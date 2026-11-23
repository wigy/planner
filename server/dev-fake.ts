// PLANNER_FAKE_GOOGLE=1: run against an in-memory Google with a few sample
// events, so the calendar can be tried without OAuth credentials. Never in
// production: nothing here reaches Google, and it is all lost on restart.

import { type Db, get, run } from './db.ts'
import { FakeGoogle } from './fake-google.ts'

export function fakeGoogle(db: Db, email: string): FakeGoogle {
  const g = new FakeGoogle()
  const primary = email
  g.addCalendar(primary, { primary: true, summary: email, backgroundColor: '#039be5' })
  g.addCalendar('holidays', { summary: 'Holidays', accessRole: 'reader', backgroundColor: '#7cb342' })
  const monday = new Date()
  monday.setHours(0, 0, 0, 0)
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
  const at = (day: number, h: number, m = 0) => {
    const d = new Date(monday)
    d.setDate(d.getDate() + day)
    d.setHours(h, m)
    return { dateTime: d.toISOString(), timeZone: 'Europe/Helsinki' }
  }
  g.external(primary, { summary: 'Customer workshop', start: at(0, 10), end: at(0, 12), organizer: { email: 'someone@example.com' } })
  g.external(primary, { summary: 'Write ledger import #tasenor', start: at(1, 9), end: at(1, 11, 30), organizer: { self: true } })
  g.external(primary, { summary: 'Standup', start: at(0, 9), end: at(0, 9, 15), recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'], organizer: { self: true } })
  g.external(primary, { summary: 'Dentist', start: at(3, 14), end: at(3, 15), organizer: { self: true } })
  const d = new Date(monday)
  d.setDate(d.getDate() + 4)
  const day = d.toISOString().slice(0, 10)
  d.setDate(d.getDate() + 1)
  g.external('holidays', { summary: 'Some holiday', start: { date: day }, end: { date: d.toISOString().slice(0, 10) } })

  const user = get<{ id: number }>(db, 'SELECT id FROM users WHERE primary_email = ?', email)
  if (user && !get(db, 'SELECT 1 FROM google_accounts WHERE email = ?', email)) {
    run(db, 'INSERT INTO google_accounts (user_id, email) VALUES (?, ?)', user.id, email)
  }
  return g
}
