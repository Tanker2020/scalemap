// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { SignalChart } from './SignalChart'

describe('SignalChart', () => {
  it('renders a polyline and a min/max band path', () => {
    const points = [{ simMs: 0, min: 1, max: 5, value: 3 }, { simMs: 1000, min: 2, max: 8, value: 4 }]
    const { container } = render(<SignalChart points={points} color="var(--color-danger)" width={200} height={40} />)
    expect(container.querySelector('polyline')).not.toBeNull()
    expect(container.querySelectorAll('path').length).toBeGreaterThanOrEqual(1)
  })

  it('calls onScrub with the nearest point simMs on click (rightmost point)', () => {
    const points = [{ simMs: 0, min: 1, max: 5, value: 3 }, { simMs: 1000, min: 2, max: 8, value: 4 }]
    let scrubbed: number | null = null
    const { container } = render(
      <SignalChart points={points} color="var(--color-danger)" width={200} height={40} onScrub={(ms) => { scrubbed = ms }} />,
    )
    const svg = container.querySelector('svg')!
    Object.defineProperty(svg, 'getBoundingClientRect', {
      value: () => ({ left: 0, width: 200, top: 0, height: 40, right: 200, bottom: 40, x: 0, y: 0, toJSON: () => {} }),
      configurable: true,
    })
    fireEvent.click(svg, { clientX: 190, clientY: 20 })
    expect(scrubbed).toBe(1000)
  })

  it('calls onScrub with nearest interior point on click', () => {
    const points = [
      { simMs: 0, min: 1, max: 5, value: 3 },
      { simMs: 500, min: 2, max: 8, value: 4 },
      { simMs: 1000, min: 2, max: 8, value: 4 },
    ]
    let scrubbed: number | null = null
    const { container } = render(
      <SignalChart points={points} color="var(--color-danger)" width={300} height={40} onScrub={(ms) => { scrubbed = ms }} />,
    )
    const svg = container.querySelector('svg')!
    Object.defineProperty(svg, 'getBoundingClientRect', {
      value: () => ({ left: 0, width: 300, top: 0, height: 40, right: 300, bottom: 40, x: 0, y: 0, toJSON: () => {} }),
      configurable: true,
    })
    // Click at x=150, which is 150/300 = 0.5 of the way across, targeting simMs = 500 (interior point)
    fireEvent.click(svg, { clientX: 150, clientY: 20 })
    expect(scrubbed).toBe(500)
  })

  it('renders without crashing with empty points array', () => {
    const { container } = render(
      <SignalChart points={[]} color="var(--color-danger)" width={200} height={40} />,
    )
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.querySelector('polyline')).toBeNull()
  })

  it('renders without crashing with single-point array', () => {
    const points = [{ simMs: 0, min: 5, max: 5, value: 5 }]
    const { container } = render(
      <SignalChart points={points} color="var(--color-danger)" width={200} height={40} />,
    )
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.querySelector('polyline')).not.toBeNull()
  })
})
