// Google OAuth and the Calendar REST API, over plain fetch.
//
// CalendarApi is the interface the sync and calendar code use; tests give them a
// fake. GoogleCalendarApi is the real one, for one linked account.

export class GoneError extends Error {} // 410: the sync token has expired
export class PreconditionFailed extends Error {} // 412: the etag no longer matches
export class GoogleAuthError extends Error {} // refresh token revoked or expired
export class GoogleError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export type GEventTime = { date?: string; dateTime?: string; timeZone?: string }

export type GEvent = {
  id: string
  etag?: string
  status?: string
  summary?: string
  description?: string
  location?: string
  start?: GEventTime
  end?: GEventTime
  recurrence?: string[]
  recurringEventId?: string
  originalStartTime?: GEventTime
  organizer?: { email?: string; self?: boolean }
  creator?: { email?: string; self?: boolean }
  attendees?: unknown[]
  updated?: string
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> }
  colorId?: string
  [key: string]: unknown
}

export type GCalendar = {
  id: string
  summary?: string
  summaryOverride?: string
  backgroundColor?: string
  accessRole?: string
  primary?: boolean
  deleted?: boolean
  timeZone?: string
}

export type EventPage = { items: GEvent[]; nextPageToken?: string; nextSyncToken?: string }

export interface CalendarApi {
  listCalendars(): Promise<GCalendar[]>
  insertCalendar(summary: string, timeZone: string): Promise<GCalendar>
  listEvents(calendarId: string, opts: { syncToken?: string; pageToken?: string }): Promise<EventPage>
  getEvent(calendarId: string, eventId: string): Promise<GEvent>
  instances(calendarId: string, eventId: string, timeMin: string, timeMax: string): Promise<GEvent[]>
  insertEvent(calendarId: string, event: Partial<GEvent>): Promise<GEvent>
  patchEvent(calendarId: string, eventId: string, patch: Partial<GEvent>, etag?: string): Promise<GEvent>
  deleteEvent(calendarId: string, eventId: string, etag?: string): Promise<void>
  moveEvent(calendarId: string, eventId: string, destination: string): Promise<GEvent>
  watch(calendarId: string, channelId: string, address: string, token: string): Promise<{ resourceId: string; expiration: string }>
  stopChannel(channelId: string, resourceId: string): Promise<void>
}

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API = 'https://www.googleapis.com/calendar/v3'
export const SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/calendar']

export type OAuthConfig = { clientId: string; clientSecret: string; redirectUri: string }

export function authUrl(cfg: OAuthConfig, state: string, loginHint?: string): string {
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  })
  if (loginHint) q.set('login_hint', loginHint)
  return `${AUTH_URL}?${q}`
}

export type TokenReply = {
  access_token: string
  expires_in: number
  refresh_token?: string
  scope?: string
  id_token?: string
}

async function tokenRequest(params: Record<string, string>): Promise<TokenReply> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  })
  const body = (await res.json().catch(() => ({}))) as TokenReply & { error?: string; error_description?: string }
  if (!res.ok) {
    if (body.error === 'invalid_grant') throw new GoogleAuthError(body.error_description ?? 'invalid_grant')
    throw new GoogleError(res.status, `token endpoint: ${body.error ?? res.status} ${body.error_description ?? ''}`)
  }
  return body
}

export function exchangeCode(cfg: OAuthConfig, code: string): Promise<TokenReply> {
  return tokenRequest({
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    grant_type: 'authorization_code',
  })
}

export function refreshAccess(cfg: OAuthConfig, refreshToken: string): Promise<TokenReply> {
  return tokenRequest({
    refresh_token: refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: 'refresh_token',
  })
}

/**
 * The identity in an ID token. The token came straight from Google's token
 * endpoint over TLS, so per OpenID Connect its signature need not be checked.
 */
export function idTokenClaims(idToken: string): { email: string; email_verified?: boolean; name?: string; sub: string } {
  const payload = idToken.split('.')[1]
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
}

export class GoogleCalendarApi implements CalendarApi {
  private accessToken: () => Promise<string>
  constructor(accessToken: () => Promise<string>) {
    this.accessToken = accessToken
  }

