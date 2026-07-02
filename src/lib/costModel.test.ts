import { describe, it, expect } from 'vitest'
import type { Node } from '@xyflow/react'
import type { NodeData } from './nodeConfig'
import type { NodeMetrics } from '../app/store/simulation.store'
import { computeCost } from './costModel'

// A dbSql node priced through the AWS RDS/Aurora spec: instanceHourly + storageGbMonth + egress
// (see cloudRegistry.ts dbSql.aws pricing). instanceHourly and storageGbMonth are the "storage/
// compute cost components" GitHub #12 asks to scale by the modeled replica count (3); egress is
// intentionally NOT scaled (it's live-traffic-driven, not a per-replica cost).
function makeDbNode(overrides: Partial<NodeData> = {}): Node<NodeData> {
  return {
    id: 'db',
    type: 'dbSql',
    position: { x: 0, y: 0 },
    data: {
      label: 'db',
      subtitle: '',
      status: 'healthy',
      notes: '',
      warnings: [],
      provider: 'aws',
      cost: { instanceCount: 1, instanceRateUsdHr: 0.068, storageGb: 100, storageTierId: 'gp3' },
      ...overrides,
    },
  }
}

describe('replica-set cost scaling (consistencyLevel)', () => {
  it('a dbSql node with consistencyLevel set costs ~3x the same node without it', () => {
    const plain = makeDbNode()
    const replicated = makeDbNode({ simConfig: { consistencyLevel: 'QUORUM' } })
    const metrics = new Map<string, NodeMetrics>()

    const plainSummary = computeCost([plain], metrics)
    const replicatedSummary = computeCost([replicated], metrics)

    expect(plainSummary.perNode).toHaveLength(1)
    expect(replicatedSummary.perNode).toHaveLength(1)

    const plainMonthly = plainSummary.perNode[0].monthlyUsd
    const replicatedMonthly = replicatedSummary.perNode[0].monthlyUsd
    // No live traffic → no egress component, so total cost is purely instanceHourly + storageGbMonth,
    // both of which scale by the replica multiplier — expect ~exactly 3x, not just "more".
    expect(replicatedMonthly).toBeCloseTo(plainMonthly * 3, 5)
  })

  it('scales only the storage/compute components, not egress (which is traffic-driven, not per-replica)', () => {
    const metrics = new Map<string, NodeMetrics>([
      ['db', { inRps: 100, egressBytesPerSec: 1024 * 1024 } as NodeMetrics],
    ])
    const plain = makeDbNode()
    const replicated = makeDbNode({ simConfig: { consistencyLevel: 'ALL' } })

    const plainSummary = computeCost([plain], metrics)
    const replicatedSummary = computeCost([replicated], metrics)

    const plainEgress = plainSummary.perNode[0].components.find(c => c.kind === 'egress')?.monthlyUsd ?? 0
    const replicatedEgress = replicatedSummary.perNode[0].components.find(c => c.kind === 'egress')?.monthlyUsd ?? 0
    expect(replicatedEgress).toBeCloseTo(plainEgress, 5)

    const plainInstance = plainSummary.perNode[0].components.find(c => c.kind === 'instanceHourly')?.monthlyUsd ?? 0
    const replicatedInstance = replicatedSummary.perNode[0].components.find(c => c.kind === 'instanceHourly')?.monthlyUsd ?? 0
    expect(replicatedInstance).toBeCloseTo(plainInstance * 3, 5)
  })

  it('regression guard: a node without consistencyLevel set costs exactly what it did before this change', () => {
    const node = makeDbNode()
    const metrics = new Map<string, NodeMetrics>()
    const summary = computeCost([node], metrics)

    // Hand-computed expectation, independent of the replica-scaling code path: 1 instance @
    // $0.068/hr * 730 hr/month + 100GB * $0.115/GB-month (gp3 tier) + $0 egress (no traffic).
    const expectedInstance = 1 * 0.068 * 730
    const expectedStorage = 100 * 0.115
    expect(summary.perNode[0].monthlyUsd).toBeCloseTo(expectedInstance + expectedStorage, 5)
  })
})
