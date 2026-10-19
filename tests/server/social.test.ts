import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestUser, startServer, twoUsers, type TestServer } from "../helpers/server";

let srv: TestServer;
let a: TestUser;
let b: TestUser;
beforeEach(async () => {
  srv = await startServer();
  [a, b] = await twoUsers(srv);
});
afterEach(async () => {
  await srv.close();
});

const lastEvent = (u: TestUser, type: string) => {
  const e = srv.app.relay.eventLog(u.id).filter((x) => x.type === type).at(-1);
  return e ? JSON.parse(e.payload) : undefined;
};

describe("reactions", () => {
  it("one reaction per person; counts and `mine` are viewer-relative; both sides get an event", async () => {
    const m = await a.sendOk(b, "nice");
    let r = await b.call("PUT", `/api/messages/${m.id}/reaction`, { emoji: "👍" });
    expect(r.body.reactions).toEqual([{ emoji: "👍", count: 1, mine: true }]);
    r = await a.call("PUT", `/api/messages/${m.id}/reaction`, { emoji: "👍" });
    expect(r.body.reactions).toEqual([{ emoji: "👍", count: 2, mine: true }]);
    expect(lastEvent(b, "message.reactions")).toEqual({
      peerId: a.id,
      messageId: m.id,
      reactions: [{ emoji: "👍", count: 2, mine: true }],
    });
    // Switching replaces my reaction; null clears it.
    await b.call("PUT", `/api/messages/${m.id}/reaction`, { emoji: "❤️" });
    const seen = (await a.call("GET", `/api/dialogs/${b.id}/messages`)).body.messages[0].reactions;
    expect(seen).toEqual([
      { emoji: "👍", count: 1, mine: true },
      { emoji: "❤️", count: 1, mine: false },
    ]);
    await b.call("PUT", `/api/messages/${m.id}/reaction`, { emoji: null });
    expect((await b.call("GET", `/api/dialogs/${a.id}/messages`)).body.messages[0].reactions).toEqual([
      { emoji: "👍", count: 1, mine: false },
    ]);
  });

  it("rejects unknown emoji and messages you can't see", async () => {
    const m = await a.sendOk(b, "x");
    expect((await b.call("PUT", `/api/messages/${m.id}/reaction`, { emoji: "🦄" })).status).toBe(400);
    const c = await new TestUser(srv).register("outsider_r", "Out");
    expect((await c.call("PUT", `/api/messages/${m.id}/reaction`, { emoji: "👍" })).status).toBe(404);
  });
});

describe("blocking", () => {
  it("a blocked person can't message you; you still can; unblock restores it", async () => {
    expect((await a.call("PUT", `/api/users/${b.id}/block`, { blocked: true })).body.blocked).toBe(true);
    expect(lastEvent(a, "user.blocked")).toEqual({ userId: b.id, blocked: true });
    expect((await b.send(a, "hi")).body.error.code).toBe("BLOCKED");
    expect((await a.send(b, "I can still write")).status).toBe(200);
    expect((await a.dialog(b)).blocked).toBe(true);
    expect((await b.dialog(a)).blocked).toBe(false); // B is not told
    await a.call("PUT", `/api/users/${b.id}/block`, { blocked: false });
    expect((await b.send(a, "hi again")).status).toBe(200);
  });

  it("hides your presence from people you blocked", async () => {
    const pa = await a.connect();
    await a.call("PUT", `/api/users/${b.id}/block`, { blocked: true });
    const r = await b.call("GET", `/api/presence?ids=${a.id}`);
    expect(r.body.presence[a.id]).toEqual({ online: false, lastSeen: null });
    pa.close();
  });
});

