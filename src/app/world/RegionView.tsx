// src/app/world/RegionView.tsx
// Level-2 region flow page (Phase 4 D1-D6, mockup "Level 2 · Region page (v2)"): global-edge
// inbound -> animated split shares -> AZ rows (health ring, clickable server strips, $/mo) ->
// cross-AZ column, with one alert ribbon above and (T3) a failover timeline below. Fully
// scrub-aware: every metric reads `scrubBatch ?? latestBatch` (D1) and renders a meaningful
// static state ("—", doc-derived counts) before the sim has ever produced a batch.
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { useSimulationStore } from '../store/simulation.store'
import { useCompiledWorld } from './useCompiledWorld'
import { WORLD_REGIONS } from '../../lib/regionConfig'
import type { RoutingPolicyKind } from '../../lib/world/types'
import { azShares, ribbonAlert, sparklineSeries } from './region/regionData'
import { AlertRibbon } from './region/AlertRibbon'
import { SplitLines } from './region/SplitLines'
import { AzRow } from './region/AzRow'
import { CrossAzColumn } from './region/CrossAzColumn'
import { TimelineStrip } from './region/TimelineStrip'

const POLICY_LABEL: Record<RoutingPolicyKind, string> = {
  latency: 'latency-based routing', geo: 'geo-based routing',
  weighted: 'weighted routing', priority: 'priority routing',
}
const TEAL = '#2DD4BF'
const CHIP: CSSProperties = { borderRadius: 10, padding: '2px 8px', font: '9px var(--font-mono)' }
const ACCENT_CHIP_BORDER = '#4A9EFF44'
const SUCCESS_CHIP_BORDER = '#22C55E44'
// Schematic estimate for SplitLines' height, not a live DOM measurement — see the fragment's
// judgment-call note (D11 budgets the page at ~1Hz re-render; a ResizeObserver-driven height
// sync would add churn for a purely schematic diagram).
const ROW_HEIGHT_ESTIMATE = 64
const SPARK_W = 80
const SPARK_H = 20

export function RegionView() {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const { regionId, goAz, goServer } = useNavStore()
  const batch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const running = useSimulationStore(s => s.running)
  const events = useSimulationStore(s => s.events)
  const isDown = useSimulationStore(s => s.healthOverrides[regionId ?? ''] ?? false)
  const setOutage = useSimulationStore(s => s.setOutage)
  const [spark, setSpark] = useState<number[]>([])
  const timelineRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!regionId) return
    const poll = () => setSpark(sparklineSeries(useSimulationStore.getState().getReplayFrames(), regionId))
    poll()
    if (!running) return
    const id = setInterval(poll, 1000)
    return () => clearInterval(id)
  }, [running, regionId])

  if (!regionId || !doc.regions[regionId]) return null

  const region = doc.regions[regionId]
  const azs = Object.values(doc.azs).filter(a => a.regionId === regionId)
  const servers = Object.values(doc.servers).filter(s => azs.some(a => a.id === s.azId))
  const instanceCount = Object.values(compiled.instances).filter(i => i.regionId === regionId).length
  const worldLabel = WORLD_REGIONS.find(r => r.id === region.catalogId)?.label ?? region.catalogId

  const shares = azShares(regionId, doc, batch)
  const alert = ribbonAlert(regionId, doc, events, batch?.simMs ?? 0)
  const regionRps = batch?.regions[regionId]?.rps ?? 0
  const rowsHeight = Math.max(140, azs.length * ROW_HEIGHT_ESTIMATE)
  const maxSpark = Math.max(1, ...spark)

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
              {isDown ? '✓ Clear region outage' : '⚡ Simulate region outage'}
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
        <div style={{ display: 'flex', alignItems: 'stretch', gap: 0 }}>
          <div style={{ width: 120, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            <div style={{ fontSize: 20, color: TEAL }}>◍</div>
            <div style={{ fontSize: 10, color: 'var(--color-text-primary)' }}>global edge</div>
            <div style={{ fontSize: 12, color: TEAL }}>{regionRps.toFixed(0)} rps</div>
            <svg width={SPARK_W} height={SPARK_H}>
              <polyline
                points={spark.map((v, i) => `${(i / Math.max(1, spark.length - 1)) * SPARK_W},${SPARK_H - (v / maxSpark) * SPARK_H}`).join(' ')}
                fill="none" stroke={TEAL} strokeWidth={1.2} opacity={0.8}
              />
            </svg>
          </div>

          <SplitLines shares={shares} height={rowsHeight} />

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {azs.map(az => (
              <AzRow
                key={az.id} azId={az.id} regionId={regionId}
                onNavigateAz={() => goAz(regionId, az.id)}
                onNavigateServer={serverId => goServer(regionId, az.id, serverId)}
              />
            ))}
          </div>

          <CrossAzColumn regionId={regionId} />
        </div>
      )}

      <div ref={timelineRef}>
        <TimelineStrip regionId={regionId} />
      </div>
    </div>
  )
}
