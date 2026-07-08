// Phase-1 placeholder for the Level-4 circuit-board view (Phase 3): a faithful readout of
// everything compiled for this server, so the model is verifiable end-to-end today.
import type { CSSProperties } from 'react'
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { useCompiledWorld } from './useCompiledWorld'

const section: CSSProperties = {
  background: 'var(--color-surface)', border: '1px solid var(--color-node-border)',
  borderRadius: 10, padding: 14, font: '12px var(--font-mono)', color: 'var(--color-text-primary)',
}

export function ServerView() {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const serverId = useNavStore(s => s.serverId)
  const server = serverId ? doc.servers[serverId] : null
  if (!server) return null

  const instances = Object.values(compiled.instances).filter(i => i.serverId === server.id)

  return (
    <div style={{ padding: 24, display: 'grid', gap: 12, maxWidth: 720 }}>
      <div style={section}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{server.label}</div>
        <div style={{ color: 'var(--color-text-secondary)', marginTop: 4 }}>
          {server.kind} · {server.specs.vcpu} vCPU / {Math.round(server.specs.ramMb / 1024)} GB · {server.specs.diskGb} GB disk · {server.specs.nicMbps} Mbps
          {server.kind === 'vps' && server.oversubscriptionRatio ? ` · ${server.oversubscriptionRatio}:1 oversubscribed` : ''}
          {' '}· ${server.hourlyUsd.toFixed(3)}/hr
        </div>
      </div>

      <div style={section}>
        <div style={{ color: 'var(--color-text-muted)', marginBottom: 8 }}>SERVICES ({instances.length})</div>
        {instances.map(i => {
          const bp = doc.blueprints[i.blueprintId]
          const pl = doc.placements[i.placementId]
          return (
            <div key={i.id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: bp?.color ?? 'var(--color-text-muted)' }} />
              <span>{bp?.name ?? i.blueprintId}</span>
              <span style={{ color: 'var(--color-text-muted)' }}>
                {i.role} · {pl?.runtime.type ?? 'process'}
                {pl?.runtime.type === 'container' ? ` (stack: ${pl.runtime.stackName})` : ''}
              </span>
            </div>
          )
        })}
        {instances.length === 0 && <div style={{ color: 'var(--color-text-muted)' }}>nothing deployed — add a placement in the World panel</div>}
      </div>

      <div style={section}>
        <div style={{ color: 'var(--color-text-muted)', marginBottom: 8 }}>FIREWALL ({server.firewall.length} rules, default deny)</div>
        {server.firewall.map(r => (
          <div key={r.id} style={{ color: r.action === 'allow' ? 'var(--color-success)' : 'var(--color-danger)' }}>
            {r.action.toUpperCase()} :{r.port} {r.protocol} from {r.source}
          </div>
        ))}
      </div>

      {server.stacks.length > 0 && (
        <div style={section}>
          <div style={{ color: 'var(--color-text-muted)', marginBottom: 8 }}>COMPOSE STACKS</div>
          {server.stacks.map(st => (
            <div key={st.name} style={{ marginBottom: 6 }}>
              <div>{st.name}</div>
              <div style={{ color: 'var(--color-text-muted)' }}>
                nets: {st.networks.map(n => `${n.name} (${n.cidr})`).join(', ') || '—'} · vols: {st.volumes.map(v => `${v.name} ${v.sizeGb}GB`).join(', ') || '—'}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
