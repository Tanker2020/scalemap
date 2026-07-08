// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData, NodeType, RequestEdgeConfig } from '../../../../lib/nodeConfig'
import { useSimulationStore, type NodeMetrics } from '../../../store/simulation.store'
import { startSimulation, stopSimulation, setCallbacks } from '../particleEngine'
import { clearBreakers } from './circuitBreakers'
import { clearBackpressureState } from './backpressure'
import { clearChaosState } from './chaos'

// Regression coverage for the bug this fix addresses: forwarded/relayed particles (minted
// directly by the LB's round-robin block or forwardToOutbound — see particleEngine.ts) never
// used to touch EdgePath.effectiveRps, so a node fed purely by forwarding always reported
// inRps/outRps = 0 in Analytics despite particles visibly flowing. Worse, that false 0 inRps
// tripped the idle-RPS gate in spawnParticles, throttling the receiving node's OWN outbound
// edges toward zero too — cascading the failure past the immediate forwarding hop.

const reqConfig: RequestEdgeConfig = {
  methodDistribution: { GET: 100, POST: 0, PUT: 0, DELETE: 0 },
  timeoutMs: 30_000,
  retryConfig: { maxRetries: 0, baseDelayMs: 100, jitter: 'full', maxDelayMs: 1000 },
}

function node(id: string, type: NodeType): Node<NodeData> {
  return { id, type, position: { x: 0, y: 0 }, data: { label: id, subtitle: '', status: 'healthy', notes: '', warnings: [] } }
}
function reqEdge(id: string, source: string, target: string): Edge<EdgeData> {
  return {
    id, source, target, type: 'request',
    data: { label: '', edgeType: 'request', throughput: 0, latency: 0, config: reqConfig } as EdgeData,
  }
}

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

