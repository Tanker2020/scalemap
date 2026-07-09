// 1 Hz replay ring (300 frames = 5 min) + per-scope synthetic request tracer.
// The facade pushes one ReplayFrame per second (batch + that second's event window) and
// calls tracer.sample() in the same tick.
import type { ReplayFrame, TracedRequest, RenderScope } from './types'
import type { Rng } from './rng'
import type { InstanceFlow } from './flows'
import type { WorldDoc, CompiledWorld, InstanceId, PopulationId } from '../world/types'

export interface ReplayBuffer {
  push(f: ReplayFrame): void
  getFrames(): ReplayFrame[]
}

export function createReplayBuffer(cap = 300): ReplayBuffer {
  const frames: ReplayFrame[] = []
  return {
    push(f) {
      frames.push(f)
      if (frames.length > cap) frames.splice(0, frames.length - cap)
    },
    getFrames() {
      return [...frames]
    },
  }
}

export function scopeKey(scope: RenderScope): string {
  switch (scope.level) {
    case 'globe': return 'globe'
    case 'region': return `region:${scope.regionId}`
    case 'az': return `az:${scope.azId}`
    case 'server': return `server:${scope.serverId}`
  }
}

const MAX_TRACES_PER_SCOPE = 10
const MAX_TRACE_DEPTH = 8

export interface Tracer {
  sample(
    flows: Record<InstanceId, InstanceFlow>,
    compiled: CompiledWorld,
    doc: WorldDoc,
    simMs: number,
    populationOf?: (entryInstanceId: InstanceId) => PopulationId | null,
  ): void
  getTraced(scope: RenderScope): TracedRequest[]
}

export function createTracer(rng: Rng): Tracer {
  const byScope = new Map<string, TracedRequest[]>()
  const lastSampleMs = new Map<string, number>()
  let traceSeq = 0

  function record(key: string, trace: TracedRequest, simMs: number) {
    if ((lastSampleMs.get(key) ?? -1) >= simMs) return   // ≤1 per scope per window
    lastSampleMs.set(key, simMs)
    const list = byScope.get(key) ?? []
    list.push(trace)
    if (list.length > MAX_TRACES_PER_SCOPE) list.splice(0, list.length - MAX_TRACES_PER_SCOPE)
    byScope.set(key, list)
  }

  return {
    sample(flows, compiled, _doc, simMs, populationOf) {
      // Entry instances: offered demand and nothing upstream feeding them.
      const fedByOthers = new Set<string>()
      for (const f of Object.values(flows)) {
        for (const row of f.downstream) if (row.toInstanceId) fedByOthers.add(row.toInstanceId)
      }
      const entries = Object.values(flows)
        .filter(f => f.offeredRps > 0 && !fedByOthers.has(f.instanceId) && compiled.instances[f.instanceId])
      if (entries.length === 0) return

      const entry = rng.pick(entries)
      const hops: TracedRequest['hops'] = []
      const touchedInstances = [entry.instanceId]
      let cur = entry.instanceId
      let refused = false
      for (let depth = 0; depth < MAX_TRACE_DEPTH; depth++) {
        const f = flows[cur]
        if (!f || f.downstream.length === 0) break
        const row = rng.pick(f.downstream)
        const toId = row.toInstanceId ?? row.toManagedServiceId ?? ''
        const latencyMs = row.blocked ? 0 : row.toInstanceId ? (flows[row.toInstanceId]?.serviceLatencyMs ?? 1) : 3
        hops.push({
          fromId: cur,
          toId,
          hopClass: row.hopClass,
          latencyMs,
          outcome: row.blocked ? 'refused' : 'ok',
        })
        if (row.blocked) { refused = true; break }
        if (!row.toInstanceId) break                     // managed target is terminal
        cur = row.toInstanceId
        touchedInstances.push(cur)
      }

      const trace: TracedRequest = {
        id: `trace-${simMs}-${traceSeq++}`,
        populationId: populationOf ? populationOf(entry.instanceId) : null,
        hops,
        totalMs: entry.serviceLatencyMs + hops.reduce((s, h) => s + h.latencyMs, 0),
        outcome: refused ? 'refused' : 'ok',
      }

      // Record into every scope the walk touched.
      const keys = new Set<string>(['globe'])
      const entryInst = compiled.instances[entry.instanceId]
      keys.add(`region:${entryInst.regionId}`)
      for (const id of touchedInstances) {
        const inst = compiled.instances[id]
        if (!inst) continue
        keys.add(`az:${inst.azId}`)
        keys.add(`server:${inst.serverId}`)
      }
      for (const key of keys) record(key, trace, simMs)
    },

    getTraced(scope) {
      return [...(byScope.get(scopeKey(scope)) ?? [])]
    },
  }
}
