import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestUser, startServer, twoUsers, type TestServer } from "../helpers/server";
import { uuidV4 } from "../../src/shared/text";

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

const types = (u: TestUser) => srv.app.relay.eventLog(u.id).map((e) => e.type);

describe("send (H10, BR-SEND)", () => {
  it("AC-9 (server side): whitespace-only text is rejected with MESSAGE_EMPTY", async () => {
    const r = await a.send(b, " \n\t ");
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("MESSAGE_EMPTY");
  });

  it("stores text as sent (not trimmed), returns viewer-relative message with clientToken", async () => {
    const token = uuidV4();
    const r = await a.call("POST", `/api/dialogs/${b.id}/messages`, { clientToken: token, text: "  hello  " });
    expect(r.status).toBe(200);
    expect(r.body.duplicate).toBe(false);
    expect(r.body.message).toMatchObject({ text: "  hello  ", out: true, peerId: b.id, senderId: a.id, clientToken: token });
    const bh = await b.call("GET", `/api/dialogs/${a.id}/messages`);
    expect(bh.body.messages[0]).toMatchObject({ out: false, peerId: a.id });
    expect(bh.body.messages[0].clientToken).toBeUndefined();
  });

  it("AC-13: same clientToken twice creates one message; second response duplicate:true same id; B gets one message.new", async () => {
    const token = uuidV4();
    const r1 = await a.call("POST", `/api/dialogs/${b.id}/messages`, { clientToken: token, text: "once" });
    const r2 = await a.call("POST", `/api/dialogs/${b.id}/messages`, { clientToken: token, text: "once" });
    expect(r2.body.duplicate).toBe(true);
    expect(r2.body.message.id).toBe(r1.body.message.id);
    expect(types(b).filter((t) => t === "message.new")).toHaveLength(1);
    expect(types(a).filter((t) => t === "message.new")).toHaveLength(1);
    const hist = await b.call("GET", `/api/dialogs/${a.id}/messages`);
    expect(hist.body.messages).toHaveLength(1);
  });

  it("AC-14: rapid sends get ascending ids in send order; B sees them in that order", async () => {
    const ids: number[] = [];
    for (const t of ["1", "2", "3"]) ids.push((await a.sendOk(b, t)).id);
    expect([...ids].sort((x, y) => x - y)).toEqual(ids);
    const hist = await b.call("GET", `/api/dialogs/${a.id}/messages`);
    expect(hist.body.messages.map((m: any) => m.text).reverse()).toEqual(["1", "2", "3"]);
  });

  it("AC-16 (server side): text over MAX_TEXT_LEN is rejected with TEXT_TOO_LONG", async () => {
    const r = await a.send(b, "x".repeat(4097));
    expect(r.body.error.code).toBe("TEXT_TOO_LONG");
    expect((await a.send(b, "x".repeat(4096))).status).toBe(200);
  });

  it("AC-17 (server side): sending clears the draft and emits dialog.draft null to the sender", async () => {
    await a.call("PUT", `/api/dialogs/${b.id}/draft`, { text: "half-written" });
    expect((await a.dialog(b)).draft?.text).toBe("half-written");
    await a.sendOk(b, "done");
    expect((await a.dialog(b)).draft).toBeNull();
    const log = srv.app.relay.eventLog(a.id);
    const last = log[log.length - 1];
    expect(last.type).toBe("dialog.draft");
    expect(JSON.parse(last.payload)).toEqual({ peerId: b.id, draft: null });
  });

  it("clearDraft:false keeps the draft", async () => {
    await a.call("PUT", `/api/dialogs/${b.id}/draft`, { text: "keep" });
    await a.sendOk(b, "x", { clearDraft: false });
    expect((await a.dialog(b)).draft?.text).toBe("keep");
  });

  it("rejects invalid tokens, peers and self-chat", async () => {
    expect((await a.call("POST", `/api/dialogs/${b.id}/messages`, { clientToken: "nope", text: "x" })).body.error.code).toBe(
      "TOKEN_INVALID",
    );
    expect((await a.send(9999, "x")).status).toBe(404);
    expect((await a.send(a, "x")).body.error.code).toBe("PEER_INVALID");
  });

  it("OD-20: rate limit gives 429 RATE_LIMITED with retryAfterMs", async () => {
    await srv.close();
    srv = await startServer({ rateLimitCount: 3, rateLimitWindowMs: 10_000 });
    [a, b] = await twoUsers(srv);
    for (let i = 0; i < 3; i++) await a.sendOk(b, "m" + i);
    const r = await a.send(b, "too many");
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe("RATE_LIMITED");
    expect(r.body.error.retryAfterMs).toBeGreaterThan(0);
  });
});

