// @vitest-environment jsdom
// Polish 4 T2 (spec D4): region scope's Config tab — this region's AZ rows + a "+ az" button
// reusing TopologyPanel's exact `addAz` dispatch, edit-locked while running.
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RegionConfigTab } from './RegionConfigTab'
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import { useSimulationStore } from '../../store/simulation.store'
import { getPreset } from '../../../lib/world/instanceCatalog'
import type { MetricsBatch } from '../../../lib/worldEngine/types'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useNavStore.setState({ level: 'globe', regionId: null, azId: null, serverId: null })
  useSimulationStore.setState({ latestBatch: null, scrubBatch: null, running: false })
})

describe('RegionConfigTab', () => {
  it('shows an empty state when the region has no AZs yet', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    render(<RegionConfigTab regionId={regionId} />)
    expect(screen.getByTestId('region-config-tab')).toHaveTextContent(/no az/i)
  })

  it('lists one row per AZ in this region, with a singular-aware server count', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(<RegionConfigTab regionId={regionId} />)
    const rows = screen.getAllByTestId('region-config-az-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('us-east-1a')
    expect(rows[0]).toHaveTextContent('1 server')
  })

  it('pluralizes server count correctly', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(<RegionConfigTab regionId={regionId} />)
    expect(screen.getByTestId('region-config-az-row')).toHaveTextContent('2 servers')
  })

  it('only lists AZs belonging to THIS region, not sibling regions', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    useWorldStore.getState().addAz(regionId, 'us-east-1a')
    const otherRegionId = useWorldStore.getState().addRegion('eu-west-1')
    useWorldStore.getState().addAz(otherRegionId, 'eu-west-1a')
    render(<RegionConfigTab regionId={regionId} />)
    expect(screen.getAllByTestId('region-config-az-row')).toHaveLength(1)
  })

  it('shows live rps from the metrics batch when present, "—" at rest', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    render(<RegionConfigTab regionId={regionId} />)
    expect(screen.getByTestId('region-config-az-row')).toHaveTextContent('—')

    const batch: MetricsBatch = {
      simMs: 1000, instances: {}, servers: {},
      azs: { [azId]: { azId, rps: 42, errorRate: 0, p50Ms: 5, healthScore: 100, health: 'healthy', serverCount: 0, instanceCount: 0 } },
      regions: {},
      world: { totalRps: 42, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 },
    }
    useSimulationStore.setState({ latestBatch: batch })
    render(<RegionConfigTab regionId={regionId} />)
    const rows = screen.getAllByTestId('region-config-az-row')
    expect(rows[rows.length - 1]).toHaveTextContent('42 rps')
  })

  it('clicking an AZ row dispatches goAz(regionId, azId)', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    render(<RegionConfigTab regionId={regionId} />)
    fireEvent.click(screen.getByTestId('region-config-az-row'))
    expect(useNavStore.getState().level).toBe('az')
    expect(useNavStore.getState().regionId).toBe(regionId)
    expect(useNavStore.getState().azId).toBe(azId)
  })

  it('"+ az" dispatches addAz with the same auto-suffixed label convention as TopologyPanel', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    render(<RegionConfigTab regionId={regionId} />)
    fireEvent.click(screen.getByText('+ az'))
    const azs = Object.values(useWorldStore.getState().doc.azs)
    expect(azs).toHaveLength(1)
    expect(azs[0]).toMatchObject({ regionId, label: 'us-east-1a' })
  })

  it('"+ az" is edit-locked while running, with the standard tooltip', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    useSimulationStore.setState({ running: true })
    render(<RegionConfigTab regionId={regionId} />)
    const btn = screen.getByText('+ az')
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('title', 'stop the simulation to edit')
  })

  it('"+ az" is enabled with no tooltip when stopped', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    render(<RegionConfigTab regionId={regionId} />)
    const btn = screen.getByText('+ az')
    expect(btn).not.toBeDisabled()
    expect(btn).not.toHaveAttribute('title')
  })
})
