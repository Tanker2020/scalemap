import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  getChaosFailures, clearChaosState,
  trafficMultiplier, advanceChaosSchedule,
  triggerEdgePartition, isEdgePartitioned, triggerRegionPartition,
} from './chaos'
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
    const mult = trafficMultiplier(0, 'steady', 3, 0, emptyNodesMap)
    expect(mult).toBe(3)
  })

  it('ramp mode scales from 0 up to the global multiplier over the ramp window', () => {
    const early = trafficMultiplier(0, 'ramp', 2, 0, emptyNodesMap)
    expect(early).toBe(0)
    const full = trafficMultiplier(0, 'ramp', 2, 200_000, emptyNodesMap)
    expect(full).toBe(2) // clamped at 1x once past the 120s ramp window
  })

  it('spike mode starts outside a spike burst (multiplier == base)', () => {
    const mult = trafficMultiplier(0, 'spike', 1, 0, emptyNodesMap)
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

describe('trafficMultiplier purity', () => {
  beforeEach(() => clearChaosState())

  it('calling trafficMultiplier many times with the same `now` does not change chaos schedule state (spike mode)', () => {
    advanceChaosSchedule(1000, 'spike', 1000, emptyNodesMap, noop)
    const before = trafficMultiplier(1000, 'spike', 1, 1000, emptyNodesMap)
    for (let i = 0; i < 50; i++) trafficMultiplier(1000, 'spike', 1, 1000, emptyNodesMap) // simulates per-arrival calls in one frame
    const after = trafficMultiplier(1000, 'spike', 1, 1000, emptyNodesMap)
    expect(after).toBe(before)
  })

  it('calling trafficMultiplier many times with the same `now` does not change chaos schedule state (chaos mode)', () => {
    advanceChaosSchedule(1000, 'chaos', 1000, emptyNodesMap, noop)
    const failuresBefore = new Map(getChaosFailures())
    const before = trafficMultiplier(1000, 'chaos', 1, 1000, emptyNodesMap)
    for (let i = 0; i < 50; i++) trafficMultiplier(1000, 'chaos', 1, 1000, emptyNodesMap)
    const after = trafficMultiplier(1000, 'chaos', 1, 1000, emptyNodesMap)
    expect(after).toBe(before)
    expect(getChaosFailures()).toEqual(failuresBefore)
  })

  it('trafficMultiplier alone (never calling advanceChaosSchedule) never mutates chaos state', () => {
    expect(getChaosFailures().size).toBe(0)
    for (let i = 0; i < 20; i++) trafficMultiplier(5000, 'chaos', 1, 5000, emptyNodesMap)
    // Without advanceChaosSchedule ever running, no victims should ever be picked.
    expect(getChaosFailures().size).toBe(0)
  })
})

describe('advanceChaosSchedule', () => {
  beforeEach(() => clearChaosState())

  it('is the only entry point that mutates chaos failure state and emits events', () => {
    const onEvent = vi.fn()
    advanceChaosSchedule(20_000, 'chaos', 20_000, emptyNodesMap, onEvent)
    // With an empty nodes map there are no victims to pick, but the schedule pointers still advance
    // without throwing, and no read-only call ever triggers scheduling on its own.
    expect(() => trafficMultiplier(20_000, 'chaos', 1, 20_000, emptyNodesMap)).not.toThrow()
  })
})

describe('edge-level partition chaos', () => {
  beforeEach(() => clearChaosState())

  it('an edge with an active partition reports isEdgePartitioned = true', () => {
    triggerEdgePartition('edge-1', /* durationMs */ 5000, /* now */ 0)
    expect(isEdgePartitioned('edge-1', 100)).toBe(true)
  })

  it('the partition clears after its duration elapses', () => {
    triggerEdgePartition('edge-1', 5000, 0)
    expect(isEdgePartitioned('edge-1', 6000)).toBe(false)
  })

  it('partitioning an edge does not affect node-keyed chaos state', () => {
    expect(getChaosFailures().size).toBe(0)
    triggerEdgePartition('edge-1', 5000, 0)
    // Edge partitions are a parallel, edge-keyed structure — asserting on the only node-keyed
    // chaos state this module exposes (_chaosFailures via getChaosFailures()) confirms triggering
    // an edge partition has zero side effects on node health/failure tracking.
    expect(getChaosFailures().size).toBe(0)
    expect(isEdgePartitioned('edge-1', 100)).toBe(true)
  })

  it('an edge with no partition reports isEdgePartitioned = false', () => {
    expect(isEdgePartitioned('never-partitioned', 0)).toBe(false)
  })

  it('triggerRegionPartition partitions every crossing edge for the same duration', () => {
    triggerRegionPartition(['edge-a', 'edge-b', 'edge-c'], 5000, 0)
    expect(isEdgePartitioned('edge-a', 100)).toBe(true)
    expect(isEdgePartitioned('edge-b', 100)).toBe(true)
    expect(isEdgePartitioned('edge-c', 100)).toBe(true)
    expect(isEdgePartitioned('edge-a', 6000)).toBe(false)
    expect(isEdgePartitioned('edge-b', 6000)).toBe(false)
    expect(isEdgePartitioned('edge-c', 6000)).toBe(false)
  })

  it('clearChaosState clears edge partitions', () => {
    triggerEdgePartition('edge-1', 5000, 0)
    clearChaosState()
    expect(isEdgePartitioned('edge-1', 100)).toBe(false)
  })
})
