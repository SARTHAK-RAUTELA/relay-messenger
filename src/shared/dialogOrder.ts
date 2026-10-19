// BR-LIST-1 ordering, shared by server and client.

export interface SortableDialog {
  peerId: number;
  pinned: boolean;
  pinOrder: number | null;
  activityDate: number;
  /** Server-side tie breaker; the client passes 0. */
  touchedAt?: number;
}

export function compareDialogs(a: SortableDialog, b: SortableDialog): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.pinned && b.pinned) {
    const d = (a.pinOrder ?? 0) - (b.pinOrder ?? 0);
    if (d !== 0) return d;
    return b.peerId - a.peerId;
  }
  if (a.activityDate !== b.activityDate) return b.activityDate - a.activityDate;
  const t = (b.touchedAt ?? 0) - (a.touchedAt ?? 0);
  if (t !== 0) return t;
  return b.peerId - a.peerId;
}

/** BR-LIST-2 */
export function activityDate(topDate: number | null | undefined, draft: { text: string; date: number } | null): number {
  const d = draft && draft.text.trim() !== "" ? draft.date : 0;
  return Math.max(topDate ?? 0, d);
}
