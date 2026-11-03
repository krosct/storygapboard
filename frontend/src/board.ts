// Storyboard canvas work, all in the browser: the generation plan (grid and ratio
// asked from the model), the layout guide, the final board (each panel drawn from
// its source: a cell of the model's answer or the visitor's own image, framed and
// movable; margins and frames) and the masked blend of a retouched panel.

export interface Rect { x: number; y: number; w: number; h: number }

/** A visitor's own panel: the image and its framing (0..1 like CSS object-position, 0.5 = centered). */
export interface FixedPanel { file: File; x: number; y: number }

export type Panels = (FixedPanel | null)[]

const GUIDE_LONG_SIDE = 1024
// two grays in a checkerboard: neighbor placeholders stay apart without borders
const PLACEHOLDERS = ['#8a8f94', '#7c8186']

export function parseLayout(layout: string): [number, number] {
  const [rows, cols] = layout.split('x').map(Number)
  return [rows || 1, cols || 1]
}

export function panelCount(layout: string): number {
  const [rows, cols] = parseLayout(layout)
  return rows * cols
}

/** Panel i (0-based, left to right, top to bottom) of a W x H board. */
export function cellRect(i: number, layout: string, width: number, height: number): Rect {
  const [rows, cols] = parseLayout(layout)
  const r = Math.floor(i / cols)
  const c = i % cols
  const x0 = Math.round((c * width) / cols)
  const y0 = Math.round((r * height) / rows)
  const x1 = Math.round(((c + 1) * width) / cols)
  const y1 = Math.round(((r + 1) * height) / rows)
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

export function parseRatio(text: string): number | null {
  const [w, h] = text.split(':').map(Number)
  return w > 0 && h > 0 ? w / h : null
}

/** What to ask the model for. The visitor's layout is rebuilt from it afterwards. */
export interface Plan {
  /** grid the visitor picked (the final board) */
  layout: string
  /** grid asked from the model: same panel count and reading order, any shape */
  genLayout: string
  /** whole-image ratio sent to the model */
  boardAspect: string
  /** panel shape the visitor picked (width / height); null = "auto", taken from the result */
  panelRatio: number | null
}

// Board ratios image models handle well (extreme ones like 8:1 are often ignored).
const COMMON_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '9:21', '21:9']

const GRID_SWITCH_COST = 0.15

/**
 * Ratio is the shape of each panel. Models only make a few image ratios, so pick
 * the grid (with the same panel count) and the ratio whose panels come closest:
 * 6 square panels in 1x6 are asked as 2x3 at 3:2, then laid out in a row.
 */
export function planGeneration(layout: string, panelAspect: string, layouts: string[], ratios: string[]): Plan {
  const target = parseRatio(panelAspect)
  const offered = ratios.filter((r) => COMMON_RATIOS.includes(r))
  if (target === null || offered.length === 0) {
    return { layout, genLayout: layout, boardAspect: 'auto', panelRatio: target }
  }
  const total = panelCount(layout)
  // the visitor's own grid first, so it wins ties
  const grids = [layout, ...layouts.filter((l) => l !== layout && panelCount(l) === total)]
  let best = { genLayout: layout, boardAspect: offered[0], err: Infinity }
  for (const grid of grids) {
    const [rows, cols] = parseLayout(grid)
    for (const aspect of offered) {
      const shape = ((parseRatio(aspect) ?? 1) * rows) / cols
      // another grid only when clearly better: models follow the asked grid less reliably then
      const err = Math.abs(Math.log(shape / target)) + (grid === layout ? 0 : GRID_SWITCH_COST)
      if (err < best.err - 1e-9) best = { genLayout: grid, boardAspect: aspect, err }
    }
  }
  return { layout, genLayout: best.genLayout, boardAspect: best.boardAspect, panelRatio: target }
}

/** Board ratio (width / height) for a layout: the chosen ratio, or 4:3 panels on "auto". */
export function boardRatio(layout: string, aspectRatio: string): number {
  const [w, h] = aspectRatio.split(':').map(Number)
  if (w > 0 && h > 0) return w / h
  const [rows, cols] = parseLayout(layout)
  return (cols * 4) / (rows * 3)
}

function canvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const el = document.createElement('canvas')
  el.width = width
  el.height = height
  const ctx = el.getContext('2d')
  if (!ctx) throw new Error('This browser cannot draw images (canvas unavailable).')
  return [el, ctx]
}

