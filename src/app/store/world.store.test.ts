import { describe, it, expect, beforeEach } from 'vitest'
import { useWorldStore } from './world.store'
import { useFileStore } from './file.store'
import { useSimulationStore } from './simulation.store'
import { getPreset } from '../../lib/world/instanceCatalog'
import { rackUsedU, RACK_CAPACITY_MIN, RACK_CAPACITY_MAX } from '../../lib/world/rackModel'

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

describe('world.store — db appliance nodes', () => {
  function seedAz() {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    return useWorldStore.getState().addAz(regionId, 'us-east-1a')
  }

  it('addDbServer inserts the box, its owned blueprint, and the binding placement', () => {
    const azId = seedAz()
    const { serverId, blueprintId, placementId } =
      useWorldStore.getState().addDbServer(azId, getPreset('db-sql-medium')!, 'orders-db')

    const doc = useWorldStore.getState().doc
    expect(doc.servers[serverId].kind).toBe('db-sql')
    expect(doc.blueprints[blueprintId].ownerServerKind).toBe('db-sql')
    expect(doc.placements[placementId]).toMatchObject({ blueprintId, serverId, role: 'primary' })
  })

  // The whole appliance is ONE mutate() — otherwise undo would peel it apart into a server with
  // a dangling blueprint, which compileWorld would surface as a bogus finding mid-undo.
  it('undoes the entire appliance in a single step', () => {
    const azId = seedAz()
    useWorldStore.getState().addDbServer(azId, getPreset('db-sql-medium')!, 'orders-db')

    useWorldStore.getState().undo()

    const doc = useWorldStore.getState().doc
    expect(Object.keys(doc.servers)).toHaveLength(0)
    expect(Object.keys(doc.blueprints)).toHaveLength(0)
    expect(Object.keys(doc.placements)).toHaveLength(0)
  })

  it('marks the file dirty', () => {
    const azId = seedAz()
    useFileStore.getState().setDirty(false)
    useWorldStore.getState().addDbServer(azId, getPreset('db-nosql-medium')!, 'events-db')
    expect(useFileStore.getState().dirty).toBe(true)
  })
})

