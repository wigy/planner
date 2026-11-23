import { useState } from 'react'
import type { Calendar, Occurrence, Project } from '../shared/types.ts'
import { api } from './api.ts'
import { renderMarkdown } from './markdown.ts'
import { Modal } from './Modal.tsx'

type Time = { start: string; end: string; allDay: boolean }

/** ISO instant → value for <input type="datetime-local"> in the browser's zone. */
function toLocalInput(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

function addDay(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function formatWhen(o: { start: string; end: string; allDay: boolean }): string {
  if (o.allDay) {
    const last = addDay(o.end, -1)
    return last === o.start ? `${o.start} (all day)` : `${o.start} – ${last} (all day)`
  }
  const s = new Date(o.start)
  const e = new Date(o.end)
  const day = s.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  const hm = (d: Date) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const mins = Math.round((e.getTime() - s.getTime()) / 60000)
  return `${day} ${hm(s)}–${hm(e)} (${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')} h)`
}

/** Editing a time: all-day dates are shown inclusive, stored with Google's exclusive end. */
function TimeFields({ time, onChange }: { time: Time; onChange: (t: Time) => void }) {
  return (
    <div className="time-fields">
      <label className="inline">
        <input
          type="checkbox"
          checked={time.allDay}
          onChange={(e) => {
            if (e.target.checked) {
              const d = toLocalInput(time.start).slice(0, 10)
              onChange({ allDay: true, start: d, end: addDay(d, 1) })
            } else {
              const s = new Date(`${time.start}T09:00`)
              onChange({ allDay: false, start: s.toISOString(), end: new Date(s.getTime() + 3600_000).toISOString() })
            }
          }}
        />
        All day
      </label>
      {time.allDay ? (
        <>
          <input type="date" value={time.start} onChange={(e) => e.target.value && onChange({ ...time, start: e.target.value, end: time.end <= e.target.value ? addDay(e.target.value, 1) : time.end })} />
          <span>to</span>
          <input type="date" value={addDay(time.end, -1)} onChange={(e) => e.target.value && onChange({ ...time, end: addDay(e.target.value, 1) })} />
        </>
      ) : (
        <>
          <input
            type="datetime-local"
            value={toLocalInput(time.start)}
            onChange={(e) => {
              if (!e.target.value) return
              const len = Date.parse(time.end) - Date.parse(time.start)
              const s = new Date(e.target.value)
              onChange({ ...time, start: s.toISOString(), end: new Date(s.getTime() + Math.max(len, 15 * 60000)).toISOString() })
            }}
          />
          <span>to</span>
          <input type="datetime-local" value={toLocalInput(time.end)} onChange={(e) => e.target.value && onChange({ ...time, end: new Date(e.target.value).toISOString() })} />
        </>
      )}
    </div>
  )
}

export function ScopeModal({ what, onPick, onCancel }: { what: string; onPick: (s: 'instance' | 'series') => void; onCancel: () => void }) {
  return (
    <Modal onClose={onCancel}>
      <h2>{what} a recurring event</h2>
      <p>Change only this occurrence, or every event in the series?</p>
      <div className="row">
        <button className="primary" onClick={() => onPick('instance')}>
          This occurrence
        </button>
        <button onClick={() => onPick('series')}>Whole series</button>
        <button className="link" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </Modal>
  )
}

function ProjectSelect({ projects, value, onChange, allowNone }: { projects: Project[]; value: number | null; onChange: (id: number | null) => void; allowNone?: boolean }) {
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      {allowNone ? <option value="">No project</option> : <option value="">Choose a project…</option>}
      {projects
        .filter((p) => !p.archived || p.id === value)
        .map((p) => (
          <option key={p.id} value={p.id}>
            {p.title} (#{p.hashtag})
          </option>
        ))}
    </select>
  )
}

export function EventModal({ occ, calendar, projects, onClose, onChanged }: { occ: Occurrence; calendar?: Calendar; projects: Project[]; onClose: () => void; onChanged: () => void }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(occ.title)
  const [description, setDescription] = useState(occ.description)
  const [location, setLocation] = useState(occ.location)
  const [time, setTime] = useState<Time>({ start: occ.start, end: occ.end, allDay: occ.allDay })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [scopeFor, setScopeFor] = useState<null | 'save' | 'delete'>(null)
  const bk = !!calendar?.bookkeeping
  const own = !bk && calendar?.accessRole === 'owner' && !occ.allDay && occ.organizerSelf && !occ.sentTo
  const expanded = occ.id.includes('@')
  const booked = occ.booking.kind === 'booked' ? occ.booking.projectId : null
  const [sendProject, setSendProject] = useState<number | null>(occ.taggedProjectId)
  const [mode, setMode] = useState<'copy' | 'move'>('copy')
  const [hours, setHours] = useState('')
  const canMove = occ.organizerSelf && !occ.recurring && occ.editable

  async function run(fn: () => Promise<unknown>) {
    setBusy(true)
    try {
      await fn()
      onChanged()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const save = (scope?: 'instance' | 'series') =>
    run(() =>
      api.patch(`/api/events/${occ.eventId}`, {
        title,
        description,
        location,
        ...(time.start !== occ.start || time.end !== occ.end || time.allDay !== occ.allDay ? { time } : {}),
        ...(expanded ? { occurrenceStart: occ.start, scope } : {}),
      }),
    )
  const remove = (scope?: 'instance' | 'series') =>
    run(() => api.del(`/api/events/${occ.eventId}${expanded ? `?occurrenceStart=${encodeURIComponent(occ.start)}&scope=${scope}` : ''}`))

  return (
    <Modal onClose={onClose} wide>
      <div className="event">
        <div className="muted small">
          <span className="swatch" style={{ background: calendar?.color }} /> {calendar?.name} {calendar && `· ${calendar.account}`}
          {occ.recurring && ' · recurring'}
        </div>
        {editing ? (
          <>
            <input className="title-input" value={title} onChange={(e) => setTitle(e.target.value)} />
            <TimeFields time={time} onChange={setTime} />
            <input placeholder="Location" value={location} onChange={(e) => setLocation(e.target.value)} />
            <textarea rows={6} placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
            <div className="row">
              <button className="primary" disabled={busy} onClick={() => (expanded ? setScopeFor('save') : save())}>
                Save
              </button>
              <button onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </>
        ) : (
          <>
            <h2>{occ.title || '(no title)'}</h2>
            <p>{formatWhen(occ)}</p>
            {occ.location && <p className="muted">📍 {occ.location}</p>}
            {occ.description && <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(occ.description) }} />}
            {occ.editable && (
              <div className="row">
                <button onClick={() => setEditing(true)}>Edit</button>
                <button className="danger" disabled={busy} onClick={() => (expanded ? setScopeFor('delete') : confirm('Delete this event in Google Calendar?') && remove())}>
                  Delete
                </button>
              </div>
            )}
          </>
        )}
        {error && <p className="error">{error}</p>}

        {bk && (
          <section className="bookkeeping">
            <h3>Bookkeeping</h3>
            {occ.booking.kind === 'conflict' && <p className="error">Two project hashtags ({occ.booking.hashtags.map((h) => '#' + h).join(', ')}): not booked. Pick one:</p>}
            <div className="row">
              <ProjectSelect projects={projects} value={booked} allowNone onChange={(id) => run(() => api.post(`/api/events/${occ.eventId}/book`, { projectId: id, ...(expanded ? { occurrenceStart: occ.start } : {}) }))} />
              <span className="muted small">Sets the project hashtag in the description. With no project, the event moves back out of Bookkeeping.</span>
            </div>
            {occ.allDay && <p className="muted small">An all-day entry counts only with hours set when it was sent here.</p>}
          </section>
        )}
        {own && (
          <section className="bookkeeping">
            <h3>Project</h3>
            <div className="row">
              <ProjectSelect projects={projects} value={occ.taggedProjectId} allowNone onChange={(id) => run(() => api.post(`/api/events/${occ.eventId}/book`, { projectId: id, ...(expanded ? { occurrenceStart: occ.start } : {}) }))} />
              <span className="muted small">
                Sets the project hashtag in the description, and the event moves to Bookkeeping.
              </span>
            </div>
          </section>
        )}
        {!bk && !own && (
          <section className="bookkeeping">
            <h3>Send to Bookkeeping</h3>
            {occ.sentTo ? (
              <p className="muted">Already sent to Bookkeeping.</p>
            ) : (
              <>
                <div className="row">
                  <ProjectSelect projects={projects} value={sendProject} onChange={setSendProject} />
                  <label className="inline">
                    <input type="radio" checked={mode === 'copy'} onChange={() => setMode('copy')} /> Copy
                  </label>
                  <label className={`inline ${canMove ? '' : 'disabled'}`} title={canMove ? '' : 'Only your own single events can be moved'}>
                    <input type="radio" disabled={!canMove} checked={mode === 'move'} onChange={() => setMode('move')} /> Move
                  </label>
                  {occ.allDay && <input className="small" type="number" min="0.25" step="0.25" placeholder="hours" value={hours} onChange={(e) => setHours(e.target.value)} />}
                  <button
                    className="primary"
                    disabled={busy || !sendProject || (occ.allDay && !(Number(hours) > 0))}
                    onClick={() =>
                      run(() =>
                        api.post(`/api/events/${occ.eventId}/send`, {
                          projectId: sendProject,
                          mode,
                          ...(expanded ? { occurrenceStart: occ.start } : {}),
                          ...(occ.allDay ? { minutes: Math.round(Number(hours) * 60) } : {}),
                        }),
                      )
                    }
                  >
                    Send
                  </button>
                </div>
                <p className="muted small">Copy leaves this event as it is and adds a copy to Bookkeeping. Move takes the event itself there.</p>
              </>
            )}
          </section>
        )}
      </div>
      {scopeFor && (
        <ScopeModal
          what={scopeFor === 'save' ? 'Edit' : 'Delete'}
          onCancel={() => setScopeFor(null)}
          onPick={(s) => {
            setScopeFor(null)
            if (scopeFor === 'save') save(s)
            else remove(s)
          }}
        />
      )}
    </Modal>
  )
}

export function NewEventModal({ initial, calendars, projects, onClose, onCreated }: { initial: Time; calendars: Calendar[]; projects: Project[]; onClose: () => void; onCreated: () => void }) {
  const writable = calendars.filter((c) => c.accessRole === 'owner' || c.accessRole === 'writer')
  const remembered = Number(localStorage.getItem('planner.newCalendar'))
  const [calendarId, setCalendarId] = useState<number>(writable.find((c) => c.id === remembered)?.id ?? writable.find((c) => c.primary)?.id ?? writable[0]?.id ?? 0)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [time, setTime] = useState<Time>(initial)
  const [projectId, setProjectId] = useState<number | null>(null)
  const [error, setError] = useState('')
  const cal = calendars.find((c) => c.id === calendarId)
  return (
    <Modal onClose={onClose} wide>
      <form
        className="event"
        onSubmit={async (e) => {
          e.preventDefault()
          try {
            localStorage.setItem('planner.newCalendar', String(calendarId))
            await api.post('/api/events', { calendarId, title, description, projectId: cal?.bookkeeping || (cal?.accessRole === 'owner' && !time.allDay) ? projectId : null, ...time })
            onCreated()
          } catch (err) {
            setError((err as Error).message)
          }
        }}
      >
        <h2>New event</h2>
        <select value={calendarId} onChange={(e) => setCalendarId(Number(e.target.value))}>
          {writable.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.account})
            </option>
          ))}
        </select>
        <input className="title-input" autoFocus placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <TimeFields time={time} onChange={setTime} />
        {(cal?.bookkeeping || (cal?.accessRole === 'owner' && !time.allDay)) && <ProjectSelect projects={projects} value={projectId} onChange={setProjectId} allowNone />}
        <textarea rows={4} placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button className="primary" type="submit" disabled={!calendarId || (!title.trim() && !projectId)}>
            Create
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  )
}
