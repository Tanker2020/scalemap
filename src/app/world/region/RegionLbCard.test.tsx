// @vitest-environment jsdom
// Phase 3 region LB visualization: the compact flow-page card reflects the COMPILED lb routing —
// the synthesized L4 default when nothing is authored, and the L7 listener rules when it is.
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RegionLbCard } from './RegionLbCard'
import { useWorldStore } from '../../store/world.store'
import { getPreset } from '../../../lib/world/instanceCatalog'

beforeEach(() => useWorldStore.getState().newWorld())

function seedEntryRegion() {
  const s = useWorldStore.getState()
  const regionId = s.addRegion('us-east-1')
  const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
  const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
  const webId = useWorldStore.getState().addBlueprint('web')
  useWorldStore.getState().updateBlueprint(webId, { ports: [{ port: 443, protocol: 'tcp', visibility: 'public' }] })
  useWorldStore.getState().addPlacement(webId, serverId)
  return { regionId, azId, serverId, webId }
}

describe('RegionLbCard', () => {
  it('shows the synthesized NLB · L4 default (cross-zone off) with the entry service as default target', () => {
    const { regionId } = seedEntryRegion()
    render(<RegionLbCard regionId={regionId} />)
    const card = screen.getByTestId('region-lb-card')
    expect(card).toHaveTextContent('NLB · L4')
    expect(card).toHaveTextContent('cross-zone off')
    expect(card).toHaveTextContent('all traffic → web')
    expect(screen.queryByTestId('lb-rule')).toBeNull()
  })

  it('shows the L7 listener rules → services and cross-zone on for an authored ALB', () => {
    const { regionId, azId, serverId, webId } = seedEntryRegion()
    void azId
    const apiId = useWorldStore.getState().addBlueprint('api')
    useWorldStore.getState().updateBlueprint(apiId, { ports: [{ port: 443, protocol: 'tcp', visibility: 'public' }] })
    useWorldStore.getState().addPlacement(apiId, serverId)
    const lbId = useWorldStore.getState().addLoadBalancer(regionId)
    useWorldStore.getState().updateLoadBalancer(lbId, {
      mode: 'l7',
      crossZone: true,
      listenerRules: [
        { id: 'r1', pathPattern: '/api/*', targetBlueprintId: apiId },
        { id: 'r2', pathPattern: '/*', targetBlueprintId: webId },
      ],
      defaultTargetBlueprintId: webId,
    })
    render(<RegionLbCard regionId={regionId} />)
    const card = screen.getByTestId('region-lb-card')
    expect(card).toHaveTextContent('ALB · L7')
    expect(card).toHaveTextContent('cross-zone on')
    const rules = screen.getAllByTestId('lb-rule')
    expect(rules).toHaveLength(2)
    expect(rules[0]).toHaveTextContent('/api/*')
    expect(rules[0]).toHaveTextContent('api')
    expect(rules[1]).toHaveTextContent('/*')
    expect(card).toHaveTextContent('default →')
  })
})
