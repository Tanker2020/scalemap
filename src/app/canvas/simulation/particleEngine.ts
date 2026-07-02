import type { Node, Edge } from '@xyflow/react'
import type {
  NodeData, EdgeData, NodeType, EdgeType, NodeSimConfig, RetryConfig,
  RequestEdgeConfig, StreamEdgeConfig, EventEdgeConfig, DependencyEdgeConfig,
  PacketMode, PacketTemplate, HttpTemplate, StreamTemplate, PacketDistributionEntry,
} from '../../../lib/nodeConfig'
import { GROUPING_TYPES, DEFAULT_EVENT_EDGE_CONFIG, edgeAcceptsProtocol } from '../../../lib/nodeConfig'
import { useCanvasStore } from '../../store/canvas.store'
import { interRegionLatencyMs } from '../../../lib/regionConfig'
import { useSimulationStore, type TrafficMode, type NodeMetrics, type SimEventType, type CircuitState, type RequestSnapshot, type TemplateInfo } from '../../store/simulation.store'
import { useReplayStore } from '../../store/replay.store'
import { NODE_SIM_DEFAULTS } from '../../simulation/defaults'
import { CLOUD_REGISTRY, type CloudProvider } from '../../../lib/cloudRegistry'
import {
  getBreaker, recordBreakerResult, checkBreakerTransition,
  forceOpenBreakersForNode, resetBreakersIfRecovered, getAllBreakers, clearBreakers,
} from './particleEngine/circuitBreakers'
import {
  acquireWorkers, releaseWorkerNow, scheduleWorkerRelease,
  getActiveConnections, acquireConnection, scheduleConnectionRelease,
  getWarmInstances, getWarmLastActivity, setWarmInstances, setWarmLastActivity,
  clearBackpressureState, scheduleGenericRelease, drainScheduledReleases,
} from './particleEngine/backpressure'
import {
  trafficMultiplier as chaosTrafficMultiplier, advanceChaosSchedule as chaosAdvanceSchedule,
  getChaosFailures, clearChaosState,
} from './particleEngine/chaos'

// ─── Public types ─────────────────────────────────────────────────────────────

export interface Particle {
  id: number              // stable unique ID for color-buffer click picking
  t: number
  speed: number
  color: string
  edgeId: string
  retries: number         // 0 on first spawn; incremented on each retry
  originLatencyMs: number // geographic client→server delay; consumed at first node arrival
  spawnTime: number       // performance.now() at spawn — used for request-edge timeout detection
  payloadBytes: number    // sampled response size this hop carries (log-normal) — egress + inspector
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'  // request edges only — sampled from methodDistribution
  deadLetter?: boolean    // event edges only — true once routed to a DLQ after exhausting retries
  templateId?: number     // custom packet mode — points into the central registry (Flyweight)
}

// ─── Internal state ───────────────────────────────────────────────────────────

interface NodeGlow {
  color: string
  lastActivity: number
  rps: number
}

interface ErrorFlash {
  x: number
  y: number
  startTime: number
}

interface RetryEntry {
  edgeId: string
  color: string
  retries: number   // attempt number this particle is on (1 = first retry)
  fireAt: number    // performance.now() timestamp when it should re-spawn
  deadLetter?: boolean  // event edges: true once rerouted to a DLQ after exhausting retries
  templateId?: number   // carried through so a retried packet keeps its identity (no re-roll)
}

interface EngineState {
  particles: Map<string, Particle[]>
  nodeGlows: Map<string, NodeGlow>
  rafId: number | null
  lastTime: number
  roundRobinIndex: Map<string, number>
  queueDepths: Map<string, number>
  nodeConcurrency: Map<string, number>
  errorFlashes: ErrorFlash[]
}

const state: EngineState = {
  particles: new Map(),
  nodeGlows: new Map(),
  rafId: null,
  lastTime: 0,
  roundRobinIndex: new Map(),
  queueDepths: new Map(),
  nodeConcurrency: new Map(),
  errorFlashes: [],
}

// Retry queue: particles scheduled for re-spawn after backoff delay
const _retryQueue: RetryEntry[] = []

// Color-buffer picking: each particle gets a unique integer ID
let _particleIdCounter = 0
const _particleById = new Map<number, Particle>()

// Latency sample ring buffers (last 200 samples per node)
const _latencyWindows = new Map<string, number[]>()

// Cascade upstream error pressure (decays per frame)
const _upstreamPressure = new Map<string, number>()

// Downstream stall pressure: when a downstream node fails, upstream threads pile up waiting
// → upstream node's effective utilization increases, causing it to saturate and cascade
const _downstreamStallPressure = new Map<string, number>()

// Cumulative drop counts per node since simulation start
const _droppedCounts = new Map<string, number>()

// Cumulative dead-lettered message counts per node (event edges, retries exhausted)
const _deadLetterCounts = new Map<string, number>()

// ─── Live egress bandwidth accounting ────────────────────────────────────────
// Per-node bytes egressed (response payloads) since the last metrics flush. The primary spawn
// loop attributes each particle's sampled payload to its TARGET node — the node that responds.
// Each visual particle stands in for PARTICLE_REQUEST_RATIO real requests (spawn rate = rps /
// ratio), so the measured byte rate is scaled back up by that factor to recover true bandwidth.
const _egressBytesAccum = new Map<string, number>()
let _lastEgressFlushAt = 0
const PARTICLE_REQUEST_RATIO = 10

// ─── Outage playback: particle keyframe buffer ───────────────────────────────
// Records live particle positions as packed Float32Array [edgeIdx, t, edgeIdx, t, …] at the
// metrics cadence (~15fps). The engine owns this heavy buffer (not zustand) to avoid per-tick
// store churn; the 1 Hz health timeline lives in replay.store. Frames are rendered back during
// scrub via the same getEdgePoint() used live, so no separate draw path is needed.
interface ParticleFrame { elapsedS: number; packed: Float32Array }
const _particleFrames: ParticleFrame[] = []
const _edgeIndexMap = new Map<string, number>()   // edgeId → index into _edgePaths
const MAX_PARTICLE_FRAMES = 15 * 300              // ~5 min at 15fps
let _lastReplayIndexDrawn = -1                    // guards redundant replay redraws

// Which nodes were already saturated (for start/end events)
const _saturatedNodes = new Set<string>()

// Stream edges currently in lossless-TCP backpressure (consumer lag exceeded) — tracked
// so the edge_backpressure event only fires once per onset, not every frame.
const _streamBackpressureEdges = new Set<string>()

// ─── Callbacks ────────────────────────────────────────────────────────────────

type OnNodeMetricsBatch = (batch: Map<string, NodeMetrics>) => void
type OnBottleneck  = (nodeId: string, isSaturated: boolean) => void
type OnEvent       = (type: SimEventType, nodeId: string | undefined, message: string, severity: 'info' | 'warn' | 'critical', snapshot?: Partial<NodeMetrics>, causedByNodeId?: string) => void

let _onNodeMetrics: OnNodeMetricsBatch = () => {}
let _onBottleneck:  OnBottleneck  = () => {}
let _onEvent:       OnEvent       = () => {}

export function setCallbacks(
  onNodeMetrics: OnNodeMetricsBatch,
  onBottleneck: OnBottleneck,
  onEvent: OnEvent,
) {
  _onNodeMetrics = onNodeMetrics
  _onBottleneck  = onBottleneck
  _onEvent       = onEvent
}

// ─── EMA smoothing ────────────────────────────────────────────────────────────

const _smoothedMetrics = new Map<string, NodeMetrics>()
const EMA_ALPHA = 0.25

function ema(prev: number, next: number): number {
  return prev + EMA_ALPHA * (next - prev)
}

// ─── Retry delay ─────────────────────────────────────────────────────────────

// attempt is 0-indexed: 0 = first retry, 1 = second, etc.
// full jitter:  random(0, cap)            — AWS recommended; spreads the herd
// equal jitter: cap/2 + random(0, cap/2) — guarantees minimum spacing
function computeRetryDelay(config: RetryConfig, attempt: number): number {
  const cap = config.maxDelayMs ?? Infinity
  const exp = Math.min(cap, config.baseDelayMs * Math.pow(2, attempt))
  return config.jitter === 'full'
    ? Math.random() * exp
    : exp / 2 + Math.random() * (exp / 2)
}

// ─── Request method sampling ──────────────────────────────────────────────────

// Weighted-random pick from a request edge's method distribution. Falls back to GET
// if all weights are zero/invalid.
function pickMethod(dist: RequestEdgeConfig['methodDistribution']): 'GET' | 'POST' | 'PUT' | 'DELETE' {
  const entries: ['GET' | 'POST' | 'PUT' | 'DELETE', number][] = [
    ['GET', dist.GET], ['POST', dist.POST], ['PUT', dist.PUT], ['DELETE', dist.DELETE],
  ]
  const total = entries.reduce((s, [, w]) => s + Math.max(0, w), 0)
  if (total <= 0) return 'GET'
  let r = Math.random() * total
  for (const [method, weight] of entries) {
    r -= Math.max(0, weight)
    if (r <= 0) return method
  }
  return 'GET'
}

// ─── Latency helpers ──────────────────────────────────────────────────────────

function sampleLatencyMs(p50: number, p99: number): number {
  const mu    = Math.log(Math.max(p50, 0.001))
  const sigma = (Math.log(Math.max(p99, p50 + 0.001)) - mu) / 2.326
  const u1    = Math.max(1e-10, Math.random())
  const u2    = Math.random()
  const z     = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  return Math.exp(mu + sigma * z)
}

// ─── Payload sizing ───────────────────────────────────────────────────────────

// Sample a single request's payload size (bytes) from a log-normal distribution centred on
// `meanKb`. Log-normal is used because real traffic clusters around a small mean but has a
// long tail of occasionally huge payloads, and it can never go negative. Returns 0 when the
// node has no configured response size (so unconfigured nodes egress — and cost — nothing).
const PAYLOAD_SIGMA = 0.6  // shape: ~moderate tail (std-dev of the underlying normal, in log space)

function sampleLogNormalPayload(meanKb: number): number {
  if (!(meanKb > 0)) return 0
  const meanBytes = meanKb * 1024
  // For a log-normal, E[X] = exp(mu + sigma^2/2). Solve mu so the mean lands on meanBytes.
  const mu = Math.log(meanBytes) - (PAYLOAD_SIGMA * PAYLOAD_SIGMA) / 2
  const u1 = Math.max(1e-10, Math.random())
  const u2 = Math.random()
  const z  = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  return Math.max(1, Math.round(Math.exp(mu + PAYLOAD_SIGMA * z)))
}

// The response payload a request to `edgeId`'s TARGET node will return — sized by the target's
// configured avgResponseKb (the data it egresses), falling back to the source's. This is what
// the inspector shows and what feeds the target node's egress bandwidth.
function sampleEdgeResponsePayload(edgeId: string): number {
  const edge = _edgesData.find(e => e.id === edgeId)
  const tgt  = edge ? _nodesMap.get(edge.target) : undefined
  const src  = edge ? _nodesMap.get(edge.source) : undefined
  const meanKb = (tgt?.data as NodeData | undefined)?.cost?.avgResponseKb
    ?? (src?.data as NodeData | undefined)?.cost?.avgResponseKb
    ?? 0
  return sampleLogNormalPayload(meanKb)
}

function recordLatency(nodeId: string, ms: number) {
  let window = _latencyWindows.get(nodeId)
  if (!window) { window = []; _latencyWindows.set(nodeId, window) }
  window.push(ms)
  if (window.length > 200) window.splice(0, window.length - 200)
}

// ─── Packet template helpers ──────────────────────────────────────────────────

// Roll a templateId from a node's distribution table by cumulative weight, considering only
// templates whose protocol is compatible with the edge being spawned on (http/db → request,
// event → event, stream → stream). The compatible subset renormalizes automatically, so one
// mixed distribution feeds each outbound edge only its matching slice. Returns undefined when
// no compatible weighted template exists, so the particle falls back to generic sizing.
function rollDistribution(nodeId: string, edgeType: EdgeType): number | undefined {
  const dist = (_nodesMap.get(nodeId)?.data as NodeData | undefined)?.packetDistribution
  if (!dist || dist.length === 0) return undefined
  const eligible = (d: PacketDistributionEntry) => {
    const tpl = _packetTemplates[d.templateId]
    return !!tpl && d.weight > 0 && edgeAcceptsProtocol(edgeType, tpl.protocol)
  }
  let total = 0
  for (const d of dist) if (eligible(d)) total += d.weight
  if (total <= 0) return undefined
  let r = Math.random() * total
  for (const d of dist) {
    if (!eligible(d)) continue
    r -= d.weight
    if (r <= 0) return d.templateId
  }
  return undefined
}

// A template represents a DB write when it's a db query that isn't a plain read, or an HTTP
// method that mutates state. Used to split a node's traffic into read/write lanes.
function templateIsWrite(tpl: PacketTemplate): boolean {
  if (tpl.protocol === 'db') return tpl.queryType !== 'read'
  if (tpl.protocol === 'http') return tpl.method !== 'GET'
  return false
}

// Expected read fraction (0–1) of the traffic a node generates, derived from its weighted packet
// distribution. Lets the DB write-bottleneck reflect the *actual* configured mix instead of an
// edge method slider. Returns undefined when the node has no usable distribution.
function distributionReadFraction(nodeId: string): number | undefined {
  const dist = (_nodesMap.get(nodeId)?.data as NodeData | undefined)?.packetDistribution
  if (!dist || dist.length === 0) return undefined
  // Only templates that ride a request edge (http + db) ever arrive at a DB, so event/stream
  // weights must not skew the read/write split.
  let total = 0, writeW = 0
  for (const d of dist) {
    const tpl = _packetTemplates[d.templateId]
    if (!tpl || d.weight <= 0 || !edgeAcceptsProtocol('request', tpl.protocol)) continue
    total += d.weight
    if (templateIsWrite(tpl)) writeW += d.weight
  }
  if (total <= 0) return undefined
  return 1 - writeW / total
}

// Compression shrinks bytes on the wire — applied to stream-template egress.
function compressionFactor(type: StreamTemplate['compressionType']): number {
  switch (type) {
    case 'gzip':   return 0.3
    case 'snappy': return 0.5
    default:       return 1
  }
}

// Response-payload bytes for a hop, sized from the template (custom mode) or the node's
// avgResponseKb (generic fallback). This is what the target node egresses and what the inspector
// shows. DB targets return resultSizeKb (their result set), not the inbound request size; stream
// templates apply their compression factor. Single source of truth used at every mint site.
function templatePayloadBytes(templateId: number | undefined, targetNodeType: NodeType | undefined, edgeId: string): number {
  const tpl = templateId !== undefined ? _packetTemplates[templateId] : undefined
  if (!tpl) return sampleEdgeResponsePayload(edgeId)
  if ((targetNodeType === 'dbSql' || targetNodeType === 'dbNoSql') && tpl.protocol === 'db') {
    return sampleLogNormalPayload(tpl.resultSizeKb)
  }
  let bytes = sampleLogNormalPayload(tpl.sizeKb)
  if (tpl.protocol === 'stream') bytes *= compressionFactor(tpl.compressionType)
  return Math.max(1, Math.round(bytes))
}

function computePercentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  const i = Math.floor((p / 100) * (sorted.length - 1))
  return sorted[Math.max(0, Math.min(i, sorted.length - 1))]
}

// ─── Color helpers ────────────────────────────────────────────────────────────

