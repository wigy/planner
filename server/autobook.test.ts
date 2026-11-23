import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setEventBooking } from '../shared/hashtag.ts'
import { EXACT } from '../shared/rounding.ts'
import { autoBook } from './autobook.ts'
import { bookEvent, createEvent } from './calendar.ts'
import { all, type Db, get, openDb, run } from './db.ts'
import { FakeGoogle } from './fake-google.ts'
import type { Level } from './notify.ts'
import { createProject, updateProject } from './projects.ts'
import { report, setLock } from './reports.ts'
import { type Ctx, syncAccount, syncCalendar } from './sync.ts'

let db: Db
let g: FakeGoogle
let ctx: Ctx
let notes: { level: Level; text: string }[]
const userId = 1
const PRIMARY = 'me@example.com'
const WORK = 'work@group.calendar.google.com'
const BK = 'bk@group.calendar.google.com'
const SHARED = 'other@example.com'
const t = (s: string) => ({ dateTime: s, timeZone: 'Europe/Helsinki' })
const mine = { organizer: { self: true } }

function calId(googleId: string): number {
  return get<{ id: number }>(db, 'SELECT id FROM calendars WHERE google_calendar_id = ?', googleId)!.id
}

/** google event id -> google calendar id, from the mirror. */
function where(): Record<string, string> {
  const rows = all<{ e: string; c: string }>(
    db,
    "SELECT e.google_event_id AS e, c.google_calendar_id AS c FROM events e JOIN calendars c ON c.id = e.calendar_id WHERE e.status != 'cancelled' AND e.recurring_event_id IS NULL",
  )
  return Object.fromEntries(rows.map((r) => [r.e, r.c]))
}

