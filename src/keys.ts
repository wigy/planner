// Single-key shortcuts. They never fire while typing in a field or with a
// modifier held; page-level ones also wait while a dialog is open.

import { useEffect, useRef } from 'react'

function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null
  if (!t) return false
  return t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)
}

export function dialogOpen(): boolean {
  return !!document.querySelector('.backdrop')
}

/**
 * Calls `handler` with the pressed key. `inDialog` lets it run while a dialog is
 * open (for the dialog's own keys); otherwise an open dialog silences it.
 * Return true from the handler when the key was used.
 */
export function useKeys(handler: (key: string, e: KeyboardEvent) => boolean | void, inDialog = false) {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || typing(e)) return
      if (!inDialog && dialogOpen()) return
      if (ref.current(e.key, e)) e.preventDefault()
    }
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  }, [inDialog])
}

export const SHORTCUTS: [string, string][] = [
  ['h', 'Today'],
  ['b', 'Board'],
  ['c', 'Calendar'],
  ['p', 'Projects'],
  ['r', 'Reports'],
  ['n', 'New card in P1 (on the board)'],
  ['a', 'Another card to work on (on Today)'],
  ['o', 'Open that card (on Today)'],
  ['1 – 4', 'Move the open card to P1 – P4'],
  ['d', 'Move the open card to Done'],
  ['t', 'Today (in the calendar)'],
  ['← →', 'Previous and next (in the calendar)'],
  ['m  w  d', 'Month, week or day view (in the calendar)'],
  ['?', 'This list'],
]
