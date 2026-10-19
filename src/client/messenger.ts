// Relay client core: cache, sync engine, send pipeline, read tracking, conversation state.
// Framework-free; the React UI subscribes to it. Rules reference spec section 6.

import type {
  ClientFrame,
  Dialog,
  Draft,
  Message,
  Presence,
  Reaction,
  SecretInfo,
  ServerFrame,
  SyncEvent,
  UserSummary,
} from "../shared/types";
import { MAX_TEXT_LEN, isBlank, previewText, splitText, uuidV4 } from "../shared/text";
import { activityDate } from "../shared/dialogOrder";
import { peerKind, secretIdOf } from "../shared/peer";
import { ApiClient, ApiFailure, type FetchLike } from "./api";
import {
  buildTimeline,
  deriveRow,
  dividerBeforeId,
  firstPageSize,
  firstUnreadId,
  goToBottomTarget,
  messagePreview,
  openMode,
  sortRows,
  type ClientDialog,
  type DialogRowModel,
  type PendingMessage,
  type TimelineItem,
} from "./derive";
import { copy } from "./copy";
import {
  decryptText,
  deriveChatKey,
  encryptText,
  exportPublicKey,
  generateDeviceKey,
  keyFingerprint,
  secretSupported,
  type SecretKeyStore,
} from "./secret";

export interface SocketLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ClientConfig {
  gapWaitMs: number;
  pingIntervalMs: number;
  idleTimeoutMs: number;
  reconnectDelaysMs: number[];
  sendRetryDelaysMs: number[];
  draftSaveDelayMs: number;
  maxTextLen: number;
  editLimitMs: number;
  olderPageSize: number;
}

export const defaultClientConfig: ClientConfig = {
  gapWaitMs: 500, // OD-12
  pingIntervalMs: 25_000,
  idleTimeoutMs: 60_000,
  reconnectDelaysMs: [500, 1000, 2000, 5000, 10_000],
  sendRetryDelaysMs: [1000, 3000, 10_000], // OD-5
  draftSaveDelayMs: 1500, // OD-3
  maxTextLen: MAX_TEXT_LEN,
  editLimitMs: 48 * 3600_000, // OD-4
  olderPageSize: 40,
};

export interface ClientDeps {
  baseUrl?: string;
  wsUrl: string;
  fetch: FetchLike;
  openSocket: (url: string) => SocketLike;
  storage?: StorageLike | null;
  /** Device key storage for secret chats; without it secret chats are unavailable. */
  secretKeys?: SecretKeyStore | null;
  config?: Partial<ClientConfig>;
}

/** How long a typing notice stays visible without a refresh. */
const TYPING_TTL_MS = 6000;
/** Minimum gap between typing notices we send for one chat. */
const TYPING_SEND_GAP_MS = 3000;

export type SecretStatus = "ready" | "otherDevice" | "unsupported";

export interface ConvState {
  peerId: number;
  /** Confirmed messages, ascending id. */
  messages: Message[];
  hasOlder: boolean;
  hasNewer: boolean;
  status: "loading" | "ready" | "error";
  loadingOlder: boolean;
  loadingNewer: boolean;
  error: { dir: "initial" | "older" | "newer"; message: string } | null;
  dividerBeforeId: number | null;
  /** First unread incoming id as of opening (used for go-to-bottom). */
  firstUnreadAtOpen: number | null;
  highlightId: number | null;
  jumpStack: number[];
  /** Scroll command for the view; nonce changes on every request. */
  scroll: { nonce: number; to: "bottom" | { id: number; align: "top" | "center" } | "saved" } | null;
}

export interface EditState {
  messageId: number;
  savedComposer: string;
  busy: boolean;
  error: string | null;
}

export interface ForwardDraft {
  fromPeerId: number;
  messageIds: number[];
  hideSender: boolean;
}

export type Phase = "boot" | "signedOut" | "loading" | "ready";
export type Connection = "offline" | "connecting" | "online";

export interface Notice {
  id: number;
  text: string;
}

const STORAGE_PREFIX = "relay.lastSeq.";

export class Messenger {
  // --------------------------------------------------------------- public state
  phase: Phase = "boot";
  connection: Connection = "offline";
  syncing = false;
  resetting = false;
  me: UserSummary | null = null;
  /** My account email (private; null for accounts made before emails existed). */
  myEmail: string | null = null;
  dialogs = new Map<number, ClientDialog>();
  dialogsCursor: string | null = null;
  convs = new Map<number, ConvState>();
  pending = new Map<string, PendingMessage>();
  openPeerId: number | null = null;
  composer = new Map<number, string>();
  replyTo = new Map<number, number>();
  editing = new Map<number, EditState>();
  forwardDraft = new Map<number, ForwardDraft>();
  selection = new Map<number, Set<number>>();
  notices: Notice[] = [];
  focusGateOpen = true;
  /** OD-15: scroll memory per conversation for this browser session. */
  scrollMemory = new Map<number, { anchorId: number; offset: number }>();
  /** Presence by user id (from dialogs, /api/presence and presence frames). */
  presence = new Map<number, Presence>();
  /** peerId -> userId -> expiry time of their typing notice. */
  typing = new Map<number, Map<number, number>>();
  /** This device's secret-chat public key (base64), once loaded. */
  devicePublicKey: string | null = null;

  readonly cfg: ClientConfig;
  readonly api: ApiClient;

  // --------------------------------------------------------------- internals
  private version = 0;
  private listeners = new Set<() => void>();
  private notifyScheduled = false;
  private lastSeq = 0;
  private held = new Map<number, SyncEvent>();
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  private catchingUp = false;
  private catchUpAgain = false;
  private chain: Promise<void> = Promise.resolve();
  private background = new Set<Promise<unknown>>();
  private socket: SocketLike | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastFrameAt = 0;
  private helloSeq: number | null = null;
  private serverOffset = 0;
  private pendingOrder = 0;
  private sendQueues = new Map<number, Promise<void>>();
  private readState = new Map<number, { seenMax: number; inFlight: boolean; again: boolean }>();
  private draftTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private noticeId = 0;
  private scrollNonce = 0;
  private stopped = false;
  private fetchingDialogs = new Map<number, Promise<ClientDialog>>();
  private deviceKeys: CryptoKeyPair | null = null;
  private keysReady: Promise<void> = Promise.resolve();
  private chatKeys = new Map<number, Promise<CryptoKey | null>>();
  private typingSentAt = new Map<number, number>();
  private typingTimer: ReturnType<typeof setTimeout> | null = null;
  private leaving = new Set<number>();

  constructor(private deps: ClientDeps) {
    this.cfg = { ...defaultClientConfig, ...(deps.config ?? {}) };
    this.api = new ApiClient(deps.baseUrl ?? "", deps.fetch);
  }

