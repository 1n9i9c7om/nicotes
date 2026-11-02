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
| Task       | Not stored separately: `- [ ]` lines in pages, read on demand and edited in place. |
| Semantic index | Optional embeddings of page passages (`page_chunks`, `page_index`), plus AI summaries (`page_summaries`). |

### Example: a topic hub (here: games)

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
  offers a one-time setup screen while no user exists. The server refuses to start
  rather than create that account with the example password `change-me` or one shorter
  than 8 characters.
- **API tokens** (`tokens.ts`, table `api_tokens`): `nct_` + 32 random bytes, shown once,
  stored as SHA-256 with their last four characters for the list. Sent as
  `Authorization: Bearer`, they sign requests in as their user; `read` tokens are limited
  to GET/HEAD. `/api/settings`, `/api/backups`, `/api/security`, `/api/shares`,
  `/api/reminders` and `/api/tokens` only accept the session (403 for a token), so a token
  can neither read stored AI keys nor the key file, change how the account signs in,
  publish notes, nor make more tokens. Token requests skip the CSRF content-type rule (browsers never send the
  header by themselves). Wrong tokens are rate-limited per IP (20 per 15 minutes);
  `last_used_at` is written at most once a minute. Endpoints for scripts: `docs/API.md`.
- **Calendar feed** (`routes/calendar.ts`): `GET /api/calendar/<token>.ics` with a token of
  scope `calendar` (refused as a bearer token; Settings shows the address once and "New
  address" replaces the old token). It lists open tasks with a due date — the same set as
  the task list, including its tag exclusions — as all-day VEVENTs: SUMMARY is the task as
  plain text, DESCRIPTION/URL link to the page (origin from `X-Forwarded-Proto/Host` behind
  a proxy), CATEGORIES the notebook, UID a hash of page, text and date. Text is escaped and
  lines folded at 75 octets (RFC 5545); unknown tokens get 404 and are rate-limited per IP.
- **Reminders** (`reminders.ts`, `routes/reminders.ts`; tables `push_subscriptions`,
  `reminders_sent`): tasks may carry `⏰ HH:MM` (on the due date) or `⏰ YYYY-MM-DD HH:MM`,
  parsed into `remind` (local time). A per-account time zone (saved from the browser) and an
  optional morning-summary time live in settings. `ReminderService` ticks once a minute:
  open tasks (re-parsed only when pages changed) whose reminder time has come, at most two
  hours late, and the summary of tasks due today plus overdue ones. Each goes out once (key
  in `reminders_sent`, pruned after three days); if every target fails it is retried up to
  five times. Channels: Web Push via `web-push` with a VAPID key pair per account (private
  key encrypted; subscriptions answering 404/410 are dropped; the generated service worker
  loads `push-sw.js` for `push` and `notificationclick`), and Telegram through the user's
  own bot (token in settings or `TELEGRAM_BOT_TOKEN`). Linking a chat needs no public
  address: a one-time code in a `t.me/<bot>?start=<code>` link, read by long polling
  `getUpdates` only while a code waits; a new token unlinks the chat.
- **Shared links** (`routes/shares.ts`, table `shares`): a read-only link to a page (with
  or without its subtree) or a notebook. The 18-byte token is looked up by SHA-256 and also
  stored encrypted (SecretBox), so the owner can copy the link again. `/api/shares` is
  session only; `GET /api/public/shares/<token>` needs no account and returns the live,
  untrashed pages in tree order (pages added later are included). Attachment addresses in
  the Markdown are rewritten to `/api/public/shares/<token>/attachments/<id>`, which serves
  a file only if a shared page links to it (same sandboxed headers as normal downloads).
  Unknown and expired tokens answer 404 and count against a per-IP limit (30 per 15
  minutes); responses are `no-store` with `X-Robots-Tag: noindex`, as is the SPA shell
  under `/s/`. The web app renders `/s/<token>/<page>` outside the sign-in, with TipTap
  read-only and a link bridge that only resolves pages inside the share.
- **Two-step sign-in** (`twoFactor.ts`, `routes/security.ts`; tables `two_factor`,
  `recovery_codes`): TOTP per RFC 6238 (HMAC-SHA1, 30 s, 6 digits, ±1 step), implemented
  with `node:crypto`. The 20-byte secret is encrypted with the SecretBox key; `last_step`
  remembers the step of the last accepted code, so no code works twice. With TOTP on,
  `POST /api/auth/login` answers `{twoFactor, ticket, passkey}` instead of starting a
  session; `POST /api/auth/login/code` finishes with a TOTP or recovery code. Tickets live
  5 minutes in memory and allow 5 wrong codes; wrong TOTP codes also count per account
  (10 per 6 hours, across tickets), recovery codes do not (50 bits each, so guessing is
  hopeless). Ten recovery codes, SHA-256 hashed, deleted when used.
- **Passkeys** (`passkeys.ts`, table `passkeys`, `@simplewebauthn/server`): discoverable
  credentials with user verification required, so a passkey counts as both steps and signs
  in without a username; with a ticket, it replaces the code instead. The RP ID is the host
  name of the request's `Origin`; each passkey stores it and only signs in for that host,
  so a phishing page (other origin, other RP ID) cannot use it. Challenges live 5 minutes in
  memory, keyed by a `flow` id returned with the options. Counter and `last_used_at` are
  updated on use. Algorithms are listed explicitly (EdDSA, ES256, RS256).
- **Sign-in security settings** (`/api/security`, session only): changes need the password
  again, which unlocks them for 10 minutes for that session (in memory), so a session left
  open cannot lock the owner out or add a passkey. `reset-2fa.js <user> [--passkeys]` turns
  TOTP off from the server and ends the account's sessions. API tokens are not affected by
  any of this; they are separate credentials with their own scope.
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
  strikethrough) + `[[wikilinks]]` + callouts + colours. Round-tripping between views must
  be lossless for that dialect; this is covered by tests.
