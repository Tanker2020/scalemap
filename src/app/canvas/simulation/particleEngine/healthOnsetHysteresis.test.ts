// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData, NodeSimConfig, RequestEdgeConfig } from '../../../../lib/nodeConfig'
import { useSimulationStore, type NodeMetrics } from '../../../store/simulationLegacy.store'
import { startSimulation, stopSimulation, setCallbacks, setNodeConfigs } from '../particleEngine'
import { clearBreakers } from './circuitBreakers'
import { clearBackpressureState } from './backpressure'
import { clearChaosState } from './chaos'

// Health-state (healthy/degraded/down) is computed from RAW, unsmoothed per-tick values with
// hysteresis ONLY on the down->healthy recovery tail (HEALTH_RECOVERY_LOCK_MS). The onset path
// (healthy->degraded->down) previously had zero dwell time — a single bad tick latched a worse
// state immediately, which (via forceOpenBreakersForNode) could re-trip an inbound breaker on
// every brief utilization spike, producing the reported "oscillates with no indication why."
// This fix adds a symmetric onset debounce (HEALTH_ONSET_DEBOUNCE_MS) requiring sustained
// degradation before latching a worse state.

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

describe('health-state onset hysteresis', () => {
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

  // firewall: plain generic inRps/maxRps utilization, no thread-pool/lambda/db special-casing —
  // isolates the health-onset debounce mechanism from other nodes types' own utilization
  // smoothing, so this test exercises exactly the mechanism under test.
  const healthyConfig: NodeSimConfig = { maxRps: 10_000, processingMs: 2, errorRate: 0 } as unknown as NodeSimConfig
  // 1000rps against maxRps=100 -> rawUtilization = 10.0, capping utilPenalty at 0.4 -> healthScore
  // floors at 0.6, comfortably in 'degraded' territory (>=0.50, <0.85).
  const brieflyOverloadedConfig: NodeSimConfig = { maxRps: 100, processingMs: 2, errorRate: 0 } as unknown as NodeSimConfig

  it('does not latch a worse health state from a single brief utilization spike shorter than the onset debounce window', () => {
    const nodes: Node<NodeData>[] = [node('src', 'cdn'), node('dst', 'firewall')]
    const edges: Edge<EdgeData>[] = [reqEdge('e1', 'src', 'dst')]
    useSimulationStore.getState().setEdgeRps('e1', 1000)

    const batches: Map<string, NodeMetrics>[] = []
    setCallbacks((batch) => batches.push(new Map(batch)), () => {}, () => {})
    startSimulation(makeFakeCanvas(), nodes, edges, 1)
    setNodeConfigs(new Map([['dst', healthyConfig]]))
    expect(rafCallback).not.toBeNull()

    // Reach a stable 'healthy' baseline.
    for (let i = 0; i < 60; i++) step()
    expect(batches[batches.length - 1].get('dst')?.healthState).toBe('healthy')

    // Brief spike: well under HEALTH_ONSET_DEBOUNCE_MS (3000ms) — roughly 300ms (~19 frames).
    setNodeConfigs(new Map([['dst', brieflyOverloadedConfig]]))
    const stateDuringSpike: (string | undefined)[] = []
    for (let i = 0; i < 19; i++) {
      step()
      stateDuringSpike.push(batches[batches.length - 1]?.get('dst')?.healthState)
    }

    // Restore immediately — the spike never sustained long enough to legitimately latch.
    setNodeConfigs(new Map([['dst', healthyConfig]]))
    for (let i = 0; i < 10; i++) step()

    expect(stateDuringSpike.every(s => s === 'healthy')).toBe(true)
  })

  it('does latch a worse health state once degradation is sustained past the onset debounce window', () => {
    const nodes: Node<NodeData>[] = [node('src', 'cdn'), node('dst', 'firewall')]
    const edges: Edge<EdgeData>[] = [reqEdge('e1', 'src', 'dst')]
    useSimulationStore.getState().setEdgeRps('e1', 1000)

    const batches: Map<string, NodeMetrics>[] = []
    setCallbacks((batch) => batches.push(new Map(batch)), () => {}, () => {})
    startSimulation(makeFakeCanvas(), nodes, edges, 1)
    setNodeConfigs(new Map([['dst', healthyConfig]]))
    expect(rafCallback).not.toBeNull()

    for (let i = 0; i < 60; i++) step()
    expect(batches[batches.length - 1].get('dst')?.healthState).toBe('healthy')

    // Sustained well past the debounce window (3000ms => ~190 frames); 260 gives comfortable margin.
    // Note: pure utilization overload (no errors) caps healthScore's utilPenalty at 0.4, giving a
    // floor healthScore of 0.6 — comfortably in 'degraded' (>=0.50) but never reaching 'down'
    // (<0.50) without an error-rate or latency contribution too. 'degraded' is the correct,
    // reachable worse-state target here.
    setNodeConfigs(new Map([['dst', brieflyOverloadedConfig]]))
    for (let i = 0; i < 260; i++) step()

    expect(batches[batches.length - 1].get('dst')?.healthState).toBe('degraded')
  })
})
