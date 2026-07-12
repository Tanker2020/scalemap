// src/app/world/dock/scopeData.test.ts
// Pure logic — node env (default). Fixture mirrors regionData.test.ts's two-region shape so the
// region/az/server exclusion assertions have a real sibling to be excluded FROM.
import { describe, it, expect } from 'vitest'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
} from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'
import { compileWorld } from '../../../lib/world/compileWorld'
import { regionEvents } from '../region/regionData'
import { scopeEntityIds, scopedEvents, scopedFindings, scopedCost } from './scopeData'
import type { DockScope } from './scope'
import type { EngineEvent, WorldMetrics } from '../../../lib/worldEngine/types'
import type { AnalysisFinding } from '../../../lib/analysis/types'
import type { CompileFinding, WorldDoc } from '../../../lib/world/types'

function evt(over: Partial<EngineEvent>): EngineEvent {
  return { id: 'e', simMs: 0, kind: 'engine_degraded', severity: 'info', message: '', affected: [], ...over }
}
function finding(over: Partial<AnalysisFinding>): AnalysisFinding {
  return {
    id: 'f', ruleId: 'r', family: 'structural', severity: 'warning',
    title: 't', why: 'w', fix: 'x', affected: [], ...over,
  }
}
function compileFinding(over: Partial<CompileFinding>): CompileFinding {
  return { id: 'cf', severity: 'warning', kind: 'stateful-without-volume', message: 'm', affected: [], ...over }
}

// Two regions: A has two AZs (azA1 hosts server1 + a placed instance, azA2 hosts server2 idle),
// B has one AZ (azB1 hosts server3 + a placed instance) — enough shape to prove region/az/server
// scoping EXCLUDES siblings, not just that it includes the target.
function twoRegionWorld() {
  const doc: WorldDoc = createWorld()
  const regionA = createRegion('us-east-1')
  const regionB = createRegion('eu-west-1')
  doc.regions[regionA.id] = regionA
  doc.regions[regionB.id] = regionB
  const azA1 = createAz(regionA.id, 'us-east-1a')
  const azA2 = createAz(regionA.id, 'us-east-1b')
  const azB1 = createAz(regionB.id, 'eu-west-1a')
  doc.azs[azA1.id] = azA1; doc.azs[azA2.id] = azA2; doc.azs[azB1.id] = azB1

  const server1 = createServer(azA1.id, getPreset('vps-medium')!)
  const server2 = createServer(azA2.id, getPreset('vps-medium')!)
  const server3 = createServer(azB1.id, getPreset('vps-medium')!)
  doc.servers[server1.id] = server1; doc.servers[server2.id] = server2; doc.servers[server3.id] = server3

  const bp = createBlueprint('api', 0)
  doc.blueprints[bp.id] = bp
  const pl1 = createPlacement(bp.id, server1.id)
  const pl3 = createPlacement(bp.id, server3.id)
  doc.placements[pl1.id] = pl1
  doc.placements[pl3.id] = pl3

  const compiled = compileWorld(doc)
  const instance1 = `${pl1.id}#0`
  const instance3 = `${pl3.id}#0`

  return {
    doc, compiled, regionA, regionB, azA1, azA2, azB1, server1, server2, server3,
    instance1, instance3,
  }
}

