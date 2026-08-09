import { describe, it, expect } from 'vitest'
import { createRoutingState, resolveRegion, runHealthChecks, azSplit, pickInstance, distributeToTargets } from './routingRuntime'
import { createRng } from './rng'
import type { RoutingConfig, PlacementRole } from '../world/types'
import type { HealthState } from './types'

const basePolicy = (overrides: Partial<RoutingConfig> = {}): RoutingConfig => ({
  policy: 'priority',
  weights: {},
  priorityOrder: [],
  healthCheckIntervalMs: 10_000,
  healthCheckFailureThreshold: 3,
  dnsTtlSec: 30,
  ...overrides,
})

describe('distributeToTargets (regional LB distribution)', () => {
  const healthy = () => 'healthy' as HealthState
  // az1 holds two target instances, az2 holds one (deliberately unequal to distinguish modes).
  const azBlueprintTargets = { az1: { bp: ['i-a0', 'i-a1'] }, az2: { bp: ['i-b0'] } }
  const regionAzSpread = ['az1', 'az2']

  it('cross-zone off splits equally per AZ (entry-node = serving-AZ)', () => {
    const into: Record<string, number> = {}
    distributeToTargets({
      targetBlueprintIds: ['bp'], rps: 100, crossZone: false,
      regionAzSpread, azBlueprintTargets,
      healthOfScope: healthy, healthOfInstance: healthy, cursors: createRoutingState(), into,
    })
    // each AZ node takes 50; az1's round-robin pick claims its whole 50, az2's instance takes 50
    expect(into['i-a0']).toBe(50)
    expect(into['i-b0']).toBe(50)
    expect(into['i-a1'] ?? 0).toBe(0)   // second az1 instance not picked this step
  })

  it('cross-zone on splits evenly across ALL region target instances', () => {
    const into: Record<string, number> = {}
    distributeToTargets({
      targetBlueprintIds: ['bp'], rps: 90, crossZone: true,
      regionAzSpread, azBlueprintTargets,
      healthOfScope: healthy, healthOfInstance: healthy, cursors: createRoutingState(), into,
    })
    // 3 healthy targets region-wide → 30 each (az1 total 60, az2 total 30)
    expect(into).toEqual({ 'i-a0': 30, 'i-a1': 30, 'i-b0': 30 })
  })

  it('excludes down AZs from the split', () => {
    const into: Record<string, number> = {}
    const scope = (id: string) => (id === 'az2' ? 'down' : 'healthy') as HealthState
    distributeToTargets({
      targetBlueprintIds: ['bp'], rps: 100, crossZone: false,
      regionAzSpread, azBlueprintTargets,
      healthOfScope: scope, healthOfInstance: healthy, cursors: createRoutingState(), into,
    })
    expect(into['i-a0']).toBe(100)      // only az1 healthy → it takes the whole 100
    expect(into['i-b0'] ?? 0).toBe(0)
  })

  // The target service placed in only ONE of the region's AZs, cross-zone off: the empty AZ is
  // pulled from the LB's rotation (AWS drops a zone with no healthy targets out of DNS), so its
  // share REDISTRIBUTES to the AZ that can serve — nothing is dropped.
  it('cross-zone off redistributes the empty-AZ share to the serving AZ, dropping nothing', () => {
    const into: Record<string, number> = {}
    const droppedByAz: Record<string, number> = {}
    // Only az1 hosts the target blueprint; az2 has none, so az2 leaves the split entirely.
    distributeToTargets({
      targetBlueprintIds: ['bp'], rps: 500, crossZone: false,
      regionAzSpread, azBlueprintTargets: { az1: { bp: ['i-a0'] } },
      healthOfScope: healthy, healthOfInstance: healthy, cursors: createRoutingState(), into, droppedByAz,
    })
    expect(into['i-a0']).toBe(500)       // az1 is the only serving AZ → it takes the whole ingress
    expect(droppedByAz['az2'] ?? 0).toBe(0)
    expect(droppedByAz['az1'] ?? 0).toBe(0)
    expect(Object.values(droppedByAz).reduce((a, b) => a + b, 0)).toBe(0) // nothing forfeited
  })

  it('reports the full rps as dropped when the target group is empty (spread across region AZs)', () => {
    const droppedByAz: Record<string, number> = {}
    distributeToTargets({
      targetBlueprintIds: [], rps: 300, crossZone: false,
      regionAzSpread, azBlueprintTargets, healthOfScope: healthy, healthOfInstance: healthy,
      cursors: createRoutingState(), into: {}, droppedByAz,
    })
    expect(Object.values(droppedByAz).reduce((a, b) => a + b, 0)).toBeCloseTo(300, 6)
  })

  // A placed instance that is DOWN is also an undeliverable share (real NLB connection failures).
  it('cross-zone off reports a per-blueprint share dropped when its only instance here is down', () => {
    const into: Record<string, number> = {}
    const droppedByAz: Record<string, number> = {}
    const instHealth = (id: string) => (id === 'i-a0' ? 'down' : 'healthy') as HealthState
    distributeToTargets({
      targetBlueprintIds: ['bp'], rps: 100, crossZone: false,
      regionAzSpread: ['az1'], azBlueprintTargets: { az1: { bp: ['i-a0'] } },
      healthOfScope: healthy, healthOfInstance: instHealth, cursors: createRoutingState(), into, droppedByAz,
    })
    expect(into['i-a0'] ?? 0).toBe(0)
    expect(droppedByAz['az1']).toBe(100)
  })

  it('weighted + cross-zone off splits per-AZ share by weight, not equally', () => {
    const into: Record<string, number> = {}
    distributeToTargets({
      targetBlueprintIds: ['bp'], rps: 100, crossZone: false, weighted: true,
      azWeights: { az1: 3, az2: 1 },
      regionAzSpread, azBlueprintTargets,
      healthOfScope: healthy, healthOfInstance: healthy, cursors: createRoutingState(), into,
    })
    // az1 gets 75% of 100 (round-robin claims it on one instance), az2 gets 25%.
    expect(into['i-a0']).toBe(75)
    expect(into['i-b0']).toBe(25)
  })

  it('weighted + cross-zone on splits each AZ total by weight, then evenly across its own targets', () => {
    const into: Record<string, number> = {}
    distributeToTargets({
      targetBlueprintIds: ['bp'], rps: 100, crossZone: true, weighted: true,
      azWeights: { az1: 1, az2: 1 },
      regionAzSpread, azBlueprintTargets,
      healthOfScope: healthy, healthOfInstance: healthy, cursors: createRoutingState(), into,
    })
    // Equal AZ weights → az1's 50 splits across its 2 instances (25 each), az2's 50 goes whole
    // to its 1 instance — unlike the unweighted flat split, instance COUNT no longer skews this.
    expect(into).toEqual({ 'i-a0': 25, 'i-a1': 25, 'i-b0': 50 })
  })

  it('weighted with an all-zero weight set falls back to an equal split', () => {
    const into: Record<string, number> = {}
    distributeToTargets({
      targetBlueprintIds: ['bp'], rps: 100, crossZone: false, weighted: true,
      azWeights: { az1: 0, az2: 0 },
      regionAzSpread, azBlueprintTargets,
      healthOfScope: healthy, healthOfInstance: healthy, cursors: createRoutingState(), into,
    })
    expect(into['i-a0']).toBe(50)
    expect(into['i-b0']).toBe(50)
  })
})

