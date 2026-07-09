// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData, RequestEdgeConfig } from '../../../../lib/nodeConfig'
import { useSimulationStore } from '../../../store/simulationLegacy.store'
import { startSimulation, stopSimulation, setCallbacks, getParticleCountForEdge } from '../particleEngine'
import { getBreaker, clearBreakers } from './circuitBreakers'
import { clearBackpressureState } from './backpressure'
import { getChaosFailures, clearChaosState } from './chaos'

// Minimal 2-node, 1-edge fixture: a pure source (cdn) feeding a compute node (ec2, which owns
// a thread pool and a circuit breaker per NODE_SIM_DEFAULTS) over a single request edge. The
// edge carries a small, tightly-bounded retry config so the retry's fire time is deterministic
// within a handful of frames.
// maxRetries: 1 — a single retry attempt keeps the fixture's state space small: once that one
// retry has been processed (admitted or suppressed), the retry queue goes quiet and there is no
// risk of a second retry re-arming mid-assertion-window.
// baseDelayMs/maxDelayMs are deliberately large (tens of seconds, well beyond the wall-clock
// window the test advances through for the initial spawn-travel-arrive sequence) so the retry's
// fireAt can never elapse before the test has had a chance to force the circuit open — the retry
// firing "too early" (i.e. while the circuit is still closed) was the exact source of an earlier,
// flaky version of this test.
const retryConfig: RequestEdgeConfig['retryConfig'] = {
  maxRetries: 1,
  baseDelayMs: 60_000,
  jitter: 'equal', // equal jitter: delay in [exp/2, exp] — bounded, no full-random(0, exp) spread
  maxDelayMs: 60_000,
}

const nodes: Node<NodeData>[] = [
  { id: 'src', type: 'cdn', position: { x: 0, y: 0 }, data: { label: 'cdn', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
  { id: 'dst', type: 'ec2', position: { x: 200, y: 0 }, data: { label: 'ec2', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
]
const edges: Edge<EdgeData>[] = [
  {
    id: 'e1', source: 'src', target: 'dst', type: 'request',
    data: {
      label: '', edgeType: 'request', throughput: 0, latency: 0,
      config: {
        methodDistribution: { GET: 100, POST: 0, PUT: 0, DELETE: 0 },
        timeoutMs: 30_000,
        retryConfig,
      } satisfies RequestEdgeConfig,
    },
  },
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

describe('retry admission checks (#8)', () => {
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
    clearBreakers()
    clearBackpressureState()
    clearChaosState()
    useSimulationStore.getState().setRunning(true)
    useSimulationStore.getState().setPaused(false)
    // High enough RPS that spawnChance = (rps/PARTICLE_REQUEST_RATIO) * (delta/1000) comfortably
    // exceeds 1 on the very first frame — guarantees a deterministic (non-RNG-dependent) particle
    // count on frame 1, rather than leaving "does at least one particle spawn" to chance.
    // NOTE: `ep.rps` is snapshotted once at startSimulation() from getEdgeRps and never re-read
    // per frame, so this cannot be throttled down mid-run via setEdgeRps — fresh spawning is
    // instead cut off after frame 1 by forcing chaos 'crash' on the source node (see test body),
    // which zeroes spawnParticles' downstreamFactor for every outbound edge off that node.
    useSimulationStore.getState().setEdgeRps('e1', 1000)
  })

  afterEach(() => {
    stopSimulation()
    useSimulationStore.getState().setRunning(false)
    clearBreakers()
    clearBackpressureState()
    clearChaosState()
    rafSpy.mockRestore()
    cafSpy.mockRestore()
  })

  it('does not re-spawn a retried particle onto an edge whose circuit is open', () => {
    setCallbacks(() => {}, () => {}, () => {})

    const canvas = makeFakeCanvas()
    startSimulation(canvas, nodes, edges, 1)
    expect(rafCallback).not.toBeNull()

    // Force every arrival at 'dst' to fail deterministically (chaos crash: dropRate 1, no RNG
    // needed) so the first particle that reaches 'dst' is dropped and a retry is enqueued for e1.
    getChaosFailures().set('dst', { expiry: Infinity, mode: 'crash', dropRate: 1 })

    let t = performance.now()
    let maxParticlesSeen = 0
    const step = (ms: number) => {
      t += ms
      const cb = rafCallback!
      rafCallback = null
      cb(t)
      expect(rafCallback).not.toBeNull()
      maxParticlesSeen = Math.max(maxParticlesSeen, getParticleCountForEdge('e1'))
    }

    // Frame 1: spawnChance = (1000/10) * (16/1000) = 1.6, guaranteeing >=1 particle minted onto
    // e1 with no dependence on Math.random(). Immediately force chaos 'crash' on the SOURCE node
    // afterward (downstreamFactor -> 0 in spawnParticles for every edge off 'src') so no further
    // frames mint fresh particles — only the one (or few) spawned here will travel and arrive.
    step(16)
    getChaosFailures().set('src', { expiry: Infinity, mode: 'crash', dropRate: 1 })

    // Advance enough further frames for the spawned particle(s) to travel the full edge and
    // arrive. p.t advances by `speed * dt` per frame, speed = PARTICLE_SPEED_BASE(0.0006) *
    // [0.8, 1.2] — worst case (slowest sample) needs t=1 / (0.0006*0.8*16) ≈ 130 frames; 200 is a
    // generous margin.
    for (let i = 0; i < 200; i++) step(16)

    // No further arrivals need to fail; the one allowed retry (maxRetries: 1) is already queued,
    // with a fireAt far in the future (baseDelayMs/maxDelayMs = 60s) — guaranteed not to have
    // elapsed yet at this point in wall-clock `t`.
    getChaosFailures().delete('dst')

    // Force the edge's circuit open now, comfortably before the retry's backoff elapses — this is
    // the scenario the bug under-models: retries should feel the circuit-open gate exactly like a
    // fresh spawn would.
    getBreaker('e1').state = 'open'
    getBreaker('e1').openedAt = t

    // Reset the max-seen tracker: from here on, the only legitimate source of a particle on e1
    // would be the queued retry re-minting (fresh spawns are stopped, chaos is cleared).
    maxParticlesSeen = 0

    // Jump well past the retry's fire delay (60s) in one large step, then take a few normal
    // frames so processRetryQueue's once-per-frame drain actually observes fireAt <= now.
    // maxParticlesSeen catches a transient mint even if the retried particle would itself
    // immediately arrive and drop again within this window (maxRetries:1 means no further retry
    // gets queued after this one, so nothing else can appear afterward either).
    step(70_000)
    for (let i = 0; i < 5; i++) step(16)

    // Assert: no new particle ever appeared on e1 — the retry was suppressed by the open circuit,
    // not silently minted. Under the bug, processRetryQueue mints the retry unconditionally into
    // state.particles regardless of the now-open circuit.
    expect(maxParticlesSeen).toBe(0)
  })
})
