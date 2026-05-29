# Simulation Engine Internals

This document explains exactly how Scalemap's simulation engine works — the math behind every system, what approximations are made, and why.

The engine lives entirely in `src/app/canvas/simulation/particleEngine.ts`. It runs inside a `requestAnimationFrame` loop, mutates module-level state directly (never React state), and pushes metrics to Zustand stores only on every 4th frame to avoid React re-render storms.

---

## Architecture overview

```
requestAnimationFrame loop (≈60fps)
  │
  ├── spawnParticles(now, delta)      — decides how many new particles to create per edge
  ├── advanceAndDraw(canvas, now, delta) — moves particles, draws them + glows + error flashes
  │     └── handleParticleArrival()  — fires when a particle reaches t=1 (node hit)
  └── updateAllNodeMetrics(now, delta) — runs every 4th frame; computes utilization, latency, error rate
        └── onNodeMetrics batch → Zustand (triggers React re-renders at ~15fps)

1-second setInterval (in SimulationOverlay.tsx)
  └── records history, checks SLOs, updates peak trackers
```

All internal state (`particles`, `circuitBreakers`, `latencyWindows`, pressure maps, etc.) lives in plain module-level variables and Maps — never in React state or refs. This is intentional: a rAF loop running at 60fps cannot afford React's reconciliation overhead.

---

## 1. The rAF loop

```ts
function loop(now: number) {
  const delta = Math.min(now - state.lastTime, 100)  // capped at 100ms to survive tab switches
  spawnParticles(now, delta)
  advanceAndDraw(_canvas, now, delta)
  updateAllNodeMetrics(now, delta)
  state.rafId = requestAnimationFrame(loop)
}
```

`delta` is the wall-clock milliseconds since the last frame, capped at 100ms. The cap prevents a tab that was backgrounded from "catching up" with a single enormous delta that would spawn thousands of particles at once.

`_speed` (the playback speed multiplier from the UI) is applied at the particle advance step: `dt = delta * _speed`. A speed of 3 means particles traverse edges 3× faster and timeouts/delays fire 3× sooner.

---

## 2. Traffic modes and effective multiplier

Every frame, the engine computes a single `effectiveMultiplier(now)` that scales all RPS across the diagram.

### Steady
```
multiplier = globalMultiplier
```
Flat. No time dependence.

### Ramp
```
elapsed = now - simStartTime
multiplier = globalMultiplier × min(1, elapsed / 120_000)
```
Linearly interpolates from 0 to `globalMultiplier` over 2 minutes. The 2-minute window is chosen to let cascade effects develop visibly — saturation at a slow-moving node propagates upstream over tens of seconds.

### Spike
```
if now ∈ [spikeStart, spikeStart + 10s]:
    multiplier = globalMultiplier × 8     ← 8× flash crowd
else:
    multiplier = globalMultiplier × 1

next spike fires 30s after current spike ends
```
Alternates between a 10-second burst at 8× and a 30-second quiet period. Models a flash crowd — e.g. a viral event hitting an otherwise lightly-loaded system.

### Chaos
```
multiplier = globalMultiplier × (inSpike ? 6 : 1)
spikes: 5s duration, every 8–16s (randomized)

additionally: every 5–15s, pick a random non-grouping node
  → mark it as failed for 5–20s
  → emit chaos_failure event
  → emit chaos_recovery when it expires
```
Combines unpredictable traffic spikes with random node failures. Failures are tracked in `_chaosFailures: Map<nodeId, expiryTimestamp>`. A failed node's inbound particles are dropped immediately (see §4).

---

## 3. Particle spawning math

Particles represent batches of requests. They are not 1-to-1 with individual HTTP requests — 1 particle = approximately 10 RPS visually.

```ts
const rps            = edge.rps × effectiveMultiplier × downstreamFactor
const particlesPerSec = rps / 10
const spawnChance    = particlesPerSec × (delta / 1000) × _speed
const n = floor(spawnChance) + Bernoulli(spawnChance % 1)
```

