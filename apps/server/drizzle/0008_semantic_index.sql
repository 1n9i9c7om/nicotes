CREATE TABLE `page_chunks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`page_id` text NOT NULL,
	`user_id` text NOT NULL,
	`ord` integer NOT NULL,
	`heading` text DEFAULT '' NOT NULL,
	`text` text NOT NULL,
	`hash` text NOT NULL,
	`vector` blob NOT NULL,
	FOREIGN KEY (`page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `page_chunks_page_idx` ON `page_chunks` (`page_id`);--> statement-breakpoint
CREATE INDEX `page_chunks_user_idx` ON `page_chunks` (`user_id`);--> statement-breakpoint
CREATE TABLE `page_index` (
	`page_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`version` integer NOT NULL,
	`title` text NOT NULL,
	`model` text NOT NULL,
	`indexed_at` integer NOT NULL,
	`cost` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `page_index_user_idx` ON `page_index` (`user_id`);--> statement-breakpoint
CREATE TABLE `page_summaries` (
	`page_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`summary` text NOT NULL,
	`version` integer NOT NULL,
	`model` text NOT NULL,
	`cost` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
