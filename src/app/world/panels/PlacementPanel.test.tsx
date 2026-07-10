// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PlacementPanel } from './PlacementPanel'
import { useWorldStore } from '../../store/world.store'
import { getPreset } from '../../../lib/world/instanceCatalog'

beforeEach(() => useWorldStore.getState().newWorld())

function seedPlacement() {
  const s = useWorldStore.getState()
  const regionId = s.addRegion('us-east-1')
  const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
  const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
  const bpId = useWorldStore.getState().addBlueprint('api')
  const plId = useWorldStore.getState().addPlacement(bpId, serverId)
  return { serverId, bpId, plId }
}

describe('PlacementPanel', () => {
  it('+ Place dispatches addPlacement to the first server', () => {
    seedPlacement()
    render(<PlacementPanel />)
    fireEvent.click(screen.getByText('+ Place'))
    expect(Object.keys(useWorldStore.getState().doc.placements)).toHaveLength(2)
  })

  it('role segmented dispatches updatePlacement with the exact patch', () => {
    const { plId } = seedPlacement()
    render(<PlacementPanel />)
    fireEvent.click(screen.getByText('replica'))
    expect(useWorldStore.getState().doc.placements[plId].role).toBe('replica')
  })

  it('count clamps to a floor of 1', () => {
    const { plId } = seedPlacement()
    render(<PlacementPanel />)
    fireEvent.change(screen.getByLabelText('pl-count'), { target: { value: '0' } })
    expect(useWorldStore.getState().doc.placements[plId].count).toBe(1)
  })

  it('managed service add + remove dispatch with provider', () => {
    seedPlacement()
    render(<PlacementPanel />)
    const scopeSelect = screen.getAllByRole('combobox').find(el => el.querySelector('option[value=""]'))!
    fireEvent.change(scopeSelect, { target: { value: scopeSelect.querySelectorAll('option')[1].getAttribute('value') } })
    fireEvent.click(screen.getByText('+ Add'))
    const ms = Object.values(useWorldStore.getState().doc.managedServices)
    expect(ms).toHaveLength(1)
    expect(ms[0].provider).toBe('aws')

    // Remove: the managed row's × is the last one in DOM order — the seeded placement's own
    // remove button (from the blueprints/placements section) renders above ▸ MANAGED SERVICES.
    const removeButtons = screen.getAllByText('×')
    fireEvent.click(removeButtons[removeButtons.length - 1])
    expect(Object.values(useWorldStore.getState().doc.managedServices)).toHaveLength(0)
  })
})
