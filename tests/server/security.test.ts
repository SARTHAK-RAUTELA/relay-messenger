import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { SocketProbe, TestUser, startServer, type TestServer } from "../helpers/server";

let srv: TestServer;
afterEach(async () => {
  await srv?.close();
});

const login = (s: TestServer, username: string, password: string) =>
  new TestUser(s).call("POST", "/api/auth/login", { username, password });

describe("G6: auth throttling", () => {
  it("5 failures for a username lock it with RATE_LIMITED + retryAfterMs; existing and unknown users look the same", async () => {
    srv = await startServer({ authMaxFailures: 5, authWindowMs: 60_000 });
    await new TestUser(srv).register("target", "Target");
    const known: number[] = [];
    const unknown: { status: number; code: string }[] = [];
    for (let i = 0; i < 5; i++) known.push((await login(srv, "target", "wrong-" + i)).status);
    expect(known).toEqual([401, 401, 401, 401, 401]);
    const locked = await login(srv, "target", "secret123"); // even the right password is refused while locked
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe("RATE_LIMITED");
    expect(locked.body.error.retryAfterMs).toBeGreaterThan(0);
    expect(locked.body.error.message).not.toMatch(/target|exist|unknown/i);
    // the IP is now also over the limit; on a fresh server compare an unknown user's responses
    await srv.close();
    srv = await startServer({ authMaxFailures: 5, authWindowMs: 60_000 });
    for (let i = 0; i < 6; i++) {
      const r = await login(srv, "nobody_here", "x" + i);
      unknown.push({ status: r.status, code: r.body.error.code });
    }
    expect(unknown.slice(0, 5).every((u) => u.status === 401 && u.code === "INVALID_CREDENTIALS")).toBe(true);
    expect(unknown[5]).toEqual({ status: 429, code: "RATE_LIMITED" });
  });

  it("the lock expires after the window (backoff) and a success clears the username counter", async () => {
    srv = await startServer({ authMaxFailures: 3, authWindowMs: 60_000 });
    await new TestUser(srv).register("pat", "Pat");
    for (let i = 0; i < 3; i++) await login(srv, "pat", "bad");
    expect((await login(srv, "pat", "secret123")).status).toBe(429);
    srv.clock.advance(61_000);
    expect((await login(srv, "pat", "secret123")).status).toBe(200);
  });

  it("per-IP failures across many usernames are throttled too", async () => {
    srv = await startServer({ authMaxFailures: 4, authWindowMs: 60_000 });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await login(srv, "user" + i, "bad")).status);
    expect(codes).toEqual([401, 401, 401, 401, 429]);
  });

  it("registration is limited per IP", async () => {
    srv = await startServer({ registerMaxPerIp: 2, authWindowMs: 60_000 });
    const reg = (n: string) => new TestUser(srv).call("POST", "/api/auth/register", { username: n, email: `${n}@example.test`, displayName: n, password: "secret123" });
    expect((await reg("one_1")).status).toBe(201);
    expect((await reg("two_2")).status).toBe(201);
    const third = await reg("three_3");
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe("RATE_LIMITED");
  });
});

describe("G7: WebSocket origin and payload limits", () => {
  async function session(s: TestServer) {
    return new TestUser(s).register("wsuser", "Ws");
  }
  const open = (s: TestServer, cookie: string, origin?: string) =>
    new Promise<{ status: number | null; probe: SocketProbe | null }>((resolve) => {
      const ws = new WebSocket(s.wsUrl, { headers: { cookie, ...(origin ? { origin } : {}) } });
      ws.once("unexpected-response", (_req, res) => resolve({ status: res.statusCode ?? null, probe: null }));
      ws.once("open", () => resolve({ status: 101, probe: new SocketProbe(ws) }));
      ws.once("error", () => undefined);
    });

  it("default: same-origin accepted, foreign origin rejected with 403", async () => {
    srv = await startServer();
    const u = await session(srv);
    const host = new URL(srv.base).host;
    const ok = await open(srv, u.cookie, `http://${host}`);
    expect(ok.status).toBe(101);
    ok.probe!.close();
    const bad = await open(srv, u.cookie, "https://evil.example");
    expect(bad.status).toBe(403);
  });

  it("allow-list (RELAY_ALLOWED_ORIGINS) is enforced", async () => {
    srv = await startServer({ allowedOrigins: ["https://chat.example.org"] });
    const u = await session(srv);
    expect((await open(srv, u.cookie, "https://chat.example.org")).status).toBe(101);
    expect((await open(srv, u.cookie, `http://${new URL(srv.base).host}`)).status).toBe(403);
  });

  it("frames over the 64 KiB maxPayload close the socket (1009)", async () => {
    srv = await startServer();
    const u = await session(srv);
    const { probe } = await open(srv, u.cookie);
    await probe!.waitFor((p) => p.frames.length > 0);
    probe!.ws.send("x".repeat(70 * 1024));
    await probe!.waitFor((p) => p.closeCode !== null);
    expect(probe!.closeCode).toBe(1009);
  });
});

describe("G8: JSON content type required on mutations", () => {
  it("returns 415 for a non-JSON POST (form-style CSRF) and accepts JSON", async () => {
    srv = await startServer();
    const a = await new TestUser(srv).register("ann", "Ann");
    const b = await new TestUser(srv).register("bea", "Bea");
    const res = await fetch(`${srv.base}/api/dialogs/${b.id}/messages`, {
      method: "POST",
      headers: { "content-type": "text/plain", cookie: a.cookie },
      body: JSON.stringify({ clientToken: crypto.randomUUID(), text: "x" }),
    });
    expect(res.status).toBe(415);
    expect((await res.json()).error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    const form = await fetch(`${srv.base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "username=ann&password=secret123",
    });
    expect(form.status).toBe(415);
    expect((await a.send(b, "fine")).status).toBe(200);
  });
});