function edgeColor(edgeType: string): string {
  switch (edgeType) {
    case 'stream':     return '#A78BFA'
    case 'event':      return '#2DD4BF'
    case 'dependency': return '#475569'
    default:           return '#4A9EFF'
  }
}

function nodeAccentColor(nodeType: NodeType): string {
  const map: Record<string, string> = {
    ec2: '#4A9EFF', lambda: '#4A9EFF', container: '#4A9EFF', pod: '#4A9EFF',
    loadBalancer: '#2DD4BF', apiGateway: '#2DD4BF', cdn: '#2DD4BF',
    dns: '#2DD4BF', firewall: '#2DD4BF', vpn: '#2DD4BF',
    dbSql: '#F5A623', dbNoSql: '#F5A623', objectStorage: '#F5A623', fileStorage: '#F5A623',
    queue: '#A78BFA', eventBus: '#A78BFA', pubsub: '#A78BFA', stream: '#A78BFA',
    redis: '#F5A623', memcached: '#F5A623', cdnCache: '#F5A623',
    k8sCluster: '#4A9EFF', ecsCluster: '#4A9EFF', dockerCompose: '#4A9EFF',
  }
  return map[nodeType] ?? '#4A9EFF'
}

// ─── Edge path data ───────────────────────────────────────────────────────────

interface EdgePath {
  id: string
  edgeType: string
  sourceNodeType?: NodeType
  targetNodeType?: NodeType
  rps: number
  geoLatencyMs: number  // inter-region hop penalty; 0 for same-region or no region tags
  effectiveRps?: number // live actual RPS flowing over this edge, updated every frame
}

let _edgePaths: EdgePath[] = []
let _speed = 1
let _trafficMode: TrafficMode = 'steady'
let _globalMultiplier = 1
let _nodeConfigs: Map<string, NodeSimConfig> = new Map()
let _nodeProviders: Map<string, CloudProvider> = new Map()
let _nodesMap: Map<string, Node<NodeData>> = new Map()
let _edgesData: Edge<EdgeData>[] = []
let _simStartTime = 0

// ─── Packet registry mirror (Flyweight) ──────────────────────────────────────
// Snapshotted from canvas.store at startSimulation so the hot loop never touches React state.
// Generic mode → empty/ignored; custom mode → templates drive size, DB query-type, status, etc.
let _packetMode: PacketMode = 'generic'
let _packetTemplates: Record<number, PacketTemplate> = {}

// Per-node client-error (4xx) tally since sim start — surfaced through the node's errorRate.
const _clientErrorCounts = new Map<string, number>()

// ─── Simulation clock ─────────────────────────────────────────────────────────
// Monotonic simulation time, accumulated frame-by-frame as `delta * _speed` ONLY while the
// engine actually processes a frame. Unlike performance.now(), this is immune to: pausing (no
// delta added while paused), speed changes (scaled by _speed), and lag spikes / delta-clamping
// (it tracks the exact ms of logic processed, not real-world time). All simulation-relative
// timing — replay timeline, traffic ramp, egress bandwidth window — reads from this, never the
// wall clock. (Frame-delta baselines and inter-frame scheduling still use performance.now().)
let _simulatedTimeMs = 0

// In-flight request counter used by LAC load balancer routing
const _lbActiveRequests = new Map<string, number>()

// Tracks which downstream node is the proven cause of each upstream node's stall pressure
// Used to attach definitive causedByNodeId to saturation and circuit-open events
const _stallSources = new Map<string, string>()  // upstreamNodeId → downstreamNodeId

// Node health state — written each metrics cycle, read by particle arrival handler
const _nodeHealthStates = new Map<string, 'healthy' | 'degraded' | 'down'>()
// Recovery hysteresis: timestamp before which a 'down' node cannot jump straight to 'healthy'
const _recoveryUntil    = new Map<string, number>()
const HEALTH_RECOVERY_LOCK_MS = 8_000  // 8s minimum in 'degraded' after exiting 'down'

// Lambda warm instance tracking (7b) — state lives in backpressure.ts; this constant governs
// the idle-expiry check at the call site.
const LAMBDA_WARM_IDLE_MS = 5 * 60 * 1000           // 5 min idle = cold

// K8s / ECS auto-scale state (7g)
const _currentCapacity  = new Map<string, number>()  // nodeId → current effective maxRps
const _scaleOutPending  = new Map<string, number>()  // nodeId → timestamp when scale completes
const _scaleInCooldown  = new Map<string, number>()  // nodeId → earliest scale-in time
const _restartCounts    = new Map<string, number>()  // nodeId → crash-loop restart count
const _restartCooldown  = new Map<string, number>()  // nodeId → next allowed restart time

// ─── Database read/write saturation tracking ─────────────────────────────────
const _dbSaturationReason = new Map<string, 'read' | 'write'>()

// ─── K8s hierarchy state ──────────────────────────────────────────────────────
// Per-pod HPA replica state — starts at k8sPod.replicas, modified by HPA logic.
const _podReplicas          = new Map<string, number>()
// Real-time RPS consumed by pods per namespace/cluster (updated end of each metrics tick).
const _namespaceConsumedRps = new Map<string, number>()
const _clusterConsumedRps   = new Map<string, number>()
// Throttle events — only emit once until the condition clears.
const _quotaConstrainedNodes  = new Set<string>()
const _clusterExhaustedNodes  = new Set<string>()
const _hpaBlockedNodes        = new Set<string>()

// Cache DOM elements per frame
const _pathElCache  = new Map<string, SVGPathElement | null>()
const _nodeElCache  = new Map<string, Element | null>()
let _canvasRect: DOMRect | null = null

// ─── DOM helpers ──────────────────────────────────────────────────────────────

// Determines whether a particle represents a DB read (vs write) using its stable ID modulo.
// Mirrors the `seed = p.id % 97` pattern in buildSnapshot for consistent method labelling.
function isReadParticle(particleId: number, edgeReadPct: number): boolean {
  return (particleId % 100) < Math.round(edgeReadPct * 100)
}

// Walk the parentId ancestor chain to find the nearest namespace and cluster containers.
// Used for K8s quota enforcement, CNI latency, and blast-radius cascades.
function resolveK8sParents(nodeId: string): { namespaceId?: string; clusterId?: string } {
  let namespaceId: string | undefined
  let clusterId: string | undefined
  let cur = _nodesMap.get(nodeId)
  while (cur?.parentId) {
    cur = _nodesMap.get(cur.parentId)
    if (!cur) break
    const t = cur.type as NodeType
    if (t === 'namespace' && !namespaceId) namespaceId = cur.id
    if ((t === 'k8sCluster' || t === 'ecsCluster' || t === 'dockerCompose') && !clusterId) clusterId = cur.id
  }
  return { namespaceId, clusterId }
}

function clearCaches() {
  _pathElCache.clear()
  _nodeElCache.clear()
}

function getNodeCanvasRect(nodeId: string): [number, number, number, number] | null {
  let el = _nodeElCache.get(nodeId)
  if (el === undefined) {
    el = document.querySelector(`[data-id="${nodeId}"]`) ?? null
    _nodeElCache.set(nodeId, el)
  }
  if (!el || !_canvasRect) return null
  const r = el.getBoundingClientRect()
  return [r.left - _canvasRect.left, r.top - _canvasRect.top, r.width, r.height]
}

function getEdgePoint(edgeId: string, t: number): [number, number] | null {
  let el = _pathElCache.get(edgeId)
  if (el === undefined) {
    el = document.getElementById(edgeId) as SVGPathElement | null
    _pathElCache.set(edgeId, el)
  }
  if (!el || !_canvasRect) return null
  try {
    const len = el.getTotalLength()
    if (!len) return null
    const pt  = el.getPointAtLength(t * len)
    const ctm = el.getScreenCTM()
    if (!ctm) return null
    return [ctm.a * pt.x + ctm.c * pt.y + ctm.e - _canvasRect.left,
            ctm.b * pt.x + ctm.d * pt.y + ctm.f - _canvasRect.top]
  } catch {
    return null
  }
}

// ─── Canvas drawing helpers ───────────────────────────────────────────────────

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y,     x + w, y + r,     r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x,     y + h, x,       y + h - r, r)
  ctx.lineTo(x,     y + r)
  ctx.arcTo(x,     y,     x + r,   y,         r)
  ctx.closePath()
}

// ─── Config helpers ───────────────────────────────────────────────────────────

function effectiveConfig(nodeId: string, nodeType: NodeType): NodeSimConfig {
  const defaults = NODE_SIM_DEFAULTS[nodeType] ?? { maxRps: 1000, processingMs: 10, errorRate: 0 }
  // 3-way merge: generic defaults < cloud-provider presets < explicit user override.
  const provider = _nodeProviders.get(nodeId)
  const cloud = provider && provider !== 'generic'
    ? CLOUD_REGISTRY[nodeType]?.[provider]?.simDefaults
    : undefined
  const override = _nodeConfigs.get(nodeId)
  if (!cloud && !override) return defaults
  return { ...defaults, ...cloud, ...override }
}

// ─── Geographic origin latency sampling ───────────────────────────────────────

// Weighted-random sample from a node's trafficOrigins distribution
// Returns the latency offset to tag the spawned particle with
const ENTRY_POINT_TYPES = new Set<string>(['cdn', 'loadBalancer', 'apiGateway'])

function sampleOriginLatency(sourceNodeId: string, sourceNodeType: NodeType): number {
  if (!ENTRY_POINT_TYPES.has(sourceNodeType)) return 0
  const config  = effectiveConfig(sourceNodeId, sourceNodeType)
  const origins = config.trafficOrigins
  if (!origins || origins.length === 0) return 0
  let cumulative = 0
  const r = Math.random()
  for (const origin of origins) {
    cumulative += origin.weight
    if (r <= cumulative) return origin.baseLatencyMs
  }
  return origins[origins.length - 1].baseLatencyMs
}

// ─── Traffic mode: effective spawn multiplier ─────────────────────────────────
// Delegates to chaos.ts (split further in Warning doc W2 / #5 -- pure read vs. impure schedule
// advance, code motion only from the Task 0 split, no behavior change beyond call-site cadence).
// now = wall-clock-ish rAF timestamp (drives spike/chaos timers, unchanged from before the
// split); _simulatedTimeMs = pause/speed-immune sim clock (drives the ramp branch only) --
// these are two different clocks in the original code and must stay that way here.

// Pure — safe to call any number of times per frame (spawnParticles, updateAllNodeMetrics, and
// per-arrival glow calculations in handleParticleArrival all read through this).
function effectiveMultiplier(now: number): number {
  return chaosTrafficMultiplier(now, _trafficMode, _globalMultiplier, _simulatedTimeMs, _nodesMap)
}

// Impure — advances chaos/spike schedule state and emits chaos_failure/chaos_recovery events.
// Must be called exactly once per frame, from loop(), before spawnParticles runs.
function advanceChaosSchedule(now: number): void {
  chaosAdvanceSchedule(now, _trafficMode, _simulatedTimeMs, _nodesMap, _onEvent)
}

// ─── Circuit breaker helpers ──────────────────────────────────────────────────
// Delegates to circuitBreakers.ts (moved there in Task 0 -- pure code motion, no behavior change).

function recordBreakerResultLocal(edgeId: string, isError: boolean, config: NodeSimConfig, now: number) {
  recordBreakerResult(edgeId, isError, config, now, _edgesData, _nodesMap, _upstreamPressure, _stallSources, _onEvent)
}

function checkBreakerTransitionLocal(edgeId: string, config: NodeSimConfig, now: number): CircuitState {
  return checkBreakerTransition(edgeId, config, now, _edgesData, _nodesMap, _nodeHealthStates, _onEvent)
}

// ─── Health helpers ───────────────────────────────────────────────────────────

// 0.0 at the healthy/degraded boundary (score=0.84), 1.0 at the degraded/down boundary (score=0.50)
function degradedDepth(score: number): number {
  return Math.max(0, Math.min(1, (0.84 - score) / (0.84 - 0.50)))
}

// processingMs multiplier for degraded nodes — 1.0× at entry, 2.0× at the bottom of degraded
function effectiveProcessingMs(nodeId: string, config: NodeSimConfig): number {
  const base = Math.max(1, config.processingMs)
  if (_nodeHealthStates.get(nodeId) !== 'degraded') return base
  const prevScore = _smoothedMetrics.get(nodeId)?.healthScore ?? 0.67
  return base * (1 + degradedDepth(prevScore))  // 1×–2× proportional to depth
}

// ─── LAC in-flight tracking ──────────────────────────────────────────────────

// Routers and accumulators: not counted as backends for LAC routing
const _LB_SKIP_TYPES = new Set<string>(['loadBalancer', 'apiGateway', 'queue', 'eventBus', 'pubsub', 'stream'])

// Nodes exempt from inbound-RPS gating: queue-like types drain from queue depth, not live inbound traffic.
// LBs and API Gateways are intentionally NOT in this set — they should be gated by their own inbound traffic.
const _INBOUND_GATE_EXEMPT_TYPES = new Set<string>(['queue', 'eventBus', 'pubsub', 'stream'])

// Node types that model a traditional thread pool: slow downstream holds a thread, blocking new requests
const THREAD_POOL_TYPES = new Set<string>(['ec2', 'container', 'pod', 'k8sCluster', 'ecsCluster'])

function trackRequest(nodeId: string, nodeType: NodeType, config: NodeSimConfig) {
  if (_LB_SKIP_TYPES.has(nodeType) || GROUPING_TYPES.has(nodeType)) return
  _lbActiveRequests.set(nodeId, (_lbActiveRequests.get(nodeId) ?? 0) + 1)
  scheduleGenericRelease(nodeId, Math.max(50, effectiveProcessingMs(nodeId, config)), _simulatedTimeMs, () => {
    _lbActiveRequests.set(nodeId, Math.max(0, (_lbActiveRequests.get(nodeId) ?? 1) - 1))
  })
}

// ─── Spawning ────────────────────────────────────────────────────────────────

const PARTICLE_SPEED_BASE = 0.0006
const MAX_PARTICLES = 500

