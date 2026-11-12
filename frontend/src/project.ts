// StoryGapBoard project file (.sgb) — complete session state for import/export.
// The API key is deliberately NOT included (ephemeral, memory only).
import type { Panel, Panels, PanelSource, Rect } from './board'
import type { FrameStyle } from './frame'
import type { Shape } from './marks'

export const SGB_VERSION = 1
export const SGB_MIME = 'application/json'
export const SGB_EXT = '.sgb'

// PanelSource serializável (sem Blob, com base64)
export interface SGBPanelSource {
  imageBase64: string
  mime: string
  rect: Rect
  x: number
  y: number
  empty?: boolean
  removed?: boolean
}

// Panel da aba Fill (antes da geração)
export interface SGBPanel {
  kind: 'file' | 'generated'
  // índice original no array de painéis (0-based) para preservar slots vazios
  index: number
  // se 'file': base64 + nome + tipo MIME
  fileBase64?: string
  fileName?: string
  fileType?: string
  // se 'generated': base64 do blob recortado
  imageBase64?: string
  imageMime?: string
  x: number
  y: number
  fixed: boolean
}

// Retouch mark shape (serializable)
export interface SGBShape {
  kind: 'brush' | 'circle' | 'rect'
  // brush
  size?: number
  points?: [number, number][]
  // circle/rect
  x0?: number
  y0?: number
  x1?: number
  y1?: number
}

// Histórico de retouch por painel
export interface SGBHistory {
  undo: SGBPanelSource[][]
  redo: SGBPanelSource[][]
  order: number[]
  redoOrder: number[]
}

// Arquivos de referência (aba Files)
export interface SGBReferenceFile {
  name: string
  type: string
  base64: string
  kind: 'image' | 'text'
}

// Frame style completo (copia de FrameStyle para ser explícito no schema)
export interface SGBFrameStyle {
  background: 'solid' | 'linear' | 'radial' | 'dots' | 'grid' | 'lines' | 'stripes' | 'checker' | 'texture'
  texture: 'paper' | 'canvas' | 'wood' | 'marble' | 'concrete' | 'denim' | 'watercolor'
  color1: string
  color2: string
  angle: number
  margin: number
  gap: number
  outerWidth: number
  outerColor: string
  outerKind: 'solid' | 'double' | 'dashed' | 'dotted'
  outerRadius: number
  outerBehind: string
  title: string
  titleFont: 'sans' | 'serif' | 'mono' | 'comic' | 'impact'
  titleSize: number
  titleColor: string
  titleAlign: 'left' | 'center' | 'right'
  titleAt: 'top' | 'bottom'
  titleOffset: number
  titleBold: boolean
  titleItalic: boolean
  titleUnderline: boolean
  borderWidth: number
  borderColor: string
  borderKind: 'solid' | 'double' | 'dashed' | 'dotted'
  radius: number
  shadow: number
  numbers: boolean
  numberAt: 'tl' | 'tr' | 'bl' | 'br'
  numberShape: 'circle' | 'square' | 'tag'
  numberColor: string
  numberText: string
  numberSize: number
  adjust: {
    rotation: number
    alignX: 'left' | 'center' | 'right'
    alignY: 'top' | 'middle' | 'bottom'
    emptyMode: 'kept' | 'reflow' | 'rows'
    sepia: number
    vhs: number
    scanlines: number
    grayscale: number
    grain: number
    vignette: number
    contrast: number
    saturation: number
    blur: number
    sharpen: number
  }
}

// Projeto completo
export interface SGBProject {
  version: number
  // Metadados da geração
  prompt: string
  style?: string
  provider: 'openrouter' | 'openai'
  model: string
  layout: string
  aspectRatio: string
  resolution: string
  outputFormat: string
  seed: string
  // Estado dos painéis (aba Fill)
  panels: SGBPanel[]
  // Estado do storyboard composto
  board?: {
    blobBase64: string
    blobMime: string
    filename: string
    cost: number
    seed: number | null
    width: number
    height: number
    sources: SGBPanelSource[]
    rects: Rect[]
    frame: SGBFrameStyle
  }
  // Histórico de retouches
  history: SGBHistory
  // Arquivos de referência (até 5)
  referenceFiles: SGBReferenceFile[]
  // Frame style atual
  frame: SGBFrameStyle
  // Timestamp
  savedAt: string
}

