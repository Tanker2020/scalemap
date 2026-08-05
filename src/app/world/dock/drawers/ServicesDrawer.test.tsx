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

// FEAT-008 (Task 21): ServicesDrawer takes `doc` as a plain prop (no store subscription of its
// own — that's ServerFaceplate's job in the real app), so a live-editing test needs a small
// reactive wrapper to see a store mutation reflected in the next render, mirroring how
// ServerFaceplate actually re-renders this drawer on every `doc` change.
function ReactiveDrawer({ serverId, running }: { serverId: string; running: boolean }) {
  const doc = useWorldStore(s => s.doc)
  return <ServicesDrawer server={doc.servers[serverId]} doc={doc} compiled={compileWorld(doc)} running={running} />
}

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

  it('the ✎ on a chip toggles the inline service editor (node-model Phase 5)', () => {
    const serverId = seedServer()
    const bpId = useWorldStore.getState().addBlueprint('db')
    useWorldStore.getState().addPlacement(bpId, serverId)
    render(<ServicesDrawer server={currentServer(serverId)} doc={currentDoc()} compiled={compileWorld(currentDoc())} running={false} />)
    // Closed by default.
    expect(screen.queryByLabelText('service name')).toBeNull()
    fireEvent.click(screen.getByLabelText('edit db'))
    expect(screen.getByLabelText('service name')).toHaveValue('db')
    // Toggles shut again.
    fireEvent.click(screen.getByLabelText('edit db'))
    expect(screen.queryByLabelText('service name')).toBeNull()
  })

  it('the ✎ edit affordance is locked while running', () => {
    const serverId = seedServer()
    const bpId = useWorldStore.getState().addBlueprint('db')
    useWorldStore.getState().addPlacement(bpId, serverId)
    render(<ServicesDrawer server={currentServer(serverId)} doc={currentDoc()} compiled={compileWorld(currentDoc())} running />)
    expect(screen.getByLabelText('edit db')).toBeDisabled()
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

  // FEAT-008 (Task 19 consumer audit): `compiled.instances` is the full maxCount ENVELOPE for an
  // autoscaled placement (Task 11), and a parked slot publishes no metrics (Task 16). This body
  // iterates the envelope but read health as `m?.health ?? 'healthy'` — so every not-yet-scaled-to
  // slot rendered as a green "healthy · 0 rps" service that is not actually running. Phantom
  // capacity in a live view; a parked slot must read as parked, and must NOT read as 'down'
  // either (that would conflate elastic scale-in with a kill/chaos fault).
  it('renders a parked autoscale-envelope slot as parked, not as healthy', () => {
    const serverId = seedServer()
    const bpId = useWorldStore.getState().addBlueprint('web')
    const plId = useWorldStore.getState().addPlacement(bpId, serverId)
    useWorldStore.getState().updatePlacement(plId, {
      count: 1, autoscale: { minCount: 1, maxCount: 3, targetCpuPercent: 70, scaleUpCooldownSec: 60, scaleDownCooldownSec: 300 },
    })
    const doc = currentDoc()
    const compiled = compileWorld(doc)
    const instances = Object.values(compiled.instances).filter(i => i.serverId === serverId)
    expect(instances).toHaveLength(3)   // envelope, not the authored count

    const running = instances.find(i => i.indexInPlacement === 0)!
    const liveInstances: Record<string, InstanceMetrics> = {
      [running.id]: {
        instanceId: running.id, rps: 100, errorRate: 0, p50Ms: 2.1, p99Ms: 4,
        activeConnections: 1, cpuCoresUsed: 0.1, ramMb: 64, health: 'healthy',
      },
    }

    render(<ServicesDrawer server={currentServer(serverId)} doc={doc} compiled={compiled} running liveInstances={liveInstances} />)
    const rows = screen.getAllByTestId('service-live-row')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent('healthy · 100 rps')
    expect(rows[0].dataset.parked).toBe('false')
    for (const parked of rows.slice(1)) {
      expect(parked.dataset.parked).toBe('true')
      expect(parked).toHaveTextContent('parked')
      expect(parked).not.toHaveTextContent('healthy')
      expect(parked).not.toHaveTextContent('down')
    }
  })

  // Regression floor: with no published instances at all (watching, but before the first batch),
  // nothing is parked — the pre-FEAT-008 healthy fallback stands.
  it('does not treat instances as parked before the first batch publishes', () => {
    const serverId = seedServer()
    const bpId = useWorldStore.getState().addBlueprint('db')
    useWorldStore.getState().addPlacement(bpId, serverId)
    const doc = currentDoc()
    render(<ServicesDrawer server={currentServer(serverId)} doc={doc} compiled={compileWorld(doc)} running liveInstances={{}} />)
    const rows = screen.getAllByTestId('service-live-row')
    expect(rows).toHaveLength(1)
    expect(rows[0].dataset.parked).toBe('false')
    expect(rows[0]).toHaveTextContent('healthy')
  })

  // FEAT-008 (Task 21): the "desired / running / max" readout — gated on the batch actually
  // having published a runningByPlacement entry for this placement AND the placement being
  // authored as autoscaled, per the brief's exact condition.
  it('renders desired / running / max for an autoscaled placement once runningByPlacement publishes', () => {
    const serverId = seedServer()
    const bpId = useWorldStore.getState().addBlueprint('web')
    const plId = useWorldStore.getState().addPlacement(bpId, serverId)
    useWorldStore.getState().updatePlacement(plId, {
      count: 1, autoscale: { minCount: 1, maxCount: 4, targetCpuPercent: 60, scaleUpCooldownSec: 60, scaleDownCooldownSec: 300 },
    })
    const doc = currentDoc()
    const compiled = compileWorld(doc)
    const instances = Object.values(compiled.instances).filter(i => i.serverId === serverId)
    expect(instances).toHaveLength(4)   // envelope

    const running2 = instances.filter(i => i.indexInPlacement < 2)
    const liveInstances: Record<string, InstanceMetrics> = {}
    running2.forEach(inst => {
      liveInstances[inst.id] = {
        instanceId: inst.id, rps: 10, errorRate: 0, p50Ms: 2, p99Ms: 4,
        activeConnections: 1, cpuCoresUsed: 0.1, ramMb: 64, health: 'healthy',
      }
    })

    render(
      <ServicesDrawer
        server={currentServer(serverId)} doc={doc} compiled={compiled} running liveInstances={liveInstances}
        runningByPlacement={{ [plId]: 2 }}
      />,
    )
    const readout = screen.getByTestId('autoscale-readout')
    expect(readout).toHaveTextContent('2 / 2 / 4')
  })

  it('renders a "draining" suffix when running exceeds desired for one tick', () => {
    const serverId = seedServer()
    const bpId = useWorldStore.getState().addBlueprint('web')
    const plId = useWorldStore.getState().addPlacement(bpId, serverId)
    useWorldStore.getState().updatePlacement(plId, {
      count: 1, autoscale: { minCount: 1, maxCount: 4, targetCpuPercent: 60, scaleUpCooldownSec: 60, scaleDownCooldownSec: 300 },
    })
    const doc = currentDoc()
    const compiled = compileWorld(doc)
    const instances = Object.values(compiled.instances).filter(i => i.serverId === serverId)
    const liveInstances: Record<string, InstanceMetrics> = {}
    instances.slice(0, 2).forEach(inst => {
      liveInstances[inst.id] = {
        instanceId: inst.id, rps: 10, errorRate: 0, p50Ms: 2, p99Ms: 4,
        activeConnections: 1, cpuCoresUsed: 0.1, ramMb: 64, health: 'healthy',
      }
    })
    render(
      <ServicesDrawer
        server={currentServer(serverId)} doc={doc} compiled={compiled} running liveInstances={liveInstances}
        runningByPlacement={{ [plId]: 1 }}
      />,
    )
    const readout = screen.getByTestId('autoscale-readout')
    expect(readout).toHaveTextContent('1 / 2 / 4')
    expect(readout).toHaveTextContent('draining')
  })

  it('shows no readout for a non-autoscaled placement even when runningByPlacement is supplied', () => {
    const serverId = seedServer()
    const bpId = useWorldStore.getState().addBlueprint('db')
    const plId = useWorldStore.getState().addPlacement(bpId, serverId)
    const doc = currentDoc()
    const compiled = compileWorld(doc)
    const instances = Object.values(compiled.instances).filter(i => i.serverId === serverId)
    const liveInstances: Record<string, InstanceMetrics> = {
      [instances[0].id]: {
        instanceId: instances[0].id, rps: 10, errorRate: 0, p50Ms: 2, p99Ms: 4,
        activeConnections: 1, cpuCoresUsed: 0.1, ramMb: 64, health: 'healthy',
      },
    }
    render(
      <ServicesDrawer
        server={currentServer(serverId)} doc={doc} compiled={compiled} running liveInstances={liveInstances}
        runningByPlacement={{ [plId]: 1 }}
      />,
    )
    expect(screen.queryByTestId('autoscale-readout')).toBeNull()
  })
})