describe("presence and typing", () => {
  it("contacts get presence frames when someone comes online and goes offline", async () => {
    await a.sendOk(b, "hello"); // makes them contacts
    const pb = await b.connect();
    const pa = await a.connect();
    await pb.waitFor((p) => p.frames.some((f: any) => f.kind === "presence" && f.userId === a.id && f.online));
    expect((await b.call("GET", `/api/presence?ids=${a.id}`)).body.presence[a.id].online).toBe(true);
    pa.close();
    await pb.waitFor((p) => p.frames.some((f: any) => f.kind === "presence" && f.userId === a.id && !f.online));
    const off = pb.frames.filter((f: any) => f.kind === "presence" && !f.online).at(-1) as any;
    expect(typeof off.lastSeen).toBe("number");
    expect((await b.dialog(a)).presence).toMatchObject({ online: false });
    pb.close();
  });

  it("typing frames reach the other person with the right peer id and are throttled", async () => {
    await a.sendOk(b, "hello");
    const pb = await b.connect();
    const pa = await a.connect();
    pa.ws.send(JSON.stringify({ kind: "typing", peerId: b.id }));
    pa.ws.send(JSON.stringify({ kind: "typing", peerId: b.id }));
    await pb.waitFor((p) => p.frames.some((f: any) => f.kind === "typing"));
    await new Promise((r) => setTimeout(r, 100));
    const typing = pb.frames.filter((f: any) => f.kind === "typing");
    expect(typing).toEqual([{ kind: "typing", peerId: a.id, userId: a.id }]);
    pa.close();
    pb.close();
  });

  it("typing toward someone who blocked you is dropped", async () => {
    await b.call("PUT", `/api/users/${a.id}/block`, { blocked: true });
    expect(srv.app.relay.typingTargets(a.id, b.id)).toEqual([]);
  });
});

describe("profile and account", () => {
  it("renaming yourself updates the name your contacts see", async () => {
    await a.sendOk(b, "hi");
    const r = await a.call("PATCH", "/api/me", { displayName: "Alice Liddell" });
    expect(r.body.user.displayName).toBe("Alice Liddell");
    expect(lastEvent(a, "me.updated").user.displayName).toBe("Alice Liddell");
    expect(lastEvent(b, "peer.updated")).toMatchObject({ user: { id: a.id, displayName: "Alice Liddell" }, deleted: false });
    expect((await b.dialog(a)).peer.displayName).toBe("Alice Liddell");
    expect((await a.call("PATCH", "/api/me", { displayName: "" })).status).toBe(400);
  });

  it("changing the password needs the current one and signs out other sessions", async () => {
    const other = await new TestUser(srv).login(a.user.username);
    expect((await a.call("POST", "/api/me/password", { currentPassword: "nope", newPassword: "fresh-pass" })).body.error.code).toBe(
      "WRONG_PASSWORD",
    );
    expect((await a.call("POST", "/api/me/password", { currentPassword: "secret123", newPassword: "fresh-pass" })).status).toBe(200);
    expect((await a.call("GET", "/api/me")).status).toBe(200);
    expect((await other.call("GET", "/api/me")).status).toBe(401);
    await expect(new TestUser(srv).login(a.user.username, "fresh-pass")).resolves.toBeTruthy();
  });

  it("deleting the account anonymises it, blocks sign-in and messaging, and keeps history for others", async () => {
    await a.sendOk(b, "remember me");
    expect((await a.call("POST", "/api/me/delete", { password: "wrong" })).status).toBe(403);
    expect((await a.call("POST", "/api/me/delete", { password: "secret123" })).status).toBe(204);
    expect((await a.call("GET", "/api/me")).status).toBe(401);
    await expect(new TestUser(srv).login(a.user.username)).rejects.toThrow();
    const d = await b.dialog(a);
    expect(d).toMatchObject({ peerDeleted: true, peer: { displayName: "Deleted account" } });
    expect(lastEvent(b, "peer.updated")).toMatchObject({ deleted: true });
    expect((await b.send(a, "are you there?")).body.error.code).toBe("PEER_DELETED");
    expect((await b.call("GET", `/api/dialogs/${a.id}/messages`)).body.messages[0].text).toBe("remember me");
    expect((await b.call("GET", "/api/users/search?q=deleted")).body.users).toEqual([]);
  });

  it("a deleted account leaves its groups", async () => {
    const g = (await a.call("POST", "/api/groups", { title: "G", userIds: [b.id] })).body.peerId;
    await a.call("POST", "/api/me/delete", { password: "secret123" });
    const info = (await b.call("GET", `/api/groups/${g}`)).body.group;
    expect(info.members.map((m: any) => m.id)).toEqual([b.id]);
    expect(info.ownerId).toBe(b.id);
  });
});
