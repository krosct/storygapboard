import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api, ApiError, formatBytes, type JobResult, type Meta } from '../api'
import type { Notify, ToastKind } from '../components/Toasts'
import RatioPreview from '../components/RatioPreview'
import PanelGrid from '../components/PanelGrid'
import PanelEditor, { type PanelEdit } from '../components/PanelEditor'
import { buildMask } from '../marks'
import BoardView from '../components/BoardView'
import Modal from '../components/Modal'
import {
  applySourceEdit, blobExt, canvasToBlob, composeBoard, composeGuide, cropPanel, panelCount, planGeneration,
  renderBoard, type PanelSource, type Panels, type Rect,
} from '../board'
import type { Prefs } from '../prefs'

interface Props {
  meta: Meta | null
  prefs: Prefs
  updatePrefs: (patch: Partial<Prefs>) => void
  prompt: string
  setPrompt: (value: string) => void
  apiKey: string
  files: File[]
  panels: Panels
  setPanels: (panels: Panels) => void
  notify: Notify
}

/** One version of the storyboard (the first generation, then one per retouch; moving a framing updates it in place). */
interface Board {
  blob: Blob
  url: string
  width: number
  height: number
  /** where each panel sits on the board */
  rects: Rect[]
  /** where each panel takes its pixels from (and how it is framed) */
  sources: PanelSource[]
  filename: string
  cost: number
  seed: number | null
}

/** Retouches kept per panel for undo. */
const MAX_HISTORY = 10

/**
 * Retouch history, per panel: each panel undoes and redoes only its own retouches
 * (in its retouch window). The storyboard-wide undo/redo follows `order`, the
 * panels in the order they were retouched, so it always takes back the latest one.
 */
interface History {
  /** per panel: its sources before each retouch, oldest first */
  undo: PanelSource[][]
  /** per panel: retouches taken back, latest last */
  redo: PanelSource[][]
  order: number[]
  redoOrder: number[]
}

const emptyHistory = (panels: number): History => ({
  undo: Array.from({ length: panels }, () => []), redo: Array.from({ length: panels }, () => []), order: [], redoOrder: [],
})

/** `list` without the last occurrence of `value`. */
function dropLast(list: number[], value: number): number[] {
  const at = list.lastIndexOf(value)
  return at < 0 ? list : [...list.slice(0, at), ...list.slice(at + 1)]
}

function layoutTitle(layout: string): string {
  const [rows, cols] = layout.split('x').map(Number)
  if (!rows || !cols) return layout
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  return `${plural(rows, 'row')} × ${plural(cols, 'column')}`
}

function pick(value: string, options: string[] | undefined, fallback: string): string {
  if (!options || options.length === 0) return value || fallback
  return options.includes(value) ? value : options.includes(fallback) ? fallback : options[0]
}

// Short synthesized chime when a generation ends (no audio file needed).
function useChime(muted: boolean) {
  const ctxRef = useRef<AudioContext | null>(null)
  const prime = () => {
    try {
      if (!ctxRef.current) ctxRef.current = new AudioContext()
      if (ctxRef.current.state === 'suspended') void ctxRef.current.resume()
    } catch {
      ctxRef.current = null
    }
  }
  const play = (kind: 'success' | 'error') => {
    const ctx = ctxRef.current
    if (muted || !ctx) return
    try {
      const notes = kind === 'success' ? [659.25, 880.0] : [220.0, 164.81]
      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        const t0 = ctx.currentTime + i * 0.16
        osc.type = 'sine'
        osc.frequency.value = freq
        gain.gain.setValueAtTime(0.0001, t0)
        gain.gain.exponentialRampToValueAtTime(0.2, t0 + 0.03)
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3)
        osc.connect(gain).connect(ctx.destination)
        osc.start(t0)
        osc.stop(t0 + 0.32)
      })
    } catch {
      /* sound is best effort */
    }
  }
  return { prime, play }
}

