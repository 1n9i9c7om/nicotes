CREATE TABLE `attachment_text` (
	`attachment_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`status` text NOT NULL,
	`source` text,
	`text` text DEFAULT '' NOT NULL,
	`error` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`attachment_id`) REFERENCES `attachments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `attachment_text_user_idx` ON `attachment_text` (`user_id`,`status`);--> statement-breakpoint
-- Full-text index over attachment file names and the text read from them, kept in sync by
-- triggers on attachment_text (every attachment gets a row there once it has been looked at).
CREATE VIRTUAL TABLE `attachments_fts` USING fts5(
  attachment_id UNINDEXED,
  filename,
  text,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);
--> statement-breakpoint
CREATE TRIGGER `attachments_fts_ai` AFTER INSERT ON `attachment_text` BEGIN
  INSERT INTO attachments_fts(attachment_id, filename, text)
  VALUES (new.attachment_id, (SELECT filename FROM attachments WHERE id = new.attachment_id), new.text);
END;
--> statement-breakpoint
CREATE TRIGGER `attachments_fts_ad` AFTER DELETE ON `attachment_text` BEGIN
  DELETE FROM attachments_fts WHERE attachment_id = old.attachment_id;
END;
--> statement-breakpoint
CREATE TRIGGER `attachments_fts_au` AFTER UPDATE OF text ON `attachment_text` BEGIN
  DELETE FROM attachments_fts WHERE attachment_id = old.attachment_id;
  INSERT INTO attachments_fts(attachment_id, filename, text)
  VALUES (new.attachment_id, (SELECT filename FROM attachments WHERE id = new.attachment_id), new.text);
END;
