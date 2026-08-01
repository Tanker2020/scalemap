// The WorldEngineApi facade — the single composition point that ticks the whole compiled
// world. It owns no simulation math itself; it sequences Tasks 1–11 in the documented step
// order, publishes the metrics pyramid / events / replay at 1 Hz, feeds per-scope render
// payloads to attached views, and enforces the render caps. Headless: never imports from
// src/app/. Determinism: all randomness flows through the seeded rng built here.
import type {
  WorldEngineApi, EngineCallbacks, EngineEvent, EngineEventKind, HealthState,
  RenderScope, FramePayload, VisualParticle, VisualArc, FaultScope, FaultSpec,
} from './types'
import { MAX_GLOBE_ARCS } from './types'
import type {
  WorldDoc, CompiledWorld, InstanceId, ServerId, AzId, RegionId, PopulationId, BlueprintId,
  ServiceInstance, CompiledLbRouting, Server, AvailabilityZone, PlacementRole, BlueprintDependency,
} from '../world/types'
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
import {
  createRoutingState, resolveRegion, runHealthChecks, distributeToTargets, type RoutingState,
} from './routingRuntime'
import { stepHost, type InstanceLoad, type HostStepResult } from './hostScheduler'
import { createVpsState, stepVps, type VpsState } from './vpsModel'
import { createNicState, addNicBytes, settleNic, NIC_REQUEST_BYTES, NIC_RESPONSE_BYTES, type NicState } from './networkRuntime'
import { sampleSizeMultiplier } from './latency'
import {
  getBreaker, recordWeighted, transition, admitRequest, pathKey, type Breaker,
} from './breakers'
import { solveFlows, type InstanceFlow } from './flows'
import { managedDbRuntime } from '../managedDbRuntime'
import { topicRuntime } from './broker'
import {
  createFailoverState, setOutage as failoverSetOutage, computeHealth, probeInstant, promoteReplicas,
  drainFactor, beginDrain, clearDrain, DEFAULT_HYSTERESIS, effectiveRoleResolver, hasOutage,
  type FailoverState, type OutageScope,
  recoverMultiAzManagedDbs, failbackPromotions, applyAzOutageToManaged,
} from './failover'
import {
  createMetricsState, accumulateStep, buildBatch, type MetricsState, type RoutingSnapshot,
  type VpsPublish,
} from './metrics'
import { createEventRing, mkEvent, type EventRing } from './events'
import {
  createFaultState, setFault as setFaultPure, faultsForServer, stepLeaks, type FaultState,
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

  routing: RoutingState
  failover: FailoverState
  // FEAT-001 fault injection bookkeeping (down/latency-add/cpu-brownout/memory-leak/error-inject).
  // 'down' faults ALSO route through failover's setOutage — this is bookkeeping/leak-accumulator
  // state only, never a second source of truth for outage/health.
  faults: FaultState
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

export function createWorldEngine(seed = 0x9e3779b9): WorldEngineApi & { __test_step: (steps?: number) => void; __test_render: (wallMs?: number) => void } {
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
        healthOfInstance,
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

  function runStep(simMs: number): void {
    const s = state!
    const { doc, compiled } = s
    const stepMs = s.stepMs
    const stepSec = stepMs / 1000

    // ── 0. OOM restart timers ──
    for (const [iid, restartAt] of [...s.oomRestartAt]) {
      if (simMs >= restartAt) {
        s.oomRestartAt.delete(iid)
        s.instanceHealth.set(iid, 'healthy')
        emit('instance_restarted', 'info', `instance ${iid} restarted`, [iid], simMs)
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
      demandByPop[pop.id] = populationDemandRps(pop, simMs, s.rng, stepMs, ds)
    }

    // ── 2. routing: health checks ──
    // The probe input is the RAW signal (manual outage now, last step's error/pressure via
    // probePrev) — never healthOfScope: computeHealth folds checkFailed into its output, so
    // probing the output self-sustained (a killed region's checks failed forever and it never
    // recovered after restore — the post-Polish-2 bug).
    const probeOfScope = (scope: OutageScope, id: string): HealthState =>
      hasOutage(s.failover, scope, id) ? 'down' : (s.probePrev.get(id) ?? 'healthy')
    const scopes = [
      ...Object.values(doc.regions).map(r => ({ id: r.id, health: probeOfScope('region', r.id) })),
      ...Object.values(doc.azs).map(a => ({ id: a.id, health: probeOfScope('az', a.id) })),
    ]
    const checkResults = runHealthChecks(s.routing, doc.routing, simMs, scopes)
    const checkFailedById = new Map(checkResults.map(c => [c.id, c.checkFailed]))
    for (const c of checkResults) {
      if (c.checkFailed && !s.checkFailedPrev.get(c.id)) emit('health_check_failed', 'warning', `health check failed for ${c.id}`, [c.id], simMs)
      s.checkFailedPrev.set(c.id, c.checkFailed)
    }

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
        if (errorInject) faultErrorFractionByServer[server.id] = errorInject.errorFraction
        const activeLeak = leak
        if (activeLeak) {
          stepLeaks(s.faults, resident.map(i => ({ instanceId: i.id, mbPerMinute: activeLeak.mbPerMinute })), stepSec)
        }
      }
      const loads: InstanceLoad[] = resident.map(i => {
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
      const host = stepHost(server, loads, effectiveVcpu, s.rng)
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
      if (queuedMs + faultMs > 0) extraLatencyMsByServer[server.id] = queuedMs + faultMs
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
    const { flows, totals, depthExceededInstanceIds, cycleCutEdges } = solveFlows({
      compiled, doc, entryDemand, admittedScaleByServer, latencyMultiplierByServer,
      extraLatencyMsByServer,
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
    })

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
    for (const e of promoteReplicas(s.failover, compiled, doc, downInstances, simMs, healthOfInstance)) emitEvent(e)
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
      const batch = buildBatch(s.metrics, doc, compiled, s.lastRoutingSnapshot, { ...s.windowTotals }, simMs, starved, connProfileByInstance, effectiveCpuMsByInstance, s.faults.leakAccumMb)
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

  const api: WorldEngineApi & { __test_step: (steps?: number) => void; __test_render: (wallMs?: number) => void } = {
    start(doc, compiled, callbacks) {
      // Defense against double-start (audit ISSUE-048): cancel any live rAF chain BEFORE the
      // state swap — otherwise the old chain reads the module-level `state`, sees the new run's
      // running=true, and keeps scheduling: two chains advancing one state at double speed.
      if (state?.rafId != null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(state.rafId)
      }
      const depIndexes = buildDepIndexes(doc)
      state = {
        running: true, seed, rng: createRng(seed), clock: createClock(DEFAULT_STEP_MS), stepMs: DEFAULT_STEP_MS,
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
        routing: createRoutingState(), failover: createFailoverState(), faults: createFaultState(),
        demandStates: new Map(),
        vpsStates: new Map(Object.values(doc.servers).map(sv => [sv.id, createVpsState(sv)])),
        vpsFactor: new Map(),
        nics: new Map(Object.values(doc.servers).map(sv => [sv.id, createNicState()])),
        nicDeliveredFraction: new Map(), nicQueuedLatencyMs: new Map(),
        breakers: new Map(), queueDepth: new Map(), metrics: createMetricsState(),
        events: createEventRing(500), replay: createReplayBuffer(300), tracer: createTracer(createRng(seed ^ 0x1234)),
        prevFlows: {}, windowTotals: { crossAzBytes: 0, crossRegionBytes: 0, internetBytes: 0, managedEgressBytes: {} },
        lastRoutingSnapshot: { populationRoutes: [] }, popRegion: new Map(), pendingFailover: new Map(),
        popPrevRegion: new Map(),
        checkFailedPrev: new Map(), probePrev: new Map(), instanceHealth: new Map(), oomRestartAt: new Map(), refusedRateLimit: new Map(),
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
      const affected = instanceIdsForFaultScope(state, scope, id)
      for (const e of setFaultPure(state.faults, scope, id, spec, state.clock.simMs, affected)) emitEvent(e)
      // 'down' (and clearing back to null) routes through the EXISTING failover outage path so
      // behavior stays byte-identical to the pre-FEAT-001 setOutage — faults.ts's own state above
      // is bookkeeping/event-emission only, never a second source of truth for down/health.
      if (spec === null || spec.kind === 'down') {
        const down = spec !== null
        for (const e of failoverSetOutage(state.failover, scope as OutageScope, id, down, state.clock.simMs)) emitEvent(e)
        // audit ISSUE-008: an AZ failure is a SIMULATED outage for the managed services scoped to
        // it — they go down with the AZ (and multi-AZ DBs may then auto-promote their standby),
        // and recover with it. Manual per-service kills are untouched in both directions.
        if (scope === 'az') {
          for (const e of applyAzOutageToManaged(state.failover, state.doc, id, down, state.clock.simMs)) emitEvent(e)
        }
      }
    },
    setOutage(scope, id, down) {
      // Thin alias (contract-drift.md) — new callers should prefer setFault directly.
      api.setFault(scope, id, down ? { kind: 'down' } : null)
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
