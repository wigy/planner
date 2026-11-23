import { useEffect, useState } from 'react'
import type { Label, Me } from '../shared/types.ts'
import { api } from './api.ts'

export function Settings({ me, onChange }: { me: Me; onChange: () => void }) {
  const [labels, setLabels] = useState<Label[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    api.get<Label[]>(`/api/users/${me.id}/labels`).then(setLabels)
  }, [me.id])

  return (
    <div className="page">
      <h1>Settings</h1>
      <h2>Google accounts</h2>
      {!me.googleConfigured && <p className="error">Google sign-in is not configured on the server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).</p>}
      <table className="list">
        <tbody>
          {me.accounts.map((a) => (
            <tr key={a.id}>
              <td>{a.email}</td>
              <td>{a.status === 'ok' ? <span className="pill">connected</span> : <span className="pill bad">expired</span>}</td>
              <td>
                {a.status !== 'ok' && (
                  <a className="button" href={a.email === me.email ? `/auth/google?hint=${encodeURIComponent(a.email)}` : `/auth/google?link=1&hint=${encodeURIComponent(a.email)}`}>
                    Reconnect
                  </a>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <a className="button" href="/auth/google?link=1">
          Link another Google account
        </a>{' '}
        <span className="muted small">Its calendars are synced too, and can be hidden in the calendar view.</span>
      </p>

      <h2>Labels</h2>
      {error && <p className="error">{error}</p>}
      <table className="list">
        <tbody>
          {labels.map((l) => (
            <tr key={l.id}>
              <td>
                <input
                  type="color"
                  value={l.color}
                  onChange={async (e) => {
                    const u = await api.patch<Label>(`/api/labels/${l.id}`, { color: e.target.value })
                    setLabels((ls) => ls.map((x) => (x.id === l.id ? u : x)))
                  }}
                />
              </td>
              <td>
                <input
                  defaultValue={l.name}
                  onBlur={async (e) => {
                    if (e.target.value.trim() && e.target.value !== l.name) {
                      try {
                        const u = await api.patch<Label>(`/api/labels/${l.id}`, { name: e.target.value })
                        setLabels((ls) => ls.map((x) => (x.id === l.id ? u : x)))
                      } catch (err) {
                        setError((err as Error).message)
                      }
                    }
                  }}
                />
              </td>
              <td>
                <button
                  className="danger"
                  onClick={async () => {
                    if (!confirm(`Delete label "${l.name}"? It is removed from every card.`)) return
                    await api.del(`/api/labels/${l.id}`)
                    setLabels((ls) => ls.filter((x) => x.id !== l.id))
                  }}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        Signed in as {me.email}. <button className="link" onClick={onChange}>Refresh</button>
      </p>
    </div>
  )
}