function inGoogle(calendar: string): string[] {
  return [...g.cals.get(calendar)!.events.values()].filter((e) => e.status !== 'cancelled' && !e.recurringEventId).map((e) => e.id).sort()
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-20T12:00:00Z'))
  db = openDb(':memory:')
  g = new FakeGoogle()
  notes = []
  ctx = { db, notify: (level, text) => notes.push({ level, text }), apiFor: () => g }
  run(db, "INSERT INTO users (name, primary_email, created_at) VALUES ('Me', 'me@example.com', '2026-01-01')")
  run(db, "INSERT INTO google_accounts (user_id, email) VALUES (1, 'me@example.com')")
  g.addCalendar(PRIMARY, { primary: true, summary: 'Me' })
  g.addCalendar(WORK, { summary: 'Work' })
  g.addCalendar(BK, { summary: 'Bookkeeping' })
  g.addCalendar(SHARED, { summary: 'Shared with me', accessRole: 'writer' })
  createProject(db, userId, { title: 'Acme Works', hashtag: 'acme' })
  createProject(db, userId, { title: 'Tasenor', hashtag: 'tasenor' })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('automatic booking moves the event itself', () => {
  it('moves tagged events of own calendars into Bookkeeping, and nothing else', async () => {
    g.external(WORK, { id: 'a', summary: 'Coding #acme', start: t('2026-11-02T09:00:00+02:00'), end: t('2026-11-02T11:00:00+02:00'), ...mine })
    g.external(PRIMARY, { id: 'b', summary: 'Review', description: 'notes\n#tasenor', start: t('2026-11-02T12:00:00+02:00'), end: t('2026-11-02T13:00:00+02:00'), ...mine })
    g.external(PRIMARY, { id: 'lunch', summary: 'Lunch', start: t('2026-11-02T11:00:00+02:00'), end: t('2026-11-02T12:00:00+02:00'), ...mine })
    g.external(PRIMARY, { id: 'both', summary: 'Both #acme', description: '#tasenor', start: t('2026-11-03T09:00:00+02:00'), end: t('2026-11-03T10:00:00+02:00'), ...mine })
    g.external(PRIMARY, { id: 'allday', summary: 'Offsite #acme', start: { date: '2026-11-04' }, end: { date: '2026-11-05' }, ...mine })
    g.external(PRIMARY, { id: 'invite', summary: 'Their meeting #acme', start: t('2026-11-05T09:00:00+02:00'), end: t('2026-11-05T10:00:00+02:00'), organizer: { self: false } })
    g.external(SHARED, { id: 'theirs', summary: 'Theirs #acme', start: t('2026-11-05T09:00:00+02:00'), end: t('2026-11-05T10:00:00+02:00'), ...mine })
    await syncAccount(ctx, 1)
    const r = await autoBook(ctx, userId)
    expect(r).toMatchObject({ movedIn: 2, failed: 0 })
    expect(inGoogle(BK)).toEqual(['a', 'b'])
    expect(where()).toMatchObject({ a: BK, b: BK, lunch: PRIMARY, both: PRIMARY, allday: PRIMARY, invite: PRIMARY, theirs: SHARED })
    // The titles are not touched, and there is exactly one of each event.
    expect(g.cals.get(BK)!.events.get('a')!.summary).toBe('Coding #acme')
    expect(all(db, "SELECT 1 FROM events WHERE google_event_id = 'a'")).toHaveLength(1)
    expect(notes.some((n) => /someone else's meeting/.test(n.text))).toBe(true)
    expect(report(db, userId, '2026-11', EXACT).projects.map((p) => [p.hashtag, p.minutes])).toEqual([['acme', 120], ['tasenor', 60]])
    expect((await autoBook(ctx, userId)).movedIn).toBe(0)
  })

  it('moves an event back where it came from when the tag goes', async () => {
    g.external(WORK, { id: 'a', summary: 'Coding #acme', start: t('2026-11-02T09:00:00+02:00'), end: t('2026-11-02T11:00:00+02:00'), ...mine })
    await syncAccount(ctx, 1)
    await autoBook(ctx, userId)
    g.external(BK, { id: 'a', summary: 'Coding' })
    await syncCalendar(ctx, calId(BK))
    expect((await autoBook(ctx, userId)).movedOut).toBe(1)
    expect(where().a).toBe(WORK)
    // An event made in Bookkeeping without a project goes to the primary calendar.
    g.external(BK, { id: 'direct', summary: 'Untagged', start: t('2026-11-06T09:00:00+02:00'), end: t('2026-11-06T10:00:00+02:00'), ...mine })
    await syncCalendar(ctx, calId(BK))
    await autoBook(ctx, userId)
    expect(where().direct).toBe(PRIMARY)
  })

  it('moves a series as a whole, with its changed occurrences', async () => {
    g.external(PRIMARY, { id: 's', summary: 'Standup', start: t('2026-11-02T09:00:00+02:00'), end: t('2026-11-02T09:15:00+02:00'), recurrence: ['RRULE:FREQ=DAILY;COUNT=5'], ...mine })
    await syncAccount(ctx, 1)
    const id = get<{ id: number }>(db, "SELECT id FROM events WHERE google_event_id = 's'")!.id
    const acme = get<{ id: number }>(db, "SELECT id FROM projects WHERE hashtag = 'acme'")!.id
    await bookEvent(ctx, userId, id, acme, '2026-11-04T07:00:00.000Z')
    await autoBook(ctx, userId)
    expect(where().s).toBe(BK)
    expect(g.cals.get(BK)!.events.get('s')).toMatchObject({ summary: 'Standup', description: '#acme' })
    expect(report(db, userId, '2026-11', EXACT).totalMinutes).toBe(75)
  })

  it('leaves locked months alone', async () => {
    g.external(PRIMARY, { id: 'oct', summary: 'Old #acme', start: t('2026-10-02T09:00:00+03:00'), end: t('2026-10-02T10:00:00+03:00'), ...mine })
    setLock(db, userId, '2026-10', true)
    await syncAccount(ctx, 1)
    expect((await autoBook(ctx, userId)).movedIn).toBe(0)
    expect(where().oct).toBe(PRIMARY)
    expect(notes.some((n) => n.level === 'warning' && /locked/.test(n.text))).toBe(true)
  })

  it('removes the automatic copies of the earlier version and moves their sources in', async () => {
    g.external(PRIMARY, { id: 'a', summary: 'Coding #acme', start: t('2026-11-02T09:00:00+02:00'), end: t('2026-11-02T11:00:00+02:00'), ...mine })
    g.external(BK, { id: 'copy', summary: 'Coding #acme', start: t('2026-11-02T09:00:00+02:00'), end: t('2026-11-02T11:00:00+02:00'), extendedProperties: { private: { planner_source: `${PRIMARY}/a`, planner_auto: '1' } }, ...mine })
    await syncAccount(ctx, 1)
    const r = await autoBook(ctx, userId)
    expect([r.removedCopies, r.movedIn]).toEqual([1, 1])
    expect(inGoogle(BK)).toEqual(['a'])
  })
})

describe('booking from planner', () => {
  it('puts the hashtag in the description, not the title', async () => {
    await syncAccount(ctx, 1)
    const acme = get<{ id: number }>(db, "SELECT id FROM projects WHERE hashtag = 'acme'")!.id
    await createEvent(ctx, userId, { calendarId: calId(PRIMARY), title: 'Planning', projectId: acme, start: '2026-11-26T07:00:00.000Z', end: '2026-11-26T08:00:00.000Z', allDay: false })
    await autoBook(ctx, userId)
    const ev = [...g.cals.get(BK)!.events.values()][0]
    expect([ev.summary, ev.description]).toEqual(['Planning', '#acme'])
    // Changing the project swaps the tag; no project moves the event back out.
    const id = get<{ id: number }>(db, 'SELECT id FROM events WHERE google_event_id = ?', ev.id)!.id
    const tasenor = get<{ id: number }>(db, "SELECT id FROM projects WHERE hashtag = 'tasenor'")!.id
    await bookEvent(ctx, userId, id, tasenor)
    expect(g.cals.get(BK)!.events.get(ev.id)!.description).toBe('#tasenor')
    await bookEvent(ctx, userId, id, null)
    await autoBook(ctx, userId)
    expect(where()[ev.id]).toBe(PRIMARY)
  })

  it('swaps a tag the user typed in the title in place', () => {
    const known = ['acme', 'tasenor']
    expect(setEventBooking('Coding #acme today', 'x', 'tasenor', known)).toEqual({ title: 'Coding #tasenor today', description: 'x' })
    expect(setEventBooking('Coding', 'Notes', 'acme', known)).toEqual({ title: 'Coding', description: 'Notes\n#acme' })
    expect(setEventBooking('Coding', '<p>Notes</p>', 'acme', known)).toEqual({ title: 'Coding', description: '<p>Notes</p><br>#acme' })
    expect(setEventBooking('Coding', 'Notes #acme here', 'tasenor', known)).toEqual({ title: 'Coding', description: 'Notes #tasenor here' })
    expect(setEventBooking('Coding #acme', 'Notes\n#acme', null, known)).toEqual({ title: 'Coding', description: 'Notes\n' })
  })

  it('renames the hashtag where it is, so nothing moves', async () => {
    g.external(PRIMARY, { id: 'a', summary: 'Coding', description: 'for #acme', start: t('2026-11-02T09:00:00+02:00'), end: t('2026-11-02T11:00:00+02:00'), ...mine })
    await syncAccount(ctx, 1)
    await autoBook(ctx, userId)
    const acme = get<{ id: number }>(db, "SELECT id FROM projects WHERE hashtag = 'acme'")!.id
    await updateProject(ctx, userId, acme, { hashtag: 'aw' })
    const r = await autoBook(ctx, userId)
    expect([r.movedIn, r.movedOut]).toEqual([0, 0])
    expect(g.cals.get(BK)!.events.get('a')!.description).toBe('for #aw')
  })
})

describe('daily hours', () => {
  it('sums booked minutes per Helsinki day', async () => {
    const { dailyHours } = await import('./reports.ts')
    g.external(BK, { id: 'a', summary: 'Coding', description: '#acme', start: t('2026-11-02T09:00:00+02:00'), end: t('2026-11-02T11:00:00+02:00'), ...mine })
    g.external(BK, { id: 'b', summary: 'Review', description: '#tasenor', start: t('2026-11-02T13:00:00+02:00'), end: t('2026-11-02T13:30:00+02:00'), ...mine })
    g.external(BK, { id: 'c', summary: 'Late', description: '#acme', start: t('2026-11-03T00:30:00+02:00'), end: t('2026-11-03T01:00:00+02:00'), ...mine })
    g.external(BK, { id: 'x', summary: 'Unbooked', start: t('2026-11-04T09:00:00+02:00'), end: t('2026-11-04T10:00:00+02:00'), ...mine })
    await syncAccount(ctx, 1)
    expect(dailyHours(db, userId, '2026-11-02', '2026-11-09')).toEqual({ '2026-11-02': 150, '2026-11-03': 30 })
    expect(() => dailyHours(db, userId, '2026-11-09', '2026-11-02')).toThrow()
  })
})
