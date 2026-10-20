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
| Tag        | (Phase 2) Many-to-many with pages. A tag can have a description, turning its tag view into a hub. |
| Link       | (Phase 2) Derived from `[[wikilinks]]` on save. Stored by target page id; rendered by title. |
| Attachment | (Phase 2) Files stored under `/data/attachments`, referenced from Markdown. |

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
articles across games or notebooks. Tags can optionally be inherited by descendants so
that searching `#gaming` also finds sub-articles.

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
  `SameSite=Lax` cookie; only a hash of the token is stored. Origin-checked CSRF
  protection on mutating requests. On first start an account is created from
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

### Smart Import (Phase 3)

```
URL ─► fetch ─► 1. schema.org JSON-LD? ─► 2. clean text ─► 3. LLM → JSON ─► 4. template ─► preview ─► page
```

1. **Structured data first.** Many sites embed `schema.org/Recipe` (or Article, Product,
   Event) as JSON-LD. When present it is used directly — free and exact.
2. **Content extraction.** If `CRAWL4AI_URL` is configured, the self-hosted crawl4ai
   service fetches and renders the page (handles JS-heavy sites) and returns Markdown.
   Otherwise the server fetches the HTML itself and extracts the main content with
   Mozilla Readability.
3. **LLM via OpenRouter** (`OPENROUTER_API_KEY`, configurable model). Content is mapped
   to an *import profile* schema and validated with Zod; one retry on invalid output.
4. **Template.** Each profile renders to Markdown — e.g. *Recipe*: ingredients as a
   checklist first, then numbered steps. Source URL, import date and image are kept.

Profiles: Recipe, Article (summary + key points), Product, Event, Generic. Detected from
JSON-LD `@type` or an LLM guess; always overridable. Fallback: paste text/HTML manually.

Safety: server-side fetching only (API keys never reach the browser); block private /
loopback / link-local addresses (SSRF) unless explicitly allowed; size and time limits;
token cap per import. Android PWA share target posts URLs straight into the importer.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `NICOTES_PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` (`/data` in Docker) | Database and attachments |
| `NICOTES_ADMIN_USER` / `NICOTES_ADMIN_PASSWORD` | — | Bootstrap account on first start |
| `NICOTES_SECURE_COOKIES` | `false` | Set `true` when served over HTTPS |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | — | Smart Import LLM (Phase 3) |
| `CRAWL4AI_URL`, `CRAWL4AI_TOKEN` | — | Optional crawl4ai extraction (Phase 3) |

## Roadmap

1. **Foundation** — monorepo, auth, notebooks + nested page tree (drag & drop), dual
   editor, autosave, dark theme, Docker image + compose.
2. **Linking** — `[[wikilinks]]` with autocomplete and rename propagation, backlinks,
   tags + tag hubs, Ctrl+K quick switcher, full-text search, attachments, and a
   touch-friendly "Move to…" dialog (native drag & drop does not work on phones).
3. **Smart Import** — JSON-LD, crawl4ai / Readability, OpenRouter, profiles, preview.
4. **Polish** — PWA install + share target, `.md` zip export (Obsidian-compatible
   folders + frontmatter), trash UI, version history.
5. **Later** — local graph, daily notes, templates, multi-user, GitLab CI → registry.
