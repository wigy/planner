// Booked hours shown outside Reports: the date stamp and the calendar's week
// numbers. Anything that changes events calls hoursChanged() so they refresh.

const EVENT = 'planner:hours-changed'

export function hoursChanged() {
  dispatchEvent(new Event(EVENT))
}

export function onHoursChanged(fn: () => void): () => void {
  addEventListener(EVENT, fn)
  return () => removeEventListener(EVENT, fn)
}

/** YYYY-MM-DD of a date in the browser's zone. */
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
