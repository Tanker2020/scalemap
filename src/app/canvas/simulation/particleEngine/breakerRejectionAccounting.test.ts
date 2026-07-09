// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../../../../lib/nodeConfig'
import { useSimulationStore, type NodeMetrics } from '../../../store/simulationLegacy.store'
import { startSimulation, stopSimulation, setCallbacks } from '../particleEngine'
import { getBreaker, clearBreakers } from './circuitBreakers'

// Minimal 2-node, 1-edge fixture: an apiGateway (no circuitBreaker config of its own, no
// inbound edges — a pure entry point; unlike loadBalancer, apiGateway is a legitimate
// internet-facing origin allowed to carry an independently-configured outbound RPS) calling an
// ec2 server (has a default circuitBreaker config per NODE_SIM_DEFAULTS.ec2). Forcing this
// edge's breaker open lets us isolate the caller-side errorRate contribution without any other
// error/utilization signal in play.
const nodes: Node<NodeData>[] = [
  { id: 'lb', type: 'apiGateway', position: { x: 0, y: 0 }, data: { label: 'lb', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
  { id: 'srv', type: 'ec2', position: { x: 200, y: 0 }, data: { label: 'srv', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
]
const edges: Edge<EdgeData>[] = [
  { id: 'e1', source: 'lb', target: 'srv', type: 'request', data: { label: '', edgeType: 'request', throughput: 0, latency: 0 } },
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

describe('breaker rejection accounting (caller-side errorRate)', () => {
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
    useSimulationStore.getState().setEdgeRps('e1', 300)
  })

  afterEach(() => {
    stopSimulation()
    useSimulationStore.getState().setRunning(false)
    rafSpy.mockRestore()
    cafSpy.mockRestore()
  })

  it('raises the caller (lb) errorRate to ~1 when its only outbound edge breaker is open', () => {
    const batches: Map<string, NodeMetrics>[] = []
    setCallbacks((batch) => batches.push(new Map(batch)), () => {}, () => {})

    const canvas = makeFakeCanvas()
    startSimulation(canvas, nodes, edges, 1)
    // Force the breaker open before the very first frame — spawnParticles reads
    // getBreaker(ep.id).state directly, so this takes effect immediately. Must run AFTER
    // startSimulation: startSimulation calls clearBreakers() as part of its reset, which
    // would otherwise wipe this out from under us.
    getBreaker('e1').state = 'open'

    // METRICS_THROTTLE is 4 — run 4 frames to get exactly one published batch. The very
    // first published batch is unsmoothed (no EMA yet, see particleEngine.ts:2003's
    // `prev ? {...ema...} : rawMetrics`), so we can assert an exact value.
    let t = performance.now()
    for (let i = 0; i < 4; i++) {
      const cb = rafCallback!
      rafCallback = null
      t += 16
      cb(t)
    }

    expect(batches.length).toBe(1)
    const lbMetrics = batches[0].get('lb')
    expect(lbMetrics).toBeDefined()
    // lb has no inbound edges (pure entry point) so baseErrorRate/cascadePressure/
    // clientErrorRate are all 0 — the only contribution is breakerRejectionRate, which
    // should be ~1 since 100% of lb's single outbound edge's offered load is rejected.
    expect(lbMetrics!.errorRate).toBeCloseTo(1, 5)
  })

  it('does not raise errorRate when the breaker is closed', () => {
    const batches: Map<string, NodeMetrics>[] = []
    setCallbacks((batch) => batches.push(new Map(batch)), () => {}, () => {})

    const canvas = makeFakeCanvas()
    startSimulation(canvas, nodes, edges, 1)

    let t = performance.now()
    for (let i = 0; i < 4; i++) {
      const cb = rafCallback!
      rafCallback = null
      t += 16
      cb(t)
    }

    const lbMetrics = batches[0].get('lb')
    expect(lbMetrics!.errorRate).toBeCloseTo(0, 5)
  })
})
