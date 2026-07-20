// Placement authoring — where each blueprint runs (server/count/role/runtime) plus managed
// services. Hybrid instrument restyle (Polish 1 T3) — presentation only; every dispatch below
// is byte-for-byte identical to the pre-restyle panel (see .superpowers/sdd/task-3-brief.md).
import { useState } from 'react'
import { useWorldStore } from '../../store/world.store'
import type { ManagedService, Placement, PlacementRole, PlacementRuntime } from '../../../lib/world/types'
import { managedDbEngine } from '../../../lib/world/types'
import { DB_INSTANCE_CLASSES } from '../../../lib/dbInstanceClasses'
import { SectionHeader, EdgeRow, Segmented } from '../ui/kit'
import { sectionLabel, field, smallBtn, dangerBtn, row } from './panelStyles'

// Author managed services with CLOUD_REGISTRY keys directly (D12) so Cost v2 prices them without
// the alias table. Labels stay human-readable.
const MANAGED_TYPES: { key: string; label: string }[] = [
  { key: 'dbSql', label: 'SQL DB' },
  { key: 'objectStorage', label: 'Object store' },
  { key: 'queue', label: 'Queue' },
  { key: 'redis', label: 'Redis' },
  { key: 'cdn', label: 'CDN' },
  { key: 'apiGateway', label: 'API Gateway' },
  { key: 'lambda', label: 'Lambda' },
]

// Phase 4 D10a: the authoring UI defaults to 'aws' (not the store's 'generic' default) so a
// freshly added managed service prices non-zero immediately — see world.store.ts's
// addManagedService, whose own default stays 'generic' for callers that omit the param.
const PROVIDERS: { key: ManagedService['provider']; label: string }[] = [
  { key: 'aws', label: 'AWS' },
  { key: 'gcp', label: 'GCP' },
  { key: 'azure', label: 'Azure' },
  { key: 'generic', label: 'Generic' },
]

const ROLE_OPTIONS: { value: PlacementRole; label: string }[] = [
  { value: 'primary', label: 'primary' },
  { value: 'replica', label: 'replica' },
  { value: 'canary', label: 'canary' },
]

export function PlacementPanel() {
  const doc = useWorldStore(s => s.doc)
  const store = useWorldStore.getState()
  const blueprints = Object.values(doc.blueprints)
  const servers = Object.values(doc.servers)
  const [msType, setMsType] = useState(MANAGED_TYPES[0].key)
  const [msScope, setMsScope] = useState('')
  const [msProvider, setMsProvider] = useState<ManagedService['provider']>('aws')

  const scopeOptions = [
    ...Object.values(doc.regions).map(r => ({ key: `region:${r.id}`, label: `region ${r.catalogId}` })),
    ...Object.values(doc.azs).map(a => ({ key: `az:${a.id}`, label: `az ${a.label}` })),
  ]

  return (
    <div>
      <div style={sectionLabel}>Placements</div>
      {blueprints.length === 0 && <div style={{ color: 'var(--color-text-muted)' }}>create a blueprint first</div>}
      {blueprints.map(bp => (
        <div key={bp.id} style={{
          background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
          borderRadius: 8, padding: 12, marginTop: 8,
        }}>
          <div style={row}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: bp.color, flexShrink: 0 }} />
            <strong style={{ flex: 1 }}>{bp.name}</strong>
            <button className="kit-press" style={smallBtn} disabled={servers.length === 0}
              onClick={() => store.addPlacement(bp.id, servers[0].id)}>+ Place</button>
          </div>
          {Object.values(doc.placements).filter(p => p.blueprintId === bp.id).map(pl => (
            <PlacementRow key={pl.id} pl={pl} edgeColor={bp.color} />
          ))}
        </div>
      ))}

      <SectionHeader label="▸ MANAGED SERVICES" />
      <div style={row}>
        <select style={{ ...field, flex: 1, marginBottom: 0 }} value={msType} onChange={e => setMsType(e.target.value)}>
          {MANAGED_TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <select style={{ ...field, flex: 1, marginBottom: 0 }} value={msScope} onChange={e => setMsScope(e.target.value)}>
          <option value="">scope…</option>
          {scopeOptions.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        <select style={{ ...field, width: 74, marginBottom: 0 }} aria-label="provider" value={msProvider}
          onChange={e => setMsProvider(e.target.value as ManagedService['provider'])}>
          {PROVIDERS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        <button className="kit-press" style={smallBtn} disabled={!msScope} onClick={() => {
          const [kind, id] = msScope.split(':')
          store.addManagedService(msType, MANAGED_TYPES.find(t => t.key === msType)?.label ?? msType,
            kind === 'region' ? { kind: 'region', regionId: id } : { kind: 'az', azId: id }, 5432, msProvider)
        }}>+ Add</button>
      </div>
      {Object.values(doc.managedServices).map(ms => (
        <ManagedServiceRow key={ms.id} ms={ms} />
      ))}
    </div>
  )
}

// A managed-service row. For a cloud DB (node-model Phase 3) it also exposes the instance-class
// picker + read-replica count that drive the write ceiling and pricing; other managed services
// keep the plain label + delete they always had.
function ManagedServiceRow({ ms }: { ms: ManagedService }) {
  const store = useWorldStore.getState()
  const engine = managedDbEngine(ms.nodeType)
  const classes = engine ? DB_INSTANCE_CLASSES.filter(c => c.engine === engine) : []
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
        </div>
      )}
    </EdgeRow>
  )
}

