import { describe, it, expect } from 'vitest'
import { createFaultState, setFault } from './faults'

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
