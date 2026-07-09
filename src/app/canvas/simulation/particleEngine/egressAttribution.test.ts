// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../../../../lib/nodeConfig'
import { useSimulationStore, type NodeMetrics } from '../../../store/simulationLegacy.store'
import { startSimulation, stopSimulation, setCallbacks } from '../particleEngine'
import { getBreaker } from './circuitBreakers'

// Minimal 2-node, 1-edge fixture: a pure source (cdn — no thread-pool gate, no inbound edges,
// no circuit-breaker config) feeding a compute node (ec2 — has a circuitBreaker config, so we
// can force its inbound edge's breaker open to simulate "never arrives").
const nodes: Node<NodeData>[] = [
  { id: 'src', type: 'cdn', position: { x: 0, y: 0 }, data: { label: 'cdn', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
  // avgResponseKb is required so sampleEdgeResponsePayload (via templatePayloadBytes) produces a
  // non-zero payloadBytes for generic-mode particles — without it, egress would read 0 under
  // both the buggy and fixed code, masking the bug this test exists to catch.
  { id: 'dst', type: 'ec2', position: { x: 200, y: 0 }, data: { label: 'ec2', subtitle: '', status: 'healthy', notes: '', warnings: [], cost: { avgResponseKb: 50 } } },
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

describe('egress byte attribution', () => {
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
    useSimulationStore.getState().setEdgeRps('e1', 500)
  })

  afterEach(() => {
    stopSimulation()
    useSimulationStore.getState().setRunning(false)
    rafSpy.mockRestore()
    cafSpy.mockRestore()
  })

  function tick(t: number): void {
    const cb = rafCallback!
    rafCallback = null
    cb(t)
  }

  it('does not accumulate egress bytes for a particle that never arrives (circuit open)', () => {
    // spawnParticles gates on the SAME edge-keyed breaker it later checks at arrival, so forcing
    // the breaker open before any frame runs would suppress spawning entirely and never exercise
    // the bug. Instead: let particles spawn for a few frames on a healthy edge (the bug would
    // attribute their bytes right here, at mint time), THEN trip the breaker open before any of
    // those in-flight particles reach t>=1 — handleParticleArrival re-checks the breaker live at
    // arrival time (independent of its state at spawn) and drops them there instead.
    const batches: Map<string, NodeMetrics>[] = []
    setCallbacks(
      (batch) => batches.push(new Map(batch)),
      () => {},
      () => {},
    )
    const canvas = makeFakeCanvas()
    startSimulation(canvas, nodes, edges, 1)

    let t = performance.now()
    expect(rafCallback).not.toBeNull()

    // A few frames of spawning on a healthy (closed-breaker) edge — well short of the ~104
    // frames a particle needs to reach t>=1, so nothing has arrived yet.
    for (let i = 0; i < 8; i++) { t += 16; tick(t) }

    // Now trip the breaker open — every particle already in flight on 'e1' will be dropped
    // the moment it reaches the target, never reaching the successful-arrival path.
    // openedAt must be the current SIMULATED time `t`, not a hardcoded 0: `t` starts from the
    // real performance.now() at test-start, which can already be many seconds in if this file
    // runs later in a busy worker's queue — a hardcoded 0 makes `now - openedAt` reflect real
    // elapsed wall-clock time instead of "just opened," letting resetMs (10s) elapse and the
    // breaker prematurely auto-recover to half-open before any in-flight particle arrives.
    getBreaker('e1').state = 'open'
    getBreaker('e1').openedAt = t

    // Advance well past the point every in-flight particle would have arrived (~104 frames).
    for (let i = 0; i < 150; i++) { t += 16; tick(t) }

    expect(batches.length).toBeGreaterThan(0)
    for (const batch of batches) {
      const egress = batch.get('dst')?.egressBytesPerSec ?? 0
      expect(egress).toBe(0)
    }
  })

  it('accumulates egress bytes only once the particle successfully arrives, not at spawn', () => {
    // Healthy edge — breaker stays closed. Speed/distance is set so a particle needs ~104
    // frames (t += ~0.0096/frame) to reach t>=1, so early batches are guaranteed pre-arrival.
    const batches: Map<string, NodeMetrics>[] = []
    setCallbacks(
      (batch) => batches.push(new Map(batch)),
      () => {},
      () => {},
    )
    const canvas = makeFakeCanvas()
    startSimulation(canvas, nodes, edges, 1)

    let t = performance.now()
    expect(rafCallback).not.toBeNull()

    // Advance a few frames — well before any particle can have completed the edge traversal —
    // and confirm egress is still 0 immediately after spawn.
    for (let i = 0; i < 8; i++) { t += 16; tick(t) }
    const earlyEgress = batches.map(b => b.get('dst')?.egressBytesPerSec ?? 0)
    expect(earlyEgress.every(v => v === 0)).toBe(true)

    // Advance far enough for particles to actually arrive (t>=1 at ~104 frames).
    for (let i = 0; i < 150; i++) { t += 16; tick(t) }
    const laterEgress = batches.map(b => b.get('dst')?.egressBytesPerSec ?? 0)
    expect(laterEgress.some(v => v > 0)).toBe(true)
  })
})
