# Nicotes — Design

Nicotes is a self-hosted notes app somewhere between OneNote and Obsidian: a clear
hierarchy for grouping notes, plus links and tags for connecting them — without the
"everything at once" feeling. Web UI only (installable as a PWA), deployed with
docker-compose.

## Principles

- **One primary axis.** The notebook/page tree is how you navigate. Links, tags and the
  graph are secondary and appear when they are relevant.
- **Progressive disclosure.** Sidebar, page and quick switcher are always there.
  Backlinks, graph, history and metadata are opt-in panels.
- **Markdown is the content format.** The database is the source of truth; every page
  body is Markdown and can be exported as `.md` at any time.
- **Single container.** One image, one `/data` volume, no external services required.
  Optional integrations (OpenRouter, crawl4ai) are enabled by configuration.
- **Multi-user ready.** Single user today, but every owned row carries a `user_id` and
  all access goes through the authenticated session.

## Domain model

```
User ─┬─ Notebook ── Page ── Page (children, any depth)
      │                └── tags, links, attachments
      └─ Tag (optional description = tag hub page)
```

| Entity     | Notes |
|------------|-------|
| Notebook   | Top-level grouping. Title, icon, accent colour, sort order. |
| Page       | Belongs to a notebook, optional `parent_id` for nesting. Markdown `content`, `version` for optimistic concurrency, soft delete via `deleted_at`. |
| Tag        | Many-to-many with pages, normalised names (`Open World` → `open-world`). A tag with a description acts as a hub; unused tags without one are removed automatically. |
| Link       | Index of `[[wikilinks]]` per page, rebuilt on save (and on startup). Stored as written, resolved at read time. |
| Attachment | Files under `/data/attachments/<id>`, embedded in Markdown as `/api/attachments/<id>/<name>`. |

### Example: a games knowledge base

```
Notebook "Games"
├── Elden Ring            #gaming
│   ├── Builds
│   └── Boss notes
└── Factorio              #gaming
    └── Ratios
```

Each game is a page tagged `#gaming`, with sub-articles as child pages. The `#gaming`
tag view lists every game (with its sub-article count) and can carry its own
description, so it acts as the hub. Links like `[[Elden Ring/Builds]]` connect
articles across games or notebooks. Switching on "applies to subpages" for `#gaming`
makes the sub-articles count as tagged too (search, graph filter, organize).

## Architecture

```
┌──────────────── Browser (React SPA / PWA) ────────────────┐
│  React Router · TanStack Query · TipTap ⇄ CodeMirror 6     │
└───────────────────────────┬────────────────────────────────┘
                            │ JSON over HTTP (cookie session)
┌───────────────────────────▼────────────────────────────────┐
│  nicotes server (Node, TypeScript, Hono)                    │
│  • REST API: auth, notebooks, pages, (search, import…)     │
│  • Serves the built SPA                                     │
│  • Import pipeline → crawl4ai (optional) / Readability      │
│                    → OpenRouter (optional)                  │
└───────────────────────────┬────────────────────────────────┘
                            │
             /data/nicotes.db (SQLite, WAL, FTS5)
             /data/attachments/
```

### Repository layout

```
apps/server     Hono API, Drizzle ORM, SQLite, static file serving
apps/web        Vite + React + TypeScript SPA
packages/shared Zod schemas and types shared by server and web
docs/           Design and decision notes
```

npm workspaces; the shared package is consumed as TypeScript source (bundled by Vite
and tsup respectively).

### Backend

- **Hono** on `@hono/node-server`.
- **SQLite** via `better-sqlite3` + **Drizzle ORM**. Migrations are generated with
  drizzle-kit, committed, and applied on startup.
