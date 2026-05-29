# ScaleScript File Format

A `.scalescript` file is a JSON simulation configuration that you apply on top of a Scalemap diagram. It does **not** describe infrastructure topology — that lives in `.scalemap` files. A ScaleScript describes *how to simulate* your diagram: traffic mode, per-node capacity overrides, SLO thresholds, edge throughput, and time-sequenced fault injection scenarios.

ScaleScripts are diagram-agnostic. You can write one script and replay it against any canvas whose nodes match the rules.

---

## Top-level structure

```json
{
  "version": "1",
  "name": "Black Friday stress test",
  "description": "Ramps to 5x traffic and fails the primary database at t=60s",
  "author": "rishi",
  "tags": ["stress", "database", "production"],

  "simulation": { ... },
  "nodes": { ... },
  "edges": { ... },
  "scenarios": [ ... ],
  "globalSlo": { ... }
}
```

| Field | Required | Type | Description |
|---|---|---|---|
| `version` | yes | `"1"` | Must be the string `"1"` |
| `name` | yes | string | Human-readable script name |
| `description` | no | string | Longer explanation of what the script tests |
| `author` | no | string | Who wrote the script |
| `tags` | no | `string[]` | Arbitrary labels for filtering/search |
| `simulation` | no | object | Global simulation overrides |
| `nodes` | no | object | Per-node simulation config rules |
| `edges` | no | object | Per-edge throughput overrides |
| `scenarios` | no | array | Time-sequenced events |
| `globalSlo` | no | object | Diagram-wide SLO thresholds |

---

## `simulation` — global overrides

Controls the overall simulation engine settings.

```json
"simulation": {
  "mode": "ramp",
  "baseMultiplier": 2.0,
  "speed": 3
}
```

| Field | Type | Description |
|---|---|---|
| `mode` | `"steady"` \| `"ramp"` \| `"spike"` \| `"chaos"` | Traffic pattern. `steady` = flat load. `ramp` = linearly increasing. `spike` = sudden burst then drop. `chaos` = random variance. |
| `baseMultiplier` | number | Multiplies all incoming RPS across the diagram. `1.0` = baseline, `3.0` = 3× traffic. |
| `speed` | number | Simulation playback speed multiplier. `1` = real-time, `5` = 5× faster. |

---

## `nodes` — per-node simulation config

An object whose keys are arbitrary rule names. Each rule matches canvas nodes and patches their simulation parameters. Rules match nodes by `id`, `type`, or `label` — the first matching condition wins for each node.

```json
"nodes": {
  "my-rule-name": {
    "match": { ... },
    "simConfig": { ... },
    "slo": { ... }
  }
}
```

### `match`

Determines which canvas nodes this rule applies to. All three fields are optional; any matching field triggers a match.

| Field | Type | Description |
|---|---|---|
| `id` | string | Exact node ID (precise targeting of a single node) |
| `type` | NodeType | Matches all nodes of this infrastructure type (see Node Types below) |
| `label` | string | Case-insensitive substring match against the node's label |

### `simConfig` — simulation parameters

All fields are optional. Unspecified fields fall back to the node's default values.

```json
"simConfig": {
  "maxRps": 5000,
  "maxConcurrency": 50,
  "processingMs": 20,
  "errorRate": 0.02,
  "queueCapacity": 500,
  "timeoutMs": 10000,
  "latencyModel": {
    "p50Ms": 15,
    "p99Ms": 180
  },
  "circuitBreaker": {
    "errorThreshold": 0.5,
    "resetMs": 10000
  },
  "connectionPool": {
    "max": 100,
    "timeoutMs": 5000
  },
  "coldStart": {
    "p50Ms": 400,
    "p99Ms": 2500
  },
  "maxWarmInstances": 5,
  "autoScale": {
    "minCapacityRps": 500,
    "maxCapacityRps": 5000,
    "scaleOutThreshold": 0.70,
    "scaleOutDelayMs": 30000,
    "scaleInThreshold": 0.30,
    "scaleInCooldownMs": 300000
  },
  "selfHealing": {
    "restartDelayMs": 20000,
    "maxRestarts": 3,
    "crashLoopBackoffMs": 60000
  }
}
```

