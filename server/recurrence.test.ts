import { describe, expect, it } from 'vitest'
import { fromWall, monthRange, toWall } from '../shared/time.ts'
import { expand } from './recurrence.ts'

describe('time zones', () => {
  it('converts Helsinki wall time across DST', () => {
    expect(fromWall({ y: 2026, m: 1, d: 15, h: 10, mi: 0, s: 0 }, 'Europe/Helsinki').toISOString()).toBe('2026-01-15T08:00:00.000Z')
    expect(fromWall({ y: 2026, m: 7, d: 15, h: 10, mi: 0, s: 0 }, 'Europe/Helsinki').toISOString()).toBe('2026-07-15T07:00:00.000Z')
    expect(toWall(new Date('2026-07-15T07:00:00Z'), 'Europe/Helsinki').h).toBe(10)
  })
  it('gives Helsinki month boundaries', () => {
    const r = monthRange('2026-11')
    expect(r.start.toISOString()).toBe('2026-10-31T22:00:00.000Z')
    expect(r.end.toISOString()).toBe('2026-11-30T22:00:00.000Z')
  })
})

describe('expand', () => {
  const weekly = {
    start: '2026-10-19T07:00:00.000Z', // Monday 10:00 Helsinki (summer time)
    end: '2026-10-19T08:00:00.000Z',
    allDay: false,
    timeZone: 'Europe/Helsinki',
    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
  }
  it('keeps the wall-clock time across the DST change', () => {
    const spans = expand(weekly, new Date('2026-10-18T00:00:00Z'), new Date('2026-11-03T00:00:00Z'))
    expect(spans.map((s) => s.start)).toEqual(['2026-10-19T07:00:00.000Z', '2026-10-26T08:00:00.000Z', '2026-11-02T08:00:00.000Z'])
    expect(spans[1].end).toBe('2026-10-26T09:00:00.000Z')
  })
  it('honours EXDATE, UNTIL and replaced occurrences', () => {
    const spans = expand(
      { ...weekly, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261109T075959Z', 'EXDATE;TZID=Europe/Helsinki:20261026T100000'] },
      new Date('2026-10-01T00:00:00Z'),
      new Date('2026-12-01T00:00:00Z'),
      new Set(['2026-11-02T08:00:00.000Z']),
    )
    expect(spans.map((s) => s.start)).toEqual(['2026-10-19T07:00:00.000Z'])
  })
  it('includes UNTIL when it is the last occurrence', () => {
    const spans = expand(
      { ...weekly, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261102T080000Z'] },
      new Date('2026-10-01T00:00:00Z'),
      new Date('2026-12-01T00:00:00Z'),
    )
    expect(spans).toHaveLength(3)
  })
  it('expands all-day series as dates', () => {
    const spans = expand(
      { start: '2026-11-01', end: '2026-11-02', allDay: true, timeZone: 'Europe/Helsinki', recurrence: ['RRULE:FREQ=YEARLY'] },
      new Date('2027-10-01T00:00:00Z'),
      new Date('2027-12-01T00:00:00Z'),
    )
    expect(spans).toEqual([{ start: '2027-11-01', end: '2027-11-02' }])
  })
  it('returns only occurrences overlapping the range', () => {
    const spans = expand(weekly, new Date('2026-10-19T07:30:00Z'), new Date('2026-10-20T00:00:00Z'))
    expect(spans).toHaveLength(1)
  })
})
