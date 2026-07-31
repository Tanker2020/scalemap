import { describe, it, expect } from 'vitest'
import { createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement } from './factories'
import { getPreset } from './instanceCatalog'
import { compileWorld, instanceId } from './compileWorld'
import { addPacket } from '../nodeConfig'
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

// ─── Protocol-mismatch findings (audit ISSUE-007) ────────────────────────────
// dep.protocol drives ONLY particle render tint; every simulated consequence comes from the bound
// mix's own protocol. A mismatch is advisory-surfaced, never auto-corrected.
describe('compileWorld — protocol-mismatch findings (audit ISSUE-007)', () => {
  // Two blueprints (api -> target) on one server, with api's dependency's protocol/mix set by
  // the caller. Target has no dependencies, so it never contributes its own findings.
  function mismatchWorld(depProtocol: 'http' | 'db' | 'event' | 'stream', mixProtocol: 'http' | 'db' | 'event' | 'stream' | null) {
    const { doc, server } = tinyWorld()
    const target = createBlueprint('target', 2)
    doc.blueprints[target.id] = target
    const targetPl = createPlacement(target.id, server.id)
    doc.placements[targetPl.id] = targetPl

    const api = doc.blueprints[Object.keys(doc.blueprints)[0]]
    const apiPl = createPlacement(api.id, server.id)
    doc.placements[apiPl.id] = apiPl

    let packetMix: { packetId: number; weight: number }[] | undefined
    if (mixProtocol != null) {
      const fields = mixProtocol === 'http'
        ? { name: 'p', protocol: 'http' as const, method: 'GET' as const, statusCode: 200 }
        : mixProtocol === 'db'
          ? { name: 'p', protocol: 'db' as const, queryType: 'read' as const, isWAL: false, resultSizeKb: 1 }
          : mixProtocol === 'event'
            ? { name: 'p', protocol: 'event' as const, topic: 't', eventType: 'e', deliveryMode: 'at-least-once' as const }
            : { name: 'p', protocol: 'stream' as const, streamId: 's', compressionType: 'none' as const }
      const added = addPacket(doc.packets, fields)
      doc.packets = added.registry
      packetMix = [{ packetId: added.packet.id, weight: 1 }]
    }

    api.dependencies = [{
      id: 'd-target', target: { kind: 'blueprint', blueprintId: target.id },
      port: 8080, protocol: depProtocol, packetTemplateId: null, packetMix,
    }]
    return doc
  }

  it('flags a dependency whose protocol disagrees with its bound mix', () => {
    const doc = mismatchWorld('event', 'http')
    const compiled = compileWorld(doc)
    const found = compiled.findings.filter(f => f.kind === 'protocol-mismatch')
    expect(found).toHaveLength(1)
    expect(found[0].affected).toContain('d-target')
  })

  it('does not fire when dep.protocol matches the mix majority', () => {
    const doc = mismatchWorld('http', 'http')
    const compiled = compileWorld(doc)
    expect(compiled.findings.some(f => f.kind === 'protocol-mismatch')).toBe(false)
  })

  it('does not fire when the dependency has no bound mix at all', () => {
    const doc = mismatchWorld('event', null)
    const compiled = compileWorld(doc)
    expect(compiled.findings.some(f => f.kind === 'protocol-mismatch')).toBe(false)
  })
})
