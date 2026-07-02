import { describe, it, expect, beforeEach } from 'vitest'
import {
  getActiveWorkers, setActiveWorkers, getActiveConnections, setActiveConnections,
  getWarmInstances, setWarmInstances, getWarmLastActivity, setWarmLastActivity,
  acquireWorkers, releaseWorkerNow, acquireConnection, clearBackpressureState,
  scheduleWorkerRelease, scheduleConnectionRelease, scheduleGenericRelease, drainScheduledReleases,
} from './backpressure'

describe('backpressure', () => {
  beforeEach(() => {
    clearBackpressureState()
  })

  it('getActiveWorkers defaults to 0 for an unknown node', () => {
    expect(getActiveWorkers('node-1')).toBe(0)
  })

  it('acquireWorkers grants up to the remaining capacity and updates active count', () => {
    const acquired = acquireWorkers('node-1', 5, 10)
    expect(acquired).toBe(5)
    expect(getActiveWorkers('node-1')).toBe(5)
  })

  it('acquireWorkers caps the acquired amount at maxThreads - active', () => {
    setActiveWorkers('node-1', 8)
    const acquired = acquireWorkers('node-1', 5, 10)
    expect(acquired).toBe(2)
    expect(getActiveWorkers('node-1')).toBe(10)
  })

  it('releaseWorkerNow decrements active workers, floored at 0', () => {
    setActiveWorkers('node-1', 1)
    releaseWorkerNow('node-1')
    expect(getActiveWorkers('node-1')).toBe(0)
    releaseWorkerNow('node-1')
    expect(getActiveWorkers('node-1')).toBe(0)
  })

  it('acquireConnection returns false once at capacity', () => {
    expect(acquireConnection('node-1', 1)).toBe(true)
    expect(getActiveConnections('node-1')).toBe(1)
    expect(acquireConnection('node-1', 1)).toBe(false)
    expect(getActiveConnections('node-1')).toBe(1)
  })

  it('warm instance getters/setters round-trip correctly', () => {
    expect(getWarmInstances('node-1')).toBe(0)
    setWarmInstances('node-1', 3)
    expect(getWarmInstances('node-1')).toBe(3)

    expect(getWarmLastActivity('node-1')).toBe(0)
    setWarmLastActivity('node-1', 12345)
    expect(getWarmLastActivity('node-1')).toBe(12345)
  })

  it('clearBackpressureState resets every tracked map', () => {
    setActiveWorkers('node-1', 4)
    setActiveConnections('node-1', 2)
    setWarmInstances('node-1', 1)
    setWarmLastActivity('node-1', 999)

    clearBackpressureState()

    expect(getActiveWorkers('node-1')).toBe(0)
    expect(getActiveConnections('node-1')).toBe(0)
    expect(getWarmInstances('node-1')).toBe(0)
    expect(getWarmLastActivity('node-1')).toBe(0)
  })
})

