// @vitest-environment jsdom
// Task 13 (network-topology): SecurityGroupPicker — replaces FirewallDrawer for a networked
// server (server.subnetId set), scoping the group list to the server's subnet's VPC.
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SecurityGroupPicker } from './SecurityGroupPicker'
import { useWorldStore } from '../../../store/world.store'
import { getPreset } from '../../../../lib/world/instanceCatalog'
import type { Server } from '../../../../lib/world/types'

beforeEach(() => { useWorldStore.getState().newWorld() })

function currentServer(id: string): Server { return useWorldStore.getState().doc.servers[id] }

// Seeds two VPCs (A and B), each with one subnet + one security group, and a server placed on
// VPC A's subnet — used to assert VPC scoping.
function seedTwoVpcs() {
  const s = useWorldStore.getState()
  const regionId = s.addRegion('us-east-1')
  const azId = s.addAz(regionId, 'us-east-1a')
  const serverId = s.addServer(azId, getPreset('vps-medium')!)

  const vpcAId = s.addVpc(regionId)
  const vpcBId = s.addVpc(regionId)
  const subnetAId = s.addSubnet(vpcAId, azId, 'private')
  s.addSubnet(vpcBId, azId, 'private')
  const sgAId = s.addSecurityGroup(vpcAId)
  const sgBId = s.addSecurityGroup(vpcBId)
  s.updateSecurityGroup(sgAId, { label: 'sg-a' })
  s.updateSecurityGroup(sgBId, { label: 'sg-b' })

  s.updateServer(serverId, { subnetId: subnetAId })

  return { serverId, sgAId, sgBId, subnetAId }
}

describe('SecurityGroupPicker', () => {
  it("lists security groups belonging to the server's subnet's VPC only", () => {
    const { serverId } = seedTwoVpcs()
    render(<SecurityGroupPicker server={currentServer(serverId)} />)

    expect(screen.getByText('sg-a')).toBeTruthy()
    expect(screen.queryByText('sg-b')).toBeNull()
  })

  it('toggling a group patches server.securityGroupIds', () => {
    const { serverId, sgAId } = seedTwoVpcs()
    render(<SecurityGroupPicker server={currentServer(serverId)} />)

    const row = screen.getByTestId(`sg-picker-row-${sgAId}`)
    const checkbox = row.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(checkbox.checked).toBe(false)

    fireEvent.click(checkbox)

    expect(currentServer(serverId).securityGroupIds).toContain(sgAId)
  })

  it('toggling an already-selected group removes it from securityGroupIds', () => {
    const { serverId, sgAId } = seedTwoVpcs()
    useWorldStore.getState().updateServer(serverId, { securityGroupIds: [sgAId] })
    render(<SecurityGroupPicker server={currentServer(serverId)} />)

    const row = screen.getByTestId(`sg-picker-row-${sgAId}`)
    const checkbox = row.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(checkbox.checked).toBe(true)

    fireEvent.click(checkbox)

    expect(currentServer(serverId).securityGroupIds).not.toContain(sgAId)
  })

  it('returns null (renders nothing) when server has no subnetId', () => {
    const s = useWorldStore.getState()
    const regionId = s.addRegion('us-east-1')
    const azId = s.addAz(regionId, 'us-east-1a')
    const serverId = s.addServer(azId, getPreset('vps-medium')!)

    const { container } = render(<SecurityGroupPicker server={currentServer(serverId)} />)
    expect(container.firstChild).toBeNull()
  })
})