describe('scopeEntityIds', () => {
  it('world scope returns the null sentinel ("everything", no filter)', () => {
    const { doc, compiled } = twoRegionWorld()
    expect(scopeEntityIds({ kind: 'world' }, doc, compiled)).toBeNull()
  })

  it('region scope closure = regionId + its AZs + their servers + their instances, excluding the sibling region', () => {
    const { doc, compiled, regionA, azA1, azA2, azB1, server1, server2, server3, instance1, instance3 } = twoRegionWorld()
    const scope: DockScope = { kind: 'region', regionId: regionA.id }
    const ids = scopeEntityIds(scope, doc, compiled)!
    expect(ids.has(regionA.id)).toBe(true)
    expect(ids.has(azA1.id)).toBe(true)
    expect(ids.has(azA2.id)).toBe(true)
    expect(ids.has(server1.id)).toBe(true)
    expect(ids.has(server2.id)).toBe(true)
    expect(ids.has(instance1)).toBe(true)
    // Sibling region B's entities must be excluded.
    expect(ids.has(azB1.id)).toBe(false)
    expect(ids.has(server3.id)).toBe(false)
    expect(ids.has(instance3)).toBe(false)
  })

  it('az scope closure = azId + its servers + their instances, excluding a sibling AZ in the same region', () => {
    const { doc, compiled, azA1, azA2, server1, server2, instance1 } = twoRegionWorld()
    const scope: DockScope = { kind: 'az', regionId: azA1.regionId, azId: azA1.id }
    const ids = scopeEntityIds(scope, doc, compiled)!
    expect(ids.has(azA1.id)).toBe(true)
    expect(ids.has(server1.id)).toBe(true)
    expect(ids.has(instance1)).toBe(true)
    // Sibling AZ (same region) must be excluded.
    expect(ids.has(azA2.id)).toBe(false)
    expect(ids.has(server2.id)).toBe(false)
  })

  it('server scope closure = serverId + its instances only', () => {
    const { doc, compiled, azA1, server1, server2, instance1 } = twoRegionWorld()
    const scope: DockScope = { kind: 'server', regionId: azA1.regionId, azId: azA1.id, serverId: server1.id }
    const ids = scopeEntityIds(scope, doc, compiled)!
    expect(ids.has(server1.id)).toBe(true)
    expect(ids.has(instance1)).toBe(true)
    expect(ids.has(server2.id)).toBe(false)
  })
})

describe('scopedEvents', () => {
  it('world scope returns every event, unfiltered', () => {
    const { doc, compiled, regionA, regionB } = twoRegionWorld()
    const events = [evt({ id: 'e1', affected: [regionA.id] }), evt({ id: 'e2', affected: [regionB.id] })]
    expect(scopedEvents({ kind: 'world' }, doc, compiled, events, null)).toBe(events)
  })

  it('region scope delegates to the existing regionEvents helper byte-for-byte', () => {
    const { doc, compiled, regionA, regionB, azA1, server1 } = twoRegionWorld()
    const events = [
      evt({ id: 'e1', affected: [azA1.id] }),
      evt({ id: 'e2', affected: [regionB.id] }),
      evt({ id: 'e3', affected: [server1.id] }),
    ]
    const scope: DockScope = { kind: 'region', regionId: regionA.id }
    const expected = regionEvents(regionA.id, doc, compiled, events, null)
    expect(scopedEvents(scope, doc, compiled, events, null)).toEqual(expected)
    // Sanity: the delegation actually filtered something (not a vacuous no-op equality).
    expect(expected.map(e => e.id)).toEqual(['e1', 'e3'])
  })

  it('az scope filters events to this AZ\'s closure', () => {
    const { doc, compiled, azA1, azA2, server1 } = twoRegionWorld()
    const events = [
      evt({ id: 'e1', affected: [azA1.id] }),
      evt({ id: 'e2', affected: [azA2.id] }),
      evt({ id: 'e3', affected: [server1.id] }),
    ]
    const scope: DockScope = { kind: 'az', regionId: azA1.regionId, azId: azA1.id }
    const result = scopedEvents(scope, doc, compiled, events, null)
    expect(result.map(e => e.id)).toEqual(['e1', 'e3'])
  })

  it('server scope filters events to this server\'s closure', () => {
    const { doc, compiled, azA1, server1, server2 } = twoRegionWorld()
    const events = [
      evt({ id: 'e1', affected: [server1.id] }),
      evt({ id: 'e2', affected: [server2.id] }),
    ]
    const scope: DockScope = { kind: 'server', regionId: azA1.regionId, azId: azA1.id, serverId: server1.id }
    const result = scopedEvents(scope, doc, compiled, events, null)
    expect(result.map(e => e.id)).toEqual(['e1'])
  })
})