- **Colours** (`packages/shared/src/colors.ts`, `editor/colors.ts`): a fixed palette
  (yellow, orange, red, purple, blue, green) stored as Obsidian writes it — `==text==` for
  the default (yellow) highlight, `<mark style="background: green">` for other highlights,
  `<span style="color: red">` for text colour. Only exactly these tags with palette names
  are recognised; other HTML stays plain text. The names map to theme tones in
  `styles/colors.css`; the read-only renderer shows them too, and plain-text uses
  (excerpts, read-aloud, semantic index) strip them. The full-text index still contains the
  tag words.
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
- **Search in files** (`attachmentText.ts`, table `attachment_text`, FTS table
  `attachments_fts` over file name and text, kept in sync by triggers): a background reader
  looks at every attachment once (after uploads and imports, and every minute for ones it
  has not seen): PDFs through `unpdf` (pdf.js; up to 500 pages, 500k characters, 2 minutes;
  scanned PDFs yield nothing), text files as UTF-8, images only with `readImages` on, sent as
  a data URL to the `images` AI task's model, which writes down the text or describes the
  picture (≤ 10 MB). Turning that on, or changing model or keys, retries images not read
  yet. Search adds file matches for pages whose Markdown still links the file (keeping at
  least a quarter of the results for them); a page matching by its own text is listed once.
- **Attachments** (≤ 25 MB) are served with `nosniff` and a sandboxing CSP. Images, PDF,
  plain text and audio display inline; everything else downloads. Byte ranges (`Range`,
  206/416) are supported, which Safari needs for audio and video.
