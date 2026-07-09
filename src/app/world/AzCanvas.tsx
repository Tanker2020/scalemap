// Read-only render of the focused AZ from the compiled world. Instance-level paths are
// aggregated to server-pair edges; any blocked path turns the whole edge red/dashed.
import { useMemo } from 'react'
import { ReactFlow, ReactFlowProvider, Background, type Node, type Edge } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { useSimulationStore } from '../store/simulation.store'
import { useCompiledWorld } from './useCompiledWorld'
import { layoutAzGrid } from '../../lib/world/layoutAz'
import { WorldServerNode, WorldManagedNode } from './WorldServerNode'
import { AzSimOverlay } from './AzSimOverlay'
import { InspectorV2 } from './InspectorV2'

const nodeTypes = { worldServer: WorldServerNode, worldManaged: WorldManagedNode }

export function AzCanvas() {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const batch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const { regionId, azId, goServer } = useNavStore()

  const { nodes, edges } = useMemo(() => {
    if (!azId || !regionId) return { nodes: [] as Node[], edges: [] as Edge[] }
    const servers = Object.values(doc.servers).filter(s => s.azId === azId)
    const managed = Object.values(doc.managedServices).filter(m =>
      (m.scope.kind === 'az' && m.scope.azId === azId) ||
      (m.scope.kind === 'region' && m.scope.regionId === regionId))
    const pos = layoutAzGrid(servers.map(s => s.id), managed.map(m => m.id))

    // Aggregate instance-level compiled paths into one edge per (fromServer, target).
    // Same-server blocked paths never become edges — they surface as a badge on the server node.
    const agg = new Map<string, { source: string; target: string; total: number; blocked: number; reason: string | null }>()
    const internalBlockedByServer = new Map<string, number>()
    const inAz = new Set(servers.map(s => s.id))
    const managedHere = new Set(managed.map(m => m.id))
    for (const p of compiled.paths) {
      const from = compiled.instances[p.fromInstanceId]
      if (!from || !inAz.has(from.serverId)) continue
      let targetId: string
      if (p.to.kind === 'managed') {
        if (!managedHere.has(p.to.managedServiceId)) continue
        targetId = p.to.managedServiceId
      } else {
        const to = compiled.instances[p.to.instanceId]
        if (!to || !inAz.has(to.serverId)) continue // cross-AZ links render at region level (Phase 4)
        if (to.serverId === from.serverId) {
          // Same-server paths draw no edge; blocked ones (e.g. docker network-isolation) badge the server node.
          if (p.verdict === 'blocked') {
            internalBlockedByServer.set(from.serverId, (internalBlockedByServer.get(from.serverId) ?? 0) + 1)
          }
          continue
        }
        targetId = to.serverId
      }
      const key = `${from.serverId}->${targetId}`
      const entry = agg.get(key) ?? { source: from.serverId, target: targetId, total: 0, blocked: 0, reason: null }
      entry.total++
      if (p.verdict === 'blocked') {
        entry.blocked++
        entry.reason = entry.reason ?? p.blockReason?.kind ?? 'blocked'
      }
      agg.set(key, entry)
    }

    const nodes: Node[] = [
      ...servers.map(server => ({
        id: server.id, type: 'worldServer' as const, position: pos[server.id],
        data: {
          server,
          chips: Object.values(compiled.instances)
            .filter(i => i.serverId === server.id)
            .map(i => {
              const bp = doc.blueprints[i.blueprintId]
              const pl = doc.placements[i.placementId]
              return { color: bp?.color ?? '#888', name: bp?.name ?? '?', role: i.role, runtime: pl?.runtime.type ?? 'process' }
            }),
          internalBlocked: internalBlockedByServer.get(server.id) ?? 0,
          health: batch?.servers[server.id]?.health,
          cpuPct: batch?.servers[server.id]
            ? (batch.servers[server.id].coreUtilization.reduce((a, b) => a + b, 0) /
               Math.max(1, batch.servers[server.id].coreUtilization.length)) * 100
            : undefined,
          ramUsedMb: batch?.servers[server.id]?.ramUsedMb,
          ramTotalMb: batch?.servers[server.id]?.ramTotalMb,
        },
      })),
      ...managed.map(m => ({
        id: m.id, type: 'worldManaged' as const, position: pos[m.id],
        data: { label: m.label, nodeType: m.nodeType, port: m.port },
      })),
    ]

    const edges: Edge[] = [...agg.entries()].map(([key, e]) => ({
      id: key,
      source: e.source,
      target: e.target,
      label: e.blocked > 0 ? `✕ ${e.reason}` : `${e.total} dep${e.total > 1 ? 's' : ''}`,
      style: e.blocked > 0
        ? { stroke: 'var(--color-danger)', strokeDasharray: '5 4' }
        : { stroke: 'var(--color-success)' },
      labelStyle: { fill: e.blocked > 0 ? 'var(--color-danger)' : 'var(--color-text-muted)', fontSize: 10, fontFamily: 'var(--font-mono)' },
    }))

    return { nodes, edges }
  }, [doc, compiled, azId, regionId, batch])

  if (!azId || !regionId) return null

  return (
    // ReactFlowProvider wraps both <ReactFlow> and its sibling <AzSimOverlay>: React Flow's own
    // internal provider (established inside <ReactFlow>) only covers elements passed as ITS
    // children (e.g. <Background>), not later JSX siblings — useReactFlow()/useViewport() in a
    // sibling throw without an ambient provider. Wrapping here supplies one context for both.
    <ReactFlowProvider>
      <div style={{ width: '100%', height: '100%', position: 'relative' }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          nodesDraggable={false}
          nodesConnectable={false}
          onNodeClick={(_, node) => {
            if (node.type === 'worldServer') goServer(regionId, azId, node.id)
          }}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} color="var(--color-canvas-dots)" />
        </ReactFlow>
        <AzSimOverlay azId={azId} />
        <InspectorV2 azId={azId} />
      </div>
    </ReactFlowProvider>
  )
}
