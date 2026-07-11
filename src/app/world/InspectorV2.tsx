// src/app/world/InspectorV2.tsx
// AZ-view overlay listing traced requests for the focused AZ (contracts: "engine samples ≤1
// traced request per second per scope" — polled locally since getTracedRequests is a plain
// method, not reactive state). Polish 3 T4 additive extension: when the datacenter floor
// (`az/DatacenterFloor.tsx`) has a server selected (tap, not hold), this also renders a
// "selected server" pane with a rack selector — `free pool` + every rack in this AZ, an option
// disabled when the server can't fit (`rackModel.canAssign`), dispatching
// `assignServerToRack` on change. No other new store surface (T2's rack actions only).
import { useEffect, useState, type CSSProperties } from 'react'
import { useSimulationStore } from '../store/simulation.store'
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { canAssign, rackUsedU } from '../../lib/world/rackModel'
import type { TracedRequest } from '../../lib/worldEngine/types'
import type { AzId, ServerId } from '../../lib/world/types'

const OUTCOME_COLOR: Record<TracedRequest['outcome'], string> = {
  ok: 'var(--color-success)', refused: 'var(--color-danger)',
  error: 'var(--color-danger)', timeout: 'var(--color-warning)',
}

const FREE_POOL_VALUE = '__free_pool__'

const ACT_BTN: CSSProperties = {
  font: '10px var(--font-mono)', background: 'var(--color-node-base)',
  border: '1px solid var(--color-node-border)', borderRadius: 4, padding: '3px 10px',
  cursor: 'pointer', color: 'var(--color-text-secondary)',
}

interface Props {
  azId: AzId
  selectedServerId?: ServerId | null
  onClearSelection?: () => void
}

export function InspectorV2({ azId, selectedServerId = null, onClearSelection }: Props) {
  const [traces, setTraces] = useState<TracedRequest[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const doc = useWorldStore(s => s.doc)
  const assignServerToRack = useWorldStore(s => s.assignServerToRack)
  // Post-Polish-3 fix wave (user report 2026-07-11: the selected-server card was bare) —
  // enter/kill reuse the app's existing dispatches byte-for-byte: goServer is the same nav
  // call the hold-to-enter gesture fires; kill/restore is AzRow's exact setOutage pattern
  // (disabled while stopped, keyed off healthOverrides), scoped 'server'.
  const goServer = useNavStore(s => s.goServer)
  const navRegionId = useNavStore(s => s.regionId)
  const running = useSimulationStore(s => s.running)
  const isManuallyDown = useSimulationStore(s => (selectedServerId ? s.healthOverrides[selectedServerId] ?? false : false))
  const setOutage = useSimulationStore(s => s.setOutage)

  useEffect(() => {
    const poll = () => setTraces(useSimulationStore.getState().getTracedRequests({ level: 'az', azId }))
    poll()
    const id = setInterval(poll, 1000)
    return () => clearInterval(id)
  }, [azId])

  const server = selectedServerId ? doc.servers[selectedServerId] : null
  const azRacks = Object.values(doc.racks).filter(r => r.azId === azId)

  if (traces.length === 0 && !server) return null

  return (
    <div data-no-pan style={{
      position: 'absolute', left: 12, bottom: 12, width: 270, maxHeight: 320, overflowY: 'auto',
      background: 'var(--color-surface)', border: '1px solid var(--color-node-border)',
      borderRadius: 8, padding: 10, font: '11px var(--font-mono)', color: 'var(--color-text-primary)',
      pointerEvents: 'auto',
    }}>
      {server && (
        <div style={{ marginBottom: 10, paddingBottom: 8, borderBottom: '1px solid var(--color-node-border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div style={{ font: '600 10px var(--font-mono)', color: 'var(--color-text-muted)', textTransform: 'uppercase' }}>
              selected server
            </div>
            {onClearSelection && (
              <button
                aria-label="clear selection"
                onClick={onClearSelection}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', font: '11px var(--font-mono)' }}
              >
                ✕
              </button>
            )}
          </div>
          <div style={{ marginTop: 4, color: 'var(--color-text-primary)' }}>{server.label}</div>
          <div style={{ color: 'var(--color-text-muted)', fontSize: 10, marginTop: 2 }}>
            {server.kind} · {server.specs.vcpu}vCPU / {Math.round(server.specs.ramMb / 1024)}G
            {' · '}<span style={{ color: 'var(--color-price)' }}>${server.hourlyUsd.toFixed(3)}/hr</span>
          </div>

          <label style={{ display: 'block', marginTop: 8, fontSize: 10, color: 'var(--color-text-secondary)' }}>
            rack
            <select
              aria-label="rack"
              disabled={running}
              title={running ? 'stop the simulation to edit' : undefined}
              value={server.rack?.rackId ?? FREE_POOL_VALUE}
              onChange={e => {
                const v = e.target.value
                assignServerToRack(server.id, v === FREE_POOL_VALUE ? null : v)
              }}
              style={{
                display: 'block', width: '100%', marginTop: 3, background: 'var(--color-node-base)',
                border: '1px solid var(--color-node-border)', borderRadius: 4, padding: '4px 6px',
                font: '11px var(--font-mono)', color: 'var(--color-text-primary)',
              }}
            >
              <option value={FREE_POOL_VALUE}>free pool</option>
              {azRacks.map(rack => {
                const disabled = rack.id !== server.rack?.rackId && !canAssign(doc, server.id, rack.id)
                return (
                  <option key={rack.id} value={rack.id} disabled={disabled}>
                    {rack.label} · {rackUsedU(doc, rack.id)}/{rack.capacityU} U
                  </option>
                )
              })}
            </select>
          </label>

          <div style={{ display: 'flex', gap: 6, marginTop: 9 }}>
            <button
              style={ACT_BTN}
              onClick={() => navRegionId && goServer(navRegionId, azId, server.id)}
            >
              ⏎ enter
            </button>
            <button
              style={{
                ...ACT_BTN,
                color: isManuallyDown ? 'var(--color-success)' : 'var(--color-danger)',
                opacity: running ? 1 : 0.45,
                cursor: running ? 'pointer' : 'default',
              }}
              disabled={!running}
              title={running ? undefined : 'start the simulation to break things'}
              onClick={() => setOutage('server', server.id, !isManuallyDown)}
            >
              {isManuallyDown ? '↺ restore' : 'kill'}
            </button>
          </div>
        </div>
      )}

      {traces.length > 0 && (
        <>
          <div style={{ font: '600 10px var(--font-mono)', color: 'var(--color-text-muted)', textTransform: 'uppercase', marginBottom: 6 }}>
            Traced requests
          </div>
          {traces.map(t => (
            <div key={t.id} style={{ marginBottom: 6 }}>
              <button
                style={{
                  display: 'flex', justifyContent: 'space-between', width: '100%',
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                  color: OUTCOME_COLOR[t.outcome], font: '11px var(--font-mono)',
                }}
                onClick={() => setExpandedId(id => id === t.id ? null : t.id)}
              >
                <span>{t.outcome}</span>
                <span style={{ color: 'var(--color-text-muted)' }}>{t.totalMs.toFixed(1)}ms</span>
              </button>
              {expandedId === t.id && (
                <div style={{ marginTop: 4, paddingLeft: 8, borderLeft: '2px solid var(--color-node-border)' }}>
                  {t.hops.map((h, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--color-text-secondary)' }}>
                      <span>{h.fromId} → {h.toId} ({h.hopClass})</span>
                      <span style={{ color: OUTCOME_COLOR[h.outcome] }}>{h.outcome} · {h.latencyMs.toFixed(1)}ms</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  )
}
