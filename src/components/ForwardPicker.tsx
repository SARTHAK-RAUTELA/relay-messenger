"use client";

import { useEffect, useState } from "react";
import type { UserSummary } from "@/shared/types";
import { copy } from "@/client/copy";

export interface ForwardTarget {
  id: number;
  name: string;
}

/**
 * BR-FWD-2/3/6 target picker. `onSend` forwards immediately and resolves with failed target ids;
 * `onOpen` handles the single-target, no-comment path (preview strip in the target chat).
 */
export function ForwardPicker(props: {
  count: number;
  dialogs: ForwardTarget[];
  search(q: string): Promise<UserSummary[]>;
  onSend(targets: number[], hideSender: boolean, comment: string): Promise<{ failed: number[] }>;
  onOpen(target: number, hideSender: boolean): void;
  onClose(): void;
}) {
  const [selected, setSelected] = useState<number[]>([]);
  const [hide, setHide] = useState(false);
  const [comment, setComment] = useState("");
  const [q, setQ] = useState("");
  const [found, setFound] = useState<UserSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [names, setNames] = useState<Record<number, string>>(() => Object.fromEntries(props.dialogs.map((d) => [d.id, d.name])));

  useEffect(() => {
    let live = true;
    if (!q.trim()) {
      setFound([]);
      return;
    }
    props.search(q).then((u) => live && setFound(u), () => undefined);
    return () => {
      live = false;
    };
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const options: ForwardTarget[] = [
    ...props.dialogs,
    ...found.filter((u) => !props.dialogs.some((d) => d.id === u.id)).map((u) => ({ id: u.id, name: u.displayName })),
  ];
  const toggle = (t: ForwardTarget) => {
    setNames((n) => ({ ...n, [t.id]: t.name }));
    setSelected((s) => (s.includes(t.id) ? s.filter((x) => x !== t.id) : [...s, t.id]));
  };
  const single = selected.length === 1 && comment.trim() === "";

  const send = async () => {
    setBusy(true);
    try {
      const { failed } = await props.onSend(selected, hide, comment);
      if (failed.length === 0) props.onClose();
      else setSelected(failed); // BR-FWD-6: failed targets stay selected
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={copy.forwardTitle}>
      <div className="modal">
        <h2>
          {copy.forwardTitle} <small style={{ fontWeight: 400 }}>({copy.forwarding(props.count)})</small>
        </h2>
        <input type="search" placeholder={copy.forwardSearch} value={q} onChange={(e) => setQ(e.target.value)} />
        <ul className="picker-list">
          {options.map((t) => (
            <li key={t.id}>
              <label>
                <input type="checkbox" checked={selected.includes(t.id)} onChange={() => toggle(t)} data-testid={`target-${t.id}`} />
                {names[t.id] ?? t.name}
              </label>
            </li>
          ))}
        </ul>
        <label className="check">
          <input type="checkbox" checked={hide} onChange={(e) => setHide(e.target.checked)} />
          {copy.hideAuthor}
        </label>
        <input type="text" placeholder={copy.forwardComment} value={comment} onChange={(e) => setComment(e.target.value)} />
        <div className="actions">
          <button className="ghost" onClick={props.onClose}>
            {copy.cancel}
          </button>
          {single && (
            <button className="ghost" disabled={busy} onClick={() => props.onOpen(selected[0], hide)}>
              {copy.forwardOpen}
            </button>
          )}
          <button className="primary" disabled={busy || selected.length === 0} onClick={send}>
            {copy.forwardSend}
          </button>
        </div>
      </div>
    </div>
  );
}
