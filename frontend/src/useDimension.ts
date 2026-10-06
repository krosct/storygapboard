import { useCallback, useEffect, useRef, useState } from 'react'

// React port of the Dimension template's main.js (HTML5 UP): the URL hash
// picks the open article; body classes drive the template CSS transitions.
const DELAY_MS = 325

export interface DimensionState {
  shown: string | null   // article currently displayed (display: block)
  active: boolean        // shown article has the .active class (fade/slide in)
}

function setBodyClass(name: string, on: boolean) {
  document.body.classList.toggle(name, on)
}

function hashId(): string {
  return window.location.hash.replace(/^#/, '')
}

export function useDimension(articles: readonly string[]) {
  const [state, setState] = useState<DimensionState>({ shown: null, active: false })
  const current = useRef<DimensionState>(state)
  const locked = useRef(false)
  const timers = useRef<number[]>([])

  const update = useCallback((next: DimensionState) => {
    current.current = next
    setState(next)
  }, [])

  const later = useCallback((ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms))
  }, [])

  const clearTimers = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t))
    timers.current = []
  }, [])

  const show = useCallback((id: string, initial = false) => {
    if (!articles.includes(id)) return
    if (locked.current || initial) {
      // Speed through without transitions.
      clearTimers()
      setBodyClass('is-switching', true)
      setBodyClass('is-article-visible', true)
      update({ shown: id, active: true })
      locked.current = false
      later(initial ? 1000 : 0, () => setBodyClass('is-switching', false))
      return
    }
    locked.current = true
    const finish = () => {
      update({ shown: id, active: false })
      later(25, () => {
        update({ shown: id, active: true })
        window.scrollTo(0, 0)
        later(DELAY_MS, () => { locked.current = false })
      })
    }
    if (document.body.classList.contains('is-article-visible')) {
      update({ shown: current.current.shown, active: false })
      later(DELAY_MS, finish)
    } else {
      setBodyClass('is-article-visible', true)
      later(DELAY_MS, finish)
    }
  }, [articles, clearTimers, later, update])

  const hide = useCallback(() => {
    if (!document.body.classList.contains('is-article-visible')) return
    if (locked.current) {
      clearTimers()
      setBodyClass('is-switching', true)
      update({ shown: null, active: false })
      setBodyClass('is-article-visible', false)
      locked.current = false
      setBodyClass('is-switching', false)
      window.scrollTo(0, 0)
      return
    }
    locked.current = true
    update({ shown: current.current.shown, active: false })
    later(DELAY_MS, () => {
      update({ shown: null, active: false })
      later(25, () => {
        setBodyClass('is-article-visible', false)
        window.scrollTo(0, 0)
        later(DELAY_MS, () => { locked.current = false })
      })
    })
  }, [clearTimers, later, update])

  const close = useCallback(() => {
    if (document.body.classList.contains('is-article-visible')) {
      window.history.pushState(null, '', '#')
      hide()
    }
  }, [hide])

  useEffect(() => {
    if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual'
    const onHash = () => {
      const id = hashId()
      if (id === '') hide()
      else if (articles.includes(id)) show(id)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    // Clicks inside an article stop propagation (see App); anything else closes it.
    const onBodyClick = () => close()
    window.addEventListener('hashchange', onHash)
    window.addEventListener('keyup', onKey)
    document.body.addEventListener('click', onBodyClick)
    const preload = window.setTimeout(() => setBodyClass('is-preload', false), 100)
    if (articles.includes(hashId())) show(hashId(), true)
    return () => {
      window.removeEventListener('hashchange', onHash)
      window.removeEventListener('keyup', onKey)
      document.body.removeEventListener('click', onBodyClick)
      window.clearTimeout(preload)
      clearTimers()
    }
  }, [articles, close, hide, show, clearTimers])

  return { ...state, close }
}
