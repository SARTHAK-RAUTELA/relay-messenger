import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestUser, startServer, twoUsers, type TestServer } from "../helpers/server";
import { TestClient, deferred, waitUntil } from "../helpers/client";
import type { Message } from "../../src/shared/types";

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

const incomingIds = (c: TestClient, peer: number) =>
  c.m.convs.get(peer)!.messages.filter((m) => !m.out).map((m) => m.id);
const statusOf = (c: TestClient, peer: number, id: number) =>
  c.m.timeline(peer).find((i) => i.kind === "message" && i.message.id === id)!.status;

describe("status and read tracking (BR-STATUS, BR-READ)", () => {
  it("AC-22: A sees sent; when B sees it with focus, A sees read on bubble and row", async () => {
    const ca = await client(a);
    const cb = await client(b);
    await ca.m.openConversation(b.id);
    const [t] = ca.m.send(b.id, "read me");
    await waitUntil(() => !ca.m.pending.has(t));
    const id = ca.m.convs.get(b.id)!.messages.at(-1)!.id;
    expect(statusOf(ca, b.id, id)).toBe("sent");
    expect(ca.m.dialogRows()[0].status).toBe("sent");
    await waitUntil(() => cb.m.dialogs.has(a.id));
    await cb.m.openConversation(a.id);
    cb.m.reportSeen(a.id, incomingIds(cb, a.id)); // the view reports visibility
    await waitUntil(() => statusOf(ca, b.id, id) === "read", 3000, "read receipt");
    expect(ca.m.dialogRows()[0].status).toBe("read");
  });

  it("AC-23 / EC-19: blurred window makes no read request; focus sends it and A sees read", async () => {
    const ca = await client(a);
    const cb = await client(b);
    await a.sendOk(b, "first");
    await waitUntil(() => cb.m.dialogs.has(a.id));
    await cb.m.openConversation(a.id);
    cb.m.reportSeen(a.id, incomingIds(cb, a.id));
    await cb.m.idle();
    cb.m.setFocusGate(false);
    const reads0 = cb.callsTo("POST", /\/read$/).length;
    const m = await a.sendOk(b, "while away");
    await waitUntil(() => cb.m.convs.get(a.id)!.messages.some((x) => x.id === m.id));
    cb.m.reportSeen(a.id, [m.id]);
    await cb.m.idle();
    expect(cb.callsTo("POST", /\/read$/).length).toBe(reads0);
    cb.m.setFocusGate(true);
    await waitUntil(() => cb.callsTo("POST", /\/read$/).length === reads0 + 1);
    await waitUntil(() => ca.m.dialogs.get(b.id)!.readOutboxMaxId >= m.id, 3000, "A sees read");
  });

  it("AC-24: five messages visible at once -> one request in flight at a time; final cursor = highest id", async () => {
    const ms: Message[] = [];
    for (let i = 0; i < 5; i++) ms.push(a.sendDirect(b, "m" + i));
    const cb = await client(b);
    let inFlight = 0;
    let maxInFlight = 0;
    cb.intercept = async (m, p) => {
      if (p.endsWith("/read")) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight--;
      }
      return "pass";
    };
    cb.m.setFocusGate(false); // open without auto read
    await cb.m.openConversation(a.id);
    cb.m.setFocusGate(true);
    for (const m of ms) cb.m.reportSeen(a.id, [m.id]);
    await cb.m.idle();
    expect(maxInFlight).toBe(1);
    expect(cb.m.dialogs.get(a.id)!.readInboxMaxId).toBe(ms[4].id);
    expect(cb.m.dialogs.get(a.id)!.unreadCount).toBe(0);
    expect(cb.callsTo("POST", /\/read$/).length).toBeLessThanOrEqual(2);
  });

  it("BR-READ-6: optimistic unread recount before the response", async () => {
    for (let i = 0; i < 3; i++) a.sendDirect(b, "m" + i);
    const cb = await client(b);
    const gate = deferred();
    cb.intercept = async (_m, p) => {
      if (p.endsWith("/read")) await gate.promise;
      return "pass";
    };
    await cb.m.openConversation(a.id);
    cb.m.reportSeen(a.id, incomingIds(cb, a.id));
    expect(cb.m.dialogs.get(a.id)!.unreadCount).toBe(0);
    gate.resolve();
    await cb.m.idle();
    expect(cb.m.dialogs.get(a.id)!.unreadCount).toBe(0);
  });

  it("BR-READ-7: failed read is retried once immediately, then on the next trigger", async () => {
    const m = await a.sendOk(b, "x");
    const cb = await client(b);
    cb.intercept = (_m, p) => (p.endsWith("/read") ? 500 : "pass");
    await cb.m.openConversation(a.id);
    cb.m.reportSeen(a.id, [m.id]);
    await cb.m.idle();
    expect(cb.callsTo("POST", /\/read$/)).toHaveLength(2);
    expect(cb.m.dialogs.get(a.id)!.readInboxMaxId).toBe(0);
    cb.intercept = null;
    cb.m.reportSeen(a.id, [m.id]);
    await cb.m.idle();
    expect(cb.m.dialogs.get(a.id)!.readInboxMaxId).toBe(m.id);
  });

  it("AC-26: B1 reads; B2's badge clears via read.inbox with the server's count", async () => {
    await a.sendOk(b, "1");
    await a.sendOk(b, "2");
    const b1 = await client(b);
    const b2 = await client(b);
    expect(b2.m.dialogs.get(a.id)!.unreadCount).toBe(2);
    await b1.m.openConversation(a.id);
    b1.m.reportSeen(a.id, incomingIds(b1, a.id));
    await waitUntil(() => b2.m.dialogs.get(a.id)!.unreadCount === 0, 3000, "B2 cleared");
    expect(b2.m.dialogRows()[0].badge).toBeNull();
  });

  it("AC-27/AC-28: incoming has no status; outgoing ids <= m read, > m sent", async () => {
    const ca = await client(a);
    await b.sendOk(a, "incoming");
    const out: Message[] = [];
    for (let i = 0; i < 4; i++) out.push(a.sendDirect(b, "o" + i));
    await ca.m.openConversation(b.id);
    await b.call("POST", `/api/dialogs/${a.id}/read`, { maxId: out[1].id });
    await waitUntil(() => ca.m.dialogs.get(b.id)!.readOutboxMaxId === out[1].id);
    const tl = ca.m.timeline(b.id);
    for (const item of tl) {
      if (item.kind !== "message") continue;
      if (!item.message.out) expect(item.status).toBeNull();
      else expect(item.status).toBe(item.message.id <= out[1].id ? "read" : "sent");
      expect(["failed", "sending", "sent", "read", null]).toContain(item.status);
    }
  });
});

