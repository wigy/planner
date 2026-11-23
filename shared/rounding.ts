// Rounding for time reports. Time is always stored exactly; rounding is chosen
// when a report is made and printed on it, so a report can be reproduced.

export type Rounding = {
  step: 0 | 15 | 30 | 60 // minutes; 0 means exact
  mode: 'up' | 'down' | 'nearest'
  apply: 'entry' | 'total'
}

export const EXACT: Rounding = { step: 0, mode: 'nearest', apply: 'entry' }

export function roundMinutes(minutes: number, r: Rounding): number {
  if (r.step === 0) return minutes
  const q = minutes / r.step
  const n = r.mode === 'up' ? Math.ceil(q - 1e-9) : r.mode === 'down' ? Math.floor(q + 1e-9) : Math.round(q)
  return n * r.step
}

/** The entries' minutes after rounding, and the total under the chosen rule. */
export function applyRounding(minutes: number[], r: Rounding): { entries: number[]; total: number } {
  if (r.apply === 'entry') {
    const entries = minutes.map((m) => roundMinutes(m, r))
    return { entries, total: entries.reduce((a, b) => a + b, 0) }
  }
  return { entries: minutes, total: roundMinutes(minutes.reduce((a, b) => a + b, 0), r) }
}

export function describeRounding(r: Rounding): string {
  if (r.step === 0) return 'exact minutes'
  return `${r.step} min, ${r.mode === 'nearest' ? 'to nearest' : r.mode}, per ${r.apply}`
}

export function parseRounding(q: URLSearchParams): Rounding {
  const step = Number(q.get('step') ?? 0)
  const mode = q.get('mode') ?? 'nearest'
  const apply = q.get('apply') ?? 'entry'
  return {
    step: step === 15 || step === 30 || step === 60 ? step : 0,
    mode: mode === 'up' || mode === 'down' ? mode : 'nearest',
    apply: apply === 'total' ? 'total' : 'entry',
  }
}

export function formatHours(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes - h * 60)
  return `${h}:${String(m).padStart(2, '0')}`
}
