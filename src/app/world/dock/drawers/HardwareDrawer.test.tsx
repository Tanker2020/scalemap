// @vitest-environment jsdom
// Polish 4 T4 (spec D6): HARDWARE drawer — preset-ladder knob commits + consequence hints.
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { HardwareDrawer, hardwarePv, currentLadderIndex } from './HardwareDrawer'
import { useWorldStore } from '../../../store/world.store'
import { compileWorld } from '../../../../lib/world/compileWorld'
import { getPreset, presetLadder } from '../../../../lib/world/instanceCatalog'
import type { Server, WorldDoc } from '../../../../lib/world/types'

beforeEach(() => { useWorldStore.getState().newWorld() })

function seedServer(): { azId: string; serverId: string } {
  const regionId = useWorldStore.getState().addRegion('us-east-1')
  const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
  const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
  return { azId, serverId }
}

function currentDoc(): WorldDoc { return useWorldStore.getState().doc }
function currentServer(id: string): Server { return currentDoc().servers[id] }

describe('hardwarePv', () => {
  it('formats "<vcpu>c · <ramGb>G"', () => {
    const s = { specs: { vcpu: 8, ramMb: 32768 } } as Server
    expect(hardwarePv(s)).toBe('8c · 32G')
  })

  // Polish 4 T5 (spec D7): watching posture re-voices the pv to "<cpu>% cpu · <ram>% ram".
  it('re-voices to "<cpu>% cpu · <ram>% ram" when a live reading is supplied', () => {
    const s = { specs: { vcpu: 8, ramMb: 32768 } } as Server
    expect(hardwarePv(s, { cpuPct: 31, ramPct: 42 })).toBe('31% cpu · 42% ram')
  })
})

describe('currentLadderIndex', () => {
  it('matches by catalogId exactly when the server is on-ladder', () => {
    const ladder = presetLadder('vps')
    const p = ladder[1]
    const s = { catalogId: p.id, specs: p.specs } as Server
    expect(currentLadderIndex(s, ladder)).toBe(1)
  })

  it('falls back to nearest-by-distance for an off-ladder custom spec', () => {
    const ladder = presetLadder('vps')
    const s = { catalogId: null, specs: { vcpu: ladder[0].specs.vcpu, ramMb: ladder[0].specs.ramMb } } as Server
    expect(currentLadderIndex(s, ladder)).toBe(0)
  })
})

