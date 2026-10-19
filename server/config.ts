// Server configuration. Defaults follow spec section 10 (OD-*). All values can be overridden
// through environment variables or programmatically (tests).

export interface ServerConfig {
  /** OD-4: edit window in ms (default 48 h). */
  editLimitMs: number;
  /** OD-4: delete-for-everyone window in ms; null = no limit (default). */
  revokeLimitMs: number | null;
  /** OD-19: allow delete-for-everyone on the peer's messages. */
  revokePeerMessages: boolean;
  /** OD-6 */
  maxTextLen: number;
  /** OD-9 */
  pinLimit: number;
  /** OD-20: sends per window per user. */
  rateLimitCount: number;
  rateLimitWindowMs: number;
  /** OD-11: keep at least this many events per user ... */
  retentionMinEvents: number;
  /** ... and at least this much history (ms), whichever is larger. */
  retentionMinAgeMs: number;
  /** OD-10 */
  syncDefaultLimit: number;
  syncMaxLimit: number;
  sessionTtlMs: number;
  bcryptCost: number;
  secureCookies: boolean;
  /** Auth throttling: failures allowed per key (IP, username) within the window. */
  authMaxFailures: number;
  authWindowMs: number;
  /** Registrations allowed per IP within the auth window. */
  registerMaxPerIp: number;
  /**
   * WebSocket Origin allow-list. null = same-origin only (Origin host must equal the Host header).
   * Upgrades without an Origin header (non-browser clients) are allowed.
   */
  allowedOrigins: string[] | null;
  /** Clock (injectable for tests). */
  now: () => number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const revoke = process.env.RELAY_REVOKE_LIMIT_MS;
  return {
    editLimitMs: envInt("RELAY_EDIT_LIMIT_MS", 48 * HOUR),
    revokeLimitMs: revoke ? Number(revoke) : null,
    revokePeerMessages: process.env.RELAY_REVOKE_PEER_MESSAGES !== "false",
    maxTextLen: envInt("RELAY_MAX_TEXT_LEN", 4096),
    pinLimit: envInt("RELAY_PIN_LIMIT", 5),
    rateLimitCount: envInt("RELAY_RATE_LIMIT_COUNT", 30),
    rateLimitWindowMs: envInt("RELAY_RATE_LIMIT_WINDOW_MS", 10_000),
    retentionMinEvents: envInt("RELAY_RETENTION_EVENTS", 10_000),
    retentionMinAgeMs: envInt("RELAY_RETENTION_AGE_MS", 30 * DAY),
    syncDefaultLimit: 500,
    syncMaxLimit: 1000,
    sessionTtlMs: envInt("RELAY_SESSION_TTL_MS", 30 * DAY),
    bcryptCost: envInt("RELAY_BCRYPT_COST", 10),
    secureCookies: process.env.RELAY_SECURE_COOKIES === "true",
    authMaxFailures: envInt("RELAY_AUTH_MAX_FAILURES", 5),
    authWindowMs: envInt("RELAY_AUTH_WINDOW_MS", 15 * 60_000),
    registerMaxPerIp: envInt("RELAY_REGISTER_MAX_PER_IP", 10),
    allowedOrigins: process.env.RELAY_ALLOWED_ORIGINS
      ? process.env.RELAY_ALLOWED_ORIGINS.split(",")
          .map((s) => s.trim().replace(/\/$/, ""))
          .filter(Boolean)
      : null,
    now: () => Date.now(),
    ...overrides,
  };
}
