// Phase-1 placeholder for the Level-2 region flow page (real design lands in Phase 4).
import type { CSSProperties } from 'react'
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { useCompiledWorld } from './useCompiledWorld'

const card: CSSProperties = {
  background: 'var(--color-surface)', border: '1px solid var(--color-node-border)',
  borderRadius: 10, padding: 14, cursor: 'pointer', textAlign: 'left',
  font: '12px var(--font-mono)', color: 'var(--color-text-primary)',
}

export function RegionView() {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const { regionId, goAz } = useNavStore()
  if (!regionId || !doc.regions[regionId]) return null
  const azs = Object.values(doc.azs).filter(a => a.regionId === regionId)

  return (
    <div style={{ padding: 24 }}>
      <div style={{ font: '600 14px var(--font-mono)', color: 'var(--color-text-primary)', marginBottom: 16 }}>
        {doc.regions[regionId].catalogId} — {azs.length} availability zone{azs.length === 1 ? '' : 's'}
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
