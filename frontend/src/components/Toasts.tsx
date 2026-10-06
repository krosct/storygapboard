import { useCallback, useRef, useState, type ReactNode } from 'react'

// In-page notifications. The app never uses window.alert/confirm/prompt.
export type ToastKind = 'error' | 'warning' | 'success' | 'info'
export interface Toast { id: number; kind: ToastKind; text: string }
export type Notify = (kind: ToastKind, text: string) => void

const AUTO_DISMISS_MS = 9000

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id))
  }, [])

  const notify = useCallback<Notify>((kind, text) => {
    const id = nextId.current++
    setToasts((list) => [...list.filter((t) => t.text !== text), { id, kind, text }].slice(-4))
    window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS)
  }, [dismiss])

  return { toasts, notify, dismiss }
}

export function ToastRegion({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div className="toasts" role="status" aria-live="polite" onClick={(e) => e.stopPropagation()}>
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : undefined}>
          <span>{t.text}</span>
          <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>×</button>
        </div>
      ))}
    </div>
  )
}

export function Message({ kind, children }: { kind: ToastKind; children: ReactNode }) {
  return <div className={`message message-${kind}`} role={kind === 'error' ? 'alert' : undefined}>{children}</div>
}