describe('HardwareDrawer', () => {
  it('renders the current vCPU/RAM as the knob values', () => {
    const { serverId } = seedServer()
    const doc = currentDoc()
    render(<HardwareDrawer server={currentServer(serverId)} doc={doc} compiled={compileWorld(doc)} running={false} />)
    expect(screen.getByLabelText('vCPU')).toHaveValue(String(currentLadderIndex(currentServer(serverId), presetLadder('vps'))))
  })

  it('shows "no services mounted yet" when nothing is placed', () => {
    const { serverId } = seedServer()
    const doc = currentDoc()
    render(<HardwareDrawer server={currentServer(serverId)} doc={doc} compiled={compileWorld(doc)} running={false} />)
    expect(screen.getByTestId('vcpu-hint')).toHaveTextContent('no services mounted yet')
    expect(screen.getByTestId('ram-hint')).toHaveTextContent('—')
  })

  it('shows the rps-sustain hint once a blueprint is placed', () => {
    const { serverId } = seedServer()
    const bpId = useWorldStore.getState().addBlueprint('api')
    useWorldStore.getState().addPlacement(bpId, serverId)
    const doc = currentDoc()
    render(<HardwareDrawer server={currentServer(serverId)} doc={doc} compiled={compileWorld(doc)} running={false} />)
    expect(screen.getByTestId('vcpu-hint')).toHaveTextContent('sustains ~')
    expect(screen.getByTestId('vcpu-hint')).toHaveTextContent('rps of api')
    expect(screen.getByTestId('ram-hint')).toHaveTextContent('headroom for ~')
  })

  it('RAM hint is singular ("1 connection") when the computed headroom rounds to 1 (global-constraints singular-aware-copy law)', () => {
    const { serverId } = seedServer()
    const bpId = useWorldStore.getState().addBlueprint('api')
    useWorldStore.getState().addPlacement(bpId, serverId)
    // vps-medium has 8192 MB RAM; pin resident demand to 8191 MB and per-connection cost to
    // 1 MB, so headroom = round((8192 - 8191) / 1) = exactly 1.
    useWorldStore.getState().updateBlueprint(bpId, {
      workload: { cpuMsPerRequest: 5, ramBaseMb: 8191, ramPerConnMb: 1, diskIoPerRequest: 0 },
    })
    const doc = currentDoc()
    render(<HardwareDrawer server={currentServer(serverId)} doc={doc} compiled={compileWorld(doc)} running={false} />)
    expect(screen.getByTestId('ram-hint')).toHaveTextContent('headroom for ~1 connection at 1 MB each')
    expect(screen.getByTestId('ram-hint')).not.toHaveTextContent('1 connections')
  })

  it('moving the vCPU knob commits the target preset\'s FULL set (specs/hourlyUsd/oversubscription/burstable)', () => {
    const { serverId } = seedServer()
    const doc = currentDoc()
    const ladder = presetLadder('vps')
    const targetIndex = ladder.length - 1
    render(<HardwareDrawer server={currentServer(serverId)} doc={doc} compiled={compileWorld(doc)} running={false} />)
    fireEvent.change(screen.getByLabelText('vCPU'), { target: { value: String(targetIndex) } })

    const updated = currentServer(serverId)
    const target = ladder[targetIndex]
    expect(updated.catalogId).toBe(target.id)
    expect(updated.specs).toEqual(target.specs)
    expect(updated.hourlyUsd).toBe(target.hourlyUsd)
    expect(updated.oversubscriptionRatio).toBe(target.oversubscriptionRatio)
    expect(updated.burstable).toBe(target.burstable)
  })

  it('moving the RAM knob commits through the SAME ladder (both knobs re-render the chosen preset)', () => {
    const { serverId } = seedServer()
    const doc = currentDoc()
    const ladder = presetLadder('vps')
    const targetIndex = 0
    render(<HardwareDrawer server={currentServer(serverId)} doc={doc} compiled={compileWorld(doc)} running={false} />)
    fireEvent.change(screen.getByLabelText('RAM'), { target: { value: String(targetIndex) } })
    expect(currentServer(serverId).catalogId).toBe(ladder[targetIndex].id)
  })

  it('knobs are disabled and titled while running (edit-lock law)', () => {
    const { serverId } = seedServer()
    const doc = currentDoc()
    render(<HardwareDrawer server={currentServer(serverId)} doc={doc} compiled={compileWorld(doc)} running />)
    const vcpu = screen.getByLabelText('vCPU')
    expect(vcpu).toBeDisabled()
    expect(vcpu).toHaveAttribute('title', 'stop the simulation to edit')
  })
})