export async function loadImage(source: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(source)
  } catch {
    throw new Error('Could not read an image. Try another file.')
  }
}

type Drawable = CanvasImageSource & { width: number; height: number }

/**
 * Draw the src part of img covering dst, without distortion. The crop follows
 * (fx, fy) exactly like CSS object-fit: cover + object-position, so a visitor's
 * panel lands on the board as framed in the Panels preview (same shape: no crop).
 */
function drawCover(ctx: CanvasRenderingContext2D, img: Drawable, dst: Rect,
  src: Rect = { x: 0, y: 0, w: img.width, h: img.height }, fx = 0.5, fy = 0.5) {
  const scale = Math.max(dst.w / src.w, dst.h / src.h)
  const sw = dst.w / scale
  const sh = dst.h / scale
  ctx.drawImage(img, src.x + (src.w - sw) * fx, src.y + (src.h - sh) * fy, sw, sh, dst.x, dst.y, dst.w, dst.h)
}

async function drawFixed(ctx: CanvasRenderingContext2D, panel: FixedPanel, dst: Rect) {
  const img = await loadImage(panel.file)
  drawCover(ctx, img, dst, undefined, panel.x, panel.y)
  img.close()
}

/**
 * Where one panel of the final board takes its pixels from: a region of an
 * image (the visitor's file, or its cell in the model's answer), framed like CSS
 * object-position. Keeping it (not just the composed board) lets the visitor
 * move the framing later, also after a retouch.
 */
export interface PanelSource { image: Blob; rect: Rect; x: number; y: number }

// Decoded images, kept while their blob lives (every board version reuses them).
const bitmaps = new WeakMap<Blob, Promise<ImageBitmap>>()

export function bitmapOf(image: Blob): Promise<ImageBitmap> {
  let bitmap = bitmaps.get(image)
  if (!bitmap) {
    bitmap = loadImage(image)
    bitmaps.set(image, bitmap)
    bitmap.catch(() => bitmaps.delete(image))
  }
  return bitmap
}

/** Draw a panel source into dst, with its framing. */
export function drawSource(ctx: CanvasRenderingContext2D, bitmap: ImageBitmap, source: PanelSource, dst: Rect) {
  drawCover(ctx, bitmap, dst, source.rect, source.x, source.y)
}

/** How far (in panel px) the source overflows a w x h panel on each axis: room to move the framing. */
export function framingRoom(source: PanelSource, w: number, h: number): [number, number] {
  const scale = Math.max(w / source.rect.w, h / source.rect.h)
  return [source.rect.w * scale - w, source.rect.h * scale - h]
}

/** The part of the source a w x h panel shows (source pixels). */
function visibleWindow(source: PanelSource, w: number, h: number): Rect {
  const { rect } = source
  const scale = Math.max(w / rect.w, h / rect.h)
  const sw = w / scale
  const sh = h / scale
  return { x: rect.x + (rect.w - sw) * source.x, y: rect.y + (rect.h - sh) * source.y, w: sw, h: sh }
}

const PAPER = '#ffffff'
const INK = '#1b1f22'

/** Final board geometry: panels of the same size with a margin around and between them. */
function boardGeometry(layout: string, panelW: number, panelH: number): BoardGeometry {
  const [rows, cols] = parseLayout(layout)
  const gap = Math.max(6, Math.round(Math.min(panelW, panelH) * 0.04))
  const rects = Array.from({ length: rows * cols }, (_, i) => ({
    x: gap + (i % cols) * (panelW + gap),
    y: gap + Math.floor(i / cols) * (panelH + gap),
    w: panelW,
    h: panelH,
  }))
  return { width: cols * panelW + (cols + 1) * gap, height: rows * panelH + (rows + 1) * gap, rects }
}

/** Thin dark frame just outside each panel (a white gap alone vanishes on white drawings). */
function drawFrames(ctx: CanvasRenderingContext2D, rects: Rect[]) {
  const line = Math.max(1, Math.round(Math.min(rects[0].w, rects[0].h) * 0.004))
  ctx.strokeStyle = INK
  ctx.lineWidth = line
  for (const r of rects) ctx.strokeRect(r.x - line / 2, r.y - line / 2, r.w + line, r.h + line)
}

