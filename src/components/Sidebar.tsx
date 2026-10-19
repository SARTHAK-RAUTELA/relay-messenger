"use client";

import { useEffect, useRef, useState } from "react";
import type { UserSummary } from "@/shared/types";
import { copy } from "@/client/copy";
import { useMessenger } from "./context";
import { DialogRow } from "./DialogRow";
import { Logo } from "./Logo";
import { NewGroupDialog } from "./GroupDialogs";
import { SettingsDialog } from "./SettingsDialog";

export function Sidebar() {
  const m = useMessenger();
  const rows = m.dialogRows();
  const [q, setQ] = useState("");
  const [found, setFound] = useState<UserSummary[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const dragging = useRef<number | null>(null);
  const [dialog, setDialog] = useState<"settings" | "group" | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      m.searchUsers(q).then((u) => live && setFound(u), () => undefined);
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, m]);

  const pinned = rows.filter((r) => r.pinned).map((r) => r.peerId);
  const dropOn = (target: number) => {
    const src = dragging.current;
    dragging.current = null;
    if (src == null || src === target || !pinned.includes(target)) return;
    const order = pinned.filter((p) => p !== src);
    order.splice(order.indexOf(target), 0, src);
    void m.reorderPinned(order);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="brand">
          <Logo size={24} /> {copy.product}
        </span>
        <span style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
          <button className="me" onClick={() => setDialog("settings")} title={copy.settings}>
            {m.me?.displayName}
          </button>
          <button className="ghost" onClick={() => void m.logout()}>
            {copy.signOut}
          </button>
        </span>
      </div>
      {dialog === "settings" && <SettingsDialog onClose={() => setDialog(null)} />}
      {dialog === "group" && <NewGroupDialog onClose={() => setDialog(null)} />}
      <div className="search">
        <input type="search" placeholder={copy.searchPlaceholder} value={q} onChange={(e) => setQ(e.target.value)} aria-label={copy.searchPlaceholder} />
        {found.length > 0 && (
          <ul className="search-results">
            {found.map((u) => (
              <li key={u.id}>
                <button
                  onClick={() => {
                    setQ("");
                    setFound([]);
                    void m.openConversation(u.id);
                  }}
                >
                  <strong>{u.displayName}</strong> <span style={{ color: "var(--ink-soft)" }}>@{u.username}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="sidebar-tools">
        <button className="ghost" onClick={() => setDialog("group")}>
          + {copy.newGroup}
        </button>
      </div>
      <ul className="dialog-list" aria-label="Conversations">
        {m.phase === "loading" && <li className="skeleton" style={{ margin: 12 }} />}
        {m.phase === "ready" && rows.length === 0 && <li className="empty-hint">{copy.noConversations}</li>}
        {rows.map((r) => (
          <DialogRow
            key={r.peerId}
            row={r}
            now={now}
            active={m.openPeerId === r.peerId}
            onOpen={() => void m.openConversation(r.peerId, typeof window !== "undefined" ? window.innerHeight : 600)}
            onMarkRead={() => void m.markAsRead(r.peerId)}
            onToggleMark={() => void m.setUnreadMark(r.peerId, !r.unreadMark)}
            onTogglePin={() => void m.setPinned(r.peerId, !r.pinned)}
            draggable={r.pinned}
            onDragStart={() => (dragging.current = r.peerId)}
            onDropOn={() => dropOn(r.peerId)}
          />
        ))}
        {m.dialogsCursor && (
          <li style={{ padding: 12, textAlign: "center" }}>
            <button className="ghost" onClick={() => void m.loadMoreDialogs()}>
              {copy.loadMore}
            </button>
          </li>
        )}
      </ul>
    </aside>
  );
}
