// WebSocket push hub (spec 5.3), plus the ephemeral presence and typing frames.
import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Relay, PushedEvent } from "./relay";
import type { ServerFrame } from "../src/shared/types";
import { parseCookies, SESSION_COOKIE } from "./http";

interface Client {
  ws: WebSocket;
  userId: number;
  sessionId: string;
}

/** Minimum gap between two typing notices from one user for one chat. */
const TYPING_THROTTLE_MS = 1500;

export class Hub {
  /** The socket is push-only apart from tiny ping and typing frames. */
  static readonly MAX_PAYLOAD = 64 * 1024;
  private wss = new WebSocketServer({ noServer: true, maxPayload: Hub.MAX_PAYLOAD });
  private byUser = new Map<number, Set<Client>>();
  private lastTyping = new Map<string, number>();
  private closing = false;

  constructor(private relay: Relay) {
    relay.pusher = (events) => this.push(events);
    relay.isOnline = (userId) => this.byUser.has(userId);
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
      const firstSocket = !this.byUser.has(user.id);
      const set = this.byUser.get(user.id) ?? new Set<Client>();
      set.add(client);
      this.byUser.set(user.id, set);
      ws.on("message", (raw) => {
        let frame: { kind?: string; peerId?: unknown } | null = null;
        try {
          frame = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (frame?.kind === "ping") ws.send(JSON.stringify({ kind: "pong" }));
        else if (frame?.kind === "typing") this.typing(user.id, frame.peerId);
      });
      ws.on("close", () => {
        set.delete(client);
        if (set.size === 0 && this.byUser.get(user.id) === set && !this.closing) {
          this.byUser.delete(user.id);
          this.relay.touchLastSeen(user.id);
          this.broadcastPresence(user.id);
        }
      });
      ws.on("error", () => {});
      ws.send(JSON.stringify({ kind: "hello", seq: this.relay.currentSeq(user.id), serverTime: this.relay.cfg.now() }));
      if (firstSocket) {
        this.relay.touchLastSeen(user.id);
        this.broadcastPresence(user.id);
      }
    });
  }

  private send(userId: number, frame: ServerFrame): void {
    const set = this.byUser.get(userId);
    if (!set) return;
    const data = JSON.stringify(frame);
    for (const c of set) if (c.ws.readyState === c.ws.OPEN) c.ws.send(data);
  }

  push(events: PushedEvent[]): void {
    for (const ev of events) {
      this.send(ev.userId, { kind: "event", seq: ev.seq, type: ev.type, data: ev.data } as ServerFrame);
    }
  }

  /** Tells `viewer` (or every watcher) what they may know about `userId`'s presence now. */
  sendPresence(viewer: number, userId: number): void {
    if (!this.byUser.has(viewer)) return;
    this.send(viewer, { kind: "presence", userId, ...this.relay.presence(viewer, userId) });
  }

  broadcastPresence(userId: number): void {
    for (const viewer of this.relay.presenceWatchers(userId)) this.sendPresence(viewer, userId);
  }

  private typing(userId: number, peerId: unknown): void {
    const key = `${userId}:${String(peerId)}`;
    const now = Date.now();
    if (now - (this.lastTyping.get(key) ?? 0) < TYPING_THROTTLE_MS) return;
    this.lastTyping.set(key, now);
    if (this.lastTyping.size > 10_000) this.lastTyping.clear();
    for (const t of this.relay.typingTargets(userId, peerId)) this.send(t.userId, { kind: "typing", peerId: t.peerId, userId });
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
    this.closing = true; // the database closes right after; skip last-seen writes
    for (const set of this.byUser.values()) for (const c of set) c.ws.terminate();
    this.wss.close();
  }
}