function spawnParticles(now: number, delta: number) {
  let total = 0
  for (const arr of state.particles.values()) total += arr.length
  // Gates only the visual particle-minting step below, never the effectiveRps bookkeeping loop —
  // under sustained overload the per-edge rate math must keep running every frame so inRps/outRps/
  // utilization/queue-depth integration (all of which read ep.effectiveRps) keep tracking offered
  // load instead of freezing at their last pre-cap value.
  const atCap = total >= MAX_PARTICLES

  const mult = effectiveMultiplier(now)

  for (const ep of _edgePaths) {
    // Dependency edges are static health links — they never carry traffic.
    if (ep.edgeType === 'dependency') continue

    // Suppress downstream spawning when the source node has failed or tripped its circuit breaker.
    // Models: a dead or circuit-open node can't forward traffic, so its outbound edges go dark.
    const sourceNodeId = _edgesData.find(e => e.id === ep.id)?.source
    let downstreamFactor = 1.0
    if (sourceNodeId) {
      const chaosEntry = getChaosFailures().get(sourceNodeId)
      if (_nodeHealthStates.get(sourceNodeId) === 'down') {
        downstreamFactor = 0
      } else if (chaosEntry) {
        // crash: completely dark; latency: near-zero forwarding; partial: reduced proportionally
        downstreamFactor = chaosEntry.mode === 'crash' ? 0
          : chaosEntry.mode === 'latency' ? 0.05
          : Math.max(0, 1 - chaosEntry.dropRate)
        // Stall pressure compounds on top of chaos for non-request edges only;
        // request-edge backpressure is handled by the thread pool gate below.
        if (downstreamFactor > 0 && ep.edgeType !== 'request' && _saturatedNodes.has(sourceNodeId)) {
          const stall = _downstreamStallPressure.get(sourceNodeId) ?? 0
          downstreamFactor = Math.max(0, downstreamFactor * Math.max(0.1, 1 - stall * 0.8))
        }
      } else {
        const breaker = getBreaker(ep.id)
        if (breaker?.state === 'open' && ep.edgeType !== 'event' && ep.edgeType !== 'stream') {
          downstreamFactor = 0         // circuit open: no traffic; periodic scan handles probing
        } else if (breaker?.state === 'half-open' && ep.edgeType !== 'event' && ep.edgeType !== 'stream') {
          downstreamFactor = 0.1       // probe rate: small trickle tests recovery
        } else if (ep.edgeType !== 'request' && _saturatedNodes.has(sourceNodeId)) {
          // Partial degradation: saturated node forwards at reduced rate (stream/event edges only)
          const stall = _downstreamStallPressure.get(sourceNodeId) ?? 0
          downstreamFactor = Math.max(0.1, 1 - stall * 0.8)
        }
      }
    }

    // Inbound-driven gating: suppress outbound only when a transit node is genuinely receiving
    // zero (or near-zero) traffic. A server getting no requests makes no DB calls.
    // Uses a small fixed RPS threshold so the gate fully opens at any meaningful traffic level —
    // NOT a utilization ratio (which would wrongly starve outbound on low-util but active nodes).
    // Excluded: pure source nodes (no inbound edges), LBs/gateways/queues, nodes not yet in metrics.
    const IDLE_RPS_THRESHOLD = 5  // below this the node is considered effectively idle
    if (downstreamFactor > 0 && sourceNodeId && ep.sourceNodeType
        && !_INBOUND_GATE_EXEMPT_TYPES.has(ep.sourceNodeType)) {
      const hasInbound = _edgesData.some(e => e.target === sourceNodeId)
      if (hasInbound) {
        // Treat missing metrics as 0 RPS (simulation just started) rather than skipping the gate.
        // Without this, all downstream nodes fire at 100% for the first metrics cycle (~200ms).
        const inRps = _smoothedMetrics.get(sourceNodeId)?.inRps ?? 0
        if (inRps < IDLE_RPS_THRESHOLD) {
          // Soft fade: 0 RPS → 0%, 5 RPS → 100%. Saturates immediately above the threshold.
          downstreamFactor *= inRps / IDLE_RPS_THRESHOLD
        }
        // Above the threshold: no scaling — configured outbound flows freely.
      }
    }

    // Queue backpressure: reduce spawn rate exponentially once queue depth exceeds 80% capacity.
    // Models TCP flow control for traditional queues — NOT applied to stream edges (Kafka/Kinesis)
    // because those brokers accept producer data immediately; consumer lag is tracked separately.
    if (downstreamFactor > 0 && ep.targetNodeType && ep.edgeType !== 'stream' &&
        ['queue', 'pubsub', 'eventBus'].includes(ep.targetNodeType)) {
      const tgtId  = _edgesData.find(e => e.id === ep.id)?.target
      const tgtCap = tgtId ? (effectiveConfig(tgtId, ep.targetNodeType as NodeType).queueCapacity ?? 1000) : 1000
      const depth  = tgtId ? (state.queueDepths.get(tgtId) ?? 0) : 0
      const ratio  = depth / tgtCap
      if (ratio > 0.8) {
        const backpressure = Math.pow((ratio - 0.8) / 0.2, 2)
        downstreamFactor *= Math.max(0, 1 - backpressure)
      }
    }

    // Lossless (TCP-style) data stream edges: once the target's queue depth exceeds the
    // configured consumer lag threshold, the edge enters backpressure — spawning halts
    // entirely, which causes the source to saturate its own worker threads (cascading
    // upstream just like a stalled downstream dependency).
    if (downstreamFactor > 0 && ep.edgeType === 'stream' && ep.targetNodeType
        && ['queue', 'pubsub', 'eventBus', 'stream'].includes(ep.targetNodeType)) {
      const streamConfig = (_edgesData.find(e => e.id === ep.id)?.data as EdgeData | undefined)?.config as StreamEdgeConfig | undefined
      if (streamConfig?.streamType === 'lossless_tcp') {
        const tgtId = _edgesData.find(e => e.id === ep.id)?.target
        const depth = tgtId ? (state.queueDepths.get(tgtId) ?? 0) : 0
        if (depth > streamConfig.maxConsumerLag) {
          downstreamFactor = 0
          if (!_streamBackpressureEdges.has(ep.id)) {
            _streamBackpressureEdges.add(ep.id)
            const tgtLabel = tgtId ? ((_nodesMap.get(tgtId)?.data as NodeData)?.label ?? tgtId) : ep.id
            _onEvent('edge_backpressure', tgtId, `${tgtLabel} consumer lag exceeded — stream backpressure engaged`, 'warn')
          }
          if (sourceNodeId) {
            const existing = _downstreamStallPressure.get(sourceNodeId) ?? 0
            _downstreamStallPressure.set(sourceNodeId, Math.min(1, existing + 0.05))
            _stallSources.set(sourceNodeId, tgtId ?? ep.id)
          }
        } else if (_streamBackpressureEdges.has(ep.id)) {
          _streamBackpressureEdges.delete(ep.id)
        }
      }
    }

    // Consumer-edge gating: an edge whose SOURCE is a queue-type node models that queue's
    // consumer draining it — it must not spawn traffic "from nothing." Without this gate the
    // edge free-runs at its own configured RPS regardless of what (if anything) has actually
    // arrived in the queue, so a queue with zero producers still emits consumer-side traffic.
    // Minimum-viable fix per issue #6: hard-gate on depth <= 0, zeroing effectiveRps explicitly
    // (not freezing it — consistent with C3's "always write effectiveRps" bookkeeping fix) rather
    // than modeling full delivery-guarantee semantics (dedup, differentiated redelivery), which is
    // out of scope here.
    if (downstreamFactor > 0 && sourceNodeId && ep.sourceNodeType
        && ['queue', 'pubsub', 'eventBus', 'stream'].includes(ep.sourceNodeType)) {
      const depth = state.queueDepths.get(sourceNodeId) ?? 0
      if (depth <= 0) {
        ep.effectiveRps = 0
        continue
      }
    }

    const rps = ep.rps * mult * downstreamFactor
    ep.effectiveRps = rps
    const particlesPerSec = rps / PARTICLE_REQUEST_RATIO
    const spawnChance = particlesPerSec * (delta / 1000) * _speed
    const n = Math.floor(spawnChance) + (Math.random() < (spawnChance % 1) ? 1 : 0)
    if (n === 0) continue

    // Visual particle cap: effectiveRps bookkeeping above always runs; only the actual minting
    // of Particle objects (and the thread-pool acquisition that models their in-flight cost) is
    // skipped once the global visual cap is reached, so the canvas never renders/animates more
    // than MAX_PARTICLES concurrent particles regardless of how far offered load exceeds it.
    if (atCap) continue

    // Thread pool gate: request edges on compute source nodes must acquire a worker thread per
    // particle actually minted below — NOT once per batch requesting `n`. Acquiring here would let
    // `acquireWorkers` admit up to `n` slots while the per-particle loop below may mint fewer than
    // `n` (MAX_PARTICLES global cap truncating mid-batch), leaking the difference forever since no
    // particle/arrival exists for the un-minted slots to ever release. See issue #4.
    const isThreadPoolEdge = ep.edgeType === 'request' && !!sourceNodeId && !!ep.sourceNodeType && THREAD_POOL_TYPES.has(ep.sourceNodeType)
    const maxThreads = isThreadPoolEdge
      ? effectiveConfig(sourceNodeId!, ep.sourceNodeType as NodeType).maxConcurrency ?? 200
      : 0

    if (!state.particles.has(ep.id)) state.particles.set(ep.id, [])
    const arr = state.particles.get(ep.id)!
    // Sample geographic origin latency for entry-point source nodes
    const originLatencyMs = sourceNodeId && ep.sourceNodeType
      ? sampleOriginLatency(sourceNodeId, ep.sourceNodeType)
      : 0
    // Slow particles visually based on geographic latency:
    //   0ms → 1.0× (full speed)  |  80ms → ~0.56×  |  175ms → ~0.36×  |  500ms+ → 0.1× (floor)
    // Both origin latency (client distance) and edge geo latency (inter-region hop) contribute.
    const geoSpeedFactor = Math.max(0.1, 1 / (1 + (originLatencyMs + ep.geoLatencyMs) / 100))
    const reqConfig = ep.edgeType === 'request'
      ? (_edgesData.find(e => e.id === ep.id)?.data as EdgeData | undefined)?.config as RequestEdgeConfig | undefined
      : undefined
    const targetNodeId = _edgesData.find(e => e.id === ep.id)?.target
    for (let i = 0; i < n && total < MAX_PARTICLES; i++) {
      // Acquire exactly one thread-pool worker per particle actually minted, after the
      // MAX_PARTICLES cap check above — 1:1 with the scheduleWorkerRelease call each minted
      // particle's arrival handler later makes. Reject overflow explicitly (fast-fail 503-style
      // drop) instead of silently under-acquiring and minting anyway.
      if (isThreadPoolEdge) {
        const admitted = acquireWorkers(sourceNodeId!, 1, maxThreads)
        if (admitted === 0) {
          spawnErrorFlash(sourceNodeId!)
          _droppedCounts.set(sourceNodeId!, (_droppedCounts.get(sourceNodeId!) ?? 0) + 1)
          continue
        }
      }

      const pid = ++_particleIdCounter
      // Custom mode: roll a templateId once from this edge's source-node distribution. The
      // template then drives payload size, particle colour, and (for HTTP) the method.
      const templateId = _packetMode === 'custom' && sourceNodeId ? rollDistribution(sourceNodeId, ep.edgeType as EdgeType) : undefined
      const tpl = templateId !== undefined ? _packetTemplates[templateId] : undefined
      const payloadBytes = templatePayloadBytes(templateId, ep.targetNodeType, ep.id)
      const httpTpl = tpl?.protocol === 'http' ? tpl as HttpTemplate : undefined
      const p: Particle = {
        id: pid,
        t: 0,
        speed: PARTICLE_SPEED_BASE * (0.8 + Math.random() * 0.4) * geoSpeedFactor,
        color: tpl?.colorOverride ?? edgeColor(ep.edgeType),
        edgeId: ep.id,
        retries: 0,
        originLatencyMs,
        spawnTime: now,
        payloadBytes,
        method: httpTpl ? httpTpl.method : (reqConfig ? pickMethod(reqConfig.methodDistribution) : undefined),
        templateId,
      }
      arr.push(p)
      _particleById.set(pid, p)
      // Attribute this hop's response bytes to the node that serves it (its egress).
      if (targetNodeId) _egressBytesAccum.set(targetNodeId, (_egressBytesAccum.get(targetNodeId) ?? 0) + payloadBytes)
      total++
    }
  }
}

// Request edge timeout handler — fired when a request particle exceeds the edge's
// configured timeoutMs before reaching its target. Treated as a client-side 504:
// the source's worker thread is freed, error pressure rises, and the edge's circuit
// breaker records the failure (same as a hard drop).
function handleRequestTimeout(ep: EdgePath, now: number, _particle: Particle) {
  const edgeData    = _edgesData.find(e => e.id === ep.id)
  const sourceNodeId = edgeData?.source
  const targetNodeId = edgeData?.target

  if (sourceNodeId) {
    spawnErrorFlash(sourceNodeId)
    _droppedCounts.set(sourceNodeId, (_droppedCounts.get(sourceNodeId) ?? 0) + 1)

    const srcType   = _nodesMap.get(sourceNodeId)?.type as NodeType | undefined
    const srcMaxRps = srcType ? effectiveConfig(sourceNodeId, srcType).maxRps : 1000
    const perParticle = Math.max(0.002, 10 / Math.max(10, srcMaxRps))
    const existing = _upstreamPressure.get(sourceNodeId) ?? 0
    _upstreamPressure.set(sourceNodeId, Math.min(1, existing + perParticle))

    if (ep.sourceNodeType && THREAD_POOL_TYPES.has(ep.sourceNodeType)) {
      releaseWorkerNow(sourceNodeId)
    }

    const srcLabel = (_nodesMap.get(sourceNodeId)?.data as NodeData)?.label ?? sourceNodeId
    _onEvent('request_timeout', sourceNodeId, `${srcLabel} request timed out (504)`, 'warn', undefined, targetNodeId)
  }

  if (targetNodeId) {
    const targetType = _nodesMap.get(targetNodeId)?.type as NodeType | undefined
    const config = targetType ? effectiveConfig(targetNodeId, targetType) : null
    if (config) recordBreakerResultLocal(ep.id, true, config, now)
  }
}

// ─── Particle arrival / node behavior ────────────────────────────────────────

function dropParticle(ep: EdgePath, targetNodeId: string, particle?: Particle) {
  spawnErrorFlash(targetNodeId)
  _droppedCounts.set(targetNodeId, (_droppedCounts.get(targetNodeId) ?? 0) + 1)

  const sourceNodeId = _edgesData.find(e => e.id === ep.id)?.source
  if (sourceNodeId) {
    // Normalize increments by the source node's capacity so a 10k-RPS node doesn't spike
    // in a single frame the same way a 100-RPS node does. Each dropped particle represents
    // 10 RPS worth of blocked capacity; dividing by maxRps gives the fractional load impact.
    const srcType   = _nodesMap.get(sourceNodeId)?.type as NodeType | undefined
    const srcMaxRps = srcType ? effectiveConfig(sourceNodeId, srcType).maxRps : 1000
    const perParticle = Math.max(0.002, 10 / Math.max(10, srcMaxRps))

    // Error pressure → raises source's error rate
    const existing = _upstreamPressure.get(sourceNodeId) ?? 0
    const newPressure = Math.min(1, existing + perParticle)
    _upstreamPressure.set(sourceNodeId, newPressure)

    // Stall pressure → raises source's effective utilization for stream/event edges only.
    // Request edges use the thread pool model: the worker is released immediately on drop
    // (fast-fail 503), so no scalar pressure is needed — cascade happens via thread exhaustion.
    if (ep.edgeType !== 'request') {
      const stallIncrement = perParticle * (_nodeHealthStates.get(targetNodeId) === 'down' ? 2.5 : 1.0)
      const existingStall = _downstreamStallPressure.get(sourceNodeId) ?? 0
      _downstreamStallPressure.set(sourceNodeId, Math.min(1, existingStall + stallIncrement))
      _stallSources.set(sourceNodeId, targetNodeId)
    }

    // Release the source's worker thread immediately — a 503/rejection is a fast response,
    // so the thread is freed right away (unlike a slow success that holds it for latency ms).
    if (ep.edgeType === 'request' && ep.sourceNodeType && THREAD_POOL_TYPES.has(ep.sourceNodeType)) {
      releaseWorkerNow(sourceNodeId)
    }

    // Emit cascade event once pressure is significant
    // causedByNodeId = targetNodeId is provably correct: the drop on this edge IS the cascade
    if (newPressure > 0.2 && _saturatedNodes.has(targetNodeId)) {
      const srcNode  = _nodesMap.get(sourceNodeId)
      const tgtNode  = _nodesMap.get(targetNodeId)
      const srcLabel = srcNode ? (srcNode.data as NodeData).label ?? sourceNodeId : sourceNodeId
      const tgtLabel = tgtNode ? (tgtNode.data as NodeData).label ?? targetNodeId : targetNodeId
      _onEvent('cascade_detected', sourceNodeId, `${srcLabel} → ${tgtLabel} cascade`, 'critical', undefined, targetNodeId)
    }
  }

  // Event edges have their own retry/DLQ model — handle separately and exit early.
  if (particle && ep.edgeType === 'event') {
    handleEventEdgeRetry(ep, targetNodeId, particle)
    return
  }

  // Schedule retry with exponential backoff + jitter. Request edges own their full retry
  // config (edge-level only — no node fallback). All other edge types still fall back to
  // the target node's retryConfig (e.g. stream-edge drops).
  if (particle) {
    let rc: RetryConfig | undefined
    if (ep.edgeType === 'request') {
      const reqConfig = (_edgesData.find(e => e.id === ep.id)?.data as EdgeData | undefined)?.config as RequestEdgeConfig | undefined
      rc = reqConfig?.retryConfig
    } else {
      const targetNode = _nodesMap.get(targetNodeId)
      const targetType = targetNode?.type as NodeType | undefined
      const config = targetType ? effectiveConfig(targetNodeId, targetType) : null
      rc = config?.retryConfig
    }
    if (rc && rc.maxRetries > 0 && particle.retries < rc.maxRetries) {
      // If the source of this edge is a LB/gateway, re-route the retry through the LB pool
      // instead of blindly retrying on the same failing edge — avoids hammering dead backends
      let retryEdgeId = ep.id
      const sourceType = sourceNodeId ? (_nodesMap.get(sourceNodeId)?.type as string | undefined) : undefined
      if (sourceNodeId && (sourceType === 'loadBalancer' || sourceType === 'apiGateway')) {
        const lbOutEdges = _edgePaths.filter(e =>
          _edgesData.find(d => d.id === e.id)?.source === sourceNodeId,
        )
        const healthyEdges = lbOutEdges.filter(e => {
          const tgtId = _edgesData.find(d => d.id === e.id)?.target
          return getBreaker(e.id)?.state !== 'open'
            && (tgtId === undefined || _nodeHealthStates.get(tgtId) !== 'down')
        })
        const pool = healthyEdges.length > 0 ? healthyEdges : lbOutEdges
        if (pool.length > 0) {
          retryEdgeId = pool[Math.floor(Math.random() * pool.length)].id
        }
      }
      _retryQueue.push({
        edgeId: retryEdgeId,
        color: particle.color,
        retries: particle.retries + 1,
        fireAt: performance.now() + computeRetryDelay(rc, particle.retries) / _speed,
        templateId: particle.templateId,
      })
    }
  }
}

