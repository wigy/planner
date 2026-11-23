import { useEffect, useState } from 'react'
import { COLUMN_NAMES, COLUMNS, type Label, type Ticket, type TicketDetail } from '../shared/types.ts'
import { api } from './api.ts'
import { renderMarkdown } from './markdown.ts'
import { useKeys } from './keys.ts'
import { Modal } from './Modal.tsx'

const HISTORY: Record<string, (p: Record<string, unknown>) => string> = {
  created: (p) => `created in ${COLUMN_NAMES[p.col as keyof typeof COLUMN_NAMES] ?? p.col}`,
  moved: (p) => `moved ${COLUMN_NAMES[p.from as keyof typeof COLUMN_NAMES] ?? p.from} → ${COLUMN_NAMES[p.to as keyof typeof COLUMN_NAMES] ?? p.to}`,
  title: () => 'renamed',
  description: () => 'edited the description',
  labels: () => 'changed labels',
  comment: () => 'commented',
  archived: (p) => `archived (${p.reason ?? 'by hand'})`,
  restored: (p) => `restored to ${COLUMN_NAMES[p.to as keyof typeof COLUMN_NAMES] ?? p.to}`,
  imported: (p) => `imported from Trello (${p.list ?? '?'})`,
}

export function TicketModal(props: {
  id: number
  readOnly: boolean
  labels: Label[]
  onLabelsChange: (l: Label[]) => void
  onClose: () => void
  onSaved: (t: Ticket) => void
}) {
  const [t, setT] = useState<TicketDetail | null>(null)
  const [title, setTitle] = useState('')
  const [desc, setDesc] = useState('')
  const [editingDesc, setEditingDesc] = useState(false)
  const [comment, setComment] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [error, setError] = useState('')
  const ro = props.readOnly || !!t?.archivedAt

  useEffect(() => {
    api.get<TicketDetail>(`/api/tickets/${props.id}`).then((d) => {
      setT(d)
      setTitle(d.title)
      setDesc(d.description)
    }, (e) => setError(e.message))
  }, [props.id])

  async function save(patch: Record<string, unknown>) {
    try {
      const updated = await api.patch<Ticket>(`/api/tickets/${props.id}`, patch)
      props.onSaved(updated)
      setT((old) => (old ? { ...old, ...updated } : old))
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // 1–4 move the open card between priorities, d marks it done.
  useKeys((key) => {
    if (ro || !t) return
    const col = ({ '1': 'p1', '2': 'p2', '3': 'p3', '4': 'p4', d: 'done' } as const)[key as '1']
    if (!col || col === t.col) return
    save({ col })
    return true
  }, true)

  if (!t) return <Modal onClose={props.onClose}>{error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}</Modal>

  return (
    <Modal onClose={props.onClose} wide>
      <div className="ticket">
        {ro ? (
          <h2>{t.title}</h2>
        ) : (
          <input className="title-input" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => title.trim() && title !== t.title && save({ title })} />
        )}
        <div className="row">
          {ro ? (
            <span className="pill">{t.archivedAt ? `Archived ${new Date(t.archivedAt).toLocaleDateString('en-GB')}` : COLUMN_NAMES[t.col]}</span>
          ) : (
            <select value={t.col} onChange={(e) => save({ col: e.target.value })}>
              {COLUMNS.map((c) => (
                <option key={c} value={c}>
                  {COLUMN_NAMES[c]}
                </option>
              ))}
            </select>
          )}
          <div className="labels">
            {props.labels
              .filter((l) => t.labels.includes(l.id))
              .map((l) =>
                ro ? (
                  <span key={l.id} className="label" style={{ background: l.color }}>
                    {l.name}
                  </span>
                ) : (
                  <button key={l.id} className="label" style={{ background: l.color }} title={`Remove ${l.name}`} onClick={() => save({ labels: t.labels.filter((x) => x !== l.id) })}>
                    {l.name} <span className="x">×</span>
                  </button>
                ),
              )}
            {!ro && props.labels.some((l) => !t.labels.includes(l.id)) && (
              <span className="label-picker">
                <select aria-label="Add a label" value="" onChange={(e) => e.target.value && save({ labels: [...t.labels, Number(e.target.value)] })}>
                  <option value="">Add a label</option>
                  {props.labels
                    .filter((l) => !t.labels.includes(l.id))
                    .map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                </select>
              </span>
            )}
            {!ro && (
              <form
                className="label-picker"
                onSubmit={async (e) => {
                  e.preventDefault()
                  if (!newLabel.trim()) return
                  const l = await api.post<Label>('/api/labels', { name: newLabel.trim() })
                  props.onLabelsChange([...props.labels.filter((x) => x.id !== l.id), l].sort((a, b) => a.name.localeCompare(b.name)))
                  await save({ labels: [...t.labels, l.id] })
                  setNewLabel('')
                }}
              >
                <input aria-label="New label" placeholder="New label" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
              </form>
            )}
          </div>
        </div>
        {error && <p className="error">{error}</p>}
        <h3>Description</h3>
        {editingDesc && !ro ? (
          <div>
            <textarea rows={10} value={desc} onChange={(e) => setDesc(e.target.value)} autoFocus />
            <div className="row">
              <button
                className="primary"
                onClick={async () => {
                  await save({ description: desc })
                  setEditingDesc(false)
                }}
              >
                Save
              </button>
              <button
                onClick={() => {
                  setDesc(t.description)
                  setEditingDesc(false)
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className={`markdown ${ro ? '' : 'editable'}`} onClick={() => !ro && setEditingDesc(true)}>
            {t.description ? <div dangerouslySetInnerHTML={{ __html: renderMarkdown(t.description) }} /> : <p className="muted">{ro ? 'No description.' : 'Add a description…'}</p>}
          </div>
        )}
        <h3>Comments</h3>
        {t.commentList.map((c) => (
          <div key={c.id} className="comment">
            <div className="muted small">
              <strong>{c.userName}</strong> {new Date(c.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
            </div>
            <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(c.body) }} />
          </div>
        ))}
        {!ro && (
          <form
            onSubmit={async (e) => {
              e.preventDefault()
              if (!comment.trim()) return
              try {
                const d = await api.post<TicketDetail>(`/api/tickets/${props.id}/comments`, { body: comment })
                setT(d)
                props.onSaved(d)
                setComment('')
              } catch (err) {
                setError((err as Error).message)
              }
            }}
          >
            <textarea rows={3} placeholder="Write a comment…" value={comment} onChange={(e) => setComment(e.target.value)} />
            <button className="primary" type="submit">
              Comment
            </button>
          </form>
        )}
        <details className="history">
          <summary>History</summary>
          <ul>
            {t.history.map((h, i) => (
              <li key={i}>
                <span className="muted">{new Date(h.at).toLocaleString('en-GB')}</span> {h.userName ?? 'planner'} {(HISTORY[h.kind] ?? (() => h.kind))(h.payload)}
              </li>
            ))}
          </ul>
        </details>
      </div>
    </Modal>
  )
}
