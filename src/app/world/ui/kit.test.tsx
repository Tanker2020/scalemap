// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import {
  SectionHeader, EdgeRow, ChipValue, SpecBar, MicroBars, DerivedField, Segmented,
  PresetCardGrid, Explainer,
} from './kit'

describe('SectionHeader', () => {
  it('renders the label and trailing content', () => {
    render(<SectionHeader label="▸ US-EAST-1 · N. VIRGINIA" trailing={<span>● healthy</span>} />)
    expect(screen.getByText('▸ US-EAST-1 · N. VIRGINIA')).toBeInTheDocument()
    expect(screen.getByText('● healthy')).toBeInTheDocument()
  })
})

describe('EdgeRow', () => {
  it('status maps to dot color', () => {
    const { rerender } = render(<EdgeRow status="healthy">x</EdgeRow>)
    expect(screen.getByTestId('kit-dot').style.background).toContain('--color-success')
    rerender(<EdgeRow status="degraded">x</EdgeRow>)
    expect(screen.getByTestId('kit-dot').style.background).toContain('--color-warning')
    rerender(<EdgeRow status="down">x</EdgeRow>)
    expect(screen.getByTestId('kit-dot').style.background).toContain('--color-danger')
    rerender(<EdgeRow status={null}>x</EdgeRow>)
    expect(screen.getByTestId('kit-dot').style.background).toContain('--color-text-muted')
  })
  it('omits the dot when status is undefined and fires onClick', () => {
    const onClick = vi.fn()
    render(<EdgeRow onClick={onClick}>row content</EdgeRow>)
    expect(screen.queryByTestId('kit-dot')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('row content'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe('ChipValue', () => {
  it('renders children in a chip', () => {
    render(<ChipValue title="count">×4</ChipValue>)
    expect(screen.getByTitle('count')).toHaveTextContent('×4')
  })
})

describe('SpecBar', () => {
  it('clamps fraction to [0,1]', () => {
    const { rerender } = render(<SpecBar label="cpu" fraction={1.8} color="var(--color-accent)" value="9/4 c" />)
    expect(screen.getByTestId('kit-specbar-fill').style.width).toBe('100%')
    rerender(<SpecBar label="cpu" fraction={-0.5} color="var(--color-accent)" value="0/4 c" />)
    expect(screen.getByTestId('kit-specbar-fill').style.width).toBe('0%')
  })
})

describe('MicroBars', () => {
  it('renders three bars with clamped heights', () => {
    render(<MicroBars cpu={0.62} ram={2} io={-1} />)
    const bars = screen.getAllByTestId('kit-microbar')
    expect(bars).toHaveLength(3)
    expect(bars[0].style.height).toBe('62%')
    expect(bars[1].style.height).toBe('100%')
    expect(bars[2].style.height).toBe('0%')
  })
})

describe('DerivedField', () => {
  it('commits clamped value on blur and Enter', () => {
    const onCommit = vi.fn()
    render(<DerivedField label="dnsTtlSec" value={30} min={1} onCommit={onCommit} />)
    const input = screen.getByLabelText('dnsTtlSec')
    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledWith(1)
    fireEvent.change(input, { target: { value: '45' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).toHaveBeenLastCalledWith(45)
  })
  it('rejects NaN keeping last valid', () => {
    const onCommit = vi.fn()
    render(<DerivedField label="ramBaseMb" value={220} onCommit={onCommit} />)
    const input = screen.getByLabelText('ramBaseMb')
    fireEvent.change(input, { target: { value: 'abc' } })
    fireEvent.blur(input)
    expect(onCommit).not.toHaveBeenCalled()
    expect(input).toHaveValue('220')
  })
  it('slider updates the derive line live and commits on release', () => {
    const onCommit = vi.fn()
    render(
      <DerivedField label="cpu ms" value={8} min={1} max={60} mode="slider" unit="ms"
        derive={v => `→ one core sustains ~${Math.round(1000 / v)} rps`} onCommit={onCommit} />,
    )
    const slider = screen.getByLabelText('cpu ms')
    expect(screen.getByText('→ one core sustains ~125 rps')).toBeInTheDocument()
    fireEvent.change(slider, { target: { value: '20' } })
    expect(screen.getByText('→ one core sustains ~50 rps')).toBeInTheDocument()
    expect(onCommit).not.toHaveBeenCalled()          // live derive, no commit mid-drag
    fireEvent.mouseUp(slider)
    expect(onCommit).toHaveBeenCalledWith(20)
  })
  it('disabled renders inert', () => {
    const onCommit = vi.fn()
    render(<DerivedField label="x" value={5} disabled onCommit={onCommit} />)
    expect(screen.getByLabelText('x')).toBeDisabled()
  })
})

describe('Segmented', () => {
  it('fires onChange and marks selection', () => {
    const onChange = vi.fn()
    render(
      <Segmented ariaLabel="routing policy" value="latency" onChange={onChange}
        options={[{ value: 'latency', label: '⚡ latency' }, { value: 'geo', label: '🌍 geo' }]} />,
    )
    expect(screen.getByText('⚡ latency')).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByText('🌍 geo'))
    expect(onChange).toHaveBeenCalledWith('geo')
  })
})

describe('PresetCardGrid', () => {
  it('select dispatches value', () => {
    const onChange = vi.fn()
    render(
      <PresetCardGrid value="vps-medium" onChange={onChange}
        options={[
          { value: 'vps-medium', name: 'vps-medium', detail: '4 vCPU · 8 GB · shared tenancy', price: '$0.036/hr' },
          { value: 'dedicated-8', name: 'dedicated-8', detail: '8 cores · 32 GB · yours alone', price: '$0.34/hr' },
        ]} />,
    )
    expect(screen.getByText('vps-medium').closest('button')).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByText('dedicated-8'))
    expect(onChange).toHaveBeenCalledWith('dedicated-8')
  })
})

describe('Explainer', () => {
  it('renders muted microcopy', () => {
    render(<Explainer>each population is served by its fastest healthy region</Explainer>)
    expect(screen.getByText(/fastest healthy region/)).toBeInTheDocument()
  })
})
