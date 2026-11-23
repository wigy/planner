// A confirmation dialog in planner's own style, in place of the browser's confirm().
// `await ask({...})` resolves true when the action is confirmed, false otherwise.

import { type ReactNode, useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { Modal } from './Modal.tsx'

export type Ask = {
  title: string
  body?: ReactNode
  /** The button that goes ahead, named for what it does: "Delete event", not "OK". */
  confirm: string
  /** A destructive action: the button is red, and Cancel has the focus. */
  danger?: boolean
}

function ConfirmDialog({ title, body, confirm, danger, onDone }: Ask & { onDone: (ok: boolean) => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const okRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    ;(danger ? cancelRef : okRef).current?.focus()
  }, [danger])
  return (
    <Modal onClose={() => onDone(false)}>
      <div className="confirm" role="alertdialog" aria-labelledby="confirm-title">
        <h2 id="confirm-title">{title}</h2>
        {body && <div className="confirm-body">{body}</div>}
        <div className="confirm-actions">
          <button ref={cancelRef} onClick={() => onDone(false)}>
            Cancel
          </button>
          <button ref={okRef} className={danger ? 'destroy' : 'primary'} onClick={() => onDone(true)}>
            {confirm}
          </button>
        </div>
      </div>
    </Modal>
  )
}

export function ask(options: Ask): Promise<boolean> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const before = document.activeElement as HTMLElement | null
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      root.unmount()
      host.remove()
      before?.focus?.()
      resolve(ok)
    }
    root.render(<ConfirmDialog {...options} onDone={done} />)
  })
}
