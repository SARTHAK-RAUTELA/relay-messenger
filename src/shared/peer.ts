// Peer ids address every conversation with one integer, so pins, drafts, read cursors and the
// client caches stay keyed by a single number:
//   id > 0                    a user (one-to-one chat)
//   -SECRET_BASE < id < 0     a group: id = -groupId
//   id <= -SECRET_BASE        a secret chat: id = -(SECRET_BASE + secretChatId)

import type { ChatKind } from "./types";

export const SECRET_BASE = 1_000_000_000;

export function peerKind(peerId: number): ChatKind {
  if (peerId > 0) return "user";
  return peerId > -SECRET_BASE ? "group" : "secret";
}

export const groupPeer = (groupId: number): number => -groupId;
export const groupIdOf = (peerId: number): number => -peerId;
export const secretPeer = (secretId: number): number => -(SECRET_BASE + secretId);
export const secretIdOf = (peerId: number): number => -peerId - SECRET_BASE;

/** Reactions anyone can put on a message (one per person per message). */
export const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"] as const;

export const MAX_GROUP_MEMBERS = 200;
