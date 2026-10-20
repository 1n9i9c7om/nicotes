-- Full-text index over page titles and content, kept in sync by triggers.
-- Keyed by page id (not rowid): rowids of tables without an INTEGER PRIMARY KEY may change on VACUUM.
CREATE VIRTUAL TABLE `pages_fts` USING fts5(
  page_id UNINDEXED,
  title,
  content,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);
--> statement-breakpoint
CREATE TRIGGER `pages_fts_ai` AFTER INSERT ON `pages` BEGIN
  INSERT INTO pages_fts(page_id, title, content) VALUES (new.id, new.title, new.content);
END;
--> statement-breakpoint
CREATE TRIGGER `pages_fts_ad` AFTER DELETE ON `pages` BEGIN
  DELETE FROM pages_fts WHERE page_id = old.id;
END;
--> statement-breakpoint
CREATE TRIGGER `pages_fts_au` AFTER UPDATE OF title, content ON `pages` BEGIN
  DELETE FROM pages_fts WHERE page_id = old.id;
  INSERT INTO pages_fts(page_id, title, content) VALUES (new.id, new.title, new.content);
END;
--> statement-breakpoint
INSERT INTO pages_fts(page_id, title, content) SELECT id, title, content FROM pages;