- **Canvas pages** (`components/CanvasEditor.tsx`, `lib/canvas.ts`, shared `canvas.ts`):
  Excalidraw, loaded on demand (≈340 kB gzip). A canvas page's Markdown is the Obsidian
  Excalidraw format: frontmatter `excalidraw-plugin: parsed` (which marks a canvas; the page
  list reports it as `canvas` from the first 2000 characters), `## Text Elements` with each
  text (and `[[link]]` on shapes) as `text ^elementId` so FTS and the link index see them,
  `## Embedded Files` with `fileId: ![name](attachment url)`, and the scene as
  `compressed-json` (LZString base64, 256-character lines, deleted elements dropped, files
  empty). Images pasted into a canvas are uploaded as attachments on save and fetched into
  the scene when it opens, so page versions stay small. Saves are debounced (Excalidraw
  reports every pointer move); the text tools, summary and assistant are hidden for canvases.
  Export writes `Title.excalidraw.md` with the export fields merged into the drawing's
  frontmatter; the vault import turns `.excalidraw.md` files (Obsidian's, with JSON or
  compressed JSON) back into canvas pages. Fonts are served from `/excalidraw/fonts`; the
  CDN fallback each font names is removed before the FontFace is created (Chrome checks every
  address against the CSP at that point). Shared links show canvases read-only.
- **Voice notes** (`components/VoiceRecorder.tsx`, `editor/audio.ts`, `ai/transcribe.ts`):
  MediaRecorder records Opus in WebM (Chrome, Firefox) or AAC in MP4 (Safari), at most 30
  minutes, uploaded as an attachment and linked as `[🎙️ Voice note (m:ss)](…)` (its own
  paragraph unless the line is empty). Markdown has no audio syntax, so the link stays a
  link; a ProseMirror plugin adds an `<audio>` widget after links to audio attachments
  (keyed by address, so typing does not restart playback; WebM lacks a duration, which the
  player works out by seeking to the end once). Transcription: `POST
  /api/attachments/<id>/transcribe` sends the file to an OpenAI-compatible
  `/audio/transcriptions` (URL, key and model in settings, `TRANSCRIBE_*` env), stores the
  text in `attachment_text` for search, and the editor adds it as a quote below the
  recording.
- **Framing** is refused (`frame-ancestors 'none'`). `NICOTES_BROWSER_EXTENSION=true`
  allows `moz-extension:` and `chrome-extension:` ancestors for the sidebar extension
  (`extension/`): Firefox gives every install a random origin, so it can only be allowed by
  scheme. An installed extension could then frame Nicotes and overlay it (clickjacking),
  which is why it is opt-in.
- **Sidebar extension** (`extension/`, Manifest V3, no build step): a sidebar page
  (Firefox `sidebar_action`, Chrome/Edge `side_panel`) with an iframe of the configured
  address, plus an options page. It requests host access to that site when the address is
  saved: without it the frame is third-party to the extension page, so the `SameSite=Lax`
  session cookie is withheld (Chromium) and signing in does nothing.
- **Extension updates** (Firefox, self-distributed): CI writes `update_url` into the packed
  manifest (`$CI_PAGES_URL/updates.json` or `EXTENSION_UPDATE_URL`) before Mozilla signs it,
  and the `pages` job publishes the signed `.xpi` with `updates.json`
  (`scripts/extension-updates.mjs`: version, link, SHA-256, minimum Firefox under
  `applications` — Firefox does not read `browser_specific_settings` there). Pages rather
  than the package registry or release links, because Firefox fetches anonymously and the
  project is private. The repository's manifest has no `update_url`, so unpacked copies
  don't update. Lint the packed copy with `web-ext lint --self-hosted`.

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
- **Vault import** (`import/vault.ts`): a zip (up to 300 MB; files over 25 MB and hidden
  folders such as `.obsidian` are skipped; a single top folder names the vault) is unpacked
  with fflate and kept in memory for 30 minutes between preview and import. Notes: YAML
  frontmatter (scalars, lists, block text) gives title, tags, created/updated (as the
  export writes them); other properties become `**key:** value` lines; a first `# Heading`
  equal to the title is dropped. Tags come from properties and inline `#tags` outside code.
  Layout: top-level folders → notebooks (or one notebook), subfolders → parent pages, a
  note named like its folder (beside it or inside it) → that parent; alphabetical order.
  Links: `[[Note#Heading|alias]]` → `[[Note|alias]]`, note embeds → links, file embeds and
  relative Markdown links → attachment links (resolved from the note's folder, the vault
  root, then by file name anywhere, like Obsidian), `[x](Note.md)` → `[[Note|x]]`, and links
  by file name to a note with another title are rewritten to the title. Files no note uses
  are listed as skipped. Pages are inserted in one transaction; links are indexed after.

