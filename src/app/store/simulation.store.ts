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
import { eventLogAppend, eventLogBeginRun } from '../../lib/tauri'
import { useFileStore } from './file.store'

// In-memory events are a PRESENTATION WINDOW only — what the live Events tab renders without
// mounting an unbounded DOM list. Nothing is lost past it: every event also lands in the
// durable event log (SQLite WAL via event_log_* commands; in-memory map in browser dev),
// flushed in 1 Hz batches below. User decision 2026-07-12: no hard caps on event HISTORY —
// overflow spills to disk, `eventLogTotal` carries the true count.
const EVENT_WINDOW = 500
const EVENT_FLUSH_MS = 1000

// Module-local spill state — deliberately NOT store state: buffering/flushing happens every
// second and per event, and none of it should re-render views (only eventLogTotal does).
let pendingEvents: EngineEvent[] = []
let flushTimer: ReturnType<typeof setInterval> | null = null
let spillBroken = false   // one persistent failure disables spill for the run (no 1 Hz error spam)

function flushEventLog(): void {
  const { eventLogRunId } = useSimulationStore.getState()
  if (eventLogRunId === null || spillBroken || pendingEvents.length === 0) return
  const batch = pendingEvents
  pendingEvents = []
  eventLogAppend(eventLogRunId, batch)
    .then(total => useSimulationStore.setState({ eventLogTotal: total }))
    .catch((e) => {
      // The sim (and the in-memory window) keeps working without the disk spill; surface the
      // failure once instead of once per second.
      spillBroken = true
      console.error('event log: disk spill failed — keeping the in-memory window only', e)
    })
}

function stopEventFlusher(): void {
  if (flushTimer !== null) clearInterval(flushTimer)
  flushTimer = null
  flushEventLog()   // final drain so a run's last second of events isn't dropped
}

interface SimulationStoreV2 {
  running: boolean
  // A run that is active but frozen: the engine has halted ticking (no new frames/events), yet the
  // session — latestBatch, events, manual outages, the event-log run — is kept so resume()
  // continues seamlessly. `running` stays true while paused (the world is still edit-locked); use
  // `selectLive` to gate "is the sim actively producing frames" (animations, live reads).
  paused: boolean
  timeScale: number
  latestBatch: MetricsBatch | null
  events: EngineEvent[]
  healthOverrides: Record<string, boolean>
  scrubIndex: number | null
  scrubBatch: MetricsBatch | null
  degraded: boolean
  /** Durable event-log run id for the CURRENT run; null until the backend acks the run row. */
  eventLogRunId: number | null
  /** True total events persisted this run — the Events tab shows this beside the window. */
  eventLogTotal: number

  start: (doc: WorldDoc, compiled: CompiledWorld) => void
  stop: () => void
  // Freeze/continue an active run (engine halts/resumes ticking; session state is preserved).
  pause: () => void
  resume: () => void
  // Doc swaps (New/Open) call this instead of stop(): healthOverrides referenced the
  // discarded world's ids, and a stale latestBatch/replay ring would let ScrubberV2 offer
  // frames from a world that no longer exists (see ScrubberV2.tsx's latestBatch gate).
  resetSession: () => void
  setTimeScale: (scale: number) => void
  setOutage: (scope: 'server' | 'az' | 'region' | 'managed', id: string, down: boolean) => void
  setScrubIndex: (i: number | null) => void
  attachRenderer: (scope: RenderScope, onFrame: (p: FramePayload) => void) => DetachFn
  getReplayFrames: () => ReplayFrame[]
  getTracedRequests: (scope: RenderScope) => TracedRequest[]
}

// "Live" = the sim is actively producing new frames: running, not paused, and not scrubbing a past
// frame. Flow animations and other live-motion cues gate on this so they freeze on pause/end/scrub
// (the engine-driven globe/board particles already stop when ticking halts; the region/AZ views use
// CSS/SMIL animations keyed off rps, which would otherwise keep marching over a frozen batch).
export const selectLive = (s: SimulationStoreV2): boolean => s.running && !s.paused && s.scrubIndex === null

export const useSimulationStore = create<SimulationStoreV2>((set, get) => ({
  running: false,
  paused: false,
  timeScale: 1,
  latestBatch: null,
  events: [],
  healthOverrides: {},
  scrubIndex: null,
  scrubBatch: null,
  degraded: false,
  eventLogRunId: null,
  eventLogTotal: 0,

  start: (doc, compiled) => {
    set({
      running: true, paused: false, latestBatch: null, events: [], degraded: false, scrubIndex: null,
      scrubBatch: null, eventLogRunId: null, eventLogTotal: 0,
    })
    pendingEvents = []
    spillBroken = false
    // Action-time read only (no subscription): the run row wants a human-readable label.
    eventLogBeginRun(useFileStore.getState().fileName ?? 'untitled')
      .then(runId => {
        useSimulationStore.setState({ eventLogRunId: runId })
        flushEventLog()   // catch anything buffered before the ack (incl. a sub-second run)
      })
      .catch((e) => {
        spillBroken = true
        console.error('event log: could not begin run — keeping the in-memory window only', e)
      })
    if (flushTimer !== null) clearInterval(flushTimer)
    flushTimer = setInterval(flushEventLog, EVENT_FLUSH_MS)
    worldEngine.start(doc, compiled, {
      onMetrics: (batch) => set({ latestBatch: batch }),
      onEvent: (event) => {
        pendingEvents.push(event)
        set((s) => {
          const next = s.events.length >= EVENT_WINDOW ? [...s.events.slice(s.events.length - EVENT_WINDOW + 1), event] : [...s.events, event]
          return event.kind === 'engine_degraded' ? { events: next, degraded: true } : { events: next }
        })
      },
      onHealthChange: () => {},
    })
    // The engine's start() always begins at 1x; re-apply the store's selection so the UI's
    // timeScale survives Stop → Simulate (it silently reset to realtime before, leaving the
    // select claiming 2x/4x while the engine ran 1x).
    worldEngine.setTimeScale(get().timeScale)
  },
  stop: () => {
    worldEngine.stop()
    stopEventFlusher()
    // Manual outages don't outlive a run (user request 2026-07-11): stopping restores
    // everything you killed. The engine rebuilds its failover state on the next start()
    // anyway — this clears the UI side (kill/restore buttons, health tinting keyed off
    // healthOverrides) so a fresh Simulate starts from a healthy world.
    set({ running: false, paused: false, healthOverrides: {} })
  },
  // Pause: halt the engine (which PRESERVES state) and keep the whole session — latestBatch,
  // events, manual outages, the event-log run and its 1 Hz flusher (no new events tick in while
  // frozen, so the flusher simply idles). `running` stays true so the world remains edit-locked.
  pause: () => {
    if (!get().running || get().paused) return
    worldEngine.stop()
    set({ paused: true })
  },
  // Resume: continue ticking the same run from where it froze (engine clock/metrics/replay intact).
  // Snap back to the live head — a scrub position set while paused must not keep the views frozen
  // on a past frame once the sim is live again.
  resume: () => {
    if (!get().running || !get().paused) return
    worldEngine.resume()
    set({ paused: false, scrubIndex: null, scrubBatch: null })
  },
  resetSession: () => {
    worldEngine.stop()
    stopEventFlusher()
    set({
      running: false, paused: false, latestBatch: null, events: [], scrubIndex: null, scrubBatch: null,
      degraded: false, healthOverrides: {}, eventLogRunId: null, eventLogTotal: 0,
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
