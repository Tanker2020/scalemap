// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TopologyPanel } from './TopologyPanel'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { getPreset } from '../../../lib/world/instanceCatalog'
import type { MetricsBatch } from '../../../lib/worldEngine/types'

beforeEach(() => useWorldStore.getState().newWorld())

describe('TopologyPanel', () => {
  it('adds a region from the catalog select', () => {
    render(<TopologyPanel />)
    fireEvent.change(screen.getByLabelText('add-region-select'), { target: { value: 'eu-west-1' } })
    fireEvent.click(screen.getByText('+ Region'))
    const regions = Object.values(useWorldStore.getState().doc.regions)
    expect(regions).toHaveLength(1)
    expect(regions[0].catalogId).toBe('eu-west-1')
  })

  it('adds an AZ with an auto-suffixed label, then a server from a preset', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    render(<TopologyPanel />)
    fireEvent.click(screen.getByText('+ AZ'))
    const azs = Object.values(useWorldStore.getState().doc.azs)
    expect(azs).toHaveLength(1)
    expect(azs[0]).toMatchObject({ regionId, label: 'us-east-1a' })

    fireEvent.click(screen.getByText('+ Server'))
    const servers = Object.values(useWorldStore.getState().doc.servers)
    expect(servers).toHaveLength(1)
    expect(servers[0].azId).toBe(azs[0].id)
  })

  it('adds a firewall rule to an expanded server', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, { id: 'vps-small', kind: 'vps', specs: { vcpu: 2, threadsPerCore: 1, ramMb: 4096, diskGb: 40, nicMbps: 500 }, hourlyUsd: 0.018, oversubscriptionRatio: 6, burstable: true })
    render(<TopologyPanel />)
    fireEvent.click(screen.getByText(/server-1/))       // expand the server editor
    fireEvent.click(screen.getByText('+ Rule'))
    const server = Object.values(useWorldStore.getState().doc.servers)[0]
    expect(server.firewall.length).toBe(2)              // default-internal + new rule
  })

  it('moves a firewall rule up with the ↑ button', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, { id: 'vps-small', kind: 'vps', specs: { vcpu: 2, threadsPerCore: 1, ramMb: 4096, diskGb: 40, nicMbps: 500 }, hourlyUsd: 0.018, oversubscriptionRatio: 6, burstable: true })
    render(<TopologyPanel />)
    fireEvent.click(screen.getByText(/server-1/))       // expand the server editor
    fireEvent.click(screen.getByText('+ Rule'))
    const before = Object.values(useWorldStore.getState().doc.servers)[0]
    expect(before.firewall.length).toBe(2)
    const newRule = before.firewall[1]

    const upButtons = screen.getAllByText('↑')
    fireEvent.click(upButtons[upButtons.length - 1])    // the new rule's ↑ (last row)

    const after = Object.values(useWorldStore.getState().doc.servers)[0]
    expect(after.firewall[0]).toEqual(newRule)
  })
})

function serverBatch(serverId: string, regionId: string): MetricsBatch {
  return {
    simMs: 1000,
    instances: {},
    servers: {
      [serverId]: {
        serverId, coreUtilization: [0.62, 0.62], stealFraction: 0, burstCredits: null,
        ramByInstance: [], ramUsedMb: 4096, ramTotalMb: 8192, nicInMbps: 0, nicOutMbps: 0,
        diskIoFraction: 0.3, health: 'healthy',
      },
    },
    azs: {},
    regions: { [regionId]: { regionId, rps: 100, errorRate: 0, p50Ms: 5, healthScore: 100, health: 'healthy', inboundByPopulation: [] } },
    world: { totalRps: 100, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 },
  }
}

