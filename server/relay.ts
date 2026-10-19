// Core server rules (spec sections 3, 5, 6). Transport-agnostic: the HTTP layer calls these
// methods; every state change and its events are committed in one SQLite transaction and
// pushed to connected sockets after commit (BR-SYNC-1).

import type Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";
import type { DB } from "./db/client";
import { dialogs, events, messageHidden, messages, sessions, users } from "./db/schema";
import type { ServerConfig } from "./config";
import { ApiError, Errors } from "./errors";
import type { Dialog, EventPayloads, EventType, Message, SyncEvent, UserSummary } from "../src/shared/types";
import { isBlank, isUuid, previewText } from "../src/shared/text";
import { activityDate, compareDialogs } from "../src/shared/dialogOrder";

type UserRow = typeof users.$inferSelect;
type MessageRow = typeof messages.$inferSelect;
type DialogRow = typeof dialogs.$inferSelect;

export interface PushedEvent {
  userId: number;
  seq: number;
  type: EventType;
  data: unknown;
}

export type Pusher = (events: PushedEvent[]) => void;

const USERNAME_RE = /^[A-Za-z0-9_]{3,32}$/;
const MAX_IDS = 100;

function conv(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a];
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

export class Relay {
  /** Called after each committed write with the events appended, in commit order. */
  pusher: Pusher = () => {};
  private collected: PushedEvent[] | null = null;
  private sendLog = new Map<number, number[]>();

  constructor(
    readonly db: DB,
    private readonly sqlite: Database.Database,
    readonly cfg: ServerConfig,
  ) {}

  private now(): number {
    return this.cfg.now();
  }

  // ---------------------------------------------------------------- transactions & events

  private write<T>(fn: () => T): T {
    const collected: PushedEvent[] = [];
    this.collected = collected;
    let result: T;
    try {
      result = this.sqlite.transaction(fn)();
    } finally {
      this.collected = null;
    }
    if (collected.length > 0) {
      this.pusher(collected);
      this.prune(new Set(collected.map((e) => e.userId)));
    }
    return result;
  }

  /** Appends one event to a user's log inside the current transaction (spec 3.5). */
  private emit<K extends EventType>(userId: number, type: K, data: EventPayloads[K]): void {
    if (!this.collected) throw new Error("emit outside of a write transaction");
    const row = this.db
      .update(users)
      .set({ currentSeq: sql`${users.currentSeq} + 1` })
      .where(eq(users.id, userId))
      .returning({ seq: users.currentSeq })
      .get();
    if (!row) throw new Error("emit: unknown user");
    this.db
      .insert(events)
      .values({ userId, seq: row.seq, type, payload: JSON.stringify(data), createdAt: this.now() })
      .run();
    this.collected.push({ userId, seq: row.seq, type, data });
  }

  /** OD-11 retention: keep the last N events or the last T ms, whichever is larger. */
  private prune(userIds: Set<number>): void {
    const cutoff = this.now() - this.cfg.retentionMinAgeMs;
    for (const userId of userIds) {
      const cur = this.currentSeq(userId);
      const keepFrom = cur - this.cfg.retentionMinEvents;
      if (keepFrom <= 0) continue;
      this.db
        .delete(events)
        .where(and(eq(events.userId, userId), lte(events.seq, keepFrom), lt(events.createdAt, cutoff)))
        .run();
    }
  }

  currentSeq(userId: number): number {
    return this.db.select({ s: users.currentSeq }).from(users).where(eq(users.id, userId)).get()?.s ?? 0;
  }

  // ---------------------------------------------------------------- auth (OD-1)

  // Auth throttling (sliding window per key). Keys: "ip:<addr>", "user:<lower>", "reg:<addr>".
  private authLog = new Map<string, number[]>();
  private dummyHash: string | null = null;

