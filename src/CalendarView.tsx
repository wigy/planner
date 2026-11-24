import type { DateSelectArg, EventClickArg, EventContentArg, EventDropArg, EventInput, EventSourceFuncArg } from '@fullcalendar/core'
import dayGridPlugin from '@fullcalendar/daygrid'
import interactionPlugin, { type EventResizeDoneArg } from '@fullcalendar/interaction'
import FullCalendar from '@fullcalendar/react'
import timeGridPlugin from '@fullcalendar/timegrid'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatHours } from '../shared/rounding.ts'
import type { Calendar, ExerciseEvent, Me, Occurrence, Project } from '../shared/types.ts'
import { api } from './api.ts'
import { hoursChanged, localDate, onHoursChanged } from './hours.ts'
import { useKeys } from './keys.ts'
import { EventModal, NewEventModal, ScopeModal } from './EventModal.tsx'
import { Modal } from './Modal.tsx'

type Pending = { occ: Occurrence; time: { start: string; end: string; allDay: boolean }; revert: () => void }

export function CalendarView({ me }: { me: Me }) {
  const [calendars, setCalendars] = useState<Calendar[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<Occurrence | null>(null)
  const [exercise, setExercise] = useState<ExerciseEvent[] | null>(null)
  // The Exercises calendar is not a Google calendar, so whether it is shown is kept in the browser.
  const [showExercises, setShowExercises] = useState(() => localStorage.getItem('planner.exercises') !== '0')
  const [creating, setCreating] = useState<{ start: string; end: string; allDay: boolean } | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const ref = useRef<FullCalendar>(null)
  // Booked minutes per day of the visible range, for the week numbers.
  const [range, setRange] = useState<{ from: string; to: string } | null>(null)
  const [days, setDays] = useState<Record<string, number>>({})
  useEffect(() => {
    if (!range) return
    const load = () => api.get<Record<string, number>>(`/api/hours?from=${range.from}&to=${range.to}`).then(setDays, () => {})
    load()
    return onHoursChanged(load)
  }, [range])
  const weekMinutes = (monday: Date) => {
    let sum = 0
    for (let i = 0; i < 7; i++) sum += days[localDate(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i))] ?? 0
    return sum
  }

  useKeys((key) => {
    const cal = ref.current?.getApi()
    if (!cal) return
    const views: Record<string, string> = { m: 'dayGridMonth', w: 'timeGridWeek', d: 'timeGridDay' }
    if (key === 't') cal.today()
    else if (key === 'ArrowLeft') cal.prev()
    else if (key === 'ArrowRight') cal.next()
    else if (views[key]) cal.changeView(views[key])
    else return
    return true
  })

  const loadCalendars = useCallback(() => api.get<Calendar[]>('/api/calendars').then(setCalendars, (e) => setError(e.message)), [])
  useEffect(() => {
    loadCalendars()
    api.get<Project[]>('/api/projects').then(setProjects)
  }, [loadCalendars])

  const calById = useMemo(() => new Map(calendars.map((c) => [c.id, c])), [calendars])
  const projById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])
  const refetch = () => {
    ref.current?.getApi().refetchEvents()
    hoursChanged()
  }

  const source = useCallback(
    (info: EventSourceFuncArg, ok: (events: EventInput[]) => void, fail: (e: Error) => void) => {
      api
        .get<Occurrence[]>(`/api/events?start=${info.start.toISOString()}&end=${info.end.toISOString()}`)
        .then((occs) =>
          ok(
            occs.map((o) => {
              const cal = calById.get(o.calendarId)
              const project = o.booking.kind === 'booked' ? projById.get(o.booking.projectId) : o.taggedProjectId ? projById.get(o.taggedProjectId) : undefined
              const color = o.booking.kind === 'booked' && project ? project.color : (cal?.color ?? '#4285f4')
              const classes = [o.booking.kind === 'conflict' ? 'ev-conflict' : '', o.taggedProjectId && !o.sentTo ? 'ev-tagged' : '', o.sentTo ? 'ev-sent' : '', cal?.bookkeeping ? 'ev-bk' : '']
              return {
                id: o.id,
                title: o.title || '(no title)',
                start: o.start,
                end: o.end,
                allDay: o.allDay,
                backgroundColor: color,
                borderColor: o.booking.kind === 'conflict' ? '#dc2626' : color,
                editable: o.editable,
                classNames: classes.filter(Boolean),
                extendedProps: { occ: o, tag: o.booking.kind === 'booked' && project ? project.hashtag : null },
              }
            }),
          ),
        )
        .catch(fail)
    },
    [calById, projById],
  )

  const exerciseSource = useCallback(
    (info: EventSourceFuncArg, ok: (events: EventInput[]) => void, fail: (e: Error) => void) => {
      if (!me.exercisesConfigured || !showExercises) return ok([])
      api
        .get<ExerciseEvent[]>(`/api/exercises?from=${localDate(info.start)}&to=${localDate(info.end)}`)
        .then((events) =>
          ok(
            groupExercises(events).map((group) => {
              const [e] = group
              return {
                id: `exercise:${e.id}`,
                title: group.length > 1 ? `Lifting: ${group.map(liftName).join(' · ')}` : e.title,
                start: e.start,
                end: e.end,
                allDay: e.allDay,
                editable: false,
                classNames: ['ev-ex', e.status === 'planned' ? 'ev-ex-planned' : 'ev-ex-done'],
                extendedProps: { exercises: group },
              }
            }),
          ),
        )
        .catch(fail)
    },
    [me.exercisesConfigured, showExercises],
  )
  const sources = useMemo(() => [source, exerciseSource], [source, exerciseSource])

  async function applyTime(occ: Occurrence, time: Pending['time'], scope: 'instance' | 'series' | undefined, revert: () => void) {
    try {
      await api.patch(`/api/events/${occ.eventId}`, { time, ...(occ.recurring && occ.id.includes('@') ? { occurrenceStart: occ.start, scope } : {}) })
      setError('')
    } catch (e) {
      setError((e as Error).message)
      revert()
    }
    refetch()
  }

  function onMove(arg: EventDropArg | EventResizeDoneArg) {
    const occ = arg.event.extendedProps.occ as Occurrence
    const allDay = arg.event.allDay
    const start = arg.event.start!
    const end = arg.event.end ?? new Date(start.getTime() + (allDay ? 86400_000 : 3600_000))
    const time = allDay ? { start: dateStr(start), end: dateStr(end), allDay } : { start: start.toISOString(), end: end.toISOString(), allDay }
    if (occ.id.includes('@')) setPending({ occ, time, revert: arg.revert })
    else applyTime(occ, time, undefined, arg.revert)
  }

  function onSelect(arg: DateSelectArg) {
    setCreating(arg.allDay ? { start: arg.startStr, end: arg.endStr, allDay: true } : { start: arg.start.toISOString(), end: arg.end.toISOString(), allDay: false })
    arg.view.calendar.unselect()
  }

  const hasAccount = me.accounts.length > 0
  const calItem = (c: Calendar) => (
    <label key={c.id} className="cal-item">
      <input
        type="checkbox"
        checked={c.selected}
        onChange={async (e) => {
          const updated = await api.patch<Calendar>(`/api/calendars/${c.id}`, { selected: e.target.checked })
          setCalendars((cs) => cs.map((x) => (x.id === c.id ? updated : x)))
        }}
      />
      <span className="cal-dot" style={{ background: c.color, borderColor: c.color }} />
      <span className="cal-name">{c.name}</span>
      {c.bookkeeping && <span className="pill small">hours</span>}
    </label>
  )
  return (
    <div className="calendar-page">
      <aside className="sidebar">
        <button
          className="sync"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await api.post('/api/sync')
              await loadCalendars()
              refetch()
            } catch (e) {
              setError((e as Error).message)
            }
            setBusy(false)
          }}
        >
          {busy ? 'Syncing…' : 'Sync now'}
        </button>
        {!hasAccount && <p className="muted">Link a Google account in Settings to see your calendars here.</p>}
        {groupBy(
          calendars.filter((c) => !c.bookkeeping),
          (c) => c.account,
        ).map(([account, cals]) => (
          <div key={account} className="cal-group">
            <h2 className="side-head">{account}</h2>
            {cals.map(calItem)}
          </div>
        ))}
        {(calendars.some((c) => c.bookkeeping) || me.exercisesConfigured) && (
          <div className="cal-group special">
            <h2 className="side-head">Special</h2>
            {calendars.filter((c) => c.bookkeeping).map(calItem)}
            {me.exercisesConfigured && (
              <label className="cal-item">
                <input
                  type="checkbox"
                  checked={showExercises}
                  onChange={(e) => {
                    localStorage.setItem('planner.exercises', e.target.checked ? '1' : '0')
                    setShowExercises(e.target.checked)
                  }}
                />
                <span className="cal-dot ex-dot" />
                <span className="cal-name">Exercises</span>
                <span className="pill small">Rautaloki</span>
              </label>
            )}
          </div>
        )}
        <div className="legend">
          <h2 className="side-head">Reading the colours</h2>
          <p>Events in Bookkeeping take their project's colour.</p>
          <p>
            <span className="ev-sample ev-tagged">Striped</span> has a project hashtag but cannot move to Bookkeeping: someone else's meeting, or an all-day event.
          </p>
          <p>
            <span className="ev-sample ev-sent">Faded</span> someone else's meeting that you sent to Bookkeeping as a copy.
          </p>
          <p>
            <span className="ev-sample ev-conflict">Red edge</span> has two project hashtags, so it counts for neither.
          </p>
          <p>
            <span className="ev-sample ev-bk">Dark edge</span> a Bookkeeping event: it counts as booked hours.
          </p>
          {me.exercisesConfigured && (
            <p>
              <span className="ev-sample ev-ex ev-ex-done">Green</span> a workout done,{' '}
              <span className="ev-sample ev-ex ev-ex-planned">dashed</span> one still to do this week or later.
            </p>
          )}
        </div>
      </aside>
      <div className="calendar-main">
        {error && <p className="error">{error}</p>}
        <FullCalendar
          ref={ref}
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
          initialView={localStorage.getItem('planner.view') ?? 'timeGridWeek'}
          datesSet={(arg) => {
            localStorage.setItem('planner.view', arg.view.type)
            setRange({ from: localDate(arg.start), to: localDate(arg.end) })
          }}
          eventContent={renderEvent}
          weekNumberContent={(arg) => {
            const minutes = weekMinutes(arg.date)
            return (
              <span className="week-cell" title={minutes ? `${formatHours(minutes)} h booked in week ${arg.num}` : undefined}>
                <span>W{arg.num}</span>
                {minutes > 0 && <span className="week-hours">{formatHours(minutes)}</span>}
              </span>
            )
          }}
          headerToolbar={{ left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay' }}
          buttonText={{ month: 'Month', week: 'Week', day: 'Day', today: 'Today' }}
          firstDay={1}
          locale="en-GB"
          weekNumbers
          nowIndicator
          height="calc(100vh - 120px)"
          scrollTime="07:00:00"
          slotDuration="00:30:00"
          snapDuration="00:15:00"
          eventTimeFormat={{ hour: '2-digit', minute: '2-digit', hour12: false }}
          slotLabelFormat={{ hour: '2-digit', minute: '2-digit', hour12: false }}
          selectable={hasAccount}
          selectMirror
          editable
          dayMaxEvents
          eventSources={sources}
          eventClick={(arg: EventClickArg) => {
            const ex = arg.event.extendedProps.exercises as ExerciseEvent[] | undefined
            if (ex) setExercise(ex)
            else setOpen(arg.event.extendedProps.occ as Occurrence)
          }}
          eventDrop={onMove}
          eventResize={onMove}
          select={onSelect}
        />
      </div>
      {open && (
        <EventModal
          occ={open}
          calendar={calById.get(open.calendarId)}
          projects={projects}
          onClose={() => setOpen(null)}
          onChanged={() => {
            setOpen(null)
            loadCalendars()
            refetch()
          }}
        />
      )}
      {exercise && <ExerciseModal events={exercise} onClose={() => setExercise(null)} />}
      {creating && (
        <NewEventModal
          initial={creating}
          calendars={calendars}
          projects={projects}
          onClose={() => setCreating(null)}
          onCreated={() => {
            setCreating(null)
            refetch()
          }}
        />
      )}
      {pending && (
        <ScopeModal
          what="Move"
          onCancel={() => {
            pending.revert()
            setPending(null)
          }}
          onPick={(scope) => {
            applyTime(pending.occ, pending.time, scope, pending.revert)
            setPending(null)
          }}
        />
      )}
    </div>
  )
}

