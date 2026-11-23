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

/** ISO 8601 week number: Finnish calendars count weeks this way. */
function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7))
  return Math.ceil((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400_000 / 7 + 1 / 7)
}

function useToday(): Date {
  const [today, setToday] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setToday(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])
  return today
}

/** Today's date, set like the corner of a pocket diary page. */
function DateStamp({ large }: { large?: boolean }) {
  const d = useToday()
  const Tag = large ? 'div' : 'a'
  return (
    <Tag className={`stamp ${large ? 'large' : ''}`} {...(large ? {} : { href: '#/calendar', 'aria-label': `Today, ${d.toLocaleDateString('en-GB', { dateStyle: 'full' })}. Open the calendar.` })}>
      <span className="stamp-day">{d.getDate()}</span>
      <span className="stamp-text">
        <span className="stamp-weekday">{d.toLocaleDateString('en-GB', { weekday: 'long' })}</span>
        <span className="stamp-month">
          {d.toLocaleDateString('en-GB', { month: 'long' })}, week {isoWeek(d)}
        </span>
      </span>
    </Tag>
  )
}

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
        <DateStamp />
        <nav aria-label="Sections">
          {TABS.map(([href, name]) => (
            <a key={href} href={`#${href}`} className={`/${page}` === href ? 'active' : ''}>
              {name}
            </a>
          ))}
        </nav>
        <span className="who">
          <span className="avatar" aria-hidden="true">
            {me.name.slice(0, 1).toUpperCase()}
          </span>
          <span className="who-name">{me.name}</span>
          <button
            className="quiet"
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
      <main className={`page-${page}`}>
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
      <div className="login-sheet">
        <DateStamp large />
        <h1>planner</h1>
        <p>Your board, your calendars and the hours you bill, in one place.</p>
        {error && <p className="error">{error}</p>}
        <a className="button primary" href="/auth/google">
          Sign in with Google
        </a>
        <p className="muted small">Signing in also connects your Google Calendar.</p>
      </div>
    </div>
  )
}
