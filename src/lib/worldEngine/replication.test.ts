import { describe, it, expect } from 'vitest'
import {
  createReplicationState, stepReplication, localityFloorSec, staleReadFraction,
} from './replication'
import { interRegionLatencyMs } from '../regionConfig'

describe('localityFloorSec', () => {
  it('is 5ms same-AZ, 20ms cross-AZ, and interRegionLatencyMs/1000 cross-region', () => {
    expect(localityFloorSec('same-az')).toBeCloseTo(0.005, 5)
    expect(localityFloorSec('cross-az')).toBeCloseTo(0.02, 5)
    // cross-region uses the real interRegionLatencyMs(from, to) -- assert against that function
    // directly so the two never diverge, not against a hardcoded number:
    expect(localityFloorSec('cross-region', 'us-east-1', 'eu-west-1'))
      .toBeCloseTo(interRegionLatencyMs('us-east-1', 'eu-west-1') / 1000, 5)
  })
})

describe('stepReplication', () => {
  it('backlog grows monotonically when writeRps exceeds applyCapacity', () => {
    const state = createReplicationState()
    const clusterId = 'blueprint-a|region-1'
    const replica = { id: 'inst-r1', locality: 'cross-az' as const, applyCapacity: 100 }
    stepReplication(state, { [clusterId]: [replica] }, { [clusterId]: 200 }, 1)
    const lag1 = state.lagSecByInstance.get('inst-r1')!
    stepReplication(state, { [clusterId]: [replica] }, { [clusterId]: 200 }, 1)
    const lag2 = state.lagSecByInstance.get('inst-r1')!
    expect(lag2).toBeGreaterThan(lag1)
  })

  it('drains back toward the locality floor when write load drops below apply capacity', () => {
    const state = createReplicationState()
    const clusterId = 'blueprint-a|region-1'
    const replica = { id: 'inst-r1', locality: 'same-az' as const, applyCapacity: 100 }
    for (let i = 0; i < 10; i++) stepReplication(state, { [clusterId]: [replica] }, { [clusterId]: 200 }, 1)
    const grown = state.lagSecByInstance.get('inst-r1')!
    for (let i = 0; i < 50; i++) stepReplication(state, { [clusterId]: [replica] }, { [clusterId]: 0 }, 1)
    const drained = state.lagSecByInstance.get('inst-r1')!
    expect(drained).toBeLessThan(grown)
    expect(drained).toBeCloseTo(0.005, 2) // back near the same-AZ floor
  })

  it('at zero write load, lag equals exactly the locality floor', () => {
    const state = createReplicationState()
    const clusterId = 'c'
    const replica = { id: 'r1', locality: 'cross-az' as const, applyCapacity: 100 }
    stepReplication(state, { [clusterId]: [replica] }, { [clusterId]: 0 }, 1)
    expect(state.lagSecByInstance.get('r1')).toBeCloseTo(0.02, 5)
  })
})

describe('staleReadFraction', () => {
  it('matches the Poisson collision formula to the digit', () => {
    // 100 writes/sec, 2s lag, 1000 hot keys -> ~18%
    const f = staleReadFraction(100, 2, 1000)
    expect(f).toBeCloseTo(1 - Math.exp(-(100 * 2) / 1000), 10)
    expect(f).toBeCloseTo(0.1813, 3)
  })

  it('is 0 at zero lag', () => {
    expect(staleReadFraction(100, 0, 1000)).toBe(0)
  })
})
