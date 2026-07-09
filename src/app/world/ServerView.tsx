// src/app/world/ServerView.tsx
// Level-4 server interior composition root (Phase 3): header strip + circuit-board stage +
// inspector rail placeholder (T6 replaces the <aside>). Selection/hover are held here in T6.
import { useMemo, type ReactElement } from 'react'
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { useCompiledWorld } from './useCompiledWorld'
import { layoutServerBoard, serverTraces } from './server/boardLayout'
import { ServerBoard } from './server/ServerBoard'

export function ServerView(): ReactElement | null {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const serverId = useNavStore(s => s.serverId)
  const server = serverId ? doc.servers[serverId] : null

  const layout = useMemo(() => (server ? layoutServerBoard(server, doc, compiled) : null), [server, doc, compiled])
  const traces = useMemo(() => (server && serverId ? serverTraces(serverId, doc, compiled) : []), [server, serverId, doc, compiled])

  if (!server || !serverId || !layout) return null
  const az = doc.azs[server.azId]
  const gb = Math.round(server.specs.ramMb / 1024)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--color-node-border)', font: '11px var(--font-mono)', color: 'var(--color-text-secondary)' }}>
        <span style={{ color: 'var(--color-text-primary)' }}>{server.label}</span> · {server.kind} · {server.specs.vcpu} vCPU / {gb} GB
        {' — '}{az?.label ?? '?'} › {server.rack.rackId} › U{server.rack.unit}
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ flex: 2.6, display: 'flex', minWidth: 0 }}>
          <ServerBoard
            serverId={serverId} layout={layout} traces={traces}
            selection={null} onSelect={() => {}} hoveredBlueprintId={null} onHoverBlueprint={() => {}}
          />
        </div>
        <aside style={{ width: 240, borderLeft: '1px solid var(--color-node-border)', background: 'var(--color-surface)' }} />
      </div>
    </div>
  )
}
