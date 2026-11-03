import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { bitmapOf, drawSource, framingRoom, type PanelSource, type Rect } from '../board'

interface Props {
  url: string
  width: number
  height: number
  rects: Rect[]
  sources: PanelSource[]
  editing: number | null
  running: boolean
  onRetouch: (index: number) => void
  onDownload: (index: number) => void
  /** new framing of one panel (0..1 like CSS object-position) */
  onFrame: (index: number, x: number, y: number) => void
}

const clamp = (n: number) => Math.min(1, Math.max(0, n))

interface Drag {
  index: number
  startX: number
  startY: number
  from: PanelSource
  /** room to move, in screen px */
  room: [number, number]
  bitmap: ImageBitmap
  moved: boolean
}

// The final board: drag a panel to move its framing (the whole board is redrawn
// when you let go; while dragging, a canvas over the panel shows it live). Each
// panel has two small buttons: retouch and download.
export default function BoardView(p: Props) {
  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  // the panel being held: its label and buttons hide so the framing is fully visible
  const [pressed, setPressed] = useState<number | null>(null)
  const holding = useRef(false)
  useEffect(() => {
    document.documentElement.classList.toggle('is-panning', pressed !== null)
    return () => document.documentElement.classList.remove('is-panning')
  }, [pressed])
  const live = useRef<HTMLCanvasElement>(null)

  // The live canvas stays over the panel until the redrawn board arrives.
  const [overlay, setOverlay] = useState<number | null>(null)
  useEffect(() => { setOverlay(null) }, [p.url])

  function paint(d: Drag, x: number, y: number) {
    const el = live.current
    const ctx = el?.getContext('2d')
    if (!el || !ctx) return
    drawSource(ctx, d.bitmap, { ...d.from, x, y }, { x: 0, y: 0, w: el.width, h: el.height })
  }

  async function onDown(e: PointerEvent<HTMLSpanElement>, index: number) {
    if (p.running || e.button !== 0) return
    const cell = e.currentTarget
    const rect = p.rects[index]
    const [roomX, roomY] = framingRoom(p.sources[index], rect.w, rect.h)
    if (roomX < 1 && roomY < 1) return
    // no text selection while dragging, and the panel is shown clean right away (see pressed)
    e.preventDefault()
    cell.setPointerCapture(e.pointerId)
    setPressed(index)
    holding.current = true
    const scale = cell.getBoundingClientRect().width / rect.w
    let bitmap: ImageBitmap
    try {
      bitmap = await bitmapOf(p.sources[index].image)
    } catch {
      setPressed(null)
      return
    }
    // released while the image was loading: nothing to drag
    if (!holding.current) return
    const d: Drag = {
      index, startX: e.clientX, startY: e.clientY, from: p.sources[index],
      room: [roomX * scale, roomY * scale], bitmap, moved: false,
    }
    dragRef.current = d
    setDrag(d)
    setOverlay(index)
  }

  // First paint once the live canvas is in place (moves repaint it directly).
  useEffect(() => {
    const el = live.current
    if (!drag || !el) return
    const box = el.getBoundingClientRect()
    el.width = Math.round(box.width * window.devicePixelRatio)
    el.height = Math.round(box.height * window.devicePixelRatio)
    paint(drag, drag.from.x, drag.from.y)
  }, [drag])

  function framing(d: Drag, e: PointerEvent): [number, number] {
    const [roomX, roomY] = d.room
    return [
      roomX >= 1 ? clamp(d.from.x - (e.clientX - d.startX) / roomX) : d.from.x,
      roomY >= 1 ? clamp(d.from.y - (e.clientY - d.startY) / roomY) : d.from.y,
    ]
  }

  function onMove(e: PointerEvent) {
    const d = dragRef.current
    if (!d) return
    if (Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) > 2) d.moved = true
    const [x, y] = framing(d, e)
    paint(d, x, y)
  }

  function onUp(e: PointerEvent) {
    const d = dragRef.current
    dragRef.current = null
    holding.current = false
    setDrag(null)
    setPressed(null)
    if (!d) return
    if (!d.moved) {
      setOverlay(null)
      return
    }
    const [x, y] = framing(d, e)
    p.onFrame(d.index, x, y)
  }

  function onKey(e: KeyboardEvent, index: number) {
    const step = { ArrowLeft: [-0.05, 0], ArrowRight: [0.05, 0], ArrowUp: [0, -0.05], ArrowDown: [0, 0.05] }[e.key]
    if (p.running || !step) return
    e.preventDefault()
    const s = p.sources[index]
    p.onFrame(index, clamp(s.x + step[0]), clamp(s.y + step[1]))
  }

  const pct = (v: number, total: number) => `${(v / total) * 100}%`
  return (
    <div className="board">
      <img src={p.url} alt="Generated storyboard" />
      {p.rects.map((rect, i) => {
        const [roomX, roomY] = framingRoom(p.sources[i], rect.w, rect.h)
        const movable = roomX >= 1 || roomY >= 1
        return (
          <span key={i} tabIndex={p.running ? -1 : 0}
            className={`board-cell${movable ? ' is-movable' : ''}${p.editing === i ? ' is-editing' : ''}${drag?.index === i || pressed === i ? ' is-dragging' : ''}`}
            aria-label={`Panel ${i + 1}${movable ? ': drag or use the arrow keys to move its framing' : ''}`}
            style={{ left: pct(rect.x, p.width), top: pct(rect.y, p.height), width: pct(rect.w, p.width), height: pct(rect.h, p.height) }}
            onPointerDown={(e) => void onDown(e, i)} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
            // Chrome starts a text selection from the mousedown, not the pointerdown
            onMouseDown={(e) => { if (e.target === e.currentTarget || (e.target as HTMLElement).tagName === 'CANVAS') e.preventDefault() }}
            onKeyDown={(e) => { if (e.target === e.currentTarget) onKey(e, i) }}>
            {overlay === i && <canvas ref={live} className="board-live" aria-hidden="true" />}
            <span className="board-cell-label">Panel {i + 1}</span>
            <span className="board-cell-actions" onPointerDown={(e) => e.stopPropagation()}>
              <span className="board-btn icon solid fa-pencil-alt" role="button" tabIndex={p.running ? -1 : 0}
                aria-label={`Retouch panel ${i + 1}`} title="Retouch this panel" aria-disabled={p.running}
                onClick={() => { if (!p.running) p.onRetouch(i) }}
                onKeyDown={(e) => { if (!p.running && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); p.onRetouch(i) } }} />
              <span className="board-btn icon solid fa-download" role="button" tabIndex={0}
                aria-label={`Download panel ${i + 1}`} title="Download this panel"
                onClick={() => p.onDownload(i)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onDownload(i) } }} />
            </span>
          </span>
        )
      })}
    </div>
  )
}
