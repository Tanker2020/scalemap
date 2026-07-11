// src/app/world/server/NicBlock.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'

// Same precedent as az/DatacenterFloor.test.tsx / FirewallGate.test.tsx — mock the hook directly
// rather than stubbing matchMedia (framer-motion's reduced-motion listener only initializes once
// per test-module lifetime).
const { mockUseReducedMotion } = vi.hoisted(() => ({ mockUseReducedMotion: vi.fn(() => false) }))
vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>()
  return { ...actual, useReducedMotion: mockUseReducedMotion }
})

import { NicBlock } from './NicBlock'

beforeEach(() => mockUseReducedMotion.mockReturnValue(false))

const box = { x: 0, y: 100, w: 74, h: 64 }

describe('NicBlock', () => {
  it('LINK LED reflects down state and ACT is dark at zero rps', () => {
    const { getByTestId, rerender } = render(
      <NicBlock box={box} nicMbps={1000} health="down" inboundRps={5} />,
    )
    expect(getByTestId('nic-link-led').dataset.on).toBe('false')

    rerender(<NicBlock box={box} nicMbps={1000} health="healthy" inboundRps={0} />)
    expect(getByTestId('nic-link-led').dataset.on).toBe('true')
    const act = getByTestId('nic-act-led')
    expect(act.dataset.active).toBe('false')
    expect(act.className).not.toMatch(/gw-act/)
  })

  it('ACT LED blinks when inbound rps is nonzero', () => {
    const { getByTestId } = render(<NicBlock box={box} nicMbps={1000} health="healthy" inboundRps={42} />)
    const act = getByTestId('nic-act-led')
    expect(act.dataset.active).toBe('true')
    expect(act.className).toMatch(/gw-act/)
  })

  it('pins do not ripple when throughput is zero', () => {
    const { getAllByTestId } = render(<NicBlock box={box} nicMbps={1000} inMbps={0} outMbps={0} />)
    const pins = getAllByTestId('nic-pin')
    expect(pins).toHaveLength(8)
    for (const pin of pins) {
      expect(pin.className).not.toMatch(/gw-pin/)
      expect(pin.style.opacity).toBe('0.45')
    }
  })

  it('pins ripple when throughput is nonzero', () => {
    const { getAllByTestId } = render(<NicBlock box={box} nicMbps={1000} inMbps={40} outMbps={12} />)
    const pins = getAllByTestId('nic-pin')
    for (const pin of pins) expect(pin.className).toMatch(/gw-pin/)
  })

  it('undefined in/out Mbps (no batch yet) is treated as idle — no ripple', () => {
    const { getAllByTestId } = render(<NicBlock box={box} nicMbps={1000} />)
    for (const pin of getAllByTestId('nic-pin')) expect(pin.className).not.toMatch(/gw-pin/)
  })

  it('reduced motion suppresses pin ripple even with throughput, and renders the ACT LED static-on (not dark) while active', () => {
    mockUseReducedMotion.mockReturnValue(true)
    const { getAllByTestId, getByTestId } = render(
      <NicBlock box={box} nicMbps={1000} inMbps={40} outMbps={12} inboundRps={30} />,
    )
    for (const pin of getAllByTestId('nic-pin')) expect(pin.className).not.toMatch(/gw-pin/)
    const act = getByTestId('nic-act-led')
    expect(act.className).not.toMatch(/gw-act/)          // no blink animation
    expect(act.dataset.active).toBe('true')               // but still "on" — activity is real
    expect(act.style.opacity).not.toBe('0.15')             // static-on, not forced dark
  })

  it('preserves the onSelect click dispatch (nic selection)', () => {
    const onSelect = vi.fn()
    const { container } = render(<NicBlock box={box} nicMbps={1000} onSelect={onSelect} />)
    const el = container.querySelector('[data-nic]')
    expect(el).toBeTruthy()
    fireEvent.click(el!)
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('has no container rectangle — background and border are none on the outer block', () => {
    const { container } = render(<NicBlock box={box} nicMbps={1000} />)
    const el = container.querySelector('[data-nic]') as HTMLElement
    expect(el.style.background).toBe('none')
    expect(el.style.borderStyle).toBe('none')
  })
})
