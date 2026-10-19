import { describe, expect, it } from "vitest";
import { previewText, splitText, isBlank } from "../../src/shared/text";
import {
  badgeFor,
  buildTimeline,
  deriveRow,
  dividerBeforeId,
  formatCount,
  goToBottomTarget,
  openMode,
  sortRows,
  type PendingMessage,
} from "../../src/client/derive";
import type { Dialog, Message } from "../../src/shared/types";

const msg = (id: number, over: Partial<Message> = {}): Message => ({
  id,
  peerId: 2,
  senderId: over.out ? 1 : 2,
  out: false,
  text: "m" + id,
  date: id * 1000,
  editDate: null,
  replyTo: null,
  forwardedFrom: null,
  ...over,
});
const dialog = (peer: number, over: Partial<Dialog> = {}): Dialog => ({
  peer: { id: peer, username: "u" + peer, displayName: "U" + peer },
  topMessage: null,
  unreadCount: 0,
  unreadMark: false,
  pinned: false,
  pinOrder: null,
  draft: null,
  readInboxMaxId: 0,
  readOutboxMaxId: 0,
  activityDate: 0,
  ...over,
});
const pending = (over: Partial<PendingMessage> = {}): PendingMessage => ({
  token: "t",
  peerId: 2,
  text: "p",
  date: 99_000,
  replyToId: null,
  replyTo: null,
  forwardedFrom: null,
  state: "sending",
  error: null,
  afterId: 0,
  order: 1,
  batch: null,
  ...over,
});

describe("text rules", () => {
  it("AC-32: >110 chars -> first 100 + ellipsis, one line", () => {
    const long = "word ".repeat(30) + "\nnext line";
    const p = previewText(long);
    expect(p.length).toBe(101);
    expect(p.endsWith("…")).toBe(true);
    expect(p).not.toContain("\n");
    expect(previewText("a\nb")).toBe("a b");
    expect(previewText("x".repeat(110))).toBe("x".repeat(110));
  });
  it("AC-16 / BR-SEND-2: split into ordered chunks of max length", () => {
    expect(splitText("a".repeat(9), 4)).toEqual(["aaaa", "aaaa", "a"]);
    expect(splitText("ok", 4)).toEqual(["ok"]);
  });
  it("BR-SEND-1: blank detection", () => {
    expect(isBlank(" \n\t")).toBe(true);
    expect(isBlank(" a ")).toBe(false);
  });
});

describe("row derivation (BR-LIST)", () => {
  it("AC-29: pinned first, then activity desc", () => {
    const rows = [
      deriveRow(dialog(1, { topMessage: msg(1, { date: 10_00 }) }), null),
      deriveRow(dialog(2, { topMessage: msg(2, { date: 10_05 }) }), null),
      deriveRow(dialog(3, { pinned: true, pinOrder: 0, topMessage: msg(3, { date: 9_00 }) }), null),
    ];
    expect(sortRows(rows).map((r) => r.peerId)).toEqual([3, 2, 1]);
  });
  it("AC-31: draft wins subtitle, no status, lifts activity", () => {
    const r = deriveRow(dialog(2, { topMessage: msg(5, { out: true }), draft: { text: "half", date: 999_999 } }), null);
    expect(r.subtitle).toEqual({ kind: "draft", text: "half" });
    expect(r.status).toBeNull();
    expect(r.activityDate).toBe(999_999);
  });
  it("AC-34 / AC-10: pending newest -> its text and sending/failed status", () => {
    const d = dialog(2, { topMessage: msg(5) });
    expect(deriveRow(d, pending({ afterId: 5, state: "failed" })).status).toBe("failed");
    expect(deriveRow(d, pending({ afterId: 5 }))).toMatchObject({ status: "sending", subtitle: { text: "p" } });
  });
  it("BR-LIST-10: badge precedence and compact count", () => {
    expect(badgeFor({ unreadCount: 3, unreadMark: true, pinned: true })).toEqual({ kind: "count", label: "3" });
    expect(badgeFor({ unreadCount: 0, unreadMark: true, pinned: true })).toEqual({ kind: "mark" });
    expect(badgeFor({ unreadCount: 0, unreadMark: false, pinned: true })).toEqual({ kind: "pin" });
    expect(formatCount(1500)).toBe("1.5K");
    expect(formatCount(1000)).toBe("1K");
    expect(formatCount(999)).toBe("999");
  });
  it("AC-27/AC-28: statuses from watermark; incoming has none", () => {
    const tl = buildTimeline([msg(1), msg(2, { out: true }), msg(3, { out: true })], [pending({ afterId: 3 })], 2);
    expect(tl.map((i) => i.status)).toEqual([null, "read", "sent", "sending"]);
  });
  it("BR-SEND-5: pending sorts after messages known at creation, before later confirmed ones", () => {
    const tl = buildTimeline([msg(1), msg(4)], [pending({ afterId: 1 })], 0);
    expect(tl.map((i) => i.key)).toEqual(["m1", "pt", "m4"]);
  });
});

describe("history decisions (BR-HIST)", () => {
  it("AC-39/AC-40: open around when >=2 unread, else bottom", () => {
    expect(openMode({ unreadCount: 10 })).toBe("around");
    expect(openMode({ unreadCount: 1 })).toBe("bottom");
  });
  it("AC-41: no divider when the first unread is the newest", () => {
    expect(dividerBeforeId([msg(1), msg(2)], 1, true)).toBeNull();
    expect(dividerBeforeId([msg(1), msg(2), msg(3)], 1, true)).toBe(2);
  });
  it("AC-42/AC-45: go-to-bottom target", () => {
    expect(goToBottomTarget({ jumpStack: [7], firstUnread: 5, lastVisibleId: 1 })).toEqual({ target: 7, popped: true });
    expect(goToBottomTarget({ jumpStack: [], firstUnread: 5, lastVisibleId: 3 })).toEqual({ target: 5, popped: false });
    expect(goToBottomTarget({ jumpStack: [], firstUnread: 5, lastVisibleId: 9 })).toEqual({ target: "end", popped: false });
  });
});
