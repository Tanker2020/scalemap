import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData, NodeType, NodeSimConfig, NodeSlo } from './nodeConfig'
import type { TrafficMode } from '../app/store/simulation.store'

// ─── Schema types ─────────────────────────────────────────────────────────────

export interface ScaleScriptNodeRule {
  match: { id?: string; type?: NodeType; label?: string }
  simConfig?: Partial<NodeSimConfig>
  slo?: NodeSlo
}

export interface ScaleScriptScenario {
  at: number
  action: 'setMultiplier' | 'degradeNode' | 'restoreNode' | 'failNode' | 'setEdgeRps' | 'setMode'
  target?: string
  params?: Record<string, unknown>
  value?: number | string
  message?: string
}

export interface ScaleScript {
  version: '1'
  name: string
  description?: string
  author?: string
  tags?: string[]
  simulation?: { mode?: TrafficMode; baseMultiplier?: number; speed?: number }
  nodes?: Record<string, ScaleScriptNodeRule>
  edges?: Record<string, { match: { sourceType?: NodeType; targetLabel?: string; id?: string }; throughput?: number }>
  scenarios?: ScaleScriptScenario[]
  globalSlo?: { maxErrorRate?: number; maxP99LatencyMs?: number }
}

// ─── Applied result ───────────────────────────────────────────────────────────

export interface ResolvedNodeConfig {
  nodeId: string
  simConfig: Partial<NodeSimConfig>
  slo?: NodeSlo
}

export interface ResolvedEdgeRps {
  edgeId: string
  rps: number
}

export interface ResolvedScenario extends ScaleScriptScenario {
  resolvedNodeId?: string
}

export interface AppliedScript {
  nodeConfigs: ResolvedNodeConfig[]
  edgeRps: ResolvedEdgeRps[]
  sloMap: Map<string, NodeSlo>
  scenarios: ResolvedScenario[]
  simulationOverrides: ScaleScript['simulation']
}

// ─── Parser ───────────────────────────────────────────────────────────────────

export function parseScaleScript(raw: string): ScaleScript {
  const parsed = JSON.parse(raw)
  if (parsed.version !== '1') throw new Error('Unsupported ScaleScript version')
  if (!parsed.name) throw new Error('ScaleScript must have a name')
  return parsed as ScaleScript
}

// ─── Resolver ─────────────────────────────────────────────────────────────────

export function applyScaleScript(
  script: ScaleScript,
  nodes: Node<NodeData>[],
  edges: Edge<EdgeData>[],
): AppliedScript {
  const nodeConfigs: ResolvedNodeConfig[] = []
  const sloMap = new Map<string, NodeSlo>()

  const ruleIdToNodeIds = new Map<string, string[]>()

  if (script.nodes) {
    for (const [ruleKey, rule] of Object.entries(script.nodes)) {
      const matched: string[] = []

      for (const node of nodes) {
        const m = rule.match
        if (m.id && node.id === m.id) { matched.push(node.id); continue }
        if (m.type && node.type === m.type) { matched.push(node.id); continue }
        if (m.label) {
          const label = ((node.data as NodeData).label ?? '').toLowerCase()
          if (label.includes(m.label.toLowerCase())) { matched.push(node.id); continue }
        }
      }

      ruleIdToNodeIds.set(ruleKey, matched)

      for (const nodeId of matched) {
        if (rule.simConfig) nodeConfigs.push({ nodeId, simConfig: rule.simConfig, slo: rule.slo })
        if (rule.slo) sloMap.set(nodeId, rule.slo)
      }
    }
  }

  const edgeRps: ResolvedEdgeRps[] = []
  if (script.edges) {
    for (const [, edgeRule] of Object.entries(script.edges)) {
      if (!edgeRule.throughput) continue
      for (const edge of edges) {
        const m = edgeRule.match
        if (m.id && edge.id === m.id) {
          edgeRps.push({ edgeId: edge.id, rps: edgeRule.throughput })
          continue
        }
        const srcNode = nodes.find(n => n.id === edge.source)
        const tgtNode = nodes.find(n => n.id === edge.target)
        const srcTypeMatch = !m.sourceType || srcNode?.type === m.sourceType
        const tgtLabelMatch = !m.targetLabel ||
          ((tgtNode?.data as NodeData)?.label ?? '').toLowerCase().includes(m.targetLabel.toLowerCase())
        if (srcTypeMatch && tgtLabelMatch) {
          edgeRps.push({ edgeId: edge.id, rps: edgeRule.throughput })
        }
      }
    }
  }

  // Resolve scenario targets to node IDs
  const scenarios: ResolvedScenario[] = (script.scenarios ?? []).map(sc => {
    const resolved: ResolvedScenario = { ...sc }
    if (sc.target) {
      const ids = ruleIdToNodeIds.get(sc.target)
      resolved.resolvedNodeId = ids?.[0]
    }
    return resolved
  })

  return {
    nodeConfigs,
    edgeRps,
    sloMap,
    scenarios,
    simulationOverrides: script.simulation,
  }
}

// ─── Exporter ─────────────────────────────────────────────────────────────────

export function exportScaleScript(
  name: string,
  nodes: Node<NodeData>[],
  nodeConfigs: Map<string, NodeSimConfig>,
  _edgeRps: Map<string, number>,
  sloMap: Map<string, NodeSlo>,
  simulationMode: TrafficMode,
  globalMultiplier: number,
  speed: number,
): string {
  const nodesSection: Record<string, ScaleScriptNodeRule> = {}
  for (const [nodeId, config] of nodeConfigs) {
    const node = nodes.find(n => n.id === nodeId)
    if (!node) continue
    const label = (node.data as NodeData).label
    nodesSection[nodeId] = {
      match: { id: nodeId, label },
      simConfig: config,
      slo: sloMap.get(nodeId),
    }
  }

  const script: ScaleScript = {
    version: '1',
    name,
    simulation: { mode: simulationMode, baseMultiplier: globalMultiplier, speed },
    nodes: Object.keys(nodesSection).length > 0 ? nodesSection : undefined,
    scenarios: [],
  }

  return JSON.stringify(script, null, 2)
}
