import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { SocketProbe, TestUser, startServer, twoUsers, type TestServer } from "../helpers/server";

let srv: TestServer;
beforeEach(async () => {
  srv = await startServer();
});
afterEach(async () => {
  await srv.close();
});

describe("auth (BR-AUTH)", () => {
  it("AC-1: non-auth APIs return 401 UNAUTHORIZED without a session", async () => {
    const anon = new TestUser(srv);
    for (const [m, p] of [
      ["GET", "/api/me"],
      ["GET", "/api/dialogs"],
      ["GET", "/api/dialogs/1"],
      ["GET", "/api/users/search?q=a"],
      ["POST", "/api/dialogs/1/messages"],
      ["PATCH", "/api/messages/1"],
      ["GET", "/api/sync?since=0"],
      ["PUT", "/api/dialogs/pinned-order"],
    ] as const) {
      const r = await anon.call(m, p, m === "GET" ? undefined : {});
      expect(r.status, `${m} ${p}`).toBe(401);
      expect(r.body.error.code).toBe("UNAUTHORIZED");
    }
  });

  it("AC-1: /ws without a session is closed with 4401", async () => {
    const ws = new WebSocket(srv.wsUrl);
    const probe = new SocketProbe(ws);
    await probe.waitFor((p) => p.closeCode !== null);
    expect(probe.closeCode).toBe(4401);
  });

  it("AC-2: login returns user; /api/me gives user + seq; wrong password is 401 INVALID_CREDENTIALS", async () => {
    const reg = await new TestUser(srv).register("carol", "Carol");
    const s2 = new TestUser(srv);
    const ok = await s2.call("POST", "/api/auth/login", { username: "CAROL", password: "secret123" });
    expect(ok.status).toBe(200);
    expect(ok.body.user).toEqual({ id: reg.id, username: "carol", displayName: "Carol" });
    expect(ok.body.user.passwordHash).toBeUndefined();
    const me = await s2.call("GET", "/api/me");
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(reg.id);
    expect(me.body.seq).toBe(0);
    expect(typeof me.body.serverTime).toBe("number");
    const bad = await new TestUser(srv).call("POST", "/api/auth/login", { username: "carol", password: "nope-nope" });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("register validates and rejects taken usernames (case-insensitive)", async () => {
    await new TestUser(srv).register("dave", "Dave");
    const dup = await new TestUser(srv).call("POST", "/api/auth/register", { username: "DAVE", displayName: "x", password: "secret123" });
    expect(dup.body.error.code).toBe("USERNAME_TAKEN");
    const bad = await new TestUser(srv).call("POST", "/api/auth/register", { username: "a b", displayName: "x", password: "secret123" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("session cookie is httpOnly + SameSite=Lax; logout clears it and closes sockets", async () => {
    const u = new TestUser(srv);
    const r = await fetch(srv.base + "/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "erin", displayName: "Erin", password: "secret123" }),
    });
    const sc = r.headers.get("set-cookie")!;
    expect(sc).toMatch(/HttpOnly/);
    expect(sc).toMatch(/SameSite=Lax/);
    u.cookie = sc.split(";")[0];
    const probe = await u.connect();
    await probe.waitFor((p) => p.frames.length > 0);
    const out = await u.call("POST", "/api/auth/logout");
    expect(out.status).toBe(204);
    await probe.waitFor((p) => p.closeCode !== null);
    expect(probe.closeCode).toBe(4401);
    expect((await u.call("GET", "/api/me")).status).toBe(401);
  });

  it("H1 search finds by username/display-name prefix and excludes self", async () => {
    const [a] = await twoUsers(srv);
    const r = await a.call("GET", "/api/users/search?q=bo");
    expect(r.body.users.map((u: any) => u.displayName)).toEqual(["Bob"]);
    const self = await a.call("GET", "/api/users/search?q=ali");
    expect(self.body.users).toEqual([]);
  });
});

describe("sync (BR-SYNC)", () => {
  it("AC-3: a user's event log has seq 1..N without gaps or duplicates", async () => {
    const [a, b] = await twoUsers(srv);
    const m1 = await a.sendOk(b, "one");
    await a.call("PUT", `/api/dialogs/${b.id}/draft`, { text: "draft" });
    await a.sendOk(b, "two");
    await b.call("POST", `/api/dialogs/${a.id}/read`, { maxId: m1.id + 10 });
    await a.call("PATCH", `/api/messages/${m1.id}`, { text: "one!" });
    await a.call("PUT", `/api/dialogs/${b.id}/pin`, { pinned: true });
    await a.call("PUT", `/api/dialogs/${b.id}/unread-mark`, { marked: true });
    await a.call("POST", `/api/dialogs/${b.id}/messages/delete`, { ids: [m1.id], forEveryone: true });
    for (const u of [a, b]) {
      const log = srv.app.relay.eventLog(u.id);
      expect(log.map((e) => e.seq)).toEqual(log.map((_, i) => i + 1));
      const me = await u.call("GET", "/api/me");
      expect(me.body.seq).toBe(log.length);
    }
    expect(srv.app.relay.eventLog(a.id).map((e) => e.type)).toEqual([
      "message.new",
      "dialog.draft",
      "message.new",
      "dialog.draft",
      "read.outbox",
      "message.edited",
      "dialog.pinned",
      "dialog.unreadMark",
      "messages.deleted",
    ]);
  });

  it("AC-3: an event is committed together with its state change (failed op appends nothing)", async () => {
    const [a, b] = await twoUsers(srv);
    const before = srv.app.relay.currentSeq(a.id);
    const r = await a.send(b, "   ");
    expect(r.status).toBe(400);
    expect(srv.app.relay.currentSeq(a.id)).toBe(before);
  });

  it("AC-4 (server side): hello.seq reflects events missed while disconnected; sync returns them in order", async () => {
    const [a, b] = await twoUsers(srv);
    await b.sendOk(a, "warmup");
    const n = (await a.call("GET", "/api/me")).body.seq;
    for (const t of ["x", "y", "z"]) await b.sendOk(a, t);
    const probe = await a.connect();
    await probe.waitFor((p) => p.frames.length > 0);
    expect(probe.frames[0]).toMatchObject({ kind: "hello", seq: n + 3 });
    const s = await a.call("GET", `/api/sync?since=${n}`);
    expect(s.body.events.map((e: any) => e.data.message.text)).toEqual(["x", "y", "z"]);
    expect(s.body.events.map((e: any) => e.seq)).toEqual([n + 1, n + 2, n + 3]);
    expect(s.body.seq).toBe(n + 3);
    expect(s.body.more).toBe(false);
    probe.close();
  });

  it("pushes events to every connected session in seq order; ping gets pong", async () => {
    const [a, b] = await twoUsers(srv);
    const a2 = await new TestUser(srv).login(a.user.username);
    const p1 = await a.connect();
    const p2 = await a2.connect();
    await b.sendOk(a, "hi");
    await a.sendOk(b, "yo");
    for (const p of [p1, p2]) {
      await p.waitFor((x) => x.events().length >= 2);
      expect(p.events().map((e) => e.seq)).toEqual([1, 2]);
    }
    p1.ws.send(JSON.stringify({ kind: "ping" }));
    await p1.waitFor((x) => x.frames.some((f) => f.kind === "pong"));
    p1.close();
    p2.close();
  });

  it("AC-7 (server side): sync paginates with more=true until caught up", async () => {
    const [a, b] = await twoUsers(srv);
    for (let i = 0; i < 7; i++) await b.sendOk(a, "m" + i);
    const seen: number[] = [];
    let since = 0;
    let more = true;
    let calls = 0;
    while (more) {
      const r = await a.call("GET", `/api/sync?since=${since}&limit=3`);
      seen.push(...r.body.events.map((e: any) => e.seq));
      since = r.body.seq;
      more = r.body.more;
      calls++;
    }
    expect(calls).toBe(3);
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("AC-8 (server side): since older than retention or beyond current gives 410 SYNC_RESET with currentSeq", async () => {
    await srv.close();
    srv = await startServer({ retentionMinEvents: 2, retentionMinAgeMs: 0 });
    const [a, b] = await twoUsers(srv);
    for (let i = 0; i < 6; i++) await b.sendOk(a, "m" + i);
    const old = await a.call("GET", "/api/sync?since=1");
    expect(old.status).toBe(410);
    expect(old.body.error.code).toBe("SYNC_RESET");
    expect(old.body.seq).toBe(6);
    const ahead = await a.call("GET", "/api/sync?since=99");
    expect(ahead.status).toBe(410);
    const fine = await a.call("GET", "/api/sync?since=4");
    expect(fine.status).toBe(200);
    expect(fine.body.events.map((e: any) => e.seq)).toEqual([5, 6]);
  });
});
