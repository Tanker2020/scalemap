// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData, NodeSimConfig } from '../../../../lib/nodeConfig'
import { useSimulationStore, type NodeMetrics } from '../../../store/simulation.store'
import { startSimulation, stopSimulation, setCallbacks, setNodeConfigs } from '../particleEngine'
import { triggerEdgePartition, clearChaosState } from './chaos'

// Fixture: 3 upstream sources (src1/src2/src3) each with their own edge into a single dbSql node
// ('db'). Each inbound edge stands in for one of the 3 modeled replicas' connectivity (see
// reachableReplicaCount in particleEngine.ts), so partitioning src2→db / src3→db isolates 2 of
// the 3 replicas while src1→db stays healthy.
function makeNodes(): Node<NodeData>[] {
  return [
    { id: 'src1', type: 'ec2', position: { x: 0, y: 0 }, data: { label: 'src1', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
    { id: 'src2', type: 'ec2', position: { x: 0, y: 100 }, data: { label: 'src2', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
    { id: 'src3', type: 'ec2', position: { x: 0, y: 200 }, data: { label: 'src3', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
    { id: 'db', type: 'dbSql', position: { x: 300, y: 100 }, data: { label: 'db', subtitle: '', status: 'healthy', notes: '', warnings: [], cost: { avgResponseKb: 5 } } },
  ]
}
function makeEdges(): Edge<EdgeData>[] {
  return [
    { id: 'e1', source: 'src1', target: 'db', type: 'request', data: { label: '', edgeType: 'request', throughput: 0, latency: 0, readPercentage: 1 } },
    { id: 'e2', source: 'src2', target: 'db', type: 'request', data: { label: '', edgeType: 'request', throughput: 0, latency: 0, readPercentage: 1 } },
    { id: 'e3', source: 'src3', target: 'db', type: 'request', data: { label: '', edgeType: 'request', throughput: 0, latency: 0, readPercentage: 1 } },
  ]
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
    width: 800,
    height: 600,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON() {} }),
  }
  return canvas as unknown as HTMLCanvasElement
}

describe('CAP-theorem replica-set availability', () => {
  let rafCallback: ((t: number) => void) | null = null
  let rafSpy: ReturnType<typeof vi.spyOn>
  let cafSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    clearChaosState()
    rafCallback = null
    rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      rafCallback = cb as unknown as (t: number) => void
      return 1
    })
    cafSpy = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {})
    useSimulationStore.getState().setRunning(true)
    useSimulationStore.getState().setPaused(false)
    useSimulationStore.getState().setEdgeRps('e1', 50)
    useSimulationStore.getState().setEdgeRps('e2', 50)
    useSimulationStore.getState().setEdgeRps('e3', 50)
  })

  afterEach(() => {
    stopSimulation()
    useSimulationStore.getState().setRunning(false)
    setNodeConfigs(new Map())
    rafSpy.mockRestore()
    cafSpy.mockRestore()
    clearChaosState()
  })

  function tick(t: number): void {
    const cb = rafCallback!
    rafCallback = null
    cb(t)
  }

  function run(nodes: Node<NodeData>[], edges: Edge<EdgeData>[], frames: number): Map<string, NodeMetrics>[] {
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
    for (let i = 0; i < frames; i++) { t += 16; tick(t) }
    return batches
  }

  it('a QUORUM-consistency DB remains available when only a minority (1 of 3) replicas are partitioned', () => {
    setNodeConfigs(new Map<string, NodeSimConfig>([
      ['db', { maxRps: 500, processingMs: 5, errorRate: 0, dbConfig: { maxReadRps: 5000, maxWriteRps: 500, readLatencyMs: 2, writeLatencyMs: 15 }, consistencyLevel: 'QUORUM' }],
    ]))

    const batches: Map<string, NodeMetrics>[] = []
    setCallbacks(
      (batch) => batches.push(new Map(batch)),
      () => {},
      () => {},
    )
    const canvas = makeFakeCanvas()
    startSimulation(canvas, makeNodes(), makeEdges(), 1)
    // startSimulation calls clearChaosState() internally, so the partition must be triggered
    // AFTER start — 1 of 3 replica links down, 2 still reachable — QUORUM only needs 2.
    triggerEdgePartition('e3', 60_000, 0)

    let t = performance.now()
    expect(rafCallback).not.toBeNull()
    for (let i = 0; i < 150; i++) { t += 16; tick(t) }
    const lastInRps = batches.length > 0 ? (batches[batches.length - 1].get('db')?.inRps ?? 0) : 0
    // The DB should still be actively serving traffic (not hard-zeroed by the availability gate).
    expect(lastInRps).toBeGreaterThan(0)
  })

  it('an ALL-consistency DB becomes unavailable for reads/writes when any replica is partitioned', () => {
    setNodeConfigs(new Map<string, NodeSimConfig>([
      ['db', { maxRps: 500, processingMs: 5, errorRate: 0, dbConfig: { maxReadRps: 5000, maxWriteRps: 500, readLatencyMs: 2, writeLatencyMs: 15 }, consistencyLevel: 'ALL' }],
    ]))

    const events: Array<{ type: string; message: string }> = []
    setCallbacks(
      () => {},
      () => {},
      (type, _nodeId, message) => { events.push({ type, message }) },
    )
    const canvas = makeFakeCanvas()
    startSimulation(canvas, makeNodes(), makeEdges(), 1)
    // startSimulation calls clearChaosState() internally, so the partition must be triggered
    // AFTER start — just one of the three replica links; ALL requires 3 of 3 reachable.
    triggerEdgePartition('e3', 60_000, 0)

    let t = performance.now()
    for (let i = 0; i < 150; i++) { t += 16; tick(t) }

    // Unavailability is surfaced via the same connection_pool_exhausted event dropParticle's
    // sibling gates already use — assert at least one such event referencing replica reachability.
    expect(events.some(e => e.type === 'connection_pool_exhausted' && e.message.includes('replicas reachable'))).toBe(true)
  })

  it('reads reflect replicationLagMs as added latency on non-primary replica reads', () => {
    const baseline = new Map<string, NodeSimConfig>([
      ['db', { maxRps: 500, processingMs: 5, errorRate: 0, dbConfig: { maxReadRps: 5000, maxWriteRps: 500, readLatencyMs: 2, writeLatencyMs: 15 } }],
    ])
    const withLag = new Map<string, NodeSimConfig>([
      ['db', { maxRps: 500, processingMs: 5, errorRate: 0, dbConfig: { maxReadRps: 5000, maxWriteRps: 500, readLatencyMs: 2, writeLatencyMs: 15 }, consistencyLevel: 'ONE', replicationLagMs: 500 }],
    ])

    setNodeConfigs(baseline)
    const baseBatches = run(makeNodes(), makeEdges(), 200)
    const baseP99 = baseBatches.length > 0 ? (baseBatches[baseBatches.length - 1].get('db')?.p99LatencyMs ?? 0) : 0

    stopSimulation()
    useSimulationStore.getState().setRunning(false)

    useSimulationStore.getState().setRunning(true)
    useSimulationStore.getState().setPaused(false)
    setNodeConfigs(withLag)
    const lagBatches = run(makeNodes(), makeEdges(), 200)
    const lagP99 = lagBatches.length > 0 ? (lagBatches[lagBatches.length - 1].get('db')?.p99LatencyMs ?? 0) : 0

    expect(lagP99).toBeGreaterThan(baseP99)
  })
})
