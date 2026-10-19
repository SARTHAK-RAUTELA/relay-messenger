// Composes the Relay server: SQLite + rules + HTTP API + WebSocket hub, optionally with a
// fallback handler (the Next.js request handler) for everything outside /api and /ws.
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { openDatabase } from "./db/client";
import { loadConfig, type ServerConfig } from "./config";
import { Relay } from "./relay";
import { Hub } from "./hub";
import { createApiHandler } from "./api";

export interface RelayServerOptions {
  dbFile?: string;
  config?: Partial<ServerConfig>;
  fallback?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  fallbackUpgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
}

export function createRelayServer(opts: RelayServerOptions = {}) {
  const { sqlite, db } = openDatabase(opts.dbFile ?? ":memory:");
  const cfg = loadConfig(opts.config);
  const relay = new Relay(db, sqlite, cfg);
  const hub = new Hub(relay);
  const api = createApiHandler(relay, hub);

  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/api" || path.startsWith("/api/")) {
      void api(req, res);
      return;
    }
    if (opts.fallback) {
      void opts.fallback(req, res);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  });

  server.on("upgrade", (req, socket, head) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/ws") {
      hub.handleUpgrade(req, socket, head);
    } else if (opts.fallbackUpgrade) {
      opts.fallbackUpgrade(req, socket, head);
    }
    // Otherwise leave the socket alone: Next.js dev attaches its own HMR upgrade listener.
  });

  const close = async () => {
    hub.close();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections?.();
    await closed;
    if (process.env.RELAY_TEST_KEEP_DB !== "1") sqlite.close();
  };

  return { server, relay, hub, sqlite, db, close };
}

export type RelayServer = ReturnType<typeof createRelayServer>;
