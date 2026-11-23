# CLAUDE.md

planner: todo board, Google Calendar views with two-way sync, and time bookkeeping by project
hashtag. README.md explains the rules; read it first.

- `server/` is plain `node:http` with `node:sqlite`, run as TypeScript with no build step
  (Node 24 type stripping). That means only erasable syntax (no enums, no parameter
  properties), and local imports carry an explicit `.ts` extension. `tsconfig.json` enforces both.
- `shared/` holds the types and the pure rules (hashtags, rounding, time zones), used by both
  the UI and the server.
- `src/` is the React UI (Vite), with FullCalendar for the views and dnd-kit for the board.
- **Google is the source of truth for events.** The `events` table is a mirror. Every edit goes
  to Google first, and the mirror is updated from the reply plus an incremental sync. A 412 on
  an edit means Google wins. A booking is the hashtag in a Bookkeeping event's title and
  nothing else: there is no separate bookings table to keep in step.
- `server/fake-google.ts` is the test double for the Calendar API, and the sync tests run
  against it. Extend it when the code starts relying on more of the API.
- `data/` is the live database and keys. It is gitignored and the repository is **public**:
  keep personal data out of fixtures, tests, docs and commit messages. That includes calendar
  contents, ticket text, email addresses and Trello list names.
- Checks: `npm test`, `npm run typecheck`, `npm run build`.