describe('world.store — spread', () => {
  function seedTwoAzWorld() {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azA = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    const azB = useWorldStore.getState().addAz(regionId, 'us-east-1b')
    const serverId = useWorldStore.getState().addServer(azA, getPreset('vps-medium')!)
    const bpId = useWorldStore.getState().addBlueprint('api')
    useWorldStore.getState().addPlacement(bpId, serverId)
    return { azA, azB, serverId, bpId }
  }

  it('places onto an existing host in the target AZ', () => {
    const { azB, bpId } = seedTwoAzWorld()
    const target = useWorldStore.getState().addServer(azB, getPreset('vps-medium')!)

    useWorldStore.getState().spreadBlueprint(bpId, [azB])

    const placed = Object.values(useWorldStore.getState().doc.placements)
      .filter(p => p.blueprintId === bpId).map(p => p.serverId)
    expect(placed).toContain(target)
  })

  it('creates a host in a target AZ that has none, then places onto it', () => {
    const { azB, bpId } = seedTwoAzWorld()

    useWorldStore.getState().spreadBlueprint(bpId, [azB])

    const doc = useWorldStore.getState().doc
    const inB = Object.values(doc.servers).filter(s => s.azId === azB)
    expect(inB).toHaveLength(1)
    expect(Object.values(doc.placements).some(p => p.blueprintId === bpId && p.serverId === inB[0].id)).toBe(true)
  })

  // A spread that half-applies — a new server with no placement on it — is not a state undo
  // should reach, so the whole spread is ONE mutate().
  it('undoes an entire multi-AZ spread in a single step', () => {
    const { azA, azB, bpId } = seedTwoAzWorld()
    const regionId = useWorldStore.getState().doc.azs[azA].regionId
    const azC = useWorldStore.getState().addAz(regionId, 'us-east-1c')
    const serversBefore = Object.keys(useWorldStore.getState().doc.servers).length
    const placementsBefore = Object.keys(useWorldStore.getState().doc.placements).length

    useWorldStore.getState().spreadBlueprint(bpId, [azB, azC])
    useWorldStore.getState().undo()

    const doc = useWorldStore.getState().doc
    expect(Object.keys(doc.servers)).toHaveLength(serversBefore)
    expect(Object.keys(doc.placements)).toHaveLength(placementsBefore)
  })

  it('is idempotent — spreading into an AZ that already hosts it adds nothing', () => {
    const { azB, bpId } = seedTwoAzWorld()
    useWorldStore.getState().spreadBlueprint(bpId, [azB])
    const after = Object.keys(useWorldStore.getState().doc.placements).length

    useWorldStore.getState().spreadBlueprint(bpId, [azB])

    expect(Object.keys(useWorldStore.getState().doc.placements)).toHaveLength(after)
  })

  it('marks the file dirty', () => {
    const { azB, bpId } = seedTwoAzWorld()
    useFileStore.getState().setDirty(false)
    useWorldStore.getState().spreadBlueprint(bpId, [azB])
    expect(useFileStore.getState().dirty).toBe(true)
  })

  // Names are read constantly in the server list, the floor and the breadcrumb. Derived from the
  // AZ LABEL suffix, never the AZ id — ids look like 'az-3-mf8k36su', so slicing one produced
  // names like 'web-36su'.
  it('names a spread-created host after the service and the AZ label', () => {
    const { azA, azB, bpId } = seedTwoAzWorld()
    useWorldStore.getState().spreadBlueprint(bpId, [azB])

    const doc = useWorldStore.getState().doc
    const created = Object.values(doc.servers).find(s => s.azId === azB)!

    expect(created.label).toBe('api-1b')
    expect(created.label).not.toMatch(/[0-9a-z]{6,}/)   // no raw id fragment
    expect(azA).toBeTruthy()
  })

  // Nothing to do must not burn an undo slot on a no-op.
  it('does not push history when the spread is a no-op', () => {
    const { azB, bpId } = seedTwoAzWorld()
    useWorldStore.getState().spreadBlueprint(bpId, [azB])
    const doc = useWorldStore.getState().doc

    useWorldStore.getState().spreadBlueprint(bpId, [azB])
    useWorldStore.getState().undo()

    // One undo steps back past the REAL spread, not past a recorded no-op.
    expect(Object.keys(useWorldStore.getState().doc.servers).length)
      .toBeLessThan(Object.keys(doc.servers).length)
  })
})

describe('world.store — load balancers', () => {
  it('addLoadBalancer creates a region-scoped L4 LB and marks the file dirty', () => {
    const { regionId } = buildChain()
    useFileStore.getState().setDirty(false)
    const lbId = useWorldStore.getState().addLoadBalancer(regionId)
    const lb = useWorldStore.getState().doc.loadBalancers[lbId]
    expect(lb).toMatchObject({ regionId, mode: 'l4', crossZone: false })
    expect(useFileStore.getState().dirty).toBe(true)
  })

  it('updateLoadBalancer patches config through mutate (undoable)', () => {
    const { regionId } = buildChain()
    const lbId = useWorldStore.getState().addLoadBalancer(regionId)
    useWorldStore.getState().updateLoadBalancer(lbId, { crossZone: true, mode: 'l7' })
    const lb = useWorldStore.getState().doc.loadBalancers[lbId]
    expect(lb.crossZone).toBe(true)
    expect(lb.mode).toBe('l7')
    useWorldStore.getState().undo()
    expect(useWorldStore.getState().doc.loadBalancers[lbId].crossZone).toBe(false)
  })

  it('removeRegion cascades to its load balancers', () => {
    const { regionId } = buildChain()
    const lbId = useWorldStore.getState().addLoadBalancer(regionId)
    useWorldStore.getState().removeRegion(regionId)
    expect(useWorldStore.getState().doc.loadBalancers[lbId]).toBeUndefined()
  })

  it('removeBlueprint scrubs LB listener rules and default action referencing it', () => {
    const { regionId, bpId } = buildChain()
    const lbId = useWorldStore.getState().addLoadBalancer(regionId)
    useWorldStore.getState().updateLoadBalancer(lbId, {
      mode: 'l7',
      listenerRules: [{ id: 'r1', pathPattern: '/api/*', targetBlueprintId: bpId }],
      defaultTargetBlueprintId: bpId,
    })
    useWorldStore.getState().removeBlueprint(bpId)
    const lb = useWorldStore.getState().doc.loadBalancers[lbId]
    expect(lb.listenerRules).toEqual([])
    expect(lb.defaultTargetBlueprintId).toBeNull()
  })
})

