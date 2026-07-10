// Blueprint authoring — name/color, ports, workload (derived-hint sliders/fields), stateful
// volume, dependency graph. Hybrid instrument restyle (Polish 1 T3) — presentation only; every
// dispatch below is byte-for-byte identical to the pre-restyle panel (see
// .superpowers/sdd/task-3-brief.md).
import { useState } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useCompiledWorld } from '../useCompiledWorld'
import { nextWorldId } from '../../../lib/world/factories'
import type { ServiceBlueprint, BlueprintDependency } from '../../../lib/world/types'
import { SectionHeader, ChipValue, DerivedField } from '../ui/kit'
import { rpsPerCore, hostRpsCapacity, ramAtConnections, diskIoWord } from '../ui/derived'
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
  const compiled = useCompiledWorld()
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

  const instanceCount = Object.values(compiled.instances).filter(i => i.blueprintId === bp.id).length
  const firstPlacement = Object.values(doc.placements).find(p => p.blueprintId === bp.id)
  const vcpu = firstPlacement ? doc.servers[firstPlacement.serverId]?.specs.vcpu : undefined
  const depsSummary = bp.dependencies.length > 0 ? ` · ${bp.dependencies.length} dep${bp.dependencies.length === 1 ? '' : 's'}` : ''
  const portsSummary = bp.ports.map(p => `:${p.port}`).join(' ')

  return (
    <div style={{
      background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
      borderRadius: 8, padding: 12, marginTop: 8,
    }}>
      <div style={row}>
        <input type="color" aria-label="signature color" value={bp.color}
          onChange={e => upd({ color: e.target.value })}
          style={{ width: 32, height: 20, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer', flexShrink: 0 }} />
        <input style={{ ...field, marginBottom: 0, flex: 1 }} value={bp.name} aria-label="bp-name"
          onChange={e => upd({ name: e.target.value })} />
        <ChipValue title="placed instances">×{instanceCount}</ChipValue>
        <button style={dangerBtn} onClick={() => store.removeBlueprint(bp.id)}>×</button>
      </div>
      <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 2 }}>
        {portsSummary}{depsSummary}
      </div>

      <SectionHeader label="▸ PORTS" />
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

      <SectionHeader label="▸ WORKLOAD" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <DerivedField
          label="cpu / request"
          mode="slider"
          min={1}
          max={60}
          unit="ms"
          value={bp.workload.cpuMsPerRequest}
          derive={v => '→ one core sustains ~' + Math.round(rpsPerCore(v)) + ' rps' + (vcpu ? '; this ' + vcpu + '-core host ~' + Math.round(hostRpsCapacity(vcpu, v)) + ' rps' : '')}
          onCommit={v => upd({ workload: { ...bp.workload, cpuMsPerRequest: v } })}
        />
        <DerivedField
          label="ram base MB"
          mode="input"
          min={0}
          value={bp.workload.ramBaseMb}
          onCommit={v => upd({ workload: { ...bp.workload, ramBaseMb: v } })}
        />
        <DerivedField
          label="ram / conn MB"
          mode="input"
          min={0}
          value={bp.workload.ramPerConnMb}
          derive={v => '→ ~' + (ramAtConnections(bp.workload.ramBaseMb, v) / 1024).toFixed(1) + ' GB at 2,000 active connections'}
          onCommit={v => upd({ workload: { ...bp.workload, ramPerConnMb: v } })}
        />
        <DerivedField
          label="disk io / req"
          mode="input"
          min={0}
          value={bp.workload.diskIoPerRequest}
          derive={v => '→ ' + diskIoWord(v)}
          onCommit={v => upd({ workload: { ...bp.workload, diskIoPerRequest: v } })}
        />
      </div>

      <div style={{ ...row, marginTop: 10 }}>
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
