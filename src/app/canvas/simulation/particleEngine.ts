import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData, NodeType, NodeSimConfig, RetryConfig } from '../../../lib/nodeConfig'
import { GROUPING_TYPES } from '../../../lib/nodeConfig'
import { useSimulationStore, type TrafficMode, type NodeMetrics, type SimEventType, type CircuitState } from '../../store/simulation.store'
import { NODE_SIM_DEFAULTS } from '../../simulation/defaults'

// ─── Public types ─────────────────────────────────────────────────────────────

export interface Particle {
  t: number
  speed: number
  color: string
  edgeId: string
  retries: number   // 0 on first spawn; incremented on each retry
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

// Latency sample ring buffers (last 200 samples per node)
const _latencyWindows = new Map<string, number[]>()

// Cascade upstream error pressure (decays per frame)
const _upstreamPressure = new Map<string, number>()

// Downstream stall pressure: when a downstream node fails, upstream threads pile up waiting
// → upstream node's effective utilization increases, causing it to saturate and cascade
const _downstreamStallPressure = new Map<string, number>()

// Which nodes were already saturated (for start/end events)
const _saturatedNodes = new Set<string>()

// Circuit breakers per node
const _circuitBreakers = new Map<string, CircuitBreakerEntry>()

// ─── Callbacks ────────────────────────────────────────────────────────────────

type OnNodeMetricsBatch = (batch: Map<string, NodeMetrics>) => void
type OnBottleneck  = (nodeId: string, isSaturated: boolean) => void
type OnEvent       = (type: SimEventType, nodeId: string | undefined, message: string, severity: 'info' | 'warn' | 'critical', snapshot?: Partial<NodeMetrics>) => void

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

// Chaos mode: nodeIds whose outbound is temporarily "failed"
const _chaosFailures = new Map<string, number>() // nodeId → expiry timestamp
let _chaosNextFailAt = 0

// Connection pool tracking (7a)
const _activeConnections = new Map<string, number>()

// In-flight request counter used by LAC load balancer routing
const _lbActiveRequests = new Map<string, number>()

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

// Cache DOM elements per frame
const _pathElCache  = new Map<string, SVGPathElement | null>()
const _nodeElCache  = new Map<string, Element | null>()
let _canvasRect: DOMRect | null = null

// ─── DOM helpers ──────────────────────────────────────────────────────────────

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
          _chaosFailures.set(victim.id, now + failDuration)
          if (!wasAlreadyFailed) {
            const label = (victim.data as NodeData).label ?? victim.id
            _onEvent('chaos_failure', victim.id, `${label} failed (chaos)`, 'warn')
          }
        }
        _chaosNextFailAt = now + 5_000 + Math.random() * 10_000
      }
      // Emit recovery events for expired failures
      for (const [id, expiry] of _chaosFailures) {
        if (now > expiry) {
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

function getBreaker(nodeId: string): CircuitBreakerEntry {
  let b = _circuitBreakers.get(nodeId)
  if (!b) {
    b = { state: 'closed', openedAt: 0, errorWindow: [] }
    _circuitBreakers.set(nodeId, b)
  }
  return b
}

function recordBreakerResult(nodeId: string, isError: boolean, config: NodeSimConfig, now: number) {
  const b = getBreaker(nodeId)
  const cb = config.circuitBreaker
  if (!cb) return

  b.errorWindow.push(isError ? 1 : 0)
  if (b.errorWindow.length > 20) b.errorWindow.splice(0, b.errorWindow.length - 20)

  if (b.state === 'closed') {
    const errRate = b.errorWindow.reduce((s, v) => s + v, 0) / b.errorWindow.length
    if (errRate >= cb.errorThreshold && b.errorWindow.length >= 10) {
      b.state = 'open'
      b.openedAt = now
      const node = _nodesMap.get(nodeId)
      const label = node ? (node.data as NodeData).label ?? nodeId : nodeId
      _onEvent('circuit_open', nodeId, `${label} circuit opened`, 'critical')
    }
  } else if (b.state === 'half-open') {
    if (!isError) {
      b.state = 'closed'
      b.errorWindow = []
      const node = _nodesMap.get(nodeId)
      const label = node ? (node.data as NodeData).label ?? nodeId : nodeId
      _onEvent('circuit_close', nodeId, `${label} circuit closed`, 'info')
    } else {
      b.state = 'open'
      b.openedAt = now
    }
  }
}

function checkBreakerTransition(nodeId: string, config: NodeSimConfig, now: number): CircuitState {
  const b = getBreaker(nodeId)
  const cb = config.circuitBreaker
  if (!cb) return 'closed'

  if (b.state === 'open' && now - b.openedAt > cb.resetMs) {
    b.state = 'half-open'
    const node = _nodesMap.get(nodeId)
    const label = node ? (node.data as NodeData).label ?? nodeId : nodeId
    _onEvent('circuit_half_open', nodeId, `${label} circuit half-open (testing)`, 'warn')
  }
  return b.state
}

// ─── LAC in-flight tracking ──────────────────────────────────────────────────

// Routers and accumulators: not counted as backends for LAC routing
const _LB_SKIP_TYPES = new Set<string>(['loadBalancer', 'apiGateway', 'queue', 'eventBus', 'pubsub', 'stream'])

function trackRequest(nodeId: string, nodeType: NodeType, config: NodeSimConfig) {
  if (_LB_SKIP_TYPES.has(nodeType) || GROUPING_TYPES.has(nodeType)) return
  _lbActiveRequests.set(nodeId, (_lbActiveRequests.get(nodeId) ?? 0) + 1)
  setTimeout(() => {
    _lbActiveRequests.set(nodeId, Math.max(0, (_lbActiveRequests.get(nodeId) ?? 1) - 1))
  }, Math.max(50, config.processingMs) / _speed)
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
      if (_chaosFailures.has(sourceNodeId)) {
        downstreamFactor = 0  // complete failure: no forwarding
      } else {
        const breaker = _circuitBreakers.get(sourceNodeId)
        if (breaker?.state === 'open') {
          downstreamFactor = 0.05  // circuit open: almost no traffic passes
        } else if (_saturatedNodes.has(sourceNodeId)) {
          // Partial degradation: saturated node forwards at reduced rate
          const stall = _downstreamStallPressure.get(sourceNodeId) ?? 0
          downstreamFactor = Math.max(0.1, 1 - stall * 0.8)
        }
      }
    }

    const rps = ep.rps * mult * downstreamFactor
    const particlesPerSec = rps / 10
    const spawnChance = particlesPerSec * (delta / 1000) * _speed
    const n = Math.floor(spawnChance) + (Math.random() < (spawnChance % 1) ? 1 : 0)
    if (n === 0) continue

    if (!state.particles.has(ep.id)) state.particles.set(ep.id, [])
    const arr = state.particles.get(ep.id)!
    for (let i = 0; i < n && total < MAX_PARTICLES; i++) {
      arr.push({
        t: 0,
        speed: PARTICLE_SPEED_BASE * (0.8 + Math.random() * 0.4),
        color: edgeColor(ep.edgeType),
        edgeId: ep.id,
        retries: 0,
      })
      total++
    }
  }
}

