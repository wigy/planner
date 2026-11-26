import { useCallback, useEffect, useMemo, useState } from 'react'
import { COLUMN_NAMES, type Column, type ExerciseEvent, type Label, type Me, type Ticket } from '../shared/types.ts'
import { api } from './api.ts'
import { Card } from './Board.tsx'
import { localDate } from './hours.ts'
import { useKeys } from './keys.ts'
import { TicketModal } from './TicketModal.tsx'

/** The columns a card to work on is drawn from, most urgent first. */
const OPEN: Column[] = ['p1', 'p2', 'p3', 'p4']

/** The entry page: one card to work on now, and the training still to do. */
export function Today({ me }: { me: Me }) {
  const hour = new Date().getHours()
  const greeting = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  return (
    <div className="page today">
      <h1>
        {greeting}, {me.name.split(' ')[0]}.
      </h1>
      <div className="today-grid">
        <NextCard me={me} />
        {me.exercisesConfigured && <Training />}
      </div>
    </div>
  )
}

/**
 * A random card from the most urgent column that has any. Drawn once when the page opens,
 * so it stays put while it is worked on; "Another one" draws again from the same column.
 */
function NextCard({ me }: { me: Me }) {
  const [tickets, setTickets] = useState<Ticket[] | null>(null)
  const [labels, setLabels] = useState<Label[]>([])
  const [pick, setPick] = useState<number | null>(null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([api.get<Ticket[]>(`/api/users/${me.id}/board`), api.get<Label[]>(`/api/users/${me.id}/labels`)]).then(
      ([t, l]) => {
        setTickets(t)
        setLabels(l)
      },
      (e) => setError(e.message),
    )
  }, [me.id])

  const col = useMemo(() => tickets && OPEN.find((c) => tickets.some((t) => t.col === c)), [tickets])
  const pool = useMemo(() => (tickets && col ? tickets.filter((t) => t.col === col) : []), [tickets, col])

  const draw = useCallback(() => {
    if (pool.length === 0) return
    setPick((now) => {
      const others = pool.filter((t) => t.id !== now)
      const from = others.length > 0 ? others : pool
      return from[Math.floor(Math.random() * from.length)].id
    })
  }, [pool])
  useEffect(() => {
    if (pick === null) draw()
  }, [pick, draw])

  useKeys((key) => {
    if (key === 'a' && pool.length > 1) {
      draw()
      return true
    }
    if (key === 'o' && pick !== null) {
      setOpen(true)
      return true
    }
  })

  const ticket = tickets?.find((t) => t.id === pick)
  const labelById = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels])

  return (
    <section className="today-sheet next-card">
      <header className="today-head">
        <h2>Next up</h2>
        {col && (
          <span className="muted small">
            one of {pool.length} in <span className={`col-name col-${col}`}>{COLUMN_NAMES[col]}</span>
          </span>
        )}
      </header>
      {error && <p className="error">{error}</p>}
      {tickets === null && !error && <p className="muted">Loading…</p>}
      {tickets !== null && !col && <p className="empty">The board is clear. Nothing to do but what you choose.</p>}
      {ticket && (
        <>
          <button className="focus-card" onClick={() => setOpen(true)} aria-label={`Open ${ticket.title}`}>
            <Card ticket={ticket} labelById={labelById} />
          </button>
          <div className="row">
            {pool.length > 1 && (
              <button className="quiet" onClick={draw}>
                <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M2.5 5h8l-2-2M13.5 11h-8l2 2" />
                </svg>
                Another one
              </button>
            )}
            <a className="button quiet" href="#/board">
              The board
            </a>
          </div>
        </>
      )}
      {open && pick !== null && (
        <TicketModal
          id={pick}
          readOnly={false}
          labels={labels}
          onLabelsChange={setLabels}
          onClose={() => setOpen(false)}
          onSaved={(t) => setTickets((ts) => ts && ts.map((x) => (x.id === t.id ? t : x)))}
        />
      )}
    </section>
  )
}

