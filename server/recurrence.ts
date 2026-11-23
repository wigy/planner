// Expanding a recurring Google event into the occurrences in a range.
//
// Google returns a series as one event with RFC 5545 RRULE/EXDATE/RDATE lines plus
// a separate event for every occurrence that was changed or cancelled (carrying
// recurringEventId and originalStartTime). The rule is expanded in "floating"
// wall-clock time of the event's zone and each result converted back to an
// instant, so a 10:00 meeting stays at 10:00 when DST changes.

import rrulePkg from 'rrule'
import { addDays, fromWall, toWall, type Wall } from '../shared/time.ts'

const { RRule } = rrulePkg

const MAX_OCCURRENCES = 5000

export type Series = {
  start: string // ISO instant, or YYYY-MM-DD for all-day
  end: string
  allDay: boolean
  timeZone: string
  recurrence: string[]
}

export type Span = { start: string; end: string }

function floating(w: Wall): Date {
  return new Date(Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s))
}

function wallOf(d: Date): Wall {
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() }
}

function dateWall(date: string): Wall {
  const [y, m, d] = date.split('-').map(Number)
  return { y, m, d, h: 0, mi: 0, s: 0 }
}

/** 20261123T100000Z, 20261123T100000 or 20261123 → wall (and whether it is UTC). */
function parseIcalTime(v: string): { wall: Wall; utc: boolean; dateOnly: boolean } {
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/)
  if (!m) throw new Error(`bad iCalendar time: ${v}`)
  return {
    wall: { y: +m[1], m: +m[2], d: +m[3], h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0) },
    utc: m[7] === 'Z',
    dateOnly: m[4] === undefined,
  }
}

/** The instants (ms) or dates listed in EXDATE or RDATE lines. */
function listedTimes(lines: string[], name: 'EXDATE' | 'RDATE', series: Series): { ms: Set<number>; dates: Set<string> } {
  const ms = new Set<number>()
  const dates = new Set<string>()
  for (const line of lines) {
    const m = line.match(/^([A-Z]+)((?:;[^:]*)?):(.*)$/)
    if (!m || m[1] !== name) continue
    const tzid = m[2].match(/TZID=([^;:]+)/)?.[1] ?? series.timeZone
    for (const v of m[3].split(',')) {
      const t = parseIcalTime(v.trim())
      const date = `${t.wall.y}-${String(t.wall.m).padStart(2, '0')}-${String(t.wall.d).padStart(2, '0')}`
      if (t.dateOnly || series.allDay) dates.add(date)
      else ms.add(t.utc ? floating(t.wall).getTime() : fromWall(t.wall, tzid).getTime())
    }
  }
  return { ms, dates }
}

/**
 * Occurrences of the series overlapping [from, to), skipping EXDATEs and the
 * original start times in `replaced` (occurrences that have their own exception
 * event, which is shown in their place).
 */
export function expand(series: Series, from: Date, to: Date, replaced: Set<string> = new Set()): Span[] {
  const tz = series.timeZone
  const ruleLine = series.recurrence.find((l) => l.startsWith('RRULE:'))
  const durationMs = series.allDay ? 0 : new Date(series.end).getTime() - new Date(series.start).getTime()
  const durationDays = series.allDay ? Math.round((Date.parse(series.end) - Date.parse(series.start)) / 86400_000) : 0
  const startWall = series.allDay ? dateWall(series.start) : toWall(new Date(series.start), tz)
  const ex = listedTimes(series.recurrence, 'EXDATE', series)
  const rdates = listedTimes(series.recurrence, 'RDATE', series)

  const out: Span[] = []
  const push = (startMsOrDate: number | string) => {
    if (typeof startMsOrDate === 'string') {
      const end = addDays(startMsOrDate, durationDays)
      if (ex.dates.has(startMsOrDate) || replaced.has(startMsOrDate)) return
      // All-day spans overlap [from, to) when they touch it in UTC date terms; the
      // caller's range is generous enough that this is only a filter for scale.
      if (Date.parse(end) <= from.getTime() - 86400_000 || Date.parse(startMsOrDate) >= to.getTime() + 86400_000) return
      out.push({ start: startMsOrDate, end })
    } else {
      if (ex.ms.has(startMsOrDate) || replaced.has(new Date(startMsOrDate).toISOString())) return
      if (startMsOrDate + durationMs <= from.getTime() || startMsOrDate >= to.getTime()) return
      out.push({ start: new Date(startMsOrDate).toISOString(), end: new Date(startMsOrDate + durationMs).toISOString() })
    }
  }

  if (ruleLine) {
    const options = RRule.parseString(ruleLine.slice('RRULE:'.length))
    if (options.until) {
      // UNTIL in UTC is an instant; in floating terms it is its wall time in the zone.
      const untilText = ruleLine.match(/UNTIL=([0-9TZ]+)/)?.[1] ?? ''
      if (untilText.endsWith('Z') && !series.allDay) options.until = floating(toWall(options.until, tz))
    }
    options.dtstart = floating(startWall)
    options.tzid = null
    const rule = new RRule(options)
    // Widen the floating window by a day each way: zone offsets are under a day.
    const winFrom = new Date(from.getTime() - durationMs - 2 * 86400_000)
    const winTo = new Date(to.getTime() + 2 * 86400_000)
    let n = 0
    rule.between(winFrom, winTo, true, () => ++n <= MAX_OCCURRENCES).forEach((d: Date) => {
      if (series.allDay) push(d.toISOString().slice(0, 10))
      else push(fromWall(wallOf(d), tz).getTime())
    })
  } else {
    // A series with only RDATEs still has its first occurrence at DTSTART.
    push(series.allDay ? series.start : new Date(series.start).getTime())
  }
  for (const ms of rdates.ms) push(ms)
  for (const date of rdates.dates) push(date)
  out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
  return out
}
