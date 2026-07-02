import type { Node, Edge } from '@xyflow/react'
import type { EdgeData, NodeData, NodeType, NodeSimConfig } from '../../../../lib/nodeConfig'
import type { CircuitState, SimEventType, NodeMetrics } from '../../../store/simulation.store'

// ─── Circuit breaker state ────────────────────────────────────────────────────
// Moved verbatim out of particleEngine.ts (Task 0 — pure code motion, no behavior change).
// Circuit breakers per edge (client-side: each directed edge owns its own breaker).

export interface CircuitBreakerEntry {
  state: CircuitState
  openedAt: number
  errorWindow: number[]
}

const _circuitBreakers = new Map<string, CircuitBreakerEntry>()

export function getBreaker(edgeId: string): CircuitBreakerEntry {
  let b = _circuitBreakers.get(edgeId)
  if (!b) {
    b = { state: 'closed', openedAt: 0, errorWindow: [] }
    _circuitBreakers.set(edgeId, b)
  }
  return b
}

// Read-only view of every breaker, keyed by edge id — used by the canvas draw loop (circuit-open
// overlay) and the periodic recovery scan, both of which iterate every breaker rather than
// looking one up by edge id.
export function getAllBreakers(): Map<string, CircuitBreakerEntry> {
  return _circuitBreakers
}

// Minimal callback type this module needs from the engine — passed in by particleEngine.ts
// rather than imported, so this module has no dependency on the main loop's module-level state.
type OnEvent = (
  type: SimEventType,
  nodeId: string | undefined,
  message: string,
  severity: 'info' | 'warn' | 'critical',
  snapshot?: Partial<NodeMetrics>,
  causedByNodeId?: string,
) => void

export function recordBreakerResult(
  edgeId: string,
  isError: boolean,
  config: NodeSimConfig,
  now: number,
  edgesData: Edge<EdgeData>[],
  nodesMap: Map<string, Node<NodeData>>,
  upstreamPressure: Map<string, number>,
  stallSources: Map<string, string>,
  onEvent: OnEvent,
) {
  const b = getBreaker(edgeId)
  const cb = config.circuitBreaker
  if (!cb) return

  b.errorWindow.push(isError ? 1 : 0)
  if (b.errorWindow.length > 20) b.errorWindow.splice(0, b.errorWindow.length - 20)

  const edgeData     = edgesData.find(e => e.id === edgeId)
  const targetNodeId = edgeData?.target
  const srcLabel     = edgeData?.source ? ((nodesMap.get(edgeData.source)?.data as NodeData)?.label ?? edgeData.source) : edgeId
  const tgtLabel     = targetNodeId    ? ((nodesMap.get(targetNodeId)?.data    as NodeData)?.label ?? targetNodeId)    : edgeId

  if (b.state === 'closed') {
    const errRate = b.errorWindow.reduce((s: number, v: number) => s + v, 0) / b.errorWindow.length
    if (errRate >= cb.errorThreshold && b.errorWindow.length >= 10) {
      b.state    = 'open'
      b.openedAt = now
      const cbCausedBy = targetNodeId && (upstreamPressure.get(targetNodeId) ?? 0) > 0.2
        ? stallSources.get(targetNodeId)
        : undefined
      onEvent('circuit_open', targetNodeId, `Circuit open: ${srcLabel} → ${tgtLabel}`, 'critical', undefined, cbCausedBy)
    }
  } else if (b.state === 'half-open') {
    if (!isError) {
      b.state       = 'closed'
      b.errorWindow = []
      onEvent('circuit_close', targetNodeId, `Circuit closed: ${srcLabel} → ${tgtLabel}`, 'info')
    } else {
      b.state    = 'open'
      b.openedAt = now
    }
  }
}

export function checkBreakerTransition(
  edgeId: string,
  config: NodeSimConfig,
  now: number,
  edgesData: Edge<EdgeData>[],
  nodesMap: Map<string, Node<NodeData>>,
  nodeHealthStates: Map<string, 'healthy' | 'degraded' | 'down'>,
  onEvent: OnEvent,
): CircuitState {
  const b = getBreaker(edgeId)
  const cb = config.circuitBreaker
  if (!cb) return 'closed'

  const edgeData     = edgesData.find(e => e.id === edgeId)
  const targetNodeId = edgeData?.target

  // Don't allow reset while the target node's health is 'down' — CB must stay open
  if (
    b.state === 'open' &&
    (targetNodeId === undefined || nodeHealthStates.get(targetNodeId) !== 'down') &&
    now - b.openedAt > cb.resetMs
  ) {
    b.state = 'half-open'
    const srcLabel = edgeData?.source ? ((nodesMap.get(edgeData.source)?.data as NodeData)?.label ?? edgeData.source) : edgeId
    const tgtLabel = targetNodeId    ? ((nodesMap.get(targetNodeId)?.data    as NodeData)?.label ?? targetNodeId)    : edgeId
    onEvent('circuit_half_open', targetNodeId, `Circuit half-open: ${srcLabel} → ${tgtLabel} (testing)`, 'warn')
  }
  return b.state
}

