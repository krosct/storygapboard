import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as RPE } from 'react'
import { createPortal } from 'react-dom'

// Own colour picker (the native one has no transparency): saturation/brightness area, hue and opacity
// sliders, eyedropper, and R G B / H S L / hex fields with an A (opacity %) box. Values are "#rrggbb" or "#rrggbbaa".

interface HSVA { h: number; s: number; v: number; a: number }   // h 0-360, s/v/a 0-1
type Mode = 'rgb' | 'hsl' | 'hex'
const MODES: Mode[] = ['rgb', 'hsl', 'hex']
const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n))

function hsvToRgb({ h, s, v }: HSVA): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 60) % 6
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))))
  }
  return [f(5), f(3), f(1)]
}

/** rgb → hsv; hue/saturation are kept from `prev` where the colour no longer defines them (grays, black). */
function rgbToHsv(r: number, g: number, b: number, a: number, prev: HSVA): HSVA {
  const R = r / 255, G = g / 255, B = b / 255
  const max = Math.max(R, G, B), d = max - Math.min(R, G, B)
  const v = max, s = max === 0 ? 0 : d / max
  let h = prev.h
  if (d > 0) {
    h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4
    h = (h * 60 + 360) % 360
  }
  return { h, s: v === 0 ? prev.s : s, v, a }
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const R = r / 255, G = g / 255, B = b / 255
  const max = Math.max(R, G, B), min = Math.min(R, G, B), l = (max + min) / 2, d = max - min
  if (d === 0) return [0, 0, Math.round(l * 100)]
  const s = d / (1 - Math.abs(2 * l - 1))
  let h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4
  h = (h * 60 + 360) % 360
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const S = s / 100, L = l / 100, k = (n: number) => (n + h / 30) % 12, a = S * Math.min(L, 1 - L)
  const f = (n: number) => Math.round(255 * (L - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))))
  return [f(0), f(8), f(4)]
}

const hh = (n: number) => n.toString(16).padStart(2, '0')

function parse(value: string, prev: HSVA): HSVA {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value)
  if (!m) return prev
  const n = parseInt(m[1], 16)
  return rgbToHsv((n >> 16) & 255, (n >> 8) & 255, n & 255, m[2] ? parseInt(m[2], 16) / 255 : 1, prev)
}

function toHex(c: HSVA): string {
  const [r, g, b] = hsvToRgb(c)
  const a = Math.round(c.a * 255)
  return `#${hh(r)}${hh(g)}${hh(b)}${a < 255 ? hh(a) : ''}`
}

/** Pointer drag over an element → position as fractions (0-1) of its box. */
function drag(move: (fx: number, fy: number) => void) {
  const at = (e: RPE<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    move(clamp((e.clientX - r.left) / r.width), clamp((e.clientY - r.top) / r.height))
  }
  return {
    onPointerDown: (e: RPE<HTMLElement>) => { e.currentTarget.setPointerCapture(e.pointerId); at(e) },
    onPointerMove: (e: RPE<HTMLElement>) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) at(e) },
  }
}

