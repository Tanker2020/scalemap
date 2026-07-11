// src/app/world/region/SourcesColumn.tsx
// Region v4 (Polish 3 T3, mockup `.r3` `.src`/"WHO'S SENDING" column) — one row per population
// currently routed into this region (rps > 0 in `batch.world.populationRoutes`), a synthetic
// `baseline:<regionId>` row when auto-baseline supplies demand, and the merged trunk total. A
// "self-sufficient scoped view" in the same sense `AzRow.tsx`/`CrossAzColumn.tsx` are
// (module-boundaries.md §M) — reads its own store data off just a `regionId` — except for the
// sparkline series and world-egress total, which RegionView.tsx already computes once (the same
// "compute once, thread down" reuse `AzRow.tsx`'s `monthlyUsd` prop established) and passes in
// rather than re-deriving here.
import { useReducedMotion } from 'framer-motion'
import type { CSSProperties, ReactElement } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { HOURS_PER_MONTH } from '../../../lib/costModelV2'
import { REGION_GEO, greatCircleKm } from '../../../lib/world/regionGeo'
import { dotStreamParams } from './regionData'
import type { RegionId } from '../../../lib/world/types'
import './r3Styles'

// Pure reimplementation of the engine's client→region latency convention
// (worldEngine/networkRuntime.ts INTERNET_KM_PER_MS = 100) — never imported from worldEngine
// (Global Constraints), same documented-mirror shape as regionData.ts's CROSS_AZ_HOP_MS.
const POP_LATENCY_KM_PER_MS = 100
const HAIRLINE = '#1c2430'
const TOP_ANIMATED = 5

interface SourceRow {
  key: string
  label: string
  rps: number
  isBaseline: boolean
  latencyMs: number | null
  egressUsdPerHr: number | null
}

export interface SourcesColumnProps {
  regionId: RegionId
  internetEgressMonthlyUsd: number
}

export function SourcesColumn({ regionId, internetEgressMonthlyUsd }: SourcesColumnProps): ReactElement {
  const doc = useWorldStore(s => s.doc)
  const batch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const reduced = useReducedMotion()

  const region = doc.regions[regionId]
  const geo = region ? REGION_GEO[region.catalogId] : undefined
  const worldTotalRps = batch?.world.totalRps ?? 0

  const rows: SourceRow[] = (batch?.world.populationRoutes ?? [])
    .filter(r => r.regionId === regionId && r.rps > 0)
    .map(r => {
      if (r.populationId.startsWith('baseline:')) {
        return { key: r.populationId, label: 'baseline', rps: r.rps, isBaseline: true, latencyMs: null, egressUsdPerHr: null }
      }
      const pop = doc.populations[r.populationId]
      const latencyMs = pop && geo ? Math.round(greatCircleKm(pop.lat, pop.lon, geo.lat, geo.lon) / POP_LATENCY_KM_PER_MS) : null
      // Schematic proportional attribution of the world's simulated internet-egress bill by
      // this population's live share of world rps — a documented judgment call (no per-population
      // byte-rate metric exists to attribute exactly), same "schematic estimate" spirit as
      // RegionView.tsx's ROW_HEIGHT_ESTIMATE.
      const egressUsdPerHr = worldTotalRps > 0 ? (internetEgressMonthlyUsd / HOURS_PER_MONTH) * (r.rps / worldTotalRps) : 0
      return { key: r.populationId, label: pop?.label ?? r.populationId, rps: r.rps, isBaseline: false, latencyMs, egressUsdPerHr }
    })
    .sort((a, b) => b.rps - a.rps)

  const maxRps = rows[0]?.rps ?? 0
  const trunkTotal = batch?.regions[regionId]?.rps ?? 0

  const h4: CSSProperties = { fontSize: 9.5, letterSpacing: '0.13em', color: 'var(--r3-hud)', textShadow: '0 0 8px var(--r3-hud-dim)', marginBottom: 8 }

  return (
    <div style={{
      width: 208, flexShrink: 0, alignSelf: 'start',
      border: '1px solid #24303f', borderRadius: 10,
      background: 'linear-gradient(180deg, #101720, #0d1014)', padding: '11px 12px',
      font: '10px var(--font-mono)',
    }}>
      <div style={h4}>▸ WHO&apos;S SENDING</div>
      {rows.length === 0 && <div style={{ color: 'var(--color-text-muted)', fontSize: 9.5 }}>no traffic yet</div>}
      {rows.map((row, i) => (
        <SrcRow key={row.key} row={row} maxRps={maxRps} animated={i < TOP_ANIMATED} reduced={!!reduced} />
      ))}
      <div style={{ marginTop: 10, borderTop: '1px dashed #1c2430', paddingTop: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ position: 'relative', flex: 1, height: 10, borderRadius: 5, background: '#131a24', overflow: 'hidden' }}>
            <div
              style={{
                position: 'absolute', inset: 0,
                background: 'repeating-linear-gradient(90deg, var(--r3-hud) 0 9px, transparent 9px 16px)',
                opacity: 0.9,
                ...(reduced ? {} : { animation: 'marchr 0.5s linear infinite' }),
              }}
            />
          </div>
          <span style={{ fontSize: 14, color: 'var(--r3-hud)', fontVariantNumeric: 'tabular-nums' }}>
            {Math.round(trunkTotal).toLocaleString('en-US')}
          </span>
        </div>
        <div style={{ fontSize: 8.5, color: 'var(--color-text-muted)', marginTop: 3 }}>
          merged at the edge · dash speed = rate, here and everywhere
        </div>
      </div>
    </div>
  )
}

