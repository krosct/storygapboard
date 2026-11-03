// Retouch marks (brush strokes, circles and rectangles), all in panel pixels: how
// they are drawn for the model, where they are, and the blend mask built from them.
// A brush counts only where it paints; a circle or a rectangle counts with its inside.

export type Shape =
  | { kind: 'brush'; size: number; points: [number, number][] }
  | { kind: 'circle' | 'rect'; x0: number; y0: number; x1: number; y1: number }

type Box = Extract<Shape, { kind: 'circle' | 'rect' }>

/** How far the retouch may reach around the marks (fraction of the panel's short side). */
export const BLENDS = {
  tight: { label: 'Only the marked area', pad: 0.02 },
  loose: { label: 'Marked area and around it', pad: 0.1 },
  panel: { label: 'The whole panel', pad: Infinity },
}
export type Blend = keyof typeof BLENDS

/** Mark colors the visitor can pick (the prompt names the color, so the model knows what to look for). */
export const MARK_COLORS = { red: '#ff2a2a', green: '#00d65a', blue: '#2a6bff', yellow: '#ffd400' }
export type MarkColor = keyof typeof MARK_COLORS

/**
 * The mark color that stands out most on this panel: the one with the fewest
 * pixels close to it (red marks on a red drawing would be hard to see).
 */
export function pickMarkColor(panel: HTMLCanvasElement): MarkColor {
  const size = 48
  const sample = document.createElement('canvas')
  sample.width = size
  sample.height = size
  const ctx = sample.getContext('2d')
  if (!ctx) return 'red'
  ctx.drawImage(panel, 0, 0, size, size)
  const data = ctx.getImageData(0, 0, size, size).data
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  let best: MarkColor = 'red'
  let bestCount = Infinity
  for (const name of Object.keys(MARK_COLORS) as MarkColor[]) {
    const [r, g, b] = rgb(MARK_COLORS[name])
    let count = 0
    for (let i = 0; i < data.length; i += 4) {
      if (Math.hypot(data[i] - r, data[i + 1] - g, data[i + 2] - b) < 140) count++
    }
    // red first on a tie: the default people expect
    if (count < bestCount) [best, bestCount] = [name, count]
  }
  return best
}
export const BRUSHES = { small: 0.03, medium: 0.06, large: 0.1 }

function traceBrush(ctx: CanvasRenderingContext2D, shape: Extract<Shape, { kind: 'brush' }>, width: number) {
  ctx.lineWidth = width
  ctx.beginPath()
  const [first, ...rest] = shape.points
  ctx.moveTo(first[0], first[1])
  // a single tap still paints a dot
  if (rest.length === 0) ctx.lineTo(first[0] + 0.01, first[1])
  for (const [x, y] of rest) ctx.lineTo(x, y)
  ctx.stroke()
}

/** The outline of a circle or rectangle mark, grown by pad. */
function traceBox(ctx: CanvasRenderingContext2D, shape: Box, pad = 0) {
  ctx.beginPath()
  if (shape.kind === 'rect') {
    const x = Math.min(shape.x0, shape.x1) - pad
    const y = Math.min(shape.y0, shape.y1) - pad
    ctx.rect(x, y, Math.max(Math.abs(shape.x1 - shape.x0) + 2 * pad, 1), Math.max(Math.abs(shape.y1 - shape.y0) + 2 * pad, 1))
    return
  }
  const rx = Math.abs(shape.x1 - shape.x0) / 2 + pad
  const ry = Math.abs(shape.y1 - shape.y0) / 2 + pad
  ctx.ellipse((shape.x0 + shape.x1) / 2, (shape.y0 + shape.y1) / 2, Math.max(rx, 1), Math.max(ry, 1), 0, 0, Math.PI * 2)
}

/** Marks as the model sees them: translucent paint, solid circle and rectangle outlines. */
export function drawMarks(ctx: CanvasRenderingContext2D, shapes: Shape[], width: number, height: number,
  color: MarkColor = 'red') {
  const paint = document.createElement('canvas')
  paint.width = width
  paint.height = height
  const pctx = paint.getContext('2d')
  if (!pctx) return
  pctx.strokeStyle = MARK_COLORS[color]
  pctx.lineCap = 'round'
  pctx.lineJoin = 'round'
  for (const shape of shapes) if (shape.kind === 'brush') traceBrush(pctx, shape, shape.size)
  ctx.save()
  ctx.globalAlpha = 0.5
  ctx.drawImage(paint, 0, 0)
  ctx.restore()
  ctx.save()
  ctx.strokeStyle = MARK_COLORS[color]
  ctx.lineWidth = Math.max(3, Math.round(Math.min(width, height) * 0.012))
  for (const shape of shapes) {
    if (shape.kind !== 'brush') {
      traceBox(ctx, shape)
      ctx.stroke()
    }
  }
  ctx.restore()
}

/** Marks' bounding box in % of the panel (tells the model where to look). */
export function markArea(shapes: Shape[], width: number, height: number): [number, number, number, number] {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const shape of shapes) {
    const boxes = shape.kind === 'brush'
      ? shape.points.map(([x, y]) => [x - shape.size / 2, y - shape.size / 2, x + shape.size / 2, y + shape.size / 2])
      : [[Math.min(shape.x0, shape.x1), Math.min(shape.y0, shape.y1), Math.max(shape.x0, shape.x1), Math.max(shape.y0, shape.y1)]]
    for (const [a, b, c, d] of boxes) {
      x0 = Math.min(x0, a); y0 = Math.min(y0, b); x1 = Math.max(x1, c); y1 = Math.max(y1, d)
    }
  }
  const pct = (v: number, total: number) => Math.round(Math.min(100, Math.max(0, (v / total) * 100)))
  return [pct(x0, width), pct(y0, height), pct(x1, width), pct(y1, height)]
}

/** Where the retouch may land: the marks grown by the blend reach, with soft edges (white = may change). */
export function buildMask(shapes: Shape[], width: number, height: number, blend: Blend): HTMLCanvasElement {
  if (blend === 'panel') {
    const full = document.createElement('canvas')
    full.width = width
    full.height = height
    const fctx = full.getContext('2d')
    if (fctx) {
      fctx.fillStyle = '#ffffff'
      fctx.fillRect(0, 0, width, height)
    }
    return full
  }
  const pad = Math.max(2, Math.round(Math.min(width, height) * BLENDS[blend].pad))
  const hard = document.createElement('canvas')
  hard.width = width
  hard.height = height
  const hctx = hard.getContext('2d')
  const soft = document.createElement('canvas')
  soft.width = width
  soft.height = height
  const sctx = soft.getContext('2d')
  if (!hctx || !sctx) return soft
  hctx.fillStyle = '#ffffff'
  hctx.strokeStyle = '#ffffff'
  hctx.lineCap = 'round'
  hctx.lineJoin = 'round'
  for (const shape of shapes) {
    if (shape.kind === 'brush') {
      traceBrush(hctx, shape, shape.size + pad * 2)
    } else {
      traceBox(hctx, shape, pad)
      hctx.fill()
    }
  }
  sctx.filter = `blur(${Math.max(1, Math.round(Math.min(pad / 2, Math.min(width, height) * 0.02)))}px)`
  sctx.drawImage(hard, 0, 0)
  return soft
}
