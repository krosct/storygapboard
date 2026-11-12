import type { Rect } from './board'

// The look of the storyboard around the pictures: board background, margin, outer frame, title,
// and each panel's border, corners, shadow and number. Pure drawing + geometry (no model, no server):
// changing it only redraws the board from the panels' sources.

export type Background = 'solid' | 'linear' | 'radial' | 'dots' | 'grid' | 'lines' | 'stripes' | 'checker' | 'texture'
export type TextureId = 'paper' | 'canvas' | 'wood' | 'marble' | 'concrete' | 'denim' | 'watercolor'
export type LineKind = 'solid' | 'double' | 'dashed' | 'dotted'
export type Corner = 'tl' | 'tr' | 'bl' | 'br'
export type NumberShape = 'circle' | 'square' | 'tag'
export type TitleFont = 'sans' | 'serif' | 'mono' | 'comic' | 'impact'
export type Align = 'left' | 'center' | 'right'
export type AlignX = 'left' | 'center' | 'right'
export type AlignY = 'top' | 'middle' | 'bottom'

/** Board-wide adjustments: placement of the panel block, rotation and filters (applied to the whole board). */
export interface Adjustments {
  /** tilt of the panel block, degrees (-45..45) */
  rotation: number
  alignX: AlignX
  alignY: AlignY
  /**
   * What happens to the empty/removed slots: `kept` leaves them in place (an empty slot shows a
   * gray square), `reflow` drops them and lets the panels fill the gaps (a panel can move up a row),
   * `rows` drops them but keeps every panel in its own row (each row is aligned on its own).
   */
  emptyMode: 'kept' | 'reflow' | 'rows'
  sepia: number
  vhs: number
  scanlines: number
  grayscale: number
  grain: number
  vignette: number
  /** -100..100 */
  contrast: number
  /** -100..100 */
  saturation: number
  /** 0..10 px at panel scale */
  blur: number
  /** 0..100 */
  sharpen: number
}

export const DEFAULT_ADJUST: Adjustments = {
  rotation: 0, alignX: 'left', alignY: 'top', emptyMode: 'kept',
  sepia: 0, vhs: 0, scanlines: 0, grayscale: 0, grain: 0, vignette: 0,
  contrast: 0, saturation: 0, blur: 0, sharpen: 0,
}

/** Sizes are in "units": 1 unit = 1% of the shorter side of a panel, so a style looks the same at any resolution. */
export interface FrameStyle {
  background: Background
  /** which texture to paint when background = 'texture' (its own palette: no background color) */
  texture: TextureId
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
  /** board-wide placement, rotation and filters */
  adjust: Adjustments
}

export const DEFAULT_FRAME: FrameStyle = {
  background: 'solid', texture: 'paper', color1: '#ffffff', color2: '#d9dde0', angle: 90,
  margin: 4, gap: 4,
  outerWidth: 0, outerColor: '#1b1f22', outerKind: 'solid',
  outerRadius: 0, outerBehind: '#ffffff',
  title: '', titleFont: 'sans', titleSize: 7, titleColor: '#1b1f22', titleAlign: 'center', titleAt: 'top',
  titleOffset: 10, titleBold: true, titleItalic: false, titleUnderline: false,
  borderWidth: 0.4, borderColor: '#1b1f22', borderKind: 'solid', radius: 0, shadow: 0,
  numbers: false, numberAt: 'tl', numberShape: 'circle', numberColor: '#1b1f22', numberText: '#ffffff', numberSize: 7,
  adjust: DEFAULT_ADJUST,
}

/** The storyboard before any Frame customization: bare panels with a thin white gap (the Storyboard tab). */
export const PLAIN_FRAME: FrameStyle = { ...DEFAULT_FRAME, margin: 0, gap: 1, borderWidth: 0 }

