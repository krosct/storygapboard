import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api, type Meta } from './api'
import { useDimension } from './useDimension'
import { ToastRegion, useToasts } from './components/Toasts'
import GenerateArticle from './articles/GenerateArticle'
import FilesArticle from './articles/FilesArticle'
import ModelArticle from './articles/ModelArticle'
import AboutArticle from './articles/AboutArticle'
import { loadPrefs, savePrefs, type Prefs, type Provider } from './prefs'
import type { Panels } from './board'
import type { SGBProject } from './project'
import { deserializeProject } from './project'
import type { PanelSource, Rect } from './board'
import type { FrameStyle } from './frame'
import { recordAction } from './timeline'

const ARTICLES = ['fill', 'files', 'model', 'about'] as const
const NAV: { id: (typeof ARTICLES)[number]; label: string }[] = [
  { id: 'fill', label: 'Fill' },
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
  // one key per provider, so switching back and forth keeps both (still memory only)
  const [apiKeys, setApiKeys] = useState<Record<Provider, string>>({ openrouter: '', openai: '' })
  const apiKey = apiKeys[prefs.provider]
  const setApiKey = (value: string) => setApiKeys((old) => ({ ...old, [prefs.provider]: value }))
  const modelKey = prefs.provider === 'openai' ? 'openaiModel' : 'model'
  const [files, setFiles] = useState<File[]>([])
  const [panels, setPanels] = useState<Panels>([])
  const [prompt, setPrompt] = useState('')
  const [style, setStyle] = useState('')
  // Restored board/history from project import (for GenerateArticle to pick up)
  const [restoredBoard, setRestoredBoard] = useState<{
    blob: Blob
    filename: string
    cost: number
    seed: number | null
    width: number
    height: number
    sources: PanelSource[]
    rects: Rect[]
    frame: FrameStyle
  } | null>(null)
  const [restoredHistory, setRestoredHistory] = useState<{
    undo: PanelSource[][]
    redo: PanelSource[][]
    order: number[]
    redoOrder: number[]
  } | null>(null)

  useEffect(() => {
    // Record welcome / session start action
    void recordAction('Welcome to StoryGapBoard', 'User started a new creative session.')
  }, [])

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

  // Handle project import (.sgb file) - always available regardless of active tab
  const handleImportProject = useCallback((sgb: SGBProject) => {
    try {
      notify('info', 'Importing project…')
      const restored = deserializeProject(sgb)

      // Restore preferences (provider, model, layout, ratio, resolution, format, frame)
      updatePrefs({
        provider: restored.provider,
        [restored.provider === 'openai' ? 'openaiModel' : 'model']: restored.model,
        layout: restored.layout,
        aspectRatio: restored.aspectRatio,
        resolution: restored.resolution,
        outputFormat: restored.outputFormat,
        frame: restored.frame,
      })

      // Restore prompt and style
      setPrompt(restored.prompt)
      setStyle(restored.style)

      // Restore reference files (Files tab)
      setFiles(restored.referenceFiles)

      // Restore panels (Fill tab)
      setPanels(restored.panels)

      // Restore board and history for GenerateArticle
      if (restored.board) {
        setRestoredBoard(restored.board)
        setRestoredHistory(restored.history)
      } else {
        setRestoredBoard(null)
        setRestoredHistory(null)
      }

      // Navigate to Fill tab so GenerateArticle can restore the board if present
      window.location.hash = '#fill'

      notify('success', 'Project imported. Continue where you left off!')
    } catch (e) {
      notify('error', (e as Error).message)
    }
  }, [notify, updatePrefs, setPrompt, setStyle, setFiles, setPanels, setRestoredBoard, setRestoredHistory])

  const article = (id: string, title: string | null, children: ReactNode) => (
    <article
      id={id}
      hidden={view.shown !== id}
      className={view.shown === id && view.active ? 'active' : ''}
      onClick={(e) => e.stopPropagation()}
    >
      {title !== null && <h2 className="major">{title}</h2>}
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
            <svg className="logo-mark" viewBox="0 0 100 100" aria-hidden="true">
              <defs>
                <radialGradient id="sgb-spark-glow" cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor="#ffffff" stopOpacity="0.45" />
                  <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
                </radialGradient>
                <clipPath id="sgb-tl"><rect x="24.5" y="24.5" width="23" height="23" /></clipPath>
                <clipPath id="sgb-bl"><rect x="24.5" y="52.5" width="23" height="23" /></clipPath>
                <clipPath id="sgb-br"><rect x="52.5" y="52.5" width="23" height="23" /></clipPath>
              </defs>

              {/* Top-left panel: mountain range + sun */}
              <rect x="24" y="24" width="24" height="24" rx="1" fill="none" stroke="#fff" strokeWidth="2.2" />
              <g clipPath="url(#sgb-tl)" fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="30.5" cy="30.5" r="2.2" strokeWidth="1.5" />
                <path d="M24 44 L34.5 34 L37.5 38" strokeWidth="1.6" />
                <path d="M35.5 40.5 L42.5 31.5 L48.5 40" strokeWidth="1.6" />
              </g>

              {/* Top-right panel: dashed "gap" + AI sparkles + closed pencil inside the circle */}
              <path
                d="M68 24 H52 V48 H76 V36"
                fill="none"
                stroke="rgb(255, 255, 255)"
                strokeWidth="2.2"
                strokeDasharray="3.2 3.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle cx="61" cy="37" r="8.5" fill="url(#sgb-spark-glow)" />
              <path
                d="M61 30.2 C61.4 34.5 62.5 35.6 66.8 36 C62.5 36.4 61.4 37.5 61 41.8 C60.6 37.5 59.5 36.4 55.2 36 C59.5 35.6 60.6 34.5 61 30.2 Z"
                fill="#fff"
              />
              <path
                d="M56.8 30 C57 31.6 57.4 32 59 32.2 C57.4 32.4 57 32.8 56.8 34.4 C56.6 32.8 56.2 32.4 54.6 32.2 C56.2 32 56.6 31.6 56.8 30 Z"
                fill="#fff"
              />
              <g fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round">
                <path d="M77.5 18.5 L66.5 29.5 L63.5 36.5 L70.5 33.5 L81.5 22.5 Z" strokeWidth="2" />
                <path d="M66.5 29.5 L70.5 33.5" strokeWidth="1.6" />
                <path d="M71.5 28.5 L76.5 23.5" strokeWidth="1.6" />
              </g>

              {/* Bottom-left panel: walking character */}
              <rect x="24" y="52" width="24" height="24" rx="1" fill="none" stroke="#fff" strokeWidth="2.2" />
              <g clipPath="url(#sgb-bl)" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="36" cy="57.5" r="2" />
                <path d="M34.2 60.5 L32 62.8 L29.6 66.7 L31.4 67.2 L33.5 64.2 L34.2 67.5 L30.8 75.5 L32.8 75.5 L35.8 69.2 L38.8 75.5 L40.8 75.5 L37.6 67.2 L37.2 63.5 L40.5 65.8 L41.5 64.3 L37.5 60.5 Z" />
              </g>

              {/* Bottom-right panel: night city skyline + crescent moon */}
              <rect x="52" y="52" width="24" height="24" rx="1" fill="none" stroke="#fff" strokeWidth="2.2" />
              <g clipPath="url(#sgb-br)" fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round">
                <path
                  d="M59.2 56.2 A 2.4 2.4 0 1 0 61.6 59.6 A 2.1 2.1 0 1 1 59.2 56.2 Z"
                  strokeWidth="1.3"
                />
                <path
                  d="M52 70.5 H56 V73.5 H57.8 V66 H60.8 V71 H64 V61 H67.2 V69.5 H69.2 V73 H71.2 V62 L74 63.8 V69.5 H76"
                  strokeWidth="1.5"
                />
                <path d="M64.8 61 V59.2 H66.4 V61" strokeWidth="1.3" />
                <path d="M65.6 59.2 V56.8" strokeWidth="1.3" />
                <path d="M59.3 66 V64.2" strokeWidth="1.3" />
              </g>
            </svg>
          </div>
          <div className="content">
            <div className="inner">
              <h1>Story<span className="gap">Gap</span>Board</h1>
              <p>Turn a few images into a complete storyboard.{' '}<br />
                Bring your own key and create stories!</p>
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
          {article('fill', null,   // GenerateArticle draws its own title: it becomes tabs once a storyboard exists

            <GenerateArticle
              meta={meta} prefs={prefs} updatePrefs={updatePrefs}
              prompt={prompt} setPrompt={setPrompt}
              style={style} setStyle={setStyle}
              apiKey={apiKey} files={files} setFiles={setFiles} panels={panels} setPanels={setPanels} notify={notify}
              currentView={view.shown}
              restoredBoard={restoredBoard}
              restoredHistory={restoredHistory}
              onBoardRestored={() => { setRestoredBoard(null); setRestoredHistory(null) }}
            />)}
          {article('files', 'Files',
            <FilesArticle meta={meta} files={files} setFiles={setFiles} notify={notify}
              onImportProject={handleImportProject} />)}
          {article('model', 'Model',
            <ModelArticle
              meta={meta} provider={prefs.provider} setProvider={(provider) => updatePrefs({ provider })}
              model={prefs[modelKey]} setModel={(model) => updatePrefs({ [modelKey]: model })}
              apiKey={apiKey} setApiKey={setApiKey}
            />)}
          {article('about', 'About', <AboutArticle meta={meta} />)}
        </div>

        <footer id="footer" hidden={articleOpen}>
          <p className="copyright">&copy; StoryGapBoard, created by <a href="https://krosct.github.io/" rel="noreferrer noopener" target="_blank">Gabriel Monteiro</a>. Design: <a href="https://html5up.net" rel="noreferrer noopener" target="_blank">HTML5 UP</a>.</p>
        </footer>
      </div>
      <div id="bg"></div>
      <ToastRegion toasts={toasts} dismiss={dismiss} />
    </>
  )
}
