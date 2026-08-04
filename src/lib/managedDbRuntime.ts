// src/lib/managedDbRuntime.ts
// The cloud-managed DB failure model (node-model Phase 5.4) — pure, no engine imports.
//
// Before 5.3 a managed DB failed along exactly ONE axis (rps vs its instance-class write/read
// ceiling) at a fixed 3ms latency. This module gives it the three behaviours a stress test needs:
//
//   1. QUEUEING LATENCY — effLatency = base / (1 - saturation). Latency climbs as the DB fills,
//      so "how loaded is it" becomes watchable instead of inferred.
//   2. QUERY TIMEOUT — once effLatency passes `queryTimeoutMs`, a growing fraction of admitted
//      calls ERROR. This is the SOFT failure that bites BEFORE the hard rps ceiling: a tight
//      timeout makes the DB fail at a throughput well under its raw capacity. It is the direct
//      answer to "at what throughput does this DB fall over".
//   3. CONNECTION CEILING — live connections ≈ rps × latency (Little's law) against the class's
//      maxConnections. A SECOND saturation axis: a DB can be throughput-fine but connection-drowned,
//      and because latency feeds it, queueing and connections compound.
//
// ── AGGREGATE vs PER-CALLER (the Phase 5.4 architectural decision; plan §2.1) ────────────────
// flows.ts historically enforced the managed ceiling PER CALLER, inside its per-dependency loop:
// `share` there is one caller's slice, not the total. Two callers each sending 60% of the ceiling
// were therefore both admitted in full and the DB silently absorbed 120%. Every mechanism above is
// a function of AGGREGATE rps (you cannot compute queue depth or live connections from one
// caller's share), so 5.3 inverts the direction:
//
//   this module computes ONE aggregate `refusalFraction` per DB from the PREVIOUS step's flows,
//   and flows.ts applies that fraction to each caller's share.
//
// Callers are throttled proportionally and the aggregate is finally correct. Consequences:
//   • managedDbCeilings() (flows.ts) SURVIVES and is the single source of capacity truth — this
//     module CALLS it rather than recomputing ceilings, so the two can never disagree.
//   • managedDbRefusedRps()/managedRefusedRps() (flows.ts) stay exported for non-DB services and
//     for the no-runtime fallback, but a DB with a live runtime entry no longer reaches them.
// The one-step lag mirrors the existing hostScheduler → flows `admittedScale` pattern.
import type { InstanceId, ManagedServiceId, ManagedService, WorldDoc, CompiledWorld, BlueprintDependency } from './world/types'
import { managedDbEngine } from './world/types'
import { getDbInstanceClass } from './dbInstanceClasses'
import { managedDbCeilings } from './worldEngine/flows'

// Serverless/on-demand lifts the class ceiling this many times before it throttles — it rarely
// refuses, trading a per-request price for the headroom (priced in costModelV2).
export const SERVERLESS_BURST_MULTIPLIER = 4

// Per-engine base service latency (ms) at ZERO saturation, split by operation. NoSQL point ops are
// cheaper than SQL's planner + ACID write path. These replace the old flat MANAGED_SERVICE_LATENCY_MS
// for DB nodes only; every other managed type keeps the flat constant.
export const DB_BASE_LATENCY_MS: Record<'sql' | 'nosql', { readMs: number; writeMs: number }> = {
  sql: { readMs: 3, writeMs: 6 },
  nosql: { readMs: 1.5, writeMs: 4 },
}

// Extra READ latency (ms) from where the replicas live. Writes always hit the primary, so locality
// never penalises them. Cross-region reads also book egress (costModelV2).
export const REPLICA_LOCALITY_READ_MS: Record<string, number> = {
  sameAz: 0,
  multiAz: 1.5,
  crossRegion: 30,
}

// Saturation is clamped here so latency stays finite past the ceiling (1/(1-1) is infinite). At the
// clamp a DB serves at 50x its base latency — comprehensively broken, which is the intent.
const MAX_SATURATION_FOR_LATENCY = 0.98
const P99_OVER_P50 = 3
const EPSILON_RPS = 1e-9

export interface ManagedDbRuntimeEntry {
  totalRps: number                 // aggregate offered rps across every caller (previous step)
  saturation: number               // 0..1+ on the BINDING axis (max of write/read utilization)
  p50Ms: number                    // effective service latency under this load
  p99Ms: number
  connections: number              // live connections ≈ admitted rps × latency (Little's law)
  timeoutErrorFraction: number     // 0..1 of admitted calls erroring on queryTimeoutMs
  connectionRefusedRps: number     // refused for exhausting maxConnections
  ceilingRefusedRps: number        // refused for exceeding the write/read rps ceiling
  refusalFraction: number          // 0..1 of offered that flows.ts must refuse (the §2.1 seam)
}

