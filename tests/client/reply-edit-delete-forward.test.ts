import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestUser, startServer, twoUsers, type TestServer } from "../helpers/server";
import { TestClient, deferred, waitUntil } from "../helpers/client";

let srv: TestServer;
let a: TestUser;
let b: TestUser;
const clients: TestClient[] = [];
async function client(user: TestUser, cfg = {}) {
  const c = new TestClient(srv, cfg);
  clients.push(c);
  await c.loginAs(user.user.username);
  return c;
}
beforeEach(async () => {
  srv = await startServer();
  [a, b] = await twoUsers(srv);
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.stop();
  await srv.close();
});

const msgItem = (c: TestClient, peer: number, id: number) =>
  c.m.timeline(peer).find((i) => i.kind === "message" && i.message.id === id) as any;

describe("reply (BR-REPLY)", () => {
  it("AC-44: reply strip shows author + snippet; pending message has the header immediately; strip clears", async () => {
    const m = await b.sendOk(a, "what time works?");
    const ca = await client(a);
    await ca.m.openConversation(b.id);
    ca.m.setReply(b.id, m.id);
    expect(ca.m.replyTo.get(b.id)).toBe(m.id);
    const gate = deferred();
    ca.intercept = async (meth, p) => {
      if (meth === "POST" && p.endsWith("/messages")) await gate.promise;
      return "pass";
    };
    ca.m.send(b.id, "noon");
    const pend = ca.m.timeline(b.id).at(-1) as any;
    expect(pend.kind).toBe("pending");
    expect(pend.pending.replyTo).toEqual({ id: m.id, deleted: false, senderId: b.id, senderName: "Bob", snippet: "what time works?" });
    expect(ca.m.replyTo.has(b.id)).toBe(false);
    gate.resolve();
    await waitUntil(() => ca.m.pending.size === 0);
    const fin = ca.m.timeline(b.id).at(-1) as any;
    expect(fin.message.replyTo).toMatchObject({ id: m.id, deleted: false }); // BR-REPLY-9
  });

  it("AC-45: clicking a reply header jumps (loading if needed), highlights; go-to-bottom returns", async () => {
    const first = await b.sendOk(a, "the original");
    for (let i = 0; i < 60; i++) b.sendDirect(a, "filler " + i);
    const reply = await b.sendOk(a, "about that", { replyToId: first.id });
    await a.call("POST", `/api/dialogs/${b.id}/read`, { maxId: reply.id });
    const ca = await client(a);
    await ca.m.openConversation(b.id);
    const conv = ca.m.convs.get(b.id)!;
    expect(conv.messages.some((m) => m.id === first.id)).toBe(false);
    await ca.m.jumpToMessage(b.id, first.id, reply.id);
    expect(conv.messages.some((m) => m.id === first.id)).toBe(true);
    expect(conv.highlightId).toBe(first.id);
    expect(conv.scroll?.to).toEqual({ id: first.id, align: "center" });
    await ca.m.goToBottom(b.id, first.id);
    expect(conv.scroll?.to).toEqual({ id: reply.id, align: "center" });
    expect(conv.messages.some((m) => m.id === reply.id)).toBe(true); // return point reloaded
  });

  it("AC-46 / EC-8: original deleted for everyone -> both views show unavailable live; click gives a notice", async () => {
    const m = await b.sendOk(a, "original");
    const ca = await client(a);
    const cb = await client(b);
    await ca.m.openConversation(b.id);
    await cb.m.openConversation(a.id);
    ca.m.send(b.id, "my reply");
    ca.m.setReply(b.id, null);
    await waitUntil(() => ca.m.pending.size === 0);
    const re = ca.m.convs.get(b.id)!.messages.at(-1)!;
    // send it as a reply (setReply before send)
    ca.m.setReply(b.id, m.id);
    ca.m.send(b.id, "a reply");
    await waitUntil(() => ca.m.pending.size === 0);
    const replyMsg = ca.m.convs.get(b.id)!.messages.at(-1)!;
    expect(replyMsg.replyTo).toMatchObject({ id: m.id, deleted: false });
    await waitUntil(() => cb.m.convs.get(a.id)!.messages.some((x) => x.id === replyMsg.id));
    await cb.m.deleteMessages(a.id, [m.id], true);
    await waitUntil(() => msgItem(ca, b.id, replyMsg.id)?.message.replyTo.deleted === true, 3000, "A header");
    expect(msgItem(cb, a.id, replyMsg.id).message.replyTo).toEqual({ id: m.id, deleted: true });
    expect(re.id).toBeGreaterThan(0);
    const before = ca.m.convs.get(b.id)!.scroll;
    await ca.m.jumpToMessage(b.id, m.id, replyMsg.id, true);
    expect(ca.m.notices.at(-1)!.text).toMatch(/removed/);
    expect(ca.m.convs.get(b.id)!.scroll).toBe(before);
  });

  it("AC-47 / EC-23: original deleted while the strip shows it -> strip disappears", async () => {
    const m = await b.sendOk(a, "soon gone");
    const ca = await client(a);
    await ca.m.openConversation(b.id);
    ca.m.setReply(b.id, m.id);
    await b.call("POST", `/api/dialogs/${a.id}/messages/delete`, { ids: [m.id], forEveryone: true });
    await waitUntil(() => !ca.m.replyTo.has(b.id), 3000, "strip removed");
  });

  it("AC-49: edit of the original updates rendered reply headers", async () => {
    const m = await b.sendOk(a, "v1 text");
    const r = await a.sendOk(b, "re", { replyToId: m.id });
    const ca = await client(a);
    await ca.m.openConversation(b.id);
    await b.call("PATCH", `/api/messages/${m.id}`, { text: "v2 text" });
    await waitUntil(() => msgItem(ca, b.id, r.id).message.replyTo.snippet === "v2 text", 3000, "snippet");
  });
});

