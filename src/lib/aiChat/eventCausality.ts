import type { EngineEvent, EngineEventKind, ReplayFrame } from '../worldEngine/types'
import type { WorldDoc, CompiledWorld } from '../world/types'
import { blastRadius } from '../world/dependents'

export interface CausalEpisode {
  seedEventId: string
  kind: EngineEventKind
  severity: EngineEvent['severity']
  startMs: number
  repeatedForMs: number
  roles: { primaryId: string; secondaryId: string | null }
  before: { errorRate?: number; coreUtilization?: number[] } | null
  after: { errorRate?: number; coreUtilization?: number[] } | null
  consequences: { id: string; depth: number; metric: string }[]
  followOnEvents: { id: string; kind: EngineEventKind; simMs: number }[]
  unexplainedSpikes: string[]
  message: string
}

export function decodeAffected(
  kind: EngineEventKind, affected: string[],
): { primaryId: string; secondaryId: string | null } {
  switch (kind) {
    case 'oom_kill':
    case 'instance_restarted':
      return { primaryId: affected[0] ?? '', secondaryId: affected[1] || null }
    case 'connection_refused':
    case 'breaker_open':
    case 'breaker_half_open':
    case 'breaker_closed':
      return { primaryId: affected[0] ?? '', secondaryId: affected[1] || null }
    case 'ttl_lag_expired':
    case 'failover_started':
    case 'failover_completed':
      return { primaryId: affected[0] ?? '', secondaryId: affected[2] || affected[1] || null }
    case 'replica_promoted':
      return affected.length >= 2
        ? { primaryId: affected[0], secondaryId: affected[1] }
        : { primaryId: affected[0] ?? '', secondaryId: null }
    case 'primary_failback': {
      const promoted = affected[affected.length - 1] ?? ''
      const firstFailed = affected.length > 1 ? affected[0] : null
      return { primaryId: promoted, secondaryId: firstFailed }
    }
    case 'health_check_failed':
    case 'noisy_neighbor':
    case 'burst_credits_exhausted':
    case 'outage_triggered':
    case 'outage_cleared':
    case 'fault_injected':
    case 'fault_cleared':
      return { primaryId: affected[0] ?? '', secondaryId: null }
    case 'engine_degraded':
      return { primaryId: '', secondaryId: null }
    case 'chain_depth_exceeded':
      return { primaryId: affected[0] ?? '', secondaryId: null }
    case 'chain_cycle_cut':
      return { primaryId: affected[0] ?? '', secondaryId: affected[1] || null }
    case 'partition_started':
    case 'partition_healed':
      return { primaryId: affected[0] ?? '', secondaryId: affected[1] || null }
    case 'scenario_step_applied':
      return { primaryId: affected[0] ?? '', secondaryId: affected[1] || null }
    case 'cache_cold':
    case 'cache_warm':
      return { primaryId: affected[0] ?? '', secondaryId: null }
    case 'replication_lag_high':
      return { primaryId: affected[0] ?? '', secondaryId: affected[1] || null }
    case 'stale_read_served':
      return { primaryId: affected[0] ?? '', secondaryId: null }
  }
}

const SEED_KINDS = new Set<EngineEventKind>([
  'breaker_open', 'failover_started', 'health_check_failed', 'replica_promoted', 'connection_refused',
])
const WINDOW_MS = 15_000

function isSeed(e: EngineEvent): boolean {
  return e.severity === 'critical' || SEED_KINDS.has(e.kind)
}

function metricFor(instanceId: string, batch: ReplayFrame['batch']): number | undefined {
  return batch.instances[instanceId]?.errorRate
}

export function buildCausalEpisodes(
  frames: ReplayFrame[], doc: WorldDoc, compiled: CompiledWorld,
): CausalEpisode[] {
  const episodes: CausalEpisode[] = []
  const collapsedKeys = new Map<string, CausalEpisode>()

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]
    for (const e of f.events) {
      if (!isSeed(e)) continue
      const { primaryId, secondaryId } = decodeAffected(e.kind, e.affected)
      const key = `${e.kind}|${primaryId}|${secondaryId ?? ''}`
      const existing = collapsedKeys.get(key)
      if (existing && f.simMs - existing.startMs <= WINDOW_MS * 2) {
        existing.repeatedForMs = f.simMs - existing.startMs
        continue
      }

      const before = frames[i - 1] ? { errorRate: metricFor(primaryId, frames[i - 1].batch) } : null
      const windowFrames = frames.filter(wf => wf.simMs >= f.simMs && wf.simMs <= f.simMs + WINDOW_MS)
      const afterRate = Math.max(0, ...windowFrames.map(wf => metricFor(primaryId, wf.batch) ?? 0))
      const after = { errorRate: afterRate }

      const radius = primaryId ? blastRadius(primaryId, doc, compiled) : { direct: [], transitive: [], depthOf: {} }
      const dependents = new Set([...radius.direct, ...radius.transitive, primaryId, secondaryId].filter(Boolean) as string[])

      const consequences: CausalEpisode['consequences'] = []
      const unexplainedSpikes: string[] = []
      for (const wf of windowFrames) {
        for (const [instId, m] of Object.entries(wf.batch.instances)) {
          if (m.errorRate < 0.3) continue
          if (dependents.has(instId)) {
            if (!consequences.some(c => c.id === instId)) {
              consequences.push({ id: instId, depth: radius.depthOf[instId] ?? 0, metric: `errorRate=${m.errorRate}` })
            }
          } else if (!unexplainedSpikes.includes(instId)) {
            unexplainedSpikes.push(instId)
          }
        }
      }

      const followOnEvents: CausalEpisode['followOnEvents'] = []
      for (const wf of windowFrames) {
        for (const fe of wf.events) {
          if (fe.id === e.id) continue
          const decoded = decodeAffected(fe.kind, fe.affected)
          if (dependents.has(decoded.primaryId) || (decoded.secondaryId && dependents.has(decoded.secondaryId))) {
            followOnEvents.push({ id: fe.id, kind: fe.kind, simMs: fe.simMs })
          }
        }
      }

      const episode: CausalEpisode = {
        seedEventId: e.id, kind: e.kind, severity: e.severity, startMs: f.simMs, repeatedForMs: 0,
        roles: { primaryId, secondaryId }, before, after,
        consequences, followOnEvents, unexplainedSpikes, message: e.message,
      }
      collapsedKeys.set(key, episode)
      episodes.push(episode)
    }
  }

  return selectTopEpisodes(episodes, 8)
}

// Pure recency would let a cluster of low-severity episodes near the tail of the buffer (e.g.
// connection_refused, rate-limited to ~1/sec but able to re-seed a new episode every ~30s) push
// an earlier `critical` episode (oom_kill, breaker_open on a critical dependency, ...) out of the
// window entirely — undermining the "what went wrong" diagnosis this feature exists for. Critical
// episodes are therefore always kept; remaining slots are filled by recency among the rest.
function selectTopEpisodes(episodes: CausalEpisode[], limit: number): CausalEpisode[] {
  const byRecency = [...episodes].sort((a, b) => b.startMs - a.startMs)
  const critical = byRecency.filter(e => e.severity === 'critical')
  const rest = byRecency.filter(e => e.severity !== 'critical')
  const combined = [...critical, ...rest.slice(0, Math.max(0, limit - critical.length))]
  return combined.sort((a, b) => b.startMs - a.startMs).slice(0, limit)
}
