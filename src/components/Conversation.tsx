"use client";

import { useEffect, useState } from "react";
import { copy } from "@/client/copy";
import { presenceLabel } from "@/client/derive";
import { useMessenger } from "./context";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { DeleteDialog } from "./DeleteDialog";
import { ForwardPicker } from "./ForwardPicker";
import { GroupInfoDialog } from "./GroupDialogs";
import { SecretKeyDialog } from "./SettingsDialog";

export function Conversation() {
  const m = useMessenger();
  const peerId = m.openPeerId;
  const [deleting, setDeleting] = useState<number[] | null>(null);
  const [forwarding, setForwarding] = useState<number[] | null>(null);
  const [menu, setMenu] = useState(false);
  const [panel, setPanel] = useState<"group" | "key" | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    setMenu(false);
    setPanel(null);
  }, [peerId]);

  if (peerId == null) {
    return (
      <section className="conversation">
        <div className="placeholder">{copy.pickConversation}</div>
      </section>
    );
  }
  const d = m.dialogs.get(peerId);
  const kind = d?.kind ?? "user";
  const name = d?.peer.displayName ?? "…";
  const replyId = m.replyTo.get(peerId);
  const replyMsg = replyId != null ? m.findMessage(peerId, replyId) : undefined;
  const ed = m.editing.get(peerId);
  const fd = m.forwardDraft.get(peerId);
  const selection = m.selection.get(peerId);
  const typing = m.typingIn(peerId);
  const secretStatus = kind === "secret" ? m.secretStatus(peerId) : "ready";

  const replyName = replyMsg ? (replyMsg.forwardedFrom?.name ?? m.senderNameFor(peerId, replyMsg.senderId, replyMsg)) : "";

  let subtitle: string;
  if (typing.length > 0) subtitle = kind === "group" ? copy.typingNames(typing) : copy.typing;
  else if (kind === "group") subtitle = copy.members(d?.group?.members.length ?? 0);
  else if (d?.peerDeleted) subtitle = "";
  else subtitle = presenceLabel(m.presenceOf(peerId), now);

  // Something replaces the composer when you can't (or shouldn't) write here.
  let banner: React.ReactNode = null;
  if (d?.peerDeleted) banner = copy.peerDeletedBanner;
  else if (d?.blocked) {
    banner = (
      <>
        {copy.blockedBanner}
        <button className="ghost" onClick={() => void m.setBlocked(peerId, false)}>
          {copy.unblock}
        </button>
      </>
    );
  } else if (secretStatus === "otherDevice") banner = copy.secretOtherDevice;
  else if (kind === "secret" && secretStatus === "unsupported") banner = copy.secretUnsupported;

  const menuItems: { label: string; run(): void; danger?: boolean }[] = [];
  if (kind === "group") menuItems.push({ label: copy.groupInfo, run: () => setPanel("group") });
  if (kind === "secret") menuItems.push({ label: copy.secretKey, run: () => setPanel("key") });
  if (kind === "user" && !d?.peerDeleted) {
    menuItems.push({ label: copy.startSecret, run: () => void m.startSecretChat(peerId) });
  }
  if (kind !== "group" && !d?.peerDeleted) {
    menuItems.push({ label: d?.blocked ? copy.unblock : copy.block, run: () => void m.setBlocked(peerId, !d?.blocked), danger: !d?.blocked });
  }

  return (
    <section className="conversation" aria-label={name}>
      <header className="conv-head">
        <button className="ghost back" onClick={() => m.closeConversation()} aria-label="Back">
          ←
        </button>
        <div className="grow">
          <div className={`conv-title${kind === "secret" ? " secret-name" : ""}`}>
            {kind === "secret" && <span className="kind-icon">🔒</span>}
            {name}
          </div>
          <div className={`conv-sub${typing.length ? " typing-text" : ""}`} data-testid="conv-sub">
            {subtitle || (d?.peer.username ? `@${d.peer.username}` : "")}
          </div>
        </div>
        {menuItems.length > 0 && (
          <button className="row-menu-btn" aria-label="Chat options" onClick={() => setMenu((v) => !v)}>
            ⋮
          </button>
        )}
        {menu && (
          <ul className="menu" role="menu" onMouseLeave={() => setMenu(false)}>
            {menuItems.map((it) => (
              <li key={it.label}>
                <button role="menuitem" className={it.danger ? "destructive" : undefined} onClick={() => (setMenu(false), it.run())}>
                  {it.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </header>
      <MessageList m={m} peerId={peerId} onDelete={(ids) => setDeleting(ids)} onForward={(ids) => setForwarding(ids)} />
      {selection ? (
        <div className="select-bar">
          <span className="grow">{copy.selectedCount(selection.size)}</span>
          {kind !== "secret" && (
            <button className="ghost" disabled={selection.size === 0} onClick={() => setForwarding([...selection])}>
              {copy.menuForward}
            </button>
          )}
          <button className="danger" disabled={selection.size === 0} onClick={() => setDeleting([...selection])}>
            {copy.menuDelete}
          </button>
          <button className="ghost" onClick={() => m.clearSelection(peerId)}>
            {copy.cancel}
          </button>
        </div>
      ) : banner ? (
        <div className="conv-banner" role="status" data-testid="conv-banner">
          {banner}
        </div>
      ) : (
        <Composer
          text={m.composer.get(peerId) ?? ""}
          maxLen={m.cfg.maxTextLen}
          reply={replyMsg ? { name: replyName, snippet: replyMsg.text.replace(/\s+/g, " ").slice(0, 100) } : null}
          editing={ed ? { busy: ed.busy, error: ed.error } : null}
          forward={fd ? { count: fd.messageIds.length, hideSender: fd.hideSender } : null}
          onChange={(t) => m.setComposerText(peerId, t)}
          onSend={() => (fd ? void m.sendForwardDraft(peerId) : void m.send(peerId))}
          onSaveEdit={() => void m.saveEdit(peerId)}
          onCancelReply={() => m.setReply(peerId, null)}
          onCancelEdit={() => m.cancelEdit(peerId)}
          onCancelForward={() => m.cancelForwardDraft(peerId)}
          onToggleHideSender={(v) => m.setForwardHideSender(peerId, v)}
        />
      )}
      {deleting && (
        <DeleteDialog
          count={deleting.length}
          peerName={kind === "group" ? copy.everyone : name}
          onCancel={() => setDeleting(null)}
          onConfirm={async (forEveryone) => {
            try {
              await m.deleteMessages(peerId, deleting, forEveryone);
              setDeleting(null);
            } catch {
              m.notice(copy.deleteFailedNotice); // BR-DEL-4 / AC-58
            }
          }}
        />
      )}
      {forwarding && (
        <ForwardPicker
          count={forwarding.length}
          dialogs={m
            .dialogRows()
            .filter((r) => r.kind !== "secret")
            .map((r) => ({ id: r.peerId, name: r.name }))}
          search={(q) => m.searchUsers(q)}
          onClose={() => setForwarding(null)}
          onOpen={(target, hideSender) => {
            const ids = forwarding;
            setForwarding(null);
            void m.prepareForward(target, { fromPeerId: peerId, messageIds: ids, hideSender });
          }}
          onSend={async (targets, hideSender, comment) => {
            const res = await m.forward({ fromPeerId: peerId, messageIds: forwarding, targets, hideSender, comment });
            const nameOf = (id: number) => m.dialogs.get(id)?.peer.displayName ?? "?";
            if (res.succeeded.length) m.notice(copy.forwardDone(res.succeeded.map(nameOf), res.succeeded.length));
            if (res.failed.length) m.notice(copy.forwardSomeFailed);
            return res;
          }}
        />
      )}
      {panel === "group" && <GroupInfoDialog peerId={peerId} onClose={() => setPanel(null)} />}
      {panel === "key" && <SecretKeyDialog peerId={peerId} onClose={() => setPanel(null)} />}
    </section>
  );
}
