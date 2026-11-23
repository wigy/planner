// Imports a Trello board export (Board menu → Print, export and share → Export
// as JSON) into one user's board. Safe to run again: cards and comments already
// imported (by Trello id) are skipped.
//
//   node server/import-trello.ts <export.json> <user email> [options]
//     --map "<list name>=<p1|p2|p3|p4|done>"   column for an open list (repeatable)
//     --label-list "<list name>"               also label its cards with the list name (repeatable)
//     --default <column>                       column for open lists not mapped (default p4,
//                                              labelled with the list name)
//     --dry-run                                print what would happen, write nothing
//
// Archived cards, and open cards in archived lists, go to the Archive with their
// list as a label. Checklists become a Markdown task list at the end of the
// description; attachments become links. Comments keep their dates, and are
// authored by the importing user. The export holds only the latest 1000 actions,
// so older comments may be missing from it.

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { COLUMNS, type Column } from '../shared/types.ts'
import { findOrCreateUser } from './accounts.ts'
import { get, openDb, run, tx } from './db.ts'

type TrelloLabel = { id: string; name: string; color: string | null }
type TrelloCard = {
  id: string
  name: string
  desc: string
  closed: boolean
  idList: string
  idLabels: string[]
  idChecklists: string[]
  pos: number
  dateLastActivity: string
  attachments?: { name: string; url: string }[]
}
type TrelloExport = {
  name: string
  lists: { id: string; name: string; closed: boolean }[]
  labels: TrelloLabel[]
  cards: TrelloCard[]
  checklists: { id: string; name: string; pos: number; checkItems: { name: string; state: string; pos: number }[] }[]
  actions: { id: string; type: string; date: string; data: { text?: string; card?: { id: string } } }[]
}

const COLORS: Record<string, string> = {
  green: '#22c55e', yellow: '#eab308', orange: '#f97316', red: '#ef4444', purple: '#a855f7',
  blue: '#3b82f6', sky: '#0ea5e9', lime: '#84cc16', pink: '#ec4899', black: '#334155',
}

function color(c: string | null): string {
  if (!c) return '#64748b'
  return COLORS[c.replace(/_(light|dark)$/, '')] ?? '#64748b'
}

function usage(msg: string): never {
  console.error(msg)
  console.error('usage: node server/import-trello.ts <export.json> <user email> [--map "List=p1"]... [--label-list List]... [--default p4] [--dry-run]')
  process.exit(2)
}

const args = process.argv.slice(2)
const positional: string[] = []
const map = new Map<string, Column>()
const labelLists = new Set<string>()
let fallback: Column = 'p4'
let dryRun = false
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--map') {
    const [list, col] = (args[++i] ?? '').split(/=(?=[^=]*$)/)
    if (!list || !(COLUMNS as readonly string[]).includes(col)) usage(`bad --map ${args[i]}`)
    map.set(list, col as Column)
  } else if (a === '--label-list') labelLists.add(args[++i] ?? usage('--label-list needs a list name'))
  else if (a === '--default') {
    const col = args[++i]
    if (!(COLUMNS as readonly string[]).includes(col)) usage(`bad --default ${col}`)
    fallback = col as Column
  } else if (a === '--dry-run') dryRun = true
  else positional.push(a)
}
if (positional.length !== 2) usage('need the export file and the user email')
const [file, email] = positional

const data = JSON.parse(readFileSync(file, 'utf8')) as TrelloExport
const dataDir = resolve(process.env.PLANNER_DATA ?? join(import.meta.dirname, '..', 'data'))
const db = openDb(join(dataDir, 'planner.db'))

const lists = new Map(data.lists.map((l) => [l.id, l]))
const trelloLabels = new Map(data.labels.map((l) => [l.id, l]))
const checklists = new Map(data.checklists.map((c) => [c.id, c]))
const comments = new Map<string, { id: string; text: string; date: string }[]>()
for (const a of data.actions) {
  if (a.type !== 'commentCard' || !a.data.card || !a.data.text) continue
  if (!comments.has(a.data.card.id)) comments.set(a.data.card.id, [])
  comments.get(a.data.card.id)!.push({ id: a.id, text: a.data.text, date: a.date })
}

for (const name of [...map.keys(), ...labelLists]) {
  if (!data.lists.some((l) => l.name === name)) usage(`no list named "${name}" in the export`)
}

