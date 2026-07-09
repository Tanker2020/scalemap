import { describe, it, expect } from 'vitest'
import { createRoutingState, resolveRegion, runHealthChecks, azSplit, pickInstance } from './routingRuntime'
import { createRng } from './rng'
import type { RoutingConfig } from '../world/types'
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

  it('a healthy result resets the consecutive-failure counter', () => {
    const state = createRoutingState()
    const config = basePolicy({ healthCheckIntervalMs: 1_000, healthCheckFailureThreshold: 2 })
    runHealthChecks(state, config, 0, [{ id: 'srv-1', health: 'down' }])
    runHealthChecks(state, config, 1_000, [{ id: 'srv-1', health: 'healthy' }])
    const results = runHealthChecks(state, config, 2_000, [{ id: 'srv-1', health: 'down' }])
    expect(results).toEqual([{ id: 'srv-1', checkFailed: false }])
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