describe('ServicesDrawer — authoring the AutoscalePolicy (FEAT-008 Task 21)', () => {
  it('the chip defaults to "static count" and toggling "autoscale" reveals the policy fields with sane defaults', () => {
    const serverId = seedServer()
    const bpId = useWorldStore.getState().addBlueprint('web')
    const plId = useWorldStore.getState().addPlacement(bpId, serverId)
    render(<ReactiveDrawer serverId={serverId} running={false} />)
    expect(screen.queryByTestId('autoscale-fields')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'autoscale' }))
    expect(screen.getByTestId('autoscale-fields')).toBeTruthy()
    expect(currentDoc().placements[plId].autoscale).toMatchObject({ minCount: 1, maxCount: 2, targetCpuPercent: 70 })
  })

  it('editing a policy field dispatches updatePlacement live', () => {
    const serverId = seedServer()
    const bpId = useWorldStore.getState().addBlueprint('web')
    const plId = useWorldStore.getState().addPlacement(bpId, serverId)
    render(<ReactiveDrawer serverId={serverId} running={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'autoscale' }))
    fireEvent.change(screen.getByLabelText('max count'), { target: { value: '8' } })
    expect(currentDoc().placements[plId].autoscale?.maxCount).toBe(8)
  })

  it('switching back to "static count" drops the autoscale policy', () => {
    const serverId = seedServer()
    const bpId = useWorldStore.getState().addBlueprint('web')
    const plId = useWorldStore.getState().addPlacement(bpId, serverId)
    useWorldStore.getState().updatePlacement(plId, {
      autoscale: { minCount: 1, maxCount: 4, targetCpuPercent: 60, scaleUpCooldownSec: 60, scaleDownCooldownSec: 300 },
    })
    render(<ServicesDrawer server={currentServer(serverId)} doc={currentDoc()} compiled={compileWorld(currentDoc())} running={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'static count' }))
    expect(currentDoc().placements[plId].autoscale).toBeUndefined()
  })

  it('the toggle and fields are edit-locked while running', () => {
    const serverId = seedServer()
    const bpId = useWorldStore.getState().addBlueprint('web')
    const plId = useWorldStore.getState().addPlacement(bpId, serverId)
    useWorldStore.getState().updatePlacement(plId, {
      autoscale: { minCount: 1, maxCount: 4, targetCpuPercent: 60, scaleUpCooldownSec: 60, scaleDownCooldownSec: 300 },
    })
    render(<ServicesDrawer server={currentServer(serverId)} doc={currentDoc()} compiled={compileWorld(currentDoc())} running />)
    expect(screen.getByRole('button', { name: 'static count' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'autoscale' })).toBeDisabled()
    expect(screen.getByLabelText('max count')).toBeDisabled()
  })
})
