import { describe, it, expect } from 'vitest'
import { panelTransition, hoverLiftVariants } from './motion'
import { MOTION } from './theme'

describe('motion primitives', () => {
  it('panelTransition duration matches the MOTION.panelDurationMs token, in seconds', () => {
    expect(panelTransition.duration).toBeCloseTo(MOTION.panelDurationMs / 1000, 5)
  })

  it('hoverLiftVariants defines rest and hover states with a 1px lift', () => {
    expect(hoverLiftVariants.rest).toEqual({ y: 0 })
    expect(hoverLiftVariants.hover).toEqual({ y: -1 })
  })
})
