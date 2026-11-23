// Automatic booking: an event in one of the user's own calendars whose title has
// exactly one known project hashtag is copied to Bookkeeping, and the copy then
// follows its source. The copy is marked `planner_auto` in its private extended
// properties next to `planner_source`, so copies sent by hand are never touched.
//
// - Only calendars the user owns count, not calendars shared with them, and never
//   Bookkeeping itself.
// - A recurring series is copied occurrence by occurrence, up to the end of the
//   current month; later ones follow as the months pass.
// - All-day events are skipped: their hours are not known.
// - When the source changes, the copy is updated; when the source loses the
//   hashtag or is deleted, the copy is deleted. Locked months are never touched.
// - The run reconciles the whole state, so it is safe to repeat and catches up
//   after any missed change.

import { parseBooking, setBooking } from '../shared/hashtag.ts'
import { monthOf, monthRange, REPORT_TZ } from '../shared/time.ts'
import { all, type Db, get, run } from './db.ts'
import type { GEvent, GEventTime } from './google.ts'
import { expand } from './recurrence.ts'
import { type CalendarRow, type Ctx, ensureBookkeeping, type EventRow, storeEvent, syncCalendar } from './sync.ts'

type Wanted = { key: string; summary: string; start: string; end: string; description: string; location: string; timeZone: string }

type Copy = { id: number; google_event_id: string; key: string; summary: string; start: string; end: string; description: string; location: string }

export type AutoBookResult = { created: number; updated: number; removed: number; skipped: number; failed: number }

function lockedMonths(db: Db, userId: number): Set<string> {
  return new Set(all<{ month: string }>(db, 'SELECT month FROM locked_months WHERE user_id = ?', userId).map((r) => r.month))
}

function monthOfStart(start: string): string {
  return start.length === 10 ? start.slice(0, 7) : monthOf(new Date(start))
}

function sourceCalendars(db: Db, userId: number): CalendarRow[] {
  return all<CalendarRow>(
    db,
    `SELECT c.* FROM calendars c JOIN google_accounts a ON a.id = c.google_account_id
     WHERE a.user_id = ? AND a.status = 'ok' AND c.is_bookkeeping = 0 AND c.access_role = 'owner'`,
    userId,
  )
}

/** Every copy the user's events call for right now, by source key. */
function wanted(db: Db, userId: number, known: string[], horizon: Date): { wanted: Map<string, Wanted>; skipped: number } {
  const out = new Map<string, Wanted>()
  let skipped = 0
  for (const cal of sourceCalendars(db, userId)) {
    const rows = all<EventRow>(db, "SELECT * FROM events WHERE calendar_id = ? AND status != 'cancelled' AND summary LIKE '%#%'", cal.id)
    const replaced = new Map<string, Set<string>>()
    for (const r of all<{ recurring_event_id: string; original_start: string }>(
      db,
      'SELECT recurring_event_id, original_start FROM events WHERE calendar_id = ? AND recurring_event_id IS NOT NULL',
      cal.id,
    )) {
      if (!replaced.has(r.recurring_event_id)) replaced.set(r.recurring_event_id, new Set())
      replaced.get(r.recurring_event_id)!.add(r.original_start)
    }
    for (const ev of rows) {
      if (!ev.start || !ev.end) continue
      const booking = parseBooking(ev.summary, known)
      if (booking.kind !== 'booked') continue
      if (ev.all_day === 1) {
        skipped++
        continue
      }
      const base = {
        summary: setBooking(ev.summary, booking.hashtag, known),
        description: ev.description,
        location: ev.location,
        timeZone: ev.time_zone ?? REPORT_TZ,
      }
      const source = `${cal.google_calendar_id}/${ev.google_event_id}`
      if (ev.recurrence) {
        const spans = expand(
          { start: ev.start, end: ev.end, allDay: false, timeZone: base.timeZone, recurrence: JSON.parse(ev.recurrence) },
          new Date(ev.start),
          horizon,
          replaced.get(ev.google_event_id),
        )
        for (const s of spans) out.set(`${source}@${s.start}`, { key: `${source}@${s.start}`, start: s.start, end: s.end, ...base })
      } else {
        out.set(source, { key: source, start: ev.start, end: ev.end, ...base })
      }
    }
  }
  return { wanted: out, skipped }
}

function copies(db: Db, userId: number): { auto: Map<string, Copy & { cal: CalendarRow }>; manual: Set<string> } {
  const rows = all<Copy & { auto: string | null; calendar_id: number }>(
    db,
    `SELECT e.id, e.google_event_id, e.summary, e.start, e.end, e.description, e.location, e.calendar_id,
       json_extract(e.raw_json, '$.extendedProperties.private.planner_source') AS key,
       json_extract(e.raw_json, '$.extendedProperties.private.planner_auto') AS auto
     FROM events e JOIN calendars c ON c.id = e.calendar_id JOIN google_accounts a ON a.id = c.google_account_id
     WHERE a.user_id = ? AND c.is_bookkeeping = 1 AND e.status != 'cancelled' AND key IS NOT NULL`,
    userId,
  )
  const auto = new Map<string, Copy & { cal: CalendarRow }>()
  const manual = new Set<string>()
  for (const r of rows) {
    if (r.auto === '1') auto.set(r.key, { ...r, cal: get<CalendarRow>(db, 'SELECT * FROM calendars WHERE id = ?', r.calendar_id)! })
    else manual.add(r.key)
  }
  return { auto, manual }
}

