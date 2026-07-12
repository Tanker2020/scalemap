// @vitest-environment jsdom
// Polish 4 T4 (spec D6): SERVICES drawer — chip lines, count stepper, mount-a-blueprint flow.
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ServicesDrawer, servicesPv } from './ServicesDrawer'
import { useWorldStore } from '../../../store/world.store'
import { compileWorld } from '../../../../lib/world/compileWorld'
import { getPreset } from '../../../../lib/world/instanceCatalog'
import type { Server, WorldDoc } from '../../../../lib/world/types'
import type { InstanceMetrics } from '../../../../lib/worldEngine/types'

beforeEach(() => { useWorldStore.getState().newWorld() })

function seedServer(): string {
  const regionId = useWorldStore.getState().addRegion('us-east-1')
  const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
  return useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
}
function currentDoc(): WorldDoc { return useWorldStore.getState().doc }
function currentServer(id: string): Server { return currentDoc().servers[id] }

describe('servicesPv', () => {
  it('returns "—" when no placements', () => {
    const serverId = seedServer()
    expect(servicesPv(serverId, currentDoc())).toBe('—')
  })

  it('returns "<name> ×<count> · <role>" for exactly one placement', () => {
    const serverId = seedServer()
    const bpId = useWorldStore.getState().addBlueprint('db')
    useWorldStore.getState().addPlacement(bpId, serverId)
    expect(servicesPv(serverId, currentDoc())).toBe('db ×1 · primary')
  })

  it('returns "N services" for several placements', () => {
    const serverId = seedServer()
    const bp1 = useWorldStore.getState().addBlueprint('db')
    const bp2 = useWorldStore.getState().addBlueprint('cache')
    useWorldStore.getState().addPlacement(bp1, serverId)
    useWorldStore.getState().addPlacement(bp2, serverId)
    expect(servicesPv(serverId, currentDoc())).toBe('2 services')
  })

  // Polish 4 T5 (spec D7): watching posture re-voices the pv to "<name> · p50 X ms".
  it('re-voices to "<name> · p50 X ms" when a live reading is supplied', () => {
    expect(servicesPv('irrelevant', currentDoc(), { name: 'db', p50Ms: 2.1 })).toBe('db · p50 2.1 ms')
  })
})

describe('ServicesDrawer', () => {
  it('renders one chip line per placement with name/port/role', () => {
    const serverId = seedServer()
    const bpId = useWorldStore.getState().addBlueprint('db')
    useWorldStore.getState().addPlacement(bpId, serverId)
    render(<ServicesDrawer server={currentServer(serverId)} doc={currentDoc()} compiled={compileWorld(currentDoc())} running={false} />)
    const chip = screen.getByTestId('service-chip-line')
    expect(chip).toHaveTextContent('db')
    expect(chip).toHaveTextContent('primary')
  })

  it('"+" stepper dispatches updatePlacement with count clamped >= 1', () => {
    const serverId = seedServer()
    const bpId = useWorldStore.getState().addBlueprint('db')
    const plId = useWorldStore.getState().addPlacement(bpId, serverId)
    render(<ServicesDrawer server={currentServer(serverId)} doc={currentDoc()} compiled={compileWorld(currentDoc())} running={false} />)
    fireEvent.click(screen.getByLabelText('increase db count'))
    expect(currentDoc().placements[plId].count).toBe(2)
  })

  it('"−" stepper never drops count below 1', () => {
    const serverId = seedServer()
    const bpId = useWorldStore.getState().addBlueprint('db')
    const plId = useWorldStore.getState().addPlacement(bpId, serverId)
    render(<ServicesDrawer server={currentServer(serverId)} doc={currentDoc()} compiled={compileWorld(currentDoc())} running={false} />)
    fireEvent.click(screen.getByLabelText('decrease db count'))
    expect(currentDoc().placements[plId].count).toBe(1)
  })

  it('steppers are edit-locked while running', () => {
    const serverId = seedServer()
    const bpId = useWorldStore.getState().addBlueprint('db')
    useWorldStore.getState().addPlacement(bpId, serverId)
    render(<ServicesDrawer server={currentServer(serverId)} doc={currentDoc()} compiled={compileWorld(currentDoc())} running />)
    expect(screen.getByLabelText('increase db count')).toBeDisabled()
    expect(screen.getByLabelText('decrease db count')).toBeDisabled()
  })

  it('"+ mount a blueprint…" expands to a select, and choosing one dispatches addPlacement(blueprintId, serverId)', () => {
    const serverId = seedServer()
    const bpId = useWorldStore.getState().addBlueprint('cache')
    render(<ServicesDrawer server={currentServer(serverId)} doc={currentDoc()} compiled={compileWorld(currentDoc())} running={false} />)
    fireEvent.click(screen.getByTestId('mount-blueprint-ghost'))
    const select = screen.getByLabelText('mount a blueprint')
    fireEvent.change(select, { target: { value: bpId } })
    const placements = Object.values(currentDoc().placements)
    expect(placements).toHaveLength(1)
    expect(placements[0].blueprintId).toBe(bpId)
    expect(placements[0].serverId).toBe(serverId)
  })

  it('the mount ghost is edit-locked while running', () => {
    const serverId = seedServer()
    useWorldStore.getState().addBlueprint('cache')
    render(<ServicesDrawer server={currentServer(serverId)} doc={currentDoc()} compiled={compileWorld(currentDoc())} running />)
    const ghost = screen.getByTestId('mount-blueprint-ghost')
    expect(ghost).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(ghost)
    expect(screen.queryByLabelText('mount a blueprint')).toBeNull()
  })
})

// Polish 4 T5 (spec D7): the watching-posture body — one live row per compiled instance,
// health · rps, success/warning/danger colored (HEALTH_COLOR).
describe('ServicesDrawer — watching posture (liveInstances supplied)', () => {
  it('renders one live row per compiled instance (health · rps), not per placement', () => {
    const serverId = seedServer()
    const bpId = useWorldStore.getState().addBlueprint('db')
    const plId = useWorldStore.getState().addPlacement(bpId, serverId)
    useWorldStore.getState().updatePlacement(plId, { count: 2 })
    const doc = currentDoc()
    const compiled = compileWorld(doc)
    const instances = Object.values(compiled.instances).filter(i => i.serverId === serverId)
    expect(instances).toHaveLength(2)

    const liveInstances: Record<string, InstanceMetrics> = {}
    instances.forEach((inst, i) => {
      liveInstances[inst.id] = {
        instanceId: inst.id, rps: 100 + i, errorRate: 0, p50Ms: 2.1, p99Ms: 4,
        activeConnections: 1, cpuCoresUsed: 0.1, ramMb: 64, health: i === 0 ? 'healthy' : 'down',
      }
    })

    render(<ServicesDrawer server={currentServer(serverId)} doc={doc} compiled={compiled} running liveInstances={liveInstances} />)
    const rows = screen.getAllByTestId('service-live-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('healthy · 100 rps')
    expect(rows[1]).toHaveTextContent('down · 101 rps')
    expect(screen.queryByTestId('service-chip-line')).toBeNull()
    expect(screen.queryByTestId('mount-blueprint-ghost')).toBeNull()
  })

  it('shows "No services mounted here yet." when no instances resolve', () => {
    const serverId = seedServer()
    const doc = currentDoc()
    render(<ServicesDrawer server={currentServer(serverId)} doc={doc} compiled={compileWorld(doc)} running liveInstances={{}} />)
    expect(screen.getByText('No services mounted here yet.')).toBeTruthy()
  })
})
