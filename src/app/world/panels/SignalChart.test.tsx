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

  it('calls onScrub with the nearest point simMs on click', () => {
    const points = [{ simMs: 0, min: 1, max: 5, value: 3 }, { simMs: 1000, min: 2, max: 8, value: 4 }]
    let scrubbed: number | null = null
    const { container } = render(
      <SignalChart points={points} color="var(--color-danger)" width={200} height={40} onScrub={(ms) => { scrubbed = ms }} />,
    )
    const svg = container.querySelector('svg')!
    fireEvent.click(svg, { clientX: 190, clientY: 20 })
    expect(scrubbed).toBe(1000)
  })
})
