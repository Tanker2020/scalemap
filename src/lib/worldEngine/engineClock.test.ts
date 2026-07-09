import { describe, it, expect } from 'vitest'
import { createClock } from './engineClock'

describe('engineClock', () => {
  it('starts at simMs 0', () => {
    const clock = createClock()
    expect(clock.simMs).toBe(0)
  })

  it('accumulates fractional frames: 16.7ms x 6 -> 1 step, remainder carries', () => {
    const clock = createClock(100)
    let totalSteps = 0
    for (let i = 0; i < 6; i++) totalSteps += clock.advance(16.7, 1)
    expect(totalSteps).toBe(1)
    expect(clock.simMs).toBe(100)
    // the ~0.2ms remainder carries: one more 16.7ms frame isn't enough for a second step
    expect(clock.advance(16.7, 1)).toBe(0)
    expect(clock.simMs).toBe(100)
  })

  it('timeScale 2 doubles the step rate', () => {
    const realtime = createClock(100)
    const doubled = createClock(100)
    let realSteps = 0
    let doubledSteps = 0
    for (let i = 0; i < 10; i++) {
      realSteps += realtime.advance(100, 1)
      doubledSteps += doubled.advance(100, 2)
    }
    expect(realSteps).toBe(10)
    expect(doubledSteps).toBe(20)
    expect(realtime.simMs).toBe(1000)
    expect(doubled.simMs).toBe(2000)
  })

  it('advance returns the exact whole-step count for a large frame', () => {
    const clock = createClock(100)
    expect(clock.advance(350, 1)).toBe(3)
    expect(clock.simMs).toBe(300)
  })

  it('a custom stepMs is honored', () => {
    const clock = createClock(50)
    expect(clock.advance(120, 1)).toBe(2)
    expect(clock.simMs).toBe(100)
  })
})
