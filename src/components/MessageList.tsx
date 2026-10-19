"use client";

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Messenger } from "@/client/messenger";
import type { TimelineItem } from "@/client/derive";
import { formatCount } from "@/client/derive";
import { copy } from "@/client/copy";
import { MessageBubble } from "./MessageBubble";

function dayKey(ts: number) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function dayLabel(ts: number) {
  return new Date(ts).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}
const itemDate = (i: TimelineItem) => (i.kind === "message" ? i.message.date : i.pending.date);

/** History view: paging, scroll commands, read visibility reporting (BR-HIST, BR-READ-1). */
export function MessageList(props: {
  m: Messenger;
  peerId: number;
  onDelete(ids: number[]): void;
  onForward(ids: number[]): void;
}) {
  const { m, peerId } = props;
  const conv = m.convs.get(peerId);
  const dialog = m.dialogs.get(peerId);
  const items = m.timeline(peerId);
  const selection = m.selection.get(peerId);
  const box = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const prevFirst = useRef<{ id: number | null; height: number; top: number }>({ id: null, height: 0, top: 0 });
  const stick = useRef(true);
  const handledNonce = useRef<number | null>(null);

  // Scroll preservation when older messages are prepended; stick to bottom on new messages.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !conv) return;
    const firstId = conv.messages[0]?.id ?? null;
    const prev = prevFirst.current;
    if (prev.id != null && firstId != null && firstId < prev.id) {
      el.scrollTop = prev.top + (el.scrollHeight - prev.height);
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevFirst.current = { id: firstId, height: el.scrollHeight, top: el.scrollTop };
  });

  // Scroll commands from the client (open position, jumps, go-to-bottom).
  useLayoutEffect(() => {
    const el = box.current;
    const cmd = conv?.scroll;
    if (!el || !cmd || handledNonce.current === cmd.nonce) return;
    handledNonce.current = cmd.nonce;
    if (cmd.to === "bottom") {
      el.scrollTop = el.scrollHeight;
      stick.current = true;
    } else if (cmd.to === "saved") {
      const saved = m.scrollMemory.get(peerId);
      const target = saved && el.querySelector<HTMLElement>(`[data-mid="${saved.anchorId}"]`);
      if (target) el.scrollTop = target.offsetTop - saved!.offset;
      else el.scrollTop = el.scrollHeight;
      stick.current = false;
    } else {
      const target = el.querySelector<HTMLElement>(`[data-mid="${cmd.to.id}"]`);
      if (target) {
        const divider = cmd.to.align === "top" ? el.querySelector<HTMLElement>(".unread-divider") : null;
        const anchor = divider ?? target;
        el.scrollTop =
          cmd.to.align === "top" ? anchor.offsetTop - 8 : target.offsetTop - el.clientHeight / 2 + target.offsetHeight / 2;
      }
      stick.current = false;
    }
    prevFirst.current = { id: conv?.messages[0]?.id ?? null, height: el.scrollHeight, top: el.scrollTop };
    onScroll();
  }, [conv?.scroll?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // Highlight fades out.
  useEffect(() => {
    if (conv?.highlightId == null) return;
    const t = setTimeout(() => m.clearHighlight(peerId), 1600);
    return () => clearTimeout(t);
  }, [conv?.highlightId]); // eslint-disable-line react-hooks/exhaustive-deps

  // BR-READ-1: report incoming bubbles intersecting the viewport (threshold 0, OD-8).
  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const visible = new Set<number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = Number((e.target as HTMLElement).dataset.mid);
          if (e.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        if (visible.size) m.reportSeen(peerId, [...visible]);
      },
      { root: el, threshold: 0 },
    );
    el.querySelectorAll<HTMLElement>("[data-incoming='1']").forEach((n) => io.observe(n));
    return () => io.disconnect();
  });

  const onScroll = () => {
    const el = box.current;
    if (!el || !conv) return;
    const bottomGap = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isBottom = bottomGap < 40 && !conv.hasNewer;
    stick.current = isBottom;
    if (isBottom !== atBottom) setAtBottom(isBottom);
    if (el.scrollTop < 200 && conv.hasOlder && !conv.loadingOlder && !conv.error) {
      prevFirst.current = { id: conv.messages[0]?.id ?? null, height: el.scrollHeight, top: el.scrollTop };
      void m.loadOlder(peerId);
    }
    if (bottomGap < 200 && conv.hasNewer && !conv.loadingNewer && !conv.error) void m.loadNewer(peerId);
    // OD-15: remember position (first visible bubble) unless at the bottom.
    if (isBottom) m.saveScroll(peerId, null);
    else {
      const nodes = el.querySelectorAll<HTMLElement>("[data-mid]");
      for (const n of nodes) {
        if (n.offsetTop + n.offsetHeight > el.scrollTop) {
          m.saveScroll(peerId, { anchorId: Number(n.dataset.mid), offset: n.offsetTop - el.scrollTop });
          break;
        }
      }
    }
  };

  const lastVisibleId = () => {
    const el = box.current;
    if (!el) return null;
    let last: number | null = null;
    for (const n of el.querySelectorAll<HTMLElement>("[data-mid]")) {
      if (n.offsetTop < el.scrollTop + el.clientHeight) last = Number(n.dataset.mid);
    }
    return last;
  };

  if (!conv || conv.status === "loading") {
    return (
      <div className="messages" aria-busy="true">
        <div className="skeleton" />
        <div className="skeleton" style={{ width: "60%", marginLeft: "auto" }} />
        <div className="skeleton" style={{ width: "70%" }} />
      </div>
    );
  }
  if (conv.status === "error") {
    return (
      <div className="messages">
        <div className="page-edge" role="alert">
          {copy.loadFailed} <button className="ghost" onClick={() => m.retryLoad(peerId)}>{copy.retry}</button>
        </div>
      </div>
    );
  }

  let prevDay: string | null = null;
  return (
    <div className="messages" ref={box} onScroll={onScroll} data-testid="message-list">
      {conv.loadingOlder && (
        <div className="page-edge">
          <span className="spinner" />
        </div>
      )}
      {conv.error && conv.error.dir === "older" && (
        <div className="page-edge" role="alert">
          {copy.loadFailed} <button className="ghost" onClick={() => m.retryLoad(peerId)}>{copy.retry}</button>
        </div>
      )}
      {items.length === 0 && <div className="placeholder">{copy.emptyConversation}</div>}
      {items.map((item) => {
        const d = dayKey(itemDate(item));
        const sep = d !== prevDay;
        prevDay = d;
        const id = item.kind === "message" ? item.message.id : null;
        return (
          <Fragment key={item.key}>
            {sep && (
              <div className="date-sep">
                <span>{dayLabel(itemDate(item))}</span>
              </div>
            )}
            {id != null && id === conv.dividerBeforeId && (
              <div className="unread-divider" data-testid="unread-divider">
                {copy.unreadDivider}
              </div>
            )}
            <MessageBubble
              item={item}
              senderName={
                dialog?.kind === "group" && item.kind === "message" && !item.message.out
                  ? m.senderNameFor(peerId, item.message.senderId, item.message)
                  : null
              }
              canForward={dialog?.kind !== "secret"}
              onReact={(emoji) => id != null && void m.react(peerId, id, emoji)}
              canEdit={item.kind === "message" && m.canEdit(item.message)}
              highlighted={id != null && conv.highlightId === id}
              selectionMode={!!selection}
              selected={id != null && !!selection?.has(id)}
              onReply={() => id != null && m.setReply(peerId, id)}
              onEdit={() => id != null && m.startEdit(peerId, id)}
              onForward={() => id != null && props.onForward([id])}
              onSelect={() => (id == null ? undefined : selection ? m.toggleSelect(peerId, id) : m.startSelection(peerId, id))}
              onDelete={() => id != null && props.onDelete([id])}
              onRetry={() => item.kind === "pending" && m.retryPending(item.pending.token)}
              onDiscard={() => item.kind === "pending" && m.discardPending(item.pending.token)}
              onReplyClick={(ref) => void m.jumpToMessage(peerId, ref.id, id, ref.deleted)}
            />
          </Fragment>
        );
      })}
      {conv.loadingNewer && (
        <div className="page-edge">
          <span className="spinner" />
        </div>
      )}
      {conv.error && conv.error.dir === "newer" && (
        <div className="page-edge" role="alert">
          {copy.loadFailed} <button className="ghost" onClick={() => m.retryLoad(peerId)}>{copy.retry}</button>
        </div>
      )}
      {(!atBottom || conv.hasNewer) && (
        <button className="to-bottom" aria-label={copy.goToBottom} title={copy.goToBottom} onClick={() => void m.goToBottom(peerId, lastVisibleId())}>
          ↓{dialog && dialog.unreadCount > 0 && <span className="badge">{formatCount(dialog.unreadCount)}</span>}
        </button>
      )}
    </div>
  );
}