describe('forwarded traffic is reflected in effectiveRps-derived metrics', () => {
  let rafCallback: ((t: number) => void) | null = null
  let rafSpy: ReturnType<typeof vi.spyOn>
  let cafSpy: ReturnType<typeof vi.spyOn>
  let t = 0

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

  function step(): void {
    t += 16
    const cb = rafCallback!
    rafCallback = null
    cb(t)
    expect(rafCallback).not.toBeNull()
  }

  it('propagates end-to-end through an LB (cdn -> lb -> 2 servers -> db) without starving the servers\' own configured outbound traffic, and never reverts to noisy on/off reporting', () => {
    // cdn (unrestricted origin) -> loadBalancer (forward-only, per FORWARD_ONLY_NODE_TYPES) ->
    // 2x ec2 servers (each with a REAL configured outbound edge to db) -> dbSql.
    const nodes: Node<NodeData>[] = [
      node('src', 'cdn'), node('lb', 'loadBalancer'),
      node('s1', 'ec2'), node('s2', 'ec2'), node('db', 'dbSql'),
    ]
    const edges: Edge<EdgeData>[] = [
      reqEdge('src-lb', 'src', 'lb'),
      reqEdge('lb-s1', 'lb', 's1'),
      reqEdge('lb-s2', 'lb', 's2'),
      reqEdge('s1-db', 's1', 'db'),
      reqEdge('s2-db', 's2', 'db'),
    ]

    // rps must be set BEFORE startSimulation — ep.rps is snapshotted there.
    // 200 total (~100/server after the LB's round-robin split) -- deliberately well under the
    // default EC2 compute profile's ~240rps CPU-saturation point (DEFAULT_EC2_COMPUTE_PROFILE /
    // DEFAULT_PACKET_WORKLOAD, see compute.ts). This test verifies forwarded-traffic visibility to
    // the idle-RPS gate, not compute saturation -- 500 (250/server) used to be "free" under the
    // old static-latency model but now realistically saturates s1/s2's CPU, causing real errors
    // that trip their inbound circuit breaker and (correctly) quiet their own outbound too. That
    // cascade is real, intended behavior once CPU saturation has teeth (see the compute
    // admission/latency fix plan) -- it's just a different concern than this test exists to check.
    useSimulationStore.getState().setEdgeRps('src-lb', 200)
    // lb-s1/lb-s2 would be force-zeroed regardless (loadBalancer is forward-only) — set to 0
    // explicitly for clarity; the ONLY way traffic appears on them is the LB's forwarding.
    useSimulationStore.getState().setEdgeRps('lb-s1', 0)
    useSimulationStore.getState().setEdgeRps('lb-s2', 0)
    // Each server's OWN real, independently-configured outbound call to the database — this is
    // exactly the traffic the idle-RPS gate incorrectly strangled under the bug, since it read
    // each server's inRps as permanently 0 (forwarded traffic was invisible to it).
    useSimulationStore.getState().setEdgeRps('s1-db', 50)
    useSimulationStore.getState().setEdgeRps('s2-db', 50)

    const batches: Map<string, NodeMetrics>[] = []
    setCallbacks((batch) => batches.push(new Map(batch)), () => {}, () => {})
    startSimulation(makeFakeCanvas(), nodes, edges, 1)
    expect(rafCallback).not.toBeNull()

    // Generous warm-up: a particle needs ~130 frames worst-case to traverse src->lb before the
    // LB's first forward can even happen; then the forwarded-rate EMA (per-frame) and the
    // idle-gate's own metrics-tick-smoothed inRps (every 4th frame, itself EMA'd at publish) need
    // further frames to converge before s1/s2's OWN outbound (s1-db/s2-db) fully reopens.
    for (let i = 0; i < 900; i++) step()

    // Collect a trailing window of published batches (not just the last one) to also prove the
    // fix doesn't just "eventually" show a number but doesn't bounce back to a false 0 — a naive
    // unsmoothed forwarded-count implementation would intermittently read exactly 0 here.
    const trailing: Map<string, NodeMetrics>[] = []
    for (let i = 0; i < 40; i++) {
      const before = batches.length
      step()
      for (let j = before; j < batches.length; j++) trailing.push(batches[j])
    }

    expect(trailing.length).toBeGreaterThan(0)
    const last = trailing[trailing.length - 1]

    const lb = last.get('lb')!
    const s1 = last.get('s1')!
    const s2 = last.get('s2')!
    const db = last.get('db')!

    // The LB forwards real traffic — its outRps must no longer read 0.
    expect(lb.outRps).toBeGreaterThan(0)
    // Both servers must see the forwarded traffic land as real inRps.
    expect(s1.inRps).toBeGreaterThan(0)
    expect(s2.inRps).toBeGreaterThan(0)
    // Each server's OWN configured 50rps call to the database must stay near its configured
    // value, not collapse toward 0 via the idle-gate cascade (loose bound: well above 0, and
    // clearly not strangled — 20 is 40% of the configured 50, safe against smoothing lag).
    expect(s1.outRps).toBeGreaterThan(20)
    expect(s2.outRps).toBeGreaterThan(20)
    // The database sees the servers' real outbound traffic land as real inRps.
    expect(db.inRps).toBeGreaterThan(20)

    // Noise-damping: across the trailing window, s1/s2's inRps must never read exactly 0 once
    // traffic is flowing — a hallmark of a raw reset-and-divide-per-frame counter (mostly 0,
    // occasionally a huge spike) rather than the required EMA-smoothed signal.
    const s1InRpsSamples = trailing.map(b => b.get('s1')?.inRps ?? 0)
    const s2InRpsSamples = trailing.map(b => b.get('s2')?.inRps ?? 0)
    expect(s1InRpsSamples.every(v => v > 0)).toBe(true)
    expect(s2InRpsSamples.every(v => v > 0)).toBe(true)
  })

  it('adds forwarded traffic on top of (not instead of) apiGateway\'s own configured outbound rps', () => {
    // cdn -> apiGateway -> 2x ec2. apiGateway is deliberately excluded from
    // FORWARD_ONLY_NODE_TYPES (unlike loadBalancer) — it's a legitimate internet-facing origin,
    // so its outbound edges may carry a real configured rps AND simultaneously receive forwarded
    // traffic via the same round-robin/least-connections block loadBalancer uses. The fold-in
    // must be additive, never a replacement.
    //
    // (k8sCluster/ecsCluster/dockerCompose were considered for this fixture but are GROUPING_TYPES
    // container nodes — updateAllNodeMetrics explicitly skips publishing metrics for them, so
    // their own inRps never reaches _smoothedMetrics and the idle-RPS gate can never see it,
    // permanently throttling their outbound edges regardless of this fix. apiGateway has no such
    // issue: it's a normal leaf node with real published metrics.)
    const nodes: Node<NodeData>[] = [
      node('src', 'cdn'), node('gw', 'apiGateway'), node('dst1', 'ec2'), node('dst2', 'ec2'),
    ]
    const edges: Edge<EdgeData>[] = [
      reqEdge('src-gw', 'src', 'gw'),
      reqEdge('gw-dst1', 'gw', 'dst1'),
      reqEdge('gw-dst2', 'gw', 'dst2'),
    ]

    // 200 total (~100/edge after round-robin + dst1's own 30 = ~130 at dst1) -- well under the
    // default EC2 profile's ~240rps CPU-saturation point, for the same reason as the LB test
    // above: this test verifies additive forwarded-traffic accounting, not compute saturation.
    useSimulationStore.getState().setEdgeRps('src-gw', 200)
    // gw-dst1 carries its OWN real configured rps of 30 — unaffected by any restriction, since
    // apiGateway is not forward-only. The round-robin block also picks between gw-dst1 and
    // gw-dst2 for each arrival, so gw-dst1 additionally receives a share of forwarded traffic.
    useSimulationStore.getState().setEdgeRps('gw-dst1', 30)
    useSimulationStore.getState().setEdgeRps('gw-dst2', 0)

    const batches: Map<string, NodeMetrics>[] = []
    setCallbacks((batch) => batches.push(new Map(batch)), () => {}, () => {})
    startSimulation(makeFakeCanvas(), nodes, edges, 1)
    expect(rafCallback).not.toBeNull()

    for (let i = 0; i < 500; i++) step()

    const last = batches[batches.length - 1]
    const dst1 = last.get('dst1')!

    // If the fold-in were a REPLACEMENT rather than additive, this would cap near the forwarded
    // contribution alone or the configured 30 alone. With ~500rps landing at the gateway and
    // being split roughly evenly across 2 outbound edges, the forwarded share alone dwarfs the
    // configured 30 — so a comfortable margin above 30 (well beyond smoothing noise) proves both
    // contributions are present simultaneously.
    expect(dst1.inRps).toBeGreaterThan(60)
  })
})
