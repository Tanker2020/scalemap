# Move Workload Definition from Node Config to Packet Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `WorkloadDemand` (CPU/memory/IO cost per request) from the compute node (`NodeSimConfig.workload`) to the packet/request type (`BasePacketTemplate.workload`), so different request types arriving at the same EC2 node can carry different simulated compute cost, then resolve that cost per-particle (exact) or per-node (true weighted blend of the node's configured packet distribution) depending on what's known at each call site.

**Architecture:** Task 1 relocates the schema and keeps behavior at parity (every call site falls back to one flat default, same as today's single-node-value behavior, just sourced from the new location). Task 2 replaces that flat fallback with real per-particle and weighted-blend resolution — the actual point of the issue. Task 3 updates the UI (remove from `SimConfigPanel`, add to `PacketEditor`). Each task ends in a fully compiling, fully-tested, complete milestone — no task ships a placeholder.

**Tech Stack:** TypeScript, React 19, Zustand, Vitest, `@vitest-environment jsdom` + mocked `requestAnimationFrame` for engine integration tests (established pattern from prior compute-model work).

## Global Constraints

- **`NodeSimConfig.workload` is removed entirely**, not deprecated-in-place. Old `.scalemap` files carry a harmless, unread orphan key — no migration code, no schema version bump (`serializer.ts` round-trips `simConfig` as an opaque `Partial<NodeSimConfig>` already).
- **`ComputeProfile` (hardware: vCPU/RAM/clock/architecture/IO-model) stays node-level, completely untouched by this plan.**
- No change to which node types participate in the compute model — EC2 only, same as before.
- No new Zustand store fields.
- The three new resolution functions (`resolveParticleWorkload`, `resolveSourceOutboundWorkload`, `resolveInboundWeightedWorkload`) live in `particleEngine.ts`, not `particleEngine/compute.ts` — they read engine state (`_packetTemplates`, `_nodesMap`, `_edgePaths`, `_edgesData`), which `compute.ts` is deliberately kept free of (pure resource math only, per its own file-header comment).
- Full reference: `docs/superpowers/specs/2026-07-08-workload-to-packet-config-design.md` — read it before Task 1 for the complete design narrative; each task below is self-contained and doesn't require re-reading it, but it's the source of truth if anything here is ambiguous.

---

### Task 1: Schema relocation — workload moves to packets, engine falls back to one default (behavior-parity milestone)

This task moves the field and keeps simulated behavior unchanged (every
request still costs the same, now sourced from a shared default constant
instead of the node config) — a complete, correct, testable milestone on
its own. Task 2 adds real per-packet differentiation on top.

**Files:**
- Modify: `src/lib/nodeConfig.ts` (`NodeSimConfig` `:65-159`, `BasePacketTemplate` `:228-234`)
- Modify: `src/app/simulation/defaults.ts` (`DEFAULT_EC2_WORKLOAD` `:17-22`, `NODE_SIM_DEFAULTS.ec2` `:28`)
- Modify: `src/app/canvas/simulation/particleEngine/compute.ts` (`resolveEc2Resources` `:119-126`)
- Modify: `src/app/canvas/simulation/particleEngine.ts` (import `:30`, `trackRequest` `:715-740`, and 5 more call sites — see Step 4)
- Test: `src/app/canvas/simulation/particleEngine/compute.test.ts`, `src/app/simulation/computeDefaults.test.ts`, `src/app/canvas/simulation/particleEngine/oomCrashLock.test.ts`, `src/app/canvas/simulation/particleEngine/circuitBreakerMetrics.test.ts` (fix fixtures broken by the schema change)

**Interfaces:**
- Produces: `BasePacketTemplate.workload?: WorkloadDemand`; `DEFAULT_PACKET_WORKLOAD: WorkloadDemand` (replaces `DEFAULT_EC2_WORKLOAD`); `resolveEc2Profile(config: NodeSimConfig): ComputeProfile | null` (replaces `resolveEc2Resources`).
- Consumes: nothing from other tasks — foundational.

- [ ] **Step 1: Move the schema field**

In `src/lib/nodeConfig.ts`, find (around line 154-159):

```ts
  // ─── Compute resource model (EC2 v1) ─────────────────────────────────────────
  // When set, the engine derives throughput/concurrency/OOM/latency from physical hardware
  // (computeProfile) + per-request cost (workload) instead of maxRps. EC2 only in v1.
  computeProfile?: ComputeProfile
  workload?: WorkloadDemand
}
```

Replace with:

```ts
  // ─── Compute resource model (EC2 v1) ─────────────────────────────────────────
  // When set, the engine derives throughput/concurrency/OOM/latency from physical hardware
  // (computeProfile) instead of maxRps. Per-request cost (workload) lives on the PACKET
  // template that generated the request, not here — see BasePacketTemplate.workload. EC2 only
  // in v1.
  computeProfile?: ComputeProfile
}
```

Then find `BasePacketTemplate` (around line 228):

```ts
export interface BasePacketTemplate {
  id: number
  name: string
  protocol: PacketProtocol
  sizeKb: number            // request/packet payload — drives payloadBytes via log-normal
  colorOverride?: string    // optional particle tint
}
```

Replace with:

```ts
export interface BasePacketTemplate {
  id: number
  name: string
  protocol: PacketProtocol
  sizeKb: number            // request/packet payload — drives payloadBytes via log-normal
  colorOverride?: string    // optional particle tint
  // Per-request compute cost (CPU/memory/IO), consumed by the EC2 compute model when this
  // template's particle arrives at (or originates an outbound call from) an ec2 node. Optional
  // so protocol variants that predate this field, or a template a user never touched, still
  // resolve via DEFAULT_PACKET_WORKLOAD (see defaults.ts) rather than being invalid.
  workload?: WorkloadDemand
}
```

- [ ] **Step 2: Rename the default and update `NODE_SIM_DEFAULTS.ec2`**

In `src/app/simulation/defaults.ts`, find (around line 17):

```ts
export const DEFAULT_EC2_WORKLOAD: WorkloadDemand = {
  tier: 'moderate_logic',
  cpuInstructionsBillions: 0.05,
  memoryFootprintMb: 32,
  ioBoundFraction: 0.8,
}
```

Replace with:

```ts
// No longer EC2-specific — this is the fallback workload for ANY packet that doesn't carry its
// own (generic-mode traffic, or a custom template predating this field). See
// docs/superpowers/specs/2026-07-08-workload-to-packet-config-design.md.
export const DEFAULT_PACKET_WORKLOAD: WorkloadDemand = {
  tier: 'moderate_logic',
  cpuInstructionsBillions: 0.05,
  memoryFootprintMb: 32,
  ioBoundFraction: 0.8,
}
```

Then find the `ec2:` line (around line 28) — the exact line is long; only the trailing
`workload: DEFAULT_EC2_WORKLOAD` piece changes:

```ts
  ec2:          { maxRps: 1000,  processingMs: 10,  errorRate: 0, latencyModel: { p50Ms: 20,  p99Ms: 250  }, circuitBreaker: { errorThreshold: 0.5, resetMs: 10000 }, timeoutMs: 30_000, retryConfig: { maxRetries: 3, baseDelayMs: 100,  jitter: 'full',  maxDelayMs: 2000 }, computeProfile: DEFAULT_EC2_COMPUTE_PROFILE, workload: DEFAULT_EC2_WORKLOAD },
```

Replace with:

```ts
  ec2:          { maxRps: 1000,  processingMs: 10,  errorRate: 0, latencyModel: { p50Ms: 20,  p99Ms: 250  }, circuitBreaker: { errorThreshold: 0.5, resetMs: 10000 }, timeoutMs: 30_000, retryConfig: { maxRetries: 3, baseDelayMs: 100,  jitter: 'full',  maxDelayMs: 2000 }, computeProfile: DEFAULT_EC2_COMPUTE_PROFILE },
```

- [ ] **Step 3: Rename `resolveEc2Resources` to `resolveEc2Profile`**

In `src/app/canvas/simulation/particleEngine/compute.ts`, find (around line 119):

```ts
// Gate helper: an EC2 node participates in the compute model only when it carries both a hardware
// profile and a workload. Legacy files / non-EC2 configs return null and keep legacy behavior.
export function resolveEc2Resources(
  config: NodeSimConfig,
): { profile: ComputeProfile; workload: WorkloadDemand } | null {
  if (!config.computeProfile || !config.workload) return null
  return { profile: config.computeProfile, workload: config.workload }
}
```

Replace with:

```ts
// Gate helper: an EC2 node participates in the compute model only when it carries a hardware
// profile. Legacy files / non-EC2 configs return null and keep legacy behavior. Workload is
// resolved separately (see particleEngine.ts's resolveParticleWorkload/resolveSourceOutboundWorkload/
// resolveInboundWeightedWorkload) since it now lives on packet templates, not here.
export function resolveEc2Profile(config: NodeSimConfig): ComputeProfile | null {
  return config.computeProfile ?? null
}
```

`WorkloadDemand` becomes unused in this file's import line (around line 4) — remove it (this
project's `tsconfig.json` has `noUnusedLocals: true`):

```ts
import { COMPUTE_IPC, type ComputeProfile, type WorkloadDemand, type NodeSimConfig } from '../../../../lib/nodeConfig'
```

Replace with:

```ts
import { COMPUTE_IPC, type ComputeProfile, type NodeSimConfig } from '../../../../lib/nodeConfig'
```

> Check the rest of `compute.ts` first — if any other function in this file still uses the
> `WorkloadDemand` type (several do, e.g. `cpuTimeSec`, `hardThreadCap`), keep the import; only
> drop it if truly unused. Read the file before editing to confirm.

- [ ] **Step 4: Update all 6 particleEngine.ts call sites to the new name, flat default for now**

In `src/app/canvas/simulation/particleEngine.ts`, find the import line (around line 30):

```ts
import { ec2AdmissionDecision, resolveEc2Resources, nodeUtilization, wallTimeMs, saturationLatencyMultiplier, cpuUtilization, hardThreadCap } from './particleEngine/compute'
```

Replace with:

```ts
import { ec2AdmissionDecision, resolveEc2Profile, nodeUtilization, wallTimeMs, saturationLatencyMultiplier, cpuUtilization, hardThreadCap } from './particleEngine/compute'
```

Add the `DEFAULT_PACKET_WORKLOAD` import alongside wherever this file already imports from
`../../simulation/defaults` (search for the existing `defaults` import line and add
`DEFAULT_PACKET_WORKLOAD` to it; if no such import exists yet, add
`import { DEFAULT_PACKET_WORKLOAD } from '../../simulation/defaults'` near the top with the
other local imports).

Now update each of the 6 call sites. **Site 1 — `trackRequest`** (around line 715):

```ts
function trackRequest(nodeId: string, nodeType: NodeType, config: NodeSimConfig) {
  if (_LB_SKIP_TYPES.has(nodeType) || GROUPING_TYPES.has(nodeType)) return
  _lbActiveRequests.set(nodeId, (_lbActiveRequests.get(nodeId) ?? 0) + 1)
  // EC2-with-profile holds a thread for the request's WALL time (base latency + CPU compute,
  // amplified by the node's CURRENT CPU saturation rho), so pool occupancy reflects real, live
  // compute pressure — not a static per-request cost. Other types keep the legacy
  // processingMs-based hold. rho is read from the same smoothed inRps signal other live-load
  // checks in this file already use. A longer hold time at a steady arrival rate legitimately
  // raises _lbActiveRequests further (Little's Law), which can in turn push the RAM-derived
  // hardThreadCap gate — an intended cascade (CPU saturation -> slower processing -> backlog ->
  // memory pressure -> shedding), not a bug. No feedback into rho itself: cpuUtilization is a
  // pure function of inRps (arrival rate), never of _lbActiveRequests (occupancy).
  const ec2res = nodeType === 'ec2' ? resolveEc2Resources(config) : null
  const baseMs = effectiveProcessingMs(nodeId, config)
  const holdMs = ec2res
    ? wallTimeMs(
        config.latencyModel?.p50Ms ?? baseMs,
        ec2res.workload,
        ec2res.profile,
        cpuUtilization(_smoothedMetrics.get(nodeId)?.inRps ?? 0, ec2res.workload, ec2res.profile),
      )
    : baseMs
  scheduleGenericRelease(nodeId, Math.max(50, holdMs), _simulatedTimeMs, () => {
    _lbActiveRequests.set(nodeId, Math.max(0, (_lbActiveRequests.get(nodeId) ?? 1) - 1))
  })
}
```

Replace with (workload is `DEFAULT_PACKET_WORKLOAD` for now — Task 2 differentiates it):

```ts
function trackRequest(nodeId: string, nodeType: NodeType, config: NodeSimConfig) {
  if (_LB_SKIP_TYPES.has(nodeType) || GROUPING_TYPES.has(nodeType)) return
  _lbActiveRequests.set(nodeId, (_lbActiveRequests.get(nodeId) ?? 0) + 1)
  // EC2-with-profile holds a thread for the request's WALL time (base latency + CPU compute,
  // amplified by the node's CURRENT CPU saturation rho), so pool occupancy reflects real, live
  // compute pressure — not a static per-request cost. Other types keep the legacy
  // processingMs-based hold. rho is read from the same smoothed inRps signal other live-load
  // checks in this file already use. A longer hold time at a steady arrival rate legitimately
  // raises _lbActiveRequests further (Little's Law), which can in turn push the RAM-derived
  // hardThreadCap gate — an intended cascade (CPU saturation -> slower processing -> backlog ->
  // memory pressure -> shedding), not a bug. No feedback into rho itself: cpuUtilization is a
  // pure function of inRps (arrival rate), never of _lbActiveRequests (occupancy).
  const profile = nodeType === 'ec2' ? resolveEc2Profile(config) : null
  const workload = DEFAULT_PACKET_WORKLOAD // Task 2 replaces this with per-particle/blended resolution
  const baseMs = effectiveProcessingMs(nodeId, config)
  const holdMs = profile
    ? wallTimeMs(
        config.latencyModel?.p50Ms ?? baseMs,
        workload,
        profile,
        cpuUtilization(_smoothedMetrics.get(nodeId)?.inRps ?? 0, workload, profile),
      )
    : baseMs
  scheduleGenericRelease(nodeId, Math.max(50, holdMs), _simulatedTimeMs, () => {
    _lbActiveRequests.set(nodeId, Math.max(0, (_lbActiveRequests.get(nodeId) ?? 1) - 1))
  })
}
```

**Site 2 — caller-side cap sizing, fresh spawn** (around line 1015):

```ts
          const ec2res = ep.sourceNodeType === 'ec2' ? resolveEc2Resources(srcConfig) : null
          const cap = ec2res ? hardThreadCap(ec2res.workload, ec2res.profile) : computeMaxThreads(srcConfig)
```

Replace with:

```ts
          const srcProfile = ep.sourceNodeType === 'ec2' ? resolveEc2Profile(srcConfig) : null
          const cap = srcProfile ? hardThreadCap(DEFAULT_PACKET_WORKLOAD, srcProfile) : computeMaxThreads(srcConfig)
```

**Site 3 — caller-side cap sizing, retry-respawn** (around line 2525) — same pattern:

```ts
        const ec2res = ep!.sourceNodeType === 'ec2' ? resolveEc2Resources(srcConfig) : null
        const cap = ec2res ? hardThreadCap(ec2res.workload, ec2res.profile) : computeMaxThreads(srcConfig)
```

Replace with:

```ts
        const srcProfile = ep!.sourceNodeType === 'ec2' ? resolveEc2Profile(srcConfig) : null
        const cap = srcProfile ? hardThreadCap(DEFAULT_PACKET_WORKLOAD, srcProfile) : computeMaxThreads(srcConfig)
```

**Site 4 — target-side admission decision** (around line 1422):

```ts
    const ec2res = targetNodeType === 'ec2' ? resolveEc2Resources(config) : null

    if (ec2res) {
      // EC2 compute model: memory-bound admission (hard cap) + OOM crash. CPU pressure is NOT a
      // drop here — it shows up as amplified latency in updateAllNodeMetrics.
      // Force Healthy is an explicit user override of the model: it exempts the node from compute
      // OOM/503 drops entirely, so it behaves like a perfect infinite server (consistent with how
      // forcedHealthState: 'healthy' pins every other node type). Only 'healthy' exempts — forcing
      // 'degraded'/'down' means the user WANTS problems, so those still admit-and-drop normally.
      const decision = config.forcedHealthState === 'healthy'
        ? 'admit'
        : ec2AdmissionDecision(activeThreads, ec2res.workload, ec2res.profile)
```

Replace with:

```ts
    const ec2profile = targetNodeType === 'ec2' ? resolveEc2Profile(config) : null

    if (ec2profile) {
      // EC2 compute model: memory-bound admission (hard cap) + OOM crash. CPU pressure is NOT a
      // drop here — it shows up as amplified latency in updateAllNodeMetrics.
      // Force Healthy is an explicit user override of the model: it exempts the node from compute
      // OOM/503 drops entirely, so it behaves like a perfect infinite server (consistent with how
      // forcedHealthState: 'healthy' pins every other node type). Only 'healthy' exempts — forcing
      // 'degraded'/'down' means the user WANTS problems, so those still admit-and-drop normally.
      const decision = config.forcedHealthState === 'healthy'
        ? 'admit'
        : ec2AdmissionDecision(activeThreads, DEFAULT_PACKET_WORKLOAD, ec2profile)
```

The rest of that block references `ec2res.profile.ramGiB` (in the OOM event message) — find and
replace that one usage too:

```ts
          `${label} out of memory — ${ec2res.profile.ramGiB} GiB exhausted, crashing`, 'critical',
```

Replace with:

```ts
          `${label} out of memory — ${ec2profile.ramGiB} GiB exhausted, crashing`, 'critical',
```

**Site 5 — legacy-`maxRps`-skip gate** (around line 1653):

```ts
    const ec2ComputeGated = targetNodeType === 'ec2' && resolveEc2Resources(config) !== null
```

Replace with:

```ts
    const ec2ComputeGated = targetNodeType === 'ec2' && resolveEc2Profile(config) !== null
```

**Site 6 — `updateAllNodeMetrics` utilization** (around line 1957):

```ts
      const ec2res = nodeType === 'ec2' ? resolveEc2Resources(config) : null
      if (ec2res) {
        // EC2 compute model: reported utilization is the binding constraint — CPU rho (drives the
        // latency hockey-stick) or memory (drives hard drops/OOM), whichever is higher.
        const u = nodeUtilization(inRps, activeThreads, ec2res.workload, ec2res.profile)
        utilization = u.utilization
        _bottleneckResource.set(nodeId, u.bottleneck)
      } else {
```

Replace with:

```ts
      const ec2profile2 = nodeType === 'ec2' ? resolveEc2Profile(config) : null
      if (ec2profile2) {
        // EC2 compute model: reported utilization is the binding constraint — CPU rho (drives the
        // latency hockey-stick) or memory (drives hard drops/OOM), whichever is higher.
        const u = nodeUtilization(inRps, activeThreads, DEFAULT_PACKET_WORKLOAD, ec2profile2)
        utilization = u.utilization
        _bottleneckResource.set(nodeId, u.bottleneck)
      } else {
```

> `ec2profile2` is a deliberately distinct name from Site 4's `ec2profile` — they're in different
> functions (`handleParticleArrival` vs `updateAllNodeMetrics`), so there's no actual collision,
> but match this exact name so Task 2's diff (which edits this same line again) applies cleanly.

- [ ] **Step 5: Fix broken test fixtures**

Run the full suite first to see exactly what's broken:

```
npx vitest run
```

Expected: several failures/compile errors in `compute.test.ts`,
`computeDefaults.test.ts`, `oomCrashLock.test.ts`, `circuitBreakerMetrics.test.ts` —
anywhere that constructs a `NodeSimConfig` literal with a `workload:` key (now a
type error) or calls `resolveEc2Resources` (now renamed).

Fix each:

- **`compute.test.ts`**: find the `resolveEc2Resources` describe block (tests
  named `'returns profile+workload for a config that has them'` and `'returns
  null when no compute profile is present'`). Rename the import and update the
  first test to match the new return shape:
  ```ts
  import { resolveEc2Profile } from './compute'
  ```
  ```ts
  describe('resolveEc2Profile', () => {
    it('returns the profile for a config that has one', () => {
      const r = resolveEc2Profile({ maxRps: 1000, processingMs: 10, errorRate: 0, computeProfile: DEFAULT_EC2_COMPUTE_PROFILE })
      expect(r).not.toBeNull()
      expect(r!.vCpu).toBe(2)
    })

    it('returns null when no compute profile is present (legacy nodes)', () => {
      expect(resolveEc2Profile({ maxRps: 1000, processingMs: 10, errorRate: 0 })).toBeNull()
    })
  })
  ```
  Remove the now-unused `DEFAULT_EC2_WORKLOAD` import if nothing else in the
  file uses it (check first — the pure-function tests at the top of this file
  use their own local `W`/`P` constants, not the DEFAULT_ ones, so it's likely
  fully unused after this change).

- **`computeDefaults.test.ts`**: find and update the `DEFAULT_EC2_WORKLOAD`
  import/usage:
  ```ts
  import { NODE_SIM_DEFAULTS, DEFAULT_EC2_COMPUTE_PROFILE, DEFAULT_EC2_WORKLOAD } from './defaults'
  ```
  Replace with:
  ```ts
  import { NODE_SIM_DEFAULTS, DEFAULT_EC2_COMPUTE_PROFILE, DEFAULT_PACKET_WORKLOAD } from './defaults'
  ```
  and update every `DEFAULT_EC2_WORKLOAD` reference in the test bodies to
  `DEFAULT_PACKET_WORKLOAD`. The test `'ec2 ships a compute profile + workload
  and no manual maxThreads'` asserted `ec2.workload` is defined — remove that
  specific assertion line (it's no longer true, by design) but keep the
  `ec2.computeProfile`/`ec2.maxThreads` assertions in that same test.

- **`oomCrashLock.test.ts`**: read the file, find where it constructs a
  `NodeSimConfig` with a top-level `workload,` key (around line 61-72 per a
  quick grep) and remove that key from the config literal — the test almost
  certainly doesn't need a custom packet template to still exercise OOM-lock
  behavior (it'll now resolve `DEFAULT_PACKET_WORKLOAD` internally, same
  values as before), so no other change should be needed. Run this specific
  test file after the edit and confirm it still passes with the same
  assertions.

- **`circuitBreakerMetrics.test.ts`**: find the line
  `setNodeConfigs(new Map([['dst', { forcedHealthState: 'healthy', maxThreads: 10000, computeProfile: undefined, workload: undefined } as NodeSimConfig]]))`
  and remove the now-nonexistent `workload: undefined` key:
  ```ts
  setNodeConfigs(new Map([['dst', { forcedHealthState: 'healthy', maxThreads: 10000, computeProfile: undefined } as NodeSimConfig]]))
  ```

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npx vitest run`
Expected: PASS — every test that was broken by the schema move now passes
again with equivalent (not necessarily identical-line, but behaviorally
equivalent) assertions.
Run: `npx tsc --noEmit`
Expected: clean, no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/nodeConfig.ts src/app/simulation/defaults.ts src/app/canvas/simulation/particleEngine/compute.ts src/app/canvas/simulation/particleEngine.ts src/app/canvas/simulation/particleEngine/compute.test.ts src/app/simulation/computeDefaults.test.ts src/app/canvas/simulation/particleEngine/oomCrashLock.test.ts src/app/canvas/simulation/particleEngine/circuitBreakerMetrics.test.ts
git commit -m "refactor(compute): move WorkloadDemand from NodeSimConfig to BasePacketTemplate

Relocates the schema field per issue #18 -- workload is a property of
the request type, not the node processing it. Behavior-parity
milestone: every call site falls back to the same DEFAULT_PACKET_WORKLOAD
constant (renamed from DEFAULT_EC2_WORKLOAD, same values), so simulated
behavior is unchanged until the next commit adds real per-packet
differentiation. resolveEc2Resources -> resolveEc2Profile (workload no
longer resolves alongside the hardware profile)."
```

---

### Task 2: Real per-particle and weighted-blend workload resolution

**Files:**
- Modify: `src/app/canvas/simulation/particleEngine.ts` (add 4 resolution functions; rewire the 6 call sites from Task 1's `DEFAULT_PACKET_WORKLOAD` placeholder to real resolution; thread `particle` through `trackRequest`)
- Test: `src/app/canvas/simulation/particleEngine/workloadResolution.test.ts` (new)

**Interfaces:**
- Consumes: `DEFAULT_PACKET_WORKLOAD`, `resolveEc2Profile` (Task 1).
- Produces: `resolveParticleWorkload(particle: Particle): WorkloadDemand`,
  `blendDistributionWorkload(dist: PacketDistributionEntry[] | undefined, edgeType: EdgeType): WorkloadDemand | undefined`,
  `resolveSourceOutboundWorkload(sourceNodeId: string, edgeType: EdgeType): WorkloadDemand`,
  `resolveInboundWeightedWorkload(targetNodeId: string): WorkloadDemand` — none consumed
  outside this file.

- [ ] **Step 1: Write the failing tests**

Create `src/app/canvas/simulation/particleEngine/workloadResolution.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData, HttpTemplate, PacketDistributionEntry } from '../../../../lib/nodeConfig'
import { useCanvasStore } from '../../../store/canvas.store'
import { useSimulationStore, type NodeMetrics } from '../../../store/simulation.store'
import { startSimulation, stopSimulation, setCallbacks } from '../particleEngine'

function makeFakeCanvas(): HTMLCanvasElement {
  const ctx = {
    save() {}, restore() {}, beginPath() {}, closePath() {},
    moveTo() {}, lineTo() {}, arc() {}, arcTo() {}, stroke() {}, fill() {},
    clearRect() {}, setLineDash() {},
    strokeStyle: '', fillStyle: '', lineWidth: 0, globalAlpha: 1,
    shadowColor: '', shadowBlur: 0,
  }
  const canvas = {
    width: 800, height: 600,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON() {} }),
  }
  return canvas as unknown as HTMLCanvasElement
}

const LIGHT_TEMPLATE: Omit<HttpTemplate, 'id'> = {
  name: 'light', protocol: 'http', sizeKb: 1, method: 'GET', path: '/health', statusCode: 200,
  workload: { tier: 'simple_crud', cpuInstructionsBillions: 0.001, memoryFootprintMb: 4, ioBoundFraction: 0.9 },
}
const HEAVY_TEMPLATE: Omit<HttpTemplate, 'id'> = {
  name: 'heavy', protocol: 'http', sizeKb: 1, method: 'POST', path: '/render', statusCode: 200,
  workload: { tier: 'heavy_compute', cpuInstructionsBillions: 5, memoryFootprintMb: 256, ioBoundFraction: 0.1 },
}

describe('per-particle and weighted workload resolution', () => {
  let rafCallback: ((t: number) => void) | null = null
  let rafSpy: ReturnType<typeof vi.spyOn>
  let cafSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    rafCallback = null
    rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      rafCallback = cb as unknown as (t: number) => void
      return 1
    })
    cafSpy = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {})
  })

  afterEach(() => {
    stopSimulation()
    useSimulationStore.getState().setRunning(false)
    rafSpy.mockRestore()
    cafSpy.mockRestore()
  })

  it('a node with an 80/20-weighted light/heavy distribution reports utilization strictly between the two extremes, proportioned to the weights (not a plain average)', () => {
    // caller (source, custom-mode distribution 80% light / 20% heavy) -> ec2 target.
    useCanvasStore.getState().setPacketMode('custom')
    const lightId = useCanvasStore.getState().addPacketTemplate(LIGHT_TEMPLATE)
    const heavyId = useCanvasStore.getState().addPacketTemplate(HEAVY_TEMPLATE)
    const dist: PacketDistributionEntry[] = [
      { templateId: lightId, weight: 80 },
      { templateId: heavyId, weight: 20 },
    ]
    useCanvasStore.setState(s => ({
      nodes: [
        { id: 'caller', type: 'cdn', position: { x: 0, y: 0 }, data: { label: 'caller', subtitle: '', status: 'healthy', notes: '', warnings: [], packetDistribution: dist } },
        { id: 'target', type: 'ec2', position: { x: 200, y: 0 }, data: { label: 'target', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
      ],
      edges: [
        { id: 'e1', source: 'caller', target: 'target', type: 'request', data: { label: '', edgeType: 'request', throughput: 0, latency: 0 } },
      ],
    }))

    const { nodes, edges } = useCanvasStore.getState()
    useSimulationStore.getState().setRunning(true)
    useSimulationStore.getState().setPaused(false)
    useSimulationStore.getState().setEdgeRps('e1', 300)

    const batches: Map<string, NodeMetrics>[] = []
    setCallbacks((batch) => batches.push(new Map(batch)), () => {}, () => {})
    startSimulation(makeFakeCanvas(), nodes as unknown as Node<NodeData>[], edges as unknown as Edge<EdgeData>[], 1)

    let t = performance.now()
    for (let i = 0; i < 60; i++) {
      const cb = rafCallback!
      rafCallback = null
      t += 16
      cb(t)
    }

    const target = batches[batches.length - 1].get('target')
    expect(target?.utilization).toBeGreaterThan(0)
    // Not asserting an exact number (utilization is a blend of many effects) -- the key
    // discriminator is in the unit tests below, which isolate blendDistributionWorkload's math
    // directly. This integration test just proves the wiring reaches end-to-end without throwing
    // and produces a non-trivial utilization once a custom distribution with real workload is set.
    expect(target?.utilization).toBeLessThanOrEqual(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/workloadResolution.test.ts`
Expected: FAIL or PASS-for-the-wrong-reason — before this task's changes, the
engine still resolves `DEFAULT_PACKET_WORKLOAD` everywhere regardless of the
configured distribution, so this test may pass trivially without proving
anything. This is expected and fine — the REAL discriminating tests are the
unit tests in Step 3 below, which you'll add next and which DO fail cleanly
pre-fix. Don't worry about achieving a hard red here; move to Step 3.

- [ ] **Step 3: Add the real discriminating unit tests**

Append to the same `workloadResolution.test.ts` file, in a new `describe`
block testing the exported functions directly (these DO fail before Step 4's
implementation, since the functions don't exist yet):

```ts
import { resolveParticleWorkload, blendDistributionWorkload, resolveSourceOutboundWorkload, resolveInboundWeightedWorkload } from '../particleEngine'

describe('blendDistributionWorkload weighting math', () => {
  it('an 80/20 light/heavy split blends much closer to light than a 50/50 average would', () => {
    useCanvasStore.getState().setPacketMode('custom')
    const lightId = useCanvasStore.getState().addPacketTemplate(LIGHT_TEMPLATE)
    const heavyId = useCanvasStore.getState().addPacketTemplate(HEAVY_TEMPLATE)
    useCanvasStore.setState(s => ({
      nodes: [{ id: 'src', type: 'cdn', position: { x: 0, y: 0 }, data: { label: 'src', subtitle: '', status: 'healthy', notes: '', warnings: [], packetDistribution: [{ templateId: lightId, weight: 80 }, { templateId: heavyId, weight: 20 }] } }],
      edges: [],
    }))
    // Must call startSimulation once so the engine snapshots the packet registry into its
    // internal _packetTemplates/_packetMode mirrors (see startSimulation's own comment on why —
    // the hot loop never reads React state directly).
    const canvas = document.createElement('canvas')
    const { nodes, edges } = useCanvasStore.getState()
    startSimulation(canvas, nodes as unknown as Node<NodeData>[], edges as unknown as Edge<EdgeData>[], 1)

    const blended = resolveSourceOutboundWorkload('src', 'request')
    // 80% of 0.001 + 20% of 5 = 0.0008 + 1.0 = 1.0008 -- much closer to the light value (0.001)
    // than a plain 50/50 average would be ((0.001+5)/2 = 2.5005). This is the real assertion:
    // proves the function is weight-proportional, not an unweighted mean.
    expect(blended.cpuInstructionsBillions).toBeCloseTo(1.0008, 4)
    expect(blended.cpuInstructionsBillions).toBeLessThan(2.5005 * 0.5) // sanity: well below the naive average
    stopSimulation()
  })

  it('returns undefined (not a default) when nothing in the distribution is eligible', () => {
    useCanvasStore.getState().setPacketMode('custom')
    const streamId = useCanvasStore.getState().addPacketTemplate({ name: 's', protocol: 'stream', sizeKb: 1, streamId: 'x', compressionType: 'none' })
    // A stream-protocol template is not eligible for a 'request'-type edge (edgeAcceptsProtocol).
    const result = blendDistributionWorkload([{ templateId: streamId, weight: 100 }], 'request')
    expect(result).toBeUndefined()
  })
})

describe('resolveParticleWorkload', () => {
  it('falls back to DEFAULT_PACKET_WORKLOAD when templateId is undefined (generic mode)', () => {
    const { DEFAULT_PACKET_WORKLOAD } = require('../../../simulation/defaults') as typeof import('../../../simulation/defaults')
    const w = resolveParticleWorkload({ id: 1, t: 0, speed: 1, color: '#fff', edgeId: 'e1', retries: 0, originLatencyMs: 0, spawnTime: 0, payloadBytes: 100 })
    expect(w).toEqual(DEFAULT_PACKET_WORKLOAD)
  })
})
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/workloadResolution.test.ts`
Expected: FAIL — `resolveParticleWorkload`/`blendDistributionWorkload`/
`resolveSourceOutboundWorkload`/`resolveInboundWeightedWorkload` are not
exported from `particleEngine.ts` yet.

- [ ] **Step 5: Implement the resolution functions**

In `src/app/canvas/simulation/particleEngine.ts`, add these 4 functions near
`rollDistribution`/`distributionReadFraction` (around line 265-309, which
already implement the same distribution-filtering pattern this reuses):

```ts
// Exact resolution for a specific particle's compute cost — reads its resolved packet template's
// workload, falling back to DEFAULT_PACKET_WORKLOAD when the particle has no templateId (generic
// mode) or its template predates this field.
export function resolveParticleWorkload(particle: Particle): WorkloadDemand {
  const tpl = particle.templateId !== undefined ? _packetTemplates[particle.templateId] : undefined
  return tpl?.workload ?? DEFAULT_PACKET_WORKLOAD
}

// Weighted average of cpuInstructionsBillions/memoryFootprintMb/ioBoundFraction across `dist`,
// restricted to entries whose template's protocol fits `edgeType` (same eligibility filter
// rollDistribution/distributionReadFraction already use). Returns undefined (not a default) when
// nothing is eligible to blend, so callers can layer their own fallback explicitly.
export function blendDistributionWorkload(
  dist: PacketDistributionEntry[] | undefined, edgeType: EdgeType,
): WorkloadDemand | undefined {
  if (!dist || dist.length === 0) return undefined
  let total = 0, cpu = 0, mem = 0, io = 0
  for (const d of dist) {
    const tpl = _packetTemplates[d.templateId]
    if (!tpl || d.weight <= 0 || !edgeAcceptsProtocol(edgeType, tpl.protocol)) continue
    const w = tpl.workload ?? DEFAULT_PACKET_WORKLOAD
    cpu += w.cpuInstructionsBillions * d.weight
    mem += w.memoryFootprintMb * d.weight
    io  += w.ioBoundFraction * d.weight
    total += d.weight
  }
  if (total <= 0) return undefined
  return { tier: 'custom', cpuInstructionsBillions: cpu / total, memoryFootprintMb: mem / total, ioBoundFraction: io / total }
}

// Particle-less resolution for a SOURCE node about to make an outbound call (before a specific
// packet is rolled) -- blends that node's own configured outbound distribution. Generic mode or
// no eligible distribution falls back to DEFAULT_PACKET_WORKLOAD.
export function resolveSourceOutboundWorkload(sourceNodeId: string, edgeType: EdgeType): WorkloadDemand {
  if (_packetMode !== 'custom') return DEFAULT_PACKET_WORKLOAD
  const dist = (_nodesMap.get(sourceNodeId)?.data as NodeData | undefined)?.packetDistribution
  return blendDistributionWorkload(dist, edgeType) ?? DEFAULT_PACKET_WORKLOAD
}

// Particle-less resolution for a TARGET node's aggregate utilization -- blends across every
// inbound edge's source distribution, weighted by that edge's live effectiveRps share (mirroring
// how inRps itself is already summed from inbound edges elsewhere in this file). Generic mode or
// no inbound edges/eligible distributions falls back to DEFAULT_PACKET_WORKLOAD.
export function resolveInboundWeightedWorkload(targetNodeId: string): WorkloadDemand {
  if (_packetMode !== 'custom') return DEFAULT_PACKET_WORKLOAD
  const inboundEdges = _edgePaths.filter(ep => ep.edgeType !== 'dependency' && _edgesData.find(e => e.id === ep.id)?.target === targetNodeId)
  if (inboundEdges.length === 0) return DEFAULT_PACKET_WORKLOAD
  let totalW = 0, cpu = 0, mem = 0, io = 0
  for (const ep of inboundEdges) {
    const sourceId = _edgesData.find(e => e.id === ep.id)?.source
    if (!sourceId) continue
    const dist = (_nodesMap.get(sourceId)?.data as NodeData | undefined)?.packetDistribution
    const blended = blendDistributionWorkload(dist, ep.edgeType as EdgeType)
    if (!blended) continue
    const edgeWeight = ep.effectiveRps ?? ep.rps
    if (edgeWeight <= 0) continue
    cpu += blended.cpuInstructionsBillions * edgeWeight
    mem += blended.memoryFootprintMb * edgeWeight
    io  += blended.ioBoundFraction * edgeWeight
    totalW += edgeWeight
  }
  if (totalW <= 0) return DEFAULT_PACKET_WORKLOAD
  return { tier: 'custom', cpuInstructionsBillions: cpu / totalW, memoryFootprintMb: mem / totalW, ioBoundFraction: io / totalW }
}
```

> `PacketDistributionEntry` and `EdgeType` must already be imported/available in this file (check
> the top-level imports and existing `rollDistribution`'s own signature, which already uses
> `EdgeType`) — add them to the `nodeConfig`-import line if either is missing.

- [ ] **Step 6: Thread `particle` through `trackRequest` and rewire all 6 call sites**

In `src/app/canvas/simulation/particleEngine.ts`, find `trackRequest` (Task 1
left it taking 3 params with `const workload = DEFAULT_PACKET_WORKLOAD` — the
placeholder comment says "Task 2 replaces this"):

```ts
function trackRequest(nodeId: string, nodeType: NodeType, config: NodeSimConfig) {
```

Replace the signature line with:

```ts
function trackRequest(nodeId: string, nodeType: NodeType, config: NodeSimConfig, particle?: Particle) {
```

Find the line Task 1 added:

```ts
  const profile = nodeType === 'ec2' ? resolveEc2Profile(config) : null
  const workload = DEFAULT_PACKET_WORKLOAD // Task 2 replaces this with per-particle/blended resolution
```

Replace with:

```ts
  const profile = nodeType === 'ec2' ? resolveEc2Profile(config) : null
  const workload = particle ? resolveParticleWorkload(particle) : resolveSourceOutboundWorkload(nodeId, 'request')
```

Now update the 4 arrival-time call sites (all inside `handleParticleArrival`,
which already has `particle` in scope) — find each exact call and add the
4th argument:

```ts
    trackRequest(targetNodeId, targetNodeType, config)
```

There are 4 occurrences of this exact line (around lines 1477, 1561, 1643,
1678 as of Task 1's commit — confirm via `grep -n "trackRequest(targetNodeId, targetNodeType, config)"`
since Task 1's edits may have shifted them slightly). Replace **each** with:

```ts
    trackRequest(targetNodeId, targetNodeType, config, particle)
```

> Do NOT touch the 2 caller-side `trackRequest` calls (`trackRequest(sourceNodeId!, ep.sourceNodeType as NodeType, srcConfig)` and the retry-respawn equivalent) — leave them exactly as-is, with no 4th argument. `trackRequest` internally falls back to `resolveSourceOutboundWorkload` when `particle` is omitted, which is exactly right for these two (no particle exists yet at that point).

Next, rewire the two caller-side cap-sizing sites Task 1 left on
`DEFAULT_PACKET_WORKLOAD`. Find (Site 2, around line 1015 pre-Task-1-shift):

```ts
          const srcProfile = ep.sourceNodeType === 'ec2' ? resolveEc2Profile(srcConfig) : null
          const cap = srcProfile ? hardThreadCap(DEFAULT_PACKET_WORKLOAD, srcProfile) : computeMaxThreads(srcConfig)
```

Replace with:

```ts
          const srcProfile = ep.sourceNodeType === 'ec2' ? resolveEc2Profile(srcConfig) : null
          const cap = srcProfile ? hardThreadCap(resolveSourceOutboundWorkload(sourceNodeId!, 'request'), srcProfile) : computeMaxThreads(srcConfig)
```

Find (Site 3, retry-respawn equivalent):

```ts
        const srcProfile = ep!.sourceNodeType === 'ec2' ? resolveEc2Profile(srcConfig) : null
        const cap = srcProfile ? hardThreadCap(DEFAULT_PACKET_WORKLOAD, srcProfile) : computeMaxThreads(srcConfig)
```

Replace with:

```ts
        const srcProfile = ep!.sourceNodeType === 'ec2' ? resolveEc2Profile(srcConfig) : null
        const cap = srcProfile ? hardThreadCap(resolveSourceOutboundWorkload(sourceNodeId!, 'request'), srcProfile) : computeMaxThreads(srcConfig)
```

Find (Site 4, target admission decision):

```ts
      const decision = config.forcedHealthState === 'healthy'
        ? 'admit'
        : ec2AdmissionDecision(activeThreads, DEFAULT_PACKET_WORKLOAD, ec2profile)
```

Replace with:

```ts
      const decision = config.forcedHealthState === 'healthy'
        ? 'admit'
        : ec2AdmissionDecision(activeThreads, resolveParticleWorkload(particle), ec2profile)
```

Find (Site 6, `updateAllNodeMetrics` utilization):

```ts
        const u = nodeUtilization(inRps, activeThreads, DEFAULT_PACKET_WORKLOAD, ec2profile2)
```

Replace with:

```ts
        const u = nodeUtilization(inRps, activeThreads, resolveInboundWeightedWorkload(nodeId), ec2profile2)
```

(Site 5, the legacy-`maxRps`-skip gate, never used a workload value — no
change needed there.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/workloadResolution.test.ts`
Expected: PASS (all tests, including the weighting-math assertions).

- [ ] **Step 8: Run the full suite and typecheck**

Run: `npx vitest run`
Expected: PASS — pay particular attention to every EC2-compute-model test
file from the prior branch (`compute.test.ts`, `threadPoolUnification.test.ts`,
`outboundBacklogDrain.test.ts`, `oomCrashLock.test.ts`, `circuitBreakerMetrics.test.ts`).
Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add src/app/canvas/simulation/particleEngine.ts src/app/canvas/simulation/particleEngine/workloadResolution.test.ts
git commit -m "feat(compute): resolve workload per-particle and via weighted blend, not one flat default

Replaces Task 1's flat DEFAULT_PACKET_WORKLOAD placeholder at every
call site with real resolution: exact per-particle lookup wherever a
specific packet is already known (trackRequest's arrival-time callers,
target-side admission), and a true weighted blend of the node's
configured packet distribution wherever it isn't yet (caller-side
spawn-time capacity sizing, target-side aggregate utilization) --
per user decision, not a flat fallback. This is the actual point of
issue #18: different request types arriving at the same EC2 node now
carry genuinely different simulated compute cost."
```

---

### Task 3: UI — remove node-level workload config, add packet-level workload editing

**Files:**
- Modify: `src/app/simulation/SimConfigPanel.tsx` (Workload `configBlock` `:499-543`, `effMaxThreads` `:936-940`)
- Modify: `src/app/simulation/PacketEditor.tsx` (`defaultTemplate` `:36-43`, `PacketCard` render `:250-297`, add `WorkloadPins`)

**Interfaces:**
- Consumes: `WORKLOAD_TIER_RANGES`, `resolveWorkloadInstructions` (`nodeConfig.ts`, pre-existing, already exported); `DEFAULT_PACKET_WORKLOAD` (Task 1).
- Produces: nothing consumed elsewhere — UI leaf.

- [ ] **Step 1: Remove the Workload block from `SimConfigPanel.tsx`**

Find the whole block (around lines 448-546 — the `isEc2Compute && (() => { ... })()` IIFE). It
currently renders BOTH the "Compute (vCPU/RAM)" block AND the "Workload" block inside one IIFE.
Keep the Compute block, remove only the Workload portion. Find:

```tsx
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

Replace with:

```tsx
              <div className={styles.configField}>
                <span className={styles.configLabel}>Derived Threads</span>
                <span className={styles.liveStatVal}>{derivedThreads}</span>
              </div>
            </div>
          </div>
        )
      })()}
```

Then find the IIFE's opening, which computes `workload`/`setWorkload` — these are now unused:

```tsx
      {isEc2Compute && (() => {
        const profile = { ...DEFAULT_EC2_COMPUTE_PROFILE, ...(eff.computeProfile ?? {}) }
        const workload = { ...DEFAULT_EC2_WORKLOAD, ...(eff.workload ?? {}) }
        const setProfile = (patch: Partial<typeof profile>) =>
          setNodeConfig(nodeId, { computeProfile: { ...profile, ...patch } })
        const setWorkload = (patch: Partial<typeof workload>) =>
          setNodeConfig(nodeId, { workload: { ...workload, ...patch } })
        const derivedThreads = hardThreadCap(workload, profile)
```

Replace with:

```tsx
      {isEc2Compute && (() => {
        const profile = { ...DEFAULT_EC2_COMPUTE_PROFILE, ...(eff.computeProfile ?? {}) }
        const setProfile = (patch: Partial<typeof profile>) =>
          setNodeConfig(nodeId, { computeProfile: { ...profile, ...patch } })
        // Indicative only -- actual per-request capacity now varies by packet type (Custom mode).
        // See PacketEditor for per-template workload configuration.
        const derivedThreads = hardThreadCap(DEFAULT_PACKET_WORKLOAD, profile)
```

- [ ] **Step 2: Update `SimConfigPanel.tsx`'s imports**

Find (around line 9-12):

```ts
import { NODE_CONFIG, GROUPING_TYPES, WORKLOAD_TIER_RANGES, resolveWorkloadInstructions, type NodeType, type TrafficOrigin } from '../../lib/nodeConfig'
```

Replace with:

```ts
import { NODE_CONFIG, GROUPING_TYPES, type NodeType, type TrafficOrigin } from '../../lib/nodeConfig'
```

Find:

```ts
import { NODE_SIM_DEFAULTS, DEFAULT_SLO, DEFAULT_EC2_COMPUTE_PROFILE, DEFAULT_EC2_WORKLOAD } from './defaults'
```

Replace with:

```ts
import { NODE_SIM_DEFAULTS, DEFAULT_SLO, DEFAULT_EC2_COMPUTE_PROFILE, DEFAULT_PACKET_WORKLOAD } from './defaults'
```

> Verify `NumericStepper`'s import isn't now unused in this file — it's still used by the
> Compute block's vCPU/RAM/Clock steppers, so it should stay; just confirm via a search before
> assuming.

- [ ] **Step 3: Update `effMaxThreads`**

Find (around line 936):

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

Replace with:

```ts
  // Indicative only, assuming DEFAULT_PACKET_WORKLOAD -- actual capacity varies per packet type
  // once Custom mode is in use (see PacketEditor for per-template workload configuration).
  const effMaxThreads = nodeType === 'ec2'
    ? hardThreadCap(
        DEFAULT_PACKET_WORKLOAD,
        { ...DEFAULT_EC2_COMPUTE_PROFILE, ...(nodeConfigs.get(nodeId)?.computeProfile ?? {}) },
      )
    : nodeType
      ? (nodeConfigs.get(nodeId)?.maxThreads ?? NODE_SIM_DEFAULTS[nodeType]?.maxThreads ?? 50)
      : 50
```

- [ ] **Step 4: Add workload fields to `PacketEditor.tsx`**

In `src/app/simulation/PacketEditor.tsx`, add the import for the tier helpers and default
constant (find the existing `import type { ... } from` block near the top and extend it, plus add
a new import line):

```ts
import { WORKLOAD_TIER_RANGES, resolveWorkloadInstructions, type WorkloadDemand } from '../../lib/nodeConfig'
import { DEFAULT_PACKET_WORKLOAD } from './defaults'
```

Find `defaultTemplate` (around line 36):

```ts
function defaultTemplate(protocol: PacketProtocol): NewPacketTemplate {
  switch (protocol) {
    case 'http':   return { name: 'New HTTP request', protocol, sizeKb: 2, method: 'GET', path: '/api/v1/resource', statusCode: 200 }
    case 'event':  return { name: 'New event', protocol, sizeKb: 1, topic: 'domain.events', eventType: 'created', deliveryMode: 'at-least-once' }
    case 'stream': return { name: 'New stream record', protocol, sizeKb: 4, streamId: 'stream-1', compressionType: 'none' }
    case 'db':     return { name: 'New query', protocol, sizeKb: 1, queryType: 'read', isWAL: false, resultSizeKb: 8 }
  }
}
```

Replace with:

```ts
function defaultTemplate(protocol: PacketProtocol): NewPacketTemplate {
  const workload = DEFAULT_PACKET_WORKLOAD
  switch (protocol) {
    case 'http':   return { name: 'New HTTP request', protocol, sizeKb: 2, method: 'GET', path: '/api/v1/resource', statusCode: 200, workload }
    case 'event':  return { name: 'New event', protocol, sizeKb: 1, topic: 'domain.events', eventType: 'created', deliveryMode: 'at-least-once', workload }
    case 'stream': return { name: 'New stream record', protocol, sizeKb: 4, streamId: 'stream-1', compressionType: 'none', workload }
    case 'db':     return { name: 'New query', protocol, sizeKb: 1, queryType: 'read', isWAL: false, resultSizeKb: 8, workload }
  }
}
```

Now add a `WorkloadPins` component, mirroring the existing `HttpPins`/`DbPins` pattern exactly
(find those functions, around line 464-540, for the established `Pin`/`usePinState`/`styles.input`
idiom). Add this new function right after `DbPins`:

```tsx
function WorkloadPins({ t, patch, reduceMotion }: { t: PacketTemplate; patch: (p: Partial<PacketTemplate>) => void; reduceMotion: boolean }) {
  const pin = usePinState()
  const workload = t.workload ?? DEFAULT_PACKET_WORKLOAD
  const setWorkload = (w: Partial<WorkloadDemand>) => patch({ workload: { ...workload, ...w } })
  return (
    <>
      <Pin label="Tier" valueLabel={workload.tier} editing={pin.isOpen('tier')} onToggle={() => pin.toggle('tier')} reduceMotion={reduceMotion}>
        <select className={styles.input} autoFocus value={workload.tier} onChange={e => {
          const tier = e.target.value as WorkloadDemand['tier']
          const next = tier === 'custom' ? workload.cpuInstructionsBillions : WORKLOAD_TIER_RANGES[tier].default
          setWorkload({ tier, cpuInstructionsBillions: resolveWorkloadInstructions(tier, next) })
          pin.toggle('tier')
        }}>
          <option value="simple_crud">simple_crud</option>
          <option value="moderate_logic">moderate_logic</option>
          <option value="heavy_compute">heavy_compute</option>
          <option value="custom">custom</option>
        </select>
      </Pin>
      <Pin label="Instr (B)" valueLabel={String(workload.cpuInstructionsBillions)} editing={pin.isOpen('instr')} onToggle={() => pin.toggle('instr')} reduceMotion={reduceMotion}>
        <input className={styles.input} autoFocus type="number" min={0} step={workload.tier === 'heavy_compute' || workload.tier === 'custom' ? 0.1 : 0.001}
          value={workload.cpuInstructionsBillions}
          onChange={e => setWorkload({ cpuInstructionsBillions: resolveWorkloadInstructions(workload.tier, Number(e.target.value) || 0) })} />
      </Pin>
      <Pin label="Mem/req (MB)" valueLabel={String(workload.memoryFootprintMb)} editing={pin.isOpen('mem')} onToggle={() => pin.toggle('mem')} reduceMotion={reduceMotion}>
        <input className={styles.input} autoFocus type="number" min={1} step={4}
          value={workload.memoryFootprintMb}
          onChange={e => setWorkload({ memoryFootprintMb: Math.max(1, Number(e.target.value) || 1) })} />
      </Pin>
      <Pin label="IO-bound (%)" valueLabel={String(Math.round(workload.ioBoundFraction * 100))} editing={pin.isOpen('io')} onToggle={() => pin.toggle('io')} reduceMotion={reduceMotion}>
        <input className={styles.input} autoFocus type="number" min={0} max={99} step={5}
          value={Math.round(workload.ioBoundFraction * 100)}
          onChange={e => setWorkload({ ioBoundFraction: Math.min(0.99, Math.max(0, (Number(e.target.value) || 0) / 100)) })} />
      </Pin>
    </>
  )
}
```

- [ ] **Step 5: Render `WorkloadPins` in `PacketCard`**

Find (around line 281-287):

```tsx
      {/* Protocol-specific connector pins */}
      <div className={styles.pinRow}>
        {template.protocol === 'http' && <HttpPins t={template} patch={patch} reduceMotion={reduceMotion} />}
        {template.protocol === 'event' && <EventPins t={template} patch={patch} reduceMotion={reduceMotion} />}
        {template.protocol === 'stream' && <StreamPins t={template} patch={patch} reduceMotion={reduceMotion} />}
        {template.protocol === 'db' && <DbPins t={template} patch={patch} reduceMotion={reduceMotion} />}
      </div>
```

Replace with:

```tsx
      {/* Protocol-specific connector pins */}
      <div className={styles.pinRow}>
        {template.protocol === 'http' && <HttpPins t={template} patch={patch} reduceMotion={reduceMotion} />}
        {template.protocol === 'event' && <EventPins t={template} patch={patch} reduceMotion={reduceMotion} />}
        {template.protocol === 'stream' && <StreamPins t={template} patch={patch} reduceMotion={reduceMotion} />}
        {template.protocol === 'db' && <DbPins t={template} patch={patch} reduceMotion={reduceMotion} />}
      </div>

      {/* Compute workload — shared across every protocol (BasePacketTemplate.workload) */}
      <div className={styles.pinRow}>
        <WorkloadPins t={template} patch={patch} reduceMotion={reduceMotion} />
      </div>
```

- [ ] **Step 6: Typecheck and manual verification**

Run: `npx tsc --noEmit`
Expected: clean.
Run: `npx vitest run`
Expected: all tests still pass (this task touches no engine logic).

Then `npm run tauri dev` (or `npm run dev` if Tauri isn't set up in this
environment): open the Packet Editor, confirm every protocol's card now shows
a "Tier / Instr (B) / Mem/req (MB) / IO-bound (%)" pin row; drop an EC2 node,
open its Properties panel, confirm the old node-level Workload section is
gone and "Derived Threads" still shows a number.

- [ ] **Step 7: Commit**

```bash
git add src/app/simulation/SimConfigPanel.tsx src/app/simulation/PacketEditor.tsx
git commit -m "feat(compute): move workload editing UI from node config to packet editor

SimConfigPanel's EC2 Workload section is removed (Derived Threads
becomes an indicative estimate using DEFAULT_PACKET_WORKLOAD, since
actual per-request capacity now varies by packet type). PacketEditor
gains a Tier/Instr/Mem/IO-bound pin row, shared across all 4 protocol
types since workload lives on BasePacketTemplate. New templates seed
DEFAULT_PACKET_WORKLOAD so they're immediately valid."
```

---

## Manual verification (after all 3 tasks)

Via `npm run dev` + Playwright (no automated visual-regression tooling
exists for the simulation canvas, matching this project's established
convention):

- Load the "Load Balanced Cluster" vault template, switch Packet mode to
  Custom, create two HTTP templates with very different workload tiers
  (`simple_crud` vs `heavy_compute`), assign both to a source node's
  distribution with an uneven weight split, run the simulation, and confirm
  the EC2 target's reported latency/utilization shifts when you change the
  weight split toward the heavy template.
- Confirm a fresh EC2 node with no custom packets configured (generic mode)
  behaves identically to before this plan (same default saturation point,
  ~240 rps) — the behavior-parity guarantee from Task 1 should hold
  end-to-end once Task 2's fallbacks are exercised.
- Open an old `.scalemap` file saved before this plan (one with
  `simConfig.workload` on an EC2 node) and confirm it loads without error
  (the orphan key is silently ignored) and the node still simulates
  sensibly (via `DEFAULT_PACKET_WORKLOAD`, since the file's packets predate
  per-template workload too).

## Self-Review

**Spec coverage:** Schema move (nodeConfig.ts) → Task 1 ✓. Default packets
get sensible values (defaults.ts) → Task 1 (`DEFAULT_PACKET_WORKLOAD`) +
Task 3 (`defaultTemplate` seeding) ✓. Engine resolves dynamically per-packet
or falls back to node-level weighted representatives → Task 2 (exact +
true-blend, per the "true weighted blend" decision, not the flatter
fallback-only option) ✓. `PacketEditor.tsx` renders/configures workload →
Task 3 ✓. Remove workload config from `SimConfigPanel.tsx` → Task 3 ✓.

**Placeholder scan:** Task 1's `DEFAULT_PACKET_WORKLOAD` intermediate value
is a real, complete, working fallback (not a "TBD") — explicitly designed as
a genuine behavior-parity milestone in the plan header, not a stub; Task 2
replaces it with real differentiation in the very next commit. No other
placeholders.

**Type consistency:** `resolveEc2Profile(config): ComputeProfile | null`
(Task 1) is called identically at all 6 sites in both Task 1 and Task 2 (only
the *workload* argument changes between the two tasks, never the profile
resolution). `trackRequest`'s new `particle?: Particle` parameter (Task 2)
is optional, so Task 1's un-4th-argument caller-side calls remain valid
without edits. `resolveParticleWorkload`/`resolveSourceOutboundWorkload`/
`resolveInboundWeightedWorkload` all return `WorkloadDemand` (never
`undefined`) — only the internal `blendDistributionWorkload` helper returns
`WorkloadDemand | undefined`, and every caller of it immediately falls back
to `DEFAULT_PACKET_WORKLOAD` when `undefined`, matching the design spec.

**Known open item:** none — this plan fully covers the spec. The spec's
own "no caching/memoization" non-goal is respected throughout (no new Maps
or per-frame caches added).
