// bench/enginePerf.bench.test.ts
// Perf budget (Global Constraints / spec decision 9): ≤4ms mean step at ~2,000 instances.
// This is a correctness-style assertion test using plain describe/it/expect, run under the
// normal `npx vitest run` suite so CI catches regressions — NOT vitest's separate `bench()`
// benchmarking API (the file is named `*.bench.test.ts` rather than `*.bench.ts` specifically so
// vitest's default include glob `**/*.{test,spec}.?(c|m)[jt]s?(x)` picks it up; a bare `*.bench.ts`
// would be silently excluded from `npx vitest run`). CI-tolerant per spec: only FAILS above
// 8ms/step (2x budget); 4-8ms warns via console.warn so a loaded CI box doesn't flake the build.
import { describe, it, expect } from 'vitest'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement, createPopulation,
} from '../src/lib/world/factories'
import { getPreset } from '../src/lib/world/instanceCatalog'
import { compileWorld } from '../src/lib/world/compileWorld'
import { createWorldEngine } from '../src/lib/worldEngine'
import type { WorldDoc } from '../src/lib/world/types'

const REGIONS = 6, AZS_PER_REGION = 3, SERVERS_PER_AZ = 12, INSTANCES_PER_SERVER = 9
const BACKEND_TIERS = 4
// 216 servers (6 x 3 x 12) x 9 "web" (bp0) instances/server = 1,944, + 4 single-instance backend
// tiers = 1,948 total — lands the fixture in the sanity-checked (1800, 2000] range below.

function buildSyntheticWorld(): WorldDoc {
  const doc = createWorld()
  const blueprints = Array.from({ length: BACKEND_TIERS + 1 }, (_, i) => createBlueprint(`svc-${i}`, i))
  for (const bp of blueprints) doc.blueprints[bp.id] = bp
  // bp0 ("svc-0") is the public entry point client traffic lands on; chain each blueprint to the
  // next so flows.ts has real fan-out work to do per hop, all the way down the chain.
  blueprints[0].ports = [{ port: 8080, protocol: 'tcp', visibility: 'public' }]
  for (let i = 0; i < blueprints.length - 1; i++) {
    blueprints[i].dependencies = [{
      id: `dep-${i}`, target: { kind: 'blueprint', blueprintId: blueprints[i + 1].id },
      port: 8080, protocol: 'http', packetTemplateId: null,
    }]
  }

  let firstServerId = ''
  for (let r = 0; r < REGIONS; r++) {
    const region = createRegion('us-east-1')
    doc.regions[region.id] = region
    for (let a = 0; a < AZS_PER_REGION; a++) {
      const az = createAz(region.id, `bench-${r}${String.fromCharCode(97 + a)}`)
      doc.azs[az.id] = az
      for (let s = 0; s < SERVERS_PER_AZ; s++) {
        const server = createServer(az.id, getPreset('vps-medium')!)
        doc.servers[server.id] = server
        if (!firstServerId) firstServerId = server.id
        const pl = createPlacement(blueprints[0].id, server.id)
        pl.count = INSTANCES_PER_SERVER
        doc.placements[pl.id] = pl
      }
    }
  }
  // Downstream tiers (bp1..bp4) are single-instance and colocated on the first server — a
  // deliberately small, fixed-size backend behind the large bp0 tier. compileWorld connects
  // EVERY instance of a calling blueprint to EVERY instance of its dependency target (a full
  // mesh per hop), so chaining two LARGE tiers across multiple hops explodes both the compiled
  // path count and solveFlows's BFS queue size combinatorially (candidates-per-hop compounds
  // across hops, not just within one) — an earlier draft that round-robin'd all ~2,000 instances
  // evenly across 5 blueprints produced five ~400-instance tiers, 653K compiled paths, and tens
  // of millions of BFS queue items per step. Pinning bp1-4 to 1 instance each keeps every hop's
  // fan-out at exactly 1 candidate (linear BFS growth, no compounding) while bp0 still carries
  // the ~2,000-instance bulk of the fixture and every hop still does real routing/latency/
  // breaker work.
  for (let i = 1; i < blueprints.length; i++) {
    const pl = createPlacement(blueprints[i].id, firstServerId)
    doc.placements[pl.id] = pl
  }

  const pop = createPopulation('bench-clients', 38.9, -77.5)
  // Deliberately modest, not the ~50k rps a single real-world population might peak at: with
  // bp1-4's downstream tiers pinned to 1 instance each, that single instance receives the FULL
  // fanned-out admitted rps from every one of the ~1,944 bp0 callers (solveFlows fans every
  // dependency call out to ALL compiled targets each step, with no across-time load balancing).
  // At 50k rps that saturates the single downstream instance into a genuine cascading-overload /
  // circuit-breaker-flap steady state — correctly handled by the engine, but a measurement of
  // deliberately-overloaded-backend cost, not the per-step ALGORITHMIC cost this bench targets.
  pop.peakRps = 2_000
  doc.populations[pop.id] = pop
  return doc
}

describe('engine perf budget', () => {
  it('averages ≤4ms/step over 100 steps at ~2,000 instances (fails only above 8ms; 4–8ms warns)', () => {
    const doc = buildSyntheticWorld()
    const compiled = compileWorld(doc)
    const instanceCount = Object.keys(compiled.instances).length
    expect(instanceCount).toBeGreaterThan(1800)   // sanity: fixture actually hits the target scale
    expect(instanceCount).toBeLessThanOrEqual(2000)

    // createWorldEngine() gives this bench its own isolated engine instance rather than driving
    // the shared `worldEngine` singleton the app store uses — see worldEngine/index.ts's exports.
    const engine = createWorldEngine()
    engine.start(doc, compiled, { onMetrics: () => {}, onEvent: () => {}, onHealthChange: () => {} })

    const durationsMs: number[] = []
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now()
      // __test_step is a method on the object createWorldEngine() returns (WorldEngineApi &
      // { __test_step }), not a standalone export — drives exactly one fixed 100ms step,
      // bypassing requestAnimationFrame, headless-safe for vitest/Node.
      engine.__test_step(1)
      durationsMs.push(performance.now() - t0)
    }
    engine.stop()

    const mean = durationsMs.reduce((a, b) => a + b, 0) / durationsMs.length
    if (mean > 4 && mean <= 8) {
      console.warn(`[enginePerf] mean step ${mean.toFixed(2)}ms exceeds the 4ms budget (still under the 8ms CI-fail line) at ${instanceCount} instances`)
    }
    expect(mean).toBeLessThanOrEqual(8)
  }, 30_000)
})
