import { describe, it, expect } from 'vitest'
import { scenario } from '../__fixtures__/worlds'
import { runAnalysis } from '../runAnalysis'
import { greatCircleKm } from '../../world/regionGeo'
import { compileWorld } from '../../world/compileWorld'
import { createWorldEngine } from '../../worldEngine'
import { addRoute, routeIdOf } from '../../nodeConfig'
import type { AnalysisFinding } from '../types'
import type { MetricsBatch } from '../../worldEngine/types'

const ids = (fs: AnalysisFinding[], ruleId: string) => fs.filter(f => f.ruleId === ruleId)

// Minimal batch stub — the capacity rules read only servers[id].coreUtilization.
function batchWith(serverId: string, util: number[]): MetricsBatch {
  return { servers: { [serverId]: { coreUtilization: util } } } as unknown as MetricsBatch
}

describe('capacity: ram-oversubscribed', () => {
  it('fires when reserved RAM exceeds the host and names both numbers', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const srv = s.server(az.id) // dedicated-8 → 32768 MB
    const bp = s.blueprint('web')
    const pl = s.placement(bp.id, srv.id)
    pl.runtime = { type: 'container', stackName: 'app', networkNames: [], portMappings: [], cpuLimit: null, memLimitMb: 40000 }
    const f = ids(runAnalysis(s.doc, s.compile(), null), 'ram-oversubscribed')
    expect(f).toHaveLength(1)
    expect(f[0].affected[0]).toBe(srv.id)
    expect(f[0].why).toMatch(/40000/); expect(f[0].why).toMatch(/32768/)
  })
  it('silent when reserved RAM fits', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const srv = s.server(az.id); const bp = s.blueprint('web')
    const pl = s.placement(bp.id, srv.id)
    pl.runtime = { type: 'container', stackName: 'app', networkNames: [], portMappings: [], cpuLimit: null, memLimitMb: 1000 }
    expect(ids(runAnalysis(s.doc, s.compile(), null), 'ram-oversubscribed')).toHaveLength(0)
  })

  // Audit ISSUE-066: RAM demand under LOAD includes ramPerConnMb × live activeConnections — a
  // static reservation that fits can still OOM once connections pile up.
  it('counts live per-connection RAM growth from the batch (ISSUE-066)', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const srv = s.server(az.id) // dedicated-8 → 32768 MB
    const bp = s.blueprint('web')
    bp.workload.ramBaseMb = 1000
    bp.workload.ramPerConnMb = 8
    s.placement(bp.id, srv.id)   // process runtime — no memLimit cap
    const compiled = s.compile()
    const iid = Object.keys(compiled.instances)[0]
    // Static-only: 1000 MB fits easily; silent without a batch.
    expect(ids(runAnalysis(s.doc, compiled, null), 'ram-oversubscribed')).toHaveLength(0)
    // 5000 live connections × 8 MB = 40000 MB of growth ⇒ over the 32768 MB host.
    const batch = { servers: {}, instances: { [iid]: { activeConnections: 5000 } } } as unknown as MetricsBatch
    const f = ids(runAnalysis(s.doc, compiled, batch), 'ram-oversubscribed')
    expect(f).toHaveLength(1)
    expect(f[0].why).toMatch(/per-connection/)
  })

  // Connection semantics, end to end: a STREAMING service holds connections for its authored hold
  // duration instead of for its request latency, so its per-connection RAM explodes at a throughput
  // an identical keep-alive service handles for free. The rule needs no new code for this — it
  // already reads lastBatch.instances[].activeConnections — but that only works because the ENGINE
  // now publishes a connection-aware number. This test is what ties the two together.
  it('a streaming service trips the rule at an rps its keep-alive twin handles fine', () => {
    const build = (connectionType: 'keep-alive' | 'streaming') => {
      const s = scenario()
      const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
      const srv = s.server(az.id)                 // dedicated-8 → 32768 MB
      const bp = s.blueprint('web')
      bp.ports = [{ port: 8080, protocol: 'tcp', visibility: 'public' }]
      bp.workload = { cpuMsPerRequest: 1, ramBaseMb: 500, ramPerConnMb: 4, diskIoPerRequest: 0 }
      s.placement(bp.id, srv.id)                  // process runtime — no memLimit cap
      const added = addRoute(s.doc.packets, {
        name: 'feed', method: 'GET', path: '/feed', sizeKb: 1, responseSizeKb: 1, connectionType,
      })
      s.doc.packets = added.registry
      const pop = s.population('nyc', 40.7, -74.0)
      pop.peakRps = 400
      pop.requestMix = [{ routeId: routeIdOf(added.route), weight: 1 }]
      return s
    }

    // The PEAK-connection batch, not the last one: a streaming service this oversubscribed is
    // OOM-killed by the host scheduler within the first steps (which is the feature working — the
    // same connection count drives both paths), so the final batch is a post-collapse zero. The
    // analysis rule's job is to explain the batch where the pressure is visible.
    const peakBatchFor = (s: ReturnType<typeof scenario>) => {
      const compiled = compileWorld(s.doc)
      const engine = createWorldEngine(1)
      const batches: MetricsBatch[] = []
      engine.start(s.doc, compiled, { onMetrics: b => batches.push(b), onEvent: () => {}, onHealthChange: () => {} })
      engine.__test_step(100)   // 10 s of 100 ms steps
      engine.stop()
      const conns = (b: MetricsBatch) =>
        Object.values(b.instances).reduce((m, i) => Math.max(m, i.activeConnections), 0)
      const peak = batches.reduce((best, b) => (conns(b) > conns(best) ? b : best), batches[0])
      return { compiled, peak, peakConns: conns(peak) }
    }

    const ka = build('keep-alive'); const kaRun = peakBatchFor(ka)
    // ~400 rps × ~1 ms ⇒ well under one connection: 500 MB base, nowhere near the 32 GB host.
    expect(kaRun.peakConns).toBeLessThan(1)
    expect(ids(runAnalysis(ka.doc, kaRun.compiled, kaRun.peak), 'ram-oversubscribed')).toHaveLength(0)

    const st = build('streaming'); const stRun = peakBatchFor(st)
    // ~400 rps × 30 s ⇒ ~12,000 connections × 4 MB ⇒ ~48 GB, over the 32 GB host.
    expect(stRun.peakConns).toBeGreaterThan(5000)
    const f = ids(runAnalysis(st.doc, stRun.compiled, stRun.peak), 'ram-oversubscribed')
    expect(f).toHaveLength(1)
    expect(f[0].why).toMatch(/per-connection/)
  })
})

