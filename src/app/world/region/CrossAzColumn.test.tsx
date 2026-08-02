// @vitest-environment jsdom
// FEAT-002 Task 14: render-file smoke test — a partition authored against two AZs strikes
// through the cross-AZ link (drop) or stipples it (loss). Not a pixel-diff test — asserts the
// right testid/style appears given a partitioned prop, per the brief.
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CrossAzColumn } from './CrossAzColumn'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
} from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'

// Two AZs in one region, with a stateful blueprint's primary/replica split across them — the
// SAME fixture shape regionData.test.ts's replicationPairs/crossAzEntries tests use — so
// crossAzEntries(regionId) yields exactly one { a: azA, b: azB } entry to assert against.
function twoAzWorldWithReplication() {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const azA = createAz(region.id, 'us-east-1a')
  const azB = createAz(region.id, 'us-east-1b')
  doc.regions[region.id] = region
  doc.azs[azA.id] = azA; doc.azs[azB.id] = azB
  const serverA = createServer(azA.id, getPreset('vps-medium')!)
  const serverB = createServer(azB.id, getPreset('vps-medium')!)
  doc.servers[serverA.id] = serverA; doc.servers[serverB.id] = serverB
  const db = createBlueprint('db', 2)
  db.stateful = true
  db.volumeName = 'data'
  doc.blueprints[db.id] = db
  const primary = createPlacement(db.id, serverB.id)
  const replica = createPlacement(db.id, serverA.id)
  replica.role = 'replica'
  doc.placements[primary.id] = primary
  doc.placements[replica.id] = replica
  return { doc, region, azA, azB }
}

beforeEach(() => {
  useSimulationStore.getState().resetSession()
})

describe('CrossAzColumn', () => {
  it('shows plain latency when no partition is active', () => {
    const { doc, region } = twoAzWorldWithReplication()
    useWorldStore.setState({ doc })
    render(<CrossAzColumn regionId={region.id} />)
    expect(screen.queryByTestId('crossaz-link-severed')).toBeNull()
    expect(screen.getByText(/ms$/)).toBeInTheDocument()
  })

  it('strikes through when partitioned (drop mode)', () => {
    const { doc, region, azA, azB } = twoAzWorldWithReplication()
    useWorldStore.setState({ doc })
    useSimulationStore.setState({
      partitions: [{ from: { kind: 'az', id: azA.id }, to: { kind: 'az', id: azB.id }, mode: 'drop', symmetric: true }],
    })
    render(<CrossAzColumn regionId={region.id} />)
    const severed = screen.getByTestId('crossaz-link-severed')
    expect(severed).toHaveStyle({ textDecoration: 'line-through' })
    expect(severed).toHaveTextContent('partitioned')
  })

  it('stipples (does not fully sever) for a loss-mode partition', () => {
    const { doc, region, azA, azB } = twoAzWorldWithReplication()
    useWorldStore.setState({ doc })
    useSimulationStore.setState({
      partitions: [{ from: { kind: 'az', id: azA.id }, to: { kind: 'az', id: azB.id }, mode: 'loss', lossFraction: 0.3, symmetric: true }],
    })
    render(<CrossAzColumn regionId={region.id} />)
    expect(screen.queryByTestId('crossaz-link-severed')).toBeNull()
    expect(screen.getByTestId('crossaz-link-lossy')).toHaveTextContent('30%')
  })

  it('an asymmetric partition matching the entry\'s from->to direction severs it; the reverse does not', () => {
    const { doc, region, azA, azB } = twoAzWorldWithReplication()
    useWorldStore.setState({ doc })
    // crossAzEntries orders entry.a/entry.b by AZ label ('us-east-1a' < 'us-east-1b'), so
    // entry.a === azA, entry.b === azB — impairmentFor is called (azA -> azB).
    useSimulationStore.setState({
      partitions: [{ from: { kind: 'az', id: azA.id }, to: { kind: 'az', id: azB.id }, mode: 'drop', symmetric: false }],
    })
    const { rerender } = render(<CrossAzColumn regionId={region.id} />)
    expect(screen.getByTestId('crossaz-link-severed')).toBeInTheDocument()

    useSimulationStore.setState({
      partitions: [{ from: { kind: 'az', id: azB.id }, to: { kind: 'az', id: azA.id }, mode: 'drop', symmetric: false }],
    })
    rerender(<CrossAzColumn regionId={region.id} />)
    expect(screen.queryByTestId('crossaz-link-severed')).toBeNull()
  })
})