describe('scopedFindings', () => {
  it('world scope passes both lists through unfiltered', () => {
    const { doc, compiled, regionA } = twoRegionWorld()
    const findings = [finding({ id: 'f1', affected: [regionA.id] })]
    const compileFindings = [compileFinding({ id: 'cf1', affected: [regionA.id] })]
    const result = scopedFindings({ kind: 'world' }, findings, compileFindings, doc, compiled)
    expect(result.analysis).toBe(findings)
    expect(result.compile).toBe(compileFindings)
  })

  it('narrower scope filters both lists to the entity closure', () => {
    const { doc, compiled, azA1, azA2, server1 } = twoRegionWorld()
    const findings = [
      finding({ id: 'f-in', affected: [server1.id] }),
      finding({ id: 'f-out', affected: [azA2.id] }),
    ]
    const compileFindings = [
      compileFinding({ id: 'cf-in', affected: [azA1.id] }),
      compileFinding({ id: 'cf-out', affected: [azA2.id] }),
    ]
    const scope: DockScope = { kind: 'az', regionId: azA1.regionId, azId: azA1.id }
    const result = scopedFindings(scope, findings, compileFindings, doc, compiled)
    expect(result.analysis.map(f => f.id)).toEqual(['f-in'])
    expect(result.compile.map(f => f.id)).toEqual(['cf-in'])
  })
})

describe('scopedCost', () => {
  it('server scope: hourlyUsd = server.hourlyUsd, monthlyUsd = ×730, fixed egress note', () => {
    const { doc, azA1, server1 } = twoRegionWorld()
    const scope: DockScope = { kind: 'server', regionId: azA1.regionId, azId: azA1.id, serverId: server1.id }
    const result = scopedCost(scope, doc, null)
    expect(result.hourlyUsd).toBe(server1.hourlyUsd)
    expect(result.monthlyUsd).toBeCloseTo(server1.hourlyUsd * 730, 6)
    expect(result.egressNote).toBe('egress is attributed at the AZ level')
  })

  it('server scope on a missing/deleted server degrades to zero rather than throwing', () => {
    const { doc, azA1 } = twoRegionWorld()
    const scope: DockScope = { kind: 'server', regionId: azA1.regionId, azId: azA1.id, serverId: 'srv-gone' }
    const result = scopedCost(scope, doc, null)
    expect(result.hourlyUsd).toBe(0)
    expect(result.monthlyUsd).toBe(0)
  })

  it('region scope reads computeWorldCost().byRegion for this region', () => {
    const { doc, regionA } = twoRegionWorld()
    const scope: DockScope = { kind: 'region', regionId: regionA.id }
    const result = scopedCost(scope, doc, null)
    // Region A hosts server1 (azA1) + server2 (azA2) — both bill compute hours.
    expect(result.monthlyUsd).toBeGreaterThan(0)
    expect(result.hourlyUsd).toBeCloseTo(result.monthlyUsd / 730, 6)
  })

  it('region scope with no cost yet (empty region) is zero, not a throw', () => {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    doc.regions[region.id] = region
    const result = scopedCost({ kind: 'region', regionId: region.id }, doc, null)
    expect(result.monthlyUsd).toBe(0)
    expect(result.hourlyUsd).toBe(0)
  })

  it('az scope reads computeWorldCost().byAz for this AZ', () => {
    const { doc, azA1, server1 } = twoRegionWorld()
    const scope: DockScope = { kind: 'az', regionId: azA1.regionId, azId: azA1.id }
    const result = scopedCost(scope, doc, null)
    expect(result.monthlyUsd).toBeCloseTo(server1.hourlyUsd * 730, 6)
  })

  it('world scope matches computeWorldCost\'s full monthly total', () => {
    const { doc } = twoRegionWorld()
    const world: WorldMetrics | null = null
    const result = scopedCost({ kind: 'world' }, doc, world)
    expect(result.monthlyUsd).toBeGreaterThan(0)
    expect(result.hourlyUsd).toBeCloseTo(result.monthlyUsd / 730, 6)
  })
})
