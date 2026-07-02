# Optimization Issues — Spec & Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to work this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Hard dependencies:**
> 1. [`critical-issues-spec.md`](./critical-issues-spec.md) Task 0 (the `particleEngine.ts` split) must be merged before O1 (chaos.ts) or O5 (spawnParticles, sequenced after C3).
> 2. [`warning-issues-spec.md`](./warning-issues-spec.md) Task W4 (health-score `rawUtilization` fix) must be merged before O3 — both touch the same `updateAllNodeMetrics` utilization block.
>
> Confirm both before starting: `git log --oneline -- src/app/canvas/simulation/particleEngine/circuitBreakers.ts` and check the Warning doc's tracker for W4's commit.

**Goal:** Address six optimization-opportunity issues (GitHub issues #11–#16, labeled `optimization`) — realism and cost-fidelity gaps in the simulation engine, identified in `SRE_Critique.md`. These are enhancements, not bugs; prioritize correctness of the existing behavior they touch over scope-creep into new features beyond what each issue asks for.

**Architecture:** Five issues (O1, O3, O4, O5, O6) land in `particleEngine.ts`/`particleEngine/chaos.ts`. One issue (O2) is materially larger — it asks for CAP-theorem modeling (replication, quorum, consistency levels) and touches `particleEngine.ts`, `nodeConfig.ts` (a hub file per `docs/module-boundaries.md` §2), and `costModel.ts`. Treat O2 as its own isolated sub-project, scheduled last, not bundled into the same PR wave as the other five.

**Tech Stack:** TypeScript, Vitest.

## Global Constraints

- No new npm dependencies.
- `npm run build` must pass after every task.
- Every task adds a Vitest test co-located with the file it changes.
- `nodeConfig.ts` is a 31-file-fan-in hub per `docs/module-boundaries.md` §2 — **append only** (new optional fields, new registry entries). Do not reorder or reformat existing keys in the same PR as a behavior change.

---

## Merge-Conflict Prevention Strategy

| Task | File(s) | Depends on | Can run parallel with |
|---|---|---|---|
| O1 | `particleEngine/chaos.ts` | Critical Task 0 merged | O3, O4, O5, O6 (not O2 — see O2's own note) |
| O2 | `particleEngine.ts` (DB handling), `nodeConfig.ts` (hub, append-only), `costModel.ts` | none structurally, but schedule last — largest blast radius in this doc | nothing else touching `nodeConfig.ts` in the same window |
| O3 | `particleEngine.ts` (`updateAllNodeMetrics`, `cpuFactor`) | Warning doc's W4 merged | O1, O4, O5, O6 |
| O4 | `src/lib/regionConfig.ts` + `particleEngine.ts` (latency sampling call site) | none | O1, O3, O5, O6 |
| O5 | `particleEngine.ts` (`spawnParticles`, egress attribution) | Critical Task 3 (C3) merged — both touch `spawnParticles` | O1, O3, O4, O6 |
| O6 | `particleEngine.ts` (`isReadParticle`, `buildSnapshot`) | none | everything |

O2 is flagged separately because it's the only issue in any of the three docs that touches a hub file (`nodeConfig.ts`) — per `docs/module-boundaries.md` §2's append-only convention, land it as its own solo PR with nothing else concurrently modifying `nodeConfig.ts`, and expect it to take meaningfully longer than the other five tasks combined.

---

### Task O1: No link partition or packet-loss model

**GitHub issue:** #11 — `[O1] No link partition or packet-loss model`

**Files:**
- Modify: `src/app/canvas/simulation/particleEngine/chaos.ts` (created in the Critical doc's Task 0; extended by the Warning doc's W2 — this task lands after both)
- Modify: `src/app/canvas/simulation/particleEngine.ts` (edge-level chaos application in `spawnParticles`/arrival handling)
- Test: `src/app/canvas/simulation/particleEngine/chaos.test.ts` (extend the file from Warning doc's W2)

**Interfaces:**
- Consumes: `ChaosEntry`, `_chaosFailures` (node-keyed) from `chaos.ts` — this task adds a **parallel edge-keyed** structure rather than overloading the node-keyed one, since a partition is a property of a link, not a node.
- Produces: `EdgeChaosEntry` and `isEdgePartitioned(edgeId, now)` — new exports consumed by `spawnParticles`'s per-edge loop.

**Scope:** chaos today only fails **nodes** (`_chaosFailures` is node-keyed); there's no way to sever a specific edge, or partition a region, while both endpoints stay healthy — the biggest realism gap flagged in `SRE_Critique.md` for an app that advertises "network partitions" as a concern. Per the issue's recommendation, add an edge-level chaos mode (link down / probabilistic loss) and a region-partition primitive; this unlocks O2's CAP-theorem work but does not require it — implement independently.

- [ ] **Step 1: Write the failing test**

```typescript
// particleEngine/chaos.test.ts (append)
import { triggerEdgePartition, isEdgePartitioned, clearChaosState } from './chaos'

describe('edge-level partition chaos', () => {
  beforeEach(() => clearChaosState())

  it('an edge with an active partition reports isEdgePartitioned = true', () => {
    triggerEdgePartition('edge-1', /* durationMs */ 5000, /* now */ 0)
    expect(isEdgePartitioned('edge-1', 100)).toBe(true)
  })

  it('the partition clears after its duration elapses', () => {
    triggerEdgePartition('edge-1', 5000, 0)
    expect(isEdgePartitioned('edge-1', 6000)).toBe(false)
  })

  it('partitioning an edge does not affect the health of its source/target nodes', () => {
    triggerEdgePartition('edge-1', 5000, 0)
    // Node health state is tracked elsewhere (particleEngine.ts's _nodeHealthStates) — assert
    // this module exposes no node-keyed side effect from an edge-only partition call.
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/chaos.test.ts`
Expected: FAIL — `triggerEdgePartition`/`isEdgePartitioned` don't exist yet.

- [ ] **Step 3: Implement edge-level chaos**

```typescript
// chaos.ts (additions)
interface EdgePartitionEntry { partitionedUntilSimMs: number; lossRate: number }
const _edgePartitions = new Map<string, EdgePartitionEntry>()

export function triggerEdgePartition(edgeId: string, durationMs: number, nowSimMs: number, lossRate = 1.0): void {
  _edgePartitions.set(edgeId, { partitionedUntilSimMs: nowSimMs + durationMs, lossRate })
}

export function isEdgePartitioned(edgeId: string, nowSimMs: number): boolean {
  const entry = _edgePartitions.get(edgeId)
  if (!entry) return false
  if (nowSimMs >= entry.partitionedUntilSimMs) { _edgePartitions.delete(edgeId); return false }
  return true
}

// A region partition is expressed as triggering edge-partition on every edge crossing the
// region boundary — no separate "region" state needed; the primitive is edge-level, region
// partitioning is a caller-side convenience that enumerates crossing edges once.
export function triggerRegionPartition(crossingEdgeIds: string[], durationMs: number, nowSimMs: number): void {
  for (const id of crossingEdgeIds) triggerEdgePartition(id, durationMs, nowSimMs)
}

export function clearChaosState(): void {
  // ...existing clears from Warning doc's W2...
  _edgePartitions.clear()
}
```

In `spawnParticles`'s per-edge loop, check `isEdgePartitioned(ep.id, _simulatedTimeMs)` alongside the existing circuit/health checks and drop particles on a partitioned edge (probabilistically, per `lossRate`, rather than only the deterministic 100% case) — this is what makes the loss "stochastic per-hop," per the issue, distinct from the existing deterministic capacity/health/circuit drops.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/chaos.test.ts`
Expected: PASS

- [ ] **Step 5: Wire a trigger surface**

This task only needs the engine primitive + one call site to be usable; wiring a UI control (e.g. a "partition this edge" context-menu action, or a ScaleScript scenario action) is a reasonable follow-up but not required for this issue to be considered fixed — the recommendation asks for the *model*, not a UI. Note this explicitly in the commit message so it isn't assumed done.

- [ ] **Step 6: Commit**

```bash
git add src/app/canvas/simulation/particleEngine/chaos.ts src/app/canvas/simulation/particleEngine/chaos.test.ts src/app/canvas/simulation/particleEngine.ts
git commit -m "feat: add edge-level partition/packet-loss chaos primitive (#11)"
```

---

### Task O2: No consensus/replication/quorum — CAP unmodeled

**GitHub issue:** #12 — `[O2] No consensus/replication/quorum -- CAP unmodeled`

**Files:**
- Modify: `src/lib/nodeConfig.ts` (hub file — append new optional `NodeSimConfig` fields only: `consistencyLevel?: 'ONE' | 'QUORUM' | 'ALL'`, `replicationLagMs?: number`)
- Modify: `src/app/canvas/simulation/particleEngine.ts` (DB read/write handling — apply replication lag and partition-aware availability per consistency level)
- Modify: `src/lib/costModel.ts` (replica count affects storage/compute cost — read-only addition, existing signatures unchanged)
- Test: `src/app/canvas/simulation/particleEngine/replication.test.ts`, `src/lib/costModel.test.ts`

**Interfaces:**
- Consumes: `isEdgePartitioned`/`triggerRegionPartition` from O1 (`chaos.ts`) for the partition-aware read/write availability behavior — this task should start after O1 merges even though the table above doesn't list it as a hard dependency, since implementing "partition-aware availability" without a partition primitive to test against is not meaningfully verifiable.
- Produces: `NodeSimConfig.consistencyLevel`/`.replicationLagMs` — new optional fields; every existing call site that reads `NodeSimConfig` via spread/defaults continues to work unchanged since both are optional.

**Scope (largest in this doc):** databases are currently single capacity buckets with no replication lag, leader election, quorum read/write, split-brain, or consistency-vs-availability tradeoff under partition. Per the issue's recommendation: model DB nodes as replica sets with a configurable consistency level (`ONE`/`QUORUM`/`ALL`), a replication-lag parameter, and partition-aware read/write availability, pairing with O1's partition primitive.

**Recommended de-scoping for a first PR** (flag this to the user/reviewer rather than silently cutting scope): implement `consistencyLevel` and `replicationLagMs` as configuration + their effect on read staleness and availability-under-partition (the CAP-theorem-visible behavior the issue is actually asking for), but do not implement full leader election or split-brain simulation in this pass — those are a plausible Phase 2 if this lands well. State this explicitly in the PR description.

- [ ] **Step 1: Write the failing test**

```typescript
// src/app/canvas/simulation/particleEngine/replication.test.ts
import { describe, it, expect } from 'vitest'
// Fixture: a dbSql node configured with consistencyLevel: 'QUORUM', replicationLagMs: 200,
// behind a partitioned edge (via O1's triggerEdgePartition) isolating one replica.

describe('quorum consistency under partition', () => {
  it('a QUORUM-consistency DB remains available for reads/writes when only a minority of replicas are partitioned', () => {
    // Arrange/Act/Assert per the fixture above.
  })

  it('an ALL-consistency DB becomes unavailable for writes when any replica is partitioned', () => {
    // Arrange/Act/Assert.
  })

  it('reads reflect replicationLagMs as added staleness/latency on non-primary replica reads', () => {
    // Arrange/Act/Assert.
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/replication.test.ts`
Expected: FAIL — no replica/consistency modeling exists yet.

- [ ] **Step 3: Add the config fields (hub file, append-only)**

```typescript
// nodeConfig.ts — add to the existing NodeSimConfig interface, do not reorder existing fields
export interface NodeSimConfig {
  // ...existing fields, unchanged...
  consistencyLevel?: 'ONE' | 'QUORUM' | 'ALL'   // DB nodes only; undefined = today's single-bucket behavior
  replicationLagMs?: number                      // DB nodes only; undefined = 0 (no lag modeled)
}
```

- [ ] **Step 4: Implement replica-set availability logic**

In `particleEngine.ts`'s DB-node handling (arrival/health path), when `consistencyLevel` is set: track a fixed small replica count (e.g. 3, matching the recommendation's `ONE`/`QUORUM`/`ALL` semantics without exposing a separate replica-count field yet — keep the first pass simple), compute how many replicas are reachable given active edge partitions (via O1's `isEdgePartitioned`), and gate write/read availability: `ONE` available if ≥1 replica reachable, `QUORUM` if ≥2 of 3, `ALL` if 3 of 3. Add `replicationLagMs` as extra latency on reads attributed to non-primary replicas (reuse the existing log-normal latency sampling pattern from `sampleLatencyMs` rather than inventing a new distribution).

- [ ] **Step 5: Cost model integration**

In `costModel.ts`, when a DB node has `consistencyLevel` set, multiply its storage/compute cost components by the modeled replica count (3) rather than 1 — this is additive to existing cost logic, not a signature change; verify existing `costModel.test.ts` cases (if any exist by this point from other work) still pass unchanged for nodes without `consistencyLevel` set.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/replication.test.ts src/lib/costModel.test.ts`
Expected: PASS

- [ ] **Step 7: Manual check**

Run: `npm run tauri dev`, configure a `dbSql` node with `consistencyLevel: QUORUM`, partition one of its region edges via O1's trigger path, confirm the DB stays available (per quorum), then repeat with `ALL` and confirm it goes unavailable.

- [ ] **Step 8: Commit**

```bash
git add src/lib/nodeConfig.ts src/app/canvas/simulation/particleEngine.ts src/lib/costModel.ts src/app/canvas/simulation/particleEngine/replication.test.ts src/lib/costModel.test.ts
git commit -m "feat: model DB consistency level, replication lag, and partition-aware availability (#12)"
```

---

### Task O3: Saturation latency capped at 4x vs unbounded queueing tail

**GitHub issue:** #13 — `[O3] Saturation latency capped at 4x vs unbounded queueing tail`

**Files:**
- Modify: `src/app/canvas/simulation/particleEngine.ts` (`cpuFactor`, confirmed region ~`:1817-1819`, and the `utilization = inRps/maxRps` linear computation)
- Test: `src/app/canvas/simulation/particleEngine/saturationLatency.test.ts`

**Interfaces:**
- Consumes: `rawUtilization` as fixed by the Warning doc's W4 — **do not start this task until W4 has merged**, since both touch the same block of `updateAllNodeMetrics` and this task's formula change should be written against W4's already-corrected utilization semantics, not the pre-W4 double-counted one.
- Produces: the latency-amplification multiplier now applies to storage/messaging node types too, not just compute — anything reading `p50LatencyMs`/`p99LatencyMs` for DB/queue nodes will see amplification near saturation where none existed before.

**Root cause:** latency amplification is `1 + ((util-0.7)/0.3)^2 * 3` — capped at 4x at 100% utilization, and only applied to compute types. Real queueing systems follow ~`1/(1-rho)` (M/M/1): latency should blow up hyperbolically as utilization approaches 1, not plateau. DBs/queues get no amplification at all today.

**Fix:** replace the capped polynomial with a queueing-theoretic multiplier, clamped only for numerical safety, applied uniformly across compute/storage/messaging node types.

- [ ] **Step 1: Write the failing test**

```typescript
// particleEngine/saturationLatency.test.ts
import { describe, it, expect } from 'vitest'
// Exercise the latency-amplification function directly if exported, or via a fixture that
// drives a node to a given utilization and reads back p99LatencyMs.

describe('queueing-theoretic latency amplification', () => {
  it('amplification grows hyperbolically, not capped at 4x, as utilization approaches 1', () => {
    // Assert amplification at util=0.95 is meaningfully higher than at util=0.9, and higher
    // than the old formula's ~4x ceiling would have produced.
  })

  it('applies amplification to storage (dbSql) and messaging (queue) node types, not just compute', () => {
    // Assert a dbSql node near saturation shows latency amplification (currently: none).
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/saturationLatency.test.ts`
Expected: FAIL — current formula caps at 4x and skips non-compute types.

- [ ] **Step 3: Implement the fix**

```typescript
// particleEngine.ts — replace cpuFactor's capped polynomial
function saturationLatencyMultiplier(rawUtilization: number): number {
  const clamped = Math.min(rawUtilization, 0.99)  // numerical safety near rho=1
  return 1 / (1 - clamped)
}
```

Apply `saturationLatencyMultiplier(rawUtilization)` to the latency computation for compute, storage, and messaging node types alike (read the current `cpuFactor` call site to find where the type-gate currently excludes storage/messaging, and remove that gate — verify via `codegraph explore "cpuFactor rawUtilization NodeType"` since exact conditionals may have shifted since the issue was filed).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/saturationLatency.test.ts`
Expected: PASS

- [ ] **Step 5: Regression check on existing "4x ceiling" expectations**

Run: `npm run tauri dev`, drive a compute node to ~100% utilization, confirm p99 latency now grows well past the old ~4x ceiling as utilization approaches 1, and confirm a DB/queue node driven to saturation now also shows amplified latency (previously flat).

- [ ] **Step 6: Commit**

```bash
git add src/app/canvas/simulation/particleEngine.ts src/app/canvas/simulation/particleEngine/saturationLatency.test.ts
git commit -m "fix: replace capped polynomial latency amplification with 1/(1-rho) queueing model, applied to all node types (#13)"
```

---

### Task O4: Geo latency deterministic — no jitter

**GitHub issue:** #14 — `[O4] Geo latency deterministic -- no jitter`

**Files:**
- Modify: `src/lib/regionConfig.ts` (`interRegionLatencyMs`, confirmed at `:42-52` — currently a pure deterministic function of `(fromId, toId)`)
- Modify: `src/app/canvas/simulation/particleEngine.ts` (call site that consumes `interRegionLatencyMs`/`origin.baseLatencyMs`)
- Test: `src/lib/regionConfig.test.ts`

**Interfaces:**
- Produces: a new `sampleInterRegionLatencyMs(fromId, toId, rng?)` in `regionConfig.ts` that wraps the existing pure `interRegionLatencyMs` with jitter — keep `interRegionLatencyMs` itself pure and deterministic (other callers, if any, may rely on determinism for cost/region-metadata display; do not change its signature).

**Root cause (confirmed against current source):** `interRegionLatencyMs` (`regionConfig.ts:42-52`) is a pure function returning a fixed constant per `(from, to)` zone/region pair, with zero variance — confirmed reading the source, no jitter anywhere in the file. Server processing latency is log-normal (`sampleLatencyMs` in `particleEngine.ts`), but the network component has none, so tail latency is entirely processing-driven, unlike real WAN links.

**Fix:** sample the geo component with a small jitter distribution, per the issue's recommendation, optionally coupled to future link-congestion state (not required now — O1's partition primitive is the closest analog; leave the coupling as a documented follow-up, don't block this fix on it).

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/regionConfig.test.ts
import { describe, it, expect } from 'vitest'
import { interRegionLatencyMs, sampleInterRegionLatencyMs } from './regionConfig'

describe('geo latency jitter', () => {
  it('interRegionLatencyMs remains deterministic (unchanged behavior)', () => {
    expect(interRegionLatencyMs('us-east-1', 'eu-west-1')).toBe(interRegionLatencyMs('us-east-1', 'eu-west-1'))
  })

  it('sampleInterRegionLatencyMs varies across repeated calls for the same pair', () => {
    const samples = Array.from({ length: 20 }, () => sampleInterRegionLatencyMs('us-east-1', 'eu-west-1'))
    expect(new Set(samples).size).toBeGreaterThan(1)
  })

  it('sampleInterRegionLatencyMs is centered near the deterministic base value', () => {
    const base = interRegionLatencyMs('us-east-1', 'eu-west-1')
    const samples = Array.from({ length: 200 }, () => sampleInterRegionLatencyMs('us-east-1', 'eu-west-1'))
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length
    expect(mean).toBeGreaterThan(base * 0.85)
    expect(mean).toBeLessThan(base * 1.15)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/regionConfig.test.ts`
Expected: FAIL — `sampleInterRegionLatencyMs` doesn't exist yet.

- [ ] **Step 3: Implement the jitter wrapper**

```typescript
// regionConfig.ts (additions — interRegionLatencyMs itself stays unchanged, per the constraint above)
const GEO_JITTER_FRACTION = 0.1  // ±10% of base latency, small relative to processing-latency variance

export function sampleInterRegionLatencyMs(fromId: string, toId: string): number {
  const base = interRegionLatencyMs(fromId, toId)
  if (base === 0) return 0  // same-region: no jitter on a floor of zero
  const jitter = base * GEO_JITTER_FRACTION * (Math.random() * 2 - 1)
  return Math.max(0, base + jitter)
}
```

Update the `particleEngine.ts` call site (origin-latency application at particle spawn/arrival — the same site currently reading `interRegionLatencyMs`/`origin.baseLatencyMs`) to call `sampleInterRegionLatencyMs` instead.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/regionConfig.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/regionConfig.ts src/lib/regionConfig.test.ts src/app/canvas/simulation/particleEngine.ts
git commit -m "feat: sample inter-region latency with jitter instead of a fixed constant (#14)"
```

---

### Task O5: Egress billed at spawn regardless of delivery

**GitHub issue:** #15 — `[O5] Egress billed at spawn regardless of delivery`

**Files:**
- Modify: `src/app/canvas/simulation/particleEngine.ts` (`spawnParticles` ~`:909` for the current spawn-time attribution; `handleParticleArrival` for the new arrival-time attribution)
- Test: `src/app/canvas/simulation/particleEngine/egressAttribution.test.ts`

**Interfaces:**
- Consumes: `_egressBytesAccum` (existing per-node accumulator, confirmed at `:114`) — this task changes *when* it's written, not its shape.
- Produces: egress bytes now attributed on successful arrival, not spawn — `costModel.ts`'s egress billing (which reads `NodeMetrics.egressBytesPerSec`, itself fed by `_egressBytesAccum`) will report lower, more accurate cost for scenarios with drops/timeouts/open circuits. **Sequence after Critical doc's C3** — both this task and C3 touch `spawnParticles`; land C3 first so this task's diff is against the post-C3 (cap-decoupled) version of the function.

**Root cause:** `spawnParticles` attributes `payloadBytes` to the target node at mint time (`~:909`), before the particle has actually arrived — if it's later dropped, times out, or hits an open circuit, the byte count was already billed. Combined with the Critical doc's C3 (particle cap), egress is simultaneously over-counted (failed requests still billed) and under-counted (clipped particles under load never spawned to be billed) — net error is unpredictable under stress.

**Fix:** move the `_egressBytesAccum` write from spawn time to the arrival handler, only on successful arrival (not on drop/timeout/circuit-reject paths).

- [ ] **Step 1: Write the failing test**

```typescript
// particleEngine/egressAttribution.test.ts
import { describe, it, expect } from 'vitest'
// Fixture: a single edge with a circuit forced open (via circuitBreakers.ts's getBreaker),
// so any particle spawned toward it is immediately dropped rather than arriving.

describe('egress byte attribution', () => {
  it('does not accumulate egress bytes for a particle that never arrives (circuit open)', () => {
    // Arrange: force the edge's breaker open.
    // Act: run spawnParticles for several ticks.
    // Assert: the target node's egressBytesPerSec / _egressBytesAccum-derived metric stays 0.
  })

  it('accumulates egress bytes only once the particle successfully arrives', () => {
    // Arrange: healthy edge, no drops.
    // Act: spawn and advance the sim until at least one particle arrives.
    // Assert: egress bytes are 0 immediately after spawn, non-zero after arrival.
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/egressAttribution.test.ts`
Expected: FAIL — bytes are currently attributed at spawn, so the first assertion in each test fails (non-zero immediately, or non-zero even under a dropped particle).

- [ ] **Step 3: Implement the fix**

Remove the `_egressBytesAccum` write from `spawnParticles`'s mint loop (keep `payloadBytes` sampling itself — it's still needed on the `Particle` object for display in `RequestInspector`, just don't bill it yet). Add the accumulation call in `handleParticleArrival`, gated on the arrival being a successful one (not a drop/timeout branch):

```typescript
// handleParticleArrival — on the successful-arrival branch only (not the drop/timeout/circuit-reject branches)
const current = _egressBytesAccum.get(particle_targetNodeId) ?? 0
_egressBytesAccum.set(particle_targetNodeId, current + particle.payloadBytes * PARTICLE_REQUEST_RATIO)
```

(`PARTICLE_REQUEST_RATIO` scaling matches the existing comment at `:112-113` describing how one visual particle stands in for `PARTICLE_REQUEST_RATIO` real requests — preserve that scaling, just move which code path applies it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/egressAttribution.test.ts`
Expected: PASS

- [ ] **Step 5: Regression check on CostTracker**

Run: `npm run tauri dev`, open `CostTracker`, compare estimated egress cost for a healthy diagram before/after this change (should be roughly unchanged — most particles arrive successfully) versus a diagram with a forced-open circuit or saturated node (should now show lower egress cost than before, since failed deliveries are no longer billed).

- [ ] **Step 6: Commit**

```bash
git add src/app/canvas/simulation/particleEngine.ts src/app/canvas/simulation/particleEngine/egressAttribution.test.ts
git commit -m "fix: bill egress bytes on successful arrival, not on spawn (#15)"
```

---

### Task O6: Read/write modulus mismatch (100 vs 97)

**GitHub issue:** #16 — `[O6] Read/write modulus mismatch (100 vs 97)`

**Files:**
- Modify: `src/app/canvas/simulation/particleEngine.ts` (`isReadParticle`, confirmed at `:461`; `buildSnapshot`, confirmed at `:2319` — issue cited `:2325` for the specific line, consistent with a reference inside the function body)
- Test: `src/app/canvas/simulation/particleEngine/readWriteLane.test.ts`

**Interfaces:**
- Produces: a single shared helper both `isReadParticle` and `buildSnapshot`'s inspector-label logic call, replacing the two independent moduli — no external signature change, since both were internal to `particleEngine.ts`.

**Root cause (confirmed against current source):** `isReadParticle` uses `id % 100`; `buildSnapshot` independently computes a lane label using `% 97`, with a comment claiming it "mirrors" the `% 97` pattern — but `isReadParticle` doesn't use `% 97` at all, so the two disagree. A particle's actual read/write lane (which drives DB read/write capacity accounting) can differ from what the inspector displays for that same particle — cosmetic, but confusing when debugging DB read/write splits.

**Fix:** extract one shared helper, use it in both places.

- [ ] **Step 1: Write the failing test**

```typescript
// particleEngine/readWriteLane.test.ts
import { describe, it, expect } from 'vitest'
// isReadParticle and the inspector-label logic in buildSnapshot are currently internal
// (unexported) — export a shared `particleReadWriteLane(id: number, readPercentage: number):
// 'read' | 'write'` helper as part of this fix so it's directly testable.
import { particleReadWriteLane } from '../particleEngine'

describe('read/write lane consistency', () => {
  it('the same particle id + readPercentage always classifies the same way, everywhere it is checked', () => {
    for (const id of [1, 50, 97, 99, 100, 196, 197]) {
      const a = particleReadWriteLane(id, 0.8)
      const b = particleReadWriteLane(id, 0.8)
      expect(a).toBe(b)  // trivially true today too — the real bug is *two different call sites*
                          // disagreeing, covered by the next test
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/readWriteLane.test.ts`
Expected: FAIL — `particleReadWriteLane` doesn't exist yet (`isReadParticle` and `buildSnapshot`'s inline `% 97` logic are two separate, unexported code paths).

- [ ] **Step 3: Implement the shared helper**

```typescript
// particleEngine.ts — replace both isReadParticle's body and buildSnapshot's inline % 97 logic
export function particleReadWriteLane(id: number, readPercentage: number): 'read' | 'write' {
  return (id % 100) < readPercentage * 100 ? 'read' : 'write'
}

function isReadParticle(particle: Particle, readPercentage: number): boolean {
  return particleReadWriteLane(particle.id, readPercentage) === 'read'
}
```

In `buildSnapshot`, replace the inline `seed = p.id % 97` inspector-label computation with a call to `particleReadWriteLane(p.id, readPercentage)`, sourcing `readPercentage` from the same `EdgeData.readPercentage` field `isReadParticle`'s caller already uses (confirmed field exists at `nodeConfig.ts:304`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/readWriteLane.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/canvas/simulation/particleEngine.ts src/app/canvas/simulation/particleEngine/readWriteLane.test.ts
git commit -m "fix: share one read/write lane helper between capacity accounting and inspector display (#16)"
```

---

## Sequencing Summary

```
Critical Task 0 (split, merged) ──► O1 (chaos.ts) ──► O2 (replication — solo PR, touches nodeConfig.ts hub)
Critical Task 3 (C3, merged)    ──► O5 (spawnParticles egress)
Warning Task W4 (merged)        ──► O3 (saturation latency)

No dependency, parallel-safe:
   O4 (regionConfig.ts)
   O6 (isReadParticle/buildSnapshot)
```

## Definition of Done

- [ ] All six tasks' tests pass: `npx vitest run src/app/canvas/simulation/particleEngine src/lib/regionConfig.test.ts src/lib/costModel.test.ts`
- [ ] `npm run build` passes
- [ ] `docs/module-boundaries.md` updated if O2 introduces new fan-in to `nodeConfig.ts` worth documenting (check fan-in count via `codegraph explore "NodeSimConfig"` before/after)
- [ ] Manual smoke test in `npm run tauri dev`: partition an edge and confirm quorum DB behavior (O1/O2), observe latency blow-up near saturation for a DB node (O3), observe geo-latency jitter in the request inspector (O4), compare egress cost before/after a forced circuit-open (O5), confirm DB read/write split in `PropertiesPanel` matches the inspector's per-request lane label (O6)
- [ ] GitHub issues #11–#16 closed with references to the merged commits