// Task 22 (FEAT-006): diskIops/diskType authoring — plain field inputs (not ladder knobs, since
// disk specs aren't part of the vCPU/RAM preset walk), gated on `running` the same way.
describe('HardwareDrawer — disk fields', () => {
  it('reflects the seeded preset\'s diskType (vps-medium ships "ssd") and defaults diskIops to "auto"', () => {
    const { serverId } = seedServer()
    const doc = currentDoc()
    render(<HardwareDrawer server={currentServer(serverId)} doc={doc} compiled={compileWorld(doc)} running={false} />)
    expect(screen.getByLabelText('Disk Type')).toHaveValue('ssd')
    expect(screen.getByLabelText('Disk IOPS')).toHaveValue(null)
  })

  it('renders "auto — unbounded" when the server has no authored diskType', () => {
    const { serverId } = seedServer()
    useWorldStore.getState().updateServer(serverId, { specs: { ...currentServer(serverId).specs, diskType: undefined } })
    const doc = currentDoc()
    render(<HardwareDrawer server={currentServer(serverId)} doc={doc} compiled={compileWorld(doc)} running={false} />)
    expect(screen.getByLabelText('Disk Type')).toHaveValue('')
  })

  it('choosing a disk type commits specs.diskType and leaves other specs untouched', () => {
    const { serverId } = seedServer()
    const doc = currentDoc()
    const before = currentServer(serverId).specs
    render(<HardwareDrawer server={currentServer(serverId)} doc={doc} compiled={compileWorld(doc)} running={false} />)
    fireEvent.change(screen.getByLabelText('Disk Type'), { target: { value: 'hdd' } })
    const after = currentServer(serverId).specs
    expect(after.diskType).toBe('hdd')
    expect(after.vcpu).toBe(before.vcpu)
    expect(after.ramMb).toBe(before.ramMb)
  })

  it('picking "auto — unbounded" clears diskType back to undefined', () => {
    const { serverId } = seedServer()
    useWorldStore.getState().updateServer(serverId, { specs: { ...currentServer(serverId).specs, diskType: 'nvme' } })
    const doc = currentDoc()
    render(<HardwareDrawer server={currentServer(serverId)} doc={doc} compiled={compileWorld(doc)} running={false} />)
    fireEvent.change(screen.getByLabelText('Disk Type'), { target: { value: '' } })
    expect(currentServer(serverId).specs.diskType).toBeUndefined()
  })

  it('entering a diskIops value commits it as a rounded number', () => {
    const { serverId } = seedServer()
    const doc = currentDoc()
    render(<HardwareDrawer server={currentServer(serverId)} doc={doc} compiled={compileWorld(doc)} running={false} />)
    fireEvent.change(screen.getByLabelText('Disk IOPS'), { target: { value: '3000' } })
    expect(currentServer(serverId).specs.diskIops).toBe(3000)
  })

  it('clearing the diskIops field commits it back to undefined ("auto")', () => {
    const { serverId } = seedServer()
    useWorldStore.getState().updateServer(serverId, { specs: { ...currentServer(serverId).specs, diskIops: 5000 } })
    const doc = currentDoc()
    render(<HardwareDrawer server={currentServer(serverId)} doc={doc} compiled={compileWorld(doc)} running={false} />)
    fireEvent.change(screen.getByLabelText('Disk IOPS'), { target: { value: '' } })
    expect(currentServer(serverId).specs.diskIops).toBeUndefined()
  })

  it('disk fields are disabled and titled while running (edit-lock law)', () => {
    const { serverId } = seedServer()
    const doc = currentDoc()
    render(<HardwareDrawer server={currentServer(serverId)} doc={doc} compiled={compileWorld(doc)} running />)
    // While running, HardwareDrawer takes the `live` early-return path in ServerFaceplate — but
    // this test exercises HardwareDrawer standalone with `running` true and no `live` supplied
    // (as HardwareDrawer.test.tsx already does for the vCPU/RAM knobs above), which still renders
    // the authoring body with disk fields disabled.
    const diskType = screen.getByLabelText('Disk Type')
    const diskIops = screen.getByLabelText('Disk IOPS')
    expect(diskType).toBeDisabled()
    expect(diskType).toHaveAttribute('title', 'stop the simulation to edit')
    expect(diskIops).toBeDisabled()
    expect(diskIops).toHaveAttribute('title', 'stop the simulation to edit')
  })
})

// Polish 4 T5 (spec D7): watching posture — the two knobs freeze (opacity 0.55, no draggable
// `<input>` at all — "thumb hidden"), live rps/ram rows above them, both titled
// "locked while running".
describe('HardwareDrawer — watching posture (live supplied)', () => {
  it('renders live rps/ram rows and freezes both knobs (no <input>, opacity 0.55, live track fill)', () => {
    const { serverId } = seedServer()
    const doc = currentDoc()
    render(
      <HardwareDrawer
        server={currentServer(serverId)} doc={doc} compiled={compileWorld(doc)} running
        live={{ cpuFraction: 0.31, ramFraction: 0.42, rps: 418, ramUsedMb: 3440, ramTotalMb: 8192 }}
      />,
    )
    expect(screen.getByTestId('hw-live-rps')).toHaveTextContent('418')
    expect(screen.getByTestId('hw-live-ram')).toHaveTextContent('3.4 / 8.0 GB')

    const vcpuFrozen = screen.getByTestId('hw-frozen-vcpu')
    expect(vcpuFrozen).toHaveTextContent('vCPU — locked while running')
    expect(vcpuFrozen).toHaveAttribute('title', 'locked while running')
    expect(vcpuFrozen.style.opacity).toBe('0.55')

    const ramFrozen = screen.getByTestId('hw-frozen-ram')
    expect(ramFrozen).toHaveTextContent('RAM — locked while running')
    expect(ramFrozen).toHaveAttribute('title', 'locked while running')
    expect(ramFrozen.style.opacity).toBe('0.55')

    // No draggable range input anywhere in the watching body — the thumb isn't just hidden by
    // CSS, the interactive control doesn't render at all (holds during a stopped-but-scrubbing
    // read too, where the edit-lock's `disabled={running}` alone would NOT have covered it).
    expect(screen.queryByLabelText('vCPU')).toBeNull()
    expect(screen.queryByLabelText('RAM')).toBeNull()
  })
})
