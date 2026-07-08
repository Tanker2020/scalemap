// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TopologyPanel } from './TopologyPanel'
import { useWorldStore } from '../../store/world.store'

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
