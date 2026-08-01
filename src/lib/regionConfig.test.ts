import { describe, it, expect } from 'vitest'
import { interRegionLatencyMs } from './regionConfig'

describe('geo latency', () => {
  it('interRegionLatencyMs remains deterministic (unchanged behavior)', () => {
    expect(interRegionLatencyMs('us-east-1', 'eu-west-1')).toBe(interRegionLatencyMs('us-east-1', 'eu-west-1'))
  })

  it('same-region pairs stay at a zero floor', () => {
    expect(interRegionLatencyMs('us-east-1', 'us-east-1')).toBe(0)
  })
})
