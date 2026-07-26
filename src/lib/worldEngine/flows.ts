// Per-step flow solver: contribution-based BFS from entry instances across compiled paths.
// The heart of the engine — everything downstream (host loads, metrics, particles, cost
// bytes) reads this module's output. Spec decision 6 + skeleton T8 semantics:
//   admitted = offered x admittedScale(server) x healthFactor (down 0 / degraded 0.7)
//   every dependency fans out the FULL admitted rps (call-per-request, like legacy),
//   split evenly across the dependency's compiled targets — blocked ones included
//   (the caller can't see the misconfig; attempts on blocked paths are LIVE failures)
//   blocked share -> caller refusedRps + blocked downstream row (no bytes, no propagation)
//   breakerOpen(pathKey) short-circuits the whole dependency (refused, no rows)
//   depth cap 8; cycles guarded per request chain (parent-pointer chain walk, ISSUE-074)
import type {
  CompiledWorld, WorldDoc, CompiledPath, InstanceId, ServerId, HopClass,
  ServiceBlueprint, ManagedService, ManagedServiceId, PlacementRole,
} from '../world/types'
import { managedDbEngine } from '../world/types'
import { managedCapacityRps } from '../managedCapacity'
import { MANAGED_RESPONSE_KB } from '../cloudRegistry'
import type { HealthState } from './types'
import type { Rng } from './rng'
import { sampleLatencyMs } from './latency'
import { pathKey } from './breakers'
import { getDbInstanceClass } from '../dbInstanceClasses'
// Type-only: managedDbRuntime.ts imports managedDbCeilings from here, so a VALUE import would be a
// runtime cycle. `import type` erases at compile time and keeps the dependency one-way.
import type { ManagedDbRuntime } from '../managedDbRuntime'

// 2KB per request in EACH direction (request out + response back, so every hop books
// 2 x 2048 bytes per request). A deliberately simple Phase-2 constant — packet templates
// refine per-protocol sizes in a later phase. Totals are bytes/sec (inputs are rps).
export const BYTES_PER_REQUEST_EACH_WAY = 2048

// Managed targets have no capacity model in Phase 2: fixed service latency, always
// admits. Exported for metrics (T10) and tracing (T11) to attribute managed-hop time.
export const MANAGED_SERVICE_LATENCY_MS = 3

const MAX_DEPTH = 8                 // hop-depth cap; demand landing at depth 8 stops there
const DEGRADED_ADMIT_FACTOR = 0.7   // degraded instances still serve most of their load
const EPSILON_RPS = 1e-9            // below this, a contribution is dead — don't propagate
// Queue bound (audit ISSUE-013): an instance queues up to this many seconds of its own service
// capacity; arrivals beyond it time out (errorRps). A down instance (capacity 0) has a zero
// queue, so its whole subtree still errors instantly.
export const MAX_QUEUE_SEC = 2
// Blueprints carry no authored latency model (only workload.cpuMsPerRequest), so service
// latency samples log-normal with p50 = cpuMsPerRequest and this p99 spread — legacy
// NODE_SIM_DEFAULTS spreads ran 10-12.5x. SKELETON CONCERNS #5.
const SERVICE_P99_OVER_P50 = 10

