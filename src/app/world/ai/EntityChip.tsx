// Clickable citation chip — renders an entity id resolved from an assistant response as a
// button that navigates the world to it (region/AZ/server/instance), or a plain non-interactive
// label when the id resolves to something without a nav target (blueprint/placement/population/
// managed service — see entityNav.ts's navigateToEntity).
import type { CSSProperties } from 'react'
import { navigateToEntity, entityLabel } from '../entityNav'
import { useNavStore } from '../../store/nav.store'
import type { WorldDoc, CompiledWorld } from '../../../lib/world/types'

const chipStyle: CSSProperties = {
  font: '11px var(--font-mono)', color: 'var(--color-accent)', background: 'transparent',
  border: '1px solid var(--color-node-border)', borderRadius: 4, padding: '1px 6px',
  cursor: 'pointer', display: 'inline-block', margin: '0 2px',
}
const labelStyle: CSSProperties = { ...chipStyle, cursor: 'default', color: 'var(--color-text-secondary)' }

export function EntityChip({ id, doc, compiled, onNavigated }: {
  id: string; doc: WorldDoc; compiled: CompiledWorld; onNavigated: () => void
}) {
  const label = entityLabel(id, doc, compiled)
  const canNav = doc.regions[id] || doc.azs[id] || doc.servers[id] || compiled.instances[id]
  if (!canNav) return <span style={labelStyle}>{label}</span>
  return (
    <button
      style={chipStyle}
      title={id}
      onClick={() => { if (navigateToEntity(id, doc, compiled, useNavStore.getState())) onNavigated() }}
    >
      {label}
    </button>
  )
}
