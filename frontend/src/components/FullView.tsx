import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** The image as large as the screen allows (browser fullscreen when available), over everything. */
export default function FullView({ url, onClose }: { url: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const closing = useRef(false)
  // Own host under <body>: the template closes the article on any click that reaches <body> (and on
  // Escape keyup), so clicks stop at the host and leaving the full view keeps the Download tab open.
  const [host] = useState(() => document.createElement('div'))
  const pic = useRef<HTMLCanvasElement>(null)

  // Painted on a canvas (no <img>): the page offers no way to save it, only the Download button does.
  useEffect(() => {
    const el = pic.current
    if (!el) return
    let alive = true
    const img = new Image()
    img.onload = () => {
      if (!alive) return
      el.width = img.naturalWidth
      el.height = img.naturalHeight
      el.getContext('2d')?.drawImage(img, 0, 0)
    }
    img.src = url
    return () => { alive = false }
  }, [url])

  useEffect(() => {
    const el = ref.current
    // Browser fullscreen when allowed; the overlay already fills the window if not.
    void el?.requestFullscreen?.().catch(() => undefined)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation() // never close the article behind
      close()
    }
    const onFs = () => { if (!document.fullscreenElement) close() }
    function close() {
      if (closing.current) return
      closing.current = true
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
      onClose()
    }
    const stop = (e: Event) => e.stopPropagation()
    const onKeyUp = (e: KeyboardEvent) => { if (e.key === 'Escape') e.stopPropagation() }
    host.addEventListener('click', stop)
    document.body.appendChild(host)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKeyUp, true)
    document.addEventListener('fullscreenchange', onFs)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      host.removeEventListener('click', stop)
      document.removeEventListener('fullscreenchange', onFs)
      // the Escape keyup that follows must not close the article either
      window.setTimeout(() => window.removeEventListener('keyup', onKeyUp, true), 500)
      host.remove()
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
    }
  }, [onClose, host])

  return createPortal(
    <div ref={ref} role="dialog" aria-label="Full size storyboard" onContextMenu={(e) => e.preventDefault()} onDragStart={(e) => e.preventDefault()} onClick={(e) => { e.stopPropagation(); onClose() }}
      style={{ position: 'fixed', inset: 0, zIndex: 100000, background: '#000', display: 'flex',
        alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out', userSelect: 'none' }}>
      <canvas ref={pic} role="img" aria-label="Storyboard, full size"
        style={{ maxWidth: '100vw', maxHeight: '100vh', objectFit: 'contain' }} />
    </div>,
    host,
  )
}