  private async call<T>(method: string, path: string, opts: { query?: Record<string, string>; body?: unknown; etag?: string } = {}): Promise<T> {
    const url = `${API}${path}${opts.query ? `?${new URLSearchParams(opts.query)}` : ''}`
    const headers: Record<string, string> = { authorization: `Bearer ${await this.accessToken()}` }
    if (opts.body !== undefined) headers['content-type'] = 'application/json'
    if (opts.etag) headers['if-match'] = opts.etag
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
      if (res.status === 204) return undefined as T
      const text = await res.text()
      if (res.ok) return (text ? JSON.parse(text) : undefined) as T
      if (res.status === 410) throw new GoneError(text)
      if (res.status === 412) throw new PreconditionFailed(text)
      // Rate limits and transient errors: back off a little and retry.
      if ((res.status === 429 || res.status >= 500 || (res.status === 403 && /rateLimit/i.test(text))) && attempt < 3) {
        await new Promise((ok) => setTimeout(ok, 1000 * 2 ** attempt))
        continue
      }
      let message = text
      try {
        message = JSON.parse(text).error?.message ?? text
      } catch {}
      throw new GoogleError(res.status, `${method} ${path}: ${res.status} ${message}`)
    }
  }

  async listCalendars(): Promise<GCalendar[]> {
    const out: GCalendar[] = []
    let pageToken: string | undefined
    do {
      const page = await this.call<{ items?: GCalendar[]; nextPageToken?: string }>('GET', '/users/me/calendarList', {
        query: { maxResults: '250', ...(pageToken ? { pageToken } : {}) },
      })
      out.push(...(page.items ?? []))
      pageToken = page.nextPageToken
    } while (pageToken)
    return out
  }

  insertCalendar(summary: string, timeZone: string): Promise<GCalendar> {
    return this.call('POST', '/calendars', { body: { summary, timeZone } })
  }

  listEvents(calendarId: string, opts: { syncToken?: string; pageToken?: string }): Promise<EventPage> {
    const query: Record<string, string> = { maxResults: '2500', showDeleted: 'true' }
    if (opts.syncToken) query.syncToken = opts.syncToken
    if (opts.pageToken) query.pageToken = opts.pageToken
    return this.call('GET', `/calendars/${enc(calendarId)}/events`, { query })
  }

  getEvent(calendarId: string, eventId: string): Promise<GEvent> {
    return this.call('GET', `/calendars/${enc(calendarId)}/events/${enc(eventId)}`)
  }

  async instances(calendarId: string, eventId: string, timeMin: string, timeMax: string): Promise<GEvent[]> {
    const page = await this.call<{ items?: GEvent[] }>('GET', `/calendars/${enc(calendarId)}/events/${enc(eventId)}/instances`, {
      query: { timeMin, timeMax, showDeleted: 'false', maxResults: '50' },
    })
    return page.items ?? []
  }

  insertEvent(calendarId: string, event: Partial<GEvent>): Promise<GEvent> {
    return this.call('POST', `/calendars/${enc(calendarId)}/events`, { body: event })
  }

  patchEvent(calendarId: string, eventId: string, patch: Partial<GEvent>, etag?: string): Promise<GEvent> {
    return this.call('PATCH', `/calendars/${enc(calendarId)}/events/${enc(eventId)}`, { body: patch, etag })
  }

  async deleteEvent(calendarId: string, eventId: string, etag?: string): Promise<void> {
    try {
      await this.call('DELETE', `/calendars/${enc(calendarId)}/events/${enc(eventId)}`, { etag })
    } catch (err) {
      if (err instanceof GoogleError && err.status === 410) return // already deleted
      if (err instanceof GoneError) return
      throw err
    }
  }

  moveEvent(calendarId: string, eventId: string, destination: string): Promise<GEvent> {
    return this.call('POST', `/calendars/${enc(calendarId)}/events/${enc(eventId)}/move`, { query: { destination } })
  }

  watch(calendarId: string, channelId: string, address: string, token: string): Promise<{ resourceId: string; expiration: string }> {
    return this.call('POST', `/calendars/${enc(calendarId)}/events/watch`, {
      body: { id: channelId, type: 'web_hook', address, token },
    })
  }

  async stopChannel(channelId: string, resourceId: string): Promise<void> {
    try {
      await this.call('POST', '/channels/stop', { body: { id: channelId, resourceId } })
    } catch (err) {
      if (err instanceof GoogleError && err.status === 404) return
      throw err
    }
  }
}

function enc(s: string): string {
  return encodeURIComponent(s)
}
