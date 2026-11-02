# Developing Nicotes

How to work on Nicotes: setting up, tests, the pipeline and releases. For what Nicotes does
and how to run it, see the [README](../README.md); for how it is built inside, see
[DESIGN.md](DESIGN.md). [CONTRIBUTING.md](../CONTRIBUTING.md) covers how to contribute.

## Setting up

Requires Node 24+.

```bash
npm install
npm run dev        # server on :3000, web on :5180 (proxies /api); loads ./.env
npm test
npm run build      # production build of web + server
```

## Tests

`npm test` runs the unit and API tests of every package plus the extension's tests;
`npm run typecheck` checks the types.

### End-to-end tests

`apps/e2e` drives the real web UI with [Playwright](https://playwright.dev) against the built
server, started on free ports with throwaway data dirs in the system temp folder (one with a
test account from `NICOTES_ADMIN_USER`, one empty for the first-run setup screen, one for the
sign-in security tests). AI features are not covered: the test servers run without an AI key
and all outbound requests go to a dead proxy. Tests that need another service (the Home
Assistant adapter) start a small fake of it in the test process.

```bash
npx playwright install chromium   # once; without it the installed Microsoft Edge is used
npm run e2e                       # builds web + server, then runs all specs
```

Service workers are blocked in the tests, so `offline.spec.ts` covers offline reading,
editing and merging within one page load. Reloading the app offline (served by the service
worker, signed in from the device copy) is worth a manual check when changing
`lib/offline.ts` or the PWA setup: open the built app on its own port, let it copy the
notes, switch the browser's network to offline in the developer tools, reload, edit a page,
then go back online.

After a build, run specs directly with `npm run e2e -w apps/e2e -- tests/editor.spec.ts`
(add `--headed` or `--ui` to watch). Set `E2E_CHANNEL=msedge` (or `chrome`) to pick a
browser. Failures leave a trace in `apps/e2e/test-results`
(`npx playwright show-trace <file>`).

## Dependencies

- **One React:** Excalidraw 0.18 (canvas pages) pins `@radix-ui/react-tabs` 1.0.x, whose
  peer range ends at React 18, so npm would put a React 18 at the top of `node_modules`
  for it and keep the app's React 19 in `apps/web`. The root `package.json` therefore lists
  `react` and `react-dom` 19 as dev dependencies (one React 19 for everything), and Vite
  dedupes them as well. Check `npm ls react` after changing either.
- **Excalidraw's fonts** are copied from the package into `dist/excalidraw/fonts` at build
  time (a small plugin in `apps/web/vite.config.ts`) and served by Nicotes; the CDN it would
  use otherwise is blocked by the CSP.
- **Patched versions inside Excalidraw:** the root `package.json` `overrides` raise `katex`,
  `lodash-es` and `nanoid` to versions without known vulnerabilities. Excalidraw 0.18.1 pins
  older ones (through its Mermaid import), so `npm audit` would flag them otherwise. `npm ls`
  calls the overridden versions "invalid"; that is how npm shows overrides in this workspace
  and does no harm. Remove the overrides once an Excalidraw release ships fixed versions
  (`npm audit --omit=dev` should stay clean). npm does not apply new overrides to the
  existing lockfile: let it resolve a lockfile from the `package.json` files in an empty
  folder and copy the changed entries over.
- **Windows and npm:** `npm install <package>` sometimes drops the `@esbuild/*` entries of
  other platforms from `package-lock.json` (npm/cli#4828). Compare the lockfile with
  `git diff` after adding a dependency and put missing entries back before committing.

## Adding an adapter

An adapter type is a `Source` in `apps/server/src/adapters/` (`read` returns the day's
values; `check` validates its settings) registered in `SOURCES` in `service.ts`, plus its
entry in `ADAPTER_TYPE_INFO` in `packages/shared/src/adapters.ts`: the fields the settings
form shows (`secret` fields are encrypted and never sent back), a description and the default
target and time. Use `getJson` for requests, so network trouble and error statuses become
readable messages, and `ctx.fetch`, so tests can answer with a fake service (see
`apps/server/test/adapters.test.ts`).

## Adding a settings card

The settings page is split into tabs (`TABS` in `apps/web/src/pages/SettingsPage.tsx`), each
with its own component, and the open tab is in the address (`/settings/ai`). Give a new card an
`id` and list it in its tab's `sections`: links like `/settings#models` then open that tab and
scroll to the card, from anywhere in the app.

## Database schema changes

Edit `apps/server/src/db/schema.ts`, then run `npm run db:generate -w apps/server` and commit
the generated migration.

## Branches and releases

- `develop` is where work comes together: every change starts as a feature branch off
  `develop` and is merged back into it.
- A release merges `develop` into `main` and tags it `vX.Y.Z` (bump the `version` fields in the
  `package.json` files first, and add the version to `CHANGELOG.md`, which becomes the
  release notes). Settings → About shows the running version and build.
- The browser extension has its own version in `extension/manifest.json`. Bump it only when
  something in `extension/` changes; releases without changes there reuse the extension
  that is already signed.

## Pull requests from GitHub

[GitHub](https://github.com/1n9i9c7om/nicotes) gets everything from git.nico.software through
a push mirror, which only goes one way and overwrites GitHub's branches with GitLab's. So
rulesets on GitHub block every change to branches and tags except the mirror's own pushes
(its deploy key), and pull requests can't be merged there. Issues and private
vulnerability reports are not affected. To take in pull request 123:

```bash
git fetch https://github.com/1n9i9c7om/nicotes.git pull/123/head:pr-123
git switch develop
git merge --no-ff pr-123
git push origin develop
```

A few minutes later the mirror brings the merge to GitHub, and GitHub marks the pull
request as merged. That only works while the pull request's commits stay as they are, so
merge it as above instead of squashing or rebasing it.

## Pipeline and Docker images

GitLab CI (`.gitlab-ci.yml`) builds the Docker image on a runner with the host's Docker
socket and pushes it to the project's container registry:

| Push | Image tags |
|---|---|
| `develop` | `dev-latest`, `<short-sha>` |
| `main` | `main-latest`, `<short-sha>` |
| tag `v1.2.3` | `v1.2.3` |
| other branches, merge requests | built only, not pushed |

So `main-latest` is always the newest release, and `v1.2.3` pins an older one;
`docker-compose.yml` uses `main-latest` unless `NICOTES_TAG` says otherwise.

## Browser extension in the pipeline

The pipeline packs the browser extension (`extension/`) into a zip, kept as a job artifact
on every pipeline. If that extension version is already released but `extension/`
differs from it, branch pipelines warn and a tag fails: bump the extension's version. A tag
`v1.2.3` (whose `package.json` must say `1.2.3`) then:

- uploads the zip to the project's package registry (generic package `nicotes-extension`,
  the extension's version), unless an earlier release already did;
- with the CI/CD variables `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` (an
  [addons.mozilla.org API key](https://addons.mozilla.org/developers/addon/api/key/), both
  masked and protected, with `v*` tags protected so they get them), has Mozilla sign the
  extension as "On your own" and uploads the signed `.xpi`, which release Firefox installs
  (job `extension:firefox-xpi`). Mozilla signs each version only once, so only a new
  extension version is sent there: when `extension/` did not change (same version as an
  earlier release), the job takes that release's `.xpi` from the package registry and does
  not contact Mozilla;
- creates the GitLab release `Nicotes 1.2.3` once the image is pushed, with that version's
  `CHANGELOG.md` section as its notes and the extension linked;
- publishes the landing page (`site/`, with the logo and screenshots from `docs/`) on the
  project's GitLab Pages, with the signed `.xpi` and an update manifest (`updates.json`)
  next to it; the landing page offers the `.xpi` for Firefox. The packed extension's
  `update_url` points there, so an installed copy updates itself (Firefox checks about once
  a day). Without a signed `.xpi` of the current extension version, the extension files
  already on Pages are kept, so installed copies are never offered an unsigned version.

Firefox checks for updates without signing in, so set **Settings → General → Visibility →
Pages** to "Everyone". Pages must be enabled on the GitLab instance and served over HTTPS
(Firefox ignores `http://` update URLs). If the project's Pages address isn't HTTPS, give
the Pages site a custom domain with HTTPS (Settings → Pages → Domains) and set the CI/CD
variable `EXTENSION_UPDATE_URL` to `https://<that domain>/updates.json`. Without an HTTPS
address, branch builds pack the extension without `update_url` (with a warning) and a tag
that would be signed fails, since a version can only be signed once.

## Landing page

`site/` is the landing page. `scripts/build-site.sh` puts it together with the logo and
screenshots from `docs/` and renews the expiry date in its `.well-known/security.txt`; the
`pages` job publishes it on every release tag (see above).

To update the landing page between releases, run the manual `pages` job in a branch
pipeline (e.g. on `develop`). It publishes the page with the signed extension of the
current extension version if a release signed it, and otherwise keeps the extension files
already on Pages. The job prints the addresses of the page and of `updates.json`, which
must open in a private browser window, without signing in.

To look at the landing page locally, run `sh scripts/build-site.sh public 0.0.0` and open
`public/index.html`.
