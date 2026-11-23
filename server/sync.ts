// Mirroring Google calendars into the local database.
//
// The first sync of a calendar lists every event, past ones included, since old
// events can be sent to Bookkeeping. After that only changes are fetched with the
// sync token; a 410 means the token expired, and the calendar is synced in full
// again. Push notifications trigger a sync; a poll every few minutes catches any
// that are lost.

import { randomUUID } from 'node:crypto'
import { parseBooking } from '../shared/hashtag.ts'
import { monthOf } from '../shared/time.ts'
import { all, type Db, get, now, run, tx } from './db.ts'
import { type CalendarApi, GoneError, GoogleAuthError, type GCalendar, type GEvent, type GEventTime } from './google.ts'
import type { Notifier } from './notify.ts'

export type Ctx = {
  db: Db
  notify: Notifier
  apiFor: (accountId: number) => CalendarApi
  /** https://planner.example.com, for push notifications; none means poll only. */
  publicUrl?: string
  pushToken?: string
}

export type CalendarRow = {
  id: number
  google_account_id: number
  google_calendar_id: string
  name: string
  color: string
  access_role: string
  is_primary: number
  selected: number
  is_bookkeeping: number
  sync_token: string | null
  synced_at: string | null
  watch_channel_id: string | null
  watch_resource_id: string | null
  watch_expires_at: string | null
}

export type EventRow = {
  id: number
  calendar_id: number
  google_event_id: string
  etag: string | null
  status: string
  summary: string
  description: string
  location: string
  start: string | null
  end: string | null
  all_day: number
  time_zone: string | null
  recurrence: string | null
  recurring_event_id: string | null
  original_start: string | null
  organizer_self: number
  updated: string | null
  raw_json: string
}

const BOOKKEEPING_NAME = 'Bookkeeping'

/** Start or end of an event as stored: an ISO instant, or a date for all-day events. */
export function timeOf(t: GEventTime | undefined): string | null {
  if (!t) return null
  if (t.date) return t.date
  if (t.dateTime) return new Date(t.dateTime).toISOString()
  return null
}

export function calendarOwner(db: Db, calendarId: number): number {
  const row = get<{ user_id: number }>(
    db,
    'SELECT a.user_id FROM calendars c JOIN google_accounts a ON a.id = c.google_account_id WHERE c.id = ?',
    calendarId,
  )
  if (!row) throw new Error(`no calendar ${calendarId}`)
  return row.user_id
}

export function knownHashtags(db: Db, userId: number): string[] {
  return all<{ hashtag: string }>(db, 'SELECT hashtag FROM projects WHERE user_id = ?', userId).map((r) => r.hashtag)
}

function isLocked(db: Db, userId: number, start: string | null): boolean {
  if (!start) return false
  const month = start.length === 10 ? start.slice(0, 7) : monthOf(new Date(start))
  return !!get(db, 'SELECT 1 FROM locked_months WHERE user_id = ? AND month = ?', userId, month)
}

/**
 * Writes one event from Google into the mirror, and reports the changes that
 * matter for bookkeeping. `calendar` is the local calendar row.
 */
