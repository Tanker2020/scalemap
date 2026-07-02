import type { Edge } from '@xyflow/react'
import type { NodeData, EdgeData, NodeType } from '../nodeConfig'
import { isCompute, isDatabase, isEntry, isGrouping, isMessaging } from './classify'
import type { LintIssue, LintContext, LintRule } from './types'

const labelOf = (data: NodeData | undefined, fallback: string) => data?.label?.trim() || fallback

// ─── Rule A — Isolated Node ───────────────────────────────────────────────────
// A compute node with no incoming AND no outgoing edges is dead weight.
export const isolatedNode: LintRule = (ctx) => {
  const issues: LintIssue[] = []
  for (const node of ctx.nodes) {
    const type = node.type as NodeType
    if (isGrouping(type) || !isCompute(type)) continue
    const hasIn  = (ctx.inEdges.get(node.id)?.length ?? 0) > 0
    const hasOut = (ctx.outEdges.get(node.id)?.length ?? 0) > 0
    if (hasIn || hasOut) continue
    const label = labelOf(node.data, node.id)
    issues.push({
      id: `isolated-node:${node.id}`,
      ruleId: 'isolated-node',
      severity: 'warn',
      nodeId: node.id,
      message: `${label} is not connected to anything`,
      recommendation: 'Connect it to an upstream or downstream node, or remove it if unused.',
    })
  }
  return issues
}

// ─── Rule B — Exposed Database ────────────────────────────────────────────────
// An entry node (CDN / API Gateway / Load Balancer) wired directly to a database with no buffer.
export const exposedDatabase: LintRule = (ctx) => {
  const issues: LintIssue[] = []
  for (const edge of ctx.edges) {
    const src = ctx.nodeById.get(edge.source)
    const tgt = ctx.nodeById.get(edge.target)
    if (!src || !tgt) continue
    const srcType = src.type as NodeType
    const tgtType = tgt.type as NodeType

    let entryNode = null as typeof src | null
    let dbNode    = null as typeof tgt | null
    if (isEntry(srcType) && isDatabase(tgtType)) { entryNode = src; dbNode = tgt }
    else if (isDatabase(srcType) && isEntry(tgtType)) { entryNode = tgt; dbNode = src }
    if (!entryNode || !dbNode) continue

    const entryLabel = labelOf(entryNode.data, entryNode.id)
    const dbLabel    = labelOf(dbNode.data, dbNode.id)
    issues.push({
      id: `exposed-db:${edge.id}`,
      ruleId: 'exposed-db',
      severity: 'error',
      nodeId: dbNode.id,
      edgeId: edge.id,
      message: `${entryLabel} connects directly to database ${dbLabel}`,
      recommendation: 'Insert a cache (Redis/Memcached) or queue between them to buffer load and protect the database.',
    })
  }
  return issues
}

// ─── Rule C — No Queue Consumer ───────────────────────────────────────────────
// A messaging node with producers but no consumers: every published message is silently lost.
export const noQueueConsumer: LintRule = (ctx) => {
  const issues: LintIssue[] = []
  for (const node of ctx.nodes) {
    const type = node.type as NodeType
    if (!isMessaging(type)) continue
    const hasProducers = (ctx.inEdges.get(node.id)?.length ?? 0) > 0
    const hasConsumers = (ctx.outEdges.get(node.id)?.length ?? 0) > 0
    if (!hasProducers || hasConsumers) continue
    const label = labelOf(node.data, node.id)
    issues.push({
      id: `no-queue-consumer:${node.id}`,
      ruleId: 'no-queue-consumer',
      severity: 'error',
      nodeId: node.id,
      message: `Messages published to ${label} are never consumed`,
      recommendation: 'Add a consumer (compute node or downstream service) connected from this queue/stream.',
    })
  }
  return issues
}

// ─── Rule D — No Queue Producer ──────────────────────────────────────────────
// A messaging node with consumers but no producers: consumers spin on an empty queue.
export const noQueueProducer: LintRule = (ctx) => {
  const issues: LintIssue[] = []
  for (const node of ctx.nodes) {
    const type = node.type as NodeType
    if (!isMessaging(type)) continue
    const hasProducers = (ctx.inEdges.get(node.id)?.length ?? 0) > 0
    const hasConsumers = (ctx.outEdges.get(node.id)?.length ?? 0) > 0
    if (hasProducers || !hasConsumers) continue
    const label = labelOf(node.data, node.id)
    issues.push({
      id: `no-queue-producer:${node.id}`,
      ruleId: 'no-queue-producer',
      severity: 'warn',
      nodeId: node.id,
      message: `${label} has consumers but no producers`,
      recommendation: 'Connect a producer (upstream service) to publish to this queue/stream.',
    })
  }
  return issues
}

