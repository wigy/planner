// Automatic booking: the project hashtag decides which calendar an event is in.
// An event in one of the user's own calendars whose title or description has
// exactly one known project hashtag is moved to Bookkeeping; a Bookkeeping event
// that no longer has one is moved back where it came from. There is only ever
// the one event: nothing is copied.
//
// - Moving records the origin calendar in the moved_events table (Google drops
//   private extended properties when an event changes calendar); without one,
//   the event goes back to the primary calendar of the Bookkeeping account.
// - Google moves only events the user organizes, within one account, and a
//   series only as a whole. Someone else's meeting stays where it is, and the
//   user is told once; Send to Bookkeeping copies it on request.
// - All-day events stay where they are: their hours are not known.
// - Two different project hashtags are a conflict: the event is not moved.
// - Nothing in a locked month moves.
// - Automatic copies made by the earlier version (`planner_auto`) are deleted,
//   and their sources are moved in instead.
// - The run reconciles the whole state, so it is safe to repeat and catches up
//   after any missed change.

import { parseEventBooking } from '../shared/hashtag.ts'
import { monthOf } from '../shared/time.ts'
import { all, type Db, get, now, run } from './db.ts'
import type { GEvent } from './google.ts'
import { type CalendarRow, type Ctx, ensureBookkeeping, type EventRow, storeEvent, syncCalendar } from './sync.ts'

export type AutoBookResult = { movedIn: number; movedOut: number; removedCopies: number; skipped: number; failed: number }

function monthOfStart(start: string): string {
  return start.length === 10 ? start.slice(0, 7) : monthOf(new Date(start))
}

function ownCalendars(db: Db, userId: number): CalendarRow[] {
  return all<CalendarRow>(
    db,
    `SELECT c.* FROM calendars c JOIN google_accounts a ON a.id = c.google_account_id
     WHERE a.user_id = ? AND a.status = 'ok' AND c.is_bookkeeping = 0 AND c.access_role = 'owner'`,
    userId,
  )
}

function bookkeeping(db: Db, userId: number): CalendarRow | undefined {
  return get<CalendarRow>(
    db,
    'SELECT c.* FROM calendars c JOIN google_accounts a ON a.id = c.google_account_id WHERE a.user_id = ? AND c.is_bookkeeping = 1',
    userId,
  )
}

function priv(ev: EventRow): Record<string, string> {
  return (JSON.parse(ev.raw_json) as GEvent).extendedProperties?.private ?? {}
}

/** Remembers which calendar an event was moved into Bookkeeping from. */
export function recordOrigin(db: Db, accountId: number, googleEventId: string, originCalendar: string) {
  run(db, `INSERT INTO moved_events (google_account_id, google_event_id, origin_calendar, moved_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (google_account_id, google_event_id) DO UPDATE SET origin_calendar = excluded.origin_calendar, moved_at = excluded.moved_at`,
    accountId, googleEventId, originCalendar, now())
}

const told = new Set<string>()

