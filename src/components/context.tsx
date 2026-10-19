"use client";

import { createContext, useContext, useSyncExternalStore } from "react";
import type { Messenger } from "@/client/messenger";

export const MessengerContext = createContext<Messenger | null>(null);

/** Subscribes the component to every client state change (batched per tick). */
export function useMessenger(): Messenger {
  const m = useContext(MessengerContext);
  if (!m) throw new Error("MessengerContext missing");
  useSyncExternalStore(m.subscribe, m.getVersion, m.getVersion);
  return m;
}
