# Nicotes

Self-hosted notes that are easy to group and link — somewhere between OneNote and
Obsidian. Web UI only, dark theme, runs as a single Docker container.

See [docs/DESIGN.md](docs/DESIGN.md) for the design and roadmap.

## Run with Docker

```bash
cp .env.example .env   # set NICOTES_ADMIN_USER / NICOTES_ADMIN_PASSWORD
docker compose up -d --build
```

Open http://localhost:3000. Data lives in `./data` (SQLite database + attachments).

## Development

Requires Node 24+.

```bash
npm install
npm run dev        # server on :3000, web on :5180 (proxies /api)
npm test
npm run build      # production build of web + server
```

Database schema changes: edit `apps/server/src/db/schema.ts`, then
`npm run db:generate -w apps/server` and commit the generated migration.
