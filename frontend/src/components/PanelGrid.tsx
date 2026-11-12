import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { fileKind, formatBytes } from '../api'
import { parseLayout, parseRatio, type Panel, type Panels } from '../board'
import type { Notify } from './Toasts'
import { recordAction } from '../timeline'

interface Props {
  layout: string
  /** shape of each panel ("auto" previews 4:3) */
  panelAspect: string
  panels: Panels
  setPanels: (panels: Panels) => void
  maxBytes: number
  disabled: boolean
  notify: Notify
  /** Called when a panel's framing changes (x, y in 0..1) */
  onFrame?: (index: number, x: number, y: number) => void
  /** Called after two panels swap places (their pictures and framing). */
  onSwap?: (a: number, b: number) => void
  /** Called when a panel is removed (the board shows an empty slot). */
  onRemove?: (index: number) => void
  /** Called when a picture is put into a panel (the board shows it again). */
  onAdd?: (index: number, panel: Panel) => void
}

const clamp = (n: number) => Math.min(1, Math.max(0, n))

/** The cell index under a screen point (null when the point is not over a panel cell). */
function cellIndexAt(x: number, y: number): number | null {
  const el = document.elementFromPoint(x, y)
  const cell = el?.closest('.panel-cell') as HTMLElement | null
  if (!cell) return null
  const index = Array.from(cell.parentElement?.children ?? []).indexOf(cell)
  return index >= 0 ? index : null
}

