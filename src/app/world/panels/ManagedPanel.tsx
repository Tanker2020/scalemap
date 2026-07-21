// src/app/world/panels/ManagedPanel.tsx
// Managed-service authoring — the cloud-managed appliances (SQL/NoSQL DB, object store, queue,
// redis, CDN, API gateway, lambda), each scoped to a region or AZ.
//
// node-model Phase 5 lifted this surface OUT of the retired PlacementPanel into its own world tab.
// The typed node palette (`az/paletteEntries.ts`) deliberately offers only compute hosts +
// self-managed DB appliances — Phase 1's decision that managed services are "typed cost/routing
// terminals, not hosts", so they are NOT droppable floor nodes. That left managed-service authoring
// with no home once Placements/Blueprints were removed; this panel is that home. Every dispatch
// (addManagedService / updateManagedService / removeManagedService) is byte-for-byte identical to
// PlacementPanel's old managed-services section — only the surrounding placement/blueprint CRUD was
// dropped (services are now authored via the VPS door + Connections tab).
//
// managed-service-modal plan (Task 4): the old inline "+ Add" 3-select row + ~12 per-row config
// fields (instance class, replicas, multi-AZ, capacity mode, pricing, max connections, query
// timeout, replica locality, promotion tier, capacity rps, storage GB, storage tier) are gone.
// Every managed service is now authored/edited through `ManagedServiceModal` (Task 3); each row
// here is a read-only summary + an `edit` button. `MANAGED_TYPES`/`PROVIDERS`/`STORAGE_CAPABLE`
// now live in `managedDraft.ts` (Task 1) — this file imports them instead of defining its own.
import { useState, type CSSProperties } from 'react'
import { useWorldStore } from '../../store/world.store'
import type { ManagedService, WorldDoc } from '../../../lib/world/types'
import { managedDbEngine } from '../../../lib/world/types'
import { PROVIDERS, STORAGE_CAPABLE } from '../../../lib/world/managedDraft'
import { getDbInstanceClass } from '../../../lib/dbInstanceClasses'
import { MANAGED_DEFAULT_CAPACITY_RPS } from '../../../lib/managedCapacity'
import { EdgeRow } from '../ui/kit'
import { sectionLabel, smallBtn, dangerBtn } from './panelStyles'
import { ManagedServiceModal } from './ManagedServiceModal'

// Styled like ConnectionsPanel.tsx's "open graph ↗" header action (lines 40-44/78-83) — same
// visual language for a header-level CTA button, different label.
const actionBtn: CSSProperties = {
  font: '10px var(--font-mono)', background: 'var(--color-node-base)',
  border: '1px solid var(--color-node-border)', borderRadius: 5, padding: '4px 12px',
  color: 'var(--color-text-secondary)', cursor: 'pointer',
}

function scopeLabel(doc: WorldDoc, ms: ManagedService): string {
  if (ms.scope.kind === 'region') {
    const r = doc.regions[ms.scope.regionId]
    return r ? `region ${r.catalogId}` : 'region'
  }
  const a = doc.azs[ms.scope.azId]
  return a ? `az ${a.label}` : 'az'
}

function providerLabel(provider: ManagedService['provider']): string {
  return PROVIDERS.find(p => p.key === provider)?.label ?? provider
}

// The one muted summary line per row: scope · provider, then type-specific facts (reusing the
// same lookups the old inline pickers used — getDbInstanceClass, MANAGED_DEFAULT_CAPACITY_RPS —
// rather than re-deriving display strings from scratch).
function summaryLine(doc: WorldDoc, ms: ManagedService): string {
  const parts: string[] = [scopeLabel(doc, ms), providerLabel(ms.provider)]
  const engine = managedDbEngine(ms.nodeType)
  if (engine) {
    const cls = getDbInstanceClass(ms.instanceClassId)
    const replicas = ms.replicaCount ?? 0
    parts.push(cls?.label ?? ms.instanceClassId ?? '—')
    parts.push(`${replicas} replica${replicas === 1 ? '' : 's'}`)
    parts.push(ms.multiAz ? 'multi-AZ' : 'single-AZ')
    parts.push((ms.capacityMode ?? 'provisioned') === 'serverless' ? 'serverless' : 'provisioned')
  } else {
    const rps = ms.capacityRps ?? MANAGED_DEFAULT_CAPACITY_RPS[ms.nodeType]
    parts.push(`${rps ?? '∞'} rps`)
  }
  if (STORAGE_CAPABLE.has(ms.nodeType)) {
    parts.push(`${ms.storageGb ?? 0} GB`)
  }
  return parts.join(' · ')
}

export function ManagedPanel() {
  const doc = useWorldStore(s => s.doc)
  const managed = Object.values(doc.managedServices)
  const [modalState, setModalState] = useState<{ id: string | null } | null>(null)

  // Retained only to keep the empty-state message's two variants (below) distinguishable, exactly
  // as before.
  const scopeOptions = [
    ...Object.values(doc.regions),
    ...Object.values(doc.azs),
  ]

  return (
    <div>
      <div style={sectionLabel}>Managed services</div>
      <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 6 }}>
        Cloud-managed appliances — no hardware, scoped to a region or AZ. Self-hosted databases are
        dropped from the AZ floor palette instead.
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <button type="button" className="kit-press" style={actionBtn} onClick={() => setModalState({ id: null })}>
          + add service
        </button>
      </div>
      {managed.length === 0 && (
        <div style={{ color: 'var(--color-text-muted)', marginTop: 10 }}>
          {scopeOptions.length === 0 ? 'add a region or AZ first' : 'no managed services yet'}
        </div>
      )}
      {managed.map(ms => (
        <ManagedServiceRow key={ms.id} ms={ms} doc={doc} onEdit={id => setModalState({ id })} />
      ))}
      <ManagedServiceModal
        open={modalState !== null}
        editingId={modalState?.id ?? null}
        onClose={() => setModalState(null)}
      />
    </div>
  )
}

// A managed-service row: label + port, one muted summary line, and edit/remove actions. Only the
// explicit `edit` button opens the editor — the row itself is NOT clickable (the original task
// brief for this component called for "an explicit edit button (rather than making the whole row
// clickable)" specifically because `EdgeRow` renders a plain, non-interactive `<div>` with no
// role/tabIndex, a mouse-only affordance concern).
//
// stopPropagation() on both `edit` and `×` is retained defensively: `trailing` renders inside
// EdgeRow's outer container, so if a future change ever puts an onClick back on that container,
// these two inner buttons won't silently double-fire against it.
function ManagedServiceRow({ ms, doc, onEdit }: { ms: ManagedService; doc: WorldDoc; onEdit: (id: string) => void }) {
  const store = useWorldStore.getState()
  return (
    <EdgeRow
      trailing={
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            className="kit-press" style={smallBtn} aria-label={`edit-${ms.id}`}
            onClick={e => { e.stopPropagation(); onEdit(ms.id) }}
          >
            edit
          </button>
          <button
            className="kit-press" style={dangerBtn} aria-label={`remove-${ms.id}`}
            onClick={e => { e.stopPropagation(); store.removeManagedService(ms.id) }}
          >
            ×
          </button>
        </div>
      }
    >
      <div>{ms.label} <span style={{ color: 'var(--color-text-muted)' }}>:{ms.port}</span></div>
      <div data-testid={`ms-summary-${ms.id}`} style={{ color: 'var(--color-text-muted)', fontSize: 9.5, marginTop: 2 }}>
        {summaryLine(doc, ms)}
      </div>
    </EdgeRow>
  )
}
