import { sqliteTable, integer, text, primaryKey, index, uniqueIndex } from "drizzle-orm/sqlite-core";

// Spec section 3. Timestamps are epoch milliseconds stored as integers (portable to Postgres bigint).

export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    username: text("username").notNull(),
    usernameLower: text("username_lower").notNull(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    createdAt: integer("created_at").notNull(),
    currentSeq: integer("current_seq").notNull().default(0),
    lastSeenAt: integer("last_seen_at"),
    deletedAt: integer("deleted_at"),
    /** Required at sign-up; accounts made before emails existed have NULL until set in Settings. */
    email: text("email"),
    emailLower: text("email_lower"),
  },
  (t) => [uniqueIndex("users_username_lower_uq").on(t.usernameLower), uniqueIndex("users_email_lower_uq").on(t.emailLower)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

// One-to-one messages have chat_id NULL and live under (conv_low, conv_high).
// Group and secret-chat messages carry their peer id (src/shared/peer.ts) in chat_id;
// group messages have no recipient.
export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    convLow: integer("conv_low").notNull(),
    convHigh: integer("conv_high").notNull(),
    chatId: integer("chat_id"),
    senderId: integer("sender_id")
      .notNull()
      .references(() => users.id),
    recipientId: integer("recipient_id").references(() => users.id),
    text: text("text").notNull(),
    /** JSON ServiceAction for system messages. */
    service: text("service"),
    createdAt: integer("created_at").notNull(),
    editedAt: integer("edited_at"),
    replyToId: integer("reply_to_id"),
    fwdFromUserId: integer("fwd_from_user_id"),
    fwdFromName: text("fwd_from_name"),
    fwdFromDate: integer("fwd_from_date"),
    clientToken: text("client_token").notNull(),
    deletedForEveryoneAt: integer("deleted_for_everyone_at"),
  },
  (t) => [
    index("messages_conv_idx").on(t.convLow, t.convHigh, t.id),
    index("messages_chat_idx").on(t.chatId, t.id),
    uniqueIndex("messages_sender_token_uq").on(t.senderId, t.clientToken),
    index("messages_reply_idx").on(t.replyToId),
  ],
);

export const messageHidden = sqliteTable(
  "message_hidden",
  {
    userId: integer("user_id").notNull(),
    messageId: integer("message_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.messageId] })],
);

export const messageReactions = sqliteTable(
  "message_reactions",
  {
    messageId: integer("message_id").notNull(),
    userId: integer("user_id").notNull(),
    emoji: text("emoji").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId] })],
);

export const dialogs = sqliteTable(
  "dialogs",
  {
    ownerId: integer("owner_id").notNull(),
    peerId: integer("peer_id").notNull(),
    readInboxMaxId: integer("read_inbox_max_id").notNull().default(0),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    pinOrder: integer("pin_order"),
    unreadMark: integer("unread_mark", { mode: "boolean" }).notNull().default(false),
    draftText: text("draft_text"),
    draftUpdatedAt: integer("draft_updated_at"),
    touchedAt: integer("touched_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.peerId] }), index("dialogs_peer_idx").on(t.peerId)],
);

export const events = sqliteTable(
  "events",
  {
    userId: integer("user_id").notNull(),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: text("payload").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.seq] })],
);

export const blocks = sqliteTable(
  "blocks",
  {
    blockerId: integer("blocker_id").notNull(),
    blockedId: integer("blocked_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.blockerId, t.blockedId] })],
);

export const groups = sqliteTable("groups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  ownerId: integer("owner_id")
    .notNull()
    .references(() => users.id),
  createdAt: integer("created_at").notNull(),
});

export const groupMembers = sqliteTable(
  "group_members",
  {
    groupId: integer("group_id").notNull(),
    userId: integer("user_id").notNull(),
    joinedAt: integer("joined_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] }), index("group_members_user_idx").on(t.userId)],
);

/** Device public keys for secret chats (base64 raw P-256). Private keys never leave the browser. */
export const userKeys = sqliteTable(
  "user_keys",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    publicKey: text("public_key").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("user_keys_user_key_uq").on(t.userId, t.publicKey)],
);

export const secretChats = sqliteTable("secret_chats", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  initiatorId: integer("initiator_id").notNull(),
  responderId: integer("responder_id").notNull(),
  initiatorKey: text("initiator_key").notNull(),
  responderKey: text("responder_key").notNull(),
  createdAt: integer("created_at").notNull(),
});
