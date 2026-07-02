import { describe, it, expect, beforeEach } from 'vitest'
import {
  getActiveWorkers, setActiveWorkers, getActiveConnections, setActiveConnections,
  getWarmInstances, setWarmInstances, getWarmLastActivity, setWarmLastActivity,
  acquireWorkers, releaseWorkerNow, acquireConnection, clearBackpressureState,
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
