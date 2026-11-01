# Changelog

What changed in each version of Nicotes, newest first.

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
