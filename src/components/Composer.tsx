"use client";

import { useEffect, useRef } from "react";
import { copy } from "@/client/copy";
import { splitText } from "@/shared/text";

export interface ComposerProps {
  text: string;
  maxLen: number;
  reply: { name: string; snippet: string } | null;
  editing: { busy: boolean; error: string | null } | null;
  forward: { count: number; hideSender: boolean } | null;
  onChange(text: string): void;
  onSend(): void;
  onSaveEdit(): void;
  onCancelReply(): void;
  onCancelEdit(): void;
  onCancelForward(): void;
  onToggleHideSender(v: boolean): void;
}

/** Composer with reply / edit / forward strips (section 7). */
export function Composer(p: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [p.editing != null, p.reply != null]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = () => {
    if (p.editing) p.onSaveEdit();
    else p.onSend();
  };
  const parts = p.editing ? 1 : splitText(p.text, p.maxLen).length;

  return (
    <div className="composer">
      {p.reply && !p.editing && (
        <div className="strip" data-testid="reply-strip">
          <div className="grow">
            <span className="t">
              {copy.replyingTo} {p.reply.name}
            </span>
            <span className="s">{p.reply.snippet}</span>
          </div>
          <button aria-label={copy.cancel} onClick={p.onCancelReply}>
            ✕
          </button>
        </div>
      )}
      {p.editing && (
        <div className="strip" data-testid="edit-strip">
          <div className="grow">
            <span className="t">{copy.editing}</span>
            {p.editing.error && <span className="s error">{p.editing.error}</span>}
          </div>
          <button aria-label={copy.cancel} onClick={p.onCancelEdit}>
            ✕
          </button>
        </div>
      )}
      {p.forward && (
        <div className="strip" data-testid="forward-strip">
          <div className="grow">
            <span className="t">{copy.forwarding(p.forward.count)}</span>
            <label className="check">
              <input type="checkbox" checked={p.forward.hideSender} onChange={(e) => p.onToggleHideSender(e.target.checked)} />
              {copy.hideAuthor}
            </label>
          </div>
          <button aria-label={copy.cancel} onClick={p.onCancelForward}>
            ✕
          </button>
        </div>
      )}
      <div className="composer-row">
        <textarea
          ref={ref}
          rows={1}
          aria-label={copy.composerPlaceholder}
          placeholder={copy.composerPlaceholder}
          value={p.text}
          onChange={(e) => p.onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              if (p.editing) p.onCancelEdit();
              else if (p.reply) p.onCancelReply();
            }
          }}
        />
        <button className="primary" onClick={submit} disabled={p.editing?.busy} aria-busy={p.editing?.busy}>
          {p.editing ? (p.editing.busy ? <span className="spinner" /> : copy.save) : copy.send}
        </button>
      </div>
      {parts > 1 && <div className="warn">{copy.splitWarning(parts)}</div>}
    </div>
  );
}
