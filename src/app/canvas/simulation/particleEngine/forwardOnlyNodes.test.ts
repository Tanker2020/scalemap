// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData, NodeType, RequestEdgeConfig } from '../../../../lib/nodeConfig'
import { useSimulationStore, type NodeMetrics } from '../../../store/simulationLegacy.store'
import { startSimulation, stopSimulation, setCallbacks, getParticleCountForEdge } from '../particleEngine'
import { clearBreakers } from './circuitBreakers'
import { clearBackpressureState } from './backpressure'
import { clearChaosState } from './chaos'

// Pure network-layer relays (loadBalancer, dns, firewall, vpn) must not originate independent
// traffic: their outbound edges may only carry traffic forwarded from real inbound arrivals. See
// FORWARD_ONLY_NODE_TYPES in nodeConfig.ts and the snapshot-time rps zeroing + forwarding branch
// in particleEngine.ts. loadBalancer's forwarding (round-robin) is covered separately in
// lbForwardingCircuitOpen.test.ts — this file covers the shared rps-zeroing guarantee across all
// four types, plus the NEW forwarding branch for dns/firewall/vpn (which previously had none).

const reqConfig: RequestEdgeConfig = {
  methodDistribution: { GET: 100, POST: 0, PUT: 0, DELETE: 0 },
  timeoutMs: 30_000,
  retryConfig: { maxRetries: 0, baseDelayMs: 100, jitter: 'full', maxDelayMs: 1000 },
}

function node(id: string, type: NodeType): Node<NodeData> {
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

describe('forward-only node types', () => {
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

  function driveFrames(frames: number, edgeId: string): number {
    let t = performance.now()
    let peak = 0
    for (let i = 0; i < frames; i++) {
      t += 16
      const cb = rafCallback!
      rafCallback = null
      cb(t)
      expect(rafCallback).not.toBeNull()
      peak = Math.max(peak, getParticleCountForEdge(edgeId))
    }
    return peak
  }

  describe.each(['loadBalancer', 'dns', 'firewall', 'vpn'] as NodeType[])(
    'a %s node',
    (relayType) => {
      it('never independently generates traffic on its outbound edge, no matter what RPS is configured', () => {
        const nodes: Node<NodeData>[] = [node('source', relayType), node('target', 'ec2')]
        const edges: Edge<EdgeData>[] = [reqEdge('e1', 'source', 'target')]

        // rps must be set BEFORE startSimulation — EdgePath.rps is snapshotted there.
        // A huge value here is exactly the misconfiguration this restriction must neutralize.
        useSimulationStore.getState().setEdgeRps('e1', 5000)

        setCallbacks(() => {}, () => {}, () => {})
        startSimulation(makeFakeCanvas(), nodes, edges, 1)
        expect(rafCallback).not.toBeNull()

        expect(driveFrames(300, 'e1')).toBe(0)
      })
    },
  )

  describe.each(['dns', 'firewall', 'vpn'] as NodeType[])(
    'a %s node relaying traffic (new forwarding branch)',
    (relayType) => {
      it('forwards particles that arrive on its inbound edge onto its outbound edge', () => {
        // origin(cdn, unrestricted) -> relay(forward-only) -> dst(ec2)
        const nodes: Node<NodeData>[] = [node('origin', 'cdn'), node('relay', relayType), node('dst', 'ec2')]
        const edges: Edge<EdgeData>[] = [
          reqEdge('e-in', 'origin', 'relay'),
          reqEdge('e-out', 'relay', 'dst'),
        ]

        // Hot-but-modest inbound (allowed: cdn is a legitimate origin) — 500 rps stays under every
        // relay type's maxRps (vpn's default 1000 is the tightest), so the capacity-drop gate
        // doesn't reject arrivals before they ever reach the forwarding branch under test.
        // e-out pinned to 0 so the ONLY way a particle can appear there is the relay's forwarding.
        useSimulationStore.getState().setEdgeRps('e-in', 500)
        useSimulationStore.getState().setEdgeRps('e-out', 0)

        const batches: Map<string, NodeMetrics>[] = []
        setCallbacks((batch) => batches.push(new Map(batch)), () => {}, () => {})
        startSimulation(makeFakeCanvas(), nodes, edges, 1)
        expect(rafCallback).not.toBeNull()

        expect(driveFrames(300, 'e-out')).toBeGreaterThan(0)

        // Forwarded traffic must also register as real metrics, not just visible particles —
        // this is the effectiveRps bookkeeping gap the forwarded-rps fix closes.
        const last = batches[batches.length - 1]
        expect(last?.get('relay')?.outRps).toBeGreaterThan(0)
        expect(last?.get('dst')?.inRps).toBeGreaterThan(0)
      })
    },
  )
})
