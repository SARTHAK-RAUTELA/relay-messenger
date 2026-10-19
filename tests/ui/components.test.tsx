// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DialogRow } from "../../src/components/DialogRow";
import { MessageBubble } from "../../src/components/MessageBubble";
import { DeleteDialog } from "../../src/components/DeleteDialog";
import { Composer } from "../../src/components/Composer";
import { ForwardPicker } from "../../src/components/ForwardPicker";
import { deriveRow, buildTimeline, type PendingMessage } from "../../src/client/derive";
import type { Dialog, Message } from "../../src/shared/types";

afterEach(cleanup);

const msg = (id: number, over: Partial<Message> = {}): Message => ({
  id,
  peerId: 2,
  senderId: over.out ? 1 : 2,
  out: false,
  text: "text " + id,
  date: Date.now() - 1000,
  editDate: null,
  replyTo: null,
  forwardedFrom: null,
  reactions: [],
  service: null,
  ...over,
});
const dialog = (over: Partial<Dialog> = {}): Dialog => ({
  kind: "user",
  group: null,
  secret: null,
  blocked: false,
  peerDeleted: false,
  presence: null,
  peer: { id: 2, username: "bob", displayName: "Bob" },
  topMessage: msg(1),
  unreadCount: 0,
  unreadMark: false,
  pinned: false,
  pinOrder: null,
  draft: null,
  readInboxMaxId: 0,
  readOutboxMaxId: 0,
  activityDate: Date.now(),
  ...over,
});
const noop = () => {};
const rowProps = { active: false, now: Date.now(), onOpen: noop, onMarkRead: noop, onToggleMark: noop, onTogglePin: noop };
const bubbleProps = {
  canEdit: false,
  senderName: null,
  canForward: true,
  onReact: noop,
  highlighted: false,
  selectionMode: false,
  selected: false,
  onReply: noop,
  onEdit: noop,
  onForward: noop,
  onSelect: noop,
  onDelete: noop,
  onRetry: noop,
  onDiscard: noop,
  onReplyClick: noop,
};

describe("DialogRow", () => {
  it("AC-19: preview without sender prefix and numeric badge", () => {
    render(<DialogRow {...rowProps} row={deriveRow(dialog({ unreadCount: 2, topMessage: msg(1, { text: "hey" }) }), null)} />);
    expect(screen.getByTestId("row-subtitle").textContent).toBe("hey");
    expect(screen.getByTestId("badge-count").textContent).toBe("2");
  });
  it("AC-31: draft label + text, no status indicator", () => {
    render(<DialogRow {...rowProps} row={deriveRow(dialog({ topMessage: msg(1, { out: true }), draft: { text: "later", date: Date.now() } }), null)} />);
    const sub = screen.getByTestId("row-subtitle");
    expect(sub.querySelector(".draft-label")).not.toBeNull();
    expect(sub.textContent).toContain("later");
    expect(document.querySelector("[data-status]")).toBeNull();
  });
  it("AC-32: long preview is cut", () => {
    render(<DialogRow {...rowProps} row={deriveRow(dialog({ topMessage: msg(1, { text: "y".repeat(150) }) }), null)} />);
    expect(screen.getByTestId("row-subtitle").textContent).toBe("y".repeat(100) + "…");
  });
  it("AC-33: forward marker before forwarded preview", () => {
    render(<DialogRow {...rowProps} row={deriveRow(dialog({ topMessage: msg(1, { forwardedFrom: { userId: 3, name: "Dee", date: 1 } }) }), null)} />);
    expect(screen.getByTestId("fwd-marker")).toBeTruthy();
  });
  it("AC-34: failed outgoing top shows the failed indicator", () => {
    const p: PendingMessage = {
      token: "x", peerId: 2, text: "oops", date: Date.now(), replyToId: null, replyTo: null, forwardedFrom: null,
      state: "failed", error: { code: "SERVER_ERROR", message: "" }, afterId: 1, order: 1, batch: null,
    };
    render(<DialogRow {...rowProps} row={deriveRow(dialog(), p)} />);
    expect(document.querySelector("[data-status='failed']")).not.toBeNull();
  });
  it("AC-35/AC-36: blank badge for manual mark; menu offers mark-as-read when unread, toggle otherwise", () => {
    const onMarkRead = vi.fn();
    const onToggleMark = vi.fn();
    const { rerender } = render(
      <DialogRow {...rowProps} onMarkRead={onMarkRead} onToggleMark={onToggleMark} row={deriveRow(dialog({ unreadMark: true }), null)} />,
    );
    expect(screen.getByTestId("badge-mark").textContent).toBe("");
    fireEvent.click(screen.getByLabelText("Conversation options"));
    expect(screen.queryByText("Mark as read")).toBeNull();
    fireEvent.click(screen.getByText("Remove revisit flag"));
    expect(onToggleMark).toHaveBeenCalled();
    rerender(<DialogRow {...rowProps} onMarkRead={onMarkRead} onToggleMark={onToggleMark} row={deriveRow(dialog({ unreadCount: 4 }), null)} />);
    fireEvent.click(screen.getByLabelText("Conversation options"));
    fireEvent.click(screen.getByText("Mark as read"));
    expect(onMarkRead).toHaveBeenCalled();
  });
});

