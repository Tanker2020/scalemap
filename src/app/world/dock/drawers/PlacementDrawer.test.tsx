// @vitest-environment jsdom
// Polish 4 T4 (spec D6): PLACEMENT drawer — InspectorV2's rack selector, migrated verbatim
// (same assertions, new mount) per the D6 retirement: InspectorV2's selected-server pane
// (including this rack-selector test, originally InspectorV2.test.tsx's "rack selector disables
// full racks and dispatches assignServerToRack") is superseded by this drawer.
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PlacementDrawer, placementPv } from './PlacementDrawer'
import { useWorldStore } from '../../../store/world.store'
import { getPreset } from '../../../../lib/world/instanceCatalog'
import type { Server, WorldDoc } from '../../../../lib/world/types'

beforeEach(() => { useWorldStore.getState().newWorld() })

function seedAz(): string {
  const regionId = useWorldStore.getState().addRegion('us-east-1')
  return useWorldStore.getState().addAz(regionId, 'us-east-1a')
}
function currentDoc(): WorldDoc { return useWorldStore.getState().doc }
function currentServer(id: string): Server { return currentDoc().servers[id] }

describe('placementPv', () => {
  it('"free pool" when unracked', () => {
    const azId = seedAz()
    const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    expect(placementPv(currentServer(serverId), currentDoc())).toBe('free pool')
  })

  it('"<rack label> · slot <unit>" when racked', () => {
    const azId = seedAz()
    useWorldStore.getState().addRack(azId)
    const rack = Object.values(currentDoc().racks)[0]
    const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    useWorldStore.getState().assignServerToRack(serverId, rack.id)
    expect(placementPv(currentServer(serverId), currentDoc())).toBe(`${rack.label} · slot 1`)
  })
})

describe('PlacementDrawer — rack selector (migrated from InspectorV2.test.tsx)', () => {
  it('rack selector disables full racks and dispatches assignServerToRack', () => {
    const azId = seedAz()

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

    render(<PlacementDrawer server={currentServer(selected)} doc={currentDoc()} running={false} />)

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

  it('the rack select is edit-locked while running, with the standard title', () => {
    const azId = seedAz()
    const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(<PlacementDrawer server={currentServer(serverId)} doc={currentDoc()} running />)
    const select = screen.getByLabelText('rack')
    expect(select).toBeDisabled()
    expect(select).toHaveAttribute('title', 'stop the simulation to edit')
  })
})
