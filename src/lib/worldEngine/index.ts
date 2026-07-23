// The WorldEngineApi facade — the single composition point that ticks the whole compiled
// world. It owns no simulation math itself; it sequences Tasks 1–11 in the documented step
// order, publishes the metrics pyramid / events / replay at 1 Hz, feeds per-scope render
// payloads to attached views, and enforces the render caps. Headless: never imports from
// src/app/. Determinism: all randomness flows through the seeded rng built here.
import type {
  WorldEngineApi, EngineCallbacks, EngineEvent, EngineEventKind, HealthState,
  RenderScope, FramePayload, VisualParticle, VisualArc,
} from './types'
import type {
  WorldDoc, CompiledWorld, InstanceId, ServerId, AzId, RegionId, PopulationId, BlueprintId,
  ServiceInstance, CompiledLbRouting, Server, AvailabilityZone,
} from '../world/types'
import { routeMatchesPattern, listRoutes } from '../nodeConfig'
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
import {
  getBreaker, recordWeighted, transition, admitRequest, pathKey, type Breaker,
} from './breakers'
import { solveFlows, type InstanceFlow } from './flows'
import { managedDbRuntime } from '../managedDbRuntime'
import {
  createFailoverState, setOutage as failoverSetOutage, computeHealth, probeInstant, promoteReplicas,
  drainFactor, beginDrain, clearDrain, DEFAULT_HYSTERESIS, effectiveRoleResolver, type FailoverState,
  recoverMultiAzManagedDbs, failbackPromotions, applyAzOutageToManaged,
} from './failover'
import {
  createMetricsState, accumulateStep, buildBatch, type MetricsState, type RoutingSnapshot,
  type VpsPublish,
} from './metrics'
import { createEventRing, mkEvent, type EventRing } from './events'
import { createReplayBuffer, createTracer, type ReplayBuffer, type Tracer } from './replay'
import { REGION_GEO as REGION_GEO_LOCAL } from '../world/regionGeo'

