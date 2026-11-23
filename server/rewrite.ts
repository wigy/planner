// A title rewrite made by planner itself, outside an interactive edit.

import { get } from './db.ts'
import type { GEvent } from './google.ts'
import { type CalendarRow, type Ctx, storeEvent } from './sync.ts'

export async function patchQuiet(ctx: Ctx, accountId: number, calendarId: number, googleCalendarId: string, googleEventId: string, body: Partial<GEvent>) {
  const reply = await ctx.apiFor(accountId).patchEvent(googleCalendarId, googleEventId, body)
  const cal = get<CalendarRow>(ctx.db, 'SELECT * FROM calendars WHERE id = ?', calendarId)
  if (cal) storeEvent(ctx, cal, reply)
}
