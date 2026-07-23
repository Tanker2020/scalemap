// src/app/world/region/AzRow.tsx
// One AZ's card in the region flow (Region v4, Polish 3 T3, mockup `.azcard`): health ring +
// name + live inbound rps + $/mo in the header, a hover-revealed `.r3-cfgbar` (⏎ enter / +
// server / ⚡ kill·✓ restore — all three reuse EXISTING dispatches byte-for-byte, no new store
// surface: `onNavigateAz`, `addServer(azId, getPreset('vps-medium')!)`, `setOutage('az', azId,
// !azDown)`), then either the drain line (down) or one static-bar `.azrow` per server — a
// db-tagged row (amber fill, ◆ PRIMARY/◇ REPLICA chip) for every server this AZ's `dbEndpoints`
// prop marks as a replica-rail endpoint (computed once in RegionView.tsx via
// `regionData.ts`'s `replicaRailPairs` and threaded down, the same "compute once, thread down"
// reuse `monthlyUsd` already established). Preserves every Phase-4/5 down-state distinction
// (`outage` vs `outage (manual)`, replica promotion, drain targets, the health ring's `—`
// at-rest numeral) — this restyles AzRow's existing shape, it does not replace it.
import { useMemo, type CSSProperties, type ReactElement } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useCompiledWorld, instancesByAzFor, instancesByServerFor } from '../useCompiledWorld'
import { getPreset } from '../../../lib/world/instanceCatalog'
import { dominantBlueprintColor, regionAzManaged } from './regionData'
import type { AzId, RegionId, ServerId } from '../../../lib/world/types'
import type { HealthState } from '../../../lib/worldEngine/types'
import './r3Styles'

const RING_TRACK = '#1E2430'
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
const BLUE = '#5B9CF6'   // mockup `--blue` (verbatim) — non-db utilization-bar fill

const CFG_BTN_STYLE: CSSProperties = {
  font: '10px var(--font-mono)', border: '1px solid var(--color-node-border)', borderRadius: 4,
  background: '#10141bee', color: 'var(--color-text-secondary)', padding: '2px 8px', cursor: 'pointer',
}

export interface AzRowDbEndpoint { serverId: ServerId; role: 'primary' | 'replica' }

export interface AzRowProps {
  azId: AzId
  regionId: RegionId
  // The region ingress routed to this AZ (azShares' rps — the region trunk split by AZ share).
  // The header shows THIS as the AZ's inbound rate, not batch.azs[az].rps (total instance
  // throughput, which additionally counts internal service→service hops and reads ~2× the ingress).
  inboundRps: number
  monthlyUsd: number
  dbEndpoints: AzRowDbEndpoint[]
  onNavigateAz: () => void
  onNavigateServer: (serverId: ServerId) => void
  onHoverServer: (serverId: ServerId | null) => void
}

