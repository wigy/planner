import { type ReactNode, useEffect, useRef } from 'react'

export function Modal({ children, onClose, wide }: { children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Dialogs can stack (a confirmation over an event): Escape closes only the top one.
    const on = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const open = document.querySelectorAll('.backdrop')
      if (open[open.length - 1] === ref.current) onClose()
    }
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  }, [onClose])
  return (
    <div ref={ref} className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <button className="close" onClick={onClose} aria-label="Close">
          ×
        </button>
        {children}
      </div>
    </div>
  )
}
