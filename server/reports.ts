// Time reports. Booked time is read only from the Bookkeeping calendar: every
// event there whose title carries one known project hashtag is an entry. Time is
// exact; rounding is applied here, as chosen for the report.

import { descriptionText, parseEventBooking } from '../shared/hashtag.ts'
import { applyRounding, describeRounding, type Rounding } from '../shared/rounding.ts'
import { monthRange, REPORT_TZ, toWall } from '../shared/time.ts'
import type { MonthSummary, Report, ReportEntry } from '../shared/types.ts'
import { all, type Db, get, now, run } from './db.ts'
import { Invalid } from './errors.ts'
import { expand } from './recurrence.ts'
import type { EventRow } from './sync.ts'

type Raw = { minutes: number; start: string; end: string; date: string; title: string; text: string; eventId: number; projectId: number }

function localDate(d: Date): string {
  const w = toWall(d, REPORT_TZ)
  return `${w.y}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`
}

export function checkMonth(month: unknown): string {
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Invalid('month is YYYY-MM')
  return month
}

/** Booked time in the month, exact and clipped to the month's Helsinki boundaries. */
function entries(db: Db, userId: number, month: string): { raw: Raw[]; problems: Report['problems'] } {
  const { start: from, end: to } = monthRange(month)
  const projects = all<{ id: number; hashtag: string }>(db, 'SELECT id, hashtag FROM projects WHERE user_id = ?', userId)
  const tagToId = new Map(projects.map((p) => [p.hashtag.toLowerCase(), p.id]))
  const known = [...tagToId.keys()]
  const fromDate = month + '-01'
  const toDate = to.toISOString().slice(0, 10)
  const rows = all<EventRow>(
    db,
    `SELECT e.* FROM events e JOIN calendars c ON c.id = e.calendar_id JOIN google_accounts a ON a.id = c.google_account_id
     WHERE a.user_id = ? AND c.is_bookkeeping = 1 AND e.status != 'cancelled' AND (
       e.recurrence IS NOT NULL OR (e.all_day = 0 AND e.start < ? AND e.end > ?) OR (e.all_day = 1 AND e.start >= ? AND e.start < ?))`,
    userId, to.toISOString(), from.toISOString(), fromDate, toDate,
  )
  const replaced = new Map<string, Set<string>>()
  for (const r of rows) {
    if (r.recurring_event_id && r.original_start) {
      const key = `${r.calendar_id}/${r.recurring_event_id}`
      if (!replaced.has(key)) replaced.set(key, new Set())
      replaced.get(key)!.add(r.original_start)
    }
  }
  // Exceptions outside the month still replace occurrences inside it.
  for (const r of all<{ calendar_id: number; recurring_event_id: string; original_start: string }>(
    db,
    `SELECT e.calendar_id, e.recurring_event_id, e.original_start FROM events e JOIN calendars c ON c.id = e.calendar_id
     JOIN google_accounts a ON a.id = c.google_account_id WHERE a.user_id = ? AND c.is_bookkeeping = 1 AND e.recurring_event_id IS NOT NULL`,
    userId,
  )) {
    const key = `${r.calendar_id}/${r.recurring_event_id}`
    if (!replaced.has(key)) replaced.set(key, new Set())
    replaced.get(key)!.add(r.original_start)
  }

  const raw: Raw[] = []
  const problems: Report['problems'] = []
  const add = (ev: EventRow, start: string, end: string) => {
    const booking = parseEventBooking(ev.summary, ev.description, known)
    if (booking.kind === 'conflict') {
      problems.push({ title: ev.summary, start, reason: `two project hashtags: ${booking.hashtags.map((h) => '#' + h).join(' ')}` })
      return
    }
    if (booking.kind !== 'booked') return
    const projectId = tagToId.get(booking.hashtag)!
    if (ev.all_day === 1) {
      const minutes = Number(JSON.parse(ev.raw_json).extendedProperties?.private?.planner_minutes ?? 0)
      if (!(minutes > 0)) {
        problems.push({ title: ev.summary, start, reason: 'all-day event without hours' })
        return
      }
      if (start < fromDate || start >= toDate) return
      raw.push({ minutes, start, end, date: start, title: ev.summary, text: descriptionText(ev.description, known), eventId: ev.id, projectId })
      return
    }
    const s = Math.max(Date.parse(start), from.getTime())
    const e = Math.min(Date.parse(end), to.getTime())
    if (e <= s) return
    raw.push({
      minutes: (e - s) / 60_000,
      start: new Date(s).toISOString(),
      end: new Date(e).toISOString(),
      date: localDate(new Date(s)),
      title: ev.summary,
      text: descriptionText(ev.description, known),
      eventId: ev.id,
      projectId,
    })
  }
  for (const ev of rows) {
    if (!ev.start || !ev.end) continue
    if (ev.recurrence) {
      for (const span of expand(
        { start: ev.start, end: ev.end, allDay: ev.all_day === 1, timeZone: ev.time_zone ?? REPORT_TZ, recurrence: JSON.parse(ev.recurrence) },
        from,
        to,
        replaced.get(`${ev.calendar_id}/${ev.google_event_id}`),
      )) {
        add(ev, span.start, span.end)
      }
    } else add(ev, ev.start, ev.end)
  }
  raw.sort((a, b) => (a.start < b.start ? -1 : 1))
  return { raw, problems }
}