describe('world.store — route catalog', () => {
  it('addRoute stores an http template in doc.packets, returns its id, marks dirty', () => {
    useFileStore.getState().setDirty(false)
    const routeId = useWorldStore.getState().addRoute({ name: 'api', method: 'GET', path: '/api/*' })
    const reg = useWorldStore.getState().doc.packets
    expect(reg.templates[Number(routeId)]).toMatchObject({ protocol: 'http', path: '/api/*', method: 'GET' })
    expect(useFileStore.getState().dirty).toBe(true)
  })

  it('updateRoute patches a route and is undoable', () => {
    const routeId = useWorldStore.getState().addRoute({ name: 'api', method: 'GET', path: '/api/*' })
    useWorldStore.getState().updateRoute(routeId, { path: '/v2/*', method: 'POST' })
    expect(useWorldStore.getState().doc.packets.templates[Number(routeId)]).toMatchObject({ path: '/v2/*', method: 'POST' })
    useWorldStore.getState().undo()
    expect(useWorldStore.getState().doc.packets.templates[Number(routeId)]).toMatchObject({ path: '/api/*', method: 'GET' })
  })

  it('removeRoute deletes the template and scrubs it from every population requestMix', () => {
    const { azId } = buildChain()
    void azId
    const keepId = useWorldStore.getState().addRoute({ name: 'keep', method: 'GET', path: '/keep' })
    const dropId = useWorldStore.getState().addRoute({ name: 'drop', method: 'GET', path: '/drop' })
    const popId = useWorldStore.getState().addPopulation('nyc', 40, -74)
    useWorldStore.getState().updatePopulation(popId, {
      requestMix: [{ routeId: keepId, weight: 1 }, { routeId: dropId, weight: 2 }],
    })
    useWorldStore.getState().removeRoute(dropId)
    expect(useWorldStore.getState().doc.packets.templates[Number(dropId)]).toBeUndefined()
    expect(useWorldStore.getState().doc.populations[popId].requestMix).toEqual([{ routeId: keepId, weight: 1 }])
  })
})

