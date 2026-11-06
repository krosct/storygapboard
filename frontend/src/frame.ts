import type { Rect } from './board'

// The look of the storyboard around the pictures: board background, margin, outer frame, title,
// and each panel's border, corners, shadow and number. Pure drawing + geometry (no model, no server):
// changing it only redraws the board from the panels' sources.

export type Background = 'solid' | 'linear' | 'radial' | 'dots' | 'grid' | 'lines' | 'stripes' | 'checker'
export type LineKind = 'solid' | 'double' | 'dashed' | 'dotted'
export type Corner = 'tl' | 'tr' | 'bl' | 'br'
export type NumberShape = 'circle' | 'square' | 'tag'
export type TitleFont = 'sans' | 'serif' | 'mono' | 'comic' | 'impact'
export type Align = 'left' | 'center' | 'right'

/** Sizes are in "units": 1 unit = 1% of the shorter side of a panel, so a style looks the same at any resolution. */
export interface FrameStyle {
  background: Background
  color1: string
  /** second color: gradient end, pattern ink */
  color2: string
  /** linear gradient direction (degrees, 0 = to the right, 90 = downwards) */
  angle: number
  /** space around the panels */
  margin: number
  /** space between panels */
  gap: number
  outerWidth: number
  outerColor: string
  outerKind: LineKind
  /** rounding of the board's corners (units) */
  outerRadius: number
  /** what shows behind the rounded corners (alpha 0 = transparent) */
  outerBehind: string
  title: string
  titleFont: TitleFont
  titleSize: number
  titleColor: string
  titleAlign: Align
  titleAt: 'top' | 'bottom'
  /** where the title sits between the panels (0%) and the board's edge (100%) */
  titleOffset: number
  titleBold: boolean
  titleItalic: boolean
  titleUnderline: boolean
  borderWidth: number
  borderColor: string
  borderKind: LineKind
  radius: number
  shadow: number
  numbers: boolean
  numberAt: Corner
  numberShape: NumberShape
  numberColor: string
  numberText: string
  /** number badge size (units) */
  numberSize: number
}

export const DEFAULT_FRAME: FrameStyle = {
  background: 'solid', color1: '#ffffff', color2: '#d9dde0', angle: 90,
  margin: 4, gap: 4,
  outerWidth: 0, outerColor: '#1b1f22', outerKind: 'solid',
  outerRadius: 0, outerBehind: '#ffffff',
  title: '', titleFont: 'sans', titleSize: 7, titleColor: '#1b1f22', titleAlign: 'center', titleAt: 'top',
  titleOffset: 10, titleBold: true, titleItalic: false, titleUnderline: false,
  borderWidth: 0.4, borderColor: '#1b1f22', borderKind: 'solid', radius: 0, shadow: 0,
  numbers: false, numberAt: 'tl', numberShape: 'circle', numberColor: '#1b1f22', numberText: '#ffffff', numberSize: 7,
}

/** The storyboard before any Frame customization: bare panels with a thin white gap (the Storyboard tab). */
export const PLAIN_FRAME: FrameStyle = { ...DEFAULT_FRAME, margin: 0, gap: 1, borderWidth: 0 }

export const BACKGROUNDS: Record<Background, string> = {
  solid: 'Solid color', linear: 'Gradient', radial: 'Radial gradient', dots: 'Dots', grid: 'Grid',
  lines: 'Lines', stripes: 'Diagonal stripes', checker: 'Checkerboard',
}
export const LINE_KINDS: Record<LineKind, string> = { solid: 'Solid', double: 'Double', dashed: 'Dashed', dotted: 'Dotted' }
export const TITLE_FONTS: Record<TitleFont, { label: string; css: string }> = {
  sans: { label: 'Sans', css: '"Helvetica Neue", Arial, sans-serif' },
  serif: { label: 'Serif', css: 'Georgia, "Times New Roman", serif' },
  mono: { label: 'Typewriter', css: '"Courier New", Courier, monospace' },
  comic: { label: 'Comic', css: '"Comic Sans MS", "Chalkboard SE", "Marker Felt", cursive' },
  impact: { label: 'Poster', css: 'Impact, "Arial Narrow Bold", "Haettenschweiler", sans-serif' },
}
export const CORNERS: Record<Corner, string> = { tl: 'Top left', tr: 'Top right', bl: 'Bottom left', br: 'Bottom right' }
export const NUMBER_SHAPES: Record<NumberShape, string> = { circle: 'Circle', square: 'Square', tag: 'Tag' }

