// WebSocket push hub (spec 5.3).
import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Relay, PushedEvent } from "./relay";
import { parseCookies, SESSION_COOKIE } from "./http";

interface Client {
  ws: WebSocket;
  userId: number;
  sessionId: string;
}

export class Hub {
  /** The socket is push-only; clients only send tiny ping frames. */
  static readonly MAX_PAYLOAD = 64 * 1024;
  private wss = new WebSocketServer({ noServer: true, maxPayload: Hub.MAX_PAYLOAD });
  private byUser = new Map<number, Set<Client>>();

  constructor(private relay: Relay) {
    relay.pusher = (events) => this.push(events);
  }

  /**
   * Cross-site WebSocket hijacking guard. Browsers always send Origin; it must be in
   * RELAY_ALLOWED_ORIGINS, or (when unset) match the Host the request was sent to.
   * Upgrades without Origin come from non-browser clients and carry no ambient-cookie risk.
   */
  originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    const normalized = origin.replace(/\/$/, "").toLowerCase();
    const allow = this.relay.cfg.allowedOrigins;
    if (allow) return allow.some((o) => o.toLowerCase() === normalized);
    try {
      return new URL(origin).host.toLowerCase() === String(req.headers.host ?? "").toLowerCase();
    } catch {
      return false;
    }
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.originAllowed(req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      const user = this.relay.sessionUser(sessionId);
      if (!user || !sessionId) {
        ws.close(4401, "unauthorized");
        return;
      }
      const client: Client = { ws, userId: user.id, sessionId };
      const set = this.byUser.get(user.id) ?? new Set<Client>();
      set.add(client);
      this.byUser.set(user.id, set);
      ws.on("message", (raw) => {
        let frame: { kind?: string } | null = null;
        try {
          frame = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (frame?.kind === "ping") ws.send(JSON.stringify({ kind: "pong" }));
      });
      ws.on("close", () => {
        set.delete(client);
        if (set.size === 0) this.byUser.delete(user.id);
      });
      ws.on("error", () => {});
      ws.send(JSON.stringify({ kind: "hello", seq: this.relay.currentSeq(user.id), serverTime: this.relay.cfg.now() }));
    });
  }

  push(events: PushedEvent[]): void {
    for (const ev of events) {
      const set = this.byUser.get(ev.userId);
      if (!set) continue;
      const frame = JSON.stringify({ kind: "event", seq: ev.seq, type: ev.type, data: ev.data });
      for (const c of set) {
        if (c.ws.readyState === c.ws.OPEN) c.ws.send(frame);
      }
    }
  }

  /** BR-AUTH-2: logging out closes that browser session's sockets. */
  closeSession(sessionId: string): void {
    for (const set of this.byUser.values()) {
      for (const c of set) if (c.sessionId === sessionId) c.ws.close(4401, "signed out");
    }
  }

  /** Test helper: forcibly drop all sockets of a user. */
  dropUser(userId: number): void {
    for (const c of this.byUser.get(userId) ?? []) c.ws.terminate();
  }

  close(): void {
    for (const set of this.byUser.values()) for (const c of set) c.ws.terminate();
    this.wss.close();
  }
}
