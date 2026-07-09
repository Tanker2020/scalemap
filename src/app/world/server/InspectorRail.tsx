// src/app/world/server/InspectorRail.tsx
// HUD inspector rail: a read panel per BoardSelection kind. Reads doc (useWorldStore) + live
// metrics (useServerDisplayMetrics); each panel mounts its matching edit form from
// `./inspectorForms.tsx` (WorkloadForm/RuntimeForm/FirewallEditor/VolumesEditor) — those forms own
// all world-store writes and self-lock via <fieldset disabled={running}> (D9). Rule rows drill
// into `{kind:'rule'}`.
import type { ReactElement } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useCompiledWorld } from '../useCompiledWorld'
import { useServerDisplayMetrics } from './useServerDisplayMetrics'
import type { BoardSelection } from './selection'
import { WorkloadForm, RuntimeForm, FirewallEditor, VolumesEditor } from './inspectorForms'

const railText = { font: '7.5px var(--font-mono)', color: 'var(--color-text-secondary)', lineHeight: 1.9 } as const

export interface InspectorRailProps {
  serverId: string
  selection: BoardSelection | null
  onSelect: (s: BoardSelection | null) => void
}

export function InspectorRail({ serverId, selection, onSelect }: InspectorRailProps): ReactElement {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const display = useServerDisplayMetrics(serverId)
  const server = doc.servers[serverId]

  const header = (title: string) => (
    <div style={{ font: '8px var(--font-mono)', color: '#7CFFE9', letterSpacing: '0.1em', borderBottom: '1px solid #14332E', paddingBottom: 5 }}>▸ INSPECTOR — {title}</div>
  )

  let body: ReactElement
  if (!selection) {
    body = <div style={{ ...railText, color: 'var(--color-text-muted)', marginTop: 8 }}>click any element (chip · trace · gate · rule · core · volume) to inspect</div>
  } else if (selection.kind === 'instance') {
    const inst = compiled.instances[selection.instanceId]
    const bp = inst ? doc.blueprints[inst.blueprintId] : undefined
    const pl = inst ? doc.placements[inst.placementId] : undefined
    const m = display.instances[selection.instanceId]
    const rt = pl?.runtime
    const memLimit = rt?.type === 'container' ? rt.memLimitMb : null
    const oom = memLimit && m ? m.ramMb >= memLimit * 0.9 : false
    body = (
      <div style={{ ...railText, marginTop: 6 }}>
        <div style={{ color: '#DBEAFE' }}>{bp?.name}</div>
        <div>runtime <span style={{ color: '#C4B5FD' }}>{rt?.type}{rt?.type === 'container' ? ` · stack: ${rt.stackName}` : ''}</span></div>
        {rt?.type === 'container' && <div>binds <span style={{ color: '#9CC8FF' }}>{rt.portMappings.map(p => `:${p.host}→${p.container}`).join(' ') || '—'}</span></div>}
        {rt?.type === 'container' && <div>cpu {m?.cpuCoresUsed?.toFixed(1) ?? '—'}c of {rt.cpuLimit ?? '∞'}</div>}
        {rt?.type === 'container' && <div style={{ color: oom ? 'var(--color-danger)' : undefined }}>mem {m ? Math.round(m.ramMb) : '—'}M / {memLimit ?? '∞'}M {oom && '⚠'}</div>}
        <div style={{ marginTop: 7, color: '#475569', letterSpacing: '0.08em' }}>RESOURCES ON HOST</div>
        <div>p50 {m?.p50Ms?.toFixed(1) ?? '—'}ms · {m?.activeConnections ?? '—'} conn</div>
        {inst && <WorkloadForm key={inst.blueprintId} blueprintId={inst.blueprintId} />}
        {inst && rt?.type === 'container' && <RuntimeForm key={inst.placementId} placementId={inst.placementId} />}
      </div>
    )
  } else if (selection.kind === 'nic') {
    const sm = display.server
    body = <div style={{ ...railText, marginTop: 6 }}>
      <div>speed {server?.specs.nicMbps} Mbps</div>
      <div>in {sm ? Math.round(sm.nicInMbps) : '—'} · out {sm ? Math.round(sm.nicOutMbps) : '—'} Mb/s</div>
    </div>
  } else if (selection.kind === 'firewall' || selection.kind === 'rule') {
    body = <div style={{ ...railText, marginTop: 6 }}>
      <div style={{ color: '#475569' }}>first match wins · default deny</div>
      {(server?.firewall ?? []).map(r => (
        <div key={r.id} data-testid="fw-rule-row" onClick={() => onSelect({ kind: 'rule', ruleId: r.id })}
          style={{ cursor: 'pointer', color: r.action === 'allow' ? 'var(--color-success)' : 'var(--color-danger)', background: selection.kind === 'rule' && selection.ruleId === r.id ? '#ffffff08' : undefined }}>
          {r.action.toUpperCase()} :{r.port} {r.protocol} from {r.source}
        </div>
      ))}
      <FirewallEditor key={serverId} serverId={serverId} />
    </div>
  } else if (selection.kind === 'stack') {
    const st = server?.stacks.find(s => s.name === selection.stackName)
    const members = Object.values(compiled.instances).filter(i => {
      const pl = doc.placements[i.placementId]
      return i.serverId === serverId && pl?.runtime.type === 'container' && pl.runtime.stackName === selection.stackName
    })
    body = <div style={{ ...railText, marginTop: 6 }}>
      <div>networks {st?.networks.map(n => n.cidr).join(', ') || '—'}</div>
      <div>volumes {st?.volumes.map(v => `${v.name} ${v.sizeGb}G`).join(', ') || '—'}</div>
      <div>members {members.map(i => doc.blueprints[i.blueprintId]?.name).join(', ') || '—'}</div>
      <VolumesEditor key={`${serverId}:${selection.stackName}`} serverId={serverId} stackName={selection.stackName} />
    </div>
  } else if (selection.kind === 'volume') {
    const consumers = Object.values(doc.blueprints).filter(b => b.volumeName === selection.volumeName)
    const vol = server?.stacks.find(s => s.name === selection.stackName)?.volumes.find(v => v.name === selection.volumeName)
    body = <div style={{ ...railText, marginTop: 6 }}>
      <div>size {vol?.sizeGb ?? '—'}G</div>
      <div>consumers {consumers.map(b => b.name).join(', ') || '—'}</div>
    </div>
  } else if (selection.kind === 'hardware') {
    const sm = display.server
    body = <div style={{ ...railText, marginTop: 6 }}>
      {selection.part === 'cpu' && <div>cores {sm?.coreUtilization.length ?? server?.specs.vcpu} · steal {sm ? Math.round(sm.stealFraction * 100) : 0}%</div>}
      {selection.part === 'ram' && <div>ram {sm ? (sm.ramUsedMb / 1024).toFixed(1) : '—'}/{sm ? (sm.ramTotalMb / 1024).toFixed(0) : Math.round((server?.specs.ramMb ?? 0) / 1024)}G</div>}
      {selection.part === 'disk' && <div>io {sm ? Math.round(sm.diskIoFraction * 100) : 0}% · {server?.specs.diskGb}G</div>}
    </div>
  } else { // core
    const sm = display.server
    body = <div style={{ ...railText, marginTop: 6 }}>core {selection.coreIndex} · {sm ? Math.round((sm.coreUtilization[selection.coreIndex] ?? 0) * 100) : 0}%</div>
  }

  const title = selection?.kind === 'instance'
    ? (doc.blueprints[compiled.instances[selection.instanceId]?.blueprintId]?.name ?? 'instance')
    : (selection?.kind ?? 'server')
  return (
    <aside style={{ width: 240, borderLeft: '1px solid #1E2734', background: 'linear-gradient(180deg,#0D1117EE,#0A0D12EE)', padding: 10, overflowY: 'auto' }}>
      {header(title)}
      {body}
    </aside>
  )
}
