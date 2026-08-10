// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DatacenterFloor } from './DatacenterFloor'
import { isoBox, VIEW_W, VIEW_H } from './iso'
import { POD_HEIGHT_PX } from './FreePoolPod'
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useUiStore } from '../../store/ui.store'
import { getPreset } from '../../../lib/world/instanceCatalog'
import type { MetricsBatch, InstanceMetrics, ServerMetrics } from '../../../lib/worldEngine/types'

// `useReducedMotion` reads a module-level singleton inside framer-motion/motion-dom that only
// ever initializes once per test-module lifetime (a `hasReducedMotionListener` guard), so
// stubbing `window.matchMedia` per-test is unreliable once any earlier test in this file has
// already rendered the hook. Mock the hook directly instead — the only framer-motion export this
// subtree (DatacenterFloor + its RackCabinet/FreePoolPod children) uses.
const { mockUseReducedMotion } = vi.hoisted(() => ({ mockUseReducedMotion: vi.fn(() => false) }))
vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>()
  return { ...actual, useReducedMotion: mockUseReducedMotion }
})

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useSimulationStore.getState().resetSession()
  useNavStore.setState({ level: 'az', regionId: null, azId: null, serverId: null })
  mockUseReducedMotion.mockReturnValue(false)
})

function seedAz() {
  const regionId = useWorldStore.getState().addRegion('us-east-1')
  const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
  useNavStore.getState().goAz(regionId, azId)
  return { regionId, azId }
}

const emptyInstance: InstanceMetrics = {
  instanceId: '', rps: 0, errorRate: 0, p50Ms: 0, p99Ms: 0, p90Ms: 0, activeConnections: 0,
  cpuCoresUsed: 0, ramMb: 0, health: 'healthy',
}
const emptyServer: ServerMetrics = {
  serverId: '', coreUtilization: [0.2], stealFraction: 0, burstCredits: null,
  ramByInstance: [], ramUsedMb: 0, ramTotalMb: 1024, nicInMbps: 0, nicOutMbps: 0,
  diskIoFraction: 0, health: 'healthy',
}

function makeBatch(instances: Record<string, number>, servers: string[]): MetricsBatch {
  const instanceRecord: MetricsBatch['instances'] = {}
  for (const [id, rps] of Object.entries(instances)) {
    instanceRecord[id] = { ...emptyInstance, instanceId: id, rps }
  }
  const serverRecord: MetricsBatch['servers'] = {}
  for (const id of servers) serverRecord[id] = { ...emptyServer, serverId: id }
  return {
    simMs: 1000, instances: instanceRecord, servers: serverRecord,
    azs: {}, regions: {},
    world: { totalRps: 0, populationRoutes: [] } as unknown as MetricsBatch['world'],
  }
}