function NumBox(p: { label: string; value: number; min: number; max: number; onChange: (n: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <label className="cp-box">
      <input type="text" inputMode="numeric" autoComplete="off" value={draft ?? String(p.value)}
        onChange={(e) => {
          setDraft(e.target.value)
          const n = Number(e.target.value)
          if (e.target.value.trim() !== '' && Number.isFinite(n)) p.onChange(Math.round(clamp(n, p.min, p.max)))
        }}
        onBlur={() => setDraft(null)} />
      <span>{p.label}</span>
    </label>
  )
}

interface EyeDropperCtor { new (): { open: () => Promise<{ sRGBHex: string }> } }
const POP_W = 264

export default function ColorPicker(p: { id: string; label: string; value: string; disabled?: boolean; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const [hsva, setHsva] = useState<HSVA>(() => parse(p.value, { h: 0, s: 0, v: 0, a: 1 }))
  const [mode, setMode] = useState<Mode>('rgb')
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 })
  const btn = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const emitted = useRef(p.value)
  const EyeDropper = (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper

  // follow outside changes (a preset, reset...) but not our own emissions (they would lose hue/saturation)
  useEffect(() => {
    if (p.value !== emitted.current) { emitted.current = p.value; setHsva((prev) => parse(p.value, prev)) }
  }, [p.value])

  const apply = (next: HSVA) => {
    setHsva(next)
    const hex = toHex(next)
    emitted.current = hex
    p.onChange(hex)
  }

  const place = () => {
    const b = btn.current?.getBoundingClientRect()
    if (!b) return
    const h = pop.current?.offsetHeight ?? 300
    const below = b.bottom + 6
    const left = clamp(b.left, 8, Math.max(8, window.innerWidth - POP_W - 8))
    const top = below + h > window.innerHeight - 8 ? Math.max(8, b.top - 6 - h) : below
    setPos((old) => (old.left === left && old.top === top ? old : { left, top }))   // same place: no re-render
  }
  useLayoutEffect(() => { if (open) place() })

  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => {
      const t = e.target as Node
      if (!pop.current?.contains(t) && !btn.current?.contains(t)) setOpen(false)
    }
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); btn.current?.focus() }   // never closes the article
    }
    document.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      document.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  })

  useEffect(() => { if (p.disabled) setOpen(false) }, [p.disabled])

  // own host under <body>: clicks stop there, or the page would take them as "click outside the article" and close it
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const el = document.createElement('div')
    el.addEventListener('click', (e) => e.stopPropagation())
    document.body.appendChild(el)
    setHost(el)
    return () => { el.remove(); setHost(null) }
  }, [open])

  const [r, g, b] = hsvToRgb(hsva)
  const [hue, sat, light] = rgbToHsl(r, g, b)
  const fromRgb = (nr: number, ng: number, nb: number) => apply(rgbToHsv(nr, ng, nb, hsva.a, hsva))
  const full = `rgb(${r}, ${g}, ${b})`
  const pure = `hsl(${hsva.h}, 100%, 50%)`

  const step = (e: KeyboardEvent, fn: (dx: number, dy: number) => void, k = 0.02) => {
    const d: Record<string, [number, number]> = { ArrowLeft: [-k, 0], ArrowRight: [k, 0], ArrowUp: [0, -k], ArrowDown: [0, k] }
    if (d[e.key]) { e.preventDefault(); fn(...d[e.key]) }
  }

  const eyedrop = async () => {
    try {
      const res = await new EyeDropper!().open()
      const c = parse(res.sRGBHex, hsva)
      apply({ ...c, a: hsva.a })
    } catch { /* cancelled */ }
  }

  return (
    <>
      <button ref={btn} id={p.id} type="button" className="frame-colorbtn" disabled={p.disabled} aria-haspopup="dialog"
        aria-expanded={open} title={`${p.label}: ${toHex(hsva)}`} onClick={() => setOpen(!open)}>
        <span className="cp-checker"><span style={{ background: toHex(hsva).length > 7 ? `rgba(${r}, ${g}, ${b}, ${hsva.a})` : full }} /></span>
      </button>
      {open && host && createPortal(
        <div ref={pop} className="cp-pop" role="dialog" aria-label={`${p.label} picker`} style={{ left: pos.left, top: pos.top, width: POP_W }}>
          <div className="cp-area" style={{ backgroundColor: pure }} tabIndex={0} role="slider" aria-label="Saturation and brightness"
            aria-valuetext={`Saturation ${Math.round(hsva.s * 100)}%, brightness ${Math.round(hsva.v * 100)}%`}
            {...drag((fx, fy) => apply({ ...hsva, s: fx, v: 1 - fy }))}
            onKeyDown={(e) => step(e, (dx, dy) => apply({ ...hsva, s: clamp(hsva.s + dx), v: clamp(hsva.v - dy) }))}>
            <i className="cp-thumb" style={{ left: `${hsva.s * 100}%`, top: `${(1 - hsva.v) * 100}%` }} />
          </div>
          <div className="cp-mid">
            {EyeDropper
              ? <button type="button" className="cp-eye icon solid fa-eye-dropper" aria-label="Pick a color from the screen" title="Pick from screen" onClick={eyedrop} />
              : <span className="cp-eye-gap" />}
            <span className="cp-swatch cp-checker"><span style={{ background: `rgba(${r}, ${g}, ${b}, ${hsva.a})` }} /></span>
            <div className="cp-sliders">
              <div className="cp-slider cp-hue" tabIndex={0} role="slider" aria-label="Hue" aria-valuemin={0} aria-valuemax={360}
                aria-valuenow={Math.round(hsva.h)} {...drag((fx) => apply({ ...hsva, h: fx * 360 }))}
                onKeyDown={(e) => step(e, (dx) => apply({ ...hsva, h: clamp(hsva.h + dx * 180, 0, 360) }), 0.05)}>
                <i className="cp-knob" style={{ left: `${(hsva.h / 360) * 100}%`, background: pure }} />
              </div>
              <div className="cp-slider cp-alpha cp-checker" tabIndex={0} role="slider" aria-label="Opacity" aria-valuemin={0} aria-valuemax={100}
                aria-valuenow={Math.round(hsva.a * 100)} {...drag((fx) => apply({ ...hsva, a: Math.round(fx * 100) / 100 }))}
                onKeyDown={(e) => step(e, (dx) => apply({ ...hsva, a: clamp(hsva.a + dx) }), 0.05)}>
                <span className="cp-alpha-fill" style={{ background: `linear-gradient(to right, rgba(${r}, ${g}, ${b}, 0), ${full})` }} />
                <i className="cp-knob" style={{ left: `${hsva.a * 100}%`, background: `rgba(${r}, ${g}, ${b}, ${hsva.a})` }} />
              </div>
            </div>
          </div>
          <div className="cp-fields">
            {mode === 'rgb' && <>
              <NumBox label="R" value={r} min={0} max={255} onChange={(n) => fromRgb(n, g, b)} />
              <NumBox label="G" value={g} min={0} max={255} onChange={(n) => fromRgb(r, n, b)} />
              <NumBox label="B" value={b} min={0} max={255} onChange={(n) => fromRgb(r, g, n)} />
            </>}
            {mode === 'hsl' && <>
              <NumBox label="H" value={hue} min={0} max={360} onChange={(n) => fromRgb(...hslToRgb(n, sat, light))} />
              <NumBox label="S" value={sat} min={0} max={100} onChange={(n) => fromRgb(...hslToRgb(hue, n, light))} />
              <NumBox label="L" value={light} min={0} max={100} onChange={(n) => fromRgb(...hslToRgb(hue, sat, n))} />
            </>}
            {mode === 'hex' && <HexBox value={`#${hh(r)}${hh(g)}${hh(b)}`} onChange={(v) => apply({ ...parse(v, hsva), a: hsva.a })} />}
            <NumBox label="A %" value={Math.round(hsva.a * 100)} min={0} max={100} onChange={(n) => apply({ ...hsva, a: n / 100 })} />
            <button type="button" className="cp-mode icon solid fa-sort" aria-label="Change color format" title="Change format"
              onClick={() => setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length])} />
          </div>
        </div>, host)}
    </>
  )
}

function HexBox(p: { value: string; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <label className="cp-box cp-hex">
      <input type="text" autoComplete="off" spellCheck={false} maxLength={7} value={draft ?? p.value}
        onChange={(e) => {
          setDraft(e.target.value)
          if (/^#[0-9a-f]{6}$/i.test(e.target.value)) p.onChange(e.target.value.toLowerCase())
        }}
        onBlur={() => setDraft(null)} />
      <span>HEX</span>
    </label>
  )
}
