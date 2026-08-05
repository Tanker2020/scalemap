// The WorldEngineApi facade — the single composition point that ticks the whole compiled
// world. It owns no simulation math itself; it sequences Tasks 1–11 in the documented step
// order, publishes the metrics pyramid / events / replay at 1 Hz, feeds per-scope render
// payloads to attached views, and enforces the render caps. Headless: never imports from
// src/app/. Determinism: all randomness flows through the seeded rng built here.
import type {
  WorldEngineApi, EngineCallbacks, EngineEvent, EngineEventKind, HealthState,
  RenderScope, FramePayload, VisualParticle, VisualArc, FaultScope, FaultSpec, PartitionFault,
} from './types'
import { MAX_GLOBE_ARCS } from './types'
import type {
  WorldDoc, CompiledWorld, InstanceId, ServerId, AzId, RegionId, PopulationId, BlueprintId,
  ServiceInstance, CompiledLbRouting, Server, AvailabilityZone, PlacementRole, BlueprintDependency,
  ScenarioAction, ScenarioStep, CacheConfig, DbConfig,
} from '../world/types'
import { effectiveMissFraction } from './cache'
import { managedDbEngine } from '../world/types'
import { routeMatchesPattern, listRoutes } from '../nodeConfig'
import { pickPacketByIndex, resolveWireSize, routeIngressBytes, buildPickTable, resolveMixProtocol, type WireSize, type PickTable } from '../packetResolve'
import {
  activeConnections, profileFor, resolveConnectionProfile, KEEP_ALIVE_PROFILE,
  type ConnectionProfile,
} from '../connectionModel'
import { createRng, type Rng } from './rng'
import { createClock, type ClockHandle } from './engineClock'
import {
  populationDemandRps, splitDemandByMix, createDemandState,
  type RouteDemand, type PopulationDemandState,
} from './demand'
import { effectiveOverlayMultiplier, type DemandOverlayEntry } from './rampMath'
import {
  createRoutingState, resolveRegion, runHealthChecks, distributeToTargets, type RoutingState,
} from './routingRuntime'
import { stepHost, diskIoDemandFor, diskWaitFor, resolveDiskIopsCeiling, warmthOf, type InstanceLoad, type HostStepResult, type WarmingEntry } from './hostScheduler'
import { createVpsState, stepVps, type VpsState } from './vpsModel'
import { createNicState, addNicBytes, settleNic, NIC_REQUEST_BYTES, NIC_RESPONSE_BYTES, type NicState } from './networkRuntime'
import { sampleSizeMultiplier } from './latency'
import {
  getBreaker, recordWeighted, transition, admitRequest, pathKey, type Breaker,
} from './breakers'
import { solveFlows, type InstanceFlow } from './flows'
import {
  stepReplication, createReplicationState, localityFloorSec, staleReadFraction,
  WRITE_APPLY_EFFICIENCY_CONST, type ReplicaRef, type ReplicaLocality, type ReplicationState,
} from './replication'
import { managedDbRuntime } from '../managedDbRuntime'
import { topicRuntime } from './broker'
import {
  createFailoverState, setOutage as failoverSetOutage, computeHealth, probeInstant, promoteReplicas,
  drainFactor, beginDrain, clearDrain, DEFAULT_HYSTERESIS, effectiveRoleResolver, hasOutage,
  type FailoverState, type OutageScope,
  recoverMultiAzManagedDbs, failbackPromotions, applyAzOutageToManaged,
} from './failover'
import {
  createAutoscaleState, runningSetResolver, evaluatePolicy, beginInstanceDrain, type AutoscaleState,
} from './autoscale'
import { instanceId } from '../world/compileWorld'
import {
  createMetricsState, accumulateStep, buildBatch, type MetricsState, type RoutingSnapshot,
  type VpsPublish,
} from './metrics'
import { createEventRing, mkEvent, type EventRing } from './events'
import {
  createFaultState, setFault as setFaultPure, faultsForServer, stepLeaks, impairmentFor,
  addPartition, removePartition, type FaultState,
} from './faults'
import { createReplayBuffer, createTracer, type ReplayBuffer, type Tracer } from './replay'
import { REGION_GEO as REGION_GEO_LOCAL } from '../world/regionGeo'

const DEFAULT_STEP_MS = 100
const OOM_RESTART_MS = 5000                 // spec decision 3: instance_restarted after 5s
const PARTICLE_RATIO = 10                    // rps per sampled AZ particle (skeleton T12)
const MAX_AZ_PARTICLES = 400                 // az render cap (contracts "≤ current particle cap")
// Relocated to types.ts (audit ISSUE-050) so the globe view can import the render cap without
// pulling the engine singleton into its bundle graph; re-exported for API stability.
export { MAX_GLOBE_ARCS }
const MAX_SERVER_PARTICLES = 50              // server render cap (contracts: server ≤ 50 traces)
const REFUSED_EVENT_MIN_GAP_MS = 1000        // ≤1 connection_refused per pathKey per second
const REPLICATION_EVENT_MIN_GAP_MS = 1000    // ≤1 replication_lag_high/stale_read_served per key per second (FEAT-005, Task 14)
const DISK_EVENT_MIN_GAP_MS = 1000           // ≤1 disk_saturated per server per second (FEAT-006, Task 21)
const DISK_SATURATION_THRESHOLD = 0.9        // matches iops-saturated's analysis-rule threshold
const MIN_HEALTH_SIGNAL_RPS = 0.5            // below this offered rps, errorRate carries no signal
const DEGRADE_THRESHOLD_MS = 4               // spec decision 9 / Global Constraints
const DEGRADE_WINDOW_STEPS = 30              // 3s of 100ms steps
const DEGRADED_STEP_MS = 200
const RENDER_PROGRESS_PER_MS = 1 / 1200      // particle sweeps a pair in ~1.2s wall-time

// Audit ISSUE-017: buildPayload allocated a fresh throwaway `[]` for every non-matching scope's
// particles/arcs field (e.g. an empty `arcs: []` for every az/server-scope renderer, an empty
// `particles: []` for every globe-scope one) — semantically fungible, since an empty array carries
// no state to alias-corrupt, so one shared instance serves every such case. Frozen defensively: a
// consumer mutating a shared empty array in place would be a far worse bug than the allocation it
// replaces.
const EMPTY_PARTICLES: VisualParticle[] = Object.freeze([] as VisualParticle[]) as VisualParticle[]
const EMPTY_ARCS: VisualArc[] = Object.freeze([] as VisualArc[]) as VisualArc[]

const SEVERITY: Record<HealthState, number> = { healthy: 0, degraded: 1, down: 2 }

// Group compiled instances by server once (O(instances)) instead of re-filtering the full
// instance set per server inside a loop (O(servers x instances), which dominated per-step cost
// at world scale — ~30ms/step alone at ~2,000 instances / 216 servers, an unindexed-lookup
// regression found and fixed via bench/enginePerf.bench.test.ts, Task 18). Order-preserving:
// a single pass over compiled.instances yields the same per-server order
// Object.values(compiled.instances).filter(i => i.serverId === server.id) would have.
function groupInstancesByServer(compiled: CompiledWorld): Map<ServerId, ServiceInstance[]> {
  const byServer = new Map<ServerId, ServiceInstance[]>()
  for (const inst of Object.values(compiled.instances)) {
    const list = byServer.get(inst.serverId)
    if (list) list.push(inst)
    else byServer.set(inst.serverId, [inst])
  }
  return byServer
}

// Route id → route path, resolved once at start from the world's route catalog (doc.packets).
// A population's requestMix references routes by id; the LB matches on their path.
function buildRoutePathById(doc: WorldDoc): Map<string, string> {
  const m = new Map<string, string>()
  for (const route of listRoutes(doc.packets)) m.set(String(route.id), route.path)
  return m
}

// Per-route wire bytes, resolved once at start. Two conventions on purpose:
//   cost*  — the client-facing internet-egress line, symmetric 2 KB fallback (routeIngressBytes),
//            so a world with no authored sizes matches the engine's old flat egress constant.
//   nic*   — the entry NIC, keeping its asymmetric 512 in / 2048 out fallback so entry NIC
//            throughput is byte-identical until a route actually authors a size.
// An authored sizeKb / responseSizeKb overrides BOTH.
// sizeKb (KB, not bytes) is carried alongside the resolved byte fields — the packet-driven CPU
// blend (slice 2) needs the route's raw request size in KB, not its wire-byte convention, so it
// is stored directly rather than reconstituted from costReq/1024.
// sigma (slice 3) is the route's authored NIC-burst variance coefficient, carried alongside the
// resolved byte fields so the entry accumulator below can fold it the same way cpuKb is folded.
//
// PACKET MIX (packet library): a route may instead BIND library packets, exactly like a
// dependency edge does — same registry, same `resolveWireSize`. When a mix is bound it supersedes
// everything, including the asymmetric NIC convention: the mix authors real sizes for both legs,
// so inheriting a 512-in fallback alongside a real 5 MB request would be incoherent. cost and NIC
// therefore agree on the resolved bytes, and sigma/sizeKb come from the mix's weighted mean.
// An UNBOUND route keeps its historical chain untouched — that is the regression floor.
interface RouteWireBytes { costReq: number; costResp: number; nicReq: number; nicResp: number; sizeKb: number; sigma: number }
function buildRouteBytesById(doc: WorldDoc): Map<string, RouteWireBytes> {
  const m = new Map<string, RouteWireBytes>()
  for (const route of listRoutes(doc.packets)) {
    if ((route.packetMix?.length ?? 0) > 0) {
      const w = resolveWireSize(doc.packets, route.packetMix, route.sizeKb, route.responseSizeKb)
      m.set(String(route.id), {
        costReq: w.reqBytes, costResp: w.respBytes,
        nicReq: w.reqBytes, nicResp: w.respBytes,
        sizeKb: w.sizeKb, sigma: w.sigma,
      })
      continue
    }
    const cost = routeIngressBytes(route)
    m.set(String(route.id), {
      costReq: cost.reqBytes, costResp: cost.respBytes,
      nicReq: route.sizeKb != null ? route.sizeKb * 1024 : NIC_REQUEST_BYTES,
      nicResp: route.responseSizeKb != null ? route.responseSizeKb * 1024 : NIC_RESPONSE_BYTES,
      // route.sizeKb is typed as a non-optional `number` on HttpTemplate but can genuinely be
      // `undefined` at runtime (a blanked RoutesPanel "req" size input, or a route saved before
      // slice 1 introduced sizeKb with no per-route normalization on load) — guarded the same way
      // its nicReq sibling above is, falling back to the same 2 KB convention DEFAULT_ROUTE_WIRE_BYTES
      // uses (review fix: unguarded, this NaN'd cpuKb even with cpuMsPerKb unset — 0 * NaN = NaN).
      sizeKb: route.sizeKb ?? (routeIngressBytes(undefined).reqBytes / 1024),
      sigma: route.sizeVariance ?? 0,
    })
  }
  return m
}

// Per-ROUTE connection profile, resolved once at start — the connection-semantics sibling of
// buildRouteBytesById above. Bytes say how much a request moves; this says how LONG its connection
// is held and what establishing it costs, which is what separates a CPU-bound failure from a
// RAM-bound one.
//
// A bound packet mix wins (same precedence as sizing: the mix authors the real behavior), and it
// applies the protocol-wins rule inside resolveConnectionProfile. An UNBOUND route reads its own
// connectionType + holdSeconds. Either way an unauthored route resolves to KEEP_ALIVE_PROFILE,
// which activeConnections() treats as the exact historical identity — the regression floor.
function buildRouteConnProfiles(doc: WorldDoc): Map<string, ConnectionProfile> {
  const m = new Map<string, ConnectionProfile>()
  for (const route of listRoutes(doc.packets)) {
    m.set(String(route.id), (route.packetMix?.length ?? 0) > 0
      ? resolveConnectionProfile(doc.packets, route.packetMix, route.connectionType ?? 'keep-alive')
      : profileFor(route.connectionType ?? 'keep-alive', route.holdSeconds))
  }
  return m
}

// Per-DEPENDENCY connection profile — the internal-hop sibling of buildRouteConnProfiles. An edge
// with no bound mix has nothing to say about connection behavior, so it falls to keep-alive: a
// service→service hop has always been modelled as pooled, and that is the no-op.
function buildDepConnProfiles(doc: WorldDoc): Record<string, ConnectionProfile> {
  const out: Record<string, ConnectionProfile> = {}
  for (const bp of Object.values(doc.blueprints)) {
    for (const dep of bp.dependencies) {
      out[dep.id] = resolveConnectionProfile(doc.packets, dep.packetMix)
    }
  }
  return out
}

// Per-DEPENDENCY wire bytes, resolved once at start — the internal-hop sibling of
// buildRouteBytesById above. Every service→service call used to book a flat 2 KB each way
// regardless of what it carried; this resolves each edge's bound packet mix (or its inline sizes,
// or the world default) through the shared four-tier fallback so a 5 MB blob upload and a 200-byte
// health check stop looking identical to cost, the NIC, and the CPU model.
//
// The db-derived write fraction is folded in here rather than at the call sites: a bound db mix
// speaks for the read/write split (that is what the UI shows), and everything downstream —
// WAL amplification, managed-DB refusal — reads this one resolved number.
function buildDepWireBytes(doc: WorldDoc): Record<string, WireSize> {
  const out: Record<string, WireSize> = {}
  for (const bp of Object.values(doc.blueprints)) {
    for (const dep of bp.dependencies) {
      const wire = resolveWireSize(doc.packets, dep.packetMix, dep.reqKb, dep.respKb)
      out[dep.id] = { ...wire, writeFraction: wire.writeFraction ?? dep.writeFraction ?? 0 }
    }
  }
  return out
}

// dependencyId → its BlueprintDependency (audit ISSUE-014 — the fifth recurrence of the
// unindexed-lookup class already fixed as ISSUE-032/073/075/076) and dependencyId → its
// precomputed packet pick table (audit ISSUE-013). Both replace a per-row `bp?.dependencies.find
// (d => d.id === row.dependencyId)` linear scan that ran once per downstream row per RENDER FRAME
// (60 Hz, in buildAzParticles/buildServerParticles) — dep.id → BlueprintDependency never changes
// once `doc` is frozen at start(), so the scan was loop-invariant work. Flat Records keyed by
// dep.id alone, exactly like depBytesById/depConnById above: dependency ids are already assumed
// globally unique by those two maps (in production today, not just this audit), so no composite
// key is needed here either.
interface DepIndexes {
  depById: Record<string, BlueprintDependency>
  depPickTableById: Record<string, PickTable | null>
}
function buildDepIndexes(doc: WorldDoc): DepIndexes {
  const depById: Record<string, BlueprintDependency> = {}
  const depPickTableById: Record<string, PickTable | null> = {}
  for (const bp of Object.values(doc.blueprints)) {
    for (const dep of bp.dependencies) {
      depById[dep.id] = dep
      depPickTableById[dep.id] = buildPickTable(dep.packetMix)
    }
  }
  return { depById, depPickTableById }
}

// The implicit null "default" route (a population with no request mix). Cost keeps the symmetric
// 2 KB convention; NIC keeps its asymmetric split — both matching pre-packet-sizing behavior.
// sizeKb mirrors the same 2 KB convention (costReq's fallback, in KB). sigma 0 — no NIC-burst
// jitter on the unauthored default route.
const DEFAULT_ROUTE_WIRE_BYTES: RouteWireBytes = {
  costReq: routeIngressBytes(undefined).reqBytes, costResp: routeIngressBytes(undefined).respBytes,
  nicReq: NIC_REQUEST_BYTES, nicResp: NIC_RESPONSE_BYTES,
  sizeKb: routeIngressBytes(undefined).reqBytes / 1024,
  sigma: 0,
}

// Per-entry-instance byte-weighted accumulators (Σ rps×bytes over the routes that landed there);
// divided by the instance's entry rps to get its weighted-average request/response wire size.
// cpuKb (slice 2) is the same fold over request sizeKb instead of bytes, feeding the packet-driven
// CPU blend below. varW (slice 3) is the same fold over the route's sigma, feeding the NIC-burst
// multiplier at NIC booking (step 7) below.
// connLatW/connFixedW/connExtraW/connHsW/connFrameW are the same fold once more, over the five
// ConnectionProfile fields — giving each entry instance the demand-weighted connection behavior of
// the route mix that actually landed on it, rather than one route arbitrarily speaking for all of
// them. connFrameW (audit ISSUE-004) carries frameMultiplier the same way.
interface EntryByteAccum {
  costReq: number; costResp: number; nicReq: number; nicResp: number; cpuKb: number; varW: number
  connLatW: number; connFixedW: number; connExtraW: number; connHsW: number; connFrameW: number
}

// A demand-weighted running sum of ConnectionProfiles, used identically by the entry and internal
// folds below. Kept as one helper so the two tiers can never drift apart in how they blend.
interface ProfileAccum { lat: number; fixed: number; extra: number; hs: number; frame: number }
const addProfile = (acc: ProfileAccum, p: ConnectionProfile, weight: number): void => {
  acc.lat += weight * p.latencyShare
  acc.fixed += weight * p.fixedHoldSec
  acc.extra += weight * p.extraHoldSec
  acc.hs += weight * p.handshakeCpuMs
  acc.frame += weight * p.frameMultiplier
}
const meanProfile = (acc: ProfileAccum, totalWeight: number): ConnectionProfile => ({
  latencyShare: acc.lat / totalWeight,
  fixedHoldSec: acc.fixed / totalWeight,
  extraHoldSec: acc.extra / totalWeight,
  handshakeCpuMs: acc.hs / totalWeight,
  frameMultiplier: acc.frame / totalWeight,
})

// The L7 listener-rule match: the first rule (authored order) whose pattern matches the route's
// path selects its target group; a route with no path (the implicit default route) or one that
// matches nothing falls to the LB's default action. L4 LBs carry no rules, so every route lands
// on the default targets — byte-identical to the pre-route single-target-group distribution.
function matchRouteTargets(path: string | null | undefined, lb: CompiledLbRouting): BlueprintId[] {
  if (path != null) {
    for (const rule of lb.rules) {
      if (routeMatchesPattern(path, rule.pathPattern)) return [rule.targetBlueprintId]
    }
  }
  return lb.defaultTargetBlueprintIds
}

interface Attached { scope: RenderScope; onFrame: (p: FramePayload) => void }

interface EngineState {
  running: boolean
  seed: number
  rng: Rng
  clock: ClockHandle
  stepMs: number
  timeScale: number
  doc: WorldDoc
  compiled: CompiledWorld
  callbacks: EngineCallbacks
  // Blueprints with a 'public' port = client entry points. A Set, not an array (audit
  // ISSUE-078): the particle builders membership-test this per flow per rAF frame (~60 Hz),
  // where Array.includes' O(k) scan multiplies against the hottest loop in the engine.
  entryBlueprintIds: Set<BlueprintId>
  routePathById: Map<string, string>         // routeId → route path, for L7 listener-rule matching
  routeBytesById: Map<string, RouteWireBytes>  // routeId → per-request wire bytes (cost + NIC)
  // routeId → connection profile (hold duration + handshake CPU), and its per-dependency sibling
  // for internal hops. Built once at start() from the frozen doc, exactly like the byte maps above.
  routeConnById: Map<string, ConnectionProfile>
  depConnById: Record<string, ConnectionProfile>
  // dependencyId → per-call wire bytes for INTERNAL hops (packet library). The direct sibling of
  // routeBytesById above: routes size the client→entry tier, this sizes every service→service
  // hop. Built once at start() from the frozen doc; a plain object (not a Map) so it can be
  // handed to solveFlows' `depBytesById` field without a per-step conversion.
  depBytesById: Record<string, WireSize>
  // dependencyId → BlueprintDependency (audit ISSUE-014) and dependencyId → precomputed packet
  // pick table (audit ISSUE-013) — both built once at start(), read by the particle builders
  // instead of a per-row/per-frame `.find()` scan or filter+reduce.
  depById: Record<string, BlueprintDependency>
  depPickTableById: Record<string, PickTable | null>

  // Static topology indexes built once at start() (audit ISSUE-032): the per-step health
  // propagation loops read these instead of re-filtering doc.servers/doc.azs per AZ/region
  // every step — the exact unindexed-lookup regression groupInstancesByServer's comment warns
  // against. The doc is frozen for the run, so these can never go stale.
  serversByAz: Map<AzId, Server[]>
  azsByRegion: Map<RegionId, AvailabilityZone[]>
  // Reverse of serversByAz/azsByRegion (FEAT-001): faultsForServer needs a server's az/region to
  // resolve az- and region-scoped faults per server per step. Built once at start() alongside the
  // forward indexes above, from the same frozen doc — never goes stale.
  azOfServer: Map<ServerId, AzId>
  regionOfAz: Map<AzId, RegionId>
  // Compiled instances grouped by server, built once at start() (audit ISSUE-076): compiled
  // is frozen for the run, so rebuilding this O(instances) Map every step was pure waste.
  instancesByServer: Map<ServerId, ServiceInstance[]>
  // Per-step recompute memos (audit ISSUE-079). The role resolver rescans all instances after
  // any promotion — cache it keyed on promotedAt's contents so it rebuilds only when a
  // promotion/failback actually changes the overlay. hasManagedDbs skips the managed-DB
  // runtime's per-tick flow scan outright for worlds with no managed DB (the common case);
  // WITH managed DBs the scan is inherent — its input (prevFlows) is new every tick, so there
  // is no delta to update incrementally from.
  hasManagedDbs: boolean
  // Audit ISSUE-002: same skip-when-absent pattern as hasManagedDbs, for the event-broker scan.
  hasEventDeps: boolean
  // Persistent per-topic backlog (audit ISSUE-002), keyed by dependency id — carried across ticks
  // and mutated in place by broker.ts's `topicRuntime`, same ownership pattern as `queueDepth`.
  topicBacklog: Map<string, number>
  // Demand backpressure — Mechanism B (audit ISSUE-008). Mechanism A (RAM pressure from composed
  // latency tripping the existing OOM path) was MEASURED to close the loop only via a repeating
  // OOM-kill/recover cycle, not graceful admission control — the disqualifying shape the audit
  // itself names. This is deliberate, explicit admission control at the EDGE: a per-region shed
  // fraction, hysteresis-gated (engage/recover need SUSTAINED over/under-threshold error rates,
  // not a single noisy step) so it doesn't flap on-off, applied to a population's OFFERED demand
  // before it ever reaches distributeViaLb. One-step-lagged off the previous step's regional error
  // rate, the same shape as admittedScale/managedDbRuntime.
  regionShedFraction: Map<RegionId, number>
  regionOverloadStreak: Map<RegionId, number>
  regionRecoverStreak: Map<RegionId, number>
  roleResolver: ((id: InstanceId) => PlacementRole) | null
  roleResolverKey: string
  // Permitted instance→instance downstream adjacency (audit ISSUE-014), built once at start():
  // the 1 Hz starved-detection BFS walks it from the down set to find instances that are silent
  // because an UPSTREAM died, not because the world is idle.
  downstreamAdj: Map<InstanceId, InstanceId[]>
  // FEAT-002 cross-region split-brain eligibility (audit final-review C1/I4), built once at
  // start() from the frozen compiled world: every replica instance that has NO same-region
  // authored primary sibling (promoteReplicas already owns that cluster) but DOES have an
  // authored primary for its blueprint in at least one OTHER region — a genuinely orphaned
  // cross-region-only replica, the only case index.ts's isolation-promotion block may act on. A
  // replica with a same-region primary is excluded here structurally, not just gated at apply
  // time, so it can never be a candidate for this block regardless of partition state. Empty in
  // the overwhelming common case (no cross-region-only replica topology), so the per-step loop
  // below is skipped entirely rather than scanning every instance every step.
  crossRegionOrphanReplicaIds: Set<InstanceId>

