// Pure helpers for the visual service-connections layer (app/world/connections/). No store,
// React, or side effects — same purity contract as rackModel.ts. Three responsibilities:
//   1. planReachability — given an intended edge, compute the minimal doc patches (a bound port
//      on the target blueprint + firewall allow rules on its hosting servers) that make the
//      compiled path PERMITTED. Agrees with network.ts's evaluateFirewall/port-binding
//      semantics rather than forking them.
//   2. edgesForView — fold the authored dependency graph (intent) together with compiled.paths
//      (reachability verdict) into blueprint-level edges the canvas renders, plus synthetic
//      Internet→entry ingress edges.
//   3. layoutNodes — deterministic layered left→right coordinates so no graph-layout dependency
//      is added (React Flow is gone; DOM/SVG precedent is az/DatacenterFloor.tsx).
import type {
  WorldDoc, CompiledWorld, DependencyTarget, ServicePort, FirewallRule, FirewallSource,
  BlockReason, ServiceBlueprint,
} from './types'
import { evaluateFirewall } from './network'
import { nextWorldId } from './factories'

// A blueprint is an ingress/entry point when it exposes a 'public' port — the same rule
// routing.ts's (unexported) isEntryBlueprint uses. Re-derived here to avoid a routing.ts edit.
export function isEntryBlueprint(bp: ServiceBlueprint): boolean {
  return bp.ports.some(p => p.visibility === 'public')
}

// ─── 1. Reachability planning ────────────────────────────────────────────────

export interface ReachabilityPlan {
  // The blueprint that must bind the port (null for managed targets — always reachable, spec D12).
  targetBlueprintId: string | null
  // A ServicePort to append to the target blueprint, or null if it already binds `port`.
  portToAdd: ServicePort | null
  // An `allow` rule to PREPEND to each listed server's firewall (front = first-match-wins over any
  // later deny). Only servers that don't already allow `port` are listed, so re-applying is a no-op.
  firewallAdds: { serverId: string; rule: FirewallRule }[]
}

const EMPTY_PLAN: ReachabilityPlan = { targetBlueprintId: null, portToAdd: null, firewallAdds: [] }

// Computes the patches needed to make an edge to `target` on `port` reachable. `source` controls
// the added port's visibility + the firewall rule's source ('internal' for service→service,
// 'any' for internet ingress). Note: only the two common block reasons are auto-fixed here —
// no-port-binding and firewall-deny. Container network-isolation (shared docker network / host
// port mapping) is left to manual runtime config and will still surface as blocked.
export function planReachability(
  doc: WorldDoc,
  target: DependencyTarget,
  port: number,
  source: FirewallSource = 'internal',
): ReachabilityPlan {
  if (target.kind === 'managed') return EMPTY_PLAN
  const bp = doc.blueprints[target.blueprintId]
  if (!bp) return EMPTY_PLAN

  const portToAdd: ServicePort | null = bp.ports.some(p => p.port === port)
    ? null
    : { port, protocol: 'tcp', visibility: source === 'any' ? 'public' : 'internal' }

  // Every server currently hosting an instance of the target blueprint that doesn't already
  // allow the port through its firewall.
  const hostingServerIds = new Set(
    Object.values(doc.placements)
      .filter(pl => pl.blueprintId === bp.id)
      .map(pl => pl.serverId),
  )
  const firewallAdds: ReachabilityPlan['firewallAdds'] = []
  for (const serverId of hostingServerIds) {
    const server = doc.servers[serverId]
    if (!server) continue
    if (evaluateFirewall(server.firewall, port).allowed) continue
    firewallAdds.push({
      serverId,
      rule: { id: nextWorldId('fw'), action: 'allow', port, protocol: 'tcp', source },
    })
  }

  return { targetBlueprintId: bp.id, portToAdd, firewallAdds }
}

// Applies a ReachabilityPlan to a doc immutably (used by the store's connect/fix/expose actions,
// all inside one mutate() so it's a single undo step). Prepends firewall rules; appends the port.
export function applyReachabilityPlan(doc: WorldDoc, plan: ReachabilityPlan): WorldDoc {
  let next = doc
  if (plan.targetBlueprintId && plan.portToAdd) {
    const bp = next.blueprints[plan.targetBlueprintId]
    if (bp) {
      next = {
        ...next,
        blueprints: { ...next.blueprints, [bp.id]: { ...bp, ports: [...bp.ports, plan.portToAdd] } },
      }
    }
  }
  if (plan.firewallAdds.length > 0) {
    const servers = { ...next.servers }
    for (const { serverId, rule } of plan.firewallAdds) {
      const server = servers[serverId]
      if (!server) continue
      servers[serverId] = { ...server, firewall: [rule, ...server.firewall] }
    }
    next = { ...next, servers }
  }
  return next
}

// ─── 2. Edge derivation (intent × verdict) ───────────────────────────────────

