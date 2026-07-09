// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../../../../lib/nodeConfig'
import { useSimulationStore, type NodeMetrics } from '../../../store/simulationLegacy.store'
import { startSimulation, stopSimulation, setCallbacks } from '../particleEngine'

// Minimal fixture: a queue node with a consumer edge (queue -> consumer) configured at a high
// RPS, but NO producer edge feeding the queue. Per the bug, the consumer edge historically spawns
// particles at its own free-running configured RPS regardless of queueDepth — "messages from
// nothing." queueDepth's own integrator ((inRps - outRps) * dt) starts at 0 and, with zero
// producer inRps and the bug's free-running outRps, would actually go NEGATIVE without the
// `Math.max(0, ...)` clamp already in updateAllNodeMetrics — but critically the consumer edge's
// effectiveRps/outRps should never be nonzero here in the first place.
const nodes: Node<NodeData>[] = [
  { id: 'q', type: 'queue', position: { x: 0, y: 0 }, data: { label: 'queue', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
  { id: 'consumer', type: 'ec2', position: { x: 200, y: 0 }, data: { label: 'consumer', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
]
const edges: Edge<EdgeData>[] = [
  { id: 'e-consumer', source: 'q', target: 'consumer', type: 'event', data: { label: '', edgeType: 'event', throughput: 0, latency: 0 } },
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

describe('queue consumer-edge gating on depth', () => {
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
    // Consumer edge configured at a large RPS — under the bug this free-runs regardless of
    // queueDepth (which stays 0 since there is no producer edge into 'q').
    useSimulationStore.getState().setEdgeRps('e-consumer', 5000)
  })

  afterEach(() => {
    stopSimulation()
    useSimulationStore.getState().setRunning(false)
    rafSpy.mockRestore()
    cafSpy.mockRestore()
  })

  it('emits zero consumer-edge outRps when queueDepth is zero and no producer feeds it', () => {
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
    for (let i = 0; i < 40; i++) {
      t += 16
      const cb = rafCallback!
      rafCallback = null
      cb(t)
    }

    expect(batches.length).toBeGreaterThan(0)

    // The queue itself should report outRps 0 (no traffic drained from an empty queue with no
    // producers), and the downstream consumer node should never see any inbound traffic either —
    // "messages from nothing" would show up as nonzero inRps on 'consumer'.
    const queueOutRpsSeries = batches.map(b => b.get('q')?.outRps ?? 0)
    const consumerInRpsSeries = batches.map(b => b.get('consumer')?.inRps ?? 0)

    expect(queueOutRpsSeries.every(v => v === 0)).toBe(true)
    expect(consumerInRpsSeries.every(v => v === 0)).toBe(true)

    // Queue depth itself should never go negative and should stay at 0 (no producers).
    const queueDepthSeries = batches.map(b => b.get('q')?.queueDepth ?? 0)
    expect(queueDepthSeries.every(v => v === 0)).toBe(true)
  })
})
