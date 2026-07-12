// @vitest-environment jsdom
// Polish 4 T4 (spec D6): SERVICES drawer — chip lines, count stepper, mount-a-blueprint flow.
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ServicesDrawer, servicesPv } from './ServicesDrawer'
import { useWorldStore } from '../../../store/world.store'
import { getPreset } from '../../../../lib/world/instanceCatalog'
import type { Server, WorldDoc } from '../../../../lib/world/types'

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
})

describe('ServicesDrawer', () => {
  it('renders one chip line per placement with name/port/role', () => {
    const serverId = seedServer()
    const bpId = useWorldStore.getState().addBlueprint('db')
    useWorldStore.getState().addPlacement(bpId, serverId)
    render(<ServicesDrawer server={currentServer(serverId)} doc={currentDoc()} running={false} />)
    const chip = screen.getByTestId('service-chip-line')
    expect(chip).toHaveTextContent('db')
    expect(chip).toHaveTextContent('primary')
  })

  it('"+" stepper dispatches updatePlacement with count clamped >= 1', () => {
    const serverId = seedServer()
    const bpId = useWorldStore.getState().addBlueprint('db')
    const plId = useWorldStore.getState().addPlacement(bpId, serverId)
    render(<ServicesDrawer server={currentServer(serverId)} doc={currentDoc()} running={false} />)
    fireEvent.click(screen.getByLabelText('increase db count'))
    expect(currentDoc().placements[plId].count).toBe(2)
  })

  it('"−" stepper never drops count below 1', () => {
    const serverId = seedServer()
    const bpId = useWorldStore.getState().addBlueprint('db')
    const plId = useWorldStore.getState().addPlacement(bpId, serverId)
    render(<ServicesDrawer server={currentServer(serverId)} doc={currentDoc()} running={false} />)
    fireEvent.click(screen.getByLabelText('decrease db count'))
    expect(currentDoc().placements[plId].count).toBe(1)
  })

  it('steppers are edit-locked while running', () => {
    const serverId = seedServer()
    const bpId = useWorldStore.getState().addBlueprint('db')
    useWorldStore.getState().addPlacement(bpId, serverId)
    render(<ServicesDrawer server={currentServer(serverId)} doc={currentDoc()} running />)
    expect(screen.getByLabelText('increase db count')).toBeDisabled()
    expect(screen.getByLabelText('decrease db count')).toBeDisabled()
  })

  it('"+ mount a blueprint…" expands to a select, and choosing one dispatches addPlacement(blueprintId, serverId)', () => {
    const serverId = seedServer()
    const bpId = useWorldStore.getState().addBlueprint('cache')
    render(<ServicesDrawer server={currentServer(serverId)} doc={currentDoc()} running={false} />)
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
    render(<ServicesDrawer server={currentServer(serverId)} doc={currentDoc()} running />)
    const ghost = screen.getByTestId('mount-blueprint-ghost')
    expect(ghost).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(ghost)
    expect(screen.queryByLabelText('mount a blueprint')).toBeNull()
  })
})