| Field | Type | Description |
|---|---|---|
| `maxRps` | number | Maximum requests per second this node can handle before saturating |
| `maxConcurrency` | number | Maximum simultaneous in-flight requests (relevant for Lambda, containers) |
| `processingMs` | number | Average time the node takes to process a single request |
| `errorRate` | number | Baseline error rate, `0.0`–`1.0` (e.g. `0.02` = 2%) |
| `queueCapacity` | number | Max items held in queue before drops (relevant for `queue`, `eventBus`, `pubsub`, `stream`) |
| `timeoutMs` | number | Request timeout in milliseconds; requests exceeding this are failed |
| `latencyModel.p50Ms` | number | Median latency in milliseconds |
| `latencyModel.p99Ms` | number | 99th-percentile latency in milliseconds |
| `circuitBreaker.errorThreshold` | number | Error rate (`0.0`–`1.0`) that trips the circuit breaker open |
| `circuitBreaker.resetMs` | number | Milliseconds before a tripped circuit breaker moves to half-open |
| `connectionPool.max` | number | Maximum concurrent connections in the pool (relevant for databases, caches) |
| `connectionPool.timeoutMs` | number | Milliseconds to wait for a pool connection before failing the request |
| `coldStart.p50Ms` | number | Median cold-start latency added to the first request on a cold instance (Lambda) |
| `coldStart.p99Ms` | number | P99 cold-start latency (Lambda) |
| `maxWarmInstances` | number | Number of pre-warmed instances kept alive to avoid cold starts (Lambda) |
| `autoScale.minCapacityRps` | number | Minimum capacity in RPS before any scale-out (K8s, ECS) |
| `autoScale.maxCapacityRps` | number | Maximum capacity the auto-scaler can reach |
| `autoScale.scaleOutThreshold` | number | Utilization ratio (`0.0`–`1.0`) that triggers scale-out |
| `autoScale.scaleOutDelayMs` | number | Delay in milliseconds before new capacity becomes available after scale-out |
| `autoScale.scaleInThreshold` | number | Utilization ratio below which scale-in begins |
| `autoScale.scaleInCooldownMs` | number | Cooldown period in milliseconds before another scale-in can happen |
| `selfHealing.restartDelayMs` | number | Milliseconds to restart a crashed pod/container (K8s, ECS) |
| `retryConfig.maxRetries` | number | Max retry attempts after a drop. `0` = disabled (drop-and-forget) |
| `retryConfig.baseDelayMs` | number | Base delay in ms before the first retry |
| `retryConfig.jitter` | `"full"` \| `"equal"` | `full`: `random(0, cap)` — AWS-recommended; `equal`: `cap/2 + random(0, cap/2)` |
| `retryConfig.maxDelayMs` | number | Optional cap on exponential growth. Omit for uncapped backoff. |
| `selfHealing.maxRestarts` | number | Maximum restarts before the node enters crash-loop state |
| `selfHealing.crashLoopBackoffMs` | number | Backoff period in milliseconds once crash-loop is detected |

### `slo` — per-node SLO thresholds

When the simulation's live metrics breach these thresholds, the node is flagged with an `slo_violation` event.

```json
"slo": {
  "maxP90LatencyMs": 200,
  "maxErrorRate": 0.01,
  "maxUtilization": 0.75
}
```

| Field | Type | Description |
|---|---|---|
| `maxP90LatencyMs` | number | P90 latency (ms) above which SLO is violated |
| `maxErrorRate` | number | Error rate (`0.0`–`1.0`) above which SLO is violated |
| `maxUtilization` | number | Utilization ratio (`0.0`–`1.0`) above which SLO is violated |

---

## `edges` — per-edge throughput overrides

Matches canvas edges and overrides their RPS. Edge rules match by `id`, source node type, or target node label.

```json
"edges": {
  "my-edge-rule": {
    "match": {
      "id": "edge-abc123",
      "sourceType": "lambda",
      "targetLabel": "postgres"
    },
    "throughput": 1500
  }
}
```

### `match`

| Field | Type | Description |
|---|---|---|
| `id` | string | Exact edge ID — matches one specific connection |
| `sourceType` | NodeType | Matches all edges whose source node is this infrastructure type |
| `targetLabel` | string | Case-insensitive substring match against the target node's label |

