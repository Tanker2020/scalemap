// src/app/world/panels/ManagedServiceModal.tsx
// Add/edit modal for cloud-managed services (plan: managed-service-modal, Task 3).
//
// Replaces the old cramped inline "+ Add" row + 12 per-row config fields on ManagedPanel.tsx
// (Task 4 wires this in) with one modal where every field gets a real <label> plus a consequence
// hint explaining what it DOES. Draft + Create/Save/Cancel semantics: nothing touches the store
// until confirmed — one dispatch, one undo entry either way. Shell is SettingsModal.tsx's pattern
// copied verbatim (portal, backdrop, capture-phase Escape) with two deltas: a wider/taller
// scrollable surface (a DB-type service renders 6 sections), and its own re-init effect that
// snapshots the store once per open rather than subscribing live.
//
// Edit-lock: createPortal renders this modal's DOM under document.body, OUTSIDE the React tree
// that holds WorldPanel.tsx's dock-wide `<fieldset disabled={running}>` — that fieldset never
// reaches here, so the field SECTIONS below get their own `<fieldset disabled={running}>` wrapper.
// Close/Cancel/submit stay outside it so there is always a way out while running.
import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { managedDbEngine, type ManagedCapacityMode, type ManagedPricingCommitment, type ReplicaLocality } from '../../../lib/world/types'
import {
  MANAGED_TYPES, PROVIDERS, STORAGE_CAPABLE, CACHE_MANAGED_TYPES,
  defaultManagedDraft, draftFromService, draftToConfig,
  applyNodeTypeChange, applyProviderChange, scopeFromKey,
  type ManagedDraft,
} from '../../../lib/world/managedDraft'
import { DB_INSTANCE_CLASSES, getDbInstanceClass } from '../../../lib/dbInstanceClasses'
import { MANAGED_DEFAULT_CAPACITY_RPS } from '../../../lib/managedCapacity'
import { getServiceSpec } from '../../../lib/cloudRegistry'
import { SectionHeader, Segmented, Explainer, DerivedField } from '../ui/kit'

export interface ManagedServiceModalProps {
  open: boolean
  editingId: string | null
  onClose: () => void
}

const backdropStyle: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
}
const surfaceStyle: CSSProperties = {
  width: 520, maxWidth: '92vw', maxHeight: '88vh', overflowY: 'auto',
  background: 'var(--color-surface)',
  border: '1px solid var(--color-node-border)', borderRadius: 8, padding: 16,
  font: '11px var(--font-mono)', color: 'var(--color-text-primary)',
}
const field: CSSProperties = {
  font: '10px var(--font-mono)', background: 'var(--color-node-base)',
  border: '1px solid var(--color-node-border)', borderRadius: 4,
  padding: '3px 6px', color: 'var(--color-text-primary)', width: '100%', boxSizing: 'border-box',
}
const btn: CSSProperties = {
  font: '10px var(--font-mono)', background: 'var(--color-node-base)',
  border: '1px solid var(--color-node-border)', borderRadius: 4, padding: '4px 10px',
  color: 'var(--color-text-secondary)', cursor: 'pointer',
}
const btnLocked: CSSProperties = { ...btn, opacity: 0.35, cursor: 'default' }
const rowLabel: CSSProperties = { color: 'var(--color-text-muted)', display: 'block', marginBottom: 2 }
const rowGap: CSSProperties = { marginBottom: 7 }
const smallBtnStyle: CSSProperties = {
  background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
  borderRadius: 4, padding: '4px 10px', cursor: 'pointer',
  font: '11px var(--font-mono)', color: 'var(--color-text-secondary)',
}
const priceSpan: CSSProperties = { color: 'var(--color-price)', fontSize: 10.5, marginTop: 4, display: 'block' }

