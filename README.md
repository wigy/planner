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
  `#acme`. The hashtag decides where an event lives: an event of yours that gets a project
  hashtag, in planner or in Google Calendar on your phone, moves into your **Bookkeeping**
  Google calendar, and moves back out when the hashtag goes. There is only ever the one event.
  Someone else's meeting can be *sent to Bookkeeping* as a copy on request. Reports per project
  and per month, with rounding chosen per report, export to CSV and print to PDF. Months can be
  locked once invoiced.

Signing in with Google is the login and grants the calendar access in the same step. Only
the addresses in `PLANNER_ALLOWED_EMAILS` can log in.

## How booking works

- Only the **Bookkeeping** calendar counts. planner creates it in your Google account when you
  first need it, or adopts an existing calendar you own that is called `Bookkeeping`.
- The title and the description count together: exactly one known project hashtag between them
  books the event (the same tag in both is fine). Two different project hashtags book nothing;
  the event is shown in red and logged as a warning. An unknown hashtag is listed under
  Projects so a project can be created for it. A hashtag must start the text or follow a
  space, so `a#acme` and URL fragments do not count.
- When planner sets a booking, the hashtag goes into the **description**. The title is changed
  only if it already carries a project hashtag, which is then swapped in place.
- **Automatic booking.** An event you organize, in a calendar you own, with exactly one project
  hashtag is moved to Bookkeeping within seconds of the change reaching planner; a Bookkeeping
  event without one is moved back to the calendar it came from (remembered in planner's
  database, since Google drops private extended properties on a move), or to your primary calendar. Google moves a series only as a
  whole, so a project picked for one occurrence tags the whole series. These stay where they
  are: other people's meetings (send a copy instead), all-day events (their hours are
  unknown), events with two project hashtags, and anything in a locked month.
- Renaming a project's hashtag rewrites it wherever it is, in titles and descriptions, except in
  locked months.
- A copy sent by hand records its source in the event's private extended properties
  (`planner_source`), so the same event cannot be booked twice. An all-day event can be sent
  only with the hours entered by hand (`planner_minutes`).
- Time is stored exactly. A report can round to 15, 30 or 60 minutes (up, down or to the
  nearest), per entry or on the total, and prints which rounding it used. Month boundaries are
  Europe/Helsinki, and an event crossing one is split between the two months.

## Around the app

- The date in the corner shows the hours booked this week, and the month view shows each
  week's booked hours under its week number.
- A booked event carries its project's hashtag in the corner of its block.
- A report lists each project's customer and hourly rate when they are set, with what the
  hours come to in euros, and prints with your name and the date on top.
- Urgent cards (P1 and P2) grey out step by step after a month, three months and half a year
  without changes.
- The colours follow the system's light or dark setting.
- Bookkeeping events have a dark left edge. The Bookkeeping calendar and Exercises are listed
  under *Special*, apart from the account calendars.
- **Exercises**, when an exercise feed is configured: a read-only calendar of your workouts
  from [Rautaloki](https://github.com/wigy/rautaloki), fetched live and never stored. Done
  workouts are solid green on their day; the lifting still to do is one dashed bar per week,
  this week and the weeks the running cycles have left. Its entry under *Special* switches it
  on and off (kept in the browser).
- Keyboard: `b` `c` `p` `r` open the board, calendar, projects and reports; `n` adds a card to
  P1; with a card open, `1`–`4` move it to P1–P4 and `d` to Done; in the calendar `t` goes to
  today, `←` `→` move back and forward, and `m` `w` `d` pick month, week or day. `?` lists them.

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
| `EXERCISE_FEED_URL`, `EXERCISE_FEED_KEY` | optional: the exercise feed for the Exercises calendar, e.g. `http://rautaloki:8910/api/feed`, and the shared key it expects |
| `PORT`, `HOST` | default `8920`, `0.0.0.0` |

Generate a key with `openssl rand -base64 32`.

### Exercise feed

A server-to-server JSON protocol, so any app can fill the Exercises calendar
(`server/exercises.ts`):

```
GET <EXERCISE_FEED_URL>?email=<planner user's email>&from=YYYY-MM-DD&to=YYYY-MM-DD
Authorization: Bearer <EXERCISE_FEED_KEY>

200 {"name": "Exercises", "events": [{"id", "title", "allDay", "start", "end", "status", "kind", "description"}]}
404 the email is not known there (an empty calendar)
```

An all-day event has `start` the first day and `end` the day after the last (exclusive);
otherwise both are ISO instants, as for a workout done through a timer. A missing `allDay`
means all-day.
`status` is `done` or `planned`; planned events of kind `lift` with the same days are
merged into one bar. Malformed events are dropped, and answers are cached for a minute.

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
