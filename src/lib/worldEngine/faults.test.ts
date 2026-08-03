import { describe, it, expect } from 'vitest'
import { createFaultState, setFault, addPartition, removePartition, impairmentFor } from './faults'
import type { PartitionFault } from './types'

describe('faults: setFault', () => {
  it('is idempotent — setting the same spec twice emits only once', () => {
    const state = createFaultState()
    const first = setFault(state, 'server', 'srv-1', { kind: 'cpu-brownout', capacityFraction: 0.5 }, 1000)
    expect(first).toHaveLength(1)
    expect(first[0].kind).toBe('fault_injected')
    const second = setFault(state, 'server', 'srv-1', { kind: 'cpu-brownout', capacityFraction: 0.5 }, 2000)
    expect(second).toHaveLength(0)
    expect(state.active.get('server:srv-1')).toEqual({ kind: 'cpu-brownout', capacityFraction: 0.5 })
  })

  it('clearing an active fault emits fault_cleared and removes it', () => {
    const state = createFaultState()
    setFault(state, 'server', 'srv-1', { kind: 'error-inject', errorFraction: 0.1 }, 1000)
    const cleared = setFault(state, 'server', 'srv-1', null, 2000)
    expect(cleared).toHaveLength(1)
    expect(cleared[0].kind).toBe('fault_cleared')
    expect(state.active.has('server:srv-1')).toBe(false)
  })

  it('clearing a fault that is not active emits nothing', () => {
    const state = createFaultState()
    expect(setFault(state, 'server', 'srv-1', null, 1000)).toHaveLength(0)
  })

  it('down-kind faults use outage_triggered/outage_cleared, not fault_injected/cleared', () => {
    const state = createFaultState()
    const injected = setFault(state, 'server', 'srv-1', { kind: 'down' }, 1000)
    expect(injected[0].kind).toBe('outage_triggered')
    const cleared = setFault(state, 'server', 'srv-1', null, 2000)
    expect(cleared[0].kind).toBe('outage_cleared')
  })

  it('clears leakAccumMb for the affected instance when a memory-leak fault is cleared', () => {
    const state = createFaultState()
    state.leakAccumMb.set('inst-1' as any, 42)
    setFault(state, 'server', 'srv-1', { kind: 'memory-leak', mbPerMinute: 10 }, 1000)
    setFault(state, 'server', 'srv-1', null, 2000, ['inst-1' as any])
    expect(state.leakAccumMb.get('inst-1' as any)).toBeUndefined()
  })
})

describe('faults: addPartition / removePartition', () => {
  it('addPartition pushes the fault, auto-assigns an id, and emits a partition_started event', () => {
    const state = createFaultState()
    const fault: PartitionFault = { from: { kind: 'region', id: 'r1' }, to: { kind: 'region', id: 'r2' }, mode: 'drop', symmetric: true }
    const event = addPartition(state, fault, 1000)
    expect(state.partitions).toEqual([fault])
    expect(fault.id).toBe('partition-0')   // audit final-review I3 — auto-assigned from the run-scoped counter
    expect(event.kind).toBe('partition_started')
    expect(event.simMs).toBe(1000)
  })

  it('addPartition keeps a caller-supplied id as-is', () => {
    const state = createFaultState()
    const fault: PartitionFault = { id: 'p-custom', from: { kind: 'region', id: 'r1' }, to: { kind: 'region', id: 'r2' }, mode: 'drop', symmetric: true }
    addPartition(state, fault, 1000)
    expect(fault.id).toBe('p-custom')
  })

  // Audit final-review I3: was index-based — a partition authored/healed by hand mid-run shifted
  // every later index, silently misdirecting a heal aimed at a DIFFERENT partition.
  it('removePartition removes the fault matching the given id and emits partition_healed', () => {
    const state = createFaultState()
    const fault: PartitionFault = { from: { kind: 'az', id: 'az1' }, to: { kind: 'az', id: 'az2' }, mode: 'loss', lossFraction: 0.2, symmetric: true }
    addPartition(state, fault, 1000)
    const event = removePartition(state, fault.id!, 2000)
    expect(state.partitions).toHaveLength(0)
    expect(event?.kind).toBe('partition_healed')
    expect(event?.simMs).toBe(2000)
  })

  it('removePartition addresses by id, immune to an earlier partition shifting array position', () => {
    const state = createFaultState()
    const f1: PartitionFault = { from: { kind: 'region', id: 'r1' }, to: { kind: 'region', id: 'r2' }, mode: 'drop', symmetric: true }
    const f2: PartitionFault = { from: { kind: 'region', id: 'r3' }, to: { kind: 'region', id: 'r4' }, mode: 'drop', symmetric: true }
    addPartition(state, f1, 1000)   // partition-0
    addPartition(state, f2, 1000)   // partition-1
    removePartition(state, f1.id!, 2000)   // heal the FIRST one, shifting f2 to array index 0
    expect(state.partitions).toEqual([f2])
    // f2's identity (id) is unaffected by the shift — healing it by id still works.
    const event = removePartition(state, f2.id!, 3000)
    expect(event?.kind).toBe('partition_healed')
    expect(state.partitions).toHaveLength(0)
  })

  it('removePartition with an unknown id emits nothing (null) rather than throwing', () => {
    const state = createFaultState()
    expect(() => removePartition(state, 'no-such-id', 1000)).not.toThrow()
    expect(removePartition(state, 'no-such-id', 1000)).toBeNull()
  })
})

