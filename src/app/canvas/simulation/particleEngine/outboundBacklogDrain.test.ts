// @vitest-environment jsdom
//
// Regression test for the idle-RPS gate zeroing a node's outbound edges based purely on its
// own EMA-smoothed inRps, ignoring any accepted in-flight backlog — instead of trickling
// outbound proportional to that backlog. A real server keeps draining requests it already
// accepted even after its caller (here, an upstream breaker tripping) stops sending new ones.
//
// Root-cause note on the test's own design: `_smoothedMetrics.inRps` (what the idle-RPS gate
// reads) is EMA-smoothed (alpha 0.25), so it already decays gradually on its own once the
// breaker trips — a short post-trip observation window never even reaches the point where the
// gate engages (smoothed inRps < IDLE_RPS_THRESHOLD=5), so a naive short-window test can't
// discriminate fixed vs. unfixed code. This test instead:
//   1. Overrides `srv`'s config (via setNodeConfigs) with a long processingMs (2000ms) and a
//      generous maxThreads (thread-pool model, not rate-integrated) so admitted requests stay
//      "active" in `_lbActiveRequests` — the idle gate's backlog signal for non-queue types —
//      for a long time after arrival, letting real in-flight concurrency build up toward a
//      Little's-Law steady state during warmup instead of draining within a couple of frames.
//      forcedHealthState keeps srv's own inbound breaker from organically tripping during
//      warmup — this test controls the trip manually, at a specific frame, to isolate the
//      idle-gate's trickle behavior specifically.
//   2. Warms up 150 frames (long enough for in-flight concurrency to approach steady state)
//      before tripping the breaker, then samples the 24th post-trip metrics batch for 'srv'
//      (empirically the point where inRps has decayed below the idle threshold and the
//      backlog term reliably dominates) — see the assertion below for the current bound.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData, NodeSimConfig } from '../../../../lib/nodeConfig'
import { useSimulationStore, type NodeMetrics } from '../../../store/simulation.store'
import { startSimulation, stopSimulation, setCallbacks, setNodeConfigs } from '../particleEngine'
import { getBreaker, clearBreakers } from './circuitBreakers'

// 3-node chain: lb -> srv -> db. lb is an apiGateway (a legitimate internet-facing origin, unlike
// loadBalancer, so it may carry an independently-configured outbound RPS) acting as a pure entry
// point with no inbound edges of its own. srv's inbound edge (lb->srv) breaker will be forced
// open, cutting srv's live inRps toward 0 — srv's OWN outbound edge (srv->db) is what we're
// checking: it should trickle from srv's accepted backlog rather than snap to the
// pure-inRps-decay curve.
const nodes: Node<NodeData>[] = [
  { id: 'lb',  type: 'apiGateway', position: { x: 0, y: 0 },   data: { label: 'lb',  subtitle: '', status: 'healthy', notes: '', warnings: [] } },
  { id: 'srv', type: 'ec2',          position: { x: 200, y: 0 }, data: { label: 'srv', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
  { id: 'db',  type: 'dbSql',        position: { x: 400, y: 0 }, data: { label: 'db',  subtitle: '', status: 'healthy', notes: '', warnings: [] } },
]
const edges: Edge<EdgeData>[] = [
  { id: 'e1', source: 'lb',  target: 'srv', type: 'request', data: { label: '', edgeType: 'request', throughput: 0, latency: 0 } },
  { id: 'e2', source: 'srv', target: 'db',  type: 'request', data: { label: '', edgeType: 'request', throughput: 0, latency: 0 } },
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
    width: 800, height: 600,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON() {} }),
  }
  return canvas as unknown as HTMLCanvasElement
}

describe('outbound trickles from the accepted backlog when inbound is breaker-gated', () => {
  let rafCallback: ((t: number) => void) | null = null
  let rafSpy: ReturnType<typeof vi.spyOn>
  let cafSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    clearBreakers()
    rafCallback = null
    rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      rafCallback = cb as unknown as (t: number) => void
      return 1
    })
    cafSpy = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {})
    useSimulationStore.getState().setRunning(true)
    useSimulationStore.getState().setPaused(false)
    useSimulationStore.getState().setEdgeRps('e1', 500)
    useSimulationStore.getState().setEdgeRps('e2', 500)
  })

  afterEach(() => {
    stopSimulation()
    useSimulationStore.getState().setRunning(false)
    rafSpy.mockRestore()
    cafSpy.mockRestore()
  })

  it('keeps srv->db outRps well above the pure-inRps-decay curve while srv drains its accepted backlog', () => {
    // Thread-pool model: the idle-gate's backlog reference for ec2/container is the discrete
    // `_lbActiveRequests` in-flight counter (see particleEngine.ts's idle-RPS gate), which
    // trackRequest increments on arrival and decrements after processingMs. maxThreads (200) is
    // deliberately set BELOW the ~500-1000rps natural demand so the thread pool saturates and
    // stays pinned at capacity during warmup (mirroring the old test's maxRps-below-demand
    // setup) — a long processingMs (2000ms) then makes that pinned backlog drain visibly over
    // ~2s once inbound stops, instead of within a couple of frames.
    // computeProfile/workload explicitly cleared: NODE_SIM_DEFAULTS.ec2 now carries a default
    // compute profile (EC2 v1 compute model), and effectiveConfig merges as
    // {...defaults, ...override} — without this override the merged config would still resolve
    // a profile and this node would be routed through the RAM/CPU-bound admission gate instead
    // of the fixed-maxThreads legacy path this test is specifically exercising.
    setNodeConfigs(new Map<string, NodeSimConfig>([
      ['srv', { processingMs: 2000, errorRate: 0, forcedHealthState: 'healthy', maxThreads: 200, computeProfile: undefined, workload: undefined } as NodeSimConfig],
    ]))

    const batches: Map<string, NodeMetrics>[] = []
    setCallbacks((batch) => { for (const [k, v] of batch) batches.push(new Map([[k, v]])) }, () => {}, () => {})

    const canvas = makeFakeCanvas()
    startSimulation(canvas, nodes, edges, 1)

    // Warm up long enough for srv to accept real in-flight requests (trackRequest increments
    // _lbActiveRequests on arrival) and reach steady state before the breaker trips.
    let t = performance.now()
    for (let i = 0; i < 150; i++) {
      const cb = rafCallback!
      rafCallback = null
      t += 16
      cb(t)
    }

    // Trip srv's inbound breaker open and collect every subsequent published srv metrics tick.
    getBreaker('e1').state = 'open'
    const srvOutRpsTicks: number[] = []
    for (let i = 0; i < 150; i++) {
      const before = batches.length
      const cb = rafCallback!
      rafCallback = null
      t += 16
      cb(t)
      for (let j = before; j < batches.length; j++) {
        const s = batches[j].get('srv')
        if (s) srvOutRpsTicks.push(s.outRps)
      }
    }

    // 24th post-trip metrics batch (0-indexed): empirically the smoothed inRps has decayed
    // below IDLE_RPS_THRESHOLD (5) by this point (gate engaged) while srv's in-flight backlog
    // (kept alive by the long processingMs override) has not yet drained. Without the backlog
    // trickle this value would be a deterministic function of inRps alone; with it, srv's
    // still-substantial in-flight count keeps outRps meaningfully elevated above that curve.
    expect(srvOutRpsTicks.length).toBeGreaterThan(23)
    expect(srvOutRpsTicks[23]).toBeGreaterThan(200)
  })
})
