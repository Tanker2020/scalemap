import type { DownsampledPoint } from './signalsSeries'

export interface SignalChartProps {
  points: DownsampledPoint[]
  color: string
  width: number
  height: number
  playheadSimMs?: number | null
  onScrub?: (simMs: number) => void
  markers?: { simMs: number; label: string }[]
}

export function SignalChart({ points, color, width, height, playheadSimMs, onScrub, markers }: SignalChartProps) {
  if (points.length === 0) {
    return <svg width={width} height={height} role="img" aria-label="no data" />
  }
  const minMs = points[0].simMs
  const maxMs = points[points.length - 1].simMs
  const spanMs = Math.max(1, maxMs - minMs)
  const allValues = points.flatMap(p => [p.min, p.max])
  const lo = Math.min(...allValues)
  const hi = Math.max(...allValues)
  const spanV = Math.max(1e-9, hi - lo)
  const x = (simMs: number) => ((simMs - minMs) / spanMs) * width
  const y = (v: number) => height - ((v - lo) / spanV) * height

  const linePts = points.map(p => `${x(p.simMs)},${y(p.value)}`).join(' ')
  const bandTop = points.map(p => `${x(p.simMs)},${y(p.max)}`)
  const bandBottom = points.slice().reverse().map(p => `${x(p.simMs)},${y(p.min)}`)
  const bandPath = `M ${[...bandTop, ...bandBottom].join(' L ')} Z`

  const nearestSimMs = (clientX: number, rect: DOMRect) => {
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    const targetMs = minMs + ratio * spanMs
    let nearest = points[0].simMs
    let bestDelta = Infinity
    for (const p of points) {
      const d = Math.abs(p.simMs - targetMs)
      if (d < bestDelta) { bestDelta = d; nearest = p.simMs }
    }
    return nearest
  }

  return (
    <svg
      width={width} height={height}
      role="img" aria-label="signal chart"
      onClick={onScrub ? (e) => onScrub(nearestSimMs(e.clientX, e.currentTarget.getBoundingClientRect())) : undefined}
      style={{ cursor: onScrub ? 'pointer' : 'default', display: 'block' }}
    >
      <path d={bandPath} fill={color} fillOpacity={0.15} stroke="none" />
      <polyline points={linePts} fill="none" stroke={color} strokeWidth={1.5} />
      {markers?.map((m, i) => (
        <line key={i} x1={x(m.simMs)} x2={x(m.simMs)} y1={0} y2={height} stroke="var(--color-text-muted)" strokeWidth={1} strokeDasharray="2,2" />
      ))}
      {playheadSimMs != null && (
        <line x1={x(playheadSimMs)} x2={x(playheadSimMs)} y1={0} y2={height} stroke="var(--color-text-primary)" strokeWidth={1} />
      )}
    </svg>
  )
}