- **Auth:** username + password (scrypt), opaque session token in an `HttpOnly`,
  `SameSite=Lax` cookie; only a hash of the token is stored. CSRF protection: mutating
  API requests must be JSON (or bodiless); multipart uploads must carry
  `X-Requested-With: nicotes`. Neither is possible cross-site without a CORS preflight. On first start an account is created from
  `NICOTES_ADMIN_USER` / `NICOTES_ADMIN_PASSWORD`, or — if those are unset — the UI
  offers a one-time setup screen while no user exists.
- **Concurrency:** page saves send the `version` they were based on; a mismatch returns
  `409` so two tabs never silently overwrite each other.
- **Ordering:** siblings have an integer `sort_order`; a move request names the new
  parent and index and the server renumbers siblings in a transaction.

### Frontend

- **Vite + React + TypeScript**, React Router, TanStack Query.
- **Editor with two views over the same Markdown:**
  - *Visual* — TipTap with `@tiptap/markdown` (formatted as you type).
  - *Source* — CodeMirror 6 with Markdown highlighting.
  The toggle is remembered per browser. Markdown dialect: GFM (tables, task lists,
  strikethrough) + `[[wikilinks]]` + callouts. Round-tripping between views must be
  lossless for that dialect; this is covered by tests.
- **Autosave** with debounce and a visible status (saved / saving / conflict / offline).
- **Theme:** dark, blue/cyan accents, defined as CSS custom properties.
- **Responsive:** sidebar collapses into a drawer on narrow screens.

### Links, tags and search

- **Link targets** are page titles, optionally qualified with ancestor and/or notebook
  titles: `[[Builds]]`, `[[Elden Ring/Builds]]`, `[[Games/Elden Ring/Builds]]`,
  `[[Target|label]]`. Matching is case-insensitive; an exact title wins over a path
  reading. With several candidates, the linking page's notebook wins, then the oldest
  page. Links inside code are ignored. The resolver lives in `packages/shared`, so server
  (backlinks) and web (navigation, autocomplete) always agree.
- **Autocomplete** inserts the shortest unambiguous target. Clicking an unresolved
  (dashed) link creates the page — under the qualifying parent/notebook if given.
- **Rename propagation:** renaming or moving a page, or renaming a notebook, rewrites
  every link whose target's path changed, keeping its qualification depth. Rewritten
  pages get a new version; an open editor without unsaved edits adopts the new text,
  otherwise the usual conflict banner appears.
- **Full-text search** uses an FTS5 table (title weighted 8×) kept in sync by triggers,
  keyed by page id. Every word becomes a quoted prefix term, so user input cannot inject
  FTS syntax; `#tag` words filter by tag.
- **Attachments** (≤ 25 MB) are served with `nosniff` and a sandboxing CSP. Images, PDF
  and plain text display inline; everything else downloads.

### Smart Import

```
URL ─► crawl4ai /crawl (if configured) ─┐
   └─► direct fetch (SSRF-guarded) ─────┴─► JSON-LD · og meta · Readability → Markdown
        ─► Recipe in JSON-LD? ── yes ─► recipe template (no LLM)
                              └─ no ──► LLM: classify (if "Detect") → extract JSON ─► profile template
        ─► no API key / LLM error ─► clip of the page text
   ─► cover image saved as attachment ─► preview (editable) ─► page
```

- **Profiles:** Recipe (ingredients checklist, numbered steps, sections), Article (summary
  + key points, optional full text), Product (specs table, pros/cons), Event, Generic.
  "Detect" uses the JSON-LD `@type`, else a short classification call.
- **LLM:** OpenRouter chat completions in JSON mode; the expected shape is given as a
  TypeScript type in the prompt and validated with Zod, with one corrective retry
  (`z-ai/glm-5.3-flashx` has JSON mode but no strict schema support). Output keeps the
  page's language; page text is capped at 40k characters. Token usage is shown.
- **crawl4ai** (0.9.x, `POST /crawl`, Bearer token, pruning content filter). Readability
  runs on crawl4ai's rendered HTML, which is usually cleaner than its Markdown. If
  crawl4ai fails, the built-in fetcher is used and a warning shown.