describe("dialog list (BR-LIST)", () => {
  it("AC-30: pin P1, pin P2 -> P2 above P1; reorder persists across reload and reaches the other session", async () => {
    const c = await new TestUser(srv).register("cee", "Cee");
    await a.sendOk(b, "1");
    await a.sendOk(c, "2");
    const a1 = await client(a);
    const a2 = await client(a);
    await a1.m.setPinned(b.id, true);
    await a1.m.setPinned(c.id, true);
    expect(a1.m.dialogRows().map((r) => r.peerId)).toEqual([c.id, b.id]);
    await a1.m.reorderPinned([b.id, c.id]);
    expect(a1.m.dialogRows().map((r) => r.peerId)).toEqual([b.id, c.id]);
    await waitUntil(() => a2.m.dialogRows()[0]?.peerId === b.id && a2.m.dialogRows()[1]?.pinned === true, 3000, "A2 order");
    const a3 = await client(a); // reload
    expect(a3.m.dialogRows().map((r) => r.peerId)).toEqual([b.id, c.id]);
  });

  it("AC-31: a draft lifts the dialog, shows draft label + text, no status", async () => {
    const c = await new TestUser(srv).register("cee", "Cee");
    await a.sendOk(b, "old");
    await new Promise((r) => setTimeout(r, 5));
    await a.sendOk(c, "newer");
    const ca = await client(a);
    expect(ca.m.dialogRows()[0].peerId).toBe(c.id);
    await ca.m.openConversation(b.id);
    ca.m.setComposerText(b.id, "work in progress");
    await waitUntil(() => ca.m.dialogs.get(b.id)!.draft?.text === "work in progress");
    const row = ca.m.dialogRows()[0];
    expect(row.peerId).toBe(b.id);
    expect(row.subtitle).toEqual({ kind: "draft", text: "work in progress" });
    expect(row.status).toBeNull();
  });

  it("AC-35: mark unread shows a blank badge in all sessions; opening clears it after load", async () => {
    await b.sendOk(a, "x");
    const a1 = await client(a);
    const a2 = await client(a);
    await a1.m.markAsRead(b.id);
    await a1.m.setUnreadMark(b.id, true);
    await waitUntil(() => a2.m.dialogRows()[0].badge?.kind === "mark", 3000, "A2 mark");
    await a1.m.openConversation(b.id);
    await a1.m.idle();
    await waitUntil(() => a2.m.dialogs.get(b.id)!.unreadMark === false, 3000, "A2 cleared");
    expect((await a.dialog(b)).unreadMark).toBe(false);
  });

  it("AC-36 / EC-18: mark-as-read with unread>0 reads + clears mark; with only a mark it clears without a read request", async () => {
    await b.sendOk(a, "x");
    await b.sendOk(a, "y");
    const ca = await client(a);
    await ca.m.setUnreadMark(b.id, true);
    await ca.m.markAsRead(b.id);
    expect(ca.m.dialogs.get(b.id)!.unreadCount).toBe(0);
    expect(ca.m.dialogs.get(b.id)!.unreadMark).toBe(false);
    await ca.m.setUnreadMark(b.id, true);
    const reads = ca.callsTo("POST", /\/read$/).length;
    await ca.m.markAsRead(b.id);
    expect(ca.callsTo("POST", /\/read$/).length).toBe(reads);
    expect(ca.m.dialogs.get(b.id)!.unreadMark).toBe(false);
  });

  it("AC-33: forwarded top message is flagged for the forward marker", async () => {
    const c = await new TestUser(srv).register("cee", "Cee");
    const m = await b.sendOk(a, "pass it on");
    await a.call("POST", `/api/dialogs/${c.id}/forward`, {
      fromPeerId: b.id,
      messageIds: [m.id],
      clientTokens: [crypto.randomUUID()],
      hideSender: false,
    });
    const ca = await client(a);
    const row = ca.m.dialogRows().find((r) => r.peerId === c.id)!;
    expect(row.subtitle).toEqual({ kind: "message", text: "pass it on", forwarded: true });
  });

  it("BR-LIST-14: opening a conversation with a new contact lists it only once it has a message or draft", async () => {
    const ca = await client(a);
    await ca.m.openConversation(b.id);
    expect(ca.m.dialogRows()).toHaveLength(0);
    ca.m.send(b.id, "hi");
    expect(ca.m.dialogRows().map((r) => r.peerId)).toEqual([b.id]);
  });
});

