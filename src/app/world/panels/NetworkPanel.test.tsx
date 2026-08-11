// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NetworkPanel } from './NetworkPanel'
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import { compileWorld } from '../../../lib/world/compileWorld'
import { getPreset } from '../../../lib/world/instanceCatalog'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useNavStore.setState({ level: 'globe', regionId: null, azId: null, serverId: null })
})

// Mirrors ManagedPanel.test.tsx's seedRegionAz helper — a baseline doc with one region (and,
// where noted, one AZ in it) for network entities to hang off.
function seedRegionAz() {
  const s = useWorldStore.getState()
  const regionId = s.addRegion('us-east-1')
  const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
  return { regionId, azId }
}

describe('NetworkPanel', () => {
  it('renders an empty state with an "add VPC" affordance when doc.vpcs is empty', () => {
    render(<NetworkPanel />)
    expect(screen.getByText(/no vpcs/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add vpc/i })).toBeInTheDocument()
  })

  it('clicking add VPC creates a VPC and shows it in the list', () => {
    seedRegionAz()
    render(<NetworkPanel />)
    fireEvent.click(screen.getByRole('button', { name: /add vpc/i }))
    expect(useWorldStore.getState().doc.vpcs).not.toEqual({})
  })

  it('selecting a VPC shows its subnets and an add-subnet control', () => {
    const { regionId } = seedRegionAz()
    const vpcId = useWorldStore.getState().addVpc(regionId)
    render(<NetworkPanel />)
    fireEvent.click(screen.getByTestId(`vpc-label-${vpcId}`))
    expect(screen.getByText(/no subnets yet/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add subnet/i })).toBeInTheDocument()
  })

  it('adding a subnet with an AZ selected calls addSubnet and lists it with a public/private badge and route summary', () => {
    const { regionId, azId } = seedRegionAz()
    const vpcId = useWorldStore.getState().addVpc(regionId)
    render(<NetworkPanel />)
    fireEvent.click(screen.getByTestId(`vpc-label-${vpcId}`))
    fireEvent.change(screen.getByLabelText('az'), { target: { value: azId } })
    fireEvent.change(screen.getByLabelText('subnet kind'), { target: { value: 'public' } })
    fireEvent.click(screen.getByRole('button', { name: /add subnet/i }))

    const subnets = Object.values(useWorldStore.getState().doc.subnets)
    expect(subnets).toHaveLength(1)
    expect(subnets[0]).toMatchObject({ vpcId, azId, kind: 'public' })
    const subnetCard = screen.getByTestId(`subnet-${subnets[0].id}`)
    expect(subnetCard.textContent).toContain('public')
    expect(subnetCard.textContent).toMatch(/0 routes/i)
  })

  it('a public subnet gets an "add NAT gateway" control that dispatches addNatGateway', () => {
    const { regionId, azId } = seedRegionAz()
    const vpcId = useWorldStore.getState().addVpc(regionId)
    const subnetId = useWorldStore.getState().addSubnet(vpcId, azId, 'public')
    render(<NetworkPanel />)
    fireEvent.click(screen.getByTestId(`vpc-label-${vpcId}`))
    fireEvent.click(screen.getByRole('button', { name: /add nat gateway/i }))

    const nats = Object.values(useWorldStore.getState().doc.natGateways)
    expect(nats).toHaveLength(1)
    expect(nats[0].subnetId).toBe(subnetId)
  })

  it('a private subnet does not offer an "add NAT gateway" control', () => {
    const { regionId, azId } = seedRegionAz()
    const vpcId = useWorldStore.getState().addVpc(regionId)
    useWorldStore.getState().addSubnet(vpcId, azId, 'private')
    render(<NetworkPanel />)
    fireEvent.click(screen.getByTestId(`vpc-label-${vpcId}`))
    expect(screen.queryByRole('button', { name: /add nat gateway/i })).toBeNull()
  })

  it('"add internet gateway" dispatches addInternetGateway for the selected VPC', () => {
    const { regionId } = seedRegionAz()
    const vpcId = useWorldStore.getState().addVpc(regionId)
    render(<NetworkPanel />)
    fireEvent.click(screen.getByTestId(`vpc-label-${vpcId}`))
    fireEvent.click(screen.getByRole('button', { name: /add internet gateway/i }))

    const igws = Object.values(useWorldStore.getState().doc.internetGateways)
    expect(igws).toHaveLength(1)
    expect(igws[0].vpcId).toBe(vpcId)
  })

  it('removing a VPC removes it from the list', () => {
    const { regionId } = seedRegionAz()
    const vpcId = useWorldStore.getState().addVpc(regionId)
    render(<NetworkPanel />)
    fireEvent.click(screen.getByLabelText(`remove-vpc-${vpcId}`))
    expect(useWorldStore.getState().doc.vpcs).toEqual({})
    expect(screen.getByText(/no vpcs/i)).toBeInTheDocument()
  })

  // Final review Critical #1: there was previously no UI path to add a route-table entry, so
  // every subnet's route table started (and stayed) empty forever — any cross-region dependency
  // from a server in that subnet compiled to blocked/no-egress-route with no in-app remedy. This
  // proves the new "+ add route" control actually resolves that block.
  it('adding a route via the UI resolves a previously-blocked cross-region dependency path', () => {
    const s = useWorldStore.getState()
    const regionA = s.addRegion('us-east-1')
    const regionB = useWorldStore.getState().addRegion('eu-west-1')
    const azA = useWorldStore.getState().addAz(regionA, 'us-east-1a')
    const azB = useWorldStore.getState().addAz(regionB, 'eu-west-1a')
    const serverA = useWorldStore.getState().addServer(azA, getPreset('vps-medium')!)
    const serverB = useWorldStore.getState().addServer(azB, getPreset('vps-medium')!)
    const apiId = useWorldStore.getState().addBlueprint('api')
    const targetId = useWorldStore.getState().addBlueprint('target')
    useWorldStore.getState().addPlacement(apiId, serverA)
    useWorldStore.getState().addPlacement(targetId, serverB)
    useWorldStore.getState().connectServices(apiId, { kind: 'blueprint', blueprintId: targetId }, { port: 8080, protocol: 'http', autoProvision: true })

    const vpcId = useWorldStore.getState().addVpc(regionA)
    const subnetId = useWorldStore.getState().addSubnet(vpcId, azA, 'private')
    useWorldStore.getState().updateServer(serverA, { subnetId })

    // Before: the cross-region path is blocked with no egress route out of the subnet.
    const before = compileWorld(useWorldStore.getState().doc)
    expect(before.paths.some(p => p.blockReason?.kind === 'no-egress-route')).toBe(true)

    render(<NetworkPanel />)
    fireEvent.click(screen.getByTestId(`vpc-label-${vpcId}`))
    fireEvent.click(screen.getByRole('button', { name: /add internet gateway/i }))
    const igwId = Object.keys(useWorldStore.getState().doc.internetGateways)[0]
    expect(igwId).toBeTruthy()

    fireEvent.change(screen.getByLabelText(`add route target for ${subnetId}`), {
      target: { value: `internetGateway:${igwId}` },
    })
    fireEvent.click(screen.getByRole('button', { name: /add route/i }))

    const rt = useWorldStore.getState().doc.routeTables[
      useWorldStore.getState().doc.subnets[subnetId].routeTableId
    ]
    expect(rt.routes).toHaveLength(1)
    expect(rt.routes[0]).toMatchObject({ destinationCidr: '0.0.0.0/0', target: { kind: 'internetGateway', id: igwId } })

    // After: the same cross-region path is no longer blocked on egress.
    const after = compileWorld(useWorldStore.getState().doc)
    expect(after.paths.some(p => p.blockReason?.kind === 'no-egress-route')).toBe(false)
  })

  // Final review Critical #1: SecurityGroup.rules had no authoring UI either — every group
  // started empty, so attaching one denied everything with no in-app remedy.
  it('adding a security-group rule via the UI is reflected in doc.securityGroups[id].rules', () => {
    const { regionId } = seedRegionAz()
    const vpcId = useWorldStore.getState().addVpc(regionId)
    const sgId = useWorldStore.getState().addSecurityGroup(vpcId)
    render(<NetworkPanel />)
    fireEvent.click(screen.getByTestId(`vpc-label-${vpcId}`))

    const sg = useWorldStore.getState().doc.securityGroups[sgId]
    fireEvent.change(screen.getByLabelText(`port for new rule on ${sg.label}`), { target: { value: '5432' } })
    fireEvent.change(screen.getByLabelText(`protocol for new rule on ${sg.label}`), { target: { value: 'tcp' } })
    fireEvent.click(screen.getByRole('button', { name: /add rule/i }))

    const rules = useWorldStore.getState().doc.securityGroups[sgId].rules
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({ port: 5432, protocol: 'tcp', source: 'any' })
  })

  it('removing a security-group rule via the UI removes it from doc.securityGroups[id].rules', () => {
    const { regionId } = seedRegionAz()
    const vpcId = useWorldStore.getState().addVpc(regionId)
    const sgId = useWorldStore.getState().addSecurityGroup(vpcId)
    useWorldStore.getState().updateSecurityGroup(sgId, { rules: [{ port: 5432, protocol: 'tcp', source: 'any' }] })
    render(<NetworkPanel />)
    fireEvent.click(screen.getByTestId(`vpc-label-${vpcId}`))
    fireEvent.click(screen.getByLabelText(`remove-sg-rule-${sgId}-0`))
    expect(useWorldStore.getState().doc.securityGroups[sgId].rules).toEqual([])
  })
})
