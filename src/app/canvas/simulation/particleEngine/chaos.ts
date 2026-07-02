import type { Node } from '@xyflow/react'
import type { NodeData, NodeType } from '../../../../lib/nodeConfig'
import { GROUPING_TYPES } from '../../../../lib/nodeConfig'
import type { TrafficMode, SimEventType, NodeMetrics } from '../../../store/simulation.store'

// ─── Traffic mode: effective spawn multiplier + chaos/spike state ─────────────
// Moved verbatim out of particleEngine.ts (Task 0 — pure code motion, no behavior change).
//
// Split (Warning doc W2, GitHub #5): the original single `effectiveMultiplier` both read AND
// mutated chaos/spike schedule state, but was called multiple times per frame (once per particle
// arrival, plus once each in spawnParticles/updateAllNodeMetrics). Internal "next-fire" gates
// happened to make repeated same-`now` calls idempotent, but nothing structurally enforced that.
// Now split into:
//   - trafficMultiplier: pure read of the current multiplier, safe to call any number of times.
//   - advanceChaosSchedule: impure, advances _spikeEndAt/_spikeNextAt/chaos victims and emits
//     chaos_failure/chaos_recovery events — must be called exactly once per frame.

// Spike mode state
let _spikeNextAt = 0
let _spikeEndAt  = 0

// Chaos mode failure entry — mode determines how the failure manifests
export interface ChaosEntry {
  expiry: number
  mode: 'crash' | 'latency' | 'partial'
  dropRate: number  // fraction of arriving requests that fail (1.0 = crash, 0.9 = latency, 0.5–0.8 = partial)
}
const _chaosFailures = new Map<string, ChaosEntry>()
let _chaosNextFailAt = 0

export function getChaosFailures(): Map<string, ChaosEntry> {
  return _chaosFailures
}

type OnEvent = (
  type: SimEventType,
  nodeId: string | undefined,
  message: string,
  severity: 'info' | 'warn' | 'critical',
  snapshot?: Partial<NodeMetrics>,
  causedByNodeId?: string,
) => void

// Impure: advances spike/chaos schedule state (_spikeEndAt/_spikeNextAt/_chaosNextFailAt/
// _chaosFailures) and emits chaos_failure/chaos_recovery events. Call exactly once per frame,
// before any reads of trafficMultiplier for that frame — never per-arrival or per-edge.
export function advanceChaosSchedule(
  now: number,
  trafficMode: TrafficMode,
  // Unused: 'ramp'/'steady' modes have no chaos schedule to advance (they `return` immediately
  // below) and 'spike'/'chaos' timers run on `now`, not simulated time — kept in the signature so
  // this stays parameter-symmetric with trafficMultiplier per the two-clock design from Task 0.
  _simulatedTimeMs: number,
  nodesMap: Map<string, Node<NodeData>>,
  onEvent: OnEvent,
): void {
  switch (trafficMode) {
    case 'steady':
    case 'ramp':
      return

    case 'spike': {
      if (now >= _spikeEndAt) {
        if (_spikeNextAt === 0) _spikeNextAt = now + 30_000
        if (now >= _spikeNextAt) {
          _spikeEndAt  = now + 10_000    // 10s burst
          _spikeNextAt = _spikeEndAt + 30_000  // 30s cooldown
        }
      }
      return
    }

    case 'chaos': {
      if (_chaosNextFailAt === 0) _chaosNextFailAt = now + 5_000 + Math.random() * 10_000
      if (now >= _chaosNextFailAt) {
        const nonGroupNodes = [...nodesMap.values()].filter(n => !GROUPING_TYPES.has(n.type as NodeType))
        if (nonGroupNodes.length > 0) {
          const victim = nonGroupNodes[Math.floor(Math.random() * nonGroupNodes.length)]
          const failDuration = 5_000 + Math.random() * 15_000  // 5–20s failures
          const wasAlreadyFailed = _chaosFailures.has(victim.id)
          const modeRoll = Math.random()
          const mode: ChaosEntry['mode'] = modeRoll < 0.4 ? 'crash' : modeRoll < 0.7 ? 'latency' : 'partial'
          const dropRate = mode === 'crash' ? 1.0 : mode === 'latency' ? 0.9 : 0.5 + Math.random() * 0.3
          _chaosFailures.set(victim.id, { expiry: now + failDuration, mode, dropRate })
          if (!wasAlreadyFailed) {
            const label = (victim.data as NodeData).label ?? victim.id
            const modeLabel = mode === 'crash' ? 'crash' : mode === 'latency' ? 'latency spike' : 'partial failure'
            onEvent('chaos_failure', victim.id, `${label} ${modeLabel} (chaos)`, 'warn')
          }
        }
        _chaosNextFailAt = now + 5_000 + Math.random() * 10_000
      }
      // Emit recovery events for expired failures
      for (const [id, entry] of _chaosFailures) {
        if (now > entry.expiry) {
          const node = nodesMap.get(id)
          const label = node ? (node.data as NodeData).label ?? id : id
          _chaosFailures.delete(id)
          onEvent('chaos_recovery', id, `${label} recovered`, 'info')
        }
      }
      if (_spikeNextAt === 0) _spikeNextAt = now + 8_000
      if (now >= _spikeNextAt) {
        _spikeEndAt  = now + 5_000
        _spikeNextAt = _spikeEndAt + 8_000 + Math.random() * 8_000
      }
      return
    }
  }
}

// Pure: reads current spike/chaos schedule state (never mutates it) to compute the effective
// spawn multiplier. Safe to call any number of times per frame — spawnParticles,
// updateAllNodeMetrics, and per-arrival glow calculations all call this directly.
export function trafficMultiplier(
  now: number,
  trafficMode: TrafficMode,
  globalMultiplier: number,
  simulatedTimeMs: number,
  // Unused by the pure computation (chaos victim lookup lives in advanceChaosSchedule only) —
  // kept in the signature so every call site can pass the same five arguments it already has in
  // scope without a special case, and so the two-clock (now vs. simulatedTimeMs) design from
  // Task 0 stays visually symmetric between trafficMultiplier and advanceChaosSchedule.
  _nodesMap: Map<string, Node<NodeData>>,
): number {
  switch (trafficMode) {
    case 'steady':
      return globalMultiplier

    case 'ramp': {
      // Ramp progresses in simulation time, so it survives pauses and tracks playback speed
      // (2× speed reaches full load in half the wall-clock time, not a fixed 2 real minutes).
      const elapsed = simulatedTimeMs
      const rampMs  = 120_000   // 2-min ramp to observe cascade effects
      return globalMultiplier * Math.min(1, elapsed / rampMs)
    }

    case 'spike': {
      const inSpike = now < _spikeEndAt
      return globalMultiplier * (inSpike ? 8 : 1)  // 8× flash crowd
    }

    case 'chaos': {
      const inSpike = now < _spikeEndAt
      return globalMultiplier * (inSpike ? 6 : 1)  // 6× chaos spikes
    }
  }
}

export function clearChaosState(): void {
  _spikeNextAt     = 0
  _spikeEndAt      = 0
  _chaosNextFailAt = 0
  _chaosFailures.clear()
}