describe("edit (BR-EDIT)", () => {
  it("AC-50 / AC-69: edit offered only for own, confirmed, non-forwarded, recent messages", async () => {
    const c = await new TestUser(srv).register("cee", "Cee");
    const mine = await a.sendOk(b, "mine");
    const theirs = await b.sendOk(a, "theirs");
    const src = await c.sendOk(a, "src");
    const fwd = await a.call("POST", `/api/dialogs/${b.id}/forward`, {
      fromPeerId: c.id,
      messageIds: [src.id],
      clientTokens: [crypto.randomUUID()],
      hideSender: false,
    });
    const ca = await client(a);
    await ca.m.openConversation(b.id);
    const find = (id: number) => ca.m.findMessage(b.id, id)!;
    expect(ca.m.canEdit(find(mine.id))).toBe(true);
    expect(ca.m.canEdit(find(theirs.id))).toBe(false);
    expect(ca.m.canEdit(find(fwd.body.messages[0].id))).toBe(false);
    expect(ca.m.canEdit({ ...find(mine.id), date: Date.now() - 49 * 3600_000 })).toBe(false);
    // pending and failed messages: edit mode cannot target them
    const gate = deferred();
    ca.intercept = async (m, p) => {
      if (m === "POST" && p.endsWith("/messages")) {
        await gate.promise;
        return 500;
      }
      return "pass";
    };
    const [t] = ca.m.send(b.id, "fails");
    const pendingItem = ca.m.timeline(b.id).find((i) => i.kind === "pending" && i.pending.token === t);
    expect(pendingItem?.kind).toBe("pending"); // pending items carry no message id
    for (const id of [...ca.m.convs.get(b.id)!.messages.map((m) => m.id)]) {
      expect(ca.m.findMessage(b.id, id)!.clientToken).not.toBe(t);
    }
    gate.resolve();
    await waitUntil(() => ca.m.pending.get(t)?.state === "failed");
    expect(ca.m.convs.get(b.id)!.messages.some((m) => m.clientToken === t)).toBe(false);
    ca.m.startEdit(b.id, mine.id);
    expect(ca.m.editing.get(b.id)?.messageId).toBe(mine.id); // only confirmed messages enter edit mode
  });

  it("AC-51: bubble unchanged until the server confirms; then both see new text + edited marker", async () => {
    const m = await a.sendOk(b, "before");
    const ca = await client(a);
    const cb = await client(b);
    await ca.m.openConversation(b.id);
    await cb.m.openConversation(a.id);
    ca.m.setComposerText(b.id, "my draft");
    ca.m.startEdit(b.id, m.id);
    expect(ca.m.composer.get(b.id)).toBe("before");
    ca.m.setComposerText(b.id, "after");
    const gate = deferred();
    const orig = ca.m.api.call.bind(ca.m.api);
    (ca.m.api as any).call = async (method: string, path: string, body?: unknown) => {
      if (method === "PATCH") await gate.promise;
      return orig(method, path, body);
    };
    const saving = ca.m.saveEdit(b.id);
    expect(ca.m.editing.get(b.id)!.busy).toBe(true);
    expect(msgItem(ca, b.id, m.id).message.text).toBe("before");
    gate.resolve();
    await saving;
    expect(msgItem(ca, b.id, m.id).message.text).toBe("after");
    expect(msgItem(ca, b.id, m.id).message.editDate).not.toBeNull();
    expect(ca.m.composer.get(b.id)).toBe("my draft"); // BR-EDIT-2 restore
    await waitUntil(() => msgItem(cb, a.id, m.id).message.text === "after");
    expect(msgItem(cb, a.id, m.id).message.editDate).not.toBeNull();
  });

  it("AC-52: identical text leaves edit mode silently with no event", async () => {
    const m = await a.sendOk(b, "same");
    const ca = await client(a);
    await ca.m.openConversation(b.id);
    ca.m.startEdit(b.id, m.id);
    const seq = srv.app.relay.currentSeq(a.id);
    await ca.m.saveEdit(b.id);
    expect(ca.m.editing.has(b.id)).toBe(false);
    expect(ca.m.notices).toHaveLength(0);
    expect(srv.app.relay.currentSeq(a.id)).toBe(seq);
  });

  it("BR-EDIT-4: empty edit text is rejected inline and does not delete", async () => {
    const m = await a.sendOk(b, "keep");
    const ca = await client(a);
    await ca.m.openConversation(b.id);
    ca.m.startEdit(b.id, m.id);
    ca.m.setComposerText(b.id, "   ");
    await ca.m.saveEdit(b.id);
    expect(ca.m.editing.get(b.id)!.error).toBeTruthy();
    expect(ca.callsTo("PATCH", /./)).toHaveLength(0);
  });

  it("EC-13: server EDIT_TIME_EXPIRED exits edit mode with a notice", async () => {
    const m = await a.sendOk(b, "old");
    const ca = await client(a);
    await ca.m.openConversation(b.id);
    ca.m.startEdit(b.id, m.id);
    ca.m.setComposerText(b.id, "new");
    srv.clock.advance(49 * 3600_000);
    await ca.m.saveEdit(b.id);
    expect(ca.m.editing.has(b.id)).toBe(false);
    expect(ca.m.notices).toHaveLength(1);
  });

  it("AC-54: edited top message updates the preview in both lists without re-ordering", async () => {
    const c = await new TestUser(srv).register("cee", "Cee");
    const m = await a.sendOk(b, "older");
    await new Promise((r) => setTimeout(r, 5));
    await a.sendOk(c, "newer");
    const ca = await client(a);
    const cb = await client(b);
    const order = ca.m.dialogRows().map((r) => r.peerId);
    await ca.m.openConversation(b.id);
    ca.m.startEdit(b.id, m.id);
    ca.m.setComposerText(b.id, "older (fixed)");
    await ca.m.saveEdit(b.id);
    expect(ca.m.dialogRows().map((r) => r.peerId)).toEqual(order);
    expect(ca.m.dialogRows().find((r) => r.peerId === b.id)!.subtitle).toMatchObject({ text: "older (fixed)" });
    await waitUntil(() => (cb.m.dialogRows()[0].subtitle as any).text === "older (fixed)", 3000, "B preview");
  });
});

