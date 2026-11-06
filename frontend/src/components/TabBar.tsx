import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

interface Props<T extends string> {
  tabs: [T, string][]
  active: T
  onSelect: (id: T) => void
}

const STEP = 160   // px per click on an arrow
const SPEED = 5    // px per frame while the pointer rests on an arrow

/**
 * The tab row. Tabs keep their size: when they do not fit the width, the row scrolls (drag on a phone)
 * and an arrow appears on each side that has more tabs; resting the pointer on it slides the row.
 * The underline follows the selected tab, also when the window or the text changes size.
 */
export default function TabBar<T extends string>({ tabs, active, onSelect }: Props<T>) {
  const row = useRef<HTMLDivElement>(null)
  const refs = useRef<Record<string, HTMLDivElement | null>>({})
  const [underline, setUnderline] = useState({ width: 0, left: 0 })
  const [more, setMore] = useState({ left: false, right: false })
  const raf = useRef(0)

  const measure = useCallback(() => {
    const el = row.current
    if (!el) return
    const tab = refs.current[active]
    setUnderline((u) => (u.width === (tab?.offsetWidth ?? 0) && u.left === (tab?.offsetLeft ?? 0)
      ? u : { width: tab?.offsetWidth ?? 0, left: tab?.offsetLeft ?? 0 }))
    const left = el.scrollLeft > 1
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    setMore((m) => (m.left === left && m.right === right ? m : { left, right }))
  }, [active])

  useLayoutEffect(measure, [measure, tabs.length])

  // window resize, a font that loads late, tabs that appear: everything that moves a tab
  useEffect(() => {
    const el = row.current
    if (!el) return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    for (const tab of Object.values(refs.current)) if (tab) observer.observe(tab)
    window.addEventListener('resize', measure)
    void document.fonts?.ready.then(measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [measure, tabs.length])

  // the selected tab is always in view
  useEffect(() => {
    const el = row.current
    const tab = refs.current[active]
    if (!el || !tab) return
    const from = tab.offsetLeft - 32
    const to = tab.offsetLeft + tab.offsetWidth + 32
    if (from < el.scrollLeft) el.scrollTo({ left: Math.max(0, from), behavior: 'smooth' })
    else if (to > el.scrollLeft + el.clientWidth) el.scrollTo({ left: to - el.clientWidth, behavior: 'smooth' })
  }, [active, tabs.length])

  const stop = () => { cancelAnimationFrame(raf.current); raf.current = 0 }
  useEffect(() => stop, [])
  function slide(dir: -1 | 1) {
    stop()
    const tick = () => {
      const el = row.current
      if (!el) return
      el.scrollLeft += dir * SPEED
      const end = dir < 0 ? el.scrollLeft <= 0 : el.scrollLeft + el.clientWidth >= el.scrollWidth - 1
      if (!end) raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
  }
  const arrow = (dir: -1 | 1) => (
    <span className={`tabs-arrow ${dir < 0 ? 'is-left' : 'is-right'} icon solid ${dir < 0 ? 'fa-angle-left' : 'fa-angle-right'}${(dir < 0 ? more.left : more.right) ? ' is-on' : ''}`}
      role="button" aria-label={dir < 0 ? 'Show tabs to the left' : 'Show tabs to the right'} tabIndex={-1}
      onMouseEnter={() => slide(dir)} onMouseLeave={stop}
      onClick={() => row.current?.scrollBy({ left: dir * STEP, behavior: 'smooth' })} />
  )

  return (
    <div className={`tabs-bar${more.left ? ' has-left' : ''}${more.right ? ' has-right' : ''}`}>
      {arrow(-1)}
      <div className="tabs" role="tablist" ref={row} onScroll={measure}>
        {tabs.map(([id, label]) => (
          // a div like the template's close button: its CSS styles every <button> as a big box
          <div key={id} role="tab" tabIndex={0} id={`tab-btn-${id}`} ref={(el) => { refs.current[id] = el }} aria-controls={`tab-${id}`}
            aria-selected={active === id} className={`tab${active === id ? ' selected' : ''}`}
            onClick={() => onSelect(id)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(id) } }}>
            {label}
          </div>
        ))}
        <span className="tab-underline" aria-hidden="true" style={{
          width: `${underline.width}px`, transform: `translateX(${underline.left}px)`,
        }} />
      </div>
      {arrow(1)}
    </div>
  )
}