describe("receive and unread (BR-RECV, BR-READ server)", () => {
  it("AC-19 (server side): recipient's dialog shows the text without prefix and unread +1", async () => {
    await a.sendOk(b, "hey there");
    const d = await b.dialog(a);
    expect(d.topMessage?.text).toBe("hey there");
    expect(d.unreadCount).toBe(1);
    const list = await b.call("GET", "/api/dialogs");
    expect(list.body.dialogs[0].peer.id).toBe(a.id);
  });

  it("AC-21/AC-25: read cursor is monotonic; lower maxId changes nothing and emits nothing", async () => {
    const m1 = await a.sendOk(b, "1");
    const m2 = await a.sendOk(b, "2");
    const r = await b.call("POST", `/api/dialogs/${a.id}/read`, { maxId: m2.id });
    expect(r.body).toMatchObject({ readInboxMaxId: m2.id, unreadCount: 0 });
    const seqA = srv.app.relay.currentSeq(a.id);
    const seqB = srv.app.relay.currentSeq(b.id);
    const r2 = await b.call("POST", `/api/dialogs/${a.id}/read`, { maxId: m1.id });
    expect(r2.body.readInboxMaxId).toBe(m2.id);
    expect(srv.app.relay.currentSeq(a.id)).toBe(seqA);
    expect(srv.app.relay.currentSeq(b.id)).toBe(seqB);
  });

  it("read clamps to the newest visible message and emits read.inbox (reader) + read.outbox (peer)", async () => {
    const m1 = await a.sendOk(b, "1");
    const r = await b.call("POST", `/api/dialogs/${a.id}/read`, { maxId: 10_000 });
    expect(r.body.readInboxMaxId).toBe(m1.id);
    const bl = srv.app.relay.eventLog(b.id);
    expect(JSON.parse(bl[bl.length - 1].payload)).toEqual({ peerId: a.id, maxId: m1.id, unreadCount: 0 });
    const al = srv.app.relay.eventLog(a.id);
    expect(al[al.length - 1].type).toBe("read.outbox");
    expect(JSON.parse(al[al.length - 1].payload)).toEqual({ peerId: b.id, maxId: m1.id });
  });

  it("AC-28 (server side): readOutboxMaxId equals the peer's read cursor", async () => {
    const m1 = await a.sendOk(b, "1");
    await a.sendOk(b, "2");
    await b.call("POST", `/api/dialogs/${a.id}/read`, { maxId: m1.id });
    const d = await a.dialog(b);
    expect(d.readOutboxMaxId).toBe(m1.id);
    expect(d.topMessage!.id).toBeGreaterThan(m1.id);
  });
});