export const BACKGROUNDS: Record<Background, string> = {
  solid: 'Solid color', linear: 'Gradient', radial: 'Radial gradient', dots: 'Dots', grid: 'Grid',
  lines: 'Lines', stripes: 'Diagonal stripes', checker: 'Checkerboard', texture: 'Texture',
}
export const TEXTURES: Record<TextureId, string> = {
  paper: 'Paper', canvas: 'Canvas', wood: 'Wood', marble: 'Marble',
  concrete: 'Concrete', denim: 'Denim', watercolor: 'Watercolor',
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
  // Textured looks: the background is a texture (its own palette), so no background color is used.
  { id: 'paper', label: 'Paper', style: {
    background: 'texture', texture: 'paper', margin: 6, gap: 5, borderWidth: 0.5, borderColor: '#8a7a5c',
    titleFont: 'serif', titleColor: '#4a3f2a', numbers: false } },
  { id: 'canvas', label: 'Canvas', style: {
    background: 'texture', texture: 'canvas', margin: 7, gap: 6, borderWidth: 1.2, borderColor: '#fbf7ee',
    radius: 0.5, shadow: 1.5, titleFont: 'sans', titleColor: '#5a4a30', numbers: true, numberAt: 'tl',
    numberShape: 'tag', numberColor: '#5a4a30', numberText: '#fbf7ee' } },
  { id: 'wood', label: 'Wood', style: {
    background: 'texture', texture: 'wood', margin: 6, gap: 4, borderWidth: 1.4, borderColor: '#2b1a0c',
    outerWidth: 1, outerColor: '#2b1a0c', titleFont: 'serif', titleColor: '#f3e3c8', numbers: true,
    numberAt: 'br', numberShape: 'circle', numberColor: '#f3e3c8', numberText: '#2b1a0c' } },
  { id: 'marble', label: 'Marble', style: {
    background: 'texture', texture: 'marble', margin: 8, gap: 6, borderWidth: 1.6, borderColor: '#b08d3f',
    borderKind: 'double', outerWidth: 1.6, outerColor: '#b08d3f', outerKind: 'double', shadow: 2,
    titleFont: 'serif', titleSize: 8, titleColor: '#3a3a3a', titleItalic: true, numbers: true,
    numberAt: 'bl', numberShape: 'circle', numberColor: '#b08d3f', numberText: '#ffffff' } },
  { id: 'concrete', label: 'Concrete', style: {
    background: 'texture', texture: 'concrete', margin: 5, gap: 3, borderWidth: 1.2, borderColor: '#1b1b1b',
    titleFont: 'impact', titleSize: 8, titleColor: '#1b1b1b', numbers: true, numberAt: 'tr',
    numberShape: 'square', numberColor: '#1b1b1b', numberText: '#e8e8e4' } },
  { id: 'denim', label: 'Denim', style: {
    background: 'texture', texture: 'denim', margin: 6, gap: 5, borderWidth: 1, borderColor: '#e8a33d',
    borderKind: 'dashed', radius: 1, titleFont: 'mono', titleColor: '#f0e6d2', numbers: true,
    numberAt: 'tl', numberShape: 'tag', numberColor: '#e8a33d', numberText: '#1d2f4a' } },
  { id: 'watercolor', label: 'Watercolor', style: {
    background: 'texture', texture: 'watercolor', margin: 6, gap: 5, borderWidth: 1.4, borderColor: '#ffffff',
    radius: 6, shadow: 1.2, titleFont: 'comic', titleColor: '#6b4a7a', numbers: true, numberShape: 'circle',
    numberColor: '#6b4a7a', numberText: '#ffffff' } },
]

export function presetStyle(id: string, keep: Pick<FrameStyle, 'title'>): FrameStyle {
  const preset = PRESETS.find((p) => p.id === id)
  return { ...DEFAULT_FRAME, ...preset?.style, title: keep.title }
}

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i   // #rrggbb or #rrggbbaa (alpha = transparency)
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d)
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d)
const hex = (v: unknown, d: string) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : d)

