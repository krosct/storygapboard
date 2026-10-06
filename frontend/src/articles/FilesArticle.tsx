import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { ACCEPTED_FILES, fileKind, formatBytes, type Meta } from '../api'
import { Message, type Notify } from '../components/Toasts'

interface Props {
  meta: Meta | null
  files: File[]
  setFiles: (files: File[]) => void
  notify: Notify
}

export default function FilesArticle({ meta, files, setFiles, notify }: Props) {
  const maxFiles = meta?.limits.max_files ?? 5
  const maxBytes = meta?.limits.max_file_bytes ?? 5 * 1024 * 1024
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [problems, setProblems] = useState<string[]>([])

  // Thumbnails for image files (object URLs released when the list changes).
  const previews = useMemo(
    () => files.map((f) => (fileKind(f) === 'image' ? URL.createObjectURL(f) : '')), [files])
  useEffect(() => () => previews.forEach((url) => url && URL.revokeObjectURL(url)), [previews])

  function add(incoming: File[]) {
    const next = [...files]
    const issues: string[] = []
    for (const file of incoming) {
      if (!fileKind(file)) {
        issues.push(`${file.name}: only PNG, JPEG, WebP, GIF, .txt and .md files are accepted.`)
      } else if (file.size > maxBytes) {
        issues.push(`${file.name} is larger than ${formatBytes(maxBytes)}.`)
      } else if (file.size === 0) {
        issues.push(`${file.name} is empty.`)
      } else if (next.some((f) => f.name === file.name && f.size === file.size)) {
        issues.push(`${file.name} is already in the list.`)
      } else if (next.length >= maxFiles) {
        issues.push(`${file.name} was skipped: at most ${maxFiles} files.`)
      } else {
        next.push(file)
      }
    }
    setProblems(issues)
    if (next.length !== files.length) {
      setFiles(next)
      notify('success', `${next.length} of ${maxFiles} files attached.`)
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    setDragging(false)
    add(Array.from(e.dataTransfer.files))
  }

  return (
    <>
      <p>Add up to <strong>{maxFiles} files</strong> (max {formatBytes(maxBytes)} each) to steer the result.
        <strong> Text</strong> files (.txt, .md) are added to the prompt as context; <strong>images</strong> (PNG,
        JPEG, WebP, GIF) are sent as visual references to keep a style or a character.</p>
      <p className="hint model-note">Some models accept only text: they ignore reference images. To use images too,
        pick a model that accepts both text and image input in <a href="#model">Model</a>.</p>

      <div
        className={`dropzone${dragging ? ' is-dragging' : ''}${files.length >= maxFiles ? ' is-full' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <span className="icon solid fa-cloud-upload-alt" aria-hidden="true" />
        <p>{files.length >= maxFiles ? 'The list is full.' : 'Drop files here or'}</p>
        <button type="button" className="small" disabled={files.length >= maxFiles}
          onClick={() => input.current?.click()}>Choose files</button>
        <input ref={input} type="file" multiple accept={ACCEPTED_FILES} hidden
          onChange={(e) => { add(Array.from(e.target.files ?? [])); e.target.value = '' }} />
      </div>

      {problems.length > 0 && (
        <Message kind="error">
          <ul className="plain">{problems.map((text) => <li key={text}>{text}</li>)}</ul>
        </Message>
      )}

      {files.length > 0 && (
        <div className="table-wrapper">
          <table className="file-table">
            <thead><tr><th></th><th>File</th><th>Used as</th><th>Size</th><th></th></tr></thead>
            <tbody>
              {files.map((file, i) => (
                <tr key={`${file.name}-${file.size}-${i}`}>
                  <td className="thumb">
                    {previews[i]
                      ? <img src={previews[i]} alt="" />
                      : <span className="icon fa-file-alt" aria-hidden="true" />}
                  </td>
                  <td className="name" title={file.name}>{file.name}</td>
                  <td>{fileKind(file) === 'image' ? 'Reference' : 'Context'}</td>
                  <td>{formatBytes(file.size)}</td>
                  <td>
                    <button type="button" className="small" aria-label={`Remove ${file.name}`}
                      onClick={() => { setFiles(files.filter((_, j) => j !== i)); setProblems([]) }}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ul className="actions">
        <li><a className="button primary" href="#generate">Done</a></li>
        {files.length > 0 && (
          <li><button type="button" onClick={() => { setFiles([]); setProblems([]) }}>Remove all</button></li>
        )}
      </ul>
      <p className="hint">Files stay in this tab and are sent only with a generation. The server reads them in memory
        and never saves them.</p>
    </>
  )
}