describe("dialog list (H2..H7, BR-LIST)", () => {
  it("AC-29: pinned first, then by activity desc", async () => {
    const c = await new TestUser(srv).register("cee", "Cee");
    // Z = c (pinned, oldest), X = b (older), Y = third user (newest)
    const y = await new TestUser(srv).register("why", "Why");
    await a.sendOk(c, "z");
    await new Promise((r) => setTimeout(r, 5));
    await a.sendOk(b, "x");
    await new Promise((r) => setTimeout(r, 5));
    await a.sendOk(y, "y");
    await a.call("PUT", `/api/dialogs/${c.id}/pin`, { pinned: true });
    const list = await a.call("GET", "/api/dialogs");
    expect(list.body.dialogs.map((d: any) => d.peer.id)).toEqual([c.id, y.id, b.id]);
  });

  it("AC-30 (server side): newly pinned goes on top; reorder persists; ORDER_MISMATCH on wrong set; PIN_LIMIT", async () => {
    const c = await new TestUser(srv).register("cee", "Cee");
    await a.sendOk(b, "1");
    await a.sendOk(c, "2");
    const p1 = await a.call("PUT", `/api/dialogs/${b.id}/pin`, { pinned: true });
    expect(p1.body.pinnedOrder).toEqual([b.id]);
    const p2 = await a.call("PUT", `/api/dialogs/${c.id}/pin`, { pinned: true });
    expect(p2.body.pinnedOrder).toEqual([c.id, b.id]);
    const re = await a.call("PUT", "/api/dialogs/pinned-order", { order: [b.id, c.id] });
    expect(re.body.pinnedOrder).toEqual([b.id, c.id]);
    const list = await a.call("GET", "/api/dialogs");
    expect(list.body.dialogs.map((d: any) => d.peer.id)).toEqual([b.id, c.id]);
    const bad = await a.call("PUT", "/api/dialogs/pinned-order", { order: [b.id] });
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe("ORDER_MISMATCH");
    const log = srv.app.relay.eventLog(a.id).filter((e) => e.type === "dialog.pinned");
    expect(JSON.parse(log[log.length - 1].payload)).toEqual({ pinnedOrder: [b.id, c.id] });
    // limit
    const extra: TestUser[] = [];
    for (let i = 0; i < 4; i++) extra.push(await new TestUser(srv).register("pp" + i, "P" + i));
    for (const e of extra.slice(0, 3)) expect((await a.call("PUT", `/api/dialogs/${e.id}/pin`, { pinned: true })).status).toBe(200);
    const over = await a.call("PUT", `/api/dialogs/${extra[3].id}/pin`, { pinned: true });
    expect(over.body.error.code).toBe("PIN_LIMIT");
    // unpin
    const un = await a.call("PUT", `/api/dialogs/${b.id}/pin`, { pinned: false });
    expect(un.body.pinnedOrder).not.toContain(b.id);
  });

  it("AC-31 (server side): a fresh draft lifts the dialog by activity date", async () => {
    const c = await new TestUser(srv).register("cee", "Cee");
    await a.sendOk(b, "older");
    await new Promise((r) => setTimeout(r, 5));
    await a.sendOk(c, "newer");
    await new Promise((r) => setTimeout(r, 5));
    const d = await a.call("PUT", `/api/dialogs/${b.id}/draft`, { text: "thinking" });
    expect(d.body.draft.text).toBe("thinking");
    const list = await a.call("GET", "/api/dialogs");
    expect(list.body.dialogs.map((x: any) => x.peer.id)).toEqual([b.id, c.id]);
    expect(list.body.dialogs[0].draft.text).toBe("thinking");
    // empty clears
    const cl = await a.call("PUT", `/api/dialogs/${b.id}/draft`, { text: "" });
    expect(cl.body.draft).toBeNull();
  });

  it("AC-35/AC-37 (server side): unread mark is stored, emitted once per change, survives new messages", async () => {
    await b.sendOk(a, "1");
    await a.call("POST", `/api/dialogs/${b.id}/read`, { maxId: 999 });
    const before = srv.app.relay.currentSeq(a.id);
    await a.call("PUT", `/api/dialogs/${b.id}/unread-mark`, { marked: true });
    await a.call("PUT", `/api/dialogs/${b.id}/unread-mark`, { marked: true });
    expect(srv.app.relay.currentSeq(a.id)).toBe(before + 1);
    await b.sendOk(a, "2");
    const d = await a.dialog(b);
    expect(d.unreadMark).toBe(true);
    expect(d.unreadCount).toBe(1);
  });

  it("H3 for a never-contacted user returns an empty dialog shape and creates nothing", async () => {
    const d = await a.dialog(b);
    expect(d).toMatchObject({ topMessage: null, unreadCount: 0, pinned: false, draft: null });
    expect((await a.call("GET", "/api/dialogs")).body.dialogs).toEqual([]);
    expect((await a.call("GET", "/api/dialogs/99999")).body.error.code).toBe("PEER_INVALID");
  });

  it("H2 pages with cursor", async () => {
    const others: TestUser[] = [];
    for (let i = 0; i < 5; i++) others.push(await new TestUser(srv).register("pg" + i, "Pg" + i));
    for (const o of others) await o.sendOk(a, "hi");
    const p1 = await a.call("GET", "/api/dialogs?limit=3");
    expect(p1.body.dialogs).toHaveLength(3);
    const p2 = await a.call("GET", `/api/dialogs?limit=3&cursor=${p1.body.nextCursor}`);
    expect(p2.body.dialogs).toHaveLength(2);
    expect(p2.body.nextCursor).toBeNull();
  });
});

