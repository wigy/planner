import { beforeEach, describe, expect, it } from 'vitest'
import { EXACT } from '../shared/rounding.ts'
import { bookEvent, createEvent, deleteEvent, occurrences, sendToBookkeeping, unknownHashtags, updateEvent } from './calendar.ts'
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
let userId: number

const PRIMARY = 'me@example.com'
const BK = 'bk@group.calendar.google.com'

function calId(googleId: string): number {
  return get<{ id: number }>(db, 'SELECT id FROM calendars WHERE google_calendar_id = ?', googleId)!.id
}

function eventId(googleId: string): number {
  return get<{ id: number }>(db, 'SELECT id FROM events WHERE google_event_id = ?', googleId)!.id
}

const t = (s: string) => ({ dateTime: s, timeZone: 'Europe/Helsinki' })

beforeEach(async () => {
  db = openDb(':memory:')
  g = new FakeGoogle()
  notes = []
  ctx = { db, notify: (level, text) => notes.push({ level, text }), apiFor: () => g }
  run(db, "INSERT INTO users (name, primary_email, created_at) VALUES ('Me', 'me@example.com', '2026-01-01')")
  userId = 1
  run(db, "INSERT INTO google_accounts (user_id, email) VALUES (1, 'me@example.com')")
  g.addCalendar(PRIMARY, { primary: true, summary: 'Me' })
  g.addCalendar(BK, { summary: 'Bookkeeping' })
  createProject(db, userId, { title: 'Acme Works', hashtag: '#acme' })
  createProject(db, userId, { title: 'Tasenor', hashtag: 'tasenor' })
})

describe('sync', () => {
  it('finds the Bookkeeping calendar by name and mirrors events, past ones included', async () => {
    g.external(PRIMARY, { id: 'old', summary: 'Old meeting', start: t('2020-01-10T10:00:00+02:00'), end: t('2020-01-10T11:00:00+02:00') })
    await syncAccount(ctx, 1)
    expect(get<{ is_bookkeeping: number }>(db, 'SELECT is_bookkeeping FROM calendars WHERE google_calendar_id = ?', BK)!.is_bookkeeping).toBe(1)
    expect(get<{ summary: string }>(db, "SELECT summary FROM events WHERE google_event_id = 'old'")!.summary).toBe('Old meeting')
  })

  it('applies incremental changes and deletes', async () => {
    g.external(PRIMARY, { id: 'a', summary: 'A', start: t('2026-11-02T10:00:00+02:00'), end: t('2026-11-02T11:00:00+02:00') })
    await syncAccount(ctx, 1)
    g.external(PRIMARY, { id: 'a', summary: 'A renamed' })
    g.external(PRIMARY, { id: 'b', summary: 'B', start: t('2026-11-03T10:00:00+02:00'), end: t('2026-11-03T11:00:00+02:00') })
    await syncCalendar(ctx, calId(PRIMARY))
    expect(all<{ summary: string }>(db, 'SELECT summary FROM events ORDER BY summary').map((r) => r.summary)).toEqual(['A renamed', 'B'])
    expect(g.calls.filter((c) => c.startsWith('listEvents me@')).at(-1)).not.toMatch(/full$/)
    g.external(PRIMARY, { id: 'a', status: 'cancelled' })
    await syncCalendar(ctx, calId(PRIMARY))
    expect(all(db, 'SELECT * FROM events')).toHaveLength(1)
  })

  it('syncs in full again when the token has expired (410)', async () => {
    g.external(PRIMARY, { id: 'a', summary: 'A', start: t('2026-11-02T10:00:00+02:00'), end: t('2026-11-02T11:00:00+02:00') })
    await syncAccount(ctx, 1)
    // While the token is expired, 'a' is deleted and drops out of the full list entirely.
    g.cals.get(PRIMARY)!.events.delete('a')
    g.external(PRIMARY, { id: 'c', summary: 'C', start: t('2026-11-04T10:00:00+02:00'), end: t('2026-11-04T11:00:00+02:00') })
    g.expiredBefore = g.seq
    await syncCalendar(ctx, calId(PRIMARY))
    expect(all<{ google_event_id: string }>(db, 'SELECT google_event_id FROM events').map((r) => r.google_event_id)).toEqual(['c'])
    expect(notes.some((n) => /expired/.test(n.text))).toBe(true)
  })

  it('warns about two project hashtags in a Bookkeeping title', async () => {
    g.external(BK, { id: 'x', summary: 'Call #acme #tasenor', start: t('2026-11-02T10:00:00+02:00'), end: t('2026-11-02T11:00:00+02:00') })
    await syncAccount(ctx, 1)
    expect(notes.find((n) => n.level === 'warning')?.text).toMatch(/two project hashtags/)
  })
})

