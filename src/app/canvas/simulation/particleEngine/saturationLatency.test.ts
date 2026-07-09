// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData, NodeSimConfig } from '../../../../lib/nodeConfig'
import { useSimulationStore, type NodeMetrics } from '../../../store/simulationLegacy.store'
import {
  startSimulation,
  stopSimulation,
  setCallbacks,
  setNodeConfigs,
  saturationLatencyMultiplier,
} from '../particleEngine'

describe('saturationLatencyMultiplier (pure function)', () => {
  it('grows hyperbolically toward the 0.99 numerical-safety clamp, not capped at 4x', () => {
    // 1 / (1 - min(util, 0.99))
    expect(saturationLatencyMultiplier(0)).toBeCloseTo(1, 5)
    expect(saturationLatencyMultiplier(0.5)).toBeCloseTo(2, 5)
    expect(saturationLatencyMultiplier(0.7)).toBeCloseTo(3.333, 2)
    expect(saturationLatencyMultiplier(0.9)).toBeCloseTo(10, 5)
    expect(saturationLatencyMultiplier(0.95)).toBeCloseTo(20, 5)
    expect(saturationLatencyMultiplier(0.99)).toBeCloseTo(100, 5)
    // Clamped at 0.99 for numerical safety near rho=1 — must never divide by (near-)zero.
    expect(saturationLatencyMultiplier(1)).toBeCloseTo(100, 5)
    expect(saturationLatencyMultiplier(2)).toBeCloseTo(100, 5)
    expect(Number.isFinite(saturationLatencyMultiplier(1))).toBe(true)
  })

  it('amplification at 0.95 is meaningfully higher than at 0.9, and both exceed the old ~4x ceiling', () => {
    const at90 = saturationLatencyMultiplier(0.9)
    const at95 = saturationLatencyMultiplier(0.95)

    // Old formula: 1 + ((util-0.7)/0.3)^2 * 3 -> 2.33x at 0.9, 3.06x at 0.95, capped at exactly
    // 4x only in the limit util -> 1. The new formula clears that ceiling well before util=0.95.
    expect(at95).toBeGreaterThan(at90)
    expect(at90).toBeGreaterThan(4)
    expect(at95).toBeGreaterThan(10)
  })
})

// Fake canvas: jsdom has no real 2D canvas context, so hand the engine a no-op context that
// satisfies every method call `advanceAndDraw` makes without needing to actually render anything.
function makeFakeCanvas(): HTMLCanvasElement {
  const ctx = {
    save() {}, restore() {}, beginPath() {}, closePath() {},
    moveTo() {}, lineTo() {}, arc() {}, arcTo() {}, stroke() {}, fill() {},
    clearRect() {}, setLineDash() {},
    strokeStyle: '', fillStyle: '', lineWidth: 0, globalAlpha: 1,
    shadowColor: '', shadowBlur: 0,
  }
  const canvas = {
    width: 800,
    height: 600,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON() {} }),
  }
  return canvas as unknown as HTMLCanvasElement
}