describe('DatacenterFloor', () => {
  it('renders a cabinet per rack and a pod per free-pool server', () => {
    const { azId } = seedAz()
    useWorldStore.getState().addRack(azId)
    const rack = Object.values(useWorldStore.getState().doc.racks)[0]
    const racked = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    useWorldStore.getState().assignServerToRack(racked, rack.id)
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)   // stays in the free pool

    render(<DatacenterFloor />)
    expect(screen.getByTestId(`rack-cabinet-${rack.id}`)).toBeTruthy()
    expect(screen.getAllByTestId(/^free-pod-/)).toHaveLength(1)
    expect(screen.getByTestId(`rack-slot-${racked}`)).toBeTruthy()
  })

  it('only the top 5 flows by source-server rps get the animated class', () => {
    const { azId } = seedAz()
    const msId = useWorldStore.getState().addManagedService('rds', 'db', { kind: 'az', azId }, 5432)
    const api = useWorldStore.getState().addBlueprint('api')
    useWorldStore.getState().updateBlueprint(api, {
      dependencies: [{ id: 'dep-1', target: { kind: 'managed', managedServiceId: msId }, port: 5432, protocol: 'db', packetTemplateId: null }],
    })

    const N = 10
    const serverIds: string[] = []
    const instanceRps: Record<string, number> = {}
    for (let i = 0; i < N; i++) {
      const sid = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
      serverIds.push(sid)
      const plId = useWorldStore.getState().addPlacement(api, sid)
      instanceRps[`${plId}#0`] = (i + 1) * 10   // strictly increasing rps, 10..100
    }

    useSimulationStore.setState({ running: true, latestBatch: makeBatch(instanceRps, serverIds) })

    const { rerender } = render(<DatacenterFloor />)

    const animated = screen.getAllByTestId(/^flow-/).filter(el => el.getAttribute('data-animated') === 'true')
    const all = screen.getAllByTestId(/^flow-/)
    expect(all).toHaveLength(N)
    expect(animated).toHaveLength(5)

    // The two lowest-rps servers (10, 20 rps -> servers 0 and 1) must NOT be animated.
    const animatedSources = new Set(animated.map(el => el.getAttribute('data-testid')))
    expect(animatedSources.has(`flow-${serverIds[0]}->${msId}`)).toBe(false)
    expect(animatedSources.has(`flow-${serverIds[1]}->${msId}`)).toBe(false)
    expect(animatedSources.has(`flow-${serverIds[9]}->${msId}`)).toBe(true)

    // Freeze: pausing (or ending) the run stops the marching traces even though rps stays non-zero.
    useSimulationStore.setState({ paused: true })
    rerender(<DatacenterFloor />)
    expect(screen.getAllByTestId(/^flow-/).filter(el => el.getAttribute('data-animated') === 'true')).toHaveLength(0)
  })

  it('LED blink is capped at MAX_ANIMATED_LEDS (3), ranked by cpu utilization', () => {
    const { azId } = seedAz()
    const N = 6
    const serverIds: string[] = []
    for (let i = 0; i < N; i++) {
      serverIds.push(useWorldStore.getState().addServer(azId, getPreset('vps-medium')!))
    }
    const serverRecord: MetricsBatch['servers'] = {}
    serverIds.forEach((id, i) => {
      // Strictly increasing utilization, all > 0 so every LED is lit — only the busiest 3 may blink.
      serverRecord[id] = { ...emptyServer, serverId: id, coreUtilization: [(i + 1) / N] }
    })
    useSimulationStore.setState({
      running: true,   // live: LEDs blink only while the sim is actively ticking
      latestBatch: {
        simMs: 1000, instances: {}, servers: serverRecord, azs: {}, regions: {},
        world: { totalRps: 0, populationRoutes: [] } as unknown as MetricsBatch['world'],
      },
    })

    render(<DatacenterFloor />)

    const blinking = serverIds.filter(id => {
      const pod = screen.getByTestId(`free-pod-${id}`)
      return pod.querySelector('circle')?.getAttribute('class')?.includes('az-led-blink') ?? false
    })
    expect(blinking).toHaveLength(3)
    // The animated set must be EXACTLY the top-3 by cpuMean (indices 3, 4, 5) — not just "excludes
    // the bottom 3, includes the busiest one" (which an off-by-one in the ranking slice, e.g.
    // keeping indices 2-4 instead of 3-5, could still satisfy).
    expect(new Set(blinking)).toEqual(new Set([serverIds[3], serverIds[4], serverIds[5]]))
    // The three least-busy servers (indices 0-2) must NOT blink; the busiest (index 5) must.
    expect(blinking).not.toContain(serverIds[0])
    expect(blinking).not.toContain(serverIds[1])
    expect(blinking).not.toContain(serverIds[2])
    expect(blinking).toContain(serverIds[5])
  })

  it('a newly-added free-pool server mounts with the boot-cascade class', () => {
    const { azId } = seedAz()
    const { rerender } = render(<DatacenterFloor />)
    expect(screen.queryAllByTestId(/^free-pod-/)).toHaveLength(0)

    const sid = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    rerender(<DatacenterFloor />)

    const pod = screen.getByTestId(`free-pod-${sid}`)
    expect(pod.getAttribute('class')).toContain('az-newslot')
    expect(pod.getAttribute('class')).toContain('go')
  })

  it('under reduced motion, a newly-racked server does NOT get the animating boot class', () => {
    mockUseReducedMotion.mockReturnValue(true)

    const { azId } = seedAz()
    useWorldStore.getState().addRack(azId)
    const rack = Object.values(useWorldStore.getState().doc.racks)[0]
    const { rerender } = render(<DatacenterFloor />)

    const sid = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    useWorldStore.getState().assignServerToRack(sid, rack.id)
    rerender(<DatacenterFloor />)

    const slot = screen.getByTestId(`rack-slot-${sid}`)
    // Under reduced motion the slot must render instantly, not via the `az-newslot go` cascade
    // that (absent the fix) leaves it at `opacity: 0` for up to NEW_ANIMATION_MS.
    expect(slot.getAttribute('class') ?? '').not.toContain('az-newslot')
    expect(slot.getAttribute('class') ?? '').not.toContain('go')
  })

  it('under reduced motion, a newly-added free-pool server does NOT get the animating boot class', () => {
    mockUseReducedMotion.mockReturnValue(true)

    const { azId } = seedAz()
    const { rerender } = render(<DatacenterFloor />)

    const sid = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    rerender(<DatacenterFloor />)

    const pod = screen.getByTestId(`free-pod-${sid}`)
    expect(pod.getAttribute('class')).not.toContain('az-newslot')
  })

  it('a blocked flow is always static even if its source has the highest rps', () => {
    const { azId } = seedAz()
    const web = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    const db = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    useWorldStore.setState(s => {
      const doc = { ...s.doc }
      doc.servers = { ...doc.servers, [db]: { ...doc.servers[db], firewall: [{ id: 'deny', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' }] } }
      return { doc }
    })
    const api = useWorldStore.getState().addBlueprint('api')
    const pg = useWorldStore.getState().addBlueprint('pg')
    useWorldStore.getState().updateBlueprint(pg, { ports: [{ port: 5432, protocol: 'tcp', visibility: 'internal' }] })
    useWorldStore.getState().updateBlueprint(api, {
      dependencies: [{ id: 'dep-1', target: { kind: 'blueprint', blueprintId: pg }, port: 5432, protocol: 'db', packetTemplateId: null }],
    })
    const plApi = useWorldStore.getState().addPlacement(api, web)
    useWorldStore.getState().addPlacement(pg, db)
    useSimulationStore.setState({ latestBatch: makeBatch({ [`${plApi}#0`]: 999 }, [web, db]) })

    render(<DatacenterFloor />)
    const flow = screen.getByTestId(`flow-${web}->${db}`)
    expect(flow.getAttribute('data-animated')).toBe('false')
  })
})

describe('DatacenterFloor — internet ingress + label layer (2026-07-12)', () => {
  it('renders the ISP box with a teal edge to an open public server and a red edge to a firewalled one', () => {
    const { azId } = seedAz()
    const world = useWorldStore.getState()
    const openId = world.addServer(azId, getPreset('vps-medium')!)
    const shutId = world.addServer(azId, getPreset('vps-medium')!)
    const bpId = world.addBlueprint('front')
    world.updateBlueprint(bpId, { ports: [{ port: 443, protocol: 'tcp', visibility: 'public' }] })
    world.addPlacement(bpId, openId)
    world.addPlacement(bpId, shutId)
    // openId gets a real front door; shutId keeps createServer's internal-only default.
    const open = useWorldStore.getState().doc.servers[openId]
    world.updateServer(openId, {
      firewall: [{ id: 'fw-443', action: 'allow', port: 443, protocol: 'tcp', source: 'any' }, ...open.firewall],
    })

    render(<DatacenterFloor />)
    expect(screen.getByTestId('inet-box')).toBeTruthy()
    expect(screen.getByText('INTERNET')).toBeTruthy()
    const allowed = screen.getByTestId(`ingress-${openId}`)
    const blocked = screen.getByTestId(`ingress-${shutId}`)
    expect(allowed.getAttribute('stroke')).toBe('var(--az-hud)')
    expect(allowed.getAttribute('data-animated')).toBe('false')   // static at 0 rps
    expect(blocked.getAttribute('stroke')).toBe('var(--color-danger)')
    expect(screen.getByText('✕ firewall')).toBeTruthy()
  })

  it('pod labels are floor-layer divs that never overlap each other', () => {
    const { azId } = seedAz()
    const world = useWorldStore.getState()
    world.addServer(azId, getPreset('vps-medium')!)
    world.addServer(azId, getPreset('vps-medium')!)
    world.addServer(azId, getPreset('dedicated-8')!)

    render(<DatacenterFloor />)
    const labels = screen.getAllByTestId('pod-label')
    expect(labels).toHaveLength(3)
    const rects = labels.map(el => ({
      x: parseFloat(el.style.left), y: parseFloat(el.style.top),
      w: parseFloat(el.style.width), h: 12,
    }))
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j]
        const overlap = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
        expect(overlap).toBe(false)
      }
    }
  })
})

