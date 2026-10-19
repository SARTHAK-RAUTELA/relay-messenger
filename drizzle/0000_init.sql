CREATE TABLE `dialogs` (
	`owner_id` integer NOT NULL,
	`peer_id` integer NOT NULL,
	`read_inbox_max_id` integer DEFAULT 0 NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`pin_order` integer,
	`unread_mark` integer DEFAULT false NOT NULL,
	`draft_text` text,
	`draft_updated_at` integer,
	`touched_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `peer_id`)
);
--> statement-breakpoint
CREATE TABLE `events` (
	`user_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `seq`)
);
--> statement-breakpoint
CREATE TABLE `message_hidden` (
	`user_id` integer NOT NULL,
	`message_id` integer NOT NULL,
	PRIMARY KEY(`user_id`, `message_id`)
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conv_low` integer NOT NULL,
	`conv_high` integer NOT NULL,
	`sender_id` integer NOT NULL,
	`recipient_id` integer NOT NULL,
	`text` text NOT NULL,
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
CREATE INDEX `messages_conv_idx` ON `messages` (`conv_low`,`conv_high`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_sender_token_uq` ON `messages` (`sender_id`,`client_token`);--> statement-breakpoint
CREATE INDEX `messages_reply_idx` ON `messages` (`reply_to_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`username_lower` text NOT NULL,
	`display_name` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`current_seq` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_lower_uq` ON `users` (`username_lower`);