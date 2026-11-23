import { beforeEach, describe, expect, it } from 'vitest'
import { addComment, archiveDone, archivedTickets, boardTickets, createLabel, createTicket, restoreTicket, ticketDetail, updateTicket } from './board.ts'
import { type Db, openDb, run } from './db.ts'

let db: Db
const silent = () => {}

beforeEach(() => {
  db = openDb(':memory:')
  run(db, "INSERT INTO users (name, primary_email, created_at) VALUES ('A', 'a@example.com', '2026-01-01'), ('B', 'b@example.com', '2026-01-01')")
})

describe('board', () => {
  it('orders cards by drop position', () => {
    const a = createTicket(db, 1, { title: 'a', col: 'p1' })
    const b = createTicket(db, 1, { title: 'b', col: 'p1' })
    const c = createTicket(db, 1, { title: 'c', col: 'p1' })
    updateTicket(db, 1, c.id, { after: a.id, before: b.id })
    expect(boardTickets(db, 1).map((t) => t.title)).toEqual(['a', 'c', 'b'])
    updateTicket(db, 1, a.id, { col: 'p3' })
    expect(boardTickets(db, 1).filter((t) => t.col === 'p3').map((t) => t.title)).toEqual(['a'])
  })

  it('keeps the other user’s board read-only', () => {
    const t = createTicket(db, 1, { title: 'mine' })
    expect(boardTickets(db, 1)).toHaveLength(1) // anyone can read
    expect(() => updateTicket(db, 2, t.id, { title: 'hijack' })).toThrow(/read-only/)
    expect(() => addComment(db, 2, t.id, 'hi')).toThrow(/read-only/)
  })

  it('archives cards done for 48 hours, and only those', () => {
    const t = createTicket(db, 1, { title: 'x' })
    const u = createTicket(db, 1, { title: 'y' })
    updateTicket(db, 1, t.id, { col: 'done' })
    updateTicket(db, 1, u.id, { col: 'done' })
    updateTicket(db, 1, u.id, { col: 'p1' }) // back out of Done: clock stops
    const later = new Date(Date.now() + 49 * 3600_000)
    expect(archiveDone(db, silent, new Date(Date.now() + 47 * 3600_000))).toBe(0)
    expect(archiveDone(db, silent, later)).toBe(1)
    expect(boardTickets(db, 1).map((x) => x.title)).toEqual(['y'])
    expect(archivedTickets(db, 1, 'x').total).toBe(1)
    restoreTicket(db, 1, t.id)
    expect(boardTickets(db, 1).map((x) => x.title).sort()).toEqual(['x', 'y'])
    expect(ticketDetail(db, t.id).history.map((h) => h.kind)).toEqual(['created', 'moved', 'archived', 'restored'])
  })

  it('stores comments and labels', () => {
    const t = createTicket(db, 1, { title: 'x' })
    const l = createLabel(db, 1, { name: 'Remontti', color: '#000000' })
    const other = createLabel(db, 2, { name: 'Theirs' })
    updateTicket(db, 1, t.id, { labels: [l.id, other.id] })
    addComment(db, 1, t.id, 'first')
    const d = ticketDetail(db, t.id)
    expect(d.labels).toEqual([l.id]) // another user's label is not accepted
    expect(d.commentList.map((c) => c.body)).toEqual(['first'])
  })
})
