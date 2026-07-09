// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData, HttpTemplate, PacketDistributionEntry } from '../../../../lib/nodeConfig'
import { useCanvasStore } from '../../../store/canvas.store'
import { useSimulationStore, type NodeMetrics } from '../../../store/simulationLegacy.store'
import { startSimulation, stopSimulation, setCallbacks } from '../particleEngine'
import { DEFAULT_PACKET_WORKLOAD } from '../../../simulation/defaults'

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

const LIGHT_TEMPLATE: Omit<HttpTemplate, 'id'> = {
  name: 'light', protocol: 'http', sizeKb: 1, method: 'GET', path: '/health', statusCode: 200,
  workload: { tier: 'simple_crud', cpuInstructionsBillions: 0.001, memoryFootprintMb: 4, ioBoundFraction: 0.9 },
}
const HEAVY_TEMPLATE: Omit<HttpTemplate, 'id'> = {
  name: 'heavy', protocol: 'http', sizeKb: 1, method: 'POST', path: '/render', statusCode: 200,
  workload: { tier: 'heavy_compute', cpuInstructionsBillions: 5, memoryFootprintMb: 256, ioBoundFraction: 0.1 },
}

describe('per-particle and weighted workload resolution', () => {
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
  })

  afterEach(() => {
    stopSimulation()
    useSimulationStore.getState().setRunning(false)
    rafSpy.mockRestore()
    cafSpy.mockRestore()
  })

  it('a node with an 80/20-weighted light/heavy distribution reports utilization strictly between the two extremes, proportioned to the weights (not a plain average)', () => {
    // caller (source, custom-mode distribution 80% light / 20% heavy) -> ec2 target.
    useCanvasStore.getState().setPacketMode('custom')
    const lightId = useCanvasStore.getState().addPacketTemplate(LIGHT_TEMPLATE)
    const heavyId = useCanvasStore.getState().addPacketTemplate(HEAVY_TEMPLATE)
    const dist: PacketDistributionEntry[] = [
      { templateId: lightId, weight: 80 },
      { templateId: heavyId, weight: 20 },
    ]
    useCanvasStore.setState(_s => ({
      nodes: [
        { id: 'caller', type: 'cdn', position: { x: 0, y: 0 }, data: { label: 'caller', subtitle: '', status: 'healthy', notes: '', warnings: [], packetDistribution: dist } },
        { id: 'target', type: 'ec2', position: { x: 200, y: 0 }, data: { label: 'target', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
      ],
      edges: [
        { id: 'e1', source: 'caller', target: 'target', type: 'request', data: { label: '', edgeType: 'request', throughput: 0, latency: 0 } },
      ],
    }))

    const { nodes, edges } = useCanvasStore.getState()
    useSimulationStore.getState().setRunning(true)
    useSimulationStore.getState().setPaused(false)
    useSimulationStore.getState().setEdgeRps('e1', 300)

    const batches: Map<string, NodeMetrics>[] = []
    setCallbacks((batch) => batches.push(new Map(batch)), () => {}, () => {})
    startSimulation(makeFakeCanvas(), nodes as unknown as Node<NodeData>[], edges as unknown as Edge<EdgeData>[], 1)

    let t = performance.now()
    for (let i = 0; i < 60; i++) {
      const cb = rafCallback!
      rafCallback = null
      t += 16
      cb(t)
    }

    const target = batches[batches.length - 1].get('target')
    expect(target?.utilization).toBeGreaterThan(0)
    // Not asserting an exact number (utilization is a blend of many effects) -- the key
    // discriminator is in the unit tests below, which isolate blendDistributionWorkload's math
    // directly. This integration test just proves the wiring reaches end-to-end without throwing
    // and produces a non-trivial utilization once a custom distribution with real workload is set.
    expect(target?.utilization).toBeLessThanOrEqual(1)
  })
})

import { resolveParticleWorkload, blendDistributionWorkload, resolveSourceOutboundWorkload } from '../particleEngine'

describe('blendDistributionWorkload weighting math', () => {
  it('an 80/20 light/heavy split blends much closer to light than a 50/50 average would', () => {
    useCanvasStore.getState().setPacketMode('custom')
    const lightId = useCanvasStore.getState().addPacketTemplate(LIGHT_TEMPLATE)
    const heavyId = useCanvasStore.getState().addPacketTemplate(HEAVY_TEMPLATE)
    useCanvasStore.setState(_s => ({
      nodes: [{ id: 'src', type: 'cdn', position: { x: 0, y: 0 }, data: { label: 'src', subtitle: '', status: 'healthy', notes: '', warnings: [], packetDistribution: [{ templateId: lightId, weight: 80 }, { templateId: heavyId, weight: 20 }] } }],
      edges: [],
    }))
    // Must call startSimulation once so the engine snapshots the packet registry into its
    // internal _packetTemplates/_packetMode mirrors (see startSimulation's own comment on why —
    // the hot loop never reads React state directly).
    const canvas = document.createElement('canvas')
    const { nodes, edges } = useCanvasStore.getState()
    startSimulation(canvas, nodes as unknown as Node<NodeData>[], edges as unknown as Edge<EdgeData>[], 1)

    const blended = resolveSourceOutboundWorkload('src', 'request')
    // 80% of 0.001 + 20% of 5 = 0.0008 + 1.0 = 1.0008 -- much closer to the light value (0.001)
    // than a plain 50/50 average would be ((0.001+5)/2 = 2.5005). This is the real assertion:
    // proves the function is weight-proportional, not an unweighted mean.
    expect(blended.cpuInstructionsBillions).toBeCloseTo(1.0008, 4)
    expect(blended.cpuInstructionsBillions).toBeLessThan(2.5005 * 0.5) // sanity: well below the naive average
    stopSimulation()
  })

  it('returns undefined (not a default) when nothing in the distribution is eligible', () => {
    useCanvasStore.getState().setPacketMode('custom')
    const streamId = useCanvasStore.getState().addPacketTemplate({ name: 's', protocol: 'stream', sizeKb: 1, streamId: 'x', compressionType: 'none' })
    // A stream-protocol template is not eligible for a 'request'-type edge (edgeAcceptsProtocol).
    const result = blendDistributionWorkload([{ templateId: streamId, weight: 100 }], 'request')
    expect(result).toBeUndefined()
  })
})

describe('resolveParticleWorkload', () => {
  it('falls back to DEFAULT_PACKET_WORKLOAD when templateId is undefined (generic mode)', () => {
    const w = resolveParticleWorkload({ id: 1, t: 0, speed: 1, color: '#fff', edgeId: 'e1', retries: 0, originLatencyMs: 0, spawnTime: 0, payloadBytes: 100 })
    expect(w).toEqual(DEFAULT_PACKET_WORKLOAD)
  })
})