// ─── Force-open on node 'down' + periodic recovery scan ───────────────────────
// Extracted verbatim from updateAllNodeMetrics's inline force-open loop (previously ~:1934-1947)
// and the periodic recovery scan (previously ~:2072). No behavior change — pure code motion.

// hasBreakerConfig: whether the target node type ships a `circuitBreaker` config in
// NODE_SIM_DEFAULTS (see src/app/simulation/defaults.ts). Many node types (redis, memcached,
// objectStorage, fileStorage, loadBalancer, apiGateway, cdn, dns, firewall, vpn, all queue types)
// have none — for those, a breaker has no semantic meaning and force-opening one here is
// redundant with (and outlives) the 'down' hard-gate already applied at particle-arrival time,
// which is what caused C1: a force-opened breaker on a config-less node type could never be
// found/reset by checkBreakerTransition or the periodic recovery scan below, since both bail out
// early on `!cb`, permanently latching traffic off even after the node recovered.
export function forceOpenBreakersForNode(
  nodeId: string,
  inboundRequestEdges: Edge<EdgeData>[],
  hasBreakerConfig: boolean,
  now: number,
  nodesMap: Map<string, Node<NodeData>>,
  onEvent: OnEvent,
): void {
  if (!hasBreakerConfig) return // no breaker semantically exists for this node type — the
                                 // down-state hard-gate at arrival time already suppresses traffic
  const label = (nodesMap.get(nodeId)?.data as NodeData)?.label ?? nodeId
  for (const e of inboundRequestEdges) {
    const breaker = getBreaker(e.id)
    if (breaker.state !== 'open') {
      breaker.state    = 'open'
      breaker.openedAt = now
      const srcLabel = (nodesMap.get(e.source)?.data as NodeData)?.label ?? e.source
      onEvent('circuit_open', nodeId, `Circuit open: ${srcLabel} → ${label} (health: down)`, 'critical')
    }
  }
}

export function resetBreakersIfRecovered(
  now: number,
  edgesData: Edge<EdgeData>[],
  nodesMap: Map<string, Node<NodeData>>,
  nodeHealthStates: Map<string, 'healthy' | 'degraded' | 'down'>,
  effectiveConfig: (nodeId: string, nodeType: NodeType) => NodeSimConfig,
  onEvent: OnEvent,
): void {
  for (const [edgeId, breaker] of _circuitBreakers) {
    if (breaker.state !== 'open') continue
    const edgeData = edgesData.find(e => e.id === edgeId)
    if (!edgeData) continue
    const targetId = edgeData.target
    if (nodeHealthStates.get(targetId) === 'down') continue
    const tgtType = nodesMap.get(targetId)?.type as NodeType | undefined
    if (!tgtType) continue
    const cb = effectiveConfig(targetId, tgtType).circuitBreaker
    const srcLabel = (nodesMap.get(edgeData.source)?.data as NodeData)?.label ?? edgeData.source
    const tgtLabel = (nodesMap.get(targetId)?.data    as NodeData)?.label ?? targetId
    if (!cb) {
      // Belt-and-suspenders: close any breaker force-opened before this fix landed (or by a
      // config path change mid-run), even though this node type has no circuitBreaker config —
      // otherwise it stays latched open forever with no config to ever satisfy the resetMs check.
      breaker.state = 'closed'
      onEvent('circuit_close', targetId, `Circuit closed: ${srcLabel} → ${tgtLabel} (no breaker config for this node type)`, 'info')
      continue
    }
    if (now - breaker.openedAt <= cb.resetMs) continue
    breaker.state  = 'half-open'
    onEvent('circuit_half_open', targetId, `Circuit half-open: ${srcLabel} → ${tgtLabel} (testing)`, 'warn')
  }
}

export function clearBreakers(): void {
  _circuitBreakers.clear()
}
