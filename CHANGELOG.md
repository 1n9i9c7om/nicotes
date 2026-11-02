# Changelog

What changed in each version of Nicotes, newest first.

## 0.5.1 — 2026-11-02

**New**

- **The chat can move, rename and delete pages.** Ask it to put a page under another one,
  into another notebook, or to rename it; links to the page are updated. It can also delete
  a page, but only once you confirm: it shows the question with a **Move to trash** and a
  **Keep it** button, in the web app and in Telegram. Deleted pages go to the trash, from
  where you can restore them.

**Changes**

- **Settings are organized in tabs:** Account, Notes & tasks, AI, Integrations, and App &
  data. The open tab stays open when you reload, and links to a setting open its tab.
- **The top bar stays in view on phones.** The menu and search no longer scroll away, so
  you can switch pages without scrolling back up first.
- **The chat is more reliable.** It no longer claims to have changed a page when it didn't
  call a tool, and it says where a page is with its full path (Notebook › Parent › Page)
  instead of guessing from earlier answers.

**Fixes**

- Typing `!` and picking a page with `[[` at the start of a line that already had text no
  longer deletes that text. The link is kept as `![[Page]]` within the line.

## 0.5.0 — 2026-11-02

**New**

- **A chat that uses Nicotes for you.** **Chat**, right below search, replaces Ask. Ask it
  about your notes or tell it what to do in your own words: add a task with a reminder,
  write in the journal, show what's due this week, start research. Each step it takes is
  listed above its answer, with links to the pages it touched. It needs an AI service and a
  model that can use tools (Settings → AI models → Chat).
- **Reminders.** Write `⏰ 09:00` after a task with a due date to be reminded then, and/or
  get a summary of the day's tasks every morning. Settings → Reminders sends them as
  notifications to your phone or computer, or to Telegram through a bot of your own.
- **Nicotes in Telegram.** Once a Telegram chat is connected, write or speak to the same
  assistant there. `/todo` lists open tasks with buttons to tick them off, `/calendar` shows
  the week, `/today` today's journal and `/new` starts over.
- **Recurring tasks.** Add a rule like `🔁 every week` or `🔁 every month on the 1st` to a
  task. Ticking it off adds the next one with the due date moved on. It's the syntax of
  Obsidian's Tasks plugin.
- **Tasks in your calendar app.** Settings → Tasks → Calendar subscription gives you a
  secret address for Google Calendar, Apple Calendar, Thunderbird and the like. Open tasks
  with a due date show up there as all-day events.
- **Offline.** The installed phone app keeps a copy of your notes. Without a connection you
  can still open and edit pages; your edits are sent once the server is back, combined with
  changes made elsewhere meanwhile. If both changed the same lines, your text is kept as a
  subpage "… (offline copy)". In a browser tab, switch it on under Settings → App.
- **Canvas pages.** "New canvas" makes a page to draw on, with pen, highlighter, shapes,
  arrows, text and images. Text on a canvas is found by search.
- **Voice notes.** The microphone button records into the page. With a transcription
  service set up (Settings → Voice notes), what you said is written below it too.
- **Embeds.** `![[Page]]` on a line of its own shows another page inside this one, and
  `![[Page#Heading]]` just one part of it. `[[Page#Heading]]` links work too.
- **Print or save as PDF** from a page's ⋯ menu or with Ctrl+P. The page prints alone, on
  white, the way you see it.
- **Share pages and notebooks** as read-only links, which can expire and be turned off at
  any time. Settings → Shared links lists them all.
- **Two-step sign-in and passkeys.** Settings → Sign-in security adds a code from an
  authenticator app after the password, or lets you sign in with a passkey.
- **Import Obsidian vaults.** Zip a vault or a folder of Markdown files and import it.
  Links, embeds, tasks, tags, Excalidraw drawings and the files your notes use come along.
- **Search inside files.** Search also finds text in the PDFs and text files your pages
  show. Photos and scans can be searched too once you turn on Read images with AI.
- **Adapters and charts.** Settings → Adapters writes values from Home Assistant and the
  day's weather into a logbook page or the journal once a day. Tables of numbers, such as
  logbooks, can be shown as charts in View.
- **Your own AI server.** The AI features can run on your own model server (Ollama, LM
  Studio and others), alongside OpenRouter and Routeway.
