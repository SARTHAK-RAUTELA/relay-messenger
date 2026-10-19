// Starts the production server on a fresh database for Playwright (never used for real data).
import fs from "node:fs";

const db = process.env.RELAY_DB ?? "data/e2e.db";
if (!/e2e/.test(db)) throw new Error("e2e-server only runs against an e2e database");
for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(db + suffix, { force: true });
await import("../server/index");
