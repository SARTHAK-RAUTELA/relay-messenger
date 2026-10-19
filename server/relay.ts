// Core server rules (spec sections 3, 5, 6). Transport-agnostic: the HTTP layer calls these
// methods; every state change and its events are committed in one SQLite transaction and
// pushed to connected sockets after commit (BR-SYNC-1).
//
// A conversation is addressed by a peer id (src/shared/peer.ts): a user, a group or a secret
// chat. `Chat` is the resolved form; message rows carry enough to find their chat again.

import type Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";
import type { DB } from "./db/client";
import {
  blocks,
  dialogs,
  events,
  groupMembers,
  groups,
  messageHidden,
  messageReactions,
  messages,
  secretChats,
  sessions,
  userKeys,
  users,
} from "./db/schema";
import type { ServerConfig } from "./config";
import { ApiError, Errors } from "./errors";
import type {
  Dialog,
  EventPayloads,
  EventType,
  GroupInfo,
  Message,
  Presence,
  Reaction,
  SecretInfo,
  ServiceAction,
  SyncEvent,
  UserSummary,
} from "../src/shared/types";
import { isBlank, isUuid, previewText } from "../src/shared/text";
import { activityDate, compareDialogs } from "../src/shared/dialogOrder";
import { MAX_GROUP_MEMBERS, REACTIONS, groupIdOf, groupPeer, peerKind, secretIdOf, secretPeer } from "../src/shared/peer";

type UserRow = typeof users.$inferSelect;
type MessageRow = typeof messages.$inferSelect;
type DialogRow = typeof dialogs.$inferSelect;
type GroupRow = typeof groups.$inferSelect;
type SecretRow = typeof secretChats.$inferSelect;

type Chat =
  | { kind: "user"; peerId: number; user: UserRow }
  | { kind: "group"; peerId: number; group: GroupRow }
  | { kind: "secret"; peerId: number; secret: SecretRow; other: UserRow };

export interface PushedEvent {
  userId: number;
  seq: number;
  type: EventType;
  data: unknown;
}

export type Pusher = (events: PushedEvent[]) => void;

const USERNAME_RE = /^[A-Za-z0-9_]{3,32}$/;
/** Deliberately loose: something@something.tld, no spaces. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_IDS = 100;
/** Secret-chat payloads: "e1:" + base64(iv) + ":" + base64(AES-GCM ciphertext). */
const CIPHER_RE = /^e1:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$/;
const DELETED_NAME = "Deleted account";

function conv(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a];
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

export class Relay {
  /** Called after each committed write with the events appended, in commit order. */
  pusher: Pusher = () => {};
  /** Whether a user has an open socket; set by the hub. */
  isOnline: (userId: number) => boolean = () => false;
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

  private validateDisplayName(displayName: unknown): string {
    if (typeof displayName !== "string" || displayName.trim().length < 1 || displayName.trim().length > 64) {
      throw Errors.validation("Display names are 1-64 characters.");
    }
    return displayName.trim();
  }

  private validatePassword(password: unknown): string {
    if (typeof password !== "string" || password.length < 6 || password.length > 200) {
      throw Errors.validation("Passwords need at least 6 characters.");
    }
    return password;
  }

  private validateEmail(email: unknown): string {
    if (typeof email !== "string" || email.trim().length > 254 || !EMAIL_RE.test(email.trim())) {
      throw Errors.validation("Enter a valid email address.");
    }
    return email.trim();
  }

  private emailTaken(lower: string, exceptUserId?: number): boolean {
    const row = this.db.select({ id: users.id }).from(users).where(eq(users.emailLower, lower)).get();
    return !!row && row.id !== exceptUserId;
  }

  async register(input: { username?: unknown; email?: unknown; displayName?: unknown; password?: unknown }, ip = "unknown") {
    // Every registration attempt counts against the caller's IP.
    this.throttle([{ key: "reg:" + ip, max: this.cfg.registerMaxPerIp }]);
    this.recordAuth(["reg:" + ip]);
    const { username } = input;
    if (typeof username !== "string" || !USERNAME_RE.test(username)) {
      throw Errors.validation("Usernames are 3-32 letters, digits or underscores.");
    }
    const email = this.validateEmail(input.email);
    const displayName = this.validateDisplayName(input.displayName);
    const password = this.validatePassword(input.password);
    const lower = username.toLowerCase();
    const emailLower = email.toLowerCase();
    const taken = this.db.select({ id: users.id }).from(users).where(eq(users.usernameLower, lower)).get();
    if (taken) throw new ApiError(409, "USERNAME_TAKEN", "That username is already in use.");
    if (this.emailTaken(emailLower)) throw Errors.emailTaken();
    const passwordHash = await bcrypt.hash(password, this.cfg.bcryptCost);
    try {
      const row = this.db
        .insert(users)
        .values({ username, usernameLower: lower, email, emailLower, displayName, passwordHash, createdAt: this.now() })
        .returning()
        .get();
      return { user: this.summary(row), sessionId: this.createSession(row.id) };
    } catch (e) {
      // Two sign-ups racing for the same name or email: the unique index decides.
      if (String(e).includes("email_lower")) throw Errors.emailTaken();
      if (String(e).includes("UNIQUE")) throw new ApiError(409, "USERNAME_TAKEN", "That username is already in use.");
      throw e;
    }
  }

