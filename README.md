# planner

A small self-hosted web app for a household or a one-person company:

- **Todo board.** Cards have a title, a Markdown description, comments and labels. There are four
  priority columns (P1–P4) and Done. Cards in Done for 48 hours are archived automatically,
  and archived cards stay searchable and can be restored. Each user has a board, and can open
  the other users' boards read-only.
- **Calendar.** Month, week and day views of your Google calendars, with full two-way sync:
  create, move, resize, edit and delete, including one occurrence or the whole series of a
  recurring event.
- **Time bookkeeping.** Projects have a full title and a hashtag, for example *Acme Works* and
  `#acme`. The hashtag in the title or description of an event in your **Bookkeeping**
  Google calendar books that event to the project, in both directions: booking in planner writes the hashtag,
  and typing it in Google Calendar on your phone books the event. Any event in another calendar
  can be *sent to Bookkeeping*: copied (the default, and the only option for other people's
  meetings) or, for your own events, moved. Reports per project and per month, with rounding
  chosen per report, export to CSV and print to PDF. Months can be locked once invoiced.

Signing in with Google is the login and grants the calendar access in the same step. Only
the addresses in `PLANNER_ALLOWED_EMAILS` can log in.

## How booking works

- Only the **Bookkeeping** calendar counts. planner creates it in your Google account when you
  first need it, or adopts an existing calendar you own that is called `Bookkeeping`.
- The title and the description count together: exactly one known project hashtag between them
  books the event (the same tag in both is fine). Two different project hashtags book nothing;
  the event is shown in red and logged as a warning. When planner sets a booking, the hashtag
  goes into the title and any project hashtags leave the description. An unknown hashtag is listed under
  Projects so a project can be created for it. A hashtag must start the title or follow a
  space, so `a#acme` and URL fragments do not count.
- **Automatic booking.** An event in a calendar you own (not one shared with you) whose title or
  description has exactly one known project hashtag is copied to Bookkeeping by itself, within seconds of
  the change reaching planner. The copy follows its source: moved or retitled, it is updated;
  the hashtag removed or the event deleted, the copy is deleted. A recurring series is copied
  occurrence by occurrence up to the end of the current month. All-day events are not copied,
  since their hours are unknown, and locked months are never changed. Change the booking of an
  automatic copy in its source event, not in Bookkeeping.
- Renaming a project's hashtag rewrites the titles of its Bookkeeping events, and of your own
  events in your own calendars, except in locked months.
- A copy records its source in the event's private extended properties
  (`planner_source`), so the same event cannot be booked twice. An all-day event can be sent
  only with the hours entered by hand (`planner_minutes`).
- Time is stored exactly. A report can round to 15, 30 or 60 minutes (up, down or to the
  nearest), per entry or on the total, and prints which rounding it used. Month boundaries are
  Europe/Helsinki, and an event crossing one is split between the two months.

## Running it

Node 24 or later. The server is plain `node:http` running TypeScript directly through Node's
type stripping, with SQLite from `node:sqlite`.

```bash
npm install
npm test               # vitest: sync logic against a fake Google, recurrence, board, reports
npm run typecheck
npm run build          # the UI into dist/
npm start              # http://localhost:8920
npm run dev            # API with --watch, plus Vite on :5173
```

`PLANNER_FAKE_GOOGLE=<your email>` runs against an in-memory Google with a few sample events,
so the calendar can be tried without OAuth credentials. The user must already exist; the
Trello importer below creates one. Nothing reaches Google in that mode, and everything is
lost on restart.

### Configuration

| Variable | Meaning |
|---|---|
| `PLANNER_PUBLIC_URL` | e.g. `https://planner.example.com`; used for the OAuth redirect (`/auth/google/callback`) and push notifications (`/google/push`) |
| `PLANNER_ALLOWED_EMAILS` | comma-separated Google addresses that may log in |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | an OAuth client of type *Web application* |
| `PLANNER_SECRET` | 32 bytes of base64 that sign the session cookies; created in `data/` if unset |
| `PLANNER_TOKEN_KEY` | 32 bytes of base64 that encrypt the stored refresh tokens; created in `data/` if unset. Keep it out of the backups of `data/` |
| `PLANNER_DATA` | the data directory (default `./data`) |
| `NOTIFY_URL` | optional event log endpoint: each sync failure, conflict, archive run and login is POSTed there as `{source, level, text, title}` |
| `PLANNER_POLL_SECONDS` | fallback poll interval (default 300) |
| `PORT`, `HOST` | default `8920`, `0.0.0.0` |

Generate a key with `openssl rand -base64 32`.

### Google Cloud setup

1. Create a project in the Google Cloud console and enable the **Google Calendar API**.
2. Under *OAuth consent screen*, use the type *External*, add the scopes `openid`, `email`,
   `profile` and `.../auth/calendar`, and **publish the app (status "In production")**. While
   it is in *Testing*, Google expires refresh tokens after 7 days and sync stops every week.
   An unverified app works for up to 100 users and shows an "unverified app" warning once.
3. Create an OAuth client ID of type *Web application* with the redirect URI
   `https://<your domain>/auth/google/callback`.

Push notifications need public HTTPS. Without it planner polls every few minutes.

### Importing a Trello board

```bash
node server/import-trello.ts board.json you@example.com \
  --map "Urgent=p1" --map "Next=p2" --map "Fix=p3" --label-list "Fix" --dry-run
```

Archived cards, and open cards in archived lists, go to the Archive with their list as a
label. Checklists become Markdown task lists, and attachments become links. Comments keep
their dates. Run it again and cards already imported are skipped. A Trello export holds only
the board's latest 1000 actions, so older comments can be missing.

## License

MIT