describe("MessageBubble", () => {
  const item = (m: Message, readOut = 0) => buildTimeline([m], [], readOut)[0];
  it("AC-27: incoming shows no status; outgoing shows exactly one", () => {
    render(<MessageBubble {...bubbleProps} item={item(msg(1))} />);
    expect(document.querySelectorAll("[data-status]")).toHaveLength(0);
    cleanup();
    render(<MessageBubble {...bubbleProps} item={item(msg(2, { out: true }), 2)} />);
    const s = document.querySelectorAll("[data-status]");
    expect(s).toHaveLength(1);
    expect(s[0].getAttribute("data-status")).toBe("read");
  });
  it("AC-50/AC-69: edit menu item only when canEdit", () => {
    render(<MessageBubble {...bubbleProps} item={item(msg(1, { out: true }))} canEdit={false} />);
    fireEvent.click(screen.getByLabelText("Message options"));
    expect(screen.queryByText("Edit")).toBeNull();
    cleanup();
    render(<MessageBubble {...bubbleProps} item={item(msg(1, { out: true }))} canEdit />);
    fireEvent.click(screen.getByLabelText("Message options"));
    expect(screen.getByText("Edit")).toBeTruthy();
  });
  it("AC-61/AC-70/BR-SEND-13: pending has no menu and is not selectable; failed offers retry and discard", () => {
    const p: PendingMessage = {
      token: "tok", peerId: 2, text: "x", date: Date.now(), replyToId: null, replyTo: null, forwardedFrom: null,
      state: "sending", error: null, afterId: 0, order: 1, batch: null,
    };
    const onSelect = vi.fn();
    render(<MessageBubble {...bubbleProps} selectionMode onSelect={onSelect} item={buildTimeline([], [p], 0)[0]} />);
    expect(screen.queryByLabelText("Message options")).toBeNull();
    expect(document.querySelector(".select-box")).toBeNull();
    fireEvent.click(screen.getByTestId("pending-tok"));
    expect(onSelect).not.toHaveBeenCalled();
    cleanup();
    const onRetry = vi.fn();
    const onDiscard = vi.fn();
    render(<MessageBubble {...bubbleProps} onRetry={onRetry} onDiscard={onDiscard} item={buildTimeline([], [{ ...p, state: "failed" }], 0)[0]} />);
    fireEvent.click(screen.getByText("Try again"));
    fireEvent.click(screen.getByText("Remove"));
    expect(onRetry).toHaveBeenCalled();
    expect(onDiscard).toHaveBeenCalled();
    expect(screen.queryByText("Delete")).toBeNull();
  });
  it("AC-51: edited marker and tooltip with send and edit dates", () => {
    render(<MessageBubble {...bubbleProps} item={item(msg(1, { out: true, editDate: Date.now() }))} />);
    expect(screen.getByTestId("edited")).toBeTruthy();
    const tip = screen.getByTestId("time").getAttribute("title")!;
    expect(tip).toMatch(/Sent:/);
    expect(tip).toMatch(/Edited:/);
  });
  it("AC-62/AC-63: forwarded header names the author; tooltip has original date; hidden sender has none", () => {
    render(<MessageBubble {...bubbleProps} item={item(msg(1, { forwardedFrom: { userId: 3, name: "Bob", date: 1_600_000_000_000 } }))} />);
    expect(screen.getByTestId("fwd-head").textContent).toContain("Bob");
    expect(screen.getByTestId("time").getAttribute("title")).toMatch(/Originally sent/);
    cleanup();
    render(<MessageBubble {...bubbleProps} item={item(msg(1))} />);
    expect(screen.queryByTestId("fwd-head")).toBeNull();
  });
  it("AC-44/AC-46: reply header shows author+snippet; unavailable state otherwise; click reports deleted", () => {
    const onReplyClick = vi.fn();
    render(<MessageBubble {...bubbleProps} item={item(msg(2, { replyTo: { id: 1, deleted: false, senderId: 2, senderName: "Bob", snippet: "orig" } }))} />);
    expect(screen.getByTestId("reply-head").textContent).toContain("Bob");
    expect(screen.getByTestId("reply-head").textContent).toContain("orig");
    cleanup();
    render(<MessageBubble {...bubbleProps} onReplyClick={onReplyClick} item={item(msg(2, { replyTo: { id: 1, deleted: true } }))} />);
    expect(screen.getByTestId("reply-head").textContent).toMatch(/no longer available/);
    fireEvent.click(screen.getByTestId("reply-head"));
    expect(onReplyClick).toHaveBeenCalledWith({ id: 1, deleted: true });
  });
});

