// The Exercises calendar: read-only events fetched live from an exercise feed (Rautaloki).
//
// Protocol, server to server:
//   GET <EXERCISE_FEED_URL>?email=<the planner user's email>&from=YYYY-MM-DD&to=YYYY-MM-DD
//   Authorization: Bearer <EXERCISE_FEED_KEY>
//   200 {name, events: ExerciseEvent[]}   404 for an email the feed does not know
// An event without allDay is taken as all-day, as the first version of the feed sent none.
// Nothing is stored: answers are cached for a minute so paging the calendar stays quick.

import type { ExerciseEvent } from '../shared/types.ts'

export type FeedConfig = { url: string; key: string }

export class FeedError extends Error {}

const TTL_MS = 60_000
const DATE = /^\d{4}-\d{2}-\d{2}$/

const INSTANT = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/

/** The event if it is well-formed, with allDay filled in; null otherwise. */
function valid(e: unknown): ExerciseEvent | null {
  const x = e as Record<string, unknown>
  if (!x || typeof x.start !== 'string' || typeof x.end !== 'string') return null
  const allDay = x.allDay !== false
  const times = allDay
    ? DATE.test(x.start) && DATE.test(x.end) && x.end > x.start
    : INSTANT.test(x.start) && INSTANT.test(x.end) && Date.parse(x.end) >= Date.parse(x.start)
  const ok =
    times &&
    typeof x.id === 'string' &&
    typeof x.title === 'string' &&
    (x.status === 'done' || x.status === 'planned') &&
    typeof x.kind === 'string' &&
    typeof x.description === 'string'
  return ok ? ({ ...x, allDay } as ExerciseEvent) : null
}

/** A function giving a user's exercise events overlapping [from, to), dates as YYYY-MM-DD. */
export function exerciseFeed(cfg: FeedConfig, fetchFn: typeof fetch = fetch, now = () => Date.now()) {
  const cache = new Map<string, { at: number; events: ExerciseEvent[] }>()
  return async (email: string, from: string, to: string): Promise<ExerciseEvent[]> => {
    const key = `${email}\n${from}\n${to}`
    const hit = cache.get(key)
    if (hit && now() - hit.at < TTL_MS) return hit.events
    const url = new URL(cfg.url)
    url.searchParams.set('email', email)
    url.searchParams.set('from', from)
    url.searchParams.set('to', to)
    let res: Response
    try {
      res = await fetchFn(url, { headers: { authorization: `Bearer ${cfg.key}` }, signal: AbortSignal.timeout(10_000) })
    } catch (err) {
      throw new FeedError(`exercise feed unreachable: ${String((err as Error).message ?? err)}`)
    }
    let events: ExerciseEvent[]
    if (res.status === 404) events = [] // not a user there, or the key is wrong: an empty calendar
    else if (!res.ok) throw new FeedError(`exercise feed: HTTP ${res.status}`)
    else {
      const body = (await res.json().catch(() => null)) as { events?: unknown } | null
      if (!body || !Array.isArray(body.events)) throw new FeedError('exercise feed: unexpected answer')
      events = body.events.map(valid).filter((e): e is ExerciseEvent => e !== null)
    }
    for (const [k, v] of cache) if (now() - v.at >= TTL_MS) cache.delete(k)
    cache.set(key, { at: now(), events })
    return events
  }
}
