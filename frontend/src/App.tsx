import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api, type Meta } from './api'
import { useDimension } from './useDimension'
import { ToastRegion, useToasts } from './components/Toasts'
import GenerateArticle from './articles/GenerateArticle'
import FilesArticle from './articles/FilesArticle'
import ModelArticle from './articles/ModelArticle'
import AboutArticle from './articles/AboutArticle'
import { loadPrefs, savePrefs, type Prefs } from './prefs'

const ARTICLES = ['generate', 'files', 'model', 'about'] as const
const NAV: { id: (typeof ARTICLES)[number]; label: string }[] = [
  { id: 'generate', label: 'Generate' },
  { id: 'files', label: 'Files' },
  { id: 'model', label: 'Model' },
  { id: 'about', label: 'About' },
]

export default function App() {
  const view = useDimension(ARTICLES)
  const { toasts, notify, dismiss } = useToasts()
  const [meta, setMeta] = useState<Meta | null>(null)
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs)
  // Ephemeral by design: the key and the files live only in this tab's memory.
  const [apiKey, setApiKey] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [prompt, setPrompt] = useState('')

  useEffect(() => {
    let cancelled = false
    const load = (attempt: number) => {
      api.meta().then((m) => { if (!cancelled) setMeta(m) }).catch((e: Error) => {
        if (cancelled) return
        if (attempt < 3) window.setTimeout(() => load(attempt + 1), 1500)
        else notify('error', e.message)
      })
    }
    load(1)
    return () => { cancelled = true }
  }, [notify])

  const updatePrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefs((old) => {
      const next = { ...old, ...patch }
      savePrefs(next)
      return next
    })
  }, [])

  const article = (id: string, title: string, children: ReactNode) => (
    <article
      id={id}
      hidden={view.shown !== id}
      className={view.shown === id && view.active ? 'active' : ''}
      onClick={(e) => e.stopPropagation()}
    >
      <h2 className="major">{title}</h2>
      {children}
      {/* a div like the template's: its CSS styles every <button> as a big box */}
      <div className="close" role="button" tabIndex={0} aria-label="Close" onClick={view.close}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); view.close() } }}>
        Close
      </div>
    </article>
  )

  const articleOpen = view.shown !== null

  return (
    <>
      <div id="wrapper">
        <header id="header" hidden={articleOpen}>
          <div className="logo">
            <span className="icon fa-image" aria-hidden="true"></span>
          </div>
          <div className="content">
            <div className="inner">
              <h1>Story<span className="gap">Gap</span>Board</h1>
              <p>Turn a short story and your own references into a complete storyboard.<br />
                Bring your own key and create!</p>
            </div>
          </div>
          <nav className="use-middle">
            <ul>
              {NAV.map((item, i) => (
                <li key={item.id} className={i === NAV.length / 2 ? 'is-middle' : undefined}>
                  <a href={`#${item.id}`}>{item.label}</a>
                </li>
              ))}
            </ul>
          </nav>
        </header>

        <div id="main" hidden={!articleOpen}>
          {article('generate', 'Generate',
            <GenerateArticle
              meta={meta} prefs={prefs} updatePrefs={updatePrefs}
              prompt={prompt} setPrompt={setPrompt}
              apiKey={apiKey} files={files} notify={notify}
            />)}
          {article('files', 'Files',
            <FilesArticle meta={meta} files={files} setFiles={setFiles} notify={notify} />)}
          {article('model', 'Model',
            <ModelArticle
              meta={meta} model={prefs.model} setModel={(model) => updatePrefs({ model })}
              apiKey={apiKey} setApiKey={setApiKey}
            />)}
          {article('about', 'About', <AboutArticle meta={meta} />)}
        </div>

        <footer id="footer" hidden={articleOpen}>
          <p className="copyright">&copy; StoryGapBoard. Design: <a href="https://html5up.net" rel="noreferrer noopener" target="_blank">HTML5 UP</a>.</p>
        </footer>
      </div>
      <div id="bg"></div>
      <ToastRegion toasts={toasts} dismiss={dismiss} />
    </>
  )
}
