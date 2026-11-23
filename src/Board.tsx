import { DndContext, type DragEndEvent, DragOverlay, type DragStartEvent, PointerSensor, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { COLUMN_NAMES, COLUMNS, type Column, type Label, type Me, type Ticket } from '../shared/types.ts'
import { api } from './api.ts'
import { TicketModal } from './TicketModal.tsx'

/** What each column means, in the words of the board it replaced. */
const COLUMN_HINTS: Record<Column, string> = {
  p1: 'Most urgent',
  p2: 'After that',
  p3: 'When there is time',
  p4: 'Some day',
  done: 'Archived after 48 hours',
}

export function Board({ me, ownerId }: { me: Me; ownerId: number }) {
  const readOnly = ownerId !== me.id
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [labels, setLabels] = useState<Label[]>([])
  const [error, setError] = useState('')
  const [open, setOpen] = useState<number | null>(null)
  const [filter, setFilter] = useState<number | null>(null)
  const [dragging, setDragging] = useState<Ticket | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const load = useCallback(() => {
    Promise.all([api.get<Ticket[]>(`/api/users/${ownerId}/board`), api.get<Label[]>(`/api/users/${ownerId}/labels`)])
      .then(([t, l]) => {
        setTickets(t)
        setLabels(l)
        setError('')
      })
      .catch((e) => setError(e.message))
  }, [ownerId])
  useEffect(load, [load])
  useEffect(() => {
    // Keep the other board fresh when looking at it; ours changes only by us.
    const t = setInterval(load, readOnly ? 30_000 : 120_000)
    return () => clearInterval(t)
  }, [load, readOnly])

  const labelById = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels])
  const shown = filter ? tickets.filter((t) => t.labels.includes(filter)) : tickets
  const byCol = (col: Column) => shown.filter((t) => t.col === col).sort((a, b) => a.position - b.position)
  const owner = ownerId === me.id ? null : me.others.find((o) => o.id === ownerId)

  function onDragStart(e: DragStartEvent) {
    setDragging(tickets.find((t) => `card:${t.id}` === e.active.id) ?? null)
  }

  async function onDragEnd(e: DragEndEvent) {
    setDragging(null)
    if (!e.over) return
    const id = Number(String(e.active.id).slice(5))
    const overId = String(e.over.id)
    let col: Column
    let before: number | null = null
    if (overId.startsWith('col:')) col = overId.slice(4) as Column
    else {
      const target = tickets.find((t) => t.id === Number(overId.slice(5)))
      if (!target || target.id === id) return
      col = target.col
      before = target.id
    }
    const list = byCol(col).filter((t) => t.id !== id)
    const idx = before === null ? list.length : list.findIndex((t) => t.id === before)
    const after = idx > 0 ? list[idx - 1].id : null
    // Show the move at once; the server's answer then replaces it.
    setTickets((ts) => {
      const moving = ts.find((t) => t.id === id)!
      const pa = after !== null ? ts.find((t) => t.id === after)!.position : null
      const pb = before !== null ? ts.find((t) => t.id === before)!.position : null
      const pos = pa !== null && pb !== null ? (pa + pb) / 2 : pa !== null ? pa + 1024 : pb !== null ? pb - 1024 : 1e12
      return ts.map((t) => (t.id === id ? { ...moving, col, position: pos } : t))
    })
    try {
      const updated = await api.patch<Ticket>(`/api/tickets/${id}`, { col, after, before })
      setTickets((ts) => ts.map((t) => (t.id === id ? updated : t)))
    } catch (err) {
      setError((err as Error).message)
      load()
    }
  }

  return (
    <div className="board-page">
      <div className="toolbar">
        {me.others.length > 0 && (
          <div className="segmented" role="group" aria-label="Whose board">
            <a href="#/board" className={readOnly ? '' : 'on'} aria-current={readOnly ? undefined : 'page'}>
              My board
            </a>
            {me.others.map((o) => (
              <a key={o.id} href={`#/board/${o.id}`} className={o.id === ownerId ? 'on' : ''} aria-current={o.id === ownerId ? 'page' : undefined}>
                {o.name}
              </a>
            ))}
          </div>
        )}
        <select aria-label="Show cards with label" value={filter ?? ''} onChange={(e) => setFilter(e.target.value ? Number(e.target.value) : null)}>
          <option value="">All labels</option>
          {labels.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <a className="button quiet" href={owner ? `#/archive/${ownerId}` : '#/archive'}>
          Archive
        </a>
        {readOnly && <span className="pill">You can look at {owner?.name ?? 'this'}'s board but not change it</span>}
        {error && <span className="error">{error}</span>}
      </div>
      <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <div className="columns">
          {COLUMNS.map((col) => (
            <ColumnView
              key={col}
              col={col}
              tickets={byCol(col)}
              labelById={labelById}
              readOnly={readOnly}
              onOpen={setOpen}
              onAdd={async (title) => {
                const t = await api.post<Ticket>('/api/tickets', { title, col })
                setTickets((ts) => [...ts, t])
              }}
            />
          ))}
        </div>
        <DragOverlay>{dragging && <Card ticket={dragging} labelById={labelById} overlay />}</DragOverlay>
      </DndContext>
      {open !== null && (
        <TicketModal
          id={open}
          readOnly={readOnly}
          labels={labels}
          onLabelsChange={setLabels}
          onClose={() => setOpen(null)}
          onSaved={(t) => setTickets((ts) => ts.map((x) => (x.id === t.id ? t : x)))}
        />
      )}
    </div>
  )
}

function ColumnView(props: {
  col: Column
  tickets: Ticket[]
  labelById: Map<number, Label>
  readOnly: boolean
  onOpen: (id: number) => void
  onAdd: (title: string) => Promise<void>
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${props.col}`, disabled: props.readOnly })
  const [adding, setAdding] = useState('')
  return (
    <section ref={setNodeRef} className={`column col-${props.col} ${isOver ? 'over' : ''}`}>
      <header className="column-head">
        <h2>{COLUMN_NAMES[props.col]}</h2>
        <span className="hint">{COLUMN_HINTS[props.col]}</span>
        <span className="count" aria-label={`${props.tickets.length} cards`}>
          {props.tickets.length}
        </span>
      </header>
      <div className="cards">
        {props.tickets.map((t) => (
          <DraggableCard key={t.id} ticket={t} labelById={props.labelById} readOnly={props.readOnly} onOpen={props.onOpen} />
        ))}
      </div>
      {!props.readOnly && (
        <form
          className="add"
          onSubmit={async (e) => {
            e.preventDefault()
            if (!adding.trim()) return
            await props.onAdd(adding.trim())
            setAdding('')
          }}
        >
          <input aria-label={`Add a card to ${COLUMN_NAMES[props.col]}`} placeholder="Add a card" value={adding} onChange={(e) => setAdding(e.target.value)} />
        </form>
      )}
    </section>
  )
}

function DraggableCard({ ticket, labelById, readOnly, onOpen }: { ticket: Ticket; labelById: Map<number, Label>; readOnly: boolean; onOpen: (id: number) => void }) {
  const drag = useDraggable({ id: `card:${ticket.id}`, disabled: readOnly })
  const drop = useDroppable({ id: `card:${ticket.id}`, disabled: readOnly })
  return (
    <div
      ref={(el) => {
        drag.setNodeRef(el)
        drop.setNodeRef(el)
      }}
      {...drag.attributes}
      {...drag.listeners}
      className={`drop-slot ${drop.isOver && !drag.isDragging ? 'over' : ''} ${drag.isDragging ? 'ghost' : ''}`}
      onClick={() => onOpen(ticket.id)}
    >
      <Card ticket={ticket} labelById={labelById} />
    </div>
  )
}

function Card({ ticket, labelById, overlay }: { ticket: Ticket; labelById: Map<number, Label>; overlay?: boolean }) {
  return (
    <div className={`card card-${ticket.col} ${overlay ? 'overlay' : ''}`}>
      {ticket.labels.length > 0 && (
        <div className="labels">
          {ticket.labels.map((l) => {
            const label = labelById.get(l)
            return label ? (
              <span key={l} className="label" style={{ background: label.color }}>
                {label.name}
              </span>
            ) : null
          })}
        </div>
      )}
      <div className="title">{ticket.title}</div>
      {(ticket.description || ticket.comments > 0) && (
        <div className="meta">
          {ticket.description && (
            <span title="Has a description">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3 4h10M3 8h10M3 12h6" />
              </svg>
            </span>
          )}
          {ticket.comments > 0 && (
            <span title={`${ticket.comments} comments`}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3 3.5h10v7H7l-3 2.5v-2.5H3z" />
              </svg>
              {ticket.comments}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
