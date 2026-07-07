import { describe, it, expect } from 'vitest'
import { WORKLOAD_TIER_RANGES, resolveWorkloadInstructions, COMPUTE_IPC } from './nodeConfig'

describe('workload tiers', () => {
  it('exposes IPC placeholder of 2.0', () => {
    expect(COMPUTE_IPC).toBe(2.0)
  })

  it('clamps a value into the selected tier range', () => {
    // simple_crud range is [0.001, 0.01]
    expect(resolveWorkloadInstructions('simple_crud', 5)).toBe(WORKLOAD_TIER_RANGES.simple_crud.max)
    expect(resolveWorkloadInstructions('simple_crud', 0)).toBe(WORKLOAD_TIER_RANGES.simple_crud.min)
    expect(resolveWorkloadInstructions('moderate_logic', 0.05)).toBe(0.05)
  })

  it('passes custom values through unclamped (but non-negative)', () => {
    expect(resolveWorkloadInstructions('custom', 42)).toBe(42)
    expect(resolveWorkloadInstructions('custom', -1)).toBe(0)
  })
})
