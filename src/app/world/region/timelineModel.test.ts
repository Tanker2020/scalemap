// src/app/world/region/timelineModel.test.ts
import { describe, it, expect } from 'vitest'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
} from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'
import { compileWorld } from '../../../lib/world/compileWorld'
import {
  markerClass, buildLanes, narration, causalLinks, laneIndexOfEvent, TIMELINE_WINDOW_MS,
  type TimelineLane,
} from './timelineModel'
import type { EngineEvent, AzMetrics, MetricsBatch, ReplayFrame } from '../../../lib/worldEngine/types'

function evt(over: Partial<EngineEvent>): EngineEvent {
  return { id: 'e', simMs: 0, kind: 'engine_degraded', severity: 'info', message: '', affected: [], ...over }
}
function emptyWorldMetrics(): MetricsBatch['world'] {
  return { totalRps: 0, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 }
}
function az(over: Partial<AzMetrics>): AzMetrics {
  return { azId: '', rps: 0, errorRate: 0, p50Ms: 0, p90Ms: 0, healthScore: 100, health: 'healthy', serverCount: 0, instanceCount: 0, ...over }
}
function frame(simMs: number, azs: Record<string, AzMetrics> = {}): ReplayFrame {
  return { simMs, events: [], batch: { simMs, instances: {}, servers: {}, azs, regions: {}, world: emptyWorldMetrics() } }
}

function twoAzWorld() {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const azA = createAz(region.id, 'us-east-1a')
  const azB = createAz(region.id, 'us-east-1b')
  const serverA = createServer(azA.id, getPreset('vps-medium')!)
  const serverB = createServer(azB.id, getPreset('vps-medium')!)
  doc.regions[region.id] = region
  doc.azs[azA.id] = azA; doc.azs[azB.id] = azB
  doc.servers[serverA.id] = serverA; doc.servers[serverB.id] = serverB
  return { doc, region, azA, azB, serverA, serverB }
}

describe('markerClass', () => {
  it('maps every engine event kind to the right visual class', () => {
    expect(markerClass('outage_triggered')).toBe('kill')
    expect(markerClass('health_check_failed')).toBe('hc')
    expect(markerClass('failover_started')).toBe('shift')
    expect(markerClass('failover_completed')).toBe('shift')
    expect(markerClass('ttl_lag_expired')).toBe('shift')
    expect(markerClass('replica_promoted')).toBe('promote')
    expect(markerClass('outage_cleared')).toBe('other')
    expect(markerClass('oom_kill')).toBe('other')
    expect(markerClass('engine_degraded')).toBe('other')
    // FEAT-008 (Task 21)
    expect(markerClass('scale_out')).toBe('scale-out')
    expect(markerClass('scale_in')).toBe('scale-in')
  })
})