describe("history (H9, BR-HIST server)", () => {
  it("AC-38 (server side): newest page then older pages until hasOlder=false", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 95; i++) ids.push((await a.sendOk(b, "m" + i)).id);
    const first = await b.call("GET", `/api/dialogs/${a.id}/messages?limit=40`);
    expect(first.body.messages).toHaveLength(40);
    expect(first.body.messages[0].id).toBe(ids[94]);
    expect(first.body.hasOlder).toBe(true);
    expect(first.body.hasNewer).toBe(false);
    let oldest = first.body.messages[39].id;
    let pages = 1;
    let hasOlder = true;
    const all = [...first.body.messages];
    while (hasOlder) {
      const r = await b.call("GET", `/api/dialogs/${a.id}/messages?before=${oldest}&limit=40`);
      all.push(...r.body.messages);
      oldest = r.body.messages[r.body.messages.length - 1].id;
      hasOlder = r.body.hasOlder;
      pages++;
    }
    expect(pages).toBe(3);
    expect(all.map((m) => m.id).reverse()).toEqual(ids);
  });

  it("AC-39 (server side): around=cursor returns the read cursor's neighbourhood", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 60; i++) ids.push((await a.sendOk(b, "m" + i)).id);
    await b.call("POST", `/api/dialogs/${a.id}/read`, { maxId: ids[49] });
    const d = await b.dialog(a);
    expect(d.unreadCount).toBe(10);
    const r = await b.call("GET", `/api/dialogs/${a.id}/messages?around=${d.readInboxMaxId}&limit=40`);
    const got = r.body.messages.map((m: any) => m.id);
    expect(got).toContain(ids[49]);
    expect(got).toContain(ids[50]);
    expect(got[0]).toBe(ids[59]);
    expect(r.body.hasNewer).toBe(false);
    expect(r.body.hasOlder).toBe(true);
    const nf = await b.call("GET", `/api/dialogs/${a.id}/messages?around=999999`);
    expect(nf.body.error.code).toBe("MESSAGE_NOT_FOUND");
  });

  it("after= returns newer messages newest-first", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push((await a.sendOk(b, "m" + i)).id);
    const r = await b.call("GET", `/api/dialogs/${a.id}/messages?after=${ids[1]}&limit=2`);
    expect(r.body.messages.map((m: any) => m.id)).toEqual([ids[3], ids[2]]);
    expect(r.body.hasNewer).toBe(true);
    expect(r.body.hasOlder).toBe(true);
  });
});

describe("reply (BR-REPLY server)", () => {
  it("embeds a reply preview; AC-48: reply target outside the conversation is REPLY_TARGET_INVALID", async () => {
    const m = await b.sendOk(a, "original text");
    const r = await a.sendOk(b, "answer", { replyToId: m.id });
    expect(r.replyTo).toEqual({ id: m.id, deleted: false, senderId: b.id, senderName: "Bob", snippet: "original text" });
    const c = await new TestUser(srv).register("cee", "Cee");
    const other = await c.sendOk(a, "elsewhere");
    const bad = await a.send(b, "x", { replyToId: other.id });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("REPLY_TARGET_INVALID");
  });

  it("AC-46/EC-8 (server side): delete-for-everyone makes reply headers deleted for both and emits reply.updated", async () => {
    const m = await b.sendOk(a, "to be removed");
    const reply = await a.sendOk(b, "re", { replyToId: m.id });
    await b.call("POST", `/api/dialogs/${a.id}/messages/delete`, { ids: [m.id], forEveryone: true });
    for (const [u, p] of [
      [a, b],
      [b, a],
    ] as const) {
      const h = await u.call("GET", `/api/dialogs/${p.id}/messages`);
      const r = h.body.messages.find((x: any) => x.id === reply.id);
      expect(r.replyTo).toEqual({ id: m.id, deleted: true });
      const log = srv.app.relay.eventLog(u.id);
      const ru = log.filter((e) => e.type === "reply.updated").map((e) => JSON.parse(e.payload));
      expect(ru).toEqual([{ peerId: p.id, messageIds: [reply.id] }]);
    }
  });

  it("EC-9: delete-for-me of a replied message marks the header deleted only for me", async () => {
    const m = await a.sendOk(b, "mine");
    const reply = await b.sendOk(a, "re", { replyToId: m.id });
    await a.call("POST", `/api/dialogs/${b.id}/messages/delete`, { ids: [m.id], forEveryone: false });
    const ah = await a.call("GET", `/api/dialogs/${b.id}/messages`);
    expect(ah.body.messages.find((x: any) => x.id === reply.id).replyTo.deleted).toBe(true);
    const bh = await b.call("GET", `/api/dialogs/${a.id}/messages`);
    expect(bh.body.messages.find((x: any) => x.id === reply.id).replyTo.deleted).toBe(false);
    expect(types(b)).not.toContain("reply.updated");
  });

  it("AC-49 (server side): editing the original updates the embedded snippet and emits reply.updated", async () => {
    const m = await b.sendOk(a, "first wording");
    const reply = await a.sendOk(b, "re", { replyToId: m.id });
    await b.call("PATCH", `/api/messages/${m.id}`, { text: "second wording" });
    const h = await a.call("GET", `/api/dialogs/${b.id}/messages`);
    expect(h.body.messages.find((x: any) => x.id === reply.id).replyTo.snippet).toBe("second wording");
    expect(types(a)).toContain("reply.updated");
  });
});