// Splits `admitted` rps across a dependency's compiled candidate paths (node-model Phase 3).
//
// The pre-Phase-3 behavior — and still the behavior for every NON-DB dependency — is an even
// split across all candidates. This function only diverges when the target is a DB blueprint,
// where the call volume carries reads and writes with different destinations:
//
//   SQL   — writes → the primary(s); reads → the replicas (or the primary when there are none,
//           so a single-node DB still serves its reads). Writes concentrating on one primary is
//           the single-writer ceiling: the primary's host CPU (hostScheduler.admittedScale) caps
//           them, and the SPOF falls out for free.
//   NoSQL — writes AND reads → every node. Adding nodes raises write capacity; no write SPOF.
//
// Returns a share per candidate, aligned to `candidates` order, summing to `admitted` (given at
// least one eligible target in each non-empty pool). Blocked candidates are included and get their
// share like today — the caller can't see the misconfig, so the attempt is still made and refused.
export function splitDependencyShares(
  admitted: number,
  candidates: CompiledPath[],
  roleOf: (instanceId: InstanceId) => PlacementRole,
  targetBp: ServiceBlueprint | undefined,
  writeFraction: number,
  // Audit ISSUE-006: per-target health weight (down ⇒ 0, degraded ⇒ its admit factor, healthy
  // ⇒ 1) — mirrors the entry tier's down-exclusion so internal traffic routes around failures
  // too. Optional: absent ⇒ every target weighs 1, the pre-fix even split (existing callers and
  // tests unchanged). Managed targets have no instance health and always weigh 1 (their
  // down-state is the separate managedDown gate).
  healthWeightOf: (instanceId: InstanceId) => number = () => 1,
): number[] {
  const n = candidates.length

  // Single-pass share accumulation (audit ISSUE-077): this runs per dependency per active
  // instance per tick, so the old map/filter/reduce chains (weights array + pool filter +
  // per-pool share arrays + sum2 merge, ~6 allocations per SQL call) were steady per-tick GC
  // pressure. One weights array + one output array now; identical numeric results. Role
  // classification deliberately stays per-call (NOT hoisted to start() as the audit sketched):
  // roleOf carries the promotion overlay, so roles CAN change mid-run.
  const weights = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    const p = candidates[i]
    weights[i] = p.to.kind === 'instance' ? healthWeightOf(p.to.instanceId) : 1
  }
  const shares = new Array<number>(n).fill(0)

  // Distribute `amount` across the candidates flagged by `inPool`, proportionally to health
  // weight, ACCUMULATING into `shares`. A pool whose every member is down (total weight 0)
  // falls back to the even split — there is nothing to route around, so the attempts still
  // land and fail LIVE at the dead targets (the 100%-error signal the caller's breaker feed
  // needs to trip).
  const distributeInto = (amount: number, inPool: (i: number) => boolean): void => {
    let total = 0
    let poolSize = 0
    for (let i = 0; i < n; i++) {
      if (inPool(i)) { total += weights[i]; poolSize++ }
    }
    if (total <= 0) {
      if (poolSize === 0) return
      const even = amount / poolSize
      for (let i = 0; i < n; i++) if (inPool(i)) shares[i] += even
      return
    }
    for (let i = 0; i < n; i++) if (inPool(i)) shares[i] += (amount * weights[i]) / total
  }

  // Non-DB target (or unknown): health-weighted split over all candidates (even when all are
  // equally healthy — identical to the pre-Phase-3 even split). writeFraction is meaningless
  // without primary/replica semantics, so it is ignored here.
  const engine = targetBp?.dbConfig?.engine
  if (!engine || engine === 'nosql') {
    // (NoSQL: every node is both a read and a write target, so each candidate's total is just
    // its health-weighted share — but the write/read SPLIT is what downstream capacity
    // accounting cares about.)
    distributeInto(admitted, () => true)
    return shares
  }

  const w = Math.min(1, Math.max(0, writeFraction))

  // SQL: partition by EFFECTIVE role. A managed target (a cloud DB has no primary/replica
  // instances here) is treated as writable. roleOf carries the Phase-4 promotion overlay, so a
  // promoted replica reads back as 'primary' here and writes route to it.
  const isPrimary = new Array<boolean>(n)
  let primaryCount = 0
  let replicaWeight = 0
  for (let i = 0; i < n; i++) {
    const p = candidates[i]
    isPrimary[i] = p.to.kind === 'instance' ? roleOf(p.to.instanceId) === 'primary' : true
    if (isPrimary[i]) primaryCount++
    else replicaWeight += weights[i]
  }
  const replicaCount = n - primaryCount

  // A candidate is a WRITE target if it's a primary — or, in the degenerate no-primary case,
  // every candidate is (writes must land somewhere). A candidate is a READ target if it's a
  // replica — or, when there are no replicas, the primaries serve reads too.
  // Health-aware pool selection (audit ISSUE-006, asymmetric on purpose): reads SPILL to the
  // primaries when every replica is down — a primary can always serve reads, and without the
  // spill a demoted (down) original pins the whole read share as errors, tripping the caller's
  // breaker against a perfectly healthy promoted primary. Writes never spill to replicas — a
  // replica can't take writes until promotion flips its role.
  const noPrimary = primaryCount === 0
  const noReplica = replicaCount === 0 || (replicaWeight <= 0 && !noPrimary)
  const isWriteTarget = (i: number): boolean => noPrimary || isPrimary[i]
  const isReadTarget = (i: number): boolean => noReplica ? isWriteTarget(i) : !isPrimary[i]

  // Writes and reads each distribute health-weighted within their own pool.
  if (w > 0) distributeInto(admitted * w, isWriteTarget)
  if (w < 1) distributeInto(admitted * (1 - w), isReadTarget)
  return shares
}

