import { describe, it, expect } from 'vitest'
import { createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement, nextWorldId } from './factories'
import { getPreset } from './instanceCatalog'
import { compileWorld } from './compileWorld'
import type { BlueprintDependency, WorldDoc } from './types'
import {
  planReachability, applyReachabilityPlan, edgesForView, connNodes, layoutNodes,
  isEntryBlueprint, INTERNET_NODE, connectionRows,
} from './connections'

// api (placed) depends on db (placed). db's server starts with a wide-open firewall unless a test
// tightens it. Returns the built pieces so tests can mutate before compiling.
function apiDbWorld() {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const az = createAz(region.id, 'us-east-1a')
  const apiSrv = createServer(az.id, getPreset('vps-medium')!)
  const dbSrv = createServer(az.id, getPreset('vps-medium')!)
  const api = createBlueprint('api', 0)
  const db = createBlueprint('db', 1)
  const apiPl = createPlacement(api.id, apiSrv.id)
  const dbPl = createPlacement(db.id, dbSrv.id)
  doc.regions[region.id] = region
  doc.azs[az.id] = az
  doc.servers[apiSrv.id] = apiSrv
  doc.servers[dbSrv.id] = dbSrv
  doc.blueprints[api.id] = api
  doc.blueprints[db.id] = db
  doc.placements[apiPl.id] = apiPl
  doc.placements[dbPl.id] = dbPl
  return { doc, api, db, apiSrv, dbSrv }
}

function addDep(doc: WorldDoc, fromBpId: string, target: BlueprintDependency['target'], port: number): string {
  const dep: BlueprintDependency = { id: nextWorldId('dep'), target, port, protocol: 'http', packetTemplateId: null }
  doc.blueprints[fromBpId].dependencies.push(dep)
  return dep.id
}

describe('planReachability', () => {
  it('adds the missing port + a firewall allow on a restrictive host, then is idempotent', () => {
    const { doc, db, dbSrv } = apiDbWorld()
    doc.servers[dbSrv.id].firewall = []  // default-deny host

    const plan = planReachability(doc, { kind: 'blueprint', blueprintId: db.id }, 5432)
    expect(plan.targetBlueprintId).toBe(db.id)
    expect(plan.portToAdd).toMatchObject({ port: 5432, visibility: 'internal' })
    expect(plan.firewallAdds).toHaveLength(1)
    expect(plan.firewallAdds[0]).toMatchObject({ serverId: dbSrv.id })
    expect(plan.firewallAdds[0].rule).toMatchObject({ action: 'allow', port: 5432, protocol: 'tcp' })

    const next = applyReachabilityPlan(doc, plan)
    // Re-planning against the patched doc yields nothing to do.
    const again = planReachability(next, { kind: 'blueprint', blueprintId: db.id }, 5432)
    expect(again.portToAdd).toBeNull()
    expect(again.firewallAdds).toHaveLength(0)
  })

  it('no firewall add when the host already allows the port (default open firewall)', () => {
    const { doc, db } = apiDbWorld()  // default createServer firewall = allow any/any
    const plan = planReachability(doc, { kind: 'blueprint', blueprintId: db.id }, 5432)
    expect(plan.portToAdd).not.toBeNull()      // still needs the port binding
    expect(plan.firewallAdds).toHaveLength(0)  // but reachability is already open
  })

  it('is a no-op for managed targets (always reachable)', () => {
    const { doc } = apiDbWorld()
    const plan = planReachability(doc, { kind: 'managed', managedServiceId: 'ms-x' }, 5432)
    expect(plan).toEqual({ targetBlueprintId: null, portToAdd: null, firewallAdds: [] })
  })

  it('applying the plan makes the compiled path permitted end to end', () => {
    const { doc, api, db, dbSrv } = apiDbWorld()
    doc.servers[dbSrv.id].firewall = []
    addDep(doc, api.id, { kind: 'blueprint', blueprintId: db.id }, 5432)

    const before = edgesForView(doc, compileWorld(doc)).find(e => e.toId === db.id)!
    expect(before.status).toBe('blocked')

    const patched = applyReachabilityPlan(doc, planReachability(doc, { kind: 'blueprint', blueprintId: db.id }, 5432))
    const after = edgesForView(patched, compileWorld(patched)).find(e => e.toId === db.id)!
    expect(after.status).toBe('permitted')
  })
})

