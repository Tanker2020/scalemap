import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../nodeConfig'

// A single architectural anti-pattern finding produced by a lint rule.
export interface LintIssue {
  id: string                       // stable: `${ruleId}:${nodeId|edgeId}` — used as React key
  severity: 'warn' | 'error'
  ruleId: string
  nodeId?: string                  // node to highlight on the canvas
  edgeId?: string                  // edge the issue concerns, if any
  message: string
  recommendation: string
}

// Precomputed graph view passed to every rule, so rules stay pure and don't rebuild adjacency.
export interface LintContext {
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
  nodeById: Map<string, Node<NodeData>>
  inEdges: Map<string, Edge<EdgeData>[]>   // keyed by edge.target
  outEdges: Map<string, Edge<EdgeData>[]>  // keyed by edge.source
}

// A rule is a pure function from the graph context to zero or more issues.
export type LintRule = (ctx: LintContext) => LintIssue[]