/** Ready-made looks: each one replaces every setting (the title is kept). */
export const PRESETS: { id: string; label: string; style: Partial<FrameStyle> }[] = [
  { id: 'classic', label: 'Classic', style: {} },
  { id: 'comic', label: 'Comic book', style: {
    background: 'dots', color1: '#fff3b0', color2: '#f2c94c', margin: 5, gap: 3, borderWidth: 1.6, borderColor: '#111111',
    outerWidth: 1.2, outerColor: '#111111', titleFont: 'impact', titleSize: 8, numbers: true, numberAt: 'tl',
    numberShape: 'square', numberColor: '#d62828', numberText: '#ffffff' } },
  { id: 'polaroid', label: 'Polaroid', style: {
    background: 'solid', color1: '#d8d2c4', margin: 7, gap: 7, borderWidth: 2.5, borderColor: '#fbfbf8', radius: 1, shadow: 2.5 } },
  { id: 'dark', label: 'Dark room', style: {
    background: 'solid', color1: '#101214', margin: 5, gap: 3, borderWidth: 0.5, borderColor: '#e8e8e8',
    titleColor: '#f2f2f2', numberColor: '#f2f2f2', numberText: '#101214' } },
  { id: 'newspaper', label: 'Newspaper', style: {
    background: 'solid', color1: '#efe6d2', margin: 5, gap: 2.5, borderWidth: 1, borderColor: '#2b2620', borderKind: 'double',
    outerWidth: 1.4, outerColor: '#2b2620', outerKind: 'double', titleFont: 'serif', titleSize: 8, titleColor: '#2b2620' } },
  { id: 'blueprint', label: 'Blueprint', style: {
    background: 'grid', color1: '#14407a', color2: '#2f64a8', margin: 5, gap: 4, borderWidth: 0.7, borderColor: '#e6f0ff',
    borderKind: 'dashed', titleFont: 'mono', titleColor: '#e6f0ff', numbers: true, numberShape: 'tag', numberColor: '#e6f0ff',
    numberText: '#14407a' } },
  { id: 'pastel', label: 'Pastel', style: {
    background: 'linear', color1: '#ffd6e8', color2: '#c9e4ff', angle: 60, margin: 5, gap: 4, borderWidth: 1.2,
    borderColor: '#ffffff', radius: 7, shadow: 1.5, titleFont: 'comic', titleColor: '#6b4a7a', numberColor: '#ffffff', numberText: '#6b4a7a' } },
  { id: 'sunset', label: 'Sunset', style: {
    background: 'radial', color1: '#ffb36b', color2: '#7b2d5b', margin: 5, gap: 3.5, borderWidth: 0.8, borderColor: '#fff4e0',
    radius: 3, shadow: 2, titleColor: '#fff4e0', titleFont: 'serif' } },
  { id: 'film', label: 'Film strip', style: {
    background: 'stripes', color1: '#0c0c0c', color2: '#1d1d1d', margin: 4, gap: 2, borderWidth: 0.6, borderColor: '#000000',
    outerWidth: 0.8, outerColor: '#e8c547', titleColor: '#e8c547', titleFont: 'mono', numbers: true, numberAt: 'br',
    numberShape: 'tag', numberColor: '#e8c547', numberText: '#0c0c0c' } },
  { id: 'neon', label: 'Neon', style: {
    background: 'linear', color1: '#12002b', color2: '#00263a', angle: 120, margin: 5, gap: 4, borderWidth: 0.9, borderColor: '#00f0ff',
    radius: 2, shadow: 0, outerWidth: 0.6, outerColor: '#ff2bd6', titleFont: 'impact', titleColor: '#ff2bd6', numbers: true,
    numberShape: 'circle', numberColor: '#ff2bd6', numberText: '#12002b' } },
  { id: 'manga', label: 'Manga', style: {
    background: 'lines', color1: '#ffffff', color2: '#e2e2e2', margin: 4, gap: 1.5, borderWidth: 1.6, borderColor: '#000000',
    outerWidth: 0.8, outerColor: '#000000', titleFont: 'impact', titleSize: 9, numbers: true, numberAt: 'tr',
    numberShape: 'square', numberColor: '#000000', numberText: '#ffffff' } },
  { id: 'kraft', label: 'Kraft paper', style: {
    background: 'lines', color1: '#c9a173', color2: '#b98d5e', margin: 7, gap: 6, borderWidth: 3, borderColor: '#fffaf0',
    radius: 0.5, shadow: 2.8, titleFont: 'comic', titleColor: '#4a2f17', numbers: true, numberAt: 'bl', numberShape: 'tag',
    numberColor: '#fffaf0', numberText: '#4a2f17' } },
  { id: 'terminal', label: 'Terminal', style: {
    background: 'grid', color1: '#020a04', color2: '#0b2a12', margin: 5, gap: 3, borderWidth: 0.6, borderColor: '#3dff6b',
    borderKind: 'dotted', outerWidth: 0.6, outerColor: '#3dff6b', titleFont: 'mono', titleColor: '#3dff6b', titleAlign: 'left',
    numbers: true, numberShape: 'tag', numberColor: '#3dff6b', numberText: '#020a04' } },
  { id: 'museum', label: 'Museum', style: {
    background: 'solid', color1: '#4a0f1a', margin: 9, gap: 7, borderWidth: 1.6, borderColor: '#d4af37', borderKind: 'double',
    outerWidth: 1.6, outerColor: '#d4af37', outerKind: 'double', shadow: 2, titleFont: 'serif', titleSize: 8, titleColor: '#d4af37',
    titleItalic: true, numbers: true, numberAt: 'bl', numberShape: 'circle', numberColor: '#d4af37', numberText: '#4a0f1a' } },
  { id: 'candy', label: 'Candy', style: {
    background: 'checker', color1: '#ffffff', color2: '#ffd1e3', margin: 5, gap: 4.5, borderWidth: 1.8, borderColor: '#ff4d8d',
    borderKind: 'dashed', radius: 14, shadow: 1.2, titleFont: 'comic', titleColor: '#ff4d8d', numbers: true, numberShape: 'circle',
    numberColor: '#ff4d8d', numberText: '#ffffff' } },
  { id: 'rounded', label: 'Rounded', style: { background: 'solid', color1: '#f4f6f8', margin: 4, gap: 4, borderWidth: 0.8, borderColor: '#1b1f22', radius: 9, shadow: 1.2 } },
  { id: 'seamless', label: 'Seamless', style: { margin: 0, gap: 0, borderWidth: 0 } },
  { id: 'checker', label: 'Retro', style: {
    background: 'checker', color1: '#fff2d6', color2: '#f5d6a0', margin: 5, gap: 4, borderWidth: 1.4, borderColor: '#5b2a1c',
    outerWidth: 1, outerColor: '#5b2a1c', radius: 1, shadow: 1.8, titleFont: 'impact', titleColor: '#5b2a1c', titleSize: 8 } },
]

