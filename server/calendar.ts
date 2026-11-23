// Calendar views and edits. Every edit goes to Google first; the mirror is updated
// from Google's reply, so it never holds something Google lacks. An edit made
// against a stale etag gets a 412 from Google: the event is fetched again and the
// user sees the newer version (Google wins; nothing is merged).

import { parseEventBooking, removeHashtagsKeepLayout, setBooking, setEventBooking } from '../shared/hashtag.ts'
import { monthOf, REPORT_TZ } from '../shared/time.ts'
import type { Calendar, Occurrence } from '../shared/types.ts'
import { all, type Db, get } from './db.ts'
import { Conflict, Forbidden, Invalid, NotFound } from './errors.ts'
import { type GEvent, type GEventTime, PreconditionFailed } from './google.ts'
import { expand } from './recurrence.ts'
import { type CalendarRow, type Ctx, ensureBookkeeping, type EventRow, knownHashtags, storeEvent, syncCalendar } from './sync.ts'

type ProjectTag = { id: number; hashtag: string }

export function userCalendars(db: Db, userId: number): (CalendarRow & { email: string })[] {
  return all(
    db,
    `SELECT c.*, a.email FROM calendars c JOIN google_accounts a ON a.id = c.google_account_id
     WHERE a.user_id = ? ORDER BY a.id, c.is_primary DESC, c.is_bookkeeping DESC, c.name`,
    userId,
  )
}

export function calendarJson(c: CalendarRow & { email: string }): Calendar {
  return {
    id: c.id,
    account: c.email,
    name: c.name,
    color: c.color,
    accessRole: c.access_role,
    primary: c.is_primary === 1,
    selected: c.selected === 1,
    bookkeeping: c.is_bookkeeping === 1,
    syncedAt: c.synced_at,
  }
}

function writable(c: CalendarRow): boolean {
  return c.access_role === 'owner' || c.access_role === 'writer'
}

/** The key a Bookkeeping copy records for its source, in extendedProperties.private. */
export function sourceKey(cal: CalendarRow, ev: EventRow, occurrenceStart?: string): string {
  return occurrenceStart ? `${cal.google_calendar_id}/${ev.google_event_id}@${occurrenceStart}` : `${cal.google_calendar_id}/${ev.google_event_id}`
}

/** Bookkeeping events of the user, by the source they were copied from. */
function sentMap(db: Db, userId: number): Map<string, number> {
  const rows = all<{ id: number; source: string }>(
    db,
    `SELECT e.id, json_extract(e.raw_json, '$.extendedProperties.private.planner_source') AS source
     FROM events e JOIN calendars c ON c.id = e.calendar_id JOIN google_accounts a ON a.id = c.google_account_id
     WHERE a.user_id = ? AND c.is_bookkeeping = 1 AND e.status != 'cancelled' AND source IS NOT NULL`,
    userId,
  )
  return new Map(rows.map((r) => [r.source, r.id]))
}

