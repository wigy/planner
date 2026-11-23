// Types shared by the API and the UI.

export const COLUMNS = ['p1', 'p2', 'p3', 'p4', 'done'] as const
export type Column = (typeof COLUMNS)[number]
export const COLUMN_NAMES: Record<Column, string> = { p1: 'P1', p2: 'P2', p3: 'P3', p4: 'P4', done: 'Done' }

/** Cards in Done for longer than this are archived by the hourly job. */
export const ARCHIVE_AFTER_MS = 48 * 3600_000

export type User = { id: number; name: string; email: string }

export type Me = User & {
  accounts: { id: number; email: string; status: string }[]
  others: User[]
  googleConfigured: boolean
}

export type Label = { id: number; name: string; color: string }

export type Ticket = {
  id: number
  userId: number
  title: string
  description: string
  col: Column
  position: number
  doneAt: string | null
  archivedAt: string | null
  projectId: number | null
  labels: number[]
  comments: number
  createdAt: string
  updatedAt: string
}

export type Comment = { id: number; userId: number; userName: string; body: string; createdAt: string }

export type TicketHistory = { kind: string; userName: string | null; payload: Record<string, unknown>; at: string }

export type TicketDetail = Ticket & { commentList: Comment[]; history: TicketHistory[] }

export type Calendar = {
  id: number
  account: string
  name: string
  color: string
  accessRole: string
  primary: boolean
  selected: boolean
  bookkeeping: boolean
  syncedAt: string | null
}

export type Project = {
  id: number
  title: string
  hashtag: string
  color: string
  rate: number | null
  customer: string
  archived: boolean
}

/** One occurrence of an event, as shown in the views. */
export type Occurrence = {
  id: string // `${eventId}` or `${eventId}@${start}` for an expanded occurrence
  eventId: number
  calendarId: number
  title: string
  description: string
  location: string
  start: string // ISO instant, or YYYY-MM-DD when allDay
  end: string
  allDay: boolean
  recurring: boolean // part of a series (either expanded or an exception)
  editable: boolean
  organizerSelf: boolean
  booking:
    | { kind: 'none' }
    | { kind: 'booked'; projectId: number }
    | { kind: 'conflict'; hashtags: string[] }
  /** On a non-Bookkeeping event: a project hashtag in its title, so it can be sent. */
  taggedProjectId: number | null
  /** On a non-Bookkeeping event: it has already been copied or moved to Bookkeeping. */
  sentTo: number | null
  unknownHashtags: string[]
}

export type ReportEntry = {
  eventId: number
  date: string // YYYY-MM-DD in Europe/Helsinki
  start: string
  end: string
  title: string
  /** The description as plain text, without the project hashtags. */
  text: string
  projectId: number
  minutes: number // exact, clipped to the month
  rounded: number
}

export type Report = {
  month: string
  rounding: string
  projects: { projectId: number; title: string; hashtag: string; rate: number | null; customer: string; minutes: number; entries: ReportEntry[] }[]
  totalMinutes: number
  locked: boolean
  /** Bookkeeping events in the month that book nothing: two project hashtags, or an all-day event without hours. */
  problems: { title: string; start: string; reason: string }[]
}

export type MonthSummary = { month: string; byProject: Record<number, number>; totalMinutes: number }
