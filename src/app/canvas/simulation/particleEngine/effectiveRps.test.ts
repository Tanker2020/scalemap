// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData, NodeSimConfig } from '../../../../lib/nodeConfig'
import { useSimulationStore, type NodeMetrics } from '../../../store/simulation.store'
import { startSimulation, stopSimulation, setCallbacks, setNodeConfigs, updateGlobalMultiplier } from '../particleEngine'

// Minimal 2-node, 1-edge fixture: a pure source (cdn — no thread-pool gate, no inbound edges,
// no circuit-breaker config) feeding a compute node, with edge RPS high enough that particle
// count exceeds MAX_PARTICLES (500) within the very first simulated frame.
const nodes: Node<NodeData>[] = [
  { id: 'src', type: 'cdn', position: { x: 0, y: 0 }, data: { label: 'cdn', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
  { id: 'dst', type: 'ec2', position: { x: 200, y: 0 }, data: { label: 'ec2', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
]
const edges: Edge<EdgeData>[] = [
  { id: 'e1', source: 'src', target: 'dst', type: 'request', data: { label: '', edgeType: 'request', throughput: 0, latency: 0 } },
]

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

describe('effectiveRps under particle-cap saturation', () => {
  let rafCallback: ((t: number) => void) | null = null
  let rafSpy: ReturnType<typeof vi.spyOn>
  let cafSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    rafCallback = null
    rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      rafCallback = cb as unknown as (t: number) => void
      return 1
    })
    cafSpy = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {})
    useSimulationStore.getState().setRunning(true)
    useSimulationStore.getState().setPaused(false)
    // Offered load far beyond MAX_PARTICLES(500) * PARTICLE_REQUEST_RATIO(10) per second, so the
    // 500-particle cap is hit on frame 1 and stays hit for the rest of the run.
    useSimulationStore.getState().setEdgeRps('e1', 1_000_000)
  })

  afterEach(() => {
    stopSimulation()
    useSimulationStore.getState().setRunning(false)
    rafSpy.mockRestore()
    cafSpy.mockRestore()
  })

  it('keeps advancing edge effectiveRps (via inRps) after the 500-particle visual cap is hit', () => {
    const batches: Map<string, NodeMetrics>[] = []
    setCallbacks(
      (batch) => batches.push(new Map(batch)),
      () => {},
      () => {},
    )

    const canvas = makeFakeCanvas()
    startSimulation(canvas, nodes, edges, 1)
    // 'dst' is ec2, which now carries a default thread-pool cap — under this test's deliberately
    // extreme 1,000,000rps overload, that would organically degrade health to 'down' and trip
    // 'e1's breaker (forceOpenBreakersForNode), collapsing inRps — a real, separate mechanism
    // this test isn't about. Force healthy to isolate what's actually under test: whether
    // effectiveRps/inRps keeps tracking globalMultiplier regardless of the particle-visual-cap.
    setNodeConfigs(new Map([['dst', { forcedHealthState: 'healthy' } as NodeSimConfig]]))

    // 'steady' traffic mode reads globalMultiplier directly (effectiveMultiplier's 'steady' case
    // returns it unchanged), so bumping it once per frame gives us a fully deterministic,
    // strictly-increasing offered-load signal — independent of any other gating in this fixture —
    // to distinguish "effectiveRps frozen at cap" from "effectiveRps still tracking offered load".
    let t = performance.now()
    expect(rafCallback).not.toBeNull()
    for (let i = 1; i <= 40; i++) {
      updateGlobalMultiplier(i) // 1, 2, 3, ... 40
      t += 16
      const cb = rafCallback!
      rafCallback = null
      cb(t)
    }

    // Metrics publish every 4th frame (METRICS_THROTTLE) — 40 frames should yield several batches,
    // spanning both the first (already-at-cap) frame and many frames well past it.
    expect(batches.length).toBeGreaterThan(4)

    const dstInRpsSeries = batches.map(b => b.get('dst')?.inRps ?? 0)

    // Bug reproduction: spawnParticles sums total particle count and does an early `return` once
    // total >= MAX_PARTICLES, before the per-edge loop that writes ep.effectiveRps ever runs for
    // that frame. Because our offered load overshoots the cap on frame 1, EVERY subsequent frame
    // hits that early return under the bug — so ep.effectiveRps (and therefore dst's inRps) freezes
    // at whatever it computed on frame 1 and never again reflects updateGlobalMultiplier's climb.
    // The fix keeps the effectiveRps bookkeeping loop unconditional, so inRps keeps climbing in
    // lockstep with globalMultiplier regardless of whether the visual particle cap is engaged.
    const allEqual = dstInRpsSeries.every(v => v === dstInRpsSeries[0])
    expect(allEqual).toBe(false)

    // Strictly increasing across the whole run (globalMultiplier only ever went up).
    for (let i = 1; i < dstInRpsSeries.length; i++) {
      expect(dstInRpsSeries[i]).toBeGreaterThan(dstInRpsSeries[i - 1])
    }
  })
})
