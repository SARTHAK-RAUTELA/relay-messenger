import { defineConfig } from "@playwright/test";

const PORT = 3311;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  webServer: {
    command: "npx next build && npx cross-env NODE_ENV=production tsx scripts/e2e-server.ts",
    url: `http://localhost:${PORT}/api/me`,
    timeout: 240_000,
    reuseExistingServer: false,
    env: {
      PORT: String(PORT),
      RELAY_DB: "data/e2e.db",
      RELAY_RATE_LIMIT_COUNT: "100000",
      RELAY_REGISTER_MAX_PER_IP: "100000",
    },
  },
});
