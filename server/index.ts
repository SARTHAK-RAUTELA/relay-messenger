// Relay entry point: one Node process serving the API (/api), the WebSocket (/ws) and the
// Next.js UI (everything else) on a single port.
import next from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRelayServer } from "./app";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "localhost";
const dbFile = process.env.RELAY_DB ?? path.join(root, "data", "relay.db");

async function main() {
  const holder: { handle?: (req: any, res: any) => Promise<void> } = {};
  const relay = createRelayServer({
    dbFile,
    fallback: (req, res) => holder.handle!(req, res),
  });
  const app = next({ dev, dir: root, hostname: host, port, httpServer: relay.server });
  await app.prepare();
  holder.handle = app.getRequestHandler();
  relay.server.listen(port, host, () => {
    console.log(`[relay] ${dev ? "dev" : "production"} server on http://${host}:${port}`);
  });
  const shutdown = async () => {
    await relay.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("[relay] failed to start:", e instanceof Error ? e.message : e);
  process.exit(1);
});