describe("conversation view (BR-HIST)", () => {
  async function seed(n: number) {
    const ids: number[] = [];
    for (let i = 0; i < n; i++) ids.push(a.sendDirect(b, "m" + i).id);
    return ids;
  }

  it("AC-38: 0 unread -> newest page at the bottom; older pages until hasOlder=false", async () => {
    const ids = await seed(100);
    await b.call("POST", `/api/dialogs/${a.id}/read`, { maxId: ids[99] });
    const cb = await client(b);
    await cb.m.openConversation(a.id, 800);
    const conv = cb.m.convs.get(a.id)!;
    expect(conv.messages.length).toBeLessThanOrEqual(40);
    expect(conv.messages.at(-1)!.id).toBe(ids[99]);
    expect(conv.scroll?.to).toBe("bottom");
    expect(conv.dividerBeforeId).toBeNull();
    let guard = 0;
    while (conv.hasOlder && guard++ < 10) await cb.m.loadOlder(a.id);
    expect(conv.messages.map((m) => m.id)).toEqual(ids);
  });

  it("AC-39: 10 unread -> loads around the cursor, first unread at top, divider before it", async () => {
    const ids = await seed(60);
    await b.call("POST", `/api/dialogs/${a.id}/read`, { maxId: ids[49] });
    const cb = await client(b);
    await cb.m.openConversation(a.id);
    expect(cb.callsTo("GET", /messages\?around=/)[0].path).toContain(`around=${ids[49]}`);
    const conv = cb.m.convs.get(a.id)!;
    expect(conv.dividerBeforeId).toBe(ids[50]);
    expect(conv.scroll?.to).toEqual({ id: ids[50], align: "top" });
  });

  it("AC-40 / EC-20: exactly one unread -> opens at the bottom", async () => {
    const ids = await seed(5);
    await b.call("POST", `/api/dialogs/${a.id}/read`, { maxId: ids[3] });
    const cb = await client(b);
    await cb.m.openConversation(a.id);
    expect(cb.callsTo("GET", /messages\?around=/)).toHaveLength(0);
    expect(cb.m.convs.get(a.id)!.scroll?.to).toBe("bottom");
  });

  it("AC-41: the first unread is the newest message -> no divider", async () => {
    const ids = await seed(3);
    await b.call("POST", `/api/dialogs/${a.id}/read`, { maxId: ids[1] });
    const cb = await client(b);
    await cb.m.openConversation(a.id);
    expect(cb.m.convs.get(a.id)!.dividerBeforeId).toBeNull();
  });

  it("BR-HIST-5: sending removes the divider", async () => {
    const ids = await seed(6);
    await b.call("POST", `/api/dialogs/${a.id}/read`, { maxId: ids[2] });
    const cb = await client(b);
    cb.m.setFocusGate(false);
    await cb.m.openConversation(a.id);
    expect(cb.m.convs.get(a.id)!.dividerBeforeId).toBe(ids[3]);
    cb.m.send(a.id, "reply");
    expect(cb.m.convs.get(a.id)!.dividerBeforeId).toBeNull();
  });

  it("AC-42: go-to-bottom jumps to first unread if below the viewport, else to the end", async () => {
    const ids = await seed(60);
    await b.call("POST", `/api/dialogs/${a.id}/read`, { maxId: ids[49] });
    const cb = await client(b);
    cb.m.setFocusGate(false);
    await cb.m.openConversation(a.id);
    await cb.m.goToBottom(a.id, ids[45]); // viewing older messages, first unread below
    expect(cb.m.convs.get(a.id)!.scroll?.to).toEqual({ id: ids[50], align: "top" });
    await cb.m.goToBottom(a.id, ids[55]); // first unread already above the bottom of the viewport
    expect(cb.m.convs.get(a.id)!.scroll?.to).toBe("bottom");
    // re-selecting the open conversation behaves the same way
    await cb.m.openConversation(a.id);
    expect(cb.m.convs.get(a.id)!.scroll?.to).toEqual({ id: ids[50], align: "top" });
  });

  it("AC-43: a failed page shows an error and retry loads it", async () => {
    const ids = await seed(50);
    await b.call("POST", `/api/dialogs/${a.id}/read`, { maxId: ids[49] });
    const cb = await client(b);
    await cb.m.openConversation(a.id);
    cb.intercept = (_m, p) => (p.includes("before=") ? 500 : "pass");
    await cb.m.loadOlder(a.id);
    const conv = cb.m.convs.get(a.id)!;
    expect(conv.error?.dir).toBe("older");
    const count = conv.messages.length;
    cb.intercept = null;
    await cb.m.retryLoad(a.id);
    expect(conv.error).toBeNull();
    expect(conv.messages.length).toBeGreaterThan(count);
  });

  it("AC-43 (initial): a failed first load shows the error state and retry works", async () => {
    await seed(3);
    const cb = await client(b);
    cb.intercept = (_m, p) => (p.includes("/messages?") ? 500 : "pass");
    await cb.m.openConversation(a.id);
    expect(cb.m.convs.get(a.id)!.status).toBe("error");
    cb.intercept = null;
    await cb.m.retryLoad(a.id);
    expect(cb.m.convs.get(a.id)!.status).toBe("ready");
    expect(cb.m.convs.get(a.id)!.messages).toHaveLength(3);
  });

  it("BR-HIST-3: re-opening uses the cache (no new page request)", async () => {
    await seed(5);
    const c = await new TestUser(srv).register("cee", "Cee");
    await c.sendOk(b, "other");
    const cb = await client(b);
    await cb.m.openConversation(a.id);
    await cb.m.openConversation(c.id);
    const n = cb.callsTo("GET", new RegExp(`/api/dialogs/${a.id}/messages`)).length;
    await cb.m.openConversation(a.id);
    expect(cb.callsTo("GET", new RegExp(`/api/dialogs/${a.id}/messages`)).length).toBe(n);
  });
});
