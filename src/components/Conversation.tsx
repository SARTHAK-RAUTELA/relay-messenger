"use client";

import { useState } from "react";
import { copy } from "@/client/copy";
import { useMessenger } from "./context";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { DeleteDialog } from "./DeleteDialog";
import { ForwardPicker } from "./ForwardPicker";

export function Conversation() {
  const m = useMessenger();
  const peerId = m.openPeerId;
  const [deleting, setDeleting] = useState<number[] | null>(null);
  const [forwarding, setForwarding] = useState<number[] | null>(null);

  if (peerId == null) {
    return (
      <section className="conversation">
        <div className="placeholder">{copy.pickConversation}</div>
      </section>
    );
  }
  const d = m.dialogs.get(peerId);
  const name = d?.peer.displayName ?? "…";
  const replyId = m.replyTo.get(peerId);
  const replyMsg = replyId != null ? m.findMessage(peerId, replyId) : undefined;
  const ed = m.editing.get(peerId);
  const fd = m.forwardDraft.get(peerId);
  const selection = m.selection.get(peerId);

  const replyName = replyMsg
    ? (replyMsg.forwardedFrom?.name ?? (replyMsg.out ? (m.me?.displayName ?? "") : name))
    : "";

  return (
    <section className="conversation" aria-label={name}>
      <header className="conv-head">
        <button className="ghost back" onClick={() => m.closeConversation()} aria-label="Back">
          ←
        </button>
        <div>
          <div className="conv-title">{name}</div>
          {d?.peer.username && <div className="conv-sub">@{d.peer.username}</div>}
        </div>
      </header>
      <MessageList m={m} peerId={peerId} onDelete={(ids) => setDeleting(ids)} onForward={(ids) => setForwarding(ids)} />
      {selection ? (
        <div className="select-bar">
          <span className="grow">{copy.selectedCount(selection.size)}</span>
          <button className="ghost" disabled={selection.size === 0} onClick={() => setForwarding([...selection])}>
            {copy.menuForward}
          </button>
          <button className="danger" disabled={selection.size === 0} onClick={() => setDeleting([...selection])}>
            {copy.menuDelete}
          </button>
          <button className="ghost" onClick={() => m.clearSelection(peerId)}>
            {copy.cancel}
          </button>
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
          peerName={name}
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
          dialogs={m.dialogRows().map((r) => ({ id: r.peerId, name: r.name }))}
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
    </section>
  );
}
