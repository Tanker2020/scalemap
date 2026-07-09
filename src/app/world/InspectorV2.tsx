// src/app/world/InspectorV2.tsx
// AZ-view overlay listing traced requests for the focused AZ (contracts: "engine samples ≤1
// traced request per second per scope" — polled locally since getTracedRequests is a plain
// method, not reactive state).
import { useEffect, useState } from 'react'
import { useSimulationStore } from '../store/simulation.store'
import type { TracedRequest } from '../../lib/worldEngine/types'

const OUTCOME_COLOR: Record<TracedRequest['outcome'], string> = {
  ok: 'var(--color-success)', refused: 'var(--color-danger)',
  error: 'var(--color-danger)', timeout: 'var(--color-warning)',
}

interface Props { azId: string }

export function InspectorV2({ azId }: Props) {
  const [traces, setTraces] = useState<TracedRequest[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    const poll = () => setTraces(useSimulationStore.getState().getTracedRequests({ level: 'az', azId }))
    poll()
    const id = setInterval(poll, 1000)
    return () => clearInterval(id)
  }, [azId])

  if (traces.length === 0) return null

  return (
    <div style={{
      position: 'absolute', left: 12, bottom: 12, width: 260, maxHeight: 260, overflowY: 'auto',
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
