ALTER TABLE `users` ADD `email` text;--> statement-breakpoint
ALTER TABLE `users` ADD `email_lower` text;--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_lower_uq` ON `users` (`email_lower`);