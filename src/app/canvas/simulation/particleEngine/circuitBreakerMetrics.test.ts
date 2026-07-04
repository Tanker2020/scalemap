// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData, NodeSimConfig } from '../../../../lib/nodeConfig'
import { useSimulationStore, type NodeMetrics } from '../../../store/simulation.store'
import { startSimulation, stopSimulation, setCallbacks, setNodeConfigs } from '../particleEngine'
import { getBreaker } from './circuitBreakers'

// Fake canvas: jsdom has no real 2D context — hand the engine a no-op context that satisfies every
// call advanceAndDraw makes. (Mirrors the fixture in saturationLatency.test.ts.)
function makeFakeCanvas(): HTMLCanvasElement {
  const ctx = {
    save() {}, restore() {}, beginPath() {}, closePath() {},
    moveTo() {}, lineTo() {}, arc() {}, arcTo() {}, stroke() {}, fill() {},
    clearRect() {}, setLineDash() {},
    strokeStyle: '', fillStyle: '', lineWidth: 0, globalAlpha: 1, shadowColor: '', shadowBlur: 0,
  }
  const canvas = {
    width: 800, height: 600,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON() {} }),
  }
  return canvas as unknown as HTMLCanvasElement
}

// Drives a client(src) -> server(dst) fixture for `frames` frames. If `pinBreakerOpen` is set, the
// src->dst edge's circuit breaker is forced open and re-pinned every frame so the run stays in the
// sustained-open state (the periodic recovery scan can't flip it to half-open mid-test).
async function run(frames: number, edgeRps: number, pinBreakerOpen: boolean): Promise<Map<string, NodeMetrics>> {
  // client(src) -> server(dst): src is the CALLER whose breaker to dst we force open.
  const nodes: Node<NodeData>[] = [
    { id: 'src', type: 'dns', position: { x: 0, y: 0 }, data: { label: 'client', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
    { id: 'dst', type: 'ec2', position: { x: 200, y: 0 }, data: { label: 'server', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
  ]
  const edgeData: EdgeData = { label: '', edgeType: 'request', throughput: 0, latency: 0 }
  const edges: Edge<EdgeData>[] = [
    { id: 'e1', source: 'src', target: 'dst', type: 'request', data: edgeData },
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
    setCallbacks((batch) => batches.push(new Map(batch)), () => {}, () => {})

    startSimulation(makeFakeCanvas(), nodes, edges, 1)
    setNodeConfigs(new Map([['dst', { forcedHealthState: 'healthy' } as NodeSimConfig]]))

    let t = performance.now()
    expect(rafCallback).not.toBeNull()
    for (let i = 0; i < frames; i++) {
      if (pinBreakerOpen) { const b = getBreaker('e1'); b.state = 'open'; b.openedAt = t }
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

describe('circuit-open metrics semantics', () => {
  afterEach(() => {
    stopSimulation()
    useSimulationStore.getState().setRunning(false)
  })

  it('an open downstream breaker raises the CALLER error rate instead of vanishing silently', async () => {
    const open   = await run(240, 800, /* pinBreakerOpen */ true)
    const caller = open.get('src')
    expect(caller).toBeDefined()
    // Fail-fast rejections are folded into the caller's error rate — no longer a silent 0.
    expect(caller!.errorRate).toBeGreaterThan(0.5)
    // …and are tallied as dropped requests on the caller.
    expect(caller!.droppedRequests ?? 0).toBeGreaterThan(0)
  })

  it('the protected node stops receiving new traffic while its inbound breaker is open', async () => {
    const open   = await run(240, 800, /* pinBreakerOpen */ true)
    const server = open.get('dst')
    expect(server).toBeDefined()
    // Inbound is suppressed at the source (fail-fast), so the server's inRps collapses — correct;
    // the point of the fix is that the *caller* now shows the errors (asserted above), not that
    // the protected node keeps receiving traffic.
    expect(server!.inRps).toBeLessThan(50)
  })

  it('with the breaker closed the caller shows no rejection-driven error rate', async () => {
    const healthy = await run(240, 800, /* pinBreakerOpen */ false)
    const caller  = healthy.get('src')
    expect(caller).toBeDefined()
    expect(caller!.errorRate).toBeLessThan(0.1)
  })
})
