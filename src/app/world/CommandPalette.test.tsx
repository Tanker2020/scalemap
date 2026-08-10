// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CommandPalette } from './CommandPalette'
import type { PaletteCommand } from './commands'

function cmd(overrides: Partial<PaletteCommand>): PaletteCommand {
  return { id: 'x', label: 'X', group: 'author', run: vi.fn(), ...overrides }
}

describe('CommandPalette', () => {
  it('renders nothing when closed', () => {
    render(<CommandPalette open={false} commands={[cmd({})]} onClose={vi.fn()} running={false} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('filters commands by ranked substring match and runs the selected one on Enter', () => {
    const run = vi.fn()
    render(<CommandPalette
      open
      commands={[cmd({ id: 'add-server', label: 'Add server', when: 'stopped', run }), cmd({ id: 'undo', label: 'Undo', when: 'stopped' })]}
      onClose={vi.fn()}
      running={false}
    />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'add ser' } })
    expect(screen.getByText('Add server')).toBeInTheDocument()
    expect(screen.queryByText('Undo')).not.toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(run).toHaveBeenCalled()
  })

  it('shows disabled commands greyed with the standardized tooltip, does not hide them', () => {
    const run = vi.fn()
    render(<CommandPalette open commands={[cmd({ id: 'add-server', label: 'Add server', when: 'stopped', run })]} onClose={vi.fn()} running={true} />)
    const item = screen.getByText('Add server')
    expect(item.closest('[aria-disabled="true"]')).toBeTruthy()
    expect(screen.getByTitle('stop the simulation to edit')).toBeInTheDocument()
    fireEvent.click(item)
    expect(run).not.toHaveBeenCalled()
  })

  it('shows the running-required tooltip for chaos commands while stopped', () => {
    render(<CommandPalette open commands={[cmd({ id: 'inject-fault', label: 'Kill server', when: 'running' })]} onClose={vi.fn()} running={false} />)
    expect(screen.getByTitle('start the simulation to break things')).toBeInTheDocument()
  })

  it('Escape closes the palette', () => {
    const onClose = vi.fn()
    render(<CommandPalette open commands={[cmd({})]} onClose={onClose} running={false} />)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('ArrowDown/ArrowUp move the active selection and Enter runs the active item', () => {
    const runA = vi.fn()
    const runB = vi.fn()
    render(<CommandPalette
      open
      commands={[cmd({ id: 'a', label: 'Alpha', run: runA }), cmd({ id: 'b', label: 'Beta', run: runB })]}
      onClose={vi.fn()}
      running={false}
    />)
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(runB).toHaveBeenCalled()
    expect(runA).not.toHaveBeenCalled()
  })

  it('clicking the backdrop closes the palette', () => {
    const onClose = vi.fn()
    render(<CommandPalette open commands={[cmd({})]} onClose={onClose} running={false} />)
    const overlay = document.body.querySelector('[data-testid="command-palette-overlay"]')!
    fireEvent.click(overlay)
    expect(onClose).toHaveBeenCalled()
  })
})