// Task 13: canaryWeight activation. `roleOf`/`canaryWeightOf` are both optional trailing inputs —
// every test above never passes them, which is itself the regression-floor proof (those tests are
// untouched and still pass byte-for-byte). This block covers the canary-aware behavior directly.
describe('distributeToTargets — canary routing (Task 13)', () => {
  const healthy = () => 'healthy' as HealthState
  const roleOf = (id: string): PlacementRole => (id.includes('canary') ? 'canary' : 'primary')
  const canaryWeightOf = (weight: number) => (id: string): number | undefined =>
    id.includes('canary') ? weight : undefined

  it('a target list with no canary-role instance is byte-identical whether or not roleOf/canaryWeightOf are supplied (regression floor)', () => {
    const azBlueprintTargets = { az1: { bp: ['i-a0', 'i-a1'] }, az2: { bp: ['i-b0'] } }
    const withoutCanaryFns: Record<string, number> = {}
    distributeToTargets({
      targetBlueprintIds: ['bp'], rps: 100, crossZone: false,
      regionAzSpread: ['az1', 'az2'], azBlueprintTargets,
      healthOfScope: healthy, healthOfInstance: healthy, cursors: createRoutingState(), into: withoutCanaryFns,
    })
    const withCanaryFns: Record<string, number> = {}
    distributeToTargets({
      targetBlueprintIds: ['bp'], rps: 100, crossZone: false,
      regionAzSpread: ['az1', 'az2'], azBlueprintTargets,
      healthOfScope: healthy, healthOfInstance: healthy, cursors: createRoutingState(), into: withCanaryFns,
      roleOf, canaryWeightOf: canaryWeightOf(0.05),
    })
    expect(withCanaryFns).toEqual(withoutCanaryFns)
  })

  it('crossZone off: a single-call split assigns exactly canaryWeight of a blueprint/AZ share to the canary instance', () => {
    const into: Record<string, number> = {}
    distributeToTargets({
      targetBlueprintIds: ['bp'], rps: 1000, crossZone: false,
      regionAzSpread: ['az1'],
      azBlueprintTargets: { az1: { bp: ['i-a0', 'i-a1', 'i-a2', 'i-a3', 'i-canary'] } },
      healthOfScope: healthy, healthOfInstance: healthy, cursors: createRoutingState(), into,
      roleOf, canaryWeightOf: canaryWeightOf(0.05),
    })
    expect(into['i-canary']).toBe(50)
    const mainTotal = Object.entries(into).filter(([k]) => k !== 'i-canary').reduce((sum, [, v]) => sum + v, 0)
    expect(mainTotal).toBe(950)
  })

  it('crossZone off: repeated calls round-robin the main group and the canary group on independent cursors', () => {
    const into: Record<string, number> = {}
    const cursors = createRoutingState()
    const targets = { az1: { bp: ['i-a0', 'i-a1', 'i-canary0', 'i-canary1'] } }
    for (let i = 0; i < 8; i++) {
      distributeToTargets({
        targetBlueprintIds: ['bp'], rps: 100, crossZone: false,
        regionAzSpread: ['az1'], azBlueprintTargets: targets,
        healthOfScope: healthy, healthOfInstance: healthy, cursors, into,
        roleOf, canaryWeightOf: canaryWeightOf(0.5),
      })
    }
    // 8 calls x (main=50, canary=50): main alternates i-a0/i-a1 (4 hits each x50=200), canary
    // alternates i-canary0/i-canary1 (4 hits each x50=200) — independent round-robin cursors.
    expect(into).toEqual({ 'i-a0': 200, 'i-a1': 200, 'i-canary0': 200, 'i-canary1': 200 })
  })

  it('crossZone on (unweighted): the flat region-wide split routes canaryWeight of rps to the canary subset', () => {
    const into: Record<string, number> = {}
    const azBlueprintTargets = {
      az1: { bp: ['i-a0', 'i-a1'] },
      az2: { bp: ['i-b0', 'i-canary'] },
    }
    distributeToTargets({
      targetBlueprintIds: ['bp'], rps: 1000, crossZone: true,
      regionAzSpread: ['az1', 'az2'], azBlueprintTargets,
      healthOfScope: healthy, healthOfInstance: healthy, cursors: createRoutingState(), into,
      roleOf, canaryWeightOf: canaryWeightOf(0.05),
    })
    expect(into['i-canary']).toBe(50)
    // Remaining 950 split evenly across the 3 main instances.
    expect(into['i-a0']).toBeCloseTo(950 / 3, 6)
    expect(into['i-a1']).toBeCloseTo(950 / 3, 6)
    expect(into['i-b0']).toBeCloseTo(950 / 3, 6)
  })

  it('crossZone on + weighted AZ split: canary partition applies within each AZ after its own AZ-weight share', () => {
    const into: Record<string, number> = {}
    const azBlueprintTargets = {
      az1: { bp: ['i-a0', 'i-canary'] },
      az2: { bp: ['i-b0'] },
    }
    distributeToTargets({
      targetBlueprintIds: ['bp'], rps: 1000, crossZone: true, weighted: true,
      azWeights: { az1: 1, az2: 1 },
      regionAzSpread: ['az1', 'az2'], azBlueprintTargets,
      healthOfScope: healthy, healthOfInstance: healthy, cursors: createRoutingState(), into,
      roleOf, canaryWeightOf: canaryWeightOf(0.1),
    })
    // az1 gets 500 (equal AZ weights); its own canary split takes 10% = 50 for i-canary, 450 for i-a0.
    expect(into['i-canary']).toBe(50)
    expect(into['i-a0']).toBe(450)
    expect(into['i-b0']).toBe(500) // az2 has no canary — untouched
  })

  it('no canary placement present (canaryWeightOf returns undefined for everyone) leaves behavior unchanged', () => {
    const into: Record<string, number> = {}
    const azBlueprintTargets = { az1: { bp: ['i-a0', 'i-a1'] } }
    distributeToTargets({
      targetBlueprintIds: ['bp'], rps: 100, crossZone: true, azBlueprintTargets,
      regionAzSpread: ['az1'],
      healthOfScope: healthy, healthOfInstance: healthy, cursors: createRoutingState(), into,
      roleOf: () => 'primary', canaryWeightOf: () => undefined,
    })
    expect(into).toEqual({ 'i-a0': 50, 'i-a1': 50 })
  })
})