function SrcRow({ row, maxRps, animated, reduced }: { row: SourceRow; maxRps: number; animated: boolean; reduced: boolean }): ReactElement {
  const { dots, periodSec } = dotStreamParams(row.rps, maxRps)
  return (
    <div style={{ marginBottom: 9 }} data-testid={`src-row-${row.key}`} data-dot-count={animated ? dots : 0}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--color-text-secondary)' }}>
        <span>{row.label}</span>
        <span style={{ color: 'var(--r3-teal)', fontVariantNumeric: 'tabular-nums' }}>{Math.round(row.rps)} rps</span>
      </div>
      <div style={{ height: 8, marginTop: 3, position: 'relative' }}>
        <div style={{ position: 'absolute', left: 0, right: 0, top: 3.5, height: 1, background: HAIRLINE }} />
        {animated && Array.from({ length: dots }).map((_, i) => (
          reduced ? (
            <div
              key={i} data-testid="src-dot"
              style={{
                position: 'absolute', top: 2, width: 4, height: 4, borderRadius: '50%',
                left: `${((i + 1) / (dots + 1)) * 100}%`,
                background: 'var(--r3-teal)', filter: 'drop-shadow(0 0 3px var(--r3-teal))',
              }}
            />
          ) : (
            <div
              key={i} data-testid="src-dot"
              style={{
                position: 'absolute', top: 2, width: 4, height: 4, borderRadius: '50%',
                background: 'var(--r3-teal)', filter: 'drop-shadow(0 0 3px var(--r3-teal))',
                animation: `dotrun ${periodSec}s linear infinite`,
                animationDelay: `${(i * periodSec) / dots}s`,
              }}
            />
          )
        ))}
      </div>
      <div style={{ fontSize: 8.5, color: 'var(--color-text-muted)', marginTop: 1 }}>
        {row.isBaseline
          ? 'synthetic · auto'
          : row.latencyMs != null
            ? <>{row.latencyMs} ms away · <span style={{ color: 'var(--color-price)' }}>+${(row.egressUsdPerHr ?? 0).toFixed(2)}/hr egress</span></>
            : 'routed here'}
      </div>
    </div>
  )
}