describe('calendar edits', () => {
  beforeEach(async () => {
    g.external(PRIMARY, { id: 'm', summary: 'Customer meeting', start: t('2026-11-05T10:00:00+02:00'), end: t('2026-11-05T11:30:00+02:00'), organizer: { email: 'x@y', self: false } })
    g.external(PRIMARY, { id: 'own', summary: 'Own work', start: t('2026-11-06T09:00:00+02:00'), end: t('2026-11-06T12:00:00+02:00'), organizer: { self: true } })
    await syncAccount(ctx, 1)
  })

  it('creates an event in Google and mirrors it', async () => {
    const id = await createEvent(ctx, userId, { calendarId: calId(PRIMARY), title: 'Dentist', start: '2026-11-10T08:00:00Z', end: '2026-11-10T09:00:00Z', allDay: false })
    expect(get<{ summary: string }>(db, 'SELECT summary FROM events WHERE id = ?', id)!.summary).toBe('Dentist')
  })

  it('lets Google win a conflicting edit (412)', async () => {
    const id = eventId('m')
    g.external(PRIMARY, { id: 'm', summary: 'Changed by someone else' })
    await expect(updateEvent(ctx, userId, id, { title: 'Mine' })).rejects.toThrow(/changed in Google/)
    expect(get<{ summary: string }>(db, 'SELECT summary FROM events WHERE id = ?', id)!.summary).toBe('Changed by someone else')
  })

  it('copies a meeting to Bookkeeping, once', async () => {
    const acme = get<{ id: number }>(db, "SELECT id FROM projects WHERE hashtag = 'acme'")!.id
    await sendToBookkeeping(ctx, userId, eventId('m'), { projectId: acme, mode: 'copy' })
    const copy = get<{ summary: string; raw_json: string }>(db, `SELECT e.summary, e.raw_json FROM events e JOIN calendars c ON c.id = e.calendar_id WHERE c.is_bookkeeping = 1`)!
    expect(copy.summary).toBe('Customer meeting #acme')
    expect(JSON.parse(copy.raw_json).extendedProperties.private.planner_source).toBe(`${PRIMARY}/m`)
    // The original is untouched and now shows where it went.
    expect(g.cals.get(PRIMARY)!.events.get('m')!.summary).toBe('Customer meeting')
    const occ = occurrences(db, userId, new Date('2026-11-01'), new Date('2026-12-01')).find((o) => o.title === 'Customer meeting')!
    expect(occ.sentTo).not.toBeNull()
    await expect(sendToBookkeeping(ctx, userId, eventId('m'), { projectId: acme, mode: 'copy' })).rejects.toThrow(/already/)
  })

  it('moves only the user’s own events', async () => {
    const acme = get<{ id: number }>(db, "SELECT id FROM projects WHERE hashtag = 'acme'")!.id
    await expect(sendToBookkeeping(ctx, userId, eventId('m'), { projectId: acme, mode: 'move' })).rejects.toThrow(/own events/)
    await sendToBookkeeping(ctx, userId, eventId('own'), { projectId: acme, mode: 'move' })
    const rows = all<{ summary: string; bk: number }>(db, 'SELECT e.summary, c.is_bookkeeping AS bk FROM events e JOIN calendars c ON c.id = e.calendar_id WHERE e.google_event_id = ?', 'own')
    expect(rows).toEqual([{ summary: 'Own work #acme', bk: 1 }])
  })

  it('reports booked time per project, and follows hashtags edited in Google', async () => {
    g.external(BK, { id: 'w1', summary: 'Coding #acme', start: t('2026-11-02T08:00:00+02:00'), end: t('2026-11-02T10:10:00+02:00') })
    g.external(BK, { id: 'w2', summary: 'Ledger #tasenor', start: t('2026-11-03T08:00:00+02:00'), end: t('2026-11-03T09:00:00+02:00') })
    g.external(BK, { id: 'w3', summary: 'Unbooked', start: t('2026-11-03T10:00:00+02:00'), end: t('2026-11-03T11:00:00+02:00') })
    // Crosses into December: only the November part counts.
    g.external(BK, { id: 'w4', summary: 'Night deploy #acme', start: t('2026-11-30T23:00:00+02:00'), end: t('2026-12-01T01:00:00+02:00') })
    await syncCalendar(ctx, calId(BK))
    let r = report(db, userId, '2026-11', EXACT)
    expect(r.projects.map((p) => [p.hashtag, p.minutes])).toEqual([['acme', 190], ['tasenor', 60]])
    // Someone edits the title on the phone: the booking moves.
    g.external(BK, { id: 'w2', summary: 'Ledger #acme' })
    await syncCalendar(ctx, calId(BK))
    r = report(db, userId, '2026-11', { step: 15, mode: 'up', apply: 'entry' })
    expect(r.projects.map((p) => [p.hashtag, p.minutes])).toEqual([['acme', 135 + 60 + 60]])
    expect(report(db, userId, '2026-12', EXACT).totalMinutes).toBe(60)
  })

  it('books and unbooks by rewriting the title, and refuses locked months', async () => {
    g.external(BK, { id: 'w1', summary: 'Coding', start: t('2026-11-02T08:00:00+02:00'), end: t('2026-11-02T10:00:00+02:00') })
    await syncCalendar(ctx, calId(BK))
    const tasenor = get<{ id: number }>(db, "SELECT id FROM projects WHERE hashtag = 'tasenor'")!.id
    await bookEvent(ctx, userId, eventId('w1'), tasenor)
    expect(g.cals.get(BK)!.events.get('w1')!.summary).toBe('Coding #tasenor')
    setLock(db, userId, '2026-11', true)
    await expect(bookEvent(ctx, userId, eventId('w1'), null)).rejects.toThrow(/locked/)
    // A change in Google to a locked month is flagged.
    g.external(BK, { id: 'w1', summary: 'Coding' })
    await syncCalendar(ctx, calId(BK))
    expect(notes.some((n) => n.level === 'warning' && /locked month/.test(n.text))).toBe(true)
  })

  it('renames a hashtag in every Bookkeeping title except locked months', async () => {
    g.external(BK, { id: 'oct', summary: 'Old #acme', start: t('2026-10-02T08:00:00+03:00'), end: t('2026-10-02T09:00:00+03:00') })
    g.external(BK, { id: 'nov', summary: 'New #acme', start: t('2026-11-02T08:00:00+02:00'), end: t('2026-11-02T09:00:00+02:00') })
    await syncCalendar(ctx, calId(BK))
    setLock(db, userId, '2026-10', true)
    const acme = get<{ id: number }>(db, "SELECT id FROM projects WHERE hashtag = 'acme'")!.id
    const res = await updateProject(ctx, userId, acme, { hashtag: 'aw' })
    expect([res.rewritten, res.skipped]).toEqual([1, 1])
    expect(g.cals.get(BK)!.events.get('nov')!.summary).toBe('New #aw')
    expect(unknownHashtags(db, userId)).toEqual([{ hashtag: 'acme', count: 1 }])
  })

  it('edits one occurrence of a series or the whole series', async () => {
    g.external(PRIMARY, {
      id: 'standup',
      summary: 'Standup',
      start: t('2026-11-02T09:00:00+02:00'),
      end: t('2026-11-02T09:15:00+02:00'),
      recurrence: ['RRULE:FREQ=DAILY;COUNT=5'],
    })
    await syncCalendar(ctx, calId(PRIMARY))
    const range = [new Date('2026-11-01'), new Date('2026-11-10')] as const
    const standups = () => occurrences(db, userId, ...range).filter((o) => o.title.startsWith('Standup'))
    expect(standups()).toHaveLength(5)
    const third = standups()[2]
    await updateEvent(ctx, userId, third.eventId, { title: 'Standup (moved)', occurrenceStart: third.start, scope: 'instance', time: { start: '2026-11-04T10:00:00.000Z', end: '2026-11-04T10:15:00.000Z', allDay: false } })
    const after = standups()
    expect(after).toHaveLength(5)
    expect(after.find((o) => o.title === 'Standup (moved)')!.start).toBe('2026-11-04T10:00:00.000Z')
    // Deleting one occurrence leaves four.
    const first = after[0]
    await deleteEvent(ctx, userId, first.eventId, first.start, 'instance')
    expect(standups()).toHaveLength(4)
    // Shifting the series by an hour moves the unchanged occurrences.
    const second = standups().find((o) => o.title === 'Standup')!
    await updateEvent(ctx, userId, second.eventId, {
      occurrenceStart: second.start,
      scope: 'series',
      time: { start: new Date(Date.parse(second.start) + 3600_000).toISOString(), end: new Date(Date.parse(second.end) + 3600_000).toISOString(), allDay: false },
    })
    expect(g.cals.get(PRIMARY)!.events.get('standup')!.start!.dateTime).toBe('2026-11-02T08:00:00.000Z')
  })
})