- **SSRF protection:** only http(s); every connection (including each redirect hop) goes
  through a DNS lookup that rejects loopback, private, link-local, CGNAT, multicast and
  NAT64 addresses, so DNS rebinding cannot bypass it. Targets handed to crawl4ai are
  checked the same way. 8 MB / 15 s limits. `NICOTES_IMPORT_ALLOW_PRIVATE=true` lifts it.
- **Settings:** per account (`settings` table) with environment variables as defaults;
  API key and crawl4ai token are AES-256-GCM encrypted with `NICOTES_SECRET` or a key file
  generated in the data directory, and never returned to the browser.
- The import page is a route (`/import?url=…`) so the PWA share target can use it.

### History, trash, export and PWA

- **Version history:** `page_versions` snapshots. While editing, the pre-change state is
  saved when the last snapshot is older than 10 minutes; link rewrites and restores
  always snapshot first. Retention: everything from the last 24 h, then the newest per day
  for 90 days, max 200 per page. Restoring replaces the content (not the title, so links
  stay valid) and keeps the replaced text as a version.
- **Trash:** soft-deleted subtrees share one `deleted_at` and appear as one item; pages of a
  deleted notebook come back with it. Restored pages go back under their old parent if it
  still exists, else to the top level. Items are purged after 30 days (hourly job);
  permanent deletion cascades to versions, links and tags.
- **Export:** `GET /api/export[?notebookId]` → zip with one folder per notebook,
  `Page.md` + `Page/` for pages with subpages, YAML frontmatter (id, title, tags,
  created, updated), attachments under `attachments/` with relative links. Opens as an
  Obsidian vault; `[[links]]` stay as written.
- **PWA:** vite-plugin-pwa (Workbox). Precaches only the app shell; other assets are cached
  on first use; `/api` is never served from the cache, so no offline data. The manifest's
  `share_target` points at `/share`, which extracts a URL from `url`, `text` or `title` and
  opens the importer. Installing requires HTTPS (or localhost).

### AI assistants

- **Jobs:** research and organize runs are rows in `jobs`, executed in-process (two at a
  time) with persisted progress, step log and cost; the UI polls them. Runs interrupted by
  a restart are marked failed. Every OpenRouter call reports its cost (`usage.include`);
  a run stops once it exceeds the per-run limit.
- **Reasoning:** GLM 5.3 FlashX cannot turn reasoning off and reasoning tokens count
  against `max_tokens`, so calls use `reasoning.effort = "minimal"` (retrying without
  the setting for models that reject it); the final research write-up uses "low".
- **Organize:** pages are sent in chunks of 30 with short ids (`p1`…), path, tags and
  the first 600 characters, plus the tag vocabulary and possible parents. Replies are
  validated (ids exist, no cycles, no no-op moves, tags normalised, max 3 per page) before
  they become suggestions. Applying runs in one transaction inside `propagateRenames` and
  stores inverse operations in `ai_batches`; Undo replays them in reverse (moves back to
  the old position, tags removed, AI-created group pages trashed if empty).
- **Research:** plan (title, language, queries, localised labels) → search (SearXNG JSON
  API, or the OpenRouter `web` plugin whose `url_citation` annotations carry page text)
  → pick sources (deduplicated, max 2 per site, no video sites) → read via the import
  extractor (crawl4ai / Readability, SSRF-guarded; falls back to the search snippet) →
  per-source notes (skipping irrelevant ones, replacing failures with spare candidates) →
  synthesis with `[n]` markers, turned into links, plus a generated sources list. Saved
  as a page tagged `#research`. Depths: quick 4, standard 8, deep 14 sources.

### Graph, templates and daily notes

