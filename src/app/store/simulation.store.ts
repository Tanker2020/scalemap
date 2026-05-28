import { create } from 'zustand'
import type { NodeSimConfig } from '../../lib/nodeConfig'

export type TrafficMode = 'steady' | 'ramp' | 'spike' | 'chaos'

export type CircuitState = 'closed' | 'open' | 'half-open'

export interface NodeMetrics {
  inRps: number
  outRps: number
  utilization: number
  errorRate: number
  p50LatencyMs: number
  p75LatencyMs: number
  p90LatencyMs: number
  p99LatencyMs: number
  queueDepth?: number
  concurrency?: number
  circuitState?: CircuitState
}

export type SimEventType =
  | 'saturation_start' | 'saturation_end'
  | 'circuit_open' | 'circuit_close' | 'circuit_half_open'
  | 'cascade_detected'
  | 'simulation_start' | 'simulation_stop'
  | 'chaos_failure' | 'chaos_recovery'
  | 'connection_pool_exhausted'
  | 'lambda_cold_start'
  | 'request_timeout'
  | 'slo_violation'
  | 'slo_recovery'
  | 'autoscale_triggered'
  | 'autoscale_complete'
  | 'autoscale_scaledin'
  | 'crash_loop_detected'

export interface SimEvent {
  id: string
  type: SimEventType
  nodeId?: string
  at: number
  elapsedS: number
  message: string
  severity: 'info' | 'warn' | 'critical'
  metricsSnapshot?: Partial<NodeMetrics>
}

export interface SimulationRun {
  id: string
  startedAt: number
  endedAt: number
  durationS: number
  peakRps: number
  peakUtilization: number
  avgErrorRate: number
  sloViolations: number
  bottleneckNodeIds: string[]
  events: SimEvent[]
  nodeSnapshots: Map<string, NodeMetrics>
  trafficMode: TrafficMode
  globalMultiplier: number
}

export interface SloStatus {
  passing: boolean
  violations: string[]
}

import type { ScaleScript } from '../../lib/scalescript'

interface SimulationStore {
  running: boolean
  paused: boolean
  speed: number
  simulationMode: TrafficMode
  globalMultiplier: number
  nodeMetrics: Map<string, NodeMetrics>
  bottlenecks: Set<string>
  nodeConfigs: Map<string, NodeSimConfig>
  edgeRps: Map<string, number>
  events: SimEvent[]
  sloStatus: Map<string, SloStatus>
  activeScript: ScaleScript | null

  setRunning: (running: boolean) => void
  toggleRunning: () => void
  setPaused: (paused: boolean) => void
  setSpeed: (speed: number) => void
  setSimulationMode: (mode: TrafficMode) => void
  setGlobalMultiplier: (value: number) => void
  runs: SimulationRun[]
  activeRunStart: number | null

  setNodeMetrics: (nodeId: string, metrics: NodeMetrics) => void
  setAllNodeMetrics: (batch: Map<string, NodeMetrics>) => void
  markBottleneck: (nodeId: string, isSaturated: boolean) => void
  setNodeConfig: (nodeId: string, config: Partial<NodeSimConfig>) => void
  setEdgeRps: (edgeId: string, rps: number) => void
  getEdgeRps: (edgeId: string) => number
  addEvent: (event: Omit<SimEvent, 'id'>) => void
  clearEvents: () => void
  setSloStatus: (nodeId: string, status: SloStatus) => void
  setActiveScript: (script: ScaleScript | null) => void
  pushRun: (run: SimulationRun) => void
  reset: () => void
}

let _eventCounter = 0

const MAX_EVENTS = 200

export const useSimulationStore = create<SimulationStore>((set, get) => ({
  running: false,
  paused: false,
  speed: 1,
  simulationMode: 'steady',
  globalMultiplier: 1,
  nodeMetrics: new Map(),
  bottlenecks: new Set(),
  nodeConfigs: new Map(),
  edgeRps: new Map(),
  events: [],
  sloStatus: new Map(),
  activeScript: null,
  runs: [],
  activeRunStart: null,

  setRunning: (running) => set({ running }),
  toggleRunning: () => set(s => ({ running: !s.running })),
  setPaused: (paused) => set({ paused }),
  setSpeed: (speed) => set({ speed }),
  setSimulationMode: (mode) => set({ simulationMode: mode }),
  setGlobalMultiplier: (value) => set({ globalMultiplier: value }),

  setNodeMetrics: (nodeId, metrics) =>
    set(s => {
      const next = new Map(s.nodeMetrics)
      next.set(nodeId, metrics)
      return { nodeMetrics: next }
    }),

  setAllNodeMetrics: (batch) => set(() => ({ nodeMetrics: new Map(batch) })),

  markBottleneck: (nodeId, isSaturated) =>
    set(s => {
      const next = new Set(s.bottlenecks)
      isSaturated ? next.add(nodeId) : next.delete(nodeId)
      return { bottlenecks: next }
    }),

  setNodeConfig: (nodeId, config) =>
    set(s => {
      const next = new Map(s.nodeConfigs)
      const existing = next.get(nodeId)
      next.set(nodeId, { ...(existing ?? { maxRps: 1000, processingMs: 10, errorRate: 0 }), ...config })
      return { nodeConfigs: next }
    }),

  setEdgeRps: (edgeId, rps) =>
    set(s => {
      const next = new Map(s.edgeRps)
      next.set(edgeId, rps)
      return { edgeRps: next }
    }),

  getEdgeRps: (edgeId) => get().edgeRps.get(edgeId) ?? 100,

  addEvent: (event) =>
    set(s => {
      const id = String(++_eventCounter)
      const next = [{ ...event, id }, ...s.events].slice(0, MAX_EVENTS)
      return { events: next }
    }),

  clearEvents: () => set({ events: [] }),

  setSloStatus: (nodeId, status) =>
    set(s => {
      const next = new Map(s.sloStatus)
      next.set(nodeId, status)
      return { sloStatus: next }
    }),

  setActiveScript: (script) => set({ activeScript: script }),

  pushRun: (run) => set(s => ({ runs: [run, ...s.runs].slice(0, 10) })),

  reset: () =>
    set({
      running: false,
      paused: false,
      nodeMetrics: new Map(),
      bottlenecks: new Set(),
      events: [],
      sloStatus: new Map(),
    }),
}))
