import { describe, it, expect } from 'vitest'
import { holdProgress, HOLD_DURATION_MS, isAbortedHold, HOLD_TAP_MS } from './HoldToEnter'

describe('holdProgress', () => {
  it('is 0 with a null start', () => {
    expect(holdProgress(12345, null)).toBe(0)
  })
  it('reaches exactly 1 at the duration and clamps beyond', () => {
    expect(holdProgress(1000 + HOLD_DURATION_MS, 1000)).toBe(1)
    expect(holdProgress(1000 + HOLD_DURATION_MS * 3, 1000)).toBe(1)
  })
  it('is 0.5 at half the duration', () => {
    expect(holdProgress(1000 + HOLD_DURATION_MS / 2, 1000)).toBe(0.5)
  })
  it('clamps a pre-start now to 0', () => {
    expect(holdProgress(500, 1000)).toBe(0)
  })
})

describe('isAbortedHold', () => {
  it('is false just under the tap threshold', () => {
    expect(isAbortedHold(HOLD_TAP_MS - 1)).toBe(false)
  })
  it('is true at the threshold', () => {
    expect(isAbortedHold(HOLD_TAP_MS)).toBe(true)
  })
})
