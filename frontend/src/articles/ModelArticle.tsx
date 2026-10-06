import { useState } from 'react'
import type { Meta } from '../api'

interface Props {
  meta: Meta | null
  model: string
  setModel: (value: string) => void
  apiKey: string
  setApiKey: (value: string) => void
}

export default function ModelArticle({ meta, model, setModel, apiKey, setApiKey }: Props) {
  const [reveal, setReveal] = useState(false)
  const hasKey = apiKey.trim() !== ''
  return (
    <form onSubmit={(e) => { e.preventDefault(); window.location.hash = '#generate' }} noValidate>
      <p>StoryGapBoard runs on <a href="https://openrouter.ai" target="_blank" rel="noopener noreferrer">OpenRouter</a>.
        You use your own key, so generations are billed to your OpenRouter account.</p>
      <div className="fields">
        <div className="field">
          <label htmlFor="model">Image model</label>
          <input id="model" type="text" value={model} maxLength={128} autoComplete="off" spellCheck={false}
            placeholder={meta?.default_model ?? 'meta/muse-image'}
            onChange={(e) => setModel(e.target.value)} />
          <p className="hint">Any OpenRouter model that outputs images (empty = {meta?.default_model ?? 'default'}).
            Browse them on <a href="https://openrouter.ai/models?output_modalities=image" target="_blank"
              rel="noopener noreferrer">openrouter.ai/models</a>.</p>
          <p className="hint model-note">Tip: choose a model that accepts <strong>both text and image input</strong> to
            get the most out of the app. Text-only models ignore the reference images from Files.</p>
        </div>
        <div className="field">
          <label htmlFor="api-key">OpenRouter API key</label>
          <div className="key-row">
            <input id="api-key" type={reveal ? 'text' : 'password'} value={apiKey} maxLength={512}
              autoComplete="off" spellCheck={false} placeholder="sk-or-…"
              onChange={(e) => setApiKey(e.target.value)} />
            <button type="button" className="small" aria-pressed={reveal}
              onClick={() => setReveal(!reveal)}>{reveal ? 'Hide' : 'Show'}</button>
          </div>
          <p className={`hint ${hasKey ? 'ok' : ''}`}>
            {hasKey ? 'Key set for this tab. ' : ''}
            Your key lives only in this tab&apos;s memory: closing or reloading the tab erases it. It is sent over
            HTTPS only to call OpenRouter and is never stored or logged by the server.
          </p>
        </div>
      </div>
      <ul className="actions">
        <li><input type="submit" className="primary" value="Done" /></li>
      </ul>
    </form>
  )
}
