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
    // FEAT-014 (network topology): computeWorldCost reads doc.natGateways/subnets/azs
    // unconditionally now — a hand-built fixture predating that feature needs the empty
    // defaults too, matching every other WorldDoc collection above.
    vpcs: {},
    subnets: {},
    routeTables: {},
    internetGateways: {},
    natGateways: {},
    securityGroups: {},
  } as unknown as WorldDoc
}

function fakeCompiled(): CompiledWorld {
  return {
    instances: {},
    paths: [],
  } as unknown as CompiledWorld
}

// A fully-populated WorldMetrics slice — costModelV2's computeWorldCost (called from
// runSummary.ts's buildRunSummary) reads crossAzBytesPerSec/crossRegionBytesPerSec/
// internetEgressBytesPerSec for its egress cost line; leaving those undefined (the old fixture
// shape) produced `undefined * rate = NaN` cost figures that JSON.stringify silently lossy-
// serializes to `null` — which is exactly the kind of malformed shape I1's new importJson
// validation is designed to catch, so a NaN-producing fixture now (correctly) fails re-import.
function fakeWorldMetrics() {
  return {
    totalRps: 0, errorRate: 0, populationRoutes: [],
    crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0,
  }
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
        world: fakeWorldMetrics(),
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
        world: fakeWorldMetrics(),
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

  // I1 fix (final wave-5 review): a well-formed-JSON-but-wrong-shape import used to be pushed
  // straight into `summaries` with no validation, then crash uncaught inside ComparePanel's
  // MetricRow the moment it was selected. importJson now throws BEFORE mutating state.
  it('importJson rejects a wrong-shape summaries array and leaves the store unchanged', () => {
    useBaselineStore.getState().capture(fakeFrames(), fakeDoc(), fakeCompiled(), 'existing')
    const before = useBaselineStore.getState().summaries

    expect(() => useBaselineStore.getState().importJson(JSON.stringify({ summaries: [{ id: 'x' }] })))
      .toThrow()
    expect(useBaselineStore.getState().summaries).toEqual(before)

    expect(() => useBaselineStore.getState().importJson(JSON.stringify({ summaries: 'not-an-array' })))
      .toThrow()
    expect(useBaselineStore.getState().summaries).toEqual(before)

    expect(() => useBaselineStore.getState().importJson(JSON.stringify({
      summaries: [{ id: 'y', label: 'Y', latency: { p50Ms: 1, p90Ms: 2 }, cost: { meanHourlyUsd: 1, totalUsd: 1, peakHourlyUsd: 1 } }],
    }))).toThrow()   // latency.p99Ms missing
    expect(useBaselineStore.getState().summaries).toEqual(before)
  })

  it('importJson accepts a shape-valid summaries array', () => {
    const valid = {
      id: 'ok', label: 'OK', capturedIso: '2026-08-09T00:00:00.000Z', scenarioId: null, seed: 0,
      docFingerprint: 'fp', durationMs: 1000, latency: { p50Ms: 1, p90Ms: 2, p99Ms: 3 },
      errorRate: 0, peakRps: 10, cost: { meanHourlyUsd: 1, totalUsd: 1, peakHourlyUsd: 1 },
      slo: { target: {}, breaches: [] }, eventCounts: {},
    }
    useBaselineStore.getState().importJson(JSON.stringify({ summaries: [valid] }))
    expect(useBaselineStore.getState().summaries).toEqual([valid])
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
