import { useEffect, useState } from 'react'
import { formatHours } from '../shared/rounding.ts'
import type { Me, MonthSummary, Project, Report } from '../shared/types.ts'
import { api } from './api.ts'

function thisMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const monthName = (month: string) => new Date(`${month}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })

const dayName = (date: string) => new Date(`${date.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })

const time = (iso: string) => (iso.length === 10 ? 'all day' : new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Helsinki' }))

const euros = (n: number) => n.toLocaleString('en-GB', { style: 'currency', currency: 'EUR' })

/** What the hours are worth at the project's rate; null without a rate. */
const amount = (minutes: number, rate: number | null) => (rate === null ? null : Math.round((minutes / 60) * rate * 100) / 100)

export function Reports({ me }: { me: Me }) {
  const [month, setMonth] = useState(thisMonth())
  const [project, setProject] = useState('')
  const [step, setStep] = useState('0')
  const [mode, setMode] = useState('nearest')
  const [apply, setApply] = useState('entry')
  const [projects, setProjects] = useState<Project[]>([])
  const [report, setReport] = useState<Report | null>(null)
  const [year, setYear] = useState<MonthSummary[]>([])
  const [error, setError] = useState('')
  const q = new URLSearchParams({ step, mode, apply, ...(project ? { project } : {}) })

  useEffect(() => {
    api.get<Project[]>('/api/projects').then(setProjects)
  }, [])
  const load = () => api.get<Report>(`/api/reports/${month}?${q}`).then((r) => (setReport(r), setError('')), (e) => setError(e.message))
  useEffect(() => {
    load()
  }, [month, project, step, mode, apply])
  useEffect(() => {
    api.get<MonthSummary[]>(`/api/reports/year/${month.slice(0, 4)}`).then(setYear)
  }, [month.slice(0, 4)])

  const priced = report?.projects.filter((p) => p.rate !== null) ?? []
  const total = priced.length ? priced.reduce((sum, p) => sum + amount(p.minutes, p.rate)!, 0) : null

  const yearProjects = projects.filter((p) => year.some((m) => m.byProject[p.id]))

  return (
    <div className="page report-page">
      <div className="toolbar no-print">
        <h1>Reports</h1>
        <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        <select value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
        <label className="inline">
          Rounding
          <select value={step} onChange={(e) => setStep(e.target.value)}>
            <option value="0">exact</option>
            <option value="15">15 min</option>
            <option value="30">30 min</option>
            <option value="60">1 hour</option>
          </select>
        </label>
        {step !== '0' && (
          <>
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="nearest">to nearest</option>
              <option value="up">up</option>
              <option value="down">down</option>
            </select>
            <select value={apply} onChange={(e) => setApply(e.target.value)}>
              <option value="entry">per entry</option>
              <option value="total">on the total</option>
            </select>
          </>
        )}
        <a className="button" href={`/api/reports/${month}?${q}&format=csv`}>
          CSV
        </a>
        <button onClick={() => print()}>Print / PDF</button>
        {report && (
          <button
            onClick={async () => {
              await api.put(`/api/locks/${month}`, { locked: !report.locked })
              load()
            }}
          >
            {report.locked ? `Unlock ${monthName(month)}` : `Lock ${monthName(month)}`}
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {report && (
        <div className="report">
          <div className="print-only print-head">
            <div>
              <strong>{me.name}</strong>
              <div>{me.email}</div>
            </div>
            <div className="print-meta">
              <div>Hours for {monthName(report.month)}</div>
              <div>Printed {new Date().toLocaleDateString('en-GB', { dateStyle: 'long' })}</div>
            </div>
          </div>
          <header className="report-head">
            <div>
              <h2>
                {monthName(report.month)}
                {project && <span className="report-project">{projects.find((p) => String(p.id) === project)?.title}</span>}
                {report.locked && <span className="pill">locked</span>}
              </h2>
              <p className="muted small">Rounding: {report.rounding}. Finnish time; an event that crosses into the next month is split between the two.</p>
            </div>
            <p className="report-total">
              <span className="figure">{formatHours(report.totalMinutes)}</span> hours
              {total !== null && <span className="report-euros">{euros(total)}</span>}
            </p>
          </header>
          {report.problems.length > 0 && (
            <div className="warning no-print">
              <strong>Not counted:</strong>
              <ul>
                {report.problems.map((p, i) => (
                  <li key={i}>
                    {p.start.slice(0, 10)} “{p.title}”: {p.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {report.projects.map((p) => (
            <section key={p.projectId}>
              <h3>
                {p.title} <span className="muted">#{p.hashtag}</span>
                <span className="right">
                  {formatHours(p.minutes)} h{amount(p.minutes, p.rate) !== null && <span className="muted"> {euros(amount(p.minutes, p.rate)!)}</span>}
                </span>
              </h3>
              {(p.customer || p.rate !== null) && (
                <p className="project-terms">
                  {p.customer && <>For {p.customer}</>}
                  {p.customer && p.rate !== null && ', '}
                  {p.rate !== null && <>{euros(p.rate)} an hour</>}
                </p>
              )}
              <table className="list">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Time</th>
                    <th>Title</th>
                    <th className="num">Hours</th>
                  </tr>
                </thead>
                <tbody>
                  {p.entries.map((e, i) => (
                    <tr key={i}>
                      <td className="nowrap">{dayName(e.date)}</td>
                      <td className="nowrap">
                        {time(e.start)}
                        {e.start.length > 10 && `–${time(e.end)}`}
                      </td>
                      <td>
                        {e.title}
                        {e.text && <div className="entry-text">{e.text}</div>}
                      </td>
                      <td className="num">
                        {formatHours(e.rounded)}
                        {e.rounded !== e.minutes && <span className="muted small"> ({formatHours(e.minutes)})</span>}
                      </td>
                    </tr>
                  ))}
                  {p.entries.length === 0 && (
                    <tr>
                      <td colSpan={4} className="muted">
                        Nothing booked this month.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </section>
          ))}
          {report.projects.length === 0 && <p className="empty">No hours booked in {monthName(report.month)}. Add a project hashtag to an event to book it.</p>}
        </div>
      )}
      <div className="no-print">
        <h2 className="year-head">{month.slice(0, 4)} month by month, exact hours</h2>
        <table className="list">
          <thead>
            <tr>
              <th>Month</th>
              {yearProjects.map((p) => (
                <th key={p.id} className="num">
                  #{p.hashtag}
                </th>
              ))}
              <th className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {year.map((m) => (
              <tr key={m.month} className={m.month === month ? 'current' : ''}>
                <td>
                  <button className="link" onClick={() => setMonth(m.month)}>
                    {new Date(`${m.month}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long' })}
                  </button>
                </td>
                {yearProjects.map((p) => (
                  <td key={p.id} className="num">
                    {m.byProject[p.id] ? formatHours(m.byProject[p.id]) : ''}
                  </td>
                ))}
                <td className="num">{m.totalMinutes ? formatHours(m.totalMinutes) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
