// @vitest-environment jsdom
// Polish 4 T3 (spec D3/D5): AZ scope's Config tab — rack capacity wells, slat rows, this AZ's
// cost, and the relocated floor-toolbar actions (`+ server`/`auto-arrange`/`kill AZ`).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

// Same precedent as az/DatacenterFloor.test.tsx / dock/AtlasHeader.test.tsx — mock the hook
// directly rather than stubbing matchMedia (framer-motion's reduced-motion listener only
// initializes once per test-module lifetime).
const { mockUseReducedMotion } = vi.hoisted(() => ({ mockUseReducedMotion: vi.fn(() => false) }))
vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>()
  return { ...actual, useReducedMotion: mockUseReducedMotion }
})

import { AzConfigTab } from './AzConfigTab'
import { useWorldStore } from '../../store/world.store'
import { useUiStore } from '../../store/ui.store'
import { useSimulationStore } from '../../store/simulation.store'
import { getPreset } from '../../../lib/world/instanceCatalog'
import type { MetricsBatch, ServerMetrics } from '../../../lib/worldEngine/types'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useUiStore.setState({ selectedServerId: null })
  useSimulationStore.getState().resetSession()
  mockUseReducedMotion.mockReturnValue(false)
})

function seedAz() {
  const regionId = useWorldStore.getState().addRegion('us-east-1')
  const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
  return { regionId, azId }
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

describe('AzConfigTab', () => {
  it('renders one rack-well per rack with a used/capacity caption', () => {
    const { azId } = seedAz()
    useWorldStore.getState().addRack(azId)
    const server = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    const rack = Object.values(useWorldStore.getState().doc.racks)[0]
    useWorldStore.getState().assignServerToRack(server, rack.id)

    render(<AzConfigTab azId={azId} />)
    const wells = screen.getAllByTestId('rack-well')
    expect(wells).toHaveLength(1)
    expect(wells[0].parentElement).toHaveTextContent(`${rack.label}`)
    expect(wells[0].parentElement).toHaveTextContent(`1/${rack.capacityU}U`)
  })

  it('shows the "+ rack" ghost well while stopped, hides it while running', () => {
    const { azId } = seedAz()
    render(<AzConfigTab azId={azId} />)
    expect(screen.getByTestId('rack-well-ghost')).toBeTruthy()

    act(() => { useSimulationStore.setState({ running: true }) })
    render(<AzConfigTab azId={azId} />)
    expect(screen.queryByTestId('rack-well-ghost')).toBeNull()
  })

  it('"+ rack" ghost dispatches addRack byte-for-byte', () => {
    const { azId } = seedAz()
    render(<AzConfigTab azId={azId} />)
    fireEvent.click(screen.getByTestId('rack-well-ghost'))
    expect(Object.values(useWorldStore.getState().doc.racks)).toHaveLength(1)
  })

  it('rack "×" deletes the rack and frees its resident servers to the pool', () => {
    const { azId } = seedAz()
    useWorldStore.getState().addRack(azId)
    const rack = Object.values(useWorldStore.getState().doc.racks)[0]
    const server = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    useWorldStore.getState().assignServerToRack(server, rack.id)

    render(<AzConfigTab azId={azId} />)
    fireEvent.click(screen.getByTestId('rack-delete'))
    expect(useWorldStore.getState().doc.racks[rack.id]).toBeUndefined()
    expect(useWorldStore.getState().doc.servers[server].rack).toBeNull()   // freed, not deleted
  })

  it('rack "×" is hidden while running (edit-locked, same gate as the "+ rack" ghost)', () => {
    const { azId } = seedAz()
    useWorldStore.getState().addRack(azId)
    act(() => { useSimulationStore.setState({ running: true }) })
    render(<AzConfigTab azId={azId} />)
    expect(screen.queryByTestId('rack-delete')).toBeNull()
  })

  it('renders one dock-slat per server, racked first then free pool', () => {
    const { azId } = seedAz()
    useWorldStore.getState().addRack(azId)
    const rack = Object.values(useWorldStore.getState().doc.racks)[0]
    const racked = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    useWorldStore.getState().assignServerToRack(racked, rack.id)
    const free = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)

    render(<AzConfigTab azId={azId} />)
    const slats = screen.getAllByTestId('dock-slat')
    expect(slats).toHaveLength(2)
    expect(slats[0]).toHaveTextContent(useWorldStore.getState().doc.servers[racked].label)
    expect(slats[1]).toHaveTextContent(useWorldStore.getState().doc.servers[free].label)
  })

  it('slat meta shows plain kind at rest, "kind · healthWord" while a batch is live', () => {
    const { azId } = seedAz()
    const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(<AzConfigTab azId={azId} />)
    expect(screen.getByTestId('dock-slat')).toHaveTextContent('vps')
    expect(screen.getByTestId('dock-slat')).not.toHaveTextContent('comfortable')

    const batch = makeBatch({ [serverId]: { coreUtilization: [0.1], ramUsedMb: 100, ramTotalMb: 1024, health: 'healthy' } })
    act(() => { useSimulationStore.setState({ latestBatch: batch }) })
    render(<AzConfigTab azId={azId} />)
    const slats = screen.getAllByTestId('dock-slat')
    expect(slats[slats.length - 1]).toHaveTextContent('vps · comfortable')
  })

  it('clicking a slat selects that server', () => {
    const { azId } = seedAz()
    const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(<AzConfigTab azId={azId} />)
    fireEvent.click(screen.getByTestId('dock-slat'))
    expect(useUiStore.getState().selectedServerId).toBe(serverId)
  })

  it('slat selection survives being nested in an ambient `<fieldset disabled>` (WorldPanel.tsx\'s real wrapper while running) — a native <button> would be silently unclickable here', () => {
    const { azId } = seedAz()
    const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(
      <fieldset disabled>
        <AzConfigTab azId={azId} />
      </fieldset>,
    )
    fireEvent.click(screen.getByTestId('dock-slat'))
    expect(useUiStore.getState().selectedServerId).toBe(serverId)
  })

  it('at most ONE slat blinks (D3 motion budget) — the busiest server by live mean CPU, running only', () => {
    const { azId } = seedAz()
    const a = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    const b = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    const batch = makeBatch({
      [a]: { coreUtilization: [0.9] },
      [b]: { coreUtilization: [0.2] },
    })
    act(() => { useSimulationStore.setState({ latestBatch: batch, running: true }) })
    render(<AzConfigTab azId={azId} />)

    const slats = screen.getAllByTestId('dock-slat')
    const blinking = slats.filter(s => s.getAttribute('data-blinking') === 'true')
    expect(blinking).toHaveLength(1)
    expect(blinking[0]).toHaveTextContent(useWorldStore.getState().doc.servers[a].label)
  })

  it('no slat blinks while stopped, even with a live-looking batch present (scrub)', () => {
    const { azId } = seedAz()
    const a = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    const batch = makeBatch({ [a]: { coreUtilization: [0.95] } })
    act(() => { useSimulationStore.setState({ latestBatch: batch, running: false }) })
    render(<AzConfigTab azId={azId} />)
    expect(screen.getAllByTestId('dock-slat').some(s => s.getAttribute('data-blinking') === 'true')).toBe(false)
  })

  it('no slat blinks under reduced motion, even while running', () => {
    mockUseReducedMotion.mockReturnValue(true)
    const { azId } = seedAz()
    const a = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    const batch = makeBatch({ [a]: { coreUtilization: [0.95] } })
    act(() => { useSimulationStore.setState({ latestBatch: batch, running: true }) })
    render(<AzConfigTab azId={azId} />)
    expect(screen.getAllByTestId('dock-slat').some(s => s.getAttribute('data-blinking') === 'true')).toBe(false)
  })

  it('renders blueprint accent ticks matching serverAccents', () => {
    const { azId } = seedAz()
    const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    const bpId = useWorldStore.getState().addBlueprint('api')
    useWorldStore.getState().addPlacement(bpId, serverId)
    render(<AzConfigTab azId={azId} />)
    const slat = screen.getByTestId('dock-slat')
    // one small <i> tick per accent color — assert at least one rendered inside the slat.
    expect(slat.querySelector('i')).toBeTruthy()
  })

  it('shows this AZ\'s cost, price-colored, $/hr and $/mo', () => {
    const { azId } = seedAz()
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(<AzConfigTab azId={azId} />)
    const row = screen.getByText(/servers \+ egress share/i).parentElement!
    expect(row).toHaveTextContent('/hr')
    expect(row).toHaveTextContent('/mo')
  })

  // The hardcoded "+ server" button (always a vps-medium) was replaced by the typed node
  // palette, which is what the tab now embeds. NodePalette has its own dedicated coverage in
  // az/NodePalette.test.tsx — these two assert only that the tab actually mounts it and that it
  // participates in the tab's edit-lock.
  it('embeds the typed node palette, offering compute and data nodes', () => {
    const { azId } = seedAz()
    render(<AzConfigTab azId={azId} />)
    expect(screen.getByRole('button', { name: /VPS Medium/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^SQL DB Medium/i })).toBeTruthy()
  })

  it('adds a compute host through the palette', () => {
    const { azId } = seedAz()
    render(<AzConfigTab azId={azId} />)
    fireEvent.click(screen.getByRole('button', { name: /VPS Medium/i }))
    const servers = Object.values(useWorldStore.getState().doc.servers)
    expect(servers).toHaveLength(1)
    expect(servers[0].catalogId).toBe(getPreset('vps-medium')!.id)
  })

  it('the palette and "auto-arrange" are edit-locked while running', () => {
    const { azId } = seedAz()
    act(() => { useSimulationStore.setState({ running: true }) })
    render(<AzConfigTab azId={azId} />)
    const addBtn = screen.getByRole('button', { name: /VPS Medium/i })
    const arrangeBtn = screen.getByText('auto-arrange')
    expect(addBtn).toBeDisabled()
    expect(addBtn).toHaveAttribute('title', 'stop the simulation to edit')
    expect(arrangeBtn).toBeDisabled()
    expect(arrangeBtn).toHaveAttribute('title', 'stop the simulation to edit')
  })

  it('"auto-arrange" dispatches autoArrangeAz', () => {
    const { azId } = seedAz()
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(<AzConfigTab azId={azId} />)
    fireEvent.click(screen.getByText('auto-arrange'))
    expect(Object.values(useWorldStore.getState().doc.racks)).toHaveLength(1)
  })

  it('"kill AZ" is disabled while stopped, with the standard run-only title', () => {
    const { azId } = seedAz()
    render(<AzConfigTab azId={azId} />)
    const btn = screen.getByText('kill AZ')
    // A plain <div role="button">, not a native <button> — it must stay clickable-by-the-DOM
    // even while WorldPanel.tsx's ambient `<fieldset disabled={running}>` is active (which is
    // exactly what run-only "kill AZ" needs: clickable precisely when running, i.e. when a real
    // <button> sibling would be fieldset-disabled) — so disabledness is `aria-disabled`, not the
    // native `disabled` attribute `toBeDisabled()` checks.
    expect(btn).toHaveAttribute('aria-disabled', 'true')
    expect(btn).toHaveAttribute('title', 'start the simulation to break things')
    fireEvent.click(btn)
    expect(useSimulationStore.getState().healthOverrides[azId]).toBeUndefined()
  })

  it('"kill AZ" survives being nested in an ambient `<fieldset disabled>` (WorldPanel.tsx\'s real wrapper) — a native <button> would not', () => {
    const { azId } = seedAz()
    act(() => { useSimulationStore.setState({ running: true }) })
    render(
      <fieldset disabled>
        <AzConfigTab azId={azId} />
      </fieldset>,
    )
    fireEvent.click(screen.getByText('kill AZ'))
    expect(useSimulationStore.getState().healthOverrides[azId]).toBe(true)
  })

  it('"kill AZ" dispatches setOutage(\'az\', azId, true) while running, then inverts to "↺ restore"', () => {
    const { azId } = seedAz()
    act(() => { useSimulationStore.setState({ running: true }) })
    render(<AzConfigTab azId={azId} />)
    fireEvent.click(screen.getByText('kill AZ'))
    expect(useSimulationStore.getState().healthOverrides[azId]).toBe(true)

    render(<AzConfigTab azId={azId} />)
    const restoreBtns = screen.getAllByText('↺ restore')
    expect(restoreBtns.length).toBeGreaterThan(0)
    fireEvent.click(restoreBtns[restoreBtns.length - 1])
    expect(useSimulationStore.getState().healthOverrides[azId]).toBe(false)
  })

  it('shows an empty state when the AZ has no servers yet', () => {
    const { azId } = seedAz()
    render(<AzConfigTab azId={azId} />)
    expect(screen.getByTestId('az-config-tab')).toHaveTextContent(/no servers/i)
  })

  // node-model Phase 5.3: managed services present in the AZ show in the slat list.
  it('lists az-scoped and region-scoped managed services in the SERVERS list', () => {
    const { regionId, azId } = seedAz()
    const azMs = useWorldStore.getState().addManagedService('redis', 'Cache', { kind: 'az', azId }, 6379)
    const regionMs = useWorldStore.getState().addManagedService('dbSql', 'SQL DB', { kind: 'region', regionId }, 5432)
    render(<AzConfigTab azId={azId} />)
    expect(screen.getByTestId(`az-managed-${azMs}`)).toBeTruthy()
    expect(screen.getByTestId(`az-managed-${regionMs}`)).toHaveTextContent(/region/)
  })

  // node-model Phase 5.4: the row showed rps text only, so a DB pinned at its ceiling read exactly
  // like an idle one. It now carries a saturation bar plus latency/connection numbers.
  it('shows the managed-DB saturation readout (sat% / p50 / connections) when the runtime publishes it', () => {
    const { regionId, azId } = seedAz()
    const msId = useWorldStore.getState().addManagedService('dbSql', 'SQL DB', { kind: 'region', regionId }, 5432)
    useWorldStore.getState().updateManagedService(msId, { instanceClassId: 'sql.small' })
    const batch = {
      simMs: 1000, instances: {}, servers: {}, azs: {}, regions: {},
      world: { totalRps: 0, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 },
      managedServices: {
        [msId]: {
          managedServiceId: msId, rps: 2274, refusedRps: 931, utilization: 0.9, health: 'degraded' as const,
          egressBytesPerSec: 0, saturation: 0.91, p50Ms: 78.2, p99Ms: 234.6, connections: 104, errorRps: 0,
        },
      },
    } as unknown as MetricsBatch
    act(() => { useSimulationStore.setState({ latestBatch: batch }) })
    render(<AzConfigTab azId={azId} />)
    const row = screen.getByTestId(`az-managed-${msId}`)
    expect(row).toHaveTextContent(/2274 rps/)
    expect(row).toHaveTextContent(/91%/)      // saturation on the binding axis
    expect(row).toHaveTextContent(/78ms/)     // queueing latency
    expect(row).toHaveTextContent(/104c/)     // live connections
  })

  it('flags a managed DB that is erroring on its query timeout', () => {
    const { regionId, azId } = seedAz()
    const msId = useWorldStore.getState().addManagedService('dbSql', 'SQL DB', { kind: 'region', regionId }, 5432)
    const batch = {
      simMs: 1000, instances: {}, servers: {}, azs: {}, regions: {},
      world: { totalRps: 0, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 },
      managedServices: {
        [msId]: {
          managedServiceId: msId, rps: 1672, refusedRps: 0, utilization: 0.63, health: 'degraded' as const,
          egressBytesPerSec: 0, saturation: 0.66, p50Ms: 9.8, p99Ms: 29.4, connections: 17, errorRps: 228,
        },
      },
    } as unknown as MetricsBatch
    act(() => { useSimulationStore.setState({ latestBatch: batch }) })
    render(<AzConfigTab azId={azId} />)
    expect(screen.getByTestId(`az-managed-${msId}`)).toHaveTextContent('⚠')
  })

  describe('CONNECTIONS section (opens a read-only graph, 2026-07-25)', () => {
    function wireApiDb(azId: string, dbAzId = azId) {
      const apiSrv = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
      const dbSrv = useWorldStore.getState().addServer(dbAzId, getPreset('vps-medium')!)
      const apiBp = useWorldStore.getState().addBlueprint('api')
      const dbBp = useWorldStore.getState().addBlueprint('db')
      useWorldStore.getState().addPlacement(apiBp, apiSrv)
      useWorldStore.getState().addPlacement(dbBp, dbSrv)
      useWorldStore.getState().connectServices(apiBp, { kind: 'blueprint', blueprintId: dbBp }, { port: 5432, protocol: 'db', autoProvision: true })
      return { apiBp, dbBp, apiSrv, dbSrv }
    }

    it('shows the empty state and a disabled button with no connections touching this AZ', () => {
      const { azId } = seedAz()
      render(<AzConfigTab azId={azId} />)
      expect(screen.getByText(/no connections touch this az/i)).toBeInTheDocument()
      expect(screen.getByText('open graph ↗')).toBeDisabled()
    })

    it('shows a connection count and an enabled button once a dependency touches this AZ', () => {
      const { azId } = seedAz()
      wireApiDb(azId)
      render(<AzConfigTab azId={azId} />)
      expect(screen.getByText(/1 connection touch/i)).toBeInTheDocument()
      expect(screen.getByText('open graph ↗')).not.toBeDisabled()
    })

    it('"open graph" opens AzConnectionsView with this AZ\'s nodes/edges, read-only', () => {
      const { azId } = seedAz()
      const { apiBp, dbBp } = wireApiDb(azId)
      render(<AzConfigTab azId={azId} />)

      fireEvent.click(screen.getByText('open graph ↗'))
      expect(screen.getByTestId(`az-conn-node-${apiBp}`)).toBeInTheDocument()
      expect(screen.getByTestId(`az-conn-node-${dbBp}`)).toBeInTheDocument()
      // Read-only: no connect handle, no draft bar affordance anywhere in the overlay.
      expect(screen.queryByTitle('drag to connect')).toBeNull()
    })

    it('"close" on the graph overlay hides it again', () => {
      const { azId } = seedAz()
      wireApiDb(azId)
      render(<AzConfigTab azId={azId} />)
      fireEvent.click(screen.getByText('open graph ↗'))
      expect(screen.getByTestId('az-conn-canvas')).toBeInTheDocument()

      fireEvent.click(screen.getByText('close'))
      expect(screen.queryByTestId('az-conn-canvas')).toBeNull()
    })

    it('a cross-AZ dependency appears in both AZs\' graphs', () => {
      const { regionId, azId: azA } = seedAz()
      const azB = useWorldStore.getState().addAz(regionId, 'us-east-1b')
      const { apiBp, dbBp } = wireApiDb(azA, azB)

      const { unmount } = render(<AzConfigTab azId={azA} />)
      fireEvent.click(screen.getByText('open graph ↗'))
      expect(screen.getByTestId(`az-conn-node-${apiBp}`)).toBeInTheDocument()
      expect(screen.getByTestId(`az-conn-node-${dbBp}`)).toBeInTheDocument()
      unmount()

      render(<AzConfigTab azId={azB} />)
      fireEvent.click(screen.getByText('open graph ↗'))
      expect(screen.getByTestId(`az-conn-node-${apiBp}`)).toBeInTheDocument()
      expect(screen.getByTestId(`az-conn-node-${dbBp}`)).toBeInTheDocument()
    })

    it('clicking a blocked edge shows its block reason in the read-only inspector', () => {
      const { azId } = seedAz()
      const { dbSrv } = wireApiDb(azId)
      useWorldStore.getState().updateServer(dbSrv, { firewall: [{ id: 'deny', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' }] })

      render(<AzConfigTab azId={azId} />)
      fireEvent.click(screen.getByText('open graph ↗'))
      const edge = screen.getByTestId(/^az-conn-edge-/)
      fireEvent.click(edge)
      expect(screen.getByText(/●\s*blocked/)).toBeInTheDocument()
    })
  })
})
