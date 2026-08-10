import type { CSSProperties } from 'react'
import { useNavStore } from '../store/nav.store'
import { useWorldStore } from '../store/world.store'

const seg: CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px',
  font: '500 12px var(--font-mono)', color: 'var(--color-text-secondary)',
}
const current: CSSProperties = { ...seg, cursor: 'default', color: 'var(--color-text-primary)' }
const sep = <span style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>›</span>

// Comparison environments (Wave 5): a small chip next to the World segment when
// `doc.activeEnvironmentId` resolves to an entry. Deliberately loud — `var(--color-warning)` on
// EVERY named environment (there's no "production" id to special-case as safe; any active
// overlay is a deviation from the base world) — the spec's explicit concern is mistaking a
// scaled-down staging view for production, so this must never blend into a neutral breadcrumb.
const envChip: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 4, padding: '2px 6px', borderRadius: 3,
  border: '1px solid var(--color-warning)', color: 'var(--color-warning)',
  font: '600 11px var(--font-mono)', marginLeft: 2,
}

export function Breadcrumb() {
  const nav = useNavStore()
  const doc = useWorldStore(s => s.doc)

  const region = nav.regionId ? doc.regions[nav.regionId] : null
  const az = nav.azId ? doc.azs[nav.azId] : null
  const server = nav.serverId ? doc.servers[nav.serverId] : null
  const activeEnvironment = doc.activeEnvironmentId ? doc.environments?.[doc.activeEnvironmentId] : null

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
      {activeEnvironment && (
        <span data-testid="env-chip" style={envChip} title="Active comparison environment">
          ▸ {activeEnvironment.label}
        </span>
      )}
    </nav>
  )
}
