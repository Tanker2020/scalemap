// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData, NodeSimConfig, RequestEdgeConfig, ComputeProfile } from '../../../../lib/nodeConfig'
import { useSimulationStore, type NodeMetrics } from '../../../store/simulationLegacy.store'
import { startSimulation, stopSimulation, setCallbacks, setNodeConfigs } from '../particleEngine'
import { clearBreakers } from './circuitBreakers'
import { clearBackpressureState } from './backpressure'
import { clearChaosState } from './chaos'

// When an EC2 node's compute model OOM-crashes, the engine forces it 'down' and schedules a
// restart. But the per-frame health scorer in updateAllNodeMetrics recomputes health from live
// utilization every tick — and a crashed node drops all traffic, so its utilization reads low and
// the scorer flips it back to 'degraded'/'healthy' within 1-2 frames. That let a crashed node keep
// serving and re-crash faster than restartDelayMs (a crash-loop). This test pins the fix: the OOM
// 'down' state must be held for the full restart window (mirrors the _recoveryUntil time-lock).

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

// A hardware profile whose entire RAM is smaller than the OS memory floor: currentRamMb(0) =
// osBaseMemoryMb (512) already exceeds ramGiB*1024 (~102 MB), so the FIRST admitted request OOMs.
const tinyRamProfile: ComputeProfile = {
  vCpu: 4,
  ramGiB: 0.1,
  architecture: 'x86_64',
  cpuFamily: 'test',
  baseClockGhz: 3,
  blockingIoModel: true,
  osBaseMemoryMb: 512,
  threadStackMb: 1,
}
const oomEc2Config: NodeSimConfig = {
  maxRps: 10_000,
  processingMs: 5,
  errorRate: 0,
  computeProfile: tinyRamProfile,
  selfHealing: { restartDelayMs: 5000 },
} as unknown as NodeSimConfig

describe('OOM crash lock', () => {
  let rafCallback: ((t: number) => void) | null = null
  let rafSpy: ReturnType<typeof vi.spyOn>
  let cafSpy: ReturnType<typeof vi.spyOn>
  let t = 0

  beforeEach(() => {
    t = 0
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

  it('holds an OOM-crashed EC2 node in "down" across consecutive frames within the restart window', () => {
    const nodes: Node<NodeData>[] = [node('src', 'apiGateway'), node('dst', 'ec2')]
    const edges: Edge<EdgeData>[] = [reqEdge('e1', 'src', 'dst')]
    useSimulationStore.getState().setEdgeRps('e1', 2000)

    const batches: Map<string, NodeMetrics>[] = []
    setCallbacks((batch) => batches.push(new Map(batch)), () => {}, () => {})
    startSimulation(makeFakeCanvas(), nodes, edges, 1)
    setNodeConfigs(new Map([['dst', oomEc2Config]]))
    expect(rafCallback).not.toBeNull()

    // Let traffic reach the EC2 node and trigger the first OOM crash.
    let crashedAtFrame = -1
    for (let i = 0; i < 120; i++) {
      step()
      if (batches[batches.length - 1]?.get('dst')?.healthState === 'down') { crashedAtFrame = i; break }
    }
    expect(crashedAtFrame).toBeGreaterThanOrEqual(0)

    // Sample health across the next stretch of consecutive frames (well inside the 5000ms restart
    // window). With the crash lock the node must remain 'down' the entire time; without it the
    // per-frame scorer flips it out within a frame or two.
    const sampled: (string | undefined)[] = []
    for (let i = 0; i < 150; i++) {
      step()
      sampled.push(batches[batches.length - 1]?.get('dst')?.healthState)
    }

    expect(sampled.every(s => s === 'down')).toBe(true)
  })
})
