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
