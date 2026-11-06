import { useEffect, useState, type ReactNode } from 'react'

/** A primary button that stays disabled (darker, with a loading animation over it) for `seconds`. */
export default function WaitButton({ seconds, onClick, children }: { seconds: number; onClick: () => void; children: ReactNode }) {
  const [waiting, setWaiting] = useState(true)
  useEffect(() => {
    const timer = window.setTimeout(() => setWaiting(false), seconds * 1000)
    return () => window.clearTimeout(timer)
  }, [seconds])
  return (
    <button type="button" className={`primary icon solid fa-download wait-btn${waiting ? ' is-waiting' : ''}`}
      disabled={waiting} aria-busy={waiting} onClick={onClick}
      style={{ '--wait': `${seconds}s` } as React.CSSProperties}>
      {children}
      {waiting && <span className="wait-fill" aria-hidden="true"><span className="spinner" /></span>}
    </button>
  )
}