- `rps / 10`: compression ratio so the canvas doesn't become a solid blob of particles at high throughput.
- `delta / 1000`: converts per-second rate to per-frame count.
- `× _speed`: faster playback = more particles spawned per wall-clock frame.
- The fractional part `spawnChance % 1` is used as a probability for a +1 particle, making the spawn process a Poisson approximation without needing a proper Poisson sampler.

**Global cap:** total particles across all edges is capped at 500. Once reached, spawning stops entirely until particles arrive and are removed.

### `downstreamFactor` — suppression from upstream failures

Before spawning on an edge, the engine checks whether the *source* node of that edge is degraded:

| Source node state | `downstreamFactor` |
|---|---|
| Chaos-failed | 0.0 — no traffic forwarded |
| Circuit open | 0.05 — 5% trickle (probes) |
| Saturated | `max(0.1, 1 - stallPressure × 0.8)` |
| Healthy | 1.0 |

This models the real behavior: a dead or circuit-open node cannot forward requests, so its outbound edges go dark.

---

## 4. Particle movement and rendering

Each particle has:
```ts
{ t: number, speed: number, color: string, edgeId: string }
```

`t` is a normalized position along the edge path, `0 → 1`. Every frame:
```
p.t += p.speed × dt        where dt = delta × _speed
```

`PARTICLE_SPEED_BASE = 0.0006`. With ±20% jitter (`0.8 + random() × 0.4`), particles travel at slightly different speeds, preventing them from bunching into a single point.

**Path position** is resolved against the actual SVG `<path>` element rendered by React Flow using the browser's own `SVGPathElement.getPointAtLength()`:
```ts
const len = el.getTotalLength()
const pt  = el.getPointAtLength(t * len)
const ctm = el.getScreenCTM()         // transforms SVG coords → screen coords
return [ctm.a*pt.x + ctm.c*pt.y + ctm.e - canvasRect.left,
        ctm.b*pt.x + ctm.d*pt.y + ctm.f - canvasRect.top]
```
The canvas overlay is positioned at `(0,0)` over the React Flow canvas and inherits its bounding rect, so the coordinate transform lands the particle exactly on the drawn edge path regardless of pan/zoom.

When `t >= 1`, the particle is removed and `handleParticleArrival()` fires.

---

## 5. Latency sampling — log-normal distribution

Each time a particle arrives at a node, the engine samples a latency from a log-normal distribution parameterized by the node's `p50Ms` and `p99Ms`:

```ts
function sampleLatencyMs(p50: number, p99: number): number {
  const mu    = log(p50)
  const sigma = (log(p99) - mu) / 2.326      // z-score for 99th percentile
  const z     = √(-2 × log(u1)) × cos(2π × u2)  // Box-Muller transform
  return exp(mu + sigma × z)
}
```

**Why log-normal?** Real-world service latencies are right-skewed: the median is low, but the tail can be very long (slow queries, GC pauses, cold starts). A log-normal distribution reproduces this shape with just two intuitive parameters — p50 and p99 — that operators already think in.

The constant `2.326` is the z-score of the 99th percentile of a standard normal distribution (i.e., `Φ⁻¹(0.99) ≈ 2.326`). Solving for sigma: `sigma = (log(p99) - log(p50)) / 2.326`.

**Ring buffer:** each sample is pushed into a per-node ring buffer of the last 200 latency values. Percentiles (p50, p75, p90, p99) are computed from this buffer via sort + index lookup every 4 frames.

---

## 6. Utilization model

Utilization is computed differently depending on node type.

### Standard compute nodes (EC2, container, pod, API gateway, etc.)

```
inRps       = sum(rps of all inbound edges) × effectiveMultiplier
utilization = min(1, inRps / effectiveMaxRps)
```

If `inRps ≥ maxRps`, the node is at 100% utilization. Particles arriving at a saturated node are dropped:
```ts
if (utilization >= 1.0 + config.errorRate) → dropParticle()
```
The `+ config.errorRate` term gives a small overflow budget — a node with a 2% baseline error rate starts dropping at 102% of `maxRps`, meaning random errors fire before full saturation.