describe('buildLanes', () => {
  it('one lane per AZ, ordered by doc iteration, with label + serverCount', () => {
    const { doc, region, azA, azB } = twoAzWorld()
    const compiled = compileWorld(doc)
    const lanes = buildLanes(region.id, doc, compiled, [], [], 10_000)
    expect(lanes).toHaveLength(2)
    expect(lanes[0]).toMatchObject({ azId: azA.id, label: azA.label, serverCount: 1 })
    expect(lanes[1]).toMatchObject({ azId: azB.id, label: azB.label, serverCount: 1 })
  })

  it('merges consecutive frames with equal health into one band, closes at the next band, and stretches the last band to endMs', () => {
    const { doc, region, azA } = twoAzWorld()
    const compiled = compileWorld(doc)
    const frames: ReplayFrame[] = [
      frame(1000, { [azA.id]: az({ azId: azA.id, health: 'healthy' }) }),
      frame(2000, { [azA.id]: az({ azId: azA.id, health: 'healthy' }) }),
      frame(3000, { [azA.id]: az({ azId: azA.id, health: 'down' }) }),
      frame(4000, { [azA.id]: az({ azId: azA.id, health: 'down' }) }),
    ]
    const lanes = buildLanes(region.id, doc, compiled, [], frames, 5000)
    const laneA = lanes.find(l => l.azId === azA.id)!
    expect(laneA.bands).toEqual([
      { startMs: 1000, endMs: 3000, state: 'healthy' },
      { startMs: 3000, endMs: 5000, state: 'down' },
    ])
  })

  it('excludes frames outside the trailing TIMELINE_WINDOW_MS window', () => {
    const { doc, region, azA } = twoAzWorld()
    const compiled = compileWorld(doc)
    const endMs = 200_000
    const frames: ReplayFrame[] = [
      frame(endMs - TIMELINE_WINDOW_MS - 5000, { [azA.id]: az({ azId: azA.id, health: 'down' }) }), // outside
      frame(endMs - 1000, { [azA.id]: az({ azId: azA.id, health: 'healthy' }) }),
    ]
    const lanes = buildLanes(region.id, doc, compiled, [], frames, endMs)
    const laneA = lanes.find(l => l.azId === azA.id)!
    expect(laneA.bands).toEqual([{ startMs: endMs - 1000, endMs, state: 'healthy' }])
  })

  it('assigns an az-scoped marker to its own lane', () => {
    const { doc, region, azA, azB } = twoAzWorld()
    const compiled = compileWorld(doc)
    const events = [evt({ id: 'e1', kind: 'outage_triggered', simMs: 1000, affected: [azA.id] })]
    const lanes = buildLanes(region.id, doc, compiled, events, [], 10_000)
    expect(lanes.find(l => l.azId === azA.id)!.markers).toHaveLength(1)
    expect(lanes.find(l => l.azId === azB.id)!.markers).toHaveLength(0)
  })

  it('assigns a server-scoped marker to the lane owning that server', () => {
    const { doc, region, azA, azB, serverB } = twoAzWorld()
    const compiled = compileWorld(doc)
    const events = [evt({ id: 'e1', kind: 'oom_kill', simMs: 1000, affected: [serverB.id] })]
    const lanes = buildLanes(region.id, doc, compiled, events, [], 10_000)
    expect(lanes.find(l => l.azId === azA.id)!.markers).toHaveLength(0)
    expect(lanes.find(l => l.azId === azB.id)!.markers).toHaveLength(1)
  })

  it('assigns an instance-scoped marker to the lane owning that instance', () => {
    const { doc, region, azA, serverA } = twoAzWorld()
    const bp = createBlueprint('api', 0)
    const placement = createPlacement(bp.id, serverA.id)
    doc.blueprints[bp.id] = bp
    doc.placements[placement.id] = placement
    const compiled = compileWorld(doc)
    const instanceId = Object.values(compiled.instances).find(i => i.serverId === serverA.id)!.id
    const events = [evt({ id: 'e1', kind: 'breaker_open', simMs: 1000, affected: [instanceId] })]
    const lanes = buildLanes(region.id, doc, compiled, events, [], 10_000)
    expect(lanes.find(l => l.azId === azA.id)!.markers).toHaveLength(1)
  })

  // FEAT-008 (Task 21): scale_out/scale_in fire with `affected = [placementId]` (index.ts's
  // emit call sites), not a server/AZ/instance id — this locks in the azClosureContains fix
  // that resolves a placement-scoped event to the lane owning its host server.
  it('assigns a placement-scoped scale event to the lane owning its host server', () => {
    const { doc, region, azA, azB, serverA } = twoAzWorld()
    const bp = createBlueprint('api', 0)
    const placement = createPlacement(bp.id, serverA.id)
    doc.blueprints[bp.id] = bp
    doc.placements[placement.id] = placement
    const compiled = compileWorld(doc)
    const events = [evt({ id: 'e1', kind: 'scale_out', simMs: 1000, affected: [placement.id] })]
    const lanes = buildLanes(region.id, doc, compiled, events, [], 10_000)
    expect(lanes.find(l => l.azId === azA.id)!.markers).toEqual([{ event: events[0], cls: 'scale-out' }])
    expect(lanes.find(l => l.azId === azB.id)!.markers).toHaveLength(0)
  })

  it('falls back to the first lane for a region-scoped event that names no specific AZ', () => {
    // A region-level event (e.g. a failover_started carrying only population/region ids, per
    // the engine's real affected-id shape) is in region scope (matches regionId directly) but
    // no AZ's closure contains it — it lands on the first lane per the fallback rule.
    const { doc, region, azA } = twoAzWorld()
    const compiled = compileWorld(doc)
    const events = [evt({ id: 'e1', kind: 'failover_started', simMs: 1000, affected: [region.id] })]
    const lanes = buildLanes(region.id, doc, compiled, events, [], 10_000)
    expect(lanes.find(l => l.azId === azA.id)!.markers).toHaveLength(1)
  })

  it('excludes markers outside the trailing window', () => {
    const { doc, region, azA } = twoAzWorld()
    const compiled = compileWorld(doc)
    const endMs = 200_000
    const events = [evt({ id: 'old', kind: 'outage_triggered', simMs: endMs - TIMELINE_WINDOW_MS - 1, affected: [azA.id] })]
    const lanes = buildLanes(region.id, doc, compiled, events, [], endMs)
    expect(lanes.find(l => l.azId === azA.id)!.markers).toHaveLength(0)
  })

  it('returns [] when the region has no AZs', () => {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    doc.regions[region.id] = region
    const compiled = compileWorld(doc)
    expect(buildLanes(region.id, doc, compiled, [], [], 10_000)).toEqual([])
  })
})

