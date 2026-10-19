// Wire types shared by the server and the client (spec section 4 / 5.3).

export interface UserSummary {
  id: number;
  username: string;
  displayName: string;
}

/** See src/shared/peer.ts for how peer ids encode the kind. */
export type ChatKind = "user" | "group" | "secret";

export interface Presence {
  online: boolean;
  /** null when unknown or hidden (blocked). */
  lastSeen: number | null;
}

export interface Reaction {
  emoji: string;
  count: number;
  mine: boolean;
}

/** System messages in groups and secret chats; their `text` is empty. */
export type ServiceAction =
  | { type: "groupCreated"; title: string }
  | { type: "membersAdded"; userIds: number[]; names: string[] }
  | { type: "memberRemoved"; userId: number; name: string }
  | { type: "memberLeft" }
  | { type: "groupRenamed"; title: string }
  | { type: "secretStarted" };

export type ReplyRef =
  | { id: number; deleted: true }
  | { id: number; deleted: false; senderId: number; senderName: string; snippet: string };

export interface ForwardedFrom {
  userId: number | null;
  name: string;
  date: number;
}

export interface Message {
  id: number;
  peerId: number;
  senderId: number;
  /** Author's display name (groups and secret chats). */
  senderName?: string;
  out: boolean;
  /** In secret chats this is ciphertext on the wire; the client decrypts it. */
  text: string;
  date: number;
  editDate: number | null;
  replyTo: ReplyRef | null;
  forwardedFrom: ForwardedFrom | null;
  reactions: Reaction[];
  service: ServiceAction | null;
  clientToken?: string;
  /** Client only: the text could not be decrypted on this device. */
  undecryptable?: boolean;
}

export interface Draft {
  text: string;
  date: number;
}

export interface GroupInfo {
  id: number;
  title: string;
  ownerId: number;
  members: UserSummary[];
}

export interface SecretInfo {
  id: number;
  /** The other participant. */
  userId: number;
  initiatorId: number;
  /** Base64 raw P-256 public keys captured when the chat was created. */
  initiatorKey: string;
  responderKey: string;
}

export interface Dialog {
  kind: ChatKind;
  peer: UserSummary;
  topMessage: Message | null;
  unreadCount: number;
  unreadMark: boolean;
  pinned: boolean;
  pinOrder: number | null;
  draft: Draft | null;
  readInboxMaxId: number;
  readOutboxMaxId: number;
  activityDate: number;
  group: GroupInfo | null;
  secret: SecretInfo | null;
  /** I blocked the other person (user and secret chats). */
  blocked: boolean;
  /** The other person's account was deleted. */
  peerDeleted: boolean;
  presence: Presence | null;
}

export type EventPayloads = {
  "message.new": { message: Message };
  "message.edited": { message: Message };
  "messages.deleted": { peerId: number; ids: number[] };
  "message.reactions": { peerId: number; messageId: number; reactions: Reaction[] };
  "reply.updated": { peerId: number; messageIds: number[] };
  "read.inbox": { peerId: number; maxId: number; unreadCount: number };
  "read.outbox": { peerId: number; maxId: number };
  "dialog.unreadMark": { peerId: number; marked: boolean };
  "dialog.pinned": { pinnedOrder: number[] };
  "dialog.draft": { peerId: number; draft: Draft | null };
  "dialog.removed": { peerId: number };
  "group.updated": { peerId: number; group: GroupInfo };
  "peer.updated": { user: UserSummary; deleted: boolean };
  "me.updated": { user: UserSummary };
  "user.blocked": { userId: number; blocked: boolean };
};

export type EventType = keyof EventPayloads;

export type SyncEvent = {
  [K in EventType]: { seq: number; type: K; data: EventPayloads[K] };
}[EventType];

/** Ephemeral frames are not logged and not replayed by /api/sync. */
export type ServerFrame =
  | { kind: "hello"; seq: number; serverTime: number }
  | ({ kind: "event" } & SyncEvent)
  | { kind: "pong" }
  | { kind: "presence"; userId: number; online: boolean; lastSeen: number | null }
  | { kind: "typing"; peerId: number; userId: number };

export type ClientFrame = { kind: "ping" } | { kind: "typing"; peerId: number };

export interface ApiErrorBody {
  error: { code: string; message: string; retryAfterMs?: number };
  seq?: number;
}
