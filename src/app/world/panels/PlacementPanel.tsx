import { useState } from 'react'
import { useWorldStore } from '../../store/world.store'
import type { Placement, PlacementRuntime } from '../../../lib/world/types'
import { sectionLabel, field, smallBtn, dangerBtn, row } from './panelStyles'

const MANAGED_TYPES = ['rds', 's3', 'sqs', 'redis', 'cdn', 'apiGateway', 'lambda']

export function PlacementPanel() {
  const doc = useWorldStore(s => s.doc)
  const store = useWorldStore.getState()
  const blueprints = Object.values(doc.blueprints)
  const servers = Object.values(doc.servers)
  const [msType, setMsType] = useState(MANAGED_TYPES[0])
  const [msScope, setMsScope] = useState('')

  const scopeOptions = [
    ...Object.values(doc.regions).map(r => ({ key: `region:${r.id}`, label: `region ${r.catalogId}` })),
    ...Object.values(doc.azs).map(a => ({ key: `az:${a.id}`, label: `az ${a.label}` })),
  ]

  return (
    <div>
      <div style={sectionLabel}>Placements</div>
      {blueprints.length === 0 && <div style={{ color: 'var(--color-text-muted)' }}>create a blueprint first</div>}
      {blueprints.map(bp => (
        <div key={bp.id} style={{ border: '1px solid var(--color-node-border)', borderRadius: 6, padding: 8, marginTop: 8 }}>
          <div style={row}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: bp.color }} />
            <strong style={{ flex: 1 }}>{bp.name}</strong>
            <button style={smallBtn} disabled={servers.length === 0}
              onClick={() => store.addPlacement(bp.id, servers[0].id)}>+ Place</button>
          </div>
          {Object.values(doc.placements).filter(p => p.blueprintId === bp.id).map(pl => (
            <PlacementRow key={pl.id} pl={pl} />
          ))}
        </div>
      ))}

      <div style={sectionLabel}>Managed services</div>
      <div style={row}>
        <select style={{ ...field, flex: 1, marginBottom: 0 }} value={msType} onChange={e => setMsType(e.target.value)}>
          {MANAGED_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select style={{ ...field, flex: 1, marginBottom: 0 }} value={msScope} onChange={e => setMsScope(e.target.value)}>
          <option value="">scope…</option>
          {scopeOptions.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        <button style={smallBtn} disabled={!msScope} onClick={() => {
          const [kind, id] = msScope.split(':')
          store.addManagedService(msType, msType.toUpperCase(),
            kind === 'region' ? { kind: 'region', regionId: id } : { kind: 'az', azId: id }, 5432)
        }}>+ Add</button>
      </div>
      {Object.values(doc.managedServices).map(ms => (
        <div key={ms.id} style={row}>
          <span style={{ flex: 1 }}>{ms.label} <span style={{ color: 'var(--color-text-muted)' }}>:{ms.port}</span></span>
          <button style={dangerBtn} onClick={() => store.removeManagedService(ms.id)}>×</button>
        </div>
      ))}
    </div>
  )
}

function PlacementRow({ pl }: { pl: Placement }) {
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
    <div style={{ marginTop: 6, paddingLeft: 8, borderLeft: '2px solid var(--color-node-border)' }}>
      <div style={row}>
        <select style={{ ...field, flex: 1, marginBottom: 0 }} value={pl.serverId}
          onChange={e => upd({ serverId: e.target.value })}>
          {Object.values(doc.servers).map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <input style={{ ...field, width: 44, marginBottom: 0 }} type="number" min={1} value={pl.count} aria-label="pl-count"
          onChange={e => upd({ count: Math.max(1, Number(e.target.value)) })} />
        <select style={{ ...field, width: 76, marginBottom: 0 }} value={pl.role}
          onChange={e => upd({ role: e.target.value as Placement['role'] })}>
          <option value="primary">primary</option><option value="replica">replica</option><option value="canary">canary</option>
        </select>
        <button style={dangerBtn} onClick={() => store.removePlacement(pl.id)}>×</button>
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
    </div>
  )
}
