CREATE TABLE `blocks` (
	`blocker_id` integer NOT NULL,
	`blocked_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`blocker_id`, `blocked_id`)
);
--> statement-breakpoint
CREATE TABLE `group_members` (
	`group_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`joined_at` integer NOT NULL,
	PRIMARY KEY(`group_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `group_members_user_idx` ON `group_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`owner_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `message_reactions` (
	`message_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`emoji` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`message_id`, `user_id`)
);
--> statement-breakpoint
CREATE TABLE `secret_chats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`initiator_id` integer NOT NULL,
	`responder_id` integer NOT NULL,
	`initiator_key` text NOT NULL,
	`responder_key` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`public_key` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_keys_user_key_uq` ON `user_keys` (`user_id`,`public_key`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conv_low` integer NOT NULL,
	`conv_high` integer NOT NULL,
	`chat_id` integer,
	`sender_id` integer NOT NULL,
	`recipient_id` integer,
	`text` text NOT NULL,
	`service` text,
	`created_at` integer NOT NULL,
	`edited_at` integer,
	`reply_to_id` integer,
	`fwd_from_user_id` integer,
	`fwd_from_name` text,
	`fwd_from_date` integer,
	`client_token` text NOT NULL,
	`deleted_for_everyone_at` integer,
	FOREIGN KEY (`sender_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipient_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_messages`("id", "conv_low", "conv_high", "sender_id", "recipient_id", "text", "created_at", "edited_at", "reply_to_id", "fwd_from_user_id", "fwd_from_name", "fwd_from_date", "client_token", "deleted_for_everyone_at") SELECT "id", "conv_low", "conv_high", "sender_id", "recipient_id", "text", "created_at", "edited_at", "reply_to_id", "fwd_from_user_id", "fwd_from_name", "fwd_from_date", "client_token", "deleted_for_everyone_at" FROM `messages`;--> statement-breakpoint
DROP TABLE `messages`;--> statement-breakpoint
ALTER TABLE `__new_messages` RENAME TO `messages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `messages_conv_idx` ON `messages` (`conv_low`,`conv_high`,`id`);--> statement-breakpoint
CREATE INDEX `messages_chat_idx` ON `messages` (`chat_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_sender_token_uq` ON `messages` (`sender_id`,`client_token`);--> statement-breakpoint
CREATE INDEX `messages_reply_idx` ON `messages` (`reply_to_id`);--> statement-breakpoint
ALTER TABLE `users` ADD `last_seen_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `deleted_at` integer;--> statement-breakpoint
CREATE INDEX `dialogs_peer_idx` ON `dialogs` (`peer_id`);