import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { createRelayServer, type RelayServer } from "../../server/app";
import type { ServerConfig } from "../../server/config";
import type { ServerFrame, UserSummary } from "../../src/shared/types";
import { uuidV4 } from "../../src/shared/text";

export interface TestServer {
  app: RelayServer;
  base: string;
  wsUrl: string;
  clock: { advance(ms: number): void };
  close(): Promise<void>;
}

export async function startServer(config: Partial<ServerConfig> = {}): Promise<TestServer> {
  let offset = 0;
  const clock = {
    advance(ms: number) {
      offset += ms;
    },
  };
  const app = createRelayServer({
    config: {
      bcryptCost: 4,
      rateLimitCount: 10_000,
      registerMaxPerIp: 10_000,
      now: () => Date.now() + offset,
      ...config,
    },
  });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  const port = (app.server.address() as AddressInfo).port;
  return {
    app,
    base: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    clock,
    close: () => app.close(),
  };
}

export interface ApiResult<T = any> {
  status: number;
  body: T;
}

export class TestUser {
  cookie = "";
  user!: UserSummary;
  constructor(public srv: TestServer) {}

  get id(): number {
    return this.user.id;
  }

  async call<T = any>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
    const res = await fetch(this.srv.base + path, {
      method,
      headers: { "content-type": "application/json", ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  async register(username: string, displayName = username, password = "secret123") {
    const r = await this.call("POST", "/api/auth/register", { username, email: `${username}@example.test`, displayName, password });
    if (r.status !== 201) throw new Error("register failed " + JSON.stringify(r.body));
    this.user = r.body.user;
    return this;
  }

  /** Another session (browser) of the same user. */
  async login(username: string, password = "secret123") {
    const r = await this.call("POST", "/api/auth/login", { username, password });
    if (r.status !== 200) throw new Error("login failed " + JSON.stringify(r.body));
    this.user = r.body.user;
    return this;
  }

  send(peer: TestUser | number, text: string, extra: Record<string, unknown> = {}) {
    const peerId = typeof peer === "number" ? peer : peer.id;
    return this.call("POST", `/api/dialogs/${peerId}/messages`, { clientToken: uuidV4(), text, ...extra });
  }

  async sendOk(peer: TestUser | number, text: string, extra: Record<string, unknown> = {}) {
    const r = await this.send(peer, text, extra);
    if (r.status !== 200) throw new Error("send failed " + JSON.stringify(r.body));
    return r.body.message as import("../../src/shared/types").Message;
  }

  /** Bulk seeding: calls the in-process rules directly (same events/pushes, no HTTP round trip). */
  sendDirect(peer: TestUser | number, text: string, extra: { replyToId?: number } = {}) {
    const peerId = typeof peer === "number" ? peer : peer.id;
    return this.srv.app.relay.sendMessage(this.id, peerId, { clientToken: uuidV4(), text, ...extra }).message;
  }

  dialog(peer: TestUser) {
    return this.call("GET", `/api/dialogs/${peer.id}`).then((r) => r.body.dialog as import("../../src/shared/types").Dialog);
  }

  connect(): Promise<SocketProbe> {
    return SocketProbe.open(this.srv.wsUrl, this.cookie);
  }
}

export class SocketProbe {
  frames: ServerFrame[] = [];
  closeCode: number | null = null;
  private waiters: (() => void)[] = [];
  constructor(public ws: WebSocket) {
    ws.on("message", (raw) => {
      this.frames.push(JSON.parse(String(raw)));
      this.waiters.splice(0).forEach((w) => w());
    });
    ws.on("close", (code) => {
      this.closeCode = code;
      this.waiters.splice(0).forEach((w) => w());
    });
  }

  static open(url: string, cookie: string): Promise<SocketProbe> {
    const ws = new WebSocket(url, { headers: cookie ? { cookie } : {} });
    const probe = new SocketProbe(ws);
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve(probe));
      ws.once("error", reject);
    });
  }

  events() {
    return this.frames.filter((f): f is Extract<ServerFrame, { kind: "event" }> => f.kind === "event");
  }

  async waitFor(pred: (p: SocketProbe) => boolean, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (!pred(this)) {
      if (Date.now() - start > timeoutMs) throw new Error("SocketProbe.waitFor timeout");
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }

  close() {
    this.ws.close();
  }
}

export async function twoUsers(srv: TestServer): Promise<[TestUser, TestUser]> {
  const a = await new TestUser(srv).register("alice_" + Math.random().toString(36).slice(2, 7), "Alice");
  const b = await new TestUser(srv).register("bob_" + Math.random().toString(36).slice(2, 7), "Bob");
  return [a, b];
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