describe('TopologyPanel — instrument restyle', () => {
  it('server row shows micro-bars and a utilization bar from a batch', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    useSimulationStore.setState({ latestBatch: serverBatch(serverId, regionId) })
    render(<TopologyPanel />)
    expect(screen.getAllByTestId('kit-microbar').length).toBe(3)
    expect(screen.getByTestId('topo-util-fill').style.width).toBe('62%')
    useSimulationStore.setState({ latestBatch: null })
  })

  it('at rest renders without utilization or fake numbers', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(<TopologyPanel />)
    expect(screen.queryByTestId('kit-microbar')).not.toBeInTheDocument()
    expect(screen.queryByTestId('topo-util-fill')).not.toBeInTheDocument()
  })

  it('preset card select feeds addServer with the chosen preset', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    useWorldStore.getState().addAz(regionId, 'us-east-1a')
    render(<TopologyPanel />)
    fireEvent.click(screen.getByLabelText('choose server preset'))     // opens the grid
    fireEvent.click(screen.getByText('dedicated-8'))                   // select card
    fireEvent.click(screen.getByText('+ Server'))
    const server = Object.values(useWorldStore.getState().doc.servers)[0]
    expect(server.catalogId).toBe('dedicated-8')
    expect(server.kind).toBe('dedicated')
  })

  it('healthWord chip appears only with metrics and uses the status color', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    useSimulationStore.setState({ latestBatch: serverBatch(serverId, regionId) })
    render(<TopologyPanel />)
    const word = screen.getByText('comfortable')          // healthWord(0.62, 0.5)
    expect(word).toHaveStyle({ color: 'var(--color-success)' })
    useSimulationStore.setState({ latestBatch: null })
  })

  it('no health word at rest', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(<TopologyPanel />)
    expect(screen.queryByText(/comfortable|tight|straining/)).not.toBeInTheDocument()
  })

  it('the hourly price renders in the price color', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(<TopologyPanel />)
    expect(screen.getByText('$0.036/hr')).toHaveStyle({ color: 'var(--color-price)' })
  })

  it('the preset-card price renders in the price color', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    useWorldStore.getState().addAz(regionId, 'us-east-1a')
    render(<TopologyPanel />)
    fireEvent.click(screen.getByLabelText('choose server preset'))     // opens the grid
    expect(screen.getByText('$0.036/hr')).toHaveStyle({ color: 'var(--color-price)' })
  })

  // T8 motion audit (spec D3, one-ambient-stroke-per-dock): server rows must never carry the
  // ripple animation, even with a healthy status while running — same law, same fix already
  // applied to RegionConfigTab's AZ rows in T2 (485ea33). TopologyPanel is the world-scope
  // Config tab body; its one permitted ambient stroke is the atlas's marching top arc, not a
  // per-row ripple on every healthy server.
  it('server row status dots never carry the ripple animation, even with a healthy status while running (D3: one ambient stroke per dock)', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    useSimulationStore.setState({ running: true, latestBatch: serverBatch(serverId, regionId) })
    render(<TopologyPanel />)
    const dot = screen.getByTestId('kit-dot')
    expect(dot.className).not.toMatch(/kit-ripple/)
    useSimulationStore.setState({ running: false, latestBatch: null })
  })
  // node-model Phase 5.3: managed services surface in the region tree.
  it('lists managed services in the region tree — region-scoped and az-scoped', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    const regionMs = useWorldStore.getState().addManagedService('dbSql', 'SQL DB', { kind: 'region', regionId }, 5432)
    const azMs = useWorldStore.getState().addManagedService('redis', 'Cache', { kind: 'az', azId }, 6379)
    render(<TopologyPanel />)
    expect(screen.getByTestId(`topology-managed-${regionMs}`)).toBeTruthy()
    expect(screen.getByTestId(`topology-managed-${azMs}`)).toBeTruthy()
    expect(screen.getByTestId(`topology-managed-${regionMs}`).textContent).toContain('region-wide')
  })
})

describe('TopologyPanel — Environments (Wave 5)', () => {
  it('adds a new environment via the add button', () => {
    render(<TopologyPanel />)
    fireEvent.click(screen.getByText('+ Environment'))
    const envs = Object.values(useWorldStore.getState().doc.environments ?? {})
    expect(envs).toHaveLength(1)
  })

  it('edits an environment label and factors', () => {
    useWorldStore.getState().addEnvironment('Staging')
    const id = Object.keys(useWorldStore.getState().doc.environments ?? {})[0]
    render(<TopologyPanel />)
    fireEvent.change(screen.getByLabelText(`env-label-${id}`), { target: { value: 'QA' } })
    fireEvent.change(screen.getByLabelText(`env-server-factor-${id}`), { target: { value: '0.1' } })
    fireEvent.change(screen.getByLabelText(`env-rps-factor-${id}`), { target: { value: '0.2' } })
    const env = useWorldStore.getState().doc.environments?.[id]
    expect(env?.label).toBe('QA')
    expect(env?.serverCountFactor).toBe(0.1)
    expect(env?.populationRpsFactor).toBe(0.2)
  })

  it('deletes an environment', () => {
    useWorldStore.getState().addEnvironment('Staging')
    const id = Object.keys(useWorldStore.getState().doc.environments ?? {})[0]
    render(<TopologyPanel />)
    fireEvent.click(screen.getByTestId(`env-delete-${id}`))
    expect(useWorldStore.getState().doc.environments?.[id]).toBeUndefined()
  })

  it('activates an environment via the active-environment select', () => {
    useWorldStore.getState().addEnvironment('Staging')
    const id = Object.keys(useWorldStore.getState().doc.environments ?? {})[0]
    render(<TopologyPanel />)
    fireEvent.change(screen.getByLabelText('active-environment-select'), { target: { value: id } })
    expect(useWorldStore.getState().doc.activeEnvironmentId).toBe(id)
  })

  it('sets the cloud profile via the cloud-profile select', () => {
    render(<TopologyPanel />)
    fireEvent.change(screen.getByLabelText('cloud-profile-select'), { target: { value: 'aws' } })
    expect(useWorldStore.getState().doc.cloudProfile).toBe('aws')
  })
})