describe('capacity: burstable-sustained-load', () => {
  it('fires when a burstable VPS averages above its credit baseline', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const srv = s.server(az.id, 'vps-small') // burstable, baseline 0.2
    s.placement(s.blueprint('web').id, srv.id)
    const f = ids(runAnalysis(s.doc, s.compile(), batchWith(srv.id, [0.5, 0.5])), 'burstable-sustained-load')
    expect(f).toHaveLength(1)
    expect(f[0].affected).toEqual([srv.id])
  })
  it('silent at or below the preset baseline', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const srv = s.server(az.id, 'vps-small')
    s.placement(s.blueprint('web').id, srv.id)
    expect(ids(runAnalysis(s.doc, s.compile(), batchWith(srv.id, [0.2, 0.2])), 'burstable-sustained-load')).toHaveLength(0)
  })
  // Audit ISSUE-067: the threshold is the PRESET's credit baseline, not one hardcoded 40% — a
  // small burstable at 30% sustained is already draining credits; a bigger one is not.
  it('reads the per-preset baseline: vps-small (20%) fires at 30%, vps-medium (30%) does not', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const small = s.server(az.id, 'vps-small')    // baseline 0.2
    const medium = s.server(az.id, 'vps-medium')  // baseline 0.3
    s.placement(s.blueprint('web').id, small.id)
    s.placement(s.blueprint('api', 1).id, medium.id)
    const batch = {
      servers: {
        [small.id]: { coreUtilization: [0.3, 0.3] },
        [medium.id]: { coreUtilization: [0.3, 0.3, 0.3, 0.3] },
      },
    } as unknown as MetricsBatch
    const f = ids(runAnalysis(s.doc, s.compile(), batch), 'burstable-sustained-load')
    expect(f).toHaveLength(1)
    expect(f[0].affected).toEqual([small.id])
    expect(f[0].why).toMatch(/20%/)
  })
  it('silent with a null batch', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const srv = s.server(az.id, 'vps-small')
    s.placement(s.blueprint('web').id, srv.id)
    expect(ids(runAnalysis(s.doc, s.compile(), null), 'burstable-sustained-load')).toHaveLength(0)
  })
})

