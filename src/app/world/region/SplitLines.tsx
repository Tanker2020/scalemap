// src/app/world/region/SplitLines.tsx
// Animated SVG split column between the inbound reading and the AZ row stack (D1, mockup
// lines 189-196). One cubic path per AZ share, its width scaling with the share's fraction; a
// down AZ gets a thin dashed red stub pinned to 0%.
import { useReducedMotion } from 'framer-motion'
import type { ReactElement } from 'react'
import type { AzShare } from './regionData'

const TEAL = '#2DD4BF'
const DOWN_RED = '#EF4444'
const LABEL_COLOR = '#94A3B8'
const SVG_W = 90
const ORIGIN_X = 5
const TARGET_X = 85

export interface SplitLinesProps { shares: AzShare[]; height: number }

export function SplitLines({ shares, height }: SplitLinesProps): ReactElement {
  const reduced = useReducedMotion()
  const originY = height / 2
  const rowY = (i: number) => ((i + 0.5) * height) / Math.max(1, shares.length)
  const midX = (ORIGIN_X + TARGET_X) / 2

  return (
    <svg width={SVG_W} height={height} style={{ flexShrink: 0 }} aria-hidden="true">
      {shares.map((s, i) => {
        const y = rowY(i)
        const d = `M${ORIGIN_X},${originY} C${midX - 5},${originY} ${midX},${y} ${TARGET_X},${y}`
        const pct = Math.round(s.fraction * 100)
        const strokeWidth = s.down ? 1 : 1 + 2 * s.fraction
        const stroke = s.down ? DOWN_RED : TEAL
        const dash = s.down ? '2 7' : '6 5'
        return (
          <g key={s.azId}>
            <path d={d} fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeDasharray={dash} opacity={s.down ? 0.5 : 0.75 + 0.1 * s.fraction}>
              {!reduced && !s.down && (
                <animate attributeName="stroke-dashoffset" values="22;0" dur="1s" repeatCount="indefinite" />
              )}
            </path>
            <text x={midX} y={y - 6} fill={s.down ? DOWN_RED : LABEL_COLOR} fontSize={9}>
              {pct}%
            </text>
          </g>
        )
      })}
    </svg>
  )
}
