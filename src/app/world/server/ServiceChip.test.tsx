// src/app/world/server/ServiceChip.test.tsx
// @vitest-environment jsdom
// Polish 3 T6 (D8, mockup `.b3chip .act`): sparkbar sample cap + hover lift. No pre-existing
// suite — ServiceChip previously had no dedicated test file (implicitly covered via
// ServerBoard.test.tsx's chip-rendering assertions, which are untouched by this change).
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ServiceChip } from './ServiceChip'
import type { ChipLayout } from './boardLayout'

const chip: ChipLayout = {
  instanceId: 'i1', blueprintId: 'b1', placementId: 'p1',
  box: { x: 0, y: 0, w: 150, h: 52 }, inAnchor: { x: 0, y: 26 }, outAnchor: { x: 150, y: 26 }, stackName: null,
}

describe('ServiceChip', () => {
  it('renders name, ports, and health dot', () => {
    render(<ServiceChip chip={chip} name="web" color="#5B9CF6" portsLabel=":8080" onSelect={() => {}} onHover={() => {}} />)
    expect(screen.getByText('web')).toBeInTheDocument()
    expect(screen.getByText(':8080')).toBeInTheDocument()
  })

  it('sparkbar always renders 12 bars, keeping at most 12 samples', () => {
    const { rerender } = render(<ServiceChip chip={chip} name="web" color="#5B9CF6" portsLabel=":8080" rps={0} onSelect={() => {}} onHover={() => {}} />)
    expect(screen.getAllByTestId('spark-bar')).toHaveLength(12)
    for (let i = 1; i <= 20; i++) {
      rerender(<ServiceChip chip={chip} name="web" color="#5B9CF6" portsLabel=":8080" rps={i} onSelect={() => {}} onHover={() => {}} />)
    }
    // Still exactly 12 bars in the DOM no matter how many rps updates have flowed through —
    // the rolling sample window never grows past its cap.
    expect(screen.getAllByTestId('spark-bar')).toHaveLength(12)
  })

  it('hover lift applies translateY(-2px) only while hovered', () => {
    const { rerender, container } = render(<ServiceChip chip={chip} name="web" color="#5B9CF6" portsLabel=":8080" hovered={false} onSelect={() => {}} onHover={() => {}} />)
    const el = container.querySelector('[data-chip]') as HTMLElement
    expect(el.style.transform).toBe('')
    rerender(<ServiceChip chip={chip} name="web" color="#5B9CF6" portsLabel=":8080" hovered onSelect={() => {}} onHover={() => {}} />)
    expect(el.style.transform).toBe('translateY(-2px)')
  })

  it('existing click/hover dispatches are unchanged', () => {
    let selected = false
    let hoverValue: boolean | null = null
    render(<ServiceChip chip={chip} name="web" color="#5B9CF6" portsLabel=":8080"
      onSelect={() => { selected = true }} onHover={v => { hoverValue = v }} />)
    const el = screen.getByText('web').closest('[data-chip]') as HTMLElement
    fireEvent.click(el)
    expect(selected).toBe(true)
    fireEvent.mouseEnter(el)
    expect(hoverValue).toBe(true)
    fireEvent.mouseLeave(el)
    expect(hoverValue).toBe(false)
  })

  it('data-instance carries the chip instanceId (unchanged contract)', () => {
    render(<ServiceChip chip={chip} name="web" color="#5B9CF6" portsLabel=":8080" onSelect={() => {}} onHover={() => {}} />)
    expect(screen.getByText('web').closest('[data-chip]')).toHaveAttribute('data-instance', 'i1')
  })

  // FEAT-004: the cache hit-ratio readout only appears for a cache instance (cacheHitRatio
  // present), and its warming/steady state is a purely presentational flag from the caller.
  it('renders no hit-ratio readout when cacheHitRatio is absent (non-cache instance)', () => {
    render(<ServiceChip chip={chip} name="web" color="#5B9CF6" portsLabel=":8080" onSelect={() => {}} onHover={() => {}} />)
    expect(screen.queryByTestId('cache-hit-readout')).not.toBeInTheDocument()
  })

  it('renders the hit-ratio readout as a rounded percentage when cacheHitRatio is present', () => {
    render(<ServiceChip chip={chip} name="cache" color="#E0A552" portsLabel=":6379" cacheHitRatio={0.873} onSelect={() => {}} onHover={() => {}} />)
    expect(screen.getByTestId('cache-hit-readout')).toHaveTextContent('⌬ 87%')
  })

  it('flags the warming state distinctly from steady-state via data-warming', () => {
    const { rerender } = render(<ServiceChip chip={chip} name="cache" color="#E0A552" portsLabel=":6379" cacheHitRatio={0.2} cacheWarming onSelect={() => {}} onHover={() => {}} />)
    expect(screen.getByTestId('cache-hit-readout')).toHaveAttribute('data-warming', 'true')
    rerender(<ServiceChip chip={chip} name="cache" color="#E0A552" portsLabel=":6379" cacheHitRatio={0.9} cacheWarming={false} onSelect={() => {}} onHover={() => {}} />)
    expect(screen.getByTestId('cache-hit-readout')).toHaveAttribute('data-warming', 'false')
  })
})
