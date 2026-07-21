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
import { useState } from 'react'
import { useWorldStore } from '../../store/world.store'
import type { ManagedService } from '../../../lib/world/types'
import { managedDbEngine } from '../../../lib/world/types'
import type { ManagedCapacityMode, ManagedPricingCommitment, ReplicaLocality } from '../../../lib/world/types'
import { DB_INSTANCE_CLASSES, getDbInstanceClass } from '../../../lib/dbInstanceClasses'
import { MANAGED_DEFAULT_CAPACITY_RPS } from '../../../lib/managedCapacity'
import { getServiceSpec, type StorageTier } from '../../../lib/cloudRegistry'

// Types with provisioned storage that drives $/GB-month pricing + the egress free allowance.
const STORAGE_CAPABLE = new Set(['objectStorage', 'fileStorage', 'dbSql', 'dbNoSql'])
import { EdgeRow } from '../ui/kit'
import { sectionLabel, field, smallBtn, dangerBtn, row } from './panelStyles'

// Author managed services with CLOUD_REGISTRY keys directly (D12) so Cost v2 prices them without
// the alias table. Labels stay human-readable.
const MANAGED_TYPES: { key: string; label: string; port: number }[] = [
  { key: 'dbSql', label: 'SQL DB', port: 5432 },
  { key: 'dbNoSql', label: 'NoSQL DB', port: 27017 },
  { key: 'objectStorage', label: 'Object store', port: 443 },
  { key: 'queue', label: 'Queue', port: 5672 },
  { key: 'redis', label: 'Redis', port: 6379 },
  { key: 'cdn', label: 'CDN', port: 443 },
  { key: 'apiGateway', label: 'API Gateway', port: 443 },
  { key: 'lambda', label: 'Lambda', port: 443 },
]

// The authoring UI defaults to 'aws' (not the store's 'generic' default) so a freshly added managed
// service prices non-zero immediately — see world.store.ts's addManagedService, whose own default
// stays 'generic' for callers that omit the param.
const PROVIDERS: { key: ManagedService['provider']; label: string }[] = [
  { key: 'aws', label: 'AWS' },
  { key: 'gcp', label: 'GCP' },
  { key: 'azure', label: 'Azure' },
  { key: 'generic', label: 'Generic' },
]

