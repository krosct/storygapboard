import { useState } from 'react'
import type { Meta } from '../api'
import type { Provider } from '../prefs'

interface Props {
  meta: Meta | null
  provider: Provider
  setProvider: (value: Provider) => void
  model: string
  setModel: (value: string) => void
  apiKey: string
  setApiKey: (value: string) => void
}

// What changes with the provider: where models are listed and what a key looks like.
const GUIDE: Record<Provider, { site: string; models: string; modelsLabel: string; key: string; modelHint: string }> = {
  openrouter: {
    site: 'https://openrouter.ai',
    models: 'https://openrouter.ai/models?output_modalities=image',
    modelsLabel: 'openrouter.ai/models',
    key: 'sk-or-…',
    modelHint: 'Any OpenRouter model that outputs images',
  },
  openai: {
    site: 'https://platform.openai.com',
    models: 'https://developers.openai.com/api/docs/guides/image-generation',
    modelsLabel: 'the OpenAI image guide',
    key: 'sk-…',
    modelHint: 'An OpenAI GPT Image model, e.g. gpt-image-2.5-flare (fast) or gpt-image-2.5-sunburst (precise edits)',
  },
}

export default function ModelArticle({ meta, provider, setProvider, model, setModel, apiKey, setApiKey }: Props) {
  const [reveal, setReveal] = useState(false)
  const hasKey = apiKey.trim() !== ''
  const providers = meta?.providers ?? [{ id: 'openrouter', label: 'OpenRouter', default_model: 'meta/muse-image' }]
  const info = providers.find((p) => p.id === provider) ?? providers[0]
  const guide = GUIDE[provider]
  return (
    <form onSubmit={(e) => { e.preventDefault(); window.location.hash = '#fill' }} noValidate>
      <p>StoryGapBoard runs on the provider you pick, with your own key: generations are billed to your
        account there.</p>
      <div className="fields">
        <div className="field">
          <label htmlFor="provider">Provider</label>
          <select id="provider" value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="model">Image model</label>
          <input id="model" type="text" value={model} maxLength={128} autoComplete="off" spellCheck={false}
            placeholder={info.default_model}
            onChange={(e) => setModel(e.target.value)} />
          <p className="hint">{guide.modelHint} (empty = {info.default_model}). See{' '}
            <a href={guide.models} target="_blank" rel="noopener noreferrer">{guide.modelsLabel}</a>.</p>
          {provider === 'openrouter' ? (
            <p className="hint model-note">Tip: choose a model that accepts <strong>both text and image input</strong> to
              get the most out of the app. Text-only models ignore the reference images from Files.</p>
          ) : (
            <p className="hint model-note">OpenAI GPT Image models take your panels and references as input. They may
              require a verified organization on your OpenAI account, and they do not use seeds.</p>
          )}
        </div>
        <div className="field">
          <label htmlFor="api-key">{info.label} API key</label>
          <div className="key-row">
            <input id="api-key" type={reveal ? 'text' : 'password'} value={apiKey} maxLength={512}
              autoComplete="off" spellCheck={false} placeholder={guide.key}
              onChange={(e) => setApiKey(e.target.value)} />
            <button type="button" className={`icon-only icon solid ${reveal ? 'fa-eye-slash' : 'fa-eye'}`} aria-pressed={reveal}
              aria-label={reveal ? 'Hide the key' : 'Show the key'} title={reveal ? 'Hide the key' : 'Show the key'}
              onClick={() => setReveal(!reveal)} />
          </div>
          <p className={`hint ${hasKey ? 'ok' : ''}`}>
            {hasKey ? 'Key set for this tab. ' : ''}
            Your key lives only in this tab&apos;s memory: closing or reloading the tab erases it. It is sent over
            HTTPS only to call <a href={guide.site} target="_blank" rel="noopener noreferrer">{info.label}</a> and is
            never stored or logged by the server.
          </p>
        </div>
      </div>
      <ul className="actions fixed done-row">
        <li><input type="submit" className="primary" value="Done" /></li>
      </ul>
    </form>
  )
}