export default function GenerateArticle(p: Props) {
  const [running, setRunning] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [status, setStatus] = useState<{ kind: ToastKind; text: string } | null>(null)
  const [seed, setSeed] = useState('')
  const [board, setBoard] = useState<Board | null>(null)
  const [history, setHistory] = useState<History>(() => emptyHistory(0))
  const [editing, setEditing] = useState<{ index: number; panel: HTMLCanvasElement } | null>(null)
  const [confirmReplace, setConfirmReplace] = useState(false)
  const editingRef = useRef(editing)
  editingRef.current = editing
  const jobId = useRef<string | null>(null)
  const stopListening = useRef<(() => void) | null>(null)
  const chime = useChime(p.prefs.muted)

  const ratios = p.meta?.aspect_ratios
  const aspectRatio = pick(p.prefs.aspectRatio, ratios, '1:1')
  const layout = pick(p.prefs.layout, p.meta?.layouts, p.meta?.default_layout ?? '2x3')
  const resolution = pick(p.prefs.resolution, p.meta?.resolutions, '1K')
  const outputFormat = pick(p.prefs.outputFormat, p.meta?.output_formats, 'png')
  const maxChars = p.meta?.limits.max_prompt_chars ?? 4000
  const maxBytes = p.meta?.limits.max_file_bytes ?? 5 * 1024 * 1024
  const provider = p.prefs.provider
  const providerInfo = p.meta?.providers.find((x) => x.id === provider)
  const providerLabel = providerInfo?.label ?? (provider === 'openai' ? 'OpenAI' : 'OpenRouter')
  // the model typed for this provider (empty = the provider's default, picked by the server)
  const chosenModel = (provider === 'openai' ? p.prefs.openaiModel : p.prefs.model).trim()
  const model = chosenModel || providerInfo?.default_model || ''
  const keyMissing = `Add your ${providerLabel} API key in the Model section first.`
  // development only: simulated images, nothing is sent to a provider
  const fakeModel = p.meta?.fake_model === true
  // Ratio = shape of each panel; the model gets the grid and ratio that suit it best.
  const plan = planGeneration(layout, aspectRatio, p.meta?.layouts ?? [layout], p.meta?.board_ratios ?? ratios ?? [])
  // the latest state for queued work (board redraws are chained, see `queue`)
  const latestBoard = useRef<Board | null>(null)
  latestBoard.current = board
  const latestHistory = useRef(history)
  latestHistory.current = history
  const cells = Array.from({ length: panelCount(layout) }, (_, i) => p.panels[i] ?? null)

  // Client-side clock (the server only reports status changes).
  useEffect(() => {
    if (!running) return
    const start = performance.now()
    const timer = window.setInterval(() => setElapsed((performance.now() - start) / 1000), 100)
    return () => window.clearInterval(timer)
  }, [running])

  // Release the event stream when leaving.
  useEffect(() => () => {
    stopListening.current?.()
  }, [])

  // Only the current board has an object URL: release each one when it is replaced (and on leave).
  const boardUrl = board?.url
  useEffect(() => () => { if (boardUrl) URL.revokeObjectURL(boardUrl) }, [boardUrl])

  function showBoard(next: Board, nextHistory: History = latestHistory.current) {
    latestBoard.current = next
    latestHistory.current = nextHistory
    setBoard(next)
    setHistory(nextHistory)
  }

  // Board changes (retouch, undo, redo, framing) run one after the other, each on the latest board.
  // An error reaches the caller (a retouch reports it in its own status); report=true shows it here.
  const work = useRef(Promise.resolve())
  function queue(task: () => Promise<void>, report = true): Promise<void> {
    const run = work.current.then(task)
    work.current = run.catch(() => undefined)
    if (report) run.catch((e: Error) => setStatus({ kind: 'error', text: e.message }))
    return run
  }

  function boardFrom(blob: Blob, filename: string, base: Omit<Board, 'blob' | 'url' | 'filename'>): Board {
    const stem = filename.replace(/\.[a-z]+$/, '')
    return { ...base, blob, url: URL.createObjectURL(blob), filename: `${stem}.${blobExt(blob)}` }
  }

  /** Start a job and follow it; `finish` turns the result into the next board. */
  async function runJob(start: () => Promise<string>, label: string,
    finish: (blob: Blob, info: JobResult, id: string) => Promise<void>) {
    chime.prime()
    setRunning(true)
    setElapsed(0)
    const startedAt = performance.now()
    setStatus({ kind: 'info', text: label })
    try {
      const id = await start()
      jobId.current = id
      stopListening.current = api.listen(id, (ev) => {
        if (ev.status === 'done') {
          void (async () => {
            try {
              await finish(await api.image(id), ev.result, id)
              // one line: the whole wait in the browser, then the model's own time (measured by the server)
              const total = (performance.now() - startedAt) / 1000
              setStatus({ kind: 'success', text: `Done in ${total.toFixed(1)}s (created in ${ev.result.elapsed.toFixed(1)}s)` })
              ev.result.notes.forEach((note) => p.notify('warning', note))
              chime.play('success')
            } catch (e) {
              setStatus({ kind: 'error', text: (e as Error).message })
              chime.play('error')
            } finally {
              setRunning(false)
            }
          })()
        } else if (ev.status === 'cancelled') {
          setRunning(false)
          setStatus({ kind: 'warning', text: 'Cancelled.' })
        } else if (ev.status === 'error') {
          setRunning(false)
          setStatus({ kind: 'error', text: ev.error })
          chime.play('error')
        }
      })
    } catch (err) {
      setRunning(false)
      const error = err as ApiError
      const wait = error.retryAfter ? ` Try again in ${error.retryAfter}s.` : ''
      setStatus({ kind: 'error', text: error.message + (error.message.includes('Try again') ? '' : wait) })
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (running) return
    // a storyboard is on screen: a new one replaces it, so ask first (in-page, never confirm())
    if (board) {
      setConfirmReplace(true)
      return
    }
    await generate()
  }

  async function generate() {
    setConfirmReplace(false)
    if (running) return
    if (!p.apiKey.trim() && !fakeModel) {
      setStatus({ kind: 'error', text: keyMissing })
      return
    }
    const fixedPanels = cells.flatMap((file, i) => (file ? [i + 1] : []))
    if (fixedPanels.length === cells.length) {
      setStatus({ kind: 'error', text: 'Leave at least one panel empty for the model to draw.' })
      return
    }
    const snapshot = { plan, cells: [...cells], format: outputFormat }
    setEditing(null)
    await runJob(async () => {
      const guide = fixedPanels.length ? await composeGuide(plan, cells) : null
      return api.generate({
        provider, prompt: p.prompt, model: chosenModel, aspectRatio: plan.boardAspect, layout: plan.genLayout,
        resolution, outputFormat, seed: seed.trim(), files: p.files, apiKey: p.apiKey.trim(), fixedPanels, guide,
      })
    }, 'Generating…', async (blob, info, id) => {
      const layout = await composeBoard(blob, snapshot.plan, snapshot.cells)
      const composed = await renderBoard(layout, layout.sources, snapshot.format)
      debugSave(id, [{ name: 'board.png', blob: composed }], {
        plan: snapshot.plan, board: { width: layout.width, height: layout.height }, rects: layout.rects,
        // where each panel was taken from (generated ones: the cell cut from the model's answer)
        sources: layout.sources.map((src, i) => ({ panel: i + 1, own: snapshot.cells[i] !== null, rect: src.rect })),
      })
      showBoard(boardFrom(composed, info.filename, { ...layout, cost: info.cost, seed: info.seed }),
        emptyHistory(layout.rects.length))
    })
  }

  async function openEditor(index: number) {
    if (!board || running) return
    try {
      setEditing({ index, panel: await cropPanel(board.blob, board.rects[index]) })
      setStatus(null)   // the window shows its own progress; the last run's message does not apply
    } catch (e) {
      setStatus({ kind: 'error', text: (e as Error).message })
    }
  }

  async function onEdit(edit: PanelEdit) {
    if (!board || !editing || running) return
    if (!p.apiKey.trim() && !fakeModel) {
      setStatus({ kind: 'error', text: keyMissing })
      return
    }
    const { index } = editing
    await runJob(() => api.edit({
      provider, instruction: edit.instruction, model: chosenModel, resolution, outputFormat,
      panel: edit.panel, marked: edit.marked, area: edit.area, markColor: edit.color, apiKey: p.apiKey.trim(),
    }), `Retouching panel ${index + 1}…`, (blob, info, id) => queue(async () => {
      const base = latestBoard.current
      if (!base) return
      const rect = base.rects[index]
      const sources = [...base.sources]
      const blended = await applySourceEdit(base.sources[index], rect.w, rect.h, blob, edit.mask,
        buildMask(edit.shapes, rect.w, rect.h, 'loose'))
      sources[index] = blended.source
      const next = boardFrom(await renderBoard(base, sources, outputFormat), base.filename,
        { ...base, sources, cost: base.cost + info.cost })
      // this panel's history: the source before, a fresh redo; the others are untouched
      const h = latestHistory.current
      const undo = h.undo.map((list, i) => (i === index ? [...list, base.sources[index]] : list))
      let order = [...h.order, index]
      if (undo[index].length > MAX_HISTORY) {
        undo[index] = undo[index].slice(1)
        order = order.filter((v, at) => v !== index || at !== order.indexOf(index))
      }
      showBoard(next, {
        undo, order,
        redo: h.redo.map((list, i) => (i === index ? [] : list)),
        redoOrder: h.redoOrder.filter((v) => v !== index),
      })
      const panelAfter = await cropPanel(next.blob, next.rects[index])
      setEditing({ index, panel: panelAfter })
      debugSave(id, [
        { name: 'mask.png', blob: await canvasToBlob(edit.mask, 'png') },
        { name: 'panel-sent.jpg', blob: edit.panel },
        { name: 'panel-after.png', blob: await canvasToBlob(panelAfter, 'png') },
      ], {
        panel: index + 1, size: [rect.w, rect.h], shift_px: blended.shift.map((v) => Math.round(v * 10) / 10),
        // the marks as drawn (panel px), to rebuild or check the mask
        shapes: edit.shapes,
      })
    }, false))
  }

  /**
   * Take back (or bring back) the latest retouch of one panel. The panel keeps its
   * current framing; the other panels do not change. An open retouch window follows.
   */
  function stepPanel(index: number, back: boolean) {
    return queue(async () => {
      const base = latestBoard.current
      const h = latestHistory.current
      const from = back ? h.undo[index] : h.redo[index]
      if (!base || !from?.length) return
      const current = base.sources[index]
      const restored = from[from.length - 1]
      const sources = [...base.sources]
      sources[index] = { ...restored, x: current.x, y: current.y }
      const next = boardFrom(await renderBoard(base, sources, outputFormat), base.filename, { ...base, sources })
      const popped = (lists: PanelSource[][]) => lists.map((list, i) => (i === index ? list.slice(0, -1) : list))
      const pushed = (lists: PanelSource[][]) => lists.map((list, i) => (i === index ? [...list, current] : list))
      showBoard(next, back
        ? { undo: popped(h.undo), redo: pushed(h.redo), order: dropLast(h.order, index), redoOrder: [...h.redoOrder, index] }
        : { undo: pushed(h.undo), redo: popped(h.redo), order: [...h.order, index], redoOrder: dropLast(h.redoOrder, index) })
      if (editingRef.current?.index === index) setEditing({ index, panel: await cropPanel(next.blob, next.rects[index]) })
    })
  }

  // storyboard-wide: the latest retouch, whatever the panel
  const undoLatest = () => { const i = history.order.at(-1); if (i !== undefined && !running) void stepPanel(i, true) }
  const redoLatest = () => { const i = history.redoOrder.at(-1); if (i !== undefined && !running) void stepPanel(i, false) }

  // Moving a framing redraws the current board in place (no model call, not a retouch).
  function onFrame(index: number, x: number, y: number) {
    void queue(async () => {
      const base = latestBoard.current
      if (!base) return
      const sources = [...base.sources]
      sources[index] = { ...sources[index], x, y }
      showBoard(boardFrom(await renderBoard(base, sources, outputFormat), base.filename, { ...base, sources }))
    })
  }

  /** Development only (meta.debug): post what the browser made of a job to the server's debug dump. */
  function debugSave(id: string, files: { name: string; blob: Blob }[], note: unknown) {
    if (!p.meta?.debug) return
    api.debug(id, files, note).catch((e: Error) => console.warn('debug dump:', e.message))
  }

  function saveBlob(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 10000)
  }

  async function downloadPanel(index: number) {
    if (!board) return
    try {
      const blob = await canvasToBlob(await cropPanel(board.blob, board.rects[index]), outputFormat)
      saveBlob(blob, `${board.filename.replace(/\.[a-z]+$/, '')}_panel-${index + 1}.${blobExt(blob)}`)
    } catch (e) {
      setStatus({ kind: 'error', text: (e as Error).message })
    }
  }

  async function onCancel() {
    if (!jobId.current || !running) return
    setStatus({ kind: 'info', text: 'Cancelling…' })
    try {
      await api.cancel(jobId.current)
    } catch (e) {
      setStatus({ kind: 'error', text: (e as Error).message })
    }
  }

  const fileCount = p.files.length
  const fixedCount = cells.filter(Boolean).length
  return (
    <form onSubmit={onSubmit} noValidate>
      <div className="fields">
        <div className="field">
          <label htmlFor="prompt">Prompt (optional)</label>
          <textarea id="prompt" rows={5} value={p.prompt} maxLength={maxChars} disabled={running}
            placeholder="Optional: describe the story or add details… e.g. a red panda astronaut repairs her ship and flies home at sunrise. Leave it empty and the model completes the story from your panels."
            onChange={(e) => p.setPrompt(e.target.value)} />
          <div className="hint align-right">{p.prompt.length}/{maxChars}</div>
        </div>
      </div>

      <div className="fields options">
        <div className="field fifth">
          <label htmlFor="ratio" title="Shape of each panel">Ratio</label>
          <select id="ratio" value={aspectRatio} disabled={running}
            onChange={(e) => p.updatePrefs({ aspectRatio: e.target.value })}>
            {(ratios ?? [aspectRatio]).map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="field fifth">
          <label htmlFor="layout" title="Storyboard grid: rows x columns (2x3 = 2 rows, 3 columns)">Layout</label>
          <select id="layout" value={layout} disabled={running} title={layoutTitle(layout)}
            onChange={(e) => p.updatePrefs({ layout: e.target.value })}>
            {(p.meta?.layouts ?? [layout]).map((l) => <option key={l} value={l} title={layoutTitle(l)}>{l}</option>)}
          </select>
        </div>
        <div className="field fifth">
          <label htmlFor="resolution">Size</label>
          <select id="resolution" value={resolution} disabled={running}
            onChange={(e) => p.updatePrefs({ resolution: e.target.value })}>
            {(p.meta?.resolutions ?? [resolution]).map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="field fifth">
          <label htmlFor="format">Format</label>
          <select id="format" value={outputFormat} disabled={running}
            onChange={(e) => p.updatePrefs({ outputFormat: e.target.value })}>
            {(p.meta?.output_formats ?? [outputFormat]).map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
        <div className="field fifth">
          <label htmlFor="seed">Seed</label>
          <input id="seed" type="text" inputMode="numeric" autoComplete="off" placeholder="random"
            value={seed} disabled={running} maxLength={10}
            onChange={(e) => { if (/^[0-9]*$/.test(e.target.value)) setSeed(e.target.value) }} />
        </div>
      </div>

      <p className="hint model-note">Ratio is the shape of each panel. These are the settings you want. Not every model supports all of them:
        depending on the model, some may be adjusted (e.g. to the closest supported ratio) or ignored.</p>

      <label>Panels</label>
      <PanelGrid layout={layout} panelAspect={aspectRatio} panels={cells} setPanels={p.setPanels}
        maxBytes={maxBytes} disabled={running} notify={p.notify} />

      <div className="summary-line">
        <span className="ratio-label" title="Panel shape preview"><RatioPreview ratio={aspectRatio} />Panels {aspectRatio}</span>
        <span>Storyboard: {layoutTitle(layout)}{fixedCount > 0 && `, ${fixedCount} fixed`}</span>
        {fakeModel
          ? <span className="fake-model" title="DEBUG_FAKE_MODEL is on: no provider is called">Model: simulated (development)</span>
          : <span>Model: <a href="#model">{providerLabel} · {model || '…'}</a></span>}
        <span>Files: <a href="#files">{fileCount === 0 ? 'none' : `${fileCount} attached`}</a></span>
        {!fakeModel && (
          <span>Key: <a href="#model" className={p.apiKey.trim() ? 'key-set' : 'key-missing'}>
            {p.apiKey.trim() ? 'set for this tab' : 'missing'}</a></span>
        )}
      </div>

      <ul className="actions fixed">
        <li><input type="submit" className="btn-generate" value={running ? 'Working…' : 'Generate'} disabled={running} /></li>
        <li><input type="button" className="btn-cancel" value="Cancel" disabled={!running} onClick={() => void onCancel()} /></li>
        <li>
          <button type="button"
            className={`btn-sound icon-only icon solid ${p.prefs.muted ? 'fa-volume-mute is-off' : 'fa-volume-up is-on'}`}
            aria-label="Sound when a generation ends" title={p.prefs.muted ? 'Sound off' : 'Sound on'}
            aria-pressed={!p.prefs.muted} onClick={() => p.updatePrefs({ muted: !p.prefs.muted })} />
        </li>
      </ul>

      <div className="run-strip" aria-live="polite">
        {running && <span className="elapsed">{elapsed.toFixed(1)}s</span>}
        {running && <span className="spinner" aria-hidden="true" />}
        {status && <span className={`status status-${status.kind}`}>{status.text}</span>}
      </div>

      {board && (
        <div className="result">
          <h2 className="major">StoryGaplessBoard</h2>
          <BoardView url={board.url} width={board.width} height={board.height} rects={board.rects}
            sources={board.sources} editing={editing?.index ?? null} running={running}
            onRetouch={(i) => void openEditor(i)} onDownload={(i) => void downloadPanel(i)} onFrame={onFrame} />
          <p className="hint">
            {board.width}×{board.height} · {formatBytes(board.blob.size)}
            {board.cost > 0 && <> · ${board.cost.toFixed(4)}</>}
            {board.seed !== null && <> · seed {board.seed}</>}
            {history.order.length > 0 && <> · {history.order.length} retouch{history.order.length > 1 ? 'es' : ''}</>}
          </p>
          <p className="hint board-help">Drag a panel to move its framing. On each panel: the pencil retouches a detail,
            the arrow downloads that panel alone.</p>

          {confirmReplace && (
            <Modal title="Replace the storyboard?" busy={false} small onClose={() => setConfirmReplace(false)}>
              <p>The current one will be lost.</p>
              <ul className="actions fixed">
                <li><button type="button" className="primary" onClick={() => void generate()}>Generate</button></li>
                <li><button type="button" onClick={() => setConfirmReplace(false)}>Cancel</button></li>
                <li>
                  <a className="button icon-only icon solid fa-download" href={board.url} download={board.filename}
                    aria-label="Download the current storyboard first" title="Download the current storyboard first" />
                </li>
              </ul>
            </Modal>
          )}

          {editing && (
            <PanelEditor key={editing.index} number={editing.index + 1} panel={editing.panel}
              running={running} elapsed={elapsed} status={status} maxChars={maxChars}
              canUndo={(history.undo[editing.index]?.length ?? 0) > 0}
              canRedo={(history.redo[editing.index]?.length ?? 0) > 0}
              onApply={(edit) => void onEdit(edit)} onCancel={() => void onCancel()}
              onUndo={() => void stepPanel(editing.index, true)} onRedo={() => void stepPanel(editing.index, false)}
              onClose={() => setEditing(null)} />
          )}

          <ul className="actions fixed">
            <li>
              <button type="button" className="icon-only icon solid fa-undo" aria-label="Undo retouch" title="Undo retouch"
                disabled={running || history.order.length === 0} onClick={undoLatest} />
            </li>
            <li>
              <button type="button" className="icon-only icon solid fa-redo" aria-label="Redo retouch" title="Redo retouch"
                disabled={running || history.redoOrder.length === 0} onClick={redoLatest} />
            </li>
            <li>
              <a className="button icon-only icon solid fa-eye" href={board.url} target="_blank" rel="noopener noreferrer"
                aria-label="Open full size" title="Open full size" />
            </li>
            <li><a className="button primary icon solid fa-download" href={board.url} download={board.filename}>Download</a></li>
          </ul>
          <p className="hint">Images are never saved on the server (only held briefly in memory): download it before closing this tab.</p>
        </div>
      )}
    </form>
  )
}
