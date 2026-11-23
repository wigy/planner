import { describe, expect, it } from 'vitest'
import { applyRounding, roundMinutes } from './rounding.ts'

describe('rounding', () => {
  it('is exact by default', () => {
    expect(roundMinutes(52, { step: 0, mode: 'up', apply: 'entry' })).toBe(52)
  })
  it('rounds up, down and to nearest', () => {
    expect(roundMinutes(52, { step: 15, mode: 'up', apply: 'entry' })).toBe(60)
    expect(roundMinutes(60, { step: 15, mode: 'up', apply: 'entry' })).toBe(60)
    expect(roundMinutes(52, { step: 15, mode: 'down', apply: 'entry' })).toBe(45)
    expect(roundMinutes(52, { step: 30, mode: 'nearest', apply: 'entry' })).toBe(60)
    expect(roundMinutes(44, { step: 30, mode: 'nearest', apply: 'entry' })).toBe(30)
  })
  it('applies per entry or to the total', () => {
    const r = { step: 30, mode: 'up', apply: 'entry' } as const
    expect(applyRounding([10, 10, 10], r)).toEqual({ entries: [30, 30, 30], total: 90 })
    expect(applyRounding([10, 10, 10], { ...r, apply: 'total' })).toEqual({ entries: [10, 10, 10], total: 30 })
  })
})