export interface BoardGeometry { width: number; height: number; rects: Rect[] }

const MIME: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }

export function canvasToBlob(el: HTMLCanvasElement, format: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    el.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the image.'))),
      MIME[format] ?? 'image/png', 0.92)
  })
}

/** Extension matching what the browser really encoded (Safari may fall back to PNG). */
export function blobExt(blob: Blob): string {
  return blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png'
}

/** The grid sent as the first reference (in the model's grid): fixed panels in place, numbered gray placeholders. */
export async function composeGuide(plan: Plan, panels: Panels): Promise<Blob> {
  const layout = plan.genLayout
  const ratio = boardRatio(layout, plan.boardAspect)
  const width = Math.round(ratio >= 1 ? GUIDE_LONG_SIDE : GUIDE_LONG_SIDE * ratio)
  const height = Math.round(ratio >= 1 ? GUIDE_LONG_SIDE / ratio : GUIDE_LONG_SIDE)
  const [el, ctx] = canvas(width, height)
  const total = panelCount(layout)
  const cols = parseLayout(layout)[1]
  for (let i = 0; i < total; i++) {
    const rect = cellRect(i, layout, width, height)
    const panel = panels[i]
    if (panel) {
      await drawFixed(ctx, panel, rect)
    } else {
      ctx.fillStyle = PLACEHOLDERS[(Math.floor(i / cols) + (i % cols)) % 2]
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h)
      ctx.fillStyle = '#ffffff'
      ctx.font = `600 ${Math.round(Math.min(rect.w, rect.h) * 0.3)}px sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(i + 1), rect.x + rect.w / 2, rect.y + rect.h / 2)
    }
  }
  // no borders: the model is asked for edge-to-edge panels (the final board gets ours)
  return canvasToBlob(el, 'jpeg')
}

// Panel detection in the model's image. Models do not always split the grid
// evenly or keep it edge to edge (uneven widths, their own borders), so a plain
// equal split can cut a slice of the neighbour panel. Seams = lines or bands that
// cross the whole image near each expected boundary; the cut snaps to them.
const SEAM_ANALYSIS = 480     // analysis width in px
const SEAM_WINDOW = 0.15      // search +-15% of a cell around the expected boundary
const SEAM_MIN = 0.55         // a seam crosses at least 55% of the image
const SEAM_BAND = 0.05        // a border band is at most 5% of a cell wide
const CELL_INSET = 0.015      // then drop 1.5% per side (line remnants)

function grayPixels(img: ImageBitmap): { gray: Float32Array; w: number; h: number } {
  const w = Math.min(SEAM_ANALYSIS, img.width)
  const h = Math.max(1, Math.round((img.height * w) / img.width))
  const [, ctx] = canvas(w, h)
  ctx.drawImage(img, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h).data
  const gray = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
  return { gray, w, h }
}

/** Share of the image each column (vertical seams) or row crosses with a sharp step. */
function seamScores(gray: Float32Array, w: number, h: number, vertical: boolean): Float32Array {
  const length = vertical ? w : h
  const across = vertical ? h : w
  const at = (pos: number, k: number) => (vertical ? gray[k * w + pos] : gray[pos * w + k])
  const scores = new Float32Array(length)
  for (let pos = 1; pos < length - 1; pos++) {
    let hits = 0
    for (let k = 0; k < across; k++) if (Math.abs(at(pos + 1, k) - at(pos - 1, k)) > 40) hits++
    scores[pos] = hits / across
  }
  return scores
}

/** [end of the cell before, start of the cell after] around one expected boundary. */
function snapBoundary(scores: Float32Array, expected: number, cell: number): [number, number] {
  const window = Math.round(cell * SEAM_WINDOW)
  let best = -1
  let bestValue = 0
  for (let pos = Math.max(1, expected - window); pos <= Math.min(scores.length - 2, expected + window); pos++) {
    // prefer seams near the expected place (a content line further away loses)
    const value = scores[pos] * (1 - (0.5 * Math.abs(pos - expected)) / window)
    if (scores[pos] >= SEAM_MIN && value > bestValue) [best, bestValue] = [pos, value]
  }
  if (best < 0) return [expected, expected]
  // a band (gutter) has an edge on each side: keep it out of both cells
  const band = Math.max(2, Math.round(cell * SEAM_BAND))
  let [start, end] = [best, best]
  for (let pos = Math.max(1, best - band); pos <= Math.min(scores.length - 2, best + band); pos++) {
    if (scores[pos] >= SEAM_MIN * 0.8) [start, end] = [Math.min(start, pos), Math.max(end, pos)]
  }
  return [start, end]
}

/** Cut lines along one axis: [start, end) of each cell, in analysis pixels. */
function cuts(scores: Float32Array, count: number): [number, number][] {
  const length = scores.length
  const cell = length / count
  const bounds = Array.from({ length: count - 1 }, (_, i) => snapBoundary(scores, Math.round(cell * (i + 1)), cell))
  return Array.from({ length: count }, (_, i) => [i === 0 ? 0 : bounds[i - 1][1] + 1, i === count - 1 ? length : bounds[i][0]])
}

/** Where each panel really is in the model's image (reading order). */
export function detectCells(img: ImageBitmap, layout: string): Rect[] {
  const [rows, cols] = parseLayout(layout)
  const { gray, w, h } = grayPixels(img)
  const xs = cuts(seamScores(gray, w, h, true), cols)
  const ys = cuts(seamScores(gray, w, h, false), rows)
  const sx = img.width / w
  const sy = img.height / h
  return Array.from({ length: rows * cols }, (_, i) => {
    const [x0, x1] = xs[i % cols]
    const [y0, y1] = ys[Math.floor(i / cols)]
    const rect = { x: x0 * sx, y: y0 * sy, w: (x1 - x0) * sx, h: (y1 - y0) * sy }
    // the snapped cell must stay plausible, else fall back to the even split
    const even = cellRect(i, layout, img.width, img.height)
    if (rect.w < even.w * 0.6 || rect.h < even.h * 0.6) return inset(even)
    return inset(rect)
  })
}

function inset(rect: Rect): Rect {
  const dx = rect.w * CELL_INSET
  const dy = rect.h * CELL_INSET
  return { x: rect.x + dx, y: rect.y + dy, w: rect.w - 2 * dx, h: rect.h - 2 * dy }
}

/**
 * The final board's plan, in the visitor's layout: panels exactly in the chosen
 * shape, each with its source. Generated panels come from their cell in the
 * model's answer (centered); the visitor's own panels from their file, framed as
 * in the preview. renderBoard draws it.
 */
export async function composeBoard(generated: Blob, plan: Plan,
  panels: Panels): Promise<BoardGeometry & { sources: PanelSource[] }> {
  const img = await bitmapOf(generated)
  const total = panelCount(plan.layout)
  const cells = detectCells(img, plan.genLayout)
  const ratio = plan.panelRatio ?? cells[0].w / cells[0].h
  // same pixel area as a generated panel, in the chosen shape
  const area = (img.width * img.height) / total
  const panelW = Math.max(16, Math.round(Math.sqrt(area * ratio)))
  const panelH = Math.max(16, Math.round(panelW / ratio))
  const sources = await Promise.all(Array.from({ length: total }, async (_, i): Promise<PanelSource> => {
    const panel = panels[i]
    if (!panel) return { image: generated, rect: cells[i], x: 0.5, y: 0.5 }
    const own = await bitmapOf(panel.file)
    return { image: panel.file, rect: { x: 0, y: 0, w: own.width, h: own.height }, x: panel.x, y: panel.y }
  }))
  return { ...boardGeometry(plan.layout, panelW, panelH), sources }
}

/** Draw the board: white paper, every panel from its source, thin frames. */
export async function renderBoard(geometry: BoardGeometry, sources: PanelSource[], format: string): Promise<Blob> {
  const [el, ctx] = canvas(geometry.width, geometry.height)
  ctx.fillStyle = PAPER
  ctx.fillRect(0, 0, el.width, el.height)
  for (let i = 0; i < sources.length; i++) drawSource(ctx, await bitmapOf(sources[i].image), sources[i], geometry.rects[i])
  drawFrames(ctx, geometry.rects)
  return canvasToBlob(el, format)
}

/** One panel of the board, as its own canvas. */
export async function cropPanel(board: Blob, rect: Rect): Promise<HTMLCanvasElement> {
  const img = await loadImage(board)
  const [el, ctx] = canvas(rect.w, rect.h)
  ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h)
  img.close()
  return el
}

// Lining a retouch up with the panel. Models redraw the whole panel and rarely put
// things back exactly in place; pasted as is, a few pixels of drift show the old
// picture through the soft edge of the mask (ghost outlines). The shift is measured
// outside the marks, where both images should agree.
const ALIGN_SIZE = 128        // analysis size (long side, px)
const ALIGN_REACH = 0.06      // search +-6% of the panel
const ALIGN_GAIN = 0.85       // a shift must cut the difference by 15% to be used

function grayOf(img: CanvasImageSource, w: number, h: number): Float32Array {
  const [, ctx] = canvas(w, h)
  ctx.drawImage(img, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h).data
  const gray = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
  return gray
}

/** Shift (panel px) to draw the answer at so it matches the panel outside the marks; [0, 0] when unsure. */
export function alignShift(panel: CanvasImageSource, answer: CanvasImageSource, mask: HTMLCanvasElement,
  panelW: number, panelH: number): [number, number] {
  const scale = ALIGN_SIZE / Math.max(panelW, panelH)
  const w = Math.max(8, Math.round(panelW * scale))
  const h = Math.max(8, Math.round(panelH * scale))
  const ref = grayOf(panel, w, h)
  const ans = grayOf(answer, w, h)
  const [, mctx] = canvas(w, h)
  mctx.drawImage(mask, 0, 0, w, h)
  const alpha = mctx.getImageData(0, 0, w, h).data
  const reach = Math.max(1, Math.round(Math.max(w, h) * ALIGN_REACH))
  const score = (dx: number, dy: number) => {
    let sum = 0
    let count = 0
    for (let y = reach; y < h - reach; y++) {
      for (let x = reach; x < w - reach; x++) {
        if (alpha[(y * w + x) * 4 + 3] > 25) continue   // inside the marks: allowed to differ
        sum += Math.abs(ref[y * w + x] - ans[(y - dy) * w + (x - dx)])
        count++
      }
    }
    return count > (w * h) / 10 ? sum / count : Infinity
  }
  const zero = score(0, 0)
  let best: [number, number] = [0, 0]
  let bestScore = zero
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const value = score(dx, dy)
      if (value < bestScore) [best, bestScore] = [[dx, dy], value]
    }
  }
  if (!Number.isFinite(zero) || bestScore > zero * ALIGN_GAIN) return [0, 0]
  return [best[0] / scale, best[1] / scale]
}

/**
 * Blend a retouch into the panel's source, only where the visitor marked it
 * (mask = white on transparent, panel-sized, already feathered): the part the
 * panel shows is replaced through the mask, every other pixel stays. The answer
 * is stretched to the panel (the request asks for its shape) and shifted when that
 * lines it up better (measured outside alignMask, the marks). The result is a new source with the same region and
 * framing, so it can still be moved.
 */
export async function applySourceEdit(source: PanelSource, panelW: number, panelH: number, edited: Blob,
  mask: HTMLCanvasElement, alignMask: HTMLCanvasElement = mask): Promise<{ source: PanelSource; shift: [number, number] }> {
  const base = await bitmapOf(source.image)
  const shown = visibleWindow(source, panelW, panelH)
  const [el, ctx] = canvas(base.width, base.height)
  ctx.drawImage(base, 0, 0)
  const w = Math.max(1, Math.round(shown.w))
  const h = Math.max(1, Math.round(shown.h))
  const answer = await bitmapOf(edited)
  // the panel as the model saw it, to line the answer up with
  const [panel, panelCtx] = canvas(panelW, panelH)
  drawSource(panelCtx, base, source, { x: 0, y: 0, w: panelW, h: panelH })
  // measured outside the marks (alignMask), whatever the blend reach: "the whole panel" leaves no outside
  const [shiftX, shiftY] = alignShift(panel, answer, alignMask, panelW, panelH)
  const [patch, pctx] = canvas(w, h)
  pctx.drawImage(answer, (shiftX * w) / panelW, (shiftY * h) / panelH, w, h)
  pctx.globalCompositeOperation = 'destination-in'
  pctx.drawImage(mask, 0, 0, w, h)
  ctx.drawImage(patch, shown.x, shown.y, shown.w, shown.h)
  return { source: { ...source, image: await canvasToBlob(el, 'png') }, shift: [shiftX, shiftY] }
}