/** Occurrences of the user's calendars overlapping [from, to). */
export function occurrences(db: Db, userId: number, from: Date, to: Date, onlySelected = true): Occurrence[] {
  const cals = userCalendars(db, userId).filter((c) => !onlySelected || c.selected === 1)
  if (cals.length === 0) return []
  const byId = new Map(cals.map((c) => [c.id, c]))
  const projects = all<ProjectTag>(db, 'SELECT id, hashtag FROM projects WHERE user_id = ?', userId)
  const tagToId = new Map(projects.map((p) => [p.hashtag.toLowerCase(), p.id]))
  const known = [...tagToId.keys()]
  const sent = sentMap(db, userId)
  const fromDate = new Date(from.getTime() - 86400_000).toISOString().slice(0, 10)
  const toDate = new Date(to.getTime() + 86400_000).toISOString().slice(0, 10)
  const ids = cals.map((c) => c.id).join(',')
  const rows = all<EventRow>(
    db,
    `SELECT * FROM events WHERE calendar_id IN (${ids}) AND (
       recurrence IS NOT NULL OR
       (all_day = 0 AND start < ? AND end > ?) OR
       (all_day = 1 AND start < ? AND end > ?))`,
    to.toISOString(), from.toISOString(), toDate, fromDate,
  )
  const replaced = new Map<string, Set<string>>() // `${calendar}/${series id}` -> original starts
  const exceptionRows = all<{ calendar_id: number; recurring_event_id: string; original_start: string }>(
    db,
    `SELECT calendar_id, recurring_event_id, original_start FROM events WHERE calendar_id IN (${ids}) AND recurring_event_id IS NOT NULL`,
  )
  for (const r of exceptionRows) {
    const key = `${r.calendar_id}/${r.recurring_event_id}`
    if (!replaced.has(key)) replaced.set(key, new Set())
    replaced.get(key)!.add(r.original_start)
  }

  const out: Occurrence[] = []
  const make = (ev: EventRow, cal: CalendarRow, start: string, end: string, expanded: boolean): Occurrence => {
    const booking = parseEventBooking(ev.summary, ev.description, known)
    const bk = cal.is_bookkeeping === 1
    const key = expanded ? sourceKey(cal, ev, start) : sourceKey(cal, ev)
    return {
      id: expanded ? `${ev.id}@${start}` : String(ev.id),
      eventId: ev.id,
      calendarId: cal.id,
      title: ev.summary,
      description: ev.description,
      location: ev.location,
      start,
      end,
      allDay: ev.all_day === 1,
      recurring: expanded || !!ev.recurring_event_id,
      editable: writable(cal),
      organizerSelf: ev.organizer_self === 1,
      booking: !bk
        ? { kind: 'none' }
        : booking.kind === 'booked'
          ? { kind: 'booked', projectId: tagToId.get(booking.hashtag)! }
          : booking.kind === 'conflict'
            ? { kind: 'conflict', hashtags: booking.hashtags }
            : { kind: 'none' },
      taggedProjectId: !bk && booking.kind === 'booked' ? tagToId.get(booking.hashtag)! : null,
      sentTo: bk ? null : (sent.get(key) ?? null),
      autoCopy: bk && ev.raw_json.includes('"planner_auto"') && JSON.parse(ev.raw_json).extendedProperties?.private?.planner_auto === '1',
      unknownHashtags: booking.unknown,
    }
  }
  for (const ev of rows) {
    const cal = byId.get(ev.calendar_id)!
    if (ev.status === 'cancelled' || !ev.start || !ev.end) continue
    if (ev.recurrence) {
      const spans = expand(
        { start: ev.start, end: ev.end, allDay: ev.all_day === 1, timeZone: ev.time_zone ?? REPORT_TZ, recurrence: JSON.parse(ev.recurrence) },
        from,
        to,
        replaced.get(`${ev.calendar_id}/${ev.google_event_id}`),
      )
      for (const s of spans) out.push(make(ev, cal, s.start, s.end, true))
    } else {
      out.push(make(ev, cal, ev.start, ev.end, false))
    }
  }
  return out
}

/** Unknown hashtags in the user's Bookkeeping events, so projects can be made for them. */
export function unknownHashtags(db: Db, userId: number): { hashtag: string; count: number }[] {
  const known = knownHashtags(db, userId)
  const rows = all<{ summary: string; description: string }>(
    db,
    `SELECT e.summary, e.description FROM events e JOIN calendars c ON c.id = e.calendar_id JOIN google_accounts a ON a.id = c.google_account_id
     WHERE a.user_id = ? AND c.is_bookkeeping = 1 AND e.status != 'cancelled' AND (e.summary LIKE '%#%' OR e.description LIKE '%#%')`,
    userId,
  )
  const counts = new Map<string, number>()
  for (const r of rows) for (const t of parseEventBooking(r.summary, r.description, known).unknown) counts.set(t, (counts.get(t) ?? 0) + 1)
  return [...counts].map(([hashtag, count]) => ({ hashtag, count })).sort((a, b) => b.count - a.count)
}

