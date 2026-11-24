import { describe, expect, it } from 'vitest'
import { exerciseFeed, FeedError } from './exercises.ts'

const cfg = { url: 'http://feed.test/api/feed', key: 'k3y' }
const event = { id: 'c1/4', title: 'Deadlift 5 x 5 · 62.5 kg', start: '2026-11-23', end: '2026-11-30', status: 'planned', kind: 'lift', description: '' }

function fake(status: number, body: unknown) {
  const calls: { url: string; auth: string | null }[] = []
  const fn = (async (url: URL, init?: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') })
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
  return { fn, calls }
}

describe('exercise feed', () => {
  it('asks for the user and range with the key, and keeps only well-formed events', async () => {
    const { fn, calls } = fake(200, { name: 'Exercises', events: [event, { ...event, id: 'bad', start: '23.11.2026' }, { ...event, id: 'x', status: 'maybe' }] })
    const events = await exerciseFeed(cfg, fn)('a@example.com', '2026-11-23', '2026-12-07')
    expect(events).toEqual([event])
    expect(calls).toEqual([{ url: 'http://feed.test/api/feed?email=a%40example.com&from=2026-11-23&to=2026-12-07', auth: 'Bearer k3y' }])
  })

  it('caches an answer for a minute', async () => {
    let t = 0
    const { fn, calls } = fake(200, { events: [event] })
    const feed = exerciseFeed(cfg, fn, () => t)
    await feed('a@example.com', '2026-11-23', '2026-12-07')
    t = 30_000
    await feed('a@example.com', '2026-11-23', '2026-12-07')
    expect(calls).toHaveLength(1)
    t = 61_000
    await feed('a@example.com', '2026-11-23', '2026-12-07')
    expect(calls).toHaveLength(2)
  })

  it('treats an unknown user as an empty calendar, and other failures as errors', async () => {
    expect(await exerciseFeed(cfg, fake(404, { error: 'not found' }).fn)('b@example.com', '2026-11-23', '2026-12-07')).toEqual([])
    await expect(exerciseFeed(cfg, fake(500, {}).fn)('a@example.com', '2026-11-23', '2026-12-07')).rejects.toBeInstanceOf(FeedError)
    await expect(exerciseFeed(cfg, fake(200, { nope: 1 }).fn)('a@example.com', '2026-11-23', '2026-12-07')).rejects.toBeInstanceOf(FeedError)
    const down = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    await expect(exerciseFeed(cfg, down)('a@example.com', '2026-11-23', '2026-12-07')).rejects.toBeInstanceOf(FeedError)
  })
})
