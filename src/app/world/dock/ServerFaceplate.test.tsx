// @vitest-environment jsdom
// Polish 4 T4 (spec D6): the faceplate — plate header, vitals rail, drawer spine (one open at a
// time), action row. `price`/`enter`/`kill` assertions here MIGRATE (same assertions, new mount)
// from InspectorV2.test.tsx's "selected-server card actions" describe block — InspectorV2's
// selected-server pane retires this same task.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

const { mockUseReducedMotion } = vi.hoisted(() => ({ mockUseReducedMotion: vi.fn(() => false) }))
vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>()
  return { ...actual, useReducedMotion: mockUseReducedMotion }
})

import { ServerFaceplate } from './ServerFaceplate'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useNavStore } from '../../store/nav.store'
import { useUiStore } from '../../store/ui.store'
import { getPreset } from '../../../lib/world/instanceCatalog'
import type { MetricsBatch, ServerMetrics } from '../../../lib/worldEngine/types'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useSimulationStore.getState().resetSession()
  useUiStore.setState({ selectedServerId: null })
  mockUseReducedMotion.mockReturnValue(false)
})

function seedServer(): { regionId: string; azId: string; serverId: string } {
  const regionId = useWorldStore.getState().addRegion('us-east-1')
  const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
  const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
  return { regionId, azId, serverId }
}

const emptyServer: ServerMetrics = {
  serverId: '', coreUtilization: [0], stealFraction: 0, burstCredits: null,
  ramByInstance: [], ramUsedMb: 0, ramTotalMb: 1024, nicInMbps: 0, nicOutMbps: 0,
  diskIoFraction: 0, health: 'healthy',
}
function makeBatch(servers: Record<string, Partial<ServerMetrics>>): MetricsBatch {
  const serverRecord: MetricsBatch['servers'] = {}
  for (const [id, patch] of Object.entries(servers)) serverRecord[id] = { ...emptyServer, serverId: id, ...patch }
  return {
    simMs: 1000, instances: {}, servers: serverRecord, azs: {}, regions: {},
    world: { totalRps: 0, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 },
  }
}

describe('ServerFaceplate — plate header', () => {
  it('renders the hourly price in the price color (migrated from InspectorV2.test.tsx)', () => {
    const { serverId } = seedServer()
    const hourly = useWorldStore.getState().doc.servers[serverId].hourlyUsd
    render(<ServerFaceplate serverId={serverId} showEnter={false} />)
    const price = screen.getByText(`$${hourly.toFixed(3)}/hr`)
    expect(price.style.color).toBe('var(--color-price)')
  })

  it('renders name, KIND chip, and the rack/health sub-line ("free pool" when unracked)', () => {
    const { serverId } = seedServer()
    render(<ServerFaceplate serverId={serverId} showEnter={false} />)
    const server = useWorldStore.getState().doc.servers[serverId]
    expect(screen.getByTestId('faceplate-plate')).toHaveTextContent(server.label)
    expect(screen.getByTestId('faceplate-plate')).toHaveTextContent('VPS')
    expect(screen.getByTestId('faceplate-plate')).toHaveTextContent('free pool')
  })

  it('rack text comes from Server.rack when racked', () => {
    const { azId, serverId } = seedServer()
    useWorldStore.getState().addRack(azId)
    const rack = Object.values(useWorldStore.getState().doc.racks)[0]
    useWorldStore.getState().assignServerToRack(serverId, rack.id)
    render(<ServerFaceplate serverId={serverId} showEnter={false} />)
    expect(screen.getByTestId('faceplate-plate')).toHaveTextContent(`${rack.label} slot 1`)
  })

  it('posture line reads "stopped — authoring" at rest, "running — watching" while running', () => {
    const { serverId } = seedServer()
    render(<ServerFaceplate serverId={serverId} showEnter={false} />)
    expect(screen.getByTestId('faceplate-posture')).toHaveTextContent('stopped — authoring · everything editable')

    act(() => { useSimulationStore.setState({ running: true }) })
    render(<ServerFaceplate serverId={serverId} showEnter={false} />)
    expect(screen.getAllByTestId('faceplate-posture')[1]).toHaveTextContent('running — watching · stop to edit')
  })

  it('health word is omitted at rest, shown live while running', () => {
    const { serverId } = seedServer()
    render(<ServerFaceplate serverId={serverId} showEnter={false} />)
    expect(screen.getByTestId('faceplate-plate')).not.toHaveTextContent('healthy')

    const batch = makeBatch({ [serverId]: { health: 'healthy' } })
    act(() => { useSimulationStore.setState({ latestBatch: batch, running: true }) })
    render(<ServerFaceplate serverId={serverId} showEnter={false} />)
    expect(screen.getAllByTestId('faceplate-plate')[1]).toHaveTextContent('healthy')
  })
})