- **Graph:** `GET /api/graph` returns resolved page→page links and unresolved targets;
  the client (`lib/graph.ts`) adds subpage edges, tag nodes and missing-page nodes,
  applies notebook/tag filters (inherited tags included) and the focus neighbourhood
  (1–3 hops, crossing notebooks). Rendering uses force-graph on canvas (lazy-loaded) with
  a centre pull and collision force; nodes are coloured by notebook and sized by degree,
  hovering/selecting highlights the neighbourhood. The page view shows a local graph
  (1–2 hops) below the backlinks; the full view lives at `/graph?focus=<id>&depth=n`.
- **Tag inheritance:** a per-tag `inherit` flag. Search's `#tag` filter uses a recursive
  CTE over subpages; the client derives inherited tags from the tree for chips, hubs and
  the graph; organize sees inherited tags so it does not re-suggest them.
- **Templates:** pages tagged `#template`; `applyTemplate` (shared) fills `{{date}}`,
  `{{time}}`, `{{datetime}}`, `{{weekday}}`, `{{title}}` on the client (local time). New
  pages copy the template's tags except `template`.
- **Daily notes:** `daily_notes` maps a local date to a page; `POST /api/daily` finds or
  creates it as notebook › year › month › `YYYY-MM-DD` (sorted by number), in the
  configured notebook or an auto-created "Journal". The client fills in the configured
  template. `/journal` shows a month calendar.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `NICOTES_PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` (`/data` in Docker) | Database and attachments |
| `NICOTES_ADMIN_USER` / `NICOTES_ADMIN_PASSWORD` | — | Bootstrap account on first start |
| `NICOTES_SECURE_COOKIES` | `false` | Set `true` when served over HTTPS |
| `NICOTES_SECRET` | key file in `DATA_DIR` | Encrypts stored API keys |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | —, `z-ai/glm-5.3-flashx` | Import LLM (overridable in Settings) |
| `CRAWL4AI_URL`, `CRAWL4AI_TOKEN` | — | Optional crawl4ai (overridable in Settings) |
| `NICOTES_IMPORT_ALLOW_PRIVATE` | `false` | Allow importing from private networks |
| `SEARXNG_URL` | — | Research search via SearXNG (else OpenRouter web search) |
| `OPENROUTER_RESEARCH_MODEL` | import model | Model for research runs |
| `NICOTES_AI_COST_LIMIT` | `0.5` | USD limit per AI run |

## Roadmap

1. ✅ **Foundation** — monorepo, auth, notebooks + nested page tree (drag & drop), dual
   editor, autosave, dark theme, Docker image + compose.
2. ✅ **Linking** — `[[wikilinks]]` with autocomplete and rename propagation, backlinks,
   tags + tag hubs, Ctrl+K quick switcher, full-text search, attachments, and a
   touch-friendly "Move to…" dialog (native drag & drop does not work on phones).
3. ✅ **Smart Import** — JSON-LD, crawl4ai / Readability, OpenRouter, profiles, preview.
   Builds the shared LLM + fetching layer that phase 5 reuses.
4. ✅ **Safety nets & mobile** — version history (with restore), trash UI, `.md` zip export
   (Obsidian-compatible folders + frontmatter), PWA install + Android share target
   (shares a URL straight into Smart Import). Comes before phase 5 so any change an
   LLM makes to existing pages can be reviewed and undone.
5. ✅ **AI assistants** (on top of phase 3's LLM layer):
   - **Research mode** — the user describes a topic; an LLM searches the web, reads
     sources (crawl4ai / Readability) and compiles a note with citations. Needs a web
     search source (e.g. OpenRouter's web-search plugin or a self-hosted SearXNG);
     runs as a background job with progress, the result lands as a draft page.
   - **LLM grouping & tagging** — for one page or a whole notebook/subtree, suggest
     tags, parent pages or new groups. Default is suggestions to accept/reject; an
     optional auto-apply mode records every change in version history.
6. ✅ **Graph & daily work** — graph view (global + local), tag inheritance, templates,
   daily notes with a journal calendar.
7. **Later** — multi-user, GitLab CI → registry.
