// HTTP API routes (spec 5.1, 5.2).
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Relay } from "./relay";
import type { Hub } from "./hub";
import { ApiError, Errors } from "./errors";
import {
  clearSessionCookie,
  parseCookies,
  readJson,
  sendError,
  sendJson,
  sessionCookie,
  SESSION_COOKIE,
} from "./http";

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: string[];
  query: URLSearchParams;
  body: Record<string, unknown>;
  userId: number;
  sessionId: string | undefined;
}

type Result = { status?: number; body?: unknown; headers?: Record<string, string> };
type Handler = (ctx: Ctx) => Promise<Result> | Result;

interface Route {
  method: string;
  re: RegExp;
  auth: boolean;
  handler: Handler;
}

function int(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
}

/** Socket address only; proxy headers are not trusted (no proxy in this deployment). */
function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

function pathInt(s: string): number {
  const n = Number(s);
  return Number.isInteger(n) ? n : -1;
}

export function createApiHandler(relay: Relay, hub: Hub) {
  const routes: Route[] = [];
  const add = (method: string, path: string, auth: boolean, handler: Handler) => {
    const re = new RegExp("^" + path.replace(/:[a-zA-Z]+/g, "(-?\\d+)") + "$");
    routes.push({ method, re, auth, handler });
  };
  const ok = (body: unknown): Result => ({ body });
  const cookieFor = (sid: string) => sessionCookie(sid, relay.cfg.sessionTtlMs, relay.cfg.secureCookies);

  // ---- auth
  add("POST", "/api/auth/register", false, async ({ body, req }) => {
    const { user, sessionId } = await relay.register(body, clientIp(req));
    return { status: 201, body: { user }, headers: { "set-cookie": cookieFor(sessionId) } };
  });
  add("POST", "/api/auth/login", false, async ({ body, req }) => {
    const { user, sessionId } = await relay.login(body, clientIp(req));
    return { body: { user }, headers: { "set-cookie": cookieFor(sessionId) } };
  });
  add("POST", "/api/auth/logout", false, ({ sessionId }) => {
    if (sessionId) {
      relay.logout(sessionId);
      hub.closeSession(sessionId);
    }
    return { status: 204, headers: { "set-cookie": clearSessionCookie() } };
  });
  add("GET", "/api/me", true, ({ userId }) => ok(relay.me(userId)));

  // ---- H1
  add("GET", "/api/users/search", true, ({ userId, query }) => ok({ users: relay.searchUsers(userId, query.get("q") ?? "") }));
  // ---- H2
  add("GET", "/api/dialogs", true, ({ userId, query }) =>
    ok(relay.listDialogs(userId, query.get("cursor"), int(query.get("limit")))),
  );
  // ---- H5 (before :peerId routes)
  add("PUT", "/api/dialogs/pinned-order", true, ({ userId, body }) => ok(relay.reorderPinned(userId, body.order)));
  // ---- H3
  add("GET", "/api/dialogs/:peerId", true, ({ userId, params }) => ok(relay.getDialog(userId, pathInt(params[0]))));
  // ---- H4
  add("PUT", "/api/dialogs/:peerId/pin", true, ({ userId, params, body }) =>
    ok(relay.setPinned(userId, pathInt(params[0]), body.pinned)),
  );
  // ---- H6
  add("PUT", "/api/dialogs/:peerId/unread-mark", true, ({ userId, params, body }) =>
    ok(relay.setUnreadMark(userId, pathInt(params[0]), body.marked)),
  );
  // ---- H7
  add("PUT", "/api/dialogs/:peerId/draft", true, ({ userId, params, body }) =>
    ok(relay.setDraft(userId, pathInt(params[0]), body.text)),
  );
  // ---- H8
  add("POST", "/api/dialogs/:peerId/read", true, ({ userId, params, body }) =>
    ok(relay.markRead(userId, pathInt(params[0]), body.maxId)),
  );
  // ---- H9
  add("GET", "/api/dialogs/:peerId/messages", true, ({ userId, params, query }) => {
    const q = {
      before: int(query.get("before")),
      after: int(query.get("after")),
      around: int(query.get("around")),
      limit: int(query.get("limit")),
    };
    for (const v of Object.values(q)) if (Number.isNaN(v)) throw Errors.validation("Query values must be integers.");
    return ok(relay.listMessages(userId, pathInt(params[0]), q));
  });
  // ---- H10
  add("POST", "/api/dialogs/:peerId/messages", true, ({ userId, params, body }) =>
    ok(relay.sendMessage(userId, pathInt(params[0]), body)),
  );
  // ---- H11
  add("PATCH", "/api/messages/:id", true, ({ userId, params, body }) => ok(relay.editMessage(userId, pathInt(params[0]), body.text)));
  // ---- H12
  add("POST", "/api/dialogs/:peerId/messages/delete", true, ({ userId, params, body }) =>
    ok(relay.deleteMessages(userId, pathInt(params[0]), body)),
  );
  // ---- H13
  add("POST", "/api/dialogs/:peerId/forward", true, ({ userId, params, body }) =>
    ok(relay.forwardMessages(userId, pathInt(params[0]), body)),
  );
  // ---- reactions
  add("PUT", "/api/messages/:id/reaction", true, ({ userId, params, body }) =>
    ok(relay.react(userId, pathInt(params[0]), body.emoji ?? null)),
  );

  // ---- profile & account
  add("PATCH", "/api/me", true, ({ userId, body }) => ok(relay.updateProfile(userId, body)));
  add("PUT", "/api/me/email", true, ({ userId, body }) => ok(relay.updateEmail(userId, body)));
  add("POST", "/api/me/password", true, async ({ userId, sessionId, body }) => {
    const { endedSessions } = await relay.changePassword(userId, sessionId, body);
    for (const sid of endedSessions) hub.closeSession(sid);
    return ok({ ok: true });
  });
  add("POST", "/api/me/delete", true, async ({ userId, body }) => {
    const { endedSessions } = await relay.deleteAccount(userId, body);
    for (const sid of endedSessions) hub.closeSession(sid);
    hub.broadcastPresence(userId);
    return { status: 204, headers: { "set-cookie": clearSessionCookie() } };
  });

  // ---- blocking & presence
  add("PUT", "/api/users/:id/block", true, ({ userId, params, body }) => {
    const r = relay.setBlocked(userId, pathInt(params[0]), body.blocked);
    hub.sendPresence(pathInt(params[0]), userId);
    return ok(r);
  });
  add("GET", "/api/presence", true, ({ userId, query }) => ok(relay.presenceMany(userId, query.get("ids"))));

  // ---- groups
  add("POST", "/api/groups", true, ({ userId, body }) => ok(relay.createGroup(userId, body)));
  add("GET", "/api/groups/:peerId", true, ({ userId, params }) => ok(relay.getGroup(userId, pathInt(params[0]))));
  add("PATCH", "/api/groups/:peerId", true, ({ userId, params, body }) => ok(relay.renameGroup(userId, pathInt(params[0]), body)));
  add("POST", "/api/groups/:peerId/members", true, ({ userId, params, body }) =>
    ok(relay.addMembers(userId, pathInt(params[0]), body)),
  );
  add("POST", "/api/groups/:peerId/members/:userId/remove", true, ({ userId, params }) =>
    ok(relay.removeMember(userId, pathInt(params[0]), pathInt(params[1]))),
  );

  // ---- secret chats
  add("PUT", "/api/keys", true, ({ userId, body }) => ok(relay.registerKey(userId, body.publicKey)));
  add("POST", "/api/secret-chats", true, ({ userId, body }) => ok(relay.createSecretChat(userId, body)));

  // ---- H14
  add("GET", "/api/sync", true, ({ userId, query }) => {
    const r = relay.sync(userId, int(query.get("since")), int(query.get("limit")));
    if (r.reset) {
      return { status: 410, body: { error: { code: "SYNC_RESET", message: "Too far behind; reload required." }, seq: r.seq } };
    }
    return ok({ events: r.events, seq: r.seq, more: r.more });
  });

  return async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";
      let matched: { route: Route; params: string[] } | null = null;
      let pathMatched = false;
      for (const route of routes) {
        const m = route.re.exec(url.pathname);
        if (!m) continue;
        pathMatched = true;
        if (route.method !== method) continue;
        matched = { route, params: m.slice(1) };
        break;
      }
      if (!matched) {
        throw pathMatched
          ? new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed.")
          : new ApiError(404, "NOT_FOUND", "No such endpoint.");
      }
      const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      let userId = 0;
      if (matched.route.auth) {
        const user = relay.sessionUser(sessionId);
        if (!user) throw Errors.unauthorized();
        userId = user.id;
      }
      if (method !== "GET") {
        // CSRF hardening: mutations must be JSON (a cross-site HTML form cannot send this type).
        const ct = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
        if (ct !== "application/json") {
          throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Send requests as application/json.");
        }
      }
      const body = method === "GET" ? {} : await readJson(req);
      const result = await matched.route.handler({
        req,
        res,
        params: matched.params,
        query: url.searchParams,
        body,
        userId,
        sessionId,
      });
      if (result.status === 204) {
        res.writeHead(204, result.headers ?? {});
        res.end();
        return;
      }
      sendJson(res, result.status ?? 200, result.body, result.headers);
    } catch (err) {
      sendError(res, err);
    }
  };
}