  routing: RoutingState
  failover: FailoverState
  // FEAT-001 fault injection bookkeeping (down/latency-add/cpu-brownout/memory-leak/error-inject).
  // 'down' faults ALSO route through failover's setOutage — this is bookkeeping/leak-accumulator
  // state only, never a second source of truth for outage/health.
  faults: FaultState
  // FEAT-003 (Task 18): the scenario's steps, sorted once at start() by atMs, plus a monotonic
  // apply cursor — runStep's cursor loop applies every step whose atMs has been reached exactly
  // once, in atMs order, never re-applying or skipping one that shares a step boundary with
  // another. Empty/0 for a doc with no scenario (byte-identical to pre-feature).
  scenarioSteps: ScenarioStep[]
  scenarioCursor: number
  // FEAT-003: engine-owned demand-shaping overlay, written here by the 'demand-multiplier' (every
  // population) / 'set-population-rps' (one population) scenario actions and consumed by
  // demand.ts's populationDemandRps (Task 19 — threaded through as its `demandOverlay` param). A
  // population absent from this map has no active overlay (multiplier 1, demand unchanged from
  // authored). `multiplier` is the ramp's starting value (the effective value at the moment the
  // action fired, so a second action mid-ramp continues smoothly instead of jumping back to 1);
  // `targetMultiplier` is where the ramp is heading; `rampStartMs`/`rampSec` define the linear
  // interpolation window. Shape defined once in rampMath.ts's `DemandOverlayEntry`.
  demandOverlay: Map<PopulationId, DemandOverlayEntry>
  // Per-population burst state (audit ISSUE-017) — the on-off flash-crowd process is stateful
  // across ticks; demand.ts stays a pure function of (pop, simMs, rng, state).
  demandStates: Map<PopulationId, PopulationDemandState>
  vpsStates: Map<ServerId, VpsState | null>
  vpsFactor: Map<ServerId, number>           // previous step's effective vCPU factor
  // Persistent NIC send buffers (audit ISSUE-002) + the previous step's settlement, which
  // feeds THIS step's admits/latency — the same one-step lag as vpsFactor/admittedScale.
  nics: Map<ServerId, NicState>
  nicDeliveredFraction: Map<ServerId, number>
  nicQueuedLatencyMs: Map<ServerId, number>
  breakers: Map<string, Breaker>
  // Persistent per-instance request queues (audit ISSUE-013): carried across ticks, mutated by
  // solveFlows. THE backpressure/damping state — served = min(capacity, arrivals + backlog).
  queueDepth: Map<InstanceId, number>
  metrics: MetricsState
  events: EventRing
  replay: ReplayBuffer
  tracer: Tracer

  prevFlows: Record<InstanceId, InstanceFlow>
  windowTotals: { crossAzBytes: number; crossRegionBytes: number; internetBytes: number; managedEgressBytes: Record<string, number> }
  lastRoutingSnapshot: RoutingSnapshot
  popRegion: Map<PopulationId, RegionId>
  pendingFailover: Map<PopulationId, RegionId>
  // Phase 5 (D4): remembers each population's previous region for the pending-failover window,
  // so buildDrainArcs can render the globe's drain arc FROM the old region instead of falling
  // back to the population's own lat/lon. Engine-internal — not a contract type (see
  // contract-drift.md ## PHASE 5, entry logged in Step 7 below).
  popPrevRegion: Map<PopulationId, RegionId>
  checkFailedPrev: Map<string, boolean>
  // Last step's RAW health signal per scope (failover.ts's probeInstant — manual outage +
  // error/pressure, never checkFailed). This is what runHealthChecks probes; feeding it the
  // computed health deadlocked recovery (see probeInstant's doc comment). Engine-internal.
  probePrev: Map<string, HealthState>
  instanceHealth: Map<InstanceId, HealthState>
  oomRestartAt: Map<InstanceId, number>
  refusedRateLimit: Map<string, number>
  // FEAT-005 (Task 14): rate-limit gates for the two new replication events, mirroring
  // refusedRateLimit's exact shape — a last-emitted-at simMs per key, checked against
  // REPLICATION_EVENT_MIN_GAP_MS before pushing. Keyed by clusterId for replication_lag_high,
  // by replica instanceId for stale_read_served.
  replicationLagRateLimit: Map<string, number>
  staleReadRateLimit: Map<string, number>
  // FEAT-006 (Task 21): rate-limit gate for disk_saturated, mirroring the same shape -- a
  // last-emitted-at simMs per serverId, checked against DISK_EVENT_MIN_GAP_MS before pushing.
  diskSaturatedRateLimit: Map<string, number>
  // FEAT-004 (Task 3): cache warm-since bookkeeping, keyed by the cache instance id, or
  // `managed:${managedServiceId}` for a managed cache target. A key ABSENT from this map means
  // "already warm" (Task 2's cache.ts contract: warmSinceMs === undefined ⇒ effectiveHitRatio ===
  // cfg.hitRatio) — every cache starts warm at start(), the regression floor. A key is (re)written
  // with the current simMs whenever the instance restarts cold: an OOM-restart or a 'down' fault
  // clearing back to running, mirroring how s.faults.leakAccumMb resets on the same two triggers.
  // A managed cache is never written here (ManagedService has no restart concept today — Step 4's
  // documented, deliberate scope cut) so it reads as permanently warm.
  warmSinceMs: Map<string, number>
  // FEAT-004 (Task 5): "already emitted cache_warm for the CURRENT cold cycle" guard, keyed by
  // the same identity as warmSinceMs (instance id, or `managed:${id}`). A key is added the step
  // effectiveHitRatio first reaches cfg.hitRatio again (so cache_warm fires exactly once per cold
  // cycle, not every step it stays warm) and removed whenever warmSinceMs is rewritten for a NEW
  // cold cycle (the restart/fault-clear sites) — so the next restart can fire cache_warm again.
  warmEmitted: Set<string>
  // FEAT-007 (Task 3): instance id -> cold-start ramp state, populated on OOM restart and on a
  // 'down'-fault clear (mirroring warmSinceMs's own two trigger sites), and deleted once
  // warmthOf() reaches 1 (leak prevention — see the cleanup pass near section 0 of runStep). A
  // key ABSENT from this map means "already warm" (warmthOf's own contract) — every instance
  // starts warm at start(), the regression floor.
  warmingUntil: Map<InstanceId, WarmingEntry>
  // start()-time fast-path flag (Task 3): true iff ANY blueprint or managed service in the doc
  // carries a cacheConfig. Guards the per-step cacheMissFractionByInstance build in runStep so an
  // unconfigured world (the overwhelming common case) pays zero extra cost per step.
  hasAnyCache: boolean
  // start()-time index (Task 3, Step 6): for a dependency `dep` whose OWN cacheAsideVia points at
  // a sibling cache-edge on the same blueprint, cacheAsideIndexByDepId.get(dep.id) resolves that
  // sibling's target cacheConfig + the warm-key to read its missFraction from
  // cacheMissFractionByInstance — built once here so flows.ts's per-step dependency loop never
  // re-walks bp.dependencies.find(...) per row per step (the same "build once at start(), read
  // every step" discipline as downstreamAdj/crossRegionOrphanReplicaIds above).
  cacheAsideIndexByDepId: Map<string, { cacheConfig: CacheConfig; warmKey: string }>
  // FEAT-005 (Task 11): static replica topology, built once at start() from the frozen compiled
  // world — cluster key `${primaryBlueprintId}|${primaryRegionId}`, reusing failover.ts's
  // promoteReplicas grouping convention EXACTLY (siblings clustered by the AUTHORED PRIMARY's
  // blueprint+region, not the replica's own — a cross-region standby's own region differs from
  // its primary's, which is exactly what makes its locality 'cross-region'; all of a primary's
  // replicas, wherever they live, share the SAME cluster key and therefore the SAME write
  // stream). Entries here carry only the STRUCTURAL fields (id/locality/fromRegionId/toRegionId);
  // applyCapacity is 0 here and re-derived live every step (Step 4's serviceRateByInstance is
  // per-step, so it can't be baked in at start()).
  replicasByCluster: Record<string, ReplicaRef[]>
  // clusterId -> the primary blueprint's DbConfig, resolved once at start() alongside
  // replicasByCluster so the per-step apply-capacity/stale-read/semi-sync logic never re-walks
  // doc.blueprints.
  dbConfigByCluster: Map<string, DbConfig>
  // Static per-primary-instance semi-sync ack RTT (Step 6) — see buildReplicationIndexes' own
  // comment for the narrowed hook this implements and why. Read every step, computed once here.
  semiSyncExtraMsByInstance: Record<InstanceId, number>
  // start()-time fast-path flag (the hasAnyCache precedent, Task 3): true iff the world has ANY
  // replica-role db instance with a resolvable primary. Guards every per-step replication
  // computation below so an unconfigured world (the overwhelming common case) pays zero extra
  // cost per step.
  hasAnyReplicas: boolean
  // Audit final-review finding: start()-time fast-path flag, the SAME hasAnyCache/hasAnyReplicas
  // precedent — true iff ANY server in the doc has diskIops and/or diskType authored. Task 17 gave
  // every instanceCatalog.ts preset a default diskType, so an unconfigured/legacy world (no server
  // ever explicitly overridden) still needs this false to skip the per-step disk demand/wait
  // computation entirely; FEAT-006 originally shipped without this guard.
  hasAnyDisk: boolean
  // start()-time index (audit final-review finding, alongside hasAnyDisk): instance id -> its
  // blueprint id, built ONCE from the frozen compiled world's instances so the per-server per-step
  // disk-demand computation never allocates a fresh Map from `resident` every step.
  blueprintIdByInstance: Map<InstanceId, BlueprintId>
  // FEAT-008 (Task 13): the engine's live desiredCount/cooldown state -- compileWorld already
  // expanded every autoscaled placement to its full maxCount envelope (the frozen-doc/frozen-
  // compiled constraint means the running/parked split can only be decided here, at simulation
  // time, never by recompiling). Mutated in place by evaluatePolicy every step it runs.
  autoscale: AutoscaleState
  // Memoized per Task 12's runningSetResolver -- mirrors roleResolver/roleResolverKey's exact
  // shape (effectiveRoleResolver's own precedent): rebuilt only when autoscale.desiredCount's
  // CONTENTS change, not every step, so an unconfigured/static-fleet world pays one string-join
  // comparison per step and nothing else.
  runningSet: (instanceId: InstanceId) => boolean
  runningSetKey: string
  // Task 15: instance id -> simMs the drain completes. An instance enters this map the moment a
  // scale-in decision drops it below the placement's new desiredCount (instead of being parked
  // that same step) and leaves it once INSTANCE_DRAIN_MS elapses (the periodic cleanup pass near
  // section 0). While present, runningSetResolver (autoscale.ts) treats the instance as still
  // running (CPU/RAM/publishing), while routingHealthOfInstance below additionally treats it as
  // 'down' for NEW-traffic eligibility -- draining is "running but not accepting new work".
  drainUntilByInstance: Map<InstanceId, number>
  // start()-time fast-path flag (the hasAnyCache/hasAnyDisk precedent): true iff ANY placement in
  // the doc carries an authored `autoscale` policy. desiredCount always has an entry per
  // placement (Task 12's createAutoscaleState seeds every placement, autoscaled or not), so
  // desiredCount.size === 0 is never a useful guard -- this flag is the real one, skipping the
  // per-step control-loop scan entirely for the overwhelming common case (no autoscaling
  // authored anywhere).
  hasAnyAutoscale: boolean
  // Task 10's pure backlog/lag tracker — persistent across ticks, mutated in place by
  // stepReplication.
  replication: ReplicationState
  // Last step's per-cluster write rps, threaded out of solveFlows' result (Step 4) and read back
  // ONE STEP LATER to seed staleReadFractionByReplica before the NEXT solveFlows call — the same
  // one-step-lag shape as managedDbRuntime/topicRuntime: this step's OWN write rps only becomes
  // known once THIS step's solveFlows call returns it, so computing an unlagged stale-read
  // fraction to feed INTO that same call would be circular.
  prevWriteRpsByCluster: Record<string, number>
  // Audit ISSUE-010: "already reported this run" — a chain that's over-depth or a cycle that's cut
  // every single step would otherwise spam one event per instance/edge per step; these fire once
  // per run instead (a state TRANSITION, not a steady-state condition), mirroring how other steady-
  // state events (e.g. breaker_open) avoid re-firing every step while the condition holds.
  depthExceededReported: Set<InstanceId>
  cycleCutReported: Set<string>

  idSeq: number
  lastBatchMs: number
  stepCosts: number[]
  degraded: boolean
  rafId: number | null
  lastFrameMs: number | null
  renderers: Map<number, Attached>
  rendererSeq: number
}

