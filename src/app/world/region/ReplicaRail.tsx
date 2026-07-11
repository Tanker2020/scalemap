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
// Motion budget (review fix wave, mirrors `SplitLines.tsx`'s `MAX_ANIMATED_BEAMS` cap): the
// mockup shows a SINGLE animated rail, and the region page's total concurrent-infinite-stroke
// budget (1 cross-AZ beam + 1 trunk + up to 5 dot-streams already, per the T8 sweep's tightening
// of `SplitLines.tsx`'s own cap) has no room for more than one `dashflow` per page, let alone one
// per replica pair. Only the first `MAX_ANIMATED_RAILS` entries (in `entries` order — there's no
// per-pair "loudness" metric to rank by, unlike `SplitLines.tsx`'s fraction sort) get the
// `dashflow` animation; every rail beyond the cap renders the identical static stroke. Region's
// documented worst-case total is now 1 (beam) + 1 (trunk) + 5 (dot-streams) + 1 (rail) = 8 — see
// module-boundaries.md §R.
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
const MAX_ANIMATED_RAILS = 1

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
      {entries.map((entry, i) => {
        const active = hoveredServerId === entry.primaryServerId || hoveredServerId === entry.replicaServerId
        const animated = !reduced && i < MAX_ANIMATED_RAILS
        const y1 = rowY(entry.primaryAzIndex)
        const y2 = rowY(entry.replicaAzIndex)
        const midY = (y1 + y2) / 2
        const d = `M4,${y1} C${RAIL_W},${y1} ${RAIL_W},${y2} 4,${y2}`
        return (
          <g key={`${entry.primaryServerId}:${entry.replicaServerId}`} style={{ opacity: active ? 1 : 0.38, transition: 'opacity 0.16s' }}>
            <path
              d={d} fill="none" stroke="var(--r3-amber)" strokeWidth={1.5} strokeDasharray="2 8" strokeLinecap="round"
              data-animated={animated || undefined}
              style={animated ? { animation: 'dashflow 2s linear infinite' } : undefined}
            />
            <text x={2} y={y1 - 4} fontSize={8} fill="var(--r3-amber)">◆</text>
            <text x={2} y={y2 + 10} fontSize={8} fill="var(--r3-amber)">◇</text>
            <text
              x={RAIL_W + 4} y={midY} fontSize={8.5} fill="var(--r3-amber-text)" textAnchor="middle"
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