describe('DatacenterFloor — lines survive racking (2026-07-12 follow-up)', () => {
  it('ingress and dep lines re-anchor to the cabinet when auto-arrange racks the servers', () => {
    const { azId } = seedAz()
    const world = useWorldStore.getState()
    const frontId = world.addServer(azId, getPreset('vps-medium')!)
    const dbId = world.addServer(azId, getPreset('dedicated-8')!)
    const frontBp = world.addBlueprint('front')
    world.updateBlueprint(frontBp, {
      ports: [{ port: 443, protocol: 'tcp', visibility: 'public' }],
      dependencies: [{ id: 'd1', target: { kind: 'blueprint', blueprintId: (() => {
        const dbBp = world.addBlueprint('db')
        useWorldStore.getState().updateBlueprint(dbBp, { ports: [{ port: 5432, protocol: 'tcp', visibility: 'internal' }] })
        useWorldStore.getState().addPlacement(dbBp, dbId)
        return dbBp
      })() }, port: 5432, protocol: 'db', packetTemplateId: null }],
    })
    world.addPlacement(frontBp, frontId)
    const front = useWorldStore.getState().doc.servers[frontId]
    world.updateServer(frontId, {
      firewall: [{ id: 'fw-443', action: 'allow', port: 443, protocol: 'tcp', source: 'any' }, ...front.firewall],
    })

    // Rack BOTH servers into separate racks — the reported repro (auto-arrange packs a 1U vps
    // and a 2U dedicated into one 8U rack, which would hide the dep line by design; two racks
    // keeps the cross-cabinet dep line assertable while still exercising the racked resolver).
    world.addRack(azId)
    world.addRack(azId)
    const [rackA, rackB] = Object.values(useWorldStore.getState().doc.racks)
    world.assignServerToRack(frontId, rackA.id)
    world.assignServerToRack(dbId, rackB.id)
    expect(useWorldStore.getState().doc.servers[frontId].rack?.rackId).toBe(rackA.id)

    render(<DatacenterFloor />)
    // The racked public server keeps its ISP line (this vanished before the fix)…
    expect(screen.getByTestId(`ingress-${frontId}`)).toBeTruthy()
    // …and the cross-rack dep flow keeps its trace + chip.
    expect(screen.getByTestId(`flow-${frontId}->${dbId}`)).toBeTruthy()
    expect(screen.getByText('1 dep')).toBeTruthy()
  })

  it('a dep between two servers racked in the SAME cabinet draws no line and no chip', () => {
    const { azId } = seedAz()
    const world = useWorldStore.getState()
    const aId = world.addServer(azId, getPreset('vps-medium')!)
    const bId = world.addServer(azId, getPreset('vps-medium')!)
    const apiBp = world.addBlueprint('api')
    const dbBp = world.addBlueprint('db')
    world.updateBlueprint(dbBp, { ports: [{ port: 5432, protocol: 'tcp', visibility: 'internal' }] })
    world.updateBlueprint(apiBp, {
      dependencies: [{ id: 'd1', target: { kind: 'blueprint', blueprintId: dbBp }, port: 5432, protocol: 'db', packetTemplateId: null }],
    })
    world.addPlacement(apiBp, aId)
    world.addPlacement(dbBp, bId)
    world.addRack(azId)
    const rack = Object.values(useWorldStore.getState().doc.racks)[0]
    world.assignServerToRack(aId, rack.id)
    world.assignServerToRack(bId, rack.id)

    render(<DatacenterFloor />)
    expect(screen.queryByTestId(`flow-${aId}->${bId}`)).toBeNull()
    expect(screen.queryByText('1 dep')).toBeNull()
  })

  // Background click-to-deselect (user report 2026-07-12: "once I click a server I can't view
  // the rack level config again") — a press on empty floor that never becomes a drag clears
  // the selection so the dock widens back to AZ scope; a pan must NOT.
  it('clicking empty floor background clears the server selection', () => {
    const { azId } = seedAz()
    const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    useUiStore.getState().setSelectedServerId(serverId)
    render(<DatacenterFloor />)
    const viewport = screen.getByTestId('floor-viewport')
    fireEvent.pointerDown(viewport, { clientX: 50, clientY: 50, button: 0, pointerId: 1 })
    fireEvent.pointerUp(viewport, { clientX: 51, clientY: 52, pointerId: 1 })
    expect(useUiStore.getState().selectedServerId).toBeNull()
  })

  it('a background drag (pan) does NOT clear the selection', () => {
    const { azId } = seedAz()
    const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    useUiStore.getState().setSelectedServerId(serverId)
    render(<DatacenterFloor />)
    const viewport = screen.getByTestId('floor-viewport')
    fireEvent.pointerDown(viewport, { clientX: 50, clientY: 50, button: 0, pointerId: 1 })
    fireEvent.pointerMove(viewport, { clientX: 90, clientY: 75, pointerId: 1 })
    fireEvent.pointerUp(viewport, { clientX: 120, clientY: 90, pointerId: 1 })
    expect(useUiStore.getState().selectedServerId).toBe(serverId)
  })

  it('a press starting on a server pod never clears the selection', () => {
    const { azId } = seedAz()
    const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    useUiStore.getState().setSelectedServerId(serverId)
    render(<DatacenterFloor />)
    const pod = screen.getByTestId(`free-pod-${serverId}`)
    fireEvent.pointerDown(pod, { clientX: 200, clientY: 200, button: 0, pointerId: 1 })
    fireEvent.pointerUp(pod, { clientX: 200, clientY: 200, pointerId: 1 })
    expect(useUiStore.getState().selectedServerId).toBe(serverId)
  })

  // node-model Phase 5.1 — a managed service that IS receiving traffic used to look dead.
  it('shows live received rps on a managed-service box', () => {
    const { azId } = seedAz()
    const msId = useWorldStore.getState().addManagedService('dbSql', 'SQL DB', { kind: 'az', azId }, 5432)
    const sid = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    const batch = makeBatch({}, [sid])
    batch.managedServices = { [msId]: { managedServiceId: msId, rps: 420, refusedRps: 0, utilization: 0.14, health: 'healthy', egressBytesPerSec: 0 } }
    useSimulationStore.setState({ running: true, latestBatch: batch })

    render(<DatacenterFloor />)
    expect(screen.getByTestId(`appliance-${msId}`).getAttribute('data-managed-rps')).toBe('420')
    expect(screen.getByText(/420 rps/)).toBeTruthy()
  })

  it('flags a throttling (over-ceiling) managed DB', () => {
    const { azId } = seedAz()
    const msId = useWorldStore.getState().addManagedService('dbSql', 'SQL DB', { kind: 'az', azId }, 5432)
    const sid = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    const batch = makeBatch({}, [sid])
    batch.managedServices = { [msId]: { managedServiceId: msId, rps: 2500, refusedRps: 900, utilization: 1, health: 'down', egressBytesPerSec: 0 } }
    useSimulationStore.setState({ running: true, latestBatch: batch })

    render(<DatacenterFloor />)
    expect(screen.getByText(/⚠/)).toBeTruthy()
  })

  it('kill / restore takes a managed service down and reflects it on the box (Phase 5.2)', () => {
    const { azId } = seedAz()
    const msId = useWorldStore.getState().addManagedService('queue', 'Q', { kind: 'az', azId }, 5672)
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    useSimulationStore.setState({ running: true, latestBatch: makeBatch({}, []) })

    render(<DatacenterFloor />)
    fireEvent.click(screen.getByLabelText('Simulate outage for Q'))
    expect(useSimulationStore.getState().healthOverrides[msId]).toBe(true)
    expect(screen.getByTestId(`appliance-${msId}`).getAttribute('data-managed-down')).toBe('true')
    // now a restore control is offered
    fireEvent.click(screen.getByLabelText('Clear fault on Q'))
    expect(useSimulationStore.getState().healthOverrides[msId]).toBe(false)
  })

  it('appliance box carries the amber non-fatal-fault accent for a non-down fault, not for down or no fault', () => {
    const { azId } = seedAz()
    const msId = useWorldStore.getState().addManagedService('queue', 'Q', { kind: 'az', azId }, 5672)
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    useSimulationStore.setState({ running: true, latestBatch: makeBatch({}, []) })

    // No fault: no accent.
    const { rerender } = render(<DatacenterFloor />)
    let box = screen.getByTestId(`appliance-${msId}`)
    expect(box.getAttribute('data-nonfatal-fault')).toBe('false')

    // Non-fatal fault (e.g. latency-add): accent present, still NOT reported as "down".
    useSimulationStore.getState().setFault('managed', msId, { kind: 'latency-add', ms: 400 })
    rerender(<DatacenterFloor />)
    box = screen.getByTestId(`appliance-${msId}`)
    expect(box.getAttribute('data-nonfatal-fault')).toBe('true')
    expect(box.getAttribute('data-managed-down')).toBe('false')

    // Down fault: accent flag flips back off (existing dark/struck `data-managed-down` path owns it).
    useSimulationStore.getState().setFault('managed', msId, { kind: 'down' })
    rerender(<DatacenterFloor />)
    box = screen.getByTestId(`appliance-${msId}`)
    expect(box.getAttribute('data-nonfatal-fault')).toBe('false')
    expect(box.getAttribute('data-managed-down')).toBe('true')
  })

  it('leaves a managed box static (no rps) when the sim is not live', () => {
    const { azId } = seedAz()
    const msId = useWorldStore.getState().addManagedService('dbSql', 'SQL DB', { kind: 'az', azId }, 5432)
    const sid = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    const batch = makeBatch({}, [sid])
    batch.managedServices = { [msId]: { managedServiceId: msId, rps: 420, refusedRps: 0, utilization: 0.14, health: 'healthy', egressBytesPerSec: 0 } }
    useSimulationStore.setState({ running: false, latestBatch: batch })   // not live → frozen

    render(<DatacenterFloor />)
    expect(screen.getByTestId(`appliance-${msId}`).getAttribute('data-managed-rps')).toBe('0')
    expect(screen.queryByText(/420 rps/)).toBeNull()
  })

  // FEAT-002 Task 14: a server-scoped partition dashes red the flow trace between its two
  // endpoints (mirrors the firewall-blocked treatment, marked with data-partitioned so the two
  // are distinguishable).
  it('dashes red for a partitioned flow trace (drop mode)', () => {
    const { azId } = seedAz()
    const api = useWorldStore.getState().addBlueprint('api')
    const db = useWorldStore.getState().addBlueprint('db')
    useWorldStore.getState().updateBlueprint(api, {
      dependencies: [{ id: 'dep-1', target: { kind: 'blueprint', blueprintId: db }, port: 8080, protocol: 'http', packetTemplateId: null }],
    })
    const serverA = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    const serverB = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    useWorldStore.getState().addPlacement(api, serverA)
    useWorldStore.getState().addPlacement(db, serverB)

    const { rerender } = render(<DatacenterFloor />)
    const key = `${serverA}->${serverB}`
    let trace = screen.getByTestId(`flow-${key}`)
    expect(trace.getAttribute('data-partitioned')).toBe('false')
    expect(trace).toHaveAttribute('stroke', 'var(--color-accent)')

    useSimulationStore.setState({
      partitions: [{ from: { kind: 'server', id: serverA }, to: { kind: 'server', id: serverB }, mode: 'drop', symmetric: true }],
    })
    rerender(<DatacenterFloor />)
    trace = screen.getByTestId(`flow-${key}`)
    expect(trace.getAttribute('data-partitioned')).toBe('true')
    expect(trace).toHaveAttribute('stroke', 'var(--color-danger)')
    expect(trace).toHaveAttribute('stroke-dasharray', '5 4')
    expect(trace.getAttribute('data-animated')).toBe('false')
  })

  it('stipples (not fully severed) for a loss-mode partition', () => {
    const { azId } = seedAz()
    const api = useWorldStore.getState().addBlueprint('api')
    const db = useWorldStore.getState().addBlueprint('db')
    useWorldStore.getState().updateBlueprint(api, {
      dependencies: [{ id: 'dep-1', target: { kind: 'blueprint', blueprintId: db }, port: 8080, protocol: 'http', packetTemplateId: null }],
    })
    const serverA = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    const serverB = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    useWorldStore.getState().addPlacement(api, serverA)
    useWorldStore.getState().addPlacement(db, serverB)
    useSimulationStore.setState({
      partitions: [{ from: { kind: 'server', id: serverA }, to: { kind: 'server', id: serverB }, mode: 'loss', lossFraction: 0.5, symmetric: true }],
    })

    render(<DatacenterFloor />)
    const trace = screen.getByTestId(`flow-${serverA}->${serverB}`)
    expect(trace.getAttribute('data-partitioned')).toBe('false')
    expect(trace).toHaveAttribute('stroke', 'var(--color-accent)')
    expect(trace).toHaveAttribute('stroke-dasharray', '3 6')
  })
})