// How much of `share` rps a cloud-managed DB REFUSES because it exceeds the instance class's
// capacity (node-model Phase 3). A managed DB has no host, so unlike a self-hosted DB its ceiling
// is not emergent from host CPU — the chosen class carries it explicitly. Returns 0 for a non-DB
// managed service or one with no class set (back-compat: uncapped, the pre-Phase-3 behavior).
//
//   SQL   — writeRps is a SINGLE-writer ceiling; replicas add read capacity only, never write.
//   NoSQL — writeRps is per-node, so nodes (1 primary + replicas) multiply it.
//   Both  — replicas raise the read ceiling. multiAz is a failover standby: cost, not capacity.
//
// Writes and reads overflow INDEPENDENTLY (a write-bound workload can throttle while reads have
// headroom, and vice-versa), so the refused amounts sum.
// The write/read ceilings a cloud-managed DB's instance class implies. Single source for BOTH the
// flow solver's refusal math (below) and the metrics pyramid's utilization gauge (metrics.ts) —
// extracted node-model Phase 5.1 so the two can never drift on what a class's capacity is. Returns
// null for a non-DB managed service or one with no class chosen (uncapped, pre-Phase-3 behavior).
export function managedDbCeilings(ms: ManagedService): { writeCeiling: number; readCeiling: number } | null {
  const engine = managedDbEngine(ms.nodeType)
  if (!engine) return null
  const cls = getDbInstanceClass(ms.instanceClassId)
  if (!cls) return null
  const replicas = Math.max(0, ms.replicaCount ?? 0)
  const writeCeiling = engine === 'nosql' ? cls.writeRps * (1 + replicas) : cls.writeRps
  const readCeiling = cls.readRps * (1 + replicas)
  return { writeCeiling, readCeiling }
}

export function managedDbRefusedRps(share: number, writeFraction: number, ms: ManagedService): number {
  const ceilings = managedDbCeilings(ms)
  if (!ceilings) return 0   // non-DB or uncapped until a class is chosen

  const w = Math.min(1, Math.max(0, writeFraction))
  const refusedWrite = Math.max(0, share * w - ceilings.writeCeiling)
  const refusedRead = Math.max(0, share * (1 - w) - ceilings.readCeiling)
  return refusedWrite + refusedRead
}

// How much of `share` rps ANY managed service refuses over its ceiling (node-model Phase 5.2).
// A DB uses its instance-class write/read split (above); every other type uses a single flat
// throughput ceiling (managedCapacity.ts) — so a queue/cache/object store is no longer an infinite
// sink. Returns 0 for an uncapped service (a DB with no class, or a type with no default).
export function managedRefusedRps(share: number, writeFraction: number, ms: ManagedService): number {
  if (managedDbCeilings(ms)) return managedDbRefusedRps(share, writeFraction, ms)
  const cap = managedCapacityRps(ms)
  if (cap == null || !Number.isFinite(cap)) return 0
  return Math.max(0, share - cap)
}

