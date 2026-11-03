import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  title: string
  /** while busy, Escape and the backdrop do not close it */
  busy: boolean
  onClose: () => void
  /** a short question (a few words and buttons) instead of a full tool window */
  small?: boolean
  children: ReactNode
}

// In-page dialog (the app never uses browser dialogs). Rendered in its own
// container under <body>: the open article is transformed, which would trap a
// fixed element inside it, and the template closes the article on any click that
// reaches <body> or Escape on window, so clicks stop at the container and Escape
// is caught first (capture) while the dialog is open.
export default function Modal({ title, busy, onClose, small = false, children }: Props) {
  const [host] = useState(() => document.createElement('div'))
  const dialog = useRef<HTMLDivElement>(null)
  const latest = useRef({ busy, onClose })
  latest.current = { busy, onClose }

  useEffect(() => {
    const stop = (e: Event) => e.stopPropagation()
    // Escape wherever the focus is: close this dialog only, never the article under it.
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (e.type === 'keydown' && !latest.current.busy) latest.current.onClose()
    }
    host.className = 'modal-host'
    host.addEventListener('click', stop)
    window.addEventListener('keydown', onEscape, true)
    window.addEventListener('keyup', onEscape, true)
    document.body.appendChild(host)
    document.documentElement.classList.add('has-modal')
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.focus()
    return () => {
      host.removeEventListener('click', stop)
      window.removeEventListener('keydown', onEscape, true)
      window.removeEventListener('keyup', onEscape, true)
      // closed by an Escape keydown: its keyup comes next and must not close the article
      const swallow = (e: KeyboardEvent) => { if (e.key === 'Escape') e.stopPropagation() }
      window.addEventListener('keyup', swallow, true)
      window.setTimeout(() => window.removeEventListener('keyup', swallow, true), 500)
      host.remove()
      document.documentElement.classList.remove('has-modal')
      previous?.focus?.()
    }
  }, [host])

  return createPortal(
    <div className="modal-backdrop" onClick={() => { if (!busy) onClose() }}>
      <div ref={dialog} className={`modal${small ? ' is-small' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}
        onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <span className="modal-close" role="button" tabIndex={busy ? -1 : 0} aria-label="Close"
            aria-disabled={busy}
            onClick={() => { if (!busy) onClose() }}
            onKeyDown={(e) => { if (!busy && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onClose() } }}>
            ×
          </span>
        </div>
        {children}
      </div>
    </div>,
    host,
  )
}