export const INTERNET_NODE = '__internet__'

export type EdgeStatus = 'permitted' | 'partial' | 'blocked' | 'unplaced'

export interface ConnEdge {
  id: string                    // dependencyId, or `ingress:${bpId}` for synthetic ingress edges
  fromId: string                // blueprint id, or INTERNET_NODE for ingress
  toId: string                  // blueprint id or managed-service id
  target: DependencyTarget | { kind: 'internet' }
  port: number
  protocol: string
  status: EdgeStatus
  blockReason: BlockReason | null   // worst reason among blocked candidate paths
  totalPaths: number
  blockedPaths: number
}

function statusOf(total: number, blocked: number): EdgeStatus {
  if (total === 0) return 'unplaced'
  if (blocked === 0) return 'permitted'
  if (blocked === total) return 'blocked'
  return 'partial'
}

// Folds authored dependencies (so an unplaced intent still shows) with compiled.paths (verdict).
export function edgesForView(doc: WorldDoc, compiled: CompiledWorld): ConnEdge[] {
  // Index compiled paths by dependencyId for verdict lookup.
  const byDep = new Map<string, { total: number; blocked: number; worst: BlockReason | null }>()
  for (const p of compiled.paths) {
    const agg = byDep.get(p.dependencyId) ?? { total: 0, blocked: 0, worst: null }
    agg.total++
    if (p.verdict === 'blocked') {
      agg.blocked++
      if (!agg.worst && p.blockReason) agg.worst = p.blockReason
    }
    byDep.set(p.dependencyId, agg)
  }

  const edges: ConnEdge[] = []

  // Internal service→service / →managed edges, one per authored dependency.
  for (const bp of Object.values(doc.blueprints)) {
    for (const dep of bp.dependencies) {
      const agg = byDep.get(dep.id) ?? { total: 0, blocked: 0, worst: null }
      const toId = dep.target.kind === 'blueprint' ? dep.target.blueprintId : dep.target.managedServiceId
      edges.push({
        id: dep.id,
        fromId: bp.id,
        toId,
        target: dep.target,
        port: dep.port,
        protocol: dep.protocol,
        status: statusOf(agg.total, agg.blocked),
        blockReason: agg.worst,
        totalPaths: agg.total,
        blockedPaths: agg.blocked,
      })
    }
  }

  // Synthetic ingress edges: Internet → every entry blueprint (public port). Permitted when the
  // blueprint has at least one instance placed (the LB auto-targets entry blueprints), else unplaced.
  for (const bp of Object.values(doc.blueprints)) {
    if (!isEntryBlueprint(bp)) continue
    const placed = Object.values(compiled.instances).some(i => i.blueprintId === bp.id)
    const publicPort = bp.ports.find(p => p.visibility === 'public')!.port
    edges.push({
      id: `ingress:${bp.id}`,
      fromId: INTERNET_NODE,
      toId: bp.id,
      target: { kind: 'internet' },
      port: publicPort,
      protocol: 'http',
      status: placed ? 'permitted' : 'unplaced',
      blockReason: null,
      totalPaths: placed ? 1 : 0,
      blockedPaths: 0,
    })
  }

  return edges
}

// ─── 3. Layered layout ───────────────────────────────────────────────────────

export type NodeKind = 'internet' | 'blueprint' | 'managed'

export interface ConnNode {
  id: string
  kind: NodeKind
  label: string
  color: string | null
  publicPort: boolean
}

export interface NodePos { col: number; row: number; x: number; y: number }

export const NODE_W = 150
export const NODE_H = 56
export const COL_GAP = 120
export const ROW_GAP = 36

export function connNodes(doc: WorldDoc): ConnNode[] {
  const nodes: ConnNode[] = [
    { id: INTERNET_NODE, kind: 'internet', label: 'Internet', color: null, publicPort: false },
  ]
  for (const bp of Object.values(doc.blueprints)) {
    nodes.push({ id: bp.id, kind: 'blueprint', label: bp.name, color: bp.color, publicPort: isEntryBlueprint(bp) })
  }
  for (const ms of Object.values(doc.managedServices)) {
    nodes.push({ id: ms.id, kind: 'managed', label: ms.label, color: null, publicPort: false })
  }
  return nodes
}

