# Relay

A browser messenger for one-to-one text conversations. It has a Next.js (React, TypeScript) client and a Node HTTP API with WebSocket push, backed by SQLite through Drizzle ORM. One process serves the UI, `/api/*` and `/ws` on a single port.

The long-term goal is a real-time messenger with private chats, groups and end-to-end encrypted secret chats. **Today only private (1:1) text chats are built.** See [Status](#status) for exactly what is done and what is left.

## Status

### Done

**Accounts and sessions**
- Register, log in, log out; passwords hashed with bcrypt; session cookie (`HttpOnly`, optional `Secure`).
- Login throttling per IP and per username; registration limit per IP.
- WebSocket connections are closed (code 4401) when the session ends; optional Origin allow-list.

**Conversations (dialogs)**
- User search to start a new chat.
- Dialog list ordered by last activity, with paging, unread counts and message previews.
- Pin / unpin conversations (limit 5 by default) and reorder pins by drag; order syncs across tabs and devices.
- Mark a conversation as unread.
- Drafts saved to the server after a pause in typing and restored on any device.

**Messages**
- Send text messages; long text is split; per-user send rate limit.
- Offline-tolerant send queue with retries and client tokens (no duplicates on retry).
- Delivery / read status ticks; messages count as read only while the window is focused.
- Reply to a message, with jump-to-original and highlight.
- Edit (within 48 h by default), shown as edited.
- Delete for me, or delete for everyone (optionally on the peer's messages too).
- Forward one or many messages to another chat, keeping the "forwarded from" header.
- History paging (older / newer / around a message) without scroll jumps; opens at the first unread message with an "unread" divider; go-to-bottom button; scroll position remembered per chat.

**Sync**
- Per-user event log with sequence numbers; clients catch up through `GET /api/sync` after reconnect, with gap detection. If a client is too far behind, the server answers `410 SYNC_RESET` and the client reloads.
- Event log retention (last 10 000 events or 30 days, whichever keeps more).

**Quality**
- Strict TypeScript (`npm run typecheck` is clean).
- Vitest suites: server integration, client-core integration, unit, and jsdom UI tests (172 tests; see the known flaky test below).
- Playwright end-to-end tests for read receipts, pin reordering, history paging, unread divider and reply jumps (last run: passing).
- `start-relay.bat`: one-click Windows launcher that starts the server and an ngrok tunnel so other devices can join (it contains machine-specific paths and an ngrok domain; edit them before using it).

### Left to do

**Product features not started**
- Group chats (schema, API, UI, and sync are all 1:1 only today).
- End-to-end encrypted secret chats.
- Attachments: images, files, voice messages.
- Typing indicator and online / last-seen presence.
- Reactions, message search, notifications (browser push / sound).
- Profile editing (display name, avatar), password change, account deletion.
- Block / report users.

**Engineering and operations**
- Fix a flaky UI test: `tests/ui/app.test.tsx` "AC-66 (G2): multi-target forward shows a confirmation naming the targets" failed once in a full `npm test` run (toast text checked before it named every target) but passes when run alone.
- Deployment setup: no Dockerfile, hosting config or CI pipeline yet. SQLite plus an in-process WebSocket hub means a single server instance; scaling out would need a shared database and pub/sub.
- Database backups and a documented migration workflow for production.
- Logging, metrics and error reporting.
- More end-to-end coverage (registration, edit, delete, forward, drafts, offline send).
- The specification the code refers to (`H1`–`H14` for HTTP routes, `OD-*` for configurable decisions, `AC-*` for acceptance criteria, `BR-*` for business rules) is not in this repository; add it under `docs/` so those references can be followed.

## Requirements
- Node 24 (tested on 24.15 on Windows)
- npm

## Setup
```bash
npm install
npm run seed        # dev only: creates data/relay.db with demo users ada / ben (password: relay-demo)
```

## Run
```bash
npm run dev         # development (Next dev + API + WS) on http://localhost:3000
npm run build       # production build of the UI
npm start           # production server (NODE_ENV=production) on http://localhost:3000
```
To try it, open two different browsers (or one private window), sign in as `ada` in one and `ben` in the other, and chat.

Environment variables (all optional):
| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | 3000 / localhost | listen address |
| `RELAY_DB` | `data/relay.db` | SQLite file |
| `RELAY_EDIT_LIMIT_MS` | 172800000 (48 h) | edit window (OD-4) |
| `RELAY_REVOKE_LIMIT_MS` | unset (no limit) | delete-for-everyone window (OD-4) |
| `RELAY_REVOKE_PEER_MESSAGES` | true | allow delete-for-everyone on the peer's messages (OD-19) |
| `RELAY_PIN_LIMIT` | 5 | pinned conversations (OD-9) |
| `RELAY_RATE_LIMIT_COUNT` / `_WINDOW_MS` | 30 / 10000 | send rate limit (OD-20) |
| `RELAY_RETENTION_EVENTS` / `_AGE_MS` | 10000 / 30 days | event log retention (OD-11) |
| `RELAY_SECURE_COOKIES` | false | add `Secure` to the session cookie (set under HTTPS) |
| `RELAY_AUTH_MAX_FAILURES` / `RELAY_AUTH_WINDOW_MS` | 5 / 900000 | login failures allowed per IP and per username per window |
| `RELAY_REGISTER_MAX_PER_IP` | 10 | registrations per IP per window |
| `RELAY_ALLOWED_ORIGINS` | unset (same-origin) | comma-separated WebSocket Origin allow-list |

## HTTP API

All routes except auth need the session cookie. Real-time events arrive over `/ws` and can be replayed with `/api/sync`.

| Spec | Method and path | Purpose |
|---|---|---|
| auth | `POST /api/auth/register`, `/login`, `/logout`; `GET /api/me` | accounts and session |
| H1 | `GET /api/users/search?q=` | find users |
| H2 | `GET /api/dialogs` | list conversations |
| H3 | `GET /api/dialogs/:peerId` | one conversation |
| H4 | `PUT /api/dialogs/:peerId/pin` | pin / unpin |
| H5 | `PUT /api/dialogs/pinned-order` | reorder pins |
| H6 | `PUT /api/dialogs/:peerId/unread-mark` | mark unread |
| H7 | `PUT /api/dialogs/:peerId/draft` | save draft |
| H8 | `POST /api/dialogs/:peerId/read` | mark read up to a message |
| H9 | `GET /api/dialogs/:peerId/messages` | history (`before` / `after` / `around`) |
| H10 | `POST /api/dialogs/:peerId/messages` | send |
| H11 | `PATCH /api/messages/:id` | edit |
| H12 | `POST /api/dialogs/:peerId/messages/delete` | delete for me / for everyone |
| H13 | `POST /api/dialogs/:peerId/forward` | forward |
| H14 | `GET /api/sync?since=` | catch up on missed events |

## Test
```bash
npm test            # vitest: server integration, client-core integration, unit, jsdom UI
npm run typecheck   # tsc --noEmit
npm run test:e2e    # Playwright (run `npx playwright install chromium` once); builds, then runs
                    # the production server on port 3311 against a throwaway data/e2e.db
```

## Layout
```
server/            Node backend
  index.ts         entry: Next request handler + API + WebSocket on one http server
  app.ts           composition (DB, rules, routes, hub); used directly by tests
  relay.ts         all server rules (send, read, edit, delete, forward, pins, drafts, sync, auth)
  api.ts           HTTP routes (spec H1-H14 + auth)
  hub.ts           WebSocket push (hello / event / pong, close 4401)
  config.ts        defaults and environment variable overrides
  db/schema.ts     Drizzle schema; migrations in drizzle/
src/shared/        wire types, text rules (preview, split), dialog ordering; used by both sides
src/client/        framework-free client core (Messenger): cache, sync engine, send queue,
                   read tracker, history paging; derive.ts holds pure presentation rules
src/components/    React UI; src/app/ is the Next.js app router shell
scripts/           seed.ts (dev data), e2e-server.ts (server for Playwright)
tests/             server/, client/, unit/, ui/ (jsdom), helpers/
e2e/               Playwright specs
start-relay.bat    Windows launcher: server + ngrok tunnel
```
