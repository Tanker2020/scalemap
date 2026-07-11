// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { InspectorV2 } from './InspectorV2'
import { useWorldStore } from '../store/world.store'
import { useSimulationStore } from '../store/simulation.store'
import { useNavStore } from '../store/nav.store'
import { getPreset } from '../../lib/world/instanceCatalog'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useSimulationStore.getState().resetSession()
})

function seedAz() {
  const regionId = useWorldStore.getState().addRegion('us-east-1')
  const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
  return { regionId, azId }
}

describe('InspectorV2 — selected-server rack selector (Polish 3 T4)', () => {
  it('renders nothing with no selection and no traced requests', () => {
    const { azId } = seedAz()
    const { container } = render(<InspectorV2 azId={azId} />)
    expect(container.firstChild).toBeNull()
  })

  it('rack selector disables full racks and dispatches assignServerToRack', () => {
    const { azId } = seedAz()

    // rack-full: shrunk to its 4U minimum capacity, then filled exactly by two 2U dedicated servers.
    useWorldStore.getState().addRack(azId)
    const rackFull = Object.values(useWorldStore.getState().doc.racks)[0]
    useWorldStore.getState().updateRack(rackFull.id, { capacityU: 4 })
    const d1 = useWorldStore.getState().addServer(azId, getPreset('dedicated-8')!)
    const d2 = useWorldStore.getState().addServer(azId, getPreset('dedicated-8')!)
    useWorldStore.getState().assignServerToRack(d1, rackFull.id)
    useWorldStore.getState().assignServerToRack(d2, rackFull.id)
    expect(useWorldStore.getState().doc.racks[rackFull.id].capacityU).toBe(4)

    // rack-open: freshly added, empty, plenty of room (default capacityU 8).
    useWorldStore.getState().addRack(azId)
    const rackOpen = Object.values(useWorldStore.getState().doc.racks).find(r => r.id !== rackFull.id)!

    // The selected server: a fresh 1U vps, still in the free pool.
    const selected = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)

    render(<InspectorV2 azId={azId} selectedServerId={selected} onClearSelection={() => {}} />)

    const select = screen.getByLabelText('rack') as HTMLSelectElement
    const options = Array.from(select.options)
    const fullOption = options.find(o => o.value === rackFull.id)!
    const openOption = options.find(o => o.value === rackOpen.id)!
    const freePoolOption = options.find(o => o.value === '__free_pool__')!

    expect(fullOption.disabled).toBe(true)
    expect(openOption.disabled).toBe(false)
    expect(freePoolOption.disabled).toBe(false)
    expect(fullOption.textContent).toContain('4/4 U')

    fireEvent.change(select, { target: { value: rackOpen.id } })
    expect(useWorldStore.getState().doc.servers[selected].rack?.rackId).toBe(rackOpen.id)
  })

  it('clear-selection button calls onClearSelection', () => {
    const { azId } = seedAz()
    const selected = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    let cleared = false
    render(<InspectorV2 azId={azId} selectedServerId={selected} onClearSelection={() => { cleared = true }} />)
    fireEvent.click(screen.getByLabelText('clear selection'))
    expect(cleared).toBe(true)
  })
})

describe('InspectorV2 — selected-server card actions (post-Polish-3 fix wave)', () => {
  it('renders the hourly price in the price color', () => {
    const { azId } = seedAz()
    const selected = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    const hourly = useWorldStore.getState().doc.servers[selected].hourlyUsd
    render(<InspectorV2 azId={azId} selectedServerId={selected} onClearSelection={() => {}} />)
    const price = screen.getByText(`$${hourly.toFixed(3)}/hr`)
    expect(price.style.color).toBe('var(--color-price)')
  })

  it('enter dispatches goServer with the nav region, this az, and the server', () => {
    const { regionId, azId } = seedAz()
    const selected = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    useNavStore.getState().goAz(regionId, azId)
    render(<InspectorV2 azId={azId} selectedServerId={selected} onClearSelection={() => {}} />)
    fireEvent.click(screen.getByText('⏎ enter'))
    const nav = useNavStore.getState()
    expect(nav.level).toBe('server')
    expect(nav.serverId).toBe(selected)
    expect(nav.azId).toBe(azId)
  })

  it('kill is disabled while stopped and dispatches setOutage("server", id, true) while running', () => {
    const { azId } = seedAz()
    const selected = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(<InspectorV2 azId={azId} selectedServerId={selected} onClearSelection={() => {}} />)

    const kill = screen.getByText('⚡ kill') as HTMLButtonElement
    expect(kill.disabled).toBe(true)
    expect(kill.title).toBe('start the simulation to break things')

    act(() => { useSimulationStore.setState({ running: true }) })
    fireEvent.click(screen.getByText('⚡ kill'))
    expect(useSimulationStore.getState().healthOverrides[selected]).toBe(true)
    // Now shows restore, which clears the override.
    fireEvent.click(screen.getByText('↺ restore'))
    expect(useSimulationStore.getState().healthOverrides[selected] ?? false).toBe(false)
  })
})