export function createWorldEngine(seed = 0x9e3779b9): WorldEngineApi & {
  __test_step: (steps?: number) => void
  __test_render: (wallMs?: number) => void
  // FEAT-005 (Task 11): test-only accessor for a replica instance's current replication lag — the
  // brief's own escape hatch ("directly inspectable via a test-only engine accessor") in place of
  // Task 12's not-yet-built MetricsBatch.clusters publishing surface.
  __test_replicationLagSec: (instanceId: string) => number | undefined
} {
  // Constructed lazily on start(); this placeholder keeps the closure typed before the first run.
  let state: EngineState | null = null

  const entryBlueprints = (doc: WorldDoc): BlueprintId[] =>
    Object.values(doc.blueprints).filter(bp => bp.ports.some(p => p.visibility === 'public')).map(bp => bp.id)

  // ONE id allocator for every subsystem (audit ISSUE-045): failover/promotion helpers return
  // events with descriptive hand-built ids (`outage-…`, `promote-…`) that never touched idSeq —
  // two divergent id schemes with no cross-subsystem monotonicity. The facade re-stamps every
  // event on emit, so ids are globally sequential within a run; the semantic context those
  // prefixes carried already lives in kind/message/affected.
  const emitEvent = (e: EngineEvent): void => {
    if (!state) return
    const sequenced = { ...e, id: `evt-${state.idSeq++}` }
    state.events.push(sequenced)
    state.callbacks.onEvent(sequenced)
  }
  const emit = (kind: EngineEventKind, severity: EngineEvent['severity'], message: string, affected: string[], simMs: number): void => {
    if (!state) return
    // mkEvent's idSeq arg is a placeholder here — emitEvent owns the real allocation.
    emitEvent(mkEvent(kind, severity, message, affected, simMs, 0))
  }

  const healthOfScope = (id: string): HealthState => state!.failover.healthByScope.get(id) ?? 'healthy'

  const healthOfInstance = (iid: InstanceId): HealthState => {
    const s = state!
    if (s.oomRestartAt.has(iid)) return 'down'
    const inst = s.compiled.instances[iid]
    if (inst) {
      const worst = [inst.serverId, inst.azId, inst.regionId]
        .map(healthOfScope)
        .reduce((w, h) => (SEVERITY[h] > SEVERITY[w] ? h : w), 'healthy' as HealthState)
      if (worst !== 'healthy') return worst
    }
    return s.instanceHealth.get(iid) ?? 'healthy'
  }

  // metrics.ts's MetricsState.lastHealth is looked up generically for instance AND
  // server/az/region scope ids (buildBatch calls it for all four). Dispatch to the right
  // resolver by id kind so server/az/region health (manual outages, hysteresis) actually
  // reaches the published batch instead of silently reporting 'healthy'.
  const healthOfAny = (id: string): HealthState =>
    state!.compiled.instances[id] ? healthOfInstance(id) : healthOfScope(id)

  // Route a region's inbound demand through its regional load balancer to service instances.
  // Demand arrives already split per route (splitDemandByMix); for EACH route we first-match a
  // listener rule (L7) — or fall to the default action — to pick the target group, then hand that
  // group to distributeToTargets, which owns the region→AZ→instance tier and the cross-zone
  // setting. An L4 LB has no rules, so every route lands on the default targets — byte-identical
  // to the pre-route distribution, so the engine's golden tests hold. Traffic whose target group
  // resolves empty (a rule/default pointing at a service with no instance here) is dropped: the
  // analysis engine surfaces that as a finding.
  const distributeViaLb = (
    regionId: RegionId,
    routeDemands: RouteDemand[],
    into: Record<InstanceId, number>,
    droppedByAz?: Record<AzId, number>,
    // When supplied, attribute each route's byte sizes to the entry instances that received it:
    // route the demand into a per-route scratch map, then fold both rps (into `into`) and
    // byte-weighted sums (into `weightAccum`). Absent ⇒ demand routes straight into `into`, unchanged.
    weightAccum?: Record<InstanceId, EntryByteAccum>,
  ): void => {
    const s = state!
    const lb = s.compiled.routing.lbRouting[regionId]
    if (!lb) return
    const regionAzSpread = s.compiled.routing.regionAzSpread[regionId] ?? []
    // A parked (scaled-in) instance must never be picked as an LB target, regardless of its
    // underlying health signal. Task 15: a DRAINING instance is also excluded from new traffic
    // even though runningSet(iid) now reads true for it (running=true is exactly what keeps it
    // getting CPU/RAM/publishing during its grace window) -- so eligibility here checks
    // drainUntilByInstance directly, independent of runningSet. Scoped to routing only (not the
    // module-scope healthOfInstance itself) so failover/breaker/metrics health reporting is
    // untouched -- runningSet/draining has no bearing on whether an instance IS healthy, only on
    // whether it's currently eligible to receive NEW work.
    const routingHealthOfInstance = (iid: InstanceId): HealthState =>
      (!s.runningSet(iid) || s.drainUntilByInstance.has(iid)) ? 'down' : healthOfInstance(iid)
    for (const { routeId, rps } of routeDemands) {
      if (rps <= 0) continue
      const path = routeId != null ? s.routePathById.get(routeId) : null
      const target = weightAccum ? {} : into
      distributeToTargets({
        targetBlueprintIds: matchRouteTargets(path, lb),
        rps,
        crossZone: lb.crossZone,
        regionAzSpread,
        azBlueprintTargets: s.compiled.routing.azBlueprintTargets,
        healthOfScope,
        healthOfInstance: routingHealthOfInstance,
        cursors: s.routing,
        into: target,
        droppedByAz,
        weighted: lb.algorithm === 'weighted',
        azWeights: lb.azWeights,
      })
      if (weightAccum && target !== into) {
        const wb = (routeId != null ? s.routeBytesById.get(routeId) : undefined) ?? DEFAULT_ROUTE_WIRE_BYTES
        // The implicit default route (a population with no request mix) is keep-alive — the
        // identity, so an unauthored world's connection counts are untouched.
        const cp = (routeId != null ? s.routeConnById.get(routeId) : undefined) ?? KEEP_ALIVE_PROFILE
        for (const iid in target) {
          const r = (target as Record<InstanceId, number>)[iid]
          into[iid] = (into[iid] ?? 0) + r
          let acc = weightAccum[iid]
          if (!acc) {
            acc = {
              costReq: 0, costResp: 0, nicReq: 0, nicResp: 0, cpuKb: 0, varW: 0,
              connLatW: 0, connFixedW: 0, connExtraW: 0, connHsW: 0, connFrameW: 0,
            }
            weightAccum[iid] = acc
          }
          acc.costReq += r * wb.costReq; acc.costResp += r * wb.costResp
          acc.nicReq += r * wb.nicReq; acc.nicResp += r * wb.nicResp
          acc.cpuKb += r * wb.sizeKb
          acc.varW += r * wb.sigma
          acc.connLatW += r * cp.latencyShare
          acc.connFixedW += r * cp.fixedHoldSec
          acc.connExtraW += r * cp.extraHoldSec
          acc.connHsW += r * cp.handshakeCpuMs
          acc.connFrameW += r * cp.frameMultiplier
        }
      }
    }
  }

  const applyHealth = (scope: 'server' | 'az' | 'region', id: string, inputs: { errorRate: number; cpuPressure: number; checkFailed: boolean; manualDown: boolean }, simMs: number): void => {
    const s = state!
    s.probePrev.set(id, probeInstant(inputs))
    const before = s.failover.healthByScope.get(id) ?? 'healthy'
    const after = computeHealth(s.failover, id, inputs, simMs, DEFAULT_HYSTERESIS)
    if (after !== before) {
      s.callbacks.onHealthChange(scope, id, after)
      if (scope === 'az') {
        if (after === 'down') beginDrain(s.failover, id, simMs)
        else if (before === 'down') clearDrain(s.failover, id)
      }
    }
  }

  const emitBreakerTransition = (from: Breaker['state'], to: Breaker['state'], affected: string[], simMs: number): void => {
    if (from === to) return
    if (to === 'open') emit('breaker_open', 'warning', 'circuit opened', affected, simMs)
    else if (to === 'half-open') emit('breaker_half_open', 'info', 'circuit half-open', affected, simMs)
    else if (to === 'closed') emit('breaker_closed', 'info', 'circuit closed', affected, simMs)
  }

  // FEAT-003 (Task 18/19): linear ramp — the current effective value of a demand overlay entry at
  // `simMs`, given its ramp start/target/duration. Used here to seed a NEW action's starting
  // multiplier from wherever an in-flight ramp actually is (rather than resetting to 1 — a second
  // demand-multiplier fired mid-ramp must continue smoothly), and by demand.ts's
  // populationDemandRps to scale the diurnal mean before the Poisson draw — hoisted to
  // rampMath.ts so both call sites share the EXACT same formula (see that file's header).
  const linkLabel = (e: PartitionFault['from']): string => (e.kind === 'internet' ? 'internet' : `${e.kind}:${e.id}`)

  // Human-readable fallback message for a scenario_step_applied event when the authored step
  // carries no `note` — never the primary UX (authors should write notes), just a reasonable
  // default so the Events tab never shows a blank message.
  const describeScenarioAction = (action: ScenarioAction): string => {
    switch (action.type) {
      case 'inject-fault': return `scenario: inject-fault ${action.scope}:${action.id} (${action.spec.kind})`
      case 'clear-fault': return `scenario: clear-fault ${action.scope}:${action.id}`
      case 'partition': return `scenario: partition ${linkLabel(action.fault.from)} -> ${linkLabel(action.fault.to)} (${action.fault.mode})`
      case 'heal-partition': return `scenario: heal-partition ${action.partitionId}`
      case 'demand-multiplier': return `scenario: demand-multiplier x${action.factor} over ${action.rampSec}s`
      case 'set-population-rps': return `scenario: set-population-rps ${action.populationId} -> ${action.peakRps}rps over ${action.rampSec}s`
    }
  }

  // Audit final-review I1: the shared apply logic behind api.setFault/setPartition/healPartition,
  // taking simMs EXPLICITLY rather than reading state.clock.simMs internally. runFrame's replay
  // loop (below) advances the clock for the WHOLE frame's step batch first, then replays each step
  // backdated — so a scenario action applied on a backdated step (any timeScale > 1, or a slow
  // frame yielding >1 step) must be timestamped with THAT step's own simMs, not the batch's later
  // endMs (which is what state.clock.simMs holds by the time applyScenarioAction runs). Getting
  // this wrong doesn't just mistime an event: failoverSetOutage's simMs feeds beginDrain's
  // drainUntil and managedDownSince.sinceMs, so an AZ/managed-scope scenario fault's drain ramp /
  // multi-AZ recovery window would silently vary with real wall-clock frame batching — the exact
  // determinism hole this feature exists to prevent. The public facade methods below keep reading
  // state.clock.simMs (unchanged behavior for UI-driven calls, which are never backdated), and
  // delegate to these same functions so there is exactly one implementation either way.
  const doSetFault = (s: EngineState, scope: FaultScope, id: string, spec: FaultSpec | null, simMs: number): void => {
    const affected = instanceIdsForFaultScope(s, scope, id)
    // Audit final-review N-finding: capture whether the fault being CLEARED was actually a
    // 'down' fault BEFORE setFaultPure deletes the active entry. faults.ts keeps exactly one
    // spec per `${scope}:${id}` key, so a clear (spec === null) can be clearing ANY kind —
    // 'latency-add'/'cpu-brownout'/'memory-leak'/'error-inject'/'disk-stall' just as easily as
    // 'down'. Only a 'down' fault clearing implies the instance actually restarted; the
    // cache-warmth reset below must gate on THAT, not merely on "this is a clear operation".
    const wasDown = spec === null && s.faults.active.get(`${scope}:${id}`)?.kind === 'down'
    for (const e of setFaultPure(s.faults, scope, id, spec, simMs, affected)) emitEvent(e)
    // 'down' (and clearing back to null) routes through the EXISTING failover outage path so
    // behavior stays byte-identical to the pre-FEAT-001 setOutage — faults.ts's own state above
    // is bookkeeping/event-emission only, never a second source of truth for down/health.
    if (spec === null || spec.kind === 'down') {
      const down = spec !== null
      for (const e of failoverSetOutage(s.failover, scope as OutageScope, id, down, simMs)) emitEvent(e)
      // audit ISSUE-008: an AZ failure is a SIMULATED outage for the managed services scoped to
      // it — they go down with the AZ (and multi-AZ DBs may then auto-promote their standby),
      // and recover with it. Manual per-service kills are untouched in both directions.
      if (scope === 'az') {
        for (const e of applyAzOutageToManaged(s.failover, s.doc, id, down, simMs)) emitEvent(e)
      }
      // FEAT-004 (Task 3): clearing a 'down' fault is a restart — the same "fresh cache" moment
      // as an OOM restart above. A 'down' fault being SET (not cleared) does NOT reset warmth: the
      // instance isn't running at all while faulted, so there's nothing to warm/cool; the reset
      // belongs to the moment it comes back. Clearing a NON-'down' fault (latency-add,
      // cpu-brownout, memory-leak, error-inject, disk-stall) is not a restart at all — the
      // instance kept running the whole time — so it must NOT reset warmth either (audit
      // final-review finding: this used to fire on ANY clear).
      if (wasDown) {
        for (const iid of affected) {
          const bp = s.doc.blueprints[s.compiled.instances[iid]?.blueprintId ?? '']
          if (bp?.cacheConfig) {
            s.warmSinceMs.set(iid, simMs)
            s.warmEmitted.delete(iid)
            emit('cache_cold', 'info', `instance ${iid} restarted with a cold cache`, [iid], simMs)
          }
          // FEAT-007 (Task 3): coming back from a 'down' fault is a restart, the same "fresh
          // process" moment as the cache-warmth reset above — ramp back up from cold.
          const coldStartMs = bp?.workload.coldStartMs ?? 0
          if (coldStartMs > 0) {
            s.warmingUntil.set(iid, { startedMs: simMs, coldStartMs })
            emit('instance_warming', 'info', `instance ${iid} restarted and is ramping up from cold`, [iid], simMs)
          }
        }
      }
    }
  }
  const doSetPartition = (s: EngineState, fault: PartitionFault, simMs: number): void => {
    emitEvent(addPartition(s.faults, fault, simMs))
  }
  const doHealPartition = (s: EngineState, partitionId: string, simMs: number): void => {
    const e = removePartition(s.faults, partitionId, simMs)
    if (e) emitEvent(e)
  }

  // FEAT-003 (Task 18): dispatches one scenario step's action, reusing the EXACT existing code
  // paths — inject-fault/clear-fault go through doSetFault (the SAME logic api.setFault uses, so
  // 'down'/failover wiring/applyAzOutageToManaged all fire identically), partition/heal-partition
  // go through doSetPartition/doHealPartition (thin wrappers over faults.ts's addPartition/
  // removePartition). demand-multiplier/set-population-rps write into the engine-owned
  // demandOverlay map (Task 19 makes demand.ts's populationDemandRps actually read it). Every path
  // here is passed the STEP's own simMs (audit final-review I1) — never state.clock.simMs, which
  // by the time this runs mid-replay already holds the WHOLE frame's batch end time.
  const applyScenarioAction = (s: EngineState, action: ScenarioAction, simMs: number): void => {
    switch (action.type) {
      case 'inject-fault':
        doSetFault(s, action.scope, action.id, action.spec, simMs)
        return
      case 'clear-fault':
        doSetFault(s, action.scope, action.id, null, simMs)
        return
      case 'partition':
        doSetPartition(s, action.fault, simMs)
        return
      case 'heal-partition':
        doHealPartition(s, action.partitionId, simMs)
        return
      case 'demand-multiplier': {
        // Global: applies to EVERY population currently authored in the doc.
        for (const popId of Object.keys(s.doc.populations) as PopulationId[]) {
          const existing = s.demandOverlay.get(popId)
          const current = existing ? effectiveOverlayMultiplier(existing, simMs) : 1
          s.demandOverlay.set(popId, {
            multiplier: current, targetMultiplier: action.factor, rampStartMs: simMs, rampSec: action.rampSec,
          })
        }
        return
      }
      case 'set-population-rps': {
        // Targets ONE population; the absolute peakRps is converted to a multiplier RELATIVE to
        // that population's own authored baseline (ClientPopulation.peakRps).
        const popId = action.populationId as PopulationId
        const basePeakRps = s.doc.populations[popId]?.peakRps ?? 0
        // Guard: an authored-zero baseline has no meaningful "relative to itself" scale factor.
        // Choosing a targetMultiplier of 0 (rather than skipping the write) keeps every overlay
        // entry's semantics uniform — "targeting a population with no authored baseline" reads as
        // "stays at zero," not as a silent no-op that leaves stale state behind.
        const targetMultiplier = basePeakRps === 0 ? 0 : action.peakRps / basePeakRps
        const existing = s.demandOverlay.get(popId)
        const current = existing ? effectiveOverlayMultiplier(existing, simMs) : 1
        s.demandOverlay.set(popId, {
          multiplier: current, targetMultiplier, rampStartMs: simMs, rampSec: action.rampSec,
        })
        return
      }
    }
  }

  function runStep(simMs: number): void {
    const s = state!
    const { doc, compiled } = s
    const stepMs = s.stepMs
    const stepSec = stepMs / 1000

    // ── FEAT-003: scenario timeline — apply every due step exactly once, in atMs order ──
    // Cursor-indexed, never re-applied and never skipped: scenarioSteps was sorted once at
    // start(), so advancing scenarioCursor monotonically and applying every step whose atMs has
    // now been reached (<=, so a step landing exactly on a step boundary fires that same step)
    // guarantees each step fires exactly once regardless of how many steps share a boundary.
    while (s.scenarioCursor < s.scenarioSteps.length && s.scenarioSteps[s.scenarioCursor].atMs <= simMs) {
      const step = s.scenarioSteps[s.scenarioCursor]
      applyScenarioAction(s, step.action, simMs)
      emit('scenario_step_applied', 'info', step.note ?? describeScenarioAction(step.action), [], simMs)
      s.scenarioCursor += 1
    }

    // ── 0. OOM restart timers ──
    for (const [iid, restartAt] of [...s.oomRestartAt]) {
      if (simMs >= restartAt) {
        s.oomRestartAt.delete(iid)
        s.instanceHealth.set(iid, 'healthy')
        // FEAT-004 (Task 3): a restarted process gets a fresh, cold cache — same "fresh heap"
        // moment as the leakAccumMb reset above, mirrored here for warmth.
        const restartedBp = doc.blueprints[compiled.instances[iid]?.blueprintId ?? '']
        if (restartedBp?.cacheConfig) {
          s.warmSinceMs.set(iid, simMs)
          s.warmEmitted.delete(iid)
          emit('cache_cold', 'info', `instance ${iid} restarted with a cold cache`, [iid], simMs)
        }
        emit('instance_restarted', 'info', `instance ${iid} restarted`, [iid], simMs)
      }
    }

    // ── 0b. FEAT-007: warm-up cleanup — drop entries that have reached full warmth ──
    // Placed early (before the capacity/latency sections below read s.warmingUntil) so an
    // instance that finishes warming THIS exact step is already seen as warm by every downstream
    // consumer this same step, mirroring how oomRestartAt is cleared before host scheduling reads
    // it above.
    for (const [iid] of [...s.warmingUntil]) {
      if (warmthOf(iid, s.warmingUntil, simMs) >= 1) {
        emit('instance_warm', 'info', `instance ${iid} finished warming up`, [iid], simMs)
        s.warmingUntil.delete(iid)
      }
    }

    // ── 0c. FEAT-008 (Task 15): scale-in drain cleanup — drop entries whose grace window elapsed ──
    // Once a drain completes, the instance is genuinely parked: runningSetResolver's own
    // indexInPlacement < desired check already excludes it (desiredCount was lowered the step the
    // drain began), so nothing further is needed here beyond clearing the overlay entry itself.
    // Placed alongside 0b's warmingUntil cleanup so an instance whose drain finishes THIS exact
    // step is already seen as parked by every downstream consumer this same step.
    if (s.drainUntilByInstance.size > 0) {
      for (const [iid, until] of [...s.drainUntilByInstance]) {
        if (simMs >= until) s.drainUntilByInstance.delete(iid)
      }
    }

    // ── Demand backpressure — Mechanism B (audit ISSUE-008) ──
    // Per-region error rate from the PREVIOUS step's flows (one-step lag, same shape as
    // admittedScale/managedDbRuntime) — a region's aggregate offered/error split across every
    // resident instance. Hysteresis-gated: engaging/recovering both need SUSTAINED over/under
    // threshold, so a single noisy step can't flap the shed fraction on and off.
    const REGION_OVERLOAD_ENGAGE_RATE = 0.5
    const REGION_OVERLOAD_RECOVER_RATE = 0.1
    const REGION_OVERLOAD_STREAK_STEPS = 20   // 2s of 100ms steps — "sustained", not a blip
    // Never shed the full 100%: a fully-cut region admits zero real traffic, so the very error
    // signal recovery depends on goes dark (offered=0 reads as errorRate=0, i.e. "healthy") and
    // the "still shedding" branch below would immediately zero the shed fraction right back out —
    // a one-step self-defeating loop, not genuine recovery. Capping shed keeps a real trickle of
    // traffic reaching the origin so errorRate keeps measuring the ACTUAL backend condition.
    const MAX_SHED_FRACTION = 0.9
    {
      // Restricted to ENTRY instances (public-port blueprints): an internal-tier instance's own
      // healthy error rate would otherwise DILUTE the signal from a struggling entry tier — this
      // mechanism exists to answer "is the region's front door overloaded", not "is anything
      // anywhere in the region unhappy".
      const offeredByRegion = new Map<RegionId, number>()
      const errorByRegion = new Map<RegionId, number>()
      for (const f of Object.values(s.prevFlows)) {
        const inst = compiled.instances[f.instanceId]
        if (!inst || !s.entryBlueprintIds.has(inst.blueprintId)) continue
        const offered = f.offeredRps
        if (offered <= 0) continue
        // f.errorRps (queue overflow, breaker-open, client timeout) is always capacity-driven.
        // f.refusedRps is NOT purely capacity — it also includes a firewall-blocked path or a
        // manually-downed managed service, which are structural/network-policy problems, not
        // overload. Shedding entry demand can't fix a firewall rule, so counting that toward "is
        // this region overloaded" would engage Mechanism B on a world that's merely misconfigured,
        // not saturated (caught by a permanently-blocked dependency spuriously tripping the shed
        // gate). f.structuralRefusedRps is exactly that non-capacity share, tracked at the source
        // in flows.ts; subtracting it leaves only the capacity-driven refusals (breaker-open has
        // no downstream row at all, so a row-based reconstruction would have missed it).
        const capacityRefused = f.refusedRps - (f.structuralRefusedRps ?? 0)
        offeredByRegion.set(inst.regionId, (offeredByRegion.get(inst.regionId) ?? 0) + offered)
        errorByRegion.set(inst.regionId, (errorByRegion.get(inst.regionId) ?? 0) + f.errorRps + capacityRefused)
      }
      for (const region of Object.values(doc.regions)) {
        const offered = offeredByRegion.get(region.id) ?? 0
        // Zero offered this step carries NO signal about whether the region has recovered — it
        // just means nothing was measured (e.g. an entry instance transiently down from an
        // unrelated OOM-kill cycle, audit ISSUE-008's own Mechanism A). Treating that silence as
        // "0% errors, therefore healthy" would let one signal-free step instantly zero out an
        // active shed fraction via the "still shedding" branch below — the same one-step
        // self-defeating loop MAX_SHED_FRACTION exists to prevent, just via a different trigger.
        // Skip the whole engage/recover/shed update for the region this step; wait for a step with
        // real traffic to actually measure something.
        if (offered <= 0) continue
        const errorRate = (errorByRegion.get(region.id) ?? 0) / offered
        if (errorRate >= REGION_OVERLOAD_ENGAGE_RATE) {
          s.regionOverloadStreak.set(region.id, (s.regionOverloadStreak.get(region.id) ?? 0) + 1)
          s.regionRecoverStreak.set(region.id, 0)
        } else if (errorRate <= REGION_OVERLOAD_RECOVER_RATE) {
          s.regionRecoverStreak.set(region.id, (s.regionRecoverStreak.get(region.id) ?? 0) + 1)
          s.regionOverloadStreak.set(region.id, 0)
        } else {
          // In the dead band between recover and engage thresholds: neither streak advances,
          // but neither resets either — a brief dip below ENGAGE shouldn't erase real progress
          // toward engaging, and vice versa for recovery.
        }
        const currentlyShedding = (s.regionShedFraction.get(region.id) ?? 0) > 0
        if (!currentlyShedding && (s.regionOverloadStreak.get(region.id) ?? 0) >= REGION_OVERLOAD_STREAK_STEPS) {
          s.regionShedFraction.set(region.id, Math.min(MAX_SHED_FRACTION, errorRate))
        } else if (currentlyShedding && (s.regionRecoverStreak.get(region.id) ?? 0) >= REGION_OVERLOAD_STREAK_STEPS) {
          s.regionShedFraction.set(region.id, 0)
        } else if (currentlyShedding) {
          // Still engaged: track the CURRENT error rate so the shed fraction follows a worsening
          // or improving overload without needing to fully disengage and re-engage.
          s.regionShedFraction.set(region.id, Math.min(MAX_SHED_FRACTION, errorRate))
        }
      }
    }

    // ── 1. demand ──
    const demandByPop: Record<PopulationId, number> = {}
    for (const pop of Object.values(doc.populations)) {
      let ds = s.demandStates.get(pop.id)
      if (!ds) {
        ds = createDemandState()
        s.demandStates.set(pop.id, ds)
      }
      demandByPop[pop.id] = populationDemandRps(pop, simMs, s.rng, stepMs, ds, s.demandOverlay)
    }

    // ── 2. routing: health checks ──
    // The probe input is the RAW signal (manual outage now, last step's error/pressure via
    // probePrev) — never healthOfScope: computeHealth folds checkFailed into its output, so
    // probing the output self-sustained (a killed region's checks failed forever and it never
    // recovered after restore — the post-Polish-2 bug).
    const probeOfScope = (scope: OutageScope, id: string): HealthState =>
      hasOutage(s.failover, scope, id) ? 'down' : (s.probePrev.get(id) ?? 'healthy')
    // FEAT-002 Task 12: DIRECTIONAL region-pair health checks — the split-brain enabler. An
    // asymmetric partition can make region B's probe of region A fail while region A's probe of
    // B still succeeds; a single global per-scope health value (the entries below) can't express
    // that, so for every ordered (observer, target) region pair we ALSO probe "is the TARGET
    // reachable FROM the observer" via impairmentFor, composing a distinct scope id per pair so
    // runHealthChecks' consecutive-failure/success debounce tracks each direction independently
    // (runHealthChecks itself is untouched — it just consumes whatever health value a scope is
    // handed). Direction convention (verified against impairmentFor's from/to matching): an
    // observer sees a target as down iff the TARGET->OBSERVER leg is impaired — i.e. call
    // impairmentFor(fromIds=target, toIds=observer) — since a health check's "did I get a
    // response back" signal depends on the response leg (target->observer), not the request leg.
    const regionIds = Object.values(doc.regions).map(r => r.id)
    const regionPairScopeId = (observerId: RegionId, targetId: RegionId): string => `region-pair:${observerId}->${targetId}`
    const regionPairScopes = s.faults.partitions.length === 0 ? [] : regionIds.flatMap(observerId =>
      regionIds.filter(targetId => targetId !== observerId).map(targetId => {
        const imp = impairmentFor({ regionId: targetId }, { regionId: observerId }, s.faults.partitions)
        const baseHealth = probeOfScope('region', targetId)
        const health: HealthState = imp.blocked ? 'down' : baseHealth
        return { id: regionPairScopeId(observerId, targetId), health }
      }),
    )
    const scopes = [
      ...Object.values(doc.regions).map(r => ({ id: r.id, health: probeOfScope('region', r.id) })),
      ...Object.values(doc.azs).map(a => ({ id: a.id, health: probeOfScope('az', a.id) })),
      ...regionPairScopes,
    ]
    const checkResults = runHealthChecks(s.routing, doc.routing, simMs, scopes)
    const checkFailedById = new Map(checkResults.map(c => [c.id, c.checkFailed]))
    for (const c of checkResults) {
      if (c.checkFailed && !s.checkFailedPrev.get(c.id)) emit('health_check_failed', 'warning', `health check failed for ${c.id}`, [c.id], simMs)
      s.checkFailedPrev.set(c.id, c.checkFailed)
    }
    // "Does observerId currently believe targetId is unreachable?" — falls back to targetId's own
    // (non-directional) checkFailed when there's no active partition (byte-identical to today's
    // global behavior in the common no-partition case).
    const regionSeesRegionDown = (observerId: RegionId, targetId: RegionId): boolean =>
      checkFailedById.get(regionPairScopeId(observerId, targetId)) ?? checkFailedById.get(targetId) ?? false

    // ── 3. routing: resolve + build entry demand ──
    const populationRoutes: RoutingSnapshot['populationRoutes'] = []
    const entryDemand: Record<InstanceId, number> = {}
    // Byte-weighted route sizes per entry instance (slice 1: packet-driven egress). Folded into
    // per-instance weighted averages after the routing loop, below.
    const entryByteAccum: Record<InstanceId, EntryByteAccum> = {}
    // Undeliverable rps this step, keyed by the AZ that couldn't serve it (cross-zone-off
    // forfeiture, empty target group, all-down region). Folded into region health + published as
    // a metric so dropped traffic is no longer invisible.
    const droppedByAz: Record<AzId, number> = {}
    // Weighted policy (audit ISSUE-021): compiled regionProportions splits each population's
    // demand ~70/30 across regions like Route 53 weighted records (a population is MANY clients,
    // each resolving independently — no single-region winner, no TTL cliff). Down regions drop
    // out and the split renormalizes over the survivors. Absent proportions (order-based
    // policies, or weighted with all-zero weights) keep the resolveRegion path unchanged.
    const proportions = compiled.routing.regionProportions
    for (const pop of Object.values(doc.populations)) {
      const order = compiled.routing.populationRegionOrder[pop.id] ?? []
      const prevRegion = s.popRegion.get(pop.id) ?? null
      let region: RegionId | null
      let shares: { regionId: RegionId; fraction: number }[] | null = null
      if (proportions) {
        const healthy = order.filter(id => (proportions[id] ?? 0) > 0 && healthOfScope(id) !== 'down')
        const total = healthy.reduce((sum, id) => sum + (proportions[id] ?? 0), 0)
        if (healthy.length > 0 && total > 0) {
          shares = healthy.map(id => ({ regionId: id, fraction: (proportions[id] ?? 0) / total }))
          // "Primary" for failover events / drain arcs: the highest-share healthy region.
          region = shares.reduce((best, e) => (e.fraction > best.fraction ? e : best)).regionId
        } else {
          region = resolveRegion(s.routing, pop.id, order, healthOfScope, doc.routing, simMs, s.rng)
        }
      } else {
        region = resolveRegion(s.routing, pop.id, order, healthOfScope, doc.routing, simMs, s.rng)
      }
      if (!region) continue
      if (prevRegion && prevRegion !== region) {
        emit('ttl_lag_expired', 'info', `${pop.label} DNS re-resolved ${prevRegion} → ${region}`, [pop.id, prevRegion, region], simMs)
        emit('failover_started', 'warning', `${pop.label} failing over ${prevRegion} → ${region}`, [pop.id, prevRegion, region], simMs)
        s.pendingFailover.set(pop.id, region)
        s.popPrevRegion.set(pop.id, prevRegion)   // Phase 5: from-side for the globe drain arc
      } else if (s.pendingFailover.get(pop.id) === region) {
        emit('failover_completed', 'info', `${pop.label} now served by ${region}`, [pop.id, region], simMs)
        s.pendingFailover.delete(pop.id)
        s.popPrevRegion.delete(pop.id)
      }
      s.popRegion.set(pop.id, region)
      // Split the population's scalar demand into per-route rps (its requestMix, else one implicit
      // default route) so the LB can route each class independently. populationRoutes keeps the
      // scalar totals — one row per (population, region) served; order-based policies emit
      // exactly one row, the weighted split one per share.
      for (const { regionId, fraction } of shares ?? [{ regionId: region, fraction: 1 }]) {
        // Demand backpressure (audit ISSUE-008, Mechanism B): shed a fraction of what's OFFERED
        // to an overloaded region before it ever reaches distributeViaLb — explicit admission
        // control at the edge, closing the loop demand.ts structurally cannot (it has no system-
        // state input at all). Absent overload (the common case) this is a no-op multiply by 1.
        const shed = s.regionShedFraction.get(regionId) ?? 0
        const rps = demandByPop[pop.id] * fraction * (1 - shed)
        // Rows are pushed even at rps 0 (a Poisson tick can draw zero arrivals) — the routing
        // snapshot is attribution, and drain arcs / inbound lists key off row presence.
        populationRoutes.push({ populationId: pop.id, regionId, rps })
        distributeViaLb(regionId, splitDemandByMix(rps, pop.requestMix), entryDemand, droppedByAz, entryByteAccum)
      }
    }
    s.lastRoutingSnapshot = { populationRoutes }

    // Weighted-average request/response wire bytes per entry instance, from the route mix that
    // landed there. `entryBytesByInstance` (cost/2 KB convention) → the solver's internet-egress
    // seed; `entryNicBytesByInstance` (512/2048 convention) → the entry NIC booking in step 7.
    const entryBytesByInstance: Record<InstanceId, { reqBytes: number; respBytes: number }> = {}
    const entryNicBytesByInstance: Record<InstanceId, { reqBytes: number; respBytes: number }> = {}
    // Demand-weighted-average request size in KB per entry instance (packet-driven CPU, slice 2) —
    // same fold as the byte fields above, over cpuKb instead. Non-entry instances have no key here
    // → effectiveCpuMs below reads 0 for them, unchanged from today.
    const entryPacketKbByInstance: Record<InstanceId, number> = {}
    // Demand-weighted-average NIC-burst sigma per entry instance (log-normal NIC tails, slice 3) —
    // same fold again, over sigma instead. Read at NIC booking (step 7) below to draw a
    // mean-preserving multiplier; absent/0 ⇒ no draw, booking stays byte-identical to pre-slice-3.
    const entrySizeVarianceByInstance: Record<InstanceId, number> = {}
    // Demand-weighted connection profile per ENTRY instance (connection semantics) — the same fold
    // again, over the four ConnectionProfile fields.
    const entryConnProfileByInstance: Record<InstanceId, ConnectionProfile> = {}
    for (const iid in entryByteAccum) {
      const d = entryDemand[iid]
      if (!d || d <= 0) continue
      const acc = entryByteAccum[iid]
      entryBytesByInstance[iid] = { reqBytes: acc.costReq / d, respBytes: acc.costResp / d }
      entryNicBytesByInstance[iid] = { reqBytes: acc.nicReq / d, respBytes: acc.nicResp / d }
      entryPacketKbByInstance[iid] = acc.cpuKb / d
      entrySizeVarianceByInstance[iid] = acc.varW / d
      entryConnProfileByInstance[iid] = meanProfile(
        { lat: acc.connLatW, fixed: acc.connFixedW, extra: acc.connExtraW, hs: acc.connHsW, frame: acc.connFrameW }, d)
    }

    // Demand-weighted-average INTERNAL inbound request KB per instance (packet library). The
    // entry fold above only sees client→entry traffic; a service that receives fat internal
    // payloads pays cpuMsPerKb on them too, or a blob-ingesting worker would look free.
    //
    // ONE-STEP LAG, deliberately: CPU is computed BEFORE solveFlows, so this step's downstream
    // rows do not exist yet — the signal is read from `s.prevFlows`, the same pattern
    // `admittedScale` and `managedDbRuntime` already use. At the engine's step rate the lag is
    // invisible except in the first tick after a step change in load.
    //
    // The SAME fold also carries the internal tier's connection profile (connection semantics):
    // a service called over streaming or short-lived connections pays for them whether the traffic
    // arrived from a client or from another service.
    const internalPacketKbByInstance: Record<InstanceId, number> = {}
    const internalConnProfileByInstance: Record<InstanceId, ConnectionProfile> = {}
    const internalRpsByInstance: Record<InstanceId, number> = {}
    // Demand-weighted-average INBOUND response bytes per instance (audit ISSUE-009) — the SAME
    // fold as the request-side kb above, widened to also carry `wire.respBytes` (already in scope
    // from the same `wire` lookup, so this is one extra accumulator field, not a new resolution
    // point). Feeds the NIC service-rate ceiling below: the ceiling used to divide by a flat
    // module constant regardless of what an instance's actual traffic was sized as.
    const internalRespBytesByInstance: Record<InstanceId, number> = {}
    {
      const acc: Record<InstanceId, { kb: number; respBytes: number; rps: number } & ProfileAccum> = {}
      for (const pf of Object.values(s.prevFlows)) {
        for (const row of pf.downstream) {
          const toId = row.toInstanceId
          if (row.blocked || row.rps <= 0 || toId == null) continue
          // buildDepWireBytes covers every authored dependency, so a miss here means a stale row
          // (compile drift) — skip it rather than invent a size for it.
          const wire = s.depBytesById[row.dependencyId]
          if (!wire) continue
          const kb = wire.reqBytes / 1024
          const a = acc[toId] ?? (acc[toId] = { kb: 0, respBytes: 0, rps: 0, lat: 0, fixed: 0, extra: 0, hs: 0, frame: 0 })
          a.kb += row.rps * kb
          a.respBytes += row.rps * wire.respBytes
          a.rps += row.rps
          addProfile(a, s.depConnById[row.dependencyId] ?? KEEP_ALIVE_PROFILE, row.rps)
        }
      }
      for (const iid in acc) {
        if (acc[iid].rps <= 0) continue
        internalPacketKbByInstance[iid] = acc[iid].kb / acc[iid].rps
        internalRespBytesByInstance[iid] = acc[iid].respBytes / acc[iid].rps
        internalRpsByInstance[iid] = acc[iid].rps
        internalConnProfileByInstance[iid] = meanProfile(acc[iid], acc[iid].rps)
      }
    }

    // The instance's ONE connection profile, blending the two tiers by rps share so a service that
    // serves both clients and internal callers reads a true weighted profile instead of letting one
    // tier arbitrarily win. Both maps absent ⇒ no key ⇒ every reader below falls back to
    // KEEP_ALIVE_PROFILE, the exact pre-phase behavior.
    const connProfileByInstance: Record<InstanceId, ConnectionProfile> = {}
    for (const iid of new Set([...Object.keys(entryConnProfileByInstance), ...Object.keys(internalConnProfileByInstance)])) {
      const e = entryConnProfileByInstance[iid]
      const n = internalConnProfileByInstance[iid]
      const entryRps = e ? (entryDemand[iid] ?? 0) : 0
      const internalRps = n ? (internalRpsByInstance[iid] ?? 0) : 0
      // Weights count only the tiers that actually contributed a profile, so a missing tier
      // dilutes nothing.
      const total = entryRps + internalRps
      if (total <= 0) continue
      const blend: ProfileAccum = { lat: 0, fixed: 0, extra: 0, hs: 0, frame: 0 }
      if (e) addProfile(blend, e, entryRps)
      if (n) addProfile(blend, n, internalRps)
      connProfileByInstance[iid] = meanProfile(blend, total)
    }
    const connProfileOf = (iid: InstanceId): ConnectionProfile =>
      connProfileByInstance[iid] ?? KEEP_ALIVE_PROFILE

    // Single effective ms/request per instance for this step (packet-driven CPU, slice 2): the
    // blend `cpuMsPerRequest + cpuMsPerKb × avgReqSizeKb`, collapsed once so every read site below
    // (host-scheduler cores, latency fallbacks, the flow-solver's p50) uses the SAME number and the
    // scheduler's nonlinear rps↔cores conversion never sees two different costs for one instance.
    // Absent size signal (an instance nothing calls and no client reaches) or unset cpuMsPerKb
    // (default 0) ⇒ the flat cpuMsPerRequest — byte/metric-identical to pre-slice-2 behavior.
    //
    // The two size signals are combined as a max, not a sum: they are alternative descriptions of
    // "the average request this instance serves", not two separate request streams. An instance
    // with only one of them reads exactly that one.
    //
    // CONNECTION SEMANTICS extends the same blend with a third term:
    //   cpuMs = cpuMsPerRequest + cpuMsPerKb × sizeKb + handshakeCpuMs
    // Because effectiveCpuMs already collapses to the ONE value read by the host scheduler's cores,
    // the latency fallback, and the solver's p50 seed, the handshake adder inherits all three for
    // free — a short-lived route both costs more CPU and takes longer, coherently. keep-alive and
    // streaming contribute 0 here, so only short-lived traffic moves this number.
    const effectiveCpuMs = (iid: InstanceId, bp: WorldDoc['blueprints'][string] | undefined): number => {
      const kb = Math.max(entryPacketKbByInstance[iid] ?? 0, internalPacketKbByInstance[iid] ?? 0)
      return (bp?.workload.cpuMsPerRequest ?? 1)
        + (bp?.workload.cpuMsPerKb ?? 0) * kb
        + connProfileOf(iid).handshakeCpuMs
    }
    // Handed to the flow solver so its p50 latency sample uses the same effective value the host
    // scheduler used for cores (optional/additive FlowInput field). Covers every instance carrying
    // EITHER size signal OR a connection profile — a short-lived route's handshake CPU must reach
    // the solver even on an instance with no authored packet sizes at all.
    const effectiveCpuMsByInstance: Record<InstanceId, number> = {}
    for (const iid of new Set([
      ...Object.keys(entryPacketKbByInstance),
      ...Object.keys(internalPacketKbByInstance),
      ...Object.keys(connProfileByInstance),
    ])) {
      const inst = compiled.instances[iid]
      effectiveCpuMsByInstance[iid] = effectiveCpuMs(iid, inst ? doc.blueprints[inst.blueprintId] : undefined)
    }
    // FEAT-007 (Task 5): the "latency tracks the reciprocal of capacity" half of the cold-start
    // coupling -- a warming instance's effective per-request cost (which flows.ts:519 reads as its
    // p50 basis) is scaled up by 1/warmthBlend, so a cold instance handed the SAME demand shows
    // higher latency exactly as its capacity throttle (Task 4) is granting it fewer cores. Reads
    // s.warmingUntil directly (not Task 4's warmthByInstance, which is server-loop-local and
    // already blended+keyed by resident instances only) so this pass can run once here, ahead of
    // the per-server loop, over every instance present in effectiveCpuMsByInstance -- an instance
    // absent from that record (no packet/conn signal at all) still falls back to the flat
    // cpuMsPerRequest at every OTHER read site (loads[].cpuMsPerRequest, the InstanceLoad built in
    // the server loop below), so it is deliberately left unthrottled here too: nothing downstream
    // would see a throttled value for it anyway. Guarded on s.warmingUntil.size so the fast path
    // costs nothing when no instance anywhere is warming.
    if (s.warmingUntil.size > 0) {
      for (const iid of Object.keys(effectiveCpuMsByInstance)) {
        const entry = s.warmingUntil.get(iid)
        if (!entry) continue
        const inst = compiled.instances[iid]
        const bp = inst ? doc.blueprints[inst.blueprintId] : undefined
        const warmCapacityFraction = bp?.workload.warmCapacityFraction ?? 0.3
        const w = warmthOf(iid, s.warmingUntil, simMs)
        const blend = warmCapacityFraction + (1 - warmCapacityFraction) * w
        effectiveCpuMsByInstance[iid] = effectiveCpuMsByInstance[iid] / Math.max(blend, 0.0001)
      }
    }

    // FEAT-008 (Task 13): rebuild the running-set resolver only when desiredCount's CONTENTS
    // actually changed since the last build -- the SAME memoization shape roleResolver/
    // roleResolverKey use just above (promoKey), applied to a running-set overlay instead of a
    // role overlay. Sits ahead of section 4/5 (host scheduling) below, which is the first reader.
    // Fast-pathed on hasAnyAutoscale so a world with no autoscaling authored never even computes
    // runningSetKey -- runningSet stays the `() => true` set at start() forever.
    if (s.hasAnyAutoscale) {
      const runningSetKey = [...s.autoscale.desiredCount.entries()].map(([k, v]) => `${k}:${v}`).join(',')
      if (runningSetKey !== s.runningSetKey) {
        // Task 15: drainUntilByInstance is threaded through so a draining instance (below the
        // NEW desiredCount but not yet past its drain window) still resolves running=true --
        // passed by reference (live Map), so a drain beginning/completing later this step or a
        // future one is seen without forcing a resolver rebuild of its own.
        s.runningSet = runningSetResolver(compiled, s.autoscale.desiredCount, s.drainUntilByInstance)
        s.runningSetKey = runningSetKey
      }
    }
    // FEAT-008 (Task 13): per-instance CPU utilization (cpuCoresUsed / this server's fair vCPU
    // share of that instance), collected only when hasAnyAutoscale so an unconfigured world pays
    // zero cost -- consumed by the control loop right after the per-server loop below to compute
    // `observedCpu = mean(...) over RUNNING instances of the placement` per the spec's formula.
    const cpuUtilByInstance: Record<InstanceId, number> = {}

    // ── 4/5. host scheduling (prev-step load) + VPS ──
    const admittedScaleByServer: Record<ServerId, number> = {}
    const latencyMultiplierByServer: Record<ServerId, number> = {}
    const extraLatencyMsByServer: Record<ServerId, number> = {}
    // FEAT-001 (Task 5): per-server error-inject fraction, resolved from the SAME activeFaults
    // array as brownout/leak/latencyFault below — solveFlows consumes this plain record and stays
    // decoupled from FaultState entirely.
    const faultErrorFractionByServer: Record<ServerId, number> = {}
    const hostResults: Record<ServerId, HostStepResult> = {}
    const vpsPublish: Record<ServerId, VpsPublish> = {}
    const nicByServer: Record<ServerId, NicState> = {}

    const instancesByServer = s.instancesByServer
    const serviceRateByInstance: Record<InstanceId, number> = {}
    // FEAT-001 perf gate: every fault subsystem must short-circuit to ~0 ms/step when inactive.
    // Computed once per tick (not per server) so the common zero-fault path pays a single
    // Map.size check instead of 3 Map.get()s per server per step.
    const anyFaultsActive = s.faults.active.size > 0
    for (const server of Object.values(doc.servers)) {
      const resident = instancesByServer.get(server.id) ?? []
      // FEAT-001: resolve any active server/az/region-scoped fault for this server once per step —
      // skipped entirely when no fault is active anywhere (the common case).
      let brownout: Extract<FaultSpec, { kind: 'cpu-brownout' }> | undefined
      let leak: Extract<FaultSpec, { kind: 'memory-leak' }> | undefined
      let latencyFault: Extract<FaultSpec, { kind: 'latency-add' }> | undefined
      let errorInject: Extract<FaultSpec, { kind: 'error-inject' }> | undefined
      let diskFault: Extract<FaultSpec, { kind: 'disk-stall' }> | undefined
      if (anyFaultsActive) {
        const faultAzId = s.azOfServer.get(server.id)
        const faultRegionId = faultAzId ? s.regionOfAz.get(faultAzId) : undefined
        const activeFaults = faultAzId && faultRegionId
          ? faultsForServer(server.id, faultAzId, faultRegionId, s.faults)
          : []
        brownout = activeFaults.find(
          (f): f is Extract<FaultSpec, { kind: 'cpu-brownout' }> => f.kind === 'cpu-brownout')
        leak = activeFaults.find(
          (f): f is Extract<FaultSpec, { kind: 'memory-leak' }> => f.kind === 'memory-leak')
        latencyFault = activeFaults.find(
          (f): f is Extract<FaultSpec, { kind: 'latency-add' }> => f.kind === 'latency-add')
        errorInject = activeFaults.find(
          (f): f is Extract<FaultSpec, { kind: 'error-inject' }> => f.kind === 'error-inject')
        // FEAT-006 (Task 19): disk-stall multiplies effective diskIops, the same composition
        // discipline cpu-brownout already uses for effectiveVcpu below (multiply, not replace).
        diskFault = activeFaults.find(
          (f): f is Extract<FaultSpec, { kind: 'disk-stall' }> => f.kind === 'disk-stall')
        if (errorInject) faultErrorFractionByServer[server.id] = errorInject.errorFraction
        const activeLeak = leak
        if (activeLeak) {
          stepLeaks(s.faults, resident.map(i => ({ instanceId: i.id, mbPerMinute: activeLeak.mbPerMinute })), stepSec)
        }
      }
      // FEAT-008 (Task 13): a parked instance (indexInPlacement past the placement's current
      // desiredCount) contributes NO InstanceLoad entry at all -- stepHost only ever sees the
      // loads it's handed, so "not present" already means "zero CPU, zero RAM" for free, no
      // stepHost change needed. runningSet's fast path (`() => true`) makes this filter a no-op
      // for every world with no autoscaling authored.
      const loads: InstanceLoad[] = resident.filter(i => s.runningSet(i.id)).map(i => {
        const pf = s.prevFlows[i.id]
        const bp = doc.blueprints[i.blueprintId]
        const admitted = pf?.admittedRps ?? 0
        // Composed end-to-end latency (audit ISSUE-003), not self-only serviceLatencyMs: this is
        // the OTHER of the two Little's-law call sites (metrics.ts's published activeConnections
        // is the other), so a caller blocked on a slow dependency must hold MORE connections here
        // too, or the RAM the scheduler enforces/OOM-kills on would silently diverge from what
        // metrics.ts publishes and the user sees.
        const latency = pf?.totalLatencyMs ?? pf?.serviceLatencyMs ?? effectiveCpuMs(i.id, bp)
        const runtime = doc.placements[i.placementId]?.runtime
        return {
          instanceId: i.id,
          cpuMsPerRequest: effectiveCpuMs(i.id, bp),
          admittedRps: admitted,
          // Connection semantics: one of the TWO call sites of the Little's-law formula (the other
          // is metrics.ts's published InstanceMetrics.activeConnections). Both go through
          // connectionModel's activeConnections() so the RAM the scheduler enforces here — and
          // OOM-kills on — can never diverge from the RAM the user is shown. With the keep-alive
          // identity this is bit-for-bit the old `admitted * (latency / 1000)`.
          activeConnections: activeConnections(admitted, latency, connProfileOf(i.id)),
          // FEAT-001: a memory-leak fault's accumulator folds into the base footprint so it grows
          // the RAM the host scheduler enforces (and OOM-kills on) — 0 when no leak is active,
          // byte-identical to pre-FEAT-001 behavior.
          ramBaseMb: (bp?.workload.ramBaseMb ?? 0) + (s.faults.leakAccumMb.get(i.id) ?? 0),
          ramPerConnMb: bp?.workload.ramPerConnMb ?? 0,
          memLimitMb: runtime && runtime.type === 'container' ? runtime.memLimitMb : null,
          // Audit ISSUE-018/013: fair-share weight + carried backlog, so the scheduler can grant
          // a draining instance capacity beyond its instantaneous demand.
          cpuShares: bp?.workload.cpuShares ?? 1,
          backlogRps: (s.queueDepth.get(i.id) ?? 0) / stepSec,
          // Self-hosted connection pool (audit ISSUE-005) — absent ⇒ unbounded, the pre-issue
          // behavior (poolCheckoutFor returns null and RAM/OOM accounting is untouched).
          maxConnections: bp?.workload.maxConnections,
          checkoutTimeoutMs: bp?.workload.checkoutTimeoutMs,
        }
      })
      // FEAT-001: cpu-brownout composes MULTIPLICATIVELY with the existing VPS steal factor
      // (capacityFraction defaults to 1 — a no-op — when no brownout is active).
      const effectiveVcpu = server.specs.vcpu * (s.vpsFactor.get(server.id) ?? 1) * (brownout?.capacityFraction ?? 1)
      // FEAT-006 (Task 19), audit final-review-gated: disk I/O demand vs. capacity for this server
      // this step. disk-stall multiplies the effective diskIops ceiling (mirrors cpu-brownout's
      // effectiveVcpu multiply above) — capacityFraction=1 when no disk-stall is active, a no-op.
      // diskWaitFor returns null when the server has neither diskIops nor diskType authored
      // (unmodelled, the regression floor), else 0 at/under saturation, else a growing
      // queueing-delay term. The whole block is gated on s.hasAnyDisk (the hasAnyCache/
      // hasAnyReplicas fast-path precedent) so a world with NO server anywhere carrying diskIops/
      // diskType pays zero per-step disk cost — diskWaitFor/diskCeiling/diskIoRatio would all
      // resolve to null/undefined per-server anyway in that world, this just skips paying for that
      // computation N servers x every step. blueprintIdByInstance is a start()-time index (not
      // rebuilt from `resident` every step) — the SAME "build once, read every step" discipline as
      // downstreamAdj/instancesByServer above.
      let diskWaitMs: number | null = null
      let diskIoRatio: number | undefined
      if (s.hasAnyDisk) {
        const demandIops = diskIoDemandFor(loads, s.blueprintIdByInstance, doc)
        const stalledIops = server.specs.diskIops != null
          ? server.specs.diskIops * (diskFault?.iopsFraction ?? 1)
          : server.specs.diskIops
        diskWaitMs = diskWaitFor(demandIops, stalledIops, server.specs.diskType)
        // FEAT-006 (Task 20): the SAME ceiling resolution diskWaitFor used internally, exposed here
        // so metrics.ts's ceiling-aware diskIoFraction branch can read the exact ratio that drove
        // this step's diskWaitMs rather than re-deriving it. undefined ⇒ neither diskIops nor
        // diskType authored ⇒ the legacy diskIo/100 branch stays in force (regression floor).
        const diskCeiling = resolveDiskIopsCeiling(stalledIops, server.specs.diskType)
        diskIoRatio = diskCeiling != null ? demandIops / Math.max(diskCeiling, 0.0001) : undefined
        // FEAT-006 (Task 21): disk_saturated, rate-limited per server -- mirrors
        // replication_lag_high's gate shape (a lastEmittedAtMs map checked before pushing). Only
        // fires when a ceiling is actually resolvable (diskIoRatio defined); a server with neither
        // diskIops nor diskType authored has no comparable ratio and never fires, matching
        // diskIoFraction's own dual-behavior split (Task 20).
        if (diskIoRatio != null && diskIoRatio > DISK_SATURATION_THRESHOLD) {
          const last = s.diskSaturatedRateLimit.get(server.id) ?? -Infinity
          if (simMs - last >= DISK_EVENT_MIN_GAP_MS) {
            s.diskSaturatedRateLimit.set(server.id, simMs)
            emit('disk_saturated', 'warning',
              `${server.label} disk I/O at ${Math.min(1, diskIoRatio) * 100 | 0}% of its IOPS ceiling`,
              [server.id, ...resident.map(i => i.id)], simMs)
          }
        }
      }
      // FEAT-007 (Task 4): blend Task 2's raw 0..1 warmthOf() ramp with the workload's
      // warmCapacityFraction (the floor capacity at t=0) so stepHost's water-fill sees the
      // ACTUAL capacity fraction, not the raw ramp — e.g. warmCapacityFraction 0.3 + raw 0.5 at
      // the ramp's midpoint blends to 0.65, not 0.5. Fast-pathed on s.warmingUntil.size (the same
      // "empty map ⇒ undefined, skip the per-server Object.fromEntries" discipline hasAnyDisk/
      // hasAnyCache use elsewhere) so a world with no warming instance anywhere pays zero cost
      // here and stepHost sees `undefined` (its own regression floor).
      const warmthByInstance: Record<InstanceId, number> | undefined = s.warmingUntil.size === 0
        ? undefined
        : Object.fromEntries(
            resident.map(inst => {
              const bp = doc.blueprints[inst.blueprintId]
              const floor = bp?.workload.warmCapacityFraction ?? 0.3
              const raw = warmthOf(inst.id, s.warmingUntil, simMs)
              return [inst.id, floor + (1 - floor) * raw]
            }),
          )
      const host = stepHost(server, loads, effectiveVcpu, s.rng, diskWaitMs, diskIoRatio, warmthByInstance)
      hostResults[server.id] = host
      // Fold the NIC's ABSOLUTE line-rate ceiling into each instance's capacity (audit
      // ISSUE-002 × ISSUE-013 × ISSUE-009): bandwidth is split across resident instances by the
      // same cpu-share weights, THEN each instance's own share of bytes/sec converts to a
      // per-instance rps ceiling using THAT instance's own resolved wire size — not a flat 2 KB
      // module constant. A large-payload edge (bulk export, big DB result sets) used to model
      // orders-of-magnitude more NIC throughput than physically possible, because the divisor
      // never looked at what the instance's actual traffic was sized as, even though the exact
      // resolved-size signals it needs (`entryNicBytesByInstance`/`internalPacketKbByInstance`/
      // `internalRespBytesByInstance`, above) are already built this same step for the CPU blend.
      const nicCeilingBytesPerSec = (server.specs.nicMbps * 1e6) / 8
      const totalShares = loads.reduce((sum, l) => sum + Math.max(0, l.cpuShares ?? 1), 0) || 1
      // FEAT-008 (Task 13): observedCpu = mean(cpuCoresUsed / vcpuShare) over a placement's
      // RUNNING instances (spec formula) -- cpuCoresUsed from THIS step's prev-flow admitted load
      // (the same admitted/cpuMsPerRequest basis `loads` was just built from), vcpuShare from the
      // SAME fair-share split the NIC bandwidth divvy-up just above uses (cpuShares / totalShares
      // of this server's effectiveVcpu), so a placement co-resident with heavier siblings reads a
      // proportionally smaller ceiling, not the server's full core count. Only running (loads
      // already excludes parked) instances contribute -- there is nothing to read for a parked
      // one anyway. Gated on hasAnyAutoscale so an unconfigured world skips this per-instance pass
      // entirely.
      if (s.hasAnyAutoscale) {
        for (const l of loads) {
          const vcpuShare = effectiveVcpu * (Math.max(0, l.cpuShares ?? 1) / totalShares)
          const cpuCoresUsed = (l.admittedRps * l.cpuMsPerRequest) / 1000
          cpuUtilByInstance[l.instanceId] = vcpuShare > 0 ? cpuCoresUsed / vcpuShare : 0
        }
      }
      const fallbackWireBytes = Math.max(NIC_REQUEST_BYTES, NIC_RESPONSE_BYTES)
      for (const l of loads) {
        const eb = entryNicBytesByInstance[l.instanceId]
        const reqBytes = Math.max(eb?.reqBytes ?? 0, (internalPacketKbByInstance[l.instanceId] ?? 0) * 1024)
        const respBytes = Math.max(eb?.respBytes ?? 0, internalRespBytesByInstance[l.instanceId] ?? 0)
        // The worst byte direction governs (mirrors evaluateNic) — falls back to the historical
        // flat constant when this instance has no resolvable traffic yet this step (cold start /
        // zero rps), which is exactly today's pre-fix behavior for that case.
        const effectiveWireBytes = Math.max(reqBytes, respBytes) || fallbackWireBytes
        const instanceBandwidthShare = nicCeilingBytesPerSec * (Math.max(0, l.cpuShares ?? 1) / totalShares)
        const nicShare = instanceBandwidthShare / effectiveWireBytes
        serviceRateByInstance[l.instanceId] =
          Math.min(host.serviceRateByInstance[l.instanceId] ?? 0, nicShare)
      }
      // Audit ISSUE-002 + ISSUE-016: the per-server scale now carries ONLY the NIC's delivered
      // fraction. CPU saturation no longer sheds throughput proportionally (the old one-step-lag
      // oscillator) — it bounds each instance's service rate, and the queue model (ISSUE-013)
      // absorbs the excess as latency before erroring past the queue bound.
      admittedScaleByServer[server.id] = s.nicDeliveredFraction.get(server.id) ?? 1
      latencyMultiplierByServer[server.id] = host.latencyMultiplier
      const queuedMs = s.nicQueuedLatencyMs.get(server.id) ?? 0
      const faultMs = latencyFault?.ms ?? 0
      // FEAT-006 (Task 19): disk wait composes ADDITIVELY with NIC-queue and latency-fault ms,
      // the same "must ADD not assign" discipline FEAT-001 established for extraLatencyMsByServer
      // — this is the single mechanism that reaches BOTH Little's-law call sites (the host
      // scheduler's next-step InstanceLoad.activeConnections via prevFlows, and metrics.ts's
      // published activeConnections via the same flows-solved latency samples).
      const diskMs = diskWaitMs ?? 0
      const totalExtraMs = queuedMs + faultMs + diskMs
      if (totalExtraMs > 0) extraLatencyMsByServer[server.id] = totalExtraMs
      let nic = s.nics.get(server.id)
      if (!nic) {
        nic = createNicState()
        s.nics.set(server.id, nic)
      }
      nicByServer[server.id] = nic

      if (host.oomVictim && !s.oomRestartAt.has(host.oomVictim)) {
        s.oomRestartAt.set(host.oomVictim, simMs + OOM_RESTART_MS)
        s.instanceHealth.set(host.oomVictim, 'down')
        // FEAT-001: a restarted process gets a fresh heap — any accumulated leak resets with it.
        s.faults.leakAccumMb.delete(host.oomVictim)
        emit('oom_kill', 'critical', `${host.oomVictim} OOM-killed on ${server.label}`, [host.oomVictim, server.id], simMs)
        // FEAT-007 (Task 3): a restarted process ramps back up from cold, mirroring the
        // leakAccumMb/cache-warmth resets above.
        const victimBp = doc.blueprints[s.blueprintIdByInstance.get(host.oomVictim) ?? '']
        const coldStartMs = victimBp?.workload.coldStartMs ?? 0
        if (coldStartMs > 0) {
          s.warmingUntil.set(host.oomVictim, { startedMs: simMs, coldStartMs })
          emit('instance_warming', 'info', `instance ${host.oomVictim} restarted and is ramping up from cold`, [host.oomVictim], simMs)
        }
      }

      const vpsState = s.vpsStates.get(server.id) ?? null
      if (vpsState) {
        // Unclamped pressure (audit ISSUE-034): the drain term scales with utilization above
        // baseline, so clamping to 1 made a 5x-hammered burstable VM burn credits no faster
        // than one at exactly-full load. stepVps only reads utilization for drain (accrual is
        // continuous, the steal walk never sees it), so >1 values are safe there.
        const vps = stepVps(vpsState, server, host.cpuPressure, stepMs, s.rng)
        s.vpsFactor.set(server.id, vps.effectiveVcpuFactor)
        vpsPublish[server.id] = { steal: vps.steal, effectiveVcpuFactor: vps.effectiveVcpuFactor, creditsFraction: vps.creditsFraction }
        if (vps.noisySpikeStarted) emit('noisy_neighbor', 'warning', `noisy-neighbor steal spike on ${server.label}`, [server.id], simMs)
        if (vps.creditsJustExhausted) emit('burst_credits_exhausted', 'warning', `${server.label} burst credits exhausted`, [server.id], simMs)
      } else {
        s.vpsFactor.set(server.id, 1)
        vpsPublish[server.id] = { steal: 0, effectiveVcpuFactor: 1, creditsFraction: null }
      }
    }

    // ── FEAT-008 (Task 13): autoscale control loop ──
    // Runs every step (not literally gated to a cooldown boundary) because evaluatePolicy is
    // itself cooldown-gated internally (lastScaleUpAt/lastScaleDownAt) -- calling it on a step
    // inside a cooldown window is a cheap no-op (`{ next: current, scaled: null }`), so a separate
    // step-scheduling gate on top would only add complexity without changing behavior. Hard-gated
    // on hasAnyAutoscale so a world with no autoscaling authored never even walks doc.placements
    // here.
    if (s.hasAnyAutoscale) {
      for (const pl of Object.values(doc.placements)) {
        if (!pl.autoscale) continue
        const desired = s.autoscale.desiredCount.get(pl.id) ?? pl.autoscale.minCount
        // Mean over the placement's CURRENTLY RUNNING instances only (spec formula) -- an
        // instance past `desired` is parked and never entered `loads`/`cpuUtilByInstance` this
        // step, so it is correctly excluded by construction, not by an extra filter here.
        let utilSum = 0
        for (let i = 0; i < desired; i++) utilSum += cpuUtilByInstance[instanceId(pl.id, i)] ?? 0
        const observedCpuPercent = desired > 0 ? (utilSum / desired) * 100 : 0
        const result = evaluatePolicy(pl, observedCpuPercent, s.autoscale, simMs)
        if (result.scaled === 'out') {
          // FEAT-007 hookup (Task 6 of this task's brief): every NEWLY-running instance starts
          // cold, the same registration Task 3 established for OOM restarts -- scale-out
          // therefore does not help immediately, and scaleUpCooldownSec is a genuine design
          // decision rather than a decorative field (spec's own framing).
          const bp = doc.blueprints[pl.blueprintId]
          const coldStartMs = bp?.workload.coldStartMs ?? 0
          for (let i = desired; i < result.next; i++) {
            const newId = instanceId(pl.id, i)
            if (coldStartMs > 0) {
              s.warmingUntil.set(newId, { startedMs: simMs, coldStartMs })
              emit('instance_warming', 'info', `instance ${newId} started cold by autoscale scale-out`, [newId], simMs)
            }
          }
          emit('scale_out', 'info', `placement ${pl.id} scaled out ${desired} -> ${result.next} instances`, [pl.id], simMs)
        } else if (result.scaled === 'in') {
          // Task 15: every instance whose index falls in [result.next, desired) just transitioned
          // from running to below the new desiredCount line -- instead of parking it outright this
          // step, begin its drain grace window. Until the drain completes (the 0c cleanup pass
          // above), runningSetResolver still treats it as running (CPU/RAM/publishing continue),
          // while routingHealthOfInstance excludes it from NEW traffic immediately. This event
          // fires the moment desiredCount itself changes, matching 'scale_out' firing on the
          // decision, not on completion.
          for (let i = result.next; i < desired; i++) {
            beginInstanceDrain(s.drainUntilByInstance, instanceId(pl.id, i), simMs)
          }
          emit('scale_in', 'info', `placement ${pl.id} scaled in ${desired} -> ${result.next} instances`, [pl.id], simMs)
        }
        // Task 17 owns 'autoscale_ceiling' emission (rate-limited, sat-at-maxCount-while-over-
        // target detection) -- deliberately not stubbed here beyond the EngineEventKind variant
        // itself (types.ts), to avoid a second, uncoordinated rate-limit map landing ahead of
        // Task 17's own.
      }
    }

    // ── 6. flows ──
    const breakerOpen = (key: string): boolean => {
      const b = s.breakers.get(key)
      if (!b) return false
      transition(b, simMs)
      return !admitRequest(b, simMs)
    }
    // Effective roles carry the promotion overlay committed at the END of a PRIOR step
    // (promoteReplicas below), so once a primary has failed over, this step's writes route to the
    // promoted replica. Built from engine state only — the doc is never touched. Memoized on
    // promotedAt's contents (audit ISSUE-079): after a promotion the resolver rescans all
    // instances, so rebuild it only when the overlay actually changes.
    const promoKey = s.failover.promotedAt.size === 0 ? '' : [...s.failover.promotedAt.keys()].sort().join('|')
    if (!s.roleResolver || s.roleResolverKey !== promoKey) {
      s.roleResolver = effectiveRoleResolver(compiled, s.failover.promotedAt)
      s.roleResolverKey = promoKey
    }
    const roleOf = s.roleResolver
    // Managed-DB failure model (node-model Phase 5.4) from the PREVIOUS step's flows. Queueing
    // latency, Little's-law connections and the timeout fraction are all functions of a DB's
    // AGGREGATE load, which the solver's per-dependency loop cannot see — so it is computed once
    // here and both the solver and the metrics window read the same entries. One-step lag, exactly
    // like admittedScale. Skipped outright when the world has no managed DB (audit ISSUE-079).
    // s.depBytesById carries the packet-derived write fraction (audit ISSUE-001) so the AGGREGATE
    // read/write split measured against writeCeiling/readCeiling matches the one the solver routes
    // primaries/replicas on, and the one EdgeInspector displays.
    const managedDbRt = s.hasManagedDbs ? managedDbRuntime(s.prevFlows, doc, compiled, s.depBytesById, s.depById) : {}
    // Event-broker runtime (audit ISSUE-002), same one-step-lag shape as managedDbRt above: THIS
    // step's serviceRateByInstance (already resolved for the queue model, just above) is reused as
    // the topic's consumer capacity — a consumer's simulated capacity can never disagree between
    // its own queue and the topic it drains. Skipped outright when the world has no event
    // dependency (audit ISSUE-079's hasManagedDbs pattern).
    const topicRt = s.hasEventDeps ? topicRuntime(s.prevFlows, compiled, doc, serviceRateByInstance, s.topicBacklog, stepSec) : {}
    // FEAT-002 (Task 10): per-path network-partition impairment, resolved once per step from
    // s.faults.partitions. Skipped entirely when no partition is active (the common case),
    // matching the anyFaultsActive short-circuit discipline above. NOT consumed inside flows.ts
    // yet — a later task wires actual blocking/loss/delay behavior off this map.
    const impairmentMemo = buildImpairmentMemo(compiled, doc, s.faults.partitions, s.regionOfAz)
    // FEAT-004 (Task 3): per-cache-identity miss fraction, keyed by instance id (a service whose
    // own blueprint carries cacheConfig — the "proxy" shape) or `managed:${id}` (a managed cache
    // target reached via cacheAsideVia — the "cache-aside" shape). Skipped entirely when the world
    // has no cache configured anywhere (the common case), so an unconfigured world's runStep does
    // zero extra work.
    let cacheMissFractionByInstance: Record<string, number> | undefined
    if (s.hasAnyCache) {
      cacheMissFractionByInstance = {}
      for (const inst of Object.values(compiled.instances)) {
        const bp = doc.blueprints[inst.blueprintId]
        if (!bp?.cacheConfig) continue
        cacheMissFractionByInstance[inst.id] =
          effectiveMissFraction(bp.cacheConfig, s.warmSinceMs.get(inst.id), simMs, stepSec)
        // FEAT-004 (Task 5): fires exactly once per cold cycle, the step warmth first reaches 1
        // (effectiveHitRatio === cfg.hitRatio) — warmEmitted is the "already fired" guard, reset
        // at the two restart/fault-clear sites above whenever a NEW cold cycle begins.
        const warmSince = s.warmSinceMs.get(inst.id)
        if (warmSince !== undefined && !s.warmEmitted.has(inst.id) && simMs - warmSince >= bp.cacheConfig.warmupSec * 1000) {
          s.warmEmitted.add(inst.id)
          emit('cache_warm', 'info', `instance ${inst.id} cache is fully warm`, [inst.id], simMs)
        }
      }
      for (const ms of Object.values(doc.managedServices)) {
        if (!ms.cacheConfig) continue
        const warmKey = `managed:${ms.id}`
        cacheMissFractionByInstance[warmKey] =
          effectiveMissFraction(ms.cacheConfig, s.warmSinceMs.get(warmKey), simMs, stepSec)
        const warmSince = s.warmSinceMs.get(warmKey)
        if (warmSince !== undefined && !s.warmEmitted.has(warmKey) && simMs - warmSince >= ms.cacheConfig.warmupSec * 1000) {
          s.warmEmitted.add(warmKey)
          emit('cache_warm', 'info', `managed cache ${ms.id} is fully warm`, [ms.id], simMs)
        }
      }
    }
    // FEAT-005 (Task 11): stale-read fraction per replica, ONE-STEP LAGGED off the PREVIOUS step's
    // resolved write rps (s.prevWriteRpsByCluster) and the lag reading at the START of this step
    // (s.replication.lagSecByInstance, last written at the END of the previous step) — see
    // EngineState.prevWriteRpsByCluster's own comment for why an unlagged value here would be
    // circular. Skipped entirely when the world has no replica-role db instance.
    let staleReadFractionByReplica: Record<string, number> | undefined
    if (s.hasAnyReplicas) {
      staleReadFractionByReplica = {}
      for (const [clusterId, replicas] of Object.entries(s.replicasByCluster)) {
        const writeRps = s.prevWriteRpsByCluster[clusterId] ?? 0
        const hotKeyCount = s.dbConfigByCluster.get(clusterId)?.hotKeyCount ?? 1000
        for (const replica of replicas) {
          const lagSec = s.replication.lagSecByInstance.get(replica.id) ?? 0
          staleReadFractionByReplica[replica.id] = staleReadFraction(writeRps, lagSec, hotKeyCount)
        }
      }
    }
    const { flows, totals, depthExceededInstanceIds, cycleCutEdges, writeRpsByCluster } = solveFlows({
      compiled, doc, entryDemand, admittedScaleByServer, latencyMultiplierByServer,
      extraLatencyMsByServer,
      // FEAT-004 (Task 3): cache economics multiplier — see cacheMissFractionByInstance's own
      // comment just above and flows.ts's dependency loop for how it's applied.
      cacheMissFractionByInstance,
      cacheAsideIndexByDepId: s.cacheAsideIndexByDepId,
      // FEAT-001 (Task 5): active error-inject faults, resolved once per server above.
      faultErrorFractionByServer,
      // Queue model (audit ISSUE-013): fair-share service rates + the persistent queue map
      // (mutated in place) + step length — activates the queueing path in the solver.
      serviceRateByInstance, queueDepth: s.queueDepth, stepSec,
      // Packet-driven egress (slice 1): per-entry-instance request+response wire bytes seed the
      // internet-egress byte total by the route mix's actual payload size (absent ⇒ 2 KB fallback).
      entryBytesByInstance,
      // Packet-driven CPU (slice 2): the same entry-tier signal, collapsed into one effective
      // ms/request per instance, seeds the solver's service-latency p50 so a bigger packet takes
      // longer AND costs more CPU, coherently with the host scheduler's read of the same value.
      effectiveCpuMsByInstance,
      // Packet library: per-dependency wire bytes for internal hops, so cross-AZ/cross-region
      // egress (and the managed-DB write fraction) respond to what the edge actually carries.
      depBytesById: s.depBytesById,
      breakerOpen, healthOf: healthOfInstance, roleOf, rng: s.rng,
      // Manual managed-service outages (node-model Phase 5.2): a downed managed service fails every
      // call to it. Read straight from the manual-outage set — managed ids aren't in the per-step
      // health recompute, so healthByScope would go stale on restore.
      managedDown: (id) => hasOutage(s.failover, 'managed', id),
      managedDbRuntime: managedDbRt,
      topicRuntime: topicRt,
      impairmentMemo,
      // FEAT-005 (Task 11): see the field's own comment just above for the one-step-lag rationale.
      staleReadFractionByReplica,
      // FEAT-005 (Task 11, Step 6): static semi-sync ack RTT per primary instance — see
      // buildReplicationIndexes' comment for the narrowed hook this implements.
      semiSyncExtraMsByInstance: s.hasAnyReplicas ? s.semiSyncExtraMsByInstance : undefined,
    })

    // FEAT-005 (Task 11): advance the replication backlog/lag model, AFTER the flow solve — per
    // the spec's own step ordering — so writeRpsByCluster reflects THIS step's actual resolved
    // write traffic (threaded straight out of solveFlows' result) rather than a stale guess.
    if (s.hasAnyReplicas) {
      // Live per-step applyCapacity: dbConfig.applyRatePerReplica when authored, else derived from
      // the replica's OWN service rate (hostScheduler's fair-share rps, already resolved above for
      // the queue model) x the write-apply efficiency constant. Structural fields (id/locality/
      // from-to region) are copied from the static index built at start() — only applyCapacity is
      // re-derived, since it's the only per-step-varying field.
      const liveReplicasByCluster: Record<string, ReplicaRef[]> = {}
      for (const [clusterId, replicas] of Object.entries(s.replicasByCluster)) {
        const dbConfig = s.dbConfigByCluster.get(clusterId)
        liveReplicasByCluster[clusterId] = replicas.map(r => ({
          ...r,
          applyCapacity: dbConfig?.applyRatePerReplica ?? (serviceRateByInstance[r.id] ?? 0) * WRITE_APPLY_EFFICIENCY_CONST,
        }))
      }
      stepReplication(s.replication, liveReplicasByCluster, writeRpsByCluster, stepSec)

      // Semi-sync mode (Step 6): a semi-sync replica's lag is bounded by acknowledgement RTT, not
      // async backlog — model it as DOUBLE localityFloorSec's one-way propagation floor (a
      // request-response round trip: the primary waits for the replica's ack before completing the
      // write, unlike async replication's fire-and-forget one-way floor). This OVERRIDES whatever
      // stepReplication computed for this replica above; the spec doesn't pin an exact RTT-vs-floor
      // convention, so doubling the one-way floor is this task's explicit, documented choice.
      for (const [clusterId, replicas] of Object.entries(s.replicasByCluster)) {
        const dbConfig = s.dbConfigByCluster.get(clusterId)
        if (dbConfig?.replicationMode !== 'semi-sync') continue
        for (const r of replicas) {
          const rttSec = localityFloorSec(r.locality, r.fromRegionId, r.toRegionId) * 2
          s.replication.lagSecByInstance.set(r.id, rttSec)
        }
      }

      // FEAT-005 (Task 14): replication_lag_high, rate-limited per cluster — mirrors the
      // connection_refused gate below (refusedRateLimit's exact shape, a lastEmittedAtMs map
      // checked before pushing). Checked once per cluster per step against the primary blueprint's
      // authored DbConfig.rpoTargetSec; a cluster with no authored target (rpoTargetSec == null)
      // never fires.
      for (const [clusterId, replicas] of Object.entries(s.replicasByCluster)) {
        const rpoTargetSec = s.dbConfigByCluster.get(clusterId)?.rpoTargetSec
        if (rpoTargetSec == null) continue
        const worstLagSec = Math.max(0, ...replicas.map(r => s.replication.lagSecByInstance.get(r.id) ?? 0))
        if (worstLagSec <= rpoTargetSec) continue
        const last = s.replicationLagRateLimit.get(clusterId) ?? -Infinity
        if (simMs - last < REPLICATION_EVENT_MIN_GAP_MS) continue
        s.replicationLagRateLimit.set(clusterId, simMs)
        const [primaryBlueprintId] = clusterId.split('|')
        const bpName = doc.blueprints[primaryBlueprintId]?.name ?? primaryBlueprintId
        emit('replication_lag_high', 'warning',
          `${bpName} replication lag (${worstLagSec.toFixed(1)}s) exceeds its RPO target (${rpoTargetSec}s)`,
          replicas.map(r => r.id), simMs)
      }
      // FEAT-005 (Task 14): stale_read_served, rate-limited per replica instance — gated on
      // staleReadFractionByReplica (this step's one-step-lagged reading, computed above before
      // solveFlows) being nonzero, so it never fires for a replica currently caught up.
      if (staleReadFractionByReplica) {
        for (const [replicaId, fraction] of Object.entries(staleReadFractionByReplica)) {
          if (fraction <= 0) continue
          const last = s.staleReadRateLimit.get(replicaId) ?? -Infinity
          if (simMs - last < REPLICATION_EVENT_MIN_GAP_MS) continue
          s.staleReadRateLimit.set(replicaId, simMs)
          emit('stale_read_served', 'info',
            `${replicaId} served a stale read (${(fraction * 100).toFixed(1)}% stale-read probability)`,
            [replicaId], simMs)
        }
      }

      s.prevWriteRpsByCluster = writeRpsByCluster
    }

    // Audit ISSUE-010: surface silently-dropped fan-out. Both conditions previously left no trace
    // anywhere — an instance past MAX_DEPTH read as a healthy, zero-traffic leaf; a cyclic re-entry
    // cut by the BFS guard left only a normal-looking downstream row with no marker it was cut.
    // Deduped to once per run per instance/edge (a state TRANSITION, not a steady-state condition)
    // so a persistently-overloaded/cyclic topology doesn't spam one event per step.
    for (const id of depthExceededInstanceIds) {
      if (s.depthExceededReported.has(id)) continue
      s.depthExceededReported.add(id)
      emit('chain_depth_exceeded', 'warning', `${id}'s dependency chain exceeded MAX_DEPTH and stopped fanning out further`, [id], simMs)
    }
    for (const { fromId, toId } of cycleCutEdges) {
      const key = `${fromId}->${toId}`
      if (s.cycleCutReported.has(key)) continue
      s.cycleCutReported.add(key)
      emit('chain_cycle_cut', 'warning', `dependency cycle cut: ${fromId} -> ${toId} is already on this request chain`, [fromId, toId], simMs)
    }

    // ── 7. NIC byte accounting (audit ISSUE-002: split request/response, persistent buffer) ──
    // Ingress = request payloads in, egress = response payloads out — no longer symmetric.
    // Settlement (deliveredFraction / queuedLatencyMs) happens once per server AFTER step 10's
    // metrics accumulate (which reads the per-step counters), feeding the NEXT step.
    //
    // TWO tiers, booked separately:
    //   entry    — client→instance demand, sized by the route mix that landed there (unchanged).
    //   internal — service→service calls, sized PER DEPENDENCY ROW by the packet library.
    //
    // The internal tier is the packet-library restructure. It used to be one aggregate term on
    // the SERVING side (`internalRps × 512/2048`), which could not vary by what the edge carried
    // and never touched the caller's NIC at all. It is now booked per downstream row on BOTH
    // endpoints — the caller sends the request and receives the response, the callee the mirror —
    // which is what makes a fat internal payload saturate the uplink of the service producing it.
    // The old aggregate term is REPLACED, not supplemented: booking both here and there would
    // double-count the callee.
    for (const f of Object.values(flows)) {
      const inst = compiled.instances[f.instanceId]
      const nic = inst ? nicByServer[inst.serverId] : undefined
      if (!inst || !nic) continue
      // `entryNicBytesByInstance` already falls back to 512/2048 for unauthored routes, so an
      // entry instance stays byte-identical.
      const eb = entryNicBytesByInstance[f.instanceId]
      const entryRps = eb ? Math.min(f.admittedRps, entryDemand[f.instanceId] ?? 0) : 0
      if (entryRps > 0 && eb) {
        // Log-normal NIC-burst tail (slice 3): a fresh mean-1 multiplier each step on the ENTRY
        // byte terms only — never entryBytesByInstance (the separate cost/egress seed above,
        // untouched). sigma <= 0 (unauthored route) draws nothing and multiplies by exactly 1.
        const sigma = entrySizeVarianceByInstance[f.instanceId] ?? 0
        const m = sigma > 0 ? sampleSizeMultiplier(sigma, s.rng) : 1
        addNicBytes(nic, entryRps * eb.reqBytes * m * stepSec, entryRps * eb.respBytes * m * stepSec)
      }

      // Internal hops this instance ORIGINATES. Blocked rows never reach the wire. A managed
      // target has no server of ours, so only the caller's side is booked for it.
      for (const row of f.downstream) {
        if (row.blocked || row.rps <= 0) continue
        const wire = s.depBytesById[row.dependencyId]
        const reqBytes = wire?.reqBytes ?? NIC_REQUEST_BYTES
        const respBytes = wire?.respBytes ?? NIC_RESPONSE_BYTES
        // ONE draw per row, shared by both endpoints — the same packet is on both wires. The
        // `sigma > 0` gate is what keeps an unauthored world's seeded rng stream bit-identical.
        const sigma = wire?.sigma ?? 0
        const m = sigma > 0 ? sampleSizeMultiplier(sigma, s.rng) : 1
        const req = row.rps * reqBytes * m * stepSec
        const resp = row.rps * respBytes * m * stepSec
        addNicBytes(nic, resp, req)   // caller: response in, request out
        const toId = row.toInstanceId
        const toNic = toId != null ? nicByServer[compiled.instances[toId]?.serverId ?? ''] : undefined
        if (toNic) addNicBytes(toNic, req, resp)   // callee: request in, response out
      }
    }

    // ── 8. breaker record + transition ──
    // Audit ISSUE-001: a down/erroring/CPU-shedding downstream INSTANCE produces a non-blocked
    // caller row (its subtree is zeroed at the target instead), so recording `row.blocked` as
    // the outcome logged successes while 100% of the calls failed — the breaker never opened.
    // Feed the target's observed error fraction (errorRps / offeredRps, fully aggregated across
    // all callers by the time the solver returns) instead; hard-blocked rows stay fraction 1.
    const targetErrorFraction = (iid: InstanceId): number => {
      const tf = flows[iid]
      if (!tf || tf.offeredRps <= 1e-9) return 0
      return Math.min(1, tf.errorRps / tf.offeredRps)
    }
    for (const f of Object.values(flows)) {
      for (const row of f.downstream) {
        if (row.rps <= 0) continue
        const key = pathKey(f.instanceId, row.dependencyId)
        const b = getBreaker(s.breakers, key)
        const from = b.state
        // Audit ISSUE-002: an event-protocol dependency is asynchronous — the CONSUMER's own
        // downstream health must never feed the PRODUCER's breaker (that's the exact bug this
        // issue fixes: a struggling consumer used to open the producer's breaker, the opposite of
        // what decoupling is for). An accepted (non-blocked) event row is therefore always a
        // success here; only the topic's OWN drop/DLQ overflow — already recorded as separate
        // `blocked: true` rows above — can open this breaker.
        const dep = s.depById[row.dependencyId]
        const isEventDep = dep && (resolveMixProtocol(doc.packets, dep.packetMix) ?? dep.protocol) === 'event'
        const fraction = row.blocked ? 1 : (isEventDep || !row.toInstanceId) ? 0 : targetErrorFraction(row.toInstanceId)
        // Audit ISSUE-015: record REQUEST COUNTS (rps × stepSec), not rates — the breaker's
        // time-bucketed window weighs a 10 000-rps dependency 10 000× a 1-rps one, and its
        // volume floor (minTotalToOpen) gets real request units.
        recordWeighted(b, row.rps * fraction * stepSec, row.rps * stepSec, simMs)
        transition(b, simMs)
        emitBreakerTransition(from, b.state, [f.instanceId, row.toInstanceId ?? row.toManagedServiceId ?? ''], simMs)
      }
    }

    // ── 9. failover / health propagation ──
    const serverAgg = new Map<ServerId, { offered: number; errors: number }>()
    for (const f of Object.values(flows)) {
      const inst = compiled.instances[f.instanceId]
      if (!inst) continue
      // A down instance errors BY DEFINITION — its flows say nothing about whether the scope
      // has recovered; counting them re-enters the health system's own output as input (the
      // same deadlock shape as probing checkFailed: dependency traffic kept spraying a down
      // AZ's instances, err/offered stayed pinned at 1.0, and the AZ could never come back).
      // Genuine capacity/oom errors on instances that are still up continue to count.
      if (healthOfInstance(f.instanceId) === 'down') continue
      const agg = serverAgg.get(inst.serverId) ?? { offered: 0, errors: 0 }
      agg.offered += f.offeredRps
      agg.errors += f.errorRps + f.refusedRps
      serverAgg.set(inst.serverId, agg)
    }
    // Overload pressure for the HEALTH signal, from THIS step's OFFERED load (not the
    // admitted-based hostResults.cpuPressure, which is capped at capacity so it can never exceed
    // ~1.0 — an overwhelmed server would otherwise only ever read cpuPressure ≈ 1 and never trip
    // the CPU-pressure health band). Capacity/latency/VPS paths keep the admitted-based pressure;
    // only the health input uses this offered-based one.
    const overloadPressureByServer = new Map<ServerId, number>()
    for (const server of Object.values(doc.servers)) {
      const resident = s.instancesByServer.get(server.id) ?? []
      let offeredCores = 0
      for (const i of resident) {
        const offered = flows[i.id]?.offeredRps ?? 0
        if (offered <= 0) continue
        offeredCores += (offered * effectiveCpuMs(i.id, doc.blueprints[i.blueprintId])) / 1000
      }
      const effVcpu = Math.max(0.0001, server.specs.vcpu * (s.vpsFactor.get(server.id) ?? 1))
      overloadPressureByServer.set(server.id, offeredCores / effVcpu)
    }
    const overload = (serverId: ServerId): number => overloadPressureByServer.get(serverId) ?? 0
    // Health inputs need a minimum traffic signal: after failover drains a scope, the flow
    // solver's smoothing leaves an exponentially-decaying residual that never quite reaches
    // zero — and errors/offered on that vanishing residual stays pinned at 1.0, holding the
    // scope's instant health at 'down' forever (the region-never-recovers bug's second half).
    // Below half a request/sec there is no meaningful error signal.
    const rate = (a?: { offered: number; errors: number }): number =>
      (a && a.offered > MIN_HEALTH_SIGNAL_RPS ? a.errors / a.offered : 0)
    for (const server of Object.values(doc.servers)) {
      applyHealth('server', server.id, {
        errorRate: rate(serverAgg.get(server.id)),
        cpuPressure: overload(server.id),
        checkFailed: false,
        manualDown: hasOutage(s.failover, 'server', server.id),
      }, simMs)
    }
    // Audit ISSUE-032: AZ/region rollups read the start()-built serversByAz/azsByRegion indexes —
    // per-step filters over doc.servers/doc.azs made this stage O(regions × azs × servers).
    for (const az of Object.values(doc.azs)) {
      const srv = s.serversByAz.get(az.id) ?? []
      const offered = srv.reduce((n, v) => n + (serverAgg.get(v.id)?.offered ?? 0), 0)
      const errors = srv.reduce((n, v) => n + (serverAgg.get(v.id)?.errors ?? 0), 0)
      const cpu = srv.reduce((m, v) => Math.max(m, overload(v.id)), 0)
      applyHealth('az', az.id, { errorRate: offered > MIN_HEALTH_SIGNAL_RPS ? errors / offered : 0, cpuPressure: cpu, checkFailed: checkFailedById.get(az.id) ?? false, manualDown: hasOutage(s.failover, 'az', az.id) }, simMs)
    }
    for (const region of Object.values(doc.regions)) {
      const srv = (s.azsByRegion.get(region.id) ?? []).flatMap(a => s.serversByAz.get(a.id) ?? [])
      const offered = srv.reduce((n, v) => n + (serverAgg.get(v.id)?.offered ?? 0), 0)
      const errors = srv.reduce((n, v) => n + (serverAgg.get(v.id)?.errors ?? 0), 0)
      const cpu = srv.reduce((m, v) => Math.max(m, overload(v.id)), 0)
      // NOTE: undeliverable (dropped) traffic is deliberately NOT folded into the FAILOVER region
      // health here — that state cascades onto every instance in the region (healthOfInstance =
      // worst scope) and would wrongly fail/throttle healthy backends when the LB config drops
      // traffic elsewhere. Dropped is surfaced in the region's DISPLAYED error/health instead
      // (metrics.ts buildBatch), which the routing/cascade path never reads.
      applyHealth('region', region.id, { errorRate: offered > MIN_HEALTH_SIGNAL_RPS ? errors / offered : 0, cpuPressure: cpu, checkFailed: checkFailedById.get(region.id) ?? false, manualDown: hasOutage(s.failover, 'region', region.id) }, simMs)
    }
    // Failback BEFORE promotion (audit ISSUE-007): a recovered authored primary reclaims its role
    // (clearing the overlay) so this step's promotion pass sees the true current primaries. The
    // health hysteresis' 5s recovery lock has already debounced the primary's recovery.
    for (const e of failbackPromotions(s.failover, compiled, doc, healthOfInstance, simMs)) emitEvent(e)
    const downInstances = Object.values(compiled.instances).filter(i => healthOfInstance(i.id) === 'down').map(i => i.id)
    // FEAT-005 (Task 13): per-instance write-rps for the RPO payload — approximated by giving
    // every replica in a cluster that cluster's TOTAL resolved write rps this step
    // (writeRpsByCluster, threaded straight out of solveFlows above), since Task 11's design
    // already treats a cluster's write stream as shared rather than partitioned per replica.
    // Built alongside s.replicasByCluster in one pass, not as a second computation.
    let writeRpsByReplicaInstance: Map<InstanceId, number> | undefined
    if (s.hasAnyReplicas) {
      writeRpsByReplicaInstance = new Map()
      for (const [clusterId, replicas] of Object.entries(s.replicasByCluster)) {
        const writeRps = writeRpsByCluster[clusterId] ?? 0
        for (const r of replicas) writeRpsByReplicaInstance.set(r.id, writeRps)
      }
    }
    for (const e of promoteReplicas(
      s.failover, compiled, doc, downInstances, simMs, healthOfInstance,
      s.replication.lagSecByInstance, writeRpsByReplicaInstance,
    )) emitEvent(e)

    // FEAT-002 Task 12: cross-region split-brain. promoteReplicas (failover.ts) only ever picks a
    // sibling replica in the SAME region as the down primary (spec decision 7's same-region HA
    // model) — a replica placed in a DIFFERENT region than every authored primary of its
    // blueprint is structurally invisible to it. This is the ONLY path such a replica can ever
    // take over: if its OWN region cannot (directionally) reach ANY region hosting an authored
    // primary for its blueprint, it unilaterally promotes itself — the textbook split-brain
    // failure mode, since the primary's own region (still able to reach itself) never demotes it.
    // Deliberately independent of promoteReplicas' same-region sibling selection above — it does
    // not touch that logic or its semantics, only adds a second, narrower promotion path for the
    // case that logic can never reach.
    //
    // Audit final-review C1/I4: restricted to s.crossRegionOrphanReplicaIds (built once at
    // start()) — replicas that have NO same-region authored primary sibling, i.e. genuinely
    // invisible to promoteReplicas. A replica that ALSO has a same-region primary (promoteReplicas'
    // own cluster) is excluded structurally, not just skipped here, so it can never reach this
    // block's promote/failback bookkeeping regardless of partition state. Ownership of the
    // promotion is tracked in the DEDICATED s.failover.isolationPromotedAt set — never
    // promotedAt's `alreadyPromoted` alone — so this block only ever fails back a placement IT
    // promoted, never one promoteReplicas promoted for an unrelated same-region cluster (the exact
    // flap the previous version produced: 200 replica_promoted + 200 primary_failback events over
    // 20s on a same-region-primary + same-region-replica + separate-region-primary topology, with
    // ZERO partitions active). The set is still written into the shared promotedAt map so
    // effectiveRoleResolver's routing overlay sees it — safe because failbackPromotions (same-
    // region cluster keyed) finds zero authored primaries for an orphan's blueprint+region and
    // no-ops on it, by the same eligibility guard.
    if (s.crossRegionOrphanReplicaIds.size > 0) {
      for (const instId of s.crossRegionOrphanReplicaIds) {
        const inst = compiled.instances[instId]
        if (!inst) continue   // defensive: instance ids are stable for a run, but guard anyway
        const crossRegionPrimaries = Object.values(compiled.instances).filter(
          p => p.role === 'primary' && p.blueprintId === inst.blueprintId && p.regionId !== inst.regionId,
        )
        if (crossRegionPrimaries.length === 0) continue   // defensive: precompute guarantees this is non-empty
        const isolated = crossRegionPrimaries.every(p => regionSeesRegionDown(inst.regionId, p.regionId))
        const alreadyPromoted = s.failover.isolationPromotedAt.has(inst.placementId)
        if (isolated && !alreadyPromoted) {
          s.failover.isolationPromotedAt.set(inst.placementId, simMs)
          s.failover.promotedAt.set(inst.placementId, simMs)
          const bpName = doc.blueprints[inst.blueprintId]?.name ?? inst.blueprintId
          emitEvent({
            id: `split-brain-promote-${inst.id}-${simMs}`, simMs, kind: 'replica_promoted', severity: 'critical',
            message: `${bpName} replica ${inst.id} unilaterally promoted — its region lost reachability to every primary (partition isolation)`,
            affected: [inst.id, ...crossRegionPrimaries.map(p => p.id)],
          })
        } else if (!isolated && alreadyPromoted) {
          s.failover.isolationPromotedAt.delete(inst.placementId)
          s.failover.promotedAt.delete(inst.placementId)
          const bpName = doc.blueprints[inst.blueprintId]?.name ?? inst.blueprintId
          emitEvent({
            id: `split-brain-failback-${inst.id}-${simMs}`, simMs, kind: 'primary_failback', severity: 'info',
            message: `${bpName} reachability restored — ${inst.id} failed back from its isolation promotion`,
            affected: [inst.id, ...crossRegionPrimaries.map(p => p.id)],
          })
        }
      }
    }
    // Phase 5.4: a multi-AZ managed DB promotes its standby and clears its own SIMULATED outage
    // once the failover window elapses; a single-AZ one stays down until its AZ recovers, and a
    // manual operator outage stays down until explicitly resumed (audit ISSUE-008).
    for (const e of recoverMultiAzManagedDbs(s.failover, doc, simMs)) emitEvent(e)

    // rate-limited connection_refused (blocked/breaker attempts are live failures, spec D6)
    for (const f of Object.values(flows)) {
      for (const row of f.downstream) {
        if (!row.blocked) continue
        const key = pathKey(f.instanceId, row.dependencyId)
        const last = s.refusedRateLimit.get(key) ?? -Infinity
        if (simMs - last >= REFUSED_EVENT_MIN_GAP_MS) {
          s.refusedRateLimit.set(key, simMs)
          emit('connection_refused', 'warning', `${f.instanceId} refused on ${row.dependencyId}`, [f.instanceId, row.toInstanceId ?? row.toManagedServiceId ?? ''], simMs)
        }
      }
    }

    // ── 10. metrics accumulate ──
    accumulateStep(s.metrics, flows, hostResults, vpsPublish, nicByServer, healthOfAny, simMs, managedDbRt, droppedByAz, topicRt)
    // NIC settlement (audit ISSUE-002) — AFTER accumulate (which reads the per-step byte
    // counters settleNic resets). The result gates next step's admits/latency, one-step lag.
    for (const server of Object.values(doc.servers)) {
      const nic = s.nics.get(server.id)
      if (!nic) continue
      const settled = settleNic(nic, server, stepMs)
      s.nicDeliveredFraction.set(server.id, settled.deliveredFraction)
      s.nicQueuedLatencyMs.set(server.id, settled.queuedLatencyMs)
    }
    s.windowTotals.crossAzBytes += totals.crossAzBytes * stepSec
    s.windowTotals.crossRegionBytes += totals.crossRegionBytes * stepSec
    s.windowTotals.internetBytes += totals.internetBytes * stepSec
    for (const [msId, bytes] of Object.entries(totals.managedEgressBytes)) {
      s.windowTotals.managedEgressBytes[msId] = (s.windowTotals.managedEgressBytes[msId] ?? 0) + bytes * stepSec
    }
    s.prevFlows = flows

    // ── 11. 1 Hz batch + replay + trace ──
    if (simMs - s.lastBatchMs >= 1000) {
      s.lastBatchMs = simMs
      // Starved detection (audit ISSUE-014): BFS the permitted downstream adjacency from the
      // down set — a non-down instance reached with no offered traffic this step is STARVED
      // (silent because an upstream died), not idle, and publishes 'degraded' instead of a
      // healthy zero. Presentation-only: it never feeds back into the failover inputs (the
      // probe-the-output deadlock shape this engine has been burned by before).
      const starved = new Set<InstanceId>()
      const stack = Object.values(compiled.instances)
        .filter(i => healthOfInstance(i.id) === 'down')
        .map(i => i.id)
      const visited = new Set(stack)
      while (stack.length > 0) {
        const id = stack.pop()!
        for (const next of s.downstreamAdj.get(id) ?? []) {
          if (visited.has(next)) continue
          visited.add(next)
          if (healthOfInstance(next) === 'down') {
            stack.push(next)
          } else if ((flows[next]?.offeredRps ?? 0) <= MIN_HEALTH_SIGNAL_RPS) {
            starved.add(next)
            stack.push(next)   // its own downstream is starved too
          }
        }
      }
      // connProfileByInstance is THIS step's blend — the published connection count must be
      // computed from the same profile the host scheduler just enforced RAM against.
      // effectiveCpuMsByInstance is the SAME map fed to the host scheduler's InstanceLoad above,
      // so published cpuCoresUsed reflects the CPU the scheduler actually enforced (ISSUE-011).
      // s.faults.leakAccumMb is the SAME map InstanceLoad.ramBaseMb already folded in above, so
      // published ramMb can never diverge from the RAM the scheduler enforces/OOM-kills on
      // (FEAT-001, mirrors the connProfileByInstance/effectiveCpuMsByInstance discipline).
      // roleOf (FEAT-002/Wave-1 Task 13 fix): the SAME memoized effective-role resolver built
      // above (§6, promoKey-memoized) for flow routing — publishing it lets split-brain-risk see
      // a LIVE partition-induced promotion, not just the static authored role.
      // replicasByCluster/s.replication.lagSecByInstance (FEAT-005, Task 12): the SAME static
      // topology + live lag map the step loop above already reads to build
      // staleReadFractionByReplica for THIS step's solveFlows call — publishing MetricsBatch.
      // clusters from them (never re-derived) is the divergence guard this file's other additive
      // fields already apply.
      // s.warmingUntil (FEAT-007, Task 6): the SAME map the capacity throttle (Task 4) and latency
      // throttle (Task 5) above already read via hostScheduler.ts's warmthOf — publishing
      // InstanceMetrics.warmth/degraded-health from it (never re-derived) is that same divergence
      // guard applied to warm-up.
      const batch = buildBatch(s.metrics, doc, compiled, s.lastRoutingSnapshot, { ...s.windowTotals }, simMs, starved, connProfileByInstance, effectiveCpuMsByInstance, s.faults.leakAccumMb, s.faults.active.size, roleOf, s.warmSinceMs, s.replicasByCluster, s.replication.lagSecByInstance, s.warmingUntil)
      s.callbacks.onMetrics(batch)
      s.replay.push({ simMs, batch, events: s.events.drain() })
      s.tracer.sample(flows, compiled, doc, simMs, entryId => populationsForEntry(entryId), managedDbRt)
      s.windowTotals = { crossAzBytes: 0, crossRegionBytes: 0, internetBytes: 0, managedEgressBytes: {} }
    }
  }

  // EVERY population currently feeding a given entry instance's region, with live rps (audit
  // ISSUE-039). The tracer draws the trace's populationId ∝ these — the old first-match lookup
  // credited every trace to whichever population happened to appear first in the snapshot.
  const populationsForEntry = (entryInstanceId: InstanceId): { populationId: PopulationId; rps: number }[] => {
    const inst = state!.compiled.instances[entryInstanceId]
    if (!inst) return []
    return state!.lastRoutingSnapshot.populationRoutes.filter(r => r.regionId === inst.regionId)
  }

  // Advance the fixed-step clock by a real frame and run every whole step it produced.
  function runFrame(frameMs: number): void {
    const s = state!
    const steps = s.clock.advance(frameMs, s.timeScale)
    if (steps === 0) return
    const endMs = s.clock.simMs
    for (let i = steps; i >= 1; i--) {
      const stepSimMs = endMs - (i - 1) * s.stepMs
      const t0 = perfNow()
      runStep(stepSimMs)
      recordStepCost(perfNow() - t0, stepSimMs)
    }
  }

  function recordStepCost(costMs: number, simMs: number): void {
    const s = state!
    s.stepCosts.push(costMs)
    if (s.stepCosts.length > DEGRADE_WINDOW_STEPS) s.stepCosts.shift()
    if (!s.degraded && s.stepCosts.length >= DEGRADE_WINDOW_STEPS) {
      const mean = s.stepCosts.reduce((a, b) => a + b, 0) / s.stepCosts.length
      if (mean > DEGRADE_THRESHOLD_MS) {
        s.degraded = true
        s.stepMs = DEGRADED_STEP_MS
        // Swapping stepMs requires a fresh ClockHandle (its stepMs is fixed at construction),
        // but a new clock starts at simMs 0 — carry the elapsed time forward so OOM-restart
        // timers, DNS TTL caches, health hysteresis and breaker resetMs (all absolute-simMs
        // comparisons) don't see time jump backward.
        const carryMs = s.clock.simMs
        s.clock = createClock(DEGRADED_STEP_MS)
        s.clock.advance(carryMs, 1)
        emit('engine_degraded', 'info', `engine degraded: mean step ${mean.toFixed(1)}ms > ${DEGRADE_THRESHOLD_MS}ms — halving step rate to ${DEGRADED_STEP_MS}ms`, [], simMs)
      }
    }
  }

  // ── Render payloads (per animation frame, cap-enforced) ──
  function buildPayload(scope: RenderScope, wallMs: number): FramePayload {
    const s = state!
    const simMs = s.clock.simMs
    if (scope.level === 'globe') return { simMs, particles: EMPTY_PARTICLES, arcs: buildArcs() }
    if (scope.level === 'az') return { simMs, particles: buildAzParticles(scope.azId, wallMs), arcs: EMPTY_ARCS }
    if (scope.level === 'server') return { simMs, particles: buildServerParticles(scope.serverId, wallMs), arcs: EMPTY_ARCS }
    // region rich particle surface arrives in Phase 4; ships empty-but-valid until then.
    return { simMs, particles: EMPTY_PARTICLES, arcs: EMPTY_ARCS }
  }

  // Phase 5 (D4): client arcs first, byte-identical to Phase-2's original buildArcs, then
  // inter-region (cross-region dependency flows aggregated by region pair), then drain
  // (pending-failover / stuck-on-a-down-region populations). Total capped at MAX_GLOBE_ARCS,
  // truncating in that order — client arcs are never displaced.
  function buildArcs(): VisualArc[] {
    const arcs = buildClientArcs()
    if (arcs.length < MAX_GLOBE_ARCS) arcs.push(...buildInterRegionArcs(MAX_GLOBE_ARCS - arcs.length))
    if (arcs.length < MAX_GLOBE_ARCS) arcs.push(...buildDrainArcs(MAX_GLOBE_ARCS - arcs.length))
    return arcs
  }

  // Unchanged from Phase 2 (renamed from buildArcs) — body byte-identical.
  function buildClientArcs(): VisualArc[] {
    const s = state!
    const routes = s.lastRoutingSnapshot.populationRoutes
    const maxRps = Math.max(1, ...routes.map(r => r.rps))
    const arcs: VisualArc[] = []
    for (const r of routes) {
      const pop = s.doc.populations[r.populationId]
      const region = s.doc.regions[r.regionId]
      const geo = region ? REGION_GEO_LOCAL[region.catalogId] : undefined
      if (!pop || !geo) continue
      arcs.push({ fromLatLon: [pop.lat, pop.lon], toLatLon: [geo.lat, geo.lon], intensity: Math.min(1, r.rps / maxRps), kind: 'client' })
      if (arcs.length >= MAX_GLOBE_ARCS) break
    }
    return arcs
  }

  // One arc per (fromRegionId, toRegionId) pair, aggregated over this step's downstream flow
  // rows whose caller and target instances sit in different regions. Managed-service targets
  // (toManagedServiceId) have no instance region and are skipped — they aren't cross-region
  // client-visible flows. intensity = pairRps / maxPairRps, floored at 0.15 so a faint
  // cross-region link stays visible against a dominant one.
  function buildInterRegionArcs(budget: number): VisualArc[] {
    if (budget <= 0) return []
    const s = state!
    const pairs = new Map<string, { fromRegionId: RegionId; toRegionId: RegionId; rps: number }>()
    for (const flow of Object.values(s.prevFlows)) {
      const from = s.compiled.instances[flow.instanceId]
      if (!from) continue
      for (const row of flow.downstream) {
        if (!row.toInstanceId || row.rps <= 0) continue
        const to = s.compiled.instances[row.toInstanceId]
        if (!to || to.regionId === from.regionId) continue
        const key = `${from.regionId}->${to.regionId}`
        const entry = pairs.get(key)
        if (entry) entry.rps += row.rps
        else pairs.set(key, { fromRegionId: from.regionId, toRegionId: to.regionId, rps: row.rps })
      }
    }
    if (pairs.size === 0) return []
    const maxPairRps = Math.max(...[...pairs.values()].map(p => p.rps))
    const arcs: VisualArc[] = []
    for (const { fromRegionId, toRegionId, rps } of pairs.values()) {
      const fromGeo = REGION_GEO_LOCAL[s.doc.regions[fromRegionId]?.catalogId ?? '']
      const toGeo = REGION_GEO_LOCAL[s.doc.regions[toRegionId]?.catalogId ?? '']
      if (!fromGeo || !toGeo) continue
      const intensity = Math.max(0.15, Math.min(1, rps / maxPairRps))
      arcs.push({ fromLatLon: [fromGeo.lat, fromGeo.lon], toLatLon: [toGeo.lat, toGeo.lon], intensity, kind: 'inter-region' })
      if (arcs.length >= budget) break
    }
    return arcs
  }

  // (a) one arc per population in s.pendingFailover: from the PREVIOUS region (captured in
  // s.popPrevRegion when the switch happened — see the routing block in runStep) to the newly
  // resolved one; falls back to the population's own lat/lon when the previous region isn't
  // resolvable (defensive; popPrevRegion is set in the same step pendingFailover is). (b) one
  // arc per population still routed (this step's populationRoutes) to a region whose health is
  // 'down' — the DNS-TTL lag window where clients keep arriving at a dead region. Both kinds
  // render intensity 1 (a drain arc is binary — happening or not).
  function buildDrainArcs(budget: number): VisualArc[] {
    if (budget <= 0) return []
    const s = state!
    const arcs: VisualArc[] = []
    const geoOfRegion = (regionId: RegionId): [number, number] | null => {
      const region = s.doc.regions[regionId]
      const geo = region ? REGION_GEO_LOCAL[region.catalogId] : undefined
      return geo ? [geo.lat, geo.lon] : null
    }

    for (const [popId, newRegionId] of s.pendingFailover) {
      const pop = s.doc.populations[popId]
      const toGeo = geoOfRegion(newRegionId)
      if (!pop || !toGeo) continue
      const prevRegionId = s.popPrevRegion.get(popId)
      const fromGeo: [number, number] = (prevRegionId ? geoOfRegion(prevRegionId) : null) ?? [pop.lat, pop.lon]
      arcs.push({ fromLatLon: fromGeo, toLatLon: toGeo, intensity: 1, kind: 'drain' })
      if (arcs.length >= budget) return arcs
    }

    for (const r of s.lastRoutingSnapshot.populationRoutes) {
      if (healthOfScope(r.regionId) !== 'down') continue
      const pop = s.doc.populations[r.populationId]
      const toGeo = geoOfRegion(r.regionId)
      if (!pop || !toGeo) continue
      arcs.push({ fromLatLon: [pop.lat, pop.lon], toLatLon: toGeo, intensity: 1, kind: 'drain' })
      if (arcs.length >= budget) return arcs
    }

    return arcs
  }

  function buildAzParticles(azId: AzId, wallMs: number): VisualParticle[] {
    const s = state!
    const phase = (wallMs * RENDER_PROGRESS_PER_MS)
    const particles: VisualParticle[] = []
    let pid = 0
    const drain = s.failover.drainUntil.has(azId) ? drainFactor(s.failover, azId, s.clock.simMs) : 1
    for (const f of Object.values(s.prevFlows)) {
      if (particles.length >= MAX_AZ_PARTICLES) break   // audit ISSUE-015: stop once the cap is hit
      const from = s.compiled.instances[f.instanceId]
      if (!from || from.azId !== azId) continue
      const bp = s.doc.blueprints[from.blueprintId]
      const isEntry = s.entryBlueprintIds.has(from.blueprintId)
      // entry ingress particles from the client edge
      if (isEntry && f.offeredRps > 0) {
        const n = Math.min(MAX_AZ_PARTICLES, Math.round((f.offeredRps / PARTICLE_RATIO) * drain))
        for (let k = 0; k < n && particles.length < MAX_AZ_PARTICLES; k++) {
          particles.push({ id: pid++, fromId: 'edge:client', toId: from.serverId, progress: frac(phase + k * 0.137), protocol: 'http', blocked: false, colorHint: bp?.color ?? null, packetId: null })
        }
      }
      for (const row of f.downstream) {
        if (particles.length >= MAX_AZ_PARTICLES) break   // audit ISSUE-015
        const toId = row.toInstanceId ? s.compiled.instances[row.toInstanceId]?.serverId : row.toManagedServiceId
        if (!toId) continue
        // audit ISSUE-014: s.depById is a start()-time index, not a per-row `.find()` scan.
        const dep = s.depById[row.dependencyId]
        const n = Math.min(MAX_AZ_PARTICLES, Math.max(row.blocked ? 1 : 0, Math.round(row.rps / PARTICLE_RATIO)))
        // audit ISSUE-013: precomputed pick table, not a per-particle filter+reduce over the mix.
        const pickTable = s.depPickTableById[row.dependencyId] ?? null
        for (let k = 0; k < n && particles.length < MAX_AZ_PARTICLES; k++) {
          const packetId = pickPacketByIndex(pickTable, k)
          particles.push({ id: pid++, fromId: from.serverId, toId, progress: frac(phase + k * 0.191), protocol: dep?.protocol ?? 'http', blocked: row.blocked, colorHint: packetColor(packetId) ?? bp?.color ?? null, packetId })
        }
      }
    }
    return particles
  }

  // A bound packet's own tint, when it has one. Falls through to null so the caller keeps its
  // existing blueprint-color behavior — an authored colorOverride is the ONLY thing that changes
  // a particle's hue, so an unauthored world renders exactly as before.
  function packetColor(packetId: number | null): string | null {
    if (packetId == null) return null
    return state!.doc.packets.templates[packetId]?.colorOverride ?? null
  }

  // Server-scope particles (D3): every off-server endpoint collapses to the NIC; the view routes
  // nic-originated traffic through the firewall gate. Mirrors buildAzParticles' sampling/phase.
  function buildServerParticles(serverId: ServerId, wallMs: number): VisualParticle[] {
    const s = state!
    const phase = wallMs * RENDER_PROGRESS_PER_MS
    const particles: VisualParticle[] = []
    let pid = 0
    const nicId = `nic:${serverId}`
    for (const f of Object.values(s.prevFlows)) {
      if (particles.length >= MAX_SERVER_PARTICLES) break   // audit ISSUE-015
      const from = s.compiled.instances[f.instanceId]
      if (!from || from.serverId !== serverId) continue
      const fromBp = s.doc.blueprints[from.blueprintId]
      const isEntry = s.entryBlueprintIds.has(from.blueprintId)
      // inbound entry: nic -> receiving instance; colorHint = the receiving service's hue
      if (isEntry && f.offeredRps > 0) {
        const n = Math.min(MAX_SERVER_PARTICLES, Math.round(f.offeredRps / PARTICLE_RATIO))
        for (let k = 0; k < n && particles.length < MAX_SERVER_PARTICLES; k++) {
          particles.push({ id: pid++, fromId: nicId, toId: from.id, progress: frac(phase + k * 0.137), protocol: 'http', blocked: false, colorHint: fromBp?.color ?? null, packetId: null })
        }
      }
      for (const row of f.downstream) {
        if (particles.length >= MAX_SERVER_PARTICLES) break   // audit ISSUE-015
        const target = row.toInstanceId ? s.compiled.instances[row.toInstanceId] : undefined
        const resident = !!target && target.serverId === serverId
        const toId = resident ? target!.id : nicId          // off-server/managed -> nic
        // audit ISSUE-014: s.depById is a start()-time index, not a per-row `.find()` scan.
        const dep = s.depById[row.dependencyId]
        // intra: receiving service's hue; instance->nic outbound: the sending service's hue
        const colorHint = resident ? (s.doc.blueprints[target!.blueprintId]?.color ?? null) : (fromBp?.color ?? null)
        const n = Math.min(MAX_SERVER_PARTICLES, Math.max(row.blocked ? 1 : 0, Math.round(row.rps / PARTICLE_RATIO)))
        // audit ISSUE-013: precomputed pick table, not a per-particle filter+reduce over the mix.
        const pickTable = s.depPickTableById[row.dependencyId] ?? null
        for (let k = 0; k < n && particles.length < MAX_SERVER_PARTICLES; k++) {
          const packetId = pickPacketByIndex(pickTable, k)
          particles.push({ id: pid++, fromId: from.id, toId, progress: frac(phase + k * 0.191), protocol: dep?.protocol ?? 'http', blocked: row.blocked, colorHint: packetColor(packetId) ?? colorHint, packetId })
        }
      }
    }
    return particles
  }

  function renderAll(wallMs: number): void {
    const s = state!
    for (const { scope, onFrame } of s.renderers.values()) onFrame(buildPayload(scope, wallMs))
  }

  function tick(nowMs: number): void {
    const s = state
    if (!s || !s.running) return
    const frameMs = s.lastFrameMs === null ? s.stepMs : Math.min(250, nowMs - s.lastFrameMs)
    s.lastFrameMs = nowMs
    runFrame(frameMs)
    renderAll(nowMs)
    if (typeof requestAnimationFrame === 'function') s.rafId = requestAnimationFrame(tick)
  }

  const api: WorldEngineApi & {
  __test_step: (steps?: number) => void
  __test_render: (wallMs?: number) => void
  // FEAT-005 (Task 11): test-only accessor for a replica instance's current replication lag — the
  // brief's own escape hatch ("directly inspectable via a test-only engine accessor") in place of
  // Task 12's not-yet-built MetricsBatch.clusters publishing surface.
  __test_replicationLagSec: (instanceId: string) => number | undefined
} = {
    start(doc, compiled, callbacks) {
      // Defense against double-start (audit ISSUE-048): cancel any live rAF chain BEFORE the
      // state swap — otherwise the old chain reads the module-level `state`, sees the new run's
      // running=true, and keeps scheduling: two chains advancing one state at double speed.
      if (state?.rafId != null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(state.rafId)
      }
      const depIndexes = buildDepIndexes(doc)
      const replicationIndexes = buildReplicationIndexes(doc, compiled)
      // FEAT-003: doc.scenario.seed OVERRIDES the engine's default seed source (the `seed` param
      // createWorldEngine was constructed with) rather than creating a second, independent rng
      // instance — every stochastic draw in the run (demand, tracer sampling, etc.) must come from
      // ONE seeded source for the determinism guarantee to hold. Absent a scenario, behavior is
      // byte-identical to pre-feature.
      const effectiveSeed = doc.scenario?.seed ?? seed
      state = {
        running: true, seed: effectiveSeed, rng: createRng(effectiveSeed), clock: createClock(DEFAULT_STEP_MS), stepMs: DEFAULT_STEP_MS,
        timeScale: 1, doc, compiled, callbacks, entryBlueprintIds: new Set(entryBlueprints(doc)),
        routePathById: buildRoutePathById(doc),
        routeBytesById: buildRouteBytesById(doc),
        routeConnById: buildRouteConnProfiles(doc),
        depBytesById: buildDepWireBytes(doc),
        depConnById: buildDepConnProfiles(doc),
        depById: depIndexes.depById,
        depPickTableById: depIndexes.depPickTableById,
        serversByAz: groupBy(Object.values(doc.servers), sv => sv.azId),
        azsByRegion: groupBy(Object.values(doc.azs), az => az.regionId),
        azOfServer: new Map(Object.values(doc.servers).map(sv => [sv.id, sv.azId])),
        regionOfAz: new Map(Object.values(doc.azs).map(az => [az.id, az.regionId])),
        instancesByServer: groupInstancesByServer(compiled),
        hasManagedDbs: Object.values(doc.managedServices).some(ms => !!managedDbEngine(ms.nodeType)),
        hasEventDeps: Object.values(doc.blueprints).some(bp =>
          bp.dependencies.some(dep => (resolveMixProtocol(doc.packets, dep.packetMix) ?? dep.protocol) === 'event')),
        topicBacklog: new Map(),
        regionShedFraction: new Map(), regionOverloadStreak: new Map(), regionRecoverStreak: new Map(),
        roleResolver: null, roleResolverKey: '',
        downstreamAdj: buildDownstreamAdj(compiled),
        crossRegionOrphanReplicaIds: buildCrossRegionOrphanReplicaIds(compiled),
        // FEAT-004 (Task 3): every cache starts warm (empty map — the regression floor), and
        // hasAnyCache is computed once so an unconfigured world's runStep never touches the cache
        // path at all.
        warmSinceMs: new Map(),
        // FEAT-004 (Task 5): no cold cycle in flight at start(), so nothing to guard yet.
        warmEmitted: new Set(),
        // FEAT-007 (Task 3): every instance starts warm (empty map — the regression floor).
        warmingUntil: new Map(),
        hasAnyCache: Object.values(doc.blueprints).some(bp => bp.cacheConfig != null)
          || Object.values(doc.managedServices).some(ms => ms.cacheConfig != null),
        cacheAsideIndexByDepId: buildCacheAsideIndex(doc, compiled),
        // FEAT-005 (Task 11): static replica topology + its per-cluster DbConfig, resolved once
        // here; hasAnyReplicas gates the per-step replication work below the same way hasAnyCache
        // gates the cache path.
        replicasByCluster: replicationIndexes.replicasByCluster,
        dbConfigByCluster: replicationIndexes.dbConfigByCluster,
        semiSyncExtraMsByInstance: replicationIndexes.semiSyncExtraMsByInstance,
        hasAnyReplicas: Object.keys(replicationIndexes.replicasByCluster).length > 0,
        // Audit final-review finding: hasAnyCache/hasAnyReplicas precedent applied to FEAT-006 —
        // matches diskWaitFor/resolveDiskIopsCeiling's own diskIops-or-diskType "authored" test, so
        // a world where every server carries Task 17's default diskType (the now-common case)
        // correctly counts as configured; only a world with NEITHER authored anywhere pays zero
        // per-step disk cost.
        hasAnyDisk: Object.values(doc.servers).some(sv => sv.specs.diskIops != null || sv.specs.diskType != null),
        blueprintIdByInstance: new Map(Object.values(compiled.instances).map(i => [i.id, i.blueprintId])),
        // FEAT-008 (Task 13): desiredCount seeded to minCount for every autoscaled placement, to
        // count for every static one (createAutoscaleState's own contract) -- runningSet starts
        // as the "everyone running" fast path and is rebuilt on the very first runStep call below
        // once autoscale.desiredCount is actually read.
        autoscale: createAutoscaleState(doc),
        runningSet: () => true,
        runningSetKey: '',
        // Task 15: empty at start() -- nothing is draining until the first scale-in decision.
        drainUntilByInstance: new Map(),
        hasAnyAutoscale: Object.values(doc.placements).some(pl => pl.autoscale != null),
        replication: createReplicationState(),
        prevWriteRpsByCluster: {},
        routing: createRoutingState(), failover: createFailoverState(), faults: createFaultState(),
        // FEAT-003: steps sorted once by atMs (a stable sort — ScenarioStep carries no secondary
        // ordering key, so authored array order breaks ties among same-atMs steps), cursor at 0.
        scenarioSteps: doc.scenario ? [...doc.scenario.steps].sort((a, b) => a.atMs - b.atMs) : [],
        scenarioCursor: 0,
        demandOverlay: new Map(),
        demandStates: new Map(),
        vpsStates: new Map(Object.values(doc.servers).map(sv => [sv.id, createVpsState(sv)])),
        vpsFactor: new Map(),
        nics: new Map(Object.values(doc.servers).map(sv => [sv.id, createNicState()])),
        nicDeliveredFraction: new Map(), nicQueuedLatencyMs: new Map(),
        breakers: new Map(), queueDepth: new Map(), metrics: createMetricsState(),
        events: createEventRing(500), replay: createReplayBuffer(300), tracer: createTracer(createRng(effectiveSeed ^ 0x1234)),
        prevFlows: {}, windowTotals: { crossAzBytes: 0, crossRegionBytes: 0, internetBytes: 0, managedEgressBytes: {} },
        lastRoutingSnapshot: { populationRoutes: [] }, popRegion: new Map(), pendingFailover: new Map(),
        popPrevRegion: new Map(),
        checkFailedPrev: new Map(), probePrev: new Map(), instanceHealth: new Map(), oomRestartAt: new Map(), refusedRateLimit: new Map(),
        replicationLagRateLimit: new Map(), staleReadRateLimit: new Map(),
        diskSaturatedRateLimit: new Map(),
        depthExceededReported: new Set(), cycleCutReported: new Set(),
        idSeq: 0, lastBatchMs: -1000, stepCosts: [], degraded: false, rafId: null, lastFrameMs: null,
        renderers: new Map(), rendererSeq: 0,
      }
      if (typeof requestAnimationFrame === 'function') state.rafId = requestAnimationFrame(tick)
    },
    stop() {
      if (!state) return
      state.running = false
      if (state.rafId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(state.rafId)
      state.rafId = null
    },
    resume() {
      if (!state || state.running) return
      state.running = true
      // The wall-clock gap while halted must NOT be charged as one giant frame (it would jump the
      // sim forward and spike the step cost) — reset the frame anchor so the next tick is a normal step.
      state.lastFrameMs = null
      if (typeof requestAnimationFrame === 'function') state.rafId = requestAnimationFrame(tick)
    },
    isRunning() {
      return state?.running ?? false
    },
    setTimeScale(scale) {
      if (state) state.timeScale = scale
    },
    setFault(scope, id, spec) {
      if (!state) return
      doSetFault(state, scope, id, spec, state.clock.simMs)
    },
    setOutage(scope, id, down) {
      // Thin alias (contract-drift.md) — new callers should prefer setFault directly.
      api.setFault(scope, id, down ? { kind: 'down' } : null)
    },
    setPartition(fault) {
      if (!state) return
      doSetPartition(state, fault, state.clock.simMs)
    },
    healPartition(id) {
      if (!state) return
      doHealPartition(state, id, state.clock.simMs)
    },
    attachRenderer(scope, onFrame) {
      if (!state) return () => {}
      const key = state.rendererSeq++
      state.renderers.set(key, { scope, onFrame })
      const s = state
      return () => { s.renderers.delete(key) }
    },
    getReplayFrames() {
      return state?.replay.getFrames() ?? []
    },
    getTracedRequests(scope) {
      return state?.tracer.getTraced(scope) ?? []
    },
    __test_step(steps = 1) {
      for (let i = 0; i < steps; i++) runFrame(state!.stepMs)
    },
    __test_render(wallMs = 1) { renderAll(wallMs) },
    __test_replicationLagSec(instanceId) {
      return state?.replication.lagSecByInstance.get(instanceId)
    },
  }
  return api
}

const frac = (x: number): number => x - Math.floor(x)

// Permitted instance→instance edges from the compiled paths (audit ISSUE-014). Blocked paths
// deliver nothing even when healthy, so they don't count as a feed.
function buildDownstreamAdj(compiled: CompiledWorld): Map<InstanceId, InstanceId[]> {
  const adj = new Map<InstanceId, InstanceId[]>()
  for (const p of compiled.paths) {
    if (p.verdict !== 'permitted' || p.to.kind !== 'instance') continue
    const list = adj.get(p.fromInstanceId)
    if (list) list.push(p.to.instanceId)
    else adj.set(p.fromInstanceId, [p.to.instanceId])
  }
  return adj
}

// FEAT-004 (Task 3, Step 6): for every dependency `dep` carrying a `cacheAsideVia` pointing at a
// sibling dependency on the SAME blueprint, resolve that sibling's target cacheConfig + warm-key
// ONCE at start(). A service-blueprint target resolves its warm-key to the first compiled instance
// of that blueprint (today's topologies place a cache-aside sibling as a single instance; a
// multi-instance cache-aside target would need a per-caller resolution this index structurally
// can't offer, same limitation the brief calls out for this shape). A managed target's warm-key is
// `managed:${managedServiceId}` — managed caches never restart cold (Step 4's scope cut), so their
// warmSinceMs entry is permanently absent and effectiveMissFraction reads as always-warm.
function buildCacheAsideIndex(
  doc: WorldDoc,
  compiled: CompiledWorld,
): Map<string, { cacheConfig: CacheConfig; warmKey: string }> {
  const index = new Map<string, { cacheConfig: CacheConfig; warmKey: string }>()
  let firstInstanceByBlueprint: Map<BlueprintId, InstanceId> | null = null
  for (const bp of Object.values(doc.blueprints)) {
    for (const dep of bp.dependencies) {
      if (!dep.cacheAsideVia) continue
      const sibling = bp.dependencies.find(d => d.id === dep.cacheAsideVia)
      if (!sibling) continue
      if (sibling.target.kind === 'blueprint') {
        const targetBp = doc.blueprints[sibling.target.blueprintId]
        if (!targetBp?.cacheConfig) continue
        if (!firstInstanceByBlueprint) {
          firstInstanceByBlueprint = new Map()
          for (const inst of Object.values(compiled.instances)) {
            if (!firstInstanceByBlueprint.has(inst.blueprintId)) firstInstanceByBlueprint.set(inst.blueprintId, inst.id)
          }
        }
        const warmKey = firstInstanceByBlueprint.get(sibling.target.blueprintId)
        if (warmKey) index.set(dep.id, { cacheConfig: targetBp.cacheConfig, warmKey })
      } else {
        const ms = doc.managedServices[sibling.target.managedServiceId]
        if (!ms?.cacheConfig) continue
        index.set(dep.id, { cacheConfig: ms.cacheConfig, warmKey: `managed:${ms.id}` })
      }
    }
  }
  return index
}

// FEAT-005 (Task 11): pairs every replica-role db instance with "the primary instance for its
// cluster", reusing failover.ts's promoteReplicas grouping convention (blueprintId + the
// PRIMARY's own regionId) rather than inventing a new lookup. A replica's own region can
// legitimately differ from its primary's (a cross-region standby) — that's exactly what
// determines its locality tier via localityFloorSec's same-az/cross-az/cross-region branch. When
// a blueprint has no compiled primary instance anywhere (a malformed topology), that replica is
// skipped entirely: there's nothing for it to lag behind. Both the PRIMARY lookup and the
// resulting clusterId are resolved from the frozen COMPILED role only — never the promotion
// overlay, which doesn't exist yet at start() and would make the cluster key promotion-dependent
// (flows.ts's writeRpsByCluster attribution must always agree with these exact keys).
function buildReplicationIndexes(
  doc: WorldDoc,
  compiled: CompiledWorld,
): {
  replicasByCluster: Record<string, ReplicaRef[]>
  dbConfigByCluster: Map<string, DbConfig>
  semiSyncExtraMsByInstance: Record<InstanceId, number>
} {
  const replicasByCluster: Record<string, ReplicaRef[]> = {}
  const dbConfigByCluster = new Map<string, DbConfig>()
  // FEAT-005 (Task 11, Step 6 — narrowed per the brief's own escape hatch): primaryInstanceId ->
  // the additive ms a semi-sync replica's ack RTT adds to that primary's SELF time. Computed once
  // here (not per step) because every input — locality + region pair — is static for the whole
  // run. This is a deliberately SIMPLER hook than threading a semiSyncMs term through
  // computeTotalLatencyMs's per-row network-ms composition (flows.ts): it folds the RTT into the
  // primary's own serviceLatencyMs at flow creation, the exact same mechanism
  // extraLatencyMsByServer already uses for fault-injected extra latency, rather than adding new
  // per-row plumbing. The simplification: it adds to the primary's self time for EVERY request it
  // serves (reads included), not scoped strictly to writes — a reasonable approximation given a
  // semi-sync primary's writes and reads share one queue/thread pool in this model, documented
  // here rather than left implicit. When a primary has multiple semi-sync replicas, the MAX RTT
  // wins (the primary must wait for the slowest quorum ack).
  const semiSyncExtraMsByInstance: Record<InstanceId, number> = {}

  // blueprintId -> its authored primary instances, grouped once so a world with many replicas
  // doesn't rescan every instance per replica.
  const primariesByBp = new Map<BlueprintId, ServiceInstance[]>()
  for (const inst of Object.values(compiled.instances)) {
    if (inst.role !== 'primary') continue
    const list = primariesByBp.get(inst.blueprintId)
    if (list) list.push(inst)
    else primariesByBp.set(inst.blueprintId, [inst])
  }

  for (const inst of Object.values(compiled.instances)) {
    if (inst.role !== 'replica') continue
    const bp = doc.blueprints[inst.blueprintId]
    if (bp?.kind !== 'db-sql' && bp?.kind !== 'db-nosql') continue
    const dbConfig = bp.dbConfig
    if (!dbConfig) continue
    const primaries = primariesByBp.get(inst.blueprintId)
    if (!primaries || primaries.length === 0) continue
    // Prefer a same-region primary (the promoteReplicas HA pair); otherwise fall back to the
    // first primary by id (deterministic tiebreak) — the cross-region-standby case, where the
    // replica's own region necessarily differs from every authored primary's.
    const primary = primaries.find(p => p.regionId === inst.regionId)
      ?? [...primaries].sort((a, b) => a.id.localeCompare(b.id))[0]

    const locality: ReplicaLocality =
      primary.azId === inst.azId ? 'same-az'
        : primary.regionId === inst.regionId ? 'cross-az'
          : 'cross-region'

    // localityFloorSec's cross-region branch calls regionConfig's interRegionLatencyMs, which
    // looks up WORLD_REGIONS by CATALOG id (e.g. 'us-east-1') — NOT the doc's internal Region.id
    // (a generated `region-N-xxxx` string). Resolve both endpoints' catalogId here, exactly like
    // flows.ts's computeTotalLatencyMs does (`doc.regions[inst.regionId]?.catalogId`), so a
    // cross-region floor doesn't silently fall through interRegionLatencyMs' `!from || !to`
    // guard and read as 0.
    const fromCatalogId = doc.regions[primary.regionId]?.catalogId
    const toCatalogId = doc.regions[inst.regionId]?.catalogId

    const clusterId = `${primary.blueprintId}|${primary.regionId}`
    const ref: ReplicaRef = {
      id: inst.id, locality, applyCapacity: 0,   // live-derived per step (Step 4)
      fromRegionId: fromCatalogId, toRegionId: toCatalogId,
    }
    ;(replicasByCluster[clusterId] ??= []).push(ref)
    if (!dbConfigByCluster.has(clusterId)) dbConfigByCluster.set(clusterId, dbConfig)

    if (dbConfig.replicationMode === 'semi-sync') {
      const rttMs = localityFloorSec(locality, fromCatalogId, toCatalogId) * 2 * 1000
      semiSyncExtraMsByInstance[primary.id] = Math.max(semiSyncExtraMsByInstance[primary.id] ?? 0, rttMs)
    }
  }
  return { replicasByCluster, dbConfigByCluster, semiSyncExtraMsByInstance }
}

// Audit final-review C1/I4: every replica with NO same-region authored primary sibling, but WITH
// an authored primary for its blueprint in at least one other region — the only instances index.ts's
// per-step cross-region isolation-promotion block may ever act on. Built once at start() from the
// frozen compiled world (see EngineState.crossRegionOrphanReplicaIds' own comment for the full
// rationale); a replica with a same-region primary is excluded here structurally so it can never
// reach that block regardless of partition/health state at any later step.
function buildCrossRegionOrphanReplicaIds(compiled: CompiledWorld): Set<InstanceId> {
  const primaryRegionsByBp = new Map<BlueprintId, Set<RegionId>>()
  for (const inst of Object.values(compiled.instances)) {
    if (inst.role !== 'primary') continue
    const set = primaryRegionsByBp.get(inst.blueprintId) ?? new Set<RegionId>()
    set.add(inst.regionId)
    primaryRegionsByBp.set(inst.blueprintId, set)
  }
  const orphans = new Set<InstanceId>()
  for (const inst of Object.values(compiled.instances)) {
    if (inst.role !== 'replica') continue
    const primaryRegions = primaryRegionsByBp.get(inst.blueprintId)
    if (!primaryRegions || primaryRegions.size === 0) continue
    if (primaryRegions.has(inst.regionId)) continue   // same-region primary sibling — promoteReplicas' cluster, never this block's
    orphans.add(inst.id)
  }
  return orphans
}

// FEAT-002 (Task 10): resolve every CompiledPath's from/to into plain EndpointIds and memo the
// resulting impairment, keyed on CompiledPath.id (already the path's unique identity — no
// synthesized key needed). Exported as a standalone pure function — not inlined in runStep —
// purely so it's independently testable without spinning up the whole engine's closure state;
// runStep's only job is to call it with the live compiled/doc/partitions/regionOfAz each step.
// Guarded by the caller-visible early return: an empty `partitions` array (the common case) does
// zero work — no compiled.paths iteration, no impairmentFor calls at all.
export function buildImpairmentMemo(
  compiled: CompiledWorld,
  doc: WorldDoc,
  partitions: PartitionFault[],
  regionOfAz: Map<AzId, RegionId>,
): Map<string, { blocked: boolean; lossFraction: number; delayMs: number }> {
  const memo = new Map<string, { blocked: boolean; lossFraction: number; delayMs: number }>()
  if (partitions.length === 0) return memo
  for (const path of compiled.paths) {
    const fromInst = compiled.instances[path.fromInstanceId]
    const fromIds = fromInst
      ? { regionId: fromInst.regionId, azId: fromInst.azId, serverId: fromInst.serverId }
      : {}
    let toIds: { regionId?: string; azId?: string; serverId?: string }
    if (path.to.kind === 'instance') {
      const toInst = compiled.instances[path.to.instanceId]
      toIds = toInst
        ? { regionId: toInst.regionId, azId: toInst.azId, serverId: toInst.serverId }
        : {}
    } else {
      const ms = doc.managedServices[path.to.managedServiceId]
      if (ms?.scope.kind === 'region') {
        toIds = { regionId: ms.scope.regionId }
      } else if (ms?.scope.kind === 'az') {
        // A region-level partition must still reach an az-scoped managed service, so derive its
        // parent region via the same reverse-index map used for server fault resolution.
        toIds = { azId: ms.scope.azId, regionId: regionOfAz.get(ms.scope.azId) }
      } else {
        toIds = {}
      }
    }
    memo.set(path.id, impairmentFor(fromIds, toIds, partitions))
  }
  return memo
}

// FEAT-001: resolve a fault scope/id to the concrete instance ids it covers, so setFault can
// clear their leakAccumMb entries on fault-clear (a fresh heap the moment the fault stops, not
// just on the next OOM). 'managed' scope has no compiled ServiceInstances — always [].
function instanceIdsForFaultScope(state: EngineState, scope: FaultScope, id: string): InstanceId[] {
  if (scope === 'managed') return []
  if (scope === 'server') return (state.instancesByServer.get(id) ?? []).map(i => i.id)
  if (scope === 'az') {
    const out: InstanceId[] = []
    for (const sv of state.serversByAz.get(id) ?? []) {
      for (const inst of state.instancesByServer.get(sv.id) ?? []) out.push(inst.id)
    }
    return out
  }
  // region
  const out: InstanceId[] = []
  for (const az of state.azsByRegion.get(id) ?? []) {
    for (const sv of state.serversByAz.get(az.id) ?? []) {
      for (const inst of state.instancesByServer.get(sv.id) ?? []) out.push(inst.id)
    }
  }
  return out
}

// Order-preserving single-pass grouping (audit ISSUE-032) — same shape as groupInstancesByServer.
function groupBy<T, K>(items: T[], keyOf: (item: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    const list = m.get(key)
    if (list) list.push(item)
    else m.set(key, [item])
  }
  return m
}
const perfNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())

// Shared singleton the store drives; tests construct their own via createWorldEngine().
export const worldEngine = createWorldEngine()