function timeBody(w: Wanted): { start: GEventTime; end: GEventTime } {
  return { start: { dateTime: w.start, timeZone: w.timeZone }, end: { dateTime: w.end, timeZone: w.timeZone } }
}

const warned = new Set<string>()

async function reconcile(ctx: Ctx, userId: number): Promise<AutoBookResult> {
  const { db } = ctx
  const result: AutoBookResult = { created: 0, updated: 0, removed: 0, skipped: 0, failed: 0 }
  const known = all<{ hashtag: string }>(db, 'SELECT hashtag FROM projects WHERE user_id = ?', userId).map((r) => r.hashtag)
  const horizon = monthRange(monthOf(new Date())).end
  const w = wanted(db, userId, known, horizon)
  result.skipped = w.skipped
  const have = copies(db, userId)
  const locked = lockedMonths(db, userId)
  const isLocked = (start: string) => locked.has(monthOfStart(start))
  const warnLocked = (key: string, text: string) => {
    if (warned.has(key)) return
    warned.add(key)
    ctx.notify('warning', text, 'Locked month changed')
  }
  const toCreate = [...w.wanted.values()].filter((x) => !have.auto.has(x.key) && !have.manual.has(x.key))
  if (toCreate.length === 0 && have.auto.size === 0) return result

  const ownedCalendars = new Set(sourceCalendars(db, userId).map((c) => c.google_calendar_id))
  let bk: CalendarRow | undefined = have.auto.values().next().value?.cal
  const touched = new Set<number>()

  for (const x of toCreate) {
    if (isLocked(x.start)) {
      warnLocked(`create:${x.key}`, `"${x.summary}" (${x.start}) was not booked automatically: its month is locked.`)
      result.skipped++
      continue
    }
    try {
      bk ??= await ensureBookkeeping(ctx, userId)
      const reply = await ctx.apiFor(bk.google_account_id).insertEvent(bk.google_calendar_id, {
        summary: x.summary,
        description: x.description,
        location: x.location,
        ...timeBody(x),
        extendedProperties: { private: { planner_source: x.key, planner_auto: '1' } },
      })
      storeEvent(ctx, bk, reply)
      touched.add(bk.id)
      result.created++
    } catch (err) {
      result.failed++
      ctx.notify('info', `Automatic booking of "${x.summary}" (${x.start}) failed: ${String(err)}`)
    }
  }

  for (const [key, copy] of have.auto) {
    const x = w.wanted.get(key)
    const sourceCalendar = key.slice(0, key.indexOf('/'))
    try {
      if (!x) {
        // A calendar that has gone from the list says nothing about its events.
        if (!ownedCalendars.has(sourceCalendar)) continue
        if (isLocked(copy.start)) {
          warnLocked(`remove:${key}`, `The source of booked event "${copy.summary}" (${copy.start}) lost its hashtag or was deleted, but its month is locked; the booking was kept.`)
          continue
        }
        await ctx.apiFor(copy.cal.google_account_id).deleteEvent(copy.cal.google_calendar_id, copy.google_event_id)
        run(db, 'DELETE FROM events WHERE id = ?', copy.id)
        touched.add(copy.cal.id)
        result.removed++
        continue
      }
      const same =
        copy.summary === x.summary &&
        Date.parse(copy.start) === Date.parse(x.start) &&
        Date.parse(copy.end) === Date.parse(x.end) &&
        copy.description === x.description &&
        copy.location === x.location
      if (same) continue
      if (isLocked(copy.start) || isLocked(x.start)) {
        warnLocked(`update:${key}:${x.summary}:${x.start}:${x.end}`, `The source of booked event "${copy.summary}" (${copy.start}) changed, but the month is locked; the booking was kept as it was.`)
        continue
      }
      const body: Partial<GEvent> = { summary: x.summary, description: x.description, location: x.location, ...timeBody(x) }
      const reply = await ctx.apiFor(copy.cal.google_account_id).patchEvent(copy.cal.google_calendar_id, copy.google_event_id, body)
      storeEvent(ctx, copy.cal, reply)
      touched.add(copy.cal.id)
      result.updated++
    } catch (err) {
      result.failed++
      ctx.notify('info', `Automatic booking update of "${copy.summary}" (${copy.start}) failed: ${String(err)}`)
    }
  }

  for (const id of touched) await syncCalendar(ctx, id).catch(() => {})
  if (result.created || result.updated || result.removed || result.failed) {
    ctx.notify(
      result.failed ? 'warning' : 'info',
      `Automatic booking for user ${userId}: ${result.created} copied to Bookkeeping, ${result.updated} updated, ${result.removed} removed${result.failed ? `, ${result.failed} failed` : ''}.`,
      'Automatic booking',
    )
  }
  return result
}

const queue = new Map<number, { running: Promise<AutoBookResult>; again: boolean }>()

/**
 * Brings the user's automatic Bookkeeping copies up to date. Calls while a run is
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
