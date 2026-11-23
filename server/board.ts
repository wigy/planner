// The todo board: tickets with no time, never written to Google. Each user has
// their own board; the other user's board can be read, never written, and that is
// enforced here rather than only in the UI.

import { ARCHIVE_AFTER_MS, COLUMNS, type Column, type Label, type Ticket, type TicketDetail } from '../shared/types.ts'
import { all, type Db, get, now, run, tx } from './db.ts'
import { Forbidden, Invalid, NotFound } from './errors.ts'
import type { Notifier } from './notify.ts'

type TicketRow = {
  id: number
  user_id: number
  title: string
  description: string
  col: Column
  position: number
  done_at: string | null
  archived_at: string | null
  project_id: number | null
  created_at: string
  updated_at: string
  comments: number
  labels: string | null
}

const SELECT = `SELECT t.*, (SELECT count(*) FROM ticket_comments c WHERE c.ticket_id = t.id) AS comments,
  (SELECT group_concat(label_id) FROM ticket_labels l WHERE l.ticket_id = t.id) AS labels FROM tickets t`

function json(r: TicketRow): Ticket {
  return {
    id: r.id,
    userId: r.user_id,
    title: r.title,
    description: r.description,
    col: r.col,
    position: r.position,
    doneAt: r.done_at,
    archivedAt: r.archived_at,
    projectId: r.project_id,
    labels: r.labels ? r.labels.split(',').map(Number) : [],
    comments: r.comments,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function event(db: Db, ticketId: number, userId: number | null, kind: string, payload: Record<string, unknown> = {}, at = now()) {
  run(db, 'INSERT INTO ticket_events (ticket_id, user_id, kind, payload_json, at) VALUES (?,?,?,?,?)', ticketId, userId, kind, JSON.stringify(payload), at)
}

/** Readable by anyone logged in: both users can see both boards. */
export function boardTickets(db: Db, ownerId: number): Ticket[] {
  return all<TicketRow>(db, `${SELECT} WHERE t.user_id = ? AND t.archived_at IS NULL ORDER BY t.col, t.position`, ownerId).map(json)
}

export function archivedTickets(db: Db, ownerId: number, q: string, limit = 200, offset = 0): { tickets: Ticket[]; total: number } {
  const like = `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`
  const where = `t.user_id = ? AND t.archived_at IS NOT NULL AND (? = '' OR t.title LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\')`
  const total = get<{ n: number }>(db, `SELECT count(*) AS n FROM tickets t WHERE ${where}`, ownerId, q, like, like)!.n
  const tickets = all<TicketRow>(db, `${SELECT} WHERE ${where} ORDER BY t.archived_at DESC LIMIT ? OFFSET ?`, ownerId, q, like, like, limit, offset).map(json)
  return { tickets, total }
}

function row(db: Db, id: number): TicketRow {
  const r = get<TicketRow>(db, `${SELECT} WHERE t.id = ?`, id)
  if (!r) throw new NotFound('no such ticket')
  return r
}

function own(db: Db, userId: number, id: number): TicketRow {
  const r = row(db, id)
  if (r.user_id !== userId) throw new Forbidden("the other user's board is read-only")
  return r
}

export function ticketDetail(db: Db, id: number): TicketDetail {
  const r = row(db, id)
  const commentList = all<{ id: number; user_id: number; name: string; body: string; created_at: string }>(
    db,
    'SELECT c.id, c.user_id, u.name, c.body, c.created_at FROM ticket_comments c JOIN users u ON u.id = c.user_id WHERE c.ticket_id = ? ORDER BY c.created_at, c.id',
    id,
  ).map((c) => ({ id: c.id, userId: c.user_id, userName: c.name, body: c.body, createdAt: c.created_at }))
  const history = all<{ kind: string; name: string | null; payload_json: string; at: string }>(
    db,
    'SELECT e.kind, u.name, e.payload_json, e.at FROM ticket_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.ticket_id = ? ORDER BY e.id',
    id,
  ).map((e) => ({ kind: e.kind, userName: e.name, payload: JSON.parse(e.payload_json), at: e.at }))
  return { ...json(r), commentList, history }
}

function checkCol(c: unknown): Column {
  if (typeof c !== 'string' || !(COLUMNS as readonly string[]).includes(c)) throw new Invalid('bad column')
  return c as Column
}

function endPosition(db: Db, userId: number, col: Column): number {
  const r = get<{ p: number | null }>(db, 'SELECT max(position) AS p FROM tickets WHERE user_id = ? AND col = ? AND archived_at IS NULL', userId, col)
  return (r?.p ?? 0) + 1024
}

export function createTicket(db: Db, userId: number, input: { title?: unknown; description?: unknown; col?: unknown }): Ticket {
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (!title) throw new Invalid('title required')
  const col = input.col === undefined ? 'p2' : checkCol(input.col)
  const t = now()
  const id = tx(db, () => {
    const r = run(db, 'INSERT INTO tickets (user_id, title, description, col, position, done_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      userId, title, typeof input.description === 'string' ? input.description : '', col, endPosition(db, userId, col), col === 'done' ? t : null, t, t)
    const id = Number(r.lastInsertRowid)
    event(db, id, userId, 'created', { col })
    return id
  })
  return json(row(db, id))
}

export type TicketPatch = {
  title?: unknown
  description?: unknown
  col?: unknown
  /** Drop position: between these two neighbours (ids), either may be null. */
  after?: unknown
  before?: unknown
  labels?: unknown
  projectId?: unknown
}

export function updateTicket(db: Db, userId: number, id: number, p: TicketPatch): Ticket {
  const old = own(db, userId, id)
  if (old.archived_at) throw new Invalid('restore the ticket before changing it')
  tx(db, () => {
    const t = now()
    if (p.title !== undefined) {
      const title = typeof p.title === 'string' ? p.title.trim() : ''
      if (!title) throw new Invalid('title required')
      if (title !== old.title) {
        run(db, 'UPDATE tickets SET title = ? WHERE id = ?', title, id)
        event(db, id, userId, 'title', { from: old.title, to: title })
      }
    }
    if (p.description !== undefined) {
      if (typeof p.description !== 'string') throw new Invalid('bad description')
      if (p.description !== old.description) {
        run(db, 'UPDATE tickets SET description = ? WHERE id = ?', p.description, id)
        event(db, id, userId, 'description')
      }
    }
    if (p.col !== undefined || p.after !== undefined || p.before !== undefined) {
      const col = p.col === undefined ? old.col : checkCol(p.col)
      const neighbour = (v: unknown) => {
        if (v === null || v === undefined) return null
        const n = get<{ position: number }>(db, 'SELECT position FROM tickets WHERE id = ? AND user_id = ? AND col = ? AND archived_at IS NULL', Number(v), userId, col)
        return n ? n.position : null
      }
      const a = neighbour(p.after)
      const b = neighbour(p.before)
      let position: number
      if (a !== null && b !== null) position = (a + b) / 2
      else if (a !== null) position = a + 1024
      else if (b !== null) position = b - 1024
      else position = endPosition(db, userId, col)
      run(db, 'UPDATE tickets SET col = ?, position = ? WHERE id = ?', col, position, id)
      if (col !== old.col) {
        // Done starts the 48-hour archive clock; leaving Done stops it.
        run(db, 'UPDATE tickets SET done_at = ? WHERE id = ?', col === 'done' ? t : null, id)
        event(db, id, userId, 'moved', { from: old.col, to: col })
      }
    }
    if (p.labels !== undefined) {
      if (!Array.isArray(p.labels)) throw new Invalid('labels is a list')
      const mine = new Set(all<{ id: number }>(db, 'SELECT id FROM labels WHERE user_id = ?', userId).map((l) => l.id))
      const next = [...new Set(p.labels.map(Number))].filter((l) => mine.has(l))
      const prev = old.labels ? old.labels.split(',').map(Number) : []
      run(db, 'DELETE FROM ticket_labels WHERE ticket_id = ?', id)
      for (const l of next) run(db, 'INSERT INTO ticket_labels (ticket_id, label_id) VALUES (?, ?)', id, l)
      if (next.slice().sort().join() !== prev.slice().sort().join()) event(db, id, userId, 'labels', { labels: next })
    }
    if (p.projectId !== undefined) {
      const pid = p.projectId === null ? null : Number(p.projectId)
      if (pid !== null && !get(db, 'SELECT 1 FROM projects WHERE id = ? AND user_id = ?', pid, userId)) throw new Invalid('no such project')
      run(db, 'UPDATE tickets SET project_id = ? WHERE id = ?', pid, id)
    }
    run(db, 'UPDATE tickets SET updated_at = ? WHERE id = ?', t, id)
  })
  return json(row(db, id))
}

export function addComment(db: Db, userId: number, id: number, body: unknown) {
  own(db, userId, id)
  if (typeof body !== 'string' || !body.trim()) throw new Invalid('comment is empty')
  const t = now()
  tx(db, () => {
    run(db, 'INSERT INTO ticket_comments (ticket_id, user_id, body, created_at) VALUES (?,?,?,?)', id, userId, body.trim(), t)
    run(db, 'UPDATE tickets SET updated_at = ? WHERE id = ?', t, id)
    event(db, id, userId, 'comment')
  })
}

/** Brings an archived ticket back, to the end of the column given (P2 by default). */
export function restoreTicket(db: Db, userId: number, id: number, col: unknown = 'p2'): Ticket {
  const old = own(db, userId, id)
  if (!old.archived_at) return json(old)
  const c = checkCol(col)
  tx(db, () => {
    run(db, 'UPDATE tickets SET archived_at = NULL, done_at = ?, col = ?, position = ?, updated_at = ? WHERE id = ?',
      c === 'done' ? now() : null, c, endPosition(db, userId, c), now(), id)
    event(db, id, userId, 'restored', { to: c })
  })
  return json(row(db, id))
}

/** Archives every card that has been in Done for more than 48 hours. Run hourly. */
export function archiveDone(db: Db, notify: Notifier, at = new Date()): number {
  const cutoff = new Date(at.getTime() - ARCHIVE_AFTER_MS).toISOString()
  const due = all<{ id: number; title: string }>(db, "SELECT id, title FROM tickets WHERE col = 'done' AND archived_at IS NULL AND done_at IS NOT NULL AND done_at <= ?", cutoff)
  if (due.length === 0) return 0
  const t = at.toISOString()
  tx(db, () => {
    for (const d of due) {
      run(db, 'UPDATE tickets SET archived_at = ? WHERE id = ?', t, d.id)
      event(db, d.id, null, 'archived', { reason: 'done for 48 hours' }, t)
    }
  })
  notify('info', `Archived ${due.length} ticket(s) done for over 48 hours: ${due.map((d) => d.title).join('; ')}`, 'Board cleanup')
  return due.length
}

// ---- labels ------------------------------------------------------------

export function listLabels(db: Db, ownerId: number): Label[] {
  return all<Label>(db, 'SELECT id, name, color FROM labels WHERE user_id = ? ORDER BY name COLLATE NOCASE', ownerId)
}

export function createLabel(db: Db, userId: number, input: { name?: unknown; color?: unknown }): Label {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) throw new Invalid('name required')
  const color = typeof input.color === 'string' && /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : '#64748b'
  const existing = get<Label>(db, 'SELECT id, name, color FROM labels WHERE user_id = ? AND name = ?', userId, name)
  if (existing) return existing
  const r = run(db, 'INSERT INTO labels (user_id, name, color) VALUES (?,?,?)', userId, name, color)
  return { id: Number(r.lastInsertRowid), name, color }
}

export function updateLabel(db: Db, userId: number, id: number, input: { name?: unknown; color?: unknown }): Label {
  const old = get<Label & { user_id: number }>(db, 'SELECT * FROM labels WHERE id = ?', id)
  if (!old || old.user_id !== userId) throw new NotFound('no such label')
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : old.name
  const color = typeof input.color === 'string' && /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : old.color
  run(db, 'UPDATE labels SET name = ?, color = ? WHERE id = ?', name, color, id)
  return { id, name, color }
}

export function deleteLabel(db: Db, userId: number, id: number) {
  const r = run(db, 'DELETE FROM labels WHERE id = ? AND user_id = ?', id, userId)
  if (r.changes === 0) throw new NotFound('no such label')
}
