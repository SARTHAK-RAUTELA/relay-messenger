// Pure presentation logic (dialog rows, statuses, timeline order, history view decisions).
// Kept framework-free so the rules can be unit tested.

import type { Dialog, ForwardedFrom, Message, ReplyRef } from "../shared/types";
import { previewText } from "../shared/text";
import { activityDate, compareDialogs } from "../shared/dialogOrder";

export type OutStatus = "failed" | "sending" | "sent" | "read";

export interface PendingMessage {
  token: string;
  peerId: number;
  text: string;
  date: number;
  replyToId: number | null;
  replyTo: ReplyRef | null;
  forwardedFrom: ForwardedFrom | null;
  state: "sending" | "failed";
  error: { code: string; message: string } | null;
  /** Highest confirmed id known in the conversation when created (BR-SEND-5). */
  afterId: number;
  /** Creation order among pending messages. */
  order: number;
  batch: { id: string; fromPeerId: number; sourceId: number; hideSender: boolean } | null;
}

export interface ClientDialog extends Dialog {
  /** The conversation has (had) messages, so it belongs in the list (BR-LIST-14). */
  listed: boolean;
}

/** BR-STATUS-1 for a confirmed outgoing message. */
export function confirmedStatus(message: Message, readOutboxMaxId: number): OutStatus | null {
  if (!message.out) return null; // BR-STATUS-2
  return message.id <= readOutboxMaxId ? "read" : "sent";
}

export function pendingStatus(p: PendingMessage): OutStatus {
  return p.state === "failed" ? "failed" : "sending";
}

export type TimelineItem =
  | { kind: "message"; key: string; message: Message; status: OutStatus | null }
  | { kind: "pending"; key: string; pending: PendingMessage; status: OutStatus };

/** BR-SEND-5 merged order of confirmed and pending messages. */
export function buildTimeline(messages: Message[], pending: PendingMessage[], readOutboxMaxId: number): TimelineItem[] {
  type K = { a: number; b: number; c: number; item: TimelineItem };
  const keyed: K[] = [];
  for (const m of messages) {
    keyed.push({
      a: m.id,
      b: 0,
      c: 0,
      item: { kind: "message", key: "m" + m.id, message: m, status: confirmedStatus(m, readOutboxMaxId) },
    });
  }
  for (const p of pending) {
    keyed.push({ a: p.afterId, b: 1, c: p.order, item: { kind: "pending", key: "p" + p.token, pending: p, status: pendingStatus(p) } });
  }
  keyed.sort((x, y) => x.a - y.a || x.b - y.b || x.c - y.c);
  return keyed.map((k) => k.item);
}

export type Badge = { kind: "count"; label: string } | { kind: "mark" } | { kind: "pin" } | null;

/** BR-LIST-10 compact numeric badge. */
export function formatCount(n: number): string {
  if (n <= 999) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return (k < 10 ? Math.floor(k * 10) / 10 : Math.floor(k)).toString().replace(/\.0$/, "") + "K";
  }
  const m = n / 1_000_000;
  return (m < 10 ? Math.floor(m * 10) / 10 : Math.floor(m)).toString().replace(/\.0$/, "") + "M";
}

export function badgeFor(d: { unreadCount: number; unreadMark: boolean; pinned: boolean }): Badge {
  if (d.unreadCount > 0) return { kind: "count", label: formatCount(d.unreadCount) };
  if (d.unreadMark) return { kind: "mark" };
  if (d.pinned) return { kind: "pin" };
  return null;
}

export interface DialogRowModel {
  peerId: number;
  name: string;
  subtitle: { kind: "draft"; text: string } | { kind: "message"; text: string; forwarded: boolean } | { kind: "empty" };
  time: number | null;
  status: OutStatus | null;
  badge: Badge;
  pinned: boolean;
  pinOrder: number | null;
  unreadCount: number;
  unreadMark: boolean;
  activityDate: number;
  topMessageId: number | null;
}