describe('pickInstance — canary cursor key (Task 13)', () => {
  it('a canary-suffixed blueprint key round-robins independently of the plain blueprint key', () => {
    const state = createRoutingState()
    const healthyOf = (): HealthState => 'healthy'
    expect(pickInstance(state, 'az-1', 'bp-1', ['i-1', 'i-2'], healthyOf)).toBe('i-1')
    expect(pickInstance(state, 'az-1', 'bp-1:canary', ['i-c1', 'i-c2'], healthyOf)).toBe('i-c1')
    expect(pickInstance(state, 'az-1', 'bp-1', ['i-1', 'i-2'], healthyOf)).toBe('i-2') // own cursor advanced
    expect(pickInstance(state, 'az-1', 'bp-1:canary', ['i-c1', 'i-c2'], healthyOf)).toBe('i-c2')
  })
})

describe('resolveRegion', () => {
  it('picks the first healthy region in order on a fresh cache', () => {
    const state = createRoutingState()
    const rng = createRng(1)
    const healthOf = (): HealthState => 'healthy'
    const region = resolveRegion(state, 'pop-1', ['A', 'B'], healthOf, basePolicy(), 0, rng)
    expect(region).toBe('A')
  })

  it('honors the TTL cache: a region gone down stays targeted until expiry (the observable lag)', () => {
    const state = createRoutingState()
    const rng = createRng(1)
    let aHealth: HealthState = 'healthy'
    const healthOf = (id: string): HealthState => (id === 'A' ? aHealth : 'healthy')
    const policy = basePolicy({ dnsTtlSec: 30 })

    expect(resolveRegion(state, 'pop-1', ['A', 'B'], healthOf, policy, 0, rng)).toBe('A')
    aHealth = 'down'
    // still within TTL (30s) — cache returns 'A' even though it is now down
    expect(resolveRegion(state, 'pop-1', ['A', 'B'], healthOf, policy, 5_000, rng)).toBe('A')
    expect(resolveRegion(state, 'pop-1', ['A', 'B'], healthOf, policy, 29_999, rng)).toBe('A')
    // TTL expired — re-resolves, skipping the down region
    expect(resolveRegion(state, 'pop-1', ['A', 'B'], healthOf, policy, 30_000, rng)).toBe('B')
  })

  it('returns null when every candidate region is down', () => {
    const state = createRoutingState()
    const rng = createRng(1)
    const healthOf = (): HealthState => 'down'
    expect(resolveRegion(state, 'pop-1', ['A', 'B'], healthOf, basePolicy(), 0, rng)).toBeNull()
  })

  it('passive-last activation: only reached once every earlier region in the order is down', () => {
    const state = createRoutingState()
    const rng = createRng(1)
    // orderedRegions already carries active-before-passive ordering (compileWorld's job)
    const order = ['active-1', 'active-2', 'passive-1']
    const down = new Set(['active-1', 'active-2'])
    const healthOf = (id: string): HealthState => (down.has(id) ? 'down' : 'healthy')
    expect(resolveRegion(state, 'pop-1', order, healthOf, basePolicy(), 0, rng)).toBe('passive-1')
  })

  it('weighted policy draws proportionally to configured weights over many independent resolutions', () => {
    const rng = createRng(42)
    const policy = basePolicy({ policy: 'weighted', weights: { A: 3, B: 1 }, dnsTtlSec: 30 })
    const healthOf = (): HealthState => 'healthy'
    let countA = 0
    let countB = 0
    for (let i = 0; i < 2000; i++) {
      // fresh state + a distinct popId per draw so the TTL cache never short-circuits it
      const state = createRoutingState()
      const region = resolveRegion(state, `pop-${i}`, ['A', 'B'], healthOf, policy, 0, rng)
      if (region === 'A') countA++
      else if (region === 'B') countB++
    }
    // expected ~1500/500 (75%/25%); generous tolerance for a seeded stochastic draw
    expect(countA).toBeGreaterThan(1300)
    expect(countA).toBeLessThan(1700)
    expect(countB).toBe(2000 - countA)
  })
})

