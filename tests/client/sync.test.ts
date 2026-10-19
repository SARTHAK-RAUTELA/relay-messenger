import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestUser, startServer, twoUsers, type TestServer } from "../helpers/server";
import { TestClient, waitUntil } from "../helpers/client";

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

describe("client sync engine (BR-SYNC)", () => {
  it("BR-SYNC-7: fresh start loads dialogs and adopts their seq", async () => {
    await b.sendOk(a, "before login");
    const ca = await client(a);
    expect(ca.m.getLastSeq()).toBe(srv.app.relay.currentSeq(a.id));
    expect(ca.m.dialogRows().map((r) => r.peerId)).toEqual([b.id]);
    expect(ca.callsTo("GET", /^\/api\/sync/)).toHaveLength(0);
  });

  it("AC-4: reconnect after missing 3 messages catches up in order and lastSeq = N+3", async () => {
    const ca = await client(a);
    const n = ca.m.getLastSeq();
    ca.m.suspendConnection();
    for (const t of ["one", "two", "three"]) await b.sendOk(a, t);
    ca.m.resumeConnection();
    await waitUntil(() => ca.m.getLastSeq() === n + 3, 4000, "lastSeq");
    await ca.m.idle();
    const syncCalls = ca.callsTo("GET", /^\/api\/sync/);
    expect(syncCalls[0].path).toContain(`since=${n}`);
    const d = ca.m.dialogs.get(b.id)!;
    expect(d.topMessage!.text).toBe("three");
    expect(d.unreadCount).toBe(3); // EC-4: unread +3
  });

  it("AC-5: a duplicate pushed event leaves state unchanged", async () => {
    const ca = await client(a);
    await b.sendOk(a, "hi");
    await waitUntil(() => ca.m.dialogs.get(b.id)?.unreadCount === 1);
    await ca.m.idle();
    const seq = ca.m.getLastSeq();
    const ev = srv.app.relay.eventLog(a.id).find((e) => e.seq === seq)!;
    ca.m.handleFrame({ kind: "event", seq, type: ev.type, data: JSON.parse(ev.payload) } as any);
    await ca.m.idle();
    expect(ca.m.dialogs.get(b.id)!.unreadCount).toBe(1);
    expect(ca.m.getLastSeq()).toBe(seq);
  });

  it("AC-6: a gap (N+2 without N+1) triggers catch-up since N after the gap timer; both applied in order", async () => {
    const ca = await client(a);
    const n = ca.m.getLastSeq();
    let dropped = 0;
    ca.frameFilter = (f) => {
      if (f.kind === "event" && f.seq === n + 1 && dropped === 0) {
        dropped++;
        return false;
      }
      return true;
    };
    await b.sendOk(a, "first");
    await b.sendOk(a, "second");
    await waitUntil(() => ca.m.getLastSeq() === n + 2, 4000, "caught up");
    await ca.m.idle();
    expect(dropped).toBe(1);
    expect(ca.callsTo("GET", /^\/api\/sync/).some((c) => c.path.includes(`since=${n}&`))).toBe(true);
    expect(ca.m.dialogs.get(b.id)!.topMessage!.text).toBe("second");
    expect(ca.m.dialogs.get(b.id)!.unreadCount).toBe(2);
  });

  it("gap filled before the timer fires: held event drains in order without catch-up", async () => {
    // Long gap timer on the client under test, so only the drain path can apply the events.
    const ca = await client(a, { gapWaitMs: 5000 });
    const base = ca.m.getLastSeq();
    ca.m.suspendConnection(); // deliver frames by hand, out of order
    b.sendDirect(a, "p");
    b.sendDirect(a, "q");
    const log = srv.app.relay.eventLog(a.id).filter((e) => e.seq > base);
    expect(log).toHaveLength(2);
    const frame = (e: (typeof log)[number]) => ({ kind: "event", seq: e.seq, type: e.type, data: JSON.parse(e.payload) }) as any;
    ca.m.handleFrame(frame(log[1])); // N+2 first: must be held
    await ca.m.idle();
    expect(ca.m.getLastSeq()).toBe(base);
    expect(ca.m.dialogs.get(b.id)?.topMessage?.text ?? null).not.toBe("q");
    ca.m.handleFrame(frame(log[0])); // N+1 arrives: apply both in order
    await ca.m.idle();
    expect(ca.m.getLastSeq()).toBe(base + 2);
    expect(ca.m.dialogs.get(b.id)!.topMessage!.text).toBe("q");
    expect(ca.m.dialogs.get(b.id)!.unreadCount).toBe(2);
    expect(ca.callsTo("GET", /^\/api\/sync/)).toHaveLength(0);
  });

  it("AC-7: catch-up keeps calling while more=true and applies every event once", async () => {
    const ca = await client(a);
    const n = ca.m.getLastSeq();
    ca.m.suspendConnection();
    // force small pages by rewriting the limit in the request
    ca.intercept = () => "pass";
    const origCall = ca.m.api.call.bind(ca.m.api);
    (ca.m.api as any).call = (method: string, path: string, body?: unknown) =>
      origCall(method, path.startsWith("/api/sync") ? path.replace(/limit=\d+/, "limit=2") : path, body);
    for (let i = 0; i < 7; i++) b.sendDirect(a, "m" + i);
    ca.m.resumeConnection();
    await waitUntil(() => ca.m.getLastSeq() === n + 7, 4000, "caught up");
    await ca.m.idle();
    expect(ca.callsTo("GET", /^\/api\/sync/).length).toBe(4);
    expect(ca.m.dialogs.get(b.id)!.unreadCount).toBe(7);
  });

  it("AC-8: SYNC_RESET clears caches, reloads dialogs and the open conversation, keeps pending sends", async () => {
    await srv.close();
    srv = await startServer({ retentionMinEvents: 1, retentionMinAgeMs: 0 });
    [a, b] = await twoUsers(srv);
    await b.sendOk(a, "seed");
    const ca = await client(a);
    await ca.m.openConversation(b.id);
    // A pending send that cannot complete yet
    ca.intercept = (m, p) => (m === "POST" && p.endsWith("/messages") ? "network" : "pass");
    const [token] = ca.m.send(b.id, "still pending");
    ca.m.suspendConnection();
    for (let i = 0; i < 5; i++) b.sendDirect(a, "while away " + i);
    ca.m.resumeConnection();
    await waitUntil(() => ca.m.getLastSeq() === srv.app.relay.currentSeq(a.id), 4000, "reset");
    await ca.m.idle();
    expect(ca.calls.some((c) => c.path.startsWith("/api/sync"))).toBe(true);
    // the dialog list was reloaded from scratch (initial load + reset reload)
    expect(ca.callsTo("GET", /^\/api\/dialogs\?limit=50$/)).toHaveLength(2);
    expect(ca.m.dialogs.get(b.id)!.topMessage!.text).toBe("while away 4");
    expect(ca.m.convs.get(b.id)!.messages.map((m) => m.text)).toContain("while away 4");
    expect(ca.m.pending.has(token) || ca.m.timeline(b.id).some((i) => i.kind === "message" && i.message.clientToken === token)).toBe(true);
    ca.intercept = null;
    const p = ca.m.pending.get(token);
    if (p?.state === "failed") ca.m.retryPending(token);
    await waitUntil(() => !ca.m.pending.has(token), 4000, "reconciled");
  });

  it("BR-SYNC-10: an event for an unknown peer fetches that dialog first", async () => {
    const ca = await client(a);
    await b.sendOk(a, "new contact");
    await waitUntil(() => ca.m.dialogs.has(b.id));
    await ca.m.idle();
    expect(ca.callsTo("GET", new RegExp(`^/api/dialogs/${b.id}$`))).toHaveLength(1);
    expect(ca.m.dialogs.get(b.id)!.peer.displayName).toBe("Bob");
    expect(ca.m.dialogs.get(b.id)!.unreadCount).toBe(1);
  });

  it("BR-SYNC-9: idle connection (no frames) is dropped and re-established with catch-up", async () => {
    const ca = await client(a, { idleTimeoutMs: 150, pingIntervalMs: 50 });
    const n = ca.m.getLastSeq();
    ca.frameFilter = (f) => f.kind !== "pong" && f.kind !== "event"; // silence the line
    await b.sendOk(a, "lost push");
    await waitUntil(() => ca.sockets.length >= 2, 3000, "reconnected");
    ca.frameFilter = null;
    await waitUntil(() => ca.m.getLastSeq() === n + 1, 3000, "caught up");
  });
});
