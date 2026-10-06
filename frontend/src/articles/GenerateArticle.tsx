import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api, ApiError, formatBytes, type JobResult, type Meta } from '../api'
import type { Notify, ToastKind } from '../components/Toasts'
import RatioPreview from '../components/RatioPreview'
import type { Prefs } from '../prefs'

interface Props {
  meta: Meta | null
  prefs: Prefs
  updatePrefs: (patch: Partial<Prefs>) => void
  prompt: string
  setPrompt: (value: string) => void
  apiKey: string
  files: File[]
  notify: Notify
}

interface Done { info: JobResult; url: string }

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
  const [done, setDone] = useState<Done | null>(null)
  const jobId = useRef<string | null>(null)
  const stopListening = useRef<(() => void) | null>(null)
  const chime = useChime(p.prefs.muted)

  const ratios = p.meta?.aspect_ratios
  const aspectRatio = pick(p.prefs.aspectRatio, ratios, '1:1')
  const layout = pick(p.prefs.layout, p.meta?.layouts, p.meta?.default_layout ?? '2x3')
  const resolution = pick(p.prefs.resolution, p.meta?.resolutions, '1K')
  const outputFormat = pick(p.prefs.outputFormat, p.meta?.output_formats, 'png')
  const maxChars = p.meta?.limits.max_prompt_chars ?? 4000
  const model = p.prefs.model.trim() || p.meta?.default_model || ''

  // Client-side clock (the server only reports status changes).
  useEffect(() => {
    if (!running) return
    const start = performance.now()
    const timer = window.setInterval(() => setElapsed((performance.now() - start) / 1000), 100)
    return () => window.clearInterval(timer)
  }, [running])

  // Release the image blob and the event stream when leaving.
  useEffect(() => () => {
    stopListening.current?.()
  }, [])
  useEffect(() => () => { if (done) URL.revokeObjectURL(done.url) }, [done])

  async function onFinished(id: string, info: JobResult) {
    try {
      const blob = await api.image(id)
      setDone({ info, url: URL.createObjectURL(blob) })
      setStatus({ kind: 'success', text: `Done in ${info.elapsed.toFixed(1)}s.` })
      info.notes.forEach((note) => p.notify('warning', note))
      chime.play('success')
    } catch (e) {
      setStatus({ kind: 'error', text: (e as Error).message })
      chime.play('error')
    } finally {
      setRunning(false)
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (running) return
    if (!p.prompt.trim()) {
      setStatus({ kind: 'error', text: 'Type a prompt first.' })
      return
    }
    if (!p.apiKey.trim()) {
      setStatus({ kind: 'error', text: 'Add your OpenRouter API key in the Model section first.' })
      return
    }
    chime.prime()
    setRunning(true)
    setElapsed(0)
    setDone(null)
    setStatus({ kind: 'info', text: 'Generating…' })
    try {
      const id = await api.generate({
        prompt: p.prompt, model: p.prefs.model.trim(), aspectRatio, layout, resolution, outputFormat,
        seed: seed.trim(), files: p.files, apiKey: p.apiKey.trim(),
      })
      jobId.current = id
      stopListening.current = api.listen(id, (ev) => {
        if (ev.status === 'done') {
          void onFinished(id, ev.result)
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
  return (
    <form onSubmit={onSubmit} noValidate>
      <div className="fields">
        <div className="field">
          <label htmlFor="prompt">Prompt</label>
          <textarea id="prompt" rows={5} value={p.prompt} maxLength={maxChars} disabled={running}
            placeholder="Describe the story… e.g. a red panda astronaut repairs her ship and flies home at sunrise"
            onChange={(e) => p.setPrompt(e.target.value)} />
          <div className="hint align-right">{p.prompt.length}/{maxChars}</div>
        </div>
      </div>

      <div className="fields options">
        <div className="field fifth">
          <label htmlFor="ratio">Ratio</label>
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

      <p className="hint model-note">These are the settings you want. Not every model supports all of them:
        depending on the model, some may be adjusted (e.g. to the closest supported ratio) or ignored.</p>

      <div className="summary-line">
        <span className="ratio-label" title="Aspect ratio preview"><RatioPreview ratio={aspectRatio} />{aspectRatio}</span>
        <span>Storyboard: {layoutTitle(layout)}</span>
        <span>Model: <a href="#model">{model || '…'}</a></span>
        <span>Files: <a href="#files">{fileCount === 0 ? 'none' : `${fileCount} attached`}</a></span>
        <span>Key: <a href="#model" className={p.apiKey.trim() ? 'key-set' : 'key-missing'}>
          {p.apiKey.trim() ? 'set for this tab' : 'missing'}</a></span>
      </div>

      <ul className="actions">
        <li><input type="submit" className="btn-generate" value={running ? 'Generating…' : 'Generate'} disabled={running} /></li>
        <li><input type="button" className="btn-cancel" value="Cancel" disabled={!running} onClick={() => void onCancel()} /></li>
        <li>
          <input type="button" className={`btn-sound ${p.prefs.muted ? 'is-off' : 'is-on'}`}
            value={p.prefs.muted ? 'Sound off' : 'Sound on'}
            aria-pressed={!p.prefs.muted} onClick={() => p.updatePrefs({ muted: !p.prefs.muted })} />
        </li>
      </ul>

      <div className="run-strip" aria-live="polite">
        <span className="elapsed">{elapsed.toFixed(1)}s</span>
        {running && <span className="spinner" aria-hidden="true" />}
        {status && <span className={`status status-${status.kind}`}>{status.text}</span>}
      </div>

      {done && (
        <div className="result">
          <span className="image main"><img src={done.url} alt="Generated image" /></span>
          <p className="hint">
            {done.info.width}×{done.info.height} · {formatBytes(done.info.bytes)}
            {done.info.cost > 0 && <> · ${done.info.cost.toFixed(4)}</>}
            {done.info.seed !== null && <> · seed {done.info.seed}</>}
          </p>
          <ul className="actions">
            <li><a className="button primary icon solid fa-download" href={done.url} download={done.info.filename}>Download</a></li>
            <li><a className="button" href={done.url} target="_blank" rel="noopener noreferrer">Open full size</a></li>
          </ul>
          <p className="hint">Images are never saved on the server (only held briefly in memory): download it before closing this tab.</p>
        </div>
      )}
    </form>
  )
}
