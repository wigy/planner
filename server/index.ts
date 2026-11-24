// HTTP server: a JSON API plus the built UI from dist/.
//
// Login:     GET  /auth/google[?link=1]      → Google consent (link=1 adds an account)
//            GET  /auth/google/callback
//            POST /api/logout, GET /api/me
// Board:     GET  /api/users/:id/board        (anyone logged in; the other board is read-only)
//            GET  /api/users/:id/archive?q=&offset=
//            GET  /api/users/:id/labels, POST /api/labels, PATCH|DELETE /api/labels/:id
//            POST /api/tickets, GET|PATCH /api/tickets/:id
//            POST /api/tickets/:id/comments, POST /api/tickets/:id/restore
// Calendar:  GET  /api/calendars, PATCH /api/calendars/:id {selected}
//            GET  /api/events?start=&end=, POST /api/events
//            PATCH|DELETE /api/events/:id     (occurrenceStart and scope for a series)
//            POST /api/events/:id/book {projectId|null}
//            POST /api/events/:id/send {projectId, mode, occurrenceStart?, minutes?}
//            POST /api/sync
//            GET  /api/exercises?from=&to=     (YYYY-MM-DD; the Exercises feed, 404 if none)
// Projects:  GET|POST /api/projects, PATCH /api/projects/:id, GET /api/hashtags/unknown
// Reports:   GET  /api/reports/:month?project=&step=&mode=&apply=[&format=csv]
//            GET  /api/reports/year/:year, PUT /api/locks/:month {locked}
//            GET  /api/hours?from=YYYY-MM-DD&to=YYYY-MM-DD (exact minutes per day)
// Google:    POST /google/push                (push notifications)

import { createHmac, randomBytes } from 'node:crypto'
import { createReadStream, mkdirSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { parseRounding } from '../shared/rounding.ts'
import type { Me } from '../shared/types.ts'
import { acceptTokens, accountsOf, allUsers, apiFactory, getUser } from './accounts.ts'
import { addComment, archiveDone, archivedTickets, boardTickets, createLabel, createTicket, deleteLabel, listLabels, restoreTicket, ticketDetail, updateLabel, updateTicket } from './board.ts'
import { bookEvent, calendarJson, createEvent, deleteEvent, occurrences, sendToBookkeeping, unknownHashtags, updateEvent, userCalendars } from './calendar.ts'
import { openDb, run } from './db.ts'
import { exerciseFeed, FeedError } from './exercises.ts'
import { Forbidden, Invalid, NotFound, statusOf, Unauthorized } from './errors.ts'
import { authUrl, exchangeCode, GoogleError, type OAuthConfig } from './google.ts'
import { fakeGoogle } from './dev-fake.ts'
import { makeNotifier } from './notify.ts'
import { autoBook } from './autobook.ts'
import { createProject, listProjects, updateProject } from './projects.ts'
import { checkMonth, dailyHours, report, reportCsv, setLock, yearSummary } from './reports.ts'
import { loadKey, signSession, signValue, verifySession, verifyValue } from './secrets.ts'
import { calendarOwner, type Ctx, ensureWatch, handlePush, syncAccount, syncAll } from './sync.ts'

const root = resolve(import.meta.dirname, '..')
const dataDir = resolve(process.env.PLANNER_DATA ?? join(root, 'data'))
mkdirSync(dataDir, { recursive: true })
const db = openDb(join(dataDir, 'planner.db'))
const dist = join(root, 'dist')
const port = Number(process.env.PORT ?? 8920)
const host = process.env.HOST ?? '0.0.0.0'
const publicUrl = (process.env.PLANNER_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, '')
const allowed = (process.env.PLANNER_ALLOWED_EMAILS ?? '').split(/[\s,]+/).filter(Boolean).map((e) => e.toLowerCase())
const pollMs = Number(process.env.PLANNER_POLL_SECONDS ?? 300) * 1000
const secret = loadKey(process.env.PLANNER_SECRET, dataDir, 'session-secret')
const tokenKey = loadKey(process.env.PLANNER_TOKEN_KEY, dataDir, 'token-key')
const oauth: OAuthConfig | null =
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, redirectUri: `${publicUrl}/auth/google/callback` }
    : null
