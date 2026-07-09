import { create } from 'zustand'
import type { NodeMetrics } from './simulationLegacy.store'

// Outage Playback Recorder — health-snapshot ring buffer.
// Mirrors the ring-buffer pattern in metricsHistory.store.ts. Holds one full per-node
// NodeMetrics map per second (1 Hz). Particle keyframes live in the engine (15 fps);
// this store only owns the 1 Hz health timeline plus the shared replay cursor.

export interface HealthFrame {
  elapsedS: number
  metrics: Map<string, NodeMetrics>
}

const MAX_HEALTH_FRAMES = 300 // 5 minutes at 1s resolution

interface ReplayStore {
  healthFrames: HealthFrame[]
  frameTimes: number[]        // elapsedS of each PARTICLE frame; published by the engine on pause
  isReplaying: boolean
  replayIndex: number         // index into frameTimes / engine particle buffer; -1 = live

  recordHealthFrame: (elapsedS: number, metrics: Map<string, NodeMetrics>) => void
  startReplay: (frameTimes: number[]) => void
  setReplayIndex: (i: number) => void
  stopReplay: () => void
  clearAll: () => void

  // Resolve the health frame at the current replay cursor (largest elapsedS <= T).
  currentMetricsMap: () => Map<string, NodeMetrics> | null
  metricsAt: (nodeId: string) => NodeMetrics | null
}

export const useReplayStore = create<ReplayStore>((set, get) => ({
  healthFrames: [],
  frameTimes: [],
  isReplaying: false,
  replayIndex: -1,

  recordHealthFrame: (elapsedS, metrics) =>
    set(s => {
      // new Map(metrics) is a safe shallow clone: the engine builds a fresh NodeMetrics
      // object every tick and never mutates it in place, so sharing value refs is correct.
      const next = [...s.healthFrames, { elapsedS, metrics: new Map(metrics) }]
      if (next.length > MAX_HEALTH_FRAMES) next.splice(0, next.length - MAX_HEALTH_FRAMES)
      return { healthFrames: next }
    }),

  startReplay: (frameTimes) =>
    set({
      frameTimes,
      isReplaying: frameTimes.length > 0,
      replayIndex: frameTimes.length - 1,
    }),

  setReplayIndex: (i) =>
    set(s => ({
      replayIndex: Math.max(0, Math.min(i, s.frameTimes.length - 1)),
      isReplaying: s.frameTimes.length > 0,
    })),

  stopReplay: () => set({ isReplaying: false, replayIndex: -1 }),

  clearAll: () => set({ healthFrames: [], frameTimes: [], isReplaying: false, replayIndex: -1 }),

  currentMetricsMap: () => {
    const s = get()
    if (!s.isReplaying || s.replayIndex < 0) return null
    const T = s.frameTimes[s.replayIndex]
    if (T === undefined) return null
    // healthFrames are chronological — scan for the latest frame at or before T.
    let chosen: HealthFrame | null = null
    for (const f of s.healthFrames) {
      if (f.elapsedS <= T) chosen = f
      else break
    }
    if (!chosen && s.healthFrames.length > 0) chosen = s.healthFrames[0]
    return chosen?.metrics ?? null
  },

  metricsAt: (nodeId) => get().currentMetricsMap()?.get(nodeId) ?? null,
}))