### Queue nodes (queue, eventBus, pubsub, stream)

Queues don't drop on arrival — they accumulate. Queue depth is a running integral:
```
net    = (inRps - outRps) × (delta × METRICS_THROTTLE / 1000)
depth  = max(0, prevDepth + net)
utilization = min(1, depth / queueCapacity)
```
`METRICS_THROTTLE = 4` (metrics update every 4 frames). When depth reaches `queueCapacity`, utilization = 1 and the SLO can trip, but particles are still accepted — there is no hard drop for queues.

### Lambda nodes

Lambda uses concurrency, not RPS:
```
concurrency = current in-flight count
utilization = min(1, concurrency / maxConcurrency)
```
Concurrency is tracked by incrementing a counter on arrival and decrementing it after `processingMs / speed` milliseconds via `setTimeout`. If `concurrency ≥ maxConcurrency`, the particle is dropped.

**Cold start:** if `concurrency ≥ warmInstances`, a cold-start latency penalty is added:
```
effectiveLatency = sampledLatency + sampleLatencyMs(coldStart.p50Ms, coldStart.p99Ms)
```
Warm instances expire after 5 minutes of idle. This models Lambda's container recycling behavior — a function that hasn't been called in 5 minutes loses its warm container and pays the initialization cost on the next call.

### K8s / ECS nodes (auto-scale)

These use a dynamic `effectiveMaxRps` that changes over time:
```
utilForScale = inRps / currentCapacity

if utilForScale > scaleOutThreshold and no pending scale-out:
    schedule scale-out to complete at now + scaleOutDelayMs
    → at completion: currentCapacity = min(maxCapacityRps, currentCapacity × 2)

if utilForScale < scaleInThreshold and cooldown elapsed:
    currentCapacity = max(minCapacityRps, floor(currentCapacity × 0.5))
    reset cooldown to now + scaleInCooldownMs

utilization = inRps / effectiveMaxRps
```
Scale-out doubles capacity (capped at `maxCapacityRps`). Scale-in halves it (floored at `minCapacityRps`). The asymmetric delays model how real cloud orchestrators scale out aggressively and scale in conservatively.

---

## 7. CPU saturation — non-linear latency amplification

At high utilization, compute nodes experience a non-linear latency increase. This models CPU contention, context switching, and scheduler overhead:

```ts
const isCompute = ['ec2', 'container', 'pod', 'lambda', 'k8sCluster', 'ecsCluster'].includes(nodeType)
const cpuFactor = (isCompute && utilization > 0.7)
  ? 1 + ((min(utilization, 1) - 0.7) / 0.3)² × 3
  : 1
```

| Utilization | cpuFactor | Effect on p99 latency |
|---|---|---|
| 70% | 1.0× | No amplification |
| 80% | 1.33× | 33% slower |
| 90% | 1.75× | 75% slower (≈ real queuing theory) |
| 100% | 4.0× | 4× slower |

The quadratic growth above 70% is consistent with M/M/1 queuing theory, where mean waiting time grows as `ρ / (1 - ρ)` (ρ = utilization). At ρ = 0.9 the waiting time is 9× the service time; the engine approximates this with a simpler polynomial that produces plausible visual behavior without implementing a full queuing model.

All four latency percentiles (p50, p75, p90, p99) are multiplied by `cpuFactor` before being reported.

---

## 8. Error rate model

Error rate has two additive components:

### Soft onset from utilization
```
errorOnset = 0.85
baseErrorRate = utilization > 0.85
  ? min(1, (utilization - 0.85) / 0.15 × 0.15)
  : 0
```
Errors start at 85% utilization and ramp linearly to a maximum of 15% at 100%. This reflects real services: they don't suddenly fail at 100%; they start returning errors, timing out, or shedding load as they approach saturation.