describe('world.store — service connections', () => {
  // api + db each placed on their own server; db's server firewall tightened to default-deny.
  function apiDb() {
    const s = useWorldStore.getState()
    const regionId = s.addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    const apiSrv = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    const dbSrv = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    const apiId = useWorldStore.getState().addBlueprint('api')
    const dbId = useWorldStore.getState().addBlueprint('db')
    useWorldStore.getState().addPlacement(apiId, apiSrv)
    useWorldStore.getState().addPlacement(dbId, dbSrv)
    useWorldStore.getState().updateServer(dbSrv, { firewall: [] })
    return { apiId, dbId, dbSrv }
  }

  it('connectServices with autoProvision adds the dep, binds the port, and opens the firewall in one undo step', () => {
    const { apiId, dbId, dbSrv } = apiDb()
    const depId = useWorldStore.getState().connectServices(apiId, { kind: 'blueprint', blueprintId: dbId }, { port: 5432, protocol: 'db', autoProvision: true })
    let doc = useWorldStore.getState().doc
    expect(doc.blueprints[apiId].dependencies.find(d => d.id === depId)).toMatchObject({ port: 5432, protocol: 'db' })
    expect(doc.blueprints[dbId].ports.some(p => p.port === 5432)).toBe(true)
    expect(doc.servers[dbSrv].firewall.some(r => r.action === 'allow' && r.port === 5432)).toBe(true)
    // Single undo reverts intent + reachability together.
    useWorldStore.getState().undo()
    doc = useWorldStore.getState().doc
    expect(doc.blueprints[apiId].dependencies).toHaveLength(0)
    expect(doc.blueprints[dbId].ports.some(p => p.port === 5432)).toBe(false)
    expect(doc.servers[dbSrv].firewall).toEqual([])
  })

  it('connectServices without autoProvision records intent only (leaves firewall/ports untouched)', () => {
    const { apiId, dbId, dbSrv } = apiDb()
    useWorldStore.getState().connectServices(apiId, { kind: 'blueprint', blueprintId: dbId }, { port: 5432, protocol: 'db', autoProvision: false })
    const doc = useWorldStore.getState().doc
    expect(doc.blueprints[dbId].ports.some(p => p.port === 5432)).toBe(false)
    expect(doc.servers[dbSrv].firewall).toEqual([])
  })

  it('fixReachability provisions a previously blocked edge', () => {
    const { apiId, dbId, dbSrv } = apiDb()
    const depId = useWorldStore.getState().connectServices(apiId, { kind: 'blueprint', blueprintId: dbId }, { port: 5432, protocol: 'db', autoProvision: false })
    useWorldStore.getState().fixReachability(apiId, depId)
    const doc = useWorldStore.getState().doc
    expect(doc.blueprints[dbId].ports.some(p => p.port === 5432)).toBe(true)
    expect(doc.servers[dbSrv].firewall.some(r => r.action === 'allow' && r.port === 5432)).toBe(true)
  })

  it('disconnectServices removes the dependency but leaves provisioned reachability', () => {
    const { apiId, dbId, dbSrv } = apiDb()
    const depId = useWorldStore.getState().connectServices(apiId, { kind: 'blueprint', blueprintId: dbId }, { port: 5432, protocol: 'db', autoProvision: true })
    useWorldStore.getState().disconnectServices(apiId, depId)
    const doc = useWorldStore.getState().doc
    expect(doc.blueprints[apiId].dependencies).toHaveLength(0)
    expect(doc.servers[dbSrv].firewall.some(r => r.port === 5432)).toBe(true)  // left in place
  })

  it('setNodePosition stores one override (undoable) and clearConnectionLayout resets all', () => {
    const { apiId, dbId } = apiDb()
    useWorldStore.getState().setNodePosition(apiId, { x: 100, y: 40 })
    useWorldStore.getState().setNodePosition(dbId, { x: 300, y: 40 })
    expect(useWorldStore.getState().doc.connectionLayout).toEqual({ [apiId]: { x: 100, y: 40 }, [dbId]: { x: 300, y: 40 } })
    useWorldStore.getState().undo()   // one drag = one undo step
    expect(useWorldStore.getState().doc.connectionLayout).toEqual({ [apiId]: { x: 100, y: 40 } })
    useWorldStore.getState().clearConnectionLayout()
    expect(useWorldStore.getState().doc.connectionLayout).toEqual({})
  })

  it('setInternetFacing flips a port to public and opens allow-any; toggling off makes it internal', () => {
    const { apiId } = apiDb()
    // api's default port is 8080 (internal). Expose it.
    useWorldStore.getState().setInternetFacing(apiId, 8080, true)
    let doc = useWorldStore.getState().doc
    expect(doc.blueprints[apiId].ports.find(p => p.port === 8080)?.visibility).toBe('public')
    // Toggle back to private.
    useWorldStore.getState().setInternetFacing(apiId, 8080, false)
    doc = useWorldStore.getState().doc
    expect(doc.blueprints[apiId].ports.find(p => p.port === 8080)?.visibility).toBe('internal')
  })
})

