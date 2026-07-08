import { describe, it, expect } from 'vitest'
import { createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement } from './factories'
import { getPreset } from './instanceCatalog'
import { compileWorld, instanceId } from './compileWorld'
import type { WorldDoc } from './types'

// Shared fixture builder: 1 region, 1 AZ, 1 server, 1 blueprint. Tests mutate from here.
export function tinyWorld() {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const az = createAz(region.id, 'us-east-1a')
  const server = createServer(az.id, getPreset('vps-medium')!)
  const bp = createBlueprint('api', 1)
  doc.regions[region.id] = region
  doc.azs[az.id] = az
  doc.servers[server.id] = server
  doc.blueprints[bp.id] = bp
  return { doc, region, az, server, bp }
}

describe('compileWorld — instance expansion', () => {
  it('expands a placement of count N into N instances with full lineage', () => {
    const { doc, region, az, server, bp } = tinyWorld()
    const pl = createPlacement(bp.id, server.id)
    pl.count = 3
    pl.role = 'replica'
    doc.placements[pl.id] = pl

    const compiled = compileWorld(doc)
    const ids = Object.keys(compiled.instances)
    expect(ids).toHaveLength(3)
    expect(ids).toContain(instanceId(pl.id, 0))
    const inst = compiled.instances[instanceId(pl.id, 1)]
    expect(inst).toMatchObject({
      blueprintId: bp.id, placementId: pl.id, serverId: server.id,
      azId: az.id, regionId: region.id, role: 'replica', indexInPlacement: 1,
    })
  })

  it('skips placements whose blueprint or server no longer exists (dangling refs)', () => {
    const { doc, server, bp } = tinyWorld()
    const good = createPlacement(bp.id, server.id)
    const noBp = createPlacement('bp-gone', server.id)
    const noSrv = createPlacement(bp.id, 'srv-gone')
    doc.placements[good.id] = good
    doc.placements[noBp.id] = noBp
    doc.placements[noSrv.id] = noSrv

    const compiled = compileWorld(doc)
    expect(Object.keys(compiled.instances)).toHaveLength(1)
  })

  it('returns empty collections for an empty world', () => {
    const compiled = compileWorld(createWorld())
    expect(compiled.instances).toEqual({})
    expect(compiled.paths).toEqual([])
    expect(compiled.findings).toEqual([])
  })

  it('is pure: same input object → deep-equal output, input untouched', () => {
    const { doc, server, bp } = tinyWorld()
    doc.placements['p1'] = { ...createPlacement(bp.id, server.id), id: 'p1' }
    const snapshot = JSON.parse(JSON.stringify(doc)) as WorldDoc
    const a = compileWorld(doc)
    const b = compileWorld(doc)
    expect(a).toEqual(b)
    expect(doc).toEqual(snapshot)
  })
})
