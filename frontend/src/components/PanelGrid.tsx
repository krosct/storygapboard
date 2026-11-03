import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent } from 'react'
import { fileKind, formatBytes } from '../api'
import { parseLayout, parseRatio, type FixedPanel, type Panels } from '../board'
import type { Notify } from './Toasts'

interface Props {
  layout: string
  /** shape of each panel ("auto" previews 4:3) */
  panelAspect: string
  panels: Panels
  setPanels: (panels: Panels) => void
  maxBytes: number
  disabled: boolean
  notify: Notify
}

const clamp = (n: number) => Math.min(1, Math.max(0, n))

/** How far (in screen pixels) the image overflows its box on each axis when it covers it. */
function overflow(img: HTMLImageElement): [number, number] {
  const box = img.getBoundingClientRect()
  if (!img.naturalWidth || !img.naturalHeight) return [0, 0]
  const scale = Math.max(box.width / img.naturalWidth, box.height / img.naturalHeight)
  return [img.naturalWidth * scale - box.width, img.naturalHeight * scale - box.height]
}

// The storyboard layout as boxes in the chosen panel shape: an image dropped in a
// box fills it exactly as it will in the storyboard (drag it to pick the framing
// when its shape differs); empty boxes are drawn by the model.
export default function PanelGrid({ layout, panelAspect, panels, setPanels, maxBytes, disabled, notify }: Props) {
  const [rows, cols] = parseLayout(layout)
  const total = rows * cols
  const cells = Array.from({ length: total }, (_, i) => panels[i] ?? null)
  const input = useRef<HTMLInputElement>(null)
  const target = useRef(0)
  const [over, setOver] = useState<number | null>(null)
  const drag = useRef<{ i: number; x: number; y: number; start: FixedPanel; room: [number, number] } | null>(null)

  // One preview URL per file (moving the framing must not recreate it).
  const urls = useRef(new Map<File, string>())
  const preview = (file: File) => {
    let url = urls.current.get(file)
    if (!url) {
      url = URL.createObjectURL(file)
      urls.current.set(file, url)
    }
    return url
  }
  useEffect(() => {
    const live = new Set(panels.map((c) => c?.file))
    urls.current.forEach((url, file) => {
      if (!live.has(file)) {
        URL.revokeObjectURL(url)
        urls.current.delete(file)
      }
    })
  }, [panels])
  useEffect(() => () => urls.current.forEach((url) => URL.revokeObjectURL(url)), [])

  function update(i: number, value: FixedPanel | null) {
    const next = [...cells]
    next[i] = value
    setPanels(next)
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
      update(i, { file, x: 0.5, y: 0.5 })
    }
  }

  function onDrop(e: DragEvent, i: number) {
    e.preventDefault()
    setOver(null)
    if (!disabled) put(i, e.dataTransfer.files[0])
  }

  // Drag the image to choose which part shows (like CSS object-position).
  function onPanStart(e: PointerEvent<HTMLImageElement>, i: number) {
    const cell = cells[i]
    if (disabled || !cell) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { i, x: e.clientX, y: e.clientY, start: cell, room: overflow(e.currentTarget) }
  }

  function onPanMove(e: PointerEvent<HTMLImageElement>) {
    const d = drag.current
    if (!d) return
    const [roomX, roomY] = d.room
    update(d.i, {
      ...d.start,
      x: roomX > 0 ? clamp(d.start.x - (e.clientX - d.x) / roomX) : d.start.x,
      y: roomY > 0 ? clamp(d.start.y - (e.clientY - d.y) / roomY) : d.start.y,
    })
  }

  function onPanKey(e: KeyboardEvent<HTMLImageElement>, i: number) {
    const cell = cells[i]
    const step = { ArrowLeft: [-0.05, 0], ArrowRight: [0.05, 0], ArrowUp: [0, -0.05], ArrowDown: [0, 0.05] }[e.key]
    if (disabled || !cell || !step) return
    e.preventDefault()
    update(i, { ...cell, x: clamp(cell.x + step[0]), y: clamp(cell.y + step[1]) })
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
  const fixed = cells.filter(Boolean).length
  return (
    <div className="panel-grid-block">
      <div className="panel-grid"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, maxWidth: `${gridWidth}rem` }}>
        {cells.map((cell, i) => (
          <div key={i}
            className={`panel-cell${cell ? ' is-fixed' : ''}${over === i ? ' is-over' : ''}${compact ? ' is-compact' : ''}`}
            style={{ aspectRatio: String(shape) }}
            onDragOver={(e) => { e.preventDefault(); setOver(i) }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => onDrop(e, i)}>
            <span className="panel-number">{i + 1}</span>
            {cell ? (
              <>
                <img src={preview(cell.file)} draggable={false} tabIndex={disabled ? -1 : 0}
                  alt={`Panel ${i + 1}: ${cell.file.name}. Drag or use the arrow keys to move the framing.`}
                  title="Drag to choose the framing"
                  style={{ objectPosition: `${cell.x * 100}% ${cell.y * 100}%` }}
                  onPointerDown={(e) => onPanStart(e, i)} onPointerMove={onPanMove}
                  onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}
                  onKeyDown={(e) => onPanKey(e, i)} />
                <span className="panel-remove" role="button" tabIndex={disabled ? -1 : 0}
                  aria-label={`Remove the image of panel ${i + 1}`} aria-disabled={disabled}
                  onClick={() => { if (!disabled) update(i, null) }}
                  onKeyDown={(e) => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); update(i, null) } }}>
                  ×
                </span>
              </>
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
            )}
          </div>
        ))}
      </div>
      <input ref={input} type="file" accept=".png,.jpg,.jpeg,.webp,.gif" hidden
        onChange={(e) => { put(target.current, e.target.files?.[0]); e.target.value = '' }} />
      <p className="hint">
        {fixed === 0
          ? 'Optional: drop your own images in some panels. They go into the storyboard exactly as shown here and the model draws the empty ones.'
          : `${fixed} of ${total} panels fixed: they go into the storyboard exactly as shown here (drag an image to move its framing). The model draws the other ${total - fixed}.`}
      </p>
    </div>
  )
}