export interface FlowInput {
  compiled: CompiledWorld
  doc: WorldDoc
  entryDemand: Record<InstanceId, number>          // rps landed on entry instances this step (from routing)
  admittedScaleByServer: Record<ServerId, number>  // from host scheduler (previous sub-step)
  latencyMultiplierByServer: Record<ServerId, number>
  // ── Queue model (audit ISSUE-013) — all three supplied together by the engine ──
  // Per-instance service capacity in rps (hostScheduler's fair-share rates, ISSUE-018). When
  // present WITH queueDepth+stepSec, the solver runs the queueing path: served =
  // min(capacity, arrivals + backlog), excess fills a bounded queue carried across ticks, and
  // ONLY overflow past the bound becomes errorRps. Absent ⇒ the legacy proportional path
  // (admitted = offered × admittedScale × healthFactor, excess errors instantly) — existing
  // callers and tests unchanged.
  serviceRateByInstance?: Record<InstanceId, number>
  // Requests waiting per instance, MUTATED in place each call (the engine owns the map and
  // carries it across ticks).
  queueDepth?: Map<InstanceId, number>
  // Step length in seconds — converts between rps and queued request counts.
  stepSec?: number
  // Additive per-server latency (audit ISSUE-002): the previous step's NIC queued-latency
  // settlement, added on top of the multiplied service latency. Optional: absent ⇒ 0 extra,
  // so existing callers and tests are unchanged.
  extraLatencyMsByServer?: Record<ServerId, number>
  // Per-entry-instance client-facing wire bytes (packet-driven egress, slice 1): the request+
  // response payload size the route mix landing on each entry instance implies. Seeds the
  // client→entry internet byte total by real payload size. Optional: absent ⇒ the flat
  // BYTES_PER_REQUEST_EACH_WAY convention, so direct-solveFlows unit tests are unchanged.
  entryBytesByInstance?: Record<InstanceId, { reqBytes: number; respBytes: number }>
  breakerOpen: (pathKey: string) => boolean
  healthOf: (instanceId: InstanceId) => HealthState
  // Manual-outage predicate for managed services (node-model Phase 5.2). A managed service can't
  // be reached through instance health (it has no instance), so its manual down-state is passed
  // directly. Optional: absent ⇒ never down (existing callers/tests unchanged).
  managedDown?: (managedServiceId: string) => boolean
  // Effective role per instance (node-model Phase 4 promotion overlay). Optional: absent ⇒ the
  // compiled role, so callers that don't model promotion (and every existing test) are unchanged.
  roleOf?: (instanceId: InstanceId) => PlacementRole
  // Aggregate managed-DB failure model from the PREVIOUS step (node-model Phase 5.4), keyed by
  // managed-service id. Queueing latency, Little's-law connections and the timeout fraction are all
  // functions of TOTAL load, which this per-dependency loop structurally cannot see — so the
  // aggregate refusal fraction is computed once (managedDbRuntime.ts) and applied to each caller's
  // share here. Optional: absent ⇒ the pre-5.4 per-caller ceiling path, so existing callers and
  // tests are unchanged. Same one-step-lag shape as admittedScale.
  managedDbRuntime?: ManagedDbRuntime
  rng: Rng
}

export interface DownstreamFlow {
  dependencyId: string
  toInstanceId?: InstanceId
  toManagedServiceId?: string
  rps: number
  hopClass: HopClass
  blocked: boolean
  // Why a blocked managed row failed (node-model Phase 5.4), so the metrics pyramid can split a
  // throughput/connection THROTTLE from a query TIMEOUT — they look identical as rps but mean
  // opposite things to the user (too much load vs too slow). Absent on every non-managed row and
  // on admitted rows, which keeps existing row-equality assertions unchanged.
  failure?: 'throttled' | 'timeout'
}

export interface InstanceFlow {
  instanceId: InstanceId
  offeredRps: number
  admittedRps: number
  errorRps: number
  refusedRps: number
  serviceLatencyMs: number                          // sampled, multiplied
  downstream: DownstreamFlow[]
}

export interface FlowTotals {
  crossAzBytes: number
  crossRegionBytes: number
  internetBytes: number
  // Per-service served bytes for storage/CDN managed services (node-model Phase 5.2). These are
  // attributed here INSTEAD of the world cross-zone buckets above, so the cost model can price each
  // storage service's egress against its own provider schedule + storage free allowance.
  managedEgressBytes: Record<ManagedServiceId, number>
}