/** Trello ids start with the creation time in seconds, as hex. */
function createdAt(id: string): string {
  return new Date(parseInt(id.slice(0, 8), 16) * 1000).toISOString()
}

const stats = { active: 0, archived: 0, skipped: 0, comments: 0, labels: 0 }
const perColumn: Record<string, number> = {}

class DryRun extends Error {}

try {
tx(db, () => {
  const user = findOrCreateUser(db, email.toLowerCase(), '')
  const labelIds = new Map<string, number>()
  const label = (name: string, hex: string): number => {
    const key = name.toLowerCase()
    if (labelIds.has(key)) return labelIds.get(key)!
    let row = get<{ id: number }>(db, 'SELECT id FROM labels WHERE user_id = ? AND name = ?', user.id, name)
    if (!row) {
      const r = run(db, 'INSERT INTO labels (user_id, name, color) VALUES (?, ?, ?)', user.id, name, hex)
      row = { id: Number(r.lastInsertRowid) }
      stats.labels++
    }
    labelIds.set(key, row.id)
    return row.id
  }

  for (const card of [...data.cards].sort((a, b) => a.pos - b.pos)) {
    if (get(db, 'SELECT 1 FROM tickets WHERE trello_id = ?', card.id)) {
      stats.skipped++
      continue
    }
    const list = lists.get(card.idList)
    const archived = card.closed || !list || list.closed
    let col: Column = archived ? 'done' : (map.get(list.name) ?? fallback)
    const cardLabels = new Set<number>()
    for (const id of card.idLabels) {
      const l = trelloLabels.get(id)
      if (l?.name) cardLabels.add(label(l.name, color(l.color)))
    }
    if (list && (archived || labelLists.has(list.name) || !map.has(list.name))) cardLabels.add(label(list.name, '#94a3b8'))
    if (archived && list && map.has(list.name)) col = map.get(list.name)!

    let description = card.desc ?? ''
    for (const clId of card.idChecklists) {
      const cl = checklists.get(clId)
      if (!cl) continue
      const items = [...cl.checkItems].sort((a, b) => a.pos - b.pos).map((i) => `- [${i.state === 'complete' ? 'x' : ' '}] ${i.name}`)
      description += `${description ? '\n\n' : ''}**${cl.name}**\n\n${items.join('\n')}`
    }
    if (card.attachments?.length) {
      description += `${description ? '\n\n' : ''}Attachments (in Trello):\n\n${card.attachments.map((a) => `- [${a.name}](${a.url})`).join('\n')}`
    }
    const created = createdAt(card.id)
    const last = card.dateLastActivity ?? created
    perColumn[archived ? 'archive' : col] = (perColumn[archived ? 'archive' : col] ?? 0) + 1
    if (archived) stats.archived++
    else stats.active++
    if (dryRun) continue
    const r = run(
      db,
      `INSERT INTO tickets (user_id, title, description, col, position, done_at, archived_at, trello_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      user.id, card.name, description, col, card.pos, archived || col === 'done' ? last : null, archived ? last : null, card.id, created, last,
    )
    const ticketId = Number(r.lastInsertRowid)
    for (const l of cardLabels) run(db, 'INSERT OR IGNORE INTO ticket_labels (ticket_id, label_id) VALUES (?, ?)', ticketId, l)
    run(db, 'INSERT INTO ticket_events (ticket_id, user_id, kind, payload_json, at) VALUES (?, ?, ?, ?, ?)',
      ticketId, user.id, 'imported', JSON.stringify({ from: 'trello', board: data.name, list: list?.name ?? null, archived }), new Date().toISOString())
    for (const c of (comments.get(card.id) ?? []).sort((a, b) => (a.date < b.date ? -1 : 1))) {
      run(db, 'INSERT OR IGNORE INTO ticket_comments (ticket_id, user_id, body, created_at, trello_id) VALUES (?,?,?,?,?)', ticketId, user.id, c.text, c.date, c.id)
      stats.comments++
    }
  }
  if (dryRun) throw new DryRun() // rolls back the labels and the user
})
} catch (err) {
  if (!(err instanceof DryRun)) throw err
}

console.log(`${dryRun ? '[dry run] ' : ''}board "${data.name}" → ${email}:`, stats, perColumn)