// Event edge delivery: retries with edge-configured backoff up to maxDeliveryRetries.
// Once exhausted, the message is dead-lettered — counted on the target node, and if
// deadLetterRouting points at a real outbound edge from the target, rerouted onto it
// with a dark "burnt" color marking it as a dead letter.
function handleEventEdgeRetry(ep: EdgePath, targetNodeId: string, particle: Particle) {
  const evConfig   = (_edgesData.find(e => e.id === ep.id)?.data as EdgeData | undefined)?.config as EventEdgeConfig | undefined
  const rc         = evConfig?.retryConfig ?? DEFAULT_EVENT_EDGE_CONFIG.retryConfig
  const maxRetries = rc.maxRetries
  const backoff    = evConfig?.retryBackoff ?? 'exponential'

  if (particle.retries < maxRetries) {
    let delayMs: number
    switch (backoff) {
      case 'immediate':   delayMs = 50; break
      case 'linear': {
        const raw = rc.baseDelayMs * (particle.retries + 1)
        delayMs = rc.maxDelayMs ? Math.min(rc.maxDelayMs, raw) : raw
        break
      }
      case 'exponential': delayMs = computeRetryDelay(rc, particle.retries); break
    }
    _retryQueue.push({
      edgeId: ep.id,
      color: particle.color,
      retries: particle.retries + 1,
      fireAt: performance.now() + delayMs / _speed,
      templateId: particle.templateId,
    })
    return
  }

  // Retries exhausted — dead letter
  _deadLetterCounts.set(targetNodeId, (_deadLetterCounts.get(targetNodeId) ?? 0) + 1)
  const tgtLabel = (_nodesMap.get(targetNodeId)?.data as NodeData)?.label ?? targetNodeId
  _onEvent('dead_letter', targetNodeId, `${tgtLabel} dead-lettered after ${maxRetries} retr${maxRetries === 1 ? 'y' : 'ies'}`, 'critical')

  if (evConfig?.deadLetterRouting && evConfig.deadLetterTargetId) {
    const dlqEdge = _edgePaths.find(e => {
      const d = _edgesData.find(x => x.id === e.id)
      return d?.source === targetNodeId && d?.target === evConfig!.deadLetterTargetId
    })
    if (dlqEdge) {
      _retryQueue.push({
        edgeId: dlqEdge.id,
        color: '#7F1D1D',
        retries: 0,
        fireAt: performance.now() + 50 / _speed,
        deadLetter: true,
        templateId: particle.templateId,
      })
    }
  }
}

function handleParticleArrival(ep: EdgePath, now: number, particle: Particle) {
  if (!ep.targetNodeType) return
  const targetNodeType = ep.targetNodeType
  const edgeData       = _edgesData.find(e => e.id === ep.id)
  const targetNodeId   = edgeData?.target
  const sourceNodeId   = edgeData?.source
  if (!targetNodeId) return

  // Update ambient glow
  const totalInRps = _edgePaths
    .filter(e => _edgesData.find(d => d.id === e.id)?.target === targetNodeId)
    .reduce((s, e) => s + e.rps, 0) * effectiveMultiplier(now)

  state.nodeGlows.set(targetNodeId, {
    color: nodeAccentColor(targetNodeType),
    lastActivity: now,
    rps: totalInRps,
  })

  // Hard gate: down nodes reject everything — bypasses circuit breaker timing windows
  if (_nodeHealthStates.get(targetNodeId) === 'down') {
    dropParticle(ep, targetNodeId, particle)
    return
  }

  // K8s namespace network policy: 'strict' drops traffic originating outside this namespace.
  if (targetNodeType === 'pod' && sourceNodeId) {
    const tgtParents = resolveK8sParents(targetNodeId)
    if (tgtParents.namespaceId) {
      const nsConfig = effectiveConfig(tgtParents.namespaceId, 'namespace')
      if (nsConfig.k8sNamespace?.networkPolicy === 'strict') {
        const srcParents = resolveK8sParents(sourceNodeId)
        if (srcParents.namespaceId !== tgtParents.namespaceId) {
          dropParticle(ep, targetNodeId, particle)
          return
        }
      }
    }
  }

  const config = effectiveConfig(targetNodeId, targetNodeType)

  // Chaos failure: mode-specific drop rate, feeds circuit breakers so they trip naturally
  const chaosEntry = getChaosFailures().get(targetNodeId)
  if (chaosEntry && Math.random() < chaosEntry.dropRate) {
    recordBreakerResultLocal(ep.id, true, config, now)
    dropParticle(ep, targetNodeId, particle)
    return
  }

  // Degraded health: proportional random drop — 2% at threshold entry, 15% deep in degraded
  // Models CPU throttling / resource starvation causing partial request shedding
  if (_nodeHealthStates.get(targetNodeId) === 'degraded') {
    const prevScore = _smoothedMetrics.get(targetNodeId)?.healthScore ?? 0.67
    const depth     = degradedDepth(prevScore)
    const dropRate  = 0.02 + depth * 0.13
    if (Math.random() < dropRate) {
      dropParticle(ep, targetNodeId, particle)
      return
    }
  }

  // Packet template status code (custom mode, HTTP): 5xx = server failure → drop (retry/error
  // pressure via dropParticle); 4xx = client error → the request reached the server and got a
  // response, so it completes but is tallied into the node's error rate. 2xx/3xx fall through.
  if (particle.templateId !== undefined) {
    const tpl = _packetTemplates[particle.templateId]
    if (tpl?.protocol === 'http') {
      if (tpl.statusCode >= 500) {
        recordBreakerResultLocal(ep.id, true, config, now)
        dropParticle(ep, targetNodeId, particle)
        return
      }
      if (tpl.statusCode >= 400) {
        _clientErrorCounts.set(targetNodeId, (_clientErrorCounts.get(targetNodeId) ?? 0) + 1)
      }
    }
  }

  // Connection pool check (7a) — databases and caches
  if (config.connectionPool) {
    const active = getActiveConnections(targetNodeId)
    if (active >= config.connectionPool.max) {
      dropParticle(ep, targetNodeId, particle)
      const label = ((_nodesMap.get(targetNodeId))?.data as NodeData)?.label ?? targetNodeId
      _onEvent('connection_pool_exhausted', targetNodeId, `${label} connection pool exhausted (${active}/${config.connectionPool.max})`, 'critical', { utilization: 1, errorRate: 1 })
      return
    }
    acquireConnection(targetNodeId, config.connectionPool.max)
    const releaseDelay = Math.max(50, effectiveProcessingMs(targetNodeId, config))
    scheduleConnectionRelease(targetNodeId, releaseDelay, _simulatedTimeMs)
  }

  // Check circuit breaker state (keyed on edge — client-side breaker)
  const breakerState = checkBreakerTransitionLocal(ep.id, config, now)
  if (breakerState === 'open') {
    dropParticle(ep, targetNodeId, particle)
    recordBreakerResultLocal(ep.id, true, config, now)
    return
  }
  if (breakerState === 'half-open' && Math.random() > 0.1) {
    dropParticle(ep, targetNodeId, particle)
    return
  }

  const isQueue = ['queue', 'pubsub', 'stream', 'eventBus'].includes(targetNodeType)

  // Queue overflow: hard-drop when depth >= capacity, recording an error so the producer's
  // inbound circuit accumulates failures and backpressure propagates upstream.
  if (isQueue) {
    const cap   = config.queueCapacity ?? 1000
    const depth = state.queueDepths.get(targetNodeId) ?? 0
    if (depth >= cap) {
      const label = (_nodesMap.get(targetNodeId)?.data as NodeData)?.label ?? targetNodeId
      _onEvent('connection_pool_exhausted', targetNodeId,
        `${label} queue full (${Math.round(depth)}/${cap}) — dropping`, 'critical',
        { utilization: 1, errorRate: 1 })
      recordBreakerResultLocal(ep.id, true, config, now)
      dropParticle(ep, targetNodeId, particle)
      return
    }
  }

  // Sample server-side processing latency only.
  // Neither originLatencyMs (client geographic transit) nor geoLatencyMs (inter-region network hop)
  // belong here — both are network costs external to the node, not its processing time.
  // Including them would inflate p90/p99 and falsely degrade health scores on healthy nodes.
  const lm = config.latencyModel
  let sampledLatency = lm ? sampleLatencyMs(lm.p50Ms, lm.p99Ms) : (config.processingMs || 5)

  // K8s service mesh + CNI tax: intra-cluster pod-to-pod hops pay additional latency.
  // CNI = container network interface overhead; service mesh = Envoy sidecar (e.g. Istio).
  // Only applied when source AND target are pods within the SAME cluster.
  if (targetNodeType === 'pod' && ep.sourceNodeType === 'pod' && sourceNodeId) {
    const srcParents = resolveK8sParents(sourceNodeId)
    const tgtParents = resolveK8sParents(targetNodeId)
    if (srcParents.clusterId && srcParents.clusterId === tgtParents.clusterId) {
      const clType = _nodesMap.get(srcParents.clusterId)?.type as NodeType | undefined
      const clConfig = clType ? effectiveConfig(srcParents.clusterId, clType) : null
      if (clConfig?.k8sCluster) {
        sampledLatency += clConfig.k8sCluster.cniLatencyMs
        if (clConfig.k8sCluster.hasServiceMesh) sampledLatency += 2  // Envoy sidecar overhead
      }
    }
  }

  particle.originLatencyMs = 0  // consume — zeroed so it doesn't compound on subsequent hops
  recordLatency(targetNodeId, sampledLatency)

  // Capacity check for non-queue nodes
  if (!isQueue) {
    const inRps = totalInRps
    const utilization = inRps / config.maxRps

    // Lambda: concurrency cap + cold start (7b)
    if (targetNodeType === 'lambda') {
      const cur = state.nodeConcurrency.get(targetNodeId) ?? 0
      const maxC = config.maxConcurrency ?? 10
      if (cur >= maxC) {
        dropParticle(ep, targetNodeId, particle)
        recordBreakerResultLocal(ep.id, true, config, now)
        return
      }
      // Cold start: warm instances expire after 5 min idle
      const lastAct  = getWarmLastActivity(targetNodeId)
      const maxWarm  = config.maxWarmInstances ?? 5
      const warm     = now - lastAct > LAMBDA_WARM_IDLE_MS ? 0 : getWarmInstances(targetNodeId)
      let effectiveLatency = sampledLatency  // already includes origin + geo offsets
      if (cur >= warm && config.coldStart) {
        // Pay cold-start penalty
        const cs = config.coldStart
        effectiveLatency += sampleLatencyMs(cs.p50Ms, cs.p99Ms)
        const label = ((_nodesMap.get(targetNodeId))?.data as NodeData)?.label ?? targetNodeId
        _onEvent('lambda_cold_start', targetNodeId, `${label} cold start (+${Math.round(effectiveLatency - sampledLatency)}ms)`, 'warn', { p90LatencyMs: effectiveLatency })
      }
      setWarmInstances(targetNodeId, Math.min(maxWarm, warm + 1))
      setWarmLastActivity(targetNodeId, now)
      state.nodeConcurrency.set(targetNodeId, cur + 1)
      const healthMult = _nodeHealthStates.get(targetNodeId) === 'degraded'
        ? (1 + degradedDepth(_smoothedMetrics.get(targetNodeId)?.healthScore ?? 0.67))
        : 1
      const delay = Math.max(50, effectiveLatency * healthMult)
      recordLatency(targetNodeId, effectiveLatency)
      scheduleGenericRelease(targetNodeId, delay, _simulatedTimeMs, () => {
        const c = state.nodeConcurrency.get(targetNodeId) ?? 0
        state.nodeConcurrency.set(targetNodeId, Math.max(0, c - 1))
      })
      recordBreakerResultLocal(ep.id, false, config, now)
      trackRequest(targetNodeId, targetNodeType, config)
      // Release source thread: blocked for the full lambda execution time + response transit
      if (ep.edgeType === 'request' && sourceNodeId && ep.sourceNodeType && THREAD_POOL_TYPES.has(ep.sourceNodeType)) {
        scheduleWorkerRelease(sourceNodeId, effectiveLatency + ep.geoLatencyMs, _simulatedTimeMs)
      }
      forwardToOutbound(targetNodeId, targetNodeType, particle.templateId)
      return
    }

    // Database nodes: separate read/write capacity limits + SQL locking penalty
    if (config.dbConfig && (targetNodeType === 'dbSql' || targetNodeType === 'dbNoSql')) {
      // For request edges with a configured method distribution, GET = read and
      // POST/PUT/DELETE = write — overrides the manual readPercentage slider.
      const reqConfig = ep.edgeType === 'request'
        ? (_edgesData.find(e => e.id === ep.id)?.data as EdgeData | undefined)?.config as RequestEdgeConfig | undefined
        : undefined
      // Custom mode: the read/write mix is whatever the source node's packet distribution
      // actually generates — this is what makes the write-bottleneck reflect real traffic.
      const distReadPct = _packetMode === 'custom' && sourceNodeId ? distributionReadFraction(sourceNodeId) : undefined
      const edgeReadPct = distReadPct ?? (reqConfig
        ? (() => {
            const d = reqConfig.methodDistribution
            const total = d.GET + d.POST + d.PUT + d.DELETE
            return total > 0 ? d.GET / total : 0.8
          })()
        : ((_edgesData.find(e => e.id === ep.id)?.data as EdgeData | undefined)?.readPercentage ?? 0.8))
      const readRps   = totalInRps * edgeReadPct
      const writeRps  = totalInRps * (1 - edgeReadPct)
      const readUtil  = readRps  / config.dbConfig.maxReadRps
      const writeUtil = writeRps / config.dbConfig.maxWriteRps

      if (Math.max(readUtil, writeUtil) >= 1.0 + config.errorRate) {
        _dbSaturationReason.set(targetNodeId, writeUtil >= readUtil ? 'write' : 'read')
        dropParticle(ep, targetNodeId, particle)
        recordBreakerResultLocal(ep.id, true, config, now)
        return
      }

      // Per-particle latency: read or write lane. A db template names its queryType explicitly;
      // otherwise the sampled HTTP method (GET = read) or ID-modulo sampling decides.
      // SQL locking: heavy write utilization increases read latency exponentially (row/table locks).
      const dbTpl = particle.templateId !== undefined ? _packetTemplates[particle.templateId] : undefined
      const isRead = dbTpl?.protocol === 'db'
        ? dbTpl.queryType === 'read'
        : (particle.method ? particle.method === 'GET' : isReadParticle(particle.id, edgeReadPct))
      let dbLatency = isRead ? config.dbConfig.readLatencyMs : config.dbConfig.writeLatencyMs
      // Write-Ahead Logging: a templated WAL write pays an extra fsync/journal cost.
      if (!isRead && dbTpl?.protocol === 'db' && dbTpl.isWAL) dbLatency += config.dbConfig.writeLatencyMs * 0.5
      if (targetNodeType === 'dbSql') {
        const lockingPenalty = Math.pow(writeUtil, 2) * 50  // up to +50ms at 100% write util
        dbLatency += lockingPenalty  // applies to both reads AND writes under SQL contention
      }
      particle.originLatencyMs = 0
      recordLatency(targetNodeId, dbLatency)
      recordBreakerResultLocal(ep.id, false, config, now)
      trackRequest(targetNodeId, targetNodeType, config)
      if (ep.edgeType === 'request' && sourceNodeId && ep.sourceNodeType && THREAD_POOL_TYPES.has(ep.sourceNodeType)) {
        scheduleWorkerRelease(sourceNodeId, dbLatency + ep.geoLatencyMs, _simulatedTimeMs)
      }
      forwardToOutbound(targetNodeId, targetNodeType, particle.templateId)
      return
    }

    // Other non-queue nodes: drop if at capacity
    if (utilization >= 1.0 + config.errorRate) {
      dropParticle(ep, targetNodeId, particle)
      recordBreakerResultLocal(ep.id, true, config, now)
      return
    }
  }

  // Regular compute nodes: if every outbound dependency is circuit-open, this request cannot
  // be fulfilled — fail it so the inbound circuit (LB→server) accumulates errors naturally.
  if (!isQueue && targetNodeType !== 'loadBalancer' && targetNodeType !== 'apiGateway'
      && !['k8sCluster', 'ecsCluster', 'dockerCompose'].includes(targetNodeType)
      && targetNodeType !== 'lambda') {
    const outEdges = _edgePaths.filter(e => _edgesData.find(d => d.id === e.id)?.source === targetNodeId)
    if (outEdges.length > 0 && outEdges.every(e => getBreaker(e.id)?.state === 'open')) {
      recordBreakerResultLocal(ep.id, true, config, now)
      dropParticle(ep, targetNodeId, particle)
      return
    }
  }

  recordBreakerResultLocal(ep.id, false, config, now)
  trackRequest(targetNodeId, targetNodeType, config)

  // Release source thread after target finishes processing and response transits back.
  // This is what causes thread-pool exhaustion: a slow target holds threads at the source
  // until the response arrives, not until the request is sent.
  if (ep.edgeType === 'request' && sourceNodeId && ep.sourceNodeType && THREAD_POOL_TYPES.has(ep.sourceNodeType)) {
    scheduleWorkerRelease(sourceNodeId, sampledLatency + ep.geoLatencyMs, _simulatedTimeMs)
  }

  // Load balancer / API gateway: round-robin or least-connections routing
  if (targetNodeType === 'loadBalancer' || targetNodeType === 'apiGateway') {
    const outEdges = _edgePaths.filter(e =>
      _edgesData.find(d => d.id === e.id)?.source === targetNodeId && e.edgeType !== 'dependency',
    )
    if (outEdges.length > 0) {
      const lbConfig = effectiveConfig(targetNodeId, targetNodeType)
      let chosenEp: EdgePath

      // Exclude backends whose circuit breaker is open or whose health state is 'down'.
      // Falls back to the full pool only if ALL backends are unavailable — ensures the LB
      // never silently blackholes traffic when there is no healthy option.
      const availableEdges = outEdges.filter(e => {
        const tgtId = _edgesData.find(d => d.id === e.id)?.target
        return getBreaker(e.id)?.state !== 'open'
          && (tgtId === undefined || _nodeHealthStates.get(tgtId) !== 'down')
      })
      const routingEdges = availableEdges.length > 0 ? availableEdges : outEdges

      if (lbConfig.lbRouting === 'least-connections' && routingEdges.length > 1) {
        // Route to the backend with the fewest in-flight requests
        chosenEp = routingEdges.reduce((best, ep) => {
          const tgtId      = _edgesData.find(e => e.id === ep.id)?.target
          const active     = tgtId ? (_lbActiveRequests.get(tgtId) ?? 0) : Infinity
          const bestTgtId  = _edgesData.find(e => e.id === best.id)?.target
          const bestActive = bestTgtId ? (_lbActiveRequests.get(bestTgtId) ?? 0) : Infinity
          return active < bestActive ? ep : best
        })
      } else {
        // Round-robin over available backends only
        const idx = state.roundRobinIndex.get(targetNodeId) ?? 0
        chosenEp  = routingEdges[idx % routingEdges.length]
        state.roundRobinIndex.set(targetNodeId, idx + 1)
      }

      if (!state.particles.has(chosenEp.id)) state.particles.set(chosenEp.id, [])
      const _lbp: Particle = { id: ++_particleIdCounter, t: 0, speed: PARTICLE_SPEED_BASE, color: particle.templateId !== undefined ? (_packetTemplates[particle.templateId]?.colorOverride ?? edgeColor(chosenEp.edgeType)) : edgeColor(chosenEp.edgeType), edgeId: chosenEp.id, retries: 0, originLatencyMs: 0, spawnTime: performance.now(), payloadBytes: templatePayloadBytes(particle.templateId, chosenEp.targetNodeType, chosenEp.id), templateId: particle.templateId }
      state.particles.get(chosenEp.id)!.push(_lbp)
      _particleById.set(_lbp.id, _lbp)
    }
    return
  }

  // Orchestration clusters: forward to all outbound (broadcast)
  if (['k8sCluster', 'ecsCluster', 'dockerCompose'].includes(targetNodeType)) {
    forwardToOutbound(targetNodeId, targetNodeType, particle.templateId)
    return
  }
}

