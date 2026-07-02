import { useCallback, useRef, useEffect, useState } from 'react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlowProvider,
  useReactFlow,
  type NodeTypes,
  type EdgeTypes,
  type Node,
  type OnSelectionChangeParams,
  type OnNodeDrag,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { useCanvasStore } from '../store/canvas.store'
import { useSimulationStore } from '../store/simulation.store'
import { useUiStore } from '../store/ui.store'
import { useFileStore } from '../store/file.store'
import { BaseNode } from './nodes/BaseNode'
import { GroupNode } from './nodes/GroupNode'
import { ScalemapEdge } from './edges/BaseEdge'
import { SimulationOverlay } from './simulation/SimulationOverlay'
import { PlaybackScrubber } from './simulation/PlaybackScrubber'
import { RequestInspector } from './simulation/RequestInspector'
import { ContextMenu } from '../sidebar/ContextMenu'
import { injectBurst, pickParticleAtPoint, redrawCurrentReplayFrame } from './simulation/particleEngine'
import { GROUPING_TYPES, type NodeType } from '../../lib/nodeConfig'
import type { NodeData } from '../../lib/nodeConfig'
import styles from './Canvas.module.css'

// Returns the minimum translation to push `a` out of `b` (AABB)
function resolveOverlap(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
): { dx: number; dy: number } | null {
  const overlapX = (ax + aw) - bx
  const overlapX2 = (bx + bw) - ax
  const overlapY = (ay + ah) - by
  const overlapY2 = (by + bh) - ay

  if (overlapX <= 0 || overlapX2 <= 0 || overlapY <= 0 || overlapY2 <= 0) return null

  const ox = overlapX < overlapX2 ? -overlapX : overlapX2
  const oy = overlapY < overlapY2 ? -overlapY : overlapY2
  return Math.abs(ox) <= Math.abs(oy) ? { dx: ox, dy: 0 } : { dx: 0, dy: oy }
}

const nodeTypes: NodeTypes = Object.fromEntries([
  'ec2','lambda','container','pod',
  'loadBalancer','apiGateway','cdn','dns','firewall','vpn',
  'dbSql','dbNoSql','objectStorage','fileStorage',
  'queue','eventBus','pubsub','stream',
  'redis','memcached','cdnCache',
].map(t => [t, BaseNode])) as NodeTypes

const groupTypes: NodeTypes = Object.fromEntries(
  ['vpc','subnet','az','region','namespace',
   'k8sCluster','ecsCluster','dockerCompose'].map(t => [t, GroupNode])
) as NodeTypes

const allNodeTypes: NodeTypes = { ...nodeTypes, ...groupTypes }

const edgeTypes: EdgeTypes = {
  request: ScalemapEdge,
  stream: ScalemapEdge,
  event: ScalemapEdge,
  dependency: ScalemapEdge,
}

const PADDING = 48
const HEADER_HEIGHT = 48