### History, trash, export and PWA

- **Version history:** `page_versions` snapshots. While editing, the pre-change state is
  saved when the last snapshot is older than 10 minutes; link rewrites and restores
  always snapshot first. Retention: everything from the last 24 h, then the newest per day
  for 90 days, max 200 per page. Restoring replaces the content (not the title, so links
  stay valid) and keeps the replaced text as a version.
- **Diffs:** `packages/shared/src/diff.ts` splits a line diff (`diff` package) into hunks —
  contiguous changes — and applies any subset of them (all hunks give the target, none the
  original). The history dialog compares a version with the current text (each hunk can be
  ticked off, so only some changes are restored) or with the version before. Reviewed
  results go through `POST /api/pages/:id/changes` (`content`, `baseVersion`, `reason`),
  which snapshots the current text with that reason and replaces it; a stale
  `baseVersion` is a 409. The AI page assistant uses the same review and endpoint.
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

- **Models per feature:** import, organize, research, ask, summaries and link suggestions
  each resolve their own model (settings > environment variable > the default model), so
  cheap extraction and demanding writing can use different models. Settings shows
  OpenRouter's prices next to each and warns about ids missing from its model list.
- **Services:** chat models run on OpenRouter, Routeway or the user's own
  OpenAI-compatible server (`ai/llm.ts`). A model id `routeway:<id>` goes to
  `https://api.routeway.ai/v1` with the Routeway key, `local:<id>` to
  `<own server address>/chat/completions` (key optional, cost 0, no web search; a 400 about
  JSON mode is retried without `response_format`), anything else to OpenRouter, so each
  feature uses the service of its model and a missing key or address is reported per
  service. Embeddings run on OpenRouter or the own server (`ai/embeddings.ts`); the own
  server's `/models` list is split into chat and embedding models by the word "embed" and
  cached for five minutes. The services differ in options: OpenRouter gets
  `reasoning.effort` and `usage.include` and searches via its `web` plugin; Routeway leaves
  reasoning off unless an effort above "minimal" is asked for, reports streamed usage via
  `stream_options.include_usage`, searches with an `@online` model suffix (links are read
  from the reply when no citations come back) and returns no cost, so the cost is computed
  from its price list. `GET /api/settings/models` merges both public model lists (cached
  for an hour, `refresh=1` reloads; a service that is down is left out and reported) into
  one list with prices, context size and tool / reasoning / free flags for the picker.
  Embeddings stay on OpenRouter.

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
- **Offline research** (`mode: 'offline'`): plan (title, language, labels) → one writing
  call told it cannot search, to flag uncertain or possibly outdated facts and to invent no
  sources; the depth sets length and reasoning effort (low/medium/high). No citations or
  sources list; the footer says it was written without web search, and the result's
  `searchProvider` is `offline`.

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

### Connections, tasks and AI over notes

- **Connections panel:** under each page, one tabbed panel instead of stacked sections:
  backlinks, unlinked mentions, related pages and AI link suggestions; tabs without
  content are hidden.
- **Unlinked mentions** (`shared/mentions.ts`): a title matches as whole words, case-
  insensitively, with the same punctuation between words; one-word titles must also match
  the case of their first letter ("Notes" doesn't claim every "notes"). Code, links, URLs,
  HTML, headings and due dates never match, nor do titles without letters (years, dates).
  Incoming mentions use FTS5 phrase queries as a pre-filter and skip pages that link already;
  outgoing ones skip empty pages and resolve shared titles like a bare link would. Linking
  rewrites the first mention (`[[text]]` or `[[target|text]]`); in other pages the server
  does it and keeps a `relink` version, on the open page the editor does it.
- **Tasks:** `GET /api/tasks` parses `- [ ]` lines of all pages with a checkbox (templates
  and pages tagged with an excluded tag — `recipe` by default — are skipped). Updates send
  page, line and the line as seen; the server refuses a changed line (409), otherwise
  rewrites it and saves a version. Due dates use Obsidian's `📅 YYYY-MM-DD`
  (`due:` / `@` are read too). Quick add fills today's daily note (placeholder task, a
  "Tasks" section, or the end).
