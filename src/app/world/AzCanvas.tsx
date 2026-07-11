// src/app/world/AzCanvas.tsx
// Read-only render of the focused AZ from the compiled world. Instance-level paths are
// aggregated to server-pair edges; any blocked path turns the whole edge red/dashed.
// Servers stack into per-rack frame nodes (React Flow parent/group nodes); chassis are
// frame-relative child nodes positioned by layoutRacks. Managed services stay absolute,
// in a column right of the frames.
import { useMemo } from 'react'
import { ReactFlow, ReactFlowProvider, Background, type Node, type Edge } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { useSimulationStore } from '../store/simulation.store'
import { useCompiledWorld } from './useCompiledWorld'
import { layoutRacks } from '../../lib/world/layoutRacks'
import { RackFrameNode, RackChassisNode, WorldManagedNode } from './RackNodes'
import { AzSimOverlay } from './AzSimOverlay'
import { InspectorV2 } from './InspectorV2'

const nodeTypes = { worldRackFrame: RackFrameNode, worldChassis: RackChassisNode, worldManaged: WorldManagedNode }
const NOISY_WINDOW_MS = 30_000
const PDU_KW_PER_VCPU = 0.05

export function AzCanvas() {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const batch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const events = useSimulationStore(s => s.events)
  const { regionId, azId, goServer } = useNavStore()

  const { nodes, edges } = useMemo(() => {
    if (!azId || !regionId) return { nodes: [] as Node[], edges: [] as Edge[] }
    const servers = Object.values(doc.servers).filter(s => s.azId === azId)
    const managed = Object.values(doc.managedServices).filter(m =>
      (m.scope.kind === 'az' && m.scope.azId === azId) ||
      (m.scope.kind === 'region' && m.scope.regionId === regionId))
    const azLabel = doc.azs[azId]?.label ?? azId
    const layout = layoutRacks(servers, managed.map(m => m.id))
    const displaySimMs = batch?.simMs ?? 0

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

    const serverById = new Map(servers.map(s => [s.id, s]))

    const frameNodes: Node[] = layout.frames.map(frame => {
      const kw = frame.serverIds.reduce((sum, sid) => sum + (serverById.get(sid)?.specs.vcpu ?? 0), 0) * PDU_KW_PER_VCPU
      return {
        id: `frame:${frame.rackId}`, type: 'worldRackFrame' as const,
        position: { x: frame.box.x, y: frame.box.y },
        width: frame.box.w, height: frame.box.h,
        selectable: false, zIndex: -1,
        data: { rackId: frame.rackId, azLabel, blankUnits: frame.blankUnits, pduY: frame.pduY, pduKw: kw },
      }
    })

    const chassisNodes: Node[] = servers.map(server => {
      const box = layout.chassis[server.id]
      const serverMetrics = batch?.servers[server.id]
      const residentInstances = Object.values(compiled.instances).filter(i => i.serverId === server.id)
      const metrics = serverMetrics ? {
        cpuMean: serverMetrics.coreUtilization.length
          ? serverMetrics.coreUtilization.reduce((a, b) => a + b, 0) / serverMetrics.coreUtilization.length
          : 0,
        ramFrac: serverMetrics.ramTotalMb > 0 ? serverMetrics.ramUsedMb / serverMetrics.ramTotalMb : 0,
        diskIo: serverMetrics.diskIoFraction,
        nicFrac: server.specs.nicMbps > 0 ? (serverMetrics.nicInMbps + serverMetrics.nicOutMbps) / server.specs.nicMbps : 0,
        rps: residentInstances.reduce((sum, i) => sum + (batch?.instances[i.id]?.rps ?? 0), 0),
      } : null
      const noisy = events.some(e =>
        e.kind === 'noisy_neighbor' && e.affected.includes(server.id) &&
        e.simMs <= displaySimMs && displaySimMs - e.simMs <= NOISY_WINDOW_MS)
      return {
        id: server.id, type: 'worldChassis' as const,
        parentId: `frame:${server.rack.rackId}`, extent: 'parent' as const, draggable: false,
        position: { x: box.x, y: box.y }, width: box.w, height: box.h,
        data: {
          server,
          chips: residentInstances.map(i => {
            const bp = doc.blueprints[i.blueprintId]
            return { color: bp?.color ?? '#888', name: bp?.name ?? '?' }
          }),
          internalBlocked: internalBlockedByServer.get(server.id) ?? 0,
          health: serverMetrics?.health,
          metrics,
          noisy,
        },
      }
    })

    const managedNodes: Node[] = managed.map(m => ({
      id: m.id, type: 'worldManaged' as const, position: layout.managed[m.id],
      data: { label: m.label, nodeType: m.nodeType, port: m.port },
    }))

    // Parents (frames) must precede their children (chassis) in React Flow's node array.
    const nodes: Node[] = [...frameNodes, ...chassisNodes, ...managedNodes]

    // Flow shimmer (Polish 2 T7, decision 13): source-server rps as the animation proxy — an
    // edge only shimmers when its SOURCE server is actually pushing live traffic. Lifted into a
    // Map (rather than recomputed per edge) since multiple edges can share a source server.
    const rpsByServer = new Map(servers.map(s => [
      s.id,
      Object.values(compiled.instances).filter(i => i.serverId === s.id).reduce((sum, i) => sum + (batch?.instances[i.id]?.rps ?? 0), 0),
    ]))

    const edges: Edge[] = [...agg.entries()].map(([key, e]) => ({
      id: key,
      source: e.source,
      target: e.target,
      label: e.blocked > 0 ? `✕ ${e.reason}` : `${e.total} dep${e.total > 1 ? 's' : ''}`,
      style: e.blocked > 0
        ? { stroke: 'var(--color-danger)', strokeDasharray: '5 4' }
        : { stroke: 'var(--color-success)' },
      labelStyle: { fill: e.blocked > 0 ? 'var(--color-danger)' : 'var(--color-text-muted)', fontSize: 10, fontFamily: 'var(--font-mono)' },
      // Blocked edges keep their static red dash — never shimmer a refused path.
      animated: e.blocked === 0 && (rpsByServer.get(e.source) ?? 0) > 0,
    }))

    return { nodes, edges }
  }, [doc, compiled, azId, regionId, batch, events])

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
            if (node.type === 'worldChassis') goServer(regionId, azId, node.id)
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