describe('ServerFaceplate — vitals rail', () => {
  it('renders the pulse dot and idle/live caption', () => {
    const { serverId } = seedServer()
    render(<ServerFaceplate serverId={serverId} showEnter={false} />)
    expect(screen.getByTestId('vitals-pulse')).toBeTruthy()
    expect(screen.getByTestId('vitals-caption')).toHaveTextContent('idle')
  })

  it('caption flips to "live" once a batch exists for this server', () => {
    const { serverId } = seedServer()
    const batch = makeBatch({ [serverId]: { coreUtilization: [0.4] } })
    act(() => { useSimulationStore.setState({ latestBatch: batch }) })
    render(<ServerFaceplate serverId={serverId} showEnter={false} />)
    expect(screen.getByTestId('vitals-caption')).toHaveTextContent('live')
  })

  it('the pulse is disabled (no ambient class) under reduced motion', () => {
    mockUseReducedMotion.mockReturnValue(true)
    const { serverId } = seedServer()
    render(<ServerFaceplate serverId={serverId} showEnter={false} />)
    expect(screen.getByTestId('vitals-pulse').className).toBe('')
  })

  it('the pulse carries the ambient breathe class when motion is not reduced', () => {
    const { serverId } = seedServer()
    render(<ServerFaceplate serverId={serverId} showEnter={false} />)
    expect(screen.getByTestId('vitals-pulse').className).toContain('dockfp-vitals-pulse')
  })
})

describe('ServerFaceplate — drawer spine', () => {
  it('defaults to HARDWARE open, everything else closed', () => {
    const { serverId } = seedServer()
    render(<ServerFaceplate serverId={serverId} showEnter={false} />)
    const drawers = screen.getAllByTestId('drawer')
    expect(drawers[0]).toHaveAttribute('data-drawer', 'HARDWARE')
    expect(drawers[0]).toHaveAttribute('data-open', 'true')
    expect(drawers.slice(1).every(d => d.getAttribute('data-open') === 'false')).toBe(true)
  })

  it('opening a different drawer closes the previously-open one (one open at a time)', () => {
    const { serverId } = seedServer()
    render(<ServerFaceplate serverId={serverId} showEnter={false} />)
    const headers = screen.getAllByTestId('drawer-header')
    fireEvent.click(headers[1])   // FIREWALL
    const drawers = screen.getAllByTestId('drawer')
    expect(drawers[1]).toHaveAttribute('data-open', 'true')
    expect(drawers[0]).toHaveAttribute('data-open', 'false')
  })

  it('clicking the open drawer again closes it (none open)', () => {
    const { serverId } = seedServer()
    render(<ServerFaceplate serverId={serverId} showEnter={false} />)
    const headers = screen.getAllByTestId('drawer-header')
    fireEvent.click(headers[0])   // HARDWARE, already open
    const drawers = screen.getAllByTestId('drawer')
    expect(drawers.every(d => d.getAttribute('data-open') === 'false')).toBe(true)
  })

  it('all four drawers render in HARDWARE/FIREWALL/SERVICES/PLACEMENT order with their pv readouts', () => {
    const { serverId } = seedServer()
    render(<ServerFaceplate serverId={serverId} showEnter={false} />)
    const drawers = screen.getAllByTestId('drawer')
    expect(drawers.map(d => d.getAttribute('data-drawer'))).toEqual(['HARDWARE', 'FIREWALL', 'SERVICES', 'PLACEMENT'])
  })
})