// The storyboard layout as boxes in the chosen panel shape: an image dropped in a
// box fills it exactly as it will in the storyboard. A filled panel can be dragged
// onto another to swap them; the arrow keys move its framing. Empty boxes are drawn
// by the model.
export default function PanelGrid({ layout, panelAspect, panels, setPanels, maxBytes, disabled, notify, onFrame, onSwap, onRemove, onAdd }: Props) {
  const [rows, cols] = parseLayout(layout)
  const total = rows * cols
  const cells = Array.from({ length: total }, (_, i) => panels[i] ?? null)
  const input = useRef<HTMLInputElement>(null)
  const target = useRef(0)
  const [over, setOver] = useState<number | null>(null)
  // The panel being dragged: its floating layer (the picture lifted out of the grid)
  // and the pointer position at the start (the movement is measured from there, never
  // from the previous event: that was the cause of the old trembling). The floating
  // layer is a React portal, so it is removed with the component (never left behind).
  const [dragging, setDragging] = useState<{
    i: number
    src: string
    objectPosition: string
    rect: { left: number; top: number; width: number; height: number }
  } | null>(null)
  const ghost = useRef<HTMLDivElement>(null)
  const drag = useRef<{ i: number; startX: number; startY: number } | null>(null)

  // One preview URL per source (File or Blob).
  const urls = useRef(new Map<File | Blob, string>())
  const preview = (src: File | Blob) => {
    let url = urls.current.get(src)
    if (!url) {
      url = URL.createObjectURL(src)
      urls.current.set(src, url)
    }
    return url
  }
  useEffect(() => {
    const live = new Set(panels.map((c) => c?.src).filter(Boolean))
    urls.current.forEach((url, src) => {
      if (!live.has(src)) {
        URL.revokeObjectURL(url)
        urls.current.delete(src)
      }
    })
  }, [panels])
  useEffect(() => () => urls.current.forEach((url) => URL.revokeObjectURL(url)), [])

  function update(i: number, value: Panel | null) {
    const next = [...cells]
    next[i] = value
    setPanels(next)
  }

  function remove(i: number) {
    update(i, null)
    onRemove?.(i)
    void recordAction(`Cleared Panel ${i + 1}`, `Removed image from panel slot ${i + 1}.`)
  }

  function put(i: number, file: File | undefined) {
    if (!file) return
    if (fileKind(file) !== 'image') {
      notify('error', `${file.name}: a panel takes a PNG, JPEG, WebP or GIF image.`)
    } else if (file.size > maxBytes) {
      notify('error', `${file.name} is larger than ${formatBytes(maxBytes)}.`)
    } else if (file.size === 0) {
      notify('error', `${file.name} is empty.`)
    } else {
      const panel: Panel = { src: file, x: 0.5, y: 0.5, fixed: true }
      update(i, panel)
      onAdd?.(i, panel)
      void recordAction(`Added image to Panel ${i + 1}`, `Included ${file.name} (${formatBytes(file.size)}) into panel ${i + 1}.`, file)
    }
  }

  function onDrop(e: DragEvent, i: number) {
    e.preventDefault()
    setOver(null)
    if (!disabled) put(i, e.dataTransfer.files[0])
  }

  // Drag a panel: its picture lifts out of the grid and follows the pointer exactly
  // (the cell stays behind, showing the same empty placeholder as an empty panel).
  // Dropping it on another panel swaps the two; dropping it anywhere else puts it back.
  function onDragStart(e: PointerEvent<HTMLImageElement>, i: number) {
    const cell = cells[i]
    if (disabled || !cell) return
    e.preventDefault()
    const img = e.currentTarget
    const cellEl = img.closest('.panel-cell') as HTMLElement | null
    if (!cellEl) return
    const rect = cellEl.getBoundingClientRect()

    setDragging({
      i,
      src: img.src,
      objectPosition: img.style.objectPosition,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    })
    img.setPointerCapture(e.pointerId)
    drag.current = { i, startX: e.clientX, startY: e.clientY }
  }

  function onDragMove(e: PointerEvent<HTMLImageElement>) {
    const d = drag.current
    if (!d) return
    // Cumulative movement from where the drag started (never the per-event delta).
    if (ghost.current) {
      ghost.current.style.transform = `translate(${e.clientX - d.startX}px, ${e.clientY - d.startY}px)`
    }
    const target = cellIndexAt(e.clientX, e.clientY)
    setOver(target !== null && target !== d.i ? target : null)
  }

  function endDrag(e: PointerEvent<HTMLImageElement>, swap: boolean) {
    const d = drag.current
    if (!d) return
    drag.current = null
    setDragging(null)
    setOver(null)

    if (!swap) return
    const target = cellIndexAt(e.clientX, e.clientY)
    if (target === null || target === d.i) return
    const next = [...cells]
    const moved = next[d.i]
    next[d.i] = next[target]
    next[target] = moved
    setPanels(next)
    onSwap?.(d.i, target)
  }

  function onDragEnd(e: PointerEvent<HTMLImageElement>) {
    endDrag(e, true)
  }

  function onDragCancel(e: PointerEvent<HTMLImageElement>) {
    endDrag(e, false)
  }

  // Safety net: if the pointer is released where the picture's own handler cannot see
  // it (outside the window, capture lost), the floating layer still goes away.
  useEffect(() => {
    if (!dragging) return
    const stop = () => {
      drag.current = null
      setDragging(null)
      setOver(null)
    }
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
  }, [dragging])

  function onPanKey(e: KeyboardEvent<HTMLImageElement>, i: number) {
    const cell = cells[i]
    const step = { ArrowLeft: [-0.05, 0], ArrowRight: [0.05, 0], ArrowUp: [0, -0.05], ArrowDown: [0, 0.05] }[e.key]
    if (disabled || !cell || !step) return
    e.preventDefault()
    const next = { ...cell, x: clamp(cell.x + step[0]), y: clamp(cell.y + step[1]) }
    update(i, next)
    onFrame?.(i, next.x, next.y)
  }

  // Boxes in the chosen panel shape, as in the final board. Sizes in rem: the grid
  // aims at ~14rem tall; thin panels (e.g. 9:16 in a 3x1 column) get at least 3.5rem on their short
  // side (room for the "+ image" label), then everything shrinks to fit 36rem wide and 48rem tall.
  const shape = parseRatio(panelAspect) ?? 4 / 3
  let panelH = 14 / rows
  let panelW = panelH * shape
  if (panelW < 3.5) [panelW, panelH] = [3.5, 3.5 / shape]
  if (panelH < 3.5) [panelW, panelH] = [3.5 * shape, 3.5]
  const fit = Math.min(1, 36 / (cols * panelW), 48 / (rows * panelH))
  panelW *= fit
  panelH *= fit
  const gridWidth = cols * panelW + (cols - 1) * 0.4
  // too small for the word: just the "+" (the button keeps its aria-label)
  const compact = Math.min(panelW, panelH) < 3.4
  const fixed = cells.filter((c) => c?.fixed).length
  const generated = cells.filter((c) => c && !c.fixed).length
  return (
    <div className="panel-grid-block">
      <div className="panel-grid"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, maxWidth: `${gridWidth}rem` }}>
        {cells.map((cell, i) => {
          const isDragged = dragging?.i === i
          return (
          <div key={i}
            className={`panel-cell${cell && !isDragged ? ' is-filled' : ''}${cell?.fixed && !isDragged ? ' is-fixed' : ''}${over === i ? ' is-over' : ''}${compact ? ' is-compact' : ''}`}
            style={{ aspectRatio: String(shape) }}
            onDragOver={(e) => { e.preventDefault(); setOver(i) }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => onDrop(e, i)}>
            <span className="panel-number">{i + 1}</span>
            {cell && (
              <>
                <img src={preview(cell.src)} draggable={false} tabIndex={disabled || isDragged ? -1 : 0}
                  className={isDragged ? 'is-lifted' : undefined}
                  alt={`Panel ${i + 1}: ${'name' in cell.src ? cell.src.name : 'generated'}. Drag it onto another panel to swap them; use the arrow keys to move its framing.`}
                  title="Drag onto another panel to swap; arrow keys move the framing"
                  style={{ objectPosition: `${cell.x * 100}% ${cell.y * 100}%` }}
                  onPointerDown={(e) => onDragStart(e, i)}
                  onPointerMove={onDragMove}
                  onPointerUp={onDragEnd}
                  onPointerCancel={onDragCancel}
                  onKeyDown={(e) => onPanKey(e, i)} />
                {!isDragged && (
                  <span className="panel-remove icon solid fa-times" role="button" tabIndex={disabled ? -1 : 0}
                    aria-label={`Remove the image of panel ${i + 1}`} aria-disabled={disabled}
                    onClick={() => { if (!disabled) remove(i) }}
                    onKeyDown={(e) => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); remove(i) } }} />
                )}
              </>
            )}
            {/* The empty placeholder: shown for an empty panel, and under the panel
                being dragged (exactly the same look, so it reads as "the panel is
                lifted off its slot"). */}
            {(!cell || isDragged) && (
              isDragged ? (
                <span className="panel-add" aria-hidden="true" style={{ pointerEvents: 'none' }}>
                  <span className="panel-add-plus" aria-hidden="true">+</span>
                  <span className="panel-add-text">image</span>
                </span>
              ) : (
                <span className="panel-add" role="button" tabIndex={disabled ? -1 : 0}
                  aria-label={`Add an image to panel ${i + 1}`} aria-disabled={disabled}
                  onClick={() => { if (!disabled) { target.current = i; input.current?.click() } }}
                  onKeyDown={(e) => {
                    if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault()
                      target.current = i
                      input.current?.click()
                    }
                  }}>
                  <span className="panel-add-plus" aria-hidden="true">+</span>
                  <span className="panel-add-text">image</span>
                </span>
              )
            )}
          </div>
          )
        })}
      </div>
      <input ref={input} type="file" accept=".png,.jpg,.jpeg,.webp,.gif" hidden
        onChange={(e) => { put(target.current, e.target.files?.[0]); e.target.value = '' }} />
      {/* The floating layer that follows the pointer while a panel is dragged. It is a
          portal, so React removes it with the component (it can never be left behind). */}
      {dragging && createPortal(
        <div ref={ghost} className={`panel-ghost${over !== null ? ' is-swap' : ''}`}
          style={{ left: dragging.rect.left, top: dragging.rect.top, width: dragging.rect.width, height: dragging.rect.height }}
          aria-hidden="true">
          <img src={dragging.src} alt="" style={{ objectPosition: dragging.objectPosition }} />
        </div>,
        document.body,
      )}
      <p className="hint">
        {fixed === 0 && generated === 0
          ? 'Optional: drop your own images in some panels. They go into the storyboard exactly as shown here and the model draws the empty ones.'
          : `${fixed} fixed, ${generated} generated of ${total} panels. Drag a panel onto another to swap them; the arrow keys move its framing.`}
      </p>
    </div>
  )
}
