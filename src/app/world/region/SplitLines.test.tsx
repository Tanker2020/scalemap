// src/app/world/region/SplitLines.test.tsx
// @vitest-environment jsdom
// Polish 4 TA (animation smoothness remediation): the seamless-loop law is "a marching
// stroke-dashoffset animation loops seamlessly iff its offset delta is an integer multiple of the
// dash period (dash + gap)". The animated top beam here used dash '8 9' (period 17) against the
// shared `dashflow` keyframe's -30 offset (region/r3Styles.ts) — 30 mod 17 = 13 != 0, so it
// visibly snapped ~13/17 of a period every cycle (user report 2026-07-11, taskA-brief.md). Fixed
// by widening the up-beam dash to '7 8' (period 15; 30/15 = 2 whole cycles) — see SplitLines.tsx's
// inline comment for why this option was chosen over rescaling the offset/duration per beam.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'

// Same precedent as dock/AtlasHeader.test.tsx / az/DatacenterFloor.test.tsx — mock the hook
// directly rather than stubbing matchMedia (jsdom has none, and framer-motion's reduced-motion
// listener only initializes once per test-module lifetime).
const { mockUseReducedMotion } = vi.hoisted(() => ({ mockUseReducedMotion: vi.fn(() => false) }))
vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>()
  return { ...actual, useReducedMotion: mockUseReducedMotion }
})

import { SplitLines } from './SplitLines'
import type { AzShare } from './regionData'

beforeEach(() => {
  mockUseReducedMotion.mockReturnValue(false)
})

// Parses an SVG dash-array string ("7 8") into its period (dash + gap).
function dashPeriod(dasharray: string): number {
  return dasharray.trim().split(/\s+/).map(Number).reduce((a, b) => a + b, 0)
}

// Parses an <animate values="0;-30"> string into the |offset delta|.
function offsetDelta(values: string): number {
  const [from, to] = values.split(';').map(Number)
  return Math.abs(to - from)
}

describe('SplitLines — seamless-loop invariant (taskA)', () => {
  it('the animated beam\'s stroke-dashoffset delta is a whole multiple of its dash period', () => {
    const shares: AzShare[] = [
      { azId: 'az-a', fraction: 0.7, rps: 700, dropped: 0, down: false },
      { azId: 'az-b', fraction: 0.3, rps: 300, dropped: 0, down: false },
    ]
    const { container } = render(<SplitLines shares={shares} height={200} live />)

    // az-a has the top fraction among rps>0 shares, so it's the (only, in this 2-AZ fixture)
    // animated beam — locate its <path> via the sibling <animate> child.
    const animateEl = container.querySelector('animate[attributeName="stroke-dashoffset"]')
    expect(animateEl).not.toBeNull()
    const path = animateEl!.closest('path')!
    const dasharray = path.getAttribute('stroke-dasharray')!
    const values = animateEl!.getAttribute('values')!

    const period = dashPeriod(dasharray)
    const delta = offsetDelta(values)
    // THE invariant: this is what fails against the pre-fix dash '8 9' (period 17) — delta 30,
    // 30 % 17 = 13 != 0. Post-fix dash '7 8' (period 15): 30 % 15 = 0.
    expect(delta % period).toBe(0)
  })

  it('regression guard: a period that does not divide the offset delta fails the invariant (proves the assertion above is not a tautology)', () => {
    // Directly re-checks the pre-fix numbers so this test file documents (and pins) the bug that
    // was fixed, independent of the component's current dash literal.
    expect(dashPeriod('8 9')).toBe(17)
    expect(offsetDelta('0;-30')).toBe(30)
    expect(30 % 17).not.toBe(0)   // the pre-fix combination was NOT seamless
    expect(30 % dashPeriod('7 8')).toBe(0)   // the post-fix combination IS seamless
  })

  it('non-animated (second) beam and down stubs render without an <animate> child at all', () => {
    const shares: AzShare[] = [
      { azId: 'az-down', fraction: 0, rps: 0, dropped: 0, down: true },
      { azId: 'az-idle', fraction: 0, rps: 0, dropped: 0, down: false },
    ]
    const { container } = render(<SplitLines shares={shares} height={200} live />)
    expect(container.querySelectorAll('animate').length).toBe(0)
  })

  it('reduced motion renders the beam static (no <animate> child) even when it would otherwise animate', () => {
    mockUseReducedMotion.mockReturnValue(true)
    const shares: AzShare[] = [
      { azId: 'az-a', fraction: 0.7, rps: 700, dropped: 0, down: false },
      { azId: 'az-b', fraction: 0.3, rps: 300, dropped: 0, down: false },
    ]
    const { container } = render(<SplitLines shares={shares} height={200} live />)
    expect(container.querySelectorAll('animate').length).toBe(0)
  })

  it('a NOT-live (paused/ended/scrubbed) run freezes the beam — no <animate> child even at rps>0', () => {
    const shares: AzShare[] = [
      { azId: 'az-a', fraction: 0.7, rps: 700, dropped: 0, down: false },
      { azId: 'az-b', fraction: 0.3, rps: 300, dropped: 0, down: false },
    ]
    const { container } = render(<SplitLines shares={shares} height={200} live={false} />)
    expect(container.querySelectorAll('animate').length).toBe(0)
  })
})