export function ManagedPanel() {
  const doc = useWorldStore(s => s.doc)
  const store = useWorldStore.getState()
  const [msType, setMsType] = useState(MANAGED_TYPES[0].key)
  const [msScope, setMsScope] = useState('')
  const [msProvider, setMsProvider] = useState<ManagedService['provider']>('aws')

  const scopeOptions = [
    ...Object.values(doc.regions).map(r => ({ key: `region:${r.id}`, label: `region ${r.catalogId}` })),
    ...Object.values(doc.azs).map(a => ({ key: `az:${a.id}`, label: `az ${a.label}` })),
  ]

  const managed = Object.values(doc.managedServices)

  const add = () => {
    const [kind, id] = msScope.split(':')
    const type = MANAGED_TYPES.find(t => t.key === msType)
    store.addManagedService(
      msType, type?.label ?? msType,
      kind === 'region' ? { kind: 'region', regionId: id } : { kind: 'az', azId: id },
      type?.port ?? 443, msProvider,
    )
  }

  return (
    <div>
      <div style={sectionLabel}>Managed services</div>
      <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 6 }}>
        Cloud-managed appliances — no hardware, scoped to a region or AZ. Self-hosted databases are
        dropped from the AZ floor palette instead.
      </div>
      <div style={row}>
        <select aria-label="managed type" style={{ ...field, flex: 1, marginBottom: 0 }} value={msType} onChange={e => setMsType(e.target.value)}>
          {MANAGED_TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <select aria-label="managed scope" style={{ ...field, flex: 1, marginBottom: 0 }} value={msScope} onChange={e => setMsScope(e.target.value)}>
          <option value="">scope…</option>
          {scopeOptions.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        <select style={{ ...field, width: 74, marginBottom: 0 }} aria-label="provider" value={msProvider}
          onChange={e => setMsProvider(e.target.value as ManagedService['provider'])}>
          {PROVIDERS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        <button className="kit-press" style={smallBtn} disabled={!msScope} onClick={add}>+ Add</button>
      </div>
      {managed.length === 0 && (
        <div style={{ color: 'var(--color-text-muted)', marginTop: 10 }}>
          {scopeOptions.length === 0 ? 'add a region or AZ first' : 'no managed services yet'}
        </div>
      )}
      {managed.map(ms => <ManagedServiceRow key={ms.id} ms={ms} />)}
    </div>
  )
}

// A managed-service row. For a cloud DB (node-model Phase 3) it also exposes the instance-class
// picker + read-replica count that drive the write ceiling and pricing; other managed services
// keep the plain label + delete.
function ManagedServiceRow({ ms }: { ms: ManagedService }) {
  const store = useWorldStore.getState()
  const engine = managedDbEngine(ms.nodeType)
  const classes = engine ? DB_INSTANCE_CLASSES.filter(c => c.engine === engine) : []
  const storageComponent = getServiceSpec(ms.nodeType, ms.provider)?.pricing.find(c => c.kind === 'storageGbMonth')
  const storageTiers: StorageTier[] = storageComponent?.kind === 'storageGbMonth' ? storageComponent.tiers : []
  return (
    <EdgeRow trailing={<button className="kit-press" style={dangerBtn} onClick={() => store.removeManagedService(ms.id)}>×</button>}>
      <div>{ms.label} <span style={{ color: 'var(--color-text-muted)' }}>:{ms.port}</span></div>
      {engine && (
        <div style={{ ...row, marginTop: 4 }}>
          <select
            aria-label={`db-class-${ms.id}`} style={{ ...field, flex: 1, marginBottom: 0 }}
            value={ms.instanceClassId ?? ''}
            onChange={e => store.updateManagedService(ms.id, { instanceClassId: e.target.value })}
          >
            {classes.map(c => <option key={c.id} value={c.id}>{c.label} · {c.writeRps} w/s</option>)}
          </select>
          <input
            aria-label={`db-replicas-${ms.id}`} type="number" min={0} style={{ ...field, width: 52, marginBottom: 0 }}
            value={ms.replicaCount ?? 0}
            onChange={e => store.updateManagedService(ms.id, { replicaCount: Math.max(0, Number(e.target.value)) })}
          />
          <span style={{ color: 'var(--color-text-muted)', fontSize: 9.5, alignSelf: 'center' }}>replicas</span>
          {/* Multi-AZ standby (node-model Phase 5.3): a failover standby — cost only, no added
              capacity — already priced in costModelV2 but previously unauthored. */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 3, color: 'var(--color-text-muted)', fontSize: 9.5, alignSelf: 'center', marginLeft: 4 }}>
            <input
              type="checkbox" aria-label={`db-multiaz-${ms.id}`} checked={ms.multiAz ?? false}
              onChange={e => store.updateManagedService(ms.id, { multiAz: e.target.checked })}
            />
            multi-AZ
          </label>
        </div>
      )}
      {/* Stress-test knobs (node-model Phase 5.4). Each one changes what the sim DOES: capacity
          mode moves the ceiling and the bill's shape, the timeout makes the DB fail BELOW its rps
          ceiling, connections add a second saturation axis, locality taxes read latency, and the
          promotion tier sets how fast a multi-AZ standby takes over. */}
      {engine && (
        <div style={{ ...row, marginTop: 4, flexWrap: 'wrap' }}>
          <select
            aria-label={`db-capacity-mode-${ms.id}`} style={{ ...field, width: 96, marginBottom: 0 }}
            value={ms.capacityMode ?? 'provisioned'}
            onChange={e => store.updateManagedService(ms.id, { capacityMode: e.target.value as ManagedCapacityMode })}
          >
            <option value="provisioned">provisioned</option>
            <option value="serverless">serverless</option>
          </select>
          <select
            aria-label={`db-pricing-${ms.id}`} style={{ ...field, width: 92, marginBottom: 0 }}
            value={ms.pricing ?? 'onDemand'}
            onChange={e => store.updateManagedService(ms.id, { pricing: e.target.value as ManagedPricingCommitment })}
            // A serverless DB has no provisioned capacity to commit to, so the discount can't apply.
            disabled={ms.capacityMode === 'serverless'}
            title={ms.capacityMode === 'serverless' ? 'serverless has no commitment term' : 'commitment term'}
          >
            <option value="onDemand">on-demand</option>
            <option value="reserved1yr">reserved 1yr</option>
            <option value="reserved3yr">reserved 3yr</option>
          </select>
          <input
            aria-label={`db-max-connections-${ms.id}`} type="number" min={1} style={{ ...field, width: 62, marginBottom: 0 }}
            placeholder={`${getDbInstanceClass(ms.instanceClassId)?.maxConnections ?? '—'}`}
            value={ms.maxConnections ?? ''}
            onChange={e => store.updateManagedService(ms.id, { maxConnections: e.target.value === '' ? undefined : Math.max(1, Number(e.target.value)) })}
          />
          <span style={{ color: 'var(--color-text-muted)', fontSize: 9.5, alignSelf: 'center' }}>conns</span>
          <input
            aria-label={`db-query-timeout-${ms.id}`} type="number" min={1} style={{ ...field, width: 62, marginBottom: 0 }}
            placeholder="none"
            value={ms.queryTimeoutMs ?? ''}
            onChange={e => store.updateManagedService(ms.id, { queryTimeoutMs: e.target.value === '' ? undefined : Math.max(1, Number(e.target.value)) })}
          />
          <span style={{ color: 'var(--color-text-muted)', fontSize: 9.5, alignSelf: 'center' }}>ms timeout</span>
          <select
            aria-label={`db-replica-locality-${ms.id}`} style={{ ...field, width: 104, marginBottom: 0 }}
            value={ms.replicaLocality ?? 'sameAz'}
            onChange={e => store.updateManagedService(ms.id, { replicaLocality: e.target.value as ReplicaLocality })}
          >
            <option value="sameAz">replicas same-AZ</option>
            <option value="multiAz">replicas multi-AZ</option>
            <option value="crossRegion">replicas cross-rgn</option>
          </select>
          <input
            aria-label={`db-promotion-tier-${ms.id}`} type="number" min={0} style={{ ...field, width: 48, marginBottom: 0 }}
            placeholder="0"
            value={ms.promotionTier ?? ''}
            onChange={e => store.updateManagedService(ms.id, { promotionTier: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)) })}
          />
          <span style={{ color: 'var(--color-text-muted)', fontSize: 9.5, alignSelf: 'center' }}>tier</span>
        </div>
      )}
      {/* Non-DB throughput ceiling (node-model Phase 5.2): a DB's ceiling is its instance class, but
          every other type gets a flat rps capacity — default per type, overridable here. */}
      {!engine && (
        <div style={{ ...row, marginTop: 4 }}>
          <input
            aria-label={`capacity-${ms.id}`} type="number" min={0} style={{ ...field, width: 90, marginBottom: 0 }}
            placeholder={`${MANAGED_DEFAULT_CAPACITY_RPS[ms.nodeType] ?? '∞'}`}
            value={ms.capacityRps ?? ''}
            onChange={e => store.updateManagedService(ms.id, { capacityRps: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)) })}
          />
          <span style={{ color: 'var(--color-text-muted)', fontSize: 9.5, alignSelf: 'center' }}>rps capacity</span>
        </div>
      )}
      {/* Provisioned storage (node-model Phase 5.2): drives $/GB-month pricing and — via the
          provider's free-egress-per-stored grant — the egress free allowance. */}
      {STORAGE_CAPABLE.has(ms.nodeType) && (
        <div style={{ ...row, marginTop: 4 }}>
          <input
            aria-label={`storage-gb-${ms.id}`} type="number" min={0} style={{ ...field, width: 80, marginBottom: 0 }}
            placeholder="GB stored"
            value={ms.storageGb ?? ''}
            onChange={e => store.updateManagedService(ms.id, { storageGb: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)) })}
          />
          <span style={{ color: 'var(--color-text-muted)', fontSize: 9.5, alignSelf: 'center' }}>GB</span>
          {storageTiers.length > 1 && (
            <select
              aria-label={`storage-tier-${ms.id}`} style={{ ...field, flex: 1, marginBottom: 0 }}
              value={ms.storageTierId ?? storageTiers[0].id}
              onChange={e => store.updateManagedService(ms.id, { storageTierId: e.target.value })}
            >
              {storageTiers.map(t => <option key={t.id} value={t.id}>{t.label} · ${t.storageGbMonth}/GB</option>)}
            </select>
          )}
        </div>
      )}
    </EdgeRow>
  )
}
