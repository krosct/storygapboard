// Non-secret preferences remembered in this browser. The API key, prompt and
// files are never stored.
import { DEFAULT_FRAME, sanitizeFrame, type FrameStyle } from './frame'

export type Provider = 'openrouter' | 'openai'

export interface Prefs {
  provider: Provider
  /** OpenRouter model (empty = default) */
  model: string
  /** OpenAI model (empty = default) */
  openaiModel: string
  aspectRatio: string
  layout: string
  resolution: string
  outputFormat: string
  muted: boolean
  /** the storyboard's look (Frame tab); the title is never remembered */
  frame: FrameStyle
}

const KEY = 'storygapboard.prefs'
const DEFAULTS: Prefs = { provider: 'openrouter', model: '', openaiModel: '', aspectRatio: '1:1', layout: '2x3', resolution: '1K', outputFormat: 'png', muted: false, frame: DEFAULT_FRAME }

export function loadPrefs(): Prefs {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return DEFAULTS
    const data = JSON.parse(raw) as Partial<Prefs>
    return {
      provider: data.provider === 'openai' ? 'openai' : 'openrouter',
      model: typeof data.model === 'string' ? data.model.slice(0, 128) : DEFAULTS.model,
      openaiModel: typeof data.openaiModel === 'string' ? data.openaiModel.slice(0, 128) : DEFAULTS.openaiModel,
      aspectRatio: typeof data.aspectRatio === 'string' ? data.aspectRatio : DEFAULTS.aspectRatio,
      layout: typeof data.layout === 'string' ? data.layout : DEFAULTS.layout,
      resolution: typeof data.resolution === 'string' ? data.resolution : DEFAULTS.resolution,
      outputFormat: typeof data.outputFormat === 'string' ? data.outputFormat : DEFAULTS.outputFormat,
      muted: data.muted === true,
      frame: { ...sanitizeFrame(data.frame), title: '' },
    }
  } catch {
    return DEFAULTS
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ...prefs, frame: { ...prefs.frame, title: '' } }))
  } catch {
    /* private mode or storage blocked: preferences just are not remembered */
  }
}
