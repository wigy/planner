// The Exercises calendar: read-only events fetched live from an exercise feed (Rautaloki).
//
// Protocol, server to server:
//   GET <EXERCISE_FEED_URL>?email=<the planner user's email>&from=YYYY-MM-DD&to=YYYY-MM-DD
//   Authorization: Bearer <EXERCISE_FEED_KEY>
//   200 {name, events: ExerciseEvent[]}   404 for an email the feed does not know
// Nothing is stored: answers are cached for a minute so paging the calendar stays quick.

import type { ExerciseEvent } from '../shared/types.ts'

export type FeedConfig = { url: string; key: string }

export class FeedError extends Error {}

const TTL_MS = 60_000
const DATE = /^\d{4}-\d{2}-\d{2}$/

function valid(e: unknown): e is ExerciseEvent {
  const x = e as Record<string, unknown>
  return (
    !!x &&
    typeof x.id === 'string' &&
    typeof x.title === 'string' &&
    typeof x.start === 'string' &&
    DATE.test(x.start) &&
    typeof x.end === 'string' &&
    DATE.test(x.end) &&
    x.end > x.start &&
    (x.status === 'done' || x.status === 'planned') &&
    typeof x.kind === 'string' &&
    typeof x.description === 'string'
  )
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
      events = body.events.filter(valid)
    }
    for (const [k, v] of cache) if (now() - v.at >= TTL_MS) cache.delete(k)
    cache.set(key, { at: now(), events })
    return events
  }
}