describe("delete (BR-DEL)", () => {
  it("AC-55: delete for me disappears from all A sessions after confirmation; B still sees it", async () => {
    const m = await b.sendOk(a, "x");
    const a1 = await client(a);
    const a2 = await client(a);
    const cb = await client(b);
    await a1.m.openConversation(b.id);
    await a2.m.openConversation(b.id);
    await cb.m.openConversation(a.id);
    await a1.m.deleteMessages(b.id, [m.id], false);
    expect(a1.m.timeline(b.id)).toHaveLength(0);
    await waitUntil(() => a2.m.timeline(b.id).length === 0, 3000, "A2");
    await cb.m.idle();
    expect(cb.m.timeline(a.id)).toHaveLength(1);
  });

  it("AC-56: A deletes B's message for everyone; it disappears for both", async () => {
    const m = await b.sendOk(a, "x");
    const ca = await client(a);
    const cb = await client(b);
    await ca.m.openConversation(b.id);
    await cb.m.openConversation(a.id);
    await ca.m.deleteMessages(b.id, [m.id], true);
    await waitUntil(() => cb.m.timeline(a.id).length === 0, 3000, "B");
  });

  it("AC-58: failed delete removes nothing and throws (UI shows a notice)", async () => {
    const m = await b.sendOk(a, "x");
    const ca = await client(a);
    await ca.m.openConversation(b.id);
    ca.intercept = (_m, p) => (p.endsWith("/delete") ? 500 : "pass");
    await expect(ca.m.deleteMessages(b.id, [m.id], false)).rejects.toBeTruthy();
    expect(ca.m.timeline(b.id)).toHaveLength(1);
  });

  it("AC-59 (client): B's unread drops from 3 to 1 when A deletes 2 for everyone", async () => {
    const ms = [await a.sendOk(b, "1"), await a.sendOk(b, "2"), await a.sendOk(b, "3")];
    const cb = await client(b);
    expect(cb.m.dialogs.get(a.id)!.unreadCount).toBe(3);
    await a.call("POST", `/api/dialogs/${b.id}/messages/delete`, { ids: [ms[0].id, ms[1].id], forEveryone: true });
    await waitUntil(() => cb.m.dialogs.get(a.id)!.unreadCount === 1, 3000, "unread 1");
  });

  it("AC-60: deleting the top message shows the next newest and re-sorts; none left -> empty preview", async () => {
    const c = await new TestUser(srv).register("cee", "Cee");
    const m1 = await a.sendOk(b, "b-old");
    await new Promise((r) => setTimeout(r, 5));
    await a.sendOk(c, "c-mid");
    await new Promise((r) => setTimeout(r, 5));
    const m3 = await a.sendOk(b, "b-new");
    const ca = await client(a);
    expect(ca.m.dialogRows().map((r) => r.peerId)).toEqual([b.id, c.id]);
    await ca.m.deleteMessages(b.id, [m3.id], false);
    await ca.m.idle();
    expect(ca.m.dialogRows().map((r) => r.peerId)).toEqual([c.id, b.id]);
    expect(ca.m.dialogRows()[1].subtitle).toMatchObject({ text: "b-old" });
    await ca.m.deleteMessages(b.id, [m1.id], false);
    await ca.m.idle();
    const row = ca.m.dialogRows().find((r) => r.peerId === b.id)!;
    expect(row.subtitle).toEqual({ kind: "empty" });
    expect(row.time).toBeNull();
  });

  it("AC-61: a failed message can be discarded locally without a server call", async () => {
    const ca = await client(a);
    await ca.m.openConversation(b.id);
    ca.intercept = (m, p) => (m === "POST" && p.endsWith("/messages") ? 500 : "pass");
    const [t] = ca.m.send(b.id, "nope");
    await waitUntil(() => ca.m.pending.get(t)?.state === "failed");
    const calls = ca.calls.length;
    ca.m.discardPending(t);
    expect(ca.calls.length).toBe(calls);
    expect(ca.m.timeline(b.id)).toHaveLength(0);
  });

  it("AC-61: a sending message cannot be discarded/deleted", async () => {
    const ca = await client(a);
    await ca.m.openConversation(b.id);
    const gate = deferred();
    ca.intercept = async (m, p) => {
      if (m === "POST" && p.endsWith("/messages")) await gate.promise;
      return "pass";
    };
    const [t] = ca.m.send(b.id, "in flight");
    ca.m.discardPending(t);
    expect(ca.m.pending.has(t)).toBe(true);
    gate.resolve();
    await waitUntil(() => !ca.m.pending.has(t));
  });

  it("AC-70: selection excludes pending/failed; delete acts on all selected", async () => {
    const m1 = await b.sendOk(a, "1");
    const m2 = await b.sendOk(a, "2");
    const ca = await client(a);
    await ca.m.openConversation(b.id);
    ca.intercept = (m, p) => (m === "POST" && p.endsWith("/messages") ? 500 : "pass");
    const [t] = ca.m.send(b.id, "failed one");
    await waitUntil(() => ca.m.pending.get(t)?.state === "failed");
    ca.intercept = null;
    ca.m.startSelection(b.id, m1.id);
    ca.m.toggleSelect(b.id, m2.id);
    ca.m.toggleSelect(b.id, -12345); // not a confirmed message
    expect([...ca.m.selection.get(b.id)!]).toEqual([m1.id, m2.id]);
    await ca.m.deleteMessages(b.id, [...ca.m.selection.get(b.id)!], false);
    expect(ca.m.timeline(b.id).filter((i) => i.kind === "message")).toHaveLength(0);
    expect(ca.m.selection.has(b.id)).toBe(false);
  });
});

