// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData, RequestEdgeConfig } from '../../../../lib/nodeConfig'
import { useSimulationStore } from '../../../store/simulation.store'
import { startSimulation, stopSimulation, setCallbacks, getParticleCountForEdge } from '../particleEngine'
import { getBreaker, clearBreakers } from './circuitBreakers'
import { clearBackpressureState } from './backpressure'
import { clearChaosState } from './chaos'

// Reproduces the reported bug: an API-gateway/LB fronting two backends. When BOTH backend
// breakers are open, the LB must reject the request itself (503) rather than forward a particle
// onto a tripped edge. The forwarding mint (`_lbp` in handleParticleArrival) bypasses the
// effectiveRps bookkeeping, so under the bug the LB reports outRps=0 while real particles still
// flow over the tripped edges and get re-dropped by the backends.
//
// Fixture: src (cdn, pure source) -> lb (loadBalancer) -> s1, s2 (ec2, each owns a breaker).
// Inbound src->lb runs hot so particles reliably arrive at the LB and trigger forwarding. The
// lb->server edges are pinned to 0 rps BEFORE startSimulation (ep.rps is snapshotted there, so it
// must be set beforehand) — spawnParticles then mints NOTHING on them directly, meaning the ONLY
// way a particle can appear on lb->s1 / lb->s2 is the LB's forwarding path. That isolation is what
// makes the assertion meaningful.

// maxRetries: 0 keeps the forwarding path the ONLY thing that can mint particles onto the backend
// edges — a retry would otherwise re-spawn dropped forwards and muddy the isolation.
const reqConfig: RequestEdgeConfig = {
  methodDistribution: { GET: 100, POST: 0, PUT: 0, DELETE: 0 },
  timeoutMs: 30_000,
  retryConfig: { maxRetries: 0, baseDelayMs: 100, jitter: 'full', maxDelayMs: 1000 },
}

function node(id: string, type: string): Node<NodeData> {
  return { id, type, position: { x: 0, y: 0 }, data: { label: id, subtitle: '', status: 'healthy', notes: '', warnings: [] } }
}
function reqEdge(id: string, source: string, target: string): Edge<EdgeData> {
  return {
    id, source, target, type: 'request',
    data: { label: '', edgeType: 'request', throughput: 0, latency: 0, config: reqConfig } as EdgeData,
  }
}

const nodes: Node<NodeData>[] = [node('src', 'cdn'), node('lb', 'loadBalancer'), node('s1', 'ec2'), node('s2', 'ec2')]
const edges: Edge<EdgeData>[] = [
  reqEdge('src-lb', 'src', 'lb'),
  reqEdge('lb-s1', 'lb', 's1'),
  reqEdge('lb-s2', 'lb', 's2'),
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

const backendParticles = () => getParticleCountForEdge('lb-s1') + getParticleCountForEdge('lb-s2')

describe('LB forwarding respects open circuit breakers', () => {
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

    // rps must be set BEFORE startSimulation — ep.rps is snapshotted there and never re-read.
    // Hot inbound to the LB; zero rate-based spawn on the backend edges so the only particles that
    // can appear on lb->s1 / lb->s2 come from the LB's forwarding path.
    useSimulationStore.getState().setEdgeRps('src-lb', 2000)
    useSimulationStore.getState().setEdgeRps('lb-s1', 0)
    useSimulationStore.getState().setEdgeRps('lb-s2', 0)

    setCallbacks(() => {}, () => {}, () => {})
    startSimulation(makeFakeCanvas(), nodes, edges, 1)
    expect(rafCallback).not.toBeNull()
    t = performance.now()
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

  // Advances `frames` frames, returning the peak backend-edge particle count observed across them.
  // If `keepTrippedOpen`, re-pins both backend breakers to open each frame (their state can be
  // churned by a forwarded arrival's recordBreakerResult), keeping them out of half-open.
  function run(frames: number, keepTrippedOpen = false): number {
    let peak = 0
    for (let i = 0; i < frames; i++) {
      t += 16
      const cb = rafCallback!
      rafCallback = null
      cb(t)
      expect(rafCallback).not.toBeNull()
      if (keepTrippedOpen) {
        getBreaker('lb-s1').state = 'open'; getBreaker('lb-s1').openedAt = t
        getBreaker('lb-s2').state = 'open'; getBreaker('lb-s2').openedAt = t
      }
      peak = Math.max(peak, backendParticles())
    }
    return peak
  }

  // Guard against a vacuous pass: with backend breakers CLOSED, forwarding must actually put
  // particles onto the backend edges (proving the harness drives the forwarding path at all).
  it('forwards onto backend edges when their breakers are closed', () => {
    expect(run(400)).toBeGreaterThan(0)
  })

  // The bug: with BOTH backend breakers open, the LB must drop at the LB, never forwarding onto a
  // tripped edge. Under the buggy `availableEdges.length > 0 ? availableEdges : outEdges` fallback,
  // forwarding keeps minting onto the tripped backend edges every frame, so the peak stays > 0 even
  // after in-flight warm-up particles have drained.
  it('does not forward onto backend edges whose circuit breakers are all open', () => {
    run(150)                       // warm up: inbound arrives, forwarding fills the backend edges
    getBreaker('lb-s1').state = 'open'; getBreaker('lb-s1').openedAt = t
    getBreaker('lb-s2').state = 'open'; getBreaker('lb-s2').openedAt = t
    run(200, true)                 // flush: let warm-up particles drain while breakers stay open
    expect(run(120, true)).toBe(0) // steady state: no NEW forwarding onto the tripped edges
  })
})