describe('ServerFaceplate — action row', () => {
  it('"enter board ⏎" only renders when showEnter is true', () => {
    const { serverId } = seedServer()
    const { rerender } = render(<ServerFaceplate serverId={serverId} showEnter={false} />)
    expect(screen.queryByTestId('faceplate-enter')).toBeNull()
    rerender(<ServerFaceplate serverId={serverId} showEnter />)
    expect(screen.getByTestId('faceplate-enter')).toBeTruthy()
  })

  it('"enter board ⏎" dispatches goServer with the nav region/az and this server (migrated from InspectorV2.test.tsx)', () => {
    const { regionId, azId, serverId } = seedServer()
    useNavStore.getState().goAz(regionId, azId)
    render(<ServerFaceplate serverId={serverId} showEnter />)
    fireEvent.click(screen.getByTestId('faceplate-enter'))
    const nav = useNavStore.getState()
    expect(nav.level).toBe('server')
    expect(nav.serverId).toBe(serverId)
    expect(nav.azId).toBe(azId)
  })

  it('kill is disabled while stopped and dispatches setOutage("server", id, true) while running (migrated from InspectorV2.test.tsx)', () => {
    const { serverId } = seedServer()
    render(<ServerFaceplate serverId={serverId} showEnter={false} />)

    const kill = screen.getByTestId('faceplate-kill')
    expect(kill).toHaveAttribute('aria-disabled', 'true')
    expect(kill).toHaveAttribute('title', 'start the simulation to break things')

    act(() => { useSimulationStore.setState({ running: true }) })
    render(<ServerFaceplate serverId={serverId} showEnter={false} />)
    const kills = screen.getAllByTestId('faceplate-kill')
    fireEvent.click(kills[kills.length - 1])
    expect(useSimulationStore.getState().healthOverrides[serverId]).toBe(true)
    const restores = screen.getAllByText('↺ restore')
    fireEvent.click(restores[restores.length - 1])
    expect(useSimulationStore.getState().healthOverrides[serverId] ?? false).toBe(false)
  })

  it('kill survives being nested in an ambient <fieldset disabled> while running', () => {
    const { serverId } = seedServer()
    act(() => { useSimulationStore.setState({ running: true }) })
    render(
      <fieldset disabled>
        <ServerFaceplate serverId={serverId} showEnter={false} />
      </fieldset>,
    )
    fireEvent.click(screen.getByTestId('faceplate-kill'))
    expect(useSimulationStore.getState().healthOverrides[serverId]).toBe(true)
  })

  it('"remove…" requires a two-step confirm, then dispatches removeServer + clears selection', () => {
    const { serverId } = seedServer()
    useUiStore.setState({ selectedServerId: serverId })
    render(<ServerFaceplate serverId={serverId} showEnter={false} />)
    const removeBtn = screen.getByTestId('faceplate-remove')
    expect(removeBtn).toHaveTextContent('remove…')
    fireEvent.click(removeBtn)
    expect(useWorldStore.getState().doc.servers[serverId]).toBeTruthy()
    expect(screen.getByTestId('faceplate-remove')).toHaveTextContent('confirm remove?')
    fireEvent.click(screen.getByTestId('faceplate-remove'))
    expect(useWorldStore.getState().doc.servers[serverId]).toBeUndefined()
    expect(useUiStore.getState().selectedServerId).toBeNull()
  })

  it('"remove…" is edit-locked while running', () => {
    const { serverId } = seedServer()
    act(() => { useSimulationStore.setState({ running: true }) })
    render(<ServerFaceplate serverId={serverId} showEnter={false} />)
    const removeBtn = screen.getByTestId('faceplate-remove')
    expect(removeBtn).toBeDisabled()
    expect(removeBtn).toHaveAttribute('title', 'stop the simulation to edit')
  })
})

describe('ServerFaceplate — unknown server', () => {
  it('renders nothing when the server id does not resolve', () => {
    useWorldStore.getState().newWorld()
    const { container } = render(<ServerFaceplate serverId="nope" showEnter={false} />)
    expect(container.firstChild).toBeNull()
  })
})
