// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NetworkPanel } from './NetworkPanel'
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'

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
})
