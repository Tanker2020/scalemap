import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectiveMultiplier, getChaosFailures, clearChaosState } from './chaos'
import type { Node } from '@xyflow/react'
import type { NodeData } from '../../../../lib/nodeConfig'

const noop = vi.fn()
const emptyNodesMap = new Map<string, Node<NodeData>>()

describe('chaos', () => {
  beforeEach(() => {
    clearChaosState()
    noop.mockClear()
  })

  it('steady mode returns the global multiplier unchanged', () => {
    const mult = effectiveMultiplier(0, 'steady', 3, 0, emptyNodesMap, noop)
    expect(mult).toBe(3)
  })

  it('ramp mode scales from 0 up to the global multiplier over the ramp window', () => {
    const early = effectiveMultiplier(0, 'ramp', 2, 0, emptyNodesMap, noop)
    expect(early).toBe(0)
    const full = effectiveMultiplier(0, 'ramp', 2, 200_000, emptyNodesMap, noop)
    expect(full).toBe(2) // clamped at 1x once past the 120s ramp window
  })

  it('spike mode starts outside a spike burst (multiplier == base)', () => {
    const mult = effectiveMultiplier(0, 'spike', 1, 0, emptyNodesMap, noop)
    expect(mult).toBe(1)
  })

  it('getChaosFailures starts empty and clearChaosState resets it after mutation', () => {
    expect(getChaosFailures().size).toBe(0)
    getChaosFailures().set('node-1', { expiry: 1000, mode: 'crash', dropRate: 1 })
    expect(getChaosFailures().size).toBe(1)
    clearChaosState()
    expect(getChaosFailures().size).toBe(0)
  })
})