// ─── Rule E — Lambda Direct DB ───────────────────────────────────────────────
// Lambda → Database: ephemeral connections exhaust DB connection pools under load.
// AWS RDS Proxy or a caching layer exists precisely for this reason.
export const lambdaDirectDb: LintRule = (ctx) => {
  const issues: LintIssue[] = []
  for (const edge of ctx.edges) {
    const src = ctx.nodeById.get(edge.source)
    const tgt = ctx.nodeById.get(edge.target)
    if (!src || !tgt) continue
    const srcType = src.type as NodeType
    const tgtType = tgt.type as NodeType

    let lambdaNode = null as typeof src | null
    let dbNode     = null as typeof tgt | null
    if (srcType === 'lambda' && isDatabase(tgtType)) { lambdaNode = src; dbNode = tgt }
    else if (tgtType === 'lambda' && isDatabase(srcType)) { lambdaNode = tgt; dbNode = src }
    if (!lambdaNode || !dbNode) continue

    const lambdaLabel = labelOf(lambdaNode.data, lambdaNode.id)
    const dbLabel     = labelOf(dbNode.data, dbNode.id)
    issues.push({
      id: `lambda-direct-db:${edge.id}`,
      ruleId: 'lambda-direct-db',
      severity: 'error',
      nodeId: dbNode.id,
      edgeId: edge.id,
      message: `Lambda ${lambdaLabel} connects directly to database ${dbLabel}`,
      recommendation: 'Add RDS Proxy, a connection pooler, or a caching layer (Redis/Memcached) between the Lambda and the database to prevent connection pool exhaustion.',
    })
  }
  return issues
}

// ─── Rule F — Circular Dependency ────────────────────────────────────────────
// Directed cycle in the service graph: causes deployment ordering failures and cascading restarts.
// Uses iterative DFS with a "visiting" stack (back-edge detection).
function detectCycles(ctx: LintContext): string[][] {
  const done       = new Set<string>()
  const visiting:  string[] = []
  const visitingSet = new Set<string>()
  const cycles:    string[][] = []

  function dfs(id: string) {
    if (done.has(id)) return
    if (visitingSet.has(id)) {
      const start = visiting.indexOf(id)
      if (start !== -1) cycles.push([...visiting.slice(start), id])
      return
    }
    visiting.push(id)
    visitingSet.add(id)
    for (const e of ctx.outEdges.get(id) ?? []) {
      const data = e.data as EdgeData | undefined
      const et = data?.edgeType ?? 'request'
      if (et !== 'request' && et !== 'dependency') continue // async edges break the cycle by design
      dfs(e.target)
    }
    visiting.pop()
    visitingSet.delete(id)
    done.add(id)
  }

  for (const node of ctx.nodes) dfs(node.id)
  return cycles
}

export const circularDependency: LintRule = (ctx) => {
  const cycles = detectCycles(ctx)
  // Deduplicate: two traversals of the same cycle produce the same node set.
  const seen = new Set<string>()
  return cycles.flatMap(cycle => {
    const key = [...cycle].sort().join(',')
    if (seen.has(key)) return []
    seen.add(key)
    const labels = cycle.map(id => labelOf(ctx.nodeById.get(id)?.data, id))
    return [{
      id: `circular-dep:${key}`,
      ruleId: 'circular-dep',
      severity: 'error' as const,
      nodeId: cycle[0],
      message: `Circular dependency: ${labels.join(' → ')}`,
      recommendation: 'Break the cycle by introducing an event/queue edge or extracting shared logic into a separate service.',
    }]
  })
}

// ─── Rule G — Single Entry Point SPOF ────────────────────────────────────────
// Only one ingress node (CDN/LB/Gateway) for 2+ downstream services — loss = total outage.
export const singleEntryPointSpof: LintRule = (ctx) => {
  const entryNodes = ctx.nodes.filter(n => isEntry(n.type as NodeType))
  if (entryNodes.length !== 1) return []
  const downstreamCount = ctx.nodes.filter(n => {
    const t = n.type as NodeType
    return isCompute(t) || isDatabase(t)
  }).length
  if (downstreamCount < 2) return []
  const label = labelOf(entryNodes[0].data, entryNodes[0].id)
  return [{
    id: `single-entry-spof:${entryNodes[0].id}`,
    ruleId: 'single-entry-spof',
    severity: 'warn',
    nodeId: entryNodes[0].id,
    message: `${label} is the only ingress node — a single point of failure for ${downstreamCount} downstream services`,
    recommendation: 'Add a redundant load balancer or API gateway to eliminate the single point of ingress failure.',
  }]
}