interface QueueItem {
  instanceId: InstanceId
  offered: number
  depth: number
  // Request-chain back-pointer (audit ISSUE-074): the cycle guard walks parents instead of
  // carrying a cloned Set per pushed edge. Depth is capped at MAX_DEPTH (8), so the walk is a
  // bounded ≤8-hop pointer chase — O(depth) time, zero allocation, vs a Set clone per edge.
  parent: QueueItem | null
}

// Does `id` already appear on this request chain? (The old `visited` Set semantics: the item's
// own instance plus every ancestor.)
function chainHas(item: QueueItem, id: InstanceId): boolean {
  for (let node: QueueItem | null = item; node !== null; node = node.parent) {
    if (node.instanceId === id) return true
  }
  return false
}

// Candidate-path index memo (audit ISSUE-075): fromInstanceId → dependencyId → CompiledPath[].
// compiled.paths never changes during a run, but solveFlows rebuilt this map every tick. Keyed
// weakly on the CompiledWorld object so a recompile (new identity) naturally gets a fresh index
// and stopped runs don't pin memory.
const pathIndexCache = new WeakMap<CompiledWorld, Map<InstanceId, Map<string, CompiledPath[]>>>()

function pathIndexFor(compiled: CompiledWorld): Map<InstanceId, Map<string, CompiledPath[]>> {
  const cached = pathIndexCache.get(compiled)
  if (cached) return cached
  // (compiled.paths order is deterministic, so the even split is too.)
  const index = new Map<InstanceId, Map<string, CompiledPath[]>>()
  for (const p of compiled.paths) {
    let byDep = index.get(p.fromInstanceId)
    if (!byDep) {
      byDep = new Map()
      index.set(p.fromInstanceId, byDep)
    }
    const list = byDep.get(p.dependencyId)
    if (list) list.push(p)
    else byDep.set(p.dependencyId, [p])
  }
  pathIndexCache.set(compiled, index)
  return index
}

