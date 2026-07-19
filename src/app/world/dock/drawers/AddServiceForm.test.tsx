// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AddServiceForm } from './AddServiceForm'
import { useWorldStore } from '../../../store/world.store'
import { getPreset } from '../../../../lib/world/instanceCatalog'
import { COST_MS } from '../../../../lib/world/serviceDraft'

function seedHost(): string {
  const regionId = useWorldStore.getState().addRegion('us-east-1')
  const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
  return useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
}

function nameIt(value: string): void {
  fireEvent.change(screen.getByLabelText(/service name/i), { target: { value } })
}

beforeEach(() => useWorldStore.getState().newWorld())

describe('AddServiceForm', () => {
  it('creates the service and places it on the host', () => {
    const serverId = seedHost()
    render(<AddServiceForm serverId={serverId} running={false} onDone={() => {}} />)

    nameIt('orders-api')
    fireEvent.click(screen.getByRole('button', { name: /add service/i }))

    const doc = useWorldStore.getState().doc
    const bp = Object.values(doc.blueprints)[0]
    expect(bp.name).toBe('orders-api')
    expect(Object.values(doc.placements)[0]).toMatchObject({ blueprintId: bp.id, serverId })
  })

  // A nameless service is unreadable everywhere it appears (chips, rows, the graph), so the
  // action stays inert rather than creating "Untitled".
  it('will not submit without a name', () => {
    const serverId = seedHost()
    render(<AddServiceForm serverId={serverId} running={false} onDone={() => {}} />)

    expect(screen.getByRole('button', { name: /add service/i })).toBeDisabled()

    nameIt('api')

    expect(screen.getByRole('button', { name: /add service/i })).not.toBeDisabled()
  })

  it('writes the chosen cost preset into the workload', () => {
    const serverId = seedHost()
    render(<AddServiceForm serverId={serverId} running={false} onDone={() => {}} />)

    nameIt('heavy-api')
    fireEvent.click(screen.getByRole('radio', { name: /heavy/i }))
    fireEvent.click(screen.getByRole('button', { name: /add service/i }))

    const bp = Object.values(useWorldStore.getState().doc.blueprints)[0]
    expect(bp.workload.cpuMsPerRequest).toBe(COST_MS.heavy)
  })

  // The kind picker is the first control because it changes what the rest of the form asks.
  it('hides the port controls for a worker, which binds nothing', () => {
    const serverId = seedHost()
    render(<AddServiceForm serverId={serverId} running={false} onDone={() => {}} />)

    expect(screen.getByLabelText(/^port$/i)).toBeTruthy()

    fireEvent.change(screen.getByLabelText(/service kind/i), { target: { value: 'worker' } })

    expect(screen.queryByLabelText(/^port$/i)).toBeNull()
  })

  it('offers no database kind — a db arrives as an appliance from the AZ palette', () => {
    const serverId = seedHost()
    render(<AddServiceForm serverId={serverId} running={false} onDone={() => {}} />)

    const options = [...screen.getByLabelText(/service kind/i).querySelectorAll('option')]
      .map(o => (o as HTMLOptionElement).value)

    expect(options).not.toContain('db-sql')
    expect(options).not.toContain('db-nosql')
  })

  // Advanced is the escape hatch: presets are a starting point, not a ceiling.
  it('exposes the raw workload numbers under Advanced, and they win', () => {
    const serverId = seedHost()
    render(<AddServiceForm serverId={serverId} running={false} onDone={() => {}} />)

    nameIt('tuned')
    fireEvent.click(screen.getByRole('button', { name: /advanced/i }))
    fireEvent.change(screen.getByLabelText(/cpu \/ request/i), { target: { value: '17' } })
    fireEvent.click(screen.getByRole('button', { name: /add service/i }))

    expect(Object.values(useWorldStore.getState().doc.blueprints)[0].workload.cpuMsPerRequest).toBe(17)
  })

  // Picking a preset after hand-tuning must take effect — otherwise the two controls silently
  // disagree and the preset buttons look broken.
  it('lets a preset overwrite a hand-tuned value chosen earlier', () => {
    const serverId = seedHost()
    render(<AddServiceForm serverId={serverId} running={false} onDone={() => {}} />)

    nameIt('retuned')
    fireEvent.click(screen.getByRole('button', { name: /advanced/i }))
    fireEvent.change(screen.getByLabelText(/cpu \/ request/i), { target: { value: '17' } })
    fireEvent.click(screen.getByRole('radio', { name: /light/i }))
    fireEvent.click(screen.getByRole('button', { name: /add service/i }))

    expect(Object.values(useWorldStore.getState().doc.blueprints)[0].workload.cpuMsPerRequest).toBe(COST_MS.light)
  })

  it('closes itself after adding', () => {
    const serverId = seedHost()
    const onDone = vi.fn()
    render(<AddServiceForm serverId={serverId} running={false} onDone={onDone} />)

    nameIt('api')
    fireEvent.click(screen.getByRole('button', { name: /add service/i }))

    expect(onDone).toHaveBeenCalledOnce()
  })

  it('is edit-locked while the simulation runs', () => {
    const serverId = seedHost()
    render(<AddServiceForm serverId={serverId} running onDone={() => {}} />)
    expect(screen.getByRole('button', { name: /add service/i })).toBeDisabled()
  })
})
