// Small outline of the chosen aspect ratio.
export default function RatioPreview({ ratio }: { ratio: string }) {
  const [w, h] = ratio.split(':').map(Number)
  if (!(w > 0 && h > 0)) {
    return <span className="ratio-preview ratio-auto" aria-hidden="true">auto</span>
  }
  const scale = Math.min(44 / w, 30 / h)
  const bw = w * scale
  const bh = h * scale
  return (
    <svg className="ratio-preview" width="48" height="34" aria-hidden="true">
      <rect x={(48 - bw) / 2} y={(34 - bh) / 2} width={bw} height={bh} rx="2" />
    </svg>
  )
}
