// src/app/store/simulation.store.ts — v2 (Phase 2). The legacy shape retired here with the
// legacy engine; the old store lives on verbatim as simulationLegacy.store.ts until Task 17
// deletes it with the rest of the legacy tree. Views read this store; only its actions call
// the worldEngine facade. Shape: frozen contracts §"Store publication" + the sanctioned
// additive fields scrubIndex/scrubBatch (T15 consumer) and degraded (perf watch — T12 owns it).
import { create } from 'zustand'
import type { WorldDoc, CompiledWorld } from '../../lib/world/types'
import type {
  MetricsBatch, EngineEvent, RenderScope, FramePayload, DetachFn, ReplayFrame, TracedRequest,
} from '../../lib/worldEngine/types'
import { worldEngine } from '../../lib/worldEngine'

const EVENT_CAP = 500

interface SimulationStoreV2 {
  running: boolean
  timeScale: number
  latestBatch: MetricsBatch | null
  events: EngineEvent[]
  healthOverrides: Record<string, boolean>
  scrubIndex: number | null
  scrubBatch: MetricsBatch | null
  degraded: boolean

  start: (doc: WorldDoc, compiled: CompiledWorld) => void
  stop: () => void
  // Doc swaps (New/Open) call this instead of stop(): healthOverrides referenced the
  // discarded world's ids, and a stale latestBatch/replay ring would let ScrubberV2 offer
  // frames from a world that no longer exists (see ScrubberV2.tsx's latestBatch gate).
  resetSession: () => void
  setTimeScale: (scale: number) => void
  setOutage: (scope: 'server' | 'az' | 'region', id: string, down: boolean) => void
  setScrubIndex: (i: number | null) => void
  attachRenderer: (scope: RenderScope, onFrame: (p: FramePayload) => void) => DetachFn
  getReplayFrames: () => ReplayFrame[]
  getTracedRequests: (scope: RenderScope) => TracedRequest[]
}

export const useSimulationStore = create<SimulationStoreV2>((set, get) => ({
  running: false,
  timeScale: 1,
  latestBatch: null,
  events: [],
  healthOverrides: {},
  scrubIndex: null,
  scrubBatch: null,
  degraded: false,

  start: (doc, compiled) => {
    set({ running: true, latestBatch: null, events: [], degraded: false, scrubIndex: null, scrubBatch: null })
    worldEngine.start(doc, compiled, {
      onMetrics: (batch) => set({ latestBatch: batch }),
      onEvent: (event) =>
        set((s) => {
          const next = s.events.length >= EVENT_CAP ? [...s.events.slice(s.events.length - EVENT_CAP + 1), event] : [...s.events, event]
          return event.kind === 'engine_degraded' ? { events: next, degraded: true } : { events: next }
        }),
      onHealthChange: () => {},
    })
    // The engine's start() always begins at 1x; re-apply the store's selection so the UI's
    // timeScale survives Stop → Simulate (it silently reset to realtime before, leaving the
    // select claiming 2x/4x while the engine ran 1x).
    worldEngine.setTimeScale(get().timeScale)
  },
  stop: () => {
    worldEngine.stop()
    set({ running: false })
  },
  resetSession: () => {
    worldEngine.stop()
    set({
      running: false, latestBatch: null, events: [], scrubIndex: null, scrubBatch: null,
      degraded: false, healthOverrides: {},
    })
  },
  setTimeScale: (scale) => {
    worldEngine.setTimeScale(scale)
    set({ timeScale: scale })
  },
  setOutage: (scope, id, down) => {
    worldEngine.setOutage(scope, id, down)
    set((s) => ({ healthOverrides: { ...s.healthOverrides, [id]: down } }))
  },
  setScrubIndex: (i) => {
    const frames = worldEngine.getReplayFrames()
    set({ scrubIndex: i, scrubBatch: i === null ? null : frames[i]?.batch ?? null })
  },
  attachRenderer: (scope, onFrame) => worldEngine.attachRenderer(scope, onFrame),
  getReplayFrames: () => worldEngine.getReplayFrames(),
  getTracedRequests: (scope) => worldEngine.getTracedRequests(scope),
}))
