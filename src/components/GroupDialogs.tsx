"use client";

import { useEffect, useState } from "react";
import type { UserSummary } from "@/shared/types";
import { copy } from "@/client/copy";
import { ApiFailure } from "@/client/api";
import { useMessenger } from "./context";

/** Search people and collect a selection (used to create groups and add members). */
function PeoplePicker(props: { selected: UserSummary[]; exclude: number[]; onChange(next: UserSummary[]): void }) {
  const m = useMessenger();
  const [q, setQ] = useState("");
  const [found, setFound] = useState<UserSummary[]>([]);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => m.searchUsers(q).then((u) => live && setFound(u), () => undefined), 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, m]);
  const picked = new Set(props.selected.map((u) => u.id));
  const toggle = (u: UserSummary) =>
    props.onChange(picked.has(u.id) ? props.selected.filter((x) => x.id !== u.id) : [...props.selected, u]);
  return (
    <>
      {props.selected.length > 0 && (
        <div className="chips">
          {props.selected.map((u) => (
            <button key={u.id} className="chip" onClick={() => toggle(u)} aria-label={`${copy.remove} ${u.displayName}`}>
              {u.displayName} ✕
            </button>
          ))}
        </div>
      )}
      <input type="search" placeholder={copy.forwardSearch} value={q} onChange={(e) => setQ(e.target.value)} aria-label={copy.addPeople} />
      {found.length > 0 && (
        <ul className="picker-list">
          {found
            .filter((u) => !props.exclude.includes(u.id))
            .map((u) => (
              <li key={u.id}>
                <label>
                  <input type="checkbox" checked={picked.has(u.id)} onChange={() => toggle(u)} data-testid={`pick-${u.id}`} />
                  {u.displayName} <span style={{ color: "var(--ink-soft)" }}>@{u.username}</span>
                </label>
              </li>
            ))}
        </ul>
      )}
    </>
  );
}

const errorText = (e: unknown) => (e instanceof ApiFailure ? e.message : copy.loadFailed);

export function NewGroupDialog(props: { onClose(): void }) {
  const m = useMessenger();
  const [title, setTitle] = useState("");
  const [people, setPeople] = useState<UserSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (people.length === 0) return setError(copy.pickAtLeastOne);
    setBusy(true);
    setError(null);
    try {
      await m.createGroup(title, people.map((u) => u.id));
      props.onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={copy.newGroup}>
      <div className="modal">
        <h2>{copy.newGroup}</h2>
        <input type="text" placeholder={copy.groupName} aria-label={copy.groupName} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={64} />
        <PeoplePicker selected={people} exclude={[]} onChange={setPeople} />
        {error && <div className="error" role="alert">{error}</div>}
        <div className="actions">
          <button className="ghost" onClick={props.onClose}>
            {copy.cancel}
          </button>
          <button className="primary" disabled={busy || !title.trim()} onClick={create}>
            {copy.createGroup}
          </button>
        </div>
      </div>
    </div>
  );
}

export function GroupInfoDialog(props: { peerId: number; onClose(): void }) {
  const m = useMessenger();
  const d = m.dialogs.get(props.peerId);
  const group = d?.group;
  const [title, setTitle] = useState(group?.title ?? "");
  const [people, setPeople] = useState<UserSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!group || !m.me) return null;
  const isOwner = group.ownerId === m.me.id;
  const run = async (fn: () => Promise<unknown>, close = false) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (close) props.onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={copy.groupInfo}>
      <div className="modal" style={{ overflowY: "auto" }}>
        <h2>{group.title}</h2>
        <section>
          <div style={{ display: "flex", gap: 8 }}>
            <input type="text" aria-label={copy.groupName} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={64} />
            <button className="ghost" disabled={busy || !title.trim() || title.trim() === group.title} onClick={() => run(() => m.renameGroup(props.peerId, title))}>
              {copy.rename}
            </button>
          </div>
        </section>
        <section>
          <h3>{copy.members(group.members.length)}</h3>
          <ul className="member-list">
            {group.members.map((u) => (
              <li key={u.id}>
                <span className="grow">
                  {u.id === m.me!.id ? `${u.displayName} (${copy.you})` : u.displayName}
                </span>
                {u.id === group.ownerId && <span className="tag">{copy.owner}</span>}
                {isOwner && u.id !== m.me!.id && (
                  <button className="ghost" style={{ padding: "2px 8px" }} disabled={busy} onClick={() => run(() => m.removeMember(props.peerId, u.id))}>
                    {copy.remove}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3>{copy.addPeople}</h3>
          <PeoplePicker selected={people} exclude={group.members.map((u) => u.id)} onChange={setPeople} />
          {people.length > 0 && (
            <button className="primary" disabled={busy} onClick={() => run(async () => {
              await m.addMembers(props.peerId, people.map((u) => u.id));
              setPeople([]);
            })}>
              {copy.addPeople}
            </button>
          )}
        </section>
        {error && <div className="error" role="alert">{error}</div>}
        <div className="actions">
          <button className="danger" disabled={busy} onClick={() => run(() => m.leaveGroup(props.peerId), true)}>
            {copy.leaveGroup}
          </button>
          <button className="ghost" onClick={props.onClose}>
            {copy.close}
          </button>
        </div>
      </div>
    </div>
  );
}
