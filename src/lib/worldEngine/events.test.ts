import { describe, it, expect } from 'vitest'
import { createEventRing, mkEvent } from './events'

describe('engine event ring', () => {
  it('mkEvent builds a contract-complete EngineEvent with a sequenced id', () => {
    const e = mkEvent('oom_kill', 'critical', 'instance x killed', ['inst-1', 'srv-1'], 4200, 7)
    expect(e).toEqual({
      id: 'evt-7', simMs: 4200, kind: 'oom_kill', severity: 'critical',
      message: 'instance x killed', affected: ['inst-1', 'srv-1'],
    })
  })

  it('caps the ring at cap, dropping oldest', () => {
    const ring = createEventRing(5)
    for (let i = 0; i < 8; i++) ring.push(mkEvent('health_check_failed', 'warning', `e${i}`, [], i * 100, i))
    const all = ring.all()
    expect(all).toHaveLength(5)
    expect(all[0].id).toBe('evt-3')     // oldest retained
    expect(all[4].id).toBe('evt-7')     // newest last
  })

  it('drain returns only events since the previous drain, without emptying the ring', () => {
    const ring = createEventRing(500)
    ring.push(mkEvent('outage_triggered', 'critical', 'a', [], 0, 0))
    ring.push(mkEvent('outage_cleared', 'info', 'b', [], 100, 1))
    expect(ring.drain().map(e => e.id)).toEqual(['evt-0', 'evt-1'])
    expect(ring.drain()).toEqual([])                       // window emptied
    ring.push(mkEvent('breaker_open', 'warning', 'c', [], 200, 2))
    expect(ring.drain().map(e => e.id)).toEqual(['evt-2']) // only the new window
    expect(ring.all()).toHaveLength(3)                     // ring keeps everything ≤ cap
  })
})