/** BR-LIST-6..10: everything a dialog row shows. `latestPending` is the newest pending message for the peer. */
export function deriveRow(d: Dialog, latestPending: PendingMessage | null): DialogRowModel {
  const top = d.topMessage;
  const draft = d.draft && d.draft.text.trim() !== "" ? d.draft : null;
  const pendingIsNewest = !!latestPending && (!top || latestPending.afterId >= top.id);
  let subtitle: DialogRowModel["subtitle"];
  let status: OutStatus | null = null;
  let act = activityDate(top?.date, draft);
  if (pendingIsNewest) act = Math.max(act, latestPending!.date);
  if (draft) {
    subtitle = { kind: "draft", text: previewText(draft.text) };
  } else if (pendingIsNewest) {
    subtitle = { kind: "message", text: previewText(latestPending!.text), forwarded: !!latestPending!.forwardedFrom };
    status = pendingStatus(latestPending!);
  } else if (top) {
    subtitle = { kind: "message", text: previewText(top.text), forwarded: !!top.forwardedFrom };
    status = confirmedStatus(top, d.readOutboxMaxId);
  } else {
    subtitle = { kind: "empty" };
  }
  return {
    peerId: d.peer.id,
    name: d.peer.displayName,
    subtitle,
    time: subtitle.kind === "empty" ? null : act || null,
    status,
    badge: badgeFor(d),
    pinned: d.pinned,
    pinOrder: d.pinOrder,
    unreadCount: d.unreadCount,
    unreadMark: d.unreadMark,
    activityDate: act,
    topMessageId: top?.id ?? null,
  };
}

export function sortRows(rows: DialogRowModel[]): DialogRowModel[] {
  return [...rows].sort((a, b) => compareDialogs(a, b));
}

/** BR-LIST-8 time label buckets. */
export function formatListTime(ts: number, now: number): string {
  const d = new Date(ts);
  const n = new Date(now);
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const startToday = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  if (ts >= startToday - 6 * 86400_000) return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.toLocaleDateString(undefined, { year: "2-digit", month: "short", day: "numeric" });
}

// ----------------------------------------------------------------- history view decisions

/** BR-HIST-1 / OD-7 */
export function firstPageSize(viewportHeight: number): number {
  return Math.max(10, Math.min(40, Math.ceil(viewportHeight / 40)));
}

/** BR-HIST-4 (b)/(c): open around the cursor when 2+ unread, else at the bottom. */
export function openMode(d: { unreadCount: number }): "around" | "bottom" {
  return d.unreadCount >= 2 ? "around" : "bottom";
}

/** First incoming message after the read cursor. */
export function firstUnreadId(messages: Message[], readInboxMaxId: number): number | null {
  for (const m of messages) if (!m.out && m.id > readInboxMaxId) return m.id;
  return null;
}

/** BR-HIST-5: divider before the first unread incoming message unless it is the newest message. */
export function dividerBeforeId(messages: Message[], readInboxMaxId: number, newestEndLoaded: boolean): number | null {
  const first = firstUnreadId(messages, readInboxMaxId);
  if (first == null) return null;
  const newest = messages.length ? messages[messages.length - 1].id : null;
  if (newestEndLoaded && newest === first) return null;
  return first;
}

/**
 * BR-HIST-6 / BR-REPLY-8: target of the go-to-bottom control.
 * Returns a message id to jump to, or "end".
 */
export function goToBottomTarget(opts: {
  jumpStack: number[];
  firstUnread: number | null;
  lastVisibleId: number | null;
}): { target: number | "end"; popped: boolean } {
  if (opts.jumpStack.length > 0) return { target: opts.jumpStack[opts.jumpStack.length - 1], popped: true };
  if (opts.firstUnread != null && (opts.lastVisibleId == null || opts.firstUnread > opts.lastVisibleId)) {
    return { target: opts.firstUnread, popped: false };
  }
  return { target: "end", popped: false };
}
