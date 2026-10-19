import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestUser, startServer, twoUsers, type TestServer } from "../helpers/server";
import { ApiFailure } from "../../src/client/api";
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

const bubbles = (c: TestClient, peer: number) => c.m.timeline(peer);

describe("sending (BR-SEND)", () => {
  it("AC-9: whitespace-only composer sends nothing and adds no bubble", async () => {
    const ca = await client(a);
    await ca.m.openConversation(b.id);
    ca.m.setComposerText(b.id, "   \n ");
    expect(ca.m.send(b.id)).toEqual([]);
    expect(bubbles(ca, b.id)).toHaveLength(0);
    expect(ca.callsTo("POST", /messages$/)).toHaveLength(0);
  });

  it("AC-10/AC-11: pending bubble appears before the response, dialog moves to top; response finalizes in place", async () => {
    const c = await new TestUser(srv).register("cee", "Cee");
    await a.sendOk(c, "older chat");
    await a.sendOk(b, "earlier");
    await new Promise((r) => setTimeout(r, 5));
    await a.sendOk(c, "newest chat");
    const ca = await client(a);
    await ca.m.openConversation(b.id);
    expect(ca.m.dialogRows()[0].peerId).toBe(c.id);
    const gate = deferred();
    ca.intercept = async (m, p) => {
      if (m === "POST" && p.endsWith("/messages")) await gate.promise;
      return "pass";
    };
    ca.m.setComposerText(b.id, "hello");
    const [token] = ca.m.send(b.id);
    const tl = bubbles(ca, b.id);
    const last = tl[tl.length - 1];
    expect(last).toMatchObject({ kind: "pending", status: "sending" });
    const row = ca.m.dialogRows()[0];
    expect(row.peerId).toBe(b.id);
    expect(row.subtitle).toMatchObject({ kind: "message", text: "hello" });
    expect(row.status).toBe("sending");
    // drop the push so the HTTP response is what finalizes
    ca.frameFilter = (f) => !(f.kind === "event" && f.type === "message.new");
    gate.resolve();
    await waitUntil(() => !ca.m.pending.has(token));
    const after = bubbles(ca, b.id);
    const mine = after.filter((i) => i.kind === "message" && i.message.clientToken === token);
    expect(mine).toHaveLength(1);
    expect(after.filter((i) => i.kind === "pending")).toHaveLength(0);
    expect(mine[0]).toMatchObject({ status: "sent" });
    expect((mine[0] as any).message.id).toBeGreaterThan(0);
  });

  it("AC-12: own push before the H10 response finalizes; the late response creates no duplicate", async () => {
    const ca = await client(a);
    await ca.m.openConversation(b.id);
    const gate = deferred();
    ca.intercept = async (m, p) => {
      if (m === "POST" && p.endsWith("/messages")) {
        // let the request reach the server but hold the response
        return "pass";
      }
      return "pass";
    };
    // Hold the response by wrapping api.call
    const orig = ca.m.api.call.bind(ca.m.api);
    (ca.m.api as any).call = async (method: string, path: string, body?: unknown) => {
      const r = await orig(method, path, body);
      if (method === "POST" && path.endsWith("/messages")) await gate.promise;
      return r;
    };
    const [token] = ca.m.send(b.id, "race");
    await waitUntil(() => !ca.m.pending.has(token), 3000, "push finalized");
    expect(bubbles(ca, b.id).filter((i) => i.kind === "message")).toHaveLength(1);
    gate.resolve();
    await ca.m.idle();
    expect(bubbles(ca, b.id)).toHaveLength(1);
  });

  it("AC-12 (vice versa): response first, then the push is ignored", async () => {
    const ca = await client(a);
    await ca.m.openConversation(b.id);
    const held: any[] = [];
    ca.frameFilter = (f) => {
      if (f.kind === "event" && f.type === "message.new") {
        held.push(f);
        return false;
      }
      return true;
    };
    const [token] = ca.m.send(b.id, "race2");
    await waitUntil(() => !ca.m.pending.has(token));
    ca.frameFilter = null;
    for (const f of held) ca.m.handleFrame(f);
    await ca.m.idle();
    expect(bubbles(ca, b.id)).toHaveLength(1);
  });

  it("AC-13 / EC-1 (client): lost response -> automatic resend with the same token -> duplicate:true, one bubble", async () => {
    const ca = await client(a);
    await ca.m.openConversation(b.id);
    ca.frameFilter = (f) => !(f.kind === "event" && f.type === "message.new"); // only HTTP can finalize
    const orig = ca.m.api.call.bind(ca.m.api);
    const responses: any[] = [];
    let lost = false;
    (ca.m.api as any).call = async (method: string, path: string, body?: unknown) => {
      const r: any = await orig(method, path, body);
      if (method === "POST" && path.endsWith("/messages")) {
        responses.push(r);
        if (!lost) {
          lost = true; // the server stored it, but the response never reaches the client
          throw new ApiFailure(0, "NETWORK", "lost", true);
        }
      }
      return r;
    };
    const [token] = ca.m.send(b.id, "dup");
    await waitUntil(() => !ca.m.pending.has(token), 3000, "finalized by resend");
    expect(responses.map((r) => r.duplicate)).toEqual([false, true]);
    expect(responses[0].message.id).toBe(responses[1].message.id);
    const posts = ca.callsTo("POST", /messages$/);
    expect(posts.map((c) => c.body.clientToken)).toEqual([token, token]);
    await ca.m.idle();
    expect(bubbles(ca, b.id)).toHaveLength(1);
    expect((await b.call("GET", `/api/dialogs/${a.id}/messages`)).body.messages).toHaveLength(1);
  });

  it("AC-14/EC-15: rapid sends are serialized per conversation and stored in order", async () => {
    const ca = await client(a);
    const cb = await client(b);
    await ca.m.openConversation(b.id);
    let inFlight = 0;
    let maxInFlight = 0;
    ca.intercept = async (m, p) => {
      if (m === "POST" && p.endsWith("/messages")) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
      }
      return "pass";
    };
    ca.m.send(b.id, "1");
    ca.m.send(b.id, "2");
    ca.m.send(b.id, "3");
    await waitUntil(() => ca.m.pending.size === 0);
    expect(maxInFlight).toBe(1);
    const posted = ca.callsTo("POST", /messages$/).map((c) => c.body.text);
    expect(posted).toEqual(["1", "2", "3"]);
    const mine = bubbles(ca, b.id).map((i) => (i.kind === "message" ? i.message : null)!);
    expect(mine.map((m) => m.text)).toEqual(["1", "2", "3"]);
    expect([...mine.map((m) => m.id)].sort((x, y) => x - y)).toEqual(mine.map((m) => m.id));
    await cb.m.openConversation(a.id);
    await waitUntil(() => cb.m.timeline(a.id).length === 3);
    expect(cb.m.timeline(a.id).map((i) => (i as any).message.text)).toEqual(["1", "2", "3"]);
  });

  it("AC-15: 500 -> failed with retry/discard; retry reuses the token; discard reverts the preview", async () => {
    await a.sendOk(b, "previous top");
    const ca = await client(a);
    await ca.m.openConversation(b.id);
    ca.intercept = (m, p) => (m === "POST" && p.endsWith("/messages") ? 500 : "pass");
    const [t1] = ca.m.send(b.id, "will fail");
    await waitUntil(() => ca.m.pending.get(t1)?.state === "failed");
    expect(ca.m.dialogRows()[0].status).toBe("failed"); // AC-34
    ca.intercept = null;
    ca.m.retryPending(t1);
    expect(ca.m.pending.get(t1)?.state).toBe("sending");
    await waitUntil(() => !ca.m.pending.has(t1));
    const tokens = ca.callsTo("POST", /messages$/).map((c) => c.body.clientToken);
    expect(tokens).toEqual([t1, t1]);
    expect(bubbles(ca, b.id).at(-1)).toMatchObject({ kind: "message", status: "sent" });

    ca.intercept = (m, p) => (m === "POST" && p.endsWith("/messages") ? 500 : "pass");
    const [t2] = ca.m.send(b.id, "discard me");
    await waitUntil(() => ca.m.pending.get(t2)?.state === "failed");
    expect(ca.m.dialogRows()[0].subtitle).toMatchObject({ text: "discard me" });
    ca.m.discardPending(t2);
    expect(bubbles(ca, b.id).some((i) => i.kind === "pending")).toBe(false);
    expect(ca.m.dialogRows()[0].subtitle).toMatchObject({ text: "will fail" });
  });

  it("AC-15 (network down): network errors auto-retry with the same token, then fail", async () => {
    const ca = await client(a);
    ca.intercept = (m, p) => (m === "POST" && p.endsWith("/messages") ? "network" : "pass");
    const [t] = ca.m.send(b.id, "offline");
    await waitUntil(() => ca.m.pending.get(t)?.state === "failed");
    const posts = ca.callsTo("POST", /messages$/);
    expect(posts).toHaveLength(4); // 1 + 3 automatic retries (OD-5)
    expect(new Set(posts.map((p) => p.body.clientToken))).toEqual(new Set([t]));
  });

  it("AC-16: text of 2*MAX+1 becomes three ordered messages; only the first carries the reply", async () => {
    const ca = await client(a, { maxTextLen: 50 });
    const orig = await b.sendOk(a, "quote me");
    await ca.m.openConversation(b.id);
    ca.m.setReply(b.id, orig.id);
    const text = "a".repeat(50) + "b".repeat(50) + "c";
    expect(ca.m.send(b.id, text)).toHaveLength(3);
    await waitUntil(() => ca.m.pending.size === 0);
    const posts = ca.callsTo("POST", /messages$/).map((c) => c.body);
    expect(posts.map((p) => p.text)).toEqual(["a".repeat(50), "b".repeat(50), "c"]);
    expect(posts.map((p) => p.replyToId ?? null)).toEqual([orig.id, null, null]);
  });

  it("AC-17: sending clears the draft on the server and in A's other session", async () => {
    const a1 = await client(a);
    const a2 = await client(a);
    await a1.m.openConversation(b.id);
    await a2.m.openConversation(b.id);
    a1.m.setComposerText(b.id, "draft text");
    await waitUntil(() => a2.m.dialogs.get(b.id)?.draft?.text === "draft text", 3000, "draft synced");
    expect(a2.m.composer.get(b.id)).toBe("draft text");
    a1.m.send(b.id);
    expect(a1.m.composer.get(b.id)).toBe("");
    await waitUntil(() => a2.m.dialogs.get(b.id)?.draft === null, 3000, "draft cleared in A2");
    expect(a2.m.composer.get(b.id)).toBe("");
    expect((await a.dialog(b)).draft).toBeNull();
  });

  it("AC-18 / EC-3: A1 sends; A2 shows it as a confirmed outgoing message", async () => {
    const a1 = await client(a);
    const a2 = await client(a);
    await b.sendOk(a, "from b");
    await waitUntil(() => a2.m.dialogs.has(b.id));
    await a2.m.openConversation(b.id);
    a1.m.send(b.id, "from a1");
    await waitUntil(() => a2.m.timeline(b.id).length === 2);
    const last = a2.m.timeline(b.id)[1];
    expect(last).toMatchObject({ kind: "message", status: "sent" });
    expect((last as any).message.out).toBe(true);
    expect((last as any).message.text).toBe("from a1");
  });

  it("EC-24: REPLY_TARGET_INVALID fails the pending; retry sends without the reply", async () => {
    const m = await b.sendOk(a, "soon gone");
    const ca = await client(a);
    await ca.m.openConversation(b.id);
    ca.m.setReply(b.id, m.id);
    ca.frameFilter = (f) => !(f.kind === "event" && f.type === "messages.deleted");
    await b.call("POST", `/api/dialogs/${a.id}/messages/delete`, { ids: [m.id], forEveryone: true });
    const [t] = ca.m.send(b.id, "answer");
    await waitUntil(() => ca.m.pending.get(t)?.state === "failed");
    expect(ca.m.pending.get(t)!.error!.code).toBe("REPLY_TARGET_INVALID");
    ca.m.retryPending(t);
    await waitUntil(() => !ca.m.pending.has(t));
    expect(ca.callsTo("POST", /messages$/).at(-1)!.body.replyToId).toBeUndefined();
  });
});