describe('capacity: ocean-crossing-population', () => {
  // Audit ISSUE-062: the km check only judges DISTANCE-driven policies (geo/latency), where a
  // far-first ordering signals a scoring bug (the ISSUE-009 class). The fire case simulates
  // exactly that mis-scored ordering on the compiled output under the default latency policy.
  it('fires when a distance policy produces a first region > 1.5× the nearest', () => {
    const s = scenario()
    const r1 = s.region('us-east-1'); s.az(r1.id, 'us-east-1a')
    const r2 = s.region('eu-west-1'); s.az(r2.id, 'eu-west-1a')
    const pop = s.population('london', 51.5, -0.1)
    const compiled = s.compile()
    compiled.routing.populationRegionOrder[pop.id] = [r1.id, r2.id]   // simulated mis-scoring
    const f = ids(runAnalysis(s.doc, compiled, null), 'ocean-crossing-population')
    expect(f).toHaveLength(1)
    expect(f[0].affected).toEqual([pop.id, r1.id, r2.id])
  })
  it('silent when the nearest region is first', () => {
    const s = scenario()
    const r1 = s.region('us-east-1'); s.az(r1.id, 'us-east-1a')
    const r2 = s.region('eu-west-1'); s.az(r2.id, 'eu-west-1a')
    s.population('london', 51.5, -0.1)
    expect(ids(runAnalysis(s.doc, s.compile(), null), 'ocean-crossing-population')).toHaveLength(0)
  })
  // Audit ISSUE-062's verification: a deliberate far route under an explicit priority order is
  // operator INTENT, not a design smell — the rule must stay silent (same for weighted splits).
  it('silent under a deliberate priority order to a far region (ISSUE-062)', () => {
    const s = scenario()
    const r1 = s.region('us-east-1'); s.az(r1.id, 'us-east-1a')
    const r2 = s.region('eu-west-1'); s.az(r2.id, 'eu-west-1a')
    s.doc.routing.policy = 'priority'
    s.doc.routing.priorityOrder = [r1.id, r2.id] // forces us-east-1 first for a London pop
    s.population('london', 51.5, -0.1)
    expect(ids(runAnalysis(s.doc, s.compile(), null), 'ocean-crossing-population')).toHaveLength(0)
  })
  it('haversine sanity: NYC→London ≈ 5570 km (±2%)', () => {
    const km = greatCircleKm(40.7, -74, 51.5, -0.1)
    expect(km).toBeGreaterThan(5570 * 0.98)
    expect(km).toBeLessThan(5570 * 1.02)
  })
})