function forwardToOutbound(nodeId: string, _nodeType: NodeType, templateId?: number) {
  const outEdges = _edgePaths.filter(e =>
    _edgesData.find(d => d.id === e.id)?.source === nodeId && e.edgeType !== 'dependency',
  )
  if (outEdges.length === 0) return
  // A typed packet may only continue on a transport-compatible edge — an http request can't be
  // forwarded onto an event edge. Fall back to all outbound when none match (or it's untyped).
  const tpl = templateId !== undefined ? _packetTemplates[templateId] : undefined
  const compatible = tpl
    ? outEdges.filter(e => edgeAcceptsProtocol(e.edgeType as EdgeType, tpl.protocol))
    : outEdges
  const candidates = compatible.length > 0 ? compatible : outEdges
  const outEp = candidates[Math.floor(Math.random() * candidates.length)]
  if (!state.particles.has(outEp.id)) state.particles.set(outEp.id, [])
  // Forwarded packet inherits the parent's templateId — no re-roll, so distributions stay intact.
  const _fwdp: Particle = { id: ++_particleIdCounter, t: 0, speed: PARTICLE_SPEED_BASE, color: edgeColor(outEp.edgeType), edgeId: outEp.id, retries: 0, originLatencyMs: 0, spawnTime: performance.now(), payloadBytes: templatePayloadBytes(templateId, outEp.targetNodeType, outEp.id), templateId }
  state.particles.get(outEp.id)!.push(_fwdp)
  _particleById.set(_fwdp.id, _fwdp)
}

function spawnErrorFlash(nodeId: string) {
  const rect = getNodeCanvasRect(nodeId)
  if (!rect) return
  state.errorFlashes.push({
    x: rect[0] + rect[2] / 2,
    y: rect[1] + rect[3] / 2,
    startTime: performance.now(),
  })
}

// ─── Outage playback: record / render particle keyframes ─────────────────────

function recordParticleFrame() {
  // Pack [edgeIdx, t, templateId] for every live particle on a mappable edge (templateId = -1
  // when untyped). The templateId lets the paused/scrub redraw recover each packet's colour.
  const triples: number[] = []
  for (const [edgeId, arr] of state.particles) {
    const idx = _edgeIndexMap.get(edgeId)
    if (idx === undefined) continue
    for (const p of arr) { triples.push(idx, p.t, p.templateId ?? -1) }
  }
  const elapsedS = _simulatedTimeMs / 1000
  _particleFrames.push({ elapsedS, packed: Float32Array.from(triples) })
  if (_particleFrames.length > MAX_PARTICLE_FRAMES) {
    _particleFrames.splice(0, _particleFrames.length - MAX_PARTICLE_FRAMES)
  }
}

function drawReplayFrame(canvas: HTMLCanvasElement, index: number) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  _canvasRect = canvas.getBoundingClientRect()
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  const frame = _particleFrames[index]
  if (!frame) return
  const packed = frame.packed
  for (let i = 0; i < packed.length; i += 3) {
    const ep = _edgePaths[packed[i]]
    if (!ep) continue
    const pos = getEdgePoint(ep.id, packed[i + 1])
    if (!pos) continue
    const templateId = packed[i + 2]
    const color = templateId >= 0
      ? (_packetTemplates[templateId]?.colorOverride ?? edgeColor(ep.edgeType))
      : edgeColor(ep.edgeType)
    ctx.beginPath()
    ctx.arc(pos[0], pos[1], 2.5, 0, Math.PI * 2)
    ctx.fillStyle  = color
    ctx.shadowBlur = 6
    ctx.shadowColor = color
    ctx.fill()
    ctx.shadowBlur = 0
  }
}

// Publish the recorded particle timeline to the replay store so the scrubber can index it.
// Called on pause; cheap one-time copy of frame timestamps (not the heavy packed buffers).
export function enterReplay() {
  _lastReplayIndexDrawn = -1
  useReplayStore.getState().startReplay(_particleFrames.map(f => f.elapsedS))
}

// ─── Per-frame metrics update ────────────────────────────────────────────────

const METRICS_THROTTLE = 4
let _frameCount = 0