  private recentAuth(key: string): number[] {
    const cutoff = this.now() - this.cfg.authWindowMs;
    const list = (this.authLog.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.authLog.set(key, list);
    else this.authLog.delete(key);
    return list;
  }

  private throttle(keys: { key: string; max: number }[]): void {
    let retryAfterMs = 0;
    for (const { key, max } of keys) {
      const list = this.recentAuth(key);
      if (list.length >= max) {
        // Backoff: blocked until the oldest counted attempt leaves the window.
        retryAfterMs = Math.max(retryAfterMs, list[list.length - max] + this.cfg.authWindowMs - this.now());
      }
    }
    if (retryAfterMs > 0) {
      throw new ApiError(429, "RATE_LIMITED", "Too many attempts. Please wait and try again.", Math.max(1, retryAfterMs));
    }
  }

  private recordAuth(keys: string[]): void {
    const now = this.now();
    for (const key of keys) this.authLog.set(key, [...this.recentAuth(key), now]);
  }

  async register(input: { username?: unknown; displayName?: unknown; password?: unknown }, ip = "unknown") {
    // Every registration attempt counts against the caller's IP.
    this.throttle([{ key: "reg:" + ip, max: this.cfg.registerMaxPerIp }]);
    this.recordAuth(["reg:" + ip]);
    const { username, displayName, password } = input;
    if (typeof username !== "string" || !USERNAME_RE.test(username)) {
      throw Errors.validation("Usernames are 3-32 letters, digits or underscores.");
    }
    if (typeof displayName !== "string" || displayName.trim().length < 1 || displayName.trim().length > 64) {
      throw Errors.validation("Display names are 1-64 characters.");
    }
    if (typeof password !== "string" || password.length < 6 || password.length > 200) {
      throw Errors.validation("Passwords need at least 6 characters.");
    }
    const lower = username.toLowerCase();
    const taken = this.db.select({ id: users.id }).from(users).where(eq(users.usernameLower, lower)).get();
    if (taken) throw new ApiError(409, "USERNAME_TAKEN", "That username is already in use.");
    const passwordHash = await bcrypt.hash(password, this.cfg.bcryptCost);
    try {
      const row = this.db
        .insert(users)
        .values({ username, usernameLower: lower, displayName: displayName.trim(), passwordHash, createdAt: this.now() })
        .returning()
        .get();
      return { user: this.summary(row), sessionId: this.createSession(row.id) };
    } catch (e) {
      if (String(e).includes("UNIQUE")) throw new ApiError(409, "USERNAME_TAKEN", "That username is already in use.");
      throw e;
    }
  }

  async login(input: { username?: unknown; password?: unknown }, ip = "unknown") {
    const bad = new ApiError(401, "INVALID_CREDENTIALS", "Username or password is incorrect.");
    const lower = typeof input.username === "string" ? input.username.toLowerCase().slice(0, 64) : "";
    const keys = ["ip:" + ip, "user:" + lower];
    const max = this.cfg.authMaxFailures;
    // Same throttle and same generic errors whether or not the account exists (no enumeration).
    this.throttle(keys.map((key) => ({ key, max })));
    if (typeof input.username !== "string" || typeof input.password !== "string") {
      this.recordAuth(keys);
      throw bad;
    }
    const row = this.db.select().from(users).where(eq(users.usernameLower, lower)).get();
    // Compare against a dummy hash for unknown users so timing does not reveal existence.
    if (!this.dummyHash) this.dummyHash = await bcrypt.hash("relay-dummy-password", this.cfg.bcryptCost);
    const ok = await bcrypt.compare(input.password, row?.passwordHash ?? this.dummyHash);
    if (!row || !ok) {
      this.recordAuth(keys);
      throw bad;
    }
    this.authLog.delete("user:" + lower);
    return { user: this.summary(row), sessionId: this.createSession(row.id) };
  }

  private createSession(userId: number): string {
    const id = crypto.randomBytes(32).toString("base64url");
    const now = this.now();
    this.db.insert(sessions).values({ id, userId, createdAt: now, expiresAt: now + this.cfg.sessionTtlMs }).run();
    return id;
  }

  sessionUser(sessionId: string | undefined | null): UserSummary | null {
    if (!sessionId) return null;
    const row = this.db
      .select({ user: users, expiresAt: sessions.expiresAt })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.id, sessionId))
      .get();
    if (!row) return null;
    if (row.expiresAt < this.now()) {
      this.db.delete(sessions).where(eq(sessions.id, sessionId)).run();
      return null;
    }
    return this.summary(row.user);
  }

  logout(sessionId: string): void {
    this.db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  }

  me(userId: number) {
    const row = this.db.select().from(users).where(eq(users.id, userId)).get();
    if (!row) throw Errors.unauthorized();
    return { user: this.summary(row), seq: row.currentSeq, serverTime: this.now() };
  }

  // ---------------------------------------------------------------- helpers

  private summary(u: UserRow): UserSummary {
    return { id: u.id, username: u.username, displayName: u.displayName };
  }

  private user(id: number): UserRow | undefined {
    return this.db.select().from(users).where(eq(users.id, id)).get();
  }

  private requirePeer(me: number, peerId: unknown): UserRow {
    if (!isInt(peerId) || peerId === me) throw Errors.peerInvalid();
    const peer = this.user(peerId);
    if (!peer) throw Errors.peerInvalid();
    return peer;
  }

  private inConv(a: number, b: number): SQL {
    const [lo, hi] = conv(a, b);
    return and(eq(messages.convLow, lo), eq(messages.convHigh, hi))!;
  }

  private visibleTo(userId: number): SQL {
    return and(
      isNull(messages.deletedForEveryoneAt),
      sql`not exists (select 1 from message_hidden h where h.user_id = ${userId} and h.message_id = ${messages.id})`,
    )!;
  }

  private isVisible(m: MessageRow, userId: number): boolean {
    if (m.senderId !== userId && m.recipientId !== userId) return false;
    if (m.deletedForEveryoneAt != null) return false;
    const hidden = this.db
      .select({ x: messageHidden.messageId })
      .from(messageHidden)
      .where(and(eq(messageHidden.userId, userId), eq(messageHidden.messageId, m.id)))
      .get();
    return !hidden;
  }

  private getMessage(id: number): MessageRow | undefined {
    return this.db.select().from(messages).where(eq(messages.id, id)).get();
  }

  private forwardName(m: MessageRow): string {
    if (m.fwdFromUserId != null) {
      const u = this.user(m.fwdFromUserId);
      if (u) return u.displayName;
    }
    return m.fwdFromName ?? "";
  }

  /** Viewer-relative wire message (spec 4.2). */
  wireMessage(m: MessageRow, viewerId: number): Message {
    const out = m.senderId === viewerId;
    let replyTo: Message["replyTo"] = null;
    if (m.replyToId != null) {
      const orig = this.getMessage(m.replyToId);
      if (orig && this.isVisible(orig, viewerId)) {
        const senderName = orig.fwdFromDate != null ? this.forwardName(orig) : (this.user(orig.senderId)?.displayName ?? "");
        replyTo = { id: orig.id, deleted: false, senderId: orig.senderId, senderName, snippet: previewText(orig.text) };
      } else {
        replyTo = { id: m.replyToId, deleted: true };
      }
    }
    const msg: Message = {
      id: m.id,
      peerId: out ? m.recipientId : m.senderId,
      senderId: m.senderId,
      out,
      text: m.text,
      date: m.createdAt,
      editDate: m.editedAt ?? null,
      replyTo,
      forwardedFrom:
        m.fwdFromDate != null ? { userId: m.fwdFromUserId ?? null, name: this.forwardName(m), date: m.fwdFromDate } : null,
    };
    if (out) msg.clientToken = m.clientToken;
    return msg;
  }

  private dialogRow(ownerId: number, peerId: number): DialogRow | undefined {
    return this.db
      .select()
      .from(dialogs)
      .where(and(eq(dialogs.ownerId, ownerId), eq(dialogs.peerId, peerId)))
      .get();
  }

  private ensureDialog(ownerId: number, peerId: number, touch: boolean): void {
    const now = this.now();
    if (touch) {
      this.db
        .insert(dialogs)
        .values({ ownerId, peerId, touchedAt: now })
        .onConflictDoUpdate({ target: [dialogs.ownerId, dialogs.peerId], set: { touchedAt: now } })
        .run();
    } else {
      this.db.insert(dialogs).values({ ownerId, peerId, touchedAt: now }).onConflictDoNothing().run();
    }
  }

  private topMessage(ownerId: number, peerId: number): MessageRow | undefined {
    return this.db
      .select()
      .from(messages)
      .where(and(this.inConv(ownerId, peerId), this.visibleTo(ownerId)))
      .orderBy(desc(messages.id))
      .limit(1)
      .get();
  }

  private unreadCount(ownerId: number, peerId: number, cursor: number): number {
    const r = this.db
      .select({ n: sql<number>`count(*)` })
      .from(messages)
      .where(
        and(this.inConv(ownerId, peerId), this.visibleTo(ownerId), eq(messages.senderId, peerId), gt(messages.id, cursor)),
      )
      .get();
    return Number(r?.n ?? 0);
  }

  private dialogView(ownerId: number, peer: UserRow, row: DialogRow | undefined): Dialog & { touchedAt: number } {
    const top = this.topMessage(ownerId, peer.id);
    const cursor = row?.readInboxMaxId ?? 0;
    const draft = row?.draftText ? { text: row.draftText, date: row.draftUpdatedAt ?? 0 } : null;
    const peerRow = this.dialogRow(peer.id, ownerId);
    return {
      peer: this.summary(peer),
      topMessage: top ? this.wireMessage(top, ownerId) : null,
      unreadCount: this.unreadCount(ownerId, peer.id, cursor),
      unreadMark: row?.unreadMark ?? false,
      pinned: row?.pinned ?? false,
      pinOrder: row?.pinned ? (row.pinOrder ?? 0) : null,
      draft,
      readInboxMaxId: cursor,
      readOutboxMaxId: peerRow?.readInboxMaxId ?? 0,
      activityDate: activityDate(top?.createdAt, draft),
      touchedAt: row?.touchedAt ?? 0,
    };
  }

  private strip(d: Dialog & { touchedAt?: number }): Dialog {
    const { touchedAt: _t, ...rest } = d;
    return rest;
  }

  // ---------------------------------------------------------------- H1 search

  searchUsers(me: number, q: string): UserSummary[] {
    const term = q.trim().toLowerCase();
    if (!term) return [];
    const esc = term.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
    return this.db
      .select()
      .from(users)
      .where(
        and(
          ne(users.id, me),
          or(sql`${users.usernameLower} like ${esc} escape '\\'`, sql`lower(${users.displayName}) like ${esc} escape '\\'`),
        ),
      )
      .orderBy(asc(users.usernameLower))
      .limit(20)
      .all()
      .map((u) => this.summary(u));
  }

  // ---------------------------------------------------------------- H2/H3 dialogs

  listDialogs(me: number, cursor: string | null, limitRaw: unknown) {
    let limit = isInt(limitRaw) ? limitRaw : 50;
    limit = Math.max(1, Math.min(100, limit));
    const rows = this.db.select().from(dialogs).where(eq(dialogs.ownerId, me)).all();
    const views: (Dialog & { touchedAt: number })[] = [];
    for (const row of rows) {
      const peer = this.user(row.peerId);
      if (!peer) continue;
      const hasDraft = !!row.draftText;
      const anyMessage = this.db
        .select({ id: messages.id })
        .from(messages)
        .where(this.inConv(me, row.peerId))
        .limit(1)
        .get();
      if (!anyMessage && !hasDraft && !row.pinned) continue; // BR-LIST-14
      views.push(this.dialogView(me, peer, row));
    }
    views.sort((a, b) => compareDialogs({ ...a, peerId: a.peer.id }, { ...b, peerId: b.peer.id }));
    const pinnedCount = views.filter((v) => v.pinned).length;
    limit = Math.max(limit, pinnedCount); // all pinned dialogs are on the first page
    const offset = cursor ? Math.max(0, Number(cursor) || 0) : 0;
    const page = views.slice(offset, offset + limit);
    const next = offset + limit < views.length ? String(offset + limit) : null;
    return { dialogs: page.map((d) => this.strip(d)), nextCursor: next, seq: this.currentSeq(me) };
  }

  getDialog(me: number, peerId: unknown) {
    const peer = this.requirePeer(me, peerId);
    return { dialog: this.strip(this.dialogView(me, peer, this.dialogRow(me, peer.id))), seq: this.currentSeq(me) };
  }

  private pinnedOrder(me: number): number[] {
    return this.db
      .select({ peerId: dialogs.peerId })
      .from(dialogs)
      .where(and(eq(dialogs.ownerId, me), eq(dialogs.pinned, true)))
      .orderBy(asc(dialogs.pinOrder), desc(dialogs.peerId))
      .all()
      .map((r) => r.peerId);
  }

  private writePinnedOrder(me: number, order: number[], unpinned: number | null): void {
    order.forEach((peerId, i) => {
      this.ensureDialog(me, peerId, false);
      this.db
        .update(dialogs)
        .set({ pinned: true, pinOrder: i })
        .where(and(eq(dialogs.ownerId, me), eq(dialogs.peerId, peerId)))
        .run();
    });
    if (unpinned != null) {
      this.db
        .update(dialogs)
        .set({ pinned: false, pinOrder: null, touchedAt: this.now() })
        .where(and(eq(dialogs.ownerId, me), eq(dialogs.peerId, unpinned)))
        .run();
    }
    this.emit(me, "dialog.pinned", { pinnedOrder: order });
  }

  /** H4 */
  setPinned(me: number, peerId: unknown, pinned: unknown) {
    const peer = this.requirePeer(me, peerId);
    if (typeof pinned !== "boolean") throw Errors.validation("pinned must be a boolean.");
    const order = this.pinnedOrder(me);
    const has = order.includes(peer.id);
    if (pinned && !has) {
      if (order.length >= this.cfg.pinLimit) {
        throw new ApiError(400, "PIN_LIMIT", `You can pin up to ${this.cfg.pinLimit} conversations.`);
      }
      const next = [peer.id, ...order];
      this.write(() => this.writePinnedOrder(me, next, null));
      return { pinnedOrder: next, seq: this.currentSeq(me) };
    }
    if (!pinned && has) {
      const next = order.filter((p) => p !== peer.id);
      this.write(() => this.writePinnedOrder(me, next, peer.id));
      return { pinnedOrder: next, seq: this.currentSeq(me) };
    }
    return { pinnedOrder: order, seq: this.currentSeq(me) };
  }

  /** H5 */
  reorderPinned(me: number, orderRaw: unknown) {
    const current = this.pinnedOrder(me);
    if (!Array.isArray(orderRaw) || !orderRaw.every(isInt)) throw Errors.validation("order must be a list of ids.");
    const order = orderRaw as number[];
    const same =
      order.length === current.length && new Set(order).size === order.length && order.every((p) => current.includes(p));
    if (!same) throw new ApiError(409, "ORDER_MISMATCH", "The pinned list changed; refresh and try again.");
    if (order.every((p, i) => current[i] === p)) return { pinnedOrder: current, seq: this.currentSeq(me) };
    this.write(() => this.writePinnedOrder(me, order, null));
    return { pinnedOrder: order, seq: this.currentSeq(me) };
  }

  /** H6 */
  setUnreadMark(me: number, peerId: unknown, marked: unknown) {
    const peer = this.requirePeer(me, peerId);
    if (typeof marked !== "boolean") throw Errors.validation("marked must be a boolean.");
    const row = this.dialogRow(me, peer.id);
    if ((row?.unreadMark ?? false) !== marked) {
      this.write(() => {
        this.ensureDialog(me, peer.id, false);
        this.db
          .update(dialogs)
          .set({ unreadMark: marked })
          .where(and(eq(dialogs.ownerId, me), eq(dialogs.peerId, peer.id)))
          .run();
        this.emit(me, "dialog.unreadMark", { peerId: peer.id, marked });
      });
    }
    return { seq: this.currentSeq(me) };
  }

  /** H7 */
  setDraft(me: number, peerId: unknown, text: unknown) {
    const peer = this.requirePeer(me, peerId);
    if (typeof text !== "string") throw Errors.validation("text must be a string.");
    if (text.length > this.cfg.maxTextLen) throw Errors.messageTooLong(this.cfg.maxTextLen);
    const next = isBlank(text) ? null : text;
    const row = this.dialogRow(me, peer.id);
    const prev = row?.draftText ?? null;
    if (prev === next) {
      const draft = prev ? { text: prev, date: row?.draftUpdatedAt ?? 0 } : null;
      return { draft, seq: this.currentSeq(me) };
    }
    const now = this.now();
    const draft = next ? { text: next, date: now } : null;
    this.write(() => {
      this.ensureDialog(me, peer.id, true);
      this.db
        .update(dialogs)
        .set({ draftText: next, draftUpdatedAt: next ? now : null, touchedAt: now })
        .where(and(eq(dialogs.ownerId, me), eq(dialogs.peerId, peer.id)))
        .run();
      this.emit(me, "dialog.draft", { peerId: peer.id, draft });
    });
    return { draft, seq: this.currentSeq(me) };
  }

  /** H8, BR-READ-9 / BR-STATUS-5 */
  markRead(me: number, peerId: unknown, maxIdRaw: unknown) {
    const peer = this.requirePeer(me, peerId);
    if (!isInt(maxIdRaw) || maxIdRaw < 0) throw Errors.validation("maxId must be a non-negative integer.");
    const row = this.dialogRow(me, peer.id);
    const cursor = row?.readInboxMaxId ?? 0;
    const newest = this.topMessage(me, peer.id)?.id ?? 0;
    const target = Math.min(maxIdRaw, newest);
    if (target > cursor) {
      return this.write(() => {
        this.ensureDialog(me, peer.id, false);
        this.db
          .update(dialogs)
          .set({ readInboxMaxId: target })
          .where(and(eq(dialogs.ownerId, me), eq(dialogs.peerId, peer.id)))
          .run();
        const unreadCount = this.unreadCount(me, peer.id, target);
        this.emit(me, "read.inbox", { peerId: peer.id, maxId: target, unreadCount });
        this.emit(peer.id, "read.outbox", { peerId: me, maxId: target });
        return { readInboxMaxId: target, unreadCount, seq: this.currentSeq(me) };
      });
    }
    return { readInboxMaxId: cursor, unreadCount: this.unreadCount(me, peer.id, cursor), seq: this.currentSeq(me) };
  }

  // ---------------------------------------------------------------- H9 history

  listMessages(
    me: number,
    peerId: unknown,
    q: { before?: number | null; after?: number | null; around?: number | null; limit?: number | null },
  ) {
    const peer = this.requirePeer(me, peerId);
    let limit = isInt(q.limit) ? q.limit : 40;
    limit = Math.max(1, Math.min(100, limit));
    const base = and(this.inConv(me, peer.id), this.visibleTo(me))!;
    const pick = (cond: SQL | undefined, order: "asc" | "desc", n: number) =>
      n <= 0
        ? []
        : this.db
            .select()
            .from(messages)
            .where(cond ? and(base, cond) : base)
            .orderBy(order === "asc" ? asc(messages.id) : desc(messages.id))
            .limit(n)
            .all();

    let rows: MessageRow[];
    if (isInt(q.around)) {
      const around = q.around;
      if (around > 0) {
        const exists = this.db
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.id, around), this.inConv(me, peer.id)))
          .get();
        if (!exists) throw Errors.messageNotFound();
      }
      const older = pick(lte(messages.id, around), "desc", Math.ceil(limit / 2));
      const newer = pick(gt(messages.id, around), "asc", limit - older.length);
      rows = [...newer.reverse(), ...older];
    } else if (isInt(q.before)) {
      rows = pick(lt(messages.id, q.before), "desc", limit);
    } else if (isInt(q.after)) {
      rows = pick(gt(messages.id, q.after), "asc", limit).reverse();
    } else {
      rows = pick(undefined, "desc", limit);
    }
    const exists = (cond: SQL) =>
      !!this.db.select({ id: messages.id }).from(messages).where(and(base, cond)).limit(1).get();
    let hasOlder: boolean;
    let hasNewer: boolean;
    if (rows.length > 0) {
      hasOlder = exists(lt(messages.id, rows[rows.length - 1].id));
      hasNewer = exists(gt(messages.id, rows[0].id));
    } else if (isInt(q.before)) {
      hasOlder = false;
      hasNewer = exists(gte(messages.id, q.before));
    } else if (isInt(q.after)) {
      hasOlder = exists(lte(messages.id, q.after));
      hasNewer = false;
    } else {
      hasOlder = false;
      hasNewer = false;
    }
    return { messages: rows.map((r) => this.wireMessage(r, me)), hasOlder, hasNewer, seq: this.currentSeq(me) };
  }

  // ---------------------------------------------------------------- H10 send

  private checkRate(me: number, n: number): void {
    const now = this.now();
    const log = (this.sendLog.get(me) ?? []).filter((t) => t > now - this.cfg.rateLimitWindowMs);
    this.sendLog.set(me, log);
    if (log.length + n > this.cfg.rateLimitCount && log.length > 0) {
      const retryAfterMs = Math.max(1, log[0] + this.cfg.rateLimitWindowMs - now);
      throw Errors.rateLimited(retryAfterMs);
    }
  }

  private recordSends(me: number, n: number): void {
    const now = this.now();
    const log = this.sendLog.get(me) ?? [];
    for (let i = 0; i < n; i++) log.push(now);
    this.sendLog.set(me, log);
  }

  private validateText(text: unknown): string {
    if (typeof text !== "string" || isBlank(text)) throw Errors.messageEmpty();
    if (text.length > this.cfg.maxTextLen) throw Errors.messageTooLong(this.cfg.maxTextLen);
    return text;
  }

  private byToken(me: number, token: string): MessageRow | undefined {
    return this.db
      .select()
      .from(messages)
      .where(and(eq(messages.senderId, me), eq(messages.clientToken, token)))
      .get();
  }

  private insertMessage(v: typeof messages.$inferInsert): MessageRow {
    return this.db.insert(messages).values(v).returning().get();
  }

  private announceNew(m: MessageRow): void {
    this.ensureDialog(m.senderId, m.recipientId, true);
    this.ensureDialog(m.recipientId, m.senderId, true);
    this.emit(m.senderId, "message.new", { message: this.wireMessage(m, m.senderId) });
    this.emit(m.recipientId, "message.new", { message: this.wireMessage(m, m.recipientId) });
  }

  sendMessage(
    me: number,
    peerId: unknown,
    body: { clientToken?: unknown; text?: unknown; replyToId?: unknown; clearDraft?: unknown },
  ) {
    if (!isUuid(body.clientToken)) throw Errors.tokenInvalid();
    const token = body.clientToken;
    const existing = this.byToken(me, token);
    if (existing) {
      return { message: this.wireMessage(existing, me), seq: this.currentSeq(me), duplicate: true };
    }
    const text = this.validateText(body.text);
    const peer = this.requirePeer(me, peerId);
    let replyToId: number | null = null;
    if (body.replyToId != null) {
      if (!isInt(body.replyToId)) throw Errors.replyTargetInvalid();
      const target = this.getMessage(body.replyToId);
      const [lo, hi] = conv(me, peer.id);
      if (!target || target.convLow !== lo || target.convHigh !== hi || !this.isVisible(target, me)) {
        throw Errors.replyTargetInvalid();
      }
      replyToId = target.id;
    }
    this.checkRate(me, 1);
    const clearDraft = body.clearDraft !== false;
    const result = this.write(() => {
      const dup = this.byToken(me, token);
      if (dup) return { row: dup, duplicate: true };
      const [lo, hi] = conv(me, peer.id);
      const row = this.insertMessage({
        convLow: lo,
        convHigh: hi,
        senderId: me,
        recipientId: peer.id,
        text,
        createdAt: this.now(),
        replyToId,
        clientToken: token,
      });
      this.ensureDialog(me, peer.id, true);
      this.ensureDialog(peer.id, me, true);
      this.emit(me, "message.new", { message: this.wireMessage(row, me) });
      if (clearDraft) {
        const d = this.dialogRow(me, peer.id);
        if (d?.draftText) {
          this.db
            .update(dialogs)
            .set({ draftText: null, draftUpdatedAt: null })
            .where(and(eq(dialogs.ownerId, me), eq(dialogs.peerId, peer.id)))
            .run();
          this.emit(me, "dialog.draft", { peerId: peer.id, draft: null });
        }
      }
      this.emit(peer.id, "message.new", { message: this.wireMessage(row, peer.id) });
      return { row, duplicate: false };
    });
    if (!result.duplicate) this.recordSends(me, 1);
    return { message: this.wireMessage(result.row, me), seq: this.currentSeq(me), duplicate: result.duplicate };
  }

  // ---------------------------------------------------------------- reply.updated helper

  private emitReplyUpdated(origIds: number[], onlyFor: number[] | null): void {
    if (origIds.length === 0) return;
    const replies = this.db.select().from(messages).where(inArray(messages.replyToId, origIds)).all();
    if (replies.length === 0) return;
    const perUser = new Map<number, Map<number, number[]>>();
    for (const r of replies) {
      for (const u of [r.senderId, r.recipientId]) {
        if (onlyFor && !onlyFor.includes(u)) continue;
        if (!this.isVisible(r, u)) continue;
        const peer = u === r.senderId ? r.recipientId : r.senderId;
        const byPeer = perUser.get(u) ?? new Map<number, number[]>();
        byPeer.set(peer, [...(byPeer.get(peer) ?? []), r.id]);
        perUser.set(u, byPeer);
      }
    }
    for (const [u, byPeer] of perUser) {
      for (const [peerId, ids] of byPeer) this.emit(u, "reply.updated", { peerId, messageIds: ids.sort((a, b) => a - b) });
    }
  }

  // ---------------------------------------------------------------- H11 edit

  editMessage(me: number, idRaw: unknown, text: unknown) {
    if (!isInt(idRaw)) throw Errors.messageNotFound();
    const m = this.getMessage(idRaw);
    if (!m || !this.isVisible(m, me)) throw Errors.messageNotFound();
    if (m.senderId !== me) throw new ApiError(403, "EDIT_NOT_ALLOWED", "Only your own messages can be edited.");
    if (m.fwdFromDate != null) throw new ApiError(403, "EDIT_NOT_ALLOWED", "Forwarded messages cannot be edited.");
    if (this.now() - m.createdAt > this.cfg.editLimitMs) {
      throw new ApiError(403, "EDIT_TIME_EXPIRED", "This message is too old to edit.");
    }
    const t = this.validateText(text);
    if (t === m.text) throw new ApiError(409, "TEXT_UNCHANGED", "Nothing changed.");
    const updated = this.write(() => {
      const row = this.db
        .update(messages)
        .set({ text: t, editedAt: this.now() })
        .where(eq(messages.id, m.id))
        .returning()
        .get();
      for (const u of [row.senderId, row.recipientId]) {
        if (this.isVisible(row, u)) this.emit(u, "message.edited", { message: this.wireMessage(row, u) });
      }
      this.emitReplyUpdated([row.id], null);
      return row;
    });
    return { message: this.wireMessage(updated, me), seq: this.currentSeq(me) };
  }

  // ---------------------------------------------------------------- H12 delete

  deleteMessages(me: number, peerId: unknown, body: { ids?: unknown; forEveryone?: unknown }) {
    const peer = this.requirePeer(me, peerId);
    if (!Array.isArray(body.ids) || !body.ids.every(isInt)) throw Errors.validation("ids must be a list of integers.");
    if (body.ids.length > MAX_IDS) throw Errors.tooManyIds();
    const forEveryone = body.forEveryone === true;
    const ids = [...new Set(body.ids as number[])];
    if (ids.length === 0) return { deletedIds: [], seq: this.currentSeq(me) };
    const rows = this.db
      .select()
      .from(messages)
      .where(and(inArray(messages.id, ids), this.inConv(me, peer.id), this.visibleTo(me)))
      .orderBy(asc(messages.id))
      .all();
    if (rows.length === 0) return { deletedIds: [], seq: this.currentSeq(me) };
    if (forEveryone) {
      const now = this.now();
      for (const r of rows) {
        if (this.cfg.revokeLimitMs != null && now - r.createdAt > this.cfg.revokeLimitMs) {
          throw new ApiError(403, "REVOKE_FORBIDDEN", "This message is too old to delete for both of you.");
        }
        if (!this.cfg.revokePeerMessages && r.senderId !== me) {
          throw new ApiError(403, "REVOKE_FORBIDDEN", "Only your own messages can be deleted for both of you.");
        }
      }
    }
    const deletedIds = rows.map((r) => r.id);
    this.write(() => {
      if (forEveryone) {
        const peerVisible = rows.filter((r) => this.isVisible(r, peer.id)).map((r) => r.id);
        this.db.update(messages).set({ deletedForEveryoneAt: this.now() }).where(inArray(messages.id, deletedIds)).run();
        this.emit(me, "messages.deleted", { peerId: peer.id, ids: deletedIds });
        if (peerVisible.length > 0) this.emit(peer.id, "messages.deleted", { peerId: me, ids: peerVisible });
        this.emitReplyUpdated(deletedIds, null);
      } else {
        for (const id of deletedIds) {
          this.db.insert(messageHidden).values({ userId: me, messageId: id }).onConflictDoNothing().run();
        }
        this.emit(me, "messages.deleted", { peerId: peer.id, ids: deletedIds });
        this.emitReplyUpdated(deletedIds, [me]);
      }
    });
    return { deletedIds, seq: this.currentSeq(me) };
  }

  // ---------------------------------------------------------------- H13 forward

  forwardMessages(
    me: number,
    targetPeerId: unknown,
    body: { fromPeerId?: unknown; messageIds?: unknown; clientTokens?: unknown; hideSender?: unknown },
  ) {
    const target = this.requirePeer(me, targetPeerId);
    const from = this.requirePeer(me, body.fromPeerId);
    const ids = body.messageIds;
    const tokens = body.clientTokens;
    if (!Array.isArray(ids) || !ids.every(isInt) || ids.length === 0) throw Errors.validation("messageIds required.");
    if (ids.length > MAX_IDS) throw Errors.tooManyIds();
    if (!Array.isArray(tokens) || tokens.length !== ids.length || !tokens.every(isUuid)) throw Errors.tokenInvalid();
    if (new Set(tokens).size !== tokens.length || new Set(ids).size !== ids.length) {
      throw Errors.validation("Duplicate ids or tokens.");
    }
    const hideSender = body.hideSender === true;

    const first = this.byToken(me, tokens[0] as string);
    if (first) {
      const stored = this.db
        .select()
        .from(messages)
        .where(and(eq(messages.senderId, me), inArray(messages.clientToken, tokens as string[])))
        .orderBy(asc(messages.id))
        .all();
      return { messages: stored.map((r) => this.wireMessage(r, me)), seq: this.currentSeq(me), duplicate: true };
    }

    const pairs = (ids as number[]).map((id, i) => ({ id, token: (tokens as string[])[i] }));
    const sources = new Map<number, MessageRow>();
    for (const p of pairs) {
      const m = this.getMessage(p.id);
      const [lo, hi] = conv(me, from.id);
      if (!m || m.convLow !== lo || m.convHigh !== hi || !this.isVisible(m, me)) throw Errors.messageNotFound();
      sources.set(p.id, m);
    }
    pairs.sort((a, b) => a.id - b.id);
    this.checkRate(me, pairs.length);

    const created = this.write(() => {
      const mapped = new Map<number, number>();
      const out: MessageRow[] = [];
      const [lo, hi] = conv(me, target.id);
      for (const p of pairs) {
        const src = sources.get(p.id)!;
        let fwd: { fwdFromUserId: number | null; fwdFromName: string | null; fwdFromDate: number | null } = {
          fwdFromUserId: null,
          fwdFromName: null,
          fwdFromDate: null,
        };
        if (!hideSender) {
          if (src.fwdFromDate != null) {
            fwd = { fwdFromUserId: src.fwdFromUserId, fwdFromName: this.forwardName(src), fwdFromDate: src.fwdFromDate };
          } else {
            fwd = {
              fwdFromUserId: src.senderId,
              fwdFromName: this.user(src.senderId)?.displayName ?? null,
              fwdFromDate: src.createdAt,
            };
          }
        }
        const replyToId = src.replyToId != null ? (mapped.get(src.replyToId) ?? null) : null;
        const row = this.insertMessage({
          convLow: lo,
          convHigh: hi,
          senderId: me,
          recipientId: target.id,
          text: src.text,
          createdAt: this.now(),
          replyToId,
          clientToken: p.token,
          ...fwd,
        });
        mapped.set(src.id, row.id);
        out.push(row);
        this.announceNew(row);
      }
      return out;
    });
    this.recordSends(me, created.length);
    return { messages: created.map((r) => this.wireMessage(r, me)), seq: this.currentSeq(me), duplicate: false };
  }

  // ---------------------------------------------------------------- H14 sync

  sync(me: number, sinceRaw: unknown, limitRaw: unknown) {
    if (!isInt(sinceRaw) || sinceRaw < 0) throw Errors.validation("since must be a non-negative integer.");
    let limit = isInt(limitRaw) ? limitRaw : this.cfg.syncDefaultLimit;
    limit = Math.max(1, Math.min(this.cfg.syncMaxLimit, limit));
    const cur = this.currentSeq(me);
    const oldest = this.db
      .select({ s: sql<number | null>`min(${events.seq})` })
      .from(events)
      .where(eq(events.userId, me))
      .get()?.s;
    const reset =
      sinceRaw > cur || (oldest != null && sinceRaw < oldest - 1) || (oldest == null && sinceRaw < cur);
    if (reset) return { reset: true as const, seq: cur };
    const rows = this.db
      .select()
      .from(events)
      .where(and(eq(events.userId, me), gt(events.seq, sinceRaw)))
      .orderBy(asc(events.seq))
      .limit(limit)
      .all();
    const evs = rows.map((r) => ({ seq: r.seq, type: r.type, data: JSON.parse(r.payload) }) as SyncEvent);
    const last = evs.length ? evs[evs.length - 1].seq : sinceRaw;
    return { reset: false as const, events: evs, seq: last, more: last < cur };
  }

  /** Test/diagnostic helper: the full event log of one user. */
  eventLog(userId: number) {
    return this.db.select().from(events).where(eq(events.userId, userId)).orderBy(asc(events.seq)).all();
  }
}