/** Any stored/untrusted value → valid adjustments (unknown or out-of-range fields fall back to the default). */
export function sanitizeAdjust(raw: unknown): Adjustments {
  const d = DEFAULT_ADJUST
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    rotation: num(r.rotation, -180, 180, d.rotation),
    alignX: oneOf(r.alignX, ['left', 'center', 'right'] as const, d.alignX),
    alignY: oneOf(r.alignY, ['top', 'middle', 'bottom'] as const, d.alignY),
    // legacy `trim: true` (before the three modes) means the reflow mode
    emptyMode: r.emptyMode === 'kept' || r.emptyMode === 'reflow' || r.emptyMode === 'rows'
      ? r.emptyMode
      : r.trim === true ? 'reflow' : d.emptyMode,
    sepia: num(r.sepia, 0, 100, d.sepia), vhs: num(r.vhs, 0, 100, d.vhs),
    scanlines: num(r.scanlines, 0, 100, d.scanlines), grayscale: num(r.grayscale, 0, 100, d.grayscale),
    grain: num(r.grain, 0, 100, d.grain), vignette: num(r.vignette, 0, 100, d.vignette),
    contrast: num(r.contrast, -100, 100, d.contrast), saturation: num(r.saturation, -100, 100, d.saturation),
    blur: num(r.blur, 0, 10, d.blur), sharpen: num(r.sharpen, 0, 100, d.sharpen),
  }
}

export const TITLE_MAX = 60
/** extra vertical room (units) the title can move in; independent of its font size */
const TITLE_ROOM = 10

/** Any stored/untrusted value → a valid style (unknown or out-of-range fields fall back to the default). */
export function sanitizeFrame(raw: unknown): FrameStyle {
  const d = DEFAULT_FRAME
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    background: oneOf(r.background, Object.keys(BACKGROUNDS) as Background[], d.background),
    texture: oneOf(r.texture, Object.keys(TEXTURES) as TextureId[], d.texture),
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
    adjust: sanitizeAdjust(r.adjust),
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
  /** slots laid out on the board (false = trimmed away) */
  visible: boolean[]
  /** tilt of the panel block, degrees */
  rotation: number
  /** rotation center, board px */
  pivot: { x: number; y: number }
}

const unit = (w: number, h: number) => Math.min(w, h) / 100
const titleOf = (s: FrameStyle) => s.title.trim()
/** A panel the visitor deleted but kept on the board: a plain gray square (it still takes its space). */
const EMPTY_PANEL = '#8a8f94'

/**
 * The final board: same-size panels, with margin, gaps and the title band as the style says.
 * `visible(i)` = the slot is on the board (a removed slot is not). With `adjust.trim` the visible
 * panels are reflowed (gaps closed) and the board shrinks to them; the block is then placed by the
 * alignment and tilted by the rotation (the board grows to contain it).
 */