// ─── Particle arrival / node behavior ────────────────────────────────────────

function dropParticle(ep: EdgePath, targetNodeId: string, particle?: Particle) {
  spawnErrorFlash(targetNodeId)

  const sourceNodeId = _edgesData.find(e => e.id === ep.id)?.source
  if (sourceNodeId) {
    // Error pressure → raises source's error rate
    const existing = _upstreamPressure.get(sourceNodeId) ?? 0
    const newPressure = Math.min(1, existing + 0.05)
    _upstreamPressure.set(sourceNodeId, newPressure)

    // Stall pressure → raises source's effective utilization (threads blocked waiting)
    // Models: open connections to a failed downstream node consume concurrency upstream
    const existingStall = _downstreamStallPressure.get(sourceNodeId) ?? 0
    _downstreamStallPressure.set(sourceNodeId, Math.min(1, existingStall + 0.06))

    // Emit cascade event once pressure is significant
    if (newPressure > 0.2 && _saturatedNodes.has(targetNodeId)) {
      const srcNode  = _nodesMap.get(sourceNodeId)
      const tgtNode  = _nodesMap.get(targetNodeId)
      const srcLabel = srcNode ? (srcNode.data as NodeData).label ?? sourceNodeId : sourceNodeId
      const tgtLabel = tgtNode ? (tgtNode.data as NodeData).label ?? targetNodeId : targetNodeId
      _onEvent('cascade_detected', sourceNodeId, `${srcLabel} → ${tgtLabel} cascade`, 'critical')
    }
  }

  // Schedule retry with exponential backoff + jitter if the target node allows it
  if (particle) {
    const targetNode = _nodesMap.get(targetNodeId)
    const targetType = targetNode?.type as NodeType | undefined
    const config = targetType ? effectiveConfig(targetNodeId, targetType) : null
    const rc = config?.retryConfig
    if (rc && rc.maxRetries > 0 && particle.retries < rc.maxRetries) {
      _retryQueue.push({
        edgeId: ep.id,
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
  const targetNodeId   = _edgesData.find(e => e.id === ep.id)?.target
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

  // Skip forwarding if chaos mode has this node failed
  if (_chaosFailures.has(targetNodeId)) {
    dropParticle(ep, targetNodeId, particle)
    return
  }

  const config = effectiveConfig(targetNodeId, targetNodeType)

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
    const releaseDelay = Math.max(50, (config.processingMs || 5)) / _speed
    setTimeout(() => {
      _activeConnections.set(targetNodeId, Math.max(0, (_activeConnections.get(targetNodeId) ?? 1) - 1))
    }, releaseDelay)
  }

  // Check circuit breaker state
  const breakerState = checkBreakerTransition(targetNodeId, config, now)
  if (breakerState === 'open') {
    dropParticle(ep, targetNodeId, particle)
    recordBreakerResult(targetNodeId, true, config, now)
    return
  }
  if (breakerState === 'half-open' && Math.random() > 0.1) {
    dropParticle(ep, targetNodeId, particle)
    return
  }

  const isQueue = ['queue', 'pubsub', 'stream', 'eventBus'].includes(targetNodeType)

  // Sample latency
  const lm = config.latencyModel
  const sampledLatency = lm ? sampleLatencyMs(lm.p50Ms, lm.p99Ms) : (config.processingMs || 5)
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
        recordBreakerResult(targetNodeId, true, config, now)
        return
      }
      // Cold start: warm instances expire after 5 min idle
      const lastAct  = _warmLastActivity.get(targetNodeId) ?? 0
      const maxWarm  = config.maxWarmInstances ?? 5
      const warm     = now - lastAct > LAMBDA_WARM_IDLE_MS ? 0 : (_warmInstances.get(targetNodeId) ?? 0)
      let effectiveLatency = sampledLatency
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
      const delay = Math.max(50, effectiveLatency) / _speed
      recordLatency(targetNodeId, effectiveLatency)
      setTimeout(() => {
        const c = state.nodeConcurrency.get(targetNodeId) ?? 0
        state.nodeConcurrency.set(targetNodeId, Math.max(0, c - 1))
      }, delay)
      recordBreakerResult(targetNodeId, false, config, now)
      trackRequest(targetNodeId, targetNodeType, config)
      forwardToOutbound(targetNodeId, targetNodeType)
      return
    }

    // Other non-queue nodes: drop if at capacity
    if (utilization >= 1.0 + config.errorRate) {
      dropParticle(ep, targetNodeId, particle)
      recordBreakerResult(targetNodeId, true, config, now)
      return
    }
  }

  recordBreakerResult(targetNodeId, false, config, now)
  trackRequest(targetNodeId, targetNodeType, config)

  // Load balancer / API gateway: round-robin or least-connections routing
  if (targetNodeType === 'loadBalancer' || targetNodeType === 'apiGateway') {
    const outEdges = _edgePaths.filter(e =>
      _edgesData.find(d => d.id === e.id)?.source === targetNodeId,
    )
    if (outEdges.length > 0) {
      const lbConfig = effectiveConfig(targetNodeId, targetNodeType)
      let chosenEp: EdgePath

      if (lbConfig.lbRouting === 'least-connections' && outEdges.length > 1) {
        // Route to the backend with the fewest in-flight requests
        chosenEp = outEdges.reduce((best, ep) => {
          const tgtId      = _edgesData.find(e => e.id === ep.id)?.target
          const active     = tgtId ? (_lbActiveRequests.get(tgtId) ?? 0) : Infinity
          const bestTgtId  = _edgesData.find(e => e.id === best.id)?.target
          const bestActive = bestTgtId ? (_lbActiveRequests.get(bestTgtId) ?? 0) : Infinity
          return active < bestActive ? ep : best
        })
      } else {
        // Round-robin (default)
        const idx = state.roundRobinIndex.get(targetNodeId) ?? 0
        chosenEp  = outEdges[idx % outEdges.length]
        state.roundRobinIndex.set(targetNodeId, idx + 1)
      }

      if (!state.particles.has(chosenEp.id)) state.particles.set(chosenEp.id, [])
      state.particles.get(chosenEp.id)!.push({
        t: 0, speed: PARTICLE_SPEED_BASE, color: edgeColor(chosenEp.edgeType), edgeId: chosenEp.id, retries: 0,
      })
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
  state.particles.get(outEp.id)!.push({
    t: 0, speed: PARTICLE_SPEED_BASE, color: edgeColor(outEp.edgeType), edgeId: outEp.id, retries: 0,
  })
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

// ─── Per-frame metrics update ────────────────────────────────────────────────

const METRICS_THROTTLE = 4
let _frameCount = 0

function updateAllNodeMetrics(now: number, delta: number) {
  _frameCount++
  if (_frameCount % METRICS_THROTTLE !== 0) return

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

    if (isQueue) {
      const cap = config.queueCapacity ?? 1000
      const prev = state.queueDepths.get(nodeId) ?? 0
      const net  = (inRps - outRps) * ((delta * METRICS_THROTTLE) / 1000)
      const next = Math.max(0, prev + net)
      state.queueDepths.set(nodeId, next)
      queueDepth  = next
      utilization = Math.min(1, next / cap)
    } else if (nodeType === 'lambda') {
      const cur = state.nodeConcurrency.get(nodeId) ?? 0
      const maxC = config.maxConcurrency ?? 10
      concurrency = cur
      utilization = Math.min(1, cur / maxC)
    } else {
      // K8s / ECS: use dynamic auto-scale capacity (7g)
      let effectiveMaxRps = config.maxRps
      if (config.autoScale) {
        const current = _currentCapacity.get(nodeId) ?? config.autoScale.minCapacityRps
        effectiveMaxRps = current
        // Scale-out: when util > threshold, schedule capacity increase
        const utilForScale = Math.min(1, inRps / effectiveMaxRps)
        if (utilForScale > config.autoScale.scaleOutThreshold && !_scaleOutPending.has(nodeId)) {
          _scaleOutPending.set(nodeId, now + config.autoScale.scaleOutDelayMs)
          const label = (node.data as NodeData).label ?? nodeId
          _onEvent('autoscale_triggered', nodeId, `${label} scaling out — utilization ${Math.round(utilForScale * 100)}%`, 'info')
        }
        // Apply scale-out when delay has elapsed
        const pendingAt = _scaleOutPending.get(nodeId)
        if (pendingAt && now >= pendingAt) {
          const newCap = Math.min(config.autoScale.maxCapacityRps, current * 2)
          _currentCapacity.set(nodeId, newCap)
          _scaleOutPending.delete(nodeId)
          const label = (node.data as NodeData).label ?? nodeId
          _onEvent('autoscale_complete', nodeId, `${label} capacity → ${newCap} RPS`, 'info')
        }
        // Scale-in: when util < threshold and cooldown elapsed
        const cooldownEnd = _scaleInCooldown.get(nodeId) ?? 0
        if (utilForScale < config.autoScale.scaleInThreshold && now > cooldownEnd && current > config.autoScale.minCapacityRps) {
          const newCap = Math.max(config.autoScale.minCapacityRps, Math.floor(current * 0.5))
          _currentCapacity.set(nodeId, newCap)
          _scaleInCooldown.set(nodeId, now + config.autoScale.scaleInCooldownMs)
          const label = (node.data as NodeData).label ?? nodeId
          _onEvent('autoscale_scaledin', nodeId, `${label} scaled in → ${newCap} RPS`, 'info')
        }
        // Self-healing: auto-recover from chaos failures (7g)
        if (config.selfHealing && _chaosFailures.has(nodeId)) {
          const expiry = _chaosFailures.get(nodeId) ?? 0
          if (now > expiry) {
            const restarts  = _restartCounts.get(nodeId) ?? 0
            const cooldown  = _restartCooldown.get(nodeId) ?? 0
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
    const isCompute = ['ec2', 'container', 'pod', 'lambda', 'k8sCluster', 'ecsCluster'].includes(nodeType)
    const cpuFactor = (isCompute && utilization > 0.7)
      ? 1 + Math.pow((Math.min(utilization, 1) - 0.7) / 0.3, 2) * 3  // up to 4× at 100% util
      : 1

    // Compute latency percentiles from ring buffer
    const latencySamples = _latencyWindows.get(nodeId) ?? []
    const rawP50 = computePercentile(latencySamples, 50) * cpuFactor
    const rawP75 = computePercentile(latencySamples, 75) * cpuFactor
    const rawP90 = computePercentile(latencySamples, 90) * cpuFactor
    const rawP99 = computePercentile(latencySamples, 99) * cpuFactor

    // Circuit breaker state
    const breaker = _circuitBreakers.get(nodeId)
    const circuitState = breaker?.state ?? 'closed'

    // Saturation events
    const wasSaturated = _saturatedNodes.has(nodeId)
    const nowSaturated = utilization >= 1.0
    if (nowSaturated && !wasSaturated) {
      _saturatedNodes.add(nodeId)
      const label = (node.data as NodeData).label ?? nodeId
      _onEvent('saturation_start', nodeId, `${label} saturated (${Math.round(utilization * 100)}%)`, 'critical')
    } else if (!nowSaturated && wasSaturated) {
      _saturatedNodes.delete(nodeId)
      const label = (node.data as NodeData).label ?? nodeId
      _onEvent('saturation_end', nodeId, `${label} recovered`, 'info')
    }

    // Soft error onset at 85% utilization (real services start erroring before full saturation)
    const errorOnset = 0.85
    const baseErrorRate = utilization > errorOnset
      ? Math.min(1, (utilization - errorOnset) / (1.0 - errorOnset) * 0.15)
      : 0

    const rawMetrics: NodeMetrics = {
      inRps,
      outRps,
      utilization,
      // Cascade pressure contributes a smaller fraction so tight SLO error thresholds
      // don't trip from background noise; real saturation still drives errorRate up via baseErrorRate
      errorRate: Math.min(1, baseErrorRate + cascadePressure * 0.15),
      p50LatencyMs: rawP50,
      p75LatencyMs: rawP75,
      p90LatencyMs: rawP90,
      p99LatencyMs: rawP99,
      ...(queueDepth !== undefined && { queueDepth }),
      ...(concurrency !== undefined && { concurrency }),
      circuitState,
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
      queueDepth:    rawMetrics.queueDepth,
      concurrency:   rawMetrics.concurrency,
      circuitState:  rawMetrics.circuitState,
    } : rawMetrics
    _smoothedMetrics.set(nodeId, metrics)

    metricsBatch.set(nodeId, metrics)
    // Bottleneck threshold uses raw utilization (before stall inflation) so nodes aren't
    // marked as bottlenecks purely because their downstream is failing
    _onBottleneck(nodeId, rawUtilization > 0.8)
  }

  if (metricsBatch.size > 0) _onNodeMetrics(metricsBatch)
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
    state.particles.get(r.edgeId)!.push({
      t: 0,
      speed: PARTICLE_SPEED_BASE * (0.8 + Math.random() * 0.4),
      color: r.color,
      edgeId: r.edgeId,
      retries: r.retries,
    })
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

    const surviving: Particle[] = []
    for (const p of arr) {
      p.t += p.speed * dt

      if (p.t >= 1) {
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
  }

  state.rafId = requestAnimationFrame(loop)
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

    return {
      id: edge.id,
      edgeType: edge.data?.edgeType ?? 'request',
      sourceNodeType: src.type as NodeType | undefined,
      targetNodeType: tgt.type as NodeType | undefined,
      rps: useSimulationStore.getState().getEdgeRps(edge.id),
    }
  }).filter(Boolean) as EdgePath[]

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
  _warmInstances.clear()
  _warmLastActivity.clear()
  _currentCapacity.clear()
  _scaleOutPending.clear()
  _scaleInCooldown.clear()
  _restartCounts.clear()
  _restartCooldown.clear()
  _retryQueue.length = 0
  _smoothedMetrics.clear()
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
      arr.push({ t: 0, speed: PARTICLE_SPEED_BASE * (0.8 + Math.random() * 0.8), color: edgeColor(ep.edgeType), edgeId: edge.id, retries: 0 })
    }
  }
}