/**
 * The lifts planned for the same week become one bar: as separate week-long bars they stack,
 * and the month view hides all but a few behind "+n more", which makes a hidden one look as
 * if it started on the first day with room. Everything else stays one event each.
 */
function groupExercises(events: ExerciseEvent[]): ExerciseEvent[][] {
  const weeks = new Map<string, ExerciseEvent[]>()
  const out: ExerciseEvent[][] = []
  for (const e of events) {
    if (e.status !== 'planned' || e.kind !== 'lift' || !e.allDay) {
      out.push([e])
      continue
    }
    const key = `${e.start}/${e.end}`
    const week = weeks.get(key)
    if (week) week.push(e)
    else {
      const group = [e]
      weeks.set(key, group)
      out.push(group)
    }
  }
  return out
}

/** "Deadlift 5 x 5 · 62.5 kg" → "Deadlift", for the title of a merged week. */
function liftName(e: ExerciseEvent): string {
  const scheme = e.title.search(/ (\d+ x |TEST\b)/)
  return scheme > 0 ? e.title.slice(0, scheme) : e.title
}

/** Workouts from the exercise feed: read-only, so only what they are and when. */
function ExerciseModal({ events, onClose }: { events: ExerciseEvent[]; onClose: () => void }) {
  const [first] = events
  const day = (d: Date) => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  const time = (d: Date) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  let when: string
  if (first.allDay) {
    const last = new Date(`${first.end}T12:00:00`)
    last.setDate(last.getDate() - 1)
    const start = new Date(`${first.start}T12:00:00`)
    when = first.start === localDate(last) ? day(start) : `${day(start)} – ${day(last)}`
  } else {
    const start = new Date(first.start)
    when = `${day(start)}, ${time(start)}–${time(new Date(first.end))}`
  }
  const single = events.length === 1
  return (
    <Modal onClose={onClose}>
      <h2>{single ? first.title : 'Lifting'}</h2>
      <p className="muted">
        {when} · {first.status === 'planned' ? 'to do' : 'done'}
      </p>
      {single ? (
        first.description && <p>{first.description}</p>
      ) : (
        <ul className="ex-list">
          {events.map((e) => (
            <li key={e.id}>
              <strong>{e.title}</strong>
              {e.description && <div className="muted small">{e.description}</div>}
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">From Rautaloki, read-only here.</p>
    </Modal>
  )
}

/** An event block; a booked one carries its project's hashtag in the corner. */
function renderEvent(arg: EventContentArg) {
  const tag = arg.event.extendedProps.tag as string | null
  if (!tag) return true
  const dot = arg.event.display === 'list-item' || (!arg.event.allDay && arg.view.type === 'dayGridMonth')
  return (
    <div className={`ev ${dot ? 'ev-line' : ''}`}>
      {dot && <span className="fc-daygrid-event-dot" style={{ borderColor: arg.backgroundColor }} />}
      {arg.timeText && <span className="fc-event-time">{arg.timeText}</span>}
      <span className="fc-event-title">{arg.event.title}</span>
      <span className="ev-tag">#{tag}</span>
    </div>
  )
}

function dateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function groupBy<T>(items: T[], key: (t: T) => string): [string, T[]][] {
  const m = new Map<string, T[]>()
  for (const i of items) {
    const k = key(i)
    if (!m.has(k)) m.set(k, [])
    m.get(k)!.push(i)
  }
  return [...m]
}
