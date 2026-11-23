import { useCallback, useEffect, useState } from 'react'
import type { Me } from '../shared/types.ts'
import { api, ApiError } from './api.ts'
import { Archive } from './Archive.tsx'
import { Board } from './Board.tsx'
import { CalendarView } from './CalendarView.tsx'
import { Projects } from './Projects.tsx'
import { Reports } from './Reports.tsx'
import { Settings } from './Settings.tsx'

function useHash(): string {
  const [hash, setHash] = useState(location.hash.slice(1) || '/board')
  useEffect(() => {
    const on = () => setHash(location.hash.slice(1) || '/board')
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  return hash
}

const TABS = [
  ['/board', 'Board'],
  ['/calendar', 'Calendar'],
  ['/projects', 'Projects'],
  ['/reports', 'Reports'],
  ['/archive', 'Archive'],
  ['/settings', 'Settings'],
] as const

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined)
  const [loadError, setLoadError] = useState('')
  const hash = useHash()
  const reload = useCallback(() => {
    api
      .get<Me>('/api/me')
      .then(setMe)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) setMe(null)
        else setLoadError(String(err.message ?? err))
      })
  }, [])
  useEffect(reload, [reload])

  if (loadError) return <div className="login"><p className="error">{loadError}</p></div>
  if (me === undefined) return <div className="login"><p className="muted">Loading…</p></div>
  if (me === null) return <Login />

  const [, page, arg] = hash.split('/')
  const revoked = me.accounts.filter((a) => a.status !== 'ok')
  return (
    <div className="app">
      <header className="top">
        <span className="brand">planner</span>
        <nav>
          {TABS.map(([href, name]) => (
            <a key={href} href={`#${href}`} className={`/${page}` === href ? 'active' : ''}>
              {name}
            </a>
          ))}
        </nav>
        <span className="who">
          {me.name}
          <button
            className="link"
            onClick={async () => {
              await api.post('/api/logout')
              setMe(null)
            }}
          >
            Log out
          </button>
        </span>
      </header>
      {revoked.length > 0 && (
        <div className="banner">
          Google access for {revoked.map((a) => a.email).join(', ')} has expired. <a href="#/settings">Reconnect it in Settings</a>.
        </div>
      )}
      <main>
        {page === 'board' && <Board me={me} ownerId={arg ? Number(arg) : me.id} />}
        {page === 'archive' && <Archive me={me} ownerId={arg ? Number(arg) : me.id} />}
        {page === 'calendar' && <CalendarView me={me} />}
        {page === 'projects' && <Projects />}
        {page === 'reports' && <Reports />}
        {page === 'settings' && <Settings me={me} onChange={reload} />}
      </main>
    </div>
  )
}

function Login() {
  const error = new URLSearchParams(location.search).get('error')
  return (
    <div className="login">
      <h1>planner</h1>
      <p className="muted">Todo board, calendar and time bookkeeping.</p>
      {error && <p className="error">{error}</p>}
      <a className="button primary" href="/auth/google">
        Sign in with Google
      </a>
    </div>
  )
}
