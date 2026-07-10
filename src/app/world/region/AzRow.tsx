// src/app/world/region/AzRow.tsx
// One AZ's row in the region flow (D4, mockup lines 199-246): health ring, clickable server
// strips (or the drain line when down), per-AZ $/mo, and a running-gated outage switch.
import type { CSSProperties, ReactElement } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useCompiledWorld } from '../useCompiledWorld'
import { computeWorldCost } from '../../../lib/costModelV2'
import { dominantBlueprintColor } from './regionData'
import type { AzId, RegionId, ServerId } from '../../../lib/world/types'
import type { HealthState } from '../../../lib/worldEngine/types'

const ROW_BG = '#12151C'
const ROW_BORDER = '#232833'
const RING_TRACK = '#1E2430'
const STRIP_TRACK = '#1E2430'
const RING_NUMERAL_OK = '#E2E8F0'
// Ring-numeral/az-label tint for a down row — lighter than --color-danger for legibility on
// the dark ring/row background; the mockup uses this exact literal hex too, no token match (R2).
const DOWN_TINT = '#FCA5A5'
const RING_R = 14
const RING_CIRC = 2 * Math.PI * RING_R
const HEALTH_COLOR: Record<HealthState, string> = {
  healthy: 'var(--color-success)', degraded: 'var(--color-warning)', down: 'var(--color-danger)',
}
const PROMOTE_WINDOW_MS = 30_000

export interface AzRowProps {
  azId: AzId
  regionId: RegionId
  onNavigateAz: () => void
  onNavigateServer: (serverId: ServerId) => void
}

export function AzRow({ azId, regionId, onNavigateAz, onNavigateServer }: AzRowProps): ReactElement {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const batch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const running = useSimulationStore(s => s.running)
  const events = useSimulationStore(s => s.events)
  const isManuallyDown = useSimulationStore(s => s.healthOverrides[azId] ?? false)
  const setOutage = useSimulationStore(s => s.setOutage)

  const az = doc.azs[azId]
  const servers = Object.values(doc.servers).filter(s => s.azId === azId)
  const instanceCount = Object.values(compiled.instances).filter(i => i.azId === azId).length
  const metrics = batch?.azs[azId] ?? null
  const isDown = metrics?.health === 'down'
  const usd = computeWorldCost(doc, batch?.world ?? null).byAz.find(e => e.azId === azId)?.monthlyUsd ?? 0

  const residentInstanceIds = Object.values(compiled.instances).filter(i => i.azId === azId).map(i => i.id)
  const promoting = batch != null && events.some(e =>
    e.kind === 'replica_promoted' && e.simMs > batch.simMs - PROMOTE_WINDOW_MS && e.simMs <= batch.simMs &&
    e.affected.some(id => residentInstanceIds.includes(id)))

  const healthyAzLabels = Object.values(doc.azs)
    .filter(a => a.regionId === regionId && a.id !== azId && batch?.azs[a.id]?.health !== 'down')
    .map(a => a.label)

  const score = metrics?.healthScore
  const dashOffset = score == null ? RING_CIRC : RING_CIRC * (1 - score / 100)
  const ringColor = HEALTH_COLOR[metrics?.health ?? 'healthy']

  const rowStyle: CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 14, background: ROW_BG,
    border: `1px solid ${isDown ? 'var(--color-danger)' : ROW_BORDER}`,
    borderLeft: `2px solid ${ringColor}`,
    borderRadius: 8, padding: '8px 14px', cursor: 'pointer', opacity: isDown ? 0.8 : 1,
    font: '11px var(--font-mono)',
  }

  return (
    <div data-az-row={azId} style={rowStyle} onClick={onNavigateAz}>
      <svg width={34} height={34} viewBox="0 0 34 34" style={{ flexShrink: 0 }}>
        <circle cx={17} cy={17} r={RING_R} fill="none" stroke={RING_TRACK} strokeWidth={3.5} />
        {score != null && (
          <circle
            cx={17} cy={17} r={RING_R} fill="none" stroke={ringColor} strokeWidth={3.5}
            strokeDasharray={RING_CIRC} strokeDashoffset={dashOffset} strokeLinecap="round"
            transform="rotate(-90 17 17)"
          />
        )}
        <text x={17} y={21} fill={isDown ? DOWN_TINT : RING_NUMERAL_OK} fontSize={9} textAnchor="middle">
          {score != null ? Math.round(score) : '—'}
        </text>
      </svg>

      <div style={{ width: 110, flexShrink: 0 }}>
        <div style={{ color: isDown ? DOWN_TINT : 'var(--color-text-primary)' }}>{az?.label ?? azId}</div>
        <div style={{ color: isDown ? 'var(--color-danger)' : 'var(--color-text-muted)' }}>
          {isDown ? 'outage (manual)' : `${servers.length} srv · ${instanceCount} svc`}
        </div>
      </div>

      {isDown ? (
        <div style={{ flex: 1, color: 'var(--color-text-secondary)' }}>
          draining → {healthyAzLabels.map(label => (
            <span key={label} style={{ color: 'var(--color-success)', marginRight: 4 }}>{label}</span>
          ))}
          {promoting && <span> · replicas promoting</span>}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 2.5, alignItems: 'flex-end', height: 22, flex: 1 }}>
          {servers.map(server => {
            const sm = batch?.servers[server.id]
            const mean = sm && sm.coreUtilization.length
              ? sm.coreUtilization.reduce((a, b) => a + b, 0) / sm.coreUtilization.length
              : 0
            const heightPct = batch ? Math.max(4, mean * 100) : 6
            const color = dominantBlueprintColor(server.id, doc, compiled)
            return (
              <div
                key={server.id} title={server.label}
                style={{ width: 9, height: `${heightPct}%`, background: STRIP_TRACK, borderTop: `2px solid ${color}`, borderRadius: 1, cursor: 'pointer' }}
                onClick={e => { e.stopPropagation(); onNavigateServer(server.id) }}
              />
            )
          })}
        </div>
      )}

      <div style={{ textAlign: 'right', color: 'var(--color-text-secondary)', width: 130, flexShrink: 0 }}>
        {isDown ? (
          <span style={{ color: 'var(--color-text-muted)' }}>0 rps · —</span>
        ) : (
          <>
            {(metrics?.rps ?? 0).toFixed(0)} rps · p50 {(metrics?.p50Ms ?? 0).toFixed(0)}ms<br />
            <span style={{ color: 'var(--color-text-muted)' }}>
              err {((metrics?.errorRate ?? 0) * 100).toFixed(1)}% · ${Math.round(usd)}/mo
            </span>
          </>
        )}
      </div>

      {running && (
        <button
          aria-label={`${isManuallyDown ? 'Clear' : 'Simulate'} outage for ${az?.label ?? azId}`}
          style={{
            background: 'var(--color-node-base)',
            border: `1px solid ${isManuallyDown ? 'var(--color-danger)' : 'var(--color-node-border)'}`,
            borderRadius: 4, padding: '3px 6px', cursor: 'pointer', flexShrink: 0,
            font: '10px var(--font-mono)', color: isManuallyDown ? 'var(--color-danger)' : 'var(--color-text-secondary)',
          }}
          onClick={e => { e.stopPropagation(); setOutage('az', azId, !isManuallyDown) }}
        >
          {isManuallyDown ? '✓' : '⚡'}
        </button>
      )}
    </div>
  )
}