describe('narration', () => {
  it('returns null with no events', () => {
    const { doc, region } = twoAzWorld()
    const compiled = compileWorld(doc)
    expect(narration(region.id, doc, compiled, [])).toBeNull()
  })

  it('returns null when only shift/promotion events exist with no kill or detection anchor', () => {
    const { doc, region, azA } = twoAzWorld()
    const compiled = compileWorld(doc)
    const events = [evt({ id: 'shift', kind: 'failover_started', simMs: 1000, affected: [azA.id], message: 'shifted' })]
    expect(narration(region.id, doc, compiled, events)).toBeNull()
  })

  it('narrates a kill-only chain with the mandated "you killed <label>" voicing', () => {
    const { doc, region, azA } = twoAzWorld()
    const compiled = compileWorld(doc)
    const events = [evt({ id: 'kill', kind: 'outage_triggered', simMs: 12_000, affected: [azA.id], message: 'az us-east-1a manually taken down' })]
    const result = narration(region.id, doc, compiled, events)
    expect(result).not.toBeNull()
    expect(result!.chain.map(e => e.id)).toEqual(['kill'])
    expect(result!.text).toBe(`What just happened: t=12s you killed ${azA.label}.`)
  })

  it('narrates the full kill -> detection -> shift -> promotion chain in order', () => {
    const { doc, region, azA, serverA } = twoAzWorld()
    const bp = createBlueprint('db', 0)
    const placement = createPlacement(bp.id, serverA.id)
    doc.blueprints[bp.id] = bp
    doc.placements[placement.id] = placement
    const compiled = compileWorld(doc)
    const instanceId = Object.values(compiled.instances).find(i => i.serverId === serverA.id)!.id
    const events = [
      evt({ id: 'kill', kind: 'outage_triggered', simMs: 12_000, affected: [azA.id] }),
      evt({ id: 'hc', kind: 'health_check_failed', simMs: 15_000, affected: [azA.id] }),
      // Real failover_started events carry population/region ids (never AZ ids) — matches
      // region scope by naming `region.id` directly, mirroring the engine's actual shape.
      evt({ id: 'shift', kind: 'failover_started', simMs: 18_000, affected: ['pop-1', region.id], message: 'pop-1 failing over us-east-1 -> eu-west-1' }),
      evt({ id: 'promote', kind: 'replica_promoted', simMs: 19_000, affected: [instanceId], message: 'db-replica inst-x promoted to primary' }),
    ]
    const result = narration(region.id, doc, compiled, events)
    expect(result!.chain.map(e => e.id)).toEqual(['kill', 'hc', 'shift', 'promote'])
    expect(result!.text).toBe(
      `What just happened: t=12s you killed ${azA.label} → health checks failed (t=15s) → ` +
      `pop-1 failing over us-east-1 -> eu-west-1 (t=18s) → db-replica inst-x promoted to primary (t=19s).`,
    )
  })

  it('omits a segment whose event does not exist (kill with no detection, then a later shift)', () => {
    const { doc, region, azA } = twoAzWorld()
    const compiled = compileWorld(doc)
    const events = [
      evt({ id: 'kill', kind: 'outage_triggered', simMs: 5000, affected: [azA.id] }),
      evt({ id: 'shift', kind: 'ttl_lag_expired', simMs: 8000, affected: ['pop-1', region.id], message: 'pop-1 DNS re-resolved' }),
    ]
    const result = narration(region.id, doc, compiled, events)
    expect(result!.chain.map(e => e.id)).toEqual(['kill', 'shift'])
    expect(result!.text).toContain('you killed')
    expect(result!.text).not.toContain('health checks failed')
  })

  it('anchors on detection alone when there is no kill event', () => {
    const { doc, region, azA } = twoAzWorld()
    const compiled = compileWorld(doc)
    const events = [evt({ id: 'hc', kind: 'health_check_failed', simMs: 7000, affected: [azA.id] })]
    const result = narration(region.id, doc, compiled, events)
    expect(result!.chain.map(e => e.id)).toEqual(['hc'])
    expect(result!.text).toBe('What just happened: t=7s health checks failed.')
  })

  it('anchors on the most recent kill when several exist', () => {
    const { doc, region, azA } = twoAzWorld()
    const compiled = compileWorld(doc)
    const events = [
      evt({ id: 'kill1', kind: 'outage_triggered', simMs: 1000, affected: [azA.id] }),
      evt({ id: 'kill2', kind: 'outage_triggered', simMs: 9000, affected: [azA.id] }),
    ]
    const result = narration(region.id, doc, compiled, events)
    expect(result!.chain.map(e => e.id)).toEqual(['kill2'])
  })

  it('ignores events outside the region scope', () => {
    const doc = createWorld()
    const regionA = createRegion('us-east-1')
    const regionB = createRegion('eu-west-1')
    const azX = createAz(regionB.id, 'eu-west-1a')
    doc.regions[regionA.id] = regionA; doc.regions[regionB.id] = regionB
    doc.azs[azX.id] = azX
    const compiled = compileWorld(doc)
    const events = [evt({ id: 'foreign', kind: 'outage_triggered', simMs: 1000, affected: [azX.id] })]
    expect(narration(regionA.id, doc, compiled, events)).toBeNull()
  })
})

