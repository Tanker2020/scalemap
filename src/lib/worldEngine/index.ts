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
} from '../world/types'
import { createRng, type Rng } from './rng'
import { createClock, type ClockHandle } from './engineClock'
import { populationDemandRps, baselineDemands } from './demand'
import {
  createRoutingState, resolveRegion, runHealthChecks, azSplit, pickInstance, type RoutingState,
} from './routingRuntime'
import { stepHost, type InstanceLoad, type HostStepResult } from './hostScheduler'
import { createVpsState, stepVps, type VpsState } from './vpsModel'
import { createNicState, applyNicCap, type NicState } from './networkRuntime'
import {
  getBreaker, recordResult, transition, admitRequest, pathKey, type Breaker,
} from './breakers'
import { solveFlows, type InstanceFlow, BYTES_PER_REQUEST_EACH_WAY } from './flows'
import {
  createFailoverState, setOutage as failoverSetOutage, computeHealth, promoteReplicas,
  drainFactor, beginDrain, clearDrain, DEFAULT_HYSTERESIS, type FailoverState,
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
const MAX_GLOBE_ARCS = 200
const REFUSED_EVENT_MIN_GAP_MS = 1000        // ≤1 connection_refused per pathKey per second
const DEGRADE_THRESHOLD_MS = 4               // spec decision 9 / Global Constraints
const DEGRADE_WINDOW_STEPS = 30              // 3s of 100ms steps
const DEGRADED_STEP_MS = 200
const RENDER_PROGRESS_PER_MS = 1 / 1200      // particle sweeps a pair in ~1.2s wall-time

const SEVERITY: Record<HealthState, number> = { healthy: 0, degraded: 1, down: 2 }

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

  routing: RoutingState
  failover: FailoverState
  vpsStates: Map<ServerId, VpsState | null>
  vpsFactor: Map<ServerId, number>           // previous step's effective vCPU factor
  breakers: Map<string, Breaker>
  metrics: MetricsState
  events: EventRing
  replay: ReplayBuffer
  tracer: Tracer

  prevFlows: Record<InstanceId, InstanceFlow>
  windowTotals: { crossAzBytes: number; crossRegionBytes: number; internetBytes: number }
  lastRoutingSnapshot: RoutingSnapshot
  popRegion: Map<PopulationId, RegionId>
  pendingFailover: Map<PopulationId, RegionId>
  checkFailedPrev: Map<string, boolean>
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

export function createWorldEngine(seed = 0x9e3779b9): WorldEngineApi & { __test_step: (steps?: number) => void } {
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

  // Distribute a region's inbound rps to entry-blueprint instances: healthy AZs (equal shares)
  // → entry blueprints present in the AZ (equal shares) → round-robin instance.
  const distributeToEntries = (regionId: RegionId, rps: number, simMs: number, into: Record<InstanceId, number>): void => {
    const s = state!
    if (rps <= 0) return
    const azIds = azSplit(s.compiled.routing.regionAzSpread[regionId] ?? [], healthOfScope)
    if (azIds.length === 0) return
    const perAz = rps / azIds.length
    for (const azId of azIds) {
      const byBp = s.compiled.routing.azBlueprintTargets[azId] ?? {}
      const entriesHere = s.entryBlueprintIds.filter(bpId => (byBp[bpId]?.length ?? 0) > 0)
      if (entriesHere.length === 0) continue
      const perBp = perAz / entriesHere.length
      for (const bpId of entriesHere) {
        const inst = pickInstance(s.routing, azId, bpId, byBp[bpId], healthOfInstance)
        if (inst) into[inst] = (into[inst] ?? 0) + perBp
      }
    }
    void simMs   // reserved for future drain-aware ingest; drain currently applied at the flow layer
  }

  const applyHealth = (scope: 'server' | 'az' | 'region', id: string, inputs: { errorRate: number; cpuPressure: number; checkFailed: boolean; manualDown: boolean }, simMs: number): void => {
    const s = state!
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
    for (const pop of Object.values(doc.populations)) demandByPop[pop.id] = populationDemandRps(pop, simMs, s.rng)
    const baseline = baselineDemands(doc.traffic, doc.populations, doc.regions)

    // ── 2. routing: health checks ──
    const scopes = [
      ...Object.values(doc.regions).map(r => ({ id: r.id, health: healthOfScope(r.id) })),
      ...Object.values(doc.azs).map(a => ({ id: a.id, health: healthOfScope(a.id) })),
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
    for (const pop of Object.values(doc.populations)) {
      const order = compiled.routing.populationRegionOrder[pop.id] ?? []
      const prevRegion = s.popRegion.get(pop.id) ?? null
      const region = resolveRegion(s.routing, pop.id, order, healthOfScope, doc.routing, simMs, s.rng)
      if (!region) continue
      if (prevRegion && prevRegion !== region) {
        emit('ttl_lag_expired', 'info', `${pop.label} DNS re-resolved ${prevRegion} → ${region}`, [pop.id, prevRegion, region], simMs)
        emit('failover_started', 'warning', `${pop.label} failing over ${prevRegion} → ${region}`, [pop.id, prevRegion, region], simMs)
        s.pendingFailover.set(pop.id, region)
      } else if (s.pendingFailover.get(pop.id) === region) {
        emit('failover_completed', 'info', `${pop.label} now served by ${region}`, [pop.id, region], simMs)
        s.pendingFailover.delete(pop.id)
      }
      s.popRegion.set(pop.id, region)
      populationRoutes.push({ populationId: pop.id, regionId: region, rps: demandByPop[pop.id] })
      distributeToEntries(region, demandByPop[pop.id], simMs, entryDemand)
    }
    // baseline synthetic populations bypass DNS — straight to their own region (controller ruling)
    for (const [popId, rps] of Object.entries(baseline)) {
      const regionId = popId.slice('baseline:'.length)
      if (!doc.regions[regionId] || healthOfScope(regionId) === 'down') continue
      populationRoutes.push({ populationId: popId, regionId, rps })
      distributeToEntries(regionId, rps, simMs, entryDemand)
    }
    s.lastRoutingSnapshot = { populationRoutes }

    // ── 4/5. host scheduling (prev-step load) + VPS ──
    const admittedScaleByServer: Record<ServerId, number> = {}
    const latencyMultiplierByServer: Record<ServerId, number> = {}
    const hostResults: Record<ServerId, HostStepResult> = {}
    const vpsPublish: Record<ServerId, VpsPublish> = {}
    const nicByServer: Record<ServerId, NicState> = {}

    for (const server of Object.values(doc.servers)) {
      const resident = Object.values(compiled.instances).filter(i => i.serverId === server.id)
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
        }
      })
      const effectiveVcpu = server.specs.vcpu * (s.vpsFactor.get(server.id) ?? 1)
      const host = stepHost(server, loads, effectiveVcpu, s.rng)
      hostResults[server.id] = host
      admittedScaleByServer[server.id] = host.admittedScale
      latencyMultiplierByServer[server.id] = host.latencyMultiplier
      nicByServer[server.id] = createNicState()

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
    const { flows, totals } = solveFlows({
      compiled, doc, entryDemand, admittedScaleByServer, latencyMultiplierByServer,
      breakerOpen, healthOf: healthOfInstance, rng: s.rng,
    })

    // ── 7. NIC caps (per-server byte accounting from this step's flows) ──
    for (const f of Object.values(flows)) {
      const inst = compiled.instances[f.instanceId]
      const nic = inst ? nicByServer[inst.serverId] : undefined
      if (!inst || !nic) continue
      const bytes = f.admittedRps * BYTES_PER_REQUEST_EACH_WAY * stepSec
      applyNicCap(nic, doc.servers[inst.serverId], bytes, bytes, stepMs)
    }

    // ── 8. breaker record + transition ──
    for (const f of Object.values(flows)) {
      for (const row of f.downstream) {
        if (row.rps <= 0) continue
        const key = pathKey(f.instanceId, row.dependencyId)
        const b = getBreaker(s.breakers, key)
        const from = b.state
        recordResult(b, row.blocked, simMs)
        transition(b, simMs)
        emitBreakerTransition(from, b.state, [f.instanceId, row.toInstanceId ?? row.toManagedServiceId ?? ''], simMs)
      }
    }

    // ── 9. failover / health propagation ──
    const serverAgg = new Map<ServerId, { offered: number; errors: number }>()
    for (const f of Object.values(flows)) {
      const inst = compiled.instances[f.instanceId]
      if (!inst) continue
      const agg = serverAgg.get(inst.serverId) ?? { offered: 0, errors: 0 }
      agg.offered += f.offeredRps
      agg.errors += f.errorRps + f.refusedRps
      serverAgg.set(inst.serverId, agg)
    }
    const rate = (a?: { offered: number; errors: number }): number => (a && a.offered > 0 ? a.errors / a.offered : 0)
    for (const server of Object.values(doc.servers)) {
      applyHealth('server', server.id, {
        errorRate: rate(serverAgg.get(server.id)),
        cpuPressure: hostResults[server.id]?.cpuPressure ?? 0,
        checkFailed: false,
        manualDown: s.failover.manualOutages.has(server.id),
      }, simMs)
    }
    for (const az of Object.values(doc.azs)) {
      const srv = Object.values(doc.servers).filter(v => v.azId === az.id)
      const offered = srv.reduce((n, v) => n + (serverAgg.get(v.id)?.offered ?? 0), 0)
      const errors = srv.reduce((n, v) => n + (serverAgg.get(v.id)?.errors ?? 0), 0)
      const cpu = srv.reduce((m, v) => Math.max(m, hostResults[v.id]?.cpuPressure ?? 0), 0)
      applyHealth('az', az.id, { errorRate: offered > 0 ? errors / offered : 0, cpuPressure: cpu, checkFailed: checkFailedById.get(az.id) ?? false, manualDown: s.failover.manualOutages.has(az.id) }, simMs)
    }
    for (const region of Object.values(doc.regions)) {
      const azsIn = Object.values(doc.azs).filter(a => a.regionId === region.id)
      const srv = Object.values(doc.servers).filter(v => azsIn.some(a => a.id === v.azId))
      const offered = srv.reduce((n, v) => n + (serverAgg.get(v.id)?.offered ?? 0), 0)
      const errors = srv.reduce((n, v) => n + (serverAgg.get(v.id)?.errors ?? 0), 0)
      const cpu = srv.reduce((m, v) => Math.max(m, hostResults[v.id]?.cpuPressure ?? 0), 0)
      applyHealth('region', region.id, { errorRate: offered > 0 ? errors / offered : 0, cpuPressure: cpu, checkFailed: checkFailedById.get(region.id) ?? false, manualDown: s.failover.manualOutages.has(region.id) }, simMs)
    }
    const downInstances = Object.values(compiled.instances).filter(i => healthOfInstance(i.id) === 'down').map(i => i.id)
    for (const e of promoteReplicas(s.failover, compiled, doc, downInstances, simMs)) emitEvent(e)

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
    accumulateStep(s.metrics, flows, hostResults, vpsPublish, nicByServer, healthOfAny, simMs)
    s.windowTotals.crossAzBytes += totals.crossAzBytes * stepSec
    s.windowTotals.crossRegionBytes += totals.crossRegionBytes * stepSec
    s.windowTotals.internetBytes += totals.internetBytes * stepSec
    s.prevFlows = flows

    // ── 11. 1 Hz batch + replay + trace ──
    if (simMs - s.lastBatchMs >= 1000) {
      s.lastBatchMs = simMs
      const batch = buildBatch(s.metrics, doc, compiled, s.lastRoutingSnapshot, { ...s.windowTotals }, simMs)
      s.callbacks.onMetrics(batch)
      s.replay.push({ simMs, batch, events: s.events.drain() })
      s.tracer.sample(flows, compiled, doc, simMs, entryId => populationForEntry(entryId))
      s.windowTotals = { crossAzBytes: 0, crossRegionBytes: 0, internetBytes: 0 }
    }
  }

  // Which population currently feeds a given entry instance (for TracedRequest.populationId).
  const populationForEntry = (entryInstanceId: InstanceId): PopulationId | null => {
    const inst = state!.compiled.instances[entryInstanceId]
    if (!inst) return null
    const route = state!.lastRoutingSnapshot.populationRoutes.find(r => r.regionId === inst.regionId && !r.populationId.startsWith('baseline:'))
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
    // region/server rich particle surfaces arrive in Phases 4/3; Phase 2 ships empty-but-valid payloads.
    return { simMs, particles: [], arcs: [] }
  }

  function buildArcs(): VisualArc[] {
    const s = state!
    const routes = s.lastRoutingSnapshot.populationRoutes
    const maxRps = Math.max(1, ...routes.map(r => r.rps))
    const arcs: VisualArc[] = []
    for (const r of routes) {
      if (r.populationId.startsWith('baseline:')) continue
      const pop = s.doc.populations[r.populationId]
      const region = s.doc.regions[r.regionId]
      const geo = region ? REGION_GEO_LOCAL[region.catalogId] : undefined
      if (!pop || !geo) continue
      arcs.push({ fromLatLon: [pop.lat, pop.lon], toLatLon: [geo.lat, geo.lon], intensity: Math.min(1, r.rps / maxRps), kind: 'client' })
      if (arcs.length >= MAX_GLOBE_ARCS) break
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

  const api: WorldEngineApi & { __test_step: (steps?: number) => void } = {
    start(doc, compiled, callbacks) {
      state = {
        running: true, seed, rng: createRng(seed), clock: createClock(DEFAULT_STEP_MS), stepMs: DEFAULT_STEP_MS,
        timeScale: 1, doc, compiled, callbacks, entryBlueprintIds: entryBlueprints(doc),
        routing: createRoutingState(), failover: createFailoverState(),
        vpsStates: new Map(Object.values(doc.servers).map(sv => [sv.id, createVpsState(sv)])),
        vpsFactor: new Map(), breakers: new Map(), metrics: createMetricsState(),
        events: createEventRing(500), replay: createReplayBuffer(300), tracer: createTracer(createRng(seed ^ 0x1234)),
        prevFlows: {}, windowTotals: { crossAzBytes: 0, crossRegionBytes: 0, internetBytes: 0 },
        lastRoutingSnapshot: { populationRoutes: [] }, popRegion: new Map(), pendingFailover: new Map(),
        checkFailedPrev: new Map(), instanceHealth: new Map(), oomRestartAt: new Map(), refusedRateLimit: new Map(),
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
    isRunning() {
      return state?.running ?? false
    },
    setTimeScale(scale) {
      if (state) state.timeScale = scale
    },
    setOutage(scope, id, down) {
      if (!state) return
      for (const e of failoverSetOutage(state.failover, scope, id, down, state.clock.simMs)) emitEvent(e)
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
  }
  return api
}

const frac = (x: number): number => x - Math.floor(x)
const perfNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())

// Shared singleton the store drives; tests construct their own via createWorldEngine().
export const worldEngine = createWorldEngine()
