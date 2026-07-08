import { useState } from 'react'
import { useWorldStore } from '../../store/world.store'
import { nextWorldId } from '../../../lib/world/factories'
import type { ServiceBlueprint, BlueprintDependency } from '../../../lib/world/types'
import { sectionLabel, field, smallBtn, dangerBtn, row } from './panelStyles'

export function BlueprintPanel() {
  const doc = useWorldStore(s => s.doc)
  const store = useWorldStore.getState()
  const [name, setName] = useState('')

  return (
    <div>
      <div style={sectionLabel}>Blueprints</div>
      <div style={row}>
        <input style={{ ...field, marginBottom: 0, flex: 1 }} placeholder="new blueprint name"
          value={name} onChange={e => setName(e.target.value)} />
        <button style={smallBtn} disabled={!name.trim()}
          onClick={() => { store.addBlueprint(name.trim()); setName('') }}>+ Blueprint</button>
      </div>
      {Object.values(doc.blueprints).map(bp => <BlueprintCard key={bp.id} bp={bp} />)}
    </div>
  )
}

function BlueprintCard({ bp }: { bp: ServiceBlueprint }) {
  const doc = useWorldStore(s => s.doc)
  const store = useWorldStore.getState()
  const [showDeps, setShowDeps] = useState(false)
  const upd = (patch: Partial<ServiceBlueprint>) => store.updateBlueprint(bp.id, patch)

  const targets = [
    ...Object.values(doc.blueprints).filter(b => b.id !== bp.id).map(b => ({ key: `bp:${b.id}`, label: b.name })),
    ...Object.values(doc.managedServices).map(m => ({ key: `ms:${m.id}`, label: `${m.label} (managed)` })),
  ]

  const addDep = () => {
    if (targets.length === 0) return
    const [kind, id] = targets[0].key.split(':')
    const dep: BlueprintDependency = {
      id: nextWorldId('dep'),
      target: kind === 'bp' ? { kind: 'blueprint', blueprintId: id } : { kind: 'managed', managedServiceId: id },
      port: 8080, protocol: 'http', packetTemplateId: null,
    }
    upd({ dependencies: [...bp.dependencies, dep] })
  }

  const setDepTarget = (i: number, key: string) => {
    const [kind, id] = key.split(':')
    upd({ dependencies: bp.dependencies.map((d, j) => j === i ? {
      ...d, target: kind === 'bp' ? { kind: 'blueprint', blueprintId: id } : { kind: 'managed', managedServiceId: id },
    } : d) })
  }

  return (
    <div style={{ border: '1px solid var(--color-node-border)', borderRadius: 6, padding: 8, marginTop: 8 }}>
      <div style={row}>
        <span style={{ width: 10, height: 10, borderRadius: 3, background: bp.color, flexShrink: 0 }} />
        <input style={{ ...field, marginBottom: 0, flex: 1 }} value={bp.name} aria-label="bp-name"
          onChange={e => upd({ name: e.target.value })} />
        <button style={dangerBtn} onClick={() => store.removeBlueprint(bp.id)}>×</button>
      </div>

      <div style={sectionLabel}>Ports</div>
      {bp.ports.map((p, i) => (
        <div key={i} style={row}>
          <input style={{ ...field, width: 64, marginBottom: 0 }} type="number" value={p.port} aria-label={`port-${i}`}
            onChange={e => upd({ ports: bp.ports.map((x, j) => j === i ? { ...x, port: Number(e.target.value) } : x) })} />
          <select style={{ ...field, width: 80, marginBottom: 0 }} value={p.visibility}
            onChange={e => upd({ ports: bp.ports.map((x, j) => j === i ? { ...x, visibility: e.target.value as 'public' | 'internal' } : x) })}>
            <option value="internal">internal</option><option value="public">public</option>
          </select>
          <button style={dangerBtn} onClick={() => upd({ ports: bp.ports.filter((_, j) => j !== i) })}>×</button>
        </div>
      ))}
      <button style={smallBtn} onClick={() => upd({ ports: [...bp.ports, { port: 8080, protocol: 'tcp', visibility: 'internal' }] })}>+ Port</button>

      <div style={sectionLabel}>Workload</div>
      {([
        ['cpuMsPerRequest', 'cpu ms/req'], ['ramBaseMb', 'ram base MB'],
        ['ramPerConnMb', 'ram/conn MB'], ['diskIoPerRequest', 'disk io/req'],
      ] as const).map(([key, label]) => (
        <div key={key} style={row}>
          <span style={{ flex: 1, color: 'var(--color-text-muted)' }}>{label}</span>
          <input style={{ ...field, width: 70, marginBottom: 0 }} type="number" value={bp.workload[key]}
            onChange={e => upd({ workload: { ...bp.workload, [key]: Number(e.target.value) } })} />
        </div>
      ))}

      <div style={row}>
        <label style={{ flex: 1, color: 'var(--color-text-muted)' }}>
          <input type="checkbox" checked={bp.stateful}
            onChange={e => upd({ stateful: e.target.checked, volumeName: e.target.checked ? (bp.volumeName ?? `${bp.name}-data`) : null })} />
          {' '}stateful
        </label>
        {bp.stateful && (
          <input style={{ ...field, width: 110, marginBottom: 0 }} placeholder="volume name"
            value={bp.volumeName ?? ''} onChange={e => upd({ volumeName: e.target.value || null })} />
        )}
      </div>

      <button style={smallBtn} onClick={() => setShowDeps(s => !s)}>{showDeps ? '▾ deps' : '▸ deps'}</button>
      {showDeps && (
        <div style={{ marginTop: 4 }}>
          {bp.dependencies.map((d, i) => {
            const key = d.target.kind === 'blueprint' ? `bp:${d.target.blueprintId}` : `ms:${d.target.managedServiceId}`
            return (
              <div key={d.id} style={row}>
                <select style={{ ...field, flex: 1, marginBottom: 0 }} value={key} onChange={e => setDepTarget(i, e.target.value)}>
                  {targets.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
                </select>
                <input style={{ ...field, width: 56, marginBottom: 0 }} type="number" value={d.port} aria-label={`dep-port-${i}`}
                  onChange={e => upd({ dependencies: bp.dependencies.map((x, j) => j === i ? { ...x, port: Number(e.target.value) } : x) })} />
                <select style={{ ...field, width: 64, marginBottom: 0 }} value={d.protocol}
                  onChange={e => upd({ dependencies: bp.dependencies.map((x, j) => j === i ? { ...x, protocol: e.target.value as BlueprintDependency['protocol'] } : x) })}>
                  <option value="http">http</option><option value="db">db</option>
                  <option value="event">event</option><option value="stream">stream</option>
                </select>
                <button style={dangerBtn} onClick={() => upd({ dependencies: bp.dependencies.filter((_, j) => j !== i) })}>×</button>
              </div>
            )
          })}
          <button style={smallBtn} disabled={targets.length === 0} onClick={addDep}>+ Dependency</button>
        </div>
      )}
    </div>
  )
}