export function presetStyle(id: string, keep: Pick<FrameStyle, 'title'>): FrameStyle {
  const preset = PRESETS.find((p) => p.id === id)
  return { ...DEFAULT_FRAME, ...preset?.style, title: keep.title }
}

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i   // #rrggbb or #rrggbbaa (alpha = transparency)
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d)
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d)
const hex = (v: unknown, d: string) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : d)

export const TITLE_MAX = 60
/** extra vertical room (units) the title can move in; independent of its font size */
const TITLE_ROOM = 10

/** Any stored/untrusted value → a valid style (unknown or out-of-range fields fall back to the default). */
export function sanitizeFrame(raw: unknown): FrameStyle {
  const d = DEFAULT_FRAME
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    background: oneOf(r.background, Object.keys(BACKGROUNDS) as Background[], d.background),
    color1: hex(r.color1, d.color1), color2: hex(r.color2, d.color2), angle: num(r.angle, 0, 360, d.angle),
    margin: num(r.margin, 0, 20, d.margin), gap: num(r.gap, 0, 20, d.gap),
    outerWidth: num(r.outerWidth, 0, 6, d.outerWidth), outerColor: hex(r.outerColor, d.outerColor),
    outerKind: oneOf(r.outerKind, Object.keys(LINE_KINDS) as LineKind[], d.outerKind),
    outerRadius: num(r.outerRadius, 0, 30, d.outerRadius), outerBehind: hex(r.outerBehind, d.outerBehind),
    title: typeof r.title === 'string' ? r.title.slice(0, TITLE_MAX) : d.title,
    titleFont: oneOf(r.titleFont, Object.keys(TITLE_FONTS) as TitleFont[], d.titleFont),
    titleSize: num(r.titleSize, 3, 25, d.titleSize), titleColor: hex(r.titleColor, d.titleColor),
    titleAlign: oneOf(r.titleAlign, ['left', 'center', 'right'] as const, d.titleAlign),
    titleAt: oneOf(r.titleAt, ['top', 'bottom'] as const, d.titleAt),
    titleOffset: num(r.titleOffset, 0, 100, d.titleOffset),
    titleBold: typeof r.titleBold === 'boolean' ? r.titleBold : d.titleBold,
    titleItalic: r.titleItalic === true, titleUnderline: r.titleUnderline === true,
    borderWidth: num(r.borderWidth, 0, 8, d.borderWidth), borderColor: hex(r.borderColor, d.borderColor),
    borderKind: oneOf(r.borderKind, Object.keys(LINE_KINDS) as LineKind[], d.borderKind),
    radius: num(r.radius, 0, 30, d.radius), shadow: num(r.shadow, 0, 6, d.shadow),
    numbers: r.numbers === true, numberAt: oneOf(r.numberAt, Object.keys(CORNERS) as Corner[], d.numberAt),
    numberShape: oneOf(r.numberShape, Object.keys(NUMBER_SHAPES) as NumberShape[], d.numberShape),
    numberColor: hex(r.numberColor, d.numberColor), numberText: hex(r.numberText, d.numberText),
    numberSize: num(r.numberSize, 3, 25, d.numberSize),
  }
}

