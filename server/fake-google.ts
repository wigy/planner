// An in-memory Google Calendar for tests: change log, sync tokens, etags, 410
// and 412 behave like the real API in the ways the sync code depends on.

import { type CalendarApi, GoneError, type GCalendar, type GEvent, PreconditionFailed } from './google.ts'
import { expand } from './recurrence.ts'

type Cal = { meta: GCalendar; events: Map<string, GEvent>; log: { seq: number; id: string }[] }

export class FakeGoogle implements CalendarApi {
  cals = new Map<string, Cal>()
  seq = 1
  nextId = 1
  /** Tokens issued before this sequence number are expired (410). */
  expiredBefore = 0
  calls: string[] = []

  addCalendar(id: string, meta: Partial<GCalendar> = {}) {
    this.cals.set(id, { meta: { id, summary: id, accessRole: 'owner', ...meta }, events: new Map(), log: [] })
  }

  private cal(id: string): Cal {
    const c = this.cals.get(id)
    if (!c) throw new Error(`fake: no calendar ${id}`)
    return c
  }

  private touch(c: Cal, ev: GEvent) {
    ev.etag = `"${this.seq}"`
    ev.updated = new Date().toISOString()
    c.events.set(ev.id, ev)
    c.log.push({ seq: this.seq++, id: ev.id })
  }

  /** Changes an event the way another client would. */
  external(calendarId: string, ev: Partial<GEvent> & { id?: string }): GEvent {
    const c = this.cal(calendarId)
    const id = ev.id ?? `ev${this.nextId++}`
    const merged = { status: 'confirmed', ...(c.events.get(id) ?? {}), ...ev, id } as GEvent
    this.touch(c, merged)
    return merged
  }

  async listCalendars(): Promise<GCalendar[]> {
    this.calls.push('listCalendars')
    return [...this.cals.values()].map((c) => c.meta)
  }

  async insertCalendar(summary: string): Promise<GCalendar> {
    const id = `cal${this.nextId++}@group.calendar.google.com`
    this.addCalendar(id, { summary, accessRole: 'owner' })
    return this.cal(id).meta
  }

  async listEvents(calendarId: string, opts: { syncToken?: string; pageToken?: string }) {
    this.calls.push(`listEvents ${calendarId} ${opts.syncToken ?? 'full'}`)
    const c = this.cal(calendarId)
    let items: GEvent[]
    if (opts.syncToken) {
      const since = Number(opts.syncToken)
      if (since < this.expiredBefore) throw new GoneError('sync token expired')
      const ids = new Set(c.log.filter((l) => l.seq >= since).map((l) => l.id))
      items = [...ids].map((id) => c.events.get(id)!).filter(Boolean)
    } else {
      // A full list leaves out deleted events, as Google does after a while.
      items = [...c.events.values()].filter((e) => e.status !== 'cancelled' || e.recurringEventId)
    }
    return { items: structuredClone(items), nextSyncToken: String(this.seq) }
  }

  async getEvent(calendarId: string, eventId: string): Promise<GEvent> {
    const ev = this.cal(calendarId).events.get(eventId)
    if (!ev) throw new Error('fake: not found')
    return structuredClone(ev)
  }

  async instances(calendarId: string, eventId: string, timeMin: string, timeMax: string): Promise<GEvent[]> {
    const c = this.cal(calendarId)
    const master = c.events.get(eventId)!
    const allDay = !!master.start?.date
    const spans = expand(
      {
        start: allDay ? master.start!.date! : new Date(master.start!.dateTime!).toISOString(),
        end: allDay ? master.end!.date! : new Date(master.end!.dateTime!).toISOString(),
        allDay,
        timeZone: master.start?.timeZone ?? 'Europe/Helsinki',
        recurrence: master.recurrence ?? [],
      },
      new Date(timeMin),
      new Date(timeMax),
    )
    return spans.map((s) => {
      const suffix = allDay ? s.start.replace(/-/g, '') : s.start.replace(/[-:]/g, '').replace(/\.\d{3}/, '')
      const id = `${eventId}_${suffix}`
      const existing = c.events.get(id)
      return (
        existing ?? {
          id,
          status: 'confirmed',
          summary: master.summary,
          recurringEventId: eventId,
          originalStartTime: allDay ? { date: s.start } : { dateTime: s.start, timeZone: master.start?.timeZone },
          start: allDay ? { date: s.start } : { dateTime: s.start },
          end: allDay ? { date: s.end } : { dateTime: s.end },
        }
      )
    })
  }

  async insertEvent(calendarId: string, event: Partial<GEvent>): Promise<GEvent> {
    this.calls.push(`insertEvent ${calendarId}`)
    const ev = { status: 'confirmed', organizer: { self: true }, ...structuredClone(event), id: `ev${this.nextId++}` } as GEvent
    this.touch(this.cal(calendarId), ev)
    return structuredClone(ev)
  }

  async patchEvent(calendarId: string, eventId: string, patch: Partial<GEvent>, etag?: string): Promise<GEvent> {
    this.calls.push(`patchEvent ${calendarId} ${eventId}`)
    const c = this.cal(calendarId)
    let ev = c.events.get(eventId)
    if (!ev) {
      // Patching an instance of a series creates the exception event.
      const m = eventId.match(/^(.*)_(\d{8}(T\d{6}Z)?)$/)
      if (!m) throw new Error('fake: not found')
      const inst = (await this.instances(calendarId, m[1], '1970-01-01T00:00:00Z', '2100-01-01T00:00:00Z')).find((i) => i.id === eventId)
      if (!inst) throw new Error('fake: no such instance')
      ev = inst
    }
    if (etag && ev.etag !== etag) throw new PreconditionFailed('etag mismatch')
    const next = { ...structuredClone(ev), ...structuredClone(patch) }
    if (patch.extendedProperties) {
      next.extendedProperties = { private: { ...(ev.extendedProperties?.private ?? {}), ...(patch.extendedProperties.private ?? {}) } }
    }
    this.touch(c, next)
    return structuredClone(next)
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    this.calls.push(`deleteEvent ${calendarId} ${eventId}`)
    const c = this.cal(calendarId)
    let ev = c.events.get(eventId)
    if (!ev) {
      const m = eventId.match(/^(.*)_(\d{8}(T\d{6}Z)?)$/)
      if (m) ev = (await this.instances(calendarId, m[1], '1970-01-01T00:00:00Z', '2100-01-01T00:00:00Z')).find((i) => i.id === eventId)
    }
    if (!ev) return
    this.touch(c, { ...ev, status: 'cancelled' })
  }

  async moveEvent(calendarId: string, eventId: string, destination: string): Promise<GEvent> {
    this.calls.push(`moveEvent ${calendarId} ${eventId} ${destination}`)
    const from = this.cal(calendarId)
    const ev = from.events.get(eventId)!
    this.touch(from, { ...ev, status: 'cancelled' })
    const moved = { ...structuredClone(ev), status: 'confirmed' }
    this.touch(this.cal(destination), moved)
    return structuredClone(moved)
  }

  async watch(): Promise<{ resourceId: string; expiration: string }> {
    return { resourceId: 'res', expiration: String(Date.now() + 7 * 86400_000) }
  }

  async stopChannel(): Promise<void> {}
}
