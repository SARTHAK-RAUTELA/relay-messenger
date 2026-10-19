"use client";

import type { OutStatus } from "@/client/derive";
import { copy } from "@/client/copy";

/**
 * Original outgoing-status indicator (BR-STATUS-1/4). One SVG whose parts transition in place:
 * sending = rotating open arc, sent = solid dot, read = dot inside a closed ring, failed = "!" badge.
 */
export function StatusIcon({ status }: { status: OutStatus }) {
  const label = copy.statusLabel[status];
  const failed = status === "failed";
  return (
    <span className={`status ${status}`} role="img" aria-label={label} title={label} data-status={status}>
      <svg viewBox="0 0 14 14" aria-hidden="true">
        <circle
          className="ring"
          cx="7"
          cy="7"
          r="5.5"
          fill="none"
          stroke={failed ? "#b3261e" : "#2c5048"}
          strokeWidth="1.5"
          strokeDasharray={status === "sending" ? "20 15" : "40 0"}
          opacity={status === "sent" ? 0 : 1}
        />
        <circle cx="7" cy="7" r={status === "sending" ? 0 : status === "failed" ? 0 : 2.6} fill={status === "read" ? "#f2c14e" : "#2c5048"} />
        {failed && <path d="M7 3.8v3.6M7 9.6v.4" stroke="#b3261e" strokeWidth="1.6" strokeLinecap="round" />}
      </svg>
    </span>
  );
}
