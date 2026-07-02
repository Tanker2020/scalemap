import { describe, it, expect } from 'vitest'
import { interRegionLatencyMs, sampleInterRegionLatencyMs } from './regionConfig'

describe('geo latency jitter', () => {
  it('interRegionLatencyMs remains deterministic (unchanged behavior)', () => {
    expect(interRegionLatencyMs('us-east-1', 'eu-west-1')).toBe(interRegionLatencyMs('us-east-1', 'eu-west-1'))
  })

  it('sampleInterRegionLatencyMs varies across repeated calls for the same pair', () => {
    const samples = Array.from({ length: 20 }, () => sampleInterRegionLatencyMs('us-east-1', 'eu-west-1'))
    expect(new Set(samples).size).toBeGreaterThan(1)
  })

  it('sampleInterRegionLatencyMs is centered near the deterministic base value', () => {
    const base = interRegionLatencyMs('us-east-1', 'eu-west-1')
    const samples = Array.from({ length: 200 }, () => sampleInterRegionLatencyMs('us-east-1', 'eu-west-1'))
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length
    expect(mean).toBeGreaterThan(base * 0.85)
    expect(mean).toBeLessThan(base * 1.15)
  })

  it('same-region pairs stay at a zero floor with no jitter', () => {
    const samples = Array.from({ length: 20 }, () => sampleInterRegionLatencyMs('us-east-1', 'us-east-1'))
    expect(samples.every(s => s === 0)).toBe(true)
  })
})
