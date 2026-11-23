import { useEffect, useState } from 'react'
import { formatHours } from '../shared/rounding.ts'
import type { MonthSummary, Project, Report } from '../shared/types.ts'
import { api } from './api.ts'

function thisMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const time = (iso: string) => (iso.length === 10 ? 'all day' : new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Helsinki' }))

export function Reports() {
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
            {report.locked ? `Unlock ${month}` : `Lock ${month}`}
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {report && (
        <div className="report">
          <h2>
            Hours {report.month}
            {project && ` — ${projects.find((p) => String(p.id) === project)?.title}`} {report.locked && <span className="pill">locked</span>}
          </h2>
          <p className="muted small">Rounding: {report.rounding}. Times in Europe/Helsinki; events crossing a month boundary are split.</p>
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
                {p.title} <span className="muted">#{p.hashtag}</span> <span className="right">{formatHours(p.minutes)} h</span>
              </h3>
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
                      <td className="nowrap">{e.date}</td>
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
          {report.projects.length === 0 && <p className="muted">Nothing booked this month.</p>}
          <p className="total">
            Total <strong>{formatHours(report.totalMinutes)} h</strong>
          </p>
        </div>
      )}
      <div className="no-print">
        <h2>{month.slice(0, 4)} by month (exact)</h2>
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
                    {m.month}
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
