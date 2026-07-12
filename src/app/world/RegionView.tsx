// src/app/world/RegionView.tsx
// Level-2 region flow page (Region v4, Polish 3 T3, mockup `.r3`): a de-lined restyle of the
// Phase-4 shape — WHO'S-SENDING sources column -> ingress beams (top-2 animated, motion-budget
// capped) -> AZ cards (hover-revealed cfgbar, static per-server bars) -> cross-AZ column, with
// a tucked replica rail in the gutter, one alert ribbon above and a failover timeline below.
// Fully scrub-aware: every metric reads `scrubBatch ?? latestBatch` (D1) and renders a
// meaningful static state ("—", doc-derived counts) before the sim has ever produced a batch.
import { useEffect, useRef, useState } from 'react'
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { useSimulationStore } from '../store/simulation.store'
import { useCompiledWorld } from './useCompiledWorld'
import { WORLD_REGIONS } from '../../lib/regionConfig'
import { computeWorldCost } from '../../lib/costModelV2'
import type { RoutingPolicyKind, ServerId } from '../../lib/world/types'
import { azShares, ribbonAlert, replicaRailPairs } from './region/regionData'
import { AlertRibbon } from './region/AlertRibbon'
import { SplitLines } from './region/SplitLines'
import { AzRow, type AzRowDbEndpoint } from './region/AzRow'
import { CrossAzColumn } from './region/CrossAzColumn'
import { SourcesColumn } from './region/SourcesColumn'
import { ReplicaRail, type ReplicaRailEntry } from './region/ReplicaRail'
import { TimelineV2 } from './region/TimelineV2'

const POLICY_LABEL: Record<RoutingPolicyKind, string> = {
  latency: 'latency-based routing', geo: 'geo-based routing',
  weighted: 'weighted routing', priority: 'priority routing',
}
const CHIP = { borderRadius: 10, padding: '2px 8px', font: '9px var(--font-mono)' } as const
const ACCENT_CHIP_BORDER = '#4A9EFF44'
const SUCCESS_CHIP_BORDER = '#22C55E44'
// Schematic estimate for the az-card column's height, not a live DOM measurement — see the
// fragment's judgment-call note (D11 budgets the page at ~1Hz re-render; a ResizeObserver-driven
// height sync would add churn for a purely schematic diagram). Region v4's cards are taller
// (header + one row per server) than Phase 4's compact single-line AzRow, hence the bump.
const ROW_HEIGHT_ESTIMATE = 110

