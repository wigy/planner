// Wall-clock time in a named zone, without a timezone library. Reports use
// Europe/Helsinki month boundaries, and recurring events are expanded in the
// zone of the event, so that a 10:00 meeting stays at 10:00 across DST.

export const REPORT_TZ = 'Europe/Helsinki'

export type Wall = { y: number; m: number; d: number; h: number; mi: number; s: number }

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(tz, f)
  }
  return f
}

/** The wall-clock time of an instant in a zone. */
export function toWall(instant: Date, tz: string): Wall {
  const parts: Record<string, number> = {}
  for (const p of formatter(tz).formatToParts(instant)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value)
  }
  return { y: parts.year, m: parts.month, d: parts.day, h: parts.hour, mi: parts.minute, s: parts.second }
}

function wallMs(w: Wall): number {
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s)
}

/**
 * The instant at which a zone's clock shows the given wall time. In a DST gap
 * the time is moved forward by the gap; in an overlap the earlier instant wins.
 */
export function fromWall(w: Wall, tz: string): Date {
  const target = wallMs(w)
  let guess = target
  for (let i = 0; i < 3; i++) {
    const offset = wallMs(toWall(new Date(guess), tz)) - guess
    const next = target - offset
    if (next === guess) break
    guess = next
  }
  // Prefer the earlier of two candidates in an overlap.
  const earlier = guess - 3600_000
  if (wallMs(toWall(new Date(earlier), tz)) === target) return new Date(earlier)
  return new Date(guess)
}

/** First instant of a month (YYYY-MM) in the zone, and of the next month. */
export function monthRange(month: string, tz = REPORT_TZ): { start: Date; end: Date } {
  const [y, m] = month.split('-').map(Number)
  const start = fromWall({ y, m, d: 1, h: 0, mi: 0, s: 0 }, tz)
  const end = fromWall({ y: m === 12 ? y + 1 : y, m: m === 12 ? 1 : m + 1, d: 1, h: 0, mi: 0, s: 0 }, tz)
  return { start, end }
}

/** YYYY-MM of an instant in the zone. */
export function monthOf(instant: Date, tz = REPORT_TZ): string {
  const w = toWall(instant, tz)
  return `${w.y}-${String(w.m).padStart(2, '0')}`
}

/** The instant an all-day date (YYYY-MM-DD) starts in the zone. */
export function dateStart(date: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  return fromWall({ y, m, d, h: 0, mi: 0, s: 0 }, tz)
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return t.toISOString().slice(0, 10)
}
