// src/app/world/GlobeCards.tsx
// The pre-Phase-5 Level-1 card grid, extracted verbatim from the old GlobeView.tsx (only the
// export name changed). Survives as the WebGL-unavailable fallback AND as the visual reference
// screen readers effectively see (the canvas itself is aria-hidden — see GlobeView.tsx's hidden
// a11y region list, which is the REAL navigation surface in both branches; this component is
// just the sighted-fallback visual).
import type { CSSProperties } from 'react'
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { useSimulationStore } from '../store/simulation.store'
import { useCompiledWorld } from './useCompiledWorld'
import { WORLD_REGIONS } from '../../lib/regionConfig'

const card: CSSProperties = {
  background: 'var(--color-surface)', border: '1px solid var(--color-node-border)',
  borderRadius: 10, padding: 14, cursor: 'pointer', textAlign: 'left',
  font: '12px var(--font-mono)', color: 'var(--color-text-primary)',
}

const HEALTH_COLOR = { healthy: 'var(--color-success)', degraded: 'var(--color-warning)', down: 'var(--color-danger)' } as const

export function GlobeCards() {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const goRegion = useNavStore(s => s.goRegion)
  const latestBatch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const regions = Object.values(doc.regions)

  return (
    <div style={{ padding: 24 }}>
      <div style={{ font: '600 14px var(--font-mono)', color: 'var(--color-text-primary)', marginBottom: 4 }}>
        World — {regions.length} region{regions.length === 1 ? '' : 's'} · {Object.keys(compiled.instances).length} service instances
      </div>
      <div style={{ font: '11px var(--font-mono)', color: 'var(--color-text-muted)', marginBottom: 16 }}>
        {compiled.findings.length > 0
          ? `${compiled.findings.length} finding(s) — see the World panel`
          : 'no findings'}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
        {regions.map(r => {
          const azs = Object.values(doc.azs).filter(a => a.regionId === r.id)
          const serverCount = Object.values(doc.servers).filter(s => azs.some(a => a.id === s.azId)).length
          const label = WORLD_REGIONS.find(w => w.id === r.catalogId)?.label ?? r.catalogId
          return (
            <button key={r.id} style={card} onClick={() => goRegion(r.id)}>
              <div style={{ fontWeight: 600 }}>{r.catalogId}</div>
              <div style={{ color: 'var(--color-text-secondary)', marginTop: 2 }}>{label}</div>
              <div style={{ color: 'var(--color-text-muted)', marginTop: 8 }}>
                {azs.length} AZ · {serverCount} server{serverCount === 1 ? '' : 's'} · {r.role}
              </div>
              {latestBatch?.regions[r.id] && (
                <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                  <span style={{ color: HEALTH_COLOR[latestBatch.regions[r.id].health] }}>● {latestBatch.regions[r.id].health}</span>
                  <span style={{ color: 'var(--color-text-secondary)' }}>{latestBatch.regions[r.id].rps.toFixed(0)} rps</span>
                  <span style={{ color: 'var(--color-text-secondary)' }}>{(latestBatch.regions[r.id].errorRate * 100).toFixed(1)}% err</span>
                </div>
              )}
            </button>
          )
        })}
        {regions.length === 0 && (
          <div style={{ color: 'var(--color-text-muted)', font: '12px var(--font-mono)' }}>
            No regions yet — add one in the World panel →
          </div>
        )}
      </div>
    </div>
  )
}