export function report(db: Db, userId: number, month: string, rounding: Rounding, projectId?: number): Report {
  const { raw, problems } = entries(db, userId, month)
  const projects = all<{ id: number; title: string; hashtag: string }>(db, 'SELECT id, title, hashtag FROM projects WHERE user_id = ? ORDER BY title COLLATE NOCASE', userId)
  const out: Report['projects'] = []
  let total = 0
  for (const p of projects) {
    if (projectId && p.id !== projectId) continue
    const mine = raw.filter((r) => r.projectId === p.id)
    if (mine.length === 0 && !projectId) continue
    const rounded = applyRounding(mine.map((r) => r.minutes), rounding)
    const list: ReportEntry[] = mine.map((r, i) => ({ ...r, rounded: rounded.entries[i] }))
    out.push({ projectId: p.id, title: p.title, hashtag: p.hashtag, minutes: rounded.total, entries: list })
    total += rounded.total
  }
  return {
    month,
    rounding: describeRounding(rounding),
    projects: out,
    totalMinutes: total,
    locked: !!get(db, 'SELECT 1 FROM locked_months WHERE user_id = ? AND month = ?', userId, month),
    problems,
  }
}

/** Exact booked minutes per project for each month of a year. */
export function yearSummary(db: Db, userId: number, year: number): MonthSummary[] {
  const out: MonthSummary[] = []
  for (let m = 1; m <= 12; m++) {
    const month = `${year}-${String(m).padStart(2, '0')}`
    const { raw } = entries(db, userId, month)
    const byProject: Record<number, number> = {}
    for (const r of raw) byProject[r.projectId] = (byProject[r.projectId] ?? 0) + r.minutes
    out.push({ month, byProject, totalMinutes: raw.reduce((a, r) => a + r.minutes, 0) })
  }
  return out
}

function csvCell(v: string | number): string {
  const s = String(v)
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function reportCsv(r: Report): string {
  const lines = [['project', 'hashtag', 'date', 'start', 'end', 'title', 'text', 'exact_minutes', 'minutes', 'hours'].join(',')]
  const hhmm = (iso: string) => (iso.length === 10 ? '' : (() => {
    const w = toWall(new Date(iso), REPORT_TZ)
    return `${String(w.h).padStart(2, '0')}:${String(w.mi).padStart(2, '0')}`
  })())
  for (const p of r.projects) {
    for (const e of p.entries) {
      lines.push([p.title, '#' + p.hashtag, e.date, hhmm(e.start), hhmm(e.end), e.title, e.text, Math.round(e.minutes), Math.round(e.rounded), (e.rounded / 60).toFixed(2)].map(csvCell).join(','))
    }
    lines.push([p.title, '#' + p.hashtag, 'total', '', '', '', '', '', Math.round(p.minutes), (p.minutes / 60).toFixed(2)].map(csvCell).join(','))
  }
  lines.push(['all projects', '', 'total', '', '', '', '', '', Math.round(r.totalMinutes), (r.totalMinutes / 60).toFixed(2)].map(csvCell).join(','))
  lines.push(['rounding: ' + r.rounding].map(csvCell).join(','))
  return lines.join('\n') + '\n'
}

export function setLock(db: Db, userId: number, month: string, locked: boolean) {
  if (locked) run(db, 'INSERT OR IGNORE INTO locked_months (user_id, month, locked_at) VALUES (?, ?, ?)', userId, month, now())
  else run(db, 'DELETE FROM locked_months WHERE user_id = ? AND month = ?', userId, month)
}
