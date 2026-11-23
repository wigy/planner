// SQLite storage. One file, written only by this process.
//
// The calendar tables are a mirror of Google: Google is the source of truth for
// events, and every booking is the project hashtag in a Bookkeeping event's title.
// Tickets, comments and labels exist only here.

import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  primary_email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS google_accounts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  refresh_token_enc TEXT,
  scopes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ok',        -- ok | revoked
  calendars_synced_at TEXT
);
CREATE TABLE IF NOT EXISTS calendars (
  id INTEGER PRIMARY KEY,
  google_account_id INTEGER NOT NULL REFERENCES google_accounts(id),
  google_calendar_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#4285f4',
  access_role TEXT NOT NULL DEFAULT 'reader',
  is_primary INTEGER NOT NULL DEFAULT 0,
  selected INTEGER NOT NULL DEFAULT 1,      -- shown in the views
  is_bookkeeping INTEGER NOT NULL DEFAULT 0,
  sync_token TEXT,
  synced_at TEXT,
  watch_channel_id TEXT,
  watch_resource_id TEXT,
  watch_expires_at TEXT,
  UNIQUE (google_account_id, google_calendar_id)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  google_event_id TEXT NOT NULL,
  etag TEXT,
  status TEXT NOT NULL,                     -- confirmed | tentative | cancelled
  summary TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  start TEXT,                               -- ISO instant, or YYYY-MM-DD when all_day
  end TEXT,
  all_day INTEGER NOT NULL DEFAULT 0,
  time_zone TEXT,
  recurrence TEXT,                          -- JSON array of RRULE/EXDATE/RDATE lines
  recurring_event_id TEXT,                  -- set on an instance that differs from its series
  original_start TEXT,
  organizer_self INTEGER NOT NULL DEFAULT 0,
  updated TEXT,
  raw_json TEXT NOT NULL,
  UNIQUE (calendar_id, google_event_id)
);
CREATE INDEX IF NOT EXISTS events_range ON events (calendar_id, start, end);
CREATE INDEX IF NOT EXISTS events_series ON events (calendar_id, recurring_event_id);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  hashtag TEXT NOT NULL COLLATE NOCASE,
  color TEXT NOT NULL DEFAULT '#3b82f6',
  rate REAL,
  customer TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, hashtag)
);
CREATE TABLE IF NOT EXISTS locked_months (
  user_id INTEGER NOT NULL REFERENCES users(id),
  month TEXT NOT NULL,                      -- YYYY-MM
  locked_at TEXT NOT NULL,
  PRIMARY KEY (user_id, month)
);
CREATE TABLE IF NOT EXISTS labels (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#64748b',
  UNIQUE (user_id, name)
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  col TEXT NOT NULL,                        -- p1 | p2 | p3 | p4 | done
  position REAL NOT NULL,
  done_at TEXT,
  archived_at TEXT,
  project_id INTEGER REFERENCES projects(id),
  trello_id TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tickets_board ON tickets (user_id, archived_at, col, position);
CREATE TABLE IF NOT EXISTS ticket_labels (
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (ticket_id, label_id)
);
CREATE TABLE IF NOT EXISTS ticket_comments (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  trello_id TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS ticket_events (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),     -- null for the automatic archive job
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  at TEXT NOT NULL
);
-- Where planner moved an event into Bookkeeping from, to move it back when its
-- hashtag goes. Kept here because Google drops private extended properties
-- when an event changes calendar. A moved event keeps its Google id.
CREATE TABLE IF NOT EXISTS moved_events (
  google_account_id INTEGER NOT NULL REFERENCES google_accounts(id) ON DELETE CASCADE,
  google_event_id TEXT NOT NULL,
  origin_calendar TEXT NOT NULL,
  moved_at TEXT NOT NULL,
  PRIMARY KEY (google_account_id, google_event_id)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

export type Db = DatabaseSync

export function openDb(file: string): Db {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  db.exec(SCHEMA)
  return db
}

export function now(): string {
  return new Date().toISOString()
}

/** Runs fn in a transaction; rolls back if it throws. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

// node:sqlite returns rows as null-prototype objects of unknown shape; these
// helpers give them a type at the one place each query is written.
export function all<T>(db: Db, sql: string, ...params: (string | number | null)[]): T[] {
  return db.prepare(sql).all(...params) as T[]
}

export function get<T>(db: Db, sql: string, ...params: (string | number | null)[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined
}

export function run(db: Db, sql: string, ...params: (string | number | null)[]) {
  return db.prepare(sql).run(...params)
}
