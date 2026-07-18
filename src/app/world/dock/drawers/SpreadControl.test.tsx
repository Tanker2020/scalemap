// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SpreadControl } from './SpreadControl'
import { useWorldStore } from '../../../store/world.store'
import { getPreset } from '../../../../lib/world/instanceCatalog'

function seed(azCount = 3) {
  const regionId = useWorldStore.getState().addRegion('us-east-1')
  const azIds: string[] = []
  for (let i = 0; i < azCount; i++) {
    azIds.push(useWorldStore.getState().addAz(regionId, `us-east-1${String.fromCharCode(97 + i)}`))
  }
  const serverId = useWorldStore.getState().addServer(azIds[0], getPreset('vps-medium')!)
  const blueprintId = useWorldStore.getState().addBlueprint('api')
  useWorldStore.getState().addPlacement(blueprintId, serverId)
  return { regionId, azIds, serverId, blueprintId }
}

function open(): void {
  fireEvent.click(screen.getByRole('button', { name: /spread/i }))
}

beforeEach(() => useWorldStore.getState().newWorld())

describe('SpreadControl', () => {
  it('offers the other AZs in the same region as spread targets', () => {
    const { azIds, serverId, blueprintId } = seed(3)
    render(<SpreadControl blueprintId={blueprintId} serverId={serverId} running={false} />)

    open()

    expect(screen.getByLabelText('us-east-1b')).toBeTruthy()
    expect(screen.getByLabelText('us-east-1c')).toBeTruthy()
    // Not the AZ this copy already lives in.
    expect(screen.queryByLabelText('us-east-1a')).toBeNull()
    expect(azIds).toHaveLength(3)
  })

  it('spreads into the checked AZs only', () => {
    const { azIds, serverId, blueprintId } = seed(3)
    render(<SpreadControl blueprintId={blueprintId} serverId={serverId} running={false} />)
    open()

    fireEvent.click(screen.getByLabelText('us-east-1b'))
    fireEvent.click(screen.getByRole('button', { name: /^spread into/i }))

    const doc = useWorldStore.getState().doc
    const azOf = (serverIdIn: string) => doc.servers[serverIdIn].azId
    const hostAzs = Object.values(doc.placements)
      .filter(p => p.blueprintId === blueprintId).map(p => azOf(p.serverId))

    expect(hostAzs).toContain(azIds[1])
    expect(hostAzs).not.toContain(azIds[2])
  })

  // An AZ that already runs this service is not a spread target — showing it as one invites a
  // click that silently does nothing (planSpread skips it).
  it('does not offer an AZ that already hosts the service', () => {
    const { azIds, serverId, blueprintId } = seed(3)
    const other = useWorldStore.getState().addServer(azIds[1], getPreset('vps-medium')!)
    useWorldStore.getState().addPlacement(blueprintId, other)

    render(<SpreadControl blueprintId={blueprintId} serverId={serverId} running={false} />)
    open()

    expect(screen.queryByLabelText('us-east-1b')).toBeNull()
    expect(screen.getByLabelText('us-east-1c')).toBeTruthy()
  })

  it('says so when the service already covers every AZ in the region', () => {
    const { azIds, serverId, blueprintId } = seed(2)
    const other = useWorldStore.getState().addServer(azIds[1], getPreset('vps-medium')!)
    useWorldStore.getState().addPlacement(blueprintId, other)

    render(<SpreadControl blueprintId={blueprintId} serverId={serverId} running={false} />)
    open()

    expect(screen.getByText(/every az/i)).toBeTruthy()
  })

  // Nothing checked means nothing to do — the action must not be live.
  it('disables the spread action until at least one AZ is checked', () => {
    const { serverId, blueprintId } = seed(3)
    render(<SpreadControl blueprintId={blueprintId} serverId={serverId} running={false} />)
    open()

    expect(screen.getByRole('button', { name: /^spread into/i })).toBeDisabled()

    fireEvent.click(screen.getByLabelText('us-east-1b'))

    expect(screen.getByRole('button', { name: /^spread into/i })).not.toBeDisabled()
  })

  it('is edit-locked while the simulation runs', () => {
    const { serverId, blueprintId } = seed(3)
    render(<SpreadControl blueprintId={blueprintId} serverId={serverId} running />)

    expect(screen.getByRole('button', { name: /spread/i })).toBeDisabled()
  })

  it('closes after a spread, so the panel returns to its resting state', () => {
    const { serverId, blueprintId } = seed(3)
    render(<SpreadControl blueprintId={blueprintId} serverId={serverId} running={false} />)
    open()

    fireEvent.click(screen.getByLabelText('us-east-1b'))
    fireEvent.click(screen.getByRole('button', { name: /^spread into/i }))

    expect(screen.queryByLabelText('us-east-1c')).toBeNull()
  })
})
