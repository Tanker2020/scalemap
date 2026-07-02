import type { Node } from '@xyflow/react'
import type { NodeData, NodeType } from '../../../../lib/nodeConfig'
import { GROUPING_TYPES } from '../../../../lib/nodeConfig'
import type { TrafficMode, SimEventType, NodeMetrics } from '../../../store/simulation.store'

// ─── Traffic mode: effective spawn multiplier + chaos/spike state ─────────────
// Moved verbatim out of particleEngine.ts (Task 0 — pure code motion, no behavior change).
// effectiveMultiplier itself is untouched here — splitting it into pure/impure halves is a
// separate follow-up (Warning doc W2), not this task.

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

export function effectiveMultiplier(
  now: number,
  trafficMode: TrafficMode,
  globalMultiplier: number,
  simulatedTimeMs: number,
  nodesMap: Map<string, Node<NodeData>>,
  onEvent: OnEvent,
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
      if (now >= _spikeEndAt) {
        if (_spikeNextAt === 0) _spikeNextAt = now + 30_000
        if (now >= _spikeNextAt) {
          _spikeEndAt  = now + 10_000    // 10s burst
          _spikeNextAt = _spikeEndAt + 30_000  // 30s cooldown
        }
      }
      const inSpike = now < _spikeEndAt
      return globalMultiplier * (inSpike ? 8 : 1)  // 8× flash crowd
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
