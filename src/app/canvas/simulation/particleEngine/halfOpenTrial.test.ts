// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../../../../lib/nodeConfig'
import { useSimulationStore } from '../../../store/simulationLegacy.store'
import { startSimulation, stopSimulation, setCallbacks, getParticleCountForEdge } from '../particleEngine'
import { getBreaker, clearBreakers } from './circuitBreakers'

const nodes: Node<NodeData>[] = [
  { id: 'lb', type: 'loadBalancer', position: { x: 0, y: 0 }, data: { label: 'lb', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
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

describe('half-open admits exactly one trial request', () => {
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
    // High rps — without the trial gate this would mint many particles per frame
    // (particlesPerSec = 100_000 / 10 = 10_000; even one 16ms frame at downstreamFactor=1
    // computes spawnChance ≈ 160, far more than 1).
    useSimulationStore.getState().setEdgeRps('e1', 100_000)
  })

  afterEach(() => {
    stopSimulation()
    useSimulationStore.getState().setRunning(false)
    rafSpy.mockRestore()
    cafSpy.mockRestore()
  })

  it('never has more than 1 particle in flight on a half-open edge', () => {
    setCallbacks(() => {}, () => {}, () => {})

    const canvas = makeFakeCanvas()
    startSimulation(canvas, nodes, edges, 1)
    // Force half-open AFTER startSimulation: startSimulation calls clearBreakers() as part
    // of its reset, which would otherwise wipe this out from under us (see the same fix
    // applied in breakerRejectionAccounting.test.ts).
    getBreaker('e1').state = 'half-open'

    let t = performance.now()
    for (let i = 0; i < 20; i++) {
      const cb = rafCallback!
      rafCallback = null
      t += 16
      cb(t)
      expect(getParticleCountForEdge('e1')).toBeLessThanOrEqual(1)
    }
  })

  it('authorizes exactly one trial on entry, not zero', () => {
    setCallbacks(() => {}, () => {}, () => {})

    const canvas = makeFakeCanvas()
    startSimulation(canvas, nodes, edges, 1)
    // See comment above — must be set after startSimulation's clearBreakers() reset.
    getBreaker('e1').state = 'half-open'

    let t = performance.now()
    let sawAParticle = false
    for (let i = 0; i < 20; i++) {
      const cb = rafCallback!
      rafCallback = null
      t += 16
      cb(t)
      if (getParticleCountForEdge('e1') >= 1) sawAParticle = true
    }
    expect(sawAParticle).toBe(true)
  })
})

describe('half-open trial is not stranded by an empty-queue source gate', () => {
  const queueNodes: Node<NodeData>[] = [
    { id: 'q', type: 'queue', position: { x: 0, y: 0 }, data: { label: 'q', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
    { id: 'srv', type: 'ec2', position: { x: 200, y: 0 }, data: { label: 'srv', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
  ]
  const queueEdges: Edge<EdgeData>[] = [
    { id: 'e1', source: 'q', target: 'srv', type: 'request', data: { label: '', edgeType: 'request', throughput: 0, latency: 0 } },
  ]

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
    useSimulationStore.getState().setEdgeRps('e1', 100_000)
    // Queue depth is left unset — defaults to 0, i.e. the queue is momentarily empty.
  })

  afterEach(() => {
    stopSimulation()
    useSimulationStore.getState().setRunning(false)
    rafSpy.mockRestore()
    cafSpy.mockRestore()
  })

  it('still mints the trial when the half-open edge sources from an empty queue', () => {
    setCallbacks(() => {}, () => {}, () => {})

    const canvas = makeFakeCanvas()
    startSimulation(canvas, queueNodes, queueEdges, 1)
    // Force half-open AFTER startSimulation: startSimulation calls clearBreakers() as part
    // of its reset, which would otherwise wipe this out from under us.
    getBreaker('e1').state = 'half-open'

    let t = performance.now()
    let sawAParticle = false
    for (let i = 0; i < 20; i++) {
      const cb = rafCallback!
      rafCallback = null
      t += 16
      cb(t)
      if (getParticleCountForEdge('e1') >= 1) sawAParticle = true
    }
    expect(sawAParticle).toBe(true)
  })
})