### Cascade pressure from upstream drops
When a particle is dropped (because a node is saturated, its circuit breaker is open, or chaos has failed it), a `dropParticle()` call adds pressure to the *source* node upstream:
```
upstreamPressure = min(1, existing + 0.05)   // +5% per drop event
```
This pressure decays per frame:
```
upstreamPressure × 0.98 per frame (≈ half-life ~34 frames)
```
It contributes to the error rate:
```
errorRate = min(1, baseErrorRate + cascadePressure × 0.15)
```
The `× 0.15` cap prevents cascade pressure from dominating tight SLO checks — background noise from a single dropped particle shouldn't immediately trip a 1% error rate SLO.

---

## 9. Cascade and stall pressure

When a downstream node fails or saturates, the effect propagates upstream through two pressure signals:

### Upstream error pressure
Adds to the source node's error rate (see §8). Represents: responses from the failed downstream arrive as errors at the caller.

### Downstream stall pressure
```
downstreamStallPressure = min(1, existing + 0.06)   // per drop
decay: × 0.97 per frame (slower than error pressure)
```
Stall pressure inflates the *utilization* of the upstream node:
```
utilization = min(1, utilization + stallPressure × 0.3)
```
This models a subtle but critical real-world behavior: when a downstream service hangs (rather than failing fast), upstream threads block waiting for responses. Those blocked threads consume concurrency slots, pushing the upstream node toward saturation even though its actual CPU isn't doing work. The slower decay (0.97 vs 0.98) means stall effects are visible for longer than error effects.

**Bottleneck marking** uses `rawUtilization` (before stall inflation) with a threshold of 0.8. This prevents upstream nodes from being incorrectly marked as bottlenecks purely because their downstream is failing.

---

## 10. Circuit breaker

The engine implements a per-node three-state circuit breaker: `closed → open → half-open → closed`.

**Error window:** a sliding window of the last 20 request outcomes (1 = error, 0 = success).

**Trip condition (closed → open):**
```
errRate = sum(errorWindow) / len(errorWindow)
if errRate >= errorThreshold AND len(errorWindow) >= 10:
    state = 'open'
    openedAt = now
```
Requires at least 10 samples before tripping (prevents false positives at startup).

**Reset (open → half-open):**
```
if now - openedAt > resetMs:
    state = 'half-open'
```

**Half-open behavior:** 90% of arrivals are still dropped (`Math.random() > 0.1`), and 10% are allowed through as probes:
- Probe succeeds → `state = 'closed'`, window cleared
- Probe fails → `state = 'open'`, `openedAt = now` (full cooldown restarts)

When the circuit is open, `downstreamFactor = 0.05` on spawning (§3) — almost no traffic is forwarded from the node whose circuit has tripped.

---

## 11. Connection pool (databases and caches)

Nodes with `connectionPool` configured track active connections separately from RPS:

```
on arrival:
  if activeConnections >= connectionPool.max:
    dropParticle()
    emit connection_pool_exhausted
    return

  activeConnections++
  setTimeout(() => activeConnections--, processingMs / speed)
```

The connection is "held" for `processingMs` milliseconds (scaled by playback speed) before being released back to the pool. This models the real behavior of a connection pool: connections are a finite resource that must be held for the duration of a query, not just at the moment of arrival. A spike in slow queries (high `processingMs`) depletes the pool faster than fast queries at the same RPS.

---

## 12. Load balancer and API gateway — round-robin forwarding

When a particle arrives at a `loadBalancer` or `apiGateway` node, rather than consuming it, the node immediately re-emits a new particle on one of its outbound edges in round-robin order:
```
outEdges = all edges where source == this node
idx      = roundRobinIndex[nodeId] % outEdges.length
roundRobinIndex[nodeId]++
emit new particle on outEdges[idx]
```
This makes traffic distribution across backends visible — if one backend saturates and its circuit breaker opens, the round-robin still tries to route to it (and those particles get dropped), modeling a real LB that hasn't yet gotten health-check feedback.

Orchestration nodes (K8s, ECS, Docker Compose) use broadcast forwarding instead — a random outbound edge is chosen each time, not round-robin.

---

## 13. EMA smoothing

Raw per-frame metrics have high variance (because particle arrivals are stochastic). Rather than displaying raw values, the engine applies Exponential Moving Average smoothing before sending metrics to the store:

