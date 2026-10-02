// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BlueprintsPanel } from './BlueprintsPanel'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useSimulationStore.setState({ running: false })
})

describe('BlueprintsPanel — "+ new service"', () => {
  it('creates an UNPLACED service definition and says where to mount it', () => {
    render(<BlueprintsPanel openConnections={() => {}} />)
    expect(screen.getByText(/no services yet — create one above/)).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('new service'))
    fireEvent.change(screen.getByLabelText(/service name/i), { target: { value: 'orders-api' } })
    fireEvent.click(screen.getByRole('button', { name: /add service/i }))

    const doc = useWorldStore.getState().doc
    const bps = Object.values(doc.blueprints)
    expect(bps).toHaveLength(1)
    expect(bps[0]).toMatchObject({ name: 'orders-api', kind: 'api', ownerServerKind: null })
    expect(Object.keys(doc.placements)).toHaveLength(0)
    expect(screen.getByText(/not placed — mount it from a server's Services drawer/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /add service/i })).toBeNull()   // form closed
  })

  it('creates a reverse proxy with its default routing config', () => {
    render(<BlueprintsPanel openConnections={() => {}} />)
    fireEvent.click(screen.getByLabelText('new service'))
    fireEvent.change(screen.getByLabelText(/service kind/i), { target: { value: 'proxy' } })
    fireEvent.change(screen.getByLabelText(/service name/i), { target: { value: 'edge' } })
    fireEvent.click(screen.getByRole('button', { name: /add service/i }))
    const bp = Object.values(useWorldStore.getState().doc.blueprints)[0]
    expect(bp.kind).toBe('proxy')
    expect(bp.proxyConfig).toBeDefined()
  })

  it('cancel closes the form without creating anything', () => {
    render(<BlueprintsPanel openConnections={() => {}} />)
    fireEvent.click(screen.getByLabelText('new service'))
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(Object.keys(useWorldStore.getState().doc.blueprints)).toHaveLength(0)
    expect(screen.getByLabelText('new service')).toBeInTheDocument()
  })

  it('is edit-locked while the simulation runs', () => {
    useSimulationStore.setState({ running: true })
    render(<BlueprintsPanel openConnections={() => {}} />)
    expect(screen.getByLabelText('new service')).toBeDisabled()
  })
})