function CanvasInner() {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })
  const { screenToFlowPosition, fitView } = useReactFlow()

  const { nodes, edges, onNodesChange, onEdgesChange, onConnect, addNode, removeNodes, removeEdges } = useCanvasStore()
  const {
    gridEnabled, setSelectedNode, setSelectedEdge,
    contextMenu, setContextMenu, closeContextMenu,
    activeTool, setActiveTool,
    connectSourceId, setConnectSource,
  } = useUiStore()
  const { running, setInspectedRequest } = useSimulationStore()
  const { setDirty } = useFileStore()

  const isHand = activeTool === 'hand'
  const isConnect = activeTool === 'connect'
  const isSelect = activeTool === 'select'

  // Track canvas size for simulation overlay
  useEffect(() => {
    if (!wrapperRef.current) return
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      setDimensions({ width, height })
    })
    ro.observe(wrapperRef.current)
    return () => ro.disconnect()
  }, [])

  // Auto-expand group nodes to contain their children
  const expandGroups = useCallback(() => {
    const allNodes = useCanvasStore.getState().nodes
    const childNodes = allNodes.filter(n => n.parentId)
    if (childNodes.length === 0) return

    const parentIds = new Set(childNodes.map(n => n.parentId!))
    const updates: { id: string; w: number; h: number }[] = []

    for (const parentId of parentIds) {
      const parent = allNodes.find(n => n.id === parentId)
      if (!parent) continue
      const children = allNodes.filter(n => n.parentId === parentId)
      if (children.length === 0) continue

      let maxX = 0, maxY = 0
      for (const child of children) {
        const m = (child as Node & { measured?: { width: number; height: number } }).measured
        const cw = m?.width ?? 148
        const ch = m?.height ?? 48
        maxX = Math.max(maxX, child.position.x + cw + PADDING)
        maxY = Math.max(maxY, child.position.y + ch + PADDING)
      }

      const currentW = (parent.style?.width as number) ?? 360
      const currentH = (parent.style?.height as number) ?? 240
      const requiredW = Math.max(maxX + PADDING, 240)
      const requiredH = Math.max(maxY + HEADER_HEIGHT, 160)

      if (requiredW > currentW || requiredH > currentH) {
        updates.push({
          id: parentId,
          w: Math.max(requiredW, currentW),
          h: Math.max(requiredH, currentH),
        })
      }
    }

    if (updates.length > 0) {
      useCanvasStore.setState(s => ({
        nodes: s.nodes.map(n => {
          const u = updates.find(x => x.id === n.id)
          return u ? { ...n, style: { ...n.style, width: u.w, height: u.h } } : n
        }),
      }))
    }
  }, [])

  // Push dragged node(s) out of any overlapping non-group nodes
  const resolveNodeCollisions = useCallback((draggedIds: Set<string>) => {
    const allNodes = useCanvasStore.getState().nodes
    const nonGroup = allNodes.filter(nd => !GROUPING_TYPES.has(nd.type as NodeType))

    const updates: { id: string; x: number; y: number }[] = []

    for (const dragged of nonGroup.filter(nd => draggedIds.has(nd.id))) {
      const dm = (dragged as Node<NodeData> & { measured?: { width: number; height: number } }).measured
      let ax = dragged.position.x, ay = dragged.position.y
      const aw = dm?.width ?? 148, ah = dm?.height ?? 46

      for (const other of nonGroup) {
        if (other.id === dragged.id || draggedIds.has(other.id)) continue
        const om = (other as Node<NodeData> & { measured?: { width: number; height: number } }).measured
        const bx = other.position.x, by = other.position.y
        const bw = om?.width ?? 148, bh = om?.height ?? 46

        const fix = resolveOverlap(ax, ay, aw, ah, bx, by, bw, bh)
        if (fix) { ax += fix.dx; ay += fix.dy }
      }

      if (ax !== dragged.position.x || ay !== dragged.position.y) {
        updates.push({ id: dragged.id, x: ax, y: ay })
      }
    }

    if (updates.length > 0) {
      useCanvasStore.setState(s => ({
        nodes: s.nodes.map(nd => {
          const u = updates.find(x => x.id === nd.id)
          return u ? { ...nd, position: { x: u.x, y: u.y } } : nd
        }),
      }))
    }
  }, [])

  const onNodeDragStopHandler: OnNodeDrag = useCallback((_e, _node, draggedNodes) => {
    const ids = new Set<string>(draggedNodes.map((n: Node) => n.id))
    resolveNodeCollisions(ids)

    // Reparenting: check if any non-group node entered or left a group
    const allNodes = useCanvasStore.getState().nodes
    const groups = allNodes.filter(n => GROUPING_TYPES.has(n.type as NodeType))

    type ReparentUpdate = { id: string; parentId?: string; position: { x: number; y: number } }
    const reparentUpdates: ReparentUpdate[] = []

    for (const dn of draggedNodes) {
      if (GROUPING_TYPES.has(dn.type as NodeType)) continue
      const freshNode = allNodes.find(n => n.id === dn.id)
      if (!freshNode) continue

      // Compute absolute canvas position (children have parent-relative positions)
      let absX = freshNode.position.x
      let absY = freshNode.position.y
      if (freshNode.parentId) {
        const parent = allNodes.find(n => n.id === freshNode.parentId)
        if (parent) { absX += parent.position.x; absY += parent.position.y }
      }

      const dm = (freshNode as Node & { measured?: { width: number; height: number } }).measured
      const nw = dm?.width ?? 148
      const nh = dm?.height ?? 46
      const cx = absX + nw / 2
      const cy = absY + nh / 2

      const targetGroup = groups.find(g => {
        const gw = (g.style?.width as number) ?? 360
        const gh = (g.style?.height as number) ?? 240
        return cx >= g.position.x && cx <= g.position.x + gw && cy >= g.position.y && cy <= g.position.y + gh
      })

      if (targetGroup && freshNode.parentId !== targetGroup.id) {
        reparentUpdates.push({
          id: freshNode.id,
          parentId: targetGroup.id,
          position: { x: absX - targetGroup.position.x, y: absY - targetGroup.position.y },
        })
      } else if (!targetGroup && freshNode.parentId) {
        reparentUpdates.push({ id: freshNode.id, parentId: undefined, position: { x: absX, y: absY } })
      }
    }

    if (reparentUpdates.length > 0) {
      useCanvasStore.setState(s => ({
        nodes: s.nodes.map(n => {
          const u = reparentUpdates.find(x => x.id === n.id)
          if (!u) return n
          return { ...n, parentId: u.parentId, position: u.position }
        }),
      }))
      useFileStore.getState().setDirty(true)
    }

    requestAnimationFrame(() => expandGroups())
  }, [resolveNodeCollisions, expandGroups])

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    if (running) return
    const nodeType = e.dataTransfer.getData('nodeType') as NodeType
    if (!nodeType) return

    const position = screenToFlowPosition({ x: e.clientX, y: e.clientY })

    // Check if dropped inside a group node
    const parentGroup = nodes.find(n => {
      if (!GROUPING_TYPES.has(n.type as NodeType)) return false
      const w = (n.style?.width as number) ?? (n as Node & { measured?: { width: number } }).measured?.width ?? 360
      const h = (n.style?.height as number) ?? (n as Node & { measured?: { height: number } }).measured?.height ?? 240
      return (
        position.x >= n.position.x &&
        position.x <= n.position.x + w &&
        position.y >= n.position.y &&
        position.y <= n.position.y + h
      )
    })

    const finalPos = parentGroup
      ? { x: position.x - parentGroup.position.x, y: position.y - parentGroup.position.y }
      : position

    addNode(nodeType, finalPos, parentGroup?.id)
    setDirty(true)
    // After the node renders, expand any groups that need it
    requestAnimationFrame(() => expandGroups())
  }, [screenToFlowPosition, addNode, setDirty, nodes, expandGroups])

  const onSelectionChange = useCallback(({ nodes: sNodes, edges: sEdges }: OnSelectionChangeParams) => {
    if (sNodes.length === 1) setSelectedNode(sNodes[0].id)
    else if (sEdges.length === 1) setSelectedEdge(sEdges[0].id)
    else { setSelectedNode(null); setSelectedEdge(null) }
  }, [setSelectedNode, setSelectedEdge])

  const onNodeContextMenu = useCallback((e: React.MouseEvent, node: Node) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, targetId: node.id, targetType: 'node' })
  }, [setContextMenu])

  // Click-to-connect: in Connect mode, click source → click target → creates edge
  const onNodeClick = useCallback((_e: React.MouseEvent, node: Node) => {
    if (running) {
      injectBurst(node.id, edges)
      return
    }

    if (isConnect) {
      if (!connectSourceId) {
        setConnectSource(node.id)
      } else if (connectSourceId === node.id) {
        setConnectSource(null)
      } else {
        onConnect({ source: connectSourceId, target: node.id, sourceHandle: null, targetHandle: null })
        setDirty(true)
        setConnectSource(null)
      }
    }
  }, [running, edges, isConnect, connectSourceId, setConnectSource, onConnect, setDirty])

  // Keep replay-frame particle dots glued to their edges while panning/zooming paused.
  // getEdgePoint() itself is always viewport-correct; the redraw just needs to be re-triggered
  // on every pan/zoom tick, not only when the scrubber index changes (see redrawCurrentReplayFrame).
  const onMove = useCallback(() => { redrawCurrentReplayFrame() }, [])

  const onPaneClick = useCallback((event: React.MouseEvent) => {
    closeContextMenu()
    if (isConnect) setConnectSource(null)
    // Click-to-inspect a particle while simulating. React Flow only fires onPaneClick for a
    // genuine click (it suppresses this after a pan-drag), so no manual drag-distance check
    // is needed here — unlike the old overlay-canvas handler this replaces.
    if (running && wrapperRef.current) {
      const rect = wrapperRef.current.getBoundingClientRect()
      const snap = pickParticleAtPoint(event.clientX, event.clientY, rect)
      setInspectedRequest(snap ?? null)
    }
  }, [closeContextMenu, isConnect, setConnectSource, running, setInspectedRequest])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      const tag = (e.target as HTMLElement)?.tagName
      const inInput = tag === 'INPUT' || tag === 'TEXTAREA'

      if (!inInput && !meta) {
        if (e.key === 'v' || e.key === 'V') { setActiveTool('select'); setConnectSource(null) }
        if (e.key === 'h' || e.key === 'H') { setActiveTool('hand');   setConnectSource(null) }
        if (e.key === 'c' || e.key === 'C') { setActiveTool('connect'); setConnectSource(null) }
        if (e.key === 'Escape')              { setConnectSource(null) }
      }

      if ((e.key === 'Delete' || e.key === 'Backspace') && !inInput) {
        const selectedNodeIds = nodes.filter(n => n.selected).map(n => n.id)
        const selectedEdgeIds = edges.filter(ed => ed.selected).map(ed => ed.id)
        if (selectedNodeIds.length > 0) removeNodes(selectedNodeIds)
        if (selectedEdgeIds.length > 0) removeEdges(selectedEdgeIds)
      }
      if (meta && e.key === 'z' && !e.shiftKey) { e.preventDefault(); useCanvasStore.getState().undo() }
      if (meta && e.key === 'z' && e.shiftKey)  { e.preventDefault(); useCanvasStore.getState().redo() }
      if (meta && e.shiftKey && e.key === 'F')   { e.preventDefault(); fitView({ padding: 0.1 }) }
      if (e.key === ' ' && !inInput) {
        e.preventDefault()
        const { running, paused, setRunning, setPaused } = useSimulationStore.getState()
        if (!running) { setPaused(false); setRunning(true) }
        else if (paused) { setPaused(false) }
        else { setPaused(true) }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [nodes, edges, removeNodes, removeEdges, fitView, setActiveTool, setConnectSource])

  const wrapperClass = [
    styles.wrapper,
    isHand ? styles.handMode : '',
    isConnect && !running ? styles.connectMode : '',
    connectSourceId ? styles.connectPending : '',
    running ? styles.simulating : '',
  ].filter(Boolean).join(' ')

  return (
    <div ref={wrapperRef} className={wrapperClass}>
      {running && (
        <div className={styles.simLock}>
          Simulation running — editing locked
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={allNodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={(changes) => { onNodesChange(changes); setDirty(true) }}
        onEdgesChange={(changes) => { onEdgesChange(changes); setDirty(true) }}
        onConnect={(connection) => { onConnect(connection); setDirty(true) }}
        onSelectionChange={onSelectionChange}
        onNodeContextMenu={onNodeContextMenu}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        onMove={onMove}
        onNodeDragStop={onNodeDragStopHandler}
        onDrop={onDrop}
        onDragOver={onDragOver}
        defaultEdgeOptions={{ type: 'request' }}
        snapToGrid={gridEnabled}
        snapGrid={[8, 8]}
        minZoom={0.1}
        maxZoom={4}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        panOnDrag={isHand ? [0, 1, 2] : [1, 2]}
        selectionOnDrag={isSelect && !running}
        nodesDraggable={!running}
        nodesConnectable={!running && isConnect}
        nodesFocusable={!running}
        connectionRadius={80}
        elevateEdgesOnSelect
        proOptions={{ hideAttribution: true }}
      >
        {gridEnabled && (
          <Background
            variant={BackgroundVariant.Dots}
            color="#1A1D22"
            gap={24}
            size={1}
          />
        )}
        <MiniMap
          style={{ background: '#111318', border: '1px solid #2A2E38' }}
          maskColor="#0D0F1288"
          nodeColor={(n) => GROUPING_TYPES.has(n.type as NodeType) ? '#1A2035' : '#2A2E38'}
          zoomable
          pannable
        />
      </ReactFlow>

      {dimensions.width > 0 && (
        <SimulationOverlay width={dimensions.width} height={dimensions.height} />
      )}
      <PlaybackScrubber />
      <RequestInspector />

      {connectSourceId && (
        <div className={styles.connectHint}>
          Click any node to connect → <kbd>Esc</kbd> to cancel
        </div>
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          targetId={contextMenu.targetId}
          targetType={contextMenu.targetType}
          onClose={closeContextMenu}
        />
      )}
    </div>
  )
}

export function Canvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  )
}