// ---- edits -----------------------------------------------------------------

type Target = { cal: CalendarRow; ev: EventRow }

function target(db: Db, userId: number, eventId: number): Target {
  const ev = get<EventRow>(db, 'SELECT * FROM events WHERE id = ?', eventId)
  if (!ev) throw new NotFound('no such event')
  const cal = get<CalendarRow>(
    db,
    'SELECT c.* FROM calendars c JOIN google_accounts a ON a.id = c.google_account_id WHERE c.id = ? AND a.user_id = ?',
    ev.calendar_id,
    userId,
  )
  if (!cal) throw new NotFound('no such event')
  return { cal, ev }
}

function lockedMonth(db: Db, userId: number, start: string | null | undefined): string | null {
  if (!start) return null
  const month = start.length === 10 ? start.slice(0, 7) : monthOf(new Date(start))
  return get(db, 'SELECT 1 FROM locked_months WHERE user_id = ? AND month = ?', userId, month) ? month : null
}

function refuseLocked(db: Db, userId: number, cal: CalendarRow, ...starts: (string | null | undefined)[]) {
  if (cal.is_bookkeeping !== 1) return
  for (const s of starts) {
    const m = lockedMonth(db, userId, s)
    if (m) throw new Conflict(`${m} is locked: unlock it in Reports before changing its bookings`)
  }
}

export type TimeInput = { start: string; end: string; allDay: boolean }

function timeBody(t: TimeInput, tz: string): { start: GEventTime; end: GEventTime } {
  if (t.allDay) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t.start) || !/^\d{4}-\d{2}-\d{2}$/.test(t.end)) throw new Invalid('all-day times are dates')
    if (t.end <= t.start) throw new Invalid('end must be after start')
    return { start: { date: t.start }, end: { date: t.end } }
  }
  const s = new Date(t.start)
  const e = new Date(t.end)
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) throw new Invalid('bad time')
  if (e <= s) throw new Invalid('end must be after start')
  return { start: { dateTime: s.toISOString(), timeZone: tz }, end: { dateTime: e.toISOString(), timeZone: tz } }
}

async function afterWrite(ctx: Ctx, cal: CalendarRow, reply: GEvent | undefined) {
  if (reply) storeEvent(ctx, cal, reply)
  // An incremental sync also picks up what the reply does not show, such as the
  // exception rows Google creates when one occurrence of a series is changed.
  await syncCalendar(ctx, cal.id)
}

/**
 * Google merges a patch's start and end into the old ones field by field, so a
 * switch between timed and all-day has to clear the other kind of time, or the
 * event would carry both and Google refuses it ("Invalid start time").
 */
function clearOtherTime(t: GEventTime): GEventTime {
  return t.date ? { date: t.date, dateTime: null, timeZone: null } : { ...t, date: null }
}

async function patch(ctx: Ctx, t: Target, eventId: string, body: Partial<GEvent>, etag?: string): Promise<GEvent> {
  const api = ctx.apiFor(t.cal.google_account_id)
  if (body.start) body.start = clearOtherTime(body.start)
  if (body.end) body.end = clearOtherTime(body.end)
  try {
    return await api.patchEvent(t.cal.google_calendar_id, eventId, body, etag)
  } catch (err) {
    if (err instanceof PreconditionFailed) {
      const fresh = await api.getEvent(t.cal.google_calendar_id, eventId)
      storeEvent(ctx, t.cal, fresh)
      ctx.notify('info', `Edit of "${t.ev.summary}" lost to a newer change in Google; the newer version was kept.`, 'Calendar conflict')
      throw new Conflict('the event was changed in Google meanwhile; showing the newer version, please redo your edit')
    }
    throw err
  }
}

