export interface Meta {
  default_model: string
  aspect_ratios: string[]
  layouts: string[]
  default_layout: string
  resolutions: string[]
  output_formats: string[]
  limits: {
    max_files: number
    max_file_bytes: number
    max_prompt_chars: number
    generate_per_minute: number
    generate_per_day: number
  }
}

export interface JobResult {
  filename: string
  width: number
  height: number
  bytes: number
  cost: number
  seed: number | null
  elapsed: number
  notes: string[]
}

export type JobEvent =
  | { status: 'running'; elapsed: number }
  | { status: 'done'; result: JobResult }
  | { status: 'cancelled' }
  | { status: 'error'; error: string }

export interface GenerateInput {
  prompt: string
  model: string
  aspectRatio: string
  layout: string
  resolution: string
  outputFormat: string
  seed: string
  files: File[]
  apiKey: string
}

export class ApiError extends Error {
  status: number
  retryAfter: number | null

  constructor(message: string, status: number, retryAfter: number | null = null) {
    super(message)
    this.status = status
    this.retryAfter = retryAfter
  }
}

async function request(url: string, init?: RequestInit): Promise<Response> {
  let res: Response
  try {
    res = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init })
  } catch {
    throw new ApiError('Cannot reach the server. Check your connection and try again.', 0)
  }
  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { detail?: unknown }
      if (typeof body.detail === 'string') detail = body.detail
    } catch {
      /* not JSON */
    }
    const retry = Number(res.headers.get('Retry-After'))
    throw new ApiError(detail || `Request failed (HTTP ${res.status}).`, res.status,
      Number.isFinite(retry) && retry > 0 ? retry : null)
  }
  return res
}

export const api = {
  async meta(): Promise<Meta> {
    return (await request('/api/meta')).json() as Promise<Meta>
  },

  async generate(input: GenerateInput): Promise<string> {
    const form = new FormData()
    form.append('prompt', input.prompt)
    form.append('model', input.model)
    form.append('aspect_ratio', input.aspectRatio)
    form.append('layout', input.layout)
    form.append('resolution', input.resolution)
    form.append('output_format', input.outputFormat)
    form.append('seed', input.seed)
    for (const file of input.files) form.append('files', file, file.name)
    // The key travels in a header (never in the URL) and is not stored anywhere.
    const res = await request('/api/generate', {
      method: 'POST',
      body: form,
      headers: { 'X-Api-Key': input.apiKey },
    })
    const body = (await res.json()) as { job_id: string }
    return body.job_id
  },

  async cancel(jobId: string): Promise<void> {
    await request(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' })
  },

  async image(jobId: string): Promise<Blob> {
    return (await request(`/api/jobs/${encodeURIComponent(jobId)}/image`)).blob()
  },

  listen(jobId: string, onEvent: (ev: JobEvent) => void): () => void {
    const src = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events`)
    let closed = false
    src.onmessage = (msg) => {
      const ev = JSON.parse(msg.data as string) as JobEvent
      onEvent(ev)
      if (ev.status !== 'running') {
        closed = true
        src.close()
      }
    }
    src.onerror = () => {
      if (closed) return
      closed = true
      src.close()
      onEvent({ status: 'error', error: 'Lost the connection to the server.' })
    }
    return () => {
      closed = true
      src.close()
    }
  },
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif']
const TEXT_EXTS = ['.txt', '.md']
export const ACCEPTED_FILES = [...IMAGE_EXTS, ...TEXT_EXTS].join(',')

export function fileKind(file: File): 'image' | 'text' | null {
  const name = file.name.toLowerCase()
  if (IMAGE_EXTS.some((ext) => name.endsWith(ext))) return 'image'
  if (TEXT_EXTS.some((ext) => name.endsWith(ext))) return 'text'
  return null
}
