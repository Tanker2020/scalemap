// Per-step flow solver: contribution-based BFS from entry instances across compiled paths.
// The heart of the engine — everything downstream (host loads, metrics, particles, cost
// bytes) reads this module's output. Spec decision 6 + skeleton T8 semantics:
//   admitted = offered x admittedScale(server) x healthFactor (down 0 / degraded 0.7)
//   every dependency fans out the FULL admitted rps (call-per-request, like legacy),
//   split evenly across the dependency's compiled targets — blocked ones included
//   (the caller can't see the misconfig; attempts on blocked paths are LIVE failures)
//   blocked share -> caller refusedRps + blocked downstream row (no bytes, no propagation)
//   breakerOpen(pathKey) short-circuits the whole dependency (refused, no rows)
//   depth cap 8; cycles guarded per request chain (visited set carried on each item)
import type {
  CompiledWorld, WorldDoc, CompiledPath, InstanceId, ServerId, HopClass,
  ServiceBlueprint, ManagedService, PlacementRole,
} from '../world/types'
import { managedDbEngine } from '../world/types'
import type { HealthState } from './types'
import type { Rng } from './rng'
import { sampleLatencyMs } from './latency'
import { pathKey } from './breakers'
import { getDbInstanceClass } from '../dbInstanceClasses'

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
): number[] {
  const n = candidates.length
  const even = admitted / n

  // Non-DB target (or unknown): even split, exactly as before Phase 3. writeFraction is
  // meaningless without primary/replica semantics, so it is ignored here.
  const engine = targetBp?.dbConfig?.engine
  if (!engine) return candidates.map(() => even)

  const w = Math.min(1, Math.max(0, writeFraction))

  if (engine === 'nosql') {
    // Every node is both a read and a write target, so each candidate's total is just the even
    // share — but the write/read SPLIT is what downstream capacity accounting cares about.
    return candidates.map(() => even)
  }

  // SQL: partition by EFFECTIVE role. A managed target (a cloud DB has no primary/replica
  // instances here) is treated as writable. roleOf carries the Phase-4 promotion overlay, so a
  // promoted replica reads back as 'primary' here and writes route to it.
  const isPrimary = candidates.map(p =>
    p.to.kind === 'instance' ? roleOf(p.to.instanceId) === 'primary' : true)
  const primaryCount = isPrimary.filter(Boolean).length
  const replicaCount = n - primaryCount

  // A candidate is a WRITE target if it's a primary — or, in the degenerate no-primary case,
  // every candidate is (writes must land somewhere). A candidate is a READ target if it's a
  // replica — or, when there are no replicas, the primaries serve reads too.
  const noPrimary = primaryCount === 0
  const noReplica = replicaCount === 0
  const isWriteTarget = (i: number): boolean => noPrimary || isPrimary[i]
  const isReadTarget = (i: number): boolean => noReplica ? isWriteTarget(i) : !isPrimary[i]

  const writeCount = noPrimary ? n : primaryCount
  const readCount = noReplica ? (noPrimary ? n : primaryCount) : replicaCount
  const writeEach = w <= 0 ? 0 : (admitted * w) / writeCount
  const readEach = w >= 1 ? 0 : (admitted * (1 - w)) / readCount

  return candidates.map((_, i) =>
    (isWriteTarget(i) ? writeEach : 0) + (isReadTarget(i) ? readEach : 0))
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
export function managedDbRefusedRps(share: number, writeFraction: number, ms: ManagedService): number {
  const engine = managedDbEngine(ms.nodeType)
  if (!engine) return 0
  const cls = getDbInstanceClass(ms.instanceClassId)
  if (!cls) return 0   // uncapped until a class is chosen

  const replicas = Math.max(0, ms.replicaCount ?? 0)
  const writeCeiling = engine === 'nosql' ? cls.writeRps * (1 + replicas) : cls.writeRps
  const readCeiling = cls.readRps * (1 + replicas)

  const w = Math.min(1, Math.max(0, writeFraction))
  const refusedWrite = Math.max(0, share * w - writeCeiling)
  const refusedRead = Math.max(0, share * (1 - w) - readCeiling)
  return refusedWrite + refusedRead
}

export interface FlowInput {
  compiled: CompiledWorld
  doc: WorldDoc
  entryDemand: Record<InstanceId, number>          // rps landed on entry instances this step (from routing)
  admittedScaleByServer: Record<ServerId, number>  // from host scheduler (previous sub-step)
  latencyMultiplierByServer: Record<ServerId, number>
  breakerOpen: (pathKey: string) => boolean
  healthOf: (instanceId: InstanceId) => HealthState
  // Effective role per instance (node-model Phase 4 promotion overlay). Optional: absent ⇒ the
  // compiled role, so callers that don't model promotion (and every existing test) are unchanged.
  roleOf?: (instanceId: InstanceId) => PlacementRole
  rng: Rng
}

export interface DownstreamFlow {
  dependencyId: string
  toInstanceId?: InstanceId
  toManagedServiceId?: string
  rps: number
  hopClass: HopClass
  blocked: boolean
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
}

interface QueueItem {
  instanceId: InstanceId
  offered: number
  depth: number
  visited: Set<InstanceId>   // instances already on this request chain (cycle guard)
}

export function solveFlows(input: FlowInput): { flows: Record<InstanceId, InstanceFlow>; totals: FlowTotals } {
  const {
    compiled, doc, entryDemand, admittedScaleByServer, latencyMultiplierByServer,
    breakerOpen, healthOf, rng,
  } = input
  // Default to the compiled role when the caller doesn't supply a promotion overlay.
  const roleOf = input.roleOf ?? ((id: InstanceId) => compiled.instances[id]?.role ?? 'primary')

  // Index candidate paths once: fromInstanceId -> dependencyId -> CompiledPath[]
  // (compiled.paths order is deterministic, so the even split is too).
  const pathsByFromDep = new Map<InstanceId, Map<string, CompiledPath[]>>()
  for (const p of compiled.paths) {
    let byDep = pathsByFromDep.get(p.fromInstanceId)
    if (!byDep) {
      byDep = new Map()
      pathsByFromDep.set(p.fromInstanceId, byDep)
    }
    const list = byDep.get(p.dependencyId)
    if (list) list.push(p)
    else byDep.set(p.dependencyId, [p])
  }

  const flows: Record<InstanceId, InstanceFlow> = {}
  const totals: FlowTotals = { crossAzBytes: 0, crossRegionBytes: 0, internetBytes: 0 }

  // First-touch flow record; serviceLatencyMs is sampled exactly once per instance, in
  // BFS creation order (deterministic under a seeded rng).
  const getFlow = (id: InstanceId): InstanceFlow => {
    let f = flows[id]
    if (!f) {
      const inst = compiled.instances[id]
      const bp = inst ? doc.blueprints[inst.blueprintId] : undefined
      const p50 = Math.max(0.1, bp?.workload.cpuMsPerRequest ?? 1)
      const multiplier = inst ? (latencyMultiplierByServer[inst.serverId] ?? 1) : 1
      f = {
        instanceId: id,
        offeredRps: 0,
        admittedRps: 0,
        errorRps: 0,
        refusedRps: 0,
        serviceLatencyMs: sampleLatencyMs(p50, p50 * SERVICE_P99_OVER_P50, rng) * multiplier,
        downstream: [],
      }
      flows[id] = f
    }
    return f
  }

  // Contributions from different entries/chains can land on the same downstream row —
  // aggregate rps into one row per (dependency, target, blocked) triple.
  const addDownstream = (
    f: InstanceFlow,
    dependencyId: string,
    target: { toInstanceId?: InstanceId; toManagedServiceId?: string },
    rps: number,
    hopClass: HopClass,
    blocked: boolean,
  ): void => {
    const row = f.downstream.find(d =>
      d.dependencyId === dependencyId &&
      d.toInstanceId === target.toInstanceId &&
      d.toManagedServiceId === target.toManagedServiceId &&
      d.blocked === blocked)
    if (row) row.rps += rps
    else f.downstream.push({ dependencyId, ...target, rps, hopClass, blocked })
  }

  const bucketBytes = (hopClass: HopClass, rps: number): void => {
    const bytes = rps * BYTES_PER_REQUEST_EACH_WAY * 2   // request + response
    if (hopClass === 'cross-az') totals.crossAzBytes += bytes
    else if (hopClass === 'cross-region') totals.crossRegionBytes += bytes
    // localhost / same-az transfer is free — no cost line for it
  }

  const queue: QueueItem[] = []
  for (const [instanceId, rps] of Object.entries(entryDemand)) {
    if (rps <= 0) continue
    queue.push({ instanceId, offered: rps, depth: 0, visited: new Set([instanceId]) })
    // Client -> entry traffic rides the public internet.
    totals.internetBytes += rps * BYTES_PER_REQUEST_EACH_WAY * 2
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
    const admitted = item.offered * admittedScale * healthFactor
    flow.admittedRps += admitted
    flow.errorRps += item.offered - admitted   // shed + down demand errors HERE

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
      const shares = splitDependencyShares(admitted, candidates, roleOf, targetBp, dep.writeFraction ?? 0)

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
          // Cloud-managed DB capacity (node-model Phase 3): the instance class caps writes/reads;
          // over-ceiling demand is throttled — refused on the caller and shown as a blocked row,
          // while the admitted remainder carries bytes. A non-DB managed target (or one with no
          // class) refuses nothing, so this is byte-identical to before for everything else.
          const ms = doc.managedServices[path.to.managedServiceId]
          const refused = ms ? managedDbRefusedRps(share, dep.writeFraction ?? 0, ms) : 0
          const admittedToMs = share - refused
          if (admittedToMs > EPSILON_RPS) {
            addDownstream(flow, dep.id, target, admittedToMs, path.hopClass, false)
            bucketBytes(path.hopClass, admittedToMs)
          }
          if (refused > EPSILON_RPS) {
            flow.refusedRps += refused
            addDownstream(flow, dep.id, target, refused, path.hopClass, true)
          }
          continue   // managed targets are terminal — no capacity subtree to propagate into
        }

        addDownstream(flow, dep.id, target, share, path.hopClass, false)
        bucketBytes(path.hopClass, share)

        const toId = path.to.instanceId
        if (item.visited.has(toId)) continue        // cycle guard: row recorded, no re-entry
        const visited = new Set(item.visited)
        visited.add(toId)
        queue.push({ instanceId: toId, offered: share, depth: item.depth + 1, visited })
      }
    }
  }

  return { flows, totals }
}
