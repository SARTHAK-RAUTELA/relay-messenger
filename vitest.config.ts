import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    testTimeout: 20000,
    hookTimeout: 20000,
    pool: "forks",
    maxWorkers: 2,
    // Closing in-memory better-sqlite3 handles between tests intermittently aborted the Windows
    // worker (0xC0000409). Test servers leave the handle to process exit instead.
    env: { RELAY_TEST_KEEP_DB: "1" },
  },
});