export function AzRow({
  azId, regionId, inboundRps, monthlyUsd, dbEndpoints, onNavigateAz, onNavigateServer, onHoverServer,
}: AzRowProps): ReactElement {
  const doc = useWorldStore(s => s.doc)
  const addServer = useWorldStore(s => s.addServer)
  const compiled = useCompiledWorld()
  const batch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const running = useSimulationStore(s => s.running)
  const events = useSimulationStore(s => s.events)
  const isManuallyDown = useSimulationStore(s => s.healthOverrides[azId] ?? false)
  const healthOverrides = useSimulationStore(s => s.healthOverrides)
  const setOutage = useSimulationStore(s => s.setOutage)
  // Managed cloud services scoped to THIS az (node-model Phase 5.2) — shown as usage rows below the
  // servers, since they have no hardware but still take load and can be taken down.
  const managedHere = regionAzManaged(azId, doc, batch)

  const az = doc.azs[azId]
  // Audit ISSUE-029: memoized + indexed derivations. AzRow re-renders every 1 Hz batch; the
  // unmemoized full-instance-map filters here (×N AzRows) made the region page
  // O(servers × instances) per second. instancesByAzFor/instancesByServerFor are the shared
  // per-compiled indexes (WeakMap-cached in useCompiledWorld.ts).
  const servers = useMemo(() => Object.values(doc.servers).filter(s => s.azId === azId), [doc.servers, azId])
  const residentInstances = instancesByAzFor(compiled).get(azId) ?? []
  const instanceCount = residentInstances.length
  const metrics = batch?.azs[azId] ?? null
  const isDown = metrics?.health === 'down'
  const dbByServerId = useMemo(() => new Map(dbEndpoints.map(e => [e.serverId, e.role])), [dbEndpoints])

  const residentInstanceIds = useMemo(() => new Set(residentInstances.map(i => i.id)), [residentInstances])
  const batchSimMs = batch?.simMs
  const promoting = useMemo(() => batchSimMs != null && events.some(e =>
    e.kind === 'replica_promoted' && e.simMs > batchSimMs - PROMOTE_WINDOW_MS && e.simMs <= batchSimMs &&
    e.affected.some(id => residentInstanceIds.has(id))), [batchSimMs, events, residentInstanceIds])

  const rpsByServer = useMemo(() => {
    const byServer = instancesByServerFor(compiled)
    const m = new Map<ServerId, number>()
    for (const s of servers) {
      m.set(s.id, (byServer.get(s.id) ?? []).reduce((sum, i) => sum + (batch?.instances[i.id]?.rps ?? 0), 0))
    }
    return m
  }, [servers, compiled, batch])

  const healthyAzLabels = Object.values(doc.azs)
    .filter(a => a.regionId === regionId && a.id !== azId && batch?.azs[a.id]?.health !== 'down')
    .map(a => a.label)

  const score = metrics?.healthScore
  const dashOffset = score == null ? RING_CIRC : RING_CIRC * (1 - score / 100)
  const ringColor = HEALTH_COLOR[metrics?.health ?? 'healthy']

  const cardStyle: CSSProperties = {
    border: `1px solid ${isDown ? 'var(--color-danger)' : 'var(--color-node-border)'}`,
    borderRadius: 10, background: 'var(--color-node-base)', padding: '11px 13px',
    position: 'relative', font: '11px var(--font-mono)', opacity: isDown ? 0.85 : 1,
  }

  return (
    <div className="r3-azcard" data-az-row={azId} style={cardStyle}>
      <div className="r3-cfgbar" style={{ position: 'absolute', top: 8, right: 10, display: 'flex', gap: 5, zIndex: 3 }}>
        <button className="r3-cfgbtn" style={CFG_BTN_STYLE} onClick={onNavigateAz}>⏎ enter</button>
        {/* Authoring is edit-locked while the sim runs (user request 2026-07-11); kill is the
            inverse — it only makes sense DURING a run. */}
        <button className="r3-cfgbtn" style={CFG_BTN_STYLE} disabled={running} title={running ? 'stop the simulation to edit' : undefined} onClick={() => addServer(azId, getPreset('vps-medium')!)}>+ server</button>
        <button
          className="r3-cfgbtn x" style={CFG_BTN_STYLE} disabled={!running}
          aria-label={`${isManuallyDown ? 'Clear' : 'Simulate'} outage for ${az?.label ?? azId}`}
          onClick={() => setOutage('az', azId, !isManuallyDown)}
        >
          {isManuallyDown ? '✓ restore' : 'kill'}
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, cursor: 'pointer' }} onClick={onNavigateAz}>
        <svg width={22} height={22} viewBox="0 0 34 34" style={{ flexShrink: 0 }}>
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
        <span style={{ fontWeight: 600, fontSize: 11.5, color: isDown ? DOWN_TINT : 'var(--color-text-primary)' }}>
          {az?.label ?? azId}
        </span>
        <span style={{ color: isDown ? 'var(--color-danger)' : 'var(--r3-hud)', fontSize: 10.5, fontVariantNumeric: 'tabular-nums' }}>
          {isDown ? (isManuallyDown ? 'outage (manual)' : 'outage') : `◂ ${inboundRps.toFixed(0)} rps`}
        </span>
        <span style={{ color: 'var(--color-text-muted)', fontSize: 9.5 }}>
          {servers.length} srv · {instanceCount} svc
          {!isDown && <> · p50 {(metrics?.p50Ms ?? 0).toFixed(0)}ms</>}
          {' · '}<span style={{ color: 'var(--color-price)' }}>${Math.round(monthlyUsd)}/mo</span>
        </span>
      </div>

      {isDown ? (
        <div style={{ marginTop: 8, color: 'var(--color-text-secondary)', fontSize: 10 }}>
          draining → {healthyAzLabels.map(label => (
            <span key={label} style={{ color: 'var(--color-success)', marginRight: 4 }}>{label}</span>
          ))}
          {promoting && <span> · replicas promoting</span>}
        </div>
      ) : (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {servers.map(server => {
            const sm = batch?.servers[server.id]
            const mean = sm && sm.coreUtilization.length
              ? sm.coreUtilization.reduce((a, b) => a + b, 0) / sm.coreUtilization.length
              : 0
            const pct = batch ? Math.max(4, Math.round(mean * 100)) : 6
            const role = dbByServerId.get(server.id)
            const isDb = role != null
            const barColor = isDb ? 'var(--r3-amber)' : (dominantBlueprintColor(server.id, doc, compiled) || BLUE)
            const rps = rpsByServer.get(server.id) ?? 0
            return (
              <div
                key={server.id} title={server.label}
                style={{
                  display: 'grid', gridTemplateColumns: '120px 1fr 58px', gap: 10, alignItems: 'center',
                  fontSize: 10, color: 'var(--color-text-secondary)', padding: '3px 6px', borderRadius: 4,
                  borderLeft: isDb ? '2px solid var(--r3-amber)' : '2px solid transparent',
                  background: isDb ? '#e0a5520a' : 'transparent', cursor: 'pointer', position: 'relative',
                }}
                onMouseEnter={() => isDb && onHoverServer(server.id)}
                onMouseLeave={() => isDb && onHoverServer(null)}
                onClick={e => { e.stopPropagation(); onNavigateServer(server.id) }}
              >
                <span>{server.label}</span>
                <span style={{ height: 5, borderRadius: 3, background: '#1a202b', overflow: 'hidden', position: 'relative', display: 'block' }}>
                  <span style={{ position: 'absolute', inset: '0 auto 0 0', width: `${pct}%`, background: barColor, display: 'block', height: '100%' }}>
                    <span style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 4, borderRadius: 2, background: '#ffffffcc', filter: 'blur(1px)', opacity: 0.7 }} />
                  </span>
                </span>
                <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {role === 'replica' ? 'reads only' : `${Math.round(rps)} rps`}
                </span>
                {isDb && (
                  <span
                    style={{
                      position: 'absolute', right: -4, top: '50%', transform: 'translate(100%, -50%)',
                      fontSize: 8, letterSpacing: '0.08em', whiteSpace: 'nowrap',
                      color: role === 'primary' ? 'var(--r3-amber)' : 'var(--r3-amber-text)',
                    }}
                  >
                    {role === 'primary' ? '◆ PRIMARY' : '◇ REPLICA'}
                  </span>
                )}
              </div>
            )
          })}
          {managedHere.map(m => {
            const down = healthOverrides[m.id] ?? false
            // Phase 5.4: a capacity-modelled DB reports a real saturation on its BINDING axis —
            // prefer it over the coarse reads+writes utilization gauge when it exists.
            const fill = m.saturation > 0 ? Math.min(1, m.saturation) : m.utilization
            const pct = down ? 100 : Math.max(2, Math.round(fill * 100))
            const barColor = down ? 'var(--color-danger)' : HEALTH_COLOR[m.health]
            const capLabel = m.capacityRps != null ? `${Math.round(m.rps)}/${m.capacityRps}` : `${Math.round(m.rps)}`
            // The DB readout: how full, how slow, how many connections. Only shown for a DB with a
            // live runtime (p50 > 0); everything else keeps the plain rps line.
            const dbReadout = m.p50Ms > 0
              ? `${Math.round(fill * 100)}% · ${m.p50Ms < 10 ? m.p50Ms.toFixed(1) : Math.round(m.p50Ms)}ms · ${Math.round(m.connections)}c`
              : null
            return (
              <div
                key={m.id} data-managed-row={m.id}
                title={`${m.label} · ${m.nodeType} (managed${m.scope === 'region' ? ', region-wide' : ''})`
                  + (m.p50Ms > 0 ? ` — p50 ${m.p50Ms.toFixed(1)}ms · ${Math.round(m.connections)} connections` : '')
                  + (m.errorRps > 0.5 ? ` · ${Math.round(m.errorRps)} rps timing out` : '')}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, color: 'var(--color-text-secondary)',
                  padding: '3px 6px', borderRadius: 4, borderLeft: `2px solid ${barColor}`,
                }}
              >
                <span style={{ width: 108, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {m.label}{m.scope === 'region' ? <span style={{ color: 'var(--color-text-muted)' }}> · rgn</span> : ''}
                </span>
                <span style={{ flex: 1, height: 5, borderRadius: 3, background: '#1a202b', overflow: 'hidden', position: 'relative', display: 'block' }}>
                  <span style={{ position: 'absolute', inset: '0 auto 0 0', width: `${pct}%`, background: barColor, height: '100%', display: 'block' }} />
                </span>
                <span style={{ width: 132, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: down ? 'var(--color-danger)' : undefined }}>
                  {down ? 'down' : (dbReadout ?? `${capLabel} rps`)}
                  {!down && (m.refusedRps > 0.5 || m.errorRps > 0.5) ? ' ⚠' : ''}
                </span>
                {running && (
                  <button
                    type="button" aria-label={`${down ? 'restore' : 'kill'} ${m.label}`}
                    onClick={() => setOutage('managed', m.id, !down)}
                    style={{
                      font: '9px var(--font-mono)', cursor: 'pointer', padding: '1px 6px', borderRadius: 3,
                      border: `1px solid ${down ? 'var(--color-success)' : 'var(--color-danger)'}`,
                      background: '#10141bee', color: down ? 'var(--color-success)' : 'var(--color-danger)',
                    }}
                  >
                    {down ? '✓ restore' : 'kill'}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
