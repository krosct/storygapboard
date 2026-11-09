import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

const MIN_ZOOM = 1
const MAX_ZOOM = 4
const STEP = 1.25
const DOUBLE_CLICK_ZOOM = 2.5

interface Props {
  src: string
  alt: string
  /** natural size of the picture: the pan limits are computed from its shape */
  width: number
  height: number
}

interface View { zoom: number; x: number; y: number }

type Gesture =
  | { kind: 'pan'; startX: number; startY: number; baseX: number; baseY: number }
  | { kind: 'pinch'; startDist: number; startZoom: number }

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)

/** A picture you can zoom (buttons, wheel, pinch, double click) and drag, like a PDF viewer. */
export default function ImageViewer({ src, alt, width, height }: Props) {
  const stage = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>({ zoom: MIN_ZOOM, x: 0, y: 0 })
  // the latest view, read by the gesture handlers between two renders
  const latest = useRef(view)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef<Gesture | null>(null)

  /** How far the picture may be dragged at this zoom, so its edge never leaves the frame. */
  function clampPan(x: number, y: number, zoom: number) {
    const el = stage.current
    if (!el) return { x, y }
    const fit = Math.min(el.clientWidth / width, el.clientHeight / height)
    const maxX = Math.max(0, (fit * width * zoom - el.clientWidth) / 2)
    const maxY = Math.max(0, (fit * height * zoom - el.clientHeight) / 2)
    return { x: Math.min(maxX, Math.max(-maxX, x)), y: Math.min(maxY, Math.max(-maxY, y)) }
  }

  function commit(next: View) {
    latest.current = next
    setView(next)
  }

  function setZoom(next: number) {
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next))
    const p = zoom === MIN_ZOOM ? { x: 0, y: 0 } : clampPan(latest.current.x, latest.current.y, zoom)
    commit({ zoom, ...p })
  }

  function startGesture() {
    const pts = [...pointers.current.values()]
    if (pts.length === 1) {
      gesture.current = { kind: 'pan', startX: pts[0].x, startY: pts[0].y, baseX: latest.current.x, baseY: latest.current.y }
    } else if (pts.length >= 2) {
      gesture.current = { kind: 'pinch', startDist: dist(pts[0], pts[1]), startZoom: latest.current.zoom }
    } else {
      gesture.current = null
    }
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    stage.current?.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    startGesture()
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const p = pointers.current.get(e.pointerId)
    if (!p) return
    p.x = e.clientX
    p.y = e.clientY
    const g = gesture.current
    if (!g) return
    if (g.kind === 'pan' && latest.current.zoom > MIN_ZOOM) {
      const q = clampPan(g.baseX + e.clientX - g.startX, g.baseY + e.clientY - g.startY, latest.current.zoom)
      commit({ ...latest.current, ...q })
    } else if (g.kind === 'pinch') {
      const pts = [...pointers.current.values()]
      if (pts.length >= 2 && g.startDist > 0) setZoom(g.startZoom * dist(pts[0], pts[1]) / g.startDist)
    }
  }

  function onPointerEnd(e: ReactPointerEvent<HTMLDivElement>) {
    pointers.current.delete(e.pointerId)
    // a pinch that ends with one finger left goes on as a drag from where that finger is
    startGesture()
  }

  // the wheel zooms (not scrolls) the picture: a non-passive listener so the page does not move
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setZoom(latest.current.zoom * (e.deltaY < 0 ? STEP : 1 / STEP))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // setZoom only reads refs and the state setter, so the handler from the first render stays valid
  }, [])

  const zoomed = view.zoom > MIN_ZOOM
  return (
    <div className="viewer">
      <div ref={stage} className={`viewer-stage${zoomed ? ' is-zoomed' : ''}`}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
        onDoubleClick={() => setZoom(zoomed ? MIN_ZOOM : DOUBLE_CLICK_ZOOM)}>
        <img src={src} alt={alt} width={width} height={height} draggable={false}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }} />
      </div>
      <div className="viewer-bar">
        <button type="button" className="icon-only icon solid fa-search-minus" aria-label="Zoom out" title="Zoom out"
          disabled={!zoomed} onClick={() => setZoom(latest.current.zoom / STEP)} />
        <span className="viewer-zoom" aria-live="polite">{Math.round(view.zoom * 100)}%</span>
        <button type="button" className="icon-only icon solid fa-search-plus" aria-label="Zoom in" title="Zoom in"
          disabled={view.zoom >= MAX_ZOOM} onClick={() => setZoom(latest.current.zoom * STEP)} />
        <button type="button" className="icon-only icon solid fa-expand" aria-label="Fit to window" title="Fit to window"
          disabled={!zoomed} onClick={() => setZoom(MIN_ZOOM)} />
      </div>
    </div>
  )
}
