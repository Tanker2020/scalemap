// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { VaultCard } from './VaultCard'
import { VAULT } from '../../lib/vault/exampleWorlds'

describe('VaultCard', () => {
  it('renders glyph, name, blurb, tags, and difficulty pill', () => {
    const entry = VAULT[0]
    const { container } = render(<VaultCard entry={entry} onOpen={() => {}} />)
    expect(container.querySelector('svg')).toBeInTheDocument()
    expect(screen.getByText('Classic three-tier')).toBeInTheDocument()
    expect(screen.getByText(/The on-ramp/)).toBeInTheDocument()
    expect(screen.getByText('1 region')).toBeInTheDocument()
    expect(screen.getByText('beginner')).toBeInTheDocument()
  })
  it('click fires onOpen with the entry', () => {
    const onOpen = vi.fn()
    render(<VaultCard entry={VAULT[3]} onOpen={onOpen} />)
    fireEvent.click(screen.getByText('Everything wrong at once'))
    expect(onOpen).toHaveBeenCalledWith(VAULT[3])
  })
})
