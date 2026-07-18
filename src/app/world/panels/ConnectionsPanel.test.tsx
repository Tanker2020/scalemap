// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ConnectionsPanel } from './ConnectionsPanel'
import { useWorldStore } from '../../store/world.store'
import { getPreset } from '../../../lib/world/instanceCatalog'
import type { BlueprintDependency } from '../../../lib/world/types'

// api (public, so it also gets a synthetic Internet ingress edge) depends on db.
function seedApiDb(): { apiId: string; dbId: string } {
  const regionId = useWorldStore.getState().addRegion('us-east-1')
  const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
  const apiSrv = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
  const dbSrv = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
  const apiId = useWorldStore.getState().addBlueprint('api')
  const dbId = useWorldStore.getState().addBlueprint('db')
  useWorldStore.getState().addPlacement(apiId, apiSrv)
  useWorldStore.getState().addPlacement(dbId, dbSrv)

  useWorldStore.getState().updateBlueprint(apiId, {
    ports: [{ port: 443, protocol: 'tcp', visibility: 'public' }],
    dependencies: [{
      id: 'dep-1', target: { kind: 'blueprint', blueprintId: dbId },
      port: 5432, protocol: 'db', packetTemplateId: null,
    } satisfies BlueprintDependency],
  })
  return { apiId, dbId }
}

beforeEach(() => useWorldStore.getState().newWorld())

describe('ConnectionsPanel', () => {
  it('lists each connection with its endpoints and port', () => {
    seedApiDb()
    render(<ConnectionsPanel onOpenGraph={() => {}} />)

    const row = screen.getByTestId('connection-row-dep-1')

    expect(row.textContent).toContain('api')
    expect(row.textContent).toContain('db')
    expect(row.textContent).toContain('5432')
  })

  it('lists the synthetic Internet ingress edge alongside authored dependencies', () => {
    seedApiDb()
    render(<ConnectionsPanel onOpenGraph={() => {}} />)
    expect(screen.getByText('Internet')).toBeTruthy()
  })

  // The canvas is the editor; the dock is the index into it. The tab must be able to reach it.
  it('opens the full-screen graph on request', () => {
    seedApiDb()
    const onOpenGraph = vi.fn()
    render(<ConnectionsPanel onOpenGraph={onOpenGraph} />)

    fireEvent.click(screen.getByRole('button', { name: /open graph/i }))

    expect(onOpenGraph).toHaveBeenCalledOnce()
  })

  // The dock header renders its own count; if it counts a different set than this list renders,
  // the user sees "3 connections" above four rows. Pin the list's own composition so the header
  // formula in WorldPanel has something concrete to agree with.
  it('renders one row per authored dependency PLUS one per public ingress', () => {
    seedApiDb()   // 1 authored dependency (api -> db) + 1 public port on api
    render(<ConnectionsPanel onOpenGraph={() => {}} />)
    expect(screen.getAllByTestId(/^connection-row-/)).toHaveLength(2)
  })

  it('tells the user what the surface is for when there are no connections yet', () => {
    render(<ConnectionsPanel onOpenGraph={() => {}} />)
    expect(screen.getByText(/no connections/i)).toBeTruthy()
  })

  // A blocked edge is the single most important thing this list can show — it is a
  // misconfiguration the user cannot see anywhere else without opening the graph.
  it('marks a blocked connection as blocked', () => {
    const { apiId, dbId } = seedApiDb()
    // Close the db host's firewall so the compiled path is denied.
    const dbServerId = Object.values(useWorldStore.getState().doc.placements)
      .find(p => p.blueprintId === dbId)!.serverId
    useWorldStore.getState().updateServer(dbServerId, { firewall: [] })

    render(<ConnectionsPanel onOpenGraph={() => {}} />)

    expect(screen.getByTestId('connection-row-dep-1').textContent).toMatch(/blocked/i)
    expect(apiId).toBeTruthy()
  })
})