describe('runHealthChecks', () => {
  it('marks checkFailed only after consecutive failures reach the threshold', () => {
    const state = createRoutingState()
    const config = basePolicy({ healthCheckIntervalMs: 1_000, healthCheckFailureThreshold: 3 })
    let results = runHealthChecks(state, config, 0, [{ id: 'srv-1', health: 'down' }])
    expect(results).toEqual([{ id: 'srv-1', checkFailed: false }]) // 1 failure
    results = runHealthChecks(state, config, 1_000, [{ id: 'srv-1', health: 'down' }])
    expect(results).toEqual([{ id: 'srv-1', checkFailed: false }]) // 2 failures, still below threshold 3
    results = runHealthChecks(state, config, 2_000, [{ id: 'srv-1', health: 'down' }])
    expect(results).toEqual([{ id: 'srv-1', checkFailed: true }]) // 3 failures, threshold reached
  })

  // Audit ISSUE-020 (intentional behavior change): a SINGLE healthy probe no longer wipes the
  // failure counter — clearing requires healthCheckHealthyThreshold consecutive successes.
  it('one healthy probe does not reset failures; the healthy-threshold run does', () => {
    const state = createRoutingState()
    const config = basePolicy({ healthCheckIntervalMs: 1_000, healthCheckFailureThreshold: 2 })
    runHealthChecks(state, config, 0, [{ id: 'srv-1', health: 'down' }])          // 1 failure
    runHealthChecks(state, config, 1_000, [{ id: 'srv-1', health: 'healthy' }])   // 1 success < threshold 2
    // Failure count survived the single success → this failure reaches the fall threshold.
    const flapped = runHealthChecks(state, config, 2_000, [{ id: 'srv-1', health: 'down' }])
    expect(flapped).toEqual([{ id: 'srv-1', checkFailed: true }])

    // Two consecutive successes clear it (default healthy threshold = 2).
    runHealthChecks(state, config, 3_000, [{ id: 'srv-1', health: 'healthy' }])
    runHealthChecks(state, config, 4_000, [{ id: 'srv-1', health: 'healthy' }])
    const recovered = runHealthChecks(state, config, 5_000, [{ id: 'srv-1', health: 'down' }])
    expect(recovered).toEqual([{ id: 'srv-1', checkFailed: false }])   // fresh count: 1 < 2
  })

  it('a scope alternating pass/fail ratchets to failed instead of never tripping', () => {
    const state = createRoutingState()
    const config = basePolicy({ healthCheckIntervalMs: 1_000, healthCheckFailureThreshold: 3 })
    let last: { id: string; checkFailed: boolean }[] = []
    for (let i = 0; i < 6; i++) {
      const health = i % 2 === 0 ? 'down' : 'healthy'
      last = runHealthChecks(state, config, i * 1_000, [{ id: 'srv-1', health }])
    }
    // fail/pass/fail/pass/fail/pass — failures ratchet 1,1,2,2,3,3 → tripped at the 5th check.
    expect(last).toEqual([{ id: 'srv-1', checkFailed: true }])
  })

  it('honors an authored healthCheckHealthyThreshold', () => {
    const state = createRoutingState()
    const config = basePolicy({
      healthCheckIntervalMs: 1_000, healthCheckFailureThreshold: 2, healthCheckHealthyThreshold: 3,
    })
    runHealthChecks(state, config, 0, [{ id: 'srv-1', health: 'down' }])
    runHealthChecks(state, config, 1_000, [{ id: 'srv-1', health: 'down' }])          // failed (2)
    runHealthChecks(state, config, 2_000, [{ id: 'srv-1', health: 'healthy' }])
    const twoOfThree = runHealthChecks(state, config, 3_000, [{ id: 'srv-1', health: 'healthy' }])
    expect(twoOfThree).toEqual([{ id: 'srv-1', checkFailed: true }])   // 2 successes < threshold 3
    const recovered = runHealthChecks(state, config, 4_000, [{ id: 'srv-1', health: 'healthy' }])
    expect(recovered).toEqual([{ id: 'srv-1', checkFailed: false }])
  })

  it('the interval gate skips extra checks — repeated calls within one interval only count once', () => {
    const state = createRoutingState()
    const config = basePolicy({ healthCheckIntervalMs: 10_000, healthCheckFailureThreshold: 5 })
    for (let t = 0; t < 5; t++) {
      runHealthChecks(state, config, t * 100, [{ id: 'srv-1', health: 'down' }]) // all within one interval
    }
    // only the first call (t=0) should have counted — 1 failure, well below threshold 5
    const results = runHealthChecks(state, config, 400, [{ id: 'srv-1', health: 'down' }])
    expect(results).toEqual([{ id: 'srv-1', checkFailed: false }])
  })
})

