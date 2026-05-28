interface SparklineProps {
  data: number[]
  color: string
  height?: number
  maxPoints?: number
}

export function Sparkline({ data, color, height = 32, maxPoints = 60 }: SparklineProps) {
  const points = data.slice(-maxPoints)
  if (points.length < 2) {
    return <div style={{ height, background: '#111318', borderRadius: 3 }} />
  }

  const max = Math.max(...points, 0.001)
  const w = 100
  const h = height
  const step = w / (points.length - 1)

  const coords = points.map((v, i) => [i * step, h - (v / max) * (h - 2) - 1])

  const polyline = coords.map(([x, y]) => `${x},${y}`).join(' ')
  const area = `${coords[0][0]},${h} ${polyline} ${coords[coords.length - 1][0]},${h}`

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height, display: 'block' }}
    >
      <defs>
        <linearGradient id={`sg-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <polygon
        points={area}
        fill={`url(#sg-${color.replace('#', '')})`}
      />
      <polyline
        points={polyline}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}
