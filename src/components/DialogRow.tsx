"use client";

import { useState } from "react";
import type { DialogRowModel } from "@/client/derive";
import { formatListTime } from "@/client/derive";
import { copy } from "@/client/copy";
import { StatusIcon } from "./StatusIcon";

export interface DialogRowProps {
  row: DialogRowModel;
  active: boolean;
  now: number;
  onOpen(): void;
  onMarkRead(): void;
  onToggleMark(): void;
  onTogglePin(): void;
  draggable?: boolean;
  onDragStart?(): void;
  onDropOn?(): void;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

/** BR-LIST-6..11 */
export function DialogRow({ row, active, now, onOpen, onMarkRead, onToggleMark, onTogglePin, draggable, onDragStart, onDropOn }: DialogRowProps) {
  const [menu, setMenu] = useState(false);
  const sub = row.subtitle;
  return (
    <li
      className={`row${active ? " active" : ""}`}
      data-testid={`dialog-${row.peerId}`}
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu(true);
      }}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={(e) => draggable && e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onDropOn?.();
      }}
    >
      <div className="avatar" aria-hidden="true">
        {initials(row.name)}
      </div>
      <div className="row-main">
        <div className="row-top">
          <span className="row-name">{row.name}</span>
          <span className="row-meta">
            {row.status && <StatusIcon status={row.status} />}
            {row.time != null && <time data-testid="row-time">{formatListTime(row.time, now)}</time>}
          </span>
        </div>
        <div className="row-sub">
          <span className="row-sub-text" data-testid="row-subtitle">
            {sub.kind === "draft" && (
              <>
                <span className="draft-label">{copy.draftLabel}</span>
                {sub.text}
              </>
            )}
            {sub.kind === "message" && (
              <>
                {sub.forwarded && (
                  <span className="fwd-marker" data-testid="fwd-marker" aria-label="forwarded">
                    {copy.forwardMarker}
                  </span>
                )}
                {sub.text}
              </>
            )}
          </span>
          {row.badge?.kind === "count" && (
            <span className="badge" data-testid="badge-count">
              {row.badge.label}
            </span>
          )}
          {row.badge?.kind === "mark" && <span className="badge mark" data-testid="badge-mark" aria-label={copy.markUnread} />}
          {row.badge?.kind === "pin" && (
            <span className="badge pin" data-testid="badge-pin" aria-label={copy.pin}>
              ▲
            </span>
          )}
        </div>
      </div>
      <button
        className="row-menu-btn"
        aria-label="Conversation options"
        onClick={(e) => {
          e.stopPropagation();
          setMenu((v) => !v);
        }}
      >
        ⋮
      </button>
      {menu && (
        <ul className="menu" role="menu" onClick={(e) => e.stopPropagation()} onMouseLeave={() => setMenu(false)}>
          {row.unreadCount > 0 ? (
            <li>
              <button role="menuitem" onClick={() => (setMenu(false), onMarkRead())}>
                {copy.markRead}
              </button>
            </li>
          ) : (
            <li>
              <button role="menuitem" onClick={() => (setMenu(false), onToggleMark())}>
                {row.unreadMark ? copy.clearMark : copy.markUnread}
              </button>
            </li>
          )}
          <li>
            <button role="menuitem" onClick={() => (setMenu(false), onTogglePin())}>
              {row.pinned ? copy.unpin : copy.pin}
            </button>
          </li>
        </ul>
      )}
    </li>
  );
}