describe('edgesForView', () => {
  it('emits one edge per authored dependency and marks it blocked when the path is blocked', () => {
    const { doc, api, db, dbSrv } = apiDbWorld()
    doc.servers[dbSrv.id].firewall = []  // db binds 8080 by default → firewall-deny, not port issue
    addDep(doc, api.id, { kind: 'blueprint', blueprintId: db.id }, 8080)
    const edge = edgesForView(doc, compileWorld(doc)).find(e => e.fromId === api.id && e.toId === db.id)!
    expect(edge.status).toBe('blocked')
    expect(edge.blockReason?.kind).toBe('firewall-deny')
  })

  it('shows an authored dependency as unplaced when nothing is placed yet', () => {
    const { doc, api, db } = apiDbWorld()
    doc.placements = {}  // remove placements → no instances → no compiled paths
    addDep(doc, api.id, { kind: 'blueprint', blueprintId: db.id }, 8080)
    const edge = edgesForView(doc, compileWorld(doc)).find(e => e.toId === db.id)!
    expect(edge.status).toBe('unplaced')
  })

  it('emits a synthetic Internet ingress edge iff a blueprint has a public port', () => {
    const { doc, api } = apiDbWorld()
    let edges = edgesForView(doc, compileWorld(doc))
    expect(edges.some(e => e.fromId === INTERNET_NODE)).toBe(false)

    doc.blueprints[api.id].ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
    edges = edgesForView(doc, compileWorld(doc))
    const ingress = edges.find(e => e.fromId === INTERNET_NODE)!
    expect(ingress).toMatchObject({ toId: api.id, port: 443, status: 'permitted' })
    expect(isEntryBlueprint(doc.blueprints[api.id])).toBe(true)
  })
})

describe('layoutNodes', () => {
  it('places Internet at col 0 and a callee to the right of its caller', () => {
    const { doc, api, db } = apiDbWorld()
    doc.blueprints[api.id].ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
    addDep(doc, api.id, { kind: 'blueprint', blueprintId: db.id }, 8080)
    const compiled = compileWorld(doc)
    const nodes = connNodes(doc)
    const pos = layoutNodes(nodes, edgesForView(doc, compiled))
    expect(pos[INTERNET_NODE].col).toBe(0)
    expect(pos[api.id].col).toBeGreaterThanOrEqual(1)
    expect(pos[db.id].col).toBeGreaterThan(pos[api.id].col)
  })
})

// The dock's Connections tab renders these rows; the full-screen canvas renders the same edges
// as geometry. Both read edgesForView, so the list can never disagree with the graph.
describe('connectionRows', () => {
  it('labels each edge with its endpoint names and port', () => {
    const { doc, api, db } = apiDbWorld()
    addDep(doc, api.id, { kind: 'blueprint', blueprintId: db.id }, 5432)

    const row = connectionRows(doc, compileWorld(doc)).find(r => r.toLabel === 'db')

    expect(row).toBeDefined()
    expect(row!.fromLabel).toBe('api')
    expect(row!.port).toBe(5432)
  })

  it('labels a synthetic ingress edge as coming from the Internet', () => {
    const { doc, api } = apiDbWorld()
    api.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]

    const rows = connectionRows(doc, compileWorld(doc))

    expect(rows.some(r => r.fromLabel === 'Internet')).toBe(true)
  })

  // The list IS the tab's content, so a stable order matters more than a clever one: rows must
  // not reshuffle under the user as unrelated parts of the world change.
  it('orders rows by source then target label', () => {
    const { doc, api, db } = apiDbWorld()
    addDep(doc, api.id, { kind: 'blueprint', blueprintId: db.id }, 5432)

    const labels = connectionRows(doc, compileWorld(doc)).map(r => `${r.fromLabel} ${r.toLabel}`)

    expect([...labels].sort()).toEqual(labels)
  })

  it('carries each edge status through for the row status dot', () => {
    const { doc, api, db } = apiDbWorld()
    addDep(doc, api.id, { kind: 'blueprint', blueprintId: db.id }, 5432)

    for (const row of connectionRows(doc, compileWorld(doc))) {
      expect(['permitted', 'partial', 'blocked', 'unplaced']).toContain(row.status)
    }
  })

  it('falls back to a placeholder label for an edge pointing at a deleted node', () => {
    const { doc, api } = apiDbWorld()
    addDep(doc, api.id, { kind: 'blueprint', blueprintId: 'bp-deleted' }, 9999)

    const row = connectionRows(doc, compileWorld(doc)).find(r => r.port === 9999)

    expect(row).toBeDefined()
    expect(row!.toLabel).toBe('(deleted)')
  })
})
