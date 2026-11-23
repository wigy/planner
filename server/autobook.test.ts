import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { autoBook } from './autobook.ts'
import { all, type Db, get, openDb, run } from './db.ts'
import { FakeGoogle } from './fake-google.ts'
import type { Level } from './notify.ts'
import { createProject, updateProject } from './projects.ts'
import { setLock } from './reports.ts'
import { type Ctx, syncAccount, syncCalendar } from './sync.ts'

let db: Db
let g: FakeGoogle
let ctx: Ctx
let notes: { level: Level; text: string }[]
const userId = 1
const PRIMARY = 'me@example.com'
const BK = 'bk@group.calendar.google.com'
const SHARED = 'other@example.com'
const t = (s: string) => ({ dateTime: s, timeZone: 'Europe/Helsinki' })

function calId(googleId: string): number {
  return get<{ id: number }>(db, 'SELECT id FROM calendars WHERE google_calendar_id = ?', googleId)!.id
}

function booked(): { summary: string; start: string; source: string }[] {
  return all<{ summary: string; start: string; source: string }>(
    db,
    `SELECT e.summary, e.start, json_extract(e.raw_json, '$.extendedProperties.private.planner_source') AS source
     FROM events e JOIN calendars c ON c.id = e.calendar_id WHERE c.is_bookkeeping = 1 AND e.status != 'cancelled' ORDER BY e.start`,
  )
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
  g.addCalendar(BK, { summary: 'Bookkeeping' })
  g.addCalendar(SHARED, { summary: 'Shared with me', accessRole: 'writer' })
  createProject(db, userId, { title: 'Acme Works', hashtag: 'acme' })
  createProject(db, userId, { title: 'Tasenor', hashtag: 'tasenor' })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('automatic booking', () => {
  it('copies hashtagged events from own calendars, once', async () => {
    g.external(PRIMARY, { id: 'a', summary: 'Coding #acme', start: t('2026-11-02T09:00:00+02:00'), end: t('2026-11-02T11:00:00+02:00'), organizer: { self: true } })
    g.external(PRIMARY, { id: 'b', summary: 'Lunch', start: t('2026-11-02T11:00:00+02:00'), end: t('2026-11-02T12:00:00+02:00') })
    g.external(PRIMARY, { id: 'c', summary: 'Both #acme #tasenor', start: t('2026-11-03T09:00:00+02:00'), end: t('2026-11-03T10:00:00+02:00') })
    g.external(PRIMARY, { id: 'd', summary: 'Offsite #acme', start: { date: '2026-11-04' }, end: { date: '2026-11-05' } })
    g.external(SHARED, { id: 'e', summary: 'Theirs #acme', start: t('2026-11-05T09:00:00+02:00'), end: t('2026-11-05T10:00:00+02:00') })
    await syncAccount(ctx, 1)
    const r = await autoBook(ctx, userId)
    expect(r).toMatchObject({ created: 1, skipped: 1, failed: 0 })
    expect(booked()).toEqual([{ summary: 'Coding #acme', start: '2026-11-02T07:00:00.000Z', source: `${PRIMARY}/a` }])
    expect((await autoBook(ctx, userId)).created).toBe(0)
  })

  it('follows the source: moved, retagged, untagged and deleted', async () => {
    g.external(PRIMARY, { id: 'a', summary: 'Coding #acme', start: t('2026-11-02T09:00:00+02:00'), end: t('2026-11-02T11:00:00+02:00') })
    await syncAccount(ctx, 1)
    await autoBook(ctx, userId)
    g.external(PRIMARY, { id: 'a', summary: 'Ledger #tasenor', start: t('2026-11-02T10:00:00+02:00'), end: t('2026-11-02T11:00:00+02:00') })
    await syncCalendar(ctx, calId(PRIMARY))
    expect((await autoBook(ctx, userId)).updated).toBe(1)
    expect(booked()).toEqual([{ summary: 'Ledger #tasenor', start: '2026-11-02T08:00:00.000Z', source: `${PRIMARY}/a` }])
    g.external(PRIMARY, { id: 'a', summary: 'Ledger' })
    await syncCalendar(ctx, calId(PRIMARY))
    expect((await autoBook(ctx, userId)).removed).toBe(1)
    expect(booked()).toEqual([])
    g.external(PRIMARY, { id: 'a', summary: 'Ledger #tasenor' })
    await syncCalendar(ctx, calId(PRIMARY))
    await autoBook(ctx, userId)
    g.external(PRIMARY, { id: 'a', status: 'cancelled' })
    await syncCalendar(ctx, calId(PRIMARY))
    await autoBook(ctx, userId)
    expect(booked()).toEqual([])
  })

  it('copies a series occurrence by occurrence up to the end of the month', async () => {
    g.external(PRIMARY, {
      id: 's',
      summary: 'Standup #acme',
      start: t('2026-11-23T09:00:00+02:00'),
      end: t('2026-11-23T09:15:00+02:00'),
      recurrence: ['RRULE:FREQ=WEEKLY'],
    })
    await syncAccount(ctx, 1)
    await autoBook(ctx, userId)
    expect(booked().map((b) => b.start)).toEqual(['2026-11-23T07:00:00.000Z', '2026-11-30T07:00:00.000Z'])
    vi.setSystemTime(new Date('2026-12-01T12:00:00Z'))
    await autoBook(ctx, userId)
    expect(booked()).toHaveLength(6) // 2 in November, 4 Mondays in December
  })

  it('leaves manual copies and locked months alone', async () => {
    g.external(PRIMARY, { id: 'oct', summary: 'Old #acme', start: t('2026-10-02T09:00:00+03:00'), end: t('2026-10-02T10:00:00+03:00') })
    g.external(BK, { id: 'manual', summary: 'By hand #tasenor', start: t('2026-11-03T09:00:00+02:00'), end: t('2026-11-03T10:00:00+02:00'), extendedProperties: { private: { planner_source: `${PRIMARY}/nov` } } })
    g.external(PRIMARY, { id: 'nov', summary: 'Nov #acme', start: t('2026-11-03T09:00:00+02:00'), end: t('2026-11-03T10:00:00+02:00') })
    setLock(db, userId, '2026-10', true)
    await syncAccount(ctx, 1)
    const r = await autoBook(ctx, userId)
    expect(r.created).toBe(0)
    expect(booked().map((b) => b.summary)).toEqual(['By hand #tasenor'])
    expect(notes.some((n) => n.level === 'warning' && /locked/.test(n.text))).toBe(true)
  })

  it('renames the hashtag in the source too, so the copy stays', async () => {
    g.external(PRIMARY, { id: 'a', summary: 'Coding #acme', start: t('2026-11-02T09:00:00+02:00'), end: t('2026-11-02T11:00:00+02:00'), organizer: { self: true } })
    await syncAccount(ctx, 1)
    await autoBook(ctx, userId)
    const acme = get<{ id: number }>(db, "SELECT id FROM projects WHERE hashtag = 'acme'")!.id
    await updateProject(ctx, userId, acme, { hashtag: 'aw' })
    const r = await autoBook(ctx, userId)
    expect([r.created, r.removed]).toEqual([0, 0])
    expect(g.cals.get(PRIMARY)!.events.get('a')!.summary).toBe('Coding #aw')
    expect(booked().map((b) => b.summary)).toEqual(['Coding #aw'])
  })
})

describe('booking from planner', () => {
  it('writes the hashtag into an own event, and automatic booking copies it', async () => {
    const { bookEvent, createEvent } = await import('./calendar.ts')
    await syncAccount(ctx, 1)
    const acme = get<{ id: number }>(db, "SELECT id FROM projects WHERE hashtag = 'acme'")!.id
    await createEvent(ctx, userId, { calendarId: calId(PRIMARY), title: 'Planning', projectId: acme, start: '2026-11-26T07:00:00.000Z', end: '2026-11-26T08:00:00.000Z', allDay: false })
    const id = get<{ id: number }>(db, "SELECT id FROM events WHERE summary = 'Planning #acme'")!.id
    await autoBook(ctx, userId)
    expect(booked().map((b) => b.summary)).toEqual(['Planning #acme'])
    const tasenor = get<{ id: number }>(db, "SELECT id FROM projects WHERE hashtag = 'tasenor'")!.id
    await bookEvent(ctx, userId, id, tasenor)
    await autoBook(ctx, userId)
    expect(booked().map((b) => b.summary)).toEqual(['Planning #tasenor'])
    const copy = get<{ id: number }>(db, "SELECT e.id FROM events e JOIN calendars c ON c.id = e.calendar_id WHERE c.is_bookkeeping = 1")!.id
    await expect(bookEvent(ctx, userId, copy, null)).rejects.toThrow(/follows its source/)
  })
})