export function ManagedServiceModal({ open, editingId, onClose }: ManagedServiceModalProps): ReactElement | null {
  const running = useSimulationStore(s => s.running)
  // Live subscription: the scope select's option list should track whatever regions/AZs exist
  // right now — unlike the draft itself (see the effect below), this is not the user's local edit.
  const doc = useWorldStore(s => s.doc)

  const [draft, setDraft] = useState<ManagedDraft>(() => defaultManagedDraft())

  // Re-initialize the draft on every open from a ONE-TIME snapshot — NOT a live subscription. The
  // draft is what the user is editing locally; it must not be clobbered by a store change
  // happening elsewhere while the modal is open.
  useEffect(() => {
    if (!open) return
    const snapshot = useWorldStore.getState()
    const existing = editingId ? snapshot.doc.managedServices[editingId] : undefined
    setDraft(existing ? draftFromService(existing) : defaultManagedDraft())
  }, [open, editingId])

  // Capture-phase Esc: fires BEFORE WorldShell's bubble-phase Escape-goes-up handler (same
  // mechanism ServerView.tsx/SettingsModal.tsx already use — capture always precedes bubble for a
  // `window` listener regardless of mount order). stopPropagation halts the event's entire
  // remaining traversal, including its own return trip through window's bubble phase, so
  // WorldShell's handler never runs for this keydown at all; preventDefault is belt-and-suspenders
  // in case that return trip somehow still occurs (WorldShell's handler also bails on
  // defaultPrevented).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true) // CAPTURE
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open) return null

  const engine = managedDbEngine(draft.nodeType)
  const isDb = engine !== null
  const isStorageCapable = STORAGE_CAPABLE.has(draft.nodeType)
  const isCache = CACHE_MANAGED_TYPES.has(draft.nodeType)
  const instanceClasses = engine ? DB_INSTANCE_CLASSES.filter(c => c.engine === engine) : []
  const selectedClass = getDbInstanceClass(draft.instanceClassId)
  const storageComponent = getServiceSpec(draft.nodeType, draft.provider)?.pricing.find(c => c.kind === 'storageGbMonth')
  const storageTiers = storageComponent?.kind === 'storageGbMonth' ? storageComponent.tiers : []
  const selectedTier = storageTiers.find(t => t.id === (draft.storageTierId ?? storageTiers[0]?.id))

  const scopeOptions = [
    ...Object.values(doc.regions).map(r => ({ key: `region:${r.id}`, label: `region ${r.catalogId}` })),
    ...Object.values(doc.azs).map(a => ({ key: `az:${a.id}`, label: `az ${a.label}` })),
  ]

  const parsedScope = scopeFromKey(draft.scopeKey)
  const scopeValid = parsedScope !== null && (
    parsedScope.kind === 'region' ? !!doc.regions[parsedScope.id] : !!doc.azs[parsedScope.id]
  )
  const portValid = Number.isInteger(draft.port) && draft.port >= 1 && draft.port <= 65535
  const canSubmit = !running && draft.label.trim() !== '' && scopeValid && portValid

  const submit = (): void => {
    if (running) return
    if (!canSubmit) return
    // draftToConfig already resolves scopeKey -> ManagedScope and gates DB/storage/non-DB keys by
    // nodeType, so the identity fields (nodeType/label/port/provider/scope) it emits are reused
    // directly rather than re-derived here.
    const config = draftToConfig({ ...draft, label: draft.label.trim() })
    if (editingId) {
      useWorldStore.getState().updateManagedService(editingId, config)
    } else {
      useWorldStore.getState().addManagedService(
        config.nodeType!, config.label!, config.scope!, config.port!, draft.provider, config,
      )
    }
    onClose()
  }

  return createPortal(
    <div style={backdropStyle} onClick={onClose}>
      <div style={surfaceStyle} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ font: '600 12px var(--font-mono)' }}>
            {editingId ? 'Edit managed service' : 'Add managed service'}
          </span>
          <button style={smallBtnStyle} onClick={onClose}>close</button>
        </div>

        <fieldset disabled={running} style={{ border: 'none', margin: 0, padding: 0, minInlineSize: 0 }}>
          <SectionHeader label="▸ IDENTITY" />
          <div style={rowGap}>
            <label htmlFor="ms-type" style={rowLabel}>service type</label>
            <select
              id="ms-type" aria-label="service type" style={field} value={draft.nodeType}
              onChange={e => setDraft(d => applyNodeTypeChange(d, e.target.value))}
            >
              {MANAGED_TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 6, ...rowGap }}>
            <div style={{ flex: 1 }}>
              <label htmlFor="ms-name" style={rowLabel}>name</label>
              <input
                id="ms-name" aria-label="name" style={field} value={draft.label}
                onChange={e => setDraft(d => ({ ...d, label: e.target.value }))}
              />
            </div>
            <div style={{ flex: '0 0 90px' }}>
              <label htmlFor="ms-port" style={rowLabel}>port</label>
              <input
                id="ms-port" aria-label="port" type="number" style={field} value={draft.port}
                onChange={e => setDraft(d => ({ ...d, port: Number(e.target.value) }))}
              />
            </div>
          </div>

          <SectionHeader label="▸ PLACEMENT" />
          <div style={rowGap}>
            <label htmlFor="ms-scope" style={rowLabel}>scope</label>
            <select
              id="ms-scope" aria-label="scope" style={field} value={draft.scopeKey}
              onChange={e => setDraft(d => ({ ...d, scopeKey: e.target.value }))}
            >
              <option value="">scope…</option>
              {scopeOptions.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </div>
          <div style={rowGap}>
            <label style={rowLabel}>provider</label>
            <Segmented
              ariaLabel="provider" value={draft.provider}
              onChange={p => setDraft(d => applyProviderChange(d, p))}
              options={PROVIDERS.map(p => ({ value: p.key, label: p.label }))}
            />
          </div>

          <SectionHeader label="▸ CAPACITY" />
          {isDb ? (
            <>
              <div style={rowGap}>
                <label htmlFor="ms-instance-class" style={rowLabel}>instance class</label>
                <select
                  id="ms-instance-class" aria-label="instance class" style={field}
                  value={draft.instanceClassId ?? ''}
                  onChange={e => setDraft(d => ({ ...d, instanceClassId: e.target.value }))}
                >
                  {instanceClasses.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
                {selectedClass && (
                  <>
                    <Explainer>
                      {selectedClass.writeRps} writes/s · {selectedClass.readRps} reads/s · {selectedClass.maxConnections} connections
                    </Explainer>
                    <span style={priceSpan}>${selectedClass.hourlyUsd.toFixed(2)}/hr</span>
                  </>
                )}
              </div>
              <div style={rowGap}>
                <label style={rowLabel}>capacity mode</label>
                <Segmented
                  ariaLabel="capacity mode" value={draft.capacityMode ?? 'provisioned'}
                  onChange={(v: ManagedCapacityMode) => setDraft(d => ({ ...d, capacityMode: v }))}
                  options={[{ value: 'provisioned', label: 'provisioned' }, { value: 'serverless', label: 'serverless' }]}
                />
                {draft.capacityMode === 'serverless' && (
                  <Explainer>bursts past the class ceiling and prices per request</Explainer>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, ...rowGap }}>
                <div style={{ flex: 1 }}>
                  <label htmlFor="ms-max-conn" style={rowLabel}>max connections</label>
                  <input
                    id="ms-max-conn" aria-label="max connections" type="number" style={field}
                    placeholder={`${selectedClass?.maxConnections ?? '—'}`}
                    value={draft.maxConnections ?? ''}
                    onChange={e => setDraft(d => ({ ...d, maxConnections: e.target.value }))}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label htmlFor="ms-query-timeout" style={rowLabel}>query timeout (ms)</label>
                  <input
                    id="ms-query-timeout" aria-label="query timeout" type="number" style={field}
                    placeholder="none"
                    value={draft.queryTimeoutMs ?? ''}
                    onChange={e => setDraft(d => ({ ...d, queryTimeoutMs: e.target.value }))}
                  />
                </div>
              </div>
              <Explainer>connections ≈ rps × latency — a slow DB drowns here before it hits the rps ceiling</Explainer>
              <Explainer>queries slower than this error out — the DB can fail below its rps ceiling</Explainer>
            </>
          ) : (
            <div style={rowGap}>
              <label htmlFor="ms-capacity-rps" style={rowLabel}>throughput ceiling (rps)</label>
              <input
                id="ms-capacity-rps" aria-label="throughput ceiling" type="number" style={field}
                placeholder={`${MANAGED_DEFAULT_CAPACITY_RPS[draft.nodeType] ?? '∞'}`}
                value={draft.capacityRps ?? ''}
                onChange={e => setDraft(d => ({ ...d, capacityRps: e.target.value }))}
              />
            </div>
          )}

          {isDb && (
            <>
              <SectionHeader label="▸ REPLICAS & FAILOVER" />
              <div style={rowGap}>
                <DerivedField
                  label="read replicas" value={draft.replicaCount ?? 0} min={0}
                  onCommit={n => setDraft(d => ({ ...d, replicaCount: n }))}
                />
              </div>
              <div style={rowGap}>
                <label htmlFor="ms-replica-locality" style={rowLabel}>replica locality</label>
                <select
                  id="ms-replica-locality" aria-label="replica locality" style={field}
                  value={draft.replicaLocality ?? 'sameAz'}
                  onChange={e => setDraft(d => ({ ...d, replicaLocality: e.target.value as ReplicaLocality }))}
                >
                  <option value="sameAz">same-AZ</option>
                  <option value="multiAz">multi-AZ</option>
                  <option value="crossRegion">cross-region</option>
                </select>
              </div>
              <div style={rowGap}>
                <label htmlFor="ms-multiaz" style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--color-text-secondary)' }}>
                  <input
                    id="ms-multiaz" type="checkbox" aria-label="multi-AZ standby"
                    checked={draft.multiAz ?? false}
                    onChange={e => setDraft(d => ({ ...d, multiAz: e.target.checked }))}
                  />
                  multi-AZ standby
                </label>
                <Explainer>a failover standby: costs money, adds no read capacity</Explainer>
              </div>
              <div style={rowGap}>
                <label htmlFor="ms-promotion-tier" style={rowLabel}>promotion tier</label>
                <input
                  id="ms-promotion-tier" aria-label="promotion tier" type="number" style={field}
                  placeholder="0"
                  value={draft.promotionTier ?? ''}
                  onChange={e => setDraft(d => ({ ...d, promotionTier: e.target.value }))}
                />
              </div>
            </>
          )}

          {isStorageCapable && (
            <>
              <SectionHeader label="▸ STORAGE" />
              <div style={rowGap}>
                <DerivedField
                  label="provisioned GB" value={Number(draft.storageGb) || 0} min={0} unit="GB"
                  onCommit={n => setDraft(d => ({ ...d, storageGb: String(n) }))}
                />
              </div>
              {storageTiers.length > 1 && (
                <div style={rowGap}>
                  <label htmlFor="ms-storage-tier" style={rowLabel}>storage tier</label>
                  <select
                    id="ms-storage-tier" aria-label="storage tier" style={field}
                    value={draft.storageTierId ?? storageTiers[0].id}
                    onChange={e => setDraft(d => ({ ...d, storageTierId: e.target.value }))}
                  >
                    {storageTiers.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                  </select>
                  {selectedTier && <span style={priceSpan}>${selectedTier.storageGbMonth}/GB-month</span>}
                </div>
              )}
            </>
          )}

          {isCache && (
            <>
              <SectionHeader label="▸ CACHE" />
              <div style={{ display: 'flex', gap: 6, ...rowGap }}>
                <div style={{ flex: 1 }}>
                  <label htmlFor="ms-cache-hit" style={rowLabel}>hit ratio (0-1)</label>
                  <input
                    id="ms-cache-hit" aria-label="cache hit ratio" type="number" min={0} max={1} step={0.01} style={field}
                    value={draft.cacheHitRatio ?? ''}
                    onChange={e => setDraft(d => ({ ...d, cacheHitRatio: e.target.value }))}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label htmlFor="ms-cache-warmup" style={rowLabel}>warmup sec</label>
                  <input
                    id="ms-cache-warmup" aria-label="cache warmup seconds" type="number" min={0} style={field}
                    value={draft.cacheWarmupSec ?? ''}
                    onChange={e => setDraft(d => ({ ...d, cacheWarmupSec: e.target.value }))}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label htmlFor="ms-cache-ttl" style={rowLabel}>ttl sec</label>
                  <input
                    id="ms-cache-ttl" aria-label="cache ttl seconds" type="number" min={0} style={field}
                    value={draft.cacheTtlSec ?? ''}
                    onChange={e => setDraft(d => ({ ...d, cacheTtlSec: e.target.value }))}
                  />
                </div>
              </div>
              <Explainer>hit ratio is steady-state, reached gradually over warmup — a cold restart starts at 0% and climbs; ttl sets the ambient miss floor</Explainer>
            </>
          )}

          {isDb && (
            <>
              <SectionHeader label="▸ PRICING" />
              <div style={rowGap}>
                <label htmlFor="ms-pricing" style={rowLabel}>commitment term</label>
                <select
                  id="ms-pricing" aria-label="commitment term" style={field}
                  value={draft.pricing ?? 'onDemand'}
                  disabled={draft.capacityMode === 'serverless'}
                  title={draft.capacityMode === 'serverless' ? 'serverless has no commitment term' : undefined}
                  onChange={e => setDraft(d => ({ ...d, pricing: e.target.value as ManagedPricingCommitment }))}
                >
                  <option value="onDemand">on-demand</option>
                  <option value="reserved1yr">reserved 1yr</option>
                  <option value="reserved3yr">reserved 3yr</option>
                </select>
              </div>
            </>
          )}
        </fieldset>

        <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
          <button
            type="button" className="kit-press" style={canSubmit ? btn : btnLocked}
            disabled={!canSubmit}
            title={running ? 'stop the simulation to edit' : undefined}
            onClick={submit}
          >
            {editingId ? 'Save' : 'Create'}
          </button>
          <button type="button" className="kit-press" style={btn} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
