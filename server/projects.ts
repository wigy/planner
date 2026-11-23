// Projects and their hashtags.

import { HASHTAG_RE, renameHashtag } from '../shared/hashtag.ts'
import { monthOf } from '../shared/time.ts'
import type { Project } from '../shared/types.ts'
import { all, type Db, get, run } from './db.ts'
import { Conflict, Invalid, NotFound } from './errors.ts'
import { patchQuiet } from './rewrite.ts'
import type { Ctx, EventRow } from './sync.ts'

type ProjectRow = { id: number; user_id: number; title: string; hashtag: string; color: string; rate: number | null; customer: string; archived: number }

function json(p: ProjectRow): Project {
  return { id: p.id, title: p.title, hashtag: p.hashtag, color: p.color, rate: p.rate, customer: p.customer, archived: p.archived === 1 }
}

export function listProjects(db: Db, userId: number): Project[] {
  return all<ProjectRow>(db, 'SELECT * FROM projects WHERE user_id = ? ORDER BY archived, title COLLATE NOCASE', userId).map(json)
}

function cleanTag(tag: unknown): string {
  if (typeof tag !== 'string') throw new Invalid('hashtag required')
  const t = tag.trim().replace(/^#/, '').toLowerCase()
  if (!HASHTAG_RE.test(t)) throw new Invalid('a hashtag is 1–32 of a–z, 0–9, _ and -')
  return t
}

function cleanColor(c: unknown): string {
  return typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : '#3b82f6'
}

export type ProjectInput = { title?: unknown; hashtag?: unknown; color?: unknown; rate?: unknown; customer?: unknown; archived?: unknown }

export function createProject(db: Db, userId: number, input: ProjectInput): Project {
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (!title) throw new Invalid('title required')
  const hashtag = cleanTag(input.hashtag)
  if (get(db, 'SELECT 1 FROM projects WHERE user_id = ? AND hashtag = ?', userId, hashtag)) throw new Conflict(`#${hashtag} is already in use`)
  const rate = typeof input.rate === 'number' && input.rate >= 0 ? input.rate : null
  const r = run(db, 'INSERT INTO projects (user_id, title, hashtag, color, rate, customer) VALUES (?,?,?,?,?,?)',
    userId, title, hashtag, cleanColor(input.color), rate, typeof input.customer === 'string' ? input.customer.trim() : '')
  return json(get<ProjectRow>(db, 'SELECT * FROM projects WHERE id = ?', Number(r.lastInsertRowid))!)
}

/**
 * Updates a project. Changing its hashtag rewrites the title of every
 * Bookkeeping event that carries the old one, except in locked months, and of
 * the user's own events in their own calendars, which automatic booking copies.
 */
export async function updateProject(ctx: Ctx, userId: number, id: number, input: ProjectInput): Promise<{ project: Project; rewritten: number; skipped: number }> {
  const { db } = ctx
  const old = get<ProjectRow>(db, 'SELECT * FROM projects WHERE id = ? AND user_id = ?', id, userId)
  if (!old) throw new NotFound('no such project')
  const title = input.title === undefined ? old.title : typeof input.title === 'string' && input.title.trim() ? input.title.trim() : null
  if (!title) throw new Invalid('title required')
  const hashtag = input.hashtag === undefined ? old.hashtag : cleanTag(input.hashtag)
  if (hashtag !== old.hashtag && get(db, 'SELECT 1 FROM projects WHERE user_id = ? AND hashtag = ? AND id != ?', userId, hashtag, id)) {
    throw new Conflict(`#${hashtag} is already in use`)
  }
  const rate = input.rate === undefined ? old.rate : typeof input.rate === 'number' && input.rate >= 0 ? input.rate : null
  run(db, 'UPDATE projects SET title = ?, hashtag = ?, color = ?, rate = ?, customer = ?, archived = ? WHERE id = ?',
    title, hashtag, input.color === undefined ? old.color : cleanColor(input.color), rate,
    typeof input.customer === 'string' ? input.customer.trim() : old.customer,
    input.archived === undefined ? old.archived : input.archived ? 1 : 0, id)
  let rewritten = 0
  let skipped = 0
  if (hashtag !== old.hashtag) {
    const locked = new Set(all<{ month: string }>(db, 'SELECT month FROM locked_months WHERE user_id = ?', userId).map((r) => r.month))
    const rows = all<EventRow & { account_id: number; google_calendar_id: string }>(
      db,
      `SELECT e.*, c.google_account_id AS account_id, c.google_calendar_id FROM events e
       JOIN calendars c ON c.id = e.calendar_id JOIN google_accounts a ON a.id = c.google_account_id
       WHERE a.user_id = ? AND (c.is_bookkeeping = 1 OR (c.access_role = 'owner' AND e.organizer_self = 1))
         AND e.status != 'cancelled' AND e.summary LIKE ?
       ORDER BY c.is_bookkeeping`,
      userId, `%#${old.hashtag}%`,
    )
    for (const ev of rows) {
      const next = renameHashtag(ev.summary, old.hashtag, hashtag)
      if (next === ev.summary) continue
      const month = ev.start ? (ev.start.length === 10 ? ev.start.slice(0, 7) : monthOf(new Date(ev.start))) : ''
      if (locked.has(month)) {
        skipped++
        continue
      }
      try {
        await patchQuiet(ctx, ev.account_id, ev.calendar_id, ev.google_calendar_id, ev.google_event_id, { summary: next })
        rewritten++
      } catch (err) {
        skipped++
        ctx.notify('info', `Renaming #${old.hashtag} in "${ev.summary}" failed: ${String(err)}`)
      }
    }
    ctx.notify('info', `Project "${title}": hashtag #${old.hashtag} renamed to #${hashtag}; ${rewritten} event titles rewritten, ${skipped} left as they were (locked months or failures).`, 'Project hashtag renamed')
  }
  return { project: json(get<ProjectRow>(db, 'SELECT * FROM projects WHERE id = ?', id)!), rewritten, skipped }
}
