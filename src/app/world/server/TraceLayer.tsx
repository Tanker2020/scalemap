// src/app/world/server/TraceLayer.tsx
// SVG etched traces beneath the DOM blocks (z0). One <path> per StaticTrace via
// layout.tracePath; permitted = protocol-colored with a soft glow, blocked = danger dashed with
// the rule label at the path midpoint. Paths are clickable (T6 refines to trace inspect).
import type { ReactElement } from 'react'
import type { BoardLayout, StaticTrace } from './boardLayout'
import type { BlueprintId } from '../../../lib/world/types'
import type { BoardSelection } from './selection'

const PROTOCOL_COLOR: Record<StaticTrace['protocol'], string> = {
  http: '#4A9EFF', db: '#F5A623', event: '#A78BFA', stream: '#2DD4BF',
}

export interface TraceLayerProps {
  layout: BoardLayout
  traces: StaticTrace[]
  selection: BoardSelection | null
  onSelect: (s: BoardSelection | null) => void
  hoveredBlueprintId: BlueprintId | null
}

export function TraceLayer({ layout, traces, onSelect }: TraceLayerProps): ReactElement {
  return (
    <svg width={layout.stageW} height={layout.stageH}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {traces.map((t, i) => {
        const d = layout.tracePath(t.fromId, t.toId)
        if (!d) return null
        const blocked = t.verdict === 'blocked'
        const color = blocked ? 'var(--color-danger)' : PROTOCOL_COLOR[t.protocol]
        const a = layout.anchorFor(t.fromId)
        const b = layout.anchorFor(t.toId)
        const mx = a && b ? (a.x + b.x) / 2 : 0
        const my = a && b ? (a.y + b.y) / 2 : 0
        return (
          <g key={i}>
            <path
              d={d} fill="none" stroke={color}
              strokeWidth={blocked ? 1.6 : 2.2}
              strokeDasharray={blocked ? '4 4' : undefined}
              opacity={blocked ? 0.85 : 0.85}
              style={{ filter: blocked ? undefined : `drop-shadow(0 0 4px ${color})`, cursor: 'pointer', pointerEvents: 'stroke' }}
              onClick={() => onSelect(null)}
            />
            {blocked && t.label && (
              <text x={mx + 6} y={my - 4} fill="#FF8A8A" fontSize={8} style={{ pointerEvents: 'none' }}>
                refused — {t.label}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}