const notify = makeNotifier(process.env.NOTIFY_URL)
const exercises = process.env.EXERCISE_FEED_URL ? exerciseFeed({ url: process.env.EXERCISE_FEED_URL, key: process.env.EXERCISE_FEED_KEY ?? '' }) : null
const fake = process.env.PLANNER_FAKE_GOOGLE ? fakeGoogle(db, process.env.PLANNER_FAKE_GOOGLE) : null
const ctx: Ctx = {
  db,
  notify,
  apiFor: fake ? () => fake : apiFactory(db, tokenKey, oauth),
  publicUrl,
  pushToken: createHmac('sha256', secret).update('google-push').digest('base64url'),
  afterSync: (calendarId) => {
    autoBook(ctx, calendarOwner(db, calendarId)).catch((err) => notify('info', `Automatic booking failed: ${String(err)}`))
  },
}

const MAX_BODY = 1024 * 1024
const COOKIE = 'planner_session'
const STATE_COOKIE = 'planner_oauth'
const SESSION_AGE = 90 * 24 * 3600

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

function redirect(res: ServerResponse, to: string, cookies: string[] = []) {
  res.writeHead(302, { location: to, 'cache-control': 'no-store', ...(cookies.length ? { 'set-cookie': cookies } : {}) })
  res.end()
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Invalid('body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error()
    return v
  } catch {
    throw new Invalid('body is not a JSON object')
  }
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return undefined
}

function setCookie(name: string, value: string, maxAge: number): string {
  const secure = publicUrl.startsWith('https://') ? '; Secure' : ''
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
}

function me(req: IncomingMessage): number {
  const token = cookie(req, COOKIE)
  const id = token ? verifySession(secret, token, SESSION_AGE * 1000) : null
  if (!id || !getUser(db, id)) throw new Unauthorized('not logged in')
  return id
}

/** Writes need a same-origin JSON request: with SameSite=Lax this closes CSRF. */
function checkWrite(req: IncomingMessage) {
  if (req.method === 'GET') return
  if (!(req.headers['content-type'] ?? '').startsWith('application/json') && req.headers['content-length'] !== '0' && req.headers['content-length'] !== undefined) {
    throw new Invalid('send application/json')
  }
  const origin = req.headers.origin
  if (origin && origin !== publicUrl && !/^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/.test(origin)) {
    throw new Forbidden('cross-origin request')
  }
}

function int(v: string | undefined): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new NotFound()
  return n
}

function optString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

