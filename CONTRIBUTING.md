# Contributing to Nicotes

Thanks for helping! Bug reports, ideas and merge requests are all welcome.

## Reporting bugs and ideas

Open an [issue](https://git.nico.software/1n9i9c7om/nicotes/-/issues). For a bug, please
include:

- the version (Settings → About shows version and build);
- your browser and device, and whether it happens in the installed phone app or the sidebar;
- what you did, what you expected and what happened instead.

Security problems go in a confidential issue instead, see [SECURITY.md](SECURITY.md).

## Setting up

You need Node 24 or newer.

```bash
npm install
npm run dev        # server on :3000, web on :5180 (proxies /api)
```

`npm run dev` reads `.env` in the repository root if there is one (start from
`.env.example`). Without an account in it, the first visit shows the setup screen.

## Branches

- `develop` is where changes come together. Start your branch from it
  (`feature/<what-it-does>`) and open your merge request against `develop`, not `main`.
- `main` only receives releases, each tagged `vX.Y.Z`. A maintainer bumps the version and
  writes the [changelog](CHANGELOG.md) entry when releasing, so you don't need to.
- If you change anything in `extension/`, bump the extension's own version in
  `extension/manifest.json` (for example `0.4.1` → `0.4.2`); the pipeline warns until you do.
- Keep a merge request to one change. Small ones are reviewed faster.

## Before you open a merge request

```bash
npm run typecheck
npm test               # unit and API tests, plus the extension's tests
npm run e2e            # when you changed the UI: builds, then runs the Playwright tests
```

- New behaviour comes with tests next to the existing ones (`apps/*/test`, `apps/e2e/tests`).
- Database changes: edit `apps/server/src/db/schema.ts`, run
  `npm run db:generate -w apps/server` and commit the generated migration.
- Tests never reach the internet or an AI service; keep it that way, and never commit API
  keys or a `.env`.
- Match the code around your change: its naming, its comments, its style (2 spaces, LF,
  see `.editorconfig`). User-facing text is plain English without jargon.
- Write commit messages as a short sentence in the imperative ("Let the Firefox extension
  update itself"), with details in the body if needed.

## License

Nicotes is licensed under the [AGPL-3.0](LICENSE). By contributing, you agree that your
contribution is licensed under it as well.
