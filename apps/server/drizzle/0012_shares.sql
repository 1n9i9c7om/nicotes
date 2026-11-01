CREATE TABLE `shares` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`target_id` text NOT NULL,
	`include_children` integer DEFAULT false NOT NULL,
	`token_hash` text NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`view_count` integer DEFAULT 0 NOT NULL,
	`last_viewed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shares_token_hash_unique` ON `shares` (`token_hash`);--> statement-breakpoint
CREATE INDEX `shares_user_idx` ON `shares` (`user_id`);--> statement-breakpoint
CREATE INDEX `shares_target_idx` ON `shares` (`target_id`);