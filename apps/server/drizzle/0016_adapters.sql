CREATE TABLE `adapters` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`config` text NOT NULL,
	`secrets` text,
	`target` text NOT NULL,
	`daily_at` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`page_id` text,
	`last_run_at` integer,
	`last_run_date` text,
	`last_status` text,
	`last_message` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `adapters_user_idx` ON `adapters` (`user_id`);