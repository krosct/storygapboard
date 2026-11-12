import { api } from './api'

export interface TimelineEntry {
  id: string
  timestamp: string // ISO
  timeDisplay: string // e.g. "10:30:15"
  title: string
  description: string
  imageBlob?: Blob
  imageDataUrl?: string
  imageAspect?: number // width / height
}

const SESSION_KEY = 'sgb_session_id'
function getSessionId(): string {
  let id = sessionStorage.getItem(SESSION_KEY)
  if (!id) {
    id = 'sess_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36)
    sessionStorage.setItem(SESSION_KEY, id)
  }
  return id
}

// Global in-memory timeline for the current session
const timelineEntries: TimelineEntry[] = []

/**
 * Compress an image Blob or HTMLCanvasElement to a lightweight JPEG DataURL for inclusion in the timeline & PDF.
 * Max dimension 400px, 60% quality.
 */
export async function createCompressedSnapshot(
  source: Blob | HTMLCanvasElement
): Promise<{ dataUrl: string; aspect: number } | undefined> {
  try {
    let imgBitmap: ImageBitmap | HTMLCanvasElement
    if (source instanceof HTMLCanvasElement) {
      imgBitmap = source
    } else {
      imgBitmap = await createImageBitmap(source)
    }

    const srcW = imgBitmap.width
    const srcH = imgBitmap.height
    if (srcW === 0 || srcH === 0) return undefined

    const aspect = srcW / srcH
    const maxDim = 400
    let targetW = srcW
    let targetH = srcH

    if (targetW > maxDim || targetH > maxDim) {
      if (aspect >= 1) {
        targetW = maxDim
        targetH = Math.round(maxDim / aspect)
      } else {
        targetH = maxDim
        targetW = Math.round(maxDim * aspect)
      }
    }

    const canvas = document.createElement('canvas')
    canvas.width = targetW
    canvas.height = targetH
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined

    // White background for transparent PNGs
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, targetW, targetH)
    ctx.drawImage(imgBitmap, 0, 0, targetW, targetH)

    const dataUrl = canvas.toDataURL('image/jpeg', 0.6)
    return { dataUrl, aspect }
  } catch (e) {
    console.warn('Failed to compress snapshot for timeline:', e)
    return undefined
  }
}

/**
 * Record a timeline event: logs to the server and appends to the session timeline.
 */
export async function recordAction(
  title: string,
  description: string,
  imageSource?: Blob | HTMLCanvasElement,
  durationMs?: number
): Promise<void> {
  const now = new Date()
  const timeDisplay = now.toLocaleTimeString([], { hour12: false })
  const sessionId = getSessionId()

  let snapshot: { dataUrl: string; aspect: number } | undefined
  if (imageSource) {
    snapshot = await createCompressedSnapshot(imageSource)
  }

  const entry: TimelineEntry = {
    id: Math.random().toString(36).substring(2, 9),
    timestamp: now.toISOString(),
    timeDisplay,
    title,
    description,
    imageDataUrl: snapshot?.dataUrl,
    imageAspect: snapshot?.aspect,
  }

  timelineEntries.push(entry)

  // Report to server log asynchronously
  void api.logAction(title, description, durationMs, sessionId)
}

export function getTimeline(): TimelineEntry[] {
  return [...timelineEntries]
}

/**
 * Generate a PDF document containing the story of the user's creation process.
 * Loaded dynamically (lazy import) so jsPDF is not included in the initial bundle.
 */
export async function generateTimelinePdf(): Promise<Blob> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  })

  const pageWidth = 210
  const pageHeight = 297
  const marginX = 20
  const marginY = 20
  const contentWidth = pageWidth - marginX * 2
  let y = marginY

  // Title Banner
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(22)
  doc.setTextColor(30, 41, 59)
  doc.text('StoryGapBoard — Creation Story', marginX, y)
  y += 8

  // Subtitle
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(100, 116, 139)
  const dateStr = new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' })
  doc.text(`Timeline of your creative process • Generated on ${dateStr}`, marginX, y)
  y += 12

  // Separator line
  doc.setDrawColor(226, 232, 240)
  doc.setLineWidth(0.5)
  doc.line(marginX, y, pageWidth - marginX, y)
  y += 10

  const entries = getTimeline()

  if (entries.length === 0) {
    doc.setFont('helvetica', 'italic')
    doc.setFontSize(11)
    doc.setTextColor(100, 116, 139)
    doc.text('No user actions recorded yet in this session.', marginX, y)
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]

    // Estimate needed vertical height
    const imgHeight = entry.imageDataUrl && entry.imageAspect ? Math.min(50, 60 / entry.imageAspect) : 0
    const neededHeight = 20 + imgHeight + (entry.description ? 10 : 0)

    // Check page break
    if (y + neededHeight > pageHeight - marginY) {
      doc.addPage()
      y = marginY
    }

    // Timeline node (bullet + line)
    doc.setFillColor(79, 70, 229) // Indigo bullet
    doc.circle(marginX + 2, y + 2, 2.5, 'F')

    // Timeline vertical connecting line to next item
    if (i < entries.length - 1) {
      doc.setDrawColor(203, 213, 225)
      doc.setLineWidth(0.5)
      doc.line(marginX + 2, y + 5, marginX + 2, y + neededHeight + 2)
    }

    // Header: Time + Title
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(11)
    doc.setTextColor(30, 41, 59)
    doc.text(`[${entry.timeDisplay}]  ${entry.title}`, marginX + 10, y + 3)
    y += 7

    // Description text (wrap text)
    if (entry.description) {
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9)
      doc.setTextColor(71, 85, 105)
      const lines = doc.splitTextToSize(entry.description, contentWidth - 12)
      doc.text(lines, marginX + 10, y + 1)
      y += lines.length * 4.5 + 2
    }

    // Image preview if available
    if (entry.imageDataUrl && entry.imageAspect) {
      try {
        const imgH = Math.min(50, 65 / entry.imageAspect)
        const imgW = imgH * entry.imageAspect
        doc.addImage(entry.imageDataUrl, 'JPEG', marginX + 10, y + 1, imgW, imgH)
        y += imgH + 5
      } catch (e) {
        console.warn('Failed to embed image into timeline PDF:', e)
      }
    }

    y += 6
  }

  // Footer on all pages
  const pageCount = doc.getNumberOfPages()
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(148, 163, 184)
    doc.text(`StoryGapBoard • Page ${p} of ${pageCount}`, pageWidth / 2, pageHeight - 10, { align: 'center' })
  }

  return doc.output('blob')
}
