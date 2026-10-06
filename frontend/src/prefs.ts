// Non-secret preferences remembered in this browser. The API key, prompt and
// files are never stored.
export interface Prefs {
  model: string
  aspectRatio: string
  layout: string
  resolution: string
  outputFormat: string
  muted: boolean
}

const KEY = 'storygapboard.prefs'
const DEFAULTS: Prefs = { model: '', aspectRatio: '1:1', layout: '2x3', resolution: '1K', outputFormat: 'png', muted: false }

export function loadPrefs(): Prefs {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return DEFAULTS
    const data = JSON.parse(raw) as Partial<Prefs>
    return {
      model: typeof data.model === 'string' ? data.model.slice(0, 128) : DEFAULTS.model,
      aspectRatio: typeof data.aspectRatio === 'string' ? data.aspectRatio : DEFAULTS.aspectRatio,
      layout: typeof data.layout === 'string' ? data.layout : DEFAULTS.layout,
      resolution: typeof data.resolution === 'string' ? data.resolution : DEFAULTS.resolution,
      outputFormat: typeof data.outputFormat === 'string' ? data.outputFormat : DEFAULTS.outputFormat,
      muted: data.muted === true,
    }
  } catch {
    return DEFAULTS
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    /* private mode or storage blocked: preferences just are not remembered */
  }
}
