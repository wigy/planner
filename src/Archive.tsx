import { useEffect, useState } from 'react'
import type { Label, Me, Ticket } from '../shared/types.ts'
import { api } from './api.ts'
import { TicketModal } from './TicketModal.tsx'

export function Archive({ me, ownerId }: { me: Me; ownerId: number }) {
  const readOnly = ownerId !== me.id
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState<{ tickets: Ticket[]; total: number }>({ tickets: [], total: 0 })
  const [labels, setLabels] = useState<Label[]>([])
  const [open, setOpen] = useState<number | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const t = setTimeout(() => {
      api.get<{ tickets: Ticket[]; total: number }>(`/api/users/${ownerId}/archive?q=${encodeURIComponent(q)}&offset=${offset}`).then(setData, (e) => setError(e.message))
    }, 200)
    return () => clearTimeout(t)
  }, [ownerId, q, offset])
  useEffect(() => {
    api.get<Label[]>(`/api/users/${ownerId}/labels`).then(setLabels)
  }, [ownerId])
  const labelById = new Map(labels.map((l) => [l.id, l]))

  return (
    <div className="page">
      <div className="toolbar">
        <h1>Archive</h1>
        <select value={ownerId} onChange={(e) => (location.hash = Number(e.target.value) === me.id ? '#/archive' : `#/archive/${e.target.value}`)}>
          <option value={me.id}>My archive</option>
          {me.others.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}'s archive (read-only)
            </option>
          ))}
        </select>
        <input
          placeholder="Search title and description"
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setOffset(0)
          }}
        />
        <span className="muted">{data.total} cards</span>
        {error && <span className="error">{error}</span>}
      </div>
      <table className="list">
        <thead>
          <tr>
            <th>Archived</th>
            <th>Title</th>
            <th>Labels</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.tickets.map((t) => (
            <tr key={t.id}>
              <td className="nowrap muted">{t.archivedAt && new Date(t.archivedAt).toLocaleDateString('en-GB')}</td>
              <td>
                <button className="link" onClick={() => setOpen(t.id)}>
                  {t.title}
                </button>
              </td>
              <td>
                {t.labels.map((l) => {
                  const label = labelById.get(l)
                  return label ? <span key={l} className="label" style={{ background: label.color }}>{label.name}</span> : null
                })}
              </td>
              <td className="nowrap">
                {!readOnly && (
                  <button
                    onClick={async () => {
                      await api.post(`/api/tickets/${t.id}/restore`, { col: 'p2' })
                      setData((d) => ({ tickets: d.tickets.filter((x) => x.id !== t.id), total: d.total - 1 }))
                    }}
                  >
                    Restore to P2
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>
          ← Newer
        </button>
        <button disabled={offset + 100 >= data.total} onClick={() => setOffset(offset + 100)}>
          Older →
        </button>
      </div>
      {open !== null && <TicketModal id={open} readOnly labels={labels} onLabelsChange={setLabels} onClose={() => setOpen(null)} onSaved={() => {}} />}
    </div>
  )
}
