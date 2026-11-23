import { useEffect, useState } from 'react'
import type { Project } from '../shared/types.ts'
import { api } from './api.ts'
import { ask } from './Confirm.tsx'

type Draft = { title: string; hashtag: string; color: string; rate: string; customer: string }
const EMPTY: Draft = { title: '', hashtag: '', color: '#3b82f6', rate: '', customer: '' }

export function Projects() {
  const [projects, setProjects] = useState<Project[]>([])
  const [unknown, setUnknown] = useState<{ hashtag: string; count: number }[]>([])
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [editing, setEditing] = useState<number | null>(null)
  const [edit, setEdit] = useState<Draft>(EMPTY)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  const load = () => {
    api.get<Project[]>('/api/projects').then(setProjects, (e) => setError(e.message))
    api.get<{ hashtag: string; count: number }[]>('/api/hashtags/unknown').then(setUnknown)
  }
  useEffect(load, [])

  const body = (d: Draft) => ({ title: d.title, hashtag: d.hashtag, color: d.color, rate: d.rate ? Number(d.rate) : null, customer: d.customer })

  return (
    <div className="page">
      <h1>Projects</h1>
      <p className="lede">
        Put a project's hashtag in an event's title or description, here or in Google Calendar on your phone, and the event moves to Bookkeeping and counts for that project. Take the hashtag out and it moves back.
      </p>
      {error && <p className="error">{error}</p>}
      {note && <p className="note">{note}</p>}
      <table className="list">
        <thead>
          <tr>
            <th>Title</th>
            <th>Hashtag</th>
            <th>Customer</th>
            <th>Rate €/h</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {projects.map((p) =>
            editing === p.id ? (
              <tr key={p.id}>
                <td>
                  <input type="color" value={edit.color} onChange={(e) => setEdit({ ...edit, color: e.target.value })} />
                  <input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
                </td>
                <td>
                  <input value={edit.hashtag} onChange={(e) => setEdit({ ...edit, hashtag: e.target.value })} />
                </td>
                <td>
                  <input value={edit.customer} onChange={(e) => setEdit({ ...edit, customer: e.target.value })} />
                </td>
                <td>
                  <input className="small" type="number" value={edit.rate} onChange={(e) => setEdit({ ...edit, rate: e.target.value })} />
                </td>
                <td className="nowrap">
                  <button
                    className="primary"
                    onClick={async () => {
                      const renaming = edit.hashtag.replace(/^#/, '').toLowerCase() !== p.hashtag
                      const next = edit.hashtag.replace(/^#/, '').toLowerCase()
                      if (
                        renaming &&
                        !(await ask({
                          title: `Rename #${p.hashtag} to #${next}?`,
                          body: <p>Every event that carries #{p.hashtag} is rewritten in Google Calendar. Events in locked months keep the old hashtag.</p>,
                          confirm: 'Rename hashtag',
                        }))
                      )
                        return
                      try {
                        const r = await api.patch<{ project: Project; rewritten: number; skipped: number }>(`/api/projects/${p.id}`, body(edit))
                        setNote(renaming ? `Renamed: ${r.rewritten} events rewritten, ${r.skipped} left as they were.` : '')
                        setEditing(null)
                        setError('')
                        load()
                      } catch (e) {
                        setError((e as Error).message)
                      }
                    }}
                  >
                    Save
                  </button>
                  <button onClick={() => setEditing(null)}>Cancel</button>
                </td>
              </tr>
            ) : (
              <tr key={p.id} className={p.archived ? 'muted' : ''}>
                <td>
                  <span className="swatch" style={{ background: p.color }} /> {p.title} {p.archived && <span className="pill small">archived</span>}
                </td>
                <td>#{p.hashtag}</td>
                <td>{p.customer}</td>
                <td>{p.rate ?? ''}</td>
                <td className="nowrap">
                  <button
                    onClick={() => {
                      setEditing(p.id)
                      setEdit({ title: p.title, hashtag: p.hashtag, color: p.color, rate: p.rate === null ? '' : String(p.rate), customer: p.customer })
                    }}
                  >
                    Edit
                  </button>
                  <button onClick={async () => (await api.patch(`/api/projects/${p.id}`, { archived: !p.archived }), load())}>{p.archived ? 'Unarchive' : 'Archive'}</button>
                </td>
              </tr>
            ),
          )}
          <tr>
            <td>
              <input type="color" value={draft.color} onChange={(e) => setDraft({ ...draft, color: e.target.value })} />
              <input placeholder="New project title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </td>
            <td>
              <input placeholder="#hashtag" value={draft.hashtag} onChange={(e) => setDraft({ ...draft, hashtag: e.target.value })} />
            </td>
            <td>
              <input placeholder="Customer" value={draft.customer} onChange={(e) => setDraft({ ...draft, customer: e.target.value })} />
            </td>
            <td>
              <input className="small" type="number" placeholder="€/h" value={draft.rate} onChange={(e) => setDraft({ ...draft, rate: e.target.value })} />
            </td>
            <td>
              <button
                className="primary"
                onClick={async () => {
                  try {
                    await api.post('/api/projects', body(draft))
                    setDraft(EMPTY)
                    setError('')
                    load()
                  } catch (e) {
                    setError((e as Error).message)
                  }
                }}
              >
                Add
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      {unknown.length > 0 && (
        <>
          <h2>Hashtags without a project</h2>
          <p className="muted">These appear in Bookkeeping events but match no project, so those hours are not counted yet.</p>
          <ul>
            {unknown.map((u) => (
              <li key={u.hashtag}>
                #{u.hashtag} <span className="muted">({u.count} events)</span>{' '}
                <button className="link" onClick={() => setDraft({ ...EMPTY, hashtag: u.hashtag })}>
                  Create a project for it
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
