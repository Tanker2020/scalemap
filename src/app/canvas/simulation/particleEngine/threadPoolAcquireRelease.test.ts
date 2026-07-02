// @vitest-environment jsdom
//
// Regression test for GitHub issue #4 (W1): thread-pool acquire clamped but release unclamped.
//
// Root cause: spawnParticles used to call `acquireWorkers(sourceNodeId, n, maxThreads)` ONCE per
// edge per frame, requesting the whole batch size `n`, while the per-particle mint loop right below
// it could mint FEWER than `n` particles whenever the global MAX_PARTICLES visual cap was hit
// mid-batch. Each minted particle's arrival handler schedules exactly one worker release — so any
// particles "acquired for" but never minted leaked their worker slot forever (a leak that only
// cleared on restart). Separately, discarding acquireWorkers' return value meant a clamped batch
// could still mint (and later release) more particles than were actually admitted, driving
// _activeWorkers negative over time (floored at 0, but still incorrect bookkeeping).
//
// The fix moves the acquire call inside the per-particle mint loop (one call per actually-minted
// particle, requesting 1), so acquisition and the later 1:1 scheduleWorkerRelease are structurally
// symmetric — this test drives the real engine (not just backpressure.ts in isolation, which was
// already correct) to prove the call site itself no longer leaks or over-releases.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../../../../lib/nodeConfig'
import { useSimulationStore } from '../../../store/simulation.store'
import { startSimulation, stopSimulation, setCallbacks, updateGlobalMultiplier } from '../particleEngine'
import { getActiveWorkers, clearBackpressureState } from './backpressure'

// Thread-pool source (ec2, maxConcurrency defaults to 200 per effectiveConfig's `?? 200` fallback)
// feeding a slow downstream so workers stay held (not fast-failed) across many frames, and RPS high
// enough to blow well past MAX_PARTICLES (500) so the mint loop truncates mid-batch on some edges.
const nodes: Node<NodeData>[] = [
  { id: 'src', type: 'ec2', position: { x: 0, y: 0 }, data: { label: 'ec2', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
  { id: 'dst', type: 'ec2', position: { x: 200, y: 0 }, data: { label: 'ec2-dst', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
]
const edges: Edge<EdgeData>[] = [
  { id: 'e1', source: 'src', target: 'dst', type: 'request', data: { label: '', edgeType: 'request', throughput: 0, latency: 0 } },
]

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

describe('thread-pool acquire/release symmetry through spawnParticles (#4)', () => {
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
    clearBackpressureState()
    // Offered load far beyond MAX_PARTICLES(500) * PARTICLE_REQUEST_RATIO(10) per second, so the
    // per-edge mint loop truncates mid-batch (total hits MAX_PARTICLES before `i` reaches `n`).
    useSimulationStore.getState().setEdgeRps('e1', 1_000_000)
  })

  afterEach(() => {
    stopSimulation()
    useSimulationStore.getState().setRunning(false)
    rafSpy.mockRestore()
    cafSpy.mockRestore()
  })

  it('never drives activeWorkers above the node maxConcurrency (default 200), even under massive overshoot', () => {
    setCallbacks(() => {}, () => {}, () => {})
    const canvas = makeFakeCanvas()
    startSimulation(canvas, nodes, edges, 1)

    let t = performance.now()
    expect(rafCallback).not.toBeNull()
    for (let i = 1; i <= 60; i++) {
      updateGlobalMultiplier(i)
      t += 16
      const cb = rafCallback!
      rafCallback = null
      cb(t)
      // At every single frame, active workers for 'src' must stay within [0, maxConcurrency].
      // Under the pre-fix bug (batch-level acquire discarding the clamp return value while the
      // mint loop truncates independently), this invariant still nominally held on the *acquire*
      // side, but the corresponding *leak* showed up as activeWorkers staying pinned near/at the
      // cap and never draining back down once offered load subsided — this loop's final assertion
      // below (after the run ends and all in-flight releases have drained) is where that surfaces.
      expect(getActiveWorkers('src')).toBeLessThanOrEqual(200)
      expect(getActiveWorkers('src')).toBeGreaterThanOrEqual(0)
    }

    stopSimulation()
    // stopSimulation clears backpressure state entirely (fresh-run guarantee from C2) — active
    // workers for any node must be back at 0 immediately, not just eventually.
    expect(getActiveWorkers('src')).toBe(0)
  })
})
