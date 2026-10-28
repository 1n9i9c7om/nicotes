# Nicotes

Self-hosted notes that are easy to group and link — somewhere between OneNote and
Obsidian. Web UI only, dark theme, runs as a single Docker container.

See [docs/DESIGN.md](docs/DESIGN.md) for the design and roadmap.

## Run with Docker

```bash
cp .env.example .env   # set NICOTES_ADMIN_USER / NICOTES_ADMIN_PASSWORD
docker compose up -d --build
```

Open http://localhost:3000. Data lives in the `nicotes-data` volume (SQLite database,
attachments and the key that encrypts stored API keys).

### Writing

Pages are Markdown, edited either formatted (**Visual**) or as source (**Markdown**). The
toolbar's highlighter button colours the selected text or its background from a small
palette; colours are stored the way Obsidian writes them (`==highlight==`,
`<mark style="background: green">`, `<span style="color: red">`), so they survive an export.

### Graph, journal and templates

The **Graph** shows how pages connect through `[[links]]`, subpages and tags, filterable
by notebook or tag, with a focus mode around any page; every page also has a small local
graph. **Today** opens the daily note (filed as Journal › year › month, see **Journal** for
the calendar). Any page tagged `#template` can be used for new pages and daily notes, with
`{{date}}`, `{{time}}`, `{{weekday}}` and `{{title}}` placeholders.

### Tasks and connections

Every `- [ ]` checkbox in any page shows up under **Tasks**, grouped by due date
(`📅 2026-10-25` in the text, or pick a date in the list); ticking one off there updates its
page, and new tasks go into today's journal note. Checklists of pages tagged `#recipe` stay
out (Settings → Tasks). Below each page, **Connections** shows backlinks, **unlinked
mentions** (pages that name each other without a link, linked with one click) and, with
the semantic index, **related** pages.

### Interactive views

Next to Visual and Markdown, **View** shows a page the way its content wants to be used: a
checklist to tick and drag around, a recipe with adjustable servings, timers and a
full-screen cook mode, a step-by-step guide, or a reader that reads stories aloud and
highlights the current sentence. The layout is detected automatically; with an OpenRouter
key the AI decides for unclear pages (a fraction of a cent each), and you can always pick one
yourself. Changes made in a view (ticking, adding, reordering) edit the page itself.

In every mode, drag either edge of the page to make it wider or narrower (double-click the
edge to reset); the width is remembered per browser.

### Ask your notes (optional)

With an OpenRouter key, **Ask** answers questions from your own notes with numbered
sources, and the page menu can **summarize** a page or **suggest links** to other pages.
Switch on the **semantic index** (Settings) to find notes by meaning — related pages,
"By meaning" results in search, better answers. It sends the text of your notes to
OpenRouter for embeddings (with the default model a few cents for thousands of pages).
**Ask** searches all notebooks by default; the picker next to the question box limits it to
some of them.

### Page assistant (optional)

**Assistant** in the page bar opens a chat beside the page: ask about it or tell it what to
change ("add a section on costs", "fix the spelling", "translate to German"). It only ever
changes the open page, and only what you approve: proposals arrive as a diff where every
change can be ticked off on its own, like staging hunks in git, and the text before is kept
in the version history ("Before AI changes"). What else it may read you choose in the panel
for each conversation — this page only (where it always starts), its section, its notebook or
all notebooks — and **Web research**
lets it search the web and read a few sources first.

The **version history** shows a version's changes compared with the current text or with
the version before, and can restore only some of the changes.

### Research & organize (optional)

With an OpenRouter key, **Research** answers a question by searching the web, reading the
best sources and writing a note with numbered citations (on pages with citations, **Hide
sources** in the page bar hides the numbers in the text without removing them from the
page). With **Model knowledge only** it searches nothing and the model writes the note from
its own knowledge instead: faster and cheaper, but without sources, and possibly outdated; **Organize with AI** (notebook or
page menu) suggests tags, better parent pages and new groups, which you review before
anything changes, and every applied batch can be undone. Each run shows its cost and stops
at a configurable limit (default $0.50). Under Settings → **AI models** every feature
(import, organize, research, Ask, the page assistant, summaries, link suggestions, layouts)
can use its own model, picked from a searchable list with prices, context size and filters;
unset ones use the default model.