- **Semantic index** (opt-in per user, OpenRouter embeddings, default
  `openai/text-embedding-3-small` at 512 dimensions): a background indexer embeds pages
  whose version, title or model changed, once typing has paused for 30 s, in passages of
  ≤ 1200 characters split by heading (title and heading path are embedded with each
  passage; unchanged passages keep their vectors by hash). Vectors live in SQLite and in an
  in-memory copy per user; queries are a linear scan (thousands of passages take
  milliseconds). Results are cut by an absolute floor and by distance to the best hit.
  Switching the index off deletes it.
- **Related pages:** nearest pages by mean passage vector, minus pages already connected
  (links both ways, parent, children); "Link" adds the page to a "See also" section.
- **Chat** (`chat/agent.ts`, `chat/tools.ts`, `chat/routes.ts`, table `chat_messages`):
  an agent with OpenAI-style tool calling (`chatWithTools` in `ai/llm.ts`, not streamed;
  the "Chat" model, task id `ask`, must support tools). Tools reuse the routes' code:
  `search_notes` (FTS incl. files), `search_by_meaning`, `read_page` (by id or title as a
  wikilink; canvas pages give their texts; 12k characters), `list_notebooks`, `list_pages`,
  `create_page`, `append_to_page`, `read_journal`, `write_journal`, `list_tasks` (refs are
  `pageId:line`), `add_task` (today's journal unless a page is named; due date and `⏰`
  reminder), `update_task` (checks the line still matches), `calendar` (≤ 62 days: tasks
  per day, journal days), `start_research`, `research_status`. Arguments are validated
  with the tools' zod schemas (sent as JSON Schema); failures go back to the model as
  `{error}` and show as failed steps. Up to 8 rounds per message, the last with
  `tool_choice: "none"`, and the per-run cost limit applies. The system prompt has the
  date and time in the account's time zone. History: the channel's messages (web and
  Telegram are separate) up to 24k characters; tool traffic is kept only within a turn,
  the steps are stored with the answer for display. `POST /api/chat` streams `user`,
  `action` and `answer` events; `DELETE /api/chat` forgets the conversation.
- **Telegram chat** (`telegram.ts`): once a chat is linked, the reminder service long-polls
  the bot (messages and button presses) and hands updates of the linked chat to
  `TelegramBot`: `/todo` lists open tasks (overdue, today, next 7 days, undated) with a
  button per task (`d:pageId:line:hash of the line`, so a changed task is not ticked by
  mistake), `/calendar` a Monday–Sunday week with « / » buttons (`w:date`, edited in place),
  `/new` resets, voice messages are fetched (`getFile`) and transcribed. Other text goes to
  the chat (channel `telegram`, "typing…" while it works); its Markdown is converted to
  Telegram's HTML (bold, italics, code, lists, links; `[[links]]` point to the app's
  address) and split into 4000-character messages. Other chats are ignored.
- **Read scopes:** what an AI feature may read besides the open page — `page` (nothing),
  `section` (the parent page's subtree; a top-level page's own subtree), `notebook` or
  `all` (`ai/scope.ts`). Retrieval (`ai/retrieve.ts`: passages by meaning when the semantic
  index is on, else full-text search and the sections with the most matching words) takes
  the allowed page ids.