describe('faults: impairmentFor', () => {
  it('returns no impairment when there are no partitions', () => {
    const result = impairmentFor({ regionId: 'r1' }, { regionId: 'r2' }, [])
    expect(result).toEqual({ blocked: false, lossFraction: 0, delayMs: 0 })
  })

  it('a symmetric drop blocks paths in both directions between the endpoints', () => {
    const partition: PartitionFault = { from: { kind: 'region', id: 'r1' }, to: { kind: 'region', id: 'r2' }, mode: 'drop', symmetric: true }
    expect(impairmentFor({ regionId: 'r1' }, { regionId: 'r2' }, [partition]).blocked).toBe(true)
    expect(impairmentFor({ regionId: 'r2' }, { regionId: 'r1' }, [partition]).blocked).toBe(true)
  })

  it('an asymmetric drop blocks only from->to, leaving to->from untouched', () => {
    const partition: PartitionFault = { from: { kind: 'region', id: 'r1' }, to: { kind: 'region', id: 'r2' }, mode: 'drop', symmetric: false }
    expect(impairmentFor({ regionId: 'r1' }, { regionId: 'r2' }, [partition]).blocked).toBe(true)
    expect(impairmentFor({ regionId: 'r2' }, { regionId: 'r1' }, [partition]).blocked).toBe(false)
  })

  it('loss mode returns the configured lossFraction, not blocked', () => {
    const partition: PartitionFault = { from: { kind: 'az', id: 'az1' }, to: { kind: 'az', id: 'az2' }, mode: 'loss', lossFraction: 0.3, symmetric: true }
    const result = impairmentFor({ azId: 'az1' }, { azId: 'az2' }, [partition])
    expect(result.blocked).toBe(false)
    expect(result.lossFraction).toBe(0.3)
  })

  it('delay mode returns the configured delayMs', () => {
    const partition: PartitionFault = { from: { kind: 'region', id: 'r1' }, to: { kind: 'region', id: 'r2' }, mode: 'delay', delayMs: 150, symmetric: true }
    expect(impairmentFor({ regionId: 'r1' }, { regionId: 'r2' }, [partition]).delayMs).toBe(150)
  })

  it('delayMs accumulates additively across multiple co-located delay partitions', () => {
    const a: PartitionFault = { from: { kind: 'region', id: 'r1' }, to: { kind: 'region', id: 'r2' }, mode: 'delay', delayMs: 100, symmetric: true }
    const b: PartitionFault = { from: { kind: 'region', id: 'r1' }, to: { kind: 'region', id: 'r2' }, mode: 'delay', delayMs: 50, symmetric: true }
    expect(impairmentFor({ regionId: 'r1' }, { regionId: 'r2' }, [a, b]).delayMs).toBe(150)
  })

  it('an unrelated endpoint pair returns the zero/false baseline exactly', () => {
    const partition: PartitionFault = { from: { kind: 'region', id: 'r1' }, to: { kind: 'region', id: 'r2' }, mode: 'drop', symmetric: true }
    expect(impairmentFor({ regionId: 'r3' }, { regionId: 'r4' }, [partition])).toEqual({ blocked: false, lossFraction: 0, delayMs: 0 })
  })

  it('a server-scoped partition never matches an EndpointIds with serverId undefined (managed-service case)', () => {
    const partition: PartitionFault = { from: { kind: 'server', id: 'srv-1' }, to: { kind: 'server', id: 'srv-2' }, mode: 'drop', symmetric: true }
    // A managed-service endpoint resolves to regionId/azId only, serverId left undefined.
    const managedIds = { regionId: 'r1', azId: 'az1' }
    expect(impairmentFor({ serverId: 'srv-1' }, managedIds, [partition]).blocked).toBe(false)
    expect(impairmentFor(managedIds, { serverId: 'srv-2' }, [partition]).blocked).toBe(false)
  })
})