// ==================== UTILITÁRIOS ====================

/** Converte Blob para base64 (data URL sem prefixo). */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      // Remove "data:<mime>;base64," prefix
      const base64 = result.split(',')[1] ?? result
      resolve(base64)
    }
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

/** Converte base64 (sem prefixo) para Blob com MIME dado. */
export function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64)
  const len = binary.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

/** Converte File para base64. */
export async function fileToBase64(file: File): Promise<string> {
  return blobToBase64(file)
}

/** Converte base64 + nome + tipo para File. */
export function base64ToFile(base64: string, name: string, type: string): File {
  const blob = base64ToBlob(base64, type)
  return new File([blob], name, { type })
}

/** Serializa PanelSource → SGBPanelSource. */
export async function serializePanelSource(src: PanelSource): Promise<SGBPanelSource> {
  const base64 = await blobToBase64(src.image)
  return {
    imageBase64: base64,
    mime: src.image.type || 'image/png',
    rect: src.rect,
    x: src.x,
    y: src.y,
    empty: src.empty,
    removed: src.removed,
  }
}

/** Desserializa SGBPanelSource → PanelSource. */
export function deserializePanelSource(sgb: SGBPanelSource): PanelSource {
  const image = base64ToBlob(sgb.imageBase64, sgb.mime)
  return {
    image,
    rect: sgb.rect,
    x: sgb.x,
    y: sgb.y,
    empty: sgb.empty,
    removed: sgb.removed,
  }
}

/** Serializa Panel (Fill tab) → SGBPanel. Inclui índice para preservar posição. */
export async function serializePanel(panel: Panel, index: number): Promise<SGBPanel & { index: number }> {
  if (panel.src instanceof File) {
    const base64 = await fileToBase64(panel.src)
    return {
      kind: 'file',
      fileBase64: base64,
      fileName: panel.src.name,
      fileType: panel.src.type,
      x: panel.x,
      y: panel.y,
      fixed: panel.fixed,
      index,
    }
  } else {
    const base64 = await blobToBase64(panel.src)
    return {
      kind: 'generated',
      imageBase64: base64,
      imageMime: panel.src.type || 'image/png',
      x: panel.x,
      y: panel.y,
      fixed: panel.fixed,
      index,
    }
  }
}

/** Desserializa SGBPanel → Panel. */
export function deserializePanel(sgb: SGBPanel & { index: number }): { panel: Panel; index: number } {
  if (sgb.kind === 'file') {
    const file = base64ToFile(sgb.fileBase64!, sgb.fileName!, sgb.fileType!)
    return { panel: { src: file, x: sgb.x, y: sgb.y, fixed: sgb.fixed }, index: sgb.index }
  } else {
    const blob = base64ToBlob(sgb.imageBase64!, sgb.imageMime || 'image/png')
    return { panel: { src: blob, x: sgb.x, y: sgb.y, fixed: sgb.fixed }, index: sgb.index }
  }
}

/** Serializa Shape → SGBShape. */
export function serializeShape(shape: Shape): SGBShape {
  if (shape.kind === 'brush') {
    return { kind: 'brush', size: shape.size, points: shape.points }
  } else {
    return { kind: shape.kind, x0: shape.x0, y0: shape.y0, x1: shape.x1, y1: shape.y1 }
  }
}

/** Desserializa SGBShape → Shape. */
export function deserializeShape(sgb: SGBShape): Shape {
  if (sgb.kind === 'brush') {
    return { kind: 'brush', size: sgb.size!, points: sgb.points! }
  } else {
    return { kind: sgb.kind, x0: sgb.x0!, y0: sgb.y0!, x1: sgb.x1!, y1: sgb.y1! }
  }
}