### Edge rule fields

| Field | Type | Description |
|---|---|---|
| `throughput` | number | RPS to push through the matched edge(s) |

---

## `scenarios` — time-sequenced events

An array of actions that fire at specific simulation ticks. Use these to script fault injection, traffic changes, and recovery sequences.

```json
"scenarios": [
  { "at": 10,  "action": "setMultiplier", "value": 3.0,         "message": "Traffic spike starts" },
  { "at": 30,  "action": "degradeNode",   "target": "db-rule",  "message": "Database under pressure" },
  { "at": 60,  "action": "failNode",      "target": "db-rule",  "message": "Database fails" },
  { "at": 90,  "action": "restoreNode",   "target": "db-rule",  "message": "Database recovered" },
  { "at": 120, "action": "setMode",       "value": "chaos",     "message": "Chaos phase begins" },
  { "at": 150, "action": "setEdgeRps",    "target": "edge-abc", "value": 5000 }
]
```

| Field | Type | Description |
|---|---|---|
| `at` | number | Simulation tick (seconds from start) at which this action fires |
| `action` | string | The action to perform — see actions table below |
| `target` | string | For node actions: a key from the `nodes` rule map. For `setEdgeRps`: an edge ID |
| `value` | number \| string | Action-specific value (multiplier, RPS count, or traffic mode string) |
| `message` | string | Human-readable label shown in the event log |

### Available actions

| `action` | `target` | `value` | Effect |
|---|---|---|---|
| `setMultiplier` | — | number | Changes the global RPS multiplier |
| `setMode` | — | `"steady"` \| `"ramp"` \| `"spike"` \| `"chaos"` | Switches the traffic mode mid-simulation |
| `degradeNode` | node rule key | — | Sets matched node(s) to `degraded` status and raises error rate |
| `failNode` | node rule key | — | Sets matched node(s) to `down` status; all traffic fails |
| `restoreNode` | node rule key | — | Restores matched node(s) to `healthy` status |
| `setEdgeRps` | edge ID | number | Overrides throughput on a specific edge at runtime |

---

## `globalSlo` — diagram-wide thresholds

Applied across the entire diagram as a fallback for nodes without a per-node SLO.

```json
"globalSlo": {
  "maxErrorRate": 0.01,
  "maxP99LatencyMs": 500
}
```

| Field | Type | Description |
|---|---|---|
| `maxErrorRate` | number | Diagram-wide error rate ceiling (`0.0`–`1.0`) |
| `maxP99LatencyMs` | number | Diagram-wide P99 latency ceiling in milliseconds |

---

## Node types

Valid values for `match.type` in node and edge rules:

| Type | Label | Category |
|---|---|---|
| `ec2` | EC2 / VM | Compute |
| `lambda` | Lambda | Compute |
| `container` | Container | Compute |
| `pod` | Pod | Compute |
| `loadBalancer` | Load Balancer | Network |
| `apiGateway` | API Gateway | Network |
| `cdn` | CDN | Network |
| `dns` | DNS | Network |
| `firewall` | Firewall | Network |
| `vpn` | VPN | Network |
| `dbSql` | Database (SQL) | Storage |
| `dbNoSql` | Database (NoSQL) | Storage |
| `objectStorage` | Object Storage | Storage |
| `fileStorage` | File Storage | Storage |
| `queue` | Message Queue | Messaging |
| `eventBus` | Event Bus | Messaging |
| `pubsub` | Pub/Sub Topic | Messaging |
| `stream` | Stream (Kafka) | Messaging |
| `redis` | Redis | Caching |
| `memcached` | Memcached | Caching |
| `cdnCache` | CDN Cache | Caching |
| `k8sCluster` | K8s Cluster | Orchestration |
| `ecsCluster` | ECS Cluster | Orchestration |
| `dockerCompose` | Docker Compose | Orchestration |
| `vpc` | VPC | Grouping |
| `subnet` | Subnet | Grouping |
| `az` | Availability Zone | Grouping |
| `region` | Region | Grouping |
| `namespace` | Namespace | Grouping |

Grouping types (`vpc`, `subnet`, `az`, `region`, `namespace`) are pass-through — they have no capacity limits and ScaleScript `simConfig` on them has no effect.