describe('world.store', () => {
  it('newWorld resets the dirty flag and created timestamp', () => {
    useFileStore.getState().setDirty(true)
    useFileStore.getState().setCreatedIso('2020-01-01T00:00:00.000Z')
    useWorldStore.getState().newWorld()
    expect(useFileStore.getState().dirty).toBe(false)
    expect(useFileStore.getState().createdIso).toBeNull()
  })

  it('newWorld stops a running simulation (doc swap under a live engine edit-locks the app)', () => {
    useSimulationStore.setState({ running: true })
    useWorldStore.getState().newWorld()
    expect(useSimulationStore.getState().running).toBe(false)
  })

  it('replaceWorld stops a running simulation (open-while-running)', () => {
    useSimulationStore.setState({ running: true })
    useWorldStore.getState().replaceWorld(useWorldStore.getState().doc)
    expect(useSimulationStore.getState().running).toBe(false)
  })

  it('newWorld clears batch, events, scrub state, and health overrides', () => {
    useSimulationStore.setState({
      running: true, latestBatch: { simMs: 1 } as never, events: [{ id: 'e' } as never],
      scrubIndex: 3, scrubBatch: { simMs: 1 } as never, degraded: true, healthOverrides: { srv: true },
    })
    useWorldStore.getState().newWorld()
    const s = useSimulationStore.getState()
    expect(s.running).toBe(false)
    expect(s.latestBatch).toBeNull()
    expect(s.events).toEqual([])
    expect(s.scrubIndex).toBeNull()
    expect(s.scrubBatch).toBeNull()
    expect(s.degraded).toBe(false)
    expect(s.healthOverrides).toEqual({})
  })

  it('replaceWorld likewise clears the sim session', () => {
    useSimulationStore.setState({ latestBatch: { simMs: 1 } as never, scrubIndex: 2, healthOverrides: { x: true } })
    useWorldStore.getState().replaceWorld(useWorldStore.getState().doc)
    const s = useSimulationStore.getState()
    expect(s.latestBatch).toBeNull()
    expect(s.scrubIndex).toBeNull()
    expect(s.healthOverrides).toEqual({})
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

  it('undo marks the file store dirty even if dirty was cleared beforehand', () => {
    buildChain()
    useFileStore.getState().setDirty(false)
    useWorldStore.getState().undo()
    expect(useFileStore.getState().dirty).toBe(true)
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

  it('addManagedService stores the given provider', () => {
    const { azId } = buildChain()
    const msId = useWorldStore.getState().addManagedService('dbSql', 'SQL DB', { kind: 'az', azId }, 5432, 'aws')
    const doc = useWorldStore.getState().doc
    expect(doc.managedServices[msId].provider).toBe('aws')
  })

  describe('racks', () => {
    it('updateRack clamps capacity to 4-42 and never below used', () => {
      const { azId } = buildChain()
      useWorldStore.getState().addRack(azId)
      const rackId = Object.keys(useWorldStore.getState().doc.racks)[0]

      useWorldStore.getState().updateRack(rackId, { capacityU: 100 })
      expect(useWorldStore.getState().doc.racks[rackId].capacityU).toBe(RACK_CAPACITY_MAX)

      useWorldStore.getState().updateRack(rackId, { capacityU: 1 })
      expect(useWorldStore.getState().doc.racks[rackId].capacityU).toBe(RACK_CAPACITY_MIN)

      // Rack up capacity, occupy 6U (three 2U dedicated servers), then try to shrink below
      // that usedU — capacity must stay pinned at used, not fall to the bare MIN floor.
      useWorldStore.getState().updateRack(rackId, { capacityU: 8 })
      for (let i = 0; i < 3; i++) {
        const serverId = useWorldStore.getState().addServer(azId, getPreset('dedicated-8')!)
        useWorldStore.getState().assignServerToRack(serverId, rackId)
      }
      expect(rackUsedU(useWorldStore.getState().doc, rackId)).toBe(6)

      useWorldStore.getState().updateRack(rackId, { capacityU: 1 })
      expect(useWorldStore.getState().doc.racks[rackId].capacityU).toBe(6)
    })

    it('removeRack sends residents to the free pool in one undo step', () => {
      const { azId } = buildChain()
      useWorldStore.getState().addRack(azId)
      const rackId = Object.keys(useWorldStore.getState().doc.racks)[0]
      const serverId = useWorldStore.getState().addServer(azId, getPreset('dedicated-8')!)
      useWorldStore.getState().assignServerToRack(serverId, rackId)
      expect(useWorldStore.getState().doc.servers[serverId].rack).toEqual({ rackId, unit: 1, heightU: 2 })

      const historyBefore = useWorldStore.getState().history.length
      useWorldStore.getState().removeRack(rackId)
      expect(useWorldStore.getState().doc.racks[rackId]).toBeUndefined()
      expect(useWorldStore.getState().doc.servers[serverId].rack).toBeNull()
      expect(useWorldStore.getState().history.length).toBe(historyBefore + 1)   // one undo step

      useWorldStore.getState().undo()
      expect(useWorldStore.getState().doc.racks[rackId]).toBeDefined()
      expect(useWorldStore.getState().doc.servers[serverId].rack).toEqual({ rackId, unit: 1, heightU: 2 })
    })

    it('assignServerToRack refuses when the rack is full and clears back to the free pool with null', () => {
      const { azId } = buildChain()
      useWorldStore.getState().addRack(azId)
      const rackId = Object.keys(useWorldStore.getState().doc.racks)[0]
      useWorldStore.getState().updateRack(rackId, { capacityU: RACK_CAPACITY_MIN })   // 4U — clamp floor
      const s1 = useWorldStore.getState().addServer(azId, getPreset('dedicated-8')!)
      const s2 = useWorldStore.getState().addServer(azId, getPreset('dedicated-8')!)
      const s3 = useWorldStore.getState().addServer(azId, getPreset('dedicated-8')!)
      useWorldStore.getState().assignServerToRack(s1, rackId)
      useWorldStore.getState().assignServerToRack(s2, rackId)
      expect(useWorldStore.getState().doc.servers[s1].rack).toEqual({ rackId, unit: 1, heightU: 2 })
      expect(useWorldStore.getState().doc.servers[s2].rack).toEqual({ rackId, unit: 3, heightU: 2 })

      useWorldStore.getState().assignServerToRack(s3, rackId)   // rack is full (4U/4U) — refused
      expect(useWorldStore.getState().doc.servers[s3].rack).toBeNull()

      useWorldStore.getState().assignServerToRack(s1, null)
      expect(useWorldStore.getState().doc.servers[s1].rack).toBeNull()
    })

    it('undo restores both racks and server assignments after autoArrangeAz', () => {
      const { azId } = buildChain()   // buildChain's own server is already free-pool (rack: null)
      useWorldStore.getState().addServer(azId, getPreset('dedicated-8')!)
      useWorldStore.getState().addServer(azId, getPreset('dedicated-8')!)

      const historyBefore = useWorldStore.getState().history.length
      useWorldStore.getState().autoArrangeAz(azId)
      const doc = useWorldStore.getState().doc
      expect(Object.keys(doc.racks).length).toBeGreaterThan(0)
      expect(Object.values(doc.servers).filter(s => s.azId === azId).every(s => s.rack !== null)).toBe(true)
      expect(useWorldStore.getState().history.length).toBe(historyBefore + 1)   // one undo step

      useWorldStore.getState().undo()
      const undone = useWorldStore.getState().doc
      expect(Object.keys(undone.racks).length).toBe(0)
      expect(Object.values(undone.servers).filter(s => s.azId === azId).every(s => s.rack === null)).toBe(true)
    })
  })
})