// ─── Rule H — Unbalanced Load Balancer ───────────────────────────────────────
// A LB/gateway routing to exactly 1 backend provides no redundancy or load distribution.
export const unbalancedLoadBalancer: LintRule = (ctx) => {
  const issues: LintIssue[] = []
  for (const node of ctx.nodes) {
    const type = node.type as NodeType
    if (type !== 'loadBalancer' && type !== 'apiGateway') continue
    const backends = (ctx.outEdges.get(node.id) ?? []).filter((e: Edge<EdgeData>) => {
      const tgtType = ctx.nodeById.get(e.target)?.type as NodeType | undefined
      return tgtType && (isCompute(tgtType) || isDatabase(tgtType))
    })
    if (backends.length !== 1) continue
    const label = labelOf(node.data, node.id)
    issues.push({
      id: `unbalanced-lb:${node.id}`,
      ruleId: 'unbalanced-lb',
      severity: 'warn',
      nodeId: node.id,
      message: `${label} routes to only one backend — no redundancy`,
      recommendation: 'Add at least one more backend to achieve actual load distribution and fault tolerance.',
    })
  }
  return issues
}

// ─── Rule I — Deep Sync Chain ─────────────────────────────────────────────────
// 5+ sequential synchronous hops from an entry node creates a cumulative latency ceiling
// and makes the entire chain brittle — one slow hop degrades all callers.
// Longest-path DFS from each entry, following only request/dependency-typed edges, with a
// `visiting` cycle guard (mirrors detectCycles' pattern below) since longest-path is only
// well-defined on a DAG — a cycle just stops that branch; circularDependency owns reporting it.
const DEEP_SYNC_THRESHOLD = 5

export const deepSyncChain: LintRule = (ctx) => {
  // Build a sync-only adjacency list (request + dependency edges only).
  const syncOut = new Map<string, { target: string }[]>()
  for (const e of ctx.edges) {
    const data = e.data as EdgeData | undefined
    const et = data?.edgeType ?? 'request'
    if (et !== 'request' && et !== 'dependency') continue
    if (!syncOut.has(e.source)) syncOut.set(e.source, [])
    syncOut.get(e.source)!.push({ target: e.target })
  }

  // Track max sync depth per node across all DFS traversals.
  const maxDepth = new Map<string, number>()
  const visiting = new Set<string>()

  function dfs(id: string, depth: number): void {
    if (visiting.has(id)) return // cycle — bail without recording; circularDependency reports cycles
    visiting.add(id)
    if (depth >= DEEP_SYNC_THRESHOLD) {
      const prev = maxDepth.get(id) ?? 0
      if (depth > prev) maxDepth.set(id, depth)
    }
    for (const { target } of syncOut.get(id) ?? []) dfs(target, depth + 1)
    visiting.delete(id)
  }

  const entryNodes = ctx.nodes.filter(n => isEntry(n.type as NodeType))
  for (const entry of entryNodes) dfs(entry.id, 0)

  return Array.from(maxDepth.entries()).map(([nodeId, depth]) => {
    const label = labelOf(ctx.nodeById.get(nodeId)?.data, nodeId)
    return {
      id: `deep-sync-chain:${nodeId}`,
      ruleId: 'deep-sync-chain',
      severity: 'warn' as const,
      nodeId,
      message: `${label} is reachable via a synchronous chain of ${depth} hops`,
      recommendation: 'Consider introducing an async queue or event bus to decouple services and avoid cascading latency.',
    }
  })
}

// ─── Registry ─────────────────────────────────────────────────────────────────
// Append new rules here. The runner has no per-rule knowledge.
export const LINT_RULES: LintRule[] = [
  isolatedNode,
  exposedDatabase,
  noQueueConsumer,
  noQueueProducer,
  lambdaDirectDb,
  circularDependency,
  singleEntryPointSpof,
  unbalancedLoadBalancer,
  deepSyncChain,
]