describe('azSplit', () => {
  it('keeps healthy and degraded AZs, drops down ones', () => {
    const health: Record<string, HealthState> = { a: 'healthy', b: 'down', c: 'degraded' }
    expect(azSplit(['a', 'b', 'c'], id => health[id])).toEqual(['a', 'c'])
  })

  it('returns [] when every AZ is down', () => {
    expect(azSplit(['a', 'b'], () => 'down')).toEqual([])
  })
})

describe('pickInstance', () => {
  it('round-robins across healthy targets and wraps around', () => {
    const state = createRoutingState()
    const targets = ['i-1', 'i-2', 'i-3']
    const healthyOf = (): HealthState => 'healthy'
    const picks = Array.from({ length: 7 }, () => pickInstance(state, 'az-1', 'bp-1', targets, healthyOf))
    expect(picks).toEqual(['i-1', 'i-2', 'i-3', 'i-1', 'i-2', 'i-3', 'i-1'])
  })

  it('keeps a separate cursor per (az, blueprint) pair', () => {
    const state = createRoutingState()
    const targets = ['i-1', 'i-2']
    const healthyOf = (): HealthState => 'healthy'
    expect(pickInstance(state, 'az-1', 'bp-1', targets, healthyOf)).toBe('i-1')
    expect(pickInstance(state, 'az-1', 'bp-2', targets, healthyOf)).toBe('i-1') // different blueprint, own cursor
    expect(pickInstance(state, 'az-1', 'bp-1', targets, healthyOf)).toBe('i-2') // bp-1's cursor advanced independently
  })

  it('skips down instances and returns null when none are healthy', () => {
    const state = createRoutingState()
    const health: Record<string, HealthState> = { 'i-1': 'down', 'i-2': 'healthy' }
    const healthyOf = (id: string): HealthState => health[id]
    expect(pickInstance(state, 'az-1', 'bp-1', ['i-1', 'i-2'], healthyOf)).toBe('i-2')
    expect(pickInstance(state, 'az-1', 'bp-2', ['i-1'], healthyOf)).toBeNull()
  })
})
