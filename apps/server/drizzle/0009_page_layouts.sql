CREATE TABLE `page_layouts` (
	`page_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`spec` text NOT NULL,
	`version` integer NOT NULL,
	`source` text NOT NULL,
	`model` text,
	`cost` real DEFAULT 0 NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
