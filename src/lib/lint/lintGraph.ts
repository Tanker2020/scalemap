import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../nodeConfig'
import type { LintContext, LintIssue } from './types'
import { LINT_RULES } from './rules'

// Build the precomputed graph view once, then hand it to every rule.
function buildContext(nodes: Node<NodeData>[], edges: Edge<EdgeData>[]): LintContext {
  const nodeById = new Map(nodes.map(n => [n.id, n]))
  const inEdges  = new Map<string, Edge<EdgeData>[]>()
  const outEdges = new Map<string, Edge<EdgeData>[]>()
  for (const e of edges) {
    if (!outEdges.has(e.source)) outEdges.set(e.source, [])
    outEdges.get(e.source)!.push(e)
    if (!inEdges.has(e.target)) inEdges.set(e.target, [])
    inEdges.get(e.target)!.push(e)
  }
  return { nodes, edges, nodeById, inEdges, outEdges }
}

// On-demand static analysis runner: pass the graph to each registered rule and flatten the results.
export function lintGraph(nodes: Node<NodeData>[], edges: Edge<EdgeData>[]): LintIssue[] {
  const ctx = buildContext(nodes, edges)
  return LINT_RULES.flatMap(rule => rule(ctx))
}

export type { LintIssue, LintRule, LintContext } from './types'