- **Page assistant:** `POST /api/ai/pages/:id/assistant` streams events: steps,
  the context it read (notes within the read scope picked in the panel, which starts at `page`
  every time it opens; optionally a few web
  sources found via SearXNG/OpenRouter and read like Research does), the message, and —
  when it changes the page — the whole rewritten page as a `proposal`. The model writes the
  page after its message between `<<<PAGE` / `PAGE>>>` lines; the server streams only the
  message part and sends the page separately. The request carries the page as the user
  sees it (unsaved edits included). The assistant never writes: the client diffs the
  proposal against the current text, the user picks hunks, and the result is applied via
  `/changes` with reason `assistant`. Notes and web content are marked as data, not
  instructions, in the prompt.
- **Summaries:** 1–3 sentences per page (`page_summaries`), shown above the text and marked
  as outdated once the page version changes.
- **AI link suggestions:** the model gets the page and up to 120 candidates (nearest by
  meaning, or most recent, plus pages it names) and returns phrases to link; each phrase
  must be found in the text outside code and links before it is offered.

### Interactive page views

- **View mode** (next to Visual and Markdown, remembered per page) shows a page in a layout
  that fits its content: **checklist** (tick, add, edit, delete, drag & drop or arrow keys to
  reorder, hide done, undo), **recipe** (servings scale the amounts, ingredients to tick off,
  steps with timers, full-screen cook mode with wake lock; a time range opens a picker that
  starts in the middle, adjustable with −/+ or a slider; cook mode also takes times from the
  lines shown under "You need"), **guide** (steps one at a time),
  **reader** (read aloud with the browser's speech synthesis, sentence and word highlighting,
  position remembered), **charts** (tables of numbers, see below) and **document** (clean read
  view).
- **Blocks:** `shared/blocks.ts` splits Markdown into headings, lists (items with line ranges,
  depth, checkbox state), paragraphs, quotes, code, tables and images. Each block has a key
  from its kind, the headings above it and its position under them (`list:Ingredients:0`), so
  a layout keeps pointing at the right parts while the page is edited.
- **Layout spec:** type, language, servings and block keys for ingredients, steps and checklist
  lists (`shared/layout.ts`). A heuristic picks one instantly (ingredient/step headings in
  several languages, share of checkboxes, amount of prose, numbered lists) with a confidence;
  below 0.75, and with an API key, the AI is asked once (`POST /api/ai/layout/:pageId`). It
  sees one line per block with numbered ids and answers with the type and ids, which the server
  checks and turns into keys; missing parts come from the heuristic. Users can pick a type by
  hand (`PUT`) or go back to automatic (`DELETE`); choices live in `page_layouts`.
- **Lenient recipes:** pages written by Research or copied from elsewhere rarely follow the
  "## Ingredients / ## Steps" shape. Tables count as ingredients (under an ingredients
  heading or with an ingredient column; the amount column is found by its header and scales),
  lists nested under a labelled item ("- **Method:**") are parts of their own
  (`list:Recipe:0>1`, see `subLists`), the hand-picked fallback takes numbered lists after
  the ingredients instead of everything below them, and citation links (`[3](https://…)`)
  are hidden in recipe and guide steps. The AI sees tables and nested lists (`b5.2`) as well.
- **Two-way:** views never render HTML from the model. Their actions are line edits
  (`shared/listEdits.ts`: tick, set text, add, remove, move with nested items) applied to the
  editor's text, so they autosave, show up in version history and can be undone in the view.
  Recipe check-offs and servings are temporary on purpose: cooking should not change the note.

- **Charts** (`shared/charts.ts`, `web/components/layouts/Charts.tsx`): a table's first
  column is the x axis, every column whose cells are mostly numbers a series (decimal commas,
  thousands separators and units like "12.3 kWh" or a header "Solar (kWh)" are understood).
  Dates make a line, anything else bars from zero. Small multiples, one chart per column on
  its own axis, never two scales in one chart; empty cells break the line. Hand-drawn SVG
  (no chart library), sized to its card, with a crosshair and tooltip on hover or touch; the
  table stays below as the exact view. The colours are a fixed categorical order checked for
  colour-blind contrast on the dark surface. The heuristic picks this layout for pages whose
  tables have three or more rows of numbers and little else.

### Adapters