/** Serializa History → SGBHistory. */
export async function serializeHistory(history: {
  undo: PanelSource[][]
  redo: PanelSource[][]
  order: number[]
  redoOrder: number[]
}): Promise<SGBHistory> {
  const undo = await Promise.all(history.undo.map(async (list) =>
    Promise.all(list.map(serializePanelSource))
  ))
  const redo = await Promise.all(history.redo.map(async (list) =>
    Promise.all(list.map(serializePanelSource))
  ))
  return { undo, redo, order: history.order, redoOrder: history.redoOrder }
}

/** Desserializa SGBHistory → History. */
export function deserializeHistory(sgb: SGBHistory): {
  undo: PanelSource[][]
  redo: PanelSource[][]
  order: number[]
  redoOrder: number[]
} {
  const undo = sgb.undo.map(list => list.map(deserializePanelSource))
  const redo = sgb.redo.map(list => list.map(deserializePanelSource))
  return { undo, redo, order: sgb.order, redoOrder: sgb.redoOrder }
}

/** Serializa FrameStyle → SGBFrameStyle. */
export function serializeFrameStyle(frame: FrameStyle): SGBFrameStyle {
  return { ...frame }
}

/** Desserializa SGBFrameStyle → FrameStyle. */
export function deserializeFrameStyle(sgb: SGBFrameStyle): FrameStyle {
  return { ...sgb }
}

/** Serializa arquivo de referência → SGBReferenceFile. */
export async function serializeReferenceFile(file: File): Promise<SGBReferenceFile> {
  const base64 = await fileToBase64(file)
  const kind = file.type.startsWith('image/') ? 'image' : 'text'
  return { name: file.name, type: file.type, base64, kind }
}

/** Desserializa SGBReferenceFile → File. */
export function deserializeReferenceFile(sgb: SGBReferenceFile): File {
  return base64ToFile(sgb.base64, sgb.name, sgb.type)
}

/** Estado completo necessário para serialização. */
export interface ProjectState {
  prompt: string
  style?: string
  provider: 'openrouter' | 'openai'
  model: string
  layout: string
  aspectRatio: string
  resolution: string
  outputFormat: string
  seed: string
  panels: Panels
  board?: {
    blob: Blob
    filename: string
    cost: number
    seed: number | null
    width: number
    height: number
    sources: PanelSource[]
    rects: Rect[]
    frame: FrameStyle
  }
  history: {
    undo: PanelSource[][]
    redo: PanelSource[][]
    order: number[]
    redoOrder: number[]
  }
  referenceFiles: File[]
  frame: FrameStyle
}

/** Serializa estado completo → SGBProject. */
export async function serializeProject(state: ProjectState): Promise<SGBProject> {
  // Filtrar painéis não-nulos primeiro, depois serializar
  const nonNullPanels = state.panels
    .map((p, i) => (p !== null ? { panel: p, index: i } : null))
    .filter((p): p is { panel: Panel; index: number } => p !== null)
  const panels = await Promise.all(nonNullPanels.map(({ panel, index }) => serializePanel(panel, index)))
  const referenceFiles = await Promise.all(state.referenceFiles.map(serializeReferenceFile))

  let board: SGBProject['board']
  if (state.board) {
    const sources = await Promise.all(state.board.sources.map(serializePanelSource))
    board = {
      blobBase64: await blobToBase64(state.board.blob),
      blobMime: state.board.blob.type || 'image/png',
      filename: state.board.filename,
      cost: state.board.cost,
      seed: state.board.seed,
      width: state.board.width,
      height: state.board.height,
      sources,
      rects: state.board.rects,
      frame: serializeFrameStyle(state.board.frame),
    }
  }

  return {
    version: SGB_VERSION,
    prompt: state.prompt,
    style: state.style ?? '',
    provider: state.provider,
    model: state.model,
    layout: state.layout,
    aspectRatio: state.aspectRatio,
    resolution: state.resolution,
    outputFormat: state.outputFormat,
    seed: state.seed,
    panels,
    board,
    history: await serializeHistory(state.history),
    referenceFiles,
    frame: serializeFrameStyle(state.frame),
    savedAt: new Date().toISOString(),
  }
}