- **API tokens** under Settings → API tokens let scripts and other apps read or change your
  notes. [docs/API.md](https://git.nico.software/1n9i9c7om/nicotes/-/blob/main/docs/API.md)
  lists what they can do.

**Changes**

- **Ask is now the chat.** Old Ask links lead to the chat. Scripts that used `/api/ask`
  should use `/api/chat` instead.
- **Libraries with known security problems were updated.**
- **The browser extension stays at 0.4.1.** It hasn't changed, so there's nothing to
  update.

**For administrators**

- **All settings come from `.env`.** `docker-compose.yml` now passes the whole `.env` file
  to Nicotes instead of a fixed list of variables, so Docker Compose needs a `.env` file
  next to it. `.env.example` now starts with the few required settings; everything else is
  optional, and much of it can also be set in the app.
- **New optional settings:** `LOCAL_AI_URL` and `LOCAL_AI_KEY` (your own model server),
  `TELEGRAM_BOT_TOKEN`, `TRANSCRIBE_URL`, `TRANSCRIBE_KEY` and `TRANSCRIBE_MODEL` (voice
  notes), `NICOTES_READ_IMAGES` and `OPENROUTER_IMAGES_MODEL` (searching images),
  `NICOTES_TAG` (the image version to run) and `NICOTES_HTTP_PORT`.
  `OPENROUTER_ASK_MODEL` now picks the chat's model.
- Notifications, passkeys and voice recording need HTTPS (or localhost).

## 0.4.2 — 2026-11-01

**Changes**

- **Report bugs and ideas on GitHub.** Nicotes now has a
  [mirror on GitHub](https://github.com/1n9i9c7om/nicotes). Its issue tracker takes bug
  reports (with a short form) and ideas, and pull requests are welcome there.
- **Report security problems privately.** Use GitHub's private vulnerability reporting on
  the mirror. The website also lists this contact in its `security.txt`.
- **The browser extension stays at 0.4.1.** It now has its own version, which only changes
  when the extension itself does. This release doesn't change it, so there's nothing to
  update.

## 0.4.1 — 2026-11-01

**Changes**

- **A new logo.** Nicotes has a new icon: an N with a folded page corner. It shows in the
  browser tab, in the app, on your phone's home screen and on the sidebar extension's
  button. An installed phone app may take a while to pick up the new icon, or show it
  after you reinstall it.
- **A license and a home page.** Nicotes is now licensed under the GNU AGPL-3.0, and has a
  home page with screenshots, features and install steps.

**For administrators**

- **Install without building.** `docker-compose.yml` now pulls the ready-made image from
  the project's container registry (`main-latest`, the newest release). Update with
  `docker compose pull && docker compose up -d`, and pin a version with `NICOTES_TAG` in
  `.env`. `docker compose up -d --build` still builds from your checkout.
- **No more example password.** Nicotes refuses to create its first account with the
  example password `change-me` from `.env.example`, or with one shorter than 8
  characters, and stops with a message saying why. Existing accounts are not affected.

## 0.4.0 — 2026-11-01

**New**

- **Nicotes in your browser's sidebar.** A new browser extension shows Nicotes in the
  sidebar of Firefox, or in the side panel of Chrome and Edge, next to the page you are
  reading. Click its toolbar button to open or close it. The first time, enter your Nicotes
  address and allow the extension to access it, then sign in once inside the sidebar. You
  can change the address later in the extension's options.
- **Download the extension from the release.** Each release now offers the extension for
  download. The Firefox version, when available, updates itself to new releases.

**For administrators**

- The sidebar only works when the server allows it. Set `NICOTES_BROWSER_EXTENSION=true`
  in your `.env` and restart Nicotes. Without it, browsers refuse to show Nicotes inside
  the extension.

## 0.3.3 — 2026-10-29

**Fixes**

- **Text colour buttons show their colours.** In the editor's colour palette, the buttons
  under "Text" were all white, so you could only tell them apart by hovering. Each one now
  shows the colour it applies.

## 0.3.2 — 2026-10-28

**New**

- **Remove runs from Recent research.** Each finished entry in the Recent research list has
  an × to remove it from the list. The research note itself stays where it is.
- **Timers for time ranges.** A recipe step that says "bake for 20–30 minutes" now offers a
  timer that starts in the middle of the range. Use − and +, or the slider, to pick a
  different time within the range before starting it.

**Fixes**

- **Timers in cook mode's "You need" box.** Times mentioned in the lines under "You need"
  (for example "roughly 10–25 minutes") now get a timer as well.
- **More ways of writing times are recognised.** Ranges written with a long dash, with "~",
  or as "a 20–30-minute bake" are now understood. Before, they gave no timer or only the
  upper number.
- **Sliders match the app's look.** Sliders now use the app's colours instead of the
  browser's default style.

## 0.3.1 — 2026-10-28

**Fixes**

- **Long research notes with Routeway no longer fail.** A detailed research note could
  stop with "Routeway error: HTTP 524" when the model needed more than about a minute and a
  half to write it. The answer now arrives piece by piece as it is written, so long notes
  finish normally.
- **Checkboxes line up again.** On the Tasks page, checkboxes sat right on the edge of each
  row; in checklists inside the editor, they sat slightly below their text. Both are back
  in place.

## 0.3.0 — 2026-10-28

**New**

- **Research without the web.** Research can now answer from what the AI model already
  knows ("Model knowledge only"), without searching the web. It is quicker and cheaper,
  but the note has no sources to check and may be out of date — the note says so, and
  lists what is worth double-checking.
- **Text colours and highlights.** Select text in the editor and use the new highlighter
  button to give it a coloured background or a coloured font, from six colours. Colours
  are saved the same way Obsidian saves them, so they survive an export.

**Changes**

- **The assistant asks what it may read each time.** Which other notes the page assistant
  may read is now chosen in the assistant panel for each conversation, starting with "this
  page only". It is no longer a permanent setting on the Settings page.

**Fixes**

- **Formatting around links is kept.** Bold, italics or a colour around a `[[link]]` used
  to disappear when the page was opened in the editor. It now stays.
- **Consistent look.** Checkboxes everywhere, and the controls in the assistant panel and
  the version history, now match the rest of the app instead of the browser's default style.

## 0.2.2 — 2026-10-28

**Fixes**

- **Routeway keys are accepted.** "Test connection" in Settings rejected normal Routeway
  keys even though they worked for everything else.

## 0.2.1 — 2026-10-28

**Fixes**

- **Updates arrive right away.** After a new version was installed, an open Nicotes tab
  kept running the old version until every tab was closed, which could break pages such as
  Settings. The app now switches to the new version the next time it is opened or
  reloaded. (Updating from 0.2.0 needs one last manual reload.)

## 0.2.0 — 2026-10-28

**New**

- **Page assistant.** Ask an AI about the page you are on, or ask it to change the page
  ("add a section on costs", "fix the spelling"). It only ever edits that page, and you
  review every proposed change and accept or reject each one separately. It can
  optionally search the web first.
- **Version comparison.** The version history shows what changed between versions and
  can restore just some of the changes of an earlier version.
- **Routeway support.** Besides OpenRouter, Nicotes can use Routeway as its AI service.
  Each feature can use its own model, picked from a searchable list with prices and
  filters.
- **Adjustable page width.** Drag the edges of a page to make it wider or narrower;
  double-click to reset.
- **Hide sources.** On notes with numbered source references (such as research notes),
  a button hides the numbers for easier reading without changing the note.

**Changes**

- **Recipes from anywhere.** The recipe view handles many more ways of writing a recipe,
  such as ingredient tables or steps with sub-points.

## 0.1.0 — 2026-10-24

The first release.

- **Notebooks and pages** with nested subpages, edited either formatted or as Markdown,
  saved automatically, with version history and a trash.
- **Links between pages** (`[[Page name]]`), backlinks, tags, full-text search and a
  graph of how pages connect.
- **Journal** with a page per day, **templates**, and a **Tasks** page that collects
  every checkbox from every page.
- **Interactive views** that turn pages into checklists, recipes, step-by-step guides or
  a read-aloud reader.
- **AI features** (optional, with your own API key): import web pages as tidy notes,
  research a question on the web, ask questions about your own notes, organize pages and
  suggest links.
- **Install as an app** on phones and desktops, with sharing to Nicotes from other apps
  on Android.
- **Automatic daily backups** that can be downloaded from Settings.
