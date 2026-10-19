# Relay

A real-time browser messenger with private chats, group chats and end-to-end encrypted secret chats. It has a Next.js (React, TypeScript) client and a Node HTTP API with WebSocket push, backed by SQLite through Drizzle ORM. One process serves the UI, `/api/*` and `/ws` on a single port.

Messages are text only for now (no attachments). See [Status](#status) for exactly what is done and what is left.

## Status

### Done

**Accounts and sessions**
- Create an account with username, email, display name and password. Accounts are stored in the database (`data/relay.db`), so they survive restarts.
- Usernames and emails are unique (ignoring capital letters): a second sign-up with a taken username or email is refused (`USERNAME_TAKEN` / `EMAIL_TAKEN`).
- Sign in with the username or the email, on as many devices as you like; chats stay in sync across them (except secret chats, see below).
- The email is private: only its owner sees it (`GET /api/me`). Accounts created before emails existed can add one in Settings (`PUT /api/me/email`).
- Log out; passwords hashed with bcrypt; session cookie (`HttpOnly`, optional `Secure`).
- Login throttling per IP and per username; registration limit per IP.
- WebSocket connections are closed (code 4401) when the session ends; optional Origin allow-list.
- Settings (click your name in the sidebar): change display name, change password (signs out your other devices), delete account (name becomes "Deleted account", sign-in stops, you leave all groups; others keep the history).

**People**
- Online / last-seen status in the chat header and an online dot in the chat list.
- Typing indicator ("typing…", or "Ben is typing…" in groups) in the header and chat list.
- Block / unblock from the chat menu: a blocked person can't message you, start secret chats with you, see your online status or send you typing notices.

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
- Reactions (👍 ❤️ 😂 😮 😢 🙏), one per person per message, shown as counters under the bubble.
- History paging (older / newer / around a message) without scroll jumps; opens at the first unread message with an "unread" divider; go-to-bottom button; scroll position remembered per chat.

**Group chats**
- Create a group ("+ New group" in the sidebar) with a name and members (up to 200).
- Messages show the author's name; the chat list shows "Ben: …" for the last message.
- System messages for created / added / removed / left / renamed.
- Group info (chat menu): rename, add people (any member), remove people (owner only), leave. If the owner leaves, the longest-standing member becomes owner.
- "Read" ticks mean at least one other member has read the message.
- Delete for everyone works on your own messages; the owner can also delete anyone's.
- New members see the group's earlier history. Removed members lose access to it.

**Secret chats (end-to-end encrypted)**
- Start one from a person's chat menu ("Start secret chat"). It appears as a separate 🔒 chat.
- Each browser creates an ECDH P-256 key pair; the private key is non-extractable and stays in that browser's IndexedDB. Only the public key is sent to the server.
- Message key: HKDF-SHA-256 over the ECDH shared secret, bound to the chat id. Each message is AES-256-GCM with a fresh IV (`e1:<iv>:<ciphertext>`). The server rejects anything that isn't in this format, so plain text can't be stored by mistake.
- Replies and edits work. Forwarding into or out of secret chats is blocked, and secret-chat drafts stay in the browser (never sent to the server).
- "Encryption key" in the chat menu shows a fingerprint both people can compare to rule out a man-in-the-middle.
- A secret chat belongs to the browser that started or received it. On another device or browser it shows "can't be read here", like Telegram.
- Needs a secure context (https or localhost); over plain http on a LAN address the browser has no WebCrypto, and the app says so.

**Sync**
- Per-user event log with sequence numbers; clients catch up through `GET /api/sync` after reconnect, with gap detection. If a client is too far behind, the server answers `410 SYNC_RESET` and the client reloads.
- Event log retention (last 10 000 events or 30 days, whichever keeps more).

**Quality**
- Strict TypeScript (`npm run typecheck` is clean).
- Vitest suites: server integration, client-core integration, unit, and jsdom UI tests (226 tests, all passing).
- Playwright end-to-end tests in a real browser: read receipts, pin reordering, history paging, unread divider, reply jumps, registration, edit, delete-for-everyone, forwarding, drafts across sessions, sending while offline, group chat with typing, reactions and presence, and a secret chat whose server copy is checked to be ciphertext only.
- Presence and typing notices travel over the WebSocket only. They are not stored in the event log, and clients re-fetch presence after reconnecting.
- `start-relay.bat`: one-click Windows launcher that starts the server and an ngrok tunnel so other devices can join (it contains machine-specific paths and an ngrok domain; edit them before using it).

### Left to do

**Product features not started**
- Attachments: images, files, voice messages.
- Message search.
- Notifications (browser push / sound).
- Avatars (profile pictures for people and groups).
- Reporting users (blocking exists, reporting does not).
- Group admin roles beyond a single owner, invite links, and an option to hide history from new members.

**Secret chat limits**
- One device per secret chat. Multi-device secret chats would need per-device keys and fan-out encryption.
- Fixed keys: no key rotation or forward secrecy (no ratchet), and no self-destruct timers.
- Reactions and message timestamps in secret chats are visible to the server (only the text is encrypted).
- Losing the browser's storage (clearing site data) makes that device's secret chats unreadable; there is no backup.

**Engineering and operations**
- Deployment setup: no Dockerfile, hosting config or CI pipeline yet. SQLite plus an in-process WebSocket hub means a single server instance; scaling out would need a shared database and pub/sub.
- Database backups and a documented migration workflow for production (migrations run automatically on start; `drizzle/0001_groups_secret_presence.sql` rebuilds the `messages` table, so back up `data/relay.db` before upgrading a real install).
- Logging, metrics and error reporting.
- Performance: the dialog list and message rendering use simple per-row queries that are fine for a small install but will need batching for large groups or many chats.
- The specification the code refers to (`H1`–`H14` for HTTP routes, `OD-*` for configurable decisions, `AC-*` for acceptance criteria, `BR-*` for business rules) is not in this repository; add it under `docs/` so those references can be followed.

## Requirements
- Node 24 (tested on 24.15 on Windows)
- npm

## Setup
```bash
npm install
npm run seed        # dev only: creates data/relay.db with demo users ada / ben / cyd (password: relay-demo)
                    # and a group "Weekend plans"
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
| | `PUT /api/messages/:id/reaction` | set or clear (`emoji: null`) my reaction |
| | `PATCH /api/me`, `POST /api/me/password`, `POST /api/me/delete` | profile, password, account deletion |
| | `PUT /api/users/:id/block`, `GET /api/presence?ids=` | blocking, presence |
| | `POST /api/groups`, `GET`/`PATCH /api/groups/:peerId` | create, read, rename a group |
| | `POST /api/groups/:peerId/members`, `POST /api/groups/:peerId/members/:userId/remove` | add, remove or leave |
| | `PUT /api/keys`, `POST /api/secret-chats` | register a device key, start a secret chat |

**Peer ids.** Every conversation is addressed by one integer (`src/shared/peer.ts`): a positive id is a user (one-to-one chat), `-groupId` is a group, and `-(1 000 000 000 + secretChatId)` is a secret chat. That is why pins, drafts, read cursors and the `:peerId` routes work the same for all three.

WebSocket frames: `hello`, `event` (logged, replayable), `pong`, and ephemeral `presence` / `typing`. Clients send `ping` and `{ kind: "typing", peerId }`.

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
  relay.ts         all server rules (send, read, edit, delete, forward, reactions, pins, drafts,
                   groups, secret chats, blocking, presence, profile, sync, auth)
  api.ts           HTTP routes (spec H1-H14, auth, and the routes above)
  hub.ts           WebSocket push (hello / event / pong / presence / typing, close 4401)
  config.ts        defaults and environment variable overrides
  db/schema.ts     Drizzle schema; migrations in drizzle/
src/shared/        wire types, text rules (preview, split), dialog ordering, peer ids; used by both sides
src/client/        framework-free client core (Messenger): cache, sync engine, send queue,
                   read tracker, history paging, presence/typing; derive.ts holds pure
                   presentation rules; secret.ts holds the secret-chat cryptography
src/components/    React UI; src/app/ is the Next.js app router shell
scripts/           seed.ts (dev data), e2e-server.ts (server for Playwright)
tests/             server/, client/, unit/, ui/ (jsdom), helpers/
e2e/               Playwright specs
start-relay.bat    Windows launcher: server + ngrok tunnel
```
