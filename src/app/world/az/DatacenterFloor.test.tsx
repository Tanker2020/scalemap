// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DatacenterFloor } from './DatacenterFloor'
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import { useSimulationStore } from '../../store/simulation.store'
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
  instanceId: '', rps: 0, errorRate: 0, p50Ms: 0, p99Ms: 0, activeConnections: 0,
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

    useSimulationStore.setState({ latestBatch: makeBatch(instanceRps, serverIds) })

    render(<DatacenterFloor />)

    const animated = screen.getAllByTestId(/^flow-/).filter(el => el.getAttribute('data-animated') === 'true')
    const all = screen.getAllByTestId(/^flow-/)
    expect(all).toHaveLength(N)
    expect(animated).toHaveLength(5)

    // The two lowest-rps servers (10, 20 rps -> servers 0 and 1) must NOT be animated.
    const animatedSources = new Set(animated.map(el => el.getAttribute('data-testid')))
    expect(animatedSources.has(`flow-${serverIds[0]}->${msId}`)).toBe(false)
    expect(animatedSources.has(`flow-${serverIds[1]}->${msId}`)).toBe(false)
    expect(animatedSources.has(`flow-${serverIds[9]}->${msId}`)).toBe(true)
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
