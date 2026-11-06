import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { canvasToBlob } from '../board'
import {
  BLENDS, BRUSHES, buildMask, drawMarks, MARK_COLORS, markArea, pickMarkColor, type Blend, type MarkColor, type Shape,
} from '../marks'
import Modal, { ModalCloseButton } from './Modal'

export interface PanelEdit {
  panel: Blob
  marked: Blob
  mask: HTMLCanvasElement
  instruction: string
  /** bounding box of the marks, in % of the panel: [left, top, right, bottom] */
  area: [number, number, number, number]
  color: MarkColor
  /** the marks, to measure the model's drift outside them before blending */
  shapes: Shape[]
}

interface Props {
  number: number
  /** the panel's box on screen: the window grows out of it */
  from?: DOMRect
  panel: HTMLCanvasElement
  /** the panel before its latest retouch: when there is one, a divider compares it with the current one */
  before?: HTMLCanvasElement | null
  running: boolean
  elapsed: number
  status: { kind: string; text: string } | null
  maxChars: number
  canUndo: boolean
  canRedo: boolean
  onApply: (edit: PanelEdit) => void
  onCancel: () => void
  onUndo: () => void
  onRedo: () => void
  onClose: () => void
}

// Retouch one panel: mark the area with a brush or a circle, describe the change.
export default function PanelEditor(p: Props) {
  const { number, panel, running, maxChars } = p
  const view = useRef<HTMLCanvasElement>(null)
  const [tool, setTool] = useState<'brush' | 'circle' | 'rect'>('brush')
  const [brush, setBrush] = useState<keyof typeof BRUSHES>('medium')
  // the thickness menu under the brush button, closed by a pick or a click elsewhere
  const [sizesOpen, setSizesOpen] = useState(false)
  const brushTool = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!sizesOpen) return
    const away = (e: Event) => { if (!brushTool.current?.contains(e.target as Node)) setSizesOpen(false) }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [sizesOpen])
  // before/after divider: what is left of the line is the version before the latest retouch
  const [split, setSplit] = useState(50)
  const stage = useRef<HTMLDivElement>(null)
  const beforeView = useRef<HTMLCanvasElement>(null)
  const splitting = useRef(false)
  const moveSplit = (clientX: number) => {
    const box = view.current?.getBoundingClientRect()
    if (box && box.width) setSplit(Math.min(100, Math.max(0, ((clientX - box.left) / box.width) * 100)))
  }
  const onSplitKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 2
    if (e.key === 'ArrowLeft') setSplit((v) => Math.max(0, v - step))
    else if (e.key === 'ArrowRight') setSplit((v) => Math.min(100, v + step))
    else if (e.key === 'Home') setSplit(0)
    else if (e.key === 'End') setSplit(100)
    else return
    e.preventDefault()
  }
  const [shapes, setShapes] = useState<Shape[]>([])
  const [draft, setDraft] = useState<Shape | null>(null)
  const [instruction, setInstruction] = useState('')
  const [blend, setBlend] = useState<Blend>('loose')
  // the color that stands out most on this panel; the visitor can change it
  const [color, setColor] = useState<MarkColor>(() => pickMarkColor(panel))
  // mirrors draft for the pointer handlers (state updaters must stay pure)
  const draftRef = useRef<Shape | null>(null)
  const changeDraft = (next: Shape | null) => { draftRef.current = next; setDraft(next) }

  const before = p.before
  // a new retouch starts the comparison from the middle again
  useEffect(() => { setSplit(50) }, [before])
  useEffect(() => {
    const el = beforeView.current
    const ctx = el?.getContext('2d')
    if (!el || !ctx || !before) return
    ctx.clearRect(0, 0, el.width, el.height)
    ctx.drawImage(before, 0, 0, el.width, el.height)
  }, [before, panel])

  // A new version of the panel (after a retouch or an undo): start from clean marks.
  useEffect(() => { setShapes([]); changeDraft(null) }, [panel])

  useEffect(() => {
    const el = view.current
    const ctx = el?.getContext('2d')
    if (!el || !ctx) return
    ctx.clearRect(0, 0, el.width, el.height)
    ctx.drawImage(panel, 0, 0)
    const all = draft ? [...shapes, draft] : shapes
    drawMarks(ctx, all, el.width, el.height, color)
    // Preview of what may change: everything else is darkened (the screen only, never what is sent).
    // It follows "Changing area", so the reach of each option shows right away.
    if (all.length > 0 && blend !== 'panel') {
      const dim = document.createElement('canvas')
      dim.width = el.width
      dim.height = el.height
      const dctx = dim.getContext('2d')
      if (dctx) {
        dctx.fillStyle = 'rgba(0, 0, 0, 0.6)'
        dctx.fillRect(0, 0, el.width, el.height)
        dctx.globalCompositeOperation = 'destination-out'
        dctx.drawImage(buildMask(all, el.width, el.height, blend), 0, 0)
        ctx.drawImage(dim, 0, 0)
      }
    }
  }, [panel, shapes, draft, color, blend])

  function point(e: PointerEvent<HTMLCanvasElement>): [number, number] {
    const box = e.currentTarget.getBoundingClientRect()
    return [(e.clientX - box.left) * (panel.width / box.width), (e.clientY - box.top) * (panel.height / box.height)]
  }

  function onDown(e: PointerEvent<HTMLCanvasElement>) {
    if (running) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const [x, y] = point(e)
    const size = Math.max(4, Math.round(Math.min(panel.width, panel.height) * BRUSHES[brush]))
    changeDraft(tool === 'brush' ? { kind: 'brush', size, points: [[x, y]] } : { kind: tool, x0: x, y0: y, x1: x, y1: y })
  }

  function onMove(e: PointerEvent<HTMLCanvasElement>) {
    const d = draftRef.current
    if (!d) return
    const [x, y] = point(e)
    changeDraft(d.kind === 'brush' ? { ...d, points: [...d.points, [x, y]] } : { ...d, x1: x, y1: y })
  }

  function onUp() {
    const d = draftRef.current
    if (!d) return
    changeDraft(null)
    setShapes((s) => [...s, d])
  }

  async function apply() {
    const marked = document.createElement('canvas')
    marked.width = panel.width
    marked.height = panel.height
    const ctx = marked.getContext('2d')
    if (!ctx) return
    ctx.drawImage(panel, 0, 0)
    drawMarks(ctx, shapes, panel.width, panel.height, color)
    p.onApply({
      panel: await canvasToBlob(panel, 'jpeg'),
      marked: await canvasToBlob(marked, 'jpeg'),
      mask: buildMask(shapes, panel.width, panel.height, blend),
      instruction: instruction.trim(),
      area: markArea(shapes, panel.width, panel.height),
      color,
      shapes,
    })
  }

  const ready = shapes.length > 0 && instruction.trim().length > 0 && !running
  return (
    <Modal title={`Retouch panel ${number}`} busy={running} onClose={p.onClose} from={p.from}>
      <p className="hint">Mark it, say what to change: only the lit part changes.</p>
      <div className="editor-tools">
        {([
          ['circle', 'icon fa-circle', 'Circle: everything inside'],
          ['rect', 'icon fa-square', 'Rectangle: everything inside'],
        ] as const).map(([name, icon, label]) => (
          <button key={name} type="button" className={`tool-btn ${icon}${tool === name ? ' primary' : ''}`}
            aria-pressed={tool === name} aria-label={label} title={label}
            disabled={running} onClick={() => { setTool(name); setSizesOpen(false) }} />
        ))}
        {/* the brush is also a menu: picking it (or clicking it again) drops the thickness choice */}
        <span className="brush-tool" ref={brushTool}>
          <button type="button" className={`tool-btn icon solid fa-paint-brush${tool === 'brush' ? ' primary' : ''}`}
            aria-pressed={tool === 'brush'} aria-haspopup="true" aria-expanded={sizesOpen}
            aria-label={`Brush: only what you paint (${brush} line)`} title="Brush: only what you paint"
            disabled={running} onClick={() => { setSizesOpen(tool !== 'brush' || !sizesOpen); setTool('brush') }}>
            <span className={`brush-badge size-${brush}`} aria-hidden="true" />
          </button>
          {sizesOpen && (
            <span className="brush-sizes" role="radiogroup" aria-label="Brush thickness">
              {(['small', 'medium', 'large'] as const).map((size) => (
                <span key={size} role="radio" aria-checked={brush === size} aria-label={`${size} line`}
                  title={`${size[0].toUpperCase()}${size.slice(1)} line`} tabIndex={0}
                  className={`brush-size size-${size}${brush === size ? ' is-on' : ''}`}
                  onClick={() => { setBrush(size); setSizesOpen(false) }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setBrush(size); setSizesOpen(false) } }}>
                  <span className="brush-line" />
                </span>
              ))}
            </span>
          )}
        </span>
        <button type="button" className="tool-btn icon solid fa-undo-alt" aria-label="Undo the last mark"
          title="Undo the last mark" disabled={shapes.length === 0 || running}
          onClick={() => setShapes((s) => s.slice(0, -1))} />
        <button type="button" className="tool-btn icon solid fa-eraser" aria-label="Clear all marks"
          title="Clear all marks" disabled={shapes.length === 0 || running} onClick={() => setShapes([])} />
        <span className="mark-colors" role="radiogroup" aria-label="Mark color">
          {(Object.keys(MARK_COLORS) as MarkColor[]).map((name) => (
            <span key={name} role="radio" aria-checked={color === name} aria-label={`${name} marks`} title={`${name} marks`}
              tabIndex={running ? -1 : 0} className={`mark-color${color === name ? ' is-on' : ''}`}
              style={{ backgroundColor: MARK_COLORS[name] }}
              onClick={() => { if (!running) setColor(name) }}
              onKeyDown={(e) => { if (!running && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setColor(name) } }} />
          ))}
        </span>
      </div>
      <div ref={stage} className={`editor-stage${running ? ' is-running' : ''}`}>
        <div className="editor-wrap">
          <canvas ref={view} className="editor-canvas" width={panel.width} height={panel.height}
            aria-label={`Panel ${number}: draw on it to mark the area to change`}
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
          {before && (
            <>
              <canvas ref={beforeView} className="editor-before" width={panel.width} height={panel.height} aria-hidden="true"
                style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }} />
              <span className="compare-tag is-before" style={{ opacity: split > 14 ? 1 : 0 }}>Before</span>
              <span className="compare-tag is-after" style={{ opacity: split < 86 ? 1 : 0 }}>Now</span>
              <span className="compare-divider" style={{ left: `${split}%` }} role="slider" tabIndex={0}
                aria-label="Compare before and after the latest retouch" aria-orientation="horizontal"
                aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(split)}
                aria-valuetext={`${Math.round(split)}% before`}
                onKeyDown={onSplitKey}
                onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); splitting.current = true; moveSplit(e.clientX) }}
                onPointerMove={(e) => { if (splitting.current) moveSplit(e.clientX) }}
                onPointerUp={() => { splitting.current = false }} onPointerCancel={() => { splitting.current = false }}>
                <span className="compare-handle icon solid fa-arrows-alt-h" aria-hidden="true" />
              </span>
            </>
          )}
        </div>
        {running && (
          <div className="editor-progress" aria-hidden="true">
            <span className="spinner" />
            <span>{p.elapsed.toFixed(1)}s</span>
          </div>
        )}
      </div>
      <div className="fields editor-fields">
        <div className="field">
          <label htmlFor="edit-instruction">Change</label>
          <input id="edit-instruction" type="text" autoComplete="off" maxLength={maxChars} disabled={running}
            placeholder="e.g. spiky punk hair standing up, a blue scarf, remove the lamp"
            value={instruction} onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (ready) void apply() } }} />
        </div>
        <div className="field">
          <label htmlFor="edit-blend">Changing area</label>
          <select id="edit-blend" value={blend} disabled={running} onChange={(e) => setBlend(e.target.value as Blend)}>
            {(Object.keys(BLENDS) as Blend[]).map((key) => <option key={key} value={key}>{BLENDS[key].label}</option>)}
          </select>
        </div>
      </div>
      <p className="hint">Bigger changes need room: widen the changing area.</p>
      <div className="run-strip" aria-live="polite">
        {running && <span className="spinner" aria-hidden="true" />}
        {p.status && <span className={`status status-${p.status.kind}`}>{p.status.text}</span>}
      </div>
      <ul className="actions fixed">
        {running
          ? <li><button type="button" className="btn-cancel" onClick={p.onCancel}>Cancel</button></li>
          : <li><button type="button" className="primary" disabled={!ready} onClick={() => void apply()}>Apply edit</button></li>}
        <li>
          <button type="button" className="icon-only icon solid fa-undo" aria-label="Undo this panel's last retouch"
            title="Undo this panel's last retouch" disabled={running || !p.canUndo} onClick={p.onUndo} />
        </li>
        <li>
          <button type="button" className="icon-only icon solid fa-redo" aria-label="Redo this panel's retouch"
            title="Redo this panel's retouch" disabled={running || !p.canRedo} onClick={p.onRedo} />
        </li>
        <li><ModalCloseButton disabled={running}>Done</ModalCloseButton></li>
      </ul>
    </Modal>
  )
}
