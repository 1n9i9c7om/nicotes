<div align="center">

<img src="docs/brand/logo.svg" alt="Nicotes" height="72">

**Self-hosted notes that are easy to group and link, somewhere between OneNote and Obsidian.**

[![Pipeline](https://img.shields.io/gitlab/pipeline-status/1n9i9c7om%2Fnicotes?gitlab_url=https%3A%2F%2Fgit.nico.software&branch=main&logo=gitlab&label=pipeline)](https://git.nico.software/1n9i9c7om/nicotes/-/pipelines)
[![Latest release](https://img.shields.io/gitlab/v/release/1n9i9c7om%2Fnicotes?gitlab_url=https%3A%2F%2Fgit.nico.software&sort=semver&label=release)](https://git.nico.software/1n9i9c7om/nicotes/-/releases)
[![Docker](https://img.shields.io/badge/runs%20on-Docker-2496ED?logo=docker&logoColor=white)](#quick-start)
[![Node 24+](https://img.shields.io/badge/node-24%2B-5FA04E?logo=nodedotjs&logoColor=white)](docs/DEVELOPMENT.md)
[![React + TypeScript](https://img.shields.io/badge/React-TypeScript-3178C6?logo=typescript&logoColor=white)](docs/DEVELOPMENT.md)
[![PWA](https://img.shields.io/badge/PWA-installable-5A0FC8?logo=pwa&logoColor=white)](#phone-app)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

[Website](https://pages.nico.software/1n9i9c7om/nicotes/) · [Quick start](#quick-start) · [Features](#features) · [Releases](https://git.nico.software/1n9i9c7om/nicotes/-/releases) · [Changelog](CHANGELOG.md) · [Design & roadmap](docs/DESIGN.md)

<img src="docs/images/editor.png" alt="A page in Nicotes: notebooks and pages on the left, a formatted page with a table, tasks and links on the right" width="900">

</div>

## Why Nicotes?

OneNote gives you notebooks and pages but few connections between them. Obsidian gives
you links and a graph, but a folder of files can be a lot to keep in order. Nicotes tries to
sit in between: a calm web app where notes live in **notebooks and nested pages**, and
**links, tags and a graph** connect them across notebooks, without having to plan any of
it upfront.

- 🗂️ **Notebooks and subpages** you can drag around, with colours, tags and a full-text search (<kbd>Ctrl</kbd> <kbd>K</kbd>).
- 🔗 **`[[Links]]`, backlinks and a graph**, plus unlinked mentions that turn into links with one click, and pages embedded in other pages.
- ✅ **Every checkbox in one task list**, grouped by due date, with repeating tasks, reminders (on your phone or in Telegram) and a daily journal note.
- 🍳 **Pages that know what they are**: recipes with servings and timers, checklists, step-by-step guides, a read-aloud reader, charts of tables.
- 🤖 **Optional AI** through OpenRouter, Routeway or your own model server (Ollama, LM Studio …): a chat that works with your notes (also in Telegram), web research, and a page assistant whose changes you review like a diff.
- 📱 **On every screen**: installable on your phone, readable and editable offline, and in the sidebar of Firefox, Chrome and Edge.
- 📈 **Logbooks that fill themselves**: adapters bring in Home Assistant sensors or the weather every day, drawn as charts.
- 💾 **Your data, on your server**: one container, daily backups, an Obsidian vault import, a Markdown export that opens in Obsidian, and print or PDF of any page.
- ✏️ **Canvas pages** to draw, sketch and arrange freely, and **voice notes** that write themselves down.
- 🔗 **Read-only links** to a page or a notebook, for people without an account.
- 🔐 **Locked down**: two-step sign-in with an authenticator app, and passkeys.

<table>
  <tr>
    <td width="50%"><img src="docs/images/graph.png" alt="The graph of pages, coloured by notebook"><br><sub><b>Graph</b>: how pages connect through links, subpages and tags.</sub></td>
    <td width="50%"><img src="docs/images/recipe.png" alt="A recipe in the interactive view with servings and timers"><br><sub><b>View</b>: a recipe with adjustable servings, timers and a cook mode.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/tasks.png" alt="Tasks from all pages grouped by due date"><br><sub><b>Tasks</b>: every checkbox from every page, grouped by due date.</sub></td>
    <td width="50%">
      <img src="docs/images/phone-journal.png" alt="The daily journal note on a phone" width="31%">
      <img src="docs/images/phone-checklist.png" alt="A packing list in the checklist view on a phone" width="31%">
      <img src="docs/images/phone-drawer.png" alt="The navigation drawer on a phone" width="31%">
      <br><sub><b>Phone</b>: the same app, laid out for small screens.</sub>
    </td>
  </tr>
</table>

## Quick start

All you need is Docker with Compose. In an empty folder, e.g. `/opt/nicotes`:

```bash
curl -fsSLO https://git.nico.software/1n9i9c7om/nicotes/-/raw/main/docker-compose.yml
curl -fsSL https://git.nico.software/1n9i9c7om/nicotes/-/raw/main/.env.example -o .env
nano .env              # choose NICOTES_ADMIN_USER and your own NICOTES_ADMIN_PASSWORD
docker compose up -d
```

Open http://localhost:3000 and sign in. Nicotes refuses to start with the example
password, so pick your own. `.env` starts with three required settings: that account and
whether you reach Nicotes over HTTPS. Everything after them is optional and commented out;
most of it can also be set later under Settings in the app. Data lives in the
`nicotes-data` volume (SQLite database, attachments and the key that encrypts stored API
keys); see [Backups](#backups).

**Updating:** `docker compose pull && docker compose up -d`. The image comes from the
project's container registry (`registry.nico.software/1n9i9c7om/nicotes`):

| Tag | What it is |
|---|---|
| `main-latest` | the newest release (default) |
| `v0.4.0` | one particular release; set `NICOTES_TAG=v0.4.0` in `.env` to stay on it |
| `dev-latest` | the current `develop` build, for testing only |

**Over the internet,** put Nicotes behind a reverse proxy that serves HTTPS (Caddy,
Traefik, nginx …), publish the port on localhost only (`127.0.0.1:3000:3000` in
`docker-compose.yml`) and set `NICOTES_SECURE_COOKIES=true` in `.env`. HTTPS is also what
lets you install it on your phone.

**From source:** clone the repository and run `docker compose up -d --build` in it, which
builds the image from your checkout instead of pulling it.

## Features

### Writing

Pages are Markdown, edited either formatted (**Visual**) or as source (**Markdown**). The
toolbar's highlighter button colours the selected text or its background from a small
palette; colours are stored the way Obsidian writes them (`==highlight==`,
`<mark style="background: green">`, `<span style="color: red">`), so they survive an export.

**Canvas pages:** **New canvas** on a notebook's page (or in a notebook's or page's ⋯ menu) makes a page to draw on, as
in OneNote: pen and highlighter (with pen pressure), shapes, arrows, text and pasted
images, powered by [Excalidraw](https://excalidraw.com). Text on a canvas is found by
search, `[[Page]]` links on shapes open that page, and canvases export (and import) as
Obsidian Excalidraw drawings.

**Drawings in a page:** the pen button in the toolbar adds a drawing where the cursor is. It
opens over the page; **Done** brings you back, with the drawing shown as a picture in the
text (and on paper when you print). Click the picture to draw on. A drawing is a canvas
subpage of the page, embedded with `![[Drawing 1]]`, so `![[…]]` shows any other canvas as a
picture too.

**Voice notes:** the microphone button in the toolbar records straight into the page (the
recording is kept as an attachment, with a player). With a transcription service set up
under Settings → Integrations → **Voice notes**, what you said is written below it too: your own Whisper
server (such as [Speaches](https://speaches.ai)), or Groq or OpenAI with a key. Recording
needs HTTPS (or localhost).

**Embeds:** `![[Page]]` on a line of its own shows another page inside this one, and
`![[Page#Heading]]` just the part under that heading, as in Obsidian. Type `![[`, pick the
page and add `#Heading` if you like. The embedded text stays up to date with its page and is
edited there: its title above the embed opens it. `[[Page#Heading]]` links work too.

**Print or save as PDF** from a page's ⋯ menu (or <kbd>Ctrl</kbd> <kbd>P</kbd>) prints the page
alone, on white: in the view you are using, so a recipe, a guide or a logbook's charts print
as you see them, and a canvas prints as a sharp drawing of everything on it. "Save as PDF" in
the print dialog makes a PDF named after the page.

Search (<kbd>Ctrl</kbd> <kbd>K</kbd>) also looks inside the PDFs and text files your pages
show. Photos and scanned images can be searched too once you turn on **Read images with AI**
under Settings → Notes & tasks → Search in files: each image is then sent once to an AI model of your choice
(or one on your own server), which writes down its text or says what it shows.

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
out (Settings → Notes & tasks → Tasks). Under Settings → Notes & tasks → **Calendar
subscription** you get a secret
address for Google Calendar, Apple Calendar, Thunderbird and the like: open tasks with a due
date show up there as all-day events.

**Recurring tasks:** add a rule like `🔁 every week`, `🔁 every monday, thursday`,
`🔁 every month on the 1st` or `🔁 every 2 weeks when done` (counted from the day you tick it
off). Ticking one off, wherever you do it, adds the next one above it with the due date moved
on; the ticked one stays as a record. This is the syntax of Obsidian's Tasks plugin, so
imported vaults keep working.

**Reminders:** write `⏰ 09:00` after a task with a due date (or `⏰ 2026-11-04 09:00` after
any task) to be reminded then, and/or get summaries of your tasks at set times every day:
the first (say in the morning) lists what's due today, later ones (say in the evening)
what's still open today and what's due tomorrow.
Settings → Integrations → **Reminders** sends them as notifications to your phone or computer (on iPhone
and iPad, add Nicotes to the Home Screen first) and/or to Telegram through a bot of your
own: ask [@BotFather](https://t.me/BotFather) for one, paste its token, then press Start in
the chat Nicotes opens. Notifications need HTTPS; Telegram needs nothing but the token. The
bot only answers the Telegram account that connected it, in a private chat with it. Links in
its messages point to the address you opened these settings at; set `NICOTES_BASE_URL` in
`.env` (e.g. `https://notes.example.com`) to choose it yourself.

Below each page, **Connections** shows backlinks, **unlinked
mentions** (pages that name each other without a link, linked with one click) and, with
the semantic index, **related** pages.

### Interactive views

Next to Visual and Markdown, **View** shows a page the way its content wants to be used: a
checklist to tick and drag around, a recipe with adjustable servings, timers (for a range
like "20–30 minutes" you pick the time, starting in the middle) and a full-screen cook mode, a step-by-step guide, a reader that reads stories aloud and
highlights the current sentence, or **charts** of tables of numbers (a chart per column,
with the value of each day on hover). The layout is detected automatically; with an AI
service set up (see below), the AI decides for unclear pages (a fraction of a cent each),
and you can always pick one yourself. Changes made in a view (ticking, adding, reordering) edit the page itself.

In every mode, drag either edge of the page to make it wider or narrower (double-click the
edge to reset); the width is remembered per browser.

### Adapters

Settings → Integrations → **Adapters** brings data from other services into your notes once a day:

- **Home Assistant:** sensor values of the day, such as solar energy produced, the average
  outdoor temperature or the electricity drawn from the grid. Enter your Home Assistant
  address and a long-lived access token (your profile → Security), then one sensor per line:
  `sensor.solar_energy_today, Solar`, optionally followed by `average`, `min`, `max` or
  `change` (how much a meter grew that day) instead of the value at that moment.
- **Weather:** the day's forecast from [Open-Meteo](https://open-meteo.com) for a place you
  name (no account needed): weather, high and low, rain, sunshine and wind.

Each adapter writes into a **logbook**, a page in the "Logbooks" notebook with a table that
gets a row per day (its View draws the columns as charts), or a line in the day's **journal**
note. It runs every day at the time you choose, and **Run now** fetches today's values at
once. Logbooks are ordinary pages: you can write around the table, and keep logbooks of your
own (weight, meter readings) that show as charts too.

### Sharing

**Share…** in a page's or notebook's ⋯ menu creates a read-only link: anyone who has it can
read the page (with its subpages, if you like) or the whole notebook, without an account,
and nothing else. Links between shared pages work; links to anything else show as plain
text. A link can expire after a day, a week or 30 days, and can be turned off at any time.
Shared pages show a **Shared** button, and Settings → Account → **Shared links** lists every link
with how often it was opened. Shared pages stay out of search engines.

### Chat (optional)

**Chat**, right below search, is an assistant that uses Nicotes for you. Ask it about your
notes or tell it what to do, in your own words: *"What's due this week?"*, *"Remind me to
call the dentist tomorrow at 9"*, *"Note in my journal that the heating was fixed"*,
*"What did I write about the car?"*, *"Research heat pumps for old houses"*. It searches
and reads pages, writes, moves and renames pages and writes the journal, adds, ticks off
and moves tasks, shows the calendar and starts research; each step shows up in the chat and
links to the page it touched. It can also delete a page, but only once you confirm with
the button it shows (the page goes to the trash). It also answers questions about Nicotes
itself (*"How do I draw?"*), from this guide. **New chat** makes it forget the conversation.
It needs an AI service (see below) and a model that can use tools well, chosen under
Settings → AI → AI models → Chat: small, cheap models tend to claim they did something
without doing it, so if the steps don't match the answer, try a stronger one.

The same assistant answers in **Telegram** once a chat is connected under Settings →
Integrations → Reminders: write or send voice messages (with a transcription service set up), use
`/todo` for open tasks with buttons to tick them off, `/calendar` for the week, `/today`
and `/new` to start over. What the assistant does in Nicotes shows up there too, in a
folded list above its answer. Telegram keeps a conversation of its own.

The page menu can also **summarize** a page or **suggest links** to other pages. Switch on
the **semantic index** (Settings → AI) to find notes by meaning: related pages, "By meaning"
results in search and in the chat. It sends the text of your notes to OpenRouter for
embeddings (with the default model a few cents for thousands of pages), or to your own
model server if you pick one of its embedding models.

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

With an AI service set up, **Research** answers a question by searching the web, reading the
best sources and writing a note with numbered citations (on pages with citations, **Hide
sources** in the page bar hides the numbers in the text without removing them from the
page). With **Model knowledge only** it searches nothing and the model writes the note from
its own knowledge instead: faster and cheaper, but without sources, and possibly outdated.
Past runs are listed under **Recent research**; × removes one from the list (its note stays); **Organize with AI** (notebook or
page menu) suggests tags, better parent pages and new groups, which you review before
anything changes, and every applied batch can be undone. Each run shows its cost and stops
at a configurable limit (default $0.50). Under Settings → AI → **AI models** every feature
(import, organize, research, chat, the page assistant, summaries, link suggestions, layouts, reading images)
can use its own model, picked from a searchable list with prices, context size and filters;
unset ones use the default model.

The AI features run on [OpenRouter](https://openrouter.ai),
[Routeway](https://routeway.ai) (an OpenAI-compatible gateway) or **your own model
server**, in any combination: set up each one you want under Settings → AI, and every feature
uses the service of the model you pick for it (Routeway models are stored as
`routeway:<id>`, your own server's as `local:<id>`).

**Your own model server** keeps your notes on your network and costs nothing per use. Any
server with an OpenAI-compatible API works: [Ollama](https://ollama.com),
[LM Studio](https://lmstudio.ai), LocalAI, vLLM. Under Settings → AI → **Your own
model server**, enter the address of its API (Ollama: `http://<host>:11434/v1`, LM Studio:
`http://<host>:1234/v1`); its models then show up in the model pickers, marked Own server.
Its embedding models (names with "embed", e.g. `nomic-embed-text`) can run the semantic
index. Local models can't search the web, so web research with them needs SearXNG (below);
how well a feature works depends on the model's size.

Research searches via [SearXNG](https://docs.searxng.org) if `SEARXNG_URL` is set (the JSON
format must be enabled), otherwise via the web search of the research model's service
(OpenRouter's web plugin or Routeway's `@online`; your own server has none). For a local instance, set
`SEARXNG_SECRET` in `.env` and run:

```bash
docker compose -f compose.searxng.yml up -d
```

### Import (optional)

Import turns web pages into notes. It works out of the box for pages with embedded recipe
data and as a plain page clip; summaries and structure need an
[OpenRouter](https://openrouter.ai/keys) API key (default model `z-ai/glm-5.3-flashx`), a
[Routeway](https://routeway.ai) key or your own model server, with one of its models chosen
for import.
Keys, model and crawl4ai can be set under **Settings** or via `.env`.

[crawl4ai](https://github.com/unclecode/crawl4ai) is optional and renders JavaScript-heavy
pages. To run one locally, set `CRAWL4AI_TOKEN` in `.env`, then:

```bash
docker compose -f compose.crawl4ai.yml up -d
```

Point Nicotes at it with `CRAWL4AI_URL=http://localhost:11235` (dev) or, if both run in one
compose project, `http://crawl4ai:11235`.

**From Obsidian:** zip your vault's folder and choose the zip under Import → **Obsidian vault
or Markdown folder**. Before anything is created you see how many notes, files and tags it
holds and which notebooks it becomes: one per top-level folder, or everything in one
notebook. Notes become pages and subfolders parent pages (a folder note, `Folder.md` next to
or inside `Folder/`, becomes that parent page). `[[Links]]` (with aliases and headings),
embedded notes, tasks with their dates and repeats, `#tags` and tags in the properties come
along; canvases from the Excalidraw plugin become canvas pages; other properties are kept as a line at the top of the
page, and the images and files your notes use become attachments. Settings in `.obsidian`
are ignored. A Nicotes export (Settings → App & data → Export) can be imported the same way. This needs
no AI key.

## Phone and browser

### Phone app

Nicotes is a PWA: open it in your phone's browser and choose "Install app" / "Add to Home
Screen" (needs HTTPS, so run it behind a reverse proxy and set
`NICOTES_SECURE_COOKIES=true`). On Android it then appears in the share menu, and shared
links open the importer.

**Offline:** the installed app keeps a copy of your notes on the device (in a browser tab,
switch it on under Settings → App & data). Without a connection you can still open your notebooks
and pages (<kbd>Ctrl</kbd> <kbd>K</kbd> finds them by title), see images you opened before,
and edit pages: edits are kept on the
device ("Saved on this device") and sent once the server is back, combined with changes
made elsewhere in the meantime. If both changed the same lines, your offline text is kept
as a subpage "… (offline copy)". New pages, renames and moves need a connection. Signing
out removes the copy from the device.

### Browser sidebar

The extension in `extension/` shows Nicotes in the browser's sidebar, the way Bitwarden
does, in Firefox, Chrome and Edge. It shows the normal app (in its phone layout), with its
own sign-in.

1. Allow it on the server: set `NICOTES_BROWSER_EXTENSION=true` in `.env` and run
   `docker compose up -d` again.
2. Download it from the [releases on git.nico.software](https://git.nico.software/1n9i9c7om/nicotes/-/releases)
   (each release links the extension), or take `extension/` from the repository.
3. Install it:
   - **Firefox:** release Firefox only installs signed extensions. Open the release's signed
     `.xpi` in Firefox; it then updates itself whenever a new version comes out. Without one,
     sign the zip yourself on
     [addons.mozilla.org](https://addons.mozilla.org/developers/) as "On your own" (unlisted;
     automatic and free). To try it without signing, open `about:debugging` → This Firefox →
     "Load Temporary Add-on…" and pick its `manifest.json` (it is removed when Firefox
     restarts).
   - **Chrome / Edge:** unpack the zip, open `chrome://extensions` (`edge://extensions`), turn
     on developer mode, choose "Load unpacked" and pick the unpacked folder.
4. Click the Nicotes button in the toolbar (or the Nicotes icon in Firefox's sidebar) and enter
   the address you open Nicotes at. The browser asks to let the extension access that site,
   which keeps you signed in in the sidebar. To change the address later, open the extension's
   options (Firefox: `about:addons` → Nicotes → Options).

## Scripts and other apps

Under Settings → Account → **API tokens** you can create tokens for scripts and other apps, such as an
iOS shortcut that adds a task to today's journal, Home Assistant, or a backup script. A
token is shown once; send it as `Authorization: Bearer nct_…`. **Read only** tokens can only
look at your notes, **Read and write** ones can change them too. No token can change
settings, download backups or create other tokens, and each one can be revoked at any time.
[docs/API.md](docs/API.md) lists what the API can do, with examples.

## Sign-in security

Settings → Account → **Sign-in security** protects your account beyond the password:

- **Two-step sign-in:** after the password, Nicotes asks for a 6-digit code from an
  authenticator app such as Google Authenticator, Microsoft Authenticator, Aegis or 2FAS.
  Setting it up shows a QR code and ten recovery codes. Keep those somewhere safe: each one
  signs in once when your phone is not at hand.
- **Passkeys:** sign in with your fingerprint, face or screen lock, without password or
  code. They need HTTPS (or localhost) and only work at the address they were made at, so
  add them at the address you normally use.

Changing either asks for your password again. API tokens and the calendar address keep
working as before.

**Locked out?** If the phone and the recovery codes are both gone, turn two-step sign-in
off on the server; the password alone signs in again:

```bash
docker compose exec nicotes node apps/server/dist/reset-2fa.js <username>
```

Add `--passkeys` to remove the account's passkeys as well, for example when the phone was
stolen. The account is signed out everywhere. Without Docker, run
`npm run reset-2fa -- <username>`. The authenticator secret is encrypted with the same key
as stored API keys: if that key changes (a new `NICOTES_SECRET`, or a lost key file),
codes from the app stop working and a recovery code or this command gets you back in.

## Backups

Nicotes backs itself up once a day: a consistent copy of the database (taken while it runs),
the attachments and the key file for stored API keys, as one `nicotes-<time>.tar.gz`. It
keeps everything from the last 24 hours and the newest backup of each of the last 7 days
and of each of the last 4 weeks. **Settings → App & data → Backups** lists them, makes one on demand and
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
`DATA_DIR`. Separately, Settings → App & data → Export downloads all notes as Markdown (an
Obsidian-compatible vault), handy for reading them without Nicotes.

## Contributing

Bug reports and ideas go to the [issue tracker on GitHub](https://github.com/1n9i9c7om/nicotes/issues);
pull requests are welcome too. [CONTRIBUTING.md](CONTRIBUTING.md) explains how to contribute,
and [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) covers setting up, tests, the pipeline and
releases. Please report security problems privately, as described in [SECURITY.md](SECURITY.md).

Nicotes is developed on [git.nico.software](https://git.nico.software/1n9i9c7om/nicotes);
[GitHub](https://github.com/1n9i9c7om/nicotes) has a read-only mirror of the code. Releases,
the browser extension and the Docker image are published on git.nico.software.

## License

Nicotes is free software under the [GNU Affero General Public License v3.0](LICENSE). You
may use, change and share it; if you run a changed version for others, for example as a
hosted service, you have to offer them its source code as well.
