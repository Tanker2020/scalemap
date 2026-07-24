// src/app/world/InspectorV2.tsx
// AZ-view overlay listing traced requests for the focused AZ (contracts: "engine samples ≤1
// traced request per second per scope" — polled locally since getTracedRequests is a plain
// method, not reactive state).
//
// Polish 4 T4 (spec D6): retired the Polish-3-T4-era "selected server" pane (rack selector +
// enter/kill) — with the dock's server scope now rendering the faceplate (`dock/
// ServerFaceplate.tsx` + `dock/drawers/PlacementDrawer.tsx`) for the SAME selection
// (`ui.store.selectedServerId`), that card would have been a duplicate surface. Every dispatch
// it used to make (assignServerToRack, goServer, setOutage) moved into the faceplate/
// PlacementDrawer byte-for-byte — this file goes back to being traces-only, its pre-Polish-3-T4
// shape.
import { useEffect, useState } from 'react'
import { useSimulationStore } from '../store/simulation.store'
import type { TracedRequest } from '../../lib/worldEngine/types'
import type { AzId } from '../../lib/world/types'

const OUTCOME_COLOR: Record<TracedRequest['outcome'], string> = {
  ok: 'var(--color-success)', refused: 'var(--color-danger)',
  error: 'var(--color-danger)', timeout: 'var(--color-warning)',
}

interface Props {
  azId: AzId
}

export function InspectorV2({ azId }: Props) {
  const [traces, setTraces] = useState<TracedRequest[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // The engine's tracer holds a run's sampled requests until the next start(); poll it only while
  // a run is active (running stays true while paused, so traces persist on pause). On End (running
  // false) clear them, so a finished run's traces don't linger over the at-rest AZ floor.
  const running = useSimulationStore(s => s.running)

  useEffect(() => {
    if (!running) { setTraces([]); return }
    // getTracedRequests returns a FRESH array each call; short-circuit to the previous state
    // when the trace ids are unchanged (audit ISSUE-055) — otherwise the new reference forced a
    // steady 1 Hz re-render of the overlay even with no new traces.
    const poll = () => setTraces(prev => {
      const next = useSimulationStore.getState().getTracedRequests({ level: 'az', azId })
      const unchanged = next.length === prev.length && next.every((t, i) => t.id === prev[i].id)
      return unchanged ? prev : next
    })
    poll()
    const id = setInterval(poll, 1000)
    return () => clearInterval(id)
  }, [azId, running])

  if (traces.length === 0) return null

  return (
    <div data-no-pan style={{
      position: 'absolute', left: 12, bottom: 12, width: 270, maxHeight: 320, overflowY: 'auto',
      background: 'var(--color-surface)', border: '1px solid var(--color-node-border)',
      borderRadius: 8, padding: 10, font: '11px var(--font-mono)', color: 'var(--color-text-primary)',
      pointerEvents: 'auto',
    }}>
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
    </div>
  )
}