describe("edit (H11, BR-EDIT)", () => {
  it("AC-51 (server side): edit sets editDate, keeps id/date, emits message.edited to both", async () => {
    const m = await a.sendOk(b, "v1");
    const r = await a.call("PATCH", `/api/messages/${m.id}`, { text: "v2" });
    expect(r.status).toBe(200);
    expect(r.body.message).toMatchObject({ id: m.id, date: m.date, text: "v2" });
    expect(r.body.message.editDate).toBeGreaterThanOrEqual(m.date);
    expect(types(a)).toContain("message.edited");
    expect(types(b)).toContain("message.edited");
  });

  it("AC-52: identical text gives 409 TEXT_UNCHANGED and no event", async () => {
    const m = await a.sendOk(b, "same");
    const seq = srv.app.relay.currentSeq(a.id);
    const r = await a.call("PATCH", `/api/messages/${m.id}`, { text: "same" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("TEXT_UNCHANGED");
    expect(srv.app.relay.currentSeq(a.id)).toBe(seq);
  });

  it("AC-53: after the limit is 403 EDIT_TIME_EXPIRED; non-author is 403 EDIT_NOT_ALLOWED; empty is rejected", async () => {
    const m = await a.sendOk(b, "text");
    const byB = await b.call("PATCH", `/api/messages/${m.id}`, { text: "hijack" });
    expect(byB.status).toBe(403);
    expect(byB.body.error.code).toBe("EDIT_NOT_ALLOWED");
    const empty = await a.call("PATCH", `/api/messages/${m.id}`, { text: "  " });
    expect(empty.body.error.code).toBe("MESSAGE_EMPTY");
    srv.clock.advance(48 * 3600_000 + 1000);
    const late = await a.call("PATCH", `/api/messages/${m.id}`, { text: "late" });
    expect(late.status).toBe(403);
    expect(late.body.error.code).toBe("EDIT_TIME_EXPIRED");
  });

  it("EC-14: editing a deleted message gives MESSAGE_NOT_FOUND", async () => {
    const m = await a.sendOk(b, "gone soon");
    await a.call("POST", `/api/dialogs/${b.id}/messages/delete`, { ids: [m.id], forEveryone: true });
    const r = await a.call("PATCH", `/api/messages/${m.id}`, { text: "x" });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("MESSAGE_NOT_FOUND");
  });

  it("AC-54 (server side): editing the top message does not change list order", async () => {
    const c = await new TestUser(srv).register("cee", "Cee");
    const m = await a.sendOk(b, "older");
    await new Promise((r) => setTimeout(r, 5));
    await a.sendOk(c, "newer");
    const before = (await a.call("GET", "/api/dialogs")).body.dialogs.map((d: any) => d.peer.id);
    await a.call("PATCH", `/api/messages/${m.id}`, { text: "older, edited" });
    const after = (await a.call("GET", "/api/dialogs")).body.dialogs;
    expect(after.map((d: any) => d.peer.id)).toEqual(before);
    expect(after.find((d: any) => d.peer.id === b.id).topMessage.text).toBe("older, edited");
    const bl = (await b.call("GET", "/api/dialogs")).body.dialogs;
    expect(bl[0].topMessage.text).toBe("older, edited");
  });

  it("forwarded messages cannot be edited (AC-69 server side)", async () => {
    const c = await new TestUser(srv).register("cee", "Cee");
    const m = await b.sendOk(a, "src");
    const f = await a.call("POST", `/api/dialogs/${c.id}/forward`, {
      fromPeerId: b.id,
      messageIds: [m.id],
      clientTokens: [uuidV4()],
      hideSender: false,
    });
    const r = await a.call("PATCH", `/api/messages/${f.body.messages[0].id}`, { text: "changed" });
    expect(r.body.error.code).toBe("EDIT_NOT_ALLOWED");
  });
});

describe("delete (H12, BR-DEL)", () => {
  it("AC-55 (server side): delete-for-me hides for A only; only A gets messages.deleted", async () => {
    const m = await b.sendOk(a, "x");
    const r = await a.call("POST", `/api/dialogs/${b.id}/messages/delete`, { ids: [m.id], forEveryone: false });
    expect(r.body.deletedIds).toEqual([m.id]);
    expect((await a.call("GET", `/api/dialogs/${b.id}/messages`)).body.messages).toHaveLength(0);
    expect((await b.call("GET", `/api/dialogs/${a.id}/messages`)).body.messages).toHaveLength(1);
    expect(types(a)).toContain("messages.deleted");
    expect(types(b)).not.toContain("messages.deleted");
  });

  it("AC-56 (server side): A deletes B's message for everyone; gone for both, both notified", async () => {
    const m = await b.sendOk(a, "x");
    await a.call("POST", `/api/dialogs/${b.id}/messages/delete`, { ids: [m.id], forEveryone: true });
    expect((await a.call("GET", `/api/dialogs/${b.id}/messages`)).body.messages).toHaveLength(0);
    expect((await b.call("GET", `/api/dialogs/${a.id}/messages`)).body.messages).toHaveLength(0);
    expect(JSON.parse(srv.app.relay.eventLog(b.id).pop()!.payload)).toEqual({ peerId: a.id, ids: [m.id] });
  });

  it("invisible ids are skipped silently; >100 ids is TOO_MANY_IDS", async () => {
    const m = await b.sendOk(a, "x");
    const r = await a.call("POST", `/api/dialogs/${b.id}/messages/delete`, { ids: [m.id, 999999], forEveryone: false });
    expect(r.body.deletedIds).toEqual([m.id]);
    const many = await a.call("POST", `/api/dialogs/${b.id}/messages/delete`, {
      ids: Array.from({ length: 101 }, (_, i) => i + 1),
      forEveryone: false,
    });
    expect(many.body.error.code).toBe("TOO_MANY_IDS");
  });

  it("AC-59: B has 3 unread, A deletes 2 for everyone, B's unread becomes 1", async () => {
    const ms = [await a.sendOk(b, "1"), await a.sendOk(b, "2"), await a.sendOk(b, "3")];
    expect((await b.dialog(a)).unreadCount).toBe(3);
    await a.call("POST", `/api/dialogs/${b.id}/messages/delete`, { ids: [ms[0].id, ms[1].id], forEveryone: true });
    expect((await b.dialog(a)).unreadCount).toBe(1);
  });

  it("AC-60/EC-10/EC-11 (server side): deleting the top message promotes the next; deleting all keeps the dialog", async () => {
    const c = await new TestUser(srv).register("cee", "Cee");
    const m1 = await a.sendOk(b, "b-old");
    await new Promise((r) => setTimeout(r, 5));
    await a.sendOk(c, "c-mid");
    await new Promise((r) => setTimeout(r, 5));
    const m3 = await a.sendOk(b, "b-new");
    let list = (await a.call("GET", "/api/dialogs")).body.dialogs;
    expect(list.map((d: any) => d.peer.id)).toEqual([b.id, c.id]);
    await a.call("POST", `/api/dialogs/${b.id}/messages/delete`, { ids: [m3.id], forEveryone: false });
    list = (await a.call("GET", "/api/dialogs")).body.dialogs;
    expect(list.map((d: any) => d.peer.id)).toEqual([c.id, b.id]);
    expect(list[1].topMessage.text).toBe("b-old");
    await a.call("POST", `/api/dialogs/${b.id}/messages/delete`, { ids: [m1.id], forEveryone: true });
    list = (await a.call("GET", "/api/dialogs")).body.dialogs;
    const bd = list.find((d: any) => d.peer.id === b.id);
    expect(bd).toBeTruthy();
    expect(bd.topMessage).toBeNull();
  });
});

describe("forward (H13, BR-FWD)", () => {
  let c: TestUser;
  beforeEach(async () => {
    c = await new TestUser(srv).register("cee", "Cee");
  });
  const fwd = (u: TestUser, to: TestUser, from: TestUser, ids: number[], hideSender = false, tokens?: string[]) =>
    u.call("POST", `/api/dialogs/${to.id}/forward`, {
      fromPeerId: from.id,
      messageIds: ids,
      clientTokens: tokens ?? ids.map(() => uuidV4()),
      hideSender,
    });

  it("AC-62 (server side): copy credits original author and date; A's dialog with C moves to top", async () => {
    const m = await b.sendOk(a, "worth sharing");
    await new Promise((r) => setTimeout(r, 5));
    const r = await fwd(a, c, b, [m.id]);
    const copy = r.body.messages[0];
    expect(copy.forwardedFrom).toEqual({ userId: b.id, name: "Bob", date: m.date });
    expect(copy.senderId).toBe(a.id);
    const ch = await c.call("GET", `/api/dialogs/${a.id}/messages`);
    expect(ch.body.messages[0].forwardedFrom.name).toBe("Bob");
    expect((await a.call("GET", "/api/dialogs")).body.dialogs[0].peer.id).toBe(c.id);
  });

  it("AC-63: hideSender copies have no forwardedFrom", async () => {
    const m = await b.sendOk(a, "anon");
    const r = await fwd(a, c, b, [m.id], true);
    expect(r.body.messages[0].forwardedFrom).toBeNull();
    expect(r.body.messages[0].senderId).toBe(a.id);
  });

  it("AC-64: forwarding a forwarded message credits the first author and date", async () => {
    const d = await new TestUser(srv).register("dee", "Dee");
    const orig = await d.sendOk(b, "from D");
    const first = await fwd(b, a, d, [orig.id]);
    const second = await fwd(a, c, b, [first.body.messages[0].id]);
    expect(second.body.messages[0].forwardedFrom).toEqual({ userId: d.id, name: "Dee", date: orig.date });
  });

  it("AC-65: replies inside the batch are preserved; replies outside are dropped; copies in source-id order", async () => {
    const m1 = await b.sendOk(a, "M1");
    const m2 = await b.sendOk(a, "M2", { replyToId: m1.id });
    const both = await fwd(a, c, b, [m2.id, m1.id]);
    const [c1, c2] = both.body.messages;
    expect(c1.text).toBe("M1");
    expect(c2.text).toBe("M2");
    expect(c2.replyTo).toMatchObject({ id: c1.id, deleted: false });
    const alone = await fwd(a, c, b, [m2.id]);
    expect(alone.body.messages[0].replyTo).toBeNull();
  });

  it("AC-68: retry with the same tokens creates no duplicates", async () => {
    const m1 = await b.sendOk(a, "M1");
    const m2 = await b.sendOk(a, "M2");
    const tokens = [uuidV4(), uuidV4()];
    const r1 = await fwd(a, c, b, [m1.id, m2.id], false, tokens);
    const r2 = await fwd(a, c, b, [m1.id, m2.id], false, tokens);
    expect(r2.body.duplicate).toBe(true);
    expect(r2.body.messages.map((m: any) => m.id)).toEqual(r1.body.messages.map((m: any) => m.id));
    expect((await c.call("GET", `/api/dialogs/${a.id}/messages`)).body.messages).toHaveLength(2);
  });

  it("rejects messages not visible to the forwarder and mismatched tokens", async () => {
    const m = await b.sendOk(a, "x");
    await a.call("POST", `/api/dialogs/${b.id}/messages/delete`, { ids: [m.id], forEveryone: false });
    expect((await fwd(a, c, b, [m.id])).body.error.code).toBe("MESSAGE_NOT_FOUND");
    const m2 = await b.sendOk(a, "y");
    const bad = await a.call("POST", `/api/dialogs/${c.id}/forward`, {
      fromPeerId: b.id,
      messageIds: [m2.id],
      clientTokens: [],
      hideSender: false,
    });
    expect(bad.body.error.code).toBe("TOKEN_INVALID");
  });
});