const DAY = 86400_000

/** Monday of the week a date is in, as YYYY-MM-DD. */
function mondayOf(d: Date): string {
  return localDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)))
}

/** The first day an event touches, in the browser's zone. */
function firstDay(e: ExerciseEvent): Date {
  return e.allDay ? new Date(`${e.start}T12:00:00`) : new Date(e.start)
}

/**
 * The training from Rautaloki for this week and the next: what is planned and not yet over,
 * and what is already done this week, ticked.
 */
function Training() {
  const [events, setEvents] = useState<ExerciseEvent[] | null>(null)
  const [error, setError] = useState('')
  const now = new Date()
  const today = localDate(now)
  const thisWeek = mondayOf(now)
  const nextWeek = localDate(new Date(Date.parse(`${thisWeek}T12:00:00`) + 7 * DAY))
  const until = localDate(new Date(Date.parse(`${thisWeek}T12:00:00`) + 14 * DAY))

  useEffect(() => {
    api.get<ExerciseEvent[]>(`/api/exercises?from=${thisWeek}&to=${until}`).then(setEvents, (e) => setError(e.message))
  }, [thisWeek, until])

  const weeks = useMemo(() => {
    const shown = (events ?? []).filter((e) => {
      const ends = e.allDay ? e.end > today : Date.parse(e.end) > Date.now()
      return e.status === 'planned' ? ends : mondayOf(firstDay(e)) === thisWeek
    })
    const byWeek = new Map<string, ExerciseEvent[]>()
    for (const e of shown) {
      const week = mondayOf(firstDay(e))
      if (!byWeek.has(week)) byWeek.set(week, [])
      byWeek.get(week)!.push(e)
    }
    // Done first in each week, then what is left, each by day.
    for (const list of byWeek.values()) list.sort((a, b) => (a.status === b.status ? a.start.localeCompare(b.start) : a.status === 'done' ? -1 : 1))
    return [...byWeek].sort(([a], [b]) => a.localeCompare(b))
  }, [events, today, thisWeek])

  const weekName = (w: string) => (w === thisWeek ? 'This week' : w === nextWeek ? 'Next week' : `Week of ${w}`)
  const left = weeks.find(([w]) => w === thisWeek)?.[1].filter((e) => e.status === 'planned').length ?? 0

  return (
    <section className="today-sheet training">
      <header className="today-head">
        <h2>Training</h2>
        {events && <span className="muted small">{left === 0 ? 'nothing left this week' : `${left} still to do this week`}</span>}
      </header>
      {error && <p className="error">{error}</p>}
      {events === null && !error && <p className="muted">Loading…</p>}
      {events !== null && weeks.length === 0 && <p className="empty">Nothing planned in Rautaloki for the next two weeks.</p>}
      {weeks.map(([week, list]) => (
        <div key={week} className="ex-week">
          <h3>{weekName(week)}</h3>
          <ul>
            {list.map((e) => (
              <ExerciseRow key={e.id} e={e} today={today} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  )
}

function ExerciseRow({ e, today }: { e: ExerciseEvent; today: string }) {
  const day = firstDay(e)
  const weekLong = e.allDay && Date.parse(`${e.end}T12:00:00`) - day.getTime() >= 6 * DAY
  const when = weekLong
    ? null
    : localDate(day) === today
      ? 'Today'
      : day.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
  return (
    <li className={`ex-row ex-${e.status} ex-kind-${e.kind}`}>
      <span className="ex-mark" aria-label={e.status === 'done' ? 'done' : 'to do'}>
        {e.status === 'done' && (
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 8.5l3.2 3L13 4.5" />
          </svg>
        )}
      </span>
      <span className="ex-text">
        <span className="ex-title">{e.title}</span>
        {e.description && <span className="ex-desc">{e.description}</span>}
      </span>
      {when && <span className={`ex-when ${when === 'Today' ? 'now' : ''}`}>{when}</span>}
    </li>
  )
}