/** The Google id of one occurrence of a series, found with events.instances. */
async function instanceId(ctx: Ctx, t: Target, occurrenceStart: string): Promise<string> {
  const api = ctx.apiFor(t.cal.google_account_id)
  const allDay = t.ev.all_day === 1
  const startMs = allDay ? Date.parse(`${occurrenceStart}T00:00:00Z`) - 14 * 3600_000 : Date.parse(occurrenceStart)
  const endMs = allDay ? startMs + 38 * 3600_000 : startMs + 60_000
  const items = await api.instances(t.cal.google_calendar_id, t.ev.google_event_id, new Date(startMs).toISOString(), new Date(endMs).toISOString())
  const match = items.find((i) => {
    const o = i.originalStartTime
    return allDay ? o?.date === occurrenceStart : o?.dateTime && Date.parse(o.dateTime) === Date.parse(occurrenceStart)
  })
  if (!match) throw new NotFound('that occurrence no longer exists in Google')
  return match.id
}

export type EventInput = {
  calendarId: number
  title: string
  description?: string
  location?: string
  projectId?: number | null
} & TimeInput

export async function createEvent(ctx: Ctx, userId: number, input: EventInput): Promise<number> {
  const { db } = ctx
  const cal = userCalendars(db, userId).find((c) => c.id === input.calendarId)
  if (!cal) throw new NotFound('no such calendar')
  if (!writable(cal)) throw new Forbidden('that calendar is read-only')
  refuseLocked(db, userId, cal, input.start)
  let summary = input.title.trim()
  if ((cal.is_bookkeeping === 1 || cal.access_role === 'owner') && input.projectId) {
    const project = projectOf(db, userId, input.projectId)
    summary = setBooking(summary, project.hashtag, knownHashtags(db, userId))
  }
  if (!summary) throw new Invalid('title required')
  const api = ctx.apiFor(cal.google_account_id)
  const reply = await api.insertEvent(cal.google_calendar_id, {
    summary,
    description: input.description ?? '',
    location: input.location ?? '',
    ...timeBody(input, REPORT_TZ),
  })
  await afterWrite(ctx, cal, reply)
  return get<{ id: number }>(db, 'SELECT id FROM events WHERE calendar_id = ? AND google_event_id = ?', cal.id, reply.id)!.id
}

export type EventPatch = {
  title?: string
  description?: string
  location?: string
  time?: TimeInput
  /** The occurrence being edited, for a series; with scope 'series' the whole series changes. */
  occurrenceStart?: string
  scope?: 'instance' | 'series'
}

export async function updateEvent(ctx: Ctx, userId: number, eventId: number, p: EventPatch): Promise<void> {
  const { db } = ctx
  const t = target(db, userId, eventId)
  if (!writable(t.cal)) throw new Forbidden('that calendar is read-only')
  refuseLocked(db, userId, t.cal, t.ev.start, p.occurrenceStart, p.time?.start)
  const body: Partial<GEvent> = {}
  if (p.title !== undefined) body.summary = p.title
  if (p.description !== undefined) body.description = p.description
  if (p.location !== undefined) body.location = p.location
  const tz = t.ev.time_zone ?? REPORT_TZ

  if (t.ev.recurrence && p.occurrenceStart) {
    if (p.scope === 'series') {
      if (p.time) {
        // Moving one occurrence with scope 'series' shifts the whole series by the same amount.
        const allDay = t.ev.all_day === 1
        if (allDay !== p.time.allDay) throw new Invalid('a series cannot switch between all-day and timed here')
        if (allDay) {
          const shift = Date.parse(p.time.start) - Date.parse(p.occurrenceStart)
          const len = Date.parse(p.time.end) - Date.parse(p.time.start)
          const s = new Date(Date.parse(t.ev.start!) + shift).toISOString().slice(0, 10)
          Object.assign(body, timeBody({ allDay, start: s, end: new Date(Date.parse(s) + len).toISOString().slice(0, 10) }, tz))
        } else {
          const shift = Date.parse(p.time.start) - Date.parse(p.occurrenceStart)
          const len = Date.parse(p.time.end) - Date.parse(p.time.start)
          const s = Date.parse(t.ev.start!) + shift
          Object.assign(body, timeBody({ allDay, start: new Date(s).toISOString(), end: new Date(s + len).toISOString() }, tz))
        }
      }
      const reply = await patch(ctx, t, t.ev.google_event_id, body, t.ev.etag ?? undefined)
      await afterWrite(ctx, t.cal, reply)
      return
    }
    if (p.time) Object.assign(body, timeBody(p.time, tz))
    const id = await instanceId(ctx, t, p.occurrenceStart)
    const reply = await patch(ctx, t, id, body)
    await afterWrite(ctx, t.cal, reply)
    return
  }
  if (p.time) Object.assign(body, timeBody(p.time, tz))
  const reply = await patch(ctx, t, t.ev.google_event_id, body, t.ev.etag ?? undefined)
  await afterWrite(ctx, t.cal, reply)
}

