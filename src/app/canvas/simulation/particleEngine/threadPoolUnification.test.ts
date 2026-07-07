// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../../../../lib/nodeConfig'
import { useSimulationStore, type NodeMetrics } from '../../../store/simulation.store'
import { startSimulation, stopSimulation, setCallbacks } from '../particleEngine'

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