  // ================================================================= subscription

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  /** BR-LIST-13: changes in the same tick are coalesced into one notification. */
  private changed(): void {
    this.version++;
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      for (const l of this.listeners) l();
    });
  }

  notice(text: string): void {
    this.notices = [...this.notices, { id: ++this.noticeId, text }];
    this.changed();
  }

  dismissNotice(id: number): void {
    this.notices = this.notices.filter((n) => n.id !== id);
    this.changed();
  }

  /** Resolves when queued event processing and background refreshes have settled (tests). */
  async idle(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await this.chain;
      if (this.background.size === 0 && !this.catchingUp) {
        await new Promise((r) => setTimeout(r, 0));
        if (this.background.size === 0 && !this.catchingUp) return;
      }
      await Promise.allSettled([...this.background]);
    }
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.background.add(p);
    const done = () => this.background.delete(p);
    p.then(done, done);
    return p;
  }

  serverNow(): number {
    return Date.now() + this.serverOffset;
  }

  getLastSeq(): number {
    return this.lastSeq;
  }

  // ================================================================= auth & lifecycle

  async start(): Promise<void> {
    try {
      const me = await this.call<{ user: UserSummary; email: string | null; seq: number; serverTime: number }>(
        "GET",
        "/api/me",
      );
      this.me = me.user;
      this.myEmail = me.email;
      this.serverOffset = me.serverTime - Date.now();
      this.keysReady = this.loadDeviceKeys(me.user.id);
      await this.init();
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 401) {
        this.phase = "signedOut";
        this.changed();
        return;
      }
      throw e;
    }
  }

  /** `username` may also be the account's email address. */
  async login(username: string, password: string): Promise<void> {
    const r = await this.call<{ user: UserSummary }>("POST", "/api/auth/login", { username, password });
    this.me = r.user;
    await this.start();
  }

  async register(username: string, email: string, displayName: string, password: string): Promise<void> {
    const r = await this.call<{ user: UserSummary }>("POST", "/api/auth/register", { username, email, displayName, password });
    this.me = r.user;
    await this.start();
  }

  async logout(): Promise<void> {
    try {
      await this.call("POST", "/api/auth/logout");
    } catch {
      /* ignore */
    }
    this.signedOut();
  }

  private signedOut(): void {
    this.stop();
    this.clearAll(true);
    this.me = null;
    this.myEmail = null;
    this.deviceKeys = null;
    this.devicePublicKey = null;
    this.chatKeys.clear();
    this.presence.clear();
    this.phase = "signedOut";
    this.stopped = false;
    this.changed();
  }

  /** Loads (or creates) this device's secret-chat key pair and registers its public half. */
  private async loadDeviceKeys(userId: number): Promise<void> {
    const store = this.deps.secretKeys;
    if (!store || !secretSupported()) return;
    try {
      let pair = await store.load(userId);
      if (!pair) {
        pair = await generateDeviceKey();
        await store.save(userId, pair);
      }
      this.deviceKeys = pair;
      this.devicePublicKey = await exportPublicKey(pair.publicKey);
      await this.api.call("PUT", "/api/keys", { publicKey: this.devicePublicKey });
    } catch {
      /* secret chats stay unavailable on this device */
    }
  }

  /** API call whose result has secret-chat messages decrypted. */
  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.decode(await this.api.call<T>(method, path, body));
  }

  // ================================================================= secret chats (decode/encode)

  /** Decrypts secret-chat messages in an API result and records presence from dialogs. */
  private async decode<T>(r: T): Promise<T> {
    const o = r as { message?: Message; messages?: Message[]; dialog?: Dialog; dialogs?: Dialog[] } | null;
    if (!o || typeof o !== "object") return r;
    if (o.dialog) o.dialog = await this.decodeDialog(o.dialog);
    if (Array.isArray(o.dialogs)) o.dialogs = await Promise.all(o.dialogs.map((d) => this.decodeDialog(d)));
    if (o.message) o.message = await this.decodeMessage(o.message);
    if (Array.isArray(o.messages)) o.messages = await Promise.all(o.messages.map((m) => this.decodeMessage(m)));
    return r;
  }

  private async decodeDialog(d: Dialog): Promise<Dialog> {
    this.notePresence(d);
    if (d.kind !== "secret" || !d.topMessage) return d;
    return { ...d, topMessage: await this.decodeMessage(d.topMessage, d.secret) };
  }

  private async decodeMessage(m: Message, info?: SecretInfo | null): Promise<Message> {
    if (peerKind(m.peerId) !== "secret" || m.service) return m;
    const key = await this.secretKey(m.peerId, info);
    const sid = secretIdOf(m.peerId);
    const open = async (t: string): Promise<string | null> => {
      if (!key) return null;
      try {
        return await decryptText(key, t, sid);
      } catch {
        return null;
      }
    };
    const text = await open(m.text);
    let replyTo = m.replyTo;
    if (replyTo && !replyTo.deleted) {
      const s = await open(replyTo.snippet);
      replyTo = { ...replyTo, snippet: s == null ? copy.cantDecrypt : previewText(s) };
    }
    return { ...m, text: text ?? copy.cantDecrypt, undecryptable: text == null, replyTo };
  }

  /** The chat key for a secret chat, or null when this device does not hold a matching key. */
  private secretKey(peerId: number, info?: SecretInfo | null): Promise<CryptoKey | null> {
    const cached = this.chatKeys.get(peerId);
    if (cached) return cached;
    const p = (async () => {
      await this.keysReady;
      const s =
        info ??
        this.dialogs.get(peerId)?.secret ??
        (await this.api.call<{ dialog: Dialog }>("GET", `/api/dialogs/${peerId}`)).dialog.secret;
      if (!s || !this.deviceKeys || !this.me) return null;
      const iAmInitiator = s.initiatorId === this.me.id;
      if ((iAmInitiator ? s.initiatorKey : s.responderKey) !== this.devicePublicKey) return null;
      return deriveChatKey(this.deviceKeys.privateKey, iAmInitiator ? s.responderKey : s.initiatorKey, s.id);
    })().catch(() => null);
    this.chatKeys.set(peerId, p);
    // A failed lookup (network) should not stick.
    void p.then((k) => {
      if (!k && !this.dialogs.get(peerId)?.secret) this.chatKeys.delete(peerId);
    });
    return p;
  }

  secretStatus(peerId: number): SecretStatus {
    const s = this.dialogs.get(peerId)?.secret;
    if (!this.devicePublicKey || !this.me) return "unsupported";
    if (!s) return "ready";
    const mine = s.initiatorId === this.me.id ? s.initiatorKey : s.responderKey;
    return mine === this.devicePublicKey ? "ready" : "otherDevice";
  }

  async secretFingerprint(peerId: number): Promise<string | null> {
    const s = this.dialogs.get(peerId)?.secret;
    if (!s || !secretSupported()) return null;
    return keyFingerprint(s.initiatorKey, s.responderKey);
  }

  /** Text as it goes on the wire: encrypted for secret chats. */
  private async outgoingText(peerId: number, text: string): Promise<string> {
    if (peerKind(peerId) !== "secret") return text;
    const key = await this.secretKey(peerId);
    if (!key) throw new ApiFailure(0, "SECRET_UNAVAILABLE", copy.secretOtherDevice, false);
    return encryptText(key, text, secretIdOf(peerId));
  }

  // ================================================================= presence & typing

  /** The user behind a one-to-one or secret chat. */
  peerUserId(peerId: number): number | null {
    const kind = peerKind(peerId);
    if (kind === "user") return peerId;
    if (kind === "secret") return this.dialogs.get(peerId)?.secret?.userId ?? null;
    return null;
  }

  private notePresence(d: Dialog): void {
    const userId = d.kind === "user" ? d.peer.id : d.kind === "secret" ? d.secret?.userId : null;
    if (userId != null && d.presence) this.presence.set(userId, d.presence);
  }

  presenceOf(peerId: number): Presence | null {
    const userId = this.peerUserId(peerId);
    return userId == null ? null : (this.presence.get(userId) ?? null);
  }

  /** After (re)connecting: presence frames missed while offline are not replayed. */
  private async refreshPresence(): Promise<void> {
    const ids = new Set<number>();
    for (const d of this.dialogs.values()) {
      const u = this.peerUserId(d.peer.id);
      if (u != null) ids.add(u);
    }
    if (ids.size === 0) return;
    try {
      const r = await this.api.call<{ presence: Record<string, Presence> }>(
        "GET",
        `/api/presence?ids=${[...ids].slice(0, 200).join(",")}`,
      );
      for (const [id, p] of Object.entries(r.presence)) this.presence.set(Number(id), p);
      this.changed();
    } catch {
      /* next reconnect tries again */
    }
  }

  private sendFrame(frame: ClientFrame): void {
    try {
      this.socket?.send(JSON.stringify(frame));
    } catch {
      /* offline */
    }
  }

  private maybeSendTyping(peerId: number): void {
    const now = Date.now();
    if (now - (this.typingSentAt.get(peerId) ?? 0) < TYPING_SEND_GAP_MS) return;
    this.typingSentAt.set(peerId, now);
    this.sendFrame({ kind: "typing", peerId });
  }

  private clearTyping(peerId: number | null, userId: number): void {
    for (const [p, byUser] of this.typing) {
      if (peerId != null && p !== peerId) continue;
      byUser.delete(userId);
      if (byUser.size === 0) this.typing.delete(p);
    }
  }

  private scheduleTypingExpiry(): void {
    if (this.typingTimer) return;
    this.typingTimer = setTimeout(() => {
      this.typingTimer = null;
      const now = Date.now();
      for (const [p, byUser] of this.typing) {
        for (const [u, exp] of byUser) if (exp <= now) byUser.delete(u);
        if (byUser.size === 0) this.typing.delete(p);
      }
      this.changed();
      if (this.typing.size > 0) this.scheduleTypingExpiry();
    }, 1000);
  }

  /** Names of the people typing in a chat right now. */
  typingIn(peerId: number): string[] {
    const byUser = this.typing.get(peerId);
    if (!byUser) return [];
    const now = Date.now();
    return [...byUser]
      .filter(([, exp]) => exp > now)
      .map(([u]) => this.senderNameFor(peerId, u));
  }

  /** Display name of a message author in a chat. */
  senderNameFor(peerId: number, senderId: number, msg?: Message): string {
    if (senderId === this.me?.id) return this.me.displayName;
    const d = this.dialogs.get(peerId);
    if (d?.kind === "group") {
      return d.group?.members.find((u) => u.id === senderId)?.displayName ?? msg?.senderName ?? "";
    }
    return d?.peer.displayName ?? msg?.senderName ?? "";
  }

  /** Tears down sockets and timers. */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.gapTimer) clearTimeout(this.gapTimer);
    for (const t of this.draftTimers.values()) clearTimeout(t);
    this.draftTimers.clear();
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = null;
    this.typing.clear();
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.gapTimer = null;
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onclose = null;
      s.onmessage = null;
      try {
        s.close();
      } catch {
        /* ignore */
      }
    }
    this.connection = "offline";
  }

  private clearAll(includePending: boolean): void {
    this.dialogs.clear();
    this.convs.clear();
    this.dialogsCursor = null;
    this.held.clear();
    this.readState.clear();
    this.scrollMemory.clear();
    this.selection.clear();
    if (includePending) {
      this.pending.clear();
      this.composer.clear();
      this.replyTo.clear();
      this.editing.clear();
      this.forwardDraft.clear();
      this.openPeerId = null;
    }
  }

  /** BR-SYNC-7: fresh start loads dialogs and adopts their seq without replaying history. */
  private async init(): Promise<void> {
    this.phase = "loading";
    this.stopped = false;
    this.changed();
    await this.loadDialogsFresh();
    this.phase = "ready";
    this.changed();
    this.connect();
  }

  private async loadDialogsFresh(): Promise<void> {
    const r = await this.call<{ dialogs: Dialog[]; nextCursor: string | null; seq: number }>("GET", "/api/dialogs?limit=50");
    this.dialogs.clear();
    for (const d of r.dialogs) this.dialogs.set(d.peer.id, { ...d, listed: true });
    this.dialogsCursor = r.nextCursor;
    this.setLastSeq(r.seq);
    this.changed();
  }

  async loadMoreDialogs(): Promise<void> {
    if (!this.dialogsCursor) return;
    const r = await this.call<{ dialogs: Dialog[]; nextCursor: string | null }>(
      "GET",
      `/api/dialogs?limit=50&cursor=${encodeURIComponent(this.dialogsCursor)}`,
    );
    for (const d of r.dialogs) if (!this.dialogs.has(d.peer.id)) this.dialogs.set(d.peer.id, { ...d, listed: true });
    this.dialogsCursor = r.nextCursor;
    this.changed();
  }

  private setLastSeq(seq: number): void {
    this.lastSeq = seq;
    // OD-18: persist only lastSeq per user.
    if (this.me && this.deps.storage) {
      try {
        this.deps.storage.setItem(STORAGE_PREFIX + this.me.id, String(seq));
      } catch {
        /* storage unavailable */
      }
    }
  }

  // ================================================================= socket

  private connect(): void {
    if (this.stopped) return;
    this.connection = "connecting";
    this.changed();
    let s: SocketLike;
    try {
      s = this.deps.openSocket(this.deps.wsUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = s;
    s.onopen = () => {
      this.lastFrameAt = Date.now();
      this.reconnectAttempt = 0;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.heartbeat(), Math.min(this.cfg.pingIntervalMs, this.cfg.idleTimeoutMs / 2));
    };
    s.onmessage = (ev) => {
      this.lastFrameAt = Date.now();
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      this.handleFrame(frame);
    };
    s.onclose = (ev) => {
      if (this.socket !== s) return;
      this.socket = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (ev.code === 4401) {
        this.signedOut();
        return;
      }
      this.connection = "offline";
      this.changed();
      this.scheduleReconnect();
    };
    s.onerror = () => {
      /* onclose follows */
    };
  }

  private heartbeat(): void {
    const s = this.socket;
    if (!s) return;
    // BR-SYNC-9: no frame for the idle threshold -> reconnect and catch up.
    if (Date.now() - this.lastFrameAt > this.cfg.idleTimeoutMs) {
      this.dropConnection();
      return;
    }
    try {
      s.send(JSON.stringify({ kind: "ping" }));
    } catch {
      /* ignore */
    }
  }

  /** Closes the socket as if the network dropped; reconnects automatically. */
  dropConnection(): void {
    const s = this.socket;
    if (!s) return;
    this.socket = null;
    s.onmessage = null;
    s.onclose = null;
    try {
      s.close();
    } catch {
      /* ignore */
    }
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.connection = "offline";
    this.changed();
    this.scheduleReconnect();
  }

  /** Test hook: disconnect without reconnecting until resume(). */
  suspendConnection(): void {
    this.dropConnection();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  resumeConnection(): void {
    if (!this.socket) this.connect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delays = this.cfg.reconnectDelaysMs;
    const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)];
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  // ================================================================= sync engine (BR-SYNC)

  /** Entry point for every server frame (exposed for tests). */
  handleFrame(frame: ServerFrame): void {
    if (frame.kind === "pong") return;
    if (frame.kind === "presence") {
      this.presence.set(frame.userId, { online: frame.online, lastSeen: frame.lastSeen });
      if (!frame.online) this.clearTyping(null, frame.userId);
      this.changed();
      return;
    }
    if (frame.kind === "typing") {
      if (frame.userId === this.me?.id) return;
      const byUser = this.typing.get(frame.peerId) ?? new Map<number, number>();
      byUser.set(frame.userId, Date.now() + TYPING_TTL_MS);
      this.typing.set(frame.peerId, byUser);
      this.scheduleTypingExpiry();
      this.changed();
      return;
    }
    if (frame.kind === "hello") {
      this.serverOffset = frame.serverTime - Date.now();
      this.connection = "online";
      this.helloSeq = frame.seq;
      this.changed();
      void this.track(this.refreshPresence());
      // BR-SYNC-3
      if (frame.seq > this.lastSeq) void this.catchUp();
      else if (frame.seq < this.lastSeq) void this.enqueue(() => this.reset(frame.seq));
      return;
    }
    const { kind: _k, ...ev } = frame;
    this.onPushedEvent(ev as SyncEvent);
  }

  private enqueue(fn: () => Promise<void> | void): Promise<void> {
    const next = this.chain.then(fn).catch((e) => {
      if (typeof console !== "undefined") console.warn("[relay] event processing failed", e instanceof Error ? e.message : e);
    });
    this.chain = next;
    return next;
  }

  /** BR-SYNC-2 */
  private onPushedEvent(ev: SyncEvent): void {
    if (this.catchingUp || this.phase !== "ready") {
      if (ev.seq > this.lastSeq) this.held.set(ev.seq, ev);
      return;
    }
    void this.enqueue(async () => {
      if (ev.seq <= this.lastSeq) return; // duplicate (AC-5)
      if (ev.seq === this.lastSeq + 1) {
        await this.applyEvent(ev);
        this.setLastSeq(ev.seq);
        await this.drainHeld();
      } else {
        this.held.set(ev.seq, ev);
        this.startGapTimer();
      }
    });
  }

  private async drainHeld(): Promise<void> {
    while (this.held.has(this.lastSeq + 1)) {
      const ev = this.held.get(this.lastSeq + 1)!;
      this.held.delete(ev.seq);
      await this.applyEvent(ev);
      this.setLastSeq(ev.seq);
    }
    for (const s of [...this.held.keys()]) if (s <= this.lastSeq) this.held.delete(s);
    if (this.held.size === 0 && this.gapTimer) {
      clearTimeout(this.gapTimer);
      this.gapTimer = null;
    }
  }

  private startGapTimer(): void {
    if (this.gapTimer) return;
    this.gapTimer = setTimeout(() => {
      this.gapTimer = null;
      void this.catchUp();
    }, this.cfg.gapWaitMs);
  }

  /** BR-SYNC-4 / BR-SYNC-5 */
  catchUp(): Promise<void> {
    if (this.catchingUp) {
      this.catchUpAgain = true;
      return this.chain;
    }
    this.catchingUp = true;
    this.syncing = true;
    this.changed();
    const p = this.enqueue(async () => {
      try {
        let more = true;
        while (more) {
          let r: { events: SyncEvent[]; seq: number; more: boolean };
          try {
            r = await this.call("GET", `/api/sync?since=${this.lastSeq}&limit=500`);
          } catch (e) {
            if (e instanceof ApiFailure && e.status === 410) {
              const seq = (e.body as { seq?: number } | undefined)?.seq ?? 0;
              await this.reset(seq);
              return;
            }
            throw e;
          }
          for (const ev of r.events) {
            if (ev.seq !== this.lastSeq + 1) continue;
            await this.applyEvent(ev);
            this.setLastSeq(ev.seq);
          }
          more = r.more;
        }
        await this.drainHeld();
      } catch {
        // Network trouble: try again shortly.
        if (!this.stopped) setTimeout(() => void this.catchUp(), 2000);
      } finally {
        this.catchingUp = false;
        this.syncing = false;
        this.changed();
        if (this.held.size > 0) {
          // Events pushed during catch-up: apply what is contiguous, wait for the rest.
          void this.enqueue(() => this.drainHeld().then(() => (this.held.size > 0 ? this.startGapTimer() : undefined)));
        }
        if (this.catchUpAgain) {
          this.catchUpAgain = false;
          void this.catchUp();
        }
      }
    });
    return p;
  }

  /** BR-SYNC-5: discard caches, keep pending sends, reload from scratch. */
  private async reset(seq: number): Promise<void> {
    this.resetting = true;
    this.changed();
    try {
      this.clearAll(false);
      this.setLastSeq(seq);
      const r = await this.call<{ dialogs: Dialog[]; nextCursor: string | null; seq: number }>(
        "GET",
        "/api/dialogs?limit=50",
      );
      for (const d of r.dialogs) this.dialogs.set(d.peer.id, { ...d, listed: true });
      this.dialogsCursor = r.nextCursor;
      if (this.openPeerId != null) {
        const peer = this.openPeerId;
        await this.ensureDialog(peer);
        await this.loadInitial(peer, 600);
      }
    } finally {
      this.resetting = false;
      this.changed();
    }
  }

  // ================================================================= dialogs

  private async ensureDialog(peerId: number): Promise<ClientDialog> {
    const existing = this.dialogs.get(peerId);
    if (existing) return existing;
    return this.fetchDialog(peerId);
  }

  /** BR-SYNC-10 / BR-DEL-7: (re)fetch one dialog from the server. */
  fetchDialog(peerId: number): Promise<ClientDialog> {
    const inflight = this.fetchingDialogs.get(peerId);
    if (inflight) return inflight;
    const p = (async () => {
      try {
        const r = await this.call<{ dialog: Dialog }>("GET", `/api/dialogs/${peerId}`);
        const prev = this.dialogs.get(peerId);
        const listed = (prev?.listed ?? false) || !!r.dialog.topMessage || !!r.dialog.draft || r.dialog.pinned;
        const d: ClientDialog = { ...r.dialog, listed };
        this.dialogs.set(peerId, d);
        this.changed();
        return d;
      } catch {
        const prev = this.dialogs.get(peerId);
        if (prev) return prev;
        const stub: ClientDialog = {
          kind: peerKind(peerId),
          group: null,
          secret: null,
          blocked: false,
          peerDeleted: false,
          presence: null,
          peer: { id: peerId, username: "", displayName: "…" },
          topMessage: null,
          unreadCount: 0,
          unreadMark: false,
          pinned: false,
          pinOrder: null,
          draft: null,
          readInboxMaxId: 0,
          readOutboxMaxId: 0,
          activityDate: 0,
          listed: false,
        };
        this.dialogs.set(peerId, stub);
        return stub;
      } finally {
        this.fetchingDialogs.delete(peerId);
      }
    })();
    this.fetchingDialogs.set(peerId, p);
    return this.track(p);
  }

  private pendingFor(peerId: number): PendingMessage[] {
    return [...this.pending.values()].filter((p) => p.peerId === peerId).sort((a, b) => a.order - b.order);
  }

  /** Sorted rows for the dialog list (BR-LIST-1..10). */
  dialogRows(): DialogRowModel[] {
    const rows: DialogRowModel[] = [];
    for (const d of this.dialogs.values()) {
      const pend = this.pendingFor(d.peer.id);
      const latest = pend.length ? pend[pend.length - 1] : null;
      if (!d.listed && !latest && !d.draft && !d.pinned && !d.topMessage) continue;
      const row = deriveRow({ ...d, presence: this.presenceOf(d.peer.id) }, latest);
      const typing = this.typingIn(d.peer.id);
      if (typing.length > 0 && row.subtitle.kind !== "draft") {
        row.subtitle = { kind: "typing", text: d.kind === "group" ? copy.typingNames(typing) : copy.typing };
      }
      rows.push(row);
    }
    return sortRows(rows);
  }

  /** Removes a chat this user can no longer see (left or removed from a group). */
  private dropDialog(peerId: number): void {
    this.dialogs.delete(peerId);
    this.convs.delete(peerId);
    for (const [token, p] of this.pending) if (p.peerId === peerId) this.pending.delete(token);
    this.composer.delete(peerId);
    this.replyTo.delete(peerId);
    this.editing.delete(peerId);
    this.selection.delete(peerId);
    this.typing.delete(peerId);
    if (this.openPeerId === peerId) this.openPeerId = null;
    if (!this.leaving.delete(peerId)) this.notice(copy.removedFromChat);
  }

  /** Applies a profile change of another user everywhere their name is shown. */
  private applyPeerUpdated(user: UserSummary, deleted: boolean): void {
    for (const d of this.dialogs.values()) {
      if (d.kind === "user" && d.peer.id === user.id) {
        d.peer = user;
        d.peerDeleted = deleted;
      } else if (d.kind === "secret" && d.secret?.userId === user.id) {
        d.peer = { ...user, id: d.peer.id };
        d.peerDeleted = deleted;
      } else if (d.kind === "group" && d.group) {
        d.group = { ...d.group, members: d.group.members.map((m) => (m.id === user.id ? user : m)) };
      }
    }
    for (const conv of this.convs.values()) {
      if (peerKind(conv.peerId) === "user") continue;
      conv.messages = conv.messages.map((m) => (m.senderId === user.id ? { ...m, senderName: user.displayName } : m));
    }
  }

  private applyReactions(peerId: number, messageId: number, reactions: Reaction[]): void {
    const conv = this.convs.get(peerId);
    if (conv) conv.messages = conv.messages.map((m) => (m.id === messageId ? { ...m, reactions } : m));
    const d = this.dialogs.get(peerId);
    if (d?.topMessage?.id === messageId) d.topMessage = { ...d.topMessage, reactions };
  }

  // ================================================================= event application

  private async applyEvent(ev: SyncEvent): Promise<void> {
    switch (ev.type) {
      case "message.new": {
        await this.ensureDialog(ev.data.message.peerId);
        const msg = await this.decodeMessage(ev.data.message);
        this.clearTyping(msg.peerId, msg.senderId);
        this.applyNewMessage(msg);
        break;
      }
      case "message.edited":
        this.applyEdited(await this.decodeMessage(ev.data.message));
        break;
      case "message.reactions":
        this.applyReactions(ev.data.peerId, ev.data.messageId, ev.data.reactions);
        break;
      case "dialog.removed":
        this.dropDialog(ev.data.peerId);
        break;
      case "group.updated": {
        const d = this.dialogs.get(ev.data.peerId);
        if (d) {
          d.group = ev.data.group;
          d.peer = { ...d.peer, displayName: ev.data.group.title };
        }
        break;
      }
      case "peer.updated":
        this.applyPeerUpdated(ev.data.user, ev.data.deleted);
        break;
      case "me.updated":
        this.me = ev.data.user;
        break;
      case "user.blocked":
        for (const d of this.dialogs.values()) {
          if (this.peerUserId(d.peer.id) === ev.data.userId) d.blocked = ev.data.blocked;
        }
        break;
      case "messages.deleted":
        await this.ensureDialog(ev.data.peerId);
        this.applyDeleted(ev.data.peerId, ev.data.ids);
        break;
      case "reply.updated":
        // Reply headers are patched from message.edited / messages.deleted, which always reach
        // the same user before this event; nothing else to do.
        break;
      case "read.inbox": {
        const d = await this.ensureDialog(ev.data.peerId);
        d.readInboxMaxId = Math.max(d.readInboxMaxId, ev.data.maxId);
        d.unreadCount = ev.data.unreadCount; // E3-10 authoritative
        break;
      }
      case "read.outbox": {
        const d = await this.ensureDialog(ev.data.peerId);
        d.readOutboxMaxId = Math.max(d.readOutboxMaxId, ev.data.maxId); // BR-STATUS-3 watermark
        break;
      }
      case "dialog.unreadMark": {
        const d = await this.ensureDialog(ev.data.peerId);
        d.unreadMark = ev.data.marked;
        break;
      }
      case "dialog.pinned":
        for (const id of ev.data.pinnedOrder) await this.ensureDialog(id);
        this.applyPinned(ev.data.pinnedOrder);
        break;
      case "dialog.draft": {
        const d = await this.ensureDialog(ev.data.peerId);
        this.applyDraft(d, ev.data.draft);
        break;
      }
    }
    this.changed();
  }

  private applyPinned(order: number[]): void {
    for (const d of this.dialogs.values()) {
      const i = order.indexOf(d.peer.id);
      d.pinned = i >= 0;
      d.pinOrder = i >= 0 ? i : null;
    }
  }

  private applyDraft(d: ClientDialog, draft: Draft | null): void {
    const prevText = d.draft?.text ?? "";
    d.draft = draft;
    d.activityDate = activityDate(d.topMessage?.date, draft);
    if (draft) d.listed = true;
    // Keep an untouched composer in sync with the server draft (AC-17).
    const peer = d.peer.id;
    const cur = this.composer.get(peer);
    if ((cur === undefined || cur === prevText) && !this.editing.has(peer)) {
      this.composer.set(peer, draft?.text ?? "");
    }
  }

  /** BR-RECV-1..5, BR-SEND-7/8. Also used for H10/H13 responses. */
  private applyNewMessage(msg: Message): void {
    const peer = msg.peerId;
    if (msg.out && msg.clientToken && this.pending.has(msg.clientToken)) {
      this.pending.delete(msg.clientToken); // finalize in place
    }
    const conv = this.convs.get(peer);
    if (conv && !conv.messages.some((m) => m.id === msg.id)) {
      if (!conv.hasNewer) insertSorted(conv.messages, msg);
      // else: newer messages available; the view loads them when scrolling down.
    }
    const d = this.dialogs.get(peer);
    if (d) {
      const prevTop = d.topMessage?.id ?? 0;
      if (!d.topMessage || msg.id >= d.topMessage.id) {
        d.topMessage = msg;
        d.activityDate = activityDate(msg.date, d.draft);
      }
      if (!msg.out && msg.id > prevTop && msg.id > d.readInboxMaxId) d.unreadCount += 1;
      d.listed = true;
    }
    this.changed();
  }

  private patchReplyRefs(peerId: number, fn: (m: Message) => Message | null): void {
    const conv = this.convs.get(peerId);
    if (conv) {
      conv.messages = conv.messages.map((m) => {
        if (!m.replyTo) return m;
        const patched = fn(m);
        return patched ?? m;
      });
    }
  }

  private applyEdited(msg: Message): void {
    const peer = msg.peerId;
    const conv = this.convs.get(peer);
    if (conv) {
      const i = conv.messages.findIndex((m) => m.id === msg.id);
      if (i >= 0) conv.messages[i] = msg; // wholesale replace (BR-EDIT-7)
    }
    const d = this.dialogs.get(peer);
    if (d?.topMessage?.id === msg.id) d.topMessage = msg; // no re-sort: date unchanged (BR-LIST-4)
    // BR-REPLY-7: update rendered reply headers.
    const senderName = msg.forwardedFrom?.name ?? this.senderNameFor(peer, msg.senderId, msg);
    this.patchReplyRefs(peer, (m) =>
      m.replyTo && m.replyTo.id === msg.id && !m.replyTo.deleted
        ? { ...m, replyTo: { ...m.replyTo, senderName, snippet: previewText(msg.text) } }
        : null,
    );
    for (const p of this.pending.values()) {
      if (p.replyTo && p.replyTo.id === msg.id && !p.replyTo.deleted) {
        p.replyTo = { ...p.replyTo, snippet: previewText(msg.text) };
      }
    }
    this.changed();
  }

  /** BR-DEL-6 / BR-DEL-7 / BR-REPLY-2 / BR-REPLY-7 */
  private applyDeleted(peerId: number, ids: number[]): void {
    const set = new Set(ids);
    const d = this.dialogs.get(peerId);
    const conv = this.convs.get(peerId);
    let needsRefresh = false;
    if (conv) {
      const removed = conv.messages.filter((m) => set.has(m.id));
      conv.messages = conv.messages.filter((m) => !set.has(m.id));
      if (d) {
        const unreadRemoved = removed.filter((m) => !m.out && m.id > d.readInboxMaxId).length;
        d.unreadCount = Math.max(0, d.unreadCount - unreadRemoved);
      }
      const loadedIds = new Set(removed.map((m) => m.id));
      if (d && ids.some((id) => !loadedIds.has(id) && id > d.readInboxMaxId)) needsRefresh = true;
      if (conv.highlightId != null && set.has(conv.highlightId)) conv.highlightId = null;
    } else if (d && ids.some((id) => id > d.readInboxMaxId)) {
      needsRefresh = true;
    }
    this.patchReplyRefs(peerId, (m) =>
      m.replyTo && set.has(m.replyTo.id) && !m.replyTo.deleted ? { ...m, replyTo: { id: m.replyTo.id, deleted: true } } : null,
    );
    for (const p of this.pending.values()) {
      if (p.peerId === peerId && p.replyTo && set.has(p.replyTo.id)) p.replyTo = { id: p.replyTo.id, deleted: true };
    }
    const strip = this.replyTo.get(peerId);
    if (strip != null && set.has(strip)) this.replyTo.delete(peerId);
    const ed = this.editing.get(peerId);
    if (ed && set.has(ed.messageId)) {
      this.composer.set(peerId, ed.savedComposer);
      this.editing.delete(peerId);
      this.notice(copy.editMissingNotice);
    }
    const sel = this.selection.get(peerId);
    if (sel) for (const id of ids) sel.delete(id);
    if (d && d.topMessage && set.has(d.topMessage.id)) {
      // BR-LIST-5: newest remaining visible message becomes top.
      const last = conv && !conv.hasNewer ? conv.messages[conv.messages.length - 1] : undefined;
      d.topMessage = last ?? null;
      d.activityDate = activityDate(d.topMessage?.date, d.draft);
      needsRefresh = true;
    }
    if (needsRefresh) void this.fetchDialog(peerId);
    this.changed();
  }

  // ================================================================= conversation view

  /** Merged confirmed + pending timeline of a conversation (BR-SEND-5). */
  timeline(peerId: number): TimelineItem[] {
    const conv = this.convs.get(peerId);
    const d = this.dialogs.get(peerId);
    const pend = this.pendingFor(peerId);
    // Pending messages are shown at the newest end only when that end is loaded.
    const shownPending = conv && conv.hasNewer ? [] : pend;
    return buildTimeline(conv?.messages ?? [], shownPending, d?.readOutboxMaxId ?? 0);
  }

  findMessage(peerId: number, id: number): Message | undefined {
    return this.convs.get(peerId)?.messages.find((m) => m.id === id) ?? (this.dialogs.get(peerId)?.topMessage?.id === id ? this.dialogs.get(peerId)!.topMessage! : undefined);
  }

  private requestScroll(conv: ConvState, to: NonNullable<ConvState["scroll"]>["to"]): void {
    conv.scroll = { nonce: ++this.scrollNonce, to };
  }

  /** Opens a conversation (BR-HIST-4, BR-LIST-12, BR-READ-5). */
  async openConversation(peerId: number, viewportHeight = 600): Promise<void> {
    if (this.openPeerId != null && this.openPeerId !== peerId) this.leaveConversation(this.openPeerId);
    if (this.openPeerId === peerId) {
      // BR-HIST-6: re-selecting the open conversation acts like go-to-bottom.
      await this.goToBottom(peerId, null);
      return;
    }
    this.openPeerId = peerId;
    this.changed();
    const d = await this.ensureDialog(peerId);
    if (!this.composer.has(peerId)) this.composer.set(peerId, d.draft?.text ?? "");
    const cached = this.convs.get(peerId);
    if (cached && cached.status === "ready") {
      // BR-HIST-3 / OD-15: reuse the cache and the saved scroll position.
      cached.dividerBeforeId = dividerBeforeId(cached.messages, d.readInboxMaxId, !cached.hasNewer);
      cached.firstUnreadAtOpen = firstUnreadId(cached.messages, d.readInboxMaxId);
      if (this.scrollMemory.has(peerId)) this.requestScroll(cached, "saved");
      else if (cached.dividerBeforeId != null && openMode(d) === "around") {
        this.requestScroll(cached, { id: cached.dividerBeforeId, align: "top" });
      } else this.requestScroll(cached, "bottom");
      this.changed();
    } else {
      await this.loadInitial(peerId, viewportHeight);
    }
    await this.afterOpen(peerId);
  }

  private async afterOpen(peerId: number): Promise<void> {
    const d = this.dialogs.get(peerId);
    const conv = this.convs.get(peerId);
    if (!d || !conv || conv.status !== "ready") return;
    if (d.unreadMark) void this.track(this.setUnreadMark(peerId, false)); // BR-LIST-12
    // BR-READ-5
    if (!conv.hasNewer && conv.messages.length > 0) {
      const waiting = conv.messages.some((m) => !m.out && m.id > d.readInboxMaxId);
      const newest = conv.messages[conv.messages.length - 1].id;
      if (!waiting && d.unreadCount > 0 && newest > d.readInboxMaxId) {
        const rs = this.readStateFor(peerId);
        rs.seenMax = Math.max(rs.seenMax, newest);
        this.maybeRead(peerId);
      }
    }
  }

  private newConv(peerId: number): ConvState {
    return {
      peerId,
      messages: [],
      hasOlder: false,
      hasNewer: false,
      status: "loading",
      loadingOlder: false,
      loadingNewer: false,
      error: null,
      dividerBeforeId: null,
      firstUnreadAtOpen: null,
      highlightId: null,
      jumpStack: [],
      scroll: null,
    };
  }

  private async loadInitial(peerId: number, viewportHeight: number): Promise<void> {
    const conv = this.convs.get(peerId) ?? this.newConv(peerId);
    conv.status = "loading";
    conv.error = null;
    this.convs.set(peerId, conv);
    this.changed();
    const d = this.dialogs.get(peerId);
    const mode = d ? openMode(d) : "bottom";
    const cursor = d?.readInboxMaxId ?? 0;
    try {
      const path =
        mode === "around"
          ? `/api/dialogs/${peerId}/messages?around=${cursor}&limit=40`
          : `/api/dialogs/${peerId}/messages?limit=${firstPageSize(viewportHeight)}`;
      const r = await this.call<{ messages: Message[]; hasOlder: boolean; hasNewer: boolean }>("GET", path);
      conv.messages = [...r.messages].reverse();
      conv.hasOlder = r.hasOlder;
      conv.hasNewer = r.hasNewer;
      conv.status = "ready";
      conv.dividerBeforeId = dividerBeforeId(conv.messages, cursor, !conv.hasNewer);
      conv.firstUnreadAtOpen = firstUnreadId(conv.messages, cursor);
      if (mode === "around" && conv.dividerBeforeId != null) {
        this.requestScroll(conv, { id: conv.dividerBeforeId, align: "top" });
      } else {
        this.requestScroll(conv, "bottom");
      }
    } catch (e) {
      conv.status = "error";
      conv.error = { dir: "initial", message: copy.loadFailed };
    }
    this.changed();
  }

  /** Remember where the user was (OD-15); `atBottom` discards the memory. */
  saveScroll(peerId: number, pos: { anchorId: number; offset: number } | null): void {
    if (pos) this.scrollMemory.set(peerId, pos);
    else this.scrollMemory.delete(peerId);
  }

  leaveConversation(peerId: number): void {
    // OD-3: save the draft when leaving.
    void this.track(this.flushDraft(peerId));
    this.replyTo.delete(peerId);
    this.selection.delete(peerId);
    const conv = this.convs.get(peerId);
    if (conv) {
      conv.dividerBeforeId = null; // BR-HIST-5: divider lives until the conversation is closed
      conv.jumpStack = [];
      conv.highlightId = null;
    }
    if (this.openPeerId === peerId) this.openPeerId = null;
    this.changed();
  }

  closeConversation(): void {
    if (this.openPeerId != null) this.leaveConversation(this.openPeerId);
  }

  /** BR-HIST-2: page older. */
  async loadOlder(peerId: number): Promise<void> {
    const conv = this.convs.get(peerId);
    if (!conv || conv.loadingOlder || !conv.hasOlder || conv.messages.length === 0) return;
    conv.loadingOlder = true;
    conv.error = null;
    this.changed();
    try {
      const r = await this.call<{ messages: Message[]; hasOlder: boolean }>(
        "GET",
        `/api/dialogs/${peerId}/messages?before=${conv.messages[0].id}&limit=${this.cfg.olderPageSize}`,
      );
      const have = new Set(conv.messages.map((m) => m.id));
      conv.messages = [...r.messages.filter((m) => !have.has(m.id)).reverse(), ...conv.messages];
      conv.hasOlder = r.hasOlder;
    } catch {
      conv.error = { dir: "older", message: copy.loadFailed };
    } finally {
      conv.loadingOlder = false;
      this.changed();
    }
  }

  /** BR-HIST-2: page newer. */
  async loadNewer(peerId: number): Promise<void> {
    const conv = this.convs.get(peerId);
    if (!conv || conv.loadingNewer || !conv.hasNewer || conv.messages.length === 0) return;
    conv.loadingNewer = true;
    conv.error = null;
    this.changed();
    try {
      const r = await this.call<{ messages: Message[]; hasNewer: boolean }>(
        "GET",
        `/api/dialogs/${peerId}/messages?after=${conv.messages[conv.messages.length - 1].id}&limit=${this.cfg.olderPageSize}`,
      );
      const have = new Set(conv.messages.map((m) => m.id));
      conv.messages = [...conv.messages, ...r.messages.filter((m) => !have.has(m.id)).reverse()];
      conv.hasNewer = r.hasNewer;
    } catch {
      conv.error = { dir: "newer", message: copy.loadFailed };
    } finally {
      conv.loadingNewer = false;
      this.changed();
    }
  }

  /** BR-HIST-7: retry whichever load failed. */
  async retryLoad(peerId: number): Promise<void> {
    const conv = this.convs.get(peerId);
    if (!conv?.error) return;
    const dir = conv.error.dir;
    conv.error = null;
    if (dir === "initial") await this.loadInitial(peerId, 600);
    else if (dir === "older") await this.loadOlder(peerId);
    else await this.loadNewer(peerId);
  }

  /** Replace the loaded range with the newest page. */
  private async loadNewest(peerId: number): Promise<void> {
    const conv = this.convs.get(peerId) ?? this.newConv(peerId);
    this.convs.set(peerId, conv);
    const r = await this.call<{ messages: Message[]; hasOlder: boolean; hasNewer: boolean }>(
      "GET",
      `/api/dialogs/${peerId}/messages?limit=40`,
    );
    conv.messages = [...r.messages].reverse();
    conv.hasOlder = r.hasOlder;
    conv.hasNewer = r.hasNewer;
    conv.status = "ready";
  }

  /** BR-HIST-6 / BR-REPLY-8: go-to-bottom control. `lastVisibleId` = newest message id on screen. */
  async goToBottom(peerId: number, lastVisibleId: number | null): Promise<void> {
    const conv = this.convs.get(peerId);
    const d = this.dialogs.get(peerId);
    if (!conv || !d) return;
    const firstUnread = firstUnreadId(conv.messages, d.readInboxMaxId);
    const { target, popped } = goToBottomTarget({ jumpStack: conv.jumpStack, firstUnread, lastVisibleId });
    if (popped) conv.jumpStack.pop();
    if (target === "end") {
      if (conv.hasNewer) {
        try {
          await this.loadNewest(peerId);
        } catch {
          this.notice(copy.loadFailed);
        }
      }
      this.requestScroll(conv, "bottom");
    } else {
      if (!conv.messages.some((m) => m.id === target)) {
        // The return point was unloaded by the jump: load the range around it first.
        try {
          const r = await this.call<{ messages: Message[]; hasOlder: boolean; hasNewer: boolean }>(
            "GET",
            `/api/dialogs/${peerId}/messages?around=${target}&limit=40`,
          );
          conv.messages = [...r.messages].reverse();
          conv.hasOlder = r.hasOlder;
          conv.hasNewer = r.hasNewer;
        } catch {
          this.notice(copy.loadFailed);
          return;
        }
      }
      this.requestScroll(conv, { id: target, align: popped ? "center" : "top" });
    }
    this.changed();
  }

  /** BR-REPLY-8: jump to the replied-to message; `fromId` is the current position for the back stack. */
  async jumpToMessage(peerId: number, targetId: number, fromId: number | null, deleted = false): Promise<void> {
    const conv = this.convs.get(peerId);
    if (!conv) return;
    if (deleted) {
      this.notice(copy.originalGoneNotice);
      return;
    }
    if (!conv.messages.some((m) => m.id === targetId)) {
      try {
        const r = await this.call<{ messages: Message[]; hasOlder: boolean; hasNewer: boolean }>(
          "GET",
          `/api/dialogs/${peerId}/messages?around=${targetId}&limit=40`,
        );
        if (!r.messages.some((m) => m.id === targetId)) {
          this.notice(copy.originalGoneNotice);
          return;
        }
        conv.messages = [...r.messages].reverse();
        conv.hasOlder = r.hasOlder;
        conv.hasNewer = r.hasNewer;
      } catch (e) {
        this.notice(e instanceof ApiFailure && e.code === "MESSAGE_NOT_FOUND" ? copy.originalGoneNotice : copy.loadFailed);
        return;
      }
    }
    if (fromId != null) conv.jumpStack.push(fromId);
    conv.highlightId = targetId;
    this.requestScroll(conv, { id: targetId, align: "center" });
    this.changed();
  }

  clearHighlight(peerId: number): void {
    const conv = this.convs.get(peerId);
    if (conv && conv.highlightId != null) {
      conv.highlightId = null;
      this.changed();
    }
  }

  // ================================================================= composer & drafts

  setComposerText(peerId: number, text: string): void {
    this.composer.set(peerId, text);
    this.changed();
    if (this.editing.has(peerId)) return;
    if (!isBlank(text)) this.maybeSendTyping(peerId);
    if (peerKind(peerId) === "secret") return; // secret drafts never leave the device
    // OD-3: save the draft after a pause in typing.
    const t = this.draftTimers.get(peerId);
    if (t) clearTimeout(t);
    this.draftTimers.set(
      peerId,
      setTimeout(() => {
        this.draftTimers.delete(peerId);
        void this.track(this.flushDraft(peerId));
      }, this.cfg.draftSaveDelayMs),
    );
  }

  async flushDraft(peerId: number): Promise<void> {
    const t = this.draftTimers.get(peerId);
    if (t) clearTimeout(t);
    this.draftTimers.delete(peerId);
    if (peerKind(peerId) === "secret") return;
    const ed = this.editing.get(peerId);
    const text = ed ? ed.savedComposer : (this.composer.get(peerId) ?? "");
    const d = this.dialogs.get(peerId);
    const current = d?.draft?.text ?? "";
    const normalized = isBlank(text) ? "" : text;
    if (normalized === current) return;
    if (normalized.length > this.cfg.maxTextLen) return;
    try {
      const r = await this.call<{ draft: Draft | null }>("PUT", `/api/dialogs/${peerId}/draft`, { text: normalized });
      const dd = this.dialogs.get(peerId);
      if (dd) {
        dd.draft = r.draft;
        dd.activityDate = activityDate(dd.topMessage?.date, r.draft);
        if (r.draft) dd.listed = true;
      }
      this.changed();
    } catch {
      /* retried on the next pause */
    }
  }

  setReply(peerId: number, messageId: number | null): void {
    if (messageId == null) this.replyTo.delete(peerId);
    else {
      const m = this.findMessage(peerId, messageId);
      if (!m) return; // only confirmed messages (BR-SEND-13)
      this.editing.delete(peerId);
      this.replyTo.set(peerId, messageId);
    }
    this.changed();
  }

  private replyPreviewFor(peerId: number, id: number): Message["replyTo"] {
    const m = this.findMessage(peerId, id);
    if (!m) return { id, deleted: true };
    const d = this.dialogs.get(peerId);
    const senderName = m.forwardedFrom?.name ?? this.senderNameFor(peerId, m.senderId, m);
    return { id, deleted: false, senderId: m.senderId, senderName, snippet: previewText(m.text) };
  }

  // ================================================================= sending (BR-SEND)

  /** Sends the composer content (or `text`) to a conversation. Returns created pending tokens. */
  send(peerId: number, textArg?: string): string[] {
    const text = textArg ?? this.composer.get(peerId) ?? "";
    if (isBlank(text)) return []; // BR-SEND-1
    const replyId = this.replyTo.get(peerId) ?? null;
    const chunks = splitText(text, this.cfg.maxTextLen); // BR-SEND-2
    const tokens: string[] = [];
    chunks.forEach((chunk, i) => {
      const p = this.createPending(peerId, chunk, i === 0 ? replyId : null);
      tokens.push(p.token);
      this.enqueueSend(peerId, () => this.runSend(p.token));
    });
    // BR-REPLY-3, BR-SEND-12: clear strip, composer and local draft immediately.
    this.replyTo.delete(peerId);
    if (textArg === undefined) this.composer.set(peerId, "");
    const t = this.draftTimers.get(peerId);
    if (t) clearTimeout(t);
    this.draftTimers.delete(peerId);
    const d = this.dialogs.get(peerId);
    if (d && d.draft) {
      d.draft = null;
      d.activityDate = activityDate(d.topMessage?.date, null);
    }
    const conv = this.convs.get(peerId);
    if (conv) {
      conv.dividerBeforeId = null; // BR-HIST-5
      conv.jumpStack = [];
      this.requestScroll(conv, "bottom");
      if (conv.hasNewer) void this.track(this.loadNewest(peerId).then(() => this.changed()).catch(() => undefined));
    }
    this.changed();
    return tokens;
  }

  private maxKnownId(peerId: number): number {
    const conv = this.convs.get(peerId);
    const d = this.dialogs.get(peerId);
    const convMax = conv && conv.messages.length ? conv.messages[conv.messages.length - 1].id : 0;
    return Math.max(convMax, d?.topMessage?.id ?? 0);
  }

  private createPending(
    peerId: number,
    text: string,
    replyToId: number | null,
    extra: Partial<Pick<PendingMessage, "forwardedFrom" | "batch" | "replyTo">> = {},
  ): PendingMessage {
    const p: PendingMessage = {
      token: uuidV4(),
      peerId,
      text,
      date: this.serverNow(),
      replyToId,
      replyTo: extra.replyTo !== undefined ? extra.replyTo : replyToId != null ? this.replyPreviewFor(peerId, replyToId) : null,
      forwardedFrom: extra.forwardedFrom ?? null,
      state: "sending",
      error: null,
      afterId: this.maxKnownId(peerId),
      order: ++this.pendingOrder,
      batch: extra.batch ?? null,
    };
    this.pending.set(p.token, p);
    const d = this.dialogs.get(peerId);
    if (d) d.listed = true;
    return p;
  }

  /** BR-SEND-6: one in-flight send per conversation. */
  private enqueueSend(peerId: number, job: () => Promise<void>): Promise<void> {
    const prev = this.sendQueues.get(peerId) ?? Promise.resolve();
    const next = prev.then(job, job).catch(() => undefined);
    this.sendQueues.set(peerId, next);
    return this.track(next);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private async runSend(token: string): Promise<void> {
    let attempts = 0;
    for (;;) {
      const p = this.pending.get(token);
      if (!p || p.state !== "sending") return;
      try {
        const r = await this.call<{ message: Message; duplicate: boolean }>("POST", `/api/dialogs/${p.peerId}/messages`, {
          clientToken: p.token,
          text: await this.outgoingText(p.peerId, p.text),
          replyToId: p.replyToId ?? undefined,
          clearDraft: true,
        });
        this.applyNewMessage(r.message); // first of response/push wins (BR-SEND-7)
        return;
      } catch (e) {
        if (!this.pending.has(token)) return;
        const err = e instanceof ApiFailure ? e : new ApiFailure(0, "NETWORK", "Network error", true);
        // BR-SEND-11 / OD-5: auto-retry network failures; honour 429.
        if (err.network && attempts < this.cfg.sendRetryDelaysMs.length) {
          await this.sleep(this.cfg.sendRetryDelaysMs[attempts++]);
          continue;
        }
        if (err.status === 429 && attempts < this.cfg.sendRetryDelaysMs.length) {
          attempts++;
          await this.sleep(err.retryAfterMs ?? 1000);
          continue;
        }
        p.state = "failed"; // BR-SEND-9
        p.error = { code: err.code, message: err.message };
        this.changed();
        return;
      }
    }
  }

  /** BR-SEND-10 retry with the same clientToken. */
  retryPending(token: string): void {
    const p = this.pending.get(token);
    if (!p || p.state !== "failed") return;
    if (p.batch) {
      const batchId = p.batch.id;
      const items = [...this.pending.values()].filter((x) => x.batch?.id === batchId);
      for (const x of items) {
        x.state = "sending";
        x.error = null;
      }
      this.enqueueSend(p.peerId, () => this.runForwardBatch(batchId));
    } else {
      if (p.error?.code === "REPLY_TARGET_INVALID") {
        // EC-24: retry without the reply.
        p.replyToId = null;
        p.replyTo = null;
      }
      p.state = "sending";
      p.error = null;
      this.enqueueSend(p.peerId, () => this.runSend(token));
    }
    this.changed();
  }

  /** BR-SEND-10 discard (removes locally; dialog preview recomputes). */
  discardPending(token: string): void {
    const p = this.pending.get(token);
    if (!p || p.state !== "failed") return;
    if (p.batch) {
      const id = p.batch.id;
      for (const x of [...this.pending.values()]) if (x.batch?.id === id) this.pending.delete(x.token);
    } else this.pending.delete(token);
    this.changed();
  }

  // ================================================================= read tracking (BR-READ)

  private readStateFor(peerId: number) {
    let rs = this.readState.get(peerId);
    if (!rs) {
      rs = { seenMax: 0, inFlight: false, again: false };
      this.readState.set(peerId, rs);
    }
    return rs;
  }

  /** BR-READ-1: the view reports incoming message ids currently intersecting the viewport. */
  reportSeen(peerId: number, ids: number[]): void {
    if (ids.length === 0) return;
    const rs = this.readStateFor(peerId);
    rs.seenMax = Math.max(rs.seenMax, ...ids);
    this.maybeRead(peerId);
  }

  /** BR-READ-2 focus gate. */
  setFocusGate(open: boolean): void {
    if (this.focusGateOpen === open) return;
    this.focusGateOpen = open;
    if (open && this.openPeerId != null) this.maybeRead(this.openPeerId);
  }

  /** BR-READ-3/4/10 */
  maybeRead(peerId: number): void {
    if (!this.focusGateOpen) return;
    const rs = this.readStateFor(peerId);
    if (rs.inFlight) {
      rs.again = true;
      return;
    }
    const d = this.dialogs.get(peerId);
    if (!d) return;
    let maxId = rs.seenMax;
    const conv = this.convs.get(peerId);
    if (conv && !conv.hasNewer && conv.messages.length) {
      let newestIncoming = 0;
      for (const m of conv.messages) if (!m.out) newestIncoming = Math.max(newestIncoming, m.id);
      const newest = conv.messages[conv.messages.length - 1].id;
      if (maxId > 0 && maxId >= newestIncoming) maxId = Math.max(maxId, newest);
    }
    if (maxId <= d.readInboxMaxId) return;
    void this.track(this.sendRead(peerId, maxId));
  }

  private recountUnread(d: ClientDialog, conv: ConvState | undefined, prevCursor: number, newCursor: number): void {
    if (conv && !conv.hasNewer && (conv.messages.length === 0 || !conv.hasOlder || conv.messages[0].id <= prevCursor + 1)) {
      d.unreadCount = conv.messages.filter((m) => !m.out && m.id > newCursor).length;
    } else if (conv) {
      const nowRead = conv.messages.filter((m) => !m.out && m.id > prevCursor && m.id <= newCursor).length;
      d.unreadCount = Math.max(0, d.unreadCount - nowRead);
    }
  }

  private async sendRead(peerId: number, maxId: number): Promise<void> {
    const rs = this.readStateFor(peerId);
    const d = this.dialogs.get(peerId);
    if (!d) return;
    rs.inFlight = true;
    const prevCursor = d.readInboxMaxId;
    const prevCount = d.unreadCount;
    // BR-READ-6 optimistic apply.
    d.readInboxMaxId = maxId;
    this.recountUnread(d, this.convs.get(peerId), prevCursor, maxId);
    this.changed();
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try {
        const r = await this.call<{ readInboxMaxId: number; unreadCount: number }>("POST", `/api/dialogs/${peerId}/read`, {
          maxId,
        });
        const cur = this.dialogs.get(peerId);
        if (cur) {
          cur.readInboxMaxId = Math.max(cur.readInboxMaxId, r.readInboxMaxId);
          cur.unreadCount = r.unreadCount;
        }
        ok = true;
      } catch {
        /* BR-READ-7: one immediate retry */
      }
    }
    if (!ok) {
      const cur = this.dialogs.get(peerId);
      if (cur && cur.readInboxMaxId === maxId) {
        cur.readInboxMaxId = prevCursor; // so the next trigger retries
        cur.unreadCount = prevCount;
      }
    }
    rs.inFlight = false;
    this.changed();
    if (rs.again) {
      rs.again = false;
      this.maybeRead(peerId);
    }
  }

  // ================================================================= dialog actions

  /** BR-LIST-11 */
  async markAsRead(peerId: number): Promise<void> {
    const d = this.dialogs.get(peerId);
    if (!d) return;
    if (d.unreadCount > 0 && d.topMessage) {
      const rs = this.readStateFor(peerId);
      rs.seenMax = Math.max(rs.seenMax, d.topMessage.id);
      if (rs.inFlight) rs.again = true;
      else await this.sendRead(peerId, Math.max(d.topMessage.id, d.readInboxMaxId + 1));
    }
    if (d.unreadMark) await this.setUnreadMark(peerId, false);
  }

  async setUnreadMark(peerId: number, marked: boolean): Promise<void> {
    await this.call("PUT", `/api/dialogs/${peerId}/unread-mark`, { marked });
    const d = this.dialogs.get(peerId);
    if (d) d.unreadMark = marked;
    this.changed();
  }

  async setPinned(peerId: number, pinned: boolean): Promise<void> {
    try {
      const r = await this.call<{ pinnedOrder: number[] }>("PUT", `/api/dialogs/${peerId}/pin`, { pinned });
      this.applyPinned(r.pinnedOrder);
      this.changed();
    } catch (e) {
      if (e instanceof ApiFailure && e.code === "PIN_LIMIT") this.notice(e.message);
      else this.notice(copy.loadFailed);
    }
  }

  async reorderPinned(order: number[]): Promise<void> {
    const r = await this.call<{ pinnedOrder: number[] }>("PUT", "/api/dialogs/pinned-order", { order });
    this.applyPinned(r.pinnedOrder);
    this.changed();
  }

  // ================================================================= reactions

  /** Sets (or with null clears) my reaction; tapping my current reaction again clears it. */
  async react(peerId: number, messageId: number, emoji: string | null): Promise<void> {
    try {
      const r = await this.call<{ reactions: Reaction[] }>("PUT", `/api/messages/${messageId}/reaction`, { emoji });
      this.applyReactions(peerId, messageId, r.reactions);
      this.changed();
    } catch (e) {
      this.notice(e instanceof ApiFailure ? e.message : copy.loadFailed);
    }
  }

  // ================================================================= profile & account

  async updateProfile(displayName: string): Promise<void> {
    const r = await this.call<{ user: UserSummary }>("PATCH", "/api/me", { displayName });
    this.me = r.user;
    this.changed();
  }

  async updateEmail(email: string): Promise<void> {
    const r = await this.call<{ email: string }>("PUT", "/api/me/email", { email });
    this.myEmail = r.email;
    this.changed();
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await this.call("POST", "/api/me/password", { currentPassword, newPassword });
  }

  async deleteAccount(password: string): Promise<void> {
    await this.call("POST", "/api/me/delete", { password });
    this.signedOut();
  }

  // ================================================================= blocking

  async setBlocked(peerId: number, blocked: boolean): Promise<void> {
    const userId = this.peerUserId(peerId);
    if (userId == null) return;
    try {
      await this.call("PUT", `/api/users/${userId}/block`, { blocked });
      for (const d of this.dialogs.values()) if (this.peerUserId(d.peer.id) === userId) d.blocked = blocked;
      this.changed();
    } catch (e) {
      this.notice(e instanceof ApiFailure ? e.message : copy.loadFailed);
    }
  }

  // ================================================================= groups

  /** Creates a group and opens it. Throws ApiFailure on validation errors. */
  async createGroup(title: string, userIds: number[]): Promise<number> {
    const r = await this.call<{ peerId: number }>("POST", "/api/groups", { title, userIds });
    await this.fetchDialog(r.peerId);
    await this.openConversation(r.peerId);
    return r.peerId;
  }

  async renameGroup(peerId: number, title: string): Promise<void> {
    await this.call("PATCH", `/api/groups/${peerId}`, { title });
  }

  async addMembers(peerId: number, userIds: number[]): Promise<void> {
    await this.call("POST", `/api/groups/${peerId}/members`, { userIds });
  }

  async removeMember(peerId: number, userId: number): Promise<void> {
    await this.call("POST", `/api/groups/${peerId}/members/${userId}/remove`, {});
  }

  async leaveGroup(peerId: number): Promise<void> {
    if (!this.me) return;
    this.leaving.add(peerId);
    try {
      await this.call("POST", `/api/groups/${peerId}/members/${this.me.id}/remove`, {});
    } catch (e) {
      this.leaving.delete(peerId);
      throw e;
    }
  }

  // ================================================================= secret chats

  /** Starts a secret chat with a user from this device and opens it. */
  async startSecretChat(userId: number): Promise<number | null> {
    await this.keysReady;
    if (!this.devicePublicKey) {
      this.notice(copy.secretUnsupported);
      return null;
    }
    try {
      const r = await this.call<{ peerId: number }>("POST", "/api/secret-chats", { userId, publicKey: this.devicePublicKey });
      await this.fetchDialog(r.peerId);
      await this.openConversation(r.peerId);
      return r.peerId;
    } catch (e) {
      this.notice(e instanceof ApiFailure ? e.message : copy.loadFailed);
      return null;
    }
  }

  async searchUsers(q: string): Promise<UserSummary[]> {
    if (!q.trim()) return [];
    const r = await this.call<{ users: UserSummary[] }>("GET", `/api/users/search?q=${encodeURIComponent(q)}`);
    return r.users;
  }

  // ================================================================= edit (BR-EDIT)

  canEdit(m: Message): boolean {
    return (
      m.out && !m.forwardedFrom && !m.service && !m.undecryptable && m.date >= this.serverNow() - this.cfg.editLimitMs
    );
  }

  startEdit(peerId: number, messageId: number): void {
    const m = this.findMessage(peerId, messageId);
    if (!m || !this.canEdit(m)) return;
    const prev = this.editing.get(peerId);
    const saved = prev ? prev.savedComposer : (this.composer.get(peerId) ?? "");
    this.editing.set(peerId, { messageId, savedComposer: saved, busy: false, error: null });
    this.replyTo.delete(peerId);
    this.composer.set(peerId, m.text);
    this.changed();
  }

  cancelEdit(peerId: number): void {
    const ed = this.editing.get(peerId);
    if (!ed) return;
    this.editing.delete(peerId);
    this.composer.set(peerId, ed.savedComposer);
    this.changed();
  }

  async saveEdit(peerId: number): Promise<void> {
    const ed = this.editing.get(peerId);
    if (!ed || ed.busy) return;
    const text = this.composer.get(peerId) ?? "";
    if (isBlank(text)) {
      ed.error = copy.emptyEditError; // BR-EDIT-4
      this.changed();
      return;
    }
    ed.busy = true;
    ed.error = null;
    this.changed();
    const finish = () => {
      if (this.editing.get(peerId) === ed) {
        this.editing.delete(peerId);
        this.composer.set(peerId, ed.savedComposer);
      }
    };
    try {
      const r = await this.call<{ message: Message }>("PATCH", `/api/messages/${ed.messageId}`, {
        text: await this.outgoingText(peerId, text),
      });
      this.applyEdited(r.message);
      finish();
    } catch (e) {
      const code = e instanceof ApiFailure ? e.code : "NETWORK";
      if (code === "TEXT_UNCHANGED") finish();
      else if (code === "EDIT_TIME_EXPIRED" || code === "EDIT_NOT_ALLOWED") {
        finish();
        this.notice(copy.editExpiredNotice);
      } else if (code === "MESSAGE_NOT_FOUND") {
        finish();
        this.notice(copy.editMissingNotice);
      } else {
        ed.busy = false;
        ed.error = e instanceof ApiFailure ? e.message : copy.loadFailed;
      }
    }
    this.changed();
  }

  // ================================================================= delete (BR-DEL)

  /** Confirmed messages only; applied after the server confirms (BR-DEL-4). Throws on failure. */
  async deleteMessages(peerId: number, ids: number[], forEveryone: boolean): Promise<void> {
    const r = await this.call<{ deletedIds: number[] }>("POST", `/api/dialogs/${peerId}/messages/delete`, {
      ids,
      forEveryone,
    });
    this.applyDeleted(peerId, r.deletedIds);
    this.selection.delete(peerId);
    this.changed();
  }

  // ================================================================= selection (BR-DEL-8)

  toggleSelect(peerId: number, messageId: number): void {
    if (!this.findMessage(peerId, messageId)) return; // pending/failed cannot be selected (AC-70)
    const set = this.selection.get(peerId) ?? new Set<number>();
    if (set.has(messageId)) set.delete(messageId);
    else set.add(messageId);
    this.selection.set(peerId, set);
    this.changed();
  }

  startSelection(peerId: number, messageId?: number): void {
    this.selection.set(peerId, new Set());
    if (messageId != null) this.toggleSelect(peerId, messageId);
    this.changed();
  }

  clearSelection(peerId: number): void {
    this.selection.delete(peerId);
    this.changed();
  }

  // ================================================================= forward (BR-FWD)

  /** BR-FWD-3: one target, no comment -> preview strip in the target conversation. */
  async prepareForward(target: number, draft: ForwardDraft): Promise<void> {
    this.forwardDraft.set(target, draft);
    this.selection.delete(draft.fromPeerId);
    await this.openConversation(target);
    this.changed();
  }

  cancelForwardDraft(peerId: number): void {
    this.forwardDraft.delete(peerId);
    this.changed();
  }

  setForwardHideSender(peerId: number, hide: boolean): void {
    const f = this.forwardDraft.get(peerId);
    if (f) {
      f.hideSender = hide;
      this.changed();
    }
  }

  async sendForwardDraft(peerId: number): Promise<boolean> {
    const f = this.forwardDraft.get(peerId);
    if (!f) return false;
    this.forwardDraft.delete(peerId);
    const comment = this.composer.get(peerId) ?? "";
    const res = await this.forward({ ...f, targets: [peerId], comment: isBlank(comment) ? "" : comment });
    if (!isBlank(comment)) this.composer.set(peerId, "");
    return res.failed.length === 0;
  }

  /**
   * BR-FWD-3..6: forward to each target in sequence (comment first, OD-17).
   * Resolves with per-target success once every target's request settled.
   */
  async forward(opts: {
    fromPeerId: number;
    messageIds: number[];
    targets: number[];
    hideSender: boolean;
    comment?: string;
  }): Promise<{ succeeded: number[]; failed: number[] }> {
    const fromConv = this.convs.get(opts.fromPeerId);
    const sources = opts.messageIds
      .map((id) => fromConv?.messages.find((m) => m.id === id) ?? this.findMessage(opts.fromPeerId, id))
      .filter((m): m is Message => !!m)
      .sort((a, b) => a.id - b.id);
    const succeeded: number[] = [];
    const failed: number[] = [];
    const jobs: Promise<void>[] = [];
    this.selection.delete(opts.fromPeerId);
    for (const target of opts.targets) {
      await this.ensureDialog(target);
      if (opts.comment && !isBlank(opts.comment)) this.send(target, opts.comment);
      const batchId = uuidV4();
      const copies = new Map<number, PendingMessage>();
      for (const src of sources) {
        const fwd = opts.hideSender
          ? null
          : (src.forwardedFrom ?? {
              userId: src.senderId,
              name: this.senderNameFor(opts.fromPeerId, src.senderId, src),
              date: src.date,
            });
        const inBatch = src.replyTo ? copies.get(src.replyTo.id) : undefined;
        const p = this.createPending(target, src.text, null, {
          forwardedFrom: fwd,
          batch: { id: batchId, fromPeerId: opts.fromPeerId, sourceId: src.id, hideSender: opts.hideSender },
          replyTo: inBatch ? { id: -1, deleted: false, senderId: this.me?.id ?? 0, senderName: inBatch.forwardedFrom?.name ?? this.me?.displayName ?? "", snippet: previewText(inBatch.text) } : null,
        });
        copies.set(src.id, p);
      }
      const conv = this.convs.get(target);
      if (conv) this.requestScroll(conv, "bottom");
      this.changed();
      jobs.push(
        this.enqueueSend(target, () => this.runForwardBatch(batchId)).then(() => {
          const anyFailed = [...this.pending.values()].some((x) => x.batch?.id === batchId && x.state === "failed");
          (anyFailed ? failed : succeeded).push(target);
        }),
      );
    }
    await Promise.all(jobs);
    return { succeeded, failed };
  }

  private async runForwardBatch(batchId: string): Promise<void> {
    const items = [...this.pending.values()].filter((x) => x.batch?.id === batchId).sort((a, b) => a.order - b.order);
    if (items.length === 0 || items.some((x) => x.state !== "sending")) return;
    const first = items[0];
    let attempts = 0;
    for (;;) {
      try {
        const r = await this.call<{ messages: Message[] }>("POST", `/api/dialogs/${first.peerId}/forward`, {
          fromPeerId: first.batch!.fromPeerId,
          messageIds: items.map((x) => x.batch!.sourceId),
          clientTokens: items.map((x) => x.token),
          hideSender: first.batch!.hideSender,
        });
        for (const m of r.messages) this.applyNewMessage(m);
        return;
      } catch (e) {
        const err = e instanceof ApiFailure ? e : new ApiFailure(0, "NETWORK", "Network error", true);
        if (!items.some((x) => this.pending.has(x.token))) return;
        if (err.network && attempts < this.cfg.sendRetryDelaysMs.length) {
          await this.sleep(this.cfg.sendRetryDelaysMs[attempts++]);
          continue;
        }
        for (const x of items) {
          // BR-FWD-5: all copies for the target fail together
          x.state = "failed";
          x.error = { code: err.code, message: err.message };
        }
        this.changed();
        return;
      }
    }
  }
}

function insertSorted(list: Message[], msg: Message): void {
  let i = list.length;
  while (i > 0 && list[i - 1].id > msg.id) i--;
  list.splice(i, 0, msg);
}
