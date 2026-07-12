// @vitest-environment jsdom
// Polish 4 T4 (spec D6): the generic accordion — pv always visible, tri rotates on open,
// the body's max-height carries the state, reduced motion strips the transitions.
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const { mockUseReducedMotion } = vi.hoisted(() => ({ mockUseReducedMotion: vi.fn(() => false) }))
vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>()
  return { ...actual, useReducedMotion: mockUseReducedMotion }
})

import { Drawer } from './Drawer'

describe('Drawer', () => {
  it('renders the pv readout even when closed ("closed ≠ hidden")', () => {
    render(
      <Drawer accent="blue" title="HARDWARE" readout="8c · 32G" open={false} onToggle={() => {}}>
        <div>body content</div>
      </Drawer>,
    )
    expect(screen.getByTestId('drawer-pv')).toHaveTextContent('8c · 32G')
    expect(screen.getByTestId('drawer')).toHaveAttribute('data-open', 'false')
  })

  it('marks data-open="true" and aria-expanded when open', () => {
    render(
      <Drawer accent="blue" title="HARDWARE" readout="8c · 32G" open onToggle={() => {}}>
        <div>body content</div>
      </Drawer>,
    )
    expect(screen.getByTestId('drawer')).toHaveAttribute('data-open', 'true')
    expect(screen.getByTestId('drawer-header')).toHaveAttribute('aria-expanded', 'true')
  })

  it('body max-height is 0 when closed, 340 when open', () => {
    const { rerender } = render(
      <Drawer accent="blue" title="HARDWARE" readout="—" open={false} onToggle={() => {}}>
        <div>x</div>
      </Drawer>,
    )
    expect(screen.getByTestId('drawer-body').style.maxHeight).toBe('0px')
    rerender(
      <Drawer accent="blue" title="HARDWARE" readout="—" open onToggle={() => {}}>
        <div>x</div>
      </Drawer>,
    )
    expect(screen.getByTestId('drawer-body').style.maxHeight).toBe('340px')
  })

  it('clicking the header calls onToggle', () => {
    let toggled = false
    render(
      <Drawer accent="blue" title="HARDWARE" readout="—" open={false} onToggle={() => { toggled = true }}>
        <div>x</div>
      </Drawer>,
    )
    fireEvent.click(screen.getByTestId('drawer-header'))
    expect(toggled).toBe(true)
  })

  it('Enter/Space on the header calls onToggle (keyboard operable div-role-button)', () => {
    let calls = 0
    render(
      <Drawer accent="blue" title="HARDWARE" readout="—" open={false} onToggle={() => { calls++ }}>
        <div>x</div>
      </Drawer>,
    )
    const header = screen.getByTestId('drawer-header')
    fireEvent.keyDown(header, { key: 'Enter' })
    fireEvent.keyDown(header, { key: ' ' })
    expect(calls).toBe(2)
  })

  it('the header is a div, not a button — must stay clickable inside an ambient <fieldset disabled>', () => {
    render(
      <fieldset disabled>
        <Drawer accent="blue" title="HARDWARE" readout="—" open={false} onToggle={() => {}}>
          <div>x</div>
        </Drawer>
      </fieldset>,
    )
    const header = screen.getByTestId('drawer-header')
    expect(header.tagName).toBe('DIV')
    let toggled = false
    render(
      <fieldset disabled>
        <Drawer accent="blue" title="HARDWARE" readout="—" open={false} onToggle={() => { toggled = true }}>
          <div>x</div>
        </Drawer>
      </fieldset>,
    )
    fireEvent.click(screen.getAllByTestId('drawer-header')[1])
    expect(toggled).toBe(true)
  })

  it('tri rotates 90deg when open, 0deg when closed', () => {
    const { rerender } = render(
      <Drawer accent="blue" title="HARDWARE" readout="—" open={false} onToggle={() => {}}>
        <div>x</div>
      </Drawer>,
    )
    const tri = screen.getByTestId('drawer-header').querySelector('span')!
    expect(tri.style.transform).toBe('rotate(0deg)')
    rerender(
      <Drawer accent="blue" title="HARDWARE" readout="—" open onToggle={() => {}}>
        <div>x</div>
      </Drawer>,
    )
    expect(tri.style.transform).toBe('rotate(90deg)')
  })

  it('strips the transition under reduced motion (instant open/close)', () => {
    mockUseReducedMotion.mockReturnValue(true)
    render(
      <Drawer accent="blue" title="HARDWARE" readout="—" open onToggle={() => {}}>
        <div>x</div>
      </Drawer>,
    )
    expect(screen.getByTestId('drawer-body').style.transition).toBe('')
    mockUseReducedMotion.mockReturnValue(false)
  })

  it('renders children only meaningfully when open (body still mounted, but collapsed via max-height when closed)', () => {
    render(
      <Drawer accent="blue" title="HARDWARE" readout="—" open={false} onToggle={() => {}}>
        <div data-testid="drawer-child">child</div>
      </Drawer>,
    )
    // Body content stays in the DOM (no unmount), only visually collapsed — matches the mock's
    // slide-open behavior rather than a conditional-render flash.
    expect(screen.getByTestId('drawer-child')).toBeInTheDocument()
  })
})
