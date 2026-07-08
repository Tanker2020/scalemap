// Phase-1 placeholder for the Level-1 globe (real three.js globe lands in Phase 5).
import type { CSSProperties } from 'react'
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { useCompiledWorld } from './useCompiledWorld'
import { WORLD_REGIONS } from '../../lib/regionConfig'

const card: CSSProperties = {
  background: 'var(--color-surface)', border: '1px solid var(--color-node-border)',
  borderRadius: 10, padding: 14, cursor: 'pointer', textAlign: 'left',
  font: '12px var(--font-mono)', color: 'var(--color-text-primary)',
}

export function GlobeView() {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const goRegion = useNavStore(s => s.goRegion)
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
