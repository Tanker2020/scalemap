// src/app/world/server/inspectorForms.tsx
// Edit forms mounted inside the InspectorRail panels. Every form sits in <fieldset
// disabled={running}> (D9); numeric inputs clamp ≥0 and reject NaN (keep last valid). All writes
// go through existing world.store actions; recompile is automatic via useCompiledWorld.
import { useState, type ReactElement } from 'react'
import { useSimulationStore } from '../../store/simulation.store'
import { useWorldStore } from '../../store/world.store'
import { nextWorldId } from '../../../lib/world/factories'
import type { WorkloadProfile, FirewallRule, ComposeVolume } from '../../../lib/world/types'

const lockNote = { font: '6.5px var(--font-mono)', color: 'var(--color-text-muted)', marginTop: 4 } as const
const fs = (running: boolean): React.CSSProperties => ({ border: 'none', margin: 0, padding: 0, opacity: running ? 0.55 : 1 })
const inp: React.CSSProperties = { width: 52, background: 'var(--color-node-base)', border: '1px solid #2A3648', borderRadius: 3, color: '#E2E8F0', font: '7px var(--font-mono)', padding: '1px 4px' }

function NumberField({ label, value, onCommit }: { label: string; value: number; onCommit: (n: number) => void }) {
  const [text, setText] = useState(String(value))
  return (
    <label style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
      <span>{label}</span>
      <input aria-label={label} style={inp} value={text}
        onChange={e => setText(e.target.value)}
        onBlur={() => { const n = Number(text); if (Number.isFinite(n) && n >= 0) onCommit(n); else setText(String(value)) }}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
    </label>
  )
}

export function WorkloadForm({ blueprintId }: { blueprintId: string }): ReactElement {
  const running = useSimulationStore(s => s.running)
  const bp = useWorldStore(s => s.doc.blueprints[blueprintId])
  const update = useWorldStore(s => s.updateBlueprint)
  if (!bp) return <></>
  const set = (patch: Partial<WorkloadProfile>) => update(blueprintId, { workload: { ...bp.workload, ...patch } })
  return (
    <fieldset disabled={running} style={fs(running)}>
      <div style={{ font: '6.5px var(--font-mono)', color: '#475569', marginTop: 7, letterSpacing: '0.08em' }}>WORKLOAD</div>
      <NumberField label="cpuMsPerRequest" value={bp.workload.cpuMsPerRequest} onCommit={v => set({ cpuMsPerRequest: v })} />
      <NumberField label="ramBaseMb" value={bp.workload.ramBaseMb} onCommit={v => set({ ramBaseMb: v })} />
      <NumberField label="ramPerConnMb" value={bp.workload.ramPerConnMb} onCommit={v => set({ ramPerConnMb: v })} />
      <NumberField label="diskIoPerRequest" value={bp.workload.diskIoPerRequest} onCommit={v => set({ diskIoPerRequest: v })} />
      <label style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
        <span>color</span>
        <input aria-label="signature color" type="color" value={bp.color} onChange={e => update(blueprintId, { color: e.target.value })} />
      </label>
      {running && <div style={lockNote}>stop simulation to edit</div>}
    </fieldset>
  )
}

export function RuntimeForm({ placementId }: { placementId: string }): ReactElement {
  const running = useSimulationStore(s => s.running)
  const pl = useWorldStore(s => s.doc.placements[placementId])
  const server = useWorldStore(s => (pl ? s.doc.servers[pl.serverId] : undefined))
  const update = useWorldStore(s => s.updatePlacement)
  if (!pl) return <></>
  if (pl.runtime.type !== 'container') {
    return <div style={{ ...lockNote, marginTop: 6 }}>process runtime — limits/ports are container-only. Switch runtime in the Placements panel.</div>
  }
  const rt = pl.runtime
  const setRt = (patch: Partial<typeof rt>) => update(placementId, { runtime: { ...rt, ...patch } })
  const networks = server?.stacks.find(s => s.name === rt.stackName)?.networks ?? []
  return (
    <fieldset disabled={running} style={fs(running)}>
      <div style={{ font: '6.5px var(--font-mono)', color: '#475569', marginTop: 7, letterSpacing: '0.08em' }}>LIMITS</div>
      <NumberField label="cpuLimit" value={rt.cpuLimit ?? 0} onCommit={v => setRt({ cpuLimit: Number.isFinite(v) ? v : null })} />
      <NumberField label="memLimitMb" value={rt.memLimitMb ?? 0} onCommit={v => setRt({ memLimitMb: Number.isFinite(v) ? v : null })} />
      <div style={{ marginTop: 4 }}>networks: {networks.map(n => (
        <label key={n.name} style={{ marginRight: 6 }}>
          <input type="checkbox" checked={rt.networkNames.includes(n.name)}
            onChange={e => setRt({ networkNames: e.target.checked ? [...rt.networkNames, n.name] : rt.networkNames.filter(x => x !== n.name) })} />
          {n.name}
        </label>
      ))}</div>
      {running && <div style={lockNote}>stop simulation to edit</div>}
    </fieldset>
  )
}

