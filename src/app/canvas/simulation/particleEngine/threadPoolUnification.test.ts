// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData, NodeSimConfig, RequestEdgeConfig, ComputeProfile } from '../../../../lib/nodeConfig'
import { useSimulationStore, type NodeMetrics } from '../../../store/simulation.store'
import { startSimulation, stopSimulation, setCallbacks, setNodeConfigs } from '../particleEngine'
import { getActiveWorkers, clearBackpressureState } from './backpressure'
import { clearBreakers } from './circuitBreakers'
import { getChaosFailures, clearChaosState } from './chaos'

// caller: ec2 with NO inbound edges (a pure outbound source) and no explicit simConfig, so it
// gets NODE_SIM_DEFAULTS.ec2's default computeProfile/workload -- hardThreadCap for that default
// profile is 108 (see compute.test.ts's DEFAULT_EC2_COMPUTE_PROFILE-derived expectations).
// downstream: a plain dbSql target, just something for the request edge to point at.
const nodes: Node<NodeData>[] = [
  { id: 'caller', type: 'ec2', position: { x: 0, y: 0 }, data: { label: 'caller', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
  { id: 'downstream', type: 'dbSql', position: { x: 200, y: 0 }, data: { label: 'downstream', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
]
const edges: Edge<EdgeData>[] = [
  { id: 'e1', source: 'caller', target: 'downstream', type: 'request', data: { label: '', edgeType: 'request', throughput: 0, latency: 0 } },
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

describe('caller-side thread pool unifies with ec2 server-side capacity', () => {
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
    // Far exceeds 108 threads' worth of throughput -- particlesPerSec = 5000/10 = 500/s, so ~8
    // particles attempt to mint per 16ms frame, reaching the 108 cap well within 60 frames.
    useSimulationStore.getState().setEdgeRps('e1', 5000)
  })

  afterEach(() => {
    stopSimulation()
    useSimulationStore.getState().setRunning(false)
    rafSpy.mockRestore()
    cafSpy.mockRestore()
  })

  it('bounds caller.activeRequests at its own hardThreadCap (108), not the old independent 200-default pool', () => {
    const batches: Map<string, NodeMetrics>[] = []
    setCallbacks((batch) => batches.push(new Map(batch)), () => {}, () => {})

    const canvas = makeFakeCanvas()
    startSimulation(canvas, nodes, edges, 1)

    let t = performance.now()
    for (let i = 0; i < 60; i++) {
      const cb = rafCallback!
      rafCallback = null
      t += 16
      cb(t)
    }

    const callerActiveSeries = batches.map(b => b.get('caller')?.activeRequests ?? 0)
    const maxObserved = Math.max(...callerActiveSeries)
    // Before the fix: outbound calls acquired from an entirely separate _activeWorkers pool and
    // never touched _lbActiveRequests at all, so caller.activeRequests would stay 0 regardless of
    // outbound load. After the fix: outbound calls are tracked via the same counter/cap as inbound
    // admission, so it rises and is bounded at the node's REAL hardThreadCap (108), never the old
    // arbitrary 200 default.
    expect(maxObserved).toBeGreaterThan(0)
    expect(maxObserved).toBeLessThanOrEqual(108)
  })
})

// ─── Gap 1: retry-respawn admission must also unify for ec2/container ─────────
//
// spawnParticles' fresh-mint admission (tested above) unifies ec2/container onto their own
// server-side pool (_lbActiveRequests/hardThreadCap via trackRequest). processRetryQueue's
// re-mint of a *retried* particle is a structurally separate call site (mirrors spawnParticles'
// gate rather than sharing code with it) and, pre-fix, still unconditionally calls the OLD
// acquireWorkers(sourceNodeId, 1, maxThreads) for every THREAD_POOL_TYPES source -- including
// ec2/container, whose _activeWorkers entry is never populated by the unified fresh-spawn path,
// so it always finds room up to the old, arbitrary maxConcurrency ?? 200 default and silently
// re-admits a retry that should have been rejected by the node's real (much lower) hardThreadCap.
describe('retry re-spawn admission unifies with ec2 server-side capacity (#21 gap)', () => {
  // A tiny, explicit hardThreadCap (10) so exactly ONE particle (1 particle == PARTICLE_REQUEST_RATIO
  // == 10 real requests) fills the entire pool: activeAfter = (0+1)*10 = 10 <= 10 admits; any
  // further admission attempt computes (1+1)*10 = 20 > 10 and must be rejected.
  const lowCapProfile: ComputeProfile = {
    vCpu: 2, ramGiB: 4, architecture: 'x86_64', cpuFamily: 'test',
    baseClockGhz: 3.0, blockingIoModel: true, osBaseMemoryMb: 512, threadStackMb: 1,
    maxThreadsOverride: 10,
  }
  const retryNodes: Node<NodeData>[] = [
    { id: 'caller', type: 'ec2', position: { x: 0, y: 0 }, data: { label: 'caller', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
    { id: 'downstream', type: 'dbSql', position: { x: 200, y: 0 }, data: { label: 'downstream', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
  ]
  const retryConfig: RequestEdgeConfig['retryConfig'] = {
    maxRetries: 1,
    baseDelayMs: 60_000,
    jitter: 'equal',
    maxDelayMs: 60_000,
  }
  const retryEdges: Edge<EdgeData>[] = [
    {
      id: 'e1', source: 'caller', target: 'downstream', type: 'request',
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
    // High enough to guarantee >=1 spawn attempt on frame 1 (matches retryGating.test.ts's pattern).
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

  it('rejects a retried particle once the unified pool is already at cap, instead of silently admitting it via the old independent pool', () => {
    setCallbacks(() => {}, () => {}, () => {})

    const canvas = makeFakeCanvas()
    startSimulation(canvas, retryNodes, retryEdges, 1)

    // A huge baseLatencyMs so the ORIGINAL admitted particle's trackRequest-scheduled release
    // (wallTimeMs) never fires within this test's simulated-time window -- any drop in occupancy
    // we observe can only come from the drop/retry path, never from natural expiry.
    setNodeConfigs(new Map([['caller', {
      computeProfile: lowCapProfile,
      latencyModel: { p50Ms: 500_000, p99Ms: 600_000 },
    } as NodeSimConfig]]))

    // Every arrival at 'downstream' fails deterministically -- the one admitted particle will be
    // dropped on arrival, queuing exactly one retry (maxRetries: 1).
    getChaosFailures().set('downstream', { expiry: Infinity, mode: 'crash', dropRate: 1 })

    let t = performance.now()
    const step = (ms: number) => {
      t += ms
      const cb = rafCallback!
      rafCallback = null
      cb(t)
      expect(rafCallback).not.toBeNull()
    }

    // Frame 1: several spawn attempts on e1, but the unified gate admits exactly one (cap fills to
    // 10/10 on the very first admitted particle) -- further attempts this frame and any subsequent
    // fresh-spawn frame are rejected by the (already-fixed) main spawn-site gate, not the bug under
    // test here. getActiveWorkers('caller') must stay 0 throughout: fresh ec2 admission never
    // touches the old pool.
    step(16)
    expect(getActiveWorkers('caller')).toBe(0)

    // Advance enough frames for the one admitted particle to travel the edge and arrive (same
    // travel-time margin retryGating.test.ts uses).
    for (let i = 0; i < 200; i++) step(16)
    expect(getActiveWorkers('caller')).toBe(0)

    // The retry is now queued with fireAt far in the future (baseDelayMs/maxDelayMs = 60s).
    // Jump past it, then take a few normal frames so processRetryQueue's once-per-frame drain
    // actually observes fireAt <= now and attempts to re-mint the retried particle.
    step(70_000)
    for (let i = 0; i < 5; i++) step(16)

    // The unified pool is still fully occupied (the original particle's hold time, 500s+, has not
    // elapsed), so the retry re-spawn must be rejected by the SAME unified gate the fresh-spawn
    // site uses -- never by falling through to the old, independent acquireWorkers pool. Under the
    // pre-fix bug, processRetryQueue calls acquireWorkers(sourceNodeId, 1, maxConcurrency ?? 200)
    // unconditionally for ec2/container sources; since ec2's fresh-spawn path never touches
    // _activeWorkers, that pool reads 0 active and happily admits the retry, driving
    // getActiveWorkers('caller') to 1 -- exactly what this assertion catches.
    expect(getActiveWorkers('caller')).toBe(0)
  })
})

// ─── Gap 2: fast-fail release must also unify for ec2/container ───────────────
//
// A 503/rejection on an outbound call is a fast response -- pre-existing intent (predating the
// ec2/container unification) is that the source's worker slot is freed immediately, not held
// until the full wall-time estimate elapses. Post-unification, ec2/container's slot lives in
// _lbActiveRequests (populated by trackRequest), not the old _activeWorkers map -- so the
// immediate-release call sites (handleRequestTimeout, dropParticle), which still unconditionally
// call releaseWorkerNow (a no-op against _lbActiveRequests), silently stopped freeing the slot for
// ec2/container. This leaves a dropped/timed-out outbound call occupying its slot for the full
// scheduled hold duration instead of releasing right away.
describe('fast-fail release unifies with ec2 server-side capacity (#21 gap)', () => {
  const lowCapProfile: ComputeProfile = {
    vCpu: 2, ramGiB: 4, architecture: 'x86_64', cpuFamily: 'test',
    baseClockGhz: 3.0, blockingIoModel: true, osBaseMemoryMb: 512, threadStackMb: 1,
    maxThreadsOverride: 10,
  }
  const dropNodes: Node<NodeData>[] = [
    { id: 'caller', type: 'ec2', position: { x: 0, y: 0 }, data: { label: 'caller', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
    { id: 'downstream', type: 'dbSql', position: { x: 200, y: 0 }, data: { label: 'downstream', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
  ]
  const dropEdges: Edge<EdgeData>[] = [
    { id: 'e1', source: 'caller', target: 'downstream', type: 'request', data: { label: '', edgeType: 'request', throughput: 0, latency: 0 } },
  ]

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

  it('drops caller.activeRequests back to 0 immediately after a dropped outbound call, not after the full hold duration', () => {
    const batches: Map<string, NodeMetrics>[] = []
    setCallbacks((batch) => batches.push(new Map(batch)), () => {}, () => {})

    const canvas = makeFakeCanvas()
    startSimulation(canvas, dropNodes, dropEdges, 1)

    // Huge baseLatencyMs: the admitted particle's trackRequest-scheduled release (wallTimeMs) is
    // ~500s+ away -- far beyond this test's simulated-time window -- so any observed drop back to
    // 0 can only be the immediate fast-fail release under test, never natural expiry.
    setNodeConfigs(new Map([['caller', {
      computeProfile: lowCapProfile,
      latencyModel: { p50Ms: 500_000, p99Ms: 600_000 },
    } as NodeSimConfig]]))

    // Every arrival at 'downstream' fails deterministically, so the one admitted particle is
    // guaranteed to be dropped (not succeed) when it arrives.
    getChaosFailures().set('downstream', { expiry: Infinity, mode: 'crash', dropRate: 1 })

    let t = performance.now()
    const step = (ms: number) => {
      t += ms
      const cb = rafCallback!
      rafCallback = null
      cb(t)
      expect(rafCallback).not.toBeNull()
    }

    // Frame 1: exactly one particle is admitted (cap fills to 10/10, hardThreadCap=10). Metrics
    // are throttled to once every METRICS_THROTTLE(4) frames, so step 4 frames to guarantee a
    // batch has actually been flushed — well within the ~130-frame travel time, so the admitted
    // particle is still in flight (not yet arrived/dropped) when this batch is captured.
    for (let i = 0; i < 4; i++) step(16)
    const afterAdmit = batches[batches.length - 1]?.get('caller')?.activeRequests ?? 0
    expect(afterAdmit).toBe(10) // 1 raw particle * PARTICLE_REQUEST_RATIO(10)

    // Stop any further FRESH spawns from 'caller' now (chaos crash on the SOURCE zeroes
    // downstreamFactor for its outbound edges — same technique retryGating.test.ts uses) so the
    // pool, once released, cannot be immediately refilled by a brand-new admission. Without this,
    // the moment the one in-flight particle's slot is released, edge e1's still-high configured
    // RPS would legitimately re-fill the cap with a fresh particle before this test ever
    // observes the released (0) state -- a test-timing issue, not a functional one.
    getChaosFailures().set('caller', { expiry: Infinity, mode: 'crash', dropRate: 1 })

    // Advance enough frames for the one admitted particle to travel the edge, arrive at
    // 'downstream', and be dropped by the deterministic chaos failure (same travel-time margin as
    // elsewhere in this file / retryGating.test.ts).
    for (let i = 0; i < 200; i++) step(16)

    // The call failed fast (a drop is a fast response, not a slow success) -- the source's slot
    // must already be freed, not held for the full ~500s wall-time estimate. Under the pre-fix
    // bug, dropParticle calls releaseWorkerNow unconditionally, which is a no-op against
    // _lbActiveRequests for ec2/container, so caller.activeRequests would still read 10 here.
    const afterDrop = batches[batches.length - 1]?.get('caller')?.activeRequests ?? -1
    expect(afterDrop).toBe(0)
  })
})