export const sameFrame = (a: FrameStyle, b: FrameStyle) => JSON.stringify(a) === JSON.stringify(b)

export interface FrameGeometry {
  layout: string
  width: number
  height: number
  rects: Rect[]
  /** panel corner radius, px */
  radius: number
}

const unit = (w: number, h: number) => Math.min(w, h) / 100
const titleOf = (s: FrameStyle) => s.title.trim()

/** The final board: same-size panels, with margin, gaps and the title band as the style says. */
export function frameGeometry(layout: string, rows: number, cols: number, panelW: number, panelH: number,
  s: FrameStyle): FrameGeometry {
  const u = unit(panelW, panelH)
  const line = s.borderWidth > 0 ? Math.max(1, Math.round(u * s.borderWidth)) : 0
  const outer = s.outerWidth > 0 ? Math.max(1, Math.round(u * s.outerWidth)) : 0
  const shadow = Math.round(u * s.shadow)
  // room the borders, the outer frame and the shadows need (so they are never cut or overlapping)
  const gap = Math.max(s.gap > 0 ? Math.max(6, Math.round(u * s.gap)) : 0, line > 0 ? line * 2 : 0, shadow > 0 ? shadow * 2 : 0)
  const corner = Math.round(u * s.outerRadius * 0.3)   // a rounded board corner cuts into the margin
  const margin = Math.max(s.margin > 0 ? Math.max(6, Math.round(u * s.margin)) : 0,
    (outer > 0 ? outer * 2 : 0) + line + (shadow > 0 ? Math.round(shadow * 1.4) : 0) + corner)
  const band = titleOf(s) ? Math.round(u * s.titleSize * 1.7) + Math.round(u * TITLE_ROOM) : 0   // the text's line + a fixed room to move it in (not tied to the font size)
  const top = margin + (s.titleAt === 'top' ? band : 0)
  const rects = Array.from({ length: rows * cols }, (_, i) => ({
    x: margin + (i % cols) * (panelW + gap),
    y: top + Math.floor(i / cols) * (panelH + gap),
    w: panelW, h: panelH,
  }))
  return {
    layout, rects, radius: Math.round(u * s.radius),
    width: cols * panelW + (cols - 1) * gap + 2 * margin,
    height: rows * panelH + (rows - 1) * gap + 2 * margin + band,
  }
}

function roundPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const k = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + k, y)
  ctx.arcTo(x + w, y, x + w, y + h, k)
  ctx.arcTo(x + w, y + h, x, y + h, k)
  ctx.arcTo(x, y + h, x, y, k)
  ctx.arcTo(x, y, x + w, y, k)
  ctx.closePath()
}

/**
 * A border of thickness `width` hugging the box: outward (dir 1, panels) or inward (dir -1, the outer
 * frame). `double` = two lines with a gap, `dashed`/`dotted` along the same path.
 */