function PlacementRow({ pl, edgeColor }: { pl: Placement; edgeColor: string }) {
  const doc = useWorldStore(s => s.doc)
  const store = useWorldStore.getState()
  const upd = (patch: Partial<Placement>) => store.updatePlacement(pl.id, patch)
  const server = doc.servers[pl.serverId]
  const isContainer = pl.runtime.type === 'container'

  const setRuntimeType = (type: 'process' | 'container') => {
    if (type === 'process') return upd({ runtime: { type: 'process' } })
    const stackName = server?.stacks[0]?.name ?? 'stack-1'
    const networkNames = server?.stacks[0]?.networks.map(n => n.name) ?? []
    upd({ runtime: { type: 'container', stackName, networkNames, portMappings: [], cpuLimit: null, memLimitMb: null } })
  }

  return (
    <EdgeRow
      edgeColor={edgeColor}
      trailing={<button className="kit-press" style={dangerBtn} onClick={() => store.removePlacement(pl.id)}>×</button>}
    >
      <div style={row}>
        <select style={{ ...field, flex: 1, marginBottom: 0 }} value={pl.serverId}
          onChange={e => upd({ serverId: e.target.value })}>
          {Object.values(doc.servers).map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <input style={{ ...field, width: 44, marginBottom: 0 }} type="number" min={1} value={pl.count} aria-label="pl-count"
          onChange={e => upd({ count: Math.max(1, Number(e.target.value)) })} />
        <Segmented ariaLabel={'role-' + pl.id} value={pl.role} onChange={v => upd({ role: v })} options={ROLE_OPTIONS} />
      </div>
      <div style={row}>
        <select style={{ ...field, width: 90, marginBottom: 0 }} value={pl.runtime.type}
          onChange={e => setRuntimeType(e.target.value as 'process' | 'container')}>
          <option value="process">process</option><option value="container">container</option>
        </select>
        {isContainer && pl.runtime.type === 'container' && (
          <>
            <select style={{ ...field, flex: 1, marginBottom: 0 }} value={pl.runtime.stackName}
              onChange={e => {
                const stack = server?.stacks.find(s => s.name === e.target.value)
                upd({ runtime: { ...pl.runtime, stackName: e.target.value, networkNames: stack?.networks.map(n => n.name) ?? [] } as PlacementRuntime })
              }}>
              {(server?.stacks ?? []).map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
              {(server?.stacks.length ?? 0) === 0 && <option value={pl.runtime.stackName}>{pl.runtime.stackName} (missing)</option>}
            </select>
          </>
        )}
      </div>
      {isContainer && pl.runtime.type === 'container' && (
        <input style={field} placeholder="port mappings: host:container, host:container" aria-label="pl-mappings"
          value={pl.runtime.portMappings.map(m => `${m.host}:${m.container}`).join(', ')}
          onChange={e => upd({ runtime: { ...pl.runtime, portMappings: e.target.value.split(',').map(t => t.trim()).filter(Boolean).map(t => {
            const [host, container] = t.split(':').map(Number)
            return { host: host || 0, container: container || 0 }
          }) } as PlacementRuntime })} />
      )}
    </EdgeRow>
  )
}