describe('simulated-time release scheduling', () => {
  beforeEach(() => clearBackpressureState())

  it('does not release a worker before the scheduled simulated time has elapsed', () => {
    acquireWorkers('node-1', 1, 10)
    scheduleWorkerRelease('node-1', /* delayMs */ 500, /* simNowMs */ 0)
    drainScheduledReleases(/* simNowMs */ 300)
    expect(getActiveWorkers('node-1')).toBe(1)
  })

  it('releases a worker once simulated time passes the scheduled point, regardless of wall clock', () => {
    acquireWorkers('node-1', 1, 10)
    scheduleWorkerRelease('node-1', 500, 0)
    drainScheduledReleases(600)
    expect(getActiveWorkers('node-1')).toBe(0)
  })

  it('releases a worker exactly at the scheduled simulated time (boundary inclusive)', () => {
    acquireWorkers('node-1', 1, 10)
    scheduleWorkerRelease('node-1', 500, 0)
    drainScheduledReleases(500)
    expect(getActiveWorkers('node-1')).toBe(0)
  })

  it('does not release a connection before the scheduled simulated time has elapsed', () => {
    acquireConnection('node-1', 5)
    scheduleConnectionRelease('node-1', 200, 1_000)
    drainScheduledReleases(1_100)
    expect(getActiveConnections('node-1')).toBe(1)
  })

  it('releases a connection once simulated time passes the scheduled point', () => {
    acquireConnection('node-1', 5)
    scheduleConnectionRelease('node-1', 200, 1_000)
    drainScheduledReleases(1_200)
    expect(getActiveConnections('node-1')).toBe(0)
  })

  it('a paused simulation (no drain calls) never releases, no matter how much wall-clock time passes', async () => {
    acquireWorkers('node-1', 1, 10)
    scheduleWorkerRelease('node-1', 500, 0)
    // Simulate "pause" by simply not calling drainScheduledReleases — real wall-clock time
    // elapses (previously a live setTimeout would still fire here), but simulated time does not
    // advance while paused, so no drain call happens and nothing should release.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(getActiveWorkers('node-1')).toBe(1)
  })

  it('mid-flight speed changes do not need rescaling — delay is already expressed in simulated ms', () => {
    // A "speed change" has no separate representation any more: callers always pass a
    // simulated-time delay, and _simulatedTimeMs itself advances faster/slower with speed
    // elsewhere in the loop. Scheduling the same nominal delay at two different sim-time
    // scales fires at the correct simulated instant either way.
    acquireWorkers('node-1', 1, 10)
    scheduleWorkerRelease('node-1', 500, 1_000) // e.g. simulated clock already at 1000ms
    drainScheduledReleases(1_499)
    expect(getActiveWorkers('node-1')).toBe(1)
    drainScheduledReleases(1_500)
    expect(getActiveWorkers('node-1')).toBe(0)
  })

  it('scheduleGenericRelease invokes the provided callback once simulated time elapses', () => {
    let released = false
    scheduleGenericRelease('node-1', 100, 0, () => { released = true })
    drainScheduledReleases(50)
    expect(released).toBe(false)
    drainScheduledReleases(100)
    expect(released).toBe(true)
  })

  it('clearBackpressureState wipes pending releases so a stale one cannot fire in the next run', () => {
    acquireWorkers('node-1', 1, 10)
    scheduleWorkerRelease('node-1', 500, 0)
    clearBackpressureState()
    acquireWorkers('node-1', 1, 10)   // fresh run, same node id
    drainScheduledReleases(10_000)    // far past the old run's schedule
    expect(getActiveWorkers('node-1')).toBe(1) // only the fresh-run acquire should be active
  })

  it('clearBackpressureState wipes pending generic releases too', () => {
    let released = false
    scheduleGenericRelease('node-1', 500, 0, () => { released = true })
    clearBackpressureState()
    drainScheduledReleases(10_000)
    expect(released).toBe(false)
  })
})

describe('acquire/release symmetry under pool clamping (#4)', () => {
  beforeEach(() => clearBackpressureState())

  it('never leaves activeWorkers above maxThreads after a batch that exceeds the pool', () => {
    const maxThreads = 5
    const acquired = acquireWorkers('node-1', /* requested */ 8, maxThreads)
    expect(acquired).toBeLessThanOrEqual(maxThreads)
    expect(getActiveWorkers('node-1')).toBe(acquired)
  })

  it('releasing exactly `acquired` times returns activeWorkers to zero, never negative', () => {
    const maxThreads = 5
    const acquired = acquireWorkers('node-1', 8, maxThreads)
    for (let i = 0; i < acquired; i++) scheduleWorkerRelease('node-1', 0, 0)
    drainScheduledReleases(1)
    expect(getActiveWorkers('node-1')).toBe(0)
  })

  it('acquiring across multiple small per-particle calls admits at most maxThreads total', () => {
    // Mirrors the fixed particleEngine.ts call pattern: one acquireWorkers(nodeId, 1, max) call
    // per actually-minted particle, rather than one call requesting the whole batch size.
    const maxThreads = 3
    let totalAdmitted = 0
    for (let i = 0; i < 10; i++) {
      totalAdmitted += acquireWorkers('node-1', 1, maxThreads)
    }
    expect(getActiveWorkers('node-1')).toBe(maxThreads)
    expect(totalAdmitted).toBe(maxThreads)

    for (let i = 0; i < totalAdmitted; i++) scheduleWorkerRelease('node-1', 0, 0)
    drainScheduledReleases(1)
    expect(getActiveWorkers('node-1')).toBe(0)
  })

  it('does not go negative if released more times than acquired (defensive floor)', () => {
    acquireWorkers('node-1', 2, 10)
    for (let i = 0; i < 5; i++) scheduleWorkerRelease('node-1', 0, 0)
    drainScheduledReleases(1)
    expect(getActiveWorkers('node-1')).toBe(0)
  })
})
