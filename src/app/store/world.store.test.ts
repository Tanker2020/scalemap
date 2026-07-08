import { describe, it, expect, beforeEach } from 'vitest'
import { useWorldStore } from './world.store'
import { useFileStore } from './file.store'
import { getPreset } from '../../lib/world/instanceCatalog'

beforeEach(() => useWorldStore.getState().newWorld())

function buildChain() {
  const s = useWorldStore.getState()
  const regionId = s.addRegion('us-east-1')
  const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
  const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
  const bpId = useWorldStore.getState().addBlueprint('api')
  const plId = useWorldStore.getState().addPlacement(bpId, serverId)
  return { regionId, azId, serverId, bpId, plId }
}

describe('world.store', () => {
  it('newWorld resets the dirty flag and created timestamp', () => {
    useFileStore.getState().setDirty(true)
    useFileStore.getState().setCreatedIso('2020-01-01T00:00:00.000Z')
    useWorldStore.getState().newWorld()
    expect(useFileStore.getState().dirty).toBe(false)
    expect(useFileStore.getState().createdIso).toBeNull()
  })

  it('builds a linked region→az→server→blueprint→placement chain', () => {
    const { regionId, azId, serverId, bpId, plId } = buildChain()
    const doc = useWorldStore.getState().doc
    expect(doc.azs[azId].regionId).toBe(regionId)
    expect(doc.servers[serverId].azId).toBe(azId)
    expect(doc.placements[plId]).toMatchObject({ blueprintId: bpId, serverId })
  })

  it('removeRegion cascades through azs, servers, placements, managed services', () => {
    const { regionId, azId } = buildChain()
    useWorldStore.getState().addManagedService('rds', 'RDS', { kind: 'az', azId }, 5432)
    useWorldStore.getState().removeRegion(regionId)
    const doc = useWorldStore.getState().doc
    expect(Object.keys(doc.regions)).toHaveLength(0)
    expect(Object.keys(doc.azs)).toHaveLength(0)
    expect(Object.keys(doc.servers)).toHaveLength(0)
    expect(Object.keys(doc.placements)).toHaveLength(0)
    expect(Object.keys(doc.managedServices)).toHaveLength(0)
  })

  it('removeBlueprint drops its placements and strips dependencies pointing at it', () => {
    const { serverId, bpId } = buildChain()
    const webId = useWorldStore.getState().addBlueprint('web')
    useWorldStore.getState().updateBlueprint(webId, {
      dependencies: [{ id: 'd1', target: { kind: 'blueprint', blueprintId: bpId }, port: 8080, protocol: 'http', packetTemplateId: null }],
    })
    useWorldStore.getState().addPlacement(webId, serverId)
    useWorldStore.getState().removeBlueprint(bpId)
    const doc = useWorldStore.getState().doc
    expect(doc.blueprints[bpId]).toBeUndefined()
    expect(Object.values(doc.placements).every(p => p.blueprintId !== bpId)).toBe(true)
    expect(doc.blueprints[webId].dependencies).toHaveLength(0)
  })

  it('undo/redo restore document snapshots', () => {
    const { regionId } = buildChain()
    const before = Object.keys(useWorldStore.getState().doc.servers).length
    expect(before).toBe(1)
    useWorldStore.getState().removeRegion(regionId)
    expect(Object.keys(useWorldStore.getState().doc.servers)).toHaveLength(0)
    useWorldStore.getState().undo()
    expect(Object.keys(useWorldStore.getState().doc.servers)).toHaveLength(1)
    useWorldStore.getState().redo()
    expect(Object.keys(useWorldStore.getState().doc.servers)).toHaveLength(0)
  })

  it('every mutation replaces doc immutably (reference changes)', () => {
    const s = useWorldStore.getState()
    const before = s.doc
    s.addRegion('eu-west-1')
    expect(useWorldStore.getState().doc).not.toBe(before)
  })

  it('removeRegion drops the region from routing weights and priorityOrder', () => {
    const { regionId } = buildChain()
    const r2 = useWorldStore.getState().addRegion('eu-west-1')
    useWorldStore.getState().updateRouting({ weights: { [regionId]: 10, [r2]: 5 }, priorityOrder: [regionId, r2] })
    useWorldStore.getState().removeRegion(regionId)
    const doc = useWorldStore.getState().doc
    expect(doc.routing.weights).toEqual({ [r2]: 5 })
    expect(doc.routing.priorityOrder).toEqual([r2])
  })

  it('removeAz cascades its servers, placements, and az-scoped managed services', () => {
    const { regionId, azId } = buildChain()
    useWorldStore.getState().addManagedService('rds', 'RDS', { kind: 'az', azId }, 5432)
    useWorldStore.getState().removeAz(azId)
    const doc = useWorldStore.getState().doc
    expect(Object.keys(doc.azs)).toHaveLength(0)
    expect(Object.keys(doc.servers)).toHaveLength(0)
    expect(Object.keys(doc.placements)).toHaveLength(0)
    expect(Object.keys(doc.managedServices)).toHaveLength(0)
    expect(doc.regions[regionId]).toBeDefined()
  })

  it('removeServer cascades only its placements', () => {
    const { serverId, bpId } = buildChain()
    useWorldStore.getState().removeServer(serverId)
    const doc = useWorldStore.getState().doc
    expect(Object.keys(doc.servers)).toHaveLength(0)
    expect(Object.keys(doc.placements)).toHaveLength(0)
    expect(doc.blueprints[bpId]).toBeDefined()
  })

  it('removeManagedService strips dependencies targeting it', () => {
    const { azId, bpId } = buildChain()
    const msId = useWorldStore.getState().addManagedService('s3', 'S3', { kind: 'az', azId }, 443)
    useWorldStore.getState().updateBlueprint(bpId, {
      dependencies: [{ id: 'd1', target: { kind: 'managed', managedServiceId: msId }, port: 443, protocol: 'http', packetTemplateId: null }],
    })
    useWorldStore.getState().removeManagedService(msId)
    const doc = useWorldStore.getState().doc
    expect(doc.managedServices[msId]).toBeUndefined()
    expect(doc.blueprints[bpId].dependencies).toHaveLength(0)
  })
})
