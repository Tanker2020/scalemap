// src/app/world/server/FirewallGate.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import type { FirewallRule } from '../../../lib/world/types'

// `useReducedMotion` reads a module-level singleton inside framer-motion/motion-dom that only
// initializes once per test-module lifetime — stubbing `window.matchMedia` per-test is unreliable
// once any earlier test in this file has rendered the hook. Mock the hook directly instead, same
// precedent as az/DatacenterFloor.test.tsx.
const { mockUseReducedMotion } = vi.hoisted(() => ({ mockUseReducedMotion: vi.fn(() => false) }))
vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>()
  return { ...actual, useReducedMotion: mockUseReducedMotion }
})

import { FirewallGate, shieldSlats } from './FirewallGate'

beforeEach(() => mockUseReducedMotion.mockReturnValue(false))

const rule = (id: string, action: FirewallRule['action'], port: FirewallRule['port'] = 443): FirewallRule =>
  ({ id, action, port, protocol: 'tcp', source: 'any' })

const box = { x: 128, y: 100, w: 48, h: 80 }

describe('shieldSlats', () => {
  it('returns all rules under the cap and folds the tail into a more slat with the exact count', () => {
    const three = [rule('r1', 'allow'), rule('r2', 'deny'), rule('r3', 'allow')]
    expect(shieldSlats(three, 4)).toEqual(three.map(r => ({ kind: 'rule', rule: r })))

    const six = [rule('r1', 'allow'), rule('r2', 'deny'), rule('r3', 'allow'), rule('r4', 'deny'), rule('r5', 'allow'), rule('r6', 'deny')]
    const slats = shieldSlats(six, 4)
    expect(slats).toHaveLength(4)
    expect(slats.slice(0, 3)).toEqual(six.slice(0, 3).map(r => ({ kind: 'rule', rule: r })))
    expect(slats[3]).toEqual({ kind: 'more', count: 3 })
  })

  it('defaults maxSlats to 4', () => {
    const five = Array.from({ length: 5 }, (_, i) => rule(`r${i}`, 'allow'))
    const slats = shieldSlats(five)
    expect(slats).toHaveLength(4)
    expect(slats[3]).toEqual({ kind: 'more', count: 2 })
  })

  it('an empty rule list produces no slats', () => {
    expect(shieldSlats([])).toEqual([])
  })
})

describe('FirewallGate', () => {
  it('clicking a slat opens the firewall editor with dispatches unchanged (same onSelect as clicking the shield)', () => {
    const onSelect = vi.fn()
    const rules = [rule('allow', 'allow', 443), rule('deny', 'deny', 'any')]
    const { container, getAllByTestId } = render(
      <FirewallGate box={box} rules={rules} onSelect={onSelect} />,
    )
    // data-firewall preserved byte-for-byte (existing click -> InspectorRail selection dispatch)
    const gate = container.querySelector('[data-firewall]')
    expect(gate).toBeTruthy()

    const slats = getAllByTestId('fw-slat-rule')
    expect(slats).toHaveLength(2)
    fireEvent.click(slats[0])
    expect(onSelect).toHaveBeenCalledTimes(1)   // bubbles to the same single onClick as clicking the shield

    fireEvent.click(gate!)
    expect(onSelect).toHaveBeenCalledTimes(2)
  })

  it('a {more} slat is clickable and dispatches the same onSelect', () => {
    const onSelect = vi.fn()
    const rules = Array.from({ length: 6 }, (_, i) => rule(`r${i}`, i % 2 === 0 ? 'allow' : 'deny'))
    const { getByTestId } = render(<FirewallGate box={box} rules={rules} onSelect={onSelect} />)
    const more = getByTestId('fw-slat-more')
    expect(more.textContent).toContain('3')   // 6 rules, cap 4 -> 3 rule slats + {more, count: 3}
    fireEvent.click(more)
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it("allow slat's edge-dot fires only when traffic is passing", () => {
    const rules = [rule('allow', 'allow', 443)]
    const { container: idle } = render(<FirewallGate box={box} rules={rules} trafficActive={false} />)
    expect(idle.querySelector('[data-testid="fw-edge-dot"]')).toBeNull()

    const { container: active } = render(<FirewallGate box={box} rules={rules} trafficActive />)
    expect(active.querySelector('[data-testid="fw-edge-dot"]')).toBeTruthy()
  })

  it('beacon is present only when the firewall has at least one rule', () => {
    const { container: empty } = render(<FirewallGate box={box} rules={[]} />)
    expect(empty.querySelector('[data-testid="fw-beacon"]')).toBeNull()

    const { container: withRule } = render(<FirewallGate box={box} rules={[rule('a', 'allow')]} />)
    expect(withRule.querySelector('[data-testid="fw-beacon"]')).toBeTruthy()
  })

  it('reject sparks render at most one spark stroke, driven by a real blocked count', () => {
    const { container: noBlocks } = render(<FirewallGate box={box} rules={[]} blockedPerSecond={0} />)
    expect(noBlocks.querySelectorAll('[data-testid="fw-spark"]')).toHaveLength(0)

    const { container: blocked } = render(<FirewallGate box={box} rules={[]} blockedPerSecond={2.4} />)
    expect(blocked.querySelectorAll('[data-testid="fw-spark"]')).toHaveLength(1)   // motion budget: one stroke max
  })

  it('reduced motion suppresses the spark and edge-dot animation classes entirely', () => {
    mockUseReducedMotion.mockReturnValue(true)
    const rules = [rule('allow', 'allow', 443)]
    const { container } = render(<FirewallGate box={box} rules={rules} trafficActive blockedPerSecond={1} />)
    expect(container.querySelector('[data-testid="fw-spark"]')).toBeNull()
    // edge-dot still renders (traffic is active — it's "firing") but with no animation class
    const dot = container.querySelector('[data-testid="fw-edge-dot"]')
    expect(dot).toBeTruthy()
    expect(dot?.className).not.toMatch(/gw-edgedot/)
  })
})