function strokeBorder(ctx: CanvasRenderingContext2D, box: Rect, radius: number, width: number, color: string,
  kind: LineKind, dir: 1 | -1) {
  const line = (center: number, thick: number) => {
    const c = dir * center
    roundPath(ctx, box.x - c, box.y - c, box.w + 2 * c, box.h + 2 * c, Math.max(0, radius + c))
    ctx.lineWidth = thick
    ctx.stroke()
  }
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineJoin = 'round'
  if (kind === 'double') {
    line(width / 6, width / 3)
    line((width * 5) / 6, width / 3)
  } else {
    if (kind === 'dashed') ctx.setLineDash([width * 2.2, width * 1.4])
    if (kind === 'dotted') { ctx.setLineDash([0, width * 2]); ctx.lineCap = 'round' }
    line(width / 2, width)
  }
  ctx.restore()
}

function paintBackground(ctx: CanvasRenderingContext2D, w: number, h: number, u: number, s: FrameStyle) {
  ctx.fillStyle = s.color1
  ctx.fillRect(0, 0, w, h)
  const step = Math.max(6, u * 4)
  if (s.background === 'linear') {
    const a = (s.angle * Math.PI) / 180
    const cx = w / 2, cy = h / 2
    const reach = (Math.abs(Math.cos(a)) * w + Math.abs(Math.sin(a)) * h) / 2
    const g = ctx.createLinearGradient(cx - Math.cos(a) * reach, cy - Math.sin(a) * reach,
      cx + Math.cos(a) * reach, cy + Math.sin(a) * reach)
    g.addColorStop(0, s.color1)
    g.addColorStop(1, s.color2)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
  } else if (s.background === 'radial') {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.hypot(w, h) / 2)
    g.addColorStop(0, s.color1)
    g.addColorStop(1, s.color2)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
  } else if (s.background === 'dots') {
    ctx.fillStyle = s.color2
    for (let y = step / 2; y < h + step; y += step) {
      for (let x = ((Math.round(y / step) % 2) * step) / 2; x < w + step; x += step) {
        ctx.beginPath()
        ctx.arc(x, y, step * 0.2, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  } else if (s.background === 'grid' || s.background === 'lines') {
    ctx.strokeStyle = s.color2
    ctx.lineWidth = Math.max(1, step * 0.06)
    ctx.beginPath()
    for (let y = 0; y <= h; y += step) { ctx.moveTo(0, y); ctx.lineTo(w, y) }
    if (s.background === 'grid') for (let x = 0; x <= w; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, h) }
    ctx.stroke()
  } else if (s.background === 'stripes') {
    ctx.strokeStyle = s.color2
    ctx.lineWidth = step * 0.5
    ctx.beginPath()
    for (let x = -h; x <= w + step; x += step) { ctx.moveTo(x, h); ctx.lineTo(x + h, 0) }
    ctx.stroke()
  } else if (s.background === 'checker') {
    ctx.fillStyle = s.color2
    const cell = step * 1.5
    for (let y = 0, j = 0; y < h; y += cell, j++) {
      for (let x = 0, i = 0; x < w; x += cell, i++) if ((i + j) % 2 === 0) ctx.fillRect(x, y, cell, cell)
    }
  }
}

function paintNumber(ctx: CanvasRenderingContext2D, r: Rect, radius: number, u: number, s: FrameStyle, index: number) {
  const size = Math.max(10, u * s.numberSize)
  const label = s.numberShape === 'tag' ? `#${index + 1}` : String(index + 1)
  ctx.save()
  ctx.font = `700 ${size * 0.58}px ${TITLE_FONTS.sans.css}`
  const w = s.numberShape === 'tag' ? Math.max(size * 1.5, ctx.measureText(label).width + size * 0.7) : size
  const inset = u * 2 + radius * 0.25
  const x = s.numberAt === 'tl' || s.numberAt === 'bl' ? r.x + inset : r.x + r.w - inset - w
  const y = s.numberAt === 'tl' || s.numberAt === 'tr' ? r.y + inset : r.y + r.h - inset - size
  ctx.fillStyle = s.numberColor
  if (s.numberShape === 'circle') {
    ctx.beginPath()
    ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2)
  } else {
    roundPath(ctx, x, y, w, size, s.numberShape === 'tag' ? size / 2 : size * 0.18)
  }
  ctx.fill()
  ctx.fillStyle = s.numberText
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, x + w / 2, y + size / 2 + size * 0.04)
  ctx.restore()
}

