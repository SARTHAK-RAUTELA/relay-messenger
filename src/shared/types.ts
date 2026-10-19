// Wire types shared by the server and the client (spec section 4 / 5.3).

export interface UserSummary {
  id: number;
  username: string;
  displayName: string;
}

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
  out: boolean;
  text: string;
  date: number;
  editDate: number | null;
  replyTo: ReplyRef | null;
  forwardedFrom: ForwardedFrom | null;
  clientToken?: string;
}

export interface Draft {
  text: string;
  date: number;
}

export interface Dialog {
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
}

export type EventPayloads = {
  "message.new": { message: Message };
  "message.edited": { message: Message };
  "messages.deleted": { peerId: number; ids: number[] };
  "reply.updated": { peerId: number; messageIds: number[] };
  "read.inbox": { peerId: number; maxId: number; unreadCount: number };
  "read.outbox": { peerId: number; maxId: number };
  "dialog.unreadMark": { peerId: number; marked: boolean };
  "dialog.pinned": { pinnedOrder: number[] };
  "dialog.draft": { peerId: number; draft: Draft | null };
};

export type EventType = keyof EventPayloads;

export type SyncEvent = {
  [K in EventType]: { seq: number; type: K; data: EventPayloads[K] };
}[EventType];

export type ServerFrame =
  | { kind: "hello"; seq: number; serverTime: number }
  | ({ kind: "event" } & SyncEvent)
  | { kind: "pong" };

export interface ApiErrorBody {
  error: { code: string; message: string; retryAfterMs?: number };
  seq?: number;
}