// Deterministic left→right hierarchical (Sugiyama-style) layout that keeps edges legible:
//   1. Layer assignment — Internet at col 0; entry blueprints at col 1; col of a callee =
//      max(caller col) + 1 (relaxed to a fixpoint, capped by node count so a dependency cycle
//      can't loop forever).
//   2. Within-layer ORDERING — repeated barycenter sweeps (down then up) reorder each layer by
//      the mean position of a node's neighbours in the adjacent layer, which is the standard way
//      to cut edge crossings so a tree-like shape falls out instead of a crossing grid.
//   3. Row centering — shorter layers are vertically centered against the tallest, giving the
//      balanced tree look. Rows are integer positions; x/y are pixel coordinates.
// Callers overlay any manual doc.connectionLayout overrides on top of these auto positions.
export function layoutNodes(nodes: ConnNode[], edges: ConnEdge[]): Record<string, NodePos> {
  const col: Record<string, number> = {}
  for (const n of nodes) col[n.id] = n.kind === 'internet' ? 0 : 1

  // Only structural edges relax columns (ingress edges already pin entries to col ≥1 via Internet@0).
  const structural = edges.filter(e => e.fromId !== INTERNET_NODE)
  const cap = nodes.length + 1
  for (let iter = 0; iter < cap; iter++) {
    let changed = false
    for (const e of structural) {
      const want = (col[e.fromId] ?? 1) + 1
      if (want > (col[e.toId] ?? 1)) { col[e.toId] = want; changed = true }
    }
    for (const e of edges) {
      if (e.fromId === INTERNET_NODE && (col[e.toId] ?? 1) < 1) { col[e.toId] = 1; changed = true }
    }
    if (!changed) break
  }

  // Group node ids into layers (stable insertion order as the initial ordering).
  const maxCol = Math.max(0, ...nodes.map(n => col[n.id]))
  const layers: string[][] = Array.from({ length: maxCol + 1 }, () => [])
  for (const n of nodes) layers[col[n.id]].push(n.id)

  // Adjacency across all edges (structural + ingress) for barycenter ordering.
  const parents: Record<string, string[]> = {}
  const children: Record<string, string[]> = {}
  for (const e of edges) {
    ;(children[e.fromId] ??= []).push(e.toId)
    ;(parents[e.toId] ??= []).push(e.fromId)
  }

  const indexIn = (layer: string[]) => { const m = new Map<string, number>(); layer.forEach((id, i) => m.set(id, i)); return m }
  // Stable reorder of `layer` by each node's mean neighbour index (nodes with no neighbour in the
  // adjacent layer keep their current slot). Stable so ties preserve the prior sweep's order.
  const reorder = (layer: string[], neighboursOf: Record<string, string[]>, adjIndex: Map<string, number>): string[] => {
    const keyed = layer.map((id, i) => {
      const ns = (neighboursOf[id] ?? []).map(n => adjIndex.get(n)).filter((v): v is number => v !== undefined)
      const key = ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : i
      return { id, key, i }
    })
    keyed.sort((a, b) => (a.key - b.key) || (a.i - b.i))
    return keyed.map(k => k.id)
  }

  for (let sweep = 0; sweep < 4; sweep++) {
    for (let c = 1; c <= maxCol; c++) layers[c] = reorder(layers[c], parents, indexIn(layers[c - 1]))
    for (let c = maxCol - 1; c >= 0; c--) layers[c] = reorder(layers[c], children, indexIn(layers[c + 1]))
  }

  // Center each layer vertically against the tallest so short columns don't hug the top.
  const rowStep = NODE_H + ROW_GAP
  const tallest = Math.max(1, ...layers.map(l => l.length))
  const pos: Record<string, NodePos> = {}
  layers.forEach((layer, c) => {
    const offset = (tallest - layer.length) / 2
    layer.forEach((id, r) => {
      pos[id] = { col: c, row: r, x: c * (NODE_W + COL_GAP), y: (r + offset) * rowStep }
    })
  })
  return pos
}

// ─── Row projection for the dock's Connections tab ──────────────────────────────
// The dock lists connections; the full-screen canvas draws the same ones as geometry. Both read
// edgesForView, so the list and the graph can never disagree about what exists or its status.

export interface ConnectionRow {
  id: string
  fromLabel: string
  toLabel: string
  port: number
  protocol: string
  status: EdgeStatus
  fromId: string
  toId: string
}

// Sorted by source-then-target LABEL rather than by id or insertion order: the list is the tab's
// entire content, and rows reshuffling under the user whenever an unrelated edit changes id
// ordering is worse than any cleverer ranking. An edge whose endpoint has been deleted still
// renders (with a placeholder) instead of vanishing — a dangling dependency is exactly the kind
// of misconfiguration this surface exists to make visible.
export function connectionRows(doc: WorldDoc, compiled: CompiledWorld): ConnectionRow[] {
  const labelById = new Map(connNodes(doc).map(n => [n.id, n.label]))
  const labelOf = (id: string): string => labelById.get(id) ?? '(deleted)'

  return edgesForView(doc, compiled)
    .map(edge => ({
      id: edge.id,
      fromLabel: labelOf(edge.fromId),
      toLabel: labelOf(edge.toId),
      port: edge.port,
      protocol: edge.protocol,
      status: edge.status,
      fromId: edge.fromId,
      toId: edge.toId,
    }))
    .sort((a, b) =>
      a.fromLabel.localeCompare(b.fromLabel) ||
      a.toLabel.localeCompare(b.toLabel) ||
      a.port - b.port)
}
