import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { Server } from '../../lib/world/types'
import type { HealthState } from '../../lib/worldEngine/types'

export interface WorldServerNodeData {
  server: Server
  chips: { color: string; name: string; role: string; runtime: string }[]
  internalBlocked: number
  health?: HealthState
  cpuPct?: number
  ramUsedMb?: number
  ramTotalMb?: number
  [key: string]: unknown
}

const HEALTH_BORDER: Record<HealthState, string> = {
  healthy: '1px solid var(--color-node-border)',
  degraded: '1px solid var(--color-warning)',
  down: '1px solid var(--color-danger)',
}

export function WorldServerNode({ data }: NodeProps) {
  const { server, chips, internalBlocked, health, cpuPct, ramUsedMb, ramTotalMb } = data as WorldServerNodeData
  return (
    <div style={{
      width: 220, background: 'var(--color-node-base)', border: HEALTH_BORDER[health ?? 'healthy'],
      borderRadius: 8, padding: 10, font: '11px var(--font-mono)', color: 'var(--color-text-primary)',
    }}>
      <Handle type="target" position={Position.Left} />
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <strong>{server.label}</strong>
        <span style={{ color: 'var(--color-text-muted)' }}>{server.kind}</span>
      </div>
      <div style={{ color: 'var(--color-text-muted)', fontSize: 10, marginBottom: 6 }}>
        {server.specs.vcpu} vCPU · {Math.round(server.specs.ramMb / 1024)} GB · {server.firewall.length} fw rules
      </div>
      {cpuPct !== undefined && (
        <div style={{ color: 'var(--color-text-muted)', fontSize: 10, marginBottom: 6 }}>
          CPU {cpuPct.toFixed(0)}% · RAM {Math.round(ramUsedMb ?? 0)}/{Math.round(ramTotalMb ?? 0)} MB
        </div>
      )}
      {chips.map((c, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <span style={{ width: 7, height: 7, borderRadius: 2, background: c.color, flexShrink: 0 }} />
          <span>{c.name}</span>
          <span style={{ color: 'var(--color-text-muted)', fontSize: 10 }}>{c.role} · {c.runtime}</span>
        </div>
      ))}
      {chips.length === 0 && <div style={{ color: 'var(--color-text-muted)', fontSize: 10 }}>empty</div>}
      {internalBlocked > 0 && (
        <div style={{ color: 'var(--color-danger)', fontSize: 10, marginTop: 4 }}>
          ✕ {internalBlocked} blocked internal path{internalBlocked > 1 ? 's' : ''}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

export function WorldManagedNode({ data }: NodeProps) {
  const { label, nodeType, port } = data as { label: string; nodeType: string; port: number }
  return (
    <div style={{
      width: 170, background: 'var(--color-node-base)', border: '1px dashed var(--color-text-muted)',
      borderRadius: 8, padding: 10, font: '11px var(--font-mono)', color: 'var(--color-text-primary)',
    }}>
      <Handle type="target" position={Position.Left} />
      <strong>{label}</strong>
      <div style={{ color: 'var(--color-text-muted)', fontSize: 10 }}>managed · {nodeType} · :{port}</div>
    </div>
  )
}