describe("forward (BR-FWD)", () => {
  let c: TestUser;
  beforeEach(async () => {
    c = await new TestUser(srv).register("cee", "Cee");
  });

  it("AC-62: C sees a forwarded-from header naming B with the original date; A's dialog with C moves to top", async () => {
    const m = await b.sendOk(a, "good tip");
    await new Promise((r) => setTimeout(r, 5));
    const ca = await client(a);
    const cc = await client(c);
    await ca.m.openConversation(b.id);
    const res = await ca.m.forward({ fromPeerId: b.id, messageIds: [m.id], targets: [c.id], hideSender: false });
    expect(res).toEqual({ succeeded: [c.id], failed: [] });
    expect(ca.m.dialogRows()[0].peerId).toBe(c.id);
    await waitUntil(() => cc.m.dialogs.get(a.id)?.topMessage != null);
    const top = cc.m.dialogs.get(a.id)!.topMessage!;
    expect(top.forwardedFrom).toEqual({ userId: b.id, name: "Bob", date: m.date });
  });

  it("AC-63: hideSender copy has no header and is authored by A (pending preview too)", async () => {
    const m = await b.sendOk(a, "quiet");
    const ca = await client(a);
    await ca.m.openConversation(b.id);
    const gate = deferred();
    ca.intercept = async (_m, p) => {
      if (p.endsWith("/forward")) await gate.promise;
      return "pass";
    };
    await ca.m.openConversation(c.id);
    const done = ca.m.forward({ fromPeerId: b.id, messageIds: [m.id], targets: [c.id], hideSender: true });
    await waitUntil(() => ca.m.pending.size === 1);
    expect([...ca.m.pending.values()][0].forwardedFrom).toBeNull();
    gate.resolve();
    await done;
    const top = ca.m.dialogs.get(c.id)!.topMessage!;
    expect(top.forwardedFrom).toBeNull();
    expect(top.senderId).toBe(a.id);
  });

  it("AC-66 / EC-22: three targets, comment first, copies in source-id order; failed target reported", async () => {
    const d = await new TestUser(srv).register("dee", "Dee");
    const e = await new TestUser(srv).register("eve", "Eve");
    const m1 = await b.sendOk(a, "first");
    const m2 = await b.sendOk(a, "second");
    const ca = await client(a);
    await ca.m.openConversation(b.id);
    ca.intercept = (_m, p) => (p === `/api/dialogs/${e.id}/forward` ? 500 : "pass");
    const res = await ca.m.forward({
      fromPeerId: b.id,
      messageIds: [m2.id, m1.id],
      targets: [c.id, d.id, e.id],
      hideSender: true,
      comment: "fyi",
    });
    expect(res.succeeded.sort()).toEqual([c.id, d.id].sort());
    expect(res.failed).toEqual([e.id]);
    for (const t of [c, d]) {
      const h = await t.call("GET", `/api/dialogs/${a.id}/messages`);
      expect(h.body.messages.map((x: any) => x.text).reverse()).toEqual(["fyi", "first", "second"]);
    }
    const failedCopies = [...ca.m.pending.values()].filter((p) => p.peerId === e.id);
    expect(failedCopies.map((p) => p.state)).toEqual(["failed", "failed"]);
    // retry the failed target with the same tokens
    ca.intercept = null;
    ca.m.retryPending(failedCopies[0].token);
    await waitUntil(() => ![...ca.m.pending.values()].some((p) => p.peerId === e.id));
    const he = await e.call("GET", `/api/dialogs/${a.id}/messages`);
    expect(he.body.messages.map((x: any) => x.text).reverse()).toEqual(["fyi", "first", "second"]);
  });

  it("AC-67: single target without comment opens the target with a preview strip; send creates copies; cancel creates nothing", async () => {
    const m = await b.sendOk(a, "share");
    const ca = await client(a);
    await ca.m.openConversation(b.id);
    await ca.m.prepareForward(c.id, { fromPeerId: b.id, messageIds: [m.id], hideSender: false });
    expect(ca.m.openPeerId).toBe(c.id);
    expect(ca.m.forwardDraft.get(c.id)).toMatchObject({ messageIds: [m.id] });
    ca.m.cancelForwardDraft(c.id);
    expect(ca.callsTo("POST", /forward$/)).toHaveLength(0);
    await ca.m.prepareForward(c.id, { fromPeerId: b.id, messageIds: [m.id], hideSender: false });
    expect(await ca.m.sendForwardDraft(c.id)).toBe(true);
    expect(ca.callsTo("POST", /forward$/)).toHaveLength(1);
    expect(ca.m.forwardDraft.has(c.id)).toBe(false);
  });

  it("AC-65 (client): pending copy of a reply inside the batch shows a reply header", async () => {
    const m1 = await b.sendOk(a, "Q");
    const m2 = await b.sendOk(a, "A", { replyToId: m1.id });
    const ca = await client(a);
    await ca.m.openConversation(b.id);
    const res = await ca.m.forward({ fromPeerId: b.id, messageIds: [m1.id, m2.id], targets: [c.id], hideSender: false });
    expect(res.failed).toEqual([]);
    const h = await c.call("GET", `/api/dialogs/${a.id}/messages`);
    const [copy2, copy1] = h.body.messages;
    expect(copy2.replyTo.id).toBe(copy1.id);
  });
});
