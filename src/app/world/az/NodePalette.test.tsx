// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NodePalette } from './NodePalette'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'

function seedAz(): string {
  const regionId = useWorldStore.getState().addRegion('us-east-1')
  return useWorldStore.getState().addAz(regionId, 'us-east-1a')
}

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useSimulationStore.setState({ running: false })
})

describe('NodePalette', () => {
  it('renders a compute and a data section', () => {
    render(<NodePalette azId={seedAz()} />)
    expect(screen.getByText(/compute/i)).toBeTruthy()
    expect(screen.getByText(/data/i)).toBeTruthy()
  })

  it('adds a plain server for a compute preset', () => {
    const azId = seedAz()
    render(<NodePalette azId={azId} />)

    fireEvent.click(screen.getByRole('button', { name: /VPS Medium/i }))

    const servers = Object.values(useWorldStore.getState().doc.servers)
    expect(servers).toHaveLength(1)
    expect(servers[0].kind).toBe('vps')
    // A compute host is empty — you fill it with services yourself.
    expect(Object.keys(useWorldStore.getState().doc.blueprints)).toHaveLength(0)
  })

  // The whole point of the typed palette: a data node arrives preconfigured, not as a bare box.
  it('adds a db appliance with its owned blueprint and placement for a data preset', () => {
    const azId = seedAz()
    render(<NodePalette azId={azId} />)

    fireEvent.click(screen.getByRole('button', { name: /^SQL DB Medium/i }))

    const doc = useWorldStore.getState().doc
    expect(Object.values(doc.servers)[0].kind).toBe('db-sql')
    expect(Object.values(doc.blueprints)[0].ownerServerKind).toBe('db-sql')
    expect(Object.values(doc.placements)).toHaveLength(1)
  })

  it('names successive appliances of the same engine distinctly', () => {
    const azId = seedAz()
    render(<NodePalette azId={azId} />)

    fireEvent.click(screen.getByRole('button', { name: /^SQL DB Medium/i }))
    fireEvent.click(screen.getByRole('button', { name: /^SQL DB Medium/i }))

    const names = Object.values(useWorldStore.getState().doc.servers).map(s => s.label).sort()
    expect(names).toEqual(['sql-1', 'sql-2'])
  })

  // Authoring is edit-locked while the sim runs, matching every other control in the dock.
  it('disables every entry while the simulation is running', () => {
    const azId = seedAz()
    useSimulationStore.setState({ running: true })
    render(<NodePalette azId={azId} />)

    const button = screen.getByRole('button', { name: /VPS Medium/i })
    expect(button.hasAttribute('disabled')).toBe(true)

    fireEvent.click(button)
    expect(Object.keys(useWorldStore.getState().doc.servers)).toHaveLength(0)
  })
})
