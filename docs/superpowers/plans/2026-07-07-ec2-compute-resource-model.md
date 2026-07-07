# EC2 Compute Resource Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the EC2 node's abstract `maxRps` capacity gate with a physical vCPU/RAM compute model — deriving throughput from CPU work per request, thread concurrency from RAM, and modeling OOM crashes and CPU-saturation latency.

**Architecture:** A new pure module (`particleEngine/compute.ts`) holds all resource math (CPU time, thread caps, RAM, ρ, admission decision) as tested functions. The rAF loop calls into it for EC2 nodes only. `maxRps` stays in the type system and other node types are untouched; EC2 gains `ComputeProfile` (hardware) + `WorkloadDemand` (per-request cost). Cost integrates via a new `computeResource` registry `CostKind`. Everything is gated on `config.computeProfile !== undefined`, so nodes without a profile keep today's behavior (same pattern as `dbConfig`/`k8sPod`).

**Tech Stack:** TypeScript, React 19, Zustand, `@xyflow/react`, vitest. No new dependencies.

## Global Constraints

- **Scope: EC2 only.** `container`, `pod`, `lambda`, DBs, queues, network, grouping nodes keep their current capacity semantics. Do not touch their code paths.
- **`maxRps` is NOT removed from the type.** `NodeSimConfig.maxRps` stays required (removing it ripples through ~8 subsystems and every cloud preset). "Get rid of `maxRps` for EC2" means: (a) the engine stops gating EC2 admission on `inRps/maxRps`, and (b) the EC2 config UI stops exposing Max RPS / Max Threads. The field remains present and used by all other node types.
- **IPC is a fixed placeholder: `COMPUTE_IPC = 2.0`** across all CPU families (documented interim until a per-family lookup table exists).
- **Architecture affects cost only in v1.** `arm64` gets cheaper per-vCPU/GiB rates as real registry data. No per-workload performance multiplier (crypto/JVM) yet.
- **Base latency stays `latencyModel` (p50/p99).** CPU saturation ρ *amplifies* it through the existing `saturationLatencyMultiplier`. `ioBoundFraction` is used only for `maxThreadsCPU` and concurrency/hold-time, never to reconstruct absolute latency.
- **Soft vs hard limits:** CPU pressure (ρ) = rising latency, never a drop. Memory (`maxThreadsMem`, OOM) = the only hard admission/crash gate (plus optional `maxThreadsOverride`).
- **Design system:** JetBrains Mono, `COLORS`/`CATEGORY_COLORS` from `theme.ts`, `NumericStepper` for numeric inputs. Respect `prefers-reduced-motion` (no new animations here).
- Run `npx vitest run <file>` for a single test file; `npm run build` for type-check.
- Commit after every task. Update `docs/module-boundaries.md` in the final task.

---

### Task 1: Schema — ComputeProfile, WorkloadDemand, tier ranges

**Files:**
- Modify: `src/lib/nodeConfig.ts` (add after `NodeSimConfig`, ~line 153)
- Test: `src/lib/nodeConfig.workload.test.ts`

**Interfaces:**
- Produces:
  - `COMPUTE_IPC: number` (= 2.0)
  - `interface ComputeProfile { vCpu; ramGiB; architecture; cpuFamily; baseClockGhz; blockingIoModel; osBaseMemoryMb?; threadStackMb?; maxThreadsOverride? }`
  - `type WorkloadTier = 'simple_crud' | 'moderate_logic' | 'heavy_compute' | 'custom'`
  - `interface WorkloadDemand { tier; cpuInstructionsBillions; memoryFootprintMb; ioBoundFraction }`
  - `WORKLOAD_TIER_RANGES: Record<Exclude<WorkloadTier,'custom'>, { min; max; default }>`
  - `resolveWorkloadInstructions(tier, raw): number` — clamps `raw` into the tier's range, or passes it through for `'custom'`
  - `NodeSimConfig.computeProfile?: ComputeProfile` and `NodeSimConfig.workload?: WorkloadDemand`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/nodeConfig.workload.test.ts
import { describe, it, expect } from 'vitest'
import { WORKLOAD_TIER_RANGES, resolveWorkloadInstructions, COMPUTE_IPC } from './nodeConfig'