// Runs a 2-node (source -> target) fixture at a fixed edge RPS for `frames` frames and returns
// the final published batch of NodeMetrics for every node. The target's health state is forced
// 'healthy' so sustained near-saturation utilization doesn't trip the health-degradation/circuit-
// breaker feedback loop (errorOnset at 0.85 util -> degraded/down -> breaker opens -> inRps
// collapses) partway through the run — that feedback loop is real engine behavior but orthogonal
// to what this test needs to isolate: whether the saturation multiplier is applied to this node
// type at all.
async function runSteady(
  targetType: 'ec2' | 'dbSql' | 'queue',
  edgeRps: number,
  frames: number,
  edgeReadPercentage?: number,
): Promise<Map<string, NodeMetrics>> {
  const nodes: Node<NodeData>[] = [
    { id: 'src', type: 'cdn', position: { x: 0, y: 0 }, data: { label: 'src', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
    { id: 'dst', type: targetType, position: { x: 200, y: 0 }, data: { label: 'dst', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
  ]
  const edgeData: EdgeData = targetType === 'dbSql'
    // event edge (not 'request') so the dbUtil calc falls back to data.readPercentage instead of
    // methodDistribution.
    ? { label: '', edgeType: 'event', throughput: 0, latency: 0, readPercentage: edgeReadPercentage ?? 0 }
    : { label: '', edgeType: targetType === 'queue' ? 'event' : 'request', throughput: 0, latency: 0 }
  const edges: Edge<EdgeData>[] = [
    { id: 'e1', source: 'src', target: 'dst', type: edgeData.edgeType, data: edgeData },
  ]

  let rafCallback: ((t: number) => void) | null = null
  const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    rafCallback = cb as unknown as (t: number) => void
    return 1
  })
  const cafSpy = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {})

  try {
    useSimulationStore.getState().setRunning(true)
    useSimulationStore.getState().setPaused(false)
    useSimulationStore.getState().setEdgeRps('e1', edgeRps)

    const batches: Map<string, NodeMetrics>[] = []
    setCallbacks(
      (batch) => batches.push(new Map(batch)),
      () => {},
      () => {},
    )

    const canvas = makeFakeCanvas()
    startSimulation(canvas, nodes, edges, 1)
    // Runtime merge (effectiveConfig) spreads defaults < cloud presets < this override, so a
    // partial is fine at runtime; cast to satisfy setNodeConfigs's full-NodeSimConfig signature,
    // which real callers always populate via the fully-merged canvas store map.
    setNodeConfigs(new Map([['dst', { forcedHealthState: 'healthy' } as NodeSimConfig]]))

    let t = performance.now()
    expect(rafCallback).not.toBeNull()
    for (let i = 0; i < frames; i++) {
      t += 16
      const cb = rafCallback!
      rafCallback = null
      cb(t)
    }

    expect(batches.length).toBeGreaterThan(0)
    return batches[batches.length - 1]
  } finally {
    stopSimulation()
    useSimulationStore.getState().setRunning(false)
    rafSpy.mockRestore()
    cafSpy.mockRestore()
  }
}

describe('queueing-theoretic latency amplification is wired into node types', () => {
  beforeEach(() => {
    useSimulationStore.getState().reset?.()
  })

  afterEach(() => {
    stopSimulation()
    useSimulationStore.getState().setRunning(false)
  })

  it('a dbSql node driven near write-saturation shows amplified p99 latency versus a lightly loaded one', async () => {
    // dbSql: dbConfig.maxWriteRps = 500. readPercentage: 0 forces all traffic into writeRps so
    // edgeRps directly sets write utilization (dbUtil is computed instantaneously from inRps each
    // frame, not an integrator, so a long steady run settles cleanly).
    const lightly = await runSteady('dbSql', 25, 300, 0)   // ~5% write util
    const saturated = await runSteady('dbSql', 475, 300, 0) // ~95% write util

    const lightMetrics = lightly.get('dst')
    const satMetrics = saturated.get('dst')
    expect(lightMetrics?.p99LatencyMs).toBeGreaterThan(0)
    expect(satMetrics?.utilization).toBeGreaterThan(0.85)

    // Previously: cpuFactor's isCompute gate excluded dbSql entirely, so this ratio would be ~1x
    // (pure log-normal sampling noise) regardless of utilization. The fix must show a real jump.
    const ratio = (satMetrics?.p99LatencyMs ?? 0) / (lightMetrics?.p99LatencyMs ?? 1)
    expect(ratio).toBeGreaterThan(3)
  })

  it('a queue node driven near capacity shows amplified p99 latency versus a lightly loaded one', async () => {
    // queue: queueCapacity default 1000, no consumer edge -> queueDepth integrates inRps*dt every
    // tick with no drain, so depth/cap (the queue's utilization) climbs steadily. Particles need
    // ~100+ frames to travel an edge and be recorded (see PARTICLE_SPEED_BASE), so both runs need
    // enough frames for at least one arrival regardless of RPS. The "lightly loaded" RPS is kept
    // low enough that queueDepth never approaches capacity, but high enough (50 rps, well above
    // PARTICLE_REQUEST_RATIO's per-tick spawn-chance floor) that at least one particle reliably
    // arrives within the run — RPS=5 was occasionally too sparse to guarantee any arrival at all.
    // 300 frames (was 150): the lightly-loaded run at 50 rps depends on at least one sparse particle
    // completing its ~100-frame edge traversal AND landing in the final recorded batch. Under
    // full-suite ordering the global Math.random() position varies run-to-run, so 150 frames left
    // too thin a margin (~10% of full-suite runs recorded zero arrivals -> p99 = 0). This is a
    // pre-existing sparsity fragility (unrelated to the compute model — neither node here is ec2);
    // doubling the window makes an arrival reliable without changing the light-vs-saturated contrast.
    const lightly = await runSteady('queue', 50, 300)    // depth stays low -> low util
    const saturated = await runSteady('queue', 900, 300) // depth climbs toward capacity -> high util

    const lightMetrics = lightly.get('dst')
    const satMetrics = saturated.get('dst')
    expect(lightMetrics?.p99LatencyMs).toBeGreaterThan(0)
    expect(satMetrics?.utilization).toBeGreaterThan(0.5)

    // Previously: cpuFactor's isCompute gate excluded queue entirely, so this ratio would be ~1x
    // regardless of utilization. The fix must show a real jump.
    const ratio = (satMetrics?.p99LatencyMs ?? 0) / (lightMetrics?.p99LatencyMs ?? 1)
    expect(ratio).toBeGreaterThan(3)
  })
})