// The failure model for ONE managed DB at a given aggregate load. Returns null when the service is
// not a capacity-modelled DB (non-DB nodeType, or a DB with no instance class chosen — the
// uncapped pre-Phase-3 behavior), so callers know to fall back to the flat ceiling path.
export function managedDbRuntimeFor(
  ms: ManagedService,
  totalRps: number,
  writeFraction: number,
): ManagedDbRuntimeEntry | null {
  const engine = managedDbEngine(ms.nodeType)
  if (!engine) return null
  const ceilings = managedDbCeilings(ms)     // single source of capacity truth (see header)
  if (!ceilings) return null
  const cls = getDbInstanceClass(ms.instanceClassId)
  if (!cls) return null

  // Serverless bursts BOTH ceilings; provisioned holds the class exactly.
  const burst = ms.capacityMode === 'serverless' ? SERVERLESS_BURST_MULTIPLIER : 1
  const writeCeiling = ceilings.writeCeiling * burst
  const readCeiling = ceilings.readCeiling * burst

  const w = Math.min(1, Math.max(0, writeFraction))
  const offeredWrite = totalRps * w
  const offeredRead = totalRps * (1 - w)

  // Writes and reads overflow INDEPENDENTLY (a write-bound workload throttles while reads have
  // headroom), so the refused amounts sum — same rule as the pre-5.3 per-caller path.
  const ceilingRefusedRps =
    Math.max(0, offeredWrite - writeCeiling) + Math.max(0, offeredRead - readCeiling)

  // Provisioned storage IOPS (FEAT-006, Task 20) as a THIRD, independent binding axis: a DB can
  // be write/read-rps-fine and still be disk-bound. No per-request IOPS cost is authored for a
  // managed DB (unlike a self-hosted server's workload.diskIoPerRequest), so this approximates
  // demand as 1 op ~= 1 IOPS — every offered request (read or write) costs one disk operation —
  // against `provisionedIops` scaled by the SAME serverless burst multiplier the write/read
  // ceilings already use. Absent `provisionedIops` ⇒ iopsUtilization stays 0, which cannot raise
  // max() above what write/read already produce — the exact pre-Task-20 saturation for every
  // existing world (the regression floor).
  const iopsCeiling = ms.provisionedIops != null ? ms.provisionedIops * burst : undefined
  const iopsUtilization = iopsCeiling != null && iopsCeiling > 0 ? totalRps / iopsCeiling : 0

  // Saturation is the BINDING axis, not the blend: a DB pinned on writes is saturated even with
  // idle read capacity, and it is the pinned axis that drives the queue.
  const saturation = Math.max(
    writeCeiling > 0 ? offeredWrite / writeCeiling : 0,
    readCeiling > 0 ? offeredRead / readCeiling : 0,
    iopsUtilization,
  )

  // Base latency blends the two operation costs by mix, then locality taxes only the read share.
  const base = DB_BASE_LATENCY_MS[engine]
  const localityMs = REPLICA_LOCALITY_READ_MS[ms.replicaLocality ?? 'sameAz'] ?? 0
  const hasReplicas = (ms.replicaCount ?? 0) > 0
  const readMs = base.readMs + (hasReplicas ? localityMs : 0)
  const baseMs = w * base.writeMs + (1 - w) * readMs

  // Queueing: the classic 1/(1-ρ) blow-up, clamped so a past-ceiling DB stays finite.
  const p50Ms = baseMs / (1 - Math.min(saturation, MAX_SATURATION_FOR_LATENCY))
  const p99Ms = p50Ms * P99_OVER_P50

  // Whatever survived the rps ceiling is what actually occupies connections.
  const admittedRps = Math.max(0, totalRps - ceilingRefusedRps)
  const connections = admittedRps * (p50Ms / 1000)
  const maxConnections = ms.maxConnections ?? cls.maxConnections
  const connectionRefusedRps = connections > maxConnections && connections > EPSILON_RPS
    ? admittedRps * (1 - maxConnections / connections)
    : 0

  // The soft failure: past the timeout, an increasing share of admitted calls error out. Linear in
  // the overshoot — at 2x the timeout everything times out.
  const timeout = ms.queryTimeoutMs
  const timeoutErrorFraction = timeout != null && timeout > 0 && p50Ms > timeout
    ? Math.min(1, (p50Ms - timeout) / timeout)
    : 0

  const refusalFraction = totalRps > EPSILON_RPS
    ? Math.min(1, (ceilingRefusedRps + connectionRefusedRps) / totalRps)
    : 0

  return {
    totalRps, saturation, p50Ms, p99Ms,
    connections: Math.min(connections, maxConnections),
    timeoutErrorFraction, connectionRefusedRps, ceilingRefusedRps, refusalFraction,
  }
}