export function frameGeometry(layout: string, rows: number, cols: number, panelW: number, panelH: number,
  s: FrameStyle, visible?: (i: number) => boolean): FrameGeometry {
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

  const total = rows * cols
  const all = Array.from({ length: total }, (_, i) => i)
  let shown = visible ? all.filter((i) => visible(i)) : all
  if (shown.length === 0) shown = all   // never leave the board without a size
  const adj = s.adjust
  const mode = adj.emptyMode
  const trim = mode !== 'kept' && shown.length < total

  const fullW = cols * panelW + (cols - 1) * gap
  const fullH = rows * panelH + (rows - 1) * gap

  // visible block, in local coords (0,0 = its top-left)
  const local: Rect[] = []
  const slotOf: number[] = []
  if (mode === 'reflow' && trim) {
    // fill the grid in reading order, closing the gaps (a panel can move up a row)
    const gCols = Math.min(cols, shown.length)
    shown.forEach((slot, k) => {
      const r = Math.floor(k / gCols), c = k % gCols
      local.push({ x: c * (panelW + gap), y: r * (panelH + gap), w: panelW, h: panelH })
      slotOf.push(slot)
    })
  } else if (mode === 'rows' && trim) {
    // keep every panel in its own row; each row is aligned on its own
    const rowSlots: number[][] = Array.from({ length: rows }, () => [])
    shown.forEach((slot) => rowSlots[Math.floor(slot / cols)].push(slot))
    const nonEmpty = rowSlots.filter((r) => r.length > 0)
    const rowWidth = (n: number) => n * panelW + (n - 1) * gap
    const contentW = Math.max(...nonEmpty.map((r) => rowWidth(r.length)))
    const fx = adj.alignX === 'left' ? 0 : adj.alignX === 'right' ? 1 : 0.5
    nonEmpty.forEach((r, ri) => {
      const x0 = (contentW - rowWidth(r.length)) * fx
      r.forEach((slot, k) => {
        local.push({ x: x0 + k * (panelW + gap), y: ri * (panelH + gap), w: panelW, h: panelH })
        slotOf.push(slot)
      })
    })
  } else {
    shown.forEach((slot) => {
      const r = Math.floor(slot / cols), c = slot % cols
      local.push({ x: c * (panelW + gap), y: r * (panelH + gap), w: panelW, h: panelH })
      slotOf.push(slot)
    })
  }
  const bx0 = Math.min(...local.map((r) => r.x))
  const by0 = Math.min(...local.map((r) => r.y))
  const bx1 = Math.max(...local.map((r) => r.x + r.w))
  const by1 = Math.max(...local.map((r) => r.y + r.h))
  const bw = bx1 - bx0
  const bh = by1 - by0

  // content area: the full grid (no trim) or the visible block (trim), grown to fit the rotation
  const contentW = trim ? bw : Math.max(fullW, bw)
  const contentH = trim ? bh : Math.max(fullH, bh)
  const angle = (adj.rotation * Math.PI) / 180
  const cos = Math.abs(Math.cos(angle)), sin = Math.abs(Math.sin(angle))
  const rw = bw * cos + bh * sin
  const rh = bw * sin + bh * cos
  const cw = Math.max(contentW, rw)
  const ch = Math.max(contentH, rh)

  // place the rotated block inside the content area
  const fx = adj.alignX === 'left' ? 0 : adj.alignX === 'right' ? 1 : 0.5
  const fy = adj.alignY === 'top' ? 0 : adj.alignY === 'bottom' ? 1 : 0.5
  const offX = (cw - rw) * fx
  const offY = (ch - rh) * fy
  const centerX = offX + rw / 2
  const centerY = offY + rh / 2
  const originX = margin + centerX - bw / 2 - bx0
  const originY = top + centerY - bh / 2 - by0

  const rects: Rect[] = Array.from({ length: total }, () => ({ x: 0, y: 0, w: panelW, h: panelH }))
  const vis: boolean[] = Array.from({ length: total }, () => false)
  local.forEach((r, k) => {
    const slot = slotOf[k]
    rects[slot] = { x: r.x + originX, y: r.y + originY, w: r.w, h: r.h }
    vis[slot] = true
  })

  return {
    layout, rects, radius: Math.round(u * s.radius),
    width: Math.round(cw + 2 * margin),
    height: Math.round(ch + 2 * margin + band),
    visible: vis,
    rotation: adj.rotation,
    pivot: { x: centerX + margin, y: centerY + top },
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

/** Small deterministic PRNG, so a texture looks the same in the preview and in the final board. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** A texture background: each one has its own palette (no background color is used). */
function paintTexture(ctx: CanvasRenderingContext2D, w: number, h: number, u: number, id: TextureId) {
  const r = rng(id.length * 7919 + id.charCodeAt(0) * 31 + id.charCodeAt(1) * 17)
  const speckle = (count: number, light: string, dark: string, size: number) => {
    for (let i = 0; i < count; i++) {
      ctx.fillStyle = r() > 0.5 ? light : dark
      ctx.fillRect(r() * w, r() * h, size * (0.5 + r()), size * (0.5 + r()))
    }
  }
  if (id === 'paper') {
    // old, worn paper: stains, heavy grain, fibers and darkened edges
    ctx.fillStyle = '#e8dcc0'
    ctx.fillRect(0, 0, w, h)
    for (let i = 0; i < 26; i++) {
      const x = r() * w, y = r() * h, rad = (0.06 + r() * 0.22) * Math.min(w, h)
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad)
      g.addColorStop(0, `rgba(150,120,70,${0.05 + r() * 0.12})`)
      g.addColorStop(1, 'rgba(150,120,70,0)')
      ctx.fillStyle = g
      ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill()
    }
    speckle(6000, 'rgba(255,255,255,0.10)', 'rgba(90,70,40,0.10)', 2.2)
    ctx.strokeStyle = 'rgba(90,70,40,0.08)'
    ctx.lineWidth = 1
    for (let i = 0; i < 260; i++) {
      const x = r() * w, y = r() * h, len = u * (2 + r() * 8)
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + len, y + (r() - 0.5) * 3); ctx.stroke()
    }
    const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.6)
    vg.addColorStop(0, 'rgba(0,0,0,0)')
    vg.addColorStop(1, 'rgba(80,60,30,0.22)')
    ctx.fillStyle = vg
    ctx.fillRect(0, 0, w, h)
  } else if (id === 'canvas') {
    ctx.fillStyle = '#d9cbb0'
    ctx.fillRect(0, 0, w, h)
    const step = Math.max(3, u * 1.2)
    for (let y = 0; y < h; y += step) { ctx.fillStyle = 'rgba(255,255,255,0.10)'; ctx.fillRect(0, y, w, step / 2) }
    for (let x = 0; x < w; x += step) { ctx.fillStyle = 'rgba(0,0,0,0.05)'; ctx.fillRect(x, 0, step / 2, h) }
    speckle(1200, 'rgba(255,255,255,0.08)', 'rgba(90,70,40,0.06)', 2)
  } else if (id === 'wood') {
    ctx.fillStyle = '#8a5a2b'
    ctx.fillRect(0, 0, w, h)
    for (let i = 0; i < 70; i++) {
      const y0 = r() * h
      const freq = 1 + r() * 2
      const amp = u * 1.5 + r() * u * 3
      ctx.strokeStyle = `rgba(60,35,15,${0.06 + r() * 0.16})`
      ctx.lineWidth = 1 + r() * 3
      ctx.beginPath()
      for (let x = 0; x <= w; x += Math.max(6, u)) {
        const y = y0 + Math.sin((x / w) * Math.PI * 2 * freq + i) * amp
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
    speckle(900, 'rgba(255,220,170,0.05)', 'rgba(40,20,5,0.08)', 2)
  } else if (id === 'marble') {
    ctx.fillStyle = '#f2f2f0'
    ctx.fillRect(0, 0, w, h)
    for (let i = 0; i < 22; i++) {
      ctx.strokeStyle = `rgba(90,95,105,${0.06 + r() * 0.18})`
      ctx.lineWidth = 0.5 + r() * 2.5
      ctx.beginPath()
      let x = r() * w, y = r() * h
      ctx.moveTo(x, y)
      for (let k = 0; k < 6; k++) {
        const nx = x + (r() - 0.5) * w * 0.4, ny = y + (r() - 0.5) * h * 0.4
        ctx.quadraticCurveTo(x + (r() - 0.5) * w * 0.2, y + (r() - 0.5) * h * 0.2, nx, ny)
        x = nx; y = ny
      }
      ctx.stroke()
    }
    speckle(800, 'rgba(255,255,255,0.10)', 'rgba(120,125,135,0.05)', 2)
  } else if (id === 'concrete') {
    ctx.fillStyle = '#9a9a96'
    ctx.fillRect(0, 0, w, h)
    speckle(4200, 'rgba(255,255,255,0.07)', 'rgba(0,0,0,0.09)', 2.5)
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = `rgba(0,0,0,${0.02 + r() * 0.04})`
      ctx.beginPath(); ctx.arc(r() * w, r() * h, u * (2 + r() * 8), 0, Math.PI * 2); ctx.fill()
    }
  } else if (id === 'denim') {
    ctx.fillStyle = '#2f4f7a'
    ctx.fillRect(0, 0, w, h)
    const step = Math.max(3, u * 1.1)
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'
    for (let x = -h; x < w + step; x += step) { ctx.beginPath(); ctx.moveTo(x, h); ctx.lineTo(x + h, 0); ctx.stroke() }
    ctx.strokeStyle = 'rgba(0,0,0,0.12)'
    for (let x = -h; x < w + step; x += step) { ctx.beginPath(); ctx.moveTo(x + step / 2, h); ctx.lineTo(x + step / 2 + h, 0); ctx.stroke() }
    speckle(1000, 'rgba(255,255,255,0.06)', 'rgba(0,0,0,0.08)', 2)
  } else {
    // watercolor: strong, overlapping pastel washes with paper grain over them
    ctx.fillStyle = '#fdf6ee'
    ctx.fillRect(0, 0, w, h)
    const colors = ['#ff7aa2', '#5bb8e8', '#ffcf4d', '#6fcf7f', '#b07ad8', '#ff9a5c']
    for (let i = 0; i < 70; i++) {
      const x = r() * w, y = r() * h, rad = (0.1 + r() * 0.35) * Math.min(w, h)
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad)
      const c = colors[Math.floor(r() * colors.length)]
      g.addColorStop(0, `${c}aa`)
      g.addColorStop(0.6, `${c}55`)
      g.addColorStop(1, `${c}00`)
      ctx.fillStyle = g
      ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill()
    }
    speckle(1500, 'rgba(255,255,255,0.10)', 'rgba(80,60,40,0.05)', 2)
  }
}