export function storeEvent(ctx: Ctx, calendar: CalendarRow, ev: GEvent, defaultTz = 'Europe/Helsinki') {
  const { db } = ctx
  const old = get<EventRow>(db, 'SELECT * FROM events WHERE calendar_id = ? AND google_event_id = ?', calendar.id, ev.id)
  const bookkeeping = calendar.is_bookkeeping === 1
  const owner = bookkeeping ? calendarOwner(db, calendar.id) : 0

  if (ev.status === 'cancelled' && !ev.recurringEventId) {
    if (old) {
      run(db, 'DELETE FROM events WHERE id = ?', old.id)
      // A deleted series takes its changed occurrences with it.
      run(db, 'DELETE FROM events WHERE calendar_id = ? AND recurring_event_id = ?', calendar.id, ev.id)
      if (bookkeeping && old.status !== 'cancelled') {
        const booking = parseBooking(old.summary, knownHashtags(db, owner))
        if (booking.kind === 'booked') {
          const locked = isLocked(db, owner, old.start)
          ctx.notify(
            locked ? 'warning' : 'info',
            `Booked event "${old.summary}" (${old.start}) was deleted in Google${locked ? ' in a locked month' : ''}.`,
            'Bookkeeping entry removed',
          )
        }
      }
    }
    return
  }

  const allDay = !!ev.start?.date
  const row = {
    etag: ev.etag ?? null,
    status: ev.status ?? 'confirmed',
    summary: ev.summary ?? '',
    description: ev.description ?? '',
    location: ev.location ?? '',
    start: timeOf(ev.start),
    end: timeOf(ev.end),
    all_day: allDay ? 1 : 0,
    time_zone: ev.start?.timeZone ?? ev.originalStartTime?.timeZone ?? defaultTz,
    recurrence: ev.recurrence ? JSON.stringify(ev.recurrence) : null,
    recurring_event_id: ev.recurringEventId ?? null,
    original_start: timeOf(ev.originalStartTime),
    organizer_self: ev.organizer?.self || (!ev.organizer && ev.creator?.self) ? 1 : 0,
    updated: ev.updated ?? null,
    raw_json: JSON.stringify(ev),
  }
  if (old) {
    run(
      db,
      `UPDATE events SET etag=?, status=?, summary=?, description=?, location=?, start=?, end=?, all_day=?, time_zone=?,
         recurrence=?, recurring_event_id=?, original_start=?, organizer_self=?, updated=?, raw_json=? WHERE id = ?`,
      row.etag, row.status, row.summary, row.description, row.location, row.start, row.end, row.all_day, row.time_zone,
      row.recurrence, row.recurring_event_id, row.original_start, row.organizer_self, row.updated, row.raw_json, old.id,
    )
  } else {
    run(
      db,
      `INSERT INTO events (calendar_id, google_event_id, etag, status, summary, description, location, start, end, all_day,
         time_zone, recurrence, recurring_event_id, original_start, organizer_self, updated, raw_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      calendar.id, ev.id, row.etag, row.status, row.summary, row.description, row.location, row.start, row.end, row.all_day,
      row.time_zone, row.recurrence, row.recurring_event_id, row.original_start, row.organizer_self, row.updated, row.raw_json,
    )
  }

  if (bookkeeping && row.status !== 'cancelled') {
    const known = knownHashtags(db, owner)
    const booking = parseBooking(row.summary, known)
    const titleChanged = !old || old.summary !== row.summary
    if (booking.kind === 'conflict' && titleChanged) {
      ctx.notify('warning', `"${row.summary}" (${row.start}) has two project hashtags (${booking.hashtags.map((h) => `#${h}`).join(', ')}) and is not booked.`, 'Bookkeeping conflict')
    }
    if (old && (old.summary !== row.summary || old.start !== row.start || old.end !== row.end)) {
      const wasBooked = parseBooking(old.summary, known).kind === 'booked'
      if ((wasBooked || booking.kind === 'booked') && (isLocked(db, owner, old.start) || isLocked(db, owner, row.start))) {
        ctx.notify('warning', `Booked event "${row.summary}" was changed in Google in a locked month (was "${old.summary}" ${old.start}–${old.end}, now ${row.start}–${row.end}).`, 'Locked month changed')
      }
    }
  }
}

function colorOf(c: GCalendar): string {
  return c.backgroundColor ?? '#4285f4'
}

/** Refreshes the account's calendar list. New calendars are shown by default. */
export async function syncCalendarList(ctx: Ctx, accountId: number): Promise<void> {
  const api = ctx.apiFor(accountId)
  const list = await api.listCalendars()
  const { db } = ctx
  tx(db, () => {
    const seen = new Set<string>()
    for (const c of list) {
      if (c.deleted) continue
      seen.add(c.id)
      const name = c.summaryOverride ?? c.summary ?? c.id
      const existing = get<CalendarRow>(db, 'SELECT * FROM calendars WHERE google_account_id = ? AND google_calendar_id = ?', accountId, c.id)
      if (existing) {
        run(db, 'UPDATE calendars SET name = ?, color = ?, access_role = ?, is_primary = ? WHERE id = ?', name, colorOf(c), c.accessRole ?? 'reader', c.primary ? 1 : 0, existing.id)
      } else {
        // A calendar called Bookkeeping that the user owns is taken to be theirs,
        // so a rebuilt database finds the existing one instead of making another.
        const userId = get<{ user_id: number }>(db, 'SELECT user_id FROM google_accounts WHERE id = ?', accountId)!.user_id
        const hasBookkeeping = !!get(db, `SELECT 1 FROM calendars c JOIN google_accounts a ON a.id = c.google_account_id WHERE a.user_id = ? AND c.is_bookkeeping = 1`, userId)
        const isBk = !hasBookkeeping && name === BOOKKEEPING_NAME && c.accessRole === 'owner' ? 1 : 0
        run(
          db,
          'INSERT INTO calendars (google_account_id, google_calendar_id, name, color, access_role, is_primary, is_bookkeeping) VALUES (?,?,?,?,?,?,?)',
          accountId, c.id, name, colorOf(c), c.accessRole ?? 'reader', c.primary ? 1 : 0, isBk,
        )
      }
    }
    for (const row of all<CalendarRow>(db, 'SELECT * FROM calendars WHERE google_account_id = ?', accountId)) {
      if (!seen.has(row.google_calendar_id)) run(db, 'DELETE FROM calendars WHERE id = ?', row.id)
    }
    run(db, 'UPDATE google_accounts SET calendars_synced_at = ? WHERE id = ?', now(), accountId)
  })
}

const running = new Map<number, Promise<void>>()

/** Syncs one calendar; concurrent calls for the same calendar share one run. */
export function syncCalendar(ctx: Ctx, calendarId: number): Promise<void> {
  // Runs are queued per calendar: a change may arrive after a running sync has
  // fetched, so a second request runs once more after it rather than joining it.
  const current = running.get(calendarId) ?? Promise.resolve()
  const p = current.catch(() => {}).then(() => syncCalendarNow(ctx, calendarId))
  running.set(calendarId, p)
  p.catch(() => {}).finally(() => {
    if (running.get(calendarId) === p) running.delete(calendarId)
  })
  return p
}

async function syncCalendarNow(ctx: Ctx, calendarId: number): Promise<void> {
  const { db } = ctx
  const cal = get<CalendarRow>(db, 'SELECT * FROM calendars WHERE id = ?', calendarId)
  if (!cal) return
  const api = ctx.apiFor(cal.google_account_id)
  let syncToken = cal.sync_token ?? undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let pageToken: string | undefined
      const full = !syncToken
      const changes: GEvent[] = []
      let nextSyncToken: string | undefined
      do {
        const page = await api.listEvents(cal.google_calendar_id, { syncToken, pageToken })
        changes.push(...page.items)
        pageToken = page.nextPageToken
        nextSyncToken = page.nextSyncToken ?? nextSyncToken
      } while (pageToken)
      // Masters before their exceptions, so a deleted master does not remove a
      // fresh exception arriving in the same batch.
      changes.sort((a, b) => Number(!!a.recurringEventId) - Number(!!b.recurringEventId))
      tx(db, () => {
        const fresh = get<CalendarRow>(db, 'SELECT * FROM calendars WHERE id = ?', calendarId)!
        if (full) {
          const ids = new Set(changes.map((e) => e.id))
          for (const r of all<{ id: number; google_event_id: string }>(db, 'SELECT id, google_event_id FROM events WHERE calendar_id = ?', calendarId)) {
            if (!ids.has(r.google_event_id)) storeEvent(ctx, fresh, { id: r.google_event_id, status: 'cancelled' })
          }
        }
        for (const ev of changes) storeEvent(ctx, fresh, ev)
        run(db, 'UPDATE calendars SET sync_token = ?, synced_at = ? WHERE id = ?', nextSyncToken ?? null, now(), calendarId)
      })
      if (full) ctx.notify('debug', `Full sync of "${cal.name}": ${changes.length} events.`)
      return
    } catch (err) {
      if (err instanceof GoneError && attempt === 0) {
        ctx.notify('info', `Sync token of "${cal.name}" expired; syncing it in full again.`)
        syncToken = undefined
        continue
      }
      throw err
    }
  }
}

const failures = new Map<string, number>()

function recordFailure(ctx: Ctx, key: string, what: string, err: unknown) {
  const n = (failures.get(key) ?? 0) + 1
  failures.set(key, n)
  // Once is noise (a network blip); three in a row is worth an email.
  ctx.notify(n === 3 ? 'warning' : 'info', `${what} failed (${n} in a row): ${String(err)}`, 'Calendar sync failed')
}

/** The calendar list and every calendar of one account. */
export async function syncAccount(ctx: Ctx, accountId: number): Promise<void> {
  const { db } = ctx
  const account = get<{ email: string; status: string }>(db, 'SELECT email, status FROM google_accounts WHERE id = ?', accountId)
  if (!account || account.status !== 'ok') return
  try {
    await syncCalendarList(ctx, accountId)
    failures.delete(`account:${accountId}`)
  } catch (err) {
    if (err instanceof GoogleAuthError) {
      run(db, "UPDATE google_accounts SET status = 'revoked' WHERE id = ?", accountId)
      ctx.notify('warning', `Google access for ${account.email} was revoked or expired; it has to log in again.`, 'Google account disconnected')
      return
    }
    recordFailure(ctx, `account:${accountId}`, `Calendar list of ${account.email}`, err)
    return
  }
  for (const cal of all<CalendarRow>(db, 'SELECT * FROM calendars WHERE google_account_id = ?', accountId)) {
    try {
      await syncCalendar(ctx, cal.id)
      failures.delete(`calendar:${cal.id}`)
    } catch (err) {
      if (err instanceof GoogleAuthError) {
        run(db, "UPDATE google_accounts SET status = 'revoked' WHERE id = ?", accountId)
        ctx.notify('warning', `Google access for ${account.email} was revoked or expired; it has to log in again.`, 'Google account disconnected')
        return
      }
      recordFailure(ctx, `calendar:${cal.id}`, `Sync of "${cal.name}" (${account.email})`, err)
    }
    await ensureWatch(ctx, cal.id).catch((err) => ctx.notify('debug', `Watch for "${cal.name}" failed: ${String(err)}`))
  }
}

export async function syncAll(ctx: Ctx): Promise<void> {
  for (const a of all<{ id: number }>(ctx.db, "SELECT id FROM google_accounts WHERE status = 'ok'")) {
    await syncAccount(ctx, a.id)
  }
}

/** Keeps a push channel open for the calendar, renewing it a day before it lapses. */
export async function ensureWatch(ctx: Ctx, calendarId: number): Promise<void> {
  if (!ctx.publicUrl?.startsWith('https://') || !ctx.pushToken) return
  const { db } = ctx
  const cal = get<CalendarRow>(db, 'SELECT * FROM calendars WHERE id = ?', calendarId)
  if (!cal) return
  if (cal.watch_expires_at && Date.parse(cal.watch_expires_at) - Date.now() > 24 * 3600_000) return
  const api = ctx.apiFor(cal.google_account_id)
  const channelId = randomUUID()
  const reply = await api.watch(cal.google_calendar_id, channelId, `${ctx.publicUrl}/google/push`, ctx.pushToken)
  const old = cal.watch_channel_id && cal.watch_resource_id ? { id: cal.watch_channel_id, resource: cal.watch_resource_id } : null
  run(db, 'UPDATE calendars SET watch_channel_id = ?, watch_resource_id = ?, watch_expires_at = ? WHERE id = ?',
    channelId, reply.resourceId, new Date(Number(reply.expiration)).toISOString(), calendarId)
  if (old) await api.stopChannel(old.id, old.resource).catch(() => {})
}

/** A push notification from Google: sync the calendar its channel belongs to. */
export function handlePush(ctx: Ctx, channelId: string, token: string | undefined, state: string | undefined): boolean {
  if (!ctx.pushToken || token !== ctx.pushToken) return false
  const cal = get<{ id: number }>(ctx.db, 'SELECT id FROM calendars WHERE watch_channel_id = ?', channelId)
  if (!cal) return false
  if (state === 'sync') return true // the handshake sent when a channel opens
  syncCalendar(ctx, cal.id).catch((err) => recordFailure(ctx, `calendar:${cal.id}`, `Push-triggered sync of calendar ${cal.id}`, err))
  return true
}

/** The user's Bookkeeping calendar, creating it in Google the first time. */
export async function ensureBookkeeping(ctx: Ctx, userId: number, accountId?: number): Promise<CalendarRow> {
  const { db } = ctx
  const existing = get<CalendarRow>(
    db,
    'SELECT c.* FROM calendars c JOIN google_accounts a ON a.id = c.google_account_id WHERE a.user_id = ? AND c.is_bookkeeping = 1',
    userId,
  )
  if (existing) return existing
  const account = accountId
    ? get<{ id: number }>(db, "SELECT id FROM google_accounts WHERE id = ? AND user_id = ? AND status = 'ok'", accountId, userId)
    : get<{ id: number }>(db, `SELECT a.id FROM google_accounts a JOIN users u ON u.id = a.user_id
        WHERE a.user_id = ? AND a.status = 'ok' ORDER BY a.email = u.primary_email DESC, a.id LIMIT 1`, userId)
  if (!account) throw new Error('no linked Google account to create the Bookkeeping calendar in')
  const api = ctx.apiFor(account.id)
  const created = await api.insertCalendar(BOOKKEEPING_NAME, 'Europe/Helsinki')
  run(db, `INSERT INTO calendars (google_account_id, google_calendar_id, name, color, access_role, is_primary, is_bookkeeping, selected)
    VALUES (?, ?, ?, '#0b8043', 'owner', 0, 1, 1)`, account.id, created.id, BOOKKEEPING_NAME)
  ctx.notify('info', `Created the Bookkeeping calendar for user ${userId} in Google.`, 'Bookkeeping calendar created')
  const row = get<CalendarRow>(db, 'SELECT * FROM calendars WHERE google_account_id = ? AND google_calendar_id = ?', account.id, created.id)!
  await syncCalendar(ctx, row.id)
  return row
}
