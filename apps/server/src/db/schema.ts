import {
  blob,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const sessions = sqliteTable(
  'sessions',
  {
    /** SHA-256 of the session token; the token itself only lives in the cookie. */
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const notebooks = sqliteTable(
  'notebooks',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    icon: text('icon'),
    color: text('color'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [index('notebooks_user_idx').on(t.userId, t.sortOrder)],
);

export const pages = sqliteTable(
  'pages',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    notebookId: text('notebook_id')
      .notNull()
      .references(() => notebooks.id, { onDelete: 'cascade' }),
    parentId: text('parent_id').references((): AnySQLiteColumn => pages.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
    content: text('content').notNull().default(''),
    version: integer('version').notNull().default(1),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    index('pages_user_idx').on(t.userId),
    index('pages_tree_idx').on(t.notebookId, t.parentId, t.sortOrder),
  ],
);

/** Outgoing `[[wikilinks]]` per page, rebuilt on every content save. Resolved at read time. */
export const pageLinks = sqliteTable(
  'page_links',
  {
    sourceId: text('source_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Target exactly as written, e.g. `Elden Ring/Builds`. */
    target: text('target').notNull(),
    /** Normalised last path segment, for backlink lookups. */
    targetKey: text('target_key').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sourceId, t.target] }), index('page_links_key_idx').on(t.userId, t.targetKey)],
);

export const tags = sqliteTable(
  'tags',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Normalised name (see normalizeTag). */
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    color: text('color'),
    /** When set, subpages of a tagged page count as tagged too (search, hubs, graph). */
    inherit: integer('inherit', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('tags_user_name_idx').on(t.userId, t.name)],
);

export const pageTags = sqliteTable(
  'page_tags',
  {
    pageId: text('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.tagId] }), index('page_tags_tag_idx').on(t.tagId)],
);

export const attachments = sqliteTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    pageId: text('page_id').references(() => pages.id, { onDelete: 'set null' }),
    filename: text('filename').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('attachments_user_idx').on(t.userId)],
);

/** Per-user key/value settings. Secret values are stored encrypted (see secrets.ts). */
export const settings = sqliteTable(
  'settings',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: text('value').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

/** Snapshots of a page's earlier states (see versions.ts for when they are taken). */
export const pageVersions = sqliteTable(
  'page_versions',
  {
    id: text('id').primaryKey(),
    pageId: text('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    content: text('content').notNull(),
    /** Why the snapshot was taken: 'edit' | 'relink' | 'restore'. */
    reason: text('reason').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('page_versions_page_idx').on(t.pageId, t.createdAt)],
);

/** Long-running AI work (research, organize) with progress, run in-process. */
export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    /** queued | running | done | failed | cancelled */
    status: text('status').notNull(),
    input: text('input').notNull(),
    progress: text('progress').notNull().default('{}'),
    result: text('result'),
    error: text('error'),
    cost: real('cost').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('jobs_user_idx').on(t.userId, t.createdAt)],
);

/** Applied AI suggestions, with the inverse operations needed to undo them. */
export const aiBatches = sqliteTable('ai_batches', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  jobId: text('job_id').references(() => jobs.id, { onDelete: 'set null' }),
  summary: text('summary').notNull(),
  undo: text('undo').notNull(),
  createdAt: integer('created_at').notNull(),
  undoneAt: integer('undone_at'),
});

/** Which page is the daily note for a date (survives renames and moves). */
export const dailyNotes = sqliteTable(
  'daily_notes',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Local date, YYYY-MM-DD. */
    date: text('date').notNull(),
    pageId: text('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.date] })],
);

/**
 * Semantic index: embedding vectors of page chunks (unit length, float32). Only filled when the
 * user enabled it; rebuilt per page when its version, title or the embedding model changes.
 */
export const pageChunks = sqliteTable(
  'page_chunks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    pageId: text('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ord: integer('ord').notNull(),
    heading: text('heading').notNull().default(''),
    text: text('text').notNull(),
    /** Hash of model + embedded input, to reuse vectors of unchanged chunks. */
    hash: text('hash').notNull(),
    vector: blob('vector', { mode: 'buffer' }).notNull(),
  },
  (t) => [index('page_chunks_page_idx').on(t.pageId), index('page_chunks_user_idx').on(t.userId)],
);

/** Which state of a page the semantic index holds. */
export const pageIndex = sqliteTable(
  'page_index',
  {
    pageId: text('page_id')
      .primaryKey()
      .references(() => pages.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    title: text('title').notNull(),
    model: text('model').notNull(),
    indexedAt: integer('indexed_at').notNull(),
    /** USD spent on embeddings for this page so far. */
    cost: real('cost').notNull().default(0),
  },
  (t) => [index('page_index_user_idx').on(t.userId)],
);

/** AI summaries of pages, shown above their content; `version` tells whether they are stale. */
export const pageSummaries = sqliteTable('page_summaries', {
  pageId: text('page_id')
    .primaryKey()
    .references(() => pages.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  summary: text('summary').notNull(),
  version: integer('version').notNull(),
  model: text('model').notNull(),
  cost: real('cost').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});
