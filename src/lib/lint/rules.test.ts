import { describe, it, expect } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../nodeConfig'
import type { LintContext } from './types'
import { deepSyncChain } from './rules'

// ─── Test fixture helper ───────────────────────────────────────────────────
// Builds a minimal, real LintContext from a flat node-id list and an edge list.
// - The first node id is treated as the entry point (type: 'apiGateway', satisfying isEntry()).
//   All other nodes default to a generic compute type ('ec2').
// - Edges may be given as a [source, target] tuple (edgeType defaults to 'request') or a
//   [source, target, edgeType] triple to override the type (e.g. 'event', 'stream', 'dependency').
// - Mirrors the exact adjacency-building shape lintGraph.ts's buildContext() uses, so contexts
//   built here match what rules see in production.
type EdgeSpec = [string, string] | [string, string, EdgeData['edgeType']]

function makeCtx(
  nodeIds: string[],
  edgeSpecs: EdgeSpec[],
  opts: { entryId?: string } = {},
): LintContext {
  const entryId = opts.entryId ?? nodeIds[0]

  const nodes: Node<NodeData>[] = nodeIds.map(id => ({
    id,
    type: id === entryId ? 'apiGateway' : 'ec2',
    position: { x: 0, y: 0 },
    data: { label: id, subtitle: '', status: 'idle', notes: '', warnings: [] },
  }))

  const edges: Edge<EdgeData>[] = edgeSpecs.map(([source, target, edgeType], i) => ({
    id: `e${i}:${source}->${target}`,
    source,
    target,
    data: { label: '', edgeType: edgeType ?? 'request', throughput: 0, latency: 0 },
  }))

  const nodeById = new Map(nodes.map(n => [n.id, n]))
  const inEdges = new Map<string, Edge<EdgeData>[]>()
  const outEdges = new Map<string, Edge<EdgeData>[]>()
  for (const e of edges) {
    if (!outEdges.has(e.source)) outEdges.set(e.source, [])
    outEdges.get(e.source)!.push(e)
    if (!inEdges.has(e.target)) inEdges.set(e.target, [])
    inEdges.get(e.target)!.push(e)
  }

  return { nodes, edges, nodeById, inEdges, outEdges }
}

describe('deepSyncChain reports the longest sync path, not the shortest', () => {
  it('flags a node reachable via both a 2-hop and a 6-hop sync path as a deep chain', () => {
    // Diamond: entry -> a -> f (short, 2 hops) AND entry -> b -> c -> d -> e -> f (long, 6 hops)
    const ctx = makeCtx(
      ['entry', 'a', 'f', 'b', 'c', 'd', 'e'],
      [
        ['entry', 'a'], ['a', 'f'],
        ['entry', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e'], ['e', 'f'],
      ],
      { entryId: 'entry' },
    )
    const issues = deepSyncChain(ctx)
    expect(issues.some(i => i.nodeId === 'f')).toBe(true)
  })

  it('does not flag a node only reachable via a short (<5 hop) sync path', () => {
    const ctx = makeCtx(
      ['entry', 'a', 'b'],
      [['entry', 'a'], ['a', 'b']],
      { entryId: 'entry' },
    )
    const issues = deepSyncChain(ctx)
    expect(issues).toHaveLength(0)
  })
})