function updateAllNodeMetrics(now: number, delta: number) {
  _frameCount++
  if (_frameCount % METRICS_THROTTLE !== 0) return

  // Record a particle keyframe at the metrics cadence (~15fps) for outage playback.
  recordParticleFrame()

  const mult = effectiveMultiplier(now)
  const metricsBatch = new Map<string, NodeMetrics>()

  // Egress bandwidth window: convert bytes accumulated since the last flush into bytes/sec,
  // scaled back up by the particle:request downsample ratio. Measured against SIMULATION time
  // (not the wall clock) so the rate stays tied to the configured RPS — at 2× speed twice as
  // many particles spawn over twice as much simulated time, so bytes/sec is unchanged. Per-node
  // values are read in the loop below; the accumulator is cleared at the end.
  const egressWindowSec = Math.max(0.001, (_simulatedTimeMs - _lastEgressFlushAt) / 1000)
  _lastEgressFlushAt = _simulatedTimeMs

  // Decay upstream pressure (error rate contribution)
  for (const [id, pressure] of _upstreamPressure) {
    const next = pressure * 0.98
    if (next < 0.001) _upstreamPressure.delete(id)
    else _upstreamPressure.set(id, next)
  }

  // Decay downstream stall pressure (utilization contribution) — slower decay so cascade is visible
  for (const [id, stall] of _downstreamStallPressure) {
    const next = stall * 0.97
    if (next < 0.001) _downstreamStallPressure.delete(id)
    else _downstreamStallPressure.set(id, next)
  }

  const nodeIds = new Set<string>()
  for (const e of _edgesData) { nodeIds.add(e.source); nodeIds.add(e.target) }

  for (const nodeId of nodeIds) {
    const node = _nodesMap.get(nodeId)
    if (!node || GROUPING_TYPES.has(node.type as NodeType)) continue
    const nodeType = node.type as NodeType

    // Dependency edges are static health links — they carry no traffic and must not
    // contribute to RPS/utilization metrics.
    const inEdges  = _edgePaths.filter(ep => ep.edgeType !== 'dependency' && _edgesData.find(d => d.id === ep.id)?.target === nodeId)
    const outEdges = _edgePaths.filter(ep => ep.edgeType !== 'dependency' && _edgesData.find(d => d.id === ep.id)?.source === nodeId)
    const inRps  = inEdges.reduce((s, e) => s + (e.effectiveRps ?? (e.rps * mult)), 0)
    const outRps = outEdges.reduce((s, e) => s + (e.effectiveRps ?? (e.rps * mult)), 0)

    const config = effectiveConfig(nodeId, nodeType)
    const isQueue = ['queue', 'pubsub', 'stream', 'eventBus'].includes(nodeType)

    let utilization = 0
    let queueDepth: number | undefined
    let concurrency: number | undefined

    let consumerLagMs: number | undefined
    if (isQueue) {
      const cap = config.queueCapacity ?? 1000
      const prev = state.queueDepths.get(nodeId) ?? 0
      const net  = (inRps - outRps) * ((delta * METRICS_THROTTLE) / 1000)
      const next = Math.max(0, prev + net)
      state.queueDepths.set(nodeId, next)
      queueDepth  = next
      utilization = Math.min(1, next / cap)
      // Consumer lag: how long at the current drain rate to empty the backlog.
      // Only meaningful for stream nodes (Kafka/Kinesis semantics); starts as soon
      // as inRps > outRps and the queue has any depth.
      if (nodeType === 'stream' && next > 0) {
        consumerLagMs = outRps > 0 ? (next / outRps) * 1000 : Infinity
      }
    } else if (nodeType === 'lambda') {
      const cur = state.nodeConcurrency.get(nodeId) ?? 0
      const maxC = config.maxConcurrency ?? 10
      concurrency = cur
      utilization = Math.min(1, cur / maxC)
    } else {
      let effectiveMaxRps = config.maxRps
      const isDb = config.dbConfig && (nodeType === 'dbSql' || nodeType === 'dbNoSql')
      let dbUtil = 0

      // ── Pod: K8s HPA + three-tier capacity constraint ─────────────────────
      if (nodeType === 'pod' && config.k8sPod) {
        const kp = config.k8sPod
        const currentReplicas = _podReplicas.get(nodeId) ?? kp.replicas

        // Tier 1: pod-level capacity = replicas × per-replica capacity
        effectiveMaxRps = currentReplicas * kp.baseCapacityRps

        const parents = resolveK8sParents(nodeId)
        const prevInRps = _smoothedMetrics.get(nodeId)?.inRps ?? 0

        // Tier 2: namespace resource quota
        if (parents.namespaceId) {
          const nsConfig = effectiveConfig(parents.namespaceId, 'namespace')
          if (nsConfig.k8sNamespace) {
            const quota = nsConfig.k8sNamespace.resourceQuotaRps
            const nsTotal = _namespaceConsumedRps.get(parents.namespaceId) ?? 0
            const othersInNs = Math.max(0, nsTotal - prevInRps)
            const nsAvailable = Math.max(100, quota - othersInNs)
            if (nsAvailable < effectiveMaxRps) {
              effectiveMaxRps = nsAvailable
              if (inRps / Math.max(1, nsAvailable) > 0.9 && !_quotaConstrainedNodes.has(nodeId)) {
                _quotaConstrainedNodes.add(nodeId)
                const label = (node.data as NodeData).label ?? nodeId
                const nsLabel = (_nodesMap.get(parents.namespaceId)?.data as NodeData)?.label ?? 'namespace'
                _onEvent('quota_constrained', nodeId, `${label} capped by ${nsLabel} quota (${Math.round(nsAvailable)} RPS available)`, 'warn')
              }
            } else { _quotaConstrainedNodes.delete(nodeId) }
          }
        }

        // Tier 3: cluster node-pool capacity
        if (parents.clusterId) {
          const clType = _nodesMap.get(parents.clusterId)?.type as NodeType | undefined
          const clConfig = clType ? effectiveConfig(parents.clusterId, clType) : null
          if (clConfig?.k8sCluster) {
            const poolCap = clConfig.k8sCluster.nodePoolCapacityRps
            const clTotal = _clusterConsumedRps.get(parents.clusterId) ?? 0
            const othersInCluster = Math.max(0, clTotal - prevInRps)
            const clAvailable = Math.max(100, poolCap - othersInCluster)
            if (clAvailable < effectiveMaxRps) {
              effectiveMaxRps = clAvailable
              if (inRps / Math.max(1, clAvailable) > 0.9 && !_clusterExhaustedNodes.has(nodeId)) {
                _clusterExhaustedNodes.add(nodeId)
                const label = (node.data as NodeData).label ?? nodeId
                const clLabel = (_nodesMap.get(parents.clusterId)?.data as NodeData)?.label ?? 'cluster'
                _onEvent('cluster_exhausted', nodeId, `${label} capped by ${clLabel} node pool (${Math.round(clAvailable)} RPS available)`, 'warn')
              }
            } else { _clusterExhaustedNodes.delete(nodeId) }
          }
        }

        // HPA: scale out/in based on utilization vs targetCpuUtilization
        if (kp.hpa) {
          const hpa = kp.hpa
          const podUtil = inRps / Math.max(1, currentReplicas * kp.baseCapacityRps)

          if (podUtil > hpa.targetCpuUtilization && currentReplicas < hpa.maxReplicas) {
            const wantReplicas = Math.min(hpa.maxReplicas, currentReplicas + 1)
            const additionalCap = (wantReplicas - currentReplicas) * kp.baseCapacityRps
            let blockedBy: string | null = null
            const parents2 = resolveK8sParents(nodeId)
            if (!blockedBy && parents2.namespaceId) {
              const nsConfig = effectiveConfig(parents2.namespaceId, 'namespace')
              if (nsConfig.k8sNamespace) {
                const nsTotal = _namespaceConsumedRps.get(parents2.namespaceId) ?? 0
                if (nsTotal + additionalCap > nsConfig.k8sNamespace.resourceQuotaRps) blockedBy = 'namespace quota'
              }
            }
            if (!blockedBy && parents2.clusterId) {
              const clType2 = _nodesMap.get(parents2.clusterId)?.type as NodeType | undefined
              const clConfig2 = clType2 ? effectiveConfig(parents2.clusterId, clType2) : null
              if (clConfig2?.k8sCluster) {
                const clTotal = _clusterConsumedRps.get(parents2.clusterId) ?? 0
                if (clTotal + additionalCap > clConfig2.k8sCluster.nodePoolCapacityRps) blockedBy = 'cluster node pool'
              }
            }
            if (blockedBy) {
              if (!_hpaBlockedNodes.has(nodeId)) {
                _hpaBlockedNodes.add(nodeId)
                const label = (node.data as NodeData).label ?? nodeId
                _onEvent('hpa_blocked', nodeId, `HPA for ${label} blocked by ${blockedBy} — stuck at ${currentReplicas} replicas`, 'warn')
              }
            } else {
              _hpaBlockedNodes.delete(nodeId)
              if (!_scaleOutPending.has(nodeId)) {
                _scaleOutPending.set(nodeId, now + 30_000)
                const label = (node.data as NodeData).label ?? nodeId
                _onEvent('autoscale_triggered', nodeId, `${label} HPA scaling out → ${wantReplicas} replicas`, 'info')
              }
              const pendingAt = _scaleOutPending.get(nodeId)
              if (pendingAt && now >= pendingAt) {
                _podReplicas.set(nodeId, wantReplicas)
                _scaleOutPending.delete(nodeId)
                const label = (node.data as NodeData).label ?? nodeId
                _onEvent('autoscale_complete', nodeId, `${label} HPA → ${wantReplicas} replicas`, 'info')
              }
            }
          } else if (podUtil < hpa.targetCpuUtilization * 0.5 && currentReplicas > hpa.minReplicas) {
            const cooldownEnd = _scaleInCooldown.get(nodeId) ?? 0
            if (now > cooldownEnd) {
              const newReplicas = Math.max(hpa.minReplicas, currentReplicas - 1)
              _podReplicas.set(nodeId, newReplicas)
              _scaleInCooldown.set(nodeId, now + 300_000)
              _hpaBlockedNodes.delete(nodeId)
              const label = (node.data as NodeData).label ?? nodeId
              _onEvent('autoscale_scaledin', nodeId, `${label} HPA scaled in → ${newReplicas} replicas`, 'info')
            }
          } else {
            _hpaBlockedNodes.delete(nodeId)
          }
        }

      } else if (config.autoScale) {
        // Legacy autoScale path (ec2/container nodes with explicit autoScale config)
        const current = _currentCapacity.get(nodeId) ?? config.autoScale.minCapacityRps
        effectiveMaxRps = current
        const utilForScale = Math.min(1, inRps / effectiveMaxRps)
        if (utilForScale > config.autoScale.scaleOutThreshold && !_scaleOutPending.has(nodeId)) {
          _scaleOutPending.set(nodeId, now + config.autoScale.scaleOutDelayMs)
          const label = (node.data as NodeData).label ?? nodeId
          _onEvent('autoscale_triggered', nodeId, `${label} scaling out — utilization ${Math.round(utilForScale * 100)}%`, 'info')
        }
        const pendingAt = _scaleOutPending.get(nodeId)
        if (pendingAt && now >= pendingAt) {
          const newCap = Math.min(config.autoScale.maxCapacityRps, current * 2)
          _currentCapacity.set(nodeId, newCap)
          _scaleOutPending.delete(nodeId)
          const label = (node.data as NodeData).label ?? nodeId
          _onEvent('autoscale_complete', nodeId, `${label} capacity → ${newCap} RPS`, 'info')
        }
        const cooldownEnd = _scaleInCooldown.get(nodeId) ?? 0
        if (utilForScale < config.autoScale.scaleInThreshold && now > cooldownEnd && current > config.autoScale.minCapacityRps) {
          const newCap = Math.max(config.autoScale.minCapacityRps, Math.floor(current * 0.5))
          _currentCapacity.set(nodeId, newCap)
          _scaleInCooldown.set(nodeId, now + config.autoScale.scaleInCooldownMs)
          const label = (node.data as NodeData).label ?? nodeId
          _onEvent('autoscale_scaledin', nodeId, `${label} scaled in → ${newCap} RPS`, 'info')
        }
        if (config.selfHealing && getChaosFailures().has(nodeId)) {
          const expiry = getChaosFailures().get(nodeId)?.expiry ?? 0
          if (now > expiry) {
            const restarts = _restartCounts.get(nodeId) ?? 0
            const cooldown = _restartCooldown.get(nodeId) ?? 0
            if (now > cooldown) {
              const maxRestarts = config.selfHealing.maxRestarts
              if (restarts < maxRestarts) {
                _restartCounts.set(nodeId, restarts + 1)
                _restartCooldown.set(nodeId, now + config.selfHealing.restartDelayMs)
              } else {
                const backoff = config.selfHealing.crashLoopBackoffMs * (restarts - maxRestarts + 1)
                _restartCooldown.set(nodeId, now + backoff)
                const label = (node.data as NodeData).label ?? nodeId
                _onEvent('crash_loop_detected', nodeId, `${label} crash-loop — backoff ${Math.round(backoff / 1000)}s`, 'critical')
              }
            }
          }
        }
        effectiveMaxRps = _currentCapacity.get(nodeId) ?? config.autoScale.minCapacityRps
      } else if (isDb && config.dbConfig) {
        let readRps = 0
        let writeRps = 0
        for (const ep of inEdges) {
          const reqConfig = ep.edgeType === 'request'
            ? (_edgesData.find(e => e.id === ep.id)?.data as EdgeData | undefined)?.config as RequestEdgeConfig | undefined
            : undefined
          const edgeReadPct = reqConfig
            ? (() => {
                const d = reqConfig.methodDistribution
                const total = d.GET + d.POST + d.PUT + d.DELETE
                return total > 0 ? d.GET / total : 0.8
              })()
            : ((_edgesData.find(e => e.id === ep.id)?.data as EdgeData | undefined)?.readPercentage ?? 0.8)
          
          const edgeEffective = ep.effectiveRps ?? (ep.rps * mult)
          readRps += edgeEffective * edgeReadPct
          writeRps += edgeEffective * (1 - edgeReadPct)
        }
        const readUtil = config.dbConfig.maxReadRps > 0 ? readRps / config.dbConfig.maxReadRps : 0
        const writeUtil = config.dbConfig.maxWriteRps > 0 ? writeRps / config.dbConfig.maxWriteRps : 0
        dbUtil = Math.max(readUtil, writeUtil)
        effectiveMaxRps = writeUtil >= readUtil ? config.dbConfig.maxWriteRps : config.dbConfig.maxReadRps
      }

      let degradationFactor = 1.0
      if (_nodeHealthStates.get(nodeId) === 'degraded') {
        const prevScore = _smoothedMetrics.get(nodeId)?.healthScore ?? 0.67
        degradationFactor = 1 - degradedDepth(prevScore) * 0.5
        effectiveMaxRps = effectiveMaxRps * degradationFactor
      }

      if (isDb) {
        utilization = Math.min(1, dbUtil / degradationFactor)
      } else {
        utilization = Math.min(1, inRps / effectiveMaxRps)
      }
    }

    if (getChaosFailures().has(nodeId)) utilization = 1

    // Downstream stall: when this node's requests to a downstream node are being dropped,
    // threads pile up waiting for responses → effective utilization rises upstream
    const stallPressure = _downstreamStallPressure.get(nodeId) ?? 0
    const rawUtilization = utilization  // used for bottleneck threshold (unaffected by stall)
    utilization = Math.min(1, utilization + stallPressure * 0.3)

    // Apply upstream cascade pressure to error rate
    const cascadePressure = _upstreamPressure.get(nodeId) ?? 0

    // CPU saturation → non-linear latency amplification for compute nodes (7d)
    const isCompute = ['ec2', 'container', 'pod', 'lambda'].includes(nodeType)
    const cpuFactor = (isCompute && utilization > 0.7)
      ? 1 + Math.pow((Math.min(utilization, 1) - 0.7) / 0.3, 2) * 3  // up to 4× at 100% util
      : 1

    // Compute latency percentiles from ring buffer
    const latencySamples = _latencyWindows.get(nodeId) ?? []
    const rawP50 = computePercentile(latencySamples, 50) * cpuFactor
    const rawP75 = computePercentile(latencySamples, 75) * cpuFactor
    const rawP90 = computePercentile(latencySamples, 90) * cpuFactor
    const rawP99 = computePercentile(latencySamples, 99) * cpuFactor

    // Circuit state: worst state across all inbound edges (open > half-open > closed)
    const inboundEdgeStates = _edgesData
      .filter(e => e.target === nodeId)
      .map(e => getBreaker(e.id)?.state ?? 'closed')
    const circuitState: CircuitState = inboundEdgeStates.includes('open')
      ? 'open'
      : inboundEdgeStates.includes('half-open')
        ? 'half-open'
        : 'closed'

    // Saturation events
    const wasSaturated = _saturatedNodes.has(nodeId)
    const nowSaturated = utilization >= 1.0
    if (nowSaturated && !wasSaturated) {
      _saturatedNodes.add(nodeId)
      const label = (node.data as NodeData).label ?? nodeId
      // If stall pressure is significant, saturation is downstream-induced — causal link is proven
      const satCausedBy = stallPressure > 0.1 ? _stallSources.get(nodeId) : undefined
      _onEvent('saturation_start', nodeId, `${label} saturated (${Math.round(utilization * 100)}%)`, 'critical', undefined, satCausedBy)
    } else if (!nowSaturated && wasSaturated) {
      _saturatedNodes.delete(nodeId)
      const label = (node.data as NodeData).label ?? nodeId
      _onEvent('saturation_end', nodeId, `${label} recovered`, 'info')
    }
    if (!nowSaturated) _dbSaturationReason.delete(nodeId)

    // Soft error onset at 85% utilization (real services start erroring before full saturation)
    const errorOnset = 0.85
    const baseErrorRate = utilization > errorOnset
      ? Math.min(1, (utilization - errorOnset) / (1.0 - errorOnset) * 0.15)
      : 0

    // Templated 4xx responses count as errors without being dropped. Convert the windowed
    // count (each particle ≈ PARTICLE_REQUEST_RATIO requests) into a rate against inbound RPS.
    const clientErrors = _clientErrorCounts.get(nodeId) ?? 0
    const clientErrorRps = (clientErrors * PARTICLE_REQUEST_RATIO) / egressWindowSec
    const clientErrorRate = inRps > 0 ? Math.min(1, clientErrorRps / inRps) : 0

    const rawErrorRate = Math.min(1, baseErrorRate + cascadePressure * 0.15 + clientErrorRate)

    const activeRequests = _lbActiveRequests.get(nodeId)

    const dbSaturation = _dbSaturationReason.get(nodeId)
    const egressBytesPerSec = egressWindowSec > 0
      ? ((_egressBytesAccum.get(nodeId) ?? 0) / egressWindowSec) * PARTICLE_REQUEST_RATIO
      : 0
    const rawMetrics: NodeMetrics = {
      inRps,
      outRps,
      utilization,
      errorRate: rawErrorRate,
      p50LatencyMs: rawP50,
      p75LatencyMs: rawP75,
      p90LatencyMs: rawP90,
      p99LatencyMs: rawP99,
      ...(queueDepth     !== undefined && { queueDepth }),
      ...(consumerLagMs  !== undefined && { consumerLagMs }),
      ...(concurrency    !== undefined && { concurrency }),
      ...(activeRequests !== undefined && { activeRequests }),
      circuitState,
      droppedRequests: _droppedCounts.get(nodeId) ?? 0,
      deadLetterCount: _deadLetterCounts.get(nodeId) ?? 0,
      ...(dbSaturation !== undefined && { dbSaturation }),
      egressBytesPerSec,
    }

    // ─── Health scoring ───────────────────────────────────────────────────────
    const nodeConfig = effectiveConfig(nodeId, nodeType)
    const forced     = nodeConfig.forcedHealthState ?? 'auto'
    let healthState: 'healthy' | 'degraded' | 'down'
    let healthScore: number | undefined

    if (forced !== 'auto') {
      healthState = forced
    } else {
      // Score formula: error (40%) + utilization above 80% (40%) + latency amplification (20%)
      const baselineP50    = nodeConfig.latencyModel?.p50Ms ?? Math.max(1, nodeConfig.processingMs)
      const latencyRatio   = rawP90 > 0 ? rawP90 / Math.max(baselineP50, 1) : 1
      const errorContrib   = Math.min(0.4, rawErrorRate * 0.4)
      const utilPenalty    = rawUtilization > 0.8
        ? Math.min(0.4, ((rawUtilization - 0.8) / 0.2) * 0.4)
        : 0
      const latencyPenalty = Math.min(0.2, Math.max(0, (latencyRatio - 2) / 10) * 0.2)
      healthScore = Math.max(0, 1 - errorContrib - utilPenalty - latencyPenalty)

      const rawState = healthScore >= 0.85 ? 'healthy' : healthScore >= 0.50 ? 'degraded' : 'down'

      // Recovery hysteresis: after exiting 'down', can't jump straight to 'healthy'
      const prevState = _nodeHealthStates.get(nodeId)
      if (prevState === 'down' && rawState !== 'down') {
        _recoveryUntil.set(nodeId, now + HEALTH_RECOVERY_LOCK_MS)
      }
      healthState = (rawState === 'healthy' && (_recoveryUntil.get(nodeId) ?? 0) > now)
        ? 'degraded'  // still warming up after 'down'
        : rawState
    }

    const prevHealthState = _nodeHealthStates.get(nodeId)
    _nodeHealthStates.set(nodeId, healthState)
    rawMetrics.healthScore = healthScore
    rawMetrics.healthState = healthState

    // 'down' → immediately trip circuit breakers on inbound request edges only.
    // Event/stream edges are async and fire-and-forget — the sender has no feedback loop
    // telling it the target is unreachable, so those edges stay visually active and
    // particles are dropped on arrival instead of being suppressed at the source.
    // Delegates to circuitBreakers.ts (moved there in Task 0 — pure code motion).
    if (healthState === 'down') {
      const inboundRequestEdges = _edgesData.filter(ed => {
        if (ed.target !== nodeId) return false
        const edgePath = _edgePaths.find(ep => ep.id === ed.id)
        return edgePath?.edgeType !== 'event' && edgePath?.edgeType !== 'stream'
      })
      const hasBreakerConfig = nodeConfig.circuitBreaker !== undefined
      forceOpenBreakersForNode(nodeId, inboundRequestEdges, hasBreakerConfig, now, _nodesMap, _onEvent)
    }

    // Emit health state transition events (distinct from saturation events)
    if (prevHealthState !== undefined && prevHealthState !== healthState) {
      const label = (node.data as NodeData).label ?? nodeId
      if (healthState === 'healthy') {
        _onEvent('saturation_end', nodeId, `${label} health recovered`, 'info')
      }
    }

    // EMA smoothing for numeric fields — prevents visual jitter without losing trends
    const prev = _smoothedMetrics.get(nodeId)
    const metrics: NodeMetrics = prev ? {
      inRps:         ema(prev.inRps, rawMetrics.inRps),
      outRps:        ema(prev.outRps, rawMetrics.outRps),
      utilization:   ema(prev.utilization, rawMetrics.utilization),
      errorRate:     ema(prev.errorRate, rawMetrics.errorRate),
      p50LatencyMs:  ema(prev.p50LatencyMs, rawMetrics.p50LatencyMs),
      p75LatencyMs:  ema(prev.p75LatencyMs, rawMetrics.p75LatencyMs),
      p90LatencyMs:  ema(prev.p90LatencyMs, rawMetrics.p90LatencyMs),
      p99LatencyMs:  ema(prev.p99LatencyMs, rawMetrics.p99LatencyMs),
      egressBytesPerSec: ema(prev.egressBytesPerSec ?? 0, rawMetrics.egressBytesPerSec ?? 0),
      // Discrete fields — no smoothing
      queueDepth:       rawMetrics.queueDepth,
      consumerLagMs:    rawMetrics.consumerLagMs,
      concurrency:      rawMetrics.concurrency,
      activeRequests:   rawMetrics.activeRequests,
      circuitState:     rawMetrics.circuitState,
      healthScore:      rawMetrics.healthScore,
      healthState:      rawMetrics.healthState,
      droppedRequests:  rawMetrics.droppedRequests,
      deadLetterCount:  rawMetrics.deadLetterCount,
      dbSaturation:     rawMetrics.dbSaturation,
    } : rawMetrics
    _smoothedMetrics.set(nodeId, metrics)

    metricsBatch.set(nodeId, metrics)
    // Bottleneck threshold uses raw utilization (before stall inflation) so nodes aren't
    // marked as bottlenecks purely because their downstream is failing
    _onBottleneck(nodeId, rawUtilization > 0.8)
  }

  // Egress window consumed — reset for the next metrics tick.
  _egressBytesAccum.clear()
  _clientErrorCounts.clear()

  // ── Dependency edges: propagate health from critical static dependencies ────
  // Runs after the main per-node loop so every node's health state for this tick
  // is finalized before we read target health states. A critical dependency on a
  // 'down' target reduces the source's health score by healthPropagation.
  for (const edgeData of _edgesData) {
    const edgePath = _edgePaths.find(ep => ep.id === edgeData.id)
    if (edgePath?.edgeType !== 'dependency') continue
    const depConfig = edgeData.data?.config as DependencyEdgeConfig | undefined
    if (!depConfig?.isCritical) continue
    if (_nodeHealthStates.get(edgeData.target) !== 'down') continue

    const sourceId = edgeData.source
    const sourceMetrics = metricsBatch.get(sourceId)
    if (!sourceMetrics) continue

    const baseScore = sourceMetrics.healthScore ?? 1
    const newScore  = Math.max(0, baseScore * (1 - depConfig.healthPropagation))
    const newState: 'healthy' | 'degraded' | 'down' =
      newScore >= 0.85 ? 'healthy' : newScore >= 0.50 ? 'degraded' : 'down'

    sourceMetrics.healthScore = newScore
    sourceMetrics.healthState = newState
    _smoothedMetrics.set(sourceId, sourceMetrics)

    if (newState === 'down' && _nodeHealthStates.get(sourceId) !== 'down') {
      const label    = (_nodesMap.get(sourceId)?.data as NodeData)?.label ?? sourceId
      const tgtLabel = (_nodesMap.get(edgeData.target)?.data as NodeData)?.label ?? edgeData.target
      _onEvent('cascade_detected', sourceId, `${label} degraded — critical dependency ${tgtLabel} is down`, 'critical')
    }
    _nodeHealthStates.set(sourceId, newState)
  }

  if (metricsBatch.size > 0) _onNodeMetrics(metricsBatch)

  // ── K8s: update namespace/cluster consumed-RPS totals for next tick ─────────
  // Uses current-tick metricsBatch so the quotas are immediately reactive.
  _namespaceConsumedRps.clear()
  _clusterConsumedRps.clear()
  for (const [nId, m] of metricsBatch) {
    const n = _nodesMap.get(nId)
    if (!n || n.type !== 'pod') continue
    const parents = resolveK8sParents(nId)
    if (parents.namespaceId) _namespaceConsumedRps.set(parents.namespaceId, (_namespaceConsumedRps.get(parents.namespaceId) ?? 0) + m.inRps)
    if (parents.clusterId)   _clusterConsumedRps.set(parents.clusterId,   (_clusterConsumedRps.get(parents.clusterId)   ?? 0) + m.inRps)
  }

  // ── K8s blast radius: cascade "down" state from cluster/namespace to children ─
  // Traverses the full descendant subtree so deeply nested pods are also reached.
  for (const [gId, gNode] of _nodesMap) {
    const gType = gNode.type as NodeType
    if (!['k8sCluster', 'ecsCluster', 'dockerCompose', 'namespace'].includes(gType)) continue
    const gConfig = effectiveConfig(gId, gType)
    if (gConfig.forcedHealthState !== 'down') continue
    const queue = [gId]
    const seen  = new Set<string>()
    while (queue.length > 0) {
      const pid = queue.shift()!
      for (const [cId, cNode] of _nodesMap) {
        if (cNode.parentId !== pid || seen.has(cId)) continue
        seen.add(cId)
        _nodeHealthStates.set(cId, 'down')
        queue.push(cId)
      }
    }
  }

  // Proactively transition open circuits to half-open once resetMs has elapsed.
  // checkBreakerTransition only fires on particle arrival, but spawnParticles emits 0 particles
  // on open circuits — creating a deadlock where the circuit can never self-recover.
  // This periodic scan breaks that deadlock without relying on incoming traffic.
  // Delegates to circuitBreakers.ts (moved there in Task 0 — pure code motion).
  resetBreakersIfRecovered(now, _edgesData, _nodesMap, _nodeHealthStates, effectiveConfig, _onEvent)
}

