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
  },
  (t) => [uniqueIndex("users_username_lower_uq").on(t.usernameLower)],
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

export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    convLow: integer("conv_low").notNull(),
    convHigh: integer("conv_high").notNull(),
    senderId: integer("sender_id")
      .notNull()
      .references(() => users.id),
    recipientId: integer("recipient_id")
      .notNull()
      .references(() => users.id),
    text: text("text").notNull(),
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
  (t) => [primaryKey({ columns: [t.ownerId, t.peerId] })],
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