// audit ISSUE-010: the rule was inverted. Total failover time ≈ detection window + up to one
// TTL, so a SHORT TTL is healthy; the anti-pattern is a TTL that OUTLIVES detection (clients
// keep serving a stale cached record long after the failure is known).
describe('capacity: ttl-outlives-detection', () => {
  it('fires when the DNS TTL outlives the failure-detection window', () => {
    const s = scenario()
    // 300000ms > 10000×3 + 5000 probe timeout = 35000ms (audit ISSUE-061 folds the timeout in)
    s.doc.routing.dnsTtlSec = 300
    const f = ids(runAnalysis(s.doc, s.compile(), null), 'ttl-outlives-detection')
    expect(f).toHaveLength(1)
    expect(f[0].affected).toEqual([])
    expect(f[0].id).toBe('ttl-outlives-detection:world')
    expect(f[0].why).toMatch(/300000/); expect(f[0].why).toMatch(/35000/)
    expect(f[0].fix).toMatch(/lower/i)
  })
  it('silent when the TTL is below the detection window (short TTL is healthy)', () => {
    const s = scenario()
    s.doc.routing.dnsTtlSec = 5 // 5000ms < 35000ms — clients re-resolve promptly after detection
    expect(ids(runAnalysis(s.doc, s.compile(), null), 'ttl-outlives-detection')).toHaveLength(0)
  })
  it('silent at the default TTL/detection balance', () => {
    const s = scenario() // dnsTtlSec 30 → 30000ms < 35000ms detection (incl. probe timeout)
    expect(ids(runAnalysis(s.doc, s.compile(), null), 'ttl-outlives-detection')).toHaveLength(0)
  })
  // Audit ISSUE-061: the detection estimate includes one probe timeout — a TTL that fits the
  // bare interval×threshold window but not the true window (with timeout) must still fire.
  it('counts the probe timeout inside the detection window (ISSUE-061)', () => {
    const s = scenario()
    s.doc.routing.dnsTtlSec = 32          // 32000ms > 30000ms bare, > only WITH the old estimate…
    s.doc.routing.healthCheckTimeoutMs = 1000   // …true window = 31000ms < 32000 ⇒ fires
    expect(ids(runAnalysis(s.doc, s.compile(), null), 'ttl-outlives-detection')).toHaveLength(1)
    s.doc.routing.healthCheckTimeoutMs = 5000   // true window = 35000ms ≥ 32000 ⇒ silent
    expect(ids(runAnalysis(s.doc, s.compile(), null), 'ttl-outlives-detection')).toHaveLength(0)
  })
})

// FEAT-001 Task 7: surfaces operator-injected chaos faults so degradation from a deliberate fault
// isn't mistaken for an architectural finding.
describe('capacity: fault-injected', () => {
  it('fires an info finding when the batch reports an active operator fault', () => {
    const s = scenario()
    const batch = { servers: {}, instances: {}, activeFaultCount: 1 } as unknown as MetricsBatch
    const f = ids(runAnalysis(s.doc, s.compile(), batch), 'fault-injected')
    expect(f).toHaveLength(1)
    expect(f[0].severity).toBe('info')
    expect(f[0].id).toBe('fault-injected:world')
    expect(f[0].why).toMatch(/1 fault is/)
  })
  it('pluralizes for more than one active fault', () => {
    const s = scenario()
    const batch = { servers: {}, instances: {}, activeFaultCount: 3 } as unknown as MetricsBatch
    const f = ids(runAnalysis(s.doc, s.compile(), batch), 'fault-injected')
    expect(f).toHaveLength(1)
    expect(f[0].why).toMatch(/3 faults are/)
  })
  it('silent with a null batch', () => {
    const s = scenario()
    expect(ids(runAnalysis(s.doc, s.compile(), null), 'fault-injected')).toHaveLength(0)
  })
  it('silent when activeFaultCount is 0 or undefined', () => {
    const s = scenario()
    const zero = { servers: {}, instances: {}, activeFaultCount: 0 } as unknown as MetricsBatch
    expect(ids(runAnalysis(s.doc, s.compile(), zero), 'fault-injected')).toHaveLength(0)
    const undef = { servers: {}, instances: {} } as unknown as MetricsBatch
    expect(ids(runAnalysis(s.doc, s.compile(), undef), 'fault-injected')).toHaveLength(0)
  })
})
