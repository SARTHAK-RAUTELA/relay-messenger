"use client";

import { useState } from "react";
import type { TimelineItem } from "@/client/derive";
import type { ReplyRef } from "@/shared/types";
import { copy } from "@/client/copy";
import { serviceText } from "@/client/derive";
import { REACTIONS } from "@/shared/peer";
import { StatusIcon } from "./StatusIcon";

export interface BubbleProps {
  item: TimelineItem;
  /** Shown above incoming group messages. */
  senderName: string | null;
  canEdit: boolean;
  canForward: boolean;
  onReact(emoji: string | null): void;
  highlighted: boolean;
  selectionMode: boolean;
  selected: boolean;
  onReply(): void;
  onEdit(): void;
  onForward(): void;
  onSelect(): void;
  onDelete(): void;
  onRetry(): void;
  onDiscard(): void;
  onReplyClick(ref: ReplyRef): void;
}

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
function fmtFull(ts: number) {
  return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

/** Message bubble (UX states table, section 7). */
export function MessageBubble(p: BubbleProps) {
  const [menu, setMenu] = useState(false);
  const isPending = p.item.kind === "pending";
  const msg = p.item.kind === "message" ? p.item.message : null;
  const pend = p.item.kind === "pending" ? p.item.pending : null;
  const out = msg ? msg.out : true;
  const text = msg ? msg.text : pend!.text;
  const date = msg ? msg.date : pend!.date;
  const replyTo = msg ? msg.replyTo : pend!.replyTo;
  const fwd = msg ? msg.forwardedFrom : pend!.forwardedFrom;
  const status = p.item.status;
  const failed = status === "failed";

  // BR-EDIT-8 / BR-FWD-10 time tooltip
  const tip = [
    `${copy.sentAt}: ${fmtFull(date)}`,
    msg?.editDate ? `${copy.editedAt}: ${fmtFull(msg.editDate)}` : null,
    fwd ? `${copy.originallySent}: ${fmtFull(fwd.date)}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const selectable = p.selectionMode && !isPending;
  if (msg?.service) {
    return (
      <div className="service-row" data-mid={msg.id} data-incoming={!msg.out ? "1" : undefined} data-testid={`msg-${msg.id}`}>
        <span>{serviceText(msg.service, msg.out ? copy.you : (msg.senderName ?? ""))}</span>
      </div>
    );
  }
  const reactions = msg?.reactions ?? [];
  const mine = reactions.find((r) => r.mine)?.emoji ?? null;
  return (
    <div
      className={`bubble-row ${out ? "out" : "in"}${selectable ? " selectable" : ""}`}
      data-mid={msg?.id}
      data-incoming={msg && !msg.out ? "1" : undefined}
      data-testid={msg ? `msg-${msg.id}` : `pending-${pend!.token}`}
      onClick={selectable ? p.onSelect : undefined}
      onContextMenu={(e) => {
        if (isPending || p.selectionMode) return;
        e.preventDefault();
        setMenu(true);
      }}
    >
      {p.selectionMode && !isPending && <span className={`select-box${p.selected ? " on" : ""}`} aria-checked={p.selected} role="checkbox" />}
      <div
        className={`bubble${p.highlighted ? " highlight" : ""}${failed ? " failed" : ""}${msg?.undecryptable ? " undecryptable" : ""}`}
      >
        {p.senderName && !out && (
          <div className="sender-name" data-testid="sender-name">
            {p.senderName}
          </div>
        )}
        {fwd && (
          <div className="fwd-head" data-testid="fwd-head">
            {copy.forwardedFrom(fwd.name)}
          </div>
        )}
        {replyTo && (
          <button
            className={`reply-head${replyTo.deleted ? " gone" : ""}`}
            data-testid="reply-head"
            onClick={(e) => {
              e.stopPropagation();
              p.onReplyClick(replyTo);
            }}
          >
            {replyTo.deleted ? (
              <span className="what">{copy.originalGone}</span>
            ) : (
              <>
                <span className="who">{replyTo.senderName}</span>
                <span className="what">{replyTo.snippet}</span>
              </>
            )}
          </button>
        )}
        <div className="bubble-text">{text}</div>
        {reactions.length > 0 && (
          <div className="reactions" data-testid="reactions">
            {reactions.map((r) => (
              <button
                key={r.emoji}
                className={`reaction${r.mine ? " mine" : ""}`}
                aria-pressed={r.mine}
                onClick={(e) => {
                  e.stopPropagation();
                  p.onReact(r.mine ? null : r.emoji);
                }}
              >
                {r.emoji} {r.count}
              </button>
            ))}
          </div>
        )}
        <div className="foot" title={tip} data-testid="time">
          {msg?.editDate && <span data-testid="edited">{copy.edited}</span>}
          <span>{fmtTime(date)}</span>
          {status && <StatusIcon status={status} />}
        </div>
        {failed && (
          <div className="failed-actions" title={copy.failedHint}>
            <button onClick={p.onRetry}>{copy.retry}</button>
            <button onClick={p.onDiscard}>{copy.discard}</button>
          </div>
        )}
        {!isPending && !p.selectionMode && (
          <div className="bubble-actions">
            <button
              aria-label="Message options"
              onClick={(e) => {
                e.stopPropagation();
                setMenu((v) => !v);
              }}
            >
              ⋯
            </button>
          </div>
        )}
        {menu && !isPending && (
          <ul className="menu" role="menu" onMouseLeave={() => setMenu(false)}>
            <li className="react-bar" aria-label={copy.react}>
              {REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  aria-label={`${copy.react} ${emoji}`}
                  aria-pressed={mine === emoji}
                  onClick={() => (setMenu(false), p.onReact(mine === emoji ? null : emoji))}
                >
                  {emoji}
                </button>
              ))}
            </li>
            <li>
              <button role="menuitem" onClick={() => (setMenu(false), p.onReply())}>
                {copy.menuReply}
              </button>
            </li>
            {p.canEdit && (
              <li>
                <button role="menuitem" onClick={() => (setMenu(false), p.onEdit())}>
                  {copy.menuEdit}
                </button>
              </li>
            )}
            {p.canForward && (
              <li>
                <button role="menuitem" onClick={() => (setMenu(false), p.onForward())}>
                  {copy.menuForward}
                </button>
              </li>
            )}
            <li>
              <button role="menuitem" onClick={() => (setMenu(false), p.onSelect())}>
                {copy.menuSelect}
              </button>
            </li>
            <li>
              <button role="menuitem" className="destructive" onClick={() => (setMenu(false), p.onDelete())}>
                {copy.menuDelete}
              </button>
            </li>
          </ul>
        )}
      </div>
    </div>
  );
}