async function auth(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (url.pathname === '/auth/google') {
    if (!oauth) return json(res, 503, { error: 'Google sign-in is not configured on this server' })
    let link = ''
    if (url.searchParams.get('link') === '1') link = String(me(req))
    const nonce = randomBytes(16).toString('base64url')
    const state = signValue(secret, `${nonce}:${link}`)
    return redirect(res, authUrl(oauth, nonce, optString(url.searchParams.get('hint') ?? undefined)), [setCookie(STATE_COOKIE, state, 600)])
  }
  if (url.pathname === '/auth/google/callback') {
    if (!oauth) return json(res, 503, { error: 'Google sign-in is not configured on this server' })
    const stored = cookie(req, STATE_COOKIE)
    const value = stored ? verifyValue(secret, stored) : null
    const [nonce, link] = (value ?? '').split(':')
    const clear = setCookie(STATE_COOKIE, '', 0)
    if (!value || nonce !== url.searchParams.get('state')) return redirect(res, '/?error=' + encodeURIComponent('sign-in expired, try again'), [clear])
    const code = url.searchParams.get('code')
    if (!code) return redirect(res, '/?error=' + encodeURIComponent(url.searchParams.get('error') ?? 'no code from Google'), [clear])
    try {
      const tokens = await exchangeCode(oauth, code)
      const linkTo = link ? Number(link) : undefined
      if (linkTo !== undefined) me(req) // still logged in as the same user
      const { user, accountId, isNewAccount } = acceptTokens(db, tokenKey, tokens, allowed, linkTo)
      notify('info', `${user.email} ${linkTo ? 'linked a Google account' : 'logged in'}${isNewAccount ? ' (new account)' : ''}.`, 'Login')
      syncAccount(ctx, accountId).catch((err) => notify('info', `First sync after login failed: ${String(err)}`))
      const cookies = [clear]
      if (!linkTo) cookies.push(setCookie(COOKIE, signSession(secret, user.id), SESSION_AGE))
      return redirect(res, linkTo ? '/#/settings' : '/', cookies)
    } catch (err) {
      const message = err instanceof Forbidden ? err.message : `sign-in failed: ${String(err instanceof Error ? err.message : err)}`
      notify(err instanceof Forbidden ? 'warning' : 'info', message, 'Login refused')
      return redirect(res, '/?error=' + encodeURIComponent(message), [clear])
    }
  }
  throw new NotFound()
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
  const path = url.pathname
  const method = req.method ?? 'GET'
  checkWrite(req)
  if (path === '/api/logout' && method === 'POST') return json(res, 200, { ok: true }, { 'set-cookie': setCookie(COOKIE, '', 0) })
  const userId = me(req)
  const seg = path.split('/').slice(2) // after /api/

  if (path === '/api/me' && method === 'GET') {
    const user = getUser(db, userId)!
    const out: Me = { ...user, accounts: accountsOf(db, userId), others: allUsers(db).filter((u) => u.id !== userId), googleConfigured: !!oauth, exercisesConfigured: !!exercises }
    return json(res, 200, out)
  }

  // ---- board
  if (seg[0] === 'users' && seg.length === 3) {
    const owner = int(seg[1])
    if (!getUser(db, owner)) throw new NotFound()
    if (seg[2] === 'board' && method === 'GET') return json(res, 200, boardTickets(db, owner))
    if (seg[2] === 'labels' && method === 'GET') return json(res, 200, listLabels(db, owner))
    if (seg[2] === 'archive' && method === 'GET') {
      return json(res, 200, archivedTickets(db, owner, url.searchParams.get('q') ?? '', 100, Number(url.searchParams.get('offset') ?? 0) || 0))
    }
  }
  if (path === '/api/labels' && method === 'POST') return json(res, 200, createLabel(db, userId, await body(req)))
  if (seg[0] === 'labels' && seg.length === 2) {
    if (method === 'PATCH') return json(res, 200, updateLabel(db, userId, int(seg[1]), await body(req)))
    if (method === 'DELETE') {
      deleteLabel(db, userId, int(seg[1]))
      return json(res, 200, { ok: true })
    }
  }
  if (path === '/api/tickets' && method === 'POST') return json(res, 200, createTicket(db, userId, await body(req)))
  if (seg[0] === 'tickets' && seg.length >= 2) {
    const id = int(seg[1])
    if (seg.length === 2 && method === 'GET') return json(res, 200, ticketDetail(db, id))
    if (seg.length === 2 && method === 'PATCH') return json(res, 200, updateTicket(db, userId, id, await body(req)))
    if (seg[2] === 'comments' && method === 'POST') {
      addComment(db, userId, id, (await body(req)).body)
      return json(res, 200, ticketDetail(db, id))
    }
    if (seg[2] === 'restore' && method === 'POST') return json(res, 200, restoreTicket(db, userId, id, (await body(req)).col ?? 'p2'))
  }

  // ---- calendar
  if (path === '/api/calendars' && method === 'GET') return json(res, 200, userCalendars(db, userId).map(calendarJson))
  if (seg[0] === 'calendars' && seg.length === 2 && method === 'PATCH') {
    const id = int(seg[1])
    const cal = userCalendars(db, userId).find((c) => c.id === id)
    if (!cal) throw new NotFound()
    const b = await body(req)
    if (typeof b.selected === 'boolean') run(db, 'UPDATE calendars SET selected = ? WHERE id = ?', b.selected ? 1 : 0, id)
    return json(res, 200, calendarJson(userCalendars(db, userId).find((c) => c.id === id)!))
  }
  if (path === '/api/events' && method === 'GET') {
    const from = new Date(url.searchParams.get('start') ?? '')
    const to = new Date(url.searchParams.get('end') ?? '')
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) throw new Invalid('start and end required')
    if (to.getTime() - from.getTime() > 400 * 86400_000) throw new Invalid('range too long')
    return json(res, 200, occurrences(db, userId, from, to, url.searchParams.get('all') !== '1'))
  }
  if (path === '/api/events' && method === 'POST') {
    const b = await body(req)
    const id = await createEvent(ctx, userId, {
      calendarId: Number(b.calendarId),
      title: String(b.title ?? ''),
      description: optString(b.description),
      location: optString(b.location),
      projectId: b.projectId == null ? null : Number(b.projectId),
      start: String(b.start ?? ''),
      end: String(b.end ?? ''),
      allDay: b.allDay === true,
    })
    return json(res, 200, { id })
  }
  if (seg[0] === 'events' && seg.length >= 2) {
    const id = int(seg[1])
    if (seg.length === 2 && method === 'PATCH') {
      const b = await body(req)
      const time = b.time as { start?: unknown; end?: unknown; allDay?: unknown } | undefined
      await updateEvent(ctx, userId, id, {
        title: optString(b.title),
        description: optString(b.description),
        location: optString(b.location),
        time: time ? { start: String(time.start), end: String(time.end), allDay: time.allDay === true } : undefined,
        occurrenceStart: optString(b.occurrenceStart),
        scope: b.scope === 'series' ? 'series' : b.scope === 'instance' ? 'instance' : undefined,
      })
      return json(res, 200, { ok: true })
    }
    if (seg.length === 2 && method === 'DELETE') {
      await deleteEvent(ctx, userId, id, url.searchParams.get('occurrenceStart') ?? undefined, url.searchParams.get('scope') === 'series' ? 'series' : 'instance')
      return json(res, 200, { ok: true })
    }
    if (seg[2] === 'book' && method === 'POST') {
      const b = await body(req)
      await bookEvent(ctx, userId, id, b.projectId == null ? null : Number(b.projectId), optString(b.occurrenceStart))
      return json(res, 200, { ok: true })
    }
    if (seg[2] === 'send' && method === 'POST') {
      const b = await body(req)
      const newId = await sendToBookkeeping(ctx, userId, id, {
        projectId: Number(b.projectId),
        mode: b.mode === 'move' ? 'move' : 'copy',
        occurrenceStart: optString(b.occurrenceStart),
        minutes: typeof b.minutes === 'number' ? b.minutes : undefined,
      })
      return json(res, 200, { id: newId })
    }
  }
  if (path === '/api/exercises' && method === 'GET') {
    if (!exercises) throw new NotFound()
    const from = url.searchParams.get('from') ?? ''
    const to = url.searchParams.get('to') ?? ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to <= from) throw new Invalid('from and to required')
    return json(res, 200, await exercises(getUser(db, userId)!.email, from, to))
  }
  if (path === '/api/sync' && method === 'POST') {
    for (const a of accountsOf(db, userId)) await syncAccount(ctx, a.id)
    return json(res, 200, { ok: true })
  }

  // ---- projects
  if (path === '/api/projects' && method === 'GET') return json(res, 200, listProjects(db, userId))
  if (path === '/api/projects' && method === 'POST') {
    const project = createProject(db, userId, await body(req))
    // Existing events with the new hashtag are booked in the background.
    autoBook(ctx, userId).catch((err) => notify('info', `Automatic booking failed: ${String(err)}`))
    return json(res, 200, project)
  }
  if (seg[0] === 'projects' && seg.length === 2 && method === 'PATCH') {
    const result = await updateProject(ctx, userId, int(seg[1]), await body(req))
    autoBook(ctx, userId).catch((err) => notify('info', `Automatic booking failed: ${String(err)}`))
    return json(res, 200, result)
  }
  if (path === '/api/hashtags/unknown' && method === 'GET') return json(res, 200, unknownHashtags(db, userId))

  // ---- reports
  if (path === '/api/hours' && method === 'GET') return json(res, 200, dailyHours(db, userId, url.searchParams.get('from'), url.searchParams.get('to')))
  if (seg[0] === 'reports' && seg[1] === 'year' && seg.length === 3 && method === 'GET') {
    const year = Number(seg[2])
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Invalid('bad year')
    return json(res, 200, yearSummary(db, userId, year))
  }
  if (seg[0] === 'reports' && seg.length === 2 && method === 'GET') {
    const month = checkMonth(seg[1])
    const project = url.searchParams.get('project') ? Number(url.searchParams.get('project')) : undefined
    const r = report(db, userId, month, parseRounding(url.searchParams), project)
    if (url.searchParams.get('format') === 'csv') {
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="hours-${month}${project ? '-' + (r.projects[0]?.hashtag ?? project) : ''}.csv"`,
        'cache-control': 'no-store',
      })
      return res.end(reportCsv(r))
    }
    return json(res, 200, r)
  }
  if (seg[0] === 'locks' && seg.length === 2 && method === 'PUT') {
    const month = checkMonth(seg[1])
    const locked = (await body(req)).locked === true
    setLock(db, userId, month, locked)
    notify('info', `${getUser(db, userId)!.email} ${locked ? 'locked' : 'unlocked'} ${month}.`, 'Bookkeeping month lock')
    return json(res, 200, { month, locked })
  }
  throw new NotFound()
}

async function file(res: ServerResponse, path: string) {
  const safe = normalize(path).replace(/^(\.\.[/\\])+/, '')
  let full = join(dist, safe)
  let info = await stat(full).catch(() => null)
  if (!info?.isFile()) {
    full = join(dist, 'index.html')
    info = await stat(full).catch(() => null)
    if (!info) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      return res.end('UI not built: run npm run build')
    }
  }
  const immutable = full.includes(`${join(dist, 'assets')}`)
  res.writeHead(200, {
    'content-type': types[extname(full)] ?? 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  createReadStream(full).pipe(res)
}

/** The request URL, or null for one that does not parse (scanners send those). */
export function parseUrl(raw: string | undefined): URL | null {
  try {
    // Only the path and query matter; a leading // would otherwise read as a host.
    return new URL((raw ?? '/').replace(/^\/+/, '/'), 'http://local')
  } catch {
    return null
  }
}

const server = createServer(async (req, res) => {
  const url = parseUrl(req.url)
  if (!url) {
    res.writeHead(400, { 'content-type': 'text/plain' })
    return res.end('bad request')
  }
  try {
    if (url.pathname === '/google/push' && req.method === 'POST') {
      handlePush(ctx, String(req.headers['x-goog-channel-id'] ?? ''), req.headers['x-goog-channel-token'] as string | undefined, req.headers['x-goog-resource-state'] as string | undefined)
      res.writeHead(200)
      return res.end()
    }
    if (url.pathname === '/health') return json(res, 200, { ok: true, google: !!oauth })
    if (url.pathname.startsWith('/auth/')) return await auth(req, res, url)
    if (url.pathname.startsWith('/api/')) return await api(req, res, url)
    return await file(res, url.pathname)
  } catch (err) {
    let status = statusOf(err)
    let message = err instanceof Error ? err.message : String(err)
    if (err instanceof GoogleError) {
      status = 502
      message = `Google: ${err.message}`
    }
    if (err instanceof FeedError) status = 502
    if (status === 500 || status === 502) console.error(new Date().toISOString(), req.method, url.pathname, err)
    if (!res.headersSent) json(res, status, { error: message || res.statusMessage })
    else res.end()
  }
})

// ---- background jobs

let polling = false
async function poll() {
  if (polling || (!oauth && !fake)) return
  polling = true
  try {
    await syncAll(ctx)
  } catch (err) {
    notify('info', `Poll failed: ${String(err)}`)
  } finally {
    polling = false
  }
}

function hourly() {
  try {
    archiveDone(db, notify)
  } catch (err) {
    notify('error', `Archive job failed: ${String(err)}`, 'Board cleanup failed')
  }
  for (const c of db.prepare('SELECT id FROM calendars').all() as { id: number }[]) {
    ensureWatch(ctx, c.id).catch(() => {})
  }
}

server.listen(port, host, () => {
  console.log(new Date().toISOString(), `planner on http://${host}:${port}, public ${publicUrl}, Google ${oauth ? 'configured' : 'NOT configured'}, ${allowed.length} allowed addresses`)
  notify('debug', 'planner started.')
  hourly()
  setInterval(hourly, 3600_000)
  setTimeout(poll, 5000)
  setInterval(poll, pollMs)
})

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    server.close()
    db.close()
    process.exit(0)
  })
}

