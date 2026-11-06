import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  title: string
  /** while busy, Escape and the backdrop do not close it */
  busy: boolean
  onClose: () => void
  /** a short question (a few words and buttons) instead of a full tool window */
  small?: boolean
  /** extra class on the dialog (to style one window) */
  className?: string
  /** where the dialog comes from (e.g. the panel being retouched): it grows out of that box */
  from?: DOMRect
  children: ReactNode
}

const GROW_MS = 380
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'
/** How small the dialog starts (and ends) relative to the box it grows out of. */
const SEED_SCALE = 0.4

/**
 * Open (or, reversed, close) animation: the dialog scales up from a small seed centred on the `from`
 * box (or a soft pop without one). Resolves when it ends; the end state is held until the caller unmounts.
 */
function animateDialog(dialog: HTMLElement | null, backdrop: HTMLElement | null, from: DOMRect | undefined,
  reverse: boolean): Promise<void> {
  if (!dialog || typeof dialog.animate !== 'function') return Promise.resolve()
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return Promise.resolve()
  const to = dialog.getBoundingClientRect()
  const direction = reverse ? 'reverse' : 'normal'
  const fill = 'forwards' as const
  const fade = [{ opacity: 0 }, { opacity: 1 }]
  const done: Promise<unknown>[] = []
  if (!from || !to.width || !to.height) {
    const ms = reverse ? 180 : 220
    done.push(dialog.animate([{ opacity: 0, transform: 'scale(0.94)' }, { opacity: 1, transform: 'none' }],
      { duration: ms, easing: EASE, direction, fill }).finished)
    if (backdrop) done.push(backdrop.animate(fade, { duration: ms, easing: 'ease-out', direction, fill }).finished)
  } else {
    // uniform scale (text is never stretched), centres aligned: it visibly comes out of the panel
    const scale = Math.min(from.width / to.width, from.height / to.height, 1) * SEED_SCALE
    const dx = from.left + from.width / 2 - (to.left + to.width / 2)
    const dy = from.top + from.height / 2 - (to.top + to.height / 2)
    done.push(dialog.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0.2 },
      { opacity: 1, offset: 0.35 },
      { transform: 'none', opacity: 1 },
    ], { duration: GROW_MS, easing: EASE, direction, fill }).finished)
    if (backdrop) done.push(backdrop.animate(fade, { duration: GROW_MS, easing: 'ease-out', direction, fill }).finished)
  }
  return Promise.all(done).then(() => undefined, () => undefined)
}

/** Closes the dialog it is in, with the closing animation (what its own × and Escape do). */
const ModalCloseContext = createContext<() => void>(() => {})

export function ModalCloseButton({ disabled, children }: { disabled?: boolean; children: ReactNode }) {
  const close = useContext(ModalCloseContext)
  return <button type="button" disabled={disabled} onClick={close}>{children}</button>
}

// In-page dialog (the app never uses browser dialogs). Rendered in its own
// container under <body>: the open article is transformed, which would trap a
// fixed element inside it, and the template closes the article on any click that
// reaches <body> or Escape on window, so clicks stop at the container and Escape
// is caught first (capture) while the dialog is open.
export default function Modal({ title, busy, onClose, small = false, className = '', from, children }: Props) {
  const [host] = useState(() => document.createElement('div'))
  const dialog = useRef<HTMLDivElement>(null)
  const backdrop = useRef<HTMLDivElement>(null)
  const latest = useRef({ busy, onClose, from })
  latest.current = { busy, onClose, from }
  const closing = useRef(false)
  // every way out (×, backdrop, Escape, a Done button) plays the animation backwards, then closes
  const requestClose = useRef(() => {
    if (closing.current || latest.current.busy) return
    closing.current = true
    void animateDialog(dialog.current, backdrop.current, latest.current.from, true).then(() => latest.current.onClose())
  }).current

  useLayoutEffect(() => {
    const stop = (e: Event) => e.stopPropagation()
    // Escape wherever the focus is: close this dialog only, never the article under it.
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (e.type === 'keydown') requestClose()
    }
    host.className = 'modal-host'
    host.addEventListener('click', stop)
    window.addEventListener('keydown', onEscape, true)
    window.addEventListener('keyup', onEscape, true)
    document.body.appendChild(host)
    document.documentElement.classList.add('has-modal')
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.focus({ preventScroll: true })
    void animateDialog(dialog.current, backdrop.current, latest.current.from, false)
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
  }, [host, requestClose])

  return createPortal(
    <div ref={backdrop} className="modal-backdrop" onClick={requestClose}>
      <div ref={dialog} className={`modal${small ? ' is-small' : ''}${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}
        onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <span className="modal-close" role="button" tabIndex={busy ? -1 : 0} aria-label="Close"
            aria-disabled={busy}
            onClick={requestClose}
            onKeyDown={(e) => { if (!busy && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); requestClose() } }}>
            ×
          </span>
        </div>
        <ModalCloseContext.Provider value={requestClose}>{children}</ModalCloseContext.Provider>
      </div>
    </div>,
    host,
  )
}
