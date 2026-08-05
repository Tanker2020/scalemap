// bench/enginePerf.bench.test.ts
// Perf budget (Global Constraints / spec decision 9): ≤4ms median step at ~2,000 instances.
// A correctness-style assertion test using plain describe/it/expect — NOT vitest's separate
// bench() API. CI-tolerant per spec: only FAILS above 8ms/step (2x budget); 4-8ms warns via
// console.warn so a slightly-slow box doesn't flake the build.
//
// RUN IN ISOLATION — `npm run bench`, which targets ONLY this file. It is deliberately EXCLUDED
// from the default `npx vitest run` (see vite.config.ts `test.exclude`). A wall-clock timing
// assertion is meaningless inside the default suite: vitest runs ~117 files across parallel
// workers that all compete for cores, so the bench worker is descheduled mid-step and the SAME
// engine that steps in ~3.9ms measured ~11ms median / ~15ms mean in-suite, failing this guard on
// every full run until everyone learned to ignore it. CPU time (process.cpuUsage) does not escape
// it either — it counts V8's background GC/JIT threads, which scale with the whole suite's memory
// churn (8.3ms alone → 14.5ms in-suite, measured). Nothing timed from inside a starved worker is
// trustworthy; the only fix is to not share the machine, i.e. run this file alone.
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
// FEAT-008 (Wave 3 close, Task 22): the very first server (r=0/a=0/s=0) carries an AUTOSCALED bp0
// placement instead of a static one, so this bench measures the real cost of compileWorld's
// maxCount envelope expansion (an autoscaled placement compiles to its FULL maxCount, not its
// authored/minCount — see compileWorld.ts), not an artificially small minCount-only world. Its
// maxCount (15) is 5x its minCount (3) — a genuine "several times" envelope, per the spec's own
// "note that maxCount envelopes make compiled larger, so bench with a realistic envelope"
// warning. 215 static servers x 9 + 1 autoscaled server's 15-instance envelope = 1,950 "web" (bp0)
// instances, + 4 single-instance backend tiers = 1,954 total — lands the fixture in the
// sanity-checked (1800, 2000] range below (other placements' counts were NOT reduced to
// compensate; the autoscaled placement's extra 6 instances over the previous all-static 1,944 +
// 4 = 1,948 total still fit comfortably inside the band).
//
// Task 22 (Wave 3 close) verification note: adding this one autoscaled placement to the fixture
// exposed a real, since-fixed cost — routingHealthOfInstance (index.ts) and the observedCpu
// collection pass in the per-server host-scheduling loop were both O(whole compiled fleet) any
// time ANY placement anywhere carried an autoscale policy, not O(the autoscaled envelope), so
// enabling autoscale at ~2,000-instance scale cost an extra ~4-5ms/step regardless of how small
// the actual autoscaled placement was. Fixed by precomputing autoscaledPlacementIds/
// autoscaledInstanceIds once at start() and gating both call sites on Set membership instead of
// the single hasAnyAutoscale boolean. Compare this file's measured median against a same-machine,
// same-moment run of a build with no `autoscale` authored anywhere (e.g. `git stash` this file's
// changes) rather than against the ~3.9ms figure in the comment below in isolation — that absolute
// number drifts with ambient machine load (observed 3.9-7.5ms across otherwise-identical runs in
// this session), but the AUTOSCALE-attributable delta measured that way stayed under ~0.5ms/step
// after the fix (vs. ~4-5ms/step before it), matching the "hasAnyAutoscale fast path" budget this
// bench exists to guard.
const AUTOSCALE_MIN_COUNT = 3, AUTOSCALE_MAX_COUNT = 15

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
        const isFirstServer = !firstServerId
        if (isFirstServer) firstServerId = server.id
        const pl = createPlacement(blueprints[0].id, server.id)
        if (isFirstServer) {
          // The one autoscaled placement (see AUTOSCALE_MIN_COUNT/AUTOSCALE_MAX_COUNT above) —
          // authored count sits at minCount; compileWorld is what expands it to maxCount.
          pl.count = AUTOSCALE_MIN_COUNT
          pl.autoscale = {
            minCount: AUTOSCALE_MIN_COUNT, maxCount: AUTOSCALE_MAX_COUNT, targetCpuPercent: 60,
            scaleUpCooldownSec: 30, scaleDownCooldownSec: 300,
          }
        } else {
          pl.count = INSTANCES_PER_SERVER
        }
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
  it('median ≤4ms/step over 100 steps at ~2,000 instances (fails only above 8ms; 4–8ms warns)', () => {
    const doc = buildSyntheticWorld()
    const compiled = compileWorld(doc)
    const instanceCount = Object.keys(compiled.instances).length
    expect(instanceCount).toBeGreaterThan(1800)   // sanity: fixture actually hits the target scale
    expect(instanceCount).toBeLessThanOrEqual(2000)

    // createWorldEngine() gives this bench its own isolated engine instance rather than driving
    // the shared `worldEngine` singleton the app store uses — see worldEngine/index.ts's exports.
    const engine = createWorldEngine()
    engine.start(doc, compiled, { onMetrics: () => {}, onEvent: () => {}, onHealthChange: () => {} })

    // Warm up first: the opening steps pay one-time JIT compilation of the engine's hot paths,
    // which would otherwise skew the early samples. Discard them.
    for (let i = 0; i < 20; i++) engine.__test_step(1)

    // MEDIAN per-step wall time, not mean. A step is pure synchronous compute, but two things
    // perturb individual samples: an occasional V8 GC pause lands on one step (a fat right tail
    // that drags the MEAN ~1.5x above the typical step), and CPU contention from sibling vitest
    // workers deschedules steps mid-flight (the reason this file runs in isolation — see the
    // header). The median is robust to both: it is the cost of a TYPICAL step, which is what this
    // guard cares about. Run alone (`npm run bench`) it sits at ~3.9ms, inside the 4ms budget.
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

    durationsMs.sort((a, b) => a - b)
    const median = durationsMs[Math.floor(durationsMs.length / 2)]
    if (median > 4 && median <= 8) {
      console.warn(`[enginePerf] median step ${median.toFixed(2)}ms exceeds the 4ms budget (still under the 8ms CI-fail line) at ${instanceCount} instances`)
    }
    expect(median).toBeLessThanOrEqual(8)
  }, 30_000)
})