describe('DatacenterFloor — multi-select (wave 5 ergonomics, task 17)', () => {
  it('a plain click on a pod selects exactly that server', () => {
    const { azId } = seedAz()
    const s1 = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(<DatacenterFloor />)
    const pod = screen.getByTestId(`free-pod-${s1}`)
    fireEvent.pointerDown(pod, { clientX: 10, clientY: 10, button: 0, pointerId: 1 })
    fireEvent.pointerUp(pod, { clientX: 10, clientY: 10, pointerId: 1 })
    expect(useUiStore.getState().selectedEntityIds).toEqual(new Set([s1]))
    expect(useUiStore.getState().selectedServerId).toBe(s1)
  })

  it('⌘/ctrl-click toggles a server into/out of a multi-select', () => {
    const { azId } = seedAz()
    const s1 = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    const s2 = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(<DatacenterFloor />)
    const pod1 = screen.getByTestId(`free-pod-${s1}`)
    const pod2 = screen.getByTestId(`free-pod-${s2}`)

    fireEvent.pointerDown(pod1, { clientX: 10, clientY: 10, button: 0, pointerId: 1 })
    fireEvent.pointerUp(pod1, { clientX: 10, clientY: 10, pointerId: 1 })
    expect(useUiStore.getState().selectedEntityIds).toEqual(new Set([s1]))

    fireEvent.pointerDown(pod2, { clientX: 20, clientY: 20, button: 0, pointerId: 2, metaKey: true })
    fireEvent.pointerUp(pod2, { clientX: 20, clientY: 20, pointerId: 2, metaKey: true })
    expect(useUiStore.getState().selectedEntityIds).toEqual(new Set([s1, s2]))
    expect(useUiStore.getState().selectedServerId).toBeNull()   // multi-select: no single scope target

    // ⌘-click s1 again toggles it back OUT, leaving just s2.
    fireEvent.pointerDown(pod1, { clientX: 10, clientY: 10, button: 0, pointerId: 3, ctrlKey: true })
    fireEvent.pointerUp(pod1, { clientX: 10, clientY: 10, pointerId: 3, ctrlKey: true })
    expect(useUiStore.getState().selectedEntityIds).toEqual(new Set([s2]))
    expect(useUiStore.getState().selectedServerId).toBe(s2)
  })

  it('⇧-click range-selects from the last-clicked server to the current one, in layout order', () => {
    const { azId } = seedAz()
    const s1 = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    const s2 = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    const s3 = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(<DatacenterFloor />)
    const pod1 = screen.getByTestId(`free-pod-${s1}`)
    const pod3 = screen.getByTestId(`free-pod-${s3}`)

    fireEvent.pointerDown(pod1, { clientX: 10, clientY: 10, button: 0, pointerId: 1 })
    fireEvent.pointerUp(pod1, { clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerDown(pod3, { clientX: 30, clientY: 30, button: 0, pointerId: 2, shiftKey: true })
    fireEvent.pointerUp(pod3, { clientX: 30, clientY: 30, pointerId: 2, shiftKey: true })

    expect(useUiStore.getState().selectedEntityIds).toEqual(new Set([s1, s2, s3]))
    expect(useUiStore.getState().selectedServerId).toBeNull()
  })

  // Task 17 review round 1 (Important #3): the only prior ⇧-click test clicked an EARLIER item
  // then a LATER one (ascending anchor->target). Prove the `[lo, hi]` swap in `handleSelect`
  // resolves correctly in the opposite direction too — click the LATER item first, then an
  // EARLIER one with ⇧ held, and confirm the range still covers everything between them.
  it('⇧-click range-selects backward (later item clicked first, earlier item ⇧-clicked) the same as forward', () => {
    const { azId } = seedAz()
    const s1 = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    const s2 = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    const s3 = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(<DatacenterFloor />)
    const pod1 = screen.getByTestId(`free-pod-${s1}`)
    const pod3 = screen.getByTestId(`free-pod-${s3}`)

    // Anchor on the LATER item (s3) first...
    fireEvent.pointerDown(pod3, { clientX: 30, clientY: 30, button: 0, pointerId: 1 })
    fireEvent.pointerUp(pod3, { clientX: 30, clientY: 30, pointerId: 1 })
    expect(useUiStore.getState().selectedEntityIds).toEqual(new Set([s3]))
    // ...then ⇧-click the EARLIER item (s1) — the range must still resolve to [s1, s2, s3].
    fireEvent.pointerDown(pod1, { clientX: 10, clientY: 10, button: 0, pointerId: 2, shiftKey: true })
    fireEvent.pointerUp(pod1, { clientX: 10, clientY: 10, pointerId: 2, shiftKey: true })

    expect(useUiStore.getState().selectedEntityIds).toEqual(new Set([s1, s2, s3]))
    expect(useUiStore.getState().selectedServerId).toBeNull()
  })

  // Task 17 review round 1 (Important #1): marquee is now wired on floor-viewport's OWN pointer
  // handlers (the same element/event family the camera pan already owns), gated behind ⇧+drag so
  // a plain background drag stays pan (unchanged default) and the two gestures can never both be
  // live for one physical press. See DatacenterFloor.tsx's marqueeStartRef comment for the two
  // real-browser failure modes (moving coordinate frame + pointer-capture retargeting) this fixes.
  it('⇧+drag marquee selects exactly the servers whose floor layout rects intersect the marquee', () => {
    const { azId } = seedAz()
    // Two free-pool servers, created in order so 'server'-then-id sort (createServer's shared
    // 'server' label falls back to id ordering) puts s1 at pod grid cell (0,0) and s2 at (1,0) —
    // the SAME cols=4 base grid layoutFloor assigns below 5 occupants.
    const s1 = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    const s2 = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)

    render(<DatacenterFloor />)
    const viewport = screen.getByTestId('floor-viewport')

    // Compute the EXPECTED geometry from the same iso-projection primitives the component
    // itself uses (iso.ts's isoBox) rather than asserting against approximate pixel guesses.
    const cols = 4
    const box0 = isoBox(0, 0, cols, POD_HEIGHT_PX, 0.52)
    // A small marquee strictly inside pod 0's bounding rect only.
    const x0 = box0.roofSW.x + 5
    const y0 = box0.roofNW.y + 5

    fireEvent.pointerDown(viewport, { clientX: x0, clientY: y0, button: 0, pointerId: 1, shiftKey: true })
    fireEvent.pointerMove(viewport, { clientX: x0 + 10, clientY: y0 + 10, pointerId: 1, shiftKey: true })
    fireEvent.pointerUp(viewport, { clientX: x0 + 10, clientY: y0 + 10, pointerId: 1, shiftKey: true })

    expect(useUiStore.getState().selectedEntityIds).toEqual(new Set([s1]))
    expect(useUiStore.getState().selectedEntityIds.has(s2)).toBe(false)
  })

  it('⇧+drag marquee covering both pods selects both servers', () => {
    const { azId } = seedAz()
    const s1 = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    const s2 = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)

    render(<DatacenterFloor />)
    const viewport = screen.getByTestId('floor-viewport')

    const cols = 4
    const box0 = isoBox(0, 0, cols, POD_HEIGHT_PX, 0.52)
    const box1 = isoBox(1, 0, cols, POD_HEIGHT_PX, 0.52)
    const minX = Math.min(box0.roofSW.x, box1.roofSW.x) - 5
    const minY = Math.min(box0.roofNW.y, box1.roofNW.y) - 5
    const maxX = Math.max(box0.roofNE.x, box1.roofNE.x) + 5
    const maxY = Math.max(box0.floorSE.y, box1.floorSE.y) + 5

    fireEvent.pointerDown(viewport, { clientX: minX, clientY: minY, button: 0, pointerId: 1, shiftKey: true })
    fireEvent.pointerMove(viewport, { clientX: maxX, clientY: maxY, pointerId: 1, shiftKey: true })
    fireEvent.pointerUp(viewport, { clientX: maxX, clientY: maxY, pointerId: 1, shiftKey: true })

    expect(useUiStore.getState().selectedEntityIds).toEqual(new Set([s1, s2]))
  })

  // Task 17 review round 1 (Important #1): a background drag with NO shift key must stay a plain
  // camera pan — never also start a marquee — proving the two gestures are mutually exclusive at
  // pointerdown, not just "functionally non-conflicting" by accident.
  it('a plain (non-shift) background drag pans the camera and starts no marquee', () => {
    const { azId } = seedAz()
    const s1 = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(<DatacenterFloor />)
    const viewport = screen.getByTestId('floor-viewport')

    fireEvent.pointerDown(viewport, { clientX: 50, clientY: 50, button: 0, pointerId: 1 })
    fireEvent.pointerMove(viewport, { clientX: 90, clientY: 90, pointerId: 1 })
    fireEvent.pointerUp(viewport, { clientX: 90, clientY: 90, pointerId: 1 })

    // No marquee rect should have been rendered mid-drag, and no selection should result from it.
    expect(screen.queryByTestId('floor-marquee')).toBeNull()
    expect(useUiStore.getState().selectedEntityIds.has(s1)).toBe(false)
  })

  // Task 17 review round 1 (Important #1): the svg's bounding rect must be snapshotted ONCE at
  // marquee drag-start and reused for every move/up conversion in that drag — NOT recomputed on
  // every move. Simulate a rect that changes mid-drag (as a real camera pan would move the on-
  // screen svg) and confirm the marquee still resolves against the DRAG-START frame, matching
  // exactly what the same gesture would select if the rect had never changed.
  it('marquee coordinates stay pinned to the drag-start bounding-rect snapshot even if the rect changes mid-drag', () => {
    const { azId } = seedAz()
    const s1 = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)   // s2, deliberately unused

    render(<DatacenterFloor />)
    const viewport = screen.getByTestId('floor-viewport')

    const cols = 4
    const box0 = isoBox(0, 0, cols, POD_HEIGHT_PX, 0.52)
    const x0 = box0.roofSW.x + 5
    const y0 = box0.roofNW.y + 5

    const mkRect = (over: Partial<DOMRect>): DOMRect => ({
      left: 0, top: 0, right: VIEW_W, bottom: VIEW_H, width: VIEW_W, height: VIEW_H,
      x: 0, y: 0, toJSON: () => ({}), ...over,
    })
    // Drag-start rect: identity mapping (content px === screen px, since width === VIEW_W).
    const rectStart = mkRect({})
    const spy = vi
      .spyOn(SVGSVGElement.prototype, 'getBoundingClientRect')
      .mockReturnValue(rectStart)

    fireEvent.pointerDown(viewport, { clientX: x0, clientY: y0, button: 0, pointerId: 1, shiftKey: true })

    // Mid-drag, the rect changes (simulating the svg's on-screen position having moved, e.g. from
    // a pan). A buggy implementation that re-queries the rect on every move/up would now convert
    // the SAME client coordinates against this shifted frame, landing far outside pod 0's box and
    // missing the selection entirely.
    spy.mockReturnValue(mkRect({ left: -500, top: -500, right: VIEW_W - 500, bottom: VIEW_H - 500 }))

    fireEvent.pointerMove(viewport, { clientX: x0 + 10, clientY: y0 + 10, pointerId: 1, shiftKey: true })
    fireEvent.pointerUp(viewport, { clientX: x0 + 10, clientY: y0 + 10, pointerId: 1, shiftKey: true })

    spy.mockRestore()

    // The fix (cached rect) keeps resolving against rectStart throughout the drag, so this must
    // match the SAME small-marquee-inside-pod-0 result as the unchanging-rect test above.
    expect(useUiStore.getState().selectedEntityIds).toEqual(new Set([s1]))
  })

  // Task 17 review round 1 (Important #2): the background click-to-deselect guard used to check
  // only `selectedServerId`, which is null by design for a 2+-member selection (the store's
  // consistency invariant) — so clicking empty background could never clear a multi-select.
  it('clicking empty background clears a 2+-member selection (not just a single selectedServerId)', () => {
    const { azId } = seedAz()
    const s1 = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    const s2 = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(<DatacenterFloor />)
    const pod1 = screen.getByTestId(`free-pod-${s1}`)
    const pod2 = screen.getByTestId(`free-pod-${s2}`)

    fireEvent.pointerDown(pod1, { clientX: 10, clientY: 10, button: 0, pointerId: 1 })
    fireEvent.pointerUp(pod1, { clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerDown(pod2, { clientX: 20, clientY: 20, button: 0, pointerId: 2, metaKey: true })
    fireEvent.pointerUp(pod2, { clientX: 20, clientY: 20, pointerId: 2, metaKey: true })
    expect(useUiStore.getState().selectedEntityIds).toEqual(new Set([s1, s2]))
    expect(useUiStore.getState().selectedServerId).toBeNull()   // the pre-existing bug's blind spot

    const viewport = screen.getByTestId('floor-viewport')
    fireEvent.pointerDown(viewport, { clientX: 400, clientY: 400, button: 0, pointerId: 3 })
    fireEvent.pointerUp(viewport, { clientX: 401, clientY: 402, pointerId: 3 })

    expect(useUiStore.getState().selectedEntityIds.size).toBe(0)
    expect(useUiStore.getState().selectedServerId).toBeNull()
  })
})