```
EMA_ALPHA = 0.25
smoothed = prev + 0.25 × (raw - prev)
```

Alpha of 0.25 means the current frame contributes 25% of the new value; the previous smoothed value contributes 75%. This gives roughly a 4-frame lag (≈66ms at 60fps), which is imperceptible to users but eliminates jitter that would make sparklines unreadable.

**What is not smoothed:** `queueDepth`, `concurrency`, and `circuitState`. These are discrete values where lag would be misleading — a circuit that just opened should show as open immediately, not 25% open.

---

## 14. Client retries and retry storms

When a particle is dropped — due to saturation, an open circuit breaker, a chaos failure, connection pool exhaustion, or Lambda concurrency cap — nodes with a `retryConfig` schedule the particle for re-spawning after an exponential backoff delay.

### Delay formula

```
attempt = particle.retries   (0-indexed: 0 = first retry)
cap     = retryConfig.maxDelayMs ?? ∞
exp     = min(cap, baseDelayMs × 2^attempt)

full jitter:  delay = random(0, exp)          ← AWS-recommended; maximally spreads the herd
equal jitter: delay = exp/2 + random(0, exp/2) ← guarantees a minimum spacing
```

The delay is divided by `_speed` before being stored as a wall-clock `fireAt` timestamp, keeping retries consistent with `processingMs`-based timeouts.

A `retries` counter on each particle tracks how many attempts have been made. Once `retries >= retryConfig.maxRetries`, the particle is permanently dropped. Setting `maxRetries: 0` restores the original drop-and-forget behavior.

### Retry queue

Pending retries live in a module-level `_retryQueue: RetryEntry[]`. Each frame (before new particles are spawned), `processRetryQueue(now)` scans the queue and re-spawns any entries whose `fireAt <= now`. Re-spawned particles count toward the global `MAX_PARTICLES = 500` cap — the retry storm cannot grow unbounded.

### Thundering herd / retry storm

The storm emerges naturally from the math: when a node is saturated, all its clients back off with jitter. With `full` jitter, the backoff windows are spread uniformly — but at high load many windows still expire at roughly the same time. When the node begins recovering, it receives a burst of retries from all the clients that were waiting, potentially re-saturating it.

**Storm detection:** if `≥ 5` retries arrive at the same target node in a single frame, the engine emits a `retry_storm` event (severity: critical). This threshold is defined by `RETRY_STORM_THRESHOLD = 5` in the engine.

### Self-reinforcing cascade

Retry behavior interacts with the existing cascade model:
1. Node A saturates → drops particle → schedules retry
2. Retry fires → node A is still recovering → drops again → schedules another retry (with doubled delay)
3. Stall pressure from repeated drops builds upstream error rate and utilization on the caller
4. When A finally recovers, the burst of retries from all callers re-saturates it
5. `retry_storm` event fires; circuit breaker may trip if the error rate through the window exceeds `errorThreshold`

### Self-healing (K8s, ECS)

When a K8s or ECS node is chaos-failed, the self-healing system attempts to restart it after the chaos failure expires:

```
if chaos failure has expired AND selfHealing configured:
  restarts = restartCounts[nodeId]
  if now > restartCooldown[nodeId]:
    if restarts < maxRestarts:
      restartCounts[nodeId]++
      restartCooldown[nodeId] = now + restartDelayMs
    else:
      // crash-loop detected
      backoff = crashLoopBackoffMs × (restarts - maxRestarts + 1)
      restartCooldown[nodeId] = now + backoff
      emit crash_loop_detected
```

The backoff is linear: each restart beyond `maxRestarts` multiplies `crashLoopBackoffMs` by an increasing factor. This models Kubernetes' `CrashLoopBackOff` behavior where the pod restart interval grows after repeated failures.

---

## 16. SLO checking

SLO checks run on a 1-second interval in `SimulationOverlay.tsx`, separate from the rAF loop. For each node with a configured SLO (either from `node.data.slo` or `DEFAULT_SLO[nodeType]`):