- **What:** per-account connections to other services (`adapters` table) that write a day's
  values into a logbook page or the journal. `type` picks the source, `config` holds its
  plain settings as JSON, `secrets` its tokens as encrypted JSON (`SecretBox`, never sent back;
  the API answers which secret fields are set). The routes (`/api/adapters`) are session
  only, like settings.
- **Sources** (`server/src/adapters/`): `read(ctx)` gets the config, secrets, the day in the
  account's time zone and an injectable `fetch`, and returns values (`label`, `value`,
  `unit`) plus an optional sentence for the journal. Home Assistant reads
  `/api/states/<id>` for each sensor (value, unit, name) and one `/api/history/period` call
  from local midnight for those that take a figure over the day: a time-weighted average,
  minimum, maximum, or the growth of a meter (a drop of more than 10% counts as a reset).
  Weather geocodes the place and reads Open-Meteo's daily forecast for that date. The fields a
  source needs, with labels and help, are described in `shared/adapters.ts`, which the
  settings form is built from.
- **Writers** (`writers.ts`): a logbook is the first table whose first column is "Date";
  the day's row is replaced or inserted in date order, new values add columns, and anything
  else on the page is left alone. Without such a table one is appended. The page is created
  in a "Logbooks" notebook on the first run (again if it was deleted). The journal gets one
  `**<name>:** …` line per adapter, replaced when it runs again. Both save like the editor
  (version, snapshot, link index).
- **Schedule:** a check every minute runs adapters whose daily time has passed and whose
  `last_run_date` is not today; a failed run is retried every 15 minutes that day. A new
  adapter whose time already passed waits for the next day (the settings run it once right
  away). Run now does not count as the day's run, so an evening adapter still records the
  full day.
- **Safety:** an adapter's address is the account's to choose, like the local model server,
  so it may be on the home network. Changing the address requires entering the token again,
  so a stored token cannot be sent somewhere else.

### Backups

- **Archive:** `nicotes-<UTC time>.tar.gz` with `manifest.json` (format version, time,
  whether the key came from `NICOTES_SECRET`), `nicotes.db`, `secret.key` (if the key file
  is used) and `attachments/`. The database copy comes from SQLite's online backup API
  (`better-sqlite3` `db.backup()`), so it is consistent while the app keeps writing.
  tar.gz instead of zip because fflate has no ZIP64 (archives would break at 4 GB) and the
  archive is streamed to disk instead of built in memory. Work files are hidden
  `.….partial` files, renamed into place only when complete.
- **Schedule:** every 10 minutes the server checks whether the newest backup is older than
  `NICOTES_BACKUP_INTERVAL_HOURS` (so restarts and sleep don't skip backups; a manual
  backup resets the clock). After a failure it waits an hour; the error shows in Settings.