export async function deleteEvent(ctx: Ctx, userId: number, eventId: number, occurrenceStart?: string, scope?: 'instance' | 'series') {
  const { db } = ctx
  const t = target(db, userId, eventId)
  if (!writable(t.cal)) throw new Forbidden('that calendar is read-only')
  refuseLocked(db, userId, t.cal, t.ev.start, occurrenceStart)
  const api = ctx.apiFor(t.cal.google_account_id)
  const id = t.ev.recurrence && occurrenceStart && scope !== 'series' ? await instanceId(ctx, t, occurrenceStart) : t.ev.google_event_id
  await api.deleteEvent(t.cal.google_calendar_id, id)
  if (t.cal.is_bookkeeping === 1 && parseEventBooking(t.ev.summary, t.ev.description, knownHashtags(db, userId)).kind === 'booked') {
    ctx.notify('info', `Booked event "${t.ev.summary}" (${occurrenceStart ?? t.ev.start}) was deleted in planner.`, 'Bookkeeping entry removed')
  }
  await afterWrite(ctx, t.cal, undefined)
}

function projectOf(db: Db, userId: number, projectId: number): { id: number; hashtag: string; title: string } {
  const p = get<{ id: number; hashtag: string; title: string }>(db, 'SELECT id, hashtag, title FROM projects WHERE id = ? AND user_id = ?', projectId, userId)
  if (!p) throw new NotFound('no such project')
  return p
}

/**
 * Books an event to a project (or unbooks it) by rewriting the hashtag in its
 * title: a Bookkeeping event directly, or an event in a calendar the user owns,
 * which automatic booking then copies to Bookkeeping.
 */
