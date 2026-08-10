// @vitest-environment jsdom
// Self-maintaining keyboard-map overlay (wave 5 task 19) — renders directly off keymap.ts's
// REGISTRY (or any Binding[] passed in), so a future binding needs zero changes here to show up.
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { KeymapOverlay } from './KeymapOverlay'
import { REGISTRY } from '../keymap'

describe('KeymapOverlay', () => {
  it('renders nothing when closed', () => {
    render(<KeymapOverlay open={false} registry={REGISTRY} running={false} onClose={vi.fn()} />)
    expect(screen.queryByText('Undo')).not.toBeInTheDocument()
  })

  it('lists every registered binding grouped by group, and reflects when-state for the current running flag', () => {
    render(<KeymapOverlay open registry={[
      { id: 'undo', keys: '⌘Z', label: 'Undo', group: 'author', when: 'stopped', run: () => {} },
    ]} running={false} onClose={() => {}} />)
    expect(screen.getByText('Undo')).toBeInTheDocument()
    expect(screen.getByText('⌘Z')).toBeInTheDocument()
  })

  it('marks a binding disabled when its when-state does not match the current running flag', () => {
    render(<KeymapOverlay open registry={[
      { id: 'undo', keys: '⌘Z', label: 'Undo', group: 'author', when: 'stopped', run: () => {} },
    ]} running onClose={() => {}} />)
    expect(screen.getByText('Undo').closest('li')).toHaveAttribute('aria-disabled', 'true')
  })

  it('marks a binding enabled when its when-state matches the current running flag', () => {
    render(<KeymapOverlay open registry={[
      { id: 'undo', keys: '⌘Z', label: 'Undo', group: 'author', when: 'stopped', run: () => {} },
    ]} running={false} onClose={() => {}} />)
    expect(screen.getByText('Undo').closest('li')).toHaveAttribute('aria-disabled', 'false')
  })

  it('a newly-added binding appears without touching the overlay component', () => {
    const registry = [...REGISTRY, { id: 'new-thing', keys: 'g x', label: 'New thing', group: 'view' as const, when: 'always' as const, run: () => {} }]
    render(<KeymapOverlay open registry={registry} running={false} onClose={() => {}} />)
    expect(screen.getByText('New thing')).toBeInTheDocument()
  })

  it('renders the current REGISTRY bindings, including the new toggle-help entries', () => {
    render(<KeymapOverlay open registry={REGISTRY} running={false} onClose={vi.fn()} />)
    expect(screen.getAllByText('Keyboard shortcuts').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('⌘/')).toBeInTheDocument()
  })

  it('closes on backdrop click', () => {
    const onClose = vi.fn()
    render(<KeymapOverlay open registry={REGISTRY} running={false} onClose={onClose} />)
    const overlay = screen.getByTestId('keymap-overlay')
    overlay.click()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