/** Desserializa SGBProject → estado para restaurar. */
export function deserializeProject(sgb: SGBProject): {
  prompt: string
  style: string
  provider: 'openrouter' | 'openai'
  model: string
  layout: string
  aspectRatio: string
  resolution: string
  outputFormat: string
  seed: string
  panels: Panels
  board?: {
    blob: Blob
    filename: string
    cost: number
    seed: number | null
    width: number
    height: number
    sources: PanelSource[]
    rects: Rect[]
    frame: FrameStyle
  }
  history: {
    undo: PanelSource[][]
    redo: PanelSource[][]
    order: number[]
    redoOrder: number[]
  }
  referenceFiles: File[]
  frame: FrameStyle
} {
  // Reconstrói array de painéis com nulls nas posições corretas
  const [rows, cols] = sgb.layout.split('x').map(Number)
  const totalPanels = (rows || 1) * (cols || 1)
  const panelsArray: Panels = Array.from({ length: totalPanels }, () => null)
  for (const sgbPanel of sgb.panels) {
    const { panel, index } = deserializePanel(sgbPanel as SGBPanel & { index: number })
    if (index >= 0 && index < totalPanels) {
      panelsArray[index] = panel
    }
  }
  const panels = panelsArray
  const referenceFiles = sgb.referenceFiles.map(deserializeReferenceFile)
  const history = deserializeHistory(sgb.history)
  const frame = deserializeFrameStyle(sgb.frame)

  let board: ProjectState['board']
  if (sgb.board) {
    const sources = sgb.board.sources.map(deserializePanelSource)
    board = {
      blob: base64ToBlob(sgb.board.blobBase64, sgb.board.blobMime),
      filename: sgb.board.filename,
      cost: sgb.board.cost,
      seed: sgb.board.seed,
      width: sgb.board.width,
      height: sgb.board.height,
      sources,
      rects: sgb.board.rects,
      frame: deserializeFrameStyle(sgb.board.frame),
    }
  }

  return {
    prompt: sgb.prompt,
    style: sgb.style ?? '',
    provider: sgb.provider,
    model: sgb.model,
    layout: sgb.layout,
    aspectRatio: sgb.aspectRatio,
    resolution: sgb.resolution,
    outputFormat: sgb.outputFormat,
    seed: sgb.seed,
    panels,
    board,
    history,
    referenceFiles,
    frame,
  }
}

/** Baixa o projeto como arquivo .sgb. */
export function downloadSGB(sgb: SGBProject, filename?: string): void {
  const json = JSON.stringify(sgb, null, 2)
  const blob = new Blob([json], { type: SGB_MIME })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename || `storygapboard-${new Date().toISOString().slice(0, 19).replace(/[-:]/g, '')}.sgb`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** Lê arquivo .sgb do input e retorna SGBProject. */
export function readSGBFile(file: File): Promise<SGBProject> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const text = reader.result as string
        const parsed = JSON.parse(text) as SGBProject
        // Validação básica
        if (!parsed.version || parsed.version > SGB_VERSION) {
          reject(new Error(`Unsupported project version: ${parsed.version}. Current: ${SGB_VERSION}`))
          return
        }
        resolve(parsed)
      } catch (e) {
        reject(new Error('Invalid .sgb file: not a valid JSON project.'))
      }
    }
    reader.onerror = () => reject(new Error('Could not read the file.'))
    reader.readAsText(file)
  })
}

/** Verifica se um arquivo é .sgb. */
export function isSGBFile(file: File): boolean {
  return file.name.toLowerCase().endsWith(SGB_EXT)
}