function paintBackground(ctx: CanvasRenderingContext2D, w: number, h: number, u: number, s: FrameStyle) {
  if (s.background === 'texture') {
    paintTexture(ctx, w, h, u, s.texture)
    return
  }
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
  // the title moves in its band: 0% touches the panels, 100% the board's edge
  const space = line + Math.round(u * TITLE_ROOM)
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
 * Board-wide filters, applied to the finished board (background, panels, frame and title together).
 * Color/tone effects use the canvas filter; the texture ones (VHS, scanlines, grain, vignette,
 * sharpen) are pixel passes. Runs in device pixels, so it works on the scaled preview too.
 */
function applyFilters(ctx: CanvasRenderingContext2D, s: FrameStyle) {
  const a = s.adjust
  const w = ctx.canvas.width
  const h = ctx.canvas.height
  if (w < 1 || h < 1) return
  const css: string[] = []
  if (a.sepia > 0) css.push(`sepia(${a.sepia}%)`)
  if (a.grayscale > 0) css.push(`grayscale(${a.grayscale}%)`)
  if (a.contrast !== 0) css.push(`contrast(${100 + a.contrast}%)`)
  if (a.saturation !== 0) css.push(`saturate(${100 + a.saturation}%)`)
  if (a.blur > 0) css.push(`blur(${a.blur}px)`)
  if (css.length > 0) {
    const tmp = document.createElement('canvas')
    tmp.width = w
    tmp.height = h
    const t = tmp.getContext('2d')
    if (t) {
      t.filter = css.join(' ')
      t.drawImage(ctx.canvas, 0, 0)
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, w, h)
      ctx.drawImage(tmp, 0, 0)
      ctx.restore()
    }
  }
  if (a.vhs <= 0 && a.scanlines <= 0 && a.grain <= 0 && a.vignette <= 0 && a.sharpen <= 0) return
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data
  if (a.scanlines > 0) {
    const step = Math.max(2, Math.round(h / 300))
    const dark = (a.scanlines / 100) * 0.5
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        d[i] *= 1 - dark; d[i + 1] *= 1 - dark; d[i + 2] *= 1 - dark
      }
    }
  }
  if (a.grain > 0) {
    const amt = (a.grain / 100) * 60
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() - 0.5) * amt
      d[i] += n; d[i + 1] += n; d[i + 2] += n
    }
  }
  if (a.vignette > 0) {
    const cx = w / 2, cy = h / 2, max = Math.hypot(cx, cy)
    const amt = a.vignette / 100
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dist = Math.hypot(x - cx, y - cy) / max
        const f = 1 - amt * Math.max(0, dist - 0.35) / 0.65
        const i = (y * w + x) * 4
        d[i] *= f; d[i + 1] *= f; d[i + 2] *= f
      }
    }
  }
  if (a.vhs > 0) {
    const amt = a.vhs / 100
    const shift = Math.max(1, Math.round(w * 0.004 * amt))
    const copy = new Uint8ClampedArray(d)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        const xr = Math.min(w - 1, x + shift), xb = Math.max(0, x - shift)
        d[i] = copy[(y * w + xr) * 4]
        d[i + 2] = copy[(y * w + xb) * 4 + 2]
      }
    }
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() - 0.5) * 30 * amt
      d[i] += n; d[i + 1] += n; d[i + 2] += n
    }
  }
  if (a.sharpen > 0) {
    const amt = (a.sharpen / 100) * 2
    const copy = new Uint8ClampedArray(d)
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = (y * w + x) * 4
        for (let c = 0; c < 3; c++) {
          const blur = (copy[i - 4 + c] + copy[i + 4 + c] + copy[i - w * 4 + c] + copy[i + w * 4 + c]) / 4
          d[i + c] = copy[i + c] + (copy[i + c] - blur) * amt
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0)
}