// ─── Retry queue processing ───────────────────────────────────────────────────

const RETRY_STORM_THRESHOLD = 5  // simultaneous retries to the same node in one frame

function processRetryQueue(now: number) {
  if (_retryQueue.length === 0) return

  // Partition into ready and still-pending without allocating two arrays each frame
  const ready: RetryEntry[] = []
  let i = _retryQueue.length
  while (i--) {
    if (_retryQueue[i].fireAt <= now) ready.push(..._retryQueue.splice(i, 1))
  }
  if (ready.length === 0) return

  // Retry storm detection: count simultaneous retries arriving at each target node
  const targetHits = new Map<string, number>()
  for (const r of ready) {
    const targetId = _edgesData.find(e => e.id === r.edgeId)?.target
    if (targetId) targetHits.set(targetId, (targetHits.get(targetId) ?? 0) + 1)
  }
  for (const [nodeId, count] of targetHits) {
    if (count >= RETRY_STORM_THRESHOLD) {
      const node = _nodesMap.get(nodeId)
      const label = (node?.data as NodeData)?.label ?? nodeId
      _onEvent('retry_storm', nodeId, `${label} retry storm — ${count} retries in one burst`, 'critical')
    }
  }

  // Re-spawn ready retries as particles, subject to the global cap
  for (const r of ready) {
    let total = 0
    for (const arr of state.particles.values()) total += arr.length
    if (total >= MAX_PARTICLES) break

    if (!state.particles.has(r.edgeId)) state.particles.set(r.edgeId, [])
    const _rTargetType = _edgePaths.find(e => e.id === r.edgeId)?.targetNodeType
    const _rp: Particle = { id: ++_particleIdCounter, t: 0, speed: PARTICLE_SPEED_BASE * (0.8 + Math.random() * 0.4), color: r.color, edgeId: r.edgeId, retries: r.retries, originLatencyMs: 0, spawnTime: now, payloadBytes: templatePayloadBytes(r.templateId, _rTargetType, r.edgeId), deadLetter: r.deadLetter, templateId: r.templateId }
    state.particles.get(r.edgeId)!.push(_rp)
    _particleById.set(_rp.id, _rp)
  }
}

// ─── Main draw loop ───────────────────────────────────────────────────────────

const GLOW_LINGER = 2200
const ERROR_FLASH_DURATION = 400

function advanceAndDraw(canvas: HTMLCanvasElement, now: number, delta: number) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  _canvasRect = canvas.getBoundingClientRect()
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  // Draw node glows
  for (const [nodeId, glow] of state.nodeGlows) {
    const idleFor = now - glow.lastActivity
    if (idleFor > GLOW_LINGER) { state.nodeGlows.delete(nodeId); continue }

    const rect = getNodeCanvasRect(nodeId)
    if (!rect) continue
    const [nx, ny, nw, nh] = rect

    const breath   = 0.375 + 0.625 * (0.5 + 0.5 * Math.sin(now / 1400))
    const decay    = 1 - idleFor / GLOW_LINGER
    const rpsScale = Math.min(1, glow.rps / 600)
    const baseAlpha = 0.50 + 0.35 * rpsScale
    const blur      = 5 + 7 * rpsScale

    ctx.save()
    ctx.globalAlpha = baseAlpha * breath * decay
    ctx.shadowColor = glow.color
    ctx.shadowBlur  = blur
    ctx.strokeStyle = glow.color
    ctx.lineWidth   = 1
    roundRectPath(ctx, nx, ny, nw, nh, 8)
    ctx.stroke()
    ctx.restore()
  }

  // Draw circuit-open overlay (amber ⊘)
  for (const [nodeId, breaker] of getAllBreakers()) {
    if (breaker.state === 'closed') continue
    const rect = getNodeCanvasRect(nodeId)
    if (!rect) continue
    const [nx, ny, nw, nh] = rect
    const cx = nx + nw / 2
    const cy = ny + nh / 2

    ctx.save()
    ctx.globalAlpha = breaker.state === 'open' ? 0.7 : 0.4
    ctx.strokeStyle = '#F59E0B'
    ctx.lineWidth   = breaker.state === 'open' ? 2 : 1.5
    if (breaker.state === 'half-open') ctx.setLineDash([4, 3])
    roundRectPath(ctx, nx, ny, nw, nh, 8)
    ctx.stroke()
    ctx.setLineDash([])

    if (breaker.state === 'open') {
      // Draw ⊘ symbol
      const r = 8
      ctx.beginPath()
      ctx.arc(cx, cy - nh / 2 + 8, r, 0, Math.PI * 2)
      ctx.strokeStyle = '#F59E0B'
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(cx - r * 0.7, cy - nh / 2 + 8 - r * 0.7)
      ctx.lineTo(cx + r * 0.7, cy - nh / 2 + 8 + r * 0.7)
      ctx.stroke()
    }
    ctx.restore()
  }

  // Advance particles
  const dt = delta * _speed

  for (const ep of _edgePaths) {
    const arr = state.particles.get(ep.id)
    if (!arr || arr.length === 0) continue

    // For outbound stream edges, slow particles as the source broker fills up.
    // This creates a visual "traffic jam" on the consumer edge — particles pile up
    // when the consumer can't drain the queue fast enough. Inbound (producer→broker)
    // edges run at full speed since Kafka/Kinesis brokers accept without backpressure.
    let streamLagFactor = 1.0
    if (ep.edgeType === 'stream') {
      const srcId = _edgesData.find(e => e.id === ep.id)?.source
      const srcType = ep.sourceNodeType as string | undefined
      if (srcId && srcType && ['queue', 'pubsub', 'stream', 'eventBus'].includes(srcType)) {
        const cap = effectiveConfig(srcId, srcType as NodeType).queueCapacity ?? 1000
        const depth = state.queueDepths.get(srcId) ?? 0
        const depthRatio = Math.min(1, depth / cap)
        streamLagFactor = Math.max(0.1, 1.0 - Math.pow(depthRatio, 2))
      }
    }

    // Request edge timeout: a particle still in flight past timeoutMs is treated as a 504 —
    // the caller gives up waiting before the response (or even the request) completes.
    let requestTimeoutMs: number | undefined
    if (ep.edgeType === 'request') {
      const reqConfig = (_edgesData.find(e => e.id === ep.id)?.data as EdgeData | undefined)?.config as RequestEdgeConfig | undefined
      requestTimeoutMs = reqConfig?.timeoutMs
    }

    const surviving: Particle[] = []
    for (const p of arr) {
      if (requestTimeoutMs !== undefined && requestTimeoutMs > 0 && (now - p.spawnTime) > requestTimeoutMs / _speed) {
        _particleById.delete(p.id)
        handleRequestTimeout(ep, now, p)
        continue
      }

      p.t += p.speed * streamLagFactor * dt

      if (p.t >= 1) {
        _particleById.delete(p.id)
        handleParticleArrival(ep, now, p)
        continue
      }

      surviving.push(p)

      const pos = getEdgePoint(ep.id, p.t)
      if (!pos) continue

      const [px, py] = pos
      ctx.beginPath()
      ctx.arc(px, py, 2.5, 0, Math.PI * 2)
      ctx.fillStyle = p.color
      ctx.shadowBlur = 6
      ctx.shadowColor = p.color
      ctx.fill()
      ctx.shadowBlur = 0
    }

    state.particles.set(ep.id, surviving)
  }

  // Draw error flashes
  const survivingFlashes: ErrorFlash[] = []
  for (const flash of state.errorFlashes) {
    const age = now - flash.startTime
    if (age > ERROR_FLASH_DURATION) continue
    survivingFlashes.push(flash)
    const alpha = 1 - age / ERROR_FLASH_DURATION
    const s     = 5 + 2 * (1 - alpha)

    ctx.save()
    ctx.globalAlpha = alpha * 0.9
    ctx.strokeStyle = '#EF4444'
    ctx.lineWidth   = 2
    ctx.shadowColor = '#EF4444'
    ctx.shadowBlur  = 8 * alpha
    ctx.beginPath()
    ctx.moveTo(flash.x - s, flash.y - s); ctx.lineTo(flash.x + s, flash.y + s)
    ctx.moveTo(flash.x + s, flash.y - s); ctx.lineTo(flash.x - s, flash.y + s)
    ctx.stroke()
    ctx.restore()
  }
  state.errorFlashes.length = 0
  state.errorFlashes.push(...survivingFlashes)
}