export function solveFlows(input: FlowInput): { flows: Record<InstanceId, InstanceFlow>; totals: FlowTotals } {
  const {
    compiled, doc, entryDemand, admittedScaleByServer, latencyMultiplierByServer,
    breakerOpen, healthOf, rng,
  } = input
  // Default to the compiled role when the caller doesn't supply a promotion overlay.
  const roleOf = input.roleOf ?? ((id: InstanceId) => compiled.instances[id]?.role ?? 'primary')
  const managedDown = input.managedDown ?? (() => false)
  // Audit ISSUE-006: dependency fan-out weights each candidate by target health (mirroring the
  // entry tier's down-exclusion), so internal traffic routes around a down replica instead of
  // erroring 1/N of the group's calls forever.
  const healthWeightOf = (id: InstanceId): number => {
    const h = healthOf(id)
    return h === 'down' ? 0 : h === 'degraded' ? DEGRADED_ADMIT_FACTOR : 1
  }

  // Candidate-path index, memoized per compiled identity (audit ISSUE-075).
  const pathsByFromDep = pathIndexFor(compiled)

  const flows: Record<InstanceId, InstanceFlow> = {}
  const totals: FlowTotals = { crossAzBytes: 0, crossRegionBytes: 0, internetBytes: 0, managedEgressBytes: {} }

  // First-touch flow record; serviceLatencyMs is sampled exactly once per instance, in
  // BFS creation order (deterministic under a seeded rng).
  const getFlow = (id: InstanceId): InstanceFlow => {
    let f = flows[id]
    if (!f) {
      const inst = compiled.instances[id]
      const bp = inst ? doc.blueprints[inst.blueprintId] : undefined
      const p50 = Math.max(0.1, bp?.workload.cpuMsPerRequest ?? 1)
      const multiplier = inst ? (latencyMultiplierByServer[inst.serverId] ?? 1) : 1
      const extraMs = inst ? (input.extraLatencyMsByServer?.[inst.serverId] ?? 0) : 0
      f = {
        instanceId: id,
        offeredRps: 0,
        admittedRps: 0,
        errorRps: 0,
        refusedRps: 0,
        serviceLatencyMs: sampleLatencyMs(p50, p50 * SERVICE_P99_OVER_P50, rng) * multiplier + extraMs,
        downstream: [],
      }
      flows[id] = f
    }
    return f
  }

  // Contributions from different entries/chains can land on the same downstream row —
  // aggregate rps into one row per (dependency, target, blocked, failure) key. Keyed in a Map
  // (audit ISSUE-073): the old `f.downstream.find(...)` scanned the growing row array per
  // contribution — quadratic per tick for fan-heavy instances. Row array order is unchanged
  // (first-touch push order), so output is identical.
  const rowIndex = new Map<InstanceId, Map<string, DownstreamFlow>>()
  const addDownstream = (
    f: InstanceFlow,
    dependencyId: string,
    target: { toInstanceId?: InstanceId; toManagedServiceId?: string },
    rps: number,
    hopClass: HopClass,
    blocked: boolean,
    failure?: 'throttled' | 'timeout',
  ): void => {
    const key = `${dependencyId}|${target.toInstanceId ?? ''}|${target.toManagedServiceId ?? ''}|${blocked}|${failure ?? ''}`
    let rows = rowIndex.get(f.instanceId)
    if (!rows) {
      rows = new Map()
      rowIndex.set(f.instanceId, rows)
    }
    const row = rows.get(key)
    if (row) {
      row.rps += rps
    } else {
      const created: DownstreamFlow = { dependencyId, ...target, rps, hopClass, blocked, ...(failure ? { failure } : {}) }
      rows.set(key, created)
      f.downstream.push(created)
    }
  }

  const bucketBytes = (hopClass: HopClass, rps: number): void => {
    const bytes = rps * BYTES_PER_REQUEST_EACH_WAY * 2   // request + response
    if (hopClass === 'cross-az') totals.crossAzBytes += bytes
    else if (hopClass === 'cross-region') totals.crossRegionBytes += bytes
    // localhost / same-az transfer is free — no cost line for it
  }

  // ── Queue model plumbing (audit ISSUE-013) ──
  // Active only when the engine supplies all three inputs; unit tests calling solveFlows without
  // them run the legacy proportional path unchanged.
  const queueMode = !!(input.serviceRateByInstance && input.queueDepth && input.stepSec)
  const stepSec = input.stepSec ?? 0.1
  const queueDepth = input.queueDepth
  // Per-instance remaining serve capacity this tick (rps). Presence doubles as the first-touch
  // marker: the first item to reach an instance settles its backlog (timeout, wait latency,
  // backlog-first serving) exactly once.
  const remainingCapacity = new Map<InstanceId, number>()
  const capacityOf = new Map<InstanceId, number>()

  const queue: QueueItem[] = []
  const seeded = new Set<InstanceId>()
  for (const [instanceId, rps] of Object.entries(entryDemand)) {
    if (rps <= 0) continue
    queue.push({ instanceId, offered: rps, depth: 0, parent: null })
    seeded.add(instanceId)
    // Client -> entry traffic rides the public internet. Packet-driven egress (slice 1): the route
    // mix that landed here sets the request+response payload size; absent ⇒ the flat 2 KB-each-way
    // convention (BYTES_PER_REQUEST_EACH_WAY × 2), so worlds with no authored sizes are unchanged.
    const eb = input.entryBytesByInstance?.[instanceId]
    totals.internetBytes += rps * (eb ? eb.reqBytes + eb.respBytes : BYTES_PER_REQUEST_EACH_WAY * 2)
  }
  // Backlogged instances receiving no arrivals this tick still drain (and their served backlog
  // still fans out downstream): seed a zero-offered item so the normal first-touch path runs.
  if (queueMode) {
    for (const [instanceId, q] of queueDepth!) {
      if (q <= 0 || seeded.has(instanceId)) continue
      queue.push({ instanceId, offered: 0, depth: 0, parent: null })
    }
  }

  // BFS via head index (no O(n) shift; perf budget is 4ms/step at 2,000 instances).
  let head = 0
  while (head < queue.length) {
    const item = queue[head++]
    const inst = compiled.instances[item.instanceId]
    if (!inst) continue   // stale entry id — routing/compile drift, skip defensively
    const flow = getFlow(item.instanceId)
    flow.offeredRps += item.offered

    const health = healthOf(item.instanceId)
    const healthFactor = health === 'down' ? 0 : health === 'degraded' ? DEGRADED_ADMIT_FACTOR : 1
    const admittedScale = admittedScaleByServer[inst.serverId] ?? 1
    let admitted: number
    if (queueMode) {
      // ── Queueing path (audit ISSUE-013/016/018) ──
      // capacity = fair-share service rate × NIC delivered fraction × health. served =
      // min(capacity, backlog-first + arrivals); excess fills a bounded queue carried across
      // ticks; ONLY overflow/timeout becomes errorRps. Inherently damped: while a backlog
      // exists, served pins at capacity regardless of arrival oscillation — the proportional
      // admittedScale shed (and its two-step limit cycle) is gone from this path.
      let extraServe = 0
      let rem = remainingCapacity.get(item.instanceId)
      if (rem === undefined) {
        // First touch this tick: settle the carried queue against TODAY's capacity.
        const capacity = (input.serviceRateByInstance![item.instanceId] ?? 0) * admittedScale * healthFactor
        capacityOf.set(item.instanceId, capacity)
        const maxQueue = capacity * MAX_QUEUE_SEC
        let q0 = queueDepth!.get(item.instanceId) ?? 0
        if (q0 > maxQueue) {
          // Queue shrank (capacity dropped / instance died): the un-holdable tail times out.
          flow.errorRps += (q0 - maxQueue) / stepSec
          q0 = maxQueue
        }
        // Little's-law wait: requests queued behind q0 wait q0/capacity seconds.
        if (capacity > EPSILON_RPS && q0 > 0) flow.serviceLatencyMs += (q0 / capacity) * 1000
        const backlogServe = Math.min(q0 / stepSec, capacity)
        if (backlogServe > 0) {
          q0 = Math.max(0, q0 - backlogServe * stepSec)
          extraServe = backlogServe
        }
        queueDepth!.set(item.instanceId, q0)
        rem = capacity - backlogServe
      }
      const serveable = Math.min(item.offered, rem)
      remainingCapacity.set(item.instanceId, rem - serveable)
      const excess = item.offered - serveable
      if (excess > EPSILON_RPS) {
        const capacity = capacityOf.get(item.instanceId) ?? 0
        const maxQueue = capacity * MAX_QUEUE_SEC
        const q = queueDepth!.get(item.instanceId) ?? 0
        const queued = Math.min(excess * stepSec, Math.max(0, maxQueue - q))
        if (queued > 0) queueDepth!.set(item.instanceId, q + queued)
        flow.errorRps += excess - queued / stepSec   // only past-the-bound overflow errors
      }
      admitted = serveable + extraServe
      flow.admittedRps += admitted
    } else {
      // Legacy proportional path (pre-ISSUE-013 semantics) for callers without queue inputs.
      admitted = item.offered * admittedScale * healthFactor
      flow.admittedRps += admitted
      flow.errorRps += item.offered - admitted   // shed + down demand errors HERE
    }

    if (admitted <= EPSILON_RPS) continue      // a down instance zeroes its whole subtree
    if (item.depth >= MAX_DEPTH) continue      // landed, but fans out no further

    const bp = doc.blueprints[inst.blueprintId]
    if (!bp) continue
    const byDep = pathsByFromDep.get(item.instanceId)

    for (const dep of bp.dependencies) {
      // Per-dependency breaker short-circuit: whole call volume refused, no rows.
      if (breakerOpen(pathKey(item.instanceId, dep.id))) {
        flow.refusedRps += admitted
        continue
      }
      const candidates = byDep?.get(dep.id)
      if (!candidates || candidates.length === 0) continue   // dangling dep: compile emitted nothing
      // Call-per-request: the dependency sees the FULL admitted rps. For a non-DB target this is
      // an even split across ALL compiled targets (blocked ones included — the caller can't see
      // the misconfig); for a DB target it partitions into writes→primary / reads→replicas.
      const targetBp = dep.target.kind === 'blueprint' ? doc.blueprints[dep.target.blueprintId] : undefined
      const shares = splitDependencyShares(admitted, candidates, roleOf, targetBp, dep.writeFraction ?? 0, healthWeightOf)

      for (let ci = 0; ci < candidates.length; ci++) {
        const path = candidates[ci]
        const share = shares[ci]
        if (share <= EPSILON_RPS) continue   // this target received no traffic (e.g. reads-only DB primary)

        const target = path.to.kind === 'instance'
          ? { toInstanceId: path.to.instanceId }
          : { toManagedServiceId: path.to.managedServiceId }

        if (path.verdict === 'blocked') {
          // Refused ON THE CALLER; the blocked row is what events/particles render.
          flow.refusedRps += share
          addDownstream(flow, dep.id, target, share, path.hopClass, true)
          continue   // refused attempts carry no payload and reach nothing
        }

        if (path.to.kind === 'managed') {
          // Manual outage (node-model Phase 5.2): a downed managed service refuses its ENTIRE call
          // volume — a real dependency failure the caller sees as refused (like a blocked path),
          // no admitted remainder, no bytes. Checked before capacity, since down beats throttled.
          if (managedDown(path.to.managedServiceId)) {
            flow.refusedRps += share
            addDownstream(flow, dep.id, target, share, path.hopClass, true)
            continue
          }
          // Managed capacity (node-model Phase 3 for DBs, Phase 5.2 for every other type): the
          // service's ceiling caps admitted rps; over-ceiling demand is throttled — refused on the
          // caller and shown as a blocked row, while the admitted remainder carries bytes. A DB uses
          // its instance-class write/read split; other types use a flat throughput ceiling.
          const ms = doc.managedServices[path.to.managedServiceId]
          // Phase 5.4: when an aggregate runtime entry exists for this DB, its refusal fraction —
          // computed from TOTAL load across every caller — throttles this caller's share
          // proportionally, and its timeout fraction errors a slice of what survived. Without an
          // entry (non-DB service, unclassed DB, or no runtime supplied) fall back to the
          // pre-5.4 per-caller ceiling.
          const rt = ms ? input.managedDbRuntime?.[ms.id] : undefined
          const throttled = rt
            ? share * rt.refusalFraction
            : (ms ? managedRefusedRps(share, dep.writeFraction ?? 0, ms) : 0)
          const timedOut = rt ? (share - throttled) * rt.timeoutErrorFraction : 0
          const refused = throttled + timedOut
          const admittedToMs = share - refused
          if (admittedToMs > EPSILON_RPS) {
            addDownstream(flow, dep.id, target, admittedToMs, path.hopClass, false)
            // Storage/CDN services serve large responses: attribute those served bytes to the
            // service (priced per-service with a storage free allowance) INSTEAD of the world
            // cross-zone bucket, so nothing is double-counted. Every other managed type keeps the
            // cross-zone byte accounting — it's internal transfer, not storage egress.
            const responseKb = MANAGED_RESPONSE_KB[ms?.nodeType ?? '']
            if (responseKb != null) {
              const msId = path.to.managedServiceId
              totals.managedEgressBytes[msId] = (totals.managedEgressBytes[msId] ?? 0) + admittedToMs * responseKb * 1024
            } else {
              bucketBytes(path.hopClass, admittedToMs)
            }
          }
          // Two separate blocked rows so the metric can tell the failure modes apart.
          if (throttled > EPSILON_RPS) {
            flow.refusedRps += throttled
            addDownstream(flow, dep.id, target, throttled, path.hopClass, true, rt ? 'throttled' : undefined)
          }
          if (timedOut > EPSILON_RPS) {
            flow.refusedRps += timedOut
            addDownstream(flow, dep.id, target, timedOut, path.hopClass, true, 'timeout')
          }
          continue   // managed targets are terminal — no capacity subtree to propagate into
        }

        addDownstream(flow, dep.id, target, share, path.hopClass, false)
        bucketBytes(path.hopClass, share)

        const toId = path.to.instanceId
        if (chainHas(item, toId)) continue          // cycle guard: row recorded, no re-entry
        queue.push({ instanceId: toId, offered: share, depth: item.depth + 1, parent: item })
      }
    }
  }

  return { flows, totals }
}