export async function bookEvent(ctx: Ctx, userId: number, eventId: number, projectId: number | null, occurrenceStart?: string) {
  const { db } = ctx
  const t = target(db, userId, eventId)
  if (t.cal.is_bookkeeping !== 1 && t.cal.access_role !== 'owner') throw new Invalid('only events in your own calendars are booked; send this one to Bookkeeping instead')
  if (JSON.parse(t.ev.raw_json).extendedProperties?.private?.planner_auto === '1') {
    throw new Invalid('this booking follows its source event: change the hashtag in the original event instead')
  }
  const tag = projectId ? projectOf(db, userId, projectId).hashtag : null
  const next = setEventBooking(t.ev.summary, t.ev.description, tag, knownHashtags(db, userId))
  await updateEvent(ctx, userId, eventId, {
    title: next.title,
    ...(next.description !== t.ev.description ? { description: next.description } : {}),
    occurrenceStart,
    scope: occurrenceStart ? 'instance' : undefined,
  })
  ctx.notify('info', `"${t.ev.summary}" (${occurrenceStart ?? t.ev.start}) ${tag ? `booked to #${tag}` : 'unbooked'}.`)
}

export type SendInput = { projectId: number; mode: 'copy' | 'move'; occurrenceStart?: string; minutes?: number }

/**
 * Sends an event from another calendar to Bookkeeping: a copy (the default, and
 * the only choice for other people's meetings) or, for the user's own single
 * events, a move. Sending the same event twice is refused.
 */
export async function sendToBookkeeping(ctx: Ctx, userId: number, eventId: number, input: SendInput): Promise<number> {
  const { db } = ctx
  const t = target(db, userId, eventId)
  if (t.cal.is_bookkeeping === 1) throw new Invalid('this event is already in Bookkeeping')
  const project = projectOf(db, userId, input.projectId)
  const known = knownHashtags(db, userId)
  const bk = await ensureBookkeeping(ctx, userId)
  const expanded = !!(t.ev.recurrence && input.occurrenceStart)
  const key = sourceKey(t.cal, t.ev, expanded ? input.occurrenceStart : undefined)
  const already = sentMap(db, userId).get(key)
  if (already) throw new Conflict('this event has already been sent to Bookkeeping')

  let start = t.ev.start!
  let end = t.ev.end!
  if (expanded) {
    const len = Date.parse(t.ev.end!) - Date.parse(t.ev.start!)
    start = input.occurrenceStart!
    end = t.ev.all_day ? new Date(Date.parse(start) + len).toISOString().slice(0, 10) : new Date(Date.parse(start) + len).toISOString()
  }
  if (t.ev.all_day === 1 && !(input.minutes && input.minutes > 0)) throw new Invalid('an all-day event needs the hours entered by hand')
  refuseLocked(db, userId, bk, start)
  const summary = setBooking(t.ev.summary || '(no title)', project.hashtag, known)

  if (input.mode === 'move') {
    if (expanded || t.ev.recurrence || t.ev.recurring_event_id) throw new Invalid('a recurring event cannot be moved; copy it instead')
    if (t.ev.organizer_self !== 1 || !writable(t.cal)) throw new Forbidden('only your own events can be moved; copy this one instead')
    if (bk.google_account_id !== t.cal.google_account_id) throw new Invalid('Google moves events only within one account; copy this one instead')
    const api = ctx.apiFor(t.cal.google_account_id)
    const body: Partial<GEvent> = { summary }
    const description = removeHashtagsKeepLayout(t.ev.description, known)
    if (description !== t.ev.description) body.description = description
    if (input.minutes) body.extendedProperties = { private: { planner_minutes: String(Math.round(input.minutes)) } }
    await patch(ctx, t, t.ev.google_event_id, body, t.ev.etag ?? undefined)
    const moved = await api.moveEvent(t.cal.google_calendar_id, t.ev.google_event_id, bk.google_calendar_id)
    await afterWrite(ctx, t.cal, undefined)
    await afterWrite(ctx, bk, moved)
    ctx.notify('info', `Moved "${t.ev.summary}" (${start}) from "${t.cal.name}" to Bookkeeping as #${project.hashtag}.`)
    return get<{ id: number }>(db, 'SELECT id FROM events WHERE calendar_id = ? AND google_event_id = ?', bk.id, moved.id)!.id
  }

  const api = ctx.apiFor(bk.google_account_id)
  const priv: Record<string, string> = { planner_source: key }
  if (input.minutes) priv.planner_minutes = String(Math.round(input.minutes))
  const time =
    t.ev.all_day === 1 ? { start: { date: start }, end: { date: end } } : timeBody({ start, end, allDay: false }, t.ev.time_zone ?? REPORT_TZ)
  const reply = await api.insertEvent(bk.google_calendar_id, {
    summary,
    description: removeHashtagsKeepLayout(t.ev.description, known),
    location: t.ev.location,
    ...time,
    extendedProperties: { private: priv },
  })
  await afterWrite(ctx, bk, reply)
  ctx.notify('info', `Copied "${t.ev.summary}" (${start}) from "${t.cal.name}" to Bookkeeping as #${project.hashtag}.`)
  return get<{ id: number }>(db, 'SELECT id FROM events WHERE calendar_id = ? AND google_event_id = ?', bk.id, reply.id)!.id
}
