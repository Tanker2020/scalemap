// src/app/world/RegionView.tsx
// Level-2 region flow page (Region v4, Polish 3 T3, mockup `.r3`): a de-lined restyle of the
// Phase-4 shape — WHO'S-SENDING sources column -> ingress beams (top-2 animated, motion-budget
// capped) -> AZ cards (hover-revealed cfgbar, static per-server bars) -> cross-AZ column, with
// a tucked replica rail in the gutter, one alert ribbon above and a failover timeline below.
// Fully scrub-aware: every metric reads `scrubBatch ?? latestBatch` (D1) and renders a
// meaningful static state ("—", doc-derived counts) before the sim has ever produced a batch.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { useSimulationStore, selectLive } from '../store/simulation.store'
import { useCompiledWorld } from './useCompiledWorld'
import { WORLD_REGIONS } from '../../lib/regionConfig'
import { computeWorldCost, defaultProviderFromDoc } from '../../lib/costModelV2'
import { applyEnvironment } from '../../lib/world/environments'
import type { RoutingPolicyKind, ServerId } from '../../lib/world/types'
import { azShares, ribbonAlert, replicaRailPairs, regionManagedServices } from './region/regionData'
import { AlertRibbon } from './region/AlertRibbon'
import { SplitLines } from './region/SplitLines'
import { AzRow, type AzRowDbEndpoint } from './region/AzRow'
import { CrossAzColumn } from './region/CrossAzColumn'
import { SourcesColumn } from './region/SourcesColumn'
import { RegionLbCard } from './region/RegionLbCard'
import { ReplicaRail, type ReplicaRailEntry } from './region/ReplicaRail'
import { TimelineV2 } from './region/TimelineV2'
import { ChaosControl, isNonFatalFault, NON_FATAL_FAULT_ACCENT } from './dock/ChaosControl'

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
  const live = useSimulationStore(selectLive)
  const events = useSimulationStore(s => s.events)
  const healthOverrides = useSimulationStore(s => s.healthOverrides)
  const activeFaults = useSimulationStore(s => s.activeFaults)
  const [hoveredServerId, setHoveredServerId] = useState<ServerId | null>(null)
  const timelineRef = useRef<HTMLDivElement>(null)

  // Reset the replica-rail hover whenever the focused region changes, so a stale hover from a
  // previous region's server id can never light up this region's rail.
  useEffect(() => { setHoveredServerId(null) }, [regionId])

  // Audit ISSUE-030: every derived value below is memoized with precise deps. The page
  // re-renders on every 1 Hz batch AND on every hover-state flip; unmemoized, each of those
  // re-ran computeWorldCost over the whole doc, the full-events filter, and the rail pairing.
  // Hooks sit ABOVE the null early-return (rules of hooks), keyed on a safe '' region id.
  const rid = regionId ?? ''
  const azs = useMemo(() => Object.values(doc.azs).filter(a => a.regionId === rid), [doc.azs, rid])
  const servers = useMemo(
    () => Object.values(doc.servers).filter(s => azs.some(a => a.id === s.azId)),
    [doc.servers, azs])
  const instanceCount = useMemo(
    () => Object.values(compiled.instances).filter(i => i.regionId === rid).length,
    [compiled, rid])
  const shares = useMemo(() => azShares(rid, doc, batch), [rid, doc, batch])
  const batchSimMs = batch?.simMs ?? 0
  const alert = useMemo(() => ribbonAlert(rid, doc, events, batchSimMs), [rid, doc, events, batchSimMs])
  const managedMetrics = batch?.managedServices ?? null
  // FEAT-008 (Task 21, controller-added gap): fold `runningByPlacement` (a MetricsBatch-level
  // field, Task 16) into the `world` arg so an autoscaled placement's per-AZ/egress cost share
  // (SourcesColumn/AzRow below) tracks the live fleet, not its full maxCount envelope — same fix
  // as CostTab.tsx's. Memoized on the batch's own `world`/`runningByPlacement` refs (not
  // recreated every render) so the ISSUE-030 memoization above stays effective.
  const worldMetrics = useMemo(
    () => batch?.world ? { ...batch.world, runningByPlacement: batch.runningByPlacement } : null,
    [batch?.world, batch?.runningByPlacement])
  // computeWorldCost reads doc.servers/doc.placements directly -- an active environment's
  // instanceClassOverrides/serverCountFactor/placementCountOverrides must be overlaid here too,
  // or this region's cost rollup silently disagrees with CostTab.tsx's total. applyEnvironment is
  // pure and only reads fields already inside `doc`, so keying the memo on `doc` alone (as
  // before) still recomputes correctly whenever the active environment changes.
  // I3 fix (final wave-5 review): defaults an unpinned managed service's provider to
  // `doc.cloudProfile`, the same as CostTab.tsx's headline and scopeData.ts's rollups — this is
  // the region's own cost, not a comparison surface.
  const costs = useMemo(
    () => computeWorldCost(applyEnvironment(doc), worldMetrics, managedMetrics, defaultProviderFromDoc(doc)),
    [doc, worldMetrics, managedMetrics])
  // node-model Phase 5.1/5.2: cloud-managed services have no hardware, so they never appear among
  // the servers below. AZ-scoped ones now show in their AZ card (regionAzManaged); this strip is for
  // the REGION-scoped ones (not tied to an AZ) — listed even at rest, with live rps + throttle + kill
  // once the sim runs.
  const managedEntries = useMemo(
    () => regionManagedServices(rid, doc, batch).filter(e => e.scope === 'region'),
    [rid, doc, batch])

  // Replica rail + per-az db-endpoint tagging, computed ONCE here and threaded down (the same
  // "compute once, thread down" reuse `monthlyUsd` already established for AzRow) rather than
  // each AzRow independently re-deriving a whole-region pairing.
  const railPairs = useMemo(() => replicaRailPairs(doc, compiled, rid), [doc, compiled, rid])
  const railEntries: ReplicaRailEntry[] = useMemo(() => {
    const azIndexById = new Map(azs.map((a, i) => [a.id, i]))
    return railPairs.map(p => ({
      blueprintId: p.blueprintId,
      primaryServerId: p.primaryServerId,
      replicaServerId: p.replicaServerId,
      primaryAzIndex: azIndexById.get(doc.servers[p.primaryServerId]?.azId ?? '') ?? 0,
      replicaAzIndex: azIndexById.get(doc.servers[p.replicaServerId]?.azId ?? '') ?? 0,
    }))
  }, [azs, railPairs, doc.servers])
  const dbEndpointsByAz = useMemo(() => {
    const m = new Map<string, AzRowDbEndpoint[]>()
    for (const p of railPairs) {
      const primaryAzId = doc.servers[p.primaryServerId]?.azId
      const replicaAzId = doc.servers[p.replicaServerId]?.azId
      if (primaryAzId) m.set(primaryAzId, [...(m.get(primaryAzId) ?? []), { serverId: p.primaryServerId, role: 'primary' }])
      if (replicaAzId) m.set(replicaAzId, [...(m.get(replicaAzId) ?? []), { serverId: p.replicaServerId, role: 'replica' }])
    }
    return m
  }, [railPairs, doc.servers])

  if (!regionId || !doc.regions[regionId]) return null

  const region = doc.regions[regionId]
  const worldLabel = WORLD_REGIONS.find(r => r.id === region.catalogId)?.label ?? region.catalogId
  const rowsHeight = Math.max(140, azs.length * ROW_HEIGHT_ESTIMATE)

  return (
    <div style={{ padding: 18, font: '12px var(--font-mono)' }}>
      <div
        style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4,
          borderRadius: 6, padding: 2,
          // Non-fatal operator fault on this region (FEAT-001, plan design section) — amber accent
          // distinct from the region page's existing down/degraded treatment elsewhere on this page.
          ...(isNonFatalFault(activeFaults[regionId] ?? null) ? NON_FATAL_FAULT_ACCENT : {}),
        }}
      >
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
          <ChaosControl scope="region" id={regionId} running={running} killLabel="Simulate region outage" />
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

      {managedEntries.length > 0 && (
        <div
          data-testid="region-managed-strip"
          style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, margin: '8px 0 2px' }}
        >
          <span style={{ color: 'var(--color-text-muted)', fontSize: 10 }}>managed services:</span>
          {managedEntries.map(e => {
            const down = healthOverrides[e.id] ?? false
            const troubled = down || e.refusedRps > 0.5 || e.health === 'down'
            const tint = troubled ? 'var(--color-danger)' : e.health === 'degraded' ? 'var(--color-warning)' : 'var(--color-success)'
            return (
              <span
                key={e.id} data-testid={`region-managed-${e.id}`} title="region-wide"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  border: `1px solid ${down ? 'var(--color-danger)' : 'var(--color-node-border)'}`, borderRadius: 6,
                  background: 'var(--color-node-base)', padding: '3px 8px', fontSize: 10,
                  ...(isNonFatalFault(activeFaults[e.id] ?? null) ? NON_FATAL_FAULT_ACCENT : {}),
                }}
              >
                <span aria-hidden>🗄</span>
                <span style={{ color: 'var(--color-text-primary)' }}>{e.label}</span>
                <span style={{ color: 'var(--color-text-muted)' }}>{e.nodeType}</span>
                {/* Utilization bar (node-model Phase 5.3): live load ÷ ceiling, tinted by health —
                    the "metric bar" the region view was missing for managed services. */}
                {live && !down && (
                  <span
                    data-testid={`region-managed-bar-${e.id}`}
                    style={{ width: 46, height: 5, borderRadius: 3, background: '#1a202b', overflow: 'hidden', position: 'relative', display: 'inline-block' }}
                  >
                    <span style={{ position: 'absolute', inset: '0 auto 0 0', width: `${Math.max(2, Math.round(e.utilization * 100))}%`, background: tint, height: '100%', display: 'block' }} />
                  </span>
                )}
                {down
                  ? <span style={{ color: 'var(--color-danger)' }}>down</span>
                  : live
                    ? <span style={{ color: tint, fontVariantNumeric: 'tabular-nums' }}>
                        {Math.round(e.rps).toLocaleString('en-US')} rps{troubled ? ' ⚠' : ''}
                      </span>
                    : <span style={{ color: 'var(--color-text-muted)' }}>idle</span>}
                <ChaosControl scope="managed" id={e.id} running={running} label={e.label} />
              </span>
            )
          })}
        </div>
      )}

      {azs.length === 0 ? (
        <div style={{ color: 'var(--color-text-muted)', font: '12px var(--font-mono)' }}>
          No AZs yet — add one in the World panel →
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'stretch', gap: 0, position: 'relative' }}>
          <SourcesColumn regionId={regionId} internetEgressMonthlyUsd={costs.egress.internetUsd} />

          {/* Same ≥2-AZ gate as RegionConfigTab's LoadBalancerSection — a single-AZ region's LB
              config is a no-op, so the flow-page card stays out of the way until it's meaningful. */}
          {azs.length >= 2 && <RegionLbCard regionId={regionId} />}

          <SplitLines shares={shares} height={rowsHeight} live={live} />

          <div style={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column', gap: 8, marginRight: 20 }}>
            {azs.map(az => (
              <AzRow
                key={az.id} azId={az.id} regionId={regionId}
                inboundRps={shares.find(s => s.azId === az.id)?.rps ?? 0}
                droppedRps={shares.find(s => s.azId === az.id)?.dropped ?? 0}
                monthlyUsd={costs.byAz.find(e => e.azId === az.id)?.monthlyUsd ?? 0}
                dbEndpoints={dbEndpointsByAz.get(az.id) ?? []}
                onNavigateAz={() => goAz(regionId, az.id)}
                onNavigateServer={serverId => goServer(regionId, az.id, serverId)}
                onHoverServer={setHoveredServerId}
              />
            ))}
            <ReplicaRail entries={railEntries} azCount={azs.length} rowsHeight={rowsHeight} hoveredServerId={hoveredServerId} flowing={live && (batch?.regions[regionId]?.rps ?? 0) > 0} />
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
