import { describe, it, expect } from 'vitest'
import { createVpsState, stepVps } from './vpsModel'
import { createRng } from './rng'
import { createServer } from '../world/factories'
import { getPreset } from '../world/instanceCatalog'

function vpsServer(overrides: { oversubscriptionRatio?: number; burstable?: boolean } = {}) {
  const server = createServer('az-1', getPreset('vps-medium')!)
  if (overrides.oversubscriptionRatio !== undefined) server.oversubscriptionRatio = overrides.oversubscriptionRatio
  if (overrides.burstable !== undefined) server.burstable = overrides.burstable
  return server
}

function dedicatedServer() {
  return createServer('az-1', getPreset('dedicated-8')!)
}

describe('createVpsState', () => {
  it('returns null for a dedicated server', () => {
    expect(createVpsState(dedicatedServer())).toBeNull()
  })

  it('returns an initial steal-0 state for a vps server', () => {
    const state = createVpsState(vpsServer())
    expect(state).not.toBeNull()
    expect(state!.steal).toBe(0)
  })
})

describe('stepVps — steal walk', () => {
  it('mean steal over 5000 seeded steps approximates (ratio-1) x 0.02 within +-30%', () => {
    const server = vpsServer({ oversubscriptionRatio: 4, burstable: false })
    const state = createVpsState(server)!
    const rng = createRng(7)
    const target = (4 - 1) * 0.02 // 0.06
    let sum = 0
    const N = 5000
    for (let i = 0; i < N; i++) {
      const r = stepVps(state, server, 0.5, 1000, rng)
      sum += r.steal
    }
    const mean = sum / N
    expect(mean).toBeGreaterThan(target * 0.7)
    expect(mean).toBeLessThan(target * 1.3)
  })

  it('clamps steal to [0, 0.4] even under extreme oversubscription', () => {
    const server = vpsServer({ oversubscriptionRatio: 50, burstable: false })
    const state = createVpsState(server)!
    const rng = createRng(3)
    for (let i = 0; i < 3000; i++) {
      const r = stepVps(state, server, 0.5, 1000, rng)
      expect(r.steal).toBeGreaterThanOrEqual(0)
      expect(r.steal).toBeLessThanOrEqual(0.4)
    }
    expect(state.steal).toBeCloseTo(0.4, 5)
  })

  it('flags noisySpikeStarted when steal crosses 0.15 upward', () => {
    const server = vpsServer({ oversubscriptionRatio: 10, burstable: false })
    const state = createVpsState(server)!
    const rng = createRng(4)
    let spikes = 0
    for (let i = 0; i < 2000; i++) {
      const r = stepVps(state, server, 0.5, 1000, rng)
      if (r.noisySpikeStarted) spikes++
    }
    expect(spikes).toBeGreaterThan(0)
  })
})

describe('stepVps — burst credits', () => {
  it('drains credits under sustained high utilization until exhausted, then clamps effectiveVcpuFactor to 0.4', () => {
    const server = vpsServer({ oversubscriptionRatio: 2, burstable: true })
    const state = createVpsState(server)!
    const rng = createRng(6)
    let sawExhaustedEvent = false
    for (let i = 0; i < 20; i++) {
      const r = stepVps(state, server, 1.0, 1000, rng)
      if (r.creditsJustExhausted) sawExhaustedEvent = true
    }
    expect(state.credits).toBe(0)
    expect(sawExhaustedEvent).toBe(true)
    const throttled = stepVps(state, server, 1.0, 1000, rng)
    expect(throttled.effectiveVcpuFactor).toBe(0.4)
    expect(throttled.creditsFraction).toBe(0)
  })

  it('recovers effectiveVcpuFactor once credits climb back above 10', () => {
    const server = vpsServer({ oversubscriptionRatio: 2, burstable: true })
    const state = createVpsState(server)!
    const rng = createRng(6)
    for (let i = 0; i < 20; i++) stepVps(state, server, 1.0, 1000, rng) // drain to exhaustion
    let last = stepVps(state, server, 1.0, 1000, rng)
    expect(last.effectiveVcpuFactor).toBe(0.4)
    for (let i = 0; i < 6; i++) last = stepVps(state, server, 0.0, 1000, rng) // recover, low utilization
    expect(state.credits).toBeGreaterThan(10)
    expect(last.effectiveVcpuFactor).not.toBe(0.4)
    expect(last.effectiveVcpuFactor).toBeCloseTo(1 - state.steal, 5)
  })

  it('non-burstable VPS never reports a credits fraction and is never credit-throttled', () => {
    const server = vpsServer({ oversubscriptionRatio: 2, burstable: false })
    const state = createVpsState(server)!
    const rng = createRng(6)
    for (let i = 0; i < 30; i++) {
      const r = stepVps(state, server, 1.0, 1000, rng)
      expect(r.creditsFraction).toBeNull()
      expect(r.effectiveVcpuFactor).not.toBe(0.4)
    }
  })
})