export type ManagedDbRuntime = Record<ManagedServiceId, ManagedDbRuntimeEntry>

// Aggregate load reaching each managed DB, summed across EVERY caller's downstream rows — the
// input the model above needs and the per-caller path structurally could not see. `writeFraction`
// comes from the calling blueprint's dependency, so a mixed read/write world aggregates a
// load-weighted mix rather than any one caller's.
export function aggregateManagedDbLoad(
  prevFlows: Record<InstanceId, { instanceId: InstanceId; downstream: { dependencyId: string; toManagedServiceId?: string; rps: number; blocked: boolean }[] }>,
  doc: WorldDoc,
  compiled: CompiledWorld,
  // Resolved per-dependency wire sizes from the engine's start()-time index (audit ISSUE-001).
  // A bound db packet mix derives the write fraction from its query types and supersedes the
  // edge's hand-authored slider — which EdgeInspector hides once a mix is bound, so reading the
  // raw field here would measure saturation against a split the user cannot see. Structurally
  // typed rather than importing WireSize, to keep this module free of packetResolve: the ONE
  // resolution point is buildDepWireBytes in the engine, and this reads its output.
  // Optional: absent ⇒ the raw dependency field, so existing direct callers are unchanged.
  depBytesById?: Record<string, { writeFraction?: number }>,
  // dependencyId → BlueprintDependency, the engine's start()-time index (audit ISSUE-014 — the
  // fifth recurrence of the unindexed-lookup class already fixed as ISSUE-032/073/075/076).
  // Replaces the `bp?.dependencies.find(...)` fallback below, which ran once per downstream row
  // per STEP (10 Hz) re-scanning a blueprint's full dependency list. Optional: absent ⇒ falls
  // back to the linear scan, so existing direct callers/tests are unchanged.
  depById?: Record<string, BlueprintDependency>,
): Record<ManagedServiceId, { totalRps: number; writeFraction: number }> {
  const acc: Record<ManagedServiceId, { totalRps: number; writeRps: number }> = {}
  for (const flow of Object.values(prevFlows)) {
    const inst = compiled.instances[flow.instanceId]
    const bp = inst ? doc.blueprints[inst.blueprintId] : undefined
    for (const row of flow.downstream) {
      const msId = row.toManagedServiceId
      if (!msId || row.rps <= 0) continue
      // Blocked rows never reached the service — they were refused at the caller.
      if (row.blocked) continue
      const w = Math.min(1, Math.max(0,
        depBytesById?.[row.dependencyId]?.writeFraction
        ?? depById?.[row.dependencyId]?.writeFraction
        ?? bp?.dependencies.find(d => d.id === row.dependencyId)?.writeFraction
        ?? 0))
      const a = acc[msId] ?? { totalRps: 0, writeRps: 0 }
      a.totalRps += row.rps
      a.writeRps += row.rps * w
      acc[msId] = a
    }
  }
  const out: Record<ManagedServiceId, { totalRps: number; writeFraction: number }> = {}
  for (const [id, a] of Object.entries(acc)) {
    out[id] = { totalRps: a.totalRps, writeFraction: a.totalRps > 0 ? a.writeRps / a.totalRps : 0 }
  }
  return out
}

// The whole per-step runtime: aggregate last step's load, then run the failure model per managed DB.
// Single source for BOTH the flow solver's refusal math and the metrics pyramid's DB gauges.
export function managedDbRuntime(
  prevFlows: Parameters<typeof aggregateManagedDbLoad>[0],
  doc: WorldDoc,
  compiled: CompiledWorld,
  // Forwarded to aggregateManagedDbLoad — see its parameter doc (audit ISSUE-001).
  depBytesById?: Parameters<typeof aggregateManagedDbLoad>[3],
  // Forwarded to aggregateManagedDbLoad — see its parameter doc (audit ISSUE-014).
  depById?: Parameters<typeof aggregateManagedDbLoad>[4],
): ManagedDbRuntime {
  const load = aggregateManagedDbLoad(prevFlows, doc, compiled, depBytesById, depById)
  const out: ManagedDbRuntime = {}
  for (const ms of Object.values(doc.managedServices)) {
    const l = load[ms.id] ?? { totalRps: 0, writeFraction: 0 }
    const entry = managedDbRuntimeFor(ms, l.totalRps, l.writeFraction)
    if (entry) out[ms.id] = entry
  }
  return out
}