```
violations = []
if p90LatencyMs > slo.maxP90LatencyMs    → add violation
if errorRate    > slo.maxErrorRate       → add violation
if utilization  > slo.maxUtilization     → add violation

if was passing AND now violating → emit slo_violation event
if was violating AND now passing → emit slo_recovery event
```

SLO state uses edge-detection (only fires on transitions, not on every tick) so the event log doesn't flood with repeated violation messages.

---

## 17. Metrics update frequency and the metrics throttle

```ts
const METRICS_THROTTLE = 4
function updateAllNodeMetrics(now, delta) {
  _frameCount++
  if (_frameCount % METRICS_THROTTLE !== 0) return
  ...
  _onNodeMetrics(batch)  // → Zustand → React re-renders
}
```

Metrics are recomputed every 4 frames (~15Hz at 60fps). Sending a Zustand update every frame at 60fps would trigger 60 React reconciliations per second, making the UI sluggish. 15Hz is fast enough for smooth sparklines and responsive status indicators while keeping React overhead low.

---

## 18. Events emitted by the engine

All events are emitted via the `_onEvent` callback and stored in the simulation store's event log (capped at 200 entries).

| Event type | Trigger | Severity |
|---|---|---|
| `simulation_start` | Simulation begins | info |
| `simulation_stop` | Simulation ends | info |
| `saturation_start` | Node utilization reaches 100% | critical |
| `saturation_end` | Node utilization drops below 100% | info |
| `circuit_open` | Circuit breaker trips | critical |
| `circuit_half_open` | Circuit breaker enters probe mode | warn |
| `circuit_close` | Circuit breaker resets | info |
| `cascade_detected` | Upstream pressure > 20% while downstream is saturated | critical |
| `chaos_failure` | Random node fails in chaos mode | warn |
| `chaos_recovery` | Chaos failure expires | info |
| `connection_pool_exhausted` | Active connections hit the pool max | critical |
| `lambda_cold_start` | Lambda has no warm instance available | warn |
| `request_timeout` | (reserved for future use) | warn |
| `slo_violation` | Node transitions from passing → violating | warn |
| `slo_recovery` | Node transitions from violating → passing | info |
| `autoscale_triggered` | K8s/ECS decides to scale out | info |
| `autoscale_complete` | Scale-out capacity becomes available | info |
| `autoscale_scaledin` | K8s/ECS scales in | info |
| `crash_loop_detected` | Pod exceeds maxRestarts | critical |
| `retry_storm` | ≥5 retries arrive at the same node in one frame | critical |

---

## 19. Summary of math used

| System | Model |
|---|---|
| Latency sampling | Log-normal via Box-Muller transform |
| Percentile computation | Sort + index into ring buffer (last 200 samples) |
| Latency amplification at saturation | Quadratic: `1 + ((util - 0.7) / 0.3)² × 3` for util > 70% |
| Error rate from utilization | Linear ramp from 85%–100% util → 0%–15% error |
| Error rate from cascade | Additive: `cascadePressure × 0.15` |
| Pressure decay | Exponential: `× 0.98` (error) / `× 0.97` (stall) per frame |
| Ramp mode multiplier | Linear interpolation over 120s |
| Spike mode | Binary 8× burst, 10s on / 30s off |
| Chaos mode | Uniform random node selection, exponential backoff restarts |
| Particle spawn count | Deterministic floor + Bernoulli remainder |
| Metric smoothing | EMA with α = 0.25 |
| Queue depth | Running integral of net RPS × time |
| Auto-scale | Threshold hysteresis with asymmetric delay (scale-out fast, scale-in slow) |
| Circuit breaker | Sliding window (last 20 samples), 3-state FSM |
| Retry backoff | Exponential: `baseDelayMs × 2^attempt`, capped by `maxDelayMs` |
| Retry jitter (full) | `random(0, cap)` — uniform; maximally spreads retry bursts |
| Retry jitter (equal) | `cap/2 + random(0, cap/2)` — guarantees minimum wait |
| Retry storm detection | Count-based threshold (≥5 simultaneous retries per target per frame) |
| Load balancing | Strict round-robin |