export function RegionView() {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const { regionId, goAz, goServer } = useNavStore()
  const batch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const running = useSimulationStore(s => s.running)
  const events = useSimulationStore(s => s.events)
  const isDown = useSimulationStore(s => s.healthOverrides[regionId ?? ''] ?? false)
  const setOutage = useSimulationStore(s => s.setOutage)
  const [hoveredServerId, setHoveredServerId] = useState<ServerId | null>(null)
  const timelineRef = useRef<HTMLDivElement>(null)

  // Reset the replica-rail hover whenever the focused region changes, so a stale hover from a
  // previous region's server id can never light up this region's rail.
  useEffect(() => { setHoveredServerId(null) }, [regionId])

  if (!regionId || !doc.regions[regionId]) return null

  const region = doc.regions[regionId]
  const azs = Object.values(doc.azs).filter(a => a.regionId === regionId)
  const servers = Object.values(doc.servers).filter(s => azs.some(a => a.id === s.azId))
  const instanceCount = Object.values(compiled.instances).filter(i => i.regionId === regionId).length
  const worldLabel = WORLD_REGIONS.find(r => r.id === region.catalogId)?.label ?? region.catalogId

  const shares = azShares(regionId, doc, batch)
  const alert = ribbonAlert(regionId, doc, events, batch?.simMs ?? 0)
  const costs = computeWorldCost(doc, batch?.world ?? null)
  const rowsHeight = Math.max(140, azs.length * ROW_HEIGHT_ESTIMATE)

  // Replica rail + per-az db-endpoint tagging, computed ONCE here and threaded down (the same
  // "compute once, thread down" reuse `monthlyUsd` already established for AzRow) rather than
  // each AzRow independently re-deriving a whole-region pairing.
  const azIndexById = new Map(azs.map((a, i) => [a.id, i]))
  const railPairs = replicaRailPairs(doc, compiled, regionId)
  const railEntries: ReplicaRailEntry[] = railPairs.map(p => ({
    blueprintId: p.blueprintId,
    primaryServerId: p.primaryServerId,
    replicaServerId: p.replicaServerId,
    primaryAzIndex: azIndexById.get(doc.servers[p.primaryServerId]?.azId ?? '') ?? 0,
    replicaAzIndex: azIndexById.get(doc.servers[p.replicaServerId]?.azId ?? '') ?? 0,
  }))
  const dbEndpointsByAz = new Map<string, AzRowDbEndpoint[]>()
  for (const p of railPairs) {
    const primaryAzId = doc.servers[p.primaryServerId]?.azId
    const replicaAzId = doc.servers[p.replicaServerId]?.azId
    if (primaryAzId) dbEndpointsByAz.set(primaryAzId, [...(dbEndpointsByAz.get(primaryAzId) ?? []), { serverId: p.primaryServerId, role: 'primary' }])
    if (replicaAzId) dbEndpointsByAz.set(replicaAzId, [...(dbEndpointsByAz.get(replicaAzId) ?? []), { serverId: p.replicaServerId, role: 'replica' }])
  }

  return (
    <div style={{ padding: 18, font: '12px var(--font-mono)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <div>
          <span style={{ font: '16px var(--font-mono)', color: 'var(--color-text-primary)' }}>{region.catalogId}</span>
          <span style={{ font: '10px var(--font-mono)', color: 'var(--color-text-muted)' }}>
            {' '}{worldLabel} · {azs.length} AZ{azs.length === 1 ? '' : 's'} · {servers.length} server{servers.length === 1 ? '' : 's'} · {instanceCount} service instance{instanceCount === 1 ? '' : 's'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ ...CHIP, border: `1px solid ${ACCENT_CHIP_BORDER}`, color: 'var(--color-accent)' }}>
            {POLICY_LABEL[doc.routing.policy]}
          </span>
          <span style={{ ...CHIP, border: `1px solid ${SUCCESS_CHIP_BORDER}`, color: 'var(--color-success)' }}>
            health: {Math.round(doc.routing.healthCheckIntervalMs / 1000)}s interval
          </span>
          {running && (
            <button
              style={{
                background: 'var(--color-node-base)',
                border: `1px solid ${isDown ? 'var(--color-danger)' : 'var(--color-node-border)'}`,
                borderRadius: 4, padding: '3px 8px', cursor: 'pointer',
                font: '11px var(--font-mono)', color: isDown ? 'var(--color-danger)' : 'var(--color-text-secondary)',
              }}
              onClick={() => setOutage('region', regionId, !isDown)}
            >
              {isDown ? '✓ Clear region outage' : 'Simulate region outage'}
            </button>
          )}
        </div>
      </div>

      <AlertRibbon
        alert={alert}
        onTimelineClick={() => {
          const el = timelineRef.current
          if (!el) return
          el.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
          el.classList.add('region-timeline-flash')
          setTimeout(() => el.classList.remove('region-timeline-flash'), 1200)
        }}
      />

      {azs.length === 0 ? (
        <div style={{ color: 'var(--color-text-muted)', font: '12px var(--font-mono)' }}>
          No AZs yet — add one in the World panel →
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'stretch', gap: 0, position: 'relative' }}>
          <SourcesColumn regionId={regionId} internetEgressMonthlyUsd={costs.egress.internetUsd} />

          <SplitLines shares={shares} height={rowsHeight} />

          <div style={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column', gap: 8, marginRight: 20 }}>
            {azs.map(az => (
              <AzRow
                key={az.id} azId={az.id} regionId={regionId}
                monthlyUsd={costs.byAz.find(e => e.azId === az.id)?.monthlyUsd ?? 0}
                dbEndpoints={dbEndpointsByAz.get(az.id) ?? []}
                onNavigateAz={() => goAz(regionId, az.id)}
                onNavigateServer={serverId => goServer(regionId, az.id, serverId)}
                onHoverServer={setHoveredServerId}
              />
            ))}
            <ReplicaRail entries={railEntries} azCount={azs.length} rowsHeight={rowsHeight} hoveredServerId={hoveredServerId} flowing={(batch?.regions[regionId]?.rps ?? 0) > 0} />
          </div>

          <CrossAzColumn regionId={regionId} />
        </div>
      )}

      <div ref={timelineRef}>
        <TimelineV2 regionId={regionId} />
      </div>
    </div>
  )
}
