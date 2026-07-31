// bench/renderPerf.bench.test.ts
// Perf budget for the 60 Hz RENDER loop (audit ISSUE-013 step 5/6) — a prerequisite for Wave 3,
// per audit-spec.md's Global Constraint 2: bench/enginePerf.bench.test.ts only measures `runStep`
// (the ~10 Hz sim loop, driven by `__test_step`). None of Wave 3's fixes (013/015/007/014/016) had
// a regression guard until this file existed, driving `__test_render` directly instead.
//
// RUN IN ISOLATION — `npm run bench` (see enginePerf.bench.test.ts's header for why: wall-clock
// timing is meaningless inside the default parallel suite, which is why both bench files are
// excluded from `npx vitest run` via vite.config.ts).
//
// Budget: this file's own — the render loop is a different animal from the 10 Hz sim step (no
// analog to DEGRADE_THRESHOLD_MS exists for it), so 1ms/frame at 400 particles is picked as a
// reasonable render-loop target (a 60fps frame budget is ~16.7ms total, shared across the whole
// view — the particle rebuild should be a small slice of that), with a 2x CI-fail-only line
// matching enginePerf's convention.
//
// Measured (2026-07-31, this machine, run alone): ~0.074ms/frame median BEFORE ISSUE-013/014/015
// (per-particle mix filter/reduce + per-row dependency `.find()` scan), ~0.053ms/frame AFTER —
// both comfortably inside budget at this fixture's scale (FAN=30, a 3-packet mix). The fixes are a
// real, measured win, just not a dramatic one at this instance count: the audit's ~24,000
// allocs/sec estimate is aggregate GC pressure over sustained runtime, which a 100-frame median
// doesn't fully capture. See ISSUE-017 in `docs/module-boundaries.md` for how this number gates
// the decision on whether particle-object pooling is worth its added ownership complexity.
import { describe, it, expect } from 'vitest'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement, createPopulation,
} from '../src/lib/world/factories'
import { getPreset } from '../src/lib/world/instanceCatalog'
import { compileWorld } from '../src/lib/world/compileWorld'
import { createWorldEngine } from '../src/lib/worldEngine'
import { addPacket } from '../src/lib/nodeConfig'
import type { WorldDoc } from '../src/lib/world/types'

const FAN = 30   // 30 downstream targets, each with enough rps to hit the AZ particle cap alone

function buildFixture(): { doc: WorldDoc; azId: string } {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const az = createAz(region.id, 'bench-az')
  doc.regions[region.id] = region
  doc.azs[az.id] = az

  // Seed a 3-packet library mix (a bound dep resolves to a real PickTable, not the null fast path).
  let reg = doc.packets
  const ids: number[] = []
  for (let i = 0; i < 3; i++) {
    const added = addPacket(reg, { name: `pkt-${i}`, protocol: 'http', method: 'GET', sizeKb: 1, responseSizeKb: 1, statusCode: 200 })
    reg = added.registry
    ids.push(added.packet.id)
  }
  doc.packets = reg
  const mix = ids.map((packetId, i) => ({ packetId, weight: i + 1 }))

  const web = createBlueprint('web', 0)
  web.ports = [{ port: 8080, protocol: 'tcp', visibility: 'public' }]
  const backends = Array.from({ length: FAN }, (_, i) => createBlueprint(`svc-${i}`, (i % 8) + 1))
  web.dependencies = backends.map((bp, i) => ({
    id: `dep-${i}`, target: { kind: 'blueprint' as const, blueprintId: bp.id },
    port: 8080, protocol: 'http' as const, packetTemplateId: null, packetMix: mix,
  }))
  doc.blueprints[web.id] = web
  for (const bp of backends) doc.blueprints[bp.id] = bp

  const server = createServer(az.id, getPreset('dedicated-8')!)
  doc.servers[server.id] = server
  const webPl = createPlacement(web.id, server.id)
  doc.placements[webPl.id] = webPl
  for (const bp of backends) {
    const pl = createPlacement(bp.id, server.id)
    doc.placements[pl.id] = pl
  }

  const pop = createPopulation('bench-clients', 38.9, -77.5)
  pop.peakRps = 20_000   // plenty of rps that every one of the FAN dependencies floods the AZ cap
  pop.diurnal = 'flat'
  doc.populations[pop.id] = pop

  return { doc, azId: az.id }
}

describe('render perf budget (audit ISSUE-013/015)', () => {
  it('median ≤1ms/frame at the 400-particle AZ cap over 100 frames (fails only above 2ms)', () => {
    const { doc, azId } = buildFixture()
    const compiled = compileWorld(doc)
    const engine = createWorldEngine()
    engine.start(doc, compiled, { onMetrics: () => {}, onEvent: () => {}, onHealthChange: () => {} })

    // Warm the sim to steady flows so buildAzParticles has real (capped) demand to iterate. Kept
    // under Mechanism B's 20-step sustained-overload streak (audit ISSUE-008) — this fixture's
    // 20,000 rps against a single 8-vCPU host is a genuine, deliberate saturation for the particle
    // cap, not a backpressure scenario, and a longer warm-up would trip the demand-shedding gate
    // and reduce admitted rps below what's needed to render the full 400-particle cap.
    for (let i = 0; i < 15; i++) engine.__test_step(1)

    let lastCount = 0
    const detach = engine.attachRenderer({ level: 'az', azId }, payload => {
      lastCount = payload.particles.length
    })

    // Warm-up frames pay one-time JIT cost, discarded (mirrors enginePerf's convention).
    for (let i = 0; i < 20; i++) engine.__test_render(i)

    const durationsMs: number[] = []
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now()
      engine.__test_render(1000 + i)
      durationsMs.push(performance.now() - t0)
    }
    detach()
    engine.stop()

    expect(lastCount).toBe(400)   // sanity: the fixture actually saturates MAX_AZ_PARTICLES

    durationsMs.sort((a, b) => a - b)
    const median = durationsMs[Math.floor(durationsMs.length / 2)]
    if (median > 1 && median <= 2) {
      console.warn(`[renderPerf] median frame ${median.toFixed(3)}ms exceeds the 1ms budget (still under the 2ms CI-fail line) at 400 particles`)
    }
    expect(median).toBeLessThanOrEqual(2)
  }, 30_000)
})