export function FirewallEditor({ serverId }: { serverId: string }): ReactElement {
  const running = useSimulationStore(s => s.running)
  const server = useWorldStore(s => s.doc.servers[serverId])
  const update = useWorldStore(s => s.updateServer)
  if (!server) return <></>
  const rules = server.firewall
  const commit = (next: FirewallRule[]) => update(serverId, { firewall: next })
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= rules.length) return
    const next = [...rules]; [next[i], next[j]] = [next[j], next[i]]; commit(next)
  }
  const patch = (i: number, p: Partial<FirewallRule>) => commit(rules.map((r, k) => (k === i ? { ...r, ...p } : r)))
  return (
    <fieldset disabled={running} style={fs(running)}>
      {rules.map((r, i) => (
        <div key={r.id} style={{ display: 'flex', gap: 3, alignItems: 'center', marginTop: 3 }}>
          <select aria-label="action" value={r.action} onChange={e => patch(i, { action: e.target.value as FirewallRule['action'] })}><option value="allow">allow</option><option value="deny">deny</option></select>
          <input aria-label="port" style={{ ...inp, width: 40 }} value={String(r.port)} onChange={e => {
            const raw = e.target.value
            if (raw === 'any' || raw === '') { patch(i, { port: 'any' }); return }
            const n = Number(raw)
            patch(i, { port: Number.isFinite(n) && n >= 0 ? n : 'any' })
          }} />
          <select aria-label="protocol" value={r.protocol} onChange={e => patch(i, { protocol: e.target.value as FirewallRule['protocol'] })}><option value="tcp">tcp</option><option value="udp">udp</option><option value="any">any</option></select>
          <button aria-label="move rule up" onClick={() => move(i, -1)}>↑</button>
          <button aria-label="move rule down" onClick={() => move(i, 1)}>↓</button>
          <button aria-label="remove rule" onClick={() => commit(rules.filter((_, k) => k !== i))}>✕</button>
        </div>
      ))}
      <button aria-label="add rule" style={{ marginTop: 4 }} onClick={() => commit([...rules, { id: nextWorldId('fw'), action: 'allow', port: 'any', protocol: 'tcp', source: 'any' }])}>+ add rule</button>
      {running && <div style={lockNote}>stop simulation to edit</div>}
    </fieldset>
  )
}

export function VolumesEditor({ serverId, stackName }: { serverId: string; stackName: string }): ReactElement {
  const running = useSimulationStore(s => s.running)
  const server = useWorldStore(s => s.doc.servers[serverId])
  const update = useWorldStore(s => s.updateServer)
  if (!server) return <></>
  const stack = server.stacks.find(s => s.name === stackName)
  if (!stack) return <></>
  const commitVols = (volumes: ComposeVolume[]) => update(serverId, { stacks: server.stacks.map(s => (s.name === stackName ? { ...s, volumes } : s)) })
  const nextVolumeName = () => {
    const taken = new Set(stack.volumes.map(v => v.name))
    let n = 1
    while (taken.has(`vol-${n}`)) n++
    return `vol-${n}`
  }
  return (
    <fieldset disabled={running} style={fs(running)}>
      {stack.volumes.map((v, i) => (
        <div key={v.name} style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 3 }}>
          <span>{v.name}</span>
          <NumberField label={`size-${v.name}`} value={v.sizeGb} onCommit={n => commitVols(stack.volumes.map((x, k) => (k === i ? { ...x, sizeGb: n } : x)))} />
          <button aria-label={`remove volume ${v.name}`} onClick={() => commitVols(stack.volumes.filter((_, k) => k !== i))}>✕</button>
        </div>
      ))}
      <button aria-label="add volume" onClick={() => commitVols([...stack.volumes, { name: nextVolumeName(), sizeGb: 10 }])}>+ add volume</button>
      {running && <div style={lockNote}>stop simulation to edit</div>}
    </fieldset>
  )
}