---

## Default simulation values by node type

These are the values active when no ScaleScript overrides are present. Use them as a baseline when authoring scripts.

| Type | maxRps | processingMs | p50Ms | p99Ms | connectionPool.max |
|---|---|---|---|---|---|
| `ec2` | 1,000 | 10 | 20 | 250 | — |
| `lambda` | 1,000 | 50 | 80 | 800 | — |
| `container` | 500 | 15 | 20 | 250 | — |
| `pod` | 300 | 20 | 20 | 250 | — |
| `loadBalancer` | 10,000 | 2 | 3 | 20 | — |
| `apiGateway` | 5,000 | 5 | 10 | 100 | — |
| `cdn` | 20,000 | 1 | 5 | 50 | — |
| `dns` | 50,000 | 1 | 1 | 10 | — |
| `firewall` | 5,000 | 2 | 2 | 15 | — |
| `vpn` | 1,000 | 5 | 10 | 80 | — |
| `dbSql` | 500 | 5 | 8 | 200 | 100 |
| `dbNoSql` | 5,000 | 2 | 2 | 30 | 500 |
| `objectStorage` | 2,000 | 50 | 30 | 300 | 1,000 |
| `fileStorage` | 500 | 20 | 20 | 200 | — |
| `queue` | 10,000 | 0 | 1 | 10 | — |
| `eventBus` | 10,000 | 0 | 1 | 10 | — |
| `pubsub` | 10,000 | 0 | 1 | 10 | — |
| `stream` | 50,000 | 0 | 2 | 20 | — |
| `redis` | 50,000 | 1 | 0.5 | 5 | 10,000 |
| `memcached` | 50,000 | 1 | 0.5 | 5 | 10,000 |
| `cdnCache` | 20,000 | 1 | 3 | 30 | — |
| `k8sCluster` | 2,000 | 5 | 5 | 50 | — |
| `ecsCluster` | 2,000 | 5 | 5 | 50 | — |
| `dockerCompose` | 500 | 15 | 10 | 100 | — |

---

## Full example

```json
{
  "version": "1",
  "name": "Black Friday — DB Failure Recovery",
  "description": "Ramps to 3x traffic, degrades then kills the SQL database, verifies auto-recovery",
  "author": "rishi",
  "tags": ["stress", "database", "chaos"],

  "simulation": {
    "mode": "ramp",
    "baseMultiplier": 1.0,
    "speed": 2
  },

  "nodes": {
    "api": {
      "match": { "type": "apiGateway" },
      "simConfig": { "maxRps": 8000, "processingMs": 8, "errorRate": 0 },
      "slo": { "maxP90LatencyMs": 150, "maxErrorRate": 0.005 }
    },
    "primary-db": {
      "match": { "label": "postgres" },
      "simConfig": {
        "maxRps": 800,
        "processingMs": 8,
        "errorRate": 0,
        "connectionPool": { "max": 150, "timeoutMs": 3000 },
        "circuitBreaker": { "errorThreshold": 0.4, "resetMs": 8000 }
      },
      "slo": { "maxP90LatencyMs": 80, "maxErrorRate": 0.001, "maxUtilization": 0.65 }
    },
    "cache": {
      "match": { "type": "redis" },
      "simConfig": { "maxRps": 80000 }
    }
  },

  "edges": {
    "api-to-db": {
      "match": { "sourceType": "apiGateway", "targetLabel": "postgres" },
      "throughput": 600
    }
  },

  "scenarios": [
    { "at": 20, "action": "setMultiplier", "value": 2.0,    "message": "Traffic doubles" },
    { "at": 40, "action": "setMultiplier", "value": 3.0,    "message": "Peak traffic" },
    { "at": 60, "action": "degradeNode",   "target": "primary-db", "message": "DB under disk pressure" },
    { "at": 90, "action": "failNode",      "target": "primary-db", "message": "DB primary fails" },
    { "at": 150,"action": "restoreNode",   "target": "primary-db", "message": "Failover complete" },
    { "at": 180,"action": "setMode",       "value": "steady",      "message": "Return to baseline" }
  ],

  "globalSlo": {
    "maxErrorRate": 0.05,
    "maxP99LatencyMs": 1000
  }
}
```
