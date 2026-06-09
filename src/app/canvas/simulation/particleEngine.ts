import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData, NodeType, NodeSimConfig, RetryConfig } from '../../../lib/nodeConfig'
import { GROUPING_TYPES } from '../../../lib/nodeConfig'
import { interRegionLatencyMs } from '../../../lib/regionConfig'
import { useSimulationStore, type TrafficMode, type NodeMetrics, type SimEventType, type CircuitState, type RequestSnapshot } from '../../store/simulation.store'
import { useReplayStore } from '../../store/replay.store'
import { NODE_SIM_DEFAULTS } from '../../simulation/defaults'

// ─── Public types ─────────────────────────────────────────────────────────────

export interface Particle {
  id: number              // stable unique ID for color-buffer click picking
  t: number
  speed: number
  color: string
  edgeId: string
  retries: number         // 0 on first spawn; incremented on each retry
  originLatencyMs: number // geographic client→server delay; consumed at first node arrival
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

interface CircuitBreakerEntry {
  state: CircuitState
  openedAt: number
  errorWindow: number[]
}

interface RetryEntry {
  edgeId: string
  color: string
  retries: number   // attempt number this particle is on (1 = first retry)
  fireAt: number    // performance.now() timestamp when it should re-spawn
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

// In-flight synchronous request threads held at source nodes (request-edge thread pool model)
const _activeWorkers = new Map<string, number>()

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

// Circuit breakers per edge (client-side: each directed edge owns its own breaker)
const _circuitBreakers = new Map<string, CircuitBreakerEntry>()

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

// ─── Latency helpers ──────────────────────────────────────────────────────────

function sampleLatencyMs(p50: number, p99: number): number {
  const mu    = Math.log(Math.max(p50, 0.001))
  const sigma = (Math.log(Math.max(p99, p50 + 0.001)) - mu) / 2.326
  const u1    = Math.max(1e-10, Math.random())
  const u2    = Math.random()
  const z     = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  return Math.exp(mu + sigma * z)
}

function recordLatency(nodeId: string, ms: number) {
  let window = _latencyWindows.get(nodeId)
  if (!window) { window = []; _latencyWindows.set(nodeId, window) }
  window.push(ms)
  if (window.length > 200) window.splice(0, window.length - 200)
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
}

let _edgePaths: EdgePath[] = []
let _speed = 1
let _trafficMode: TrafficMode = 'steady'
let _globalMultiplier = 1
let _nodeConfigs: Map<string, NodeSimConfig> = new Map()
let _nodesMap: Map<string, Node<NodeData>> = new Map()
let _edgesData: Edge<EdgeData>[] = []
let _simStartTime = 0

// Spike mode state
let _spikeNextAt = 0
let _spikeEndAt  = 0

// Chaos mode failure entry — mode determines how the failure manifests
interface ChaosEntry {
  expiry: number
  mode: 'crash' | 'latency' | 'partial'
  dropRate: number  // fraction of arriving requests that fail (1.0 = crash, 0.9 = latency, 0.5–0.8 = partial)
}
const _chaosFailures = new Map<string, ChaosEntry>()
let _chaosNextFailAt = 0

// Connection pool tracking (7a)
const _activeConnections = new Map<string, number>()

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

// Lambda warm instance tracking (7b)
const _warmInstances    = new Map<string, number>()  // nodeId → warm count
const _warmLastActivity = new Map<string, number>()  // nodeId → last request ts
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
  const override = _nodeConfigs.get(nodeId)
  const defaults = NODE_SIM_DEFAULTS[nodeType] ?? { maxRps: 1000, processingMs: 10, errorRate: 0 }
  return override ? { ...defaults, ...override } : defaults
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

function effectiveMultiplier(now: number): number {
  switch (_trafficMode) {
    case 'steady':
      return _globalMultiplier

    case 'ramp': {
      const elapsed = now - _simStartTime
      const rampMs  = 120_000   // 2-min ramp to observe cascade effects
      return _globalMultiplier * Math.min(1, elapsed / rampMs)
    }

    case 'spike': {
      if (now >= _spikeEndAt) {
        if (_spikeNextAt === 0) _spikeNextAt = now + 30_000
        if (now >= _spikeNextAt) {
          _spikeEndAt  = now + 10_000    // 10s burst
          _spikeNextAt = _spikeEndAt + 30_000  // 30s cooldown
        }
      }
      const inSpike = now < _spikeEndAt
      return _globalMultiplier * (inSpike ? 8 : 1)  // 8× flash crowd
    }

    case 'chaos': {
      if (_chaosNextFailAt === 0) _chaosNextFailAt = now + 5_000 + Math.random() * 10_000
      if (now >= _chaosNextFailAt) {
        const nonGroupNodes = [..._nodesMap.values()].filter(n => !GROUPING_TYPES.has(n.type as NodeType))
        if (nonGroupNodes.length > 0) {
          const victim = nonGroupNodes[Math.floor(Math.random() * nonGroupNodes.length)]
          const failDuration = 5_000 + Math.random() * 15_000  // 5–20s failures
          const wasAlreadyFailed = _chaosFailures.has(victim.id)
          const modeRoll = Math.random()
          const mode: ChaosEntry['mode'] = modeRoll < 0.4 ? 'crash' : modeRoll < 0.7 ? 'latency' : 'partial'
          const dropRate = mode === 'crash' ? 1.0 : mode === 'latency' ? 0.9 : 0.5 + Math.random() * 0.3
          _chaosFailures.set(victim.id, { expiry: now + failDuration, mode, dropRate })
          if (!wasAlreadyFailed) {
            const label = (victim.data as NodeData).label ?? victim.id
            const modeLabel = mode === 'crash' ? 'crash' : mode === 'latency' ? 'latency spike' : 'partial failure'
            _onEvent('chaos_failure', victim.id, `${label} ${modeLabel} (chaos)`, 'warn')
          }
        }
        _chaosNextFailAt = now + 5_000 + Math.random() * 10_000
      }
      // Emit recovery events for expired failures
      for (const [id, entry] of _chaosFailures) {
        if (now > entry.expiry) {
          const node = _nodesMap.get(id)
          const label = node ? (node.data as NodeData).label ?? id : id
          _chaosFailures.delete(id)
          _onEvent('chaos_recovery', id, `${label} recovered`, 'info')
        }
      }
      if (_spikeNextAt === 0) _spikeNextAt = now + 8_000
      if (now >= _spikeNextAt) {
        _spikeEndAt  = now + 5_000
        _spikeNextAt = _spikeEndAt + 8_000 + Math.random() * 8_000
      }
      const inSpike = now < _spikeEndAt
      return _globalMultiplier * (inSpike ? 6 : 1)  // 6× chaos spikes
    }
  }
}

// ─── Circuit breaker helpers ──────────────────────────────────────────────────

function getBreaker(edgeId: string): CircuitBreakerEntry {
  let b = _circuitBreakers.get(edgeId)
  if (!b) {
    b = { state: 'closed', openedAt: 0, errorWindow: [] }
    _circuitBreakers.set(edgeId, b)
  }
  return b
}

function recordBreakerResult(edgeId: string, isError: boolean, config: NodeSimConfig, now: number) {
  const b = getBreaker(edgeId)
  const cb = config.circuitBreaker
  if (!cb) return

  b.errorWindow.push(isError ? 1 : 0)
  if (b.errorWindow.length > 20) b.errorWindow.splice(0, b.errorWindow.length - 20)

  const edgeData     = _edgesData.find(e => e.id === edgeId)
  const targetNodeId = edgeData?.target
  const srcLabel     = edgeData?.source ? ((_nodesMap.get(edgeData.source)?.data as NodeData)?.label ?? edgeData.source) : edgeId
  const tgtLabel     = targetNodeId    ? ((_nodesMap.get(targetNodeId)?.data    as NodeData)?.label ?? targetNodeId)    : edgeId

  if (b.state === 'closed') {
    const errRate = b.errorWindow.reduce((s, v) => s + v, 0) / b.errorWindow.length
    if (errRate >= cb.errorThreshold && b.errorWindow.length >= 10) {
      b.state    = 'open'
      b.openedAt = now
      const cbCausedBy = targetNodeId && (_upstreamPressure.get(targetNodeId) ?? 0) > 0.2
        ? _stallSources.get(targetNodeId)
        : undefined
      _onEvent('circuit_open', targetNodeId, `Circuit open: ${srcLabel} → ${tgtLabel}`, 'critical', undefined, cbCausedBy)
    }
  } else if (b.state === 'half-open') {
    if (!isError) {
      b.state       = 'closed'
      b.errorWindow = []
      _onEvent('circuit_close', targetNodeId, `Circuit closed: ${srcLabel} → ${tgtLabel}`, 'info')
    } else {
      b.state    = 'open'
      b.openedAt = now
    }
  }
}

function checkBreakerTransition(edgeId: string, config: NodeSimConfig, now: number): CircuitState {
  const b = getBreaker(edgeId)
  const cb = config.circuitBreaker
  if (!cb) return 'closed'

  const edgeData     = _edgesData.find(e => e.id === edgeId)
  const targetNodeId = edgeData?.target

  // Don't allow reset while the target node's health is 'down' — CB must stay open
  if (
    b.state === 'open' &&
    (targetNodeId === undefined || _nodeHealthStates.get(targetNodeId) !== 'down') &&
    now - b.openedAt > cb.resetMs
  ) {
    b.state = 'half-open'
    const srcLabel = edgeData?.source ? ((_nodesMap.get(edgeData.source)?.data as NodeData)?.label ?? edgeData.source) : edgeId
    const tgtLabel = targetNodeId    ? ((_nodesMap.get(targetNodeId)?.data    as NodeData)?.label ?? targetNodeId)    : edgeId
    _onEvent('circuit_half_open', targetNodeId, `Circuit half-open: ${srcLabel} → ${tgtLabel} (testing)`, 'warn')
  }
  return b.state
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

// Node types that model a traditional thread pool: slow downstream holds a thread, blocking new requests
const THREAD_POOL_TYPES = new Set<string>(['ec2', 'container', 'pod', 'k8sCluster', 'ecsCluster'])

function trackRequest(nodeId: string, nodeType: NodeType, config: NodeSimConfig) {
  if (_LB_SKIP_TYPES.has(nodeType) || GROUPING_TYPES.has(nodeType)) return
  _lbActiveRequests.set(nodeId, (_lbActiveRequests.get(nodeId) ?? 0) + 1)
  setTimeout(() => {
    _lbActiveRequests.set(nodeId, Math.max(0, (_lbActiveRequests.get(nodeId) ?? 1) - 1))
  }, Math.max(50, effectiveProcessingMs(nodeId, config)) / _speed)
}

// ─── Spawning ────────────────────────────────────────────────────────────────

const PARTICLE_SPEED_BASE = 0.0006
const MAX_PARTICLES = 500

function spawnParticles(now: number, delta: number) {
  let total = 0
  for (const arr of state.particles.values()) total += arr.length
  if (total >= MAX_PARTICLES) return

  const mult = effectiveMultiplier(now)

  for (const ep of _edgePaths) {
    // Suppress downstream spawning when the source node has failed or tripped its circuit breaker.
    // Models: a dead or circuit-open node can't forward traffic, so its outbound edges go dark.
    const sourceNodeId = _edgesData.find(e => e.id === ep.id)?.source
    let downstreamFactor = 1.0
    if (sourceNodeId) {
      const chaosEntry = _chaosFailures.get(sourceNodeId)
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
        const breaker = _circuitBreakers.get(ep.id)
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
        && !_LB_SKIP_TYPES.has(ep.sourceNodeType)) {
      const hasInbound = _edgesData.some(e => e.target === sourceNodeId)
      if (hasInbound) {
        const srcMetrics = _smoothedMetrics.get(sourceNodeId)
        if (srcMetrics && srcMetrics.inRps < IDLE_RPS_THRESHOLD) {
          // Soft fade: 0 RPS → 0%, 5 RPS → 100%. Saturates immediately above the threshold.
          downstreamFactor *= srcMetrics.inRps / IDLE_RPS_THRESHOLD
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

    const rps = ep.rps * mult * downstreamFactor
    const particlesPerSec = rps / 10
    const spawnChance = particlesPerSec * (delta / 1000) * _speed
    const n = Math.floor(spawnChance) + (Math.random() < (spawnChance % 1) ? 1 : 0)
    if (n === 0) continue

    // Thread pool gate: request edges on compute source nodes must acquire a worker thread.
    // A slow downstream holds threads until its response arrives; exhaustion causes local 503s
    // at the source (CPU stays low, I/O blocks the pool) — no scalar stall pressure needed.
    if (ep.edgeType === 'request' && sourceNodeId && ep.sourceNodeType && THREAD_POOL_TYPES.has(ep.sourceNodeType)) {
      const active = _activeWorkers.get(sourceNodeId) ?? 0
      const maxThreads = effectiveConfig(sourceNodeId, ep.sourceNodeType as NodeType).maxConcurrency ?? 200
      if (active >= maxThreads) {
        spawnErrorFlash(sourceNodeId)
        _droppedCounts.set(sourceNodeId, (_droppedCounts.get(sourceNodeId) ?? 0) + n)
        continue
      }
      _activeWorkers.set(sourceNodeId, Math.min(maxThreads, active + n))
    }

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
    for (let i = 0; i < n && total < MAX_PARTICLES; i++) {
      const pid = ++_particleIdCounter
      const p: Particle = {
        id: pid,
        t: 0,
        speed: PARTICLE_SPEED_BASE * (0.8 + Math.random() * 0.4) * geoSpeedFactor,
        color: edgeColor(ep.edgeType),
        edgeId: ep.id,
        retries: 0,
        originLatencyMs,
      }
      arr.push(p)
      _particleById.set(pid, p)
      total++
    }
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
      _activeWorkers.set(sourceNodeId, Math.max(0, (_activeWorkers.get(sourceNodeId) ?? 1) - 1))
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

  // Schedule retry with exponential backoff + jitter if the target node allows it
  if (particle) {
    const targetNode = _nodesMap.get(targetNodeId)
    const targetType = targetNode?.type as NodeType | undefined
    const config = targetType ? effectiveConfig(targetNodeId, targetType) : null
    const rc = config?.retryConfig
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
          return _circuitBreakers.get(e.id)?.state !== 'open'
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
  const chaosEntry = _chaosFailures.get(targetNodeId)
  if (chaosEntry && Math.random() < chaosEntry.dropRate) {
    recordBreakerResult(ep.id, true, config, now)
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

  // Connection pool check (7a) — databases and caches
  if (config.connectionPool) {
    const active = _activeConnections.get(targetNodeId) ?? 0
    if (active >= config.connectionPool.max) {
      dropParticle(ep, targetNodeId, particle)
      const label = ((_nodesMap.get(targetNodeId))?.data as NodeData)?.label ?? targetNodeId
      _onEvent('connection_pool_exhausted', targetNodeId, `${label} connection pool exhausted (${active}/${config.connectionPool.max})`, 'critical', { utilization: 1, errorRate: 1 })
      return
    }
    _activeConnections.set(targetNodeId, active + 1)
    const releaseDelay = Math.max(50, effectiveProcessingMs(targetNodeId, config)) / _speed
    setTimeout(() => {
      _activeConnections.set(targetNodeId, Math.max(0, (_activeConnections.get(targetNodeId) ?? 1) - 1))
    }, releaseDelay)
  }

  // Check circuit breaker state (keyed on edge — client-side breaker)
  const breakerState = checkBreakerTransition(ep.id, config, now)
  if (breakerState === 'open') {
    dropParticle(ep, targetNodeId, particle)
    recordBreakerResult(ep.id, true, config, now)
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
      recordBreakerResult(ep.id, true, config, now)
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
        recordBreakerResult(ep.id, true, config, now)
        return
      }
      // Cold start: warm instances expire after 5 min idle
      const lastAct  = _warmLastActivity.get(targetNodeId) ?? 0
      const maxWarm  = config.maxWarmInstances ?? 5
      const warm     = now - lastAct > LAMBDA_WARM_IDLE_MS ? 0 : (_warmInstances.get(targetNodeId) ?? 0)
      let effectiveLatency = sampledLatency  // already includes origin + geo offsets
      if (cur >= warm && config.coldStart) {
        // Pay cold-start penalty
        const cs = config.coldStart
        effectiveLatency += sampleLatencyMs(cs.p50Ms, cs.p99Ms)
        const label = ((_nodesMap.get(targetNodeId))?.data as NodeData)?.label ?? targetNodeId
        _onEvent('lambda_cold_start', targetNodeId, `${label} cold start (+${Math.round(effectiveLatency - sampledLatency)}ms)`, 'warn', { p90LatencyMs: effectiveLatency })
      }
      _warmInstances.set(targetNodeId, Math.min(maxWarm, warm + 1))
      _warmLastActivity.set(targetNodeId, now)
      state.nodeConcurrency.set(targetNodeId, cur + 1)
      const healthMult = _nodeHealthStates.get(targetNodeId) === 'degraded'
        ? (1 + degradedDepth(_smoothedMetrics.get(targetNodeId)?.healthScore ?? 0.67))
        : 1
      const delay = Math.max(50, effectiveLatency * healthMult) / _speed
      recordLatency(targetNodeId, effectiveLatency)
      setTimeout(() => {
        const c = state.nodeConcurrency.get(targetNodeId) ?? 0
        state.nodeConcurrency.set(targetNodeId, Math.max(0, c - 1))
      }, delay)
      recordBreakerResult(ep.id, false, config, now)
      trackRequest(targetNodeId, targetNodeType, config)
      // Release source thread: blocked for the full lambda execution time + response transit
      if (ep.edgeType === 'request' && sourceNodeId && ep.sourceNodeType && THREAD_POOL_TYPES.has(ep.sourceNodeType)) {
        setTimeout(() => {
          _activeWorkers.set(sourceNodeId, Math.max(0, (_activeWorkers.get(sourceNodeId) ?? 1) - 1))
        }, (effectiveLatency + ep.geoLatencyMs) / _speed)
      }
      forwardToOutbound(targetNodeId, targetNodeType)
      return
    }

    // Database nodes: separate read/write capacity limits + SQL locking penalty
    if (config.dbConfig && (targetNodeType === 'dbSql' || targetNodeType === 'dbNoSql')) {
      const edgeReadPct = ((_edgesData.find(e => e.id === ep.id)?.data as EdgeData | undefined)?.readPercentage ?? 0.8)
      const readRps   = totalInRps * edgeReadPct
      const writeRps  = totalInRps * (1 - edgeReadPct)
      const readUtil  = readRps  / config.dbConfig.maxReadRps
      const writeUtil = writeRps / config.dbConfig.maxWriteRps

      if (Math.max(readUtil, writeUtil) >= 1.0 + config.errorRate) {
        _dbSaturationReason.set(targetNodeId, writeUtil >= readUtil ? 'write' : 'read')
        dropParticle(ep, targetNodeId, particle)
        recordBreakerResult(ep.id, true, config, now)
        return
      }

      // Per-particle latency: read or write lane based on particle ID modulo.
      // SQL locking: heavy write utilization increases read latency exponentially (row/table locks).
      const isRead = isReadParticle(particle.id, edgeReadPct)
      let dbLatency = isRead ? config.dbConfig.readLatencyMs : config.dbConfig.writeLatencyMs
      if (targetNodeType === 'dbSql') {
        const lockingPenalty = Math.pow(writeUtil, 2) * 50  // up to +50ms at 100% write util
        dbLatency += lockingPenalty  // applies to both reads AND writes under SQL contention
      }
      particle.originLatencyMs = 0
      recordLatency(targetNodeId, dbLatency)
      recordBreakerResult(ep.id, false, config, now)
      trackRequest(targetNodeId, targetNodeType, config)
      if (ep.edgeType === 'request' && sourceNodeId && ep.sourceNodeType && THREAD_POOL_TYPES.has(ep.sourceNodeType)) {
        setTimeout(() => {
          _activeWorkers.set(sourceNodeId, Math.max(0, (_activeWorkers.get(sourceNodeId) ?? 1) - 1))
        }, (dbLatency + ep.geoLatencyMs) / _speed)
      }
      forwardToOutbound(targetNodeId, targetNodeType)
      return
    }

    // Other non-queue nodes: drop if at capacity
    if (utilization >= 1.0 + config.errorRate) {
      dropParticle(ep, targetNodeId, particle)
      recordBreakerResult(ep.id, true, config, now)
      return
    }
  }

  // Regular compute nodes: if every outbound dependency is circuit-open, this request cannot
  // be fulfilled — fail it so the inbound circuit (LB→server) accumulates errors naturally.
  if (!isQueue && targetNodeType !== 'loadBalancer' && targetNodeType !== 'apiGateway'
      && !['k8sCluster', 'ecsCluster', 'dockerCompose'].includes(targetNodeType)
      && targetNodeType !== 'lambda') {
    const outEdges = _edgePaths.filter(e => _edgesData.find(d => d.id === e.id)?.source === targetNodeId)
    if (outEdges.length > 0 && outEdges.every(e => _circuitBreakers.get(e.id)?.state === 'open')) {
      recordBreakerResult(ep.id, true, config, now)
      dropParticle(ep, targetNodeId, particle)
      return
    }
  }

  recordBreakerResult(ep.id, false, config, now)
  trackRequest(targetNodeId, targetNodeType, config)

  // Release source thread after target finishes processing and response transits back.
  // This is what causes thread-pool exhaustion: a slow target holds threads at the source
  // until the response arrives, not until the request is sent.
  if (ep.edgeType === 'request' && sourceNodeId && ep.sourceNodeType && THREAD_POOL_TYPES.has(ep.sourceNodeType)) {
    setTimeout(() => {
      _activeWorkers.set(sourceNodeId, Math.max(0, (_activeWorkers.get(sourceNodeId) ?? 1) - 1))
    }, (sampledLatency + ep.geoLatencyMs) / _speed)
  }

  // Load balancer / API gateway: round-robin or least-connections routing
  if (targetNodeType === 'loadBalancer' || targetNodeType === 'apiGateway') {
    const outEdges = _edgePaths.filter(e =>
      _edgesData.find(d => d.id === e.id)?.source === targetNodeId,
    )
    if (outEdges.length > 0) {
      const lbConfig = effectiveConfig(targetNodeId, targetNodeType)
      let chosenEp: EdgePath

      // Exclude backends whose circuit breaker is open or whose health state is 'down'.
      // Falls back to the full pool only if ALL backends are unavailable — ensures the LB
      // never silently blackholes traffic when there is no healthy option.
      const availableEdges = outEdges.filter(e => {
        const tgtId = _edgesData.find(d => d.id === e.id)?.target
        return _circuitBreakers.get(e.id)?.state !== 'open'
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
      const _lbp: Particle = { id: ++_particleIdCounter, t: 0, speed: PARTICLE_SPEED_BASE, color: edgeColor(chosenEp.edgeType), edgeId: chosenEp.id, retries: 0, originLatencyMs: 0 }
      state.particles.get(chosenEp.id)!.push(_lbp)
      _particleById.set(_lbp.id, _lbp)
    }
    return
  }

  // Orchestration clusters: forward to all outbound (broadcast)
  if (['k8sCluster', 'ecsCluster', 'dockerCompose'].includes(targetNodeType)) {
    forwardToOutbound(targetNodeId, targetNodeType)
    return
  }
}

function forwardToOutbound(nodeId: string, _nodeType: NodeType) {
  const outEdges = _edgePaths.filter(e =>
    _edgesData.find(d => d.id === e.id)?.source === nodeId,
  )
  if (outEdges.length === 0) return
  const outEp = outEdges[Math.floor(Math.random() * outEdges.length)]
  if (!state.particles.has(outEp.id)) state.particles.set(outEp.id, [])
  const _fwdp: Particle = { id: ++_particleIdCounter, t: 0, speed: PARTICLE_SPEED_BASE, color: edgeColor(outEp.edgeType), edgeId: outEp.id, retries: 0, originLatencyMs: 0 }
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

function recordParticleFrame(now: number) {
  // Pack [edgeIdx, t] for every live particle on a mappable edge (exact-sized typed array).
  const pairs: number[] = []
  for (const [edgeId, arr] of state.particles) {
    const idx = _edgeIndexMap.get(edgeId)
    if (idx === undefined) continue
    for (const p of arr) { pairs.push(idx, p.t) }
  }
  const elapsedS = (now - _simStartTime) / 1000
  _particleFrames.push({ elapsedS, packed: Float32Array.from(pairs) })
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
  for (let i = 0; i < packed.length; i += 2) {
    const ep = _edgePaths[packed[i]]
    if (!ep) continue
    const pos = getEdgePoint(ep.id, packed[i + 1])
    if (!pos) continue
    const color = edgeColor(ep.edgeType)
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
  recordParticleFrame(now)

  const mult = effectiveMultiplier(now)
  const metricsBatch = new Map<string, NodeMetrics>()

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

    const inEdges  = _edgePaths.filter(ep => _edgesData.find(d => d.id === ep.id)?.target === nodeId)
    const outEdges = _edgePaths.filter(ep => _edgesData.find(d => d.id === ep.id)?.source === nodeId)
    const inRps  = inEdges.reduce((s, e) => s + e.rps, 0) * mult
    const outRps = outEdges.reduce((s, e) => s + e.rps, 0) * mult

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
        if (config.selfHealing && _chaosFailures.has(nodeId)) {
          const expiry = _chaosFailures.get(nodeId)?.expiry ?? 0
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
      }

      if (_nodeHealthStates.get(nodeId) === 'degraded') {
        const prevScore = _smoothedMetrics.get(nodeId)?.healthScore ?? 0.67
        effectiveMaxRps = effectiveMaxRps * (1 - degradedDepth(prevScore) * 0.5)
      }
      utilization = Math.min(1, inRps / effectiveMaxRps)
    }

    if (_chaosFailures.has(nodeId)) utilization = 1

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
      .map(e => _circuitBreakers.get(e.id)?.state ?? 'closed')
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

    const rawErrorRate = Math.min(1, baseErrorRate + cascadePressure * 0.15)

    const activeRequests = _lbActiveRequests.get(nodeId)

    const dbSaturation = _dbSaturationReason.get(nodeId)
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
      ...(dbSaturation !== undefined && { dbSaturation }),
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
    if (healthState === 'down') {
      const label = (node.data as NodeData).label ?? nodeId
      for (const e of _edgesData.filter(ed => ed.target === nodeId)) {
        const edgePath = _edgePaths.find(ep => ep.id === e.id)
        if (edgePath?.edgeType === 'event' || edgePath?.edgeType === 'stream') continue
        const breaker = getBreaker(e.id)
        if (breaker.state !== 'open') {
          breaker.state    = 'open'
          breaker.openedAt = now
          const srcLabel = (_nodesMap.get(e.source)?.data as NodeData)?.label ?? e.source
          _onEvent('circuit_open', nodeId, `Circuit open: ${srcLabel} → ${label} (health: down)`, 'critical')
        }
      }
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
      // Discrete fields — no smoothing
      queueDepth:       rawMetrics.queueDepth,
      consumerLagMs:    rawMetrics.consumerLagMs,
      concurrency:      rawMetrics.concurrency,
      activeRequests:   rawMetrics.activeRequests,
      circuitState:     rawMetrics.circuitState,
      healthScore:      rawMetrics.healthScore,
      healthState:      rawMetrics.healthState,
      droppedRequests:  rawMetrics.droppedRequests,
      dbSaturation:     rawMetrics.dbSaturation,
    } : rawMetrics
    _smoothedMetrics.set(nodeId, metrics)

    metricsBatch.set(nodeId, metrics)
    // Bottleneck threshold uses raw utilization (before stall inflation) so nodes aren't
    // marked as bottlenecks purely because their downstream is failing
    _onBottleneck(nodeId, rawUtilization > 0.8)
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
  for (const [edgeId, breaker] of _circuitBreakers) {
    if (breaker.state !== 'open') continue
    const edgeData    = _edgesData.find(e => e.id === edgeId)
    if (!edgeData) continue
    const targetId    = edgeData.target
    if (_nodeHealthStates.get(targetId) === 'down') continue
    const tgtType     = _nodesMap.get(targetId)?.type as NodeType | undefined
    if (!tgtType) continue
    const cb          = effectiveConfig(targetId, tgtType).circuitBreaker
    if (!cb || now - breaker.openedAt <= cb.resetMs) continue
    breaker.state     = 'half-open'
    const srcLabel    = (_nodesMap.get(edgeData.source)?.data as NodeData)?.label ?? edgeData.source
    const tgtLabel    = (_nodesMap.get(targetId)?.data    as NodeData)?.label ?? targetId
    _onEvent('circuit_half_open', targetId, `Circuit half-open: ${srcLabel} → ${tgtLabel} (testing)`, 'warn')
  }
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
    const _rp: Particle = { id: ++_particleIdCounter, t: 0, speed: PARTICLE_SPEED_BASE * (0.8 + Math.random() * 0.4), color: r.color, edgeId: r.edgeId, retries: r.retries, originLatencyMs: 0 }
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
  for (const [nodeId, breaker] of _circuitBreakers) {
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

    const surviving: Particle[] = []
    for (const p of arr) {
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
  const method   = isStream ? STREAM_OPS[seed % STREAM_OPS.length] : METHODS[seed % METHODS.length]
  const path     = PATHS[(seed * 3) % PATHS.length]

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
    payloadBytes: 64 + ((seed * 41) % 8192),
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
  _spikeNextAt     = 0
  _spikeEndAt      = 0
  _chaosNextFailAt = 0
  _chaosFailures.clear()
  _frameCount = 0
  _latencyWindows.clear()
  _upstreamPressure.clear()
  _downstreamStallPressure.clear()
  _saturatedNodes.clear()
  _circuitBreakers.clear()
  _smoothedMetrics.clear()
  _activeConnections.clear()
  _lbActiveRequests.clear()
  _activeWorkers.clear()
  _nodeHealthStates.clear()
  _recoveryUntil.clear()
  _stallSources.clear()
  _particleById.clear()
  _particleIdCounter = 0
  _warmInstances.clear()
  _warmLastActivity.clear()
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
  state.particles.clear()
  state.nodeGlows.clear()
  state.roundRobinIndex.clear()
  state.queueDepths.clear()
  state.nodeConcurrency.clear()
  state.errorFlashes.length = 0
  _latencyWindows.clear()
  _upstreamPressure.clear()
  _downstreamStallPressure.clear()
  _circuitBreakers.clear()
  _activeConnections.clear()
  _lbActiveRequests.clear()
  _nodeHealthStates.clear()
  _recoveryUntil.clear()
  _stallSources.clear()
  _particleById.clear()
  _particleIdCounter = 0
  _warmInstances.clear()
  _warmLastActivity.clear()
  _currentCapacity.clear()
  _scaleOutPending.clear()
  _scaleInCooldown.clear()
  _restartCounts.clear()
  _restartCooldown.clear()
  _retryQueue.length = 0
  _droppedCounts.clear()
  _activeWorkers.clear()
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

export function updateTrafficMode(mode: TrafficMode) {
  _trafficMode = mode
  _spikeNextAt = 0; _spikeEndAt = 0
  _chaosFailures.clear(); _chaosNextFailAt = 0
}

export function updateGlobalMultiplier(mult: number) {
  _globalMultiplier = mult
}

export function setNodeConfigs(configs: Map<string, NodeSimConfig>) {
  _nodeConfigs = configs
}

export function injectBurst(nodeId: string, edges: Edge<EdgeData>[]) {
  const outEdges = edges.filter(e => e.source === nodeId)
  for (const edge of outEdges) {
    const ep = _edgePaths.find(e => e.id === edge.id)
    if (!ep) continue
    if (!state.particles.has(edge.id)) state.particles.set(edge.id, [])
    const arr = state.particles.get(edge.id)!
    for (let i = 0; i < 20; i++) {
      const _bp: Particle = { id: ++_particleIdCounter, t: 0, speed: PARTICLE_SPEED_BASE * (0.8 + Math.random() * 0.8), color: edgeColor(ep.edgeType), edgeId: edge.id, retries: 0, originLatencyMs: 0 }
      arr.push(_bp)
      _particleById.set(_bp.id, _bp)
    }
  }
}
