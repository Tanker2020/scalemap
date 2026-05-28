import { create } from 'zustand'
import {
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type Viewport,
  type Connection,
  addEdge,
} from '@xyflow/react'
import { NODE_CONFIG, GROUPING_TYPES } from '../../lib/nodeConfig'
import type { NodeData, EdgeData, NodeType, EdgeType } from '../../lib/nodeConfig'

interface CanvasSnapshot {
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
}

interface CanvasStore {
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
  viewport: Viewport
  history: CanvasSnapshot[]
  future: CanvasSnapshot[]

  onNodesChange: (changes: NodeChange<Node<NodeData>>[]) => void
  onEdgesChange: (changes: EdgeChange<Edge<EdgeData>>[]) => void
  onConnect: (connection: Connection) => void

  addNode: (type: NodeType, position: { x: number; y: number }, parentId?: string) => void
  updateNodeData: (id: string, data: Partial<NodeData>) => void
  duplicateNode: (id: string) => void
  removeNodes: (ids: string[]) => void
  updateEdgeData: (id: string, data: Partial<EdgeData>) => void
  changeEdgeType: (id: string, edgeType: EdgeType) => void
  removeEdges: (ids: string[]) => void
  setViewport: (viewport: Viewport) => void
  loadDiagram: (nodes: Node<NodeData>[], edges: Edge<EdgeData>[], viewport: Viewport) => void

  pushHistory: () => void
  undo: () => void
  redo: () => void
}

let nodeCounter = 0
function nextId(prefix: string) {
  return `${prefix}-${++nodeCounter}-${Date.now()}`
}

export const useCanvasStore = create<CanvasStore>((set, get) => ({
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  history: [],
  future: [],

  onNodesChange: (changes) => {
    set(s => ({ nodes: applyNodeChanges(changes, s.nodes) }))
  },

  onEdgesChange: (changes) => {
    set(s => ({ edges: applyEdgeChanges(changes, s.edges) }))
  },

  onConnect: (connection) => {
    get().pushHistory()
    set(s => ({
      edges: addEdge(
        {
          ...connection,
          type: 'request',
          data: { label: '', edgeType: 'request', throughput: 100, latency: 20 } as EdgeData,
        },
        s.edges,
      ),
    }))
  },

  addNode: (type, position, parentId?) => {
    get().pushHistory()
    const config = NODE_CONFIG[type]
    const isGroup = GROUPING_TYPES.has(type)
    const node: Node<NodeData> = {
      id: nextId(type),
      type,
      position,
      data: { label: config?.label ?? type, subtitle: '', status: 'healthy', notes: '', warnings: [] },
      ...(isGroup ? { style: { width: 360, height: 240 } } : {}),
      ...(parentId ? { parentId } : {}),
    }
    set(s => ({ nodes: [...s.nodes, node] }))
  },

  updateNodeData: (id, data) => {
    get().pushHistory()
    set(s => ({
      nodes: s.nodes.map(n => n.id === id ? { ...n, data: { ...n.data, ...data } } : n),
    }))
  },

  duplicateNode: (id) => {
    get().pushHistory()
    const node = get().nodes.find(n => n.id === id)
    if (!node) return
    const copy: Node<NodeData> = {
      ...node,
      id: nextId(node.type ?? 'node'),
      position: { x: node.position.x + 24, y: node.position.y + 24 },
      selected: false,
    }
    set(s => ({ nodes: [...s.nodes, copy] }))
  },

  removeNodes: (ids) => {
    get().pushHistory()
    const idSet = new Set(ids)
    set(s => ({
      nodes: s.nodes.filter(n => !idSet.has(n.id)),
      edges: s.edges.filter(e => !idSet.has(e.source) && !idSet.has(e.target)),
    }))
  },

  updateEdgeData: (id, data) => {
    get().pushHistory()
    set(s => ({
      edges: s.edges.map(e => e.id === id ? { ...e, data: { ...e.data!, ...data } } : e),
    }))
  },

  changeEdgeType: (id, edgeType) => {
    get().pushHistory()
    set(s => ({
      edges: s.edges.map(e =>
        e.id === id
          ? { ...e, type: edgeType, data: { ...e.data!, edgeType } }
          : e,
      ),
    }))
  },

  removeEdges: (ids) => {
    get().pushHistory()
    const idSet = new Set(ids)
    set(s => ({ edges: s.edges.filter(e => !idSet.has(e.id)) }))
  },

  setViewport: (viewport) => set({ viewport }),

  loadDiagram: (nodes, edges, viewport) => {
    set({ nodes, edges, viewport, history: [], future: [] })
  },

  pushHistory: () => {
    const { nodes, edges, history } = get()
    const snapshot: CanvasSnapshot = {
      nodes: JSON.parse(JSON.stringify(nodes)),
      edges: JSON.parse(JSON.stringify(edges)),
    }
    const trimmed = history.length >= 100 ? history.slice(1) : history
    set({ history: [...trimmed, snapshot], future: [] })
  },

  undo: () => {
    const { history, nodes, edges, future } = get()
    if (history.length === 0) return
    const prev = history[history.length - 1]
    const current: CanvasSnapshot = {
      nodes: JSON.parse(JSON.stringify(nodes)),
      edges: JSON.parse(JSON.stringify(edges)),
    }
    set({
      nodes: prev.nodes,
      edges: prev.edges,
      history: history.slice(0, -1),
      future: [current, ...future],
    })
  },

  redo: () => {
    const { future, nodes, edges, history } = get()
    if (future.length === 0) return
    const next = future[0]
    const current: CanvasSnapshot = {
      nodes: JSON.parse(JSON.stringify(nodes)),
      edges: JSON.parse(JSON.stringify(edges)),
    }
    set({
      nodes: next.nodes,
      edges: next.edges,
      history: [...history, current],
      future: future.slice(1),
    })
  },
}))
