import type { CSSProperties } from 'react'
import { useNavStore } from '../store/nav.store'
import { useWorldStore } from '../store/world.store'

const seg: CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px',
  font: '500 12px var(--font-mono)', color: 'var(--color-text-secondary)',
}
const current: CSSProperties = { ...seg, cursor: 'default', color: 'var(--color-text-primary)' }
const sep = <span style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>›</span>

export function Breadcrumb() {
  const nav = useNavStore()
  const doc = useWorldStore(s => s.doc)

  const region = nav.regionId ? doc.regions[nav.regionId] : null
  const az = nav.azId ? doc.azs[nav.azId] : null
  const server = nav.serverId ? doc.servers[nav.serverId] : null

  const parts: { label: string; onClick: (() => void) | null }[] = [
    { label: 'World', onClick: nav.level === 'globe' ? null : () => nav.goGlobe() },
  ]
  if (region) parts.push({
    label: region.catalogId,
    onClick: nav.level === 'region' ? null : () => nav.goRegion(region.id),
  })
  if (az) parts.push({
    label: az.label,
    onClick: nav.level === 'az' ? null : () => nav.goAz(az.regionId, az.id),
  })
  if (server) parts.push({ label: server.label, onClick: null })

  return (
    <nav style={{ display: 'flex', alignItems: 'center', gap: 4 }} aria-label="World navigation">
      {parts.map((p, i) => (
        <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {i > 0 && sep}
          {p.onClick
            ? <button style={seg} onClick={p.onClick}>{p.label}</button>
            : <span style={current}>{p.label}</span>}
        </span>
      ))}
    </nav>
  )
}
