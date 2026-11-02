# Nicotes API

Everything the web app does goes through a JSON API under `/api`, and scripts can use the
same API with an **API token**. This page lists the parts that are most useful from
outside; the full set is in `apps/server/src/routes`.

## Signing in with a token

Create a token under **Settings → Account → API tokens** and send it with every request:

```bash
curl -H "Authorization: Bearer nct_…" https://notes.example.com/api/notebooks
```

- **Read only** tokens may use `GET` requests only; **Read and write** tokens may also
  create and change things. Calendar tokens only open the calendar feed (below).
- No token can open Settings, the backups, sign-in security, shared links, reminders,
  adapters or the token list (`/api/settings`, `/api/backups`, `/api/security`,
  `/api/shares`, `/api/reminders`, `/api/adapters`, `/api/tokens`): those need a signed-in
  browser. Two-step sign-in does not apply to tokens; a token is a credential of
  its own, so keep it as safe as a password.
- A wrong token is answered with `401`; after 20 wrong tokens from one address within 15
  minutes, with `429` for a while.
- Send JSON bodies with `Content-Type: application/json`. File uploads are
  `multipart/form-data` with the file in the field `file`.
- Errors come back as `{ "error": "…" }` with a matching status code.

## Notebooks and pages

| Request | What it does |
|---|---|
| `GET /api/notebooks` | All notebooks |
| `POST /api/notebooks` `{ "title": "Inbox" }` | Creates a notebook |
| `GET /api/pages?notebookId=…` | Pages (title, parent, tags, no content), optionally of one notebook |
| `GET /api/pages/<id>` | One page with its Markdown `content` and `version` |
| `GET /api/pages/sync?since=<ms>` | Every page changed since then (all with `since` left out), in full, plus `ids` of all pages; `at` is the time to ask from next |
| `POST /api/pages` `{ "notebookId": "…", "title": "…", "content": "…", "parentId": null }` | Creates a page |
| `PATCH /api/pages/<id>` `{ "content": "…", "baseVersion": 7 }` | Changes a page; `baseVersion` is the `version` you read, so a change made meanwhile is not overwritten (`409`) |
| `PATCH /api/pages/<id>` `{ "title": "…" }` | Renames a page; `[[links]]` to it are updated |
| `DELETE /api/pages/<id>` | Moves a page to the trash |
| `GET /api/search?q=…` | Full-text search; words starting with `#` filter by tag |
| `POST /api/attachments` (multipart, field `file`) | Uploads a file; the answer's `url` can be linked from a page |

## Tasks and the journal

| Request | What it does |
|---|---|
| `GET /api/tasks?status=open` | Every checkbox from every page (`open`, `done` or `all`) |
| `POST /api/daily` `{ "date": "2026-11-01" }` | Today's (or any day's) journal note; creates it if needed. Answers `{ "page": { "id": … }, "created": … }` |
| `POST /api/tasks` `{ "pageId": "…", "text": "Buy milk", "due": "2026-11-03" }` | Adds a task to a page (`due` is optional) |
| `PATCH /api/tasks` `{ "pageId": "…", "line": 4, "raw": "- [ ] Buy milk", "done": true }` | Ticks a task off (or reopens it with `false`) and/or sets `due` (a date, or `null`); `line` and `raw` come from `GET /api/tasks`, and a changed line answers `409`. A repeating task gets its next occurrence added |

Task text can carry what the app shows: `📅 2026-11-03` (due date), `⏰ 09:00` or
`⏰ 2026-11-03 09:00` (reminder) and `🔁 every week` (repeat), e.g.
`"text": "Water the plants 🔁 every week"`.

Adding a task to today's journal note, e.g. from a shortcut:

```bash
TODAY=$(date +%F)
PAGE=$(curl -s -H "Authorization: Bearer nct_…" -H "Content-Type: application/json" \
  -d "{\"date\": \"$TODAY\"}" https://notes.example.com/api/daily | jq -r .page.id)
curl -s -H "Authorization: Bearer nct_…" -H "Content-Type: application/json" \
  -d "{\"pageId\": \"$PAGE\", \"text\": \"Call the plumber\"}" https://notes.example.com/api/tasks
```

### Logbooks from your own scripts

A page with a table whose first column is `Date` shows as charts in its View, one chart per
column of numbers. Scripts can keep such a logbook by reading the page and writing it back
with a new row (the adapters under Settings → Integrations → Adapters do the same, but are managed only in
the app, since they hold other services' tokens):

```markdown
| Date | Weight (kg) | Steps |
| --- | --- | --- |
| 2026-11-01 | 81.4 | 9120 |
| 2026-11-02 | 81.1 | 11 304 |
```

## Chat

The chat assistant can be used from scripts too (it needs an AI service set up in the app):

| Request | What it does |
|---|---|
| `POST /api/chat` `{ "text": "What's due today?" }` | Sends a message; the answer streams as server-sent events, one JSON object per `data:` line: `user`, `action` (each step it takes), then `answer` (with `entry.content`) or `error` |
| `GET /api/chat` | The conversation so far |
| `DELETE /api/chat` | Forgets the conversation |

A token shares the web app's conversation of its account. Sending a message needs a
read-and-write token, since the chat can change notes.

## Calendar feed

`GET /api/calendar/<token>.ics` is an iCalendar feed of the open tasks with a due date
(all-day events). It needs no `Authorization` header: the calendar token in the address,
created under Settings → Notes & tasks → Calendar subscription, is the key. Calendar tokens work
nowhere else, and an unknown token answers `404`.

## Export

`GET /api/export` downloads all notes as a zip of Markdown files (an Obsidian vault);
`GET /api/export?notebookId=…` only one notebook.