function paintTitle(ctx: CanvasRenderingContext2D, g: FrameGeometry, u: number, s: FrameStyle, margin: number) {
  const text = titleOf(s)
  if (!text) return
  const line = Math.round(u * s.titleSize * 1.7)   // the text's own line
  const size = u * s.titleSize
  // the title moves in the space between the panels and the board's edge: 0% touches the panels, 100% the edge
  const last = g.rects[g.rects.length - 1]
  const space = s.titleAt === 'top' ? g.rects[0].y : g.height - (last.y + last.h)
  const away = (1 - s.titleOffset / 100) * Math.max(0, space - line)   // distance from the board edge
  const y = s.titleAt === 'top' ? away + line / 2 : g.height - away - line / 2
  const pad = Math.max(margin, u * 2)
  ctx.save()
  ctx.font = `${s.titleItalic ? 'italic ' : ''}${s.titleBold ? 700 : 400} ${size}px ${TITLE_FONTS[s.titleFont].css}`
  ctx.fillStyle = s.titleColor
  ctx.textBaseline = 'middle'
  ctx.textAlign = s.titleAlign
  const x = s.titleAlign === 'left' ? pad : s.titleAlign === 'right' ? g.width - pad : g.width / 2
  ctx.fillText(text, x, y, g.width - 2 * pad)
  if (s.titleUnderline) {
    const w = Math.min(ctx.measureText(text).width, g.width - 2 * pad)
    const x0 = s.titleAlign === 'left' ? x : s.titleAlign === 'right' ? x - w : x - w / 2
    const thick = Math.max(1, size * (s.titleBold ? 0.07 : 0.05))
    ctx.fillRect(x0, y + size * 0.52, w, thick)
  }
  ctx.restore()
}

/**
 * Draw the whole board at full size. `panel(i, rect)` paints panel i's picture (already clipped to its
 * rounded corners); everything else (background, shadows, borders, numbers, outer frame, title) is here.
 */
export function drawFrame(ctx: CanvasRenderingContext2D, g: FrameGeometry, s: FrameStyle,
  panel: (index: number, rect: Rect) => void) {
  const first = g.rects[0]
  const u = unit(first.w, first.h)
  const line = s.borderWidth > 0 ? Math.max(1, Math.round(u * s.borderWidth)) : 0
  const outer = s.outerWidth > 0 ? Math.max(1, Math.round(u * s.outerWidth)) : 0
  paintBackground(ctx, g.width, g.height, u, s)
  g.rects.forEach((r, i) => {
    if (s.shadow > 0) {
      ctx.save()
      ctx.shadowColor = 'rgba(0, 0, 0, 0.5)'
      ctx.shadowBlur = u * s.shadow * 1.6
      ctx.shadowOffsetX = u * s.shadow * 0.5
      ctx.shadowOffsetY = u * s.shadow * 0.7
      ctx.fillStyle = '#000000'
      roundPath(ctx, r.x - line, r.y - line, r.w + 2 * line, r.h + 2 * line, g.radius + line)
      ctx.fill()
      ctx.restore()
    }
    ctx.save()
    roundPath(ctx, r.x, r.y, r.w, r.h, g.radius)
    ctx.clip()
    panel(i, r)
    ctx.restore()
    if (line > 0) strokeBorder(ctx, r, g.radius, line, s.borderColor, s.borderKind, 1)
    if (s.numbers) paintNumber(ctx, r, g.radius, u, s, i)
  })
  const full = { x: 0, y: 0, w: g.width, h: g.height }
  const round = Math.min(Math.round(u * s.outerRadius), g.width / 2, g.height / 2)
  if (outer > 0) strokeBorder(ctx, full, round, outer, s.outerColor, s.outerKind, -1)
  paintTitle(ctx, g, u, s, first.x)
  if (round > 0) {
    // outside the rounded corners: what the visitor chose to show behind the board
    ctx.save()
    roundPath(ctx, 0, 0, g.width, g.height, round)   // (starts a new path)
    ctx.rect(0, 0, g.width, g.height)
    ctx.clip('evenodd')   // = only the four corners outside the rounding
    ctx.clearRect(0, 0, g.width, g.height)
    ctx.fillStyle = s.outerBehind
    ctx.fillRect(0, 0, g.width, g.height)
    ctx.restore()
  }
}
