import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestUser, startServer, type TestServer } from "../helpers/server";
import { uuidV4 } from "../../src/shared/text";
import { peerKind } from "../../src/shared/peer";

let srv: TestServer;
let a: TestUser;
let b: TestUser;
let c: TestUser;
beforeEach(async () => {
  srv = await startServer();
  a = await new TestUser(srv).register("ada_g", "Ada");
  b = await new TestUser(srv).register("ben_g", "Ben");
  c = await new TestUser(srv).register("cee_g", "Cee");
});
afterEach(async () => {
  await srv.close();
});

async function makeGroup(owner: TestUser, members: TestUser[], title = "Trip") {
  const r = await owner.call("POST", "/api/groups", { title, userIds: members.map((m) => m.id) });
  expect(r.status).toBe(200);
  return r.body.peerId as number;
}
const types = (u: TestUser) => srv.app.relay.eventLog(u.id).map((e) => e.type);
const history = async (u: TestUser, peerId: number) =>
  (await u.call("GET", `/api/dialogs/${peerId}/messages`)).body.messages.reverse();

describe("groups", () => {
  it("creating a group gives every member a dialog with a 'created' service message", async () => {
    const g = await makeGroup(a, [b, c]);
    expect(peerKind(g)).toBe("group");
    for (const u of [a, b, c]) {
      const d = (await u.call("GET", `/api/dialogs/${g}`)).body.dialog;
      expect(d).toMatchObject({ kind: "group", peer: { id: g, displayName: "Trip" } });
      expect(d.group.members.map((m: any) => m.id)).toEqual([a.id, b.id, c.id]);
      expect(d.group.ownerId).toBe(a.id);
      expect(d.topMessage.service).toEqual({ type: "groupCreated", title: "Trip" });
      expect(types(u)).toContain("message.new");
    }
    const list = (await b.call("GET", "/api/dialogs")).body.dialogs;
    expect(list.map((d: any) => d.peer.id)).toContain(g);
  });

  it("validates title and members", async () => {
    expect((await a.call("POST", "/api/groups", { title: " ", userIds: [b.id] })).status).toBe(400);
    expect((await a.call("POST", "/api/groups", { title: "x", userIds: [] })).status).toBe(400);
    expect((await a.call("POST", "/api/groups", { title: "x", userIds: [99999] })).body.error.code).toBe("PEER_INVALID");
  });

  it("a message reaches every member with senderName; unread counts and read receipts are per member", async () => {
    const g = await makeGroup(a, [b, c]);
    const sent = await b.sendOk(g, "hello all");
    expect(sent).toMatchObject({ peerId: g, out: true, senderName: "Ben" });
    for (const u of [a, c]) {
      const msgs = await history(u, g);
      expect(msgs.at(-1)).toMatchObject({ text: "hello all", senderId: b.id, senderName: "Ben", out: false, peerId: g });
    }
    const da = (await a.call("GET", `/api/dialogs/${g}`)).body.dialog;
    expect(da.unreadCount).toBe(1); // the creator's own service message is not unread
    const dc = (await c.call("GET", `/api/dialogs/${g}`)).body.dialog;
    expect(dc.unreadCount).toBe(2); // "created" service message + Ben's message

    await c.call("POST", `/api/dialogs/${g}/read`, { maxId: sent.id });
    const db = (await b.call("GET", `/api/dialogs/${g}`)).body.dialog;
    expect(db.readOutboxMaxId).toBe(sent.id); // read by someone
    const outbox = srv.app.relay.eventLog(b.id).filter((e) => e.type === "read.outbox");
    expect(JSON.parse(outbox.at(-1)!.payload)).toEqual({ peerId: g, maxId: sent.id });
  });

  it("outsiders cannot read, send to or see the group", async () => {
    const g = await makeGroup(a, [b]);
    expect((await c.call("GET", `/api/dialogs/${g}/messages`)).body.error.code).toBe("PEER_INVALID");
    expect((await c.send(g, "let me in")).body.error.code).toBe("PEER_INVALID");
    expect((await c.call("GET", `/api/groups/${g}`)).status).toBe(404);
  });

  it("adding members posts a service message, updates everyone's member list, and newcomers see history", async () => {
    const g = await makeGroup(a, [b]);
    await b.sendOk(g, "before Cee");
    const r = await b.call("POST", `/api/groups/${g}/members`, { userIds: [c.id, a.id] });
    expect(r.body.added).toEqual([c.id]);
    const msgs = await history(c, g);
    expect(msgs.map((m: any) => m.text || m.service.type)).toEqual(["groupCreated", "before Cee", "membersAdded"]);
    expect(msgs.at(-1).service).toEqual({ type: "membersAdded", userIds: [c.id], names: ["Cee"] });
    expect(types(a)).toContain("group.updated");
  });

  it("only the owner removes people; the removed member loses the dialog and access", async () => {
    const g = await makeGroup(a, [b, c]);
    expect((await b.call("POST", `/api/groups/${g}/members/${c.id}/remove`, {})).body.error.code).toBe("NOT_GROUP_OWNER");
    expect((await a.call("POST", `/api/groups/${g}/members/${c.id}/remove`, {})).status).toBe(200);
    expect(types(c)).toContain("dialog.removed");
    expect((await c.call("GET", `/api/dialogs/${g}`)).status).toBe(404);
    const list = (await c.call("GET", "/api/dialogs")).body.dialogs;
    expect(list.map((d: any) => d.peer.id)).not.toContain(g);
    const last = (await history(b, g)).at(-1);
    expect(last.service).toEqual({ type: "memberRemoved", userId: c.id, name: "Cee" });
  });

  it("when the owner leaves, the longest-standing member becomes owner", async () => {
    const g = await makeGroup(a, [b, c]);
    await a.call("POST", `/api/groups/${g}/members/${a.id}/remove`, {});
    const info = (await b.call("GET", `/api/groups/${g}`)).body.group;
    expect(info.ownerId).toBe(b.id);
    expect(info.members.map((m: any) => m.id)).toEqual([b.id, c.id]);
    expect((await history(c, g)).at(-1)).toMatchObject({ senderId: a.id, service: { type: "memberLeft" } });
  });

  it("renaming updates the dialog title for everyone", async () => {
    const g = await makeGroup(a, [b]);
    await b.call("PATCH", `/api/groups/${g}`, { title: "Weekend" });
    const d = (await a.call("GET", `/api/dialogs/${g}`)).body.dialog;
    expect(d.peer.displayName).toBe("Weekend");
    expect(d.topMessage.service).toEqual({ type: "groupRenamed", title: "Weekend" });
  });

  it("delete for everyone: own messages always, others' only by the owner", async () => {
    const g = await makeGroup(a, [b, c]);
    const m = await b.sendOk(g, "oops");
    expect((await c.call("POST", `/api/dialogs/${g}/messages/delete`, { ids: [m.id], forEveryone: true })).body.error.code).toBe(
      "REVOKE_FORBIDDEN",
    );
    expect((await a.call("POST", `/api/dialogs/${g}/messages/delete`, { ids: [m.id], forEveryone: true })).status).toBe(200);
    for (const u of [b, c]) expect((await history(u, g)).some((x: any) => x.id === m.id)).toBe(false);
  });

  it("messages forward into and out of groups; service messages cannot be replied to or forwarded", async () => {
    const g = await makeGroup(a, [b]);
    const m = await b.sendOk(g, "group news");
    const fwd = await a.call("POST", `/api/dialogs/${c.id}/forward`, {
      fromPeerId: g,
      messageIds: [m.id],
      clientTokens: [uuidV4()],
    });
    expect(fwd.status).toBe(200);
    expect((await history(c, a.id)).at(-1)).toMatchObject({ text: "group news", forwardedFrom: { name: "Ben" } });
    const service = (await history(a, g))[0];
    expect((await a.send(g, "re", { replyToId: service.id })).body.error.code).toBe("REPLY_TARGET_INVALID");
  });

  it("one-to-one history does not leak into groups and vice versa", async () => {
    const g = await makeGroup(a, [b]);
    await a.sendOk(b, "private");
    await a.sendOk(g, "public");
    expect((await history(b, a.id)).map((m: any) => m.text)).toEqual(["private"]);
    expect((await history(b, g)).filter((m: any) => !m.service).map((m: any) => m.text)).toEqual(["public"]);
  });
});