  private async passwordMatches(row: UserRow | undefined, password: string): Promise<boolean> {
    // Compare against a dummy hash for unknown or deleted users so timing does not reveal existence.
    if (!this.dummyHash) this.dummyHash = await bcrypt.hash("relay-dummy-password", this.cfg.bcryptCost);
    const usable = row && row.deletedAt == null;
    const ok = await bcrypt.compare(password, usable ? row.passwordHash : this.dummyHash);
    return !!usable && ok;
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
    // The sign-in name can be the username or the email address.
    const row = this.db
      .select()
      .from(users)
      .where(lower.includes("@") ? eq(users.emailLower, lower) : eq(users.usernameLower, lower))
      .get();
    if (!(await this.passwordMatches(row, input.password)) || !row) {
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
    if (!row || row.user.deletedAt != null) return null;
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
    if (!row || row.deletedAt != null) throw Errors.unauthorized();
    // The email is private: it is only ever returned to its owner, never in UserSummary.
    return { user: this.summary(row), email: row.email ?? null, seq: row.currentSeq, serverTime: this.now() };
  }

  /** Adds or changes the account email (needed for accounts created before emails existed). */
  updateEmail(me: number, body: { email?: unknown }) {
    const email = this.validateEmail(body.email);
    const emailLower = email.toLowerCase();
    if (this.emailTaken(emailLower, me)) throw Errors.emailTaken();
    try {
      this.db.update(users).set({ email, emailLower }).where(eq(users.id, me)).run();
    } catch (e) {
      if (String(e).includes("UNIQUE")) throw Errors.emailTaken();
      throw e;
    }
    return { email };
  }

  // ---------------------------------------------------------------- profile & account

  /** Users who show this user's name or presence somewhere: direct and secret partners, group co-members. */
  private contactsOf(userId: number): number[] {
    const out = new Set<number>();
    for (const r of this.db.select({ o: dialogs.ownerId }).from(dialogs).where(eq(dialogs.peerId, userId)).all()) out.add(r.o);
    for (const s of this.db
      .select()
      .from(secretChats)
      .where(or(eq(secretChats.initiatorId, userId), eq(secretChats.responderId, userId)))
      .all()) {
      out.add(s.initiatorId === userId ? s.responderId : s.initiatorId);
    }
    const mine = this.db.select({ g: groupMembers.groupId }).from(groupMembers).where(eq(groupMembers.userId, userId)).all();
    if (mine.length) {
      for (const r of this.db
        .select({ u: groupMembers.userId })
        .from(groupMembers)
        .where(inArray(groupMembers.groupId, mine.map((m) => m.g)))
        .all()) {
        out.add(r.u);
      }
    }
    out.delete(userId);
    return [...out];
  }

  updateProfile(me: number, body: { displayName?: unknown }) {
    const displayName = this.validateDisplayName(body.displayName);
    const row = this.user(me)!;
    if (row.displayName === displayName) return { user: this.summary(row), seq: this.currentSeq(me) };
    const user = this.write(() => {
      const updated = this.db.update(users).set({ displayName }).where(eq(users.id, me)).returning().get();
      const summary = this.summary(updated);
      this.emit(me, "me.updated", { user: summary });
      for (const u of this.contactsOf(me)) this.emit(u, "peer.updated", { user: summary, deleted: false });
      return summary;
    });
    return { user, seq: this.currentSeq(me) };
  }

  /** Returns the ids of the other sessions it ended so their sockets can be closed. */
  async changePassword(me: number, sessionId: string | undefined, body: { currentPassword?: unknown; newPassword?: unknown }) {
    if (typeof body.currentPassword !== "string" || !(await this.passwordMatches(this.user(me), body.currentPassword))) {
      throw new ApiError(403, "WRONG_PASSWORD", "Your current password is not right.");
    }
    const next = this.validatePassword(body.newPassword);
    const passwordHash = await bcrypt.hash(next, this.cfg.bcryptCost);
    this.db.update(users).set({ passwordHash }).where(eq(users.id, me)).run();
    const others = this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.userId, me), sessionId ? ne(sessions.id, sessionId) : undefined))
      .all()
      .map((r) => r.id);
    if (others.length) this.db.delete(sessions).where(inArray(sessions.id, others)).run();
    return { endedSessions: others };
  }

  /**
   * Deletes an account: the name becomes "Deleted account", sign-in stops working, the user
   * leaves every group and drops their secret-chat keys. Messages stay for the other side.
   */
  async deleteAccount(me: number, body: { password?: unknown }) {
    if (typeof body.password !== "string" || !(await this.passwordMatches(this.user(me), body.password))) {
      throw new ApiError(403, "WRONG_PASSWORD", "Your password is not right.");
    }
    const ended = this.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, me)).all().map((r) => r.id);
    this.write(() => {
      const contacts = this.contactsOf(me);
      for (const g of this.db.select({ g: groupMembers.groupId }).from(groupMembers).where(eq(groupMembers.userId, me)).all()) {
        const group = this.db.select().from(groups).where(eq(groups.id, g.g)).get();
        if (group) this.leaveGroupTx(me, { kind: "group", peerId: groupPeer(group.id), group });
      }
      const name = `deleted_${me}`;
      const updated = this.db
        .update(users)
        // The email is released so it can be used for a new account.
        .set({
          deletedAt: this.now(),
          displayName: DELETED_NAME,
          username: name,
          usernameLower: name,
          email: null,
          emailLower: null,
          passwordHash: "!",
        })
        .where(eq(users.id, me))
        .returning()
        .get();
      this.db.delete(sessions).where(eq(sessions.userId, me)).run();
      this.db.delete(userKeys).where(eq(userKeys.userId, me)).run();
      for (const u of contacts) this.emit(u, "peer.updated", { user: this.summary(updated), deleted: true });
    });
    return { endedSessions: ended };
  }

  // ---------------------------------------------------------------- blocking & presence

  private isBlocked(blockerId: number, blockedId: number): boolean {
    return !!this.db
      .select({ x: blocks.blockerId })
      .from(blocks)
      .where(and(eq(blocks.blockerId, blockerId), eq(blocks.blockedId, blockedId)))
      .get();
  }

  setBlocked(me: number, userIdRaw: unknown, blocked: unknown) {
    if (!isInt(userIdRaw) || userIdRaw === me || !this.user(userIdRaw)) throw Errors.peerInvalid();
    if (typeof blocked !== "boolean") throw Errors.validation("blocked must be a boolean.");
    const userId = userIdRaw;
    if (this.isBlocked(me, userId) !== blocked) {
      this.write(() => {
        if (blocked) this.db.insert(blocks).values({ blockerId: me, blockedId: userId, createdAt: this.now() }).run();
        else this.db.delete(blocks).where(and(eq(blocks.blockerId, me), eq(blocks.blockedId, userId))).run();
        this.emit(me, "user.blocked", { userId, blocked });
      });
    }
    return { blocked, seq: this.currentSeq(me) };
  }

  /** What `viewer` may know about `userId`: nothing when blocked by them or when the account is gone. */
  presence(viewer: number, userId: number): Presence {
    const u = this.user(userId);
    if (!u || u.deletedAt != null || this.isBlocked(userId, viewer)) return { online: false, lastSeen: null };
    return { online: this.isOnline(userId), lastSeen: u.lastSeenAt ?? null };
  }

  presenceMany(viewer: number, idsRaw: string | null) {
    const ids = (idsRaw ?? "")
      .split(",")
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, 200);
    const out: Record<number, Presence> = {};
    for (const id of new Set(ids)) out[id] = this.presence(viewer, id);
    return { presence: out };
  }

  /** Who should hear about this user's online state changes. */
  presenceWatchers(userId: number): number[] {
    return this.contactsOf(userId).filter((u) => !this.isBlocked(userId, u));
  }

  touchLastSeen(userId: number): void {
    this.db.update(users).set({ lastSeenAt: this.now() }).where(eq(users.id, userId)).run();
  }

  /** Recipients of a typing notice and the peer id each of them knows the chat by. */
  typingTargets(me: number, peerId: unknown): { userId: number; peerId: number }[] {
    let chat: Chat;
    try {
      chat = this.chat(me, peerId);
    } catch {
      return [];
    }
    const other = this.otherUser(chat);
    if (other && (other.deletedAt != null || this.isBlocked(other.id, me) || this.isBlocked(me, other.id))) return [];
    return this.membersOf(chat, me)
      .filter((u) => u !== me)
      .map((u) => ({ userId: u, peerId: this.viewerPeer(chat, me, u) }));
  }

  // ---------------------------------------------------------------- helpers

  private summary(u: UserRow): UserSummary {
    return { id: u.id, username: u.username, displayName: u.displayName };
  }

  private user(id: number): UserRow | undefined {
    return this.db.select().from(users).where(eq(users.id, id)).get();
  }

  private isMember(groupId: number, userId: number): boolean {
    return !!this.db
      .select({ x: groupMembers.userId })
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)))
      .get();
  }

  private memberIds(groupId: number): number[] {
    return this.db
      .select({ u: groupMembers.userId })
      .from(groupMembers)
      .where(eq(groupMembers.groupId, groupId))
      .orderBy(asc(groupMembers.joinedAt), asc(groupMembers.userId))
      .all()
      .map((r) => r.u);
  }

  /** Resolves a peer id the caller may use; anything else is PEER_INVALID. */
  private chat(me: number, peerId: unknown): Chat {
    if (!isInt(peerId) || peerId === me || peerId === 0) throw Errors.peerInvalid();
    const kind = peerKind(peerId);
    if (kind === "user") {
      const user = this.user(peerId);
      if (!user) throw Errors.peerInvalid();
      return { kind, peerId, user };
    }
    if (kind === "group") {
      const group = this.db.select().from(groups).where(eq(groups.id, groupIdOf(peerId))).get();
      if (!group || !this.isMember(group.id, me)) throw Errors.peerInvalid();
      return { kind, peerId, group };
    }
    const secret = this.db.select().from(secretChats).where(eq(secretChats.id, secretIdOf(peerId))).get();
    if (!secret || (secret.initiatorId !== me && secret.responderId !== me)) throw Errors.peerInvalid();
    const other = this.user(secret.initiatorId === me ? secret.responderId : secret.initiatorId);
    if (!other) throw Errors.peerInvalid();
    return { kind, peerId, secret, other };
  }

  private otherUser(chat: Chat): UserRow | null {
    return chat.kind === "user" ? chat.user : chat.kind === "secret" ? chat.other : null;
  }

  private membersOf(chat: Chat, me: number): number[] {
    if (chat.kind === "user") return [me, chat.user.id];
    if (chat.kind === "group") return this.memberIds(chat.group.id);
    return [chat.secret.initiatorId, chat.secret.responderId];
  }

  /** The peer id `viewer` knows `chat` by, where `me` is the caller who resolved it. */
  private viewerPeer(chat: Chat, me: number, viewer: number): number {
    if (chat.kind === "user") return viewer === me ? chat.user.id : me;
    return chat.peerId;
  }

  private chatCond(chat: Chat, me: number): SQL {
    if (chat.kind === "user") {
      const [lo, hi] = conv(me, chat.user.id);
      return and(eq(messages.convLow, lo), eq(messages.convHigh, hi), isNull(messages.chatId))!;
    }
    return eq(messages.chatId, chat.peerId);
  }

  private inChat(m: MessageRow, chat: Chat, me: number): boolean {
    if (chat.kind === "user") {
      const [lo, hi] = conv(me, chat.user.id);
      return m.chatId == null && m.convLow === lo && m.convHigh === hi;
    }
    return m.chatId === chat.peerId;
  }

  /** Column values that place a new message in `chat`. */
  private address(chat: Chat, me: number) {
    if (chat.kind === "group") return { convLow: 0, convHigh: 0, chatId: chat.peerId, recipientId: null };
    const other = this.otherUser(chat)!;
    const [lo, hi] = conv(me, other.id);
    return { convLow: lo, convHigh: hi, chatId: chat.kind === "secret" ? chat.peerId : null, recipientId: other.id };
  }

  /** The peer id `viewer` knows the message's chat by. */
  private msgPeer(m: MessageRow, viewer: number): number {
    if (m.chatId != null) return m.chatId;
    return m.senderId === viewer ? m.recipientId! : m.senderId;
  }

  /** Everyone currently in the message's chat. */
  private audience(m: MessageRow): number[] {
    if (m.chatId == null) return [m.senderId, m.recipientId!];
    if (peerKind(m.chatId) === "group") return this.memberIds(groupIdOf(m.chatId));
    const s = this.db.select().from(secretChats).where(eq(secretChats.id, secretIdOf(m.chatId))).get();
    return s ? [s.initiatorId, s.responderId] : [];
  }

  private visibleTo(userId: number): SQL {
    return and(
      isNull(messages.deletedForEveryoneAt),
      sql`not exists (select 1 from message_hidden h where h.user_id = ${userId} and h.message_id = ${messages.id})`,
    )!;
  }

  private isVisible(m: MessageRow, userId: number): boolean {
    if (m.deletedForEveryoneAt != null) return false;
    if (m.chatId == null) {
      if (m.senderId !== userId && m.recipientId !== userId) return false;
    } else if (!this.audience(m).includes(userId)) {
      return false;
    }
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

  private reactionsFor(messageId: number, viewerId: number): Reaction[] {
    const rows = this.db.select().from(messageReactions).where(eq(messageReactions.messageId, messageId)).all();
    if (rows.length === 0) return [];
    const by = new Map<string, Reaction>();
    for (const r of rows) {
      const cur = by.get(r.emoji) ?? { emoji: r.emoji, count: 0, mine: false };
      cur.count++;
      if (r.userId === viewerId) cur.mine = true;
      by.set(r.emoji, cur);
    }
    const order = REACTIONS as readonly string[];
    return [...by.values()].sort((a, b) => order.indexOf(a.emoji) - order.indexOf(b.emoji));
  }

  /** Viewer-relative wire message (spec 4.2). */
  wireMessage(m: MessageRow, viewerId: number): Message {
    const out = m.senderId === viewerId;
    const secret = m.chatId != null && peerKind(m.chatId) === "secret";
    let replyTo: Message["replyTo"] = null;
    if (m.replyToId != null) {
      const orig = this.getMessage(m.replyToId);
      if (orig && this.isVisible(orig, viewerId)) {
        const senderName = orig.fwdFromDate != null ? this.forwardName(orig) : (this.user(orig.senderId)?.displayName ?? "");
        // Secret chats: the snippet is the whole ciphertext; the client decrypts and shortens it.
        const snippet = secret ? orig.text : previewText(orig.text);
        replyTo = { id: orig.id, deleted: false, senderId: orig.senderId, senderName, snippet };
      } else {
        replyTo = { id: m.replyToId, deleted: true };
      }
    }
    const msg: Message = {
      id: m.id,
      peerId: this.msgPeer(m, viewerId),
      senderId: m.senderId,
      out,
      text: m.text,
      date: m.createdAt,
      editDate: m.editedAt ?? null,
      replyTo,
      forwardedFrom:
        m.fwdFromDate != null ? { userId: m.fwdFromUserId ?? null, name: this.forwardName(m), date: m.fwdFromDate } : null,
      reactions: this.reactionsFor(m.id, viewerId),
      service: m.service ? (JSON.parse(m.service) as ServiceAction) : null,
    };
    if (m.chatId != null) msg.senderName = this.user(m.senderId)?.displayName ?? "";
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

  private topMessage(ownerId: number, chat: Chat): MessageRow | undefined {
    return this.db
      .select()
      .from(messages)
      .where(and(this.chatCond(chat, ownerId), this.visibleTo(ownerId)))
      .orderBy(desc(messages.id))
      .limit(1)
      .get();
  }

  private unreadCount(ownerId: number, chat: Chat, cursor: number): number {
    const r = this.db
      .select({ n: sql<number>`count(*)` })
      .from(messages)
      .where(
        and(this.chatCond(chat, ownerId), this.visibleTo(ownerId), ne(messages.senderId, ownerId), gt(messages.id, cursor)),
      )
      .get();
    return Number(r?.n ?? 0);
  }

  /** Highest read cursor among the other participants (groups: read by anyone). */
  private outboxCursor(me: number, chat: Chat): number {
    if (chat.kind === "user") return this.dialogRow(chat.user.id, me)?.readInboxMaxId ?? 0;
    const r = this.db
      .select({ m: sql<number | null>`max(${dialogs.readInboxMaxId})` })
      .from(dialogs)
      .where(and(eq(dialogs.peerId, chat.peerId), ne(dialogs.ownerId, me)))
      .get();
    return Number(r?.m ?? 0);
  }

  private groupInfo(g: GroupRow): GroupInfo {
    const ids = this.memberIds(g.id);
    const rows = ids.length ? this.db.select().from(users).where(inArray(users.id, ids)).all() : [];
    const byId = new Map(rows.map((u) => [u.id, u]));
    return {
      id: g.id,
      title: g.title,
      ownerId: g.ownerId,
      members: ids.map((id) => byId.get(id)).filter((u): u is UserRow => !!u).map((u) => this.summary(u)),
    };
  }

  private secretInfo(s: SecretRow, me: number): SecretInfo {
    return {
      id: s.id,
      userId: s.initiatorId === me ? s.responderId : s.initiatorId,
      initiatorId: s.initiatorId,
      initiatorKey: s.initiatorKey,
      responderKey: s.responderKey,
    };
  }

  private peerSummary(chat: Chat): UserSummary {
    if (chat.kind === "group") return { id: chat.peerId, username: "", displayName: chat.group.title };
    const u = this.otherUser(chat)!;
    return { ...this.summary(u), id: chat.peerId };
  }

  private dialogView(ownerId: number, chat: Chat, row: DialogRow | undefined): Dialog & { touchedAt: number } {
    const top = this.topMessage(ownerId, chat);
    const cursor = row?.readInboxMaxId ?? 0;
    const draft = row?.draftText ? { text: row.draftText, date: row.draftUpdatedAt ?? 0 } : null;
    const other = this.otherUser(chat);
    return {
      kind: chat.kind,
      peer: this.peerSummary(chat),
      topMessage: top ? this.wireMessage(top, ownerId) : null,
      unreadCount: this.unreadCount(ownerId, chat, cursor),
      unreadMark: row?.unreadMark ?? false,
      pinned: row?.pinned ?? false,
      pinOrder: row?.pinned ? (row.pinOrder ?? 0) : null,
      draft,
      readInboxMaxId: cursor,
      readOutboxMaxId: this.outboxCursor(ownerId, chat),
      activityDate: activityDate(top?.createdAt, draft),
      group: chat.kind === "group" ? this.groupInfo(chat.group) : null,
      secret: chat.kind === "secret" ? this.secretInfo(chat.secret, ownerId) : null,
      blocked: other ? this.isBlocked(ownerId, other.id) : false,
      peerDeleted: other ? other.deletedAt != null : false,
      presence: other ? this.presence(ownerId, other.id) : null,
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
          isNull(users.deletedAt),
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
      let chat: Chat;
      try {
        chat = this.chat(me, row.peerId);
      } catch {
        continue;
      }
      const hasDraft = !!row.draftText;
      const anyMessage = this.db.select({ id: messages.id }).from(messages).where(this.chatCond(chat, me)).limit(1).get();
      if (!anyMessage && !hasDraft && !row.pinned) continue; // BR-LIST-14
      views.push(this.dialogView(me, chat, row));
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
    const chat = this.chat(me, peerId);
    return { dialog: this.strip(this.dialogView(me, chat, this.dialogRow(me, chat.peerId))), seq: this.currentSeq(me) };
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
    const chat = this.chat(me, peerId);
    if (typeof pinned !== "boolean") throw Errors.validation("pinned must be a boolean.");
    const order = this.pinnedOrder(me);
    const has = order.includes(chat.peerId);
    if (pinned && !has) {
      if (order.length >= this.cfg.pinLimit) {
        throw new ApiError(400, "PIN_LIMIT", `You can pin up to ${this.cfg.pinLimit} conversations.`);
      }
      const next = [chat.peerId, ...order];
      this.write(() => this.writePinnedOrder(me, next, null));
      return { pinnedOrder: next, seq: this.currentSeq(me) };
    }
    if (!pinned && has) {
      const next = order.filter((p) => p !== chat.peerId);
      this.write(() => this.writePinnedOrder(me, next, chat.peerId));
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
    const chat = this.chat(me, peerId);
    if (typeof marked !== "boolean") throw Errors.validation("marked must be a boolean.");
    const row = this.dialogRow(me, chat.peerId);
    if ((row?.unreadMark ?? false) !== marked) {
      this.write(() => {
        this.ensureDialog(me, chat.peerId, false);
        this.db
          .update(dialogs)
          .set({ unreadMark: marked })
          .where(and(eq(dialogs.ownerId, me), eq(dialogs.peerId, chat.peerId)))
          .run();
        this.emit(me, "dialog.unreadMark", { peerId: chat.peerId, marked });
      });
    }
    return { seq: this.currentSeq(me) };
  }

  /** H7. Secret chats keep drafts on the device only (the server would see plain text). */
  setDraft(me: number, peerId: unknown, text: unknown) {
    const chat = this.chat(me, peerId);
    if (chat.kind === "secret") throw new ApiError(400, "DRAFT_NOT_ALLOWED", "Drafts of secret chats stay on your device.");
    if (typeof text !== "string") throw Errors.validation("text must be a string.");
    if (text.length > this.cfg.maxTextLen) throw Errors.messageTooLong(this.cfg.maxTextLen);
    const next = isBlank(text) ? null : text;
    const row = this.dialogRow(me, chat.peerId);
    const prev = row?.draftText ?? null;
    if (prev === next) {
      const draft = prev ? { text: prev, date: row?.draftUpdatedAt ?? 0 } : null;
      return { draft, seq: this.currentSeq(me) };
    }
    const now = this.now();
    const draft = next ? { text: next, date: now } : null;
    this.write(() => {
      this.ensureDialog(me, chat.peerId, true);
      this.db
        .update(dialogs)
        .set({ draftText: next, draftUpdatedAt: next ? now : null, touchedAt: now })
        .where(and(eq(dialogs.ownerId, me), eq(dialogs.peerId, chat.peerId)))
        .run();
      this.emit(me, "dialog.draft", { peerId: chat.peerId, draft });
    });
    return { draft, seq: this.currentSeq(me) };
  }

  /** H8, BR-READ-9 / BR-STATUS-5 */
  markRead(me: number, peerId: unknown, maxIdRaw: unknown) {
    const chat = this.chat(me, peerId);
    if (!isInt(maxIdRaw) || maxIdRaw < 0) throw Errors.validation("maxId must be a non-negative integer.");
    const row = this.dialogRow(me, chat.peerId);
    const cursor = row?.readInboxMaxId ?? 0;
    const newest = this.topMessage(me, chat)?.id ?? 0;
    const target = Math.min(maxIdRaw, newest);
    if (target > cursor) {
      return this.write(() => {
        this.ensureDialog(me, chat.peerId, false);
        this.db
          .update(dialogs)
          .set({ readInboxMaxId: target })
          .where(and(eq(dialogs.ownerId, me), eq(dialogs.peerId, chat.peerId)))
          .run();
        const unreadCount = this.unreadCount(me, chat, target);
        this.emit(me, "read.inbox", { peerId: chat.peerId, maxId: target, unreadCount });
        for (const u of this.membersOf(chat, me)) {
          if (u !== me) this.emit(u, "read.outbox", { peerId: this.viewerPeer(chat, me, u), maxId: target });
        }
        return { readInboxMaxId: target, unreadCount, seq: this.currentSeq(me) };
      });
    }
    return { readInboxMaxId: cursor, unreadCount: this.unreadCount(me, chat, cursor), seq: this.currentSeq(me) };
  }

  // ---------------------------------------------------------------- H9 history

  listMessages(
    me: number,
    peerId: unknown,
    q: { before?: number | null; after?: number | null; around?: number | null; limit?: number | null },
  ) {
    const chat = this.chat(me, peerId);
    let limit = isInt(q.limit) ? q.limit : 40;
    limit = Math.max(1, Math.min(100, limit));
    const base = and(this.chatCond(chat, me), this.visibleTo(me))!;
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
          .where(and(eq(messages.id, around), this.chatCond(chat, me)))
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

  private validateText(text: unknown, chat?: Chat): string {
    if (chat?.kind === "secret") {
      // The server never sees secret-chat plain text: only well-formed ciphertext is accepted.
      if (typeof text !== "string" || !CIPHER_RE.test(text) || text.length > this.cfg.maxTextLen * 4 + 256) {
        throw new ApiError(400, "CIPHERTEXT_INVALID", "Secret chat messages must be encrypted on your device.");
      }
      return text;
    }
    if (typeof text !== "string" || isBlank(text)) throw Errors.messageEmpty();
    if (text.length > this.cfg.maxTextLen) throw Errors.messageTooLong(this.cfg.maxTextLen);
    return text;
  }

  /** Sending into a one-to-one or secret chat needs a live account that has not blocked you. */
  private assertCanMessage(me: number, chat: Chat): void {
    const other = this.otherUser(chat);
    if (!other) return;
    if (other.deletedAt != null) throw new ApiError(403, "PEER_DELETED", "This account was deleted.");
    if (this.isBlocked(other.id, me)) throw new ApiError(403, "BLOCKED", "You can't message this person.");
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

  /** Creates dialogs and emits message.new to everyone in the chat; the sender first. */
  private announceNew(m: MessageRow, afterSender?: () => void): void {
    const audience = this.audience(m);
    const ordered = [m.senderId, ...audience.filter((u) => u !== m.senderId)];
    for (const u of ordered) {
      if (u === m.senderId && !audience.includes(u)) {
        afterSender?.();
        continue;
      }
      this.ensureDialog(u, this.msgPeer(m, u), true);
      this.emit(u, "message.new", { message: this.wireMessage(m, u) });
      if (u === m.senderId) afterSender?.();
    }
  }

  private insertService(chat: Chat, me: number, action: ServiceAction): MessageRow {
    const row = this.insertMessage({
      ...this.address(chat, me),
      senderId: me,
      text: "",
      service: JSON.stringify(action),
      createdAt: this.now(),
      clientToken: crypto.randomUUID(),
    });
    this.announceNew(row);
    return row;
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
    const chat = this.chat(me, peerId);
    const text = this.validateText(body.text, chat);
    this.assertCanMessage(me, chat);
    let replyToId: number | null = null;
    if (body.replyToId != null) {
      if (!isInt(body.replyToId)) throw Errors.replyTargetInvalid();
      const target = this.getMessage(body.replyToId);
      if (!target || target.service || !this.inChat(target, chat, me) || !this.isVisible(target, me)) {
        throw Errors.replyTargetInvalid();
      }
      replyToId = target.id;
    }
    this.checkRate(me, 1);
    const clearDraft = body.clearDraft !== false;
    const result = this.write(() => {
      const dup = this.byToken(me, token);
      if (dup) return { row: dup, duplicate: true };
      const row = this.insertMessage({
        ...this.address(chat, me),
        senderId: me,
        text,
        createdAt: this.now(),
        replyToId,
        clientToken: token,
      });
      this.announceNew(row, () => {
        if (!clearDraft) return;
        const d = this.dialogRow(me, chat.peerId);
        if (d?.draftText) {
          this.db
            .update(dialogs)
            .set({ draftText: null, draftUpdatedAt: null })
            .where(and(eq(dialogs.ownerId, me), eq(dialogs.peerId, chat.peerId)))
            .run();
          this.emit(me, "dialog.draft", { peerId: chat.peerId, draft: null });
        }
      });
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
      for (const u of this.audience(r)) {
        if (onlyFor && !onlyFor.includes(u)) continue;
        if (!this.isVisible(r, u)) continue;
        const peer = this.msgPeer(r, u);
        const byPeer = perUser.get(u) ?? new Map<number, number[]>();
        byPeer.set(peer, [...(byPeer.get(peer) ?? []), r.id]);
        perUser.set(u, byPeer);
      }
    }
    for (const [u, byPeer] of perUser) {
      for (const [peerId, ids] of byPeer) this.emit(u, "reply.updated", { peerId, messageIds: ids.sort((a, b) => a - b) });
    }
  }

  private messageChat(m: MessageRow, me: number): Chat {
    return this.chat(me, this.msgPeer(m, me));
  }

  // ---------------------------------------------------------------- H11 edit

  editMessage(me: number, idRaw: unknown, text: unknown) {
    if (!isInt(idRaw)) throw Errors.messageNotFound();
    const m = this.getMessage(idRaw);
    if (!m || !this.isVisible(m, me)) throw Errors.messageNotFound();
    if (m.senderId !== me || m.service) throw new ApiError(403, "EDIT_NOT_ALLOWED", "Only your own messages can be edited.");
    if (m.fwdFromDate != null) throw new ApiError(403, "EDIT_NOT_ALLOWED", "Forwarded messages cannot be edited.");
    if (this.now() - m.createdAt > this.cfg.editLimitMs) {
      throw new ApiError(403, "EDIT_TIME_EXPIRED", "This message is too old to edit.");
    }
    const t = this.validateText(text, this.messageChat(m, me));
    if (t === m.text) throw new ApiError(409, "TEXT_UNCHANGED", "Nothing changed.");
    const updated = this.write(() => {
      const row = this.db
        .update(messages)
        .set({ text: t, editedAt: this.now() })
        .where(eq(messages.id, m.id))
        .returning()
        .get();
      for (const u of this.audience(row)) {
        if (this.isVisible(row, u)) this.emit(u, "message.edited", { message: this.wireMessage(row, u) });
      }
      this.emitReplyUpdated([row.id], null);
      return row;
    });
    return { message: this.wireMessage(updated, me), seq: this.currentSeq(me) };
  }

  // ---------------------------------------------------------------- reactions

  react(me: number, idRaw: unknown, emoji: unknown) {
    if (!isInt(idRaw)) throw Errors.messageNotFound();
    const m = this.getMessage(idRaw);
    if (!m || !this.isVisible(m, me) || m.service) throw Errors.messageNotFound();
    if (emoji !== null && !(typeof emoji === "string" && (REACTIONS as readonly string[]).includes(emoji))) {
      throw Errors.validation("Pick one of the offered reactions.");
    }
    const current = this.db
      .select()
      .from(messageReactions)
      .where(and(eq(messageReactions.messageId, m.id), eq(messageReactions.userId, me)))
      .get();
    if ((current?.emoji ?? null) !== emoji) {
      this.write(() => {
        if (emoji === null) {
          this.db
            .delete(messageReactions)
            .where(and(eq(messageReactions.messageId, m.id), eq(messageReactions.userId, me)))
            .run();
        } else {
          this.db
            .insert(messageReactions)
            .values({ messageId: m.id, userId: me, emoji, createdAt: this.now() })
            .onConflictDoUpdate({ target: [messageReactions.messageId, messageReactions.userId], set: { emoji } })
            .run();
        }
        for (const u of this.audience(m)) {
          if (!this.isVisible(m, u)) continue;
          this.emit(u, "message.reactions", {
            peerId: this.msgPeer(m, u),
            messageId: m.id,
            reactions: this.reactionsFor(m.id, u),
          });
        }
      });
    }
    return { reactions: this.reactionsFor(m.id, me), seq: this.currentSeq(me) };
  }

  // ---------------------------------------------------------------- H12 delete

  deleteMessages(me: number, peerId: unknown, body: { ids?: unknown; forEveryone?: unknown }) {
    const chat = this.chat(me, peerId);
    if (!Array.isArray(body.ids) || !body.ids.every(isInt)) throw Errors.validation("ids must be a list of integers.");
    if (body.ids.length > MAX_IDS) throw Errors.tooManyIds();
    const forEveryone = body.forEveryone === true;
    const ids = [...new Set(body.ids as number[])];
    if (ids.length === 0) return { deletedIds: [], seq: this.currentSeq(me) };
    const rows = this.db
      .select()
      .from(messages)
      .where(and(inArray(messages.id, ids), this.chatCond(chat, me), this.visibleTo(me)))
      .orderBy(asc(messages.id))
      .all();
    if (rows.length === 0) return { deletedIds: [], seq: this.currentSeq(me) };
    if (forEveryone) {
      const now = this.now();
      for (const r of rows) {
        if (this.cfg.revokeLimitMs != null && now - r.createdAt > this.cfg.revokeLimitMs) {
          throw new ApiError(403, "REVOKE_FORBIDDEN", "This message is too old to delete for everyone.");
        }
        if (r.senderId === me) continue;
        if (chat.kind === "group" ? chat.group.ownerId !== me : !this.cfg.revokePeerMessages) {
          throw new ApiError(403, "REVOKE_FORBIDDEN", "Only your own messages can be deleted for everyone.");
        }
      }
    }
    const deletedIds = rows.map((r) => r.id);
    this.write(() => {
      if (forEveryone) {
        const others = this.membersOf(chat, me).filter((u) => u !== me);
        const visibleFor = new Map(others.map((u) => [u, rows.filter((r) => this.isVisible(r, u)).map((r) => r.id)]));
        this.db.update(messages).set({ deletedForEveryoneAt: this.now() }).where(inArray(messages.id, deletedIds)).run();
        this.emit(me, "messages.deleted", { peerId: chat.peerId, ids: deletedIds });
        for (const [u, seen] of visibleFor) {
          if (seen.length > 0) this.emit(u, "messages.deleted", { peerId: this.viewerPeer(chat, me, u), ids: seen });
        }
        this.emitReplyUpdated(deletedIds, null);
      } else {
        for (const id of deletedIds) {
          this.db.insert(messageHidden).values({ userId: me, messageId: id }).onConflictDoNothing().run();
        }
        this.emit(me, "messages.deleted", { peerId: chat.peerId, ids: deletedIds });
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
    const target = this.chat(me, targetPeerId);
    const from = this.chat(me, body.fromPeerId);
    if (target.kind === "secret" || from.kind === "secret") {
      throw new ApiError(403, "FORWARD_NOT_ALLOWED", "Secret chat messages can't be forwarded.");
    }
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
    this.assertCanMessage(me, target);

    const pairs = (ids as number[]).map((id, i) => ({ id, token: (tokens as string[])[i] }));
    const sources = new Map<number, MessageRow>();
    for (const p of pairs) {
      const m = this.getMessage(p.id);
      if (!m || m.service || !this.inChat(m, from, me) || !this.isVisible(m, me)) throw Errors.messageNotFound();
      sources.set(p.id, m);
    }
    pairs.sort((a, b) => a.id - b.id);
    this.checkRate(me, pairs.length);

    const created = this.write(() => {
      const mapped = new Map<number, number>();
      const out: MessageRow[] = [];
      const address = this.address(target, me);
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
          ...address,
          senderId: me,
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

  // ---------------------------------------------------------------- groups

  private validateTitle(title: unknown): string {
    if (typeof title !== "string" || title.trim().length < 1 || title.trim().length > 64) {
      throw Errors.validation("Group names are 1-64 characters.");
    }
    return title.trim();
  }

  /** Live, distinct users other than `me` from a request body list. */
  private validateUserIds(me: number, raw: unknown): UserRow[] {
    if (!Array.isArray(raw) || !raw.every(isInt)) throw Errors.validation("userIds must be a list of ids.");
    const ids = [...new Set(raw as number[])].filter((id) => id !== me);
    if (ids.length > MAX_GROUP_MEMBERS) throw Errors.validation(`Groups can have up to ${MAX_GROUP_MEMBERS} members.`);
    const rows = ids.length ? this.db.select().from(users).where(inArray(users.id, ids)).all() : [];
    if (rows.length !== ids.length || rows.some((u) => u.deletedAt != null)) throw Errors.peerInvalid();
    return ids.map((id) => rows.find((u) => u.id === id)!);
  }

  private groupChat(me: number, peerId: unknown): Extract<Chat, { kind: "group" }> {
    const chat = this.chat(me, peerId);
    if (chat.kind !== "group") throw Errors.peerInvalid();
    return chat;
  }

  private emitGroupUpdated(chat: Extract<Chat, { kind: "group" }>): void {
    const group = this.db.select().from(groups).where(eq(groups.id, chat.group.id)).get()!;
    const info = this.groupInfo(group);
    for (const u of this.memberIds(group.id)) this.emit(u, "group.updated", { peerId: chat.peerId, group: info });
  }

  createGroup(me: number, body: { title?: unknown; userIds?: unknown }) {
    const title = this.validateTitle(body.title);
    const others = this.validateUserIds(me, body.userIds);
    if (others.length === 0) throw Errors.validation("Add at least one person.");
    if (others.length + 1 > MAX_GROUP_MEMBERS) throw Errors.validation(`Groups can have up to ${MAX_GROUP_MEMBERS} members.`);
    const peerId = this.write(() => {
      const now = this.now();
      const group = this.db.insert(groups).values({ title, ownerId: me, createdAt: now }).returning().get();
      for (const u of [me, ...others.map((o) => o.id)]) {
        this.db.insert(groupMembers).values({ groupId: group.id, userId: u, joinedAt: now }).run();
      }
      const chat: Chat = { kind: "group", peerId: groupPeer(group.id), group };
      this.insertService(chat, me, { type: "groupCreated", title });
      return chat.peerId;
    });
    return { peerId, seq: this.currentSeq(me) };
  }

  getGroup(me: number, peerId: unknown) {
    return { group: this.groupInfo(this.groupChat(me, peerId).group) };
  }

  renameGroup(me: number, peerId: unknown, body: { title?: unknown }) {
    const chat = this.groupChat(me, peerId);
    const title = this.validateTitle(body.title);
    if (title !== chat.group.title) {
      this.write(() => {
        this.db.update(groups).set({ title }).where(eq(groups.id, chat.group.id)).run();
        this.insertService(chat, me, { type: "groupRenamed", title });
        this.emitGroupUpdated(chat);
      });
    }
    return { seq: this.currentSeq(me) };
  }

  addMembers(me: number, peerId: unknown, body: { userIds?: unknown }) {
    const chat = this.groupChat(me, peerId);
    const current = new Set(this.memberIds(chat.group.id));
    const added = this.validateUserIds(me, body.userIds).filter((u) => !current.has(u.id));
    if (current.size + added.length > MAX_GROUP_MEMBERS) {
      throw Errors.validation(`Groups can have up to ${MAX_GROUP_MEMBERS} members.`);
    }
    if (added.length > 0) {
      this.write(() => {
        for (const u of added) {
          this.db.insert(groupMembers).values({ groupId: chat.group.id, userId: u.id, joinedAt: this.now() }).run();
        }
        this.insertService(chat, me, {
          type: "membersAdded",
          userIds: added.map((u) => u.id),
          names: added.map((u) => u.displayName),
        });
        this.emitGroupUpdated(chat);
      });
    }
    return { added: added.map((u) => u.id), seq: this.currentSeq(me) };
  }

  /** Inside a write: `me` leaves the group; ownership passes to the longest-standing member. */
  private leaveGroupTx(me: number, chat: Extract<Chat, { kind: "group" }>): void {
    this.db
      .delete(groupMembers)
      .where(and(eq(groupMembers.groupId, chat.group.id), eq(groupMembers.userId, me)))
      .run();
    this.db.delete(dialogs).where(and(eq(dialogs.ownerId, me), eq(dialogs.peerId, chat.peerId))).run();
    this.emit(me, "dialog.removed", { peerId: chat.peerId });
    const remaining = this.memberIds(chat.group.id);
    if (remaining.length === 0) return;
    if (chat.group.ownerId === me) this.db.update(groups).set({ ownerId: remaining[0] }).where(eq(groups.id, chat.group.id)).run();
    this.insertService(chat, me, { type: "memberLeft" });
    this.emitGroupUpdated(chat);
  }

  /** Leave (userId = me) or, for the owner, remove someone. */
  removeMember(me: number, peerId: unknown, userIdRaw: unknown) {
    const chat = this.groupChat(me, peerId);
    if (userIdRaw === me) {
      this.write(() => this.leaveGroupTx(me, chat));
      return { seq: this.currentSeq(me) };
    }
    if (!isInt(userIdRaw) || !this.isMember(chat.group.id, userIdRaw)) throw Errors.peerInvalid();
    if (chat.group.ownerId !== me) throw new ApiError(403, "NOT_GROUP_OWNER", "Only the group owner can remove people.");
    const target = this.user(userIdRaw)!;
    this.write(() => {
      this.db
        .delete(groupMembers)
        .where(and(eq(groupMembers.groupId, chat.group.id), eq(groupMembers.userId, target.id)))
        .run();
      this.db.delete(dialogs).where(and(eq(dialogs.ownerId, target.id), eq(dialogs.peerId, chat.peerId))).run();
      this.emit(target.id, "dialog.removed", { peerId: chat.peerId });
      this.insertService(chat, me, { type: "memberRemoved", userId: target.id, name: target.displayName });
      this.emitGroupUpdated(chat);
    });
    return { seq: this.currentSeq(me) };
  }

  // ---------------------------------------------------------------- secret chats

  /** Registers this device's public key (base64 raw uncompressed P-256 point). */
  registerKey(me: number, publicKey: unknown) {
    if (typeof publicKey !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(publicKey)) {
      throw Errors.validation("publicKey must be a raw P-256 public key.");
    }
    const raw = Buffer.from(publicKey, "base64");
    if (raw.length !== 65 || raw[0] !== 4) throw Errors.validation("publicKey must be a raw P-256 public key.");
    this.db.insert(userKeys).values({ userId: me, publicKey, createdAt: this.now() }).onConflictDoNothing().run();
    return { ok: true };
  }

  createSecretChat(me: number, body: { userId?: unknown; publicKey?: unknown }) {
    if (!isInt(body.userId) || body.userId === me) throw Errors.peerInvalid();
    const other = this.user(body.userId);
    if (!other) throw Errors.peerInvalid();
    const otherChat: Chat = { kind: "user", peerId: other.id, user: other };
    this.assertCanMessage(me, otherChat);
    const mine =
      typeof body.publicKey === "string"
        ? this.db
            .select()
            .from(userKeys)
            .where(and(eq(userKeys.userId, me), eq(userKeys.publicKey, body.publicKey)))
            .get()
        : undefined;
    if (!mine) throw Errors.validation("Register this device's key first.");
    const theirs = this.db.select().from(userKeys).where(eq(userKeys.userId, other.id)).orderBy(desc(userKeys.id)).limit(1).get();
    if (!theirs) {
      throw new ApiError(409, "NO_SECRET_KEY", `${other.displayName} needs to open Relay once before you can start a secret chat.`);
    }
    const peerId = this.write(() => {
      const secret = this.db
        .insert(secretChats)
        .values({
          initiatorId: me,
          responderId: other.id,
          initiatorKey: mine.publicKey,
          responderKey: theirs.publicKey,
          createdAt: this.now(),
        })
        .returning()
        .get();
      const chat: Chat = { kind: "secret", peerId: secretPeer(secret.id), secret, other };
      this.insertService(chat, me, { type: "secretStarted" });
      return chat.peerId;
    });
    return { peerId, seq: this.currentSeq(me) };
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
