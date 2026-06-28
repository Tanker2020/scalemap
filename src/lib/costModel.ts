// Pure cost-projection layer. Combines the static rates in cloudRegistry.ts with the
// user-entered parameters on node.data.cost and the LIVE traffic metrics published by the
// particle engine (inRps), producing a per-node + total cost breakdown.
//
// Cost-typing guard (the key invariant): the run→month projection scales ONLY volume- and
// time-based components. Storage-from-config and fixed monthly fees are added flat — a DNS
// hosted-zone fee or a WAF base policy is never inflated by traffic. Each CostKind encodes
// its own behavior, so nothing is multiplied globally.

import type { Node } from '@xyflow/react'
import type { NodeData } from './nodeConfig'
import type { NodeMetrics } from '../app/store/simulation.store'
import {
  getServiceSpec,
  egressMonthlyCost,
  type CostKind,
  type RealProvider,
} from './cloudRegistry'

export const HOURS_PER_MONTH = 730
export const SECONDS_PER_MONTH = HOURS_PER_MONTH * 3600 // 2,628,000

export interface CostComponentResult {
  kind: CostKind
  label: string
  monthlyUsd: number
}

export interface NodeCostBreakdown {
  nodeId: string
  nodeLabel: string
  serviceName: string
  hourlyUsd: number
  monthlyUsd: number
  components: CostComponentResult[]
}

export interface CostSummary {
  totalHourlyUsd: number
  totalMonthlyUsd: number
  perNode: NodeCostBreakdown[]
}

const BYTES_PER_GB = 1024 ** 3

// GB egressed per month, projected from the LIVE bandwidth the particle engine measures
// (bytes/sec of actual responses leaving the node) held steady over a month.
function egressGbPerMonth(egressBytesPerSec: number): number {
  return (egressBytesPerSec * SECONDS_PER_MONTH) / BYTES_PER_GB
}

function nodeCost(node: Node<NodeData>, metrics?: NodeMetrics): NodeCostBreakdown | null {
  const data = node.data
  const type = node.type ?? ''
  const provider = data.provider ?? 'generic'
  const cost = data.cost ?? {}
  const inRps = Math.max(0, metrics?.inRps ?? 0)
  const components: CostComponentResult[] = []

  const spec = getServiceSpec(type, provider)

  if (spec) {
    const realProvider = provider as RealProvider
    for (const comp of spec.pricing) {
      switch (comp.kind) {
        case 'instanceHourly': {
          const count = cost.instanceCount ?? comp.defaultCount
          const rate = cost.instanceRateUsdHr ?? comp.defaultRateUsdHr
          components.push({ kind: comp.kind, label: comp.label, monthlyUsd: count * rate * HOURS_PER_MONTH })
          break
        }
        case 'requestsPerMillion': {
          const reqPerMonth = inRps * SECONDS_PER_MONTH
          components.push({ kind: comp.kind, label: comp.label, monthlyUsd: (reqPerMonth / 1e6) * comp.usdPerMillion })
          break
        }
        case 'egress': {
          // Dynamic egress: bill the live bandwidth the particle engine measured for this node
          // (sampled per-request payloads → bytes/sec), projected to a month. Applies to any node
          // with an egress component (DBs, compute, gateways, …) — no internet-facing gate.
          const bytesPerSec = Math.max(0, metrics?.egressBytesPerSec ?? 0)
          const gbMonth = egressGbPerMonth(bytesPerSec)
          components.push({ kind: comp.kind, label: comp.label, monthlyUsd: egressMonthlyCost(realProvider, gbMonth) })
          break
        }
        case 'storageGbMonth': {
          const tier = comp.tiers.find(t => t.id === cost.storageTierId) ?? comp.tiers[0]
          const gb = cost.storageGb ?? 0
          components.push({ kind: comp.kind, label: `${comp.label} (${tier.label})`, monthlyUsd: gb * tier.storageGbMonth })
          break
        }
        case 'fixedMonthly': {
          components.push({ kind: comp.kind, label: comp.label, monthlyUsd: comp.usd })
          break
        }
      }
    }
  } else if (cost.instanceRateUsdHr != null) {
    // Generic / unmapped node — still bill a user-supplied hourly rate if one was entered.
    const count = cost.instanceCount ?? 1
    components.push({ kind: 'instanceHourly', label: 'Instance', monthlyUsd: count * cost.instanceRateUsdHr * HOURS_PER_MONTH })
  }

  if (components.length === 0) return null

  const monthlyUsd = components.reduce((s, c) => s + c.monthlyUsd, 0)
  return {
    nodeId: node.id,
    nodeLabel: data.label || type,
    serviceName: spec?.serviceName ?? 'Custom',
    hourlyUsd: monthlyUsd / HOURS_PER_MONTH,
    monthlyUsd,
    components,
  }
}

// Compute the full cost summary. `metrics` is the live (or final-run) per-node metric map;
// pass an empty map for a no-traffic estimate (storage/fixed/instance costs still apply).
export function computeCost(
  nodes: Node<NodeData>[],
  metrics: Map<string, NodeMetrics>,
): CostSummary {
  const perNode: NodeCostBreakdown[] = []
  for (const node of nodes) {
    const breakdown = nodeCost(node, metrics.get(node.id))
    if (breakdown) perNode.push(breakdown)
  }
  perNode.sort((a, b) => b.monthlyUsd - a.monthlyUsd)
  const totalMonthlyUsd = perNode.reduce((s, n) => s + n.monthlyUsd, 0)
  return {
    totalHourlyUsd: totalMonthlyUsd / HOURS_PER_MONTH,
    totalMonthlyUsd,
    perNode,
  }
}

// Compact currency formatter for UI ($0.00, $12.3k, etc.).
export function formatUsd(n: number): string {
  if (!isFinite(n)) return '$0'
  if (n >= 1000) return `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
  if (n >= 1) return `$${n.toFixed(2)}`
  if (n === 0) return '$0'
  return `$${n.toFixed(4)}`
}