describe("receiving and unread (BR-RECV)", () => {
  it("AC-19: B's dialog moves to top, preview without prefix, unread +1", async () => {
    const c = await new TestUser(srv).register("cee", "Cee");
    await c.sendOk(b, "older");
    await a.sendOk(b, "a-old");
    await new Promise((r) => setTimeout(r, 5));
    await c.sendOk(b, "newer");
    const cb = await client(b);
    expect(cb.m.dialogRows()[0].peerId).toBe(c.id);
    const before = cb.m.dialogs.get(a.id)!.unreadCount;
    await a.sendOk(b, "ping from alice");
    await waitUntil(() => cb.m.dialogRows()[0].peerId === a.id);
    const row = cb.m.dialogRows()[0];
    expect(row.subtitle).toEqual({ kind: "message", text: "ping from alice", forwarded: false });
    expect(row.unreadCount).toBe(before + 1);
  });

  it("AC-20: the same message.new delivered twice increments unread once and renders one bubble", async () => {
    const cb = await client(b);
    await cb.m.openConversation(a.id);
    const frames: any[] = [];
    cb.frameFilter = (f) => {
      if (f.kind === "event") frames.push(f);
      return true;
    };
    cb.m.setFocusGate(false);
    await a.sendOk(b, "twice");
    await waitUntil(() => frames.length === 1);
    await cb.m.idle();
    // second delivery: same content but as a fresh event (e.g. via catch-up of a different seq)
    const f = frames[0];
    cb.m.handleFrame({ ...f, seq: cb.m.getLastSeq() + 1 });
    await cb.m.idle();
    expect(cb.m.dialogs.get(a.id)!.unreadCount).toBe(1);
    expect(cb.m.timeline(a.id)).toHaveLength(1);
  });

  it("AC-21 / EC-7: message id <= read cursor does not increment unread", async () => {
    const cb = await client(b);
    const m = await a.sendOk(b, "x");
    await waitUntil(() => cb.m.dialogs.get(a.id)?.unreadCount === 1);
    await cb.m.idle();
    const d = cb.m.dialogs.get(a.id)!;
    d.readInboxMaxId = m.id + 5; // cursor already beyond
    d.unreadCount = 0;
    cb.m.handleFrame({
      kind: "event",
      seq: cb.m.getLastSeq() + 1,
      type: "message.new",
      data: { message: { ...m, id: m.id + 1, out: false, peerId: a.id, clientToken: undefined } },
    } as any);
    await cb.m.idle();
    expect(cb.m.dialogs.get(a.id)!.unreadCount).toBe(0);
  });

  it("AC-37 / EC-17: manual mark stays set when a new incoming message arrives; badge shows the count", async () => {
    await b.sendOk(a, "x");
    const ca = await client(a);
    await ca.m.markAsRead(b.id);
    await ca.m.setUnreadMark(b.id, true);
    expect(ca.m.dialogRows()[0].badge).toEqual({ kind: "mark" });
    await b.sendOk(a, "y");
    await waitUntil(() => ca.m.dialogs.get(b.id)!.unreadCount === 1);
    expect(ca.m.dialogs.get(b.id)!.unreadMark).toBe(true);
    expect(ca.m.dialogRows()[0].badge).toEqual({ kind: "count", label: "1" });
    // opening clears both (once read)
    await ca.m.openConversation(b.id);
    await ca.m.idle();
    expect(ca.m.dialogs.get(b.id)!.unreadMark).toBe(false);
  });
});
