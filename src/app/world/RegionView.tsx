// Phase-1 placeholder for the Level-2 region flow page (real design lands in Phase 4).
import type { CSSProperties } from 'react'
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { useSimulationStore } from '../store/simulation.store'
import { useCompiledWorld } from './useCompiledWorld'

const card: CSSProperties = {
  background: 'var(--color-surface)', border: '1px solid var(--color-node-border)',
  borderRadius: 10, padding: 14, cursor: 'pointer', textAlign: 'left',
  font: '12px var(--font-mono)', color: 'var(--color-text-primary)',
}

const HEALTH_COLOR = { healthy: 'var(--color-success)', degraded: 'var(--color-warning)', down: 'var(--color-danger)' } as const

export function RegionView() {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const { regionId, goAz } = useNavStore()
  const latestBatch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const running = useSimulationStore(s => s.running)
  const isDown = useSimulationStore(s => s.healthOverrides[regionId ?? ''] ?? false)
  const setOutage = useSimulationStore(s => s.setOutage)
  if (!regionId || !doc.regions[regionId]) return null
  const azs = Object.values(doc.azs).filter(a => a.regionId === regionId)

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div style={{ font: '600 14px var(--font-mono)', color: 'var(--color-text-primary)' }}>
          {doc.regions[regionId].catalogId} — {azs.length} availability zone{azs.length === 1 ? '' : 's'}
        </div>
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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
        {azs.map(az => {
          const servers = Object.values(doc.servers).filter(s => s.azId === az.id)
          const instanceCount = Object.values(compiled.instances).filter(i => i.azId === az.id).length
          return (
            <button key={az.id} style={card} onClick={() => goAz(regionId, az.id)}>
              <div style={{ fontWeight: 600 }}>{az.label}</div>
              <div style={{ color: 'var(--color-text-muted)', marginTop: 8 }}>
                {servers.length} server{servers.length === 1 ? '' : 's'} · {instanceCount} instance{instanceCount === 1 ? '' : 's'}
              </div>
              {latestBatch?.azs[az.id] && (
                <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                  <span style={{ color: HEALTH_COLOR[latestBatch.azs[az.id].health] }}>● {latestBatch.azs[az.id].health}</span>
                  <span style={{ color: 'var(--color-text-secondary)' }}>{latestBatch.azs[az.id].rps.toFixed(0)} rps</span>
                  <span style={{ color: 'var(--color-text-secondary)' }}>{(latestBatch.azs[az.id].errorRate * 100).toFixed(1)}% err</span>
                </div>
              )}
            </button>
          )
        })}
        {azs.length === 0 && (
          <div style={{ color: 'var(--color-text-muted)', font: '12px var(--font-mono)' }}>
            No AZs yet — add one in the World panel →
          </div>
        )}
      </div>
    </div>
  )
}
