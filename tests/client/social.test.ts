// Client core: groups, typing, presence, reactions, blocking and profile changes over real sockets.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestUser, startServer, twoUsers, type TestServer } from "../helpers/server";
import { TestClient, waitUntil } from "../helpers/client";

let srv: TestServer;
let a: TestUser;
let b: TestUser;
let ca: TestClient;
let cb: TestClient;

beforeEach(async () => {
  srv = await startServer();
  [a, b] = await twoUsers(srv);
  await a.sendOk(b, "hello"); // contacts
  ca = new TestClient(srv);
  cb = new TestClient(srv);
  await ca.loginAs(a.user.username);
  await cb.loginAs(b.user.username);
});
afterEach(async () => {
  ca.stop();
  cb.stop();
  await srv.close();
});

describe("groups in the client", () => {
  it("creating a group opens it for the creator and lists it for members with sender names", async () => {
    const g = await ca.m.createGroup("Book club", [b.id]);
    expect(ca.m.openPeerId).toBe(g);
    await waitUntil(() => cb.m.dialogs.get(g)?.kind === "group", 4000, "B gets the group");
    const row = cb.m.dialogRows().find((r) => r.peerId === g)!;
    expect(row).toMatchObject({ kind: "group", name: "Book club" });
    expect(row.subtitle).toMatchObject({ kind: "message", text: "Alice created the group “Book club”" });

    await cb.m.openConversation(g);
    cb.m.send(g, "count me in");
    await waitUntil(() => ca.m.dialogs.get(g)?.topMessage?.text === "count me in");
    expect(ca.m.dialogRows().find((r) => r.peerId === g)!.subtitle).toMatchObject({ sender: "Bob", text: "count me in" });
    const last = ca.m.convs.get(g)!.messages.at(-1)!;
    expect(ca.m.senderNameFor(g, last.senderId, last)).toBe("Bob");
  });

  it("leaving drops the chat locally without a notice; being removed shows one", async () => {
    const c = await new TestUser(srv).register("cee_cl", "Cee");
    const g = await ca.m.createGroup("Trip", [b.id, c.id]);
    await waitUntil(() => cb.m.dialogs.has(g));
    await cb.m.leaveGroup(g);
    await waitUntil(() => !cb.m.dialogs.has(g), 4000, "B dropped the group");
    expect(cb.m.notices).toHaveLength(0);
    await waitUntil(() => ca.m.dialogs.get(g)?.group?.members.length === 2, 4000, "A sees B gone");

    const cc = new TestClient(srv);
    await cc.loginAs(c.user.username);
    await waitUntil(() => cc.m.dialogs.has(g));
    await ca.m.removeMember(g, c.id);
    await waitUntil(() => !cc.m.dialogs.has(g), 4000, "C removed");
    expect(cc.m.notices.map((n) => n.text)).toContain("You're no longer in that group.");
    cc.stop();
  });

  it("renaming updates the title on every member's client", async () => {
    const g = await ca.m.createGroup("Old", [b.id]);
    await waitUntil(() => cb.m.dialogs.has(g));
    await cb.m.renameGroup(g, "New name");
    await waitUntil(() => ca.m.dialogs.get(g)?.peer.displayName === "New name", 4000, "rename reaches A");
  });
});

describe("typing and presence", () => {
  it("typing shows on the other side and clears when the message arrives", async () => {
    await ca.m.openConversation(b.id);
    ca.m.setComposerText(b.id, "wri");
    await waitUntil(() => cb.m.typingIn(a.id).length === 1, 4000, "B sees typing");
    expect(cb.m.dialogRows().find((r) => r.peerId === a.id)!.subtitle).toEqual({ kind: "typing", text: "typing…" });
    ca.m.send(b.id);
    await waitUntil(() => cb.m.typingIn(a.id).length === 0, 4000, "typing cleared");
  });

  it("presence follows the other person going offline and back", async () => {
    await waitUntil(() => cb.m.presenceOf(a.id)?.online === true, 4000, "A online for B");
    ca.m.suspendConnection();
    await waitUntil(() => cb.m.presenceOf(a.id)?.online === false, 4000, "A offline for B");
    expect(cb.m.presenceOf(a.id)!.lastSeen).toEqual(expect.any(Number));
    ca.m.resumeConnection();
    await waitUntil(() => cb.m.presenceOf(a.id)?.online === true, 4000, "A back online");
  });
});

describe("reactions, blocking and profile", () => {
  it("a reaction appears on both clients", async () => {
    await cb.m.openConversation(a.id);
    const msg = cb.m.convs.get(a.id)!.messages[0];
    await ca.m.openConversation(b.id);
    await cb.m.react(a.id, msg.id, "😂");
    await waitUntil(() => (ca.m.convs.get(b.id)?.messages[0].reactions.length ?? 0) === 1, 4000, "A sees reaction");
    expect(ca.m.convs.get(b.id)!.messages[0].reactions).toEqual([{ emoji: "😂", count: 1, mine: false }]);
    expect(cb.m.convs.get(a.id)!.messages[0].reactions).toEqual([{ emoji: "😂", count: 1, mine: true }]);
  });

  it("blocking marks the dialog and the blocked person's send fails with a notice-worthy error", async () => {
    await ca.m.setBlocked(b.id, true);
    expect(ca.m.dialogs.get(b.id)!.blocked).toBe(true);
    await cb.m.openConversation(a.id);
    const [token] = cb.m.send(a.id, "still there?");
    await waitUntil(() => cb.m.pending.get(token)?.state === "failed", 4000, "send fails");
    expect(cb.m.pending.get(token)!.error).toMatchObject({ code: "BLOCKED" });
  });

  it("a name change reaches contacts and the account itself", async () => {
    await ca.m.updateProfile("Alice L.");
    expect(ca.m.me!.displayName).toBe("Alice L.");
    await waitUntil(() => cb.m.dialogs.get(a.id)?.peer.displayName === "Alice L.", 4000, "B sees new name");
  });

  it("deleting the account signs the client out and shows the other side a deleted account", async () => {
    await ca.m.deleteAccount("secret123");
    expect(ca.m.phase).toBe("signedOut");
    await waitUntil(() => cb.m.dialogs.get(a.id)?.peerDeleted === true, 4000, "B sees deletion");
    expect(cb.m.dialogs.get(a.id)!.peer.displayName).toBe("Deleted account");
  });
});