const DEFAULT_STEP_MS = 100
const OOM_RESTART_MS = 5000                 // spec decision 3: instance_restarted after 5s
const PARTICLE_RATIO = 10                    // rps per sampled AZ particle (skeleton T12)
const MAX_AZ_PARTICLES = 400                 // az render cap (contracts "≤ current particle cap")
export const MAX_GLOBE_ARCS = 200
const MAX_SERVER_PARTICLES = 50              // server render cap (contracts: server ≤ 50 traces)
const REFUSED_EVENT_MIN_GAP_MS = 1000        // ≤1 connection_refused per pathKey per second
const MIN_HEALTH_SIGNAL_RPS = 0.5            // below this offered rps, errorRate carries no signal
const DEGRADE_THRESHOLD_MS = 4               // spec decision 9 / Global Constraints
const DEGRADE_WINDOW_STEPS = 30              // 3s of 100ms steps
const DEGRADED_STEP_MS = 200
const RENDER_PROGRESS_PER_MS = 1 / 1200      // particle sweeps a pair in ~1.2s wall-time

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
  entryBlueprintIds: BlueprintId[]           // blueprints with a 'public' port = client entry points
  routePathById: Map<string, string>         // routeId → route path, for L7 listener-rule matching

  // Static topology indexes built once at start() (audit ISSUE-032): the per-step health
  // propagation loops read these instead of re-filtering doc.servers/doc.azs per AZ/region
  // every step — the exact unindexed-lookup regression groupInstancesByServer's comment warns
  // against. The doc is frozen for the run, so these can never go stale.
  serversByAz: Map<AzId, Server[]>
  azsByRegion: Map<RegionId, AvailabilityZone[]>

  routing: RoutingState
  failover: FailoverState
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

  const emitEvent = (e: EngineEvent): void => {
    if (!state) return
    state.events.push(e)
    state.callbacks.onEvent(e)
  }
  const emit = (kind: EngineEventKind, severity: EngineEvent['severity'], message: string, affected: string[], simMs: number): void => {
    if (!state) return
    emitEvent(mkEvent(kind, severity, message, affected, simMs, state.idSeq++))
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
  const distributeViaLb = (regionId: RegionId, routeDemands: RouteDemand[], into: Record<InstanceId, number>): void => {
    const s = state!
    const lb = s.compiled.routing.lbRouting[regionId]
    if (!lb) return
    const regionAzSpread = s.compiled.routing.regionAzSpread[regionId] ?? []
    for (const { routeId, rps } of routeDemands) {
      if (rps <= 0) continue
      const path = routeId != null ? s.routePathById.get(routeId) : null
      distributeToTargets({
        targetBlueprintIds: matchRouteTargets(path, lb),
        rps,
        crossZone: lb.crossZone,
        regionAzSpread,
        azBlueprintTargets: s.compiled.routing.azBlueprintTargets,
        healthOfScope,
        healthOfInstance,
        cursors: s.routing,
        into,
      })
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
    const probeOfScope = (id: string): HealthState =>
      s.failover.manualOutages.has(id) ? 'down' : (s.probePrev.get(id) ?? 'healthy')
    const scopes = [
      ...Object.values(doc.regions).map(r => ({ id: r.id, health: probeOfScope(r.id) })),
      ...Object.values(doc.azs).map(a => ({ id: a.id, health: probeOfScope(a.id) })),
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
        const rps = demandByPop[pop.id] * fraction
        // Rows are pushed even at rps 0 (a Poisson tick can draw zero arrivals) — the routing
        // snapshot is attribution, and drain arcs / inbound lists key off row presence.
        populationRoutes.push({ populationId: pop.id, regionId, rps })
        distributeViaLb(regionId, splitDemandByMix(rps, pop.requestMix), entryDemand)
      }
    }
    s.lastRoutingSnapshot = { populationRoutes }

    // ── 4/5. host scheduling (prev-step load) + VPS ──
    const admittedScaleByServer: Record<ServerId, number> = {}
    const latencyMultiplierByServer: Record<ServerId, number> = {}
    const extraLatencyMsByServer: Record<ServerId, number> = {}
    const hostResults: Record<ServerId, HostStepResult> = {}
    const vpsPublish: Record<ServerId, VpsPublish> = {}
    const nicByServer: Record<ServerId, NicState> = {}

    const instancesByServer = groupInstancesByServer(compiled)
    const serviceRateByInstance: Record<InstanceId, number> = {}
    for (const server of Object.values(doc.servers)) {
      const resident = instancesByServer.get(server.id) ?? []
      const loads: InstanceLoad[] = resident.map(i => {
        const pf = s.prevFlows[i.id]
        const bp = doc.blueprints[i.blueprintId]
        const admitted = pf?.admittedRps ?? 0
        const latency = pf?.serviceLatencyMs ?? bp?.workload.cpuMsPerRequest ?? 1
        const runtime = doc.placements[i.placementId]?.runtime
        return {
          instanceId: i.id,
          cpuMsPerRequest: bp?.workload.cpuMsPerRequest ?? 1,
          admittedRps: admitted,
          activeConnections: admitted * (latency / 1000),
          ramBaseMb: bp?.workload.ramBaseMb ?? 0,
          ramPerConnMb: bp?.workload.ramPerConnMb ?? 0,
          memLimitMb: runtime && runtime.type === 'container' ? runtime.memLimitMb : null,
          // Audit ISSUE-018/013: fair-share weight + carried backlog, so the scheduler can grant
          // a draining instance capacity beyond its instantaneous demand.
          cpuShares: bp?.workload.cpuShares ?? 1,
          backlogRps: (s.queueDepth.get(i.id) ?? 0) / stepSec,
        }
      })
      const effectiveVcpu = server.specs.vcpu * (s.vpsFactor.get(server.id) ?? 1)
      const host = stepHost(server, loads, effectiveVcpu, s.rng)
      hostResults[server.id] = host
      // Fold the NIC's ABSOLUTE line-rate ceiling into each instance's capacity (audit
      // ISSUE-002 × ISSUE-013): the worst byte direction governs (mirrors evaluateNic), shared
      // across resident instances by the same cpu-share weights. Without this the queue model
      // would never feel the NIC — a fraction multiplied onto an ample CPU rate doesn't bite.
      const nicCeilingRps =
        ((server.specs.nicMbps * 1e6) / 8) / Math.max(NIC_REQUEST_BYTES, NIC_RESPONSE_BYTES)
      const totalShares = loads.reduce((sum, l) => sum + Math.max(0, l.cpuShares ?? 1), 0) || 1
      for (const l of loads) {
        const nicShare = nicCeilingRps * (Math.max(0, l.cpuShares ?? 1) / totalShares)
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
      if (queuedMs > 0) extraLatencyMsByServer[server.id] = queuedMs
      let nic = s.nics.get(server.id)
      if (!nic) {
        nic = createNicState()
        s.nics.set(server.id, nic)
      }
      nicByServer[server.id] = nic

      if (host.oomVictim && !s.oomRestartAt.has(host.oomVictim)) {
        s.oomRestartAt.set(host.oomVictim, simMs + OOM_RESTART_MS)
        s.instanceHealth.set(host.oomVictim, 'down')
        emit('oom_kill', 'critical', `${host.oomVictim} OOM-killed on ${server.label}`, [host.oomVictim, server.id], simMs)
      }

      const vpsState = s.vpsStates.get(server.id) ?? null
      if (vpsState) {
        const vps = stepVps(vpsState, server, Math.min(1, host.cpuPressure), stepMs, s.rng)
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
      return !admitRequest(b)
    }
    // Effective roles carry the promotion overlay committed at the END of a PRIOR step
    // (promoteReplicas below), so once a primary has failed over, this step's writes route to the
    // promoted replica. Built from engine state only — the doc is never touched.
    const roleOf = effectiveRoleResolver(compiled, s.failover.promotedAt)
    // Managed-DB failure model (node-model Phase 5.4) from the PREVIOUS step's flows. Queueing
    // latency, Little's-law connections and the timeout fraction are all functions of a DB's
    // AGGREGATE load, which the solver's per-dependency loop cannot see — so it is computed once
    // here and both the solver and the metrics window read the same entries. One-step lag, exactly
    // like admittedScale.
    const managedDbRt = managedDbRuntime(s.prevFlows, doc, compiled)
    const { flows, totals } = solveFlows({
      compiled, doc, entryDemand, admittedScaleByServer, latencyMultiplierByServer,
      extraLatencyMsByServer,
      // Queue model (audit ISSUE-013): fair-share service rates + the persistent queue map
      // (mutated in place) + step length — activates the queueing path in the solver.
      serviceRateByInstance, queueDepth: s.queueDepth, stepSec,
      breakerOpen, healthOf: healthOfInstance, roleOf, rng: s.rng,
      // Manual managed-service outages (node-model Phase 5.2): a downed managed service fails every
      // call to it. Read straight from the manual-outage set — managed ids aren't in the per-step
      // health recompute, so healthByScope would go stale on restore.
      managedDown: (id) => s.failover.manualOutages.has(id),
      managedDbRuntime: managedDbRt,
    })

    // ── 7. NIC byte accounting (audit ISSUE-002: split request/response, persistent buffer) ──
    // Ingress = request payloads in, egress = response payloads out — no longer symmetric.
    // Settlement (deliveredFraction / queuedLatencyMs) happens once per server AFTER step 10's
    // metrics accumulate (which reads the per-step counters), feeding the NEXT step.
    for (const f of Object.values(flows)) {
      const inst = compiled.instances[f.instanceId]
      const nic = inst ? nicByServer[inst.serverId] : undefined
      if (!inst || !nic) continue
      addNicBytes(nic, f.admittedRps * NIC_REQUEST_BYTES * stepSec, f.admittedRps * NIC_RESPONSE_BYTES * stepSec)
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
        const fraction = row.blocked ? 1 : row.toInstanceId ? targetErrorFraction(row.toInstanceId) : 0
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
        cpuPressure: hostResults[server.id]?.cpuPressure ?? 0,
        checkFailed: false,
        manualDown: s.failover.manualOutages.has(server.id),
      }, simMs)
    }
    // Audit ISSUE-032: AZ/region rollups read the start()-built serversByAz/azsByRegion indexes —
    // per-step filters over doc.servers/doc.azs made this stage O(regions × azs × servers).
    for (const az of Object.values(doc.azs)) {
      const srv = s.serversByAz.get(az.id) ?? []
      const offered = srv.reduce((n, v) => n + (serverAgg.get(v.id)?.offered ?? 0), 0)
      const errors = srv.reduce((n, v) => n + (serverAgg.get(v.id)?.errors ?? 0), 0)
      const cpu = srv.reduce((m, v) => Math.max(m, hostResults[v.id]?.cpuPressure ?? 0), 0)
      applyHealth('az', az.id, { errorRate: offered > MIN_HEALTH_SIGNAL_RPS ? errors / offered : 0, cpuPressure: cpu, checkFailed: checkFailedById.get(az.id) ?? false, manualDown: s.failover.manualOutages.has(az.id) }, simMs)
    }
    for (const region of Object.values(doc.regions)) {
      const srv = (s.azsByRegion.get(region.id) ?? []).flatMap(a => s.serversByAz.get(a.id) ?? [])
      const offered = srv.reduce((n, v) => n + (serverAgg.get(v.id)?.offered ?? 0), 0)
      const errors = srv.reduce((n, v) => n + (serverAgg.get(v.id)?.errors ?? 0), 0)
      const cpu = srv.reduce((m, v) => Math.max(m, hostResults[v.id]?.cpuPressure ?? 0), 0)
      applyHealth('region', region.id, { errorRate: offered > MIN_HEALTH_SIGNAL_RPS ? errors / offered : 0, cpuPressure: cpu, checkFailed: checkFailedById.get(region.id) ?? false, manualDown: s.failover.manualOutages.has(region.id) }, simMs)
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
    accumulateStep(s.metrics, flows, hostResults, vpsPublish, nicByServer, healthOfAny, simMs, managedDbRt)
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
      const batch = buildBatch(s.metrics, doc, compiled, s.lastRoutingSnapshot, { ...s.windowTotals }, simMs)
      s.callbacks.onMetrics(batch)
      s.replay.push({ simMs, batch, events: s.events.drain() })
      s.tracer.sample(flows, compiled, doc, simMs, entryId => populationForEntry(entryId), managedDbRt)
      s.windowTotals = { crossAzBytes: 0, crossRegionBytes: 0, internetBytes: 0, managedEgressBytes: {} }
    }
  }

  // Which population currently feeds a given entry instance (for TracedRequest.populationId).
  const populationForEntry = (entryInstanceId: InstanceId): PopulationId | null => {
    const inst = state!.compiled.instances[entryInstanceId]
    if (!inst) return null
    const route = state!.lastRoutingSnapshot.populationRoutes.find(r => r.regionId === inst.regionId)
    return route?.populationId ?? null
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
    if (scope.level === 'globe') return { simMs, particles: [], arcs: buildArcs() }
    if (scope.level === 'az') return { simMs, particles: buildAzParticles(scope.azId, wallMs), arcs: [] }
    if (scope.level === 'server') return { simMs, particles: buildServerParticles(scope.serverId, wallMs), arcs: [] }
    // region rich particle surface arrives in Phase 4; ships empty-but-valid until then.
    return { simMs, particles: [], arcs: [] }
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
      const from = s.compiled.instances[f.instanceId]
      if (!from || from.azId !== azId) continue
      const bp = s.doc.blueprints[from.blueprintId]
      const isEntry = s.entryBlueprintIds.includes(from.blueprintId)
      // entry ingress particles from the client edge
      if (isEntry && f.offeredRps > 0) {
        const n = Math.min(MAX_AZ_PARTICLES, Math.round((f.offeredRps / PARTICLE_RATIO) * drain))
        for (let k = 0; k < n && particles.length < MAX_AZ_PARTICLES; k++) {
          particles.push({ id: pid++, fromId: 'edge:client', toId: from.serverId, progress: frac(phase + k * 0.137), protocol: 'http', blocked: false, colorHint: bp?.color ?? null })
        }
      }
      for (const row of f.downstream) {
        const toId = row.toInstanceId ? s.compiled.instances[row.toInstanceId]?.serverId : row.toManagedServiceId
        if (!toId) continue
        const dep = bp?.dependencies.find(d => d.id === row.dependencyId)
        const n = Math.min(MAX_AZ_PARTICLES, Math.max(row.blocked ? 1 : 0, Math.round(row.rps / PARTICLE_RATIO)))
        for (let k = 0; k < n && particles.length < MAX_AZ_PARTICLES; k++) {
          particles.push({ id: pid++, fromId: from.serverId, toId, progress: frac(phase + k * 0.191), protocol: dep?.protocol ?? 'http', blocked: row.blocked, colorHint: bp?.color ?? null })
        }
      }
    }
    return particles
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
      const from = s.compiled.instances[f.instanceId]
      if (!from || from.serverId !== serverId) continue
      const fromBp = s.doc.blueprints[from.blueprintId]
      const isEntry = s.entryBlueprintIds.includes(from.blueprintId)
      // inbound entry: nic -> receiving instance; colorHint = the receiving service's hue
      if (isEntry && f.offeredRps > 0) {
        const n = Math.min(MAX_SERVER_PARTICLES, Math.round(f.offeredRps / PARTICLE_RATIO))
        for (let k = 0; k < n && particles.length < MAX_SERVER_PARTICLES; k++) {
          particles.push({ id: pid++, fromId: nicId, toId: from.id, progress: frac(phase + k * 0.137), protocol: 'http', blocked: false, colorHint: fromBp?.color ?? null })
        }
      }
      for (const row of f.downstream) {
        const target = row.toInstanceId ? s.compiled.instances[row.toInstanceId] : undefined
        const resident = !!target && target.serverId === serverId
        const toId = resident ? target!.id : nicId          // off-server/managed -> nic
        const dep = fromBp?.dependencies.find(d => d.id === row.dependencyId)
        // intra: receiving service's hue; instance->nic outbound: the sending service's hue
        const colorHint = resident ? (s.doc.blueprints[target!.blueprintId]?.color ?? null) : (fromBp?.color ?? null)
        const n = Math.min(MAX_SERVER_PARTICLES, Math.max(row.blocked ? 1 : 0, Math.round(row.rps / PARTICLE_RATIO)))
        for (let k = 0; k < n && particles.length < MAX_SERVER_PARTICLES; k++) {
          particles.push({ id: pid++, fromId: from.id, toId, progress: frac(phase + k * 0.191), protocol: dep?.protocol ?? 'http', blocked: row.blocked, colorHint })
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
      state = {
        running: true, seed, rng: createRng(seed), clock: createClock(DEFAULT_STEP_MS), stepMs: DEFAULT_STEP_MS,
        timeScale: 1, doc, compiled, callbacks, entryBlueprintIds: entryBlueprints(doc),
        routePathById: buildRoutePathById(doc),
        serversByAz: groupBy(Object.values(doc.servers), sv => sv.azId),
        azsByRegion: groupBy(Object.values(doc.azs), az => az.regionId),
        routing: createRoutingState(), failover: createFailoverState(),
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
    setOutage(scope, id, down) {
      if (!state) return
      for (const e of failoverSetOutage(state.failover, scope, id, down, state.clock.simMs)) emitEvent(e)
      // audit ISSUE-008: an AZ failure is a SIMULATED outage for the managed services scoped to
      // it — they go down with the AZ (and multi-AZ DBs may then auto-promote their standby),
      // and recover with it. Manual per-service kills are untouched in both directions.
      if (scope === 'az') {
        for (const e of applyAzOutageToManaged(state.failover, state.doc, id, down, state.clock.simMs)) emitEvent(e)
      }
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