describe("DeleteDialog", () => {
  it("AC-57: checkbox unchecked by default; titles differ for one vs several; names the peer", () => {
    render(<DeleteDialog count={1} peerName="Bob" onConfirm={async () => {}} onCancel={noop} />);
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByText(/Bob/)).toBeTruthy();
    const one = screen.getByRole("heading").textContent;
    cleanup();
    render(<DeleteDialog count={3} peerName="Bob" onConfirm={async () => {}} onCancel={noop} />);
    expect(screen.getByRole("heading").textContent).not.toBe(one);
  });
  it("passes forEveryone through; AC-58: stays open (busy cleared) when the confirm fails", async () => {
    const onConfirm = vi.fn(async () => {
      throw new Error("fail");
    });
    render(<DeleteDialog count={1} peerName="Bob" onConfirm={onConfirm as never} onCancel={noop} />);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByText("Delete"));
    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledWith(true));
    await vi.waitFor(() => expect(screen.getByText("Delete")).toBeTruthy());
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("Composer", () => {
  const base = {
    maxLen: 10, reply: null, editing: null, forward: null, onChange: noop, onSend: noop, onSaveEdit: noop,
    onCancelReply: noop, onCancelEdit: noop, onCancelForward: noop, onToggleHideSender: noop,
  };
  it("Enter sends, Shift+Enter does not; over-limit text warns it will be split (AC-16 UI)", () => {
    const onSend = vi.fn();
    render(<Composer {...base} text={"x".repeat(21)} onSend={onSend} />);
    const ta = screen.getByRole("textbox");
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/3 messages/)).toBeTruthy();
  });
  it("AC-44: reply strip shows author and snippet and can be dismissed; edit strip shows busy + error", () => {
    const onCancelReply = vi.fn();
    render(<Composer {...base} text="" reply={{ name: "Bob", snippet: "orig" }} onCancelReply={onCancelReply} />);
    const strip = screen.getByTestId("reply-strip");
    expect(strip.textContent).toContain("Bob");
    expect(strip.textContent).toContain("orig");
    fireEvent.click(within(strip).getByRole("button"));
    expect(onCancelReply).toHaveBeenCalled();
    cleanup();
    render(<Composer {...base} text="x" editing={{ busy: true, error: "blank" }} />);
    expect(screen.getByTestId("edit-strip").textContent).toContain("blank");
    expect(document.querySelector("button[aria-busy='true']")).not.toBeNull();
  });
  it("AC-67: forward strip with hide-sender toggle", () => {
    const onToggle = vi.fn();
    render(<Composer {...base} text="" forward={{ count: 2, hideSender: false }} onToggleHideSender={onToggle} />);
    fireEvent.click(within(screen.getByTestId("forward-strip")).getByRole("checkbox"));
    expect(onToggle).toHaveBeenCalledWith(true);
  });
});

describe("ForwardPicker", () => {
  const dialogs = [
    { id: 2, name: "Bob" },
    { id: 3, name: "Cee" },
    { id: 4, name: "Dee" },
  ];
  it("AC-67: one target and no comment offers opening the chat", () => {
    const onOpen = vi.fn();
    render(<ForwardPicker count={1} dialogs={dialogs} search={async () => []} onSend={async () => ({ failed: [] })} onOpen={onOpen} onClose={noop} />);
    fireEvent.click(screen.getByTestId("target-3"));
    fireEvent.click(screen.getByText("Open chat"));
    expect(onOpen).toHaveBeenCalledWith(3, false);
  });
  it("AC-66: multi-target send; failed targets stay selected, others deselected", async () => {
    const onSend = vi.fn(async () => ({ failed: [4] }));
    const onClose = vi.fn();
    render(<ForwardPicker count={2} dialogs={dialogs} search={async () => []} onSend={onSend} onOpen={noop} onClose={onClose} />);
    for (const id of [2, 3, 4]) fireEvent.click(screen.getByTestId(`target-${id}`));
    fireEvent.click(screen.getByLabelText("Hide original author"));
    fireEvent.change(screen.getByPlaceholderText(/note/), { target: { value: "fyi" } });
    expect(screen.queryByText("Open chat")).toBeNull();
    fireEvent.click(screen.getByText("Send"));
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledWith([2, 3, 4], true, "fyi"));
    await vi.waitFor(() => expect((screen.getByTestId("target-2") as HTMLInputElement).checked).toBe(false));
    expect((screen.getByTestId("target-3") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId("target-4") as HTMLInputElement).checked).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });
});
