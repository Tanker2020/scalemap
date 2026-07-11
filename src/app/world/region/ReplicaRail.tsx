// src/app/world/region/ReplicaRail.tsx
// Region v4 (Polish 3 T3, mockup `.r3` `.replrail`) — the tucked-away replication gutter: one
// amber curve per cross-AZ primary/replica server pair (`regionData.ts`'s `replicaRailPairs`),
// always-on ◆→◇ direction glyphs at 0.38 opacity, brightening to full opacity + its "writes ⇣"
// label only while either endpoint server row is hovered. A presentational leaf in the
// `AlertRibbon.tsx`/`SplitLines.tsx` sense (module-boundaries.md §M) — plain data + the hover
// id as props, no store reads — and the schematic-not-DOM-measured positioning `SplitLines.tsx`
// already established (AZ-index-based Y, not a real per-row DOM measurement). Hover-brighten
// uses the `hoveredServerId` REACT state RegionView.tsx owns, per the T3 brief — never CSS
// `:has()`, which is webview-flaky.
import { useReducedMotion } from 'framer-motion'
import type { ReactElement } from 'react'
import type { BlueprintId, ServerId } from '../../../lib/world/types'
import './r3Styles'

export interface ReplicaRailEntry {
  blueprintId: BlueprintId
  primaryServerId: ServerId
  replicaServerId: ServerId
  primaryAzIndex: number
  replicaAzIndex: number
}

export interface ReplicaRailProps {
  entries: ReplicaRailEntry[]
  azCount: number
  rowsHeight: number
  hoveredServerId: ServerId | null
}

const RAIL_W = 40
const AMBER = '#E0A552'   // mockup `--amber` (verbatim) — see r3Styles.ts's header note

export function ReplicaRail({ entries, azCount, rowsHeight, hoveredServerId }: ReplicaRailProps): ReactElement | null {
  const reduced = useReducedMotion()
  if (entries.length === 0) return null

  const rowY = (azIndex: number) => ((azIndex + 0.5) * rowsHeight) / Math.max(1, azCount)

  return (
    <svg
      width={RAIL_W + 8} height={rowsHeight}
      style={{ position: 'absolute', right: -6, top: 0, pointerEvents: 'none', overflow: 'visible' }}
      aria-hidden="true"
    >
      {entries.map(entry => {
        const active = hoveredServerId === entry.primaryServerId || hoveredServerId === entry.replicaServerId
        const y1 = rowY(entry.primaryAzIndex)
        const y2 = rowY(entry.replicaAzIndex)
        const midY = (y1 + y2) / 2
        const d = `M4,${y1} C${RAIL_W},${y1} ${RAIL_W},${y2} 4,${y2}`
        return (
          <g key={`${entry.primaryServerId}:${entry.replicaServerId}`} style={{ opacity: active ? 1 : 0.38, transition: 'opacity 0.16s' }}>
            <path
              d={d} fill="none" stroke={AMBER} strokeWidth={1.5} strokeDasharray="2 8" strokeLinecap="round"
              style={!reduced ? { animation: 'dashflow 2s linear infinite' } : undefined}
            />
            <text x={2} y={y1 - 4} fontSize={8} fill={AMBER}>◆</text>
            <text x={2} y={y2 + 10} fontSize={8} fill={AMBER}>◇</text>
            <text
              x={RAIL_W + 4} y={midY} fontSize={8.5} fill={AMBER} textAnchor="middle"
              transform={`rotate(90 ${RAIL_W + 4} ${midY})`}
              style={{ opacity: active ? 1 : 0, transition: 'opacity 0.16s', font: '8.5px var(--font-mono)' }}
            >
              writes ⇣
            </text>
          </g>
        )
      })}
    </svg>
  )
}
