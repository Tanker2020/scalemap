import type { Node, Edge, Viewport } from '@xyflow/react'
import type { NodeData, EdgeData } from './nodeConfig'

export interface DiagramFile {
  version: '1'
  meta: { name: string; created: string; modified: string }
  viewport: Viewport
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
}

export function serialize(
  nodes: Node<NodeData>[],
  edges: Edge<EdgeData>[],
  viewport: Viewport,
  name: string,
  created: string,
): string {
  const diagram: DiagramFile = {
    version: '1',
    meta: { name, created, modified: new Date().toISOString() },
    viewport,
    nodes,
    edges,
  }
  return JSON.stringify(diagram, null, 2)
}

export function deserialize(raw: string): DiagramFile {
  const data = JSON.parse(raw) as DiagramFile
  if (data.version !== '1') throw new Error(`Unsupported diagram version: ${data.version}`)
  return data
}
