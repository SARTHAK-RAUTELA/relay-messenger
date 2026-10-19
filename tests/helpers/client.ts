import WebSocket from "ws";
import { Messenger, type ClientConfig, type SocketLike } from "../../src/client/messenger";
import type { TestServer } from "./server";

export type Verdict = "pass" | "network" | number;
export type Interceptor = (method: string, path: string, body: any) => Verdict | string | Promise<Verdict | string>;

/**
 * A Messenger wired to the in-process test server: cookie-jar fetch, `ws` sockets, and hooks to
 * intercept requests (fail / delay) and observe calls.
 */
export class TestClient {
  cookie = "";
  calls: { method: string; path: string; body: any }[] = [];
  intercept: Interceptor | null = null;
  m: Messenger;
  sockets: WebSocket[] = [];
  /** When set, incoming socket frames are passed through this filter (return false to drop). */
  frameFilter: ((frame: any) => boolean) | null = null;

  constructor(
    public srv: TestServer,
    config: Partial<ClientConfig> = {},
  ) {
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const path = url.replace(srv.base, "");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      this.calls.push({ method, path, body });
      if (this.intercept) {
        const verdict = await this.intercept(method, path, body);
        if (verdict === "network") throw new TypeError("fetch failed");
        if (typeof verdict === "number") {
          return new Response(JSON.stringify({ error: { code: "SERVER_ERROR", message: "boom" } }), { status: verdict });
        }
      }
      const res = await fetch(url, {
        ...init,
        headers: { ...(init?.headers as Record<string, string>), ...(this.cookie ? { cookie: this.cookie } : {}) },
      });
      const sc = res.headers.get("set-cookie");
      if (sc) this.cookie = sc.split(";")[0];
      return res;
    };
    this.m = new Messenger({
      baseUrl: srv.base,
      wsUrl: srv.wsUrl,
      fetch: fetchImpl,
      openSocket: (url) => {
        const ws = new WebSocket(url, { headers: this.cookie ? { cookie: this.cookie } : {} });
        this.sockets.push(ws);
        const wrapper: SocketLike = {
          get readyState() {
            return ws.readyState;
          },
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
          send: (d) => ws.send(d),
          close: (c, r) => ws.close(c, r),
        };
        ws.on("open", () => wrapper.onopen?.({}));
        ws.on("message", (raw) => {
          const data = String(raw);
          if (this.frameFilter && !this.frameFilter(JSON.parse(data))) return;
          wrapper.onmessage?.({ data });
        });
        ws.on("close", (code) => wrapper.onclose?.({ code }));
        ws.on("error", () => wrapper.onerror?.({}));
        return wrapper;
      },
      storage: null,
      config: { gapWaitMs: 80, sendRetryDelaysMs: [30, 30, 30], draftSaveDelayMs: 50, reconnectDelaysMs: [30], ...config },
    });
  }

  async loginAs(username: string, password = "secret123"): Promise<this> {
    await this.m.login(username, password);
    await this.online();
    return this;
  }

  async online(): Promise<void> {
    await waitUntil(() => this.m.connection === "online");
    await this.m.idle();
  }

  callsTo(method: string, re: RegExp) {
    return this.calls.filter((c) => c.method === method && re.test(c.path));
  }

  stop() {
    this.m.stop();
    for (const s of this.sockets) s.terminate();
  }
}

export async function waitUntil(pred: () => boolean, timeoutMs = 4000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitUntil timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