async function reconcile(ctx: Ctx, userId: number): Promise<AutoBookResult> {
  const { db } = ctx
  const result: AutoBookResult = { movedIn: 0, movedOut: 0, removedCopies: 0, skipped: 0, failed: 0 }
  const known = all<{ hashtag: string }>(db, 'SELECT hashtag FROM projects WHERE user_id = ?', userId).map((r) => r.hashtag)
  const lockedList = all<{ month: string }>(db, 'SELECT month FROM locked_months WHERE user_id = ?', userId).map((r) => r.month)
  const locked = (ev: EventRow) => {
    const m = monthOfStart(ev.start!)
    // A series reaches every month after its start, so a later locked month holds it too.
    return ev.recurrence ? lockedList.some((l) => l >= m) : lockedList.includes(m)
  }
  const tell = (key: string, level: 'info' | 'warning', text: string) => {
    if (told.has(key)) return
    told.add(key)
    ctx.notify(level, text, 'Automatic booking')
  }
  const touched = new Set<number>()
  let bk = bookkeeping(db, userId)

  // Masters and single events; a changed occurrence moves with its series.
  const events = (calendarId: number) =>
    all<EventRow>(db, "SELECT * FROM events WHERE calendar_id = ? AND status != 'cancelled' AND recurring_event_id IS NULL AND start IS NOT NULL", calendarId)

  // 1. Copies from the earlier version go; their sources are moved in below.
  if (bk) {
    for (const ev of events(bk.id)) {
      if (priv(ev).planner_auto !== '1') continue
      if (locked(ev)) continue
      try {
        await ctx.apiFor(bk.google_account_id).deleteEvent(bk.google_calendar_id, ev.google_event_id)
        run(db, 'DELETE FROM events WHERE id = ?', ev.id)
        touched.add(bk.id)
        result.removedCopies++
      } catch (err) {
        result.failed++
        ctx.notify('info', `Removing the automatic copy "${ev.summary}" (${ev.start}) failed: ${String(err)}`)
      }
    }
  }

  // 2. Tagged events move in.
  const own = ownCalendars(db, userId)
  for (const cal of own) {
    for (const ev of events(cal.id)) {
      if (!ev.summary.includes('#') && !ev.description.includes('#')) continue
      if (parseEventBooking(ev.summary, ev.description, known).kind !== 'booked') continue
      if (priv(ev).planner_source) continue // a copy sent by hand stays a copy
      const key = `${cal.google_calendar_id}/${ev.google_event_id}`
      if (ev.all_day === 1) {
        result.skipped++
        continue
      }
      if (ev.organizer_self !== 1) {
        tell(`foreign:${key}`, 'info', `"${ev.summary}" (${ev.start}) has a project hashtag, but it is someone else's meeting and cannot be moved to Bookkeeping. Use Send to Bookkeeping to copy it.`)
        result.skipped++
        continue
      }
      if (locked(ev)) {
        tell(`locked-in:${key}`, 'warning', `"${ev.summary}" (${ev.start}) has a project hashtag, but its month is locked, so it was not moved to Bookkeeping.`)
        result.skipped++
        continue
      }
      try {
        bk ??= await ensureBookkeeping(ctx, userId, cal.google_account_id)
        if (bk.google_account_id !== cal.google_account_id) {
          tell(`account:${key}`, 'info', `"${ev.summary}" (${ev.start}) has a project hashtag, but it is in another Google account than Bookkeeping, and Google moves events only within one account.`)
          result.skipped++
          continue
        }
        const api = ctx.apiFor(cal.google_account_id)
        const moved = await api.moveEvent(cal.google_calendar_id, ev.google_event_id, bk.google_calendar_id)
        run(db, 'DELETE FROM events WHERE calendar_id = ? AND (google_event_id = ? OR recurring_event_id = ?)', cal.id, ev.google_event_id, ev.google_event_id)
        storeEvent(ctx, bk, moved)
        recordOrigin(db, cal.google_account_id, ev.google_event_id, cal.google_calendar_id)
        touched.add(cal.id).add(bk.id)
        result.movedIn++
      } catch (err) {
        result.failed++
        ctx.notify('info', `Moving "${ev.summary}" (${ev.start}) to Bookkeeping failed: ${String(err)}`)
      }
    }
  }

  // 3. Untagged Bookkeeping events move back out.
  if (bk) {
    const primary = get<CalendarRow>(db, 'SELECT * FROM calendars WHERE google_account_id = ? AND is_primary = 1', bk.google_account_id)
    for (const ev of events(bk.id)) {
      const p = priv(ev)
      if (p.planner_source || p.planner_auto === '1') continue // copies stay; old automatic ones went above
      const booking = parseEventBooking(ev.summary, ev.description, known)
      if (booking.kind !== 'none') continue
      const key = `${bk.google_calendar_id}/${ev.google_event_id}`
      const from = get<{ origin_calendar: string }>(db, 'SELECT origin_calendar FROM moved_events WHERE google_account_id = ? AND google_event_id = ?', bk.google_account_id, ev.google_event_id)
      const origin = own.find((c) => c.google_calendar_id === from?.origin_calendar && c.google_account_id === bk!.google_account_id) ?? primary
      if (!origin) continue
      if (locked(ev)) {
        tell(`locked-out:${key}`, 'warning', `"${ev.summary}" (${ev.start}) lost its project hashtag, but its month is locked, so it stays in Bookkeeping.`)
        continue
      }
      if (ev.organizer_self !== 1) continue
      try {
        const api = ctx.apiFor(bk.google_account_id)
        const moved = await api.moveEvent(bk.google_calendar_id, ev.google_event_id, origin.google_calendar_id)
        run(db, 'DELETE FROM events WHERE calendar_id = ? AND (google_event_id = ? OR recurring_event_id = ?)', bk.id, ev.google_event_id, ev.google_event_id)
        storeEvent(ctx, origin, moved)
        run(db, 'DELETE FROM moved_events WHERE google_account_id = ? AND google_event_id = ?', bk.google_account_id, ev.google_event_id)
        touched.add(bk.id).add(origin.id)
        result.movedOut++
      } catch (err) {
        result.failed++
        ctx.notify('info', `Moving "${ev.summary}" (${ev.start}) out of Bookkeeping failed: ${String(err)}`)
      }
    }
  }

  for (const id of touched) await syncCalendar(ctx, id).catch(() => {})
  if (result.movedIn || result.movedOut || result.removedCopies || result.failed) {
    const parts = [`${result.movedIn} moved to Bookkeeping`, `${result.movedOut} moved out of it`]
    if (result.removedCopies) parts.push(`${result.removedCopies} old automatic copies removed`)
    if (result.failed) parts.push(`${result.failed} failed`)
    ctx.notify(result.failed ? 'warning' : 'info', `Automatic booking for user ${userId}: ${parts.join(', ')}.`, 'Automatic booking')
  }
  return result
}

const queue = new Map<number, { running: Promise<AutoBookResult>; again: boolean }>()

/**
 * Brings the user's calendars in line with their hashtags. Calls while a run is
 * going are folded into one more run after it.
 */
export function autoBook(ctx: Ctx, userId: number): Promise<AutoBookResult> {
  const q = queue.get(userId)
  if (q) {
    q.again = true
    return q.running
  }
  const entry = { running: Promise.resolve() as unknown as Promise<AutoBookResult>, again: false }
  entry.running = (async () => {
    try {
      let r = await reconcile(ctx, userId)
      while (entry.again) {
        entry.again = false
        r = await reconcile(ctx, userId)
      }
      return r
    } finally {
      queue.delete(userId)
    }
  })()
  queue.set(userId, entry)
  return entry.running
}