describe('laneIndexOfEvent', () => {
  const lanesFixture = (): TimelineLane[] => [
    { azId: 'az-a', label: 'a', serverCount: 1, bands: [], markers: [{ event: evt({ id: 'kill', simMs: 1000 }), cls: 'kill' }] },
    { azId: 'az-b', label: 'b', serverCount: 1, bands: [], markers: [{ event: evt({ id: 'shift', simMs: 2000 }), cls: 'shift' }] },
  ]

  it('returns the index of the lane whose markers contain the event id', () => {
    const lanes = lanesFixture()
    expect(laneIndexOfEvent(lanes, 'kill')).toBe(0)
    expect(laneIndexOfEvent(lanes, 'shift')).toBe(1)
  })

  it('returns -1 when no lane holds the event id', () => {
    const lanes = lanesFixture()
    expect(laneIndexOfEvent(lanes, 'unassigned')).toBe(-1)
  })
})

describe('causalLinks', () => {
  const lanesFixture = (): TimelineLane[] => [
    { azId: 'az-a', label: 'a', serverCount: 1, bands: [], markers: [{ event: evt({ id: 'kill', simMs: 1000 }), cls: 'kill' }] },
    { azId: 'az-b', label: 'b', serverCount: 1, bands: [], markers: [{ event: evt({ id: 'shift', simMs: 2000 }), cls: 'shift' }] },
  ]

  it('links consecutive chain steps that land in different lanes', () => {
    const lanes = lanesFixture()
    const chain = [evt({ id: 'kill', simMs: 1000 }), evt({ id: 'shift', simMs: 2000 })]
    expect(causalLinks(lanes, chain)).toEqual([{ fromId: 'az-a', toId: 'az-b' }])
  })

  it('does not link consecutive steps in the SAME lane', () => {
    const lanes = lanesFixture()
    lanes[1].markers.push({ event: evt({ id: 'shift2', simMs: 2500 }), cls: 'shift' })
    const chain = [evt({ id: 'shift', simMs: 2000 }), evt({ id: 'shift2', simMs: 2500 })]
    expect(causalLinks(lanes, chain)).toEqual([])
  })

  it('skips a pair when a chain event is not assigned to any lane', () => {
    const lanes = lanesFixture()
    const chain = [evt({ id: 'kill', simMs: 1000 }), evt({ id: 'unassigned', simMs: 3000 })]
    expect(causalLinks(lanes, chain)).toEqual([])
  })

  it('returns [] for a chain shorter than two events', () => {
    const lanes = lanesFixture()
    expect(causalLinks(lanes, [evt({ id: 'kill' })])).toEqual([])
    expect(causalLinks(lanes, [])).toEqual([])
  })
})
