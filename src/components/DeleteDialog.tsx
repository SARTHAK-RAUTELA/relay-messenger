"use client";

import { useState } from "react";
import { copy } from "@/client/copy";

/** BR-DEL-2 / BR-DEL-4 confirmation dialog. */
export function DeleteDialog(props: {
  count: number;
  peerName: string;
  onConfirm(forEveryone: boolean): Promise<void>;
  onCancel(): void;
}) {
  const [forEveryone, setForEveryone] = useState(false);
  const [busy, setBusy] = useState(false);
  const title = props.count === 1 ? copy.deleteTitleOne : copy.deleteTitleMany(props.count);
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal">
        <h2>{title}</h2>
        <label className="check">
          <input type="checkbox" checked={forEveryone} onChange={(e) => setForEveryone(e.target.checked)} />
          {copy.alsoDeleteFor(props.peerName)}
        </label>
        <div className="actions">
          <button className="ghost" onClick={props.onCancel} disabled={busy}>
            {copy.cancel}
          </button>
          <button
            className="danger"
            disabled={busy}
            aria-busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await props.onConfirm(forEveryone);
              } catch {
                /* caller shows a notice; nothing removed (BR-DEL-4) */
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <span className="spinner" /> : copy.deleteConfirm}
          </button>
        </div>
      </div>
    </div>
  );
}