- **Retention:** always the newest backup and everything from the last 24 h, then the
  newest per day for `KEEP_DAILY` days and per week for `KEEP_WEEKLY` weeks, counting only
  days/weeks that have backups (a server that was off doesn't lose its old backups).
- **Restore:** offline CLI (`dist/restore.js`): refuses while the server answers on its
  port, unpacks into a staging folder in `DATA_DIR`, checks the manifest and
  `PRAGMA integrity_check`, then moves the current database (with WAL files), attachments
  and key file to `pre-restore-<time>/` and the restored ones into place. Migrations run on
  the next start. No in-app restore: replacing the open database under a running server is
  not worth the risk.
- Backups are instance-wide; any signed-in account can create and download them, which is
  fine while there is one account (multi-user needs an admin role).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `NICOTES_PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` (`/data` in Docker) | Database and attachments |
| `NICOTES_ADMIN_USER` / `NICOTES_ADMIN_PASSWORD` | — | Bootstrap account on first start (not with the example password) |
| `NICOTES_SECURE_COOKIES` | `false` | Set `true` when served over HTTPS |
| `NICOTES_SECRET` | key file in `DATA_DIR` | Encrypts stored API keys |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | —, `z-ai/glm-5.3-flashx` | API key and default model (overridable in Settings) |
| `ROUTEWAY_API_KEY` | — | Routeway key for `routeway:<id>` models (overridable in Settings) |
| `LOCAL_AI_URL` / `LOCAL_AI_KEY` | — | Your own OpenAI-compatible model server (address ending in `/v1`, optional key) for `local:<id>` models (overridable in Settings) |
| `CRAWL4AI_URL`, `CRAWL4AI_TOKEN` | — | Optional crawl4ai (overridable in Settings) |
| `TELEGRAM_BOT_TOKEN` | — | Bot for task reminders in Telegram (overridable in Settings) |
| `NICOTES_IMPORT_ALLOW_PRIVATE` | `false` | Allow importing from private networks |
| `NICOTES_BROWSER_EXTENSION` | `false` | Allow the sidebar extension to show Nicotes in a frame |
| `SEARXNG_URL` | — | Research search via SearXNG (else OpenRouter web search) |
| `OPENROUTER_{IMPORT,ORGANIZE,RESEARCH,ASK,ASSISTANT,SUMMARY,LINKS,LAYOUT,IMAGES}_MODEL` | default model | Model per AI feature (overridable in Settings → AI models) |
| `NICOTES_READ_IMAGES` | `false` | Default for reading images with AI for search (overridable in Settings) |
| `TRANSCRIBE_URL`, `TRANSCRIBE_KEY`, `TRANSCRIBE_MODEL` | —, —, `whisper-1` | OpenAI-compatible transcription service for voice notes (overridable in Settings) |
| `NICOTES_AI_COST_LIMIT` | `0.5` | USD limit per AI run |
| `NICOTES_VERSION`, `NICOTES_BUILD_{REF,COMMIT,DATE}` | package.json version, — | Build information for Settings → About (set by CI as Docker build args) |
| `NICOTES_SEMANTIC_INDEX` | `false` | Default for the semantic index (overridable in Settings) |
| `OPENROUTER_EMBEDDING_MODEL` | `openai/text-embedding-3-small` | Embedding model for the semantic index |
| `NICOTES_BACKUP_DIR` | `DATA_DIR/backups` (`/backups` in Docker) | Where backups are written |
| `NICOTES_BACKUP_PATH` | `nicotes-backups` volume | Docker Compose only: host folder mounted at `/backups` |
| `NICOTES_BACKUP_INTERVAL_HOURS` | `24` | Hours between automatic backups; `0` turns them off |
| `NICOTES_BACKUP_KEEP_DAILY` / `NICOTES_BACKUP_KEEP_WEEKLY` | `7` / `4` | Retention: newest backup per day / per week |

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
7. ✅ **Connections & insight** — connections panel (backlinks, unlinked mentions, related
   pages, AI link suggestions), tasks across pages with due dates, semantic index with
   search by meaning, "Ask your notes" with citations (later replaced by the chat), page
   summaries.
8. ✅ **Hardening** — automatic backups with restore, Playwright end-to-end tests
   (`npm run e2e`), a model per AI feature.
9. ✅ **Interactive views** — checklist, recipe with cook mode, guide, reader with
   read-aloud, chosen by heuristics or the AI and editing the page's Markdown.
10. ✅ **Page assistant & reviewable changes** — chat beside a page that proposes edits to
    that page only, approved hunk by hunk; read scopes for the assistant and Ask; version
    history with diffs against the previous version and partial restore. GitLab CI builds
    images into the registry.
11. **Reach & security** (in progress) — ✅ own model servers (`local:<id>`), ✅ API
    tokens, ✅ calendar feed for tasks, ✅ two-step sign-in and passkeys, ✅ read-only shared
    links, ✅ task reminders (web push, Telegram), ✅ Obsidian vault import, ✅ search inside
    PDFs and images, ✅ voice notes with transcription, ✅ canvas pages (Excalidraw), ✅ a chat
    assistant with tools for every feature (web and Telegram), ✅ adapters that log data
    from other services (Home Assistant, weather), ✅ charts of tables in page views.
12. **Later** — multi-user.
