// 1 Hz replay ring (300 frames = 5 min) + per-scope synthetic request tracer.
// The facade pushes one ReplayFrame per second (batch + that second's event window) and
// calls tracer.sample() in the same tick.
import type { ReplayFrame, TracedRequest, RenderScope } from './types'
import type { Rng } from './rng'
import type { InstanceFlow } from './flows'
import { managedBaseLatencyMs } from '../managedCapacity'
import type { ManagedDbRuntime } from '../managedDbRuntime'
import { hopLatencyMs } from './networkRuntime'
import { REGION_GEO } from '../world/regionGeo'
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

// Roulette-wheel selection weighted by rps (audit ISSUE-040) — a 1-rps blocked edge no longer
// samples as often as a 1000-rps main path, so traces are representative of real traffic.
// All-zero/negative weights fall back to a uniform pick. Seeded rng ⇒ deterministic.
function pickWeighted<T>(rng: Rng, items: T[], weightOf: (t: T) => number): T {
  let total = 0
  for (const it of items) total += Math.max(0, weightOf(it))
  if (total <= 0) return rng.pick(items)
  let r = rng.range(0, total)
  for (const it of items) {
    r -= Math.max(0, weightOf(it))
    if (r <= 0) return it
  }
  return items[items.length - 1]
}

export interface Tracer {
  sample(
    flows: Record<InstanceId, InstanceFlow>,
    compiled: CompiledWorld,
    doc: WorldDoc,
    simMs: number,
    // Every population currently feeding the entry's region with its live rps (audit
    // ISSUE-039): the tracer attributes the trace by a WEIGHTED draw over these, so when
    // several populations converge on one region, traces split ∝ their traffic instead of
    // always crediting whichever population happened to be listed first.
    populationsOf?: (entryInstanceId: InstanceId) => { populationId: PopulationId; rps: number }[],
    // Phase 5.4 managed-DB failure model for THIS step. A managed hop used to book a flat 3ms, so a
    // trace through a saturated DB disagreed with the metrics pyramid by orders of magnitude.
    // Optional: absent ⇒ the flat constant (non-DB managed services keep it regardless).
    managedDbRuntime?: ManagedDbRuntime,
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
    sample(flows, compiled, doc, simMs, populationsOf, managedDbRuntime) {
      // Entry instances: offered demand and nothing upstream feeding them.
      const fedByOthers = new Set<string>()
      for (const f of Object.values(flows)) {
        for (const row of f.downstream) if (row.toInstanceId) fedByOthers.add(row.toInstanceId)
      }
      const entries = Object.values(flows)
        .filter(f => f.offeredRps > 0 && !fedByOthers.has(f.instanceId) && compiled.instances[f.instanceId])
      if (entries.length === 0) return

      // rps-weighted sampling (audit ISSUE-040): entries ∝ offered demand, hops ∝ row rps.
      const entry = pickWeighted(rng, entries, f => f.offeredRps)
      const hops: TracedRequest['hops'] = []
      const touchedInstances = [entry.instanceId]
      let cur = entry.instanceId
      let refused = false
      for (let depth = 0; depth < MAX_TRACE_DEPTH; depth++) {
        const f = flows[cur]
        if (!f || f.downstream.length === 0) break
        const row = pickWeighted(rng, f.downstream, r => r.rps)
        const toId = row.toInstanceId ?? row.toManagedServiceId ?? ''
        let latencyMs = 0
        if (!row.blocked) {
          const fromRegionCatalogId = doc.regions[compiled.instances[cur]?.regionId]?.catalogId ?? null
          // Managed hop time: the DB runtime's p50 when available, else the target's per-class
          // base latency (audit ISSUE-037 — a cache hit and an object-store GET are no longer
          // both booked at one flat constant; unknown types keep the historical 3 ms).
          const downstreamServiceMs = row.toInstanceId
            ? (flows[row.toInstanceId]?.serviceLatencyMs ?? 1)
            : (row.toManagedServiceId ? managedDbRuntime?.[row.toManagedServiceId]?.p50Ms : undefined)
              ?? managedBaseLatencyMs(doc.managedServices[row.toManagedServiceId ?? '']?.nodeType ?? '')
          const toRegionCatalogId = row.toInstanceId
            ? (doc.regions[compiled.instances[row.toInstanceId]?.regionId]?.catalogId ?? null)
            : null
          const networkHopLatencyMs = hopLatencyMs(row.hopClass, fromRegionCatalogId, toRegionCatalogId, null, REGION_GEO, rng)
          latencyMs = networkHopLatencyMs + downstreamServiceMs
        }
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

      // Weighted population attribution (audit ISSUE-039): several populations converging on
      // one region credit traces ∝ their rps into it, drawn from the tracer's OWN seeded rng
      // (never the sim stream — trace cadence must not perturb sim outcomes).
      const feeding = populationsOf ? populationsOf(entry.instanceId) : []
      const populationId = feeding.length > 0
        ? pickWeighted(rng, feeding, p => p.rps).populationId
        : null
      const trace: TracedRequest = {
        id: `trace-${simMs}-${traceSeq++}`,
        populationId,
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
