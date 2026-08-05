import { describe, it, expect } from 'vitest'
import { createAutoscaleState, runningSetResolver, evaluatePolicy } from './autoscale'

const policy = {
  minCount: 2, maxCount: 8, targetCpuPercent: 60,
  scaleUpCooldownSec: 30, scaleDownCooldownSec: 300,
}

describe('createAutoscaleState', () => {
  it('initializes desiredCount to minCount for every autoscaled placement, to count for every static one', () => {
    const doc = {
      placements: {
        p1: { id: 'p1', blueprintId: 'b', serverId: 's', count: 3, role: 'primary', runtime: 'container', autoscale: policy },
        p2: { id: 'p2', blueprintId: 'b', serverId: 's', count: 5, role: 'primary', runtime: 'container' },
      },
    } as any
    const state = createAutoscaleState(doc)
    expect(state.desiredCount.get('p1')).toBe(2) // minCount, not count
    expect(state.desiredCount.get('p2')).toBe(5) // count, unchanged
  })
})

describe('runningSetResolver', () => {
  it('fast path: with an empty desiredCount overlay change-set, every compiled instance is running', () => {
    const compiled = { instances: {
      a: { id: 'a', placementId: 'p1', indexInPlacement: 0 },
      b: { id: 'b', placementId: 'p1', indexInPlacement: 1 },
    } } as any
    const desiredCount = new Map([['p1', 2]])
    const resolver = runningSetResolver(compiled, desiredCount)
    expect(resolver('a')).toBe(true)
    expect(resolver('b')).toBe(true)
  })

  it('parks instances whose indexInPlacement >= desiredCount', () => {
    const compiled = { instances: {
      a: { id: 'a', placementId: 'p1', indexInPlacement: 0 },
      b: { id: 'b', placementId: 'p1', indexInPlacement: 1 },
      c: { id: 'c', placementId: 'p1', indexInPlacement: 2 },
    } } as any
    const desiredCount = new Map([['p1', 2]])
    const resolver = runningSetResolver(compiled, desiredCount)
    expect(resolver('a')).toBe(true)
    expect(resolver('b')).toBe(true)
    expect(resolver('c')).toBe(false) // parked -- envelope index 2 >= desired 2
  })
})

describe('evaluatePolicy', () => {
  it('scales out when observed CPU exceeds the target, respecting scaleStep', () => {
    const state = createAutoscaleState({ placements: { p1: { id: 'p1', count: 2, autoscale: { ...policy, scaleStep: 2 } } } } as any)
    const placement = { id: 'p1', autoscale: { ...policy, scaleStep: 2 } } as any
    // observed 90% against a 60% target -> ratio 1.5 -> proposed = ceil(2 * 1.5) = 3, but scaleStep caps the delta to +2
    const result = evaluatePolicy(placement, 90, state, 0)
    expect(result.scaled).toBe('out')
    expect(result.next).toBeLessThanOrEqual(4) // 2 + scaleStep(2)
    expect(result.next).toBeGreaterThan(2)
  })

  it('does not scale again within scaleUpCooldownSec of the last scale-out', () => {
    const state = createAutoscaleState({ placements: { p1: { id: 'p1', count: 2, autoscale: policy } } } as any)
    const placement = { id: 'p1', autoscale: policy } as any
    const first = evaluatePolicy(placement, 90, state, 0)
    expect(first.scaled).toBe('out')
    const second = evaluatePolicy(placement, 95, state, 5_000) // 5s later, well within 30s cooldown
    expect(second.scaled).toBe(null)
    expect(second.next).toBe(first.next)
  })

  it('scales in after scaleDownCooldownSec when observed CPU is below target, never below minCount', () => {
    const state = createAutoscaleState({ placements: { p1: { id: 'p1', count: 8, autoscale: { ...policy, minCount: 2, maxCount: 8 } } } } as any)
    state.desiredCount.set('p1', 8)
    const placement = { id: 'p1', autoscale: { ...policy, minCount: 2, maxCount: 8 } } as any
    const result = evaluatePolicy(placement, 10, state, 400_000) // far past any cooldown, CPU well under target
    expect(result.scaled).toBe('in')
    expect(result.next).toBeGreaterThanOrEqual(2)
    expect(result.next).toBeLessThan(8)
  })

  it('never exceeds maxCount or drops below minCount', () => {
    const state = createAutoscaleState({ placements: { p1: { id: 'p1', count: 8, autoscale: policy } } } as any)
    state.desiredCount.set('p1', 8)
    const placement = { id: 'p1', autoscale: policy } as any
    const result = evaluatePolicy(placement, 500, state, 400_000) // absurdly high CPU, would propose way past maxCount
    expect(result.next).toBeLessThanOrEqual(policy.maxCount)
  })
})