// ─── RAF loop ─────────────────────────────────────────────────────────────────

function loop(now: number) {
  const { running, paused } = useSimulationStore.getState()
  if (!running) { state.rafId = null; return }

  if (!paused) {
    const delta = Math.min(now - state.lastTime, 100)
    state.lastTime = now

    if (!_canvas) { state.rafId = requestAnimationFrame(loop); return }

    // Advance the simulation clock by the processed (clamped) delta, scaled by playback speed.
    _simulatedTimeMs += delta * _speed

    // Drain pool/concurrency releases scheduled in simulated time (C2 fix) before spawning this
    // frame's particles, so releases due this frame are visible to this frame's spawn decisions —
    // mirrors processRetryQueue's existing drain-then-spawn ordering.
    drainScheduledReleases(_simulatedTimeMs)

    processRetryQueue(now)
    spawnParticles(now, delta)
    advanceAndDraw(_canvas, now, delta)
    updateAllNodeMetrics(now, delta)
  } else {
    state.lastTime = now
    // While paused and scrubbing, redraw the recorded particle frame at the cursor.
    // Guarded so we only repaint when the cursor actually moves (getEdgePoint hits the DOM).
    const replay = useReplayStore.getState()
    if (replay.isReplaying && _canvas && replay.replayIndex !== _lastReplayIndexDrawn) {
      drawReplayFrame(_canvas, replay.replayIndex)
      _lastReplayIndexDrawn = replay.replayIndex
    }
  }

  state.rafId = requestAnimationFrame(loop)
}

// ─── Color-buffer particle picking ───────────────────────────────────────────

function buildSnapshot(p: Particle): RequestSnapshot {
  const edge    = _edgesData.find(e => e.id === p.edgeId)
  const srcNode = edge ? _nodesMap.get(edge.source) : undefined
  const tgtNode = edge ? _nodesMap.get(edge.target) : undefined
  const edgeType = (edge?.data as EdgeData | undefined)?.edgeType ?? 'request'

  const seed = p.id % 97
  const METHODS     = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']
  const PATHS       = ['/api/v1/data', '/api/v1/users', '/api/v1/orders', '/health', '/api/v1/events', '/api/v1/records']
  const STREAM_OPS  = ['PUBLISH', 'CONSUME', 'EMIT', 'SUBSCRIBE']

  const isStream = edgeType === 'stream' || edgeType === 'event'

  // Custom mode: resolve the real template so the inspector renders a protocol-specific card.
  const tpl = p.templateId !== undefined ? _packetTemplates[p.templateId] : undefined
  const templateInfo: TemplateInfo | undefined = tpl ? (() => {
    const base = { name: tpl.name, protocol: tpl.protocol, sizeKb: tpl.sizeKb }
    switch (tpl.protocol) {
      case 'http':   return { ...base, method: tpl.method, path: tpl.path, statusCode: tpl.statusCode }
      case 'event':  return { ...base, topic: tpl.topic, eventType: tpl.eventType, deliveryMode: tpl.deliveryMode }
      case 'stream': return { ...base, streamId: tpl.streamId, compressionType: tpl.compressionType }
      case 'db':     return { ...base, queryType: tpl.queryType, isWAL: tpl.isWAL, resultSizeKb: tpl.resultSizeKb }
    }
  })() : undefined

  // Method/path: prefer the template, else fall back to today's deterministic placeholders.
  const httpTpl = tpl?.protocol === 'http' ? tpl as HttpTemplate : undefined
  const method  = httpTpl ? httpTpl.method
    : isStream ? STREAM_OPS[seed % STREAM_OPS.length]
    : (p.method ?? METHODS[seed % METHODS.length])
  const path    = httpTpl ? httpTpl.path : PATHS[(seed * 3) % PATHS.length]

  return {
    particleId:   p.id,
    edgeId:       p.edgeId,
    sourceLabel:  (srcNode?.data as NodeData | undefined)?.label ?? 'Unknown',
    targetLabel:  (tgtNode?.data as NodeData | undefined)?.label ?? 'Unknown',
    edgeType,
    retries:      p.retries,
    progress:     p.t,
    httpMethod:   method,
    httpPath:     path,
    payloadBytes: p.payloadBytes,
    templateId:   p.templateId,
    templateInfo,
  }
}

export function pickParticleAtPoint(
  clickX: number,
  clickY: number,
  canvasRect: DOMRect,
): RequestSnapshot | null {
  if (!_canvas) return null

  // Build an off-screen pick canvas on-demand at click time — never maintained per-frame
  const pick = document.createElement('canvas')
  pick.width  = _canvas.width
  pick.height = _canvas.height
  const ctx = pick.getContext('2d')
  if (!ctx) return null

  for (const [, arr] of state.particles) {
    for (const p of arr) {
      const pos = getEdgePoint(p.edgeId, p.t)
      if (!pos) continue
      const [px, py] = pos
      // Encode particle ID into RGB channels (supports up to 16.7M unique IDs)
      ctx.fillStyle = `rgb(${(p.id >> 16) & 0xFF},${(p.id >> 8) & 0xFF},${p.id & 0xFF})`
      ctx.beginPath()
      ctx.arc(px, py, 10, 0, Math.PI * 2)  // 10px radius — generous hit area
      ctx.fill()
    }
  }

  const x = Math.round(clickX - canvasRect.left)
  const y = Math.round(clickY - canvasRect.top)
  const pixel = ctx.getImageData(x, y, 1, 1).data
  if (pixel[3] === 0) return null  // transparent → miss

  const id = (pixel[0] << 16) | (pixel[1] << 8) | pixel[2]
  if (id === 0) return null
  const particle = _particleById.get(id)
  if (!particle) return null

  return buildSnapshot(particle)
}

// ─── Public API ───────────────────────────────────────────────────────────────

let _canvas: HTMLCanvasElement | null = null

export function startSimulation(
  canvas: HTMLCanvasElement,
  nodes: Node<NodeData>[],
  edges: Edge<EdgeData>[],
  speed: number,
) {
  _canvas = canvas
  _speed  = speed
  _nodesMap  = new Map(nodes.map(n => [n.id, n]))
  _edgesData = edges

  // Snapshot the packet registry so the hot loop never reads React state.
  {
    const cs = useCanvasStore.getState()
    _packetMode = cs.packetMode
    _packetTemplates = cs.packetTemplates
    _clientErrorCounts.clear()
  }

  _edgePaths = edges.map(edge => {
    const src = _nodesMap.get(edge.source)
    const tgt = _nodesMap.get(edge.target)
    if (!src || !tgt) return null

    // Traverse the ancestor chain to find the nearest regionId, so nodes nested inside
    // vpc → az → region containers are correctly resolved (not just direct-parent lookup).
    const resolveRegionId = (nodeId: string): string | undefined => {
      let cur = _nodesMap.get(nodeId)
      while (cur) {
        const rid = (cur.data as NodeData | undefined)?.regionId
        if (rid) return rid
        cur = cur.parentId ? _nodesMap.get(cur.parentId) : undefined
      }
      return undefined
    }
    const srcRegionId  = resolveRegionId(edge.source)
    const tgtRegionId  = resolveRegionId(edge.target)
    const geoLatencyMs = srcRegionId && tgtRegionId && srcRegionId !== tgtRegionId
      ? interRegionLatencyMs(srcRegionId, tgtRegionId)
      // One side has a region, the other doesn't — apply a conservative default so
      // the latency cost of leaving/entering a defined region is not silently ignored.
      : (srcRegionId || tgtRegionId) && !(srcRegionId && tgtRegionId) ? 50 : 0

    return {
      id: edge.id,
      edgeType: edge.data?.edgeType ?? 'request',
      sourceNodeType: src.type as NodeType | undefined,
      targetNodeType: tgt.type as NodeType | undefined,
      rps: useSimulationStore.getState().getEdgeRps(edge.id),
      geoLatencyMs,
      effectiveRps: 0
    }
  }).filter(Boolean) as EdgePath[]

  // Stable edgeId → index map for packing/unpacking particle keyframes during replay.
  _edgeIndexMap.clear()
  _edgePaths.forEach((ep, i) => _edgeIndexMap.set(ep.id, i))
  _particleFrames.length = 0
  _lastReplayIndexDrawn = -1

  // Seed HPA replicas from each pod's k8sPod.replicas config
  _podReplicas.clear()
  for (const n of nodes) {
    if (n.type !== 'pod') continue
    const cfg = effectiveConfig(n.id, 'pod')
    if (cfg.k8sPod) _podReplicas.set(n.id, cfg.k8sPod.replicas)
  }
  _namespaceConsumedRps.clear()
  _clusterConsumedRps.clear()
  _quotaConstrainedNodes.clear()
  _clusterExhaustedNodes.clear()
  _hpaBlockedNodes.clear()

  clearCaches()
  if (state.rafId !== null) cancelAnimationFrame(state.rafId)

  _simStartTime    = performance.now()
  clearChaosState()
  _simulatedTimeMs = 0
  _egressBytesAccum.clear()
  _lastEgressFlushAt = 0
  _frameCount = 0
  _latencyWindows.clear()
  _upstreamPressure.clear()
  _downstreamStallPressure.clear()
  _saturatedNodes.clear()
  _streamBackpressureEdges.clear()
  clearBreakers()
  _smoothedMetrics.clear()
  clearBackpressureState()
  _lbActiveRequests.clear()
  _nodeHealthStates.clear()
  _recoveryUntil.clear()
  _stallSources.clear()
  _particleById.clear()
  _particleIdCounter = 0
  _currentCapacity.clear()
  _scaleOutPending.clear()
  _scaleInCooldown.clear()
  _restartCounts.clear()
  _restartCooldown.clear()
  _retryQueue.length = 0

  state.lastTime = _simStartTime
  state.rafId    = requestAnimationFrame(loop)
}

export function stopSimulation() {
  if (state.rafId !== null) { cancelAnimationFrame(state.rafId); state.rafId = null }
  clearChaosState()
  state.particles.clear()
  state.nodeGlows.clear()
  state.roundRobinIndex.clear()
  state.queueDepths.clear()
  state.nodeConcurrency.clear()
  state.errorFlashes.length = 0
  _latencyWindows.clear()
  _upstreamPressure.clear()
  _downstreamStallPressure.clear()
  _streamBackpressureEdges.clear()
  clearBreakers()
  clearBackpressureState()
  _lbActiveRequests.clear()
  _nodeHealthStates.clear()
  _recoveryUntil.clear()
  _stallSources.clear()
  _particleById.clear()
  _particleIdCounter = 0
  _currentCapacity.clear()
  _scaleOutPending.clear()
  _scaleInCooldown.clear()
  _restartCounts.clear()
  _restartCooldown.clear()
  _retryQueue.length = 0
  _droppedCounts.clear()
  _deadLetterCounts.clear()
  _simulatedTimeMs = 0
  _egressBytesAccum.clear()
  _lastEgressFlushAt = 0
  _smoothedMetrics.clear()
  _particleFrames.length = 0
  _edgeIndexMap.clear()
  _lastReplayIndexDrawn = -1
  _podReplicas.clear()
  _namespaceConsumedRps.clear()
  _clusterConsumedRps.clear()
  _quotaConstrainedNodes.clear()
  _clusterExhaustedNodes.clear()
  _hpaBlockedNodes.clear()
  if (_canvas) {
    _canvas.getContext('2d')?.clearRect(0, 0, _canvas.width, _canvas.height)
  }
}

export function updateSpeed(speed: number) {
  _speed = speed
}

// Number of particles currently in flight on a given edge. Read-only test/debug accessor —
// `state.particles` is otherwise module-private (mutated only inside the rAF loop, per the
// particle-state architecture rule), but tests need a way to assert "no particle was minted"
// without reaching into canvas pixel-picking (pickParticleAtPoint requires real layout geometry).
export function getParticleCountForEdge(edgeId: string): number {
  return state.particles.get(edgeId)?.length ?? 0
}

// Elapsed SIMULATION time in seconds (pause/speed/lag-proof). Consumers that record a replay-
// timeline coordinate (health frames, event elapsedS) must use this — never the wall clock —
// so they stay aligned with the particle keyframes the engine timestamps the same way.
export function getSimulatedElapsedS(): number {
  return _simulatedTimeMs / 1000
}

export function updateTrafficMode(mode: TrafficMode) {
  _trafficMode = mode
  clearChaosState()
}

export function updateGlobalMultiplier(mult: number) {
  _globalMultiplier = mult
}

export function setNodeConfigs(configs: Map<string, NodeSimConfig>) {
  _nodeConfigs = configs
}

export function setNodeProviders(providers: Map<string, CloudProvider>) {
  _nodeProviders = providers
}

export function injectBurst(nodeId: string, edges: Edge<EdgeData>[]) {
  const outEdges = edges.filter(e => e.source === nodeId)
  for (const edge of outEdges) {
    const ep = _edgePaths.find(e => e.id === edge.id)
    if (!ep) continue
    if (!state.particles.has(edge.id)) state.particles.set(edge.id, [])
    const arr = state.particles.get(edge.id)!
    for (let i = 0; i < 20; i++) {
      const templateId = _packetMode === 'custom' ? rollDistribution(nodeId, ep.edgeType as EdgeType) : undefined
      const tpl = templateId !== undefined ? _packetTemplates[templateId] : undefined
      const _bp: Particle = { id: ++_particleIdCounter, t: 0, speed: PARTICLE_SPEED_BASE * (0.8 + Math.random() * 0.8), color: tpl?.colorOverride ?? edgeColor(ep.edgeType), edgeId: edge.id, retries: 0, originLatencyMs: 0, spawnTime: performance.now(), payloadBytes: templatePayloadBytes(templateId, ep.targetNodeType, edge.id), templateId }
      arr.push(_bp)
      _particleById.set(_bp.id, _bp)
    }
  }
}