/**
 * Draw the whole board at full size. `panel(i, rect)` paints panel i's picture (already clipped to its
 * rounded corners); everything else (background, shadows, borders, numbers, outer frame, title) is here.
 * `hidden(i)` = a panel the visitor removed: nothing is drawn there (the region stays transparent).
 * `removed(i)` = the slot itself was removed: nothing is drawn there and the background shows through.
 */
export function drawFrame(ctx: CanvasRenderingContext2D, g: FrameGeometry, s: FrameStyle,
  panel: (index: number, rect: Rect) => void, hidden?: (index: number) => boolean,
  removed?: (index: number) => boolean) {
  const first = g.rects.find((_, i) => g.visible[i]) ?? g.rects[0]
  const u = unit(first.w, first.h)
  const line = s.borderWidth > 0 ? Math.max(1, Math.round(u * s.borderWidth)) : 0
  const outer = s.outerWidth > 0 ? Math.max(1, Math.round(u * s.outerWidth)) : 0
  paintBackground(ctx, g.width, g.height, u, s)
  ctx.save()
  if (g.rotation) {
    ctx.translate(g.pivot.x, g.pivot.y)
    ctx.rotate((g.rotation * Math.PI) / 180)
    ctx.translate(-g.pivot.x, -g.pivot.y)
  }
  g.rects.forEach((r, i) => {
    if (!g.visible[i] || removed?.(i)) return
    const isEmpty = hidden?.(i) === true
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
    if (isEmpty) {
      ctx.fillStyle = EMPTY_PANEL
      ctx.fillRect(r.x, r.y, r.w, r.h)
    } else {
      panel(i, r)
    }
    ctx.restore()
    if (line > 0) strokeBorder(ctx, r, g.radius, line, s.borderColor, s.borderKind, 1)
    if (s.numbers) paintNumber(ctx, r, g.radius, u, s, i)
  })
  ctx.restore()
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
  applyFilters(ctx, s)
}
