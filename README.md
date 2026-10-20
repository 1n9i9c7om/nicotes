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

### Phone app

Nicotes is a PWA: open it in your phone's browser and choose "Install app" / "Add to Home
Screen" (needs HTTPS, so run it behind a reverse proxy and set
`NICOTES_SECURE_COOKIES=true`). On Android it then appears in the share menu, and shared
links open the importer.

### Backups

Settings → Export downloads all notes as Markdown (an Obsidian-compatible vault, including
attachments). For full backups, copy the `nicotes-data` volume.

### Import (optional)

Import turns web pages into notes. It works out of the box for pages with embedded recipe
data and as a plain page clip; summaries and structure need an
[OpenRouter](https://openrouter.ai/keys) API key (default model `z-ai/glm-5.3-flashx`).
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

Database schema changes: edit `apps/server/src/db/schema.ts`, then
`npm run db:generate -w apps/server` and commit the generated migration.
