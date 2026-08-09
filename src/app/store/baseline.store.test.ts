import { describe, it, expect, beforeEach } from 'vitest'
import { useBaselineStore } from './baseline.store'
import type { WorldDoc, CompiledWorld } from '../../lib/world/types'
import type { ReplayFrame } from '../../lib/worldEngine/types'

beforeEach(() => useBaselineStore.setState({ summaries: [], compareA: null, compareB: null }))

// Minimal fake data for testing — only fields needed by buildRunSummary
function fakeDoc(): WorldDoc {
  return {
    routing: {
      policy: 'latency',
      weights: {},
      priorityOrder: [],
      healthCheckIntervalMs: 10000,
      healthCheckFailureThreshold: 3,
      dnsTtlSec: 30,
    },
    populations: {},
    regions: {},
    azs: {},
    servers: {},
    blueprints: {},
    placements: {},
    managedServices: {},
    loadBalancers: {},
    racks: {},
    packets: { mode: 'generic', templates: {}, nextId: 1 },
    slo: undefined,
    scenario: null,
  } as unknown as WorldDoc
}

function fakeCompiled(): CompiledWorld {
  return {
    instances: {},
    paths: [],
  } as unknown as CompiledWorld
}

function fakeFrames(): ReplayFrame[] {
  return [
    {
      simMs: 0,
      batch: {
        instances: {},
        servers: {},
        azs: {},
        regions: {},
        world: {
          totalRps: 0,
          errorRate: 0,
          totalCostPerHour: 0,
        },
        managedServices: null,
      },
      events: [],
    },
    {
      simMs: 1000,
      batch: {
        instances: {},
        servers: {},
        azs: {},
        regions: {},
        world: {
          totalRps: 0,
          errorRate: 0,
          totalCostPerHour: 0,
        },
        managedServices: null,
      },
      events: [],
    },
  ] as unknown as ReplayFrame[]
}

describe('baseline.store', () => {
  it('captures, exports, clears, and re-imports byte-identically', () => {
    useBaselineStore.getState().capture(fakeFrames(), fakeDoc(), fakeCompiled(), 'run A')
    expect(useBaselineStore.getState().summaries).toHaveLength(1)
    const json = useBaselineStore.getState().exportJson()

    useBaselineStore.setState({ summaries: [] })
    useBaselineStore.getState().importJson(json)
    expect(useBaselineStore.getState().summaries).toEqual(JSON.parse(json).summaries)
  })

  it('remove() drops exactly the targeted summary and clears matching compare selections', () => {
    useBaselineStore.getState().capture(fakeFrames(), fakeDoc(), fakeCompiled(), 'A')
    useBaselineStore.getState().capture(fakeFrames(), fakeDoc(), fakeCompiled(), 'B')
    const [a, b] = useBaselineStore.getState().summaries
    useBaselineStore.getState().setCompareA(a.id)
    useBaselineStore.getState().remove(a.id)
    expect(useBaselineStore.getState().summaries.map(s => s.id)).toEqual([b.id])
    expect(useBaselineStore.getState().compareA).toBeNull()
  })
})