describe('workload tiers', () => {
  it('exposes IPC placeholder of 2.0', () => {
    expect(COMPUTE_IPC).toBe(2.0)
  })

  it('clamps a value into the selected tier range', () => {
    // simple_crud range is [0.001, 0.01]
    expect(resolveWorkloadInstructions('simple_crud', 5)).toBe(WORKLOAD_TIER_RANGES.simple_crud.max)
    expect(resolveWorkloadInstructions('simple_crud', 0)).toBe(WORKLOAD_TIER_RANGES.simple_crud.min)
    expect(resolveWorkloadInstructions('moderate_logic', 0.05)).toBe(0.05)
  })

  it('passes custom values through unclamped (but non-negative)', () => {
    expect(resolveWorkloadInstructions('custom', 42)).toBe(42)
    expect(resolveWorkloadInstructions('custom', -1)).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/nodeConfig.workload.test.ts`
Expected: FAIL — `resolveWorkloadInstructions`/`COMPUTE_IPC`/`WORKLOAD_TIER_RANGES` are not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/lib/nodeConfig.ts` immediately after the `NodeSimConfig` interface (after line 153):

```ts
// ─── Compute resource model (EC2 v1) ───────────────────────────────────────────
// Physical hardware profile for a compute node. When present on a node's simConfig, the engine
// derives capacity/latency/OOM from CPU + RAM instead of the abstract maxRps gate. Gated exactly
// like dbConfig/k8sPod — absent ⇒ legacy maxRps behavior, unchanged.
export const COMPUTE_IPC = 2.0   // fixed placeholder across all CPU families until a per-family
                                 // IPC lookup table (Geekbench/SPEC) is built. ~1.5–3.0 is the
                                 // realistic band for mixed server workloads; 2.0 is defensible.

export interface ComputeProfile {
  vCpu: number                       // linear compute units (1 vCPU ≈ 1 hardware thread)
  ramGiB: number
  architecture: 'x86_64' | 'arm64'   // v1: affects cost only (arm cheaper)
  cpuFamily: string                  // cosmetic in v1 (IPC fixed at COMPUTE_IPC)
  baseClockGhz: number
  blockingIoModel: boolean           // true: thread-per-request (a blocked thread holds a stack);
                                     // false: async/event-loop (no thread stack per in-flight req)
  osBaseMemoryMb?: number            // reserved RAM floor; default 512
  threadStackMb?: number             // per-in-flight thread stack (blocking only); default 1
  maxThreadsOverride?: number        // optional Tomcat-style artificial pool cap below RAM limit
}

export type WorkloadTier = 'simple_crud' | 'moderate_logic' | 'heavy_compute' | 'custom'

export interface WorkloadDemand {
  tier: WorkloadTier
  cpuInstructionsBillions: number    // resolved value (tier-clamped or custom)
  memoryFootprintMb: number          // RAM held per active request for its duration
  ioBoundFraction: number            // 0..0.99 — fraction of wall time blocked on IO (not CPU)
}

// Bounds + default per preset tier. 'custom' is unconstrained (any non-negative value).
export const WORKLOAD_TIER_RANGES: Record<Exclude<WorkloadTier, 'custom'>, { min: number; max: number; default: number }> = {
  simple_crud:    { min: 0.001, max: 0.01, default: 0.005 }, // ~1M–10M instr — parse, 1 query, serialize
  moderate_logic: { min: 0.01,  max: 0.1,  default: 0.05  }, // ~10M–100M instr — validation, transforms
  heavy_compute:  { min: 0.1,   max: 10.0, default: 1.0   }, // ~100M–10B instr — image/crypto/ML inference
}

// Clamp a raw instruction count into the selected tier's range; 'custom' passes through (>= 0).
export function resolveWorkloadInstructions(tier: WorkloadTier, raw: number): number {
  if (tier === 'custom') return Math.max(0, raw)
  const r = WORKLOAD_TIER_RANGES[tier]
  return Math.min(r.max, Math.max(r.min, raw))
}
```

Then add these two fields inside the `NodeSimConfig` interface (after line 152, before the closing `}`):

```ts
  // ─── Compute resource model (EC2 v1) ─────────────────────────────────────────
  // When set, the engine derives throughput/concurrency/OOM/latency from physical hardware
  // (computeProfile) + per-request cost (workload) instead of maxRps. EC2 only in v1.
  computeProfile?: ComputeProfile
  workload?: WorkloadDemand
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/nodeConfig.workload.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/nodeConfig.ts src/lib/nodeConfig.workload.test.ts
git commit -m "feat(compute): add ComputeProfile + WorkloadDemand schema and tier ranges"
```

---

### Task 2: Pure compute module (the resource math)

**Files:**
- Create: `src/app/canvas/simulation/particleEngine/compute.ts`
- Test: `src/app/canvas/simulation/particleEngine/compute.test.ts`

**Interfaces:**
- Consumes: `ComputeProfile`, `WorkloadDemand`, `COMPUTE_IPC` (Task 1).
- Produces (all pure):
  - `cpuTimeSec(w, p): number`
  - `perRequestMemMb(w, p): number`
  - `maxThreadsCPU(p, ioBoundFraction): number`
  - `maxThreadsMem(w, p): number`
  - `hardThreadCap(w, p): number`
  - `cpuUtilization(inRps, w, p): number`
  - `currentRamMb(activeRequests, w, p): number`
  - `nodeUtilization(inRps, activeRequests, w, p): { utilization; bottleneck: 'cpu' | 'memory' }`
  - `wallTimeMs(baseLatencyMs, w, p): number` (base latency is the IO/base component; unused hardware args reserved for future, see body)
  - `type Ec2Admission = 'admit' | 'drop-503' | 'oom-crash'`
  - `ec2AdmissionDecision(activeRequests, w, p): Ec2Admission`

- [ ] **Step 1: Write the failing test**

```ts
// src/app/canvas/simulation/particleEngine/compute.test.ts
import { describe, it, expect } from 'vitest'
import type { ComputeProfile, WorkloadDemand } from '../../../../lib/nodeConfig'
import {
  cpuTimeSec, maxThreadsCPU, maxThreadsMem, hardThreadCap,
  cpuUtilization, currentRamMb, nodeUtilization, ec2AdmissionDecision,
} from './compute'

const P: ComputeProfile = {
  vCpu: 2, ramGiB: 4, architecture: 'x86_64', cpuFamily: 'test',
  baseClockGhz: 3.0, blockingIoModel: true, osBaseMemoryMb: 512, threadStackMb: 1,
}
const W: WorkloadDemand = {
  tier: 'moderate_logic', cpuInstructionsBillions: 0.05, memoryFootprintMb: 32, ioBoundFraction: 0.8,
}

describe('compute math', () => {
  it('cpuTimeSec = instructions / (clock * IPC)', () => {
    // 0.05 / (3.0 * 2.0) = 0.008333.. s
    expect(cpuTimeSec(W, P)).toBeCloseTo(0.05 / 6, 6)
  })

  it('maxThreadsCPU = vCpu / (1 - ioBoundFraction)', () => {
    expect(maxThreadsCPU(P, 0.8)).toBeCloseTo(10, 6) // 2 / 0.2
  })

  it('maxThreadsMem accounts for OS base + thread stack (blocking)', () => {
    // (4096 - 512) / (32 + 1) = 3584 / 33 = 108.6 -> 108
    expect(maxThreadsMem(W, P)).toBe(108)
  })

  it('async model drops the thread-stack term from footprint', () => {
    const async = { ...P, blockingIoModel: false }
    // (4096 - 512) / 32 = 112
    expect(maxThreadsMem(W, async)).toBe(112)
  })

  it('hardThreadCap clamps to maxThreadsOverride when smaller', () => {
    expect(hardThreadCap(W, { ...P, maxThreadsOverride: 50 })).toBe(50)
    expect(hardThreadCap(W, P)).toBe(108) // no override -> memory-bound
  })

  it('cpuUtilization hits 1.0 at ~240 rps for this profile', () => {
    expect(cpuUtilization(240, W, P)).toBeCloseTo(1.0, 1)
    expect(cpuUtilization(120, W, P)).toBeCloseTo(0.5, 1)
  })

  it('nodeUtilization reports cpu-bound when rho exceeds mem util', () => {
    const r = nodeUtilization(240, 10, W, P) // 10 active threads of 108 cap = 0.09 mem util
    expect(r.bottleneck).toBe('cpu')
    expect(r.utilization).toBeCloseTo(1.0, 1)
  })

  it('currentRamMb grows with active requests', () => {
    expect(currentRamMb(0, W, P)).toBe(512)
    expect(currentRamMb(100, W, P)).toBe(512 + 100 * 33)
  })

  it('admission: admit under cap, drop at cap, crash on OOM', () => {
    expect(ec2AdmissionDecision(107, W, P)).toBe('admit')
    expect(ec2AdmissionDecision(108, W, P)).toBe('drop-503')  // at hard cap
    // Force OOM independent of cap via a tiny override that still leaves RAM exceedable:
    const oomP = { ...P, maxThreadsOverride: 100000 }
    // 200 active * 33MB + 512 = 7112MB > 4096MB -> OOM
    expect(ec2AdmissionDecision(200, W, oomP)).toBe('oom-crash')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/compute.test.ts`
Expected: FAIL — module `./compute` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/app/canvas/simulation/particleEngine/compute.ts
// Pure resource math for the EC2 compute model. No engine state, no side effects — every function
// is a deterministic transform of (workload, profile), so the whole model is unit-testable here
// and the rAF loop just calls in. See docs/superpowers/plans/2026-07-07-ec2-compute-resource-model.md.
import { COMPUTE_IPC, type ComputeProfile, type WorkloadDemand } from '../../../../lib/nodeConfig'

// Seconds of pure CPU time one request costs: (billion instr) / (billion instr/sec).
// baseClockGhz * IPC = billions of instructions retired per second.
export function cpuTimeSec(w: WorkloadDemand, p: ComputeProfile): number {
  const rate = Math.max(0.001, p.baseClockGhz * COMPUTE_IPC)
  return Math.max(0, w.cpuInstructionsBillions) / rate
}

// RAM held per in-flight request. Blocking model additionally pins a thread stack.
export function perRequestMemMb(w: WorkloadDemand, p: ComputeProfile): number {
  const stack = p.blockingIoModel ? (p.threadStackMb ?? 1) : 0
  return Math.max(0.001, w.memoryFootprintMb + stack)
}

// Soft saturation threshold: useful-concurrency per core given IO wait. NOT a hard cap — it maps
// to rho≈1 in the latency multiplier, where the hockey-stick begins. clamp io<0.99 for safety.
export function maxThreadsCPU(p: ComputeProfile, ioBoundFraction: number): number {
  const io = Math.min(0.99, Math.max(0, ioBoundFraction))
  return p.vCpu / (1 - io)
}

// Hard ceiling: how many concurrent request footprints fit before OOM.
export function maxThreadsMem(w: WorkloadDemand, p: ComputeProfile): number {
  const usableMb = p.ramGiB * 1024 - (p.osBaseMemoryMb ?? 512)
  return Math.max(0, Math.floor(usableMb / perRequestMemMb(w, p)))
}

// The real hard admission cap: memory-bound, optionally clamped by an explicit pool size.
export function hardThreadCap(w: WorkloadDemand, p: ComputeProfile): number {
  const mem = maxThreadsMem(w, p)
  return p.maxThreadsOverride !== undefined ? Math.min(p.maxThreadsOverride, mem) : mem
}

// CPU utilization rho: offered core-seconds per second / available cores.
export function cpuUtilization(inRps: number, w: WorkloadDemand, p: ComputeProfile): number {
  return (Math.max(0, inRps) * cpuTimeSec(w, p)) / Math.max(0.001, p.vCpu)
}

// Current resident memory given a logical in-flight request count.
export function currentRamMb(activeRequests: number, w: WorkloadDemand, p: ComputeProfile): number {
  return (p.osBaseMemoryMb ?? 512) + Math.max(0, activeRequests) * perRequestMemMb(w, p)
}

// Reported node utilization = the binding constraint (whichever is higher), plus which one it is.
// CPU util (rho) drives latency amplification; memory util drives hard drops/OOM.
export function nodeUtilization(
  inRps: number, activeRequests: number, w: WorkloadDemand, p: ComputeProfile,
): { utilization: number; bottleneck: 'cpu' | 'memory' } {
  const rho = cpuUtilization(inRps, w, p)
  const cap = hardThreadCap(w, p)
  const memUtil = cap > 0 ? activeRequests / cap : 1
  const bottleneck = rho >= memUtil ? 'cpu' : 'memory'
  return { utilization: Math.min(1, Math.max(rho, memUtil)), bottleneck }
}

// Wall-clock hold time for a request: the IO/base latency (from latencyModel, passed in) is the
// dominant term; CPU compute time adds on top. ioBoundFraction is intentionally NOT used to rebuild
// latency here (a fraction can't regenerate absolute IO time from near-zero CPU time) — it lives in
// maxThreadsCPU only. p/w kept in the signature so the release/hold path has one source of truth.
export function wallTimeMs(baseLatencyMs: number, w: WorkloadDemand, p: ComputeProfile): number {
  return Math.max(1, baseLatencyMs + cpuTimeSec(w, p) * 1000)
}

export type Ec2Admission = 'admit' | 'drop-503' | 'oom-crash'

// Admission decision for one arriving request, given current in-flight count. OOM (hard RAM breach)
// takes priority; otherwise reject at the hard thread cap; otherwise admit. CPU pressure never
// appears here — it is a latency effect, not a rejection.
export function ec2AdmissionDecision(
  activeRequests: number, w: WorkloadDemand, p: ComputeProfile,
): Ec2Admission {
  if (currentRamMb(activeRequests, w, p) > p.ramGiB * 1024) return 'oom-crash'
  if (activeRequests >= hardThreadCap(w, p)) return 'drop-503'
  return 'admit'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/compute.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/canvas/simulation/particleEngine/compute.ts src/app/canvas/simulation/particleEngine/compute.test.ts
git commit -m "feat(compute): pure resource-math module (cpu time, thread caps, OOM, admission)"
```

---

### Task 3: Defaults — EC2 gets a compute profile + workload

**Files:**
- Modify: `src/app/simulation/defaults.ts` (ec2 entry ~line 7; add exports at end)
- Test: `src/app/simulation/computeDefaults.test.ts`

**Interfaces:**
- Consumes: `ComputeProfile`, `WorkloadDemand` (Task 1); `hardThreadCap`, `cpuUtilization` (Task 2).
- Produces:
  - `DEFAULT_EC2_COMPUTE_PROFILE: ComputeProfile`
  - `DEFAULT_EC2_WORKLOAD: WorkloadDemand`
  - `NODE_SIM_DEFAULTS.ec2` now carries `computeProfile` + `workload` and **no** `maxThreads`.

- [ ] **Step 1: Write the failing test**

```ts
// src/app/simulation/computeDefaults.test.ts
import { describe, it, expect } from 'vitest'
import { NODE_SIM_DEFAULTS, DEFAULT_EC2_COMPUTE_PROFILE, DEFAULT_EC2_WORKLOAD } from './defaults'
import { hardThreadCap, cpuUtilization } from '../canvas/simulation/particleEngine/compute'

describe('ec2 compute defaults', () => {
  it('ec2 ships a compute profile + workload and no manual maxThreads', () => {
    const ec2 = NODE_SIM_DEFAULTS.ec2
    expect(ec2.computeProfile).toBeDefined()
    expect(ec2.workload).toBeDefined()
    expect(ec2.maxThreads).toBeUndefined()
  })

  it('default profile yields a sane, CPU-bound envelope', () => {
    const p = DEFAULT_EC2_COMPUTE_PROFILE
    const w = DEFAULT_EC2_WORKLOAD
    // memory allows far more concurrency than CPU saturates -> CPU-bound
    expect(hardThreadCap(w, p)).toBeGreaterThan(50)
    expect(cpuUtilization(240, w, p)).toBeCloseTo(1.0, 1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/simulation/computeDefaults.test.ts`
Expected: FAIL — `DEFAULT_EC2_COMPUTE_PROFILE` not exported; `ec2.maxThreads` still `100`.

- [ ] **Step 3: Write minimal implementation**

In `src/app/simulation/defaults.ts`, update the import (line 1) to include the new types:

```ts
import type { NodeType, NodeSimConfig, NodeSlo, ComputeProfile, WorkloadDemand } from '../../lib/nodeConfig'
```

Add these exports above `NODE_SIM_DEFAULTS` (after the import, ~line 2):

```ts
// EC2 v1 compute defaults. A modest 2 vCPU / 4 GiB x86 box running a blocking thread-per-request
// server. With moderate_logic workload this saturates CPU (~240 rps) long before RAM (~2600 rps),
// so a fresh EC2 reads as CPU-bound — upgrade vCPU for more headroom. See the compute model plan.
export const DEFAULT_EC2_COMPUTE_PROFILE: ComputeProfile = {
  vCpu: 2,
  ramGiB: 4,
  architecture: 'x86_64',
  cpuFamily: 'Intel Xeon (generic)',
  baseClockGhz: 3.0,
  blockingIoModel: true,
  osBaseMemoryMb: 512,
  threadStackMb: 1,
}

export const DEFAULT_EC2_WORKLOAD: WorkloadDemand = {
  tier: 'moderate_logic',
  cpuInstructionsBillions: 0.05,
  memoryFootprintMb: 32,
  ioBoundFraction: 0.8,
}
```

Replace the `ec2:` line (line 7) — drop `maxThreads: 100`, add the profile + workload:

```ts
  ec2:          { maxRps: 1000,  processingMs: 10,  errorRate: 0, latencyModel: { p50Ms: 20,  p99Ms: 250  }, circuitBreaker: { errorThreshold: 0.5, resetMs: 10000 }, timeoutMs: 30_000, retryConfig: { maxRetries: 3, baseDelayMs: 100,  jitter: 'full',  maxDelayMs: 2000 }, computeProfile: DEFAULT_EC2_COMPUTE_PROFILE, workload: DEFAULT_EC2_WORKLOAD },
```

> Note: `maxRps: 1000` stays only so the required field is satisfied; the engine will ignore it for EC2 (Task 5). `container` keeps its `maxThreads: 50` — do not touch it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/simulation/computeDefaults.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/simulation/defaults.ts src/app/simulation/computeDefaults.test.ts
git commit -m "feat(compute): EC2 default compute profile + workload, drop manual maxThreads"
```

---

### Task 4: Cost — `computeResource` registry CostKind

**Files:**
- Modify: `src/lib/cloudRegistry.ts` (CostKind union ~line 58; ec2 spec ~line 145-147)
- Modify: `src/lib/costModel.ts` (`nodeCost` switch ~line 78-111)
- Test: `src/lib/costModel.compute.test.ts`

**Interfaces:**
- Consumes: `ComputeProfile` (Task 1); `NodeMetrics`, `NODE_CONFIG`.
- Produces: `CostKind` gains `{ kind: 'computeResource'; label; vCpuUsdHr; ramGiBUsdHr; vCpuUsdHrArm; ramGiBUsdHrArm }`. `nodeCost` bills EC2 from its `computeProfile` when present.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/costModel.compute.test.ts
import { describe, it, expect } from 'vitest'
import type { Node } from '@xyflow/react'
import type { NodeData } from './nodeConfig'
import { computeCost } from './costModel'

function ec2(provider: 'aws', arch: 'x86_64' | 'arm64'): Node<NodeData> {
  return {
    id: 'n1', type: 'ec2', position: { x: 0, y: 0 },
    data: {
      label: 'web', subtitle: '', status: 'healthy', notes: '', warnings: [],
      provider,
      simConfig: {
        computeProfile: {
          vCpu: 4, ramGiB: 8, architecture: arch, cpuFamily: 'x', baseClockGhz: 3, blockingIoModel: true,
        },
      },
    },
  } as Node<NodeData>
}

describe('compute-resource cost', () => {
  it('bills vCPU + RAM hourly for an EC2 with a compute profile', () => {
    const summary = computeCost([ec2('aws', 'x86_64')], new Map())
    const node = summary.perNode.find(n => n.nodeId === 'n1')!
    expect(node.components.some(c => c.kind === 'computeResource')).toBe(true)
    // 4 vCPU * 0.010 + 8 GiB * 0.0012 = 0.0496 /hr * 730 = 36.208 /mo
    expect(node.monthlyUsd).toBeCloseTo((4 * 0.010 + 8 * 0.0012) * 730, 2)
  })

  it('arm64 is cheaper than x86 for the same shape', () => {
    const x86 = computeCost([ec2('aws', 'x86_64')], new Map()).totalMonthlyUsd
    const arm = computeCost([ec2('aws', 'arm64')], new Map()).totalMonthlyUsd
    expect(arm).toBeLessThan(x86)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/costModel.compute.test.ts`
Expected: FAIL — EC2 still bills `instanceHourly`; no `computeResource` component.

- [ ] **Step 3: Write minimal implementation**

In `src/lib/cloudRegistry.ts`, add to the `CostKind` union (after line 62, before the closing of the type):

```ts
  | { kind: 'computeResource'; label: string; vCpuUsdHr: number; ramGiBUsdHr: number; vCpuUsdHrArm: number; ramGiBUsdHrArm: number }
```

Replace the three `ec2` provider specs (lines 145-147) — swap `instanceHourly` for `computeResource`, keep `egress`:

```ts
    aws:   { serviceName: 'Amazon EC2',        simDefaults: { processingMs: 10 }, pricing: [{ kind: 'computeResource', label: 'Compute (vCPU+RAM)', vCpuUsdHr: 0.010, ramGiBUsdHr: 0.0012, vCpuUsdHrArm: 0.008, ramGiBUsdHrArm: 0.0010 }, { kind: 'egress', label: 'Egress' }] },
    gcp:   { serviceName: 'Compute Engine',     simDefaults: { processingMs: 10 }, pricing: [{ kind: 'computeResource', label: 'Compute (vCPU+RAM)', vCpuUsdHr: 0.0095, ramGiBUsdHr: 0.0013, vCpuUsdHrArm: 0.0076, ramGiBUsdHrArm: 0.0010 }, { kind: 'egress', label: 'Egress' }] },
    azure: { serviceName: 'Virtual Machines',   simDefaults: { processingMs: 10 }, pricing: [{ kind: 'computeResource', label: 'Compute (vCPU+RAM)', vCpuUsdHr: 0.010, ramGiBUsdHr: 0.0012, vCpuUsdHrArm: 0.008, ramGiBUsdHrArm: 0.0010 }, { kind: 'egress', label: 'Egress' }] },
```

In `src/lib/costModel.ts`, add a `case` to the `nodeCost` switch (inside `if (spec)`, alongside the other kinds, after the `fixedMonthly` case ~line 110):

```ts
        case 'computeResource': {
          // Physical compute pricing (EC2 v1): bill provisioned vCPU + RAM, picking the arch-specific
          // rate so arm64 lands cheaper as real registry data (not a magic discount factor). Respects
          // the replica multiplier like instanceHourly does.
          const profile = data.simConfig?.computeProfile
          if (!profile) break
          const isArm = profile.architecture === 'arm64'
          const vRate = isArm ? comp.vCpuUsdHrArm : comp.vCpuUsdHr
          const rRate = isArm ? comp.ramGiBUsdHrArm : comp.ramGiBUsdHr
          const monthly = (profile.vCpu * vRate + profile.ramGiB * rRate) * HOURS_PER_MONTH * replicaMultiplier
          components.push({ kind: comp.kind, label: comp.label, monthlyUsd: monthly })
          break
        }
```

> `REPLICATED_COST_KINDS` (line 51) does not include `computeResource`, so `replicaMultiplier` here is a no-op unless you later opt compute into replica scaling — matching the current instanceHourly-only behavior. Leave `REPLICATED_COST_KINDS` unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/costModel.compute.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/cloudRegistry.ts src/lib/costModel.ts src/lib/costModel.compute.test.ts
git commit -m "feat(compute): computeResource cost kind — bill EC2 by vCPU+RAM, arm cheaper"
```

---

### Task 5: Engine admission — EC2 gates on RAM/threads, not maxRps

**Files:**
- Modify: `src/app/canvas/simulation/particleEngine.ts` (target thread-pool gate ~line 1347-1350; maxRps drop ~line 1536; imports at top)
- Test: `src/app/canvas/simulation/particleEngine/compute.test.ts` (extend — the decision fn is already the tested boundary)

**Interfaces:**
- Consumes: `ec2AdmissionDecision`, `hardThreadCap` (Task 2); `NODE_SIM_DEFAULTS` merge via `effectiveConfig`.
- Produces: EC2 arrivals routed through `ec2AdmissionDecision`; `inRps/maxRps` drop skipped for EC2-with-profile; OOM crashes the node via existing `_nodeHealthStates` + self-healing.

- [ ] **Step 1: Write the failing test** (extend `compute.test.ts` with the resolver the engine will call)

Add to `src/app/canvas/simulation/particleEngine/compute.ts` a tiny resolver, and test it:

```ts
// append to compute.test.ts
import { resolveEc2Resources } from './compute'
import { DEFAULT_EC2_COMPUTE_PROFILE, DEFAULT_EC2_WORKLOAD } from '../../../simulation/defaults'

describe('resolveEc2Resources', () => {
  it('returns profile+workload for a config that has them', () => {
    const r = resolveEc2Resources({ maxRps: 1000, processingMs: 10, errorRate: 0, computeProfile: DEFAULT_EC2_COMPUTE_PROFILE, workload: DEFAULT_EC2_WORKLOAD })
    expect(r).not.toBeNull()
    expect(r!.profile.vCpu).toBe(2)
  })

  it('returns null when no compute profile is present (legacy nodes)', () => {
    expect(resolveEc2Resources({ maxRps: 1000, processingMs: 10, errorRate: 0 })).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/compute.test.ts`
Expected: FAIL — `resolveEc2Resources` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/app/canvas/simulation/particleEngine/compute.ts`:

```ts
import type { NodeSimConfig } from '../../../../lib/nodeConfig'

// Gate helper: an EC2 node participates in the compute model only when it carries both a hardware
// profile and a workload. Legacy files / non-EC2 configs return null and keep legacy behavior.
export function resolveEc2Resources(
  config: NodeSimConfig,
): { profile: ComputeProfile; workload: WorkloadDemand } | null {
  if (!config.computeProfile || !config.workload) return null
  return { profile: config.computeProfile, workload: config.workload }
}
```

Now wire it into `particleEngine.ts`. Add the import near the other `particleEngine/` imports at the top of the file:

```ts
import { ec2AdmissionDecision, resolveEc2Resources } from './particleEngine/compute'
```

Replace the target thread-pool admission gate (lines 1347-1350). Current code:

```ts
  if (isTargetThreadPoolCompute(targetNodeType)) {
    const maxThreads = computeMaxThreads(config)
    const activeThreads = (_lbActiveRequests.get(targetNodeId) ?? 0) * PARTICLE_REQUEST_RATIO
    if (activeThreads >= maxThreads) {
```

Replace the whole `if (activeThreads >= maxThreads) { ... }` block with a compute-aware branch. New code:

```ts
  if (isTargetThreadPoolCompute(targetNodeType)) {
    const activeThreads = (_lbActiveRequests.get(targetNodeId) ?? 0) * PARTICLE_REQUEST_RATIO
    const ec2res = targetNodeType === 'ec2' ? resolveEc2Resources(config) : null

    if (ec2res) {
      // EC2 compute model: memory-bound admission (hard cap) + OOM crash. CPU pressure is NOT a
      // drop here — it shows up as amplified latency in updateAllNodeMetrics.
      const decision = ec2AdmissionDecision(activeThreads, ec2res.workload, ec2res.profile)
      if (decision === 'oom-crash') {
        const label = ((_nodesMap.get(targetNodeId))?.data as NodeData)?.label ?? targetNodeId
        _nodeHealthStates.set(targetNodeId, 'down')
        _onEvent('crash_loop_detected', targetNodeId,
          `${label} out of memory — ${ec2res.profile.ramGiB} GiB exhausted, crashing`, 'critical',
          { utilization: 1, errorRate: 1 })
        scheduleNodeRestart(targetNodeId, config)   // reuse existing self-healing (see helper below)
        dropParticle(ep, targetNodeId, particle)
        recordBreakerResultLocal(ep.id, true, config, now)
        return
      }
      if (decision === 'drop-503') {
        const label = ((_nodesMap.get(targetNodeId))?.data as NodeData)?.label ?? targetNodeId
        _onEvent('connection_pool_exhausted', targetNodeId,
          `${label} thread pool full (RAM-bound) — dropping`, 'critical', { utilization: 1, errorRate: 1 })
        dropParticle(ep, targetNodeId, particle)
        recordBreakerResultLocal(ep.id, true, config, now)
        return
      }
      // 'admit' falls through to normal processing below.
    } else {
      // Legacy path: fixed maxThreads pool (container, or EC2 files without a profile).
      const maxThreads = computeMaxThreads(config)
      if (activeThreads >= maxThreads) {
        const label = ((_nodesMap.get(targetNodeId))?.data as NodeData)?.label ?? targetNodeId
        _onEvent('connection_pool_exhausted', targetNodeId,
          `${label} thread pool full (${activeThreads}/${maxThreads}) — dropping`, 'critical',
          { utilization: 1, errorRate: 1 })
        dropParticle(ep, targetNodeId, particle)
        recordBreakerResultLocal(ep.id, true, config, now)
        return
      }
    }
  }
```

> **Verify against the real lines 1347-1360 before editing** — the exact event type/label text in the legacy branch must match what is there today (copy it verbatim; the snippet above reconstructs it). Only the EC2-with-profile branch is new.

Add a small self-healing helper near `computeMaxThreads` (~line 696). Model it on the existing self-healing usage — if a `scheduleNodeRestart`-equivalent already exists in `particleEngine/` submodules, call that instead; otherwise:

```ts
// Restore a crashed node to 'healthy' after its configured restart delay (default 5s). Mirrors the
// existing selfHealing config; OOM reuses this rather than inventing a new reboot cycle.
function scheduleNodeRestart(nodeId: string, config: NodeSimConfig): void {
  const delay = config.selfHealing?.restartDelayMs ?? 5000
  scheduleGenericRelease(nodeId, delay, _simulatedTimeMs, () => {
    if (_nodeHealthStates.get(nodeId) === 'down') _nodeHealthStates.set(nodeId, 'healthy')
  })
}
```

Finally, skip the `inRps/maxRps` drop for EC2-with-profile. At the "Other non-queue nodes: drop if at capacity" gate (line 1535-1540), change the guard:

```ts
    // Other non-queue nodes: drop if at capacity — EXCEPT EC2 running the compute model, whose
    // admission is handled by the RAM/thread gate above (maxRps is meaningless for it).
    const ec2ComputeGated = targetNodeType === 'ec2' && resolveEc2Resources(config) !== null
    if (!ec2ComputeGated && utilization >= 1.0 + config.errorRate) {
      dropParticle(ep, targetNodeId, particle)
      recordBreakerResultLocal(ep.id, true, config, now)
      return
    }
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/compute.test.ts`
Expected: PASS (11 tests).
Run: `npm run build`
Expected: type-check passes, no errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/canvas/simulation/particleEngine.ts src/app/canvas/simulation/particleEngine/compute.ts src/app/canvas/simulation/particleEngine/compute.test.ts
git commit -m "feat(compute): EC2 admission via RAM/thread cap + OOM crash, drop maxRps gate"
```

---

### Task 6: Engine metrics — CPU-ρ utilization, bottleneck label, derived hold time

**Files:**
- Modify: `src/app/store/simulation.store.ts` (`NodeMetrics` ~line 28 — add field)
- Modify: `src/app/canvas/simulation/particleEngine.ts` (utilization branch ~line 1837-1840; hold time in `trackRequest` ~line 720; metrics emit ~line 2120)
- Test: covered by `compute.test.ts` (`nodeUtilization`, `wallTimeMs`) — no new engine test harness.

**Interfaces:**
- Consumes: `nodeUtilization`, `wallTimeMs`, `resolveEc2Resources` (Task 2/5).
- Produces: `NodeMetrics.bottleneckResource?: 'cpu' | 'memory'`; EC2 utilization = ρ/mem binding constraint; EC2 thread hold time = `wallTimeMs`.

- [ ] **Step 1: Add the metrics field (type-first)**

In `src/app/store/simulation.store.ts`, add to `NodeMetrics` (after line 28, `egressBytesPerSec`):

```ts
  bottleneckResource?: 'cpu' | 'memory'          // EC2 compute model: which limit is binding
```

- [ ] **Step 2: Wire utilization + bottleneck for EC2**

In `particleEngine.ts`, replace the `isTargetThreadPoolCompute` utilization branch (lines 1837-1840):

```ts
    } else if (isTargetThreadPoolCompute(nodeType)) {
      const activeThreads = (_lbActiveRequests.get(nodeId) ?? 0) * PARTICLE_REQUEST_RATIO
      const ec2res = nodeType === 'ec2' ? resolveEc2Resources(config) : null
      if (ec2res) {
        const u = nodeUtilization(inRps, activeThreads, ec2res.workload, ec2res.profile)
        utilization = u.utilization
        _bottleneckResource.set(nodeId, u.bottleneck)
      } else {
        const maxThreads = computeMaxThreads(config)
        utilization = Math.min(1, activeThreads / maxThreads)
      }
    } else {
```

Add the import symbol to the existing compute import and declare the tracking map near the other `Map` state (e.g. by `_dbSaturationReason`):

```ts
import { ec2AdmissionDecision, resolveEc2Resources, nodeUtilization, wallTimeMs } from './particleEngine/compute'
// ...
const _bottleneckResource = new Map<string, 'cpu' | 'memory'>()
```

Emit it in `rawMetrics` (after `egressBytesPerSec`, ~line 2137):

```ts
      ...(_bottleneckResource.get(nodeId) !== undefined && { bottleneckResource: _bottleneckResource.get(nodeId) }),
```

Clear it in the two reset sites that clear `_lbActiveRequests` (~line 2766 and ~line 2804):

```ts
  _bottleneckResource.clear()
```

- [ ] **Step 3: Derive EC2 thread hold time from wall time**

The EC2 thread is held for the request's wall time (base latency + CPU), so pool occupancy reflects real compute — not the static `processingMs`. In `trackRequest` (line 717-723), branch the release delay for EC2-with-profile:

```ts
function trackRequest(nodeId: string, nodeType: NodeType, config: NodeSimConfig) {
  if (_LB_SKIP_TYPES.has(nodeType) || GROUPING_TYPES.has(nodeType)) return
  _lbActiveRequests.set(nodeId, (_lbActiveRequests.get(nodeId) ?? 0) + 1)
  const ec2res = nodeType === 'ec2' ? resolveEc2Resources(config) : null
  const baseMs = effectiveProcessingMs(nodeId, config)
  const holdMs = ec2res
    ? wallTimeMs(config.latencyModel?.p50Ms ?? baseMs, ec2res.workload, ec2res.profile)
    : Math.max(50, baseMs)
  scheduleGenericRelease(nodeId, Math.max(50, holdMs), _simulatedTimeMs, () => {
    _lbActiveRequests.set(nodeId, Math.max(0, (_lbActiveRequests.get(nodeId) ?? 1) - 1))
  })
}
```

> The existing latency-amplification at line 2061 already multiplies percentiles by `saturationLatencyMultiplier(rawUtilization)`. Because EC2's `rawUtilization` is now CPU ρ (Step 2), CPU saturation automatically produces the hockey-stick latency curve — no extra code needed. Verify no double-amplification: `wallTimeMs` sets the *base* hold/latency; the multiplier scales the *reported* percentile. These are distinct and correct.

- [ ] **Step 4: Typecheck + regression**

Run: `npm run build`
Expected: passes.
Run: `npx vitest run src/app/canvas/simulation/particleEngine`
Expected: all existing engine tests (effectiveRps, outboundBacklogDrain, readWriteLane, backpressure, circuitBreakers) still PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/store/simulation.store.ts src/app/canvas/simulation/particleEngine.ts
git commit -m "feat(compute): EC2 utilization from CPU rho + memory, bottleneck label, wall-time hold"
```

---

### Task 7: UI — EC2 compute config in SimConfigPanel

**Files:**
- Modify: `src/app/simulation/SimConfigPanel.tsx` (Capacity block ~line 340-443; live-stats ~line 832-906)
- Test: manual (UI) — verified via `npm run tauri dev` in the execution handoff.

**Interfaces:**
- Consumes: `ComputeProfile`, `WorkloadDemand`, `WORKLOAD_TIER_RANGES`, `resolveWorkloadInstructions` (Task 1); `DEFAULT_EC2_COMPUTE_PROFILE`, `DEFAULT_EC2_WORKLOAD` (Task 3); `hardThreadCap` (Task 2).
- Produces: an "Compute" config section for EC2 (vCPU, RAM, architecture, clock, blocking model, workload tier + instructions, memory footprint, IO-bound %), writing to `simConfig.computeProfile` / `simConfig.workload`. Max RPS and Max Threads hidden for EC2.

- [ ] **Step 1: Hide Max RPS + Max Threads for EC2**

In `SimConfigPanel.tsx`, add an `isEc2Compute` flag near the other type flags (~line 325):

```ts
  const isEc2Compute = nodeType === 'ec2'
```

Guard the Max RPS field (line 344) so EC2 doesn't show it:

```tsx
          {!isDb && !isEc2Compute && (
```

Guard the Max Threads field (line 432) — EC2 derives it, so only `container` keeps the manual stepper:

```tsx
          {isThreadPoolCompute && !isEc2Compute && (
```

- [ ] **Step 2: Add the EC2 Compute block**

Immediately after the Capacity `configBlock` closes (after line 444, before the SLO block at line 446), add:

```tsx
      {isEc2Compute && (() => {
        const profile = { ...DEFAULT_EC2_COMPUTE_PROFILE, ...(eff.computeProfile ?? {}) }
        const workload = { ...DEFAULT_EC2_WORKLOAD, ...(eff.workload ?? {}) }
        const setProfile = (patch: Partial<typeof profile>) =>
          setNodeConfig(nodeId, { computeProfile: { ...profile, ...patch } })
        const setWorkload = (patch: Partial<typeof workload>) =>
          setNodeConfig(nodeId, { workload: { ...workload, ...patch } })
        const derivedThreads = hardThreadCap(workload, profile)
        return (
          <div className={styles.configBlock}>
            <div className={styles.configBlockTitle}>Compute (vCPU / RAM)</div>
            <div className={styles.configGrid}>
              <div className={styles.configField}>
                <span className={styles.configLabel}>vCPU</span>
                <NumericStepper value={profile.vCpu} onChange={v => setProfile({ vCpu: v })} min={1} step={1} />
              </div>
              <div className={styles.configField}>
                <span className={styles.configLabel}>RAM (GiB)</span>
                <NumericStepper value={profile.ramGiB} onChange={v => setProfile({ ramGiB: v })} min={1} step={1} />
              </div>
              <div className={styles.configField}>
                <span className={styles.configLabel}>Clock (GHz)</span>
                <NumericStepper value={profile.baseClockGhz} onChange={v => setProfile({ baseClockGhz: v })} min={1} step={0.1} />
              </div>
              <div className={styles.configField}>
                <span className={styles.configLabel}>Architecture</span>
                <select
                  value={profile.architecture}
                  onChange={e => setProfile({ architecture: e.target.value as 'x86_64' | 'arm64' })}
                  style={{ background: 'var(--color-canvas)', color: 'var(--color-text-primary)', border: '1px solid var(--color-node-border)', borderRadius: 4, padding: '2px 6px', fontSize: 11, fontFamily: 'inherit', cursor: 'pointer', width: '100%' }}
                >
                  <option value="x86_64">x86_64</option>
                  <option value="arm64">arm64 (cheaper)</option>
                </select>
              </div>
              <div className={styles.configField}>
                <span className={styles.configLabel}>IO Model</span>
                <select
                  value={profile.blockingIoModel ? 'blocking' : 'async'}
                  onChange={e => setProfile({ blockingIoModel: e.target.value === 'blocking' })}
                  style={{ background: 'var(--color-canvas)', color: 'var(--color-text-primary)', border: '1px solid var(--color-node-border)', borderRadius: 4, padding: '2px 6px', fontSize: 11, fontFamily: 'inherit', cursor: 'pointer', width: '100%' }}
                >
                  <option value="blocking">Blocking (thread/req)</option>
                  <option value="async">Async (event loop)</option>
                </select>
              </div>
              <div className={styles.configField}>
                <span className={styles.configLabel}>Derived Threads</span>
                <span className={styles.liveStatVal}>{derivedThreads}</span>
              </div>
            </div>
            <div className={styles.configBlockTitle} style={{ marginTop: 8 }}>Workload</div>
            <div className={styles.configGrid}>
              <div className={styles.configField}>
                <span className={styles.configLabel}>Tier</span>
                <select
                  value={workload.tier}
                  onChange={e => {
                    const tier = e.target.value as typeof workload.tier
                    const next = tier === 'custom'
                      ? workload.cpuInstructionsBillions
                      : WORKLOAD_TIER_RANGES[tier].default
                    setWorkload({ tier, cpuInstructionsBillions: resolveWorkloadInstructions(tier, next) })
                  }}
                  style={{ background: 'var(--color-canvas)', color: 'var(--color-text-primary)', border: '1px solid var(--color-node-border)', borderRadius: 4, padding: '2px 6px', fontSize: 11, fontFamily: 'inherit', cursor: 'pointer', width: '100%' }}
                >
                  <option value="simple_crud">Simple CRUD</option>
                  <option value="moderate_logic">Moderate Logic</option>
                  <option value="heavy_compute">Heavy Compute</option>
                  <option value="custom">Custom</option>
                </select>
              </div>
              <div className={styles.configField}>
                <span className={styles.configLabel}>Instr (billions)</span>
                <NumericStepper
                  value={workload.cpuInstructionsBillions}
                  onChange={v => setWorkload({ cpuInstructionsBillions: resolveWorkloadInstructions(workload.tier, v) })}
                  min={0}
                  step={workload.tier === 'heavy_compute' || workload.tier === 'custom' ? 0.1 : 0.001}
                />
              </div>
              <div className={styles.configField}>
                <span className={styles.configLabel}>Mem/req (MB)</span>
                <NumericStepper value={workload.memoryFootprintMb} onChange={v => setWorkload({ memoryFootprintMb: v })} min={1} step={4} />
              </div>
              <div className={styles.configField}>
                <span className={styles.configLabel}>IO-bound (%)</span>
                <NumericStepper
                  value={Math.round(workload.ioBoundFraction * 100)}
                  onChange={v => setWorkload({ ioBoundFraction: Math.min(0.99, Math.max(0, v / 100)) })}
                  min={0}
                  max={99}
                  step={5}
                />
              </div>
            </div>
          </div>
        )
      })()}
```

- [ ] **Step 3: Add imports**

At the top of `SimConfigPanel.tsx`, extend the `nodeConfig`/`defaults`/`compute` imports:

```ts
import { WORKLOAD_TIER_RANGES, resolveWorkloadInstructions } from '../../lib/nodeConfig'
import { DEFAULT_EC2_COMPUTE_PROFILE, DEFAULT_EC2_WORKLOAD } from './defaults'
import { hardThreadCap } from '../canvas/simulation/particleEngine/compute'
```

> Confirm `NumericStepper` renders float values (`step={0.1}`/`0.001`). If it coerces to int, add a `float` prop or use a plain `<input type="number">` styled like the selects above for the Clock and Instr fields.

- [ ] **Step 4: Update live-stats "Threads" readout for EC2**

At the Threads live-stat (line 832-906), make `effMaxThreads` compute the derived cap for EC2:

```ts
  const effMaxThreads = nodeType === 'ec2'
    ? hardThreadCap(
        { ...DEFAULT_EC2_WORKLOAD, ...(nodeConfigs.get(nodeId)?.workload ?? {}) },
        { ...DEFAULT_EC2_COMPUTE_PROFILE, ...(nodeConfigs.get(nodeId)?.computeProfile ?? {}) },
      )
    : nodeType
      ? (nodeConfigs.get(nodeId)?.maxThreads ?? NODE_SIM_DEFAULTS[nodeType]?.maxThreads ?? 50)
      : 50
```

- [ ] **Step 5: Typecheck, then verify in-app**

Run: `npm run build`
Expected: passes.
Then run `npm run tauri dev`, drop an EC2 node, open its config: Max RPS/Max Threads are gone; the Compute + Workload sections appear; changing vCPU updates "Derived Threads"; run the sim and confirm the node reports utilization and (under load) a `bottleneckResource`.

- [ ] **Step 6: Commit**

```bash
git add src/app/simulation/SimConfigPanel.tsx
git commit -m "feat(compute): EC2 compute+workload config UI, hide maxRps/maxThreads for EC2"
```

---

### Task 8: Docs — update module boundaries

**Files:**
- Modify: `docs/module-boundaries.md`

- [ ] **Step 1: Document the new module + coupling**

Add a section describing:
- New low-risk leaf module `src/app/canvas/simulation/particleEngine/compute.ts` (pure, fully tested, no engine state) — safe to modify in parallel.
- `nodeConfig.ts` gained `ComputeProfile`/`WorkloadDemand` (hub file — coordinate).
- EC2-only behavior gate: `resolveEc2Resources(config) !== null`; legacy/other node types unchanged.
- `maxRps` retained in the type; EC2 no longer gates on it (engine `handleParticleArrival` + `updateAllNodeMetrics`).
- New `computeResource` CostKind in `cloudRegistry.ts` consumed by `costModel.ts`.
- `NodeMetrics.bottleneckResource` added (consumed by future UI).
- Follow-up (not in this plan): per-`PacketTemplate` `WorkloadDemand` + weighted-average node workload; extend model to `container`/`pod`/`lambda`.

- [ ] **Step 2: Commit**

```bash
git add docs/module-boundaries.md
git commit -m "docs: module boundaries for EC2 compute resource model"
```

---

## Self-Review

**Spec coverage:**
- §1 Schema (ComputeProfile, WorkloadDemand, tiers) → Task 1 ✓
- §1 tier presets + custom escape hatch → Task 1 (`resolveWorkloadInstructions`) + Task 7 UI ✓
- §2 CPU time formula (instructions / clock·IPC) → Task 2 `cpuTimeSec` ✓
- §2 OOM (RAM > ramGiB·1024 → crash + self-heal) → Task 2 `ec2AdmissionDecision` + Task 5 `scheduleNodeRestart` ✓
- §3 CPU saturation (ρ, hockey-stick latency) → Task 2 `cpuUtilization` + Task 6 (feeds existing `saturationLatencyMultiplier`) ✓
- §3 arch scale factor → **deferred** (Global Constraints: cost-only in v1) — documented, not dropped ✓
- §4 cost by vCPU/RAM + ARM discount → Task 4 `computeResource` CostKind ✓
- Refined thread model (maxThreadsCPU soft / maxThreadsMem hard, blocking vs async) → Task 2 ✓
- Milestone "replace RPS gate" → Task 5 ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/vague steps. Two explicit *verify-before-edit* notes (Task 5 legacy branch text; Task 7 NumericStepper float support) are deliberate — the surrounding code must be matched verbatim, and the snippets reconstruct it.

**Type consistency:** `resolveEc2Resources` returns `{ profile, workload }`, consumed identically in Tasks 5/6/7. `hardThreadCap(w, p)` / `nodeUtilization(inRps, activeRequests, w, p)` / `wallTimeMs(base, w, p)` signatures match across module + call sites. `computeResource` CostKind fields (`vCpuUsdHr`/`ramGiBUsdHr`/`vCpuUsdHrArm`/`ramGiBUsdHrArm`) match between registry data (Task 4 Step 3) and the `nodeCost` case. `bottleneckResource: 'cpu'|'memory'` matches between `NodeMetrics` (Task 6) and `nodeUtilization` return (Task 2).

**Known open items (intentional, noted in Task 8):** per-template workload + weighted averaging deferred; `container`/`pod`/`lambda` unchanged in v1.