The AI features run on [OpenRouter](https://openrouter.ai) or
[Routeway](https://routeway.ai) (an OpenAI-compatible gateway), or both: add the key of
each service you want under Settings, and every feature uses the service of the model you
pick for it (Routeway models are stored as `routeway:<id>`). The semantic index always
uses OpenRouter for embeddings.

Research searches via [SearXNG](https://docs.searxng.org) if `SEARXNG_URL` is set (the JSON
format must be enabled), otherwise via the web search of the research model's service
(OpenRouter's web plugin or Routeway's `@online`). For a local instance, set
`SEARXNG_SECRET` in `.env` and run:

```bash
docker compose -f compose.searxng.yml up -d
```

### Phone app

Nicotes is a PWA: open it in your phone's browser and choose "Install app" / "Add to Home
Screen" (needs HTTPS, so run it behind a reverse proxy and set
`NICOTES_SECURE_COOKIES=true`). On Android it then appears in the share menu, and shared
links open the importer.

### Backups

Nicotes backs itself up once a day: a consistent copy of the database (taken while it runs),
the attachments and the key file for stored API keys, as one `nicotes-<time>.tar.gz`. It
keeps everything from the last 24 hours and the newest backup of each of the last 7 days
and of each of the last 4 weeks. **Settings → Backups** lists them, makes one on demand and
downloads them. Interval and retention are set with `NICOTES_BACKUP_*` variables (see
`.env.example`).

In Docker, backups go to the `nicotes-backups` volume. To keep them on a NAS or another
disk, point `NICOTES_BACKUP_PATH` in `.env` at a host folder the container's user
(uid 1000) can write to, e.g. `NICOTES_BACKUP_PATH=/mnt/nas/nicotes-backups`. Backups
contain everything, including the key that decrypts stored API keys (unless you set
`NICOTES_SECRET`), so keep them private.

**Restore** replaces all current data. Nothing is deleted: the previous database and
attachments are moved to a `pre-restore-…` folder in the data directory.

```bash
docker compose stop nicotes
docker compose run --rm nicotes node apps/server/dist/restore.js /backups/nicotes-2026-10-20T03-15-00Z.tar.gz
docker compose start nicotes
```

A backup downloaded from Settings can be restored the same way after copying it into the
backup folder. Without Docker, stop the server and run `npm run restore -- <backup file>`
(or `node apps/server/dist/restore.js <backup file>` with a build); it restores into
`DATA_DIR`. Separately, Settings → Export downloads all notes as Markdown (an
Obsidian-compatible vault), handy for reading them without Nicotes.

### Import (optional)

Import turns web pages into notes. It works out of the box for pages with embedded recipe
data and as a plain page clip; summaries and structure need an
[OpenRouter](https://openrouter.ai/keys) API key (default model `z-ai/glm-5.3-flashx`) or a
[Routeway](https://routeway.ai) key with a Routeway model chosen for import.
Keys, model and crawl4ai can be set under **Settings** or via `.env`.

[crawl4ai](https://github.com/unclecode/crawl4ai) is optional and renders JavaScript-heavy
pages. To run one locally, set `CRAWL4AI_TOKEN` in `.env`, then:

```bash
docker compose -f compose.crawl4ai.yml up -d
```

Point Nicotes at it with `CRAWL4AI_URL=http://localhost:11235` (dev) or, if both run in one
compose project, `http://crawl4ai:11235`.

## Development

Requires Node 24+.

```bash
npm install
npm run dev        # server on :3000, web on :5180 (proxies /api); loads ./.env
npm test
npm run build      # production build of web + server
```

### End-to-end tests

`apps/e2e` drives the real web UI with [Playwright](https://playwright.dev) against the built
server, started on free ports with throwaway data dirs in the system temp folder (one with a
test account from `NICOTES_ADMIN_USER`, one empty for the first-run setup screen). AI features
are not covered: the test servers run without an OpenRouter key and all outbound requests
go to a dead proxy.

```bash
npx playwright install chromium   # once; without it the installed Microsoft Edge is used
npm run e2e                       # builds web + server, then runs all specs
```

After a build, run specs directly with `npm run e2e -w apps/e2e -- tests/editor.spec.ts`
(add `--headed` or `--ui` to watch). Set `E2E_CHANNEL=msedge` (or `chrome`) to pick a
browser. Failures leave a trace in `apps/e2e/test-results`
(`npx playwright show-trace <file>`).

Database schema changes: edit `apps/server/src/db/schema.ts`, then
`npm run db:generate -w apps/server` and commit the generated migration.

## Branches, releases and images

- `develop` is where work comes together: every change starts as a feature branch off
  `develop` and is merged back into it.
- A release merges `develop` into `main` and tags it `vX.Y.Z` (bump the `version` fields in the
  `package.json` files first). Settings → About shows the running version and build.

GitLab CI (`.gitlab-ci.yml`) builds the Docker image on a runner with the host's Docker
socket and pushes it to the project's container registry:

| Push | Image tags |
|---|---|
| `develop` | `dev-latest`, `<short-sha>` |
| `main` | `main-latest`, `<short-sha>` |
| tag `v1.2.3` | `v1.2.3` |
| other branches, merge requests | built only, not pushed |

So `main-latest` is always the newest release, and `v1.2.3` pins an older one, e.g.
`image: <registry>/1n9i9c7om/nicotes:main-latest` in docker-compose instead of `build: .`.
