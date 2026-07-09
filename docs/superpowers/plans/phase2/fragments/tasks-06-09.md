## Fragment: Tasks 6–9 (network runtime, breakers port, flow solver, failover machinery)

**Source binding docs (read before touching these tasks):**
`docs/superpowers/specs/2026-07-08-world-engine-contracts.md` (frozen types),
`docs/superpowers/specs/2026-07-08-phase2-substrate-engine-design.md` (decisions 2, 6, 7
govern these tasks), `.superpowers/sdd/phase2-plan-skeleton.md` (T6–T9 specs this fragment
expands). Assumes Tasks 1–5 landed exactly per the skeleton: `src/lib/worldEngine/types.ts`
(contracts verbatim), `rng.ts` (`Rng`, `createRng`), `latency.ts` (`sampleLatencyMs`),
`demand.ts`, `routingRuntime.ts`, `hostScheduler.ts`, `vpsModel.ts`.

**Run commands throughout:** `npx vitest run <path>` for a single suite; `npm run build`
(runs `tsc` over the whole repo, per CLAUDE.md) as the tsc check before each commit.

### SKELETON CONCERNS

1. **T6 cross-region latency: `sampleInterRegionLatencyMs` calls `Math.random`.** The
   skeleton says cross-region hops go "via sampleInterRegionLatencyMs", but that function
   (`src/lib/regionConfig.ts:61-66`) jitters with `Math.random()` — calling it from
   `worldEngine` breaks the frozen determinism rule ("one seeded PRNG for ALL stochastic
   draws; tests reseed per case"). This fragment ports the identical semantics
   deterministically: `interRegionLatencyMs` (the pure base, same file) × ±10% jitter drawn
   from the injected `Rng`. Same distribution, same magnitudes, seeded. No signature impact.

2. **T6 `refusedAttemptRate` cannot compute a "share" from blocked paths alone.** The
   signature takes `blockedPaths: CompiledPath[]` and must return the demand share refused,
   but a share needs a denominator (total targets for the dependency). This fragment's
   convention, documented in the code: **pass every compiled path for the (caller,
   dependency) pair** — the function filters to `dependencyId === dep.id`, splits demand
   evenly across those targets, and refuses the blocked fraction. Passing only blocked paths
   degenerates to refusing the full demand, which is also correct when every target is
   blocked. Parameter name kept as `blockedPaths` per the skeleton.

3. **T9 `setOutage` returns `EngineEvent[]` but receives no clock.** `EngineEvent.simMs` is
   required by the frozen contracts, yet the skeleton signature is
   `setOutage(state, scope, id, down): EngineEvent[]`. Resolved with an **optional trailing
   parameter** `simMs = 0` — every skeleton-shaped call site still compiles (call-compatible
   superset, the same additive-optional pattern the contracts allow), and the facade (T12)
   passes the real clock. Event ids are deterministic content-derived strings; T10's ring
   may re-sequence them.

4. **T9 `FailoverState` needs hysteresis bookkeeping fields.** The ported onset-debounce /
   recovery-lock semantics require per-scope timestamps. Two fields are **added** to the
   skeleton's four (`onsetPendingSince: Map<string, number>`, `recoveryUntil:
   Map<string, number>`) — purely additive; none of the listed fields change shape.

5. **T8 `serviceLatencyMs` has no authored p50/p99 to sample from.** `ServiceBlueprint`
   carries only `workload.cpuMsPerRequest` — no latency model. This fragment derives
   `p50 = cpuMsPerRequest`, `p99 = 10 × p50` (named const `SERVICE_P99_OVER_P50 = 10`,
   commented; legacy NODE_SIM_DEFAULTS spreads ran 10–12.5×), then multiplies by the host's
   `latencyMultiplier` per the skeleton. If blueprints later grow a latency model, only the
   two derivation lines change.

6. **T7 needs one helper beyond the four listed functions.** T8's `breakerOpen(pathKey)`
   callback must express "may this call proceed?" — which for `half-open` means *claim the
   single trial*. `admitRequest(breaker): boolean` is exported for that (additive; the
   state machine itself is exactly the legacy port). Also kept from legacy: a breaker never
   opens on fewer than 10 samples (`MIN_SAMPLES_TO_OPEN`) even inside the 20-sample window —
   that guard IS part of the legacy semantics the task says to keep.

7. **T9 recovery-lock duration: skeleton says 5000ms, legacy code uses 8000ms.**
   `particleEngine.ts:504` has `HEALTH_RECOVERY_LOCK_MS = 8_000`. This fragment follows the
   skeleton (5000ms default) since the duration is a `hysteresis` parameter anyway; flagging
   in case the 8s behavior was intended.

8. **T9 organic AZ drain needs a trigger.** `drainUntil` is set by `setOutage` for manual AZ
   outages, but organically-down AZs (health propagation) also drain. Additive export
   `beginDrain(state, azId, simMs)` (idempotent) for the facade to call when it observes an
   AZ transition to `down`; `clearDrain(state, azId)` for recovery.

---

### Task 6: Network runtime — hop latency, refused paths, NIC caps

**Files:**
- Create: `src/lib/worldEngine/networkRuntime.ts`
- Test: `src/lib/worldEngine/networkRuntime.test.ts`

**Interfaces:**
- Consumes: `HopClass, CompiledPath, BlueprintDependency, Server` from `../world/types`;
  `Rng` from `./rng`; `interRegionLatencyMs` from `../regionConfig` (pure base — see
  SKELETON CONCERNS #1); `greatCircleKm` from `../world/regionGeo`.
- Produces:

```ts
hopLatencyMs(hopClass: HopClass | 'internet', fromRegionCatalogId: string | null, toRegionCatalogId: string | null, popLatLon: [number, number] | null, regionGeo: Record<string, { lat: number; lon: number }>, rng: Rng): number
interface NicState { inBytesThisStep: number; outBytesThisStep: number }
createNicState(): NicState                       // facade zeroes/replaces per step
applyNicCap(state: NicState, server: Server, addInBytes: number, addOutBytes: number, stepMs: number): { deliveredFraction: number; queuedLatencyMs: number }
refusedAttemptRate(dep: BlueprintDependency, blockedPaths: CompiledPath[], demandRps: number): number
```

Semantics (spec decision 6): localhost 0.1ms / same-az 0.5ms / cross-az 1.5ms, each ±10%
jitter; cross-region = `interRegionLatencyMs` base ±10% (deterministic port of
`sampleInterRegionLatencyMs`, concern #1); internet = great-circle km / 100 ms ±10%. NIC:
per-direction step budget from `specs.nicMbps`; ≤cap delivers free, cap..2×cap delivers
fully with queued latency proportional to the overage, >2×cap sheds to 2×cap. Blocked-path
demand still fires and is refused in full (misconfig is a live failure mode).

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/worldEngine/networkRuntime.test.ts
import { describe, it, expect } from 'vitest'
import { hopLatencyMs, applyNicCap, createNicState, refusedAttemptRate } from './networkRuntime'
import { createRng } from './rng'
import { createServer } from '../world/factories'
import { getPreset } from '../world/instanceCatalog'
import { interRegionLatencyMs } from '../regionConfig'
import { REGION_GEO, greatCircleKm } from '../world/regionGeo'
import type { CompiledPath, BlueprintDependency } from '../world/types'

const GEO = REGION_GEO

describe('hopLatencyMs', () => {
  it('localhost ~0.1ms within +-10% jitter', () => {
    const rng = createRng(1)
    for (let i = 0; i < 300; i++) {
      const v = hopLatencyMs('localhost', null, null, null, GEO, rng)
      expect(v).toBeGreaterThanOrEqual(0.09 - 1e-9)
      expect(v).toBeLessThanOrEqual(0.11 + 1e-9)
    }
  })

  it('same-az ~0.5ms and cross-az ~1.5ms within +-10% jitter', () => {
    const rng = createRng(2)
    for (let i = 0; i < 300; i++) {
      const az = hopLatencyMs('same-az', null, null, null, GEO, rng)
      expect(az).toBeGreaterThanOrEqual(0.45 - 1e-9)
      expect(az).toBeLessThanOrEqual(0.55 + 1e-9)
      const xaz = hopLatencyMs('cross-az', null, null, null, GEO, rng)
      expect(xaz).toBeGreaterThanOrEqual(1.35 - 1e-9)
      expect(xaz).toBeLessThanOrEqual(1.65 + 1e-9)
    }
  })

  it('cross-region uses the pure inter-region base +-10% (deterministic port)', () => {
    const rng = createRng(3)
    const base = interRegionLatencyMs('us-east-1', 'eu-west-1')
    expect(base).toBeGreaterThan(0)
    for (let i = 0; i < 300; i++) {
      const v = hopLatencyMs('cross-region', 'us-east-1', 'eu-west-1', null, GEO, rng)
      expect(v).toBeGreaterThanOrEqual(base * 0.9 - 1e-9)
      expect(v).toBeLessThanOrEqual(base * 1.1 + 1e-9)
    }
  })

  it('internet = great-circle km / 100 ms +-10% from the population to the region', () => {
    const rng = createRng(4)
    const nyc: [number, number] = [40.7, -74.0]
    const geo = GEO['us-east-1']
    const expected = greatCircleKm(nyc[0], nyc[1], geo.lat, geo.lon) / 100
    for (let i = 0; i < 300; i++) {
      const v = hopLatencyMs('internet', null, 'us-east-1', nyc, GEO, rng)
      expect(v).toBeGreaterThanOrEqual(expected * 0.9 - 1e-9)
      expect(v).toBeLessThanOrEqual(expected * 1.1 + 1e-9)
    }
  })

  it('is deterministic under the same seed', () => {
    const a = createRng(42)
    const b = createRng(42)
    expect(hopLatencyMs('cross-region', 'us-east-1', 'ap-southeast-2', null, GEO, a))
      .toBe(hopLatencyMs('cross-region', 'us-east-1', 'ap-southeast-2', null, GEO, b))
  })

  it('falls back to documented constants when geo inputs are missing', () => {
    const rng = createRng(5)
    for (let i = 0; i < 100; i++) {
      const xr = hopLatencyMs('cross-region', null, 'eu-west-1', null, GEO, rng)
      expect(xr).toBeGreaterThanOrEqual(72 - 1e-9)   // 80 +-10%
      expect(xr).toBeLessThanOrEqual(88 + 1e-9)
      const inet = hopLatencyMs('internet', null, 'us-east-1', null, GEO, rng)
      expect(inet).toBeGreaterThanOrEqual(36 - 1e-9) // 40 +-10%
      expect(inet).toBeLessThanOrEqual(44 + 1e-9)
    }
  })
})

describe('applyNicCap', () => {
  // vps-medium: nicMbps 1000 -> per-100ms-step budget = 1000e6/8 * 0.1 = 12_500_000 bytes
  const server = () => createServer('az-1', getPreset('vps-medium')!)
  const CAP = 12_500_000

  it('under cap: full delivery, no queued latency', () => {
    const state = createNicState()
    expect(applyNicCap(state, server(), CAP * 0.4, CAP * 0.4, 100))
      .toEqual({ deliveredFraction: 1, queuedLatencyMs: 0 })
  })

  it('between cap and 2x cap: full delivery with proportional queued latency', () => {
    const state = createNicState()
    const r = applyNicCap(state, server(), CAP * 1.5, 0, 100)
    expect(r.deliveredFraction).toBe(1)
    expect(r.queuedLatencyMs).toBeCloseTo(50, 5) // (1.5 - 1) * 100ms
  })

  it('beyond 2x cap: sheds to 2x cap with saturated queue latency', () => {
    const state = createNicState()
    const r = applyNicCap(state, server(), 0, CAP * 4, 100)
    expect(r.deliveredFraction).toBeCloseTo(0.5, 5) // 2 / 4
    expect(r.queuedLatencyMs).toBe(100)
  })

  it('accumulates within a step: two adds that jointly cross the cap start queueing', () => {
    const state = createNicState()
    expect(applyNicCap(state, server(), CAP * 0.7, 0, 100).queuedLatencyMs).toBe(0)
    const second = applyNicCap(state, server(), CAP * 0.7, 0, 100)
    expect(second.deliveredFraction).toBe(1)
    expect(second.queuedLatencyMs).toBeCloseTo(40, 5) // cumulative 1.4x cap -> (0.4)*100ms
  })
})

describe('refusedAttemptRate', () => {
  const mkPath = (dependencyId: string, verdict: 'permitted' | 'blocked', n: number): CompiledPath => ({
    id: `p-${dependencyId}-${n}`,
    dependencyId,
    fromInstanceId: 'i-1',
    to: { kind: 'instance', instanceId: `t-${n}` },
    hopClass: 'same-az',
    verdict,
    blockReason: verdict === 'blocked' ? { kind: 'firewall-deny', detail: 'test', firewallRuleId: null } : null,
  })
  const dep: BlueprintDependency = {
    id: 'dep-1', target: { kind: 'blueprint', blueprintId: 'bp-t' },
    port: 8080, protocol: 'http', packetTemplateId: null,
  }

  it('refuses the full demand when every target path is blocked', () => {
    const paths = [mkPath('dep-1', 'blocked', 0), mkPath('dep-1', 'blocked', 1)]
    expect(refusedAttemptRate(dep, paths, 200)).toBe(200)
  })

  it('refuses the blocked share when only some targets are blocked', () => {
    const paths = [mkPath('dep-1', 'blocked', 0), mkPath('dep-1', 'permitted', 1)]
    expect(refusedAttemptRate(dep, paths, 200)).toBe(100)
  })

  it('returns 0 with no blocked paths, and ignores other dependencies\' paths', () => {
    const paths = [mkPath('dep-1', 'permitted', 0), mkPath('dep-other', 'blocked', 1)]
    expect(refusedAttemptRate(dep, paths, 200)).toBe(0)
    expect(refusedAttemptRate(dep, [], 200)).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/worldEngine/networkRuntime.test.ts`
Expected: FAIL — `Cannot find module './networkRuntime'`

- [ ] **Step 3: Write `networkRuntime.ts`**

```ts
// src/lib/worldEngine/networkRuntime.ts
// Runtime network model: per-hop latency sampling, NIC throughput caps, blocked-path
// refusals. Spec decision 6, docs/superpowers/specs/2026-07-08-phase2-substrate-engine-design.md.
import type { HopClass, CompiledPath, BlueprintDependency, Server } from '../world/types'
import type { Rng } from './rng'
import { interRegionLatencyMs } from '../regionConfig'
import { greatCircleKm } from '../world/regionGeo'

const LOCALHOST_MS = 0.1
const SAME_AZ_MS = 0.5
const CROSS_AZ_MS = 1.5
const HOP_JITTER_FRACTION = 0.1     // every hop class jitters +-10%
const INTERNET_KM_PER_MS = 100      // client->region: ~1ms per 100km great-circle
const INTERNET_FALLBACK_MS = 40     // population/geo unknown — plausible mid-continent RTT half
const CROSS_REGION_FALLBACK_MS = 80 // catalog id unknown — AMER<->EMEA-magnitude default

const jitter = (base: number, rng: Rng): number =>
  Math.max(0, base * (1 + rng.range(-HOP_JITTER_FRACTION, HOP_JITTER_FRACTION)))

// Cross-region intentionally uses the PURE interRegionLatencyMs + rng jitter rather than
// regionConfig's sampleInterRegionLatencyMs (which calls Math.random — forbidden inside
// worldEngine). Identical distribution, deterministic under seed. SKELETON CONCERNS #1.
export function hopLatencyMs(
  hopClass: HopClass | 'internet',
  fromRegionCatalogId: string | null,
  toRegionCatalogId: string | null,
  popLatLon: [number, number] | null,
  regionGeo: Record<string, { lat: number; lon: number }>,
  rng: Rng,
): number {
  switch (hopClass) {
    case 'localhost':
      return jitter(LOCALHOST_MS, rng)
    case 'same-az':
      return jitter(SAME_AZ_MS, rng)
    case 'cross-az':
      return jitter(CROSS_AZ_MS, rng)
    case 'cross-region': {
      if (!fromRegionCatalogId || !toRegionCatalogId) return jitter(CROSS_REGION_FALLBACK_MS, rng)
      const base = interRegionLatencyMs(fromRegionCatalogId, toRegionCatalogId)
      return jitter(base > 0 ? base : CROSS_REGION_FALLBACK_MS, rng)
    }
    case 'internet': {
      const geo = toRegionCatalogId ? regionGeo[toRegionCatalogId] : undefined
      if (!popLatLon || !geo) return jitter(INTERNET_FALLBACK_MS, rng)
      const km = greatCircleKm(popLatLon[0], popLatLon[1], geo.lat, geo.lon)
      return jitter(km / INTERNET_KM_PER_MS, rng)
    }
  }
}

// ─── NIC caps ─────────────────────────────────────────────────────────────────

export interface NicState {
  inBytesThisStep: number
  outBytesThisStep: number
}

export function createNicState(): NicState {
  return { inBytesThisStep: 0, outBytesThisStep: 0 }
}

// Accumulates this call's bytes into the step's running totals, then evaluates the
// cumulative load against the per-step budget (worst direction governs):
//   <= cap        -> deliveredFraction 1, no added latency
//   cap .. 2xcap  -> still delivers fully; excess waits, queuedLatencyMs grows linearly
//                    from 0 at cap to stepMs at 2xcap
//   >  2xcap      -> sheds to 2xcap (deliveredFraction = 2xcap / load), queue saturated
export function applyNicCap(
  state: NicState,
  server: Server,
  addInBytes: number,
  addOutBytes: number,
  stepMs: number,
): { deliveredFraction: number; queuedLatencyMs: number } {
  state.inBytesThisStep += addInBytes
  state.outBytesThisStep += addOutBytes
  const capBytes = ((server.specs.nicMbps * 1e6) / 8) * (stepMs / 1000)
  if (capBytes <= 0) return { deliveredFraction: 0, queuedLatencyMs: stepMs }
  const load = Math.max(state.inBytesThisStep, state.outBytesThisStep)
  const ratio = load / capBytes
  if (ratio <= 1) return { deliveredFraction: 1, queuedLatencyMs: 0 }
  if (ratio <= 2) return { deliveredFraction: 1, queuedLatencyMs: (ratio - 1) * stepMs }
  return { deliveredFraction: 2 / ratio, queuedLatencyMs: stepMs }
}

// ─── Blocked-path refusals ────────────────────────────────────────────────────

// Demand attempted down blocked paths still fires (spec decision 6) — misconfig is a live
// failure mode, not just a compile finding. Convention (SKELETON CONCERNS #2): pass EVERY
// compiled path for this (caller, dependency) pair; demand splits evenly across them and
// the share landing on blocked targets is refused in full.
export function refusedAttemptRate(
  dep: BlueprintDependency,
  blockedPaths: CompiledPath[],
  demandRps: number,
): number {
  const depPaths = blockedPaths.filter(p => p.dependencyId === dep.id)
  if (depPaths.length === 0) return 0
  const blocked = depPaths.filter(p => p.verdict === 'blocked').length
  return demandRps * (blocked / depPaths.length)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/worldEngine/networkRuntime.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: tsc check**

Run: `npm run build`
Expected: succeeds

- [ ] **Step 6: Commit**

```bash
git add src/lib/worldEngine/networkRuntime.ts src/lib/worldEngine/networkRuntime.test.ts
git commit -m "feat(engine): add network runtime (hop latency, NIC caps, refused paths)"
```

---

### Task 7: Circuit breakers (port)

**Files:**
- Create: `src/lib/worldEngine/breakers.ts`
- Test: `src/lib/worldEngine/breakers.test.ts`

**Interfaces:**
- Consumes: nothing engine-side (leaf state machine; pure port of
  `src/app/canvas/simulation/particleEngine/circuitBreakers.ts` semantics, re-keyed per
  `pathKey`, `simMs` injected instead of `Date.now()`, no event emission — the facade
  (T12) emits `breaker_open/half_open/closed` by observing state changes).
- Produces:

```ts
type BreakerState = 'closed' | 'open' | 'half-open'
interface BreakerConfig { errorThreshold: number; windowSize: number; resetMs: number }
DEFAULT_BREAKER_CONFIG: BreakerConfig            // { errorThreshold: 0.5, windowSize: 20, resetMs: 10_000 }
interface Breaker { state: BreakerState; openedAt: number; errorWindow: number[]; trialPending: boolean; config: BreakerConfig }
pathKey(fromInstanceId: string, dependencyId: string): string   // `${fromInstanceId}->${dependencyId}`
getBreaker(map: Map<string, Breaker>, key: string, config?: BreakerConfig): Breaker
recordResult(breaker: Breaker, failed: boolean, simMs: number): void
transition(breaker: Breaker, simMs: number): BreakerState
admitRequest(breaker: Breaker): boolean          // additive helper — see SKELETON CONCERNS #6
clearBreakers(map: Map<string, Breaker>): void
```

Ported semantics (keep exactly): closed→open when windowed error rate ≥ `errorThreshold`
AND at least `MIN_SAMPLES_TO_OPEN` (10) samples exist (window capped at `windowSize` 20,
oldest dropped); open→half-open after `resetMs` elapses (via `transition`); half-open
admits exactly ONE trial (`trialPending` claimed by `admitRequest`): trial success →
closed + window cleared, trial failure → open with fresh `openedAt`; `trialPending`
resets whenever the breaker enters or leaves half-open. Legacy's force-open-on-down and
health-gated reset are NOT ported here — the flow solver already zeroes a down target's
subtree and failover owns health; the facade composes those behaviors.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/worldEngine/breakers.test.ts
import { describe, it, expect } from 'vitest'
import {
  getBreaker, recordResult, transition, admitRequest, clearBreakers, pathKey,
  DEFAULT_BREAKER_CONFIG,
} from './breakers'
import type { Breaker } from './breakers'

function freshBreaker(): { map: Map<string, Breaker>; b: Breaker } {
  const map = new Map<string, Breaker>()
  const b = getBreaker(map, pathKey('i-1', 'dep-1'))
  return { map, b }
}

describe('breakers — state cycle', () => {
  it('runs the full cycle: closed -> open -> half-open -> closed on trial success', () => {
    const { b } = freshBreaker()
    expect(b.state).toBe('closed')
    for (let i = 0; i < 10; i++) recordResult(b, true, 1000)
    expect(b.state).toBe('open')
    expect(b.openedAt).toBe(1000)

    expect(transition(b, 5_000)).toBe('open')          // resetMs (10s) not yet elapsed
    expect(transition(b, 11_001)).toBe('half-open')    // > openedAt + resetMs

    expect(admitRequest(b)).toBe(true)                 // the single trial
    recordResult(b, false, 11_100)                     // trial succeeds
    expect(b.state).toBe('closed')
    expect(b.errorWindow).toEqual([])                  // window cleared on close
  })

  it('reopens with a fresh openedAt when the half-open trial fails', () => {
    const { b } = freshBreaker()
    for (let i = 0; i < 10; i++) recordResult(b, true, 1000)
    transition(b, 11_001)
    expect(b.state).toBe('half-open')
    admitRequest(b)
    recordResult(b, true, 11_200)                      // trial fails
    expect(b.state).toBe('open')
    expect(b.openedAt).toBe(11_200)
    expect(transition(b, 21_000)).toBe('open')         // new resetMs window from 11_200
    expect(transition(b, 21_201)).toBe('half-open')
  })

  it('half-open admits exactly one trial until it resolves', () => {
    const { b } = freshBreaker()
    for (let i = 0; i < 10; i++) recordResult(b, true, 0)
    transition(b, 10_001)
    expect(admitRequest(b)).toBe(true)    // claims the trial
    expect(admitRequest(b)).toBe(false)   // second caller refused
    expect(admitRequest(b)).toBe(false)
    recordResult(b, false, 10_100)        // trial resolves -> closed
    expect(admitRequest(b)).toBe(true)    // closed admits freely again
  })

  it('closed always admits; open never admits', () => {
    const { b } = freshBreaker()
    expect(admitRequest(b)).toBe(true)
    for (let i = 0; i < 10; i++) recordResult(b, true, 0)
    expect(b.state).toBe('open')
    expect(admitRequest(b)).toBe(false)
    expect(admitRequest(b)).toBe(false)
  })
})

describe('breakers — window behavior', () => {
  it('never opens below the 10-sample minimum even at 100% errors', () => {
    const { b } = freshBreaker()
    for (let i = 0; i < 9; i++) recordResult(b, true, 0)
    expect(b.state).toBe('closed')
    recordResult(b, true, 0)              // 10th sample crosses the minimum
    expect(b.state).toBe('open')
  })

  it('stays closed under the error threshold and caps the window at 20 samples', () => {
    const { b } = freshBreaker()
    // 20 successes, then 9 failures: window holds the last 20 -> 9/20 = 0.45 < 0.5
    for (let i = 0; i < 20; i++) recordResult(b, false, 0)
    for (let i = 0; i < 9; i++) recordResult(b, true, 0)
    expect(b.errorWindow.length).toBe(20)
    expect(b.state).toBe('closed')
    recordResult(b, true, 0)              // 10/20 = 0.5 >= threshold
    expect(b.state).toBe('open')
  })

  it('getBreaker creates once and reuses; clearBreakers empties the map', () => {
    const map = new Map<string, Breaker>()
    const a = getBreaker(map, 'k1')
    expect(getBreaker(map, 'k1')).toBe(a)
    expect(a.config).toEqual(DEFAULT_BREAKER_CONFIG)
    getBreaker(map, 'k2', { errorThreshold: 0.2, windowSize: 20, resetMs: 5_000 })
    expect(map.size).toBe(2)
    expect(getBreaker(map, 'k2').config.errorThreshold).toBe(0.2)
    clearBreakers(map)
    expect(map.size).toBe(0)
  })

  it('pathKey formats `${fromInstanceId}->${dependencyId}`', () => {
    expect(pathKey('pl-1#0', 'dep-9')).toBe('pl-1#0->dep-9')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/worldEngine/breakers.test.ts`
Expected: FAIL — `Cannot find module './breakers'`

- [ ] **Step 3: Write `breakers.ts`**

```ts
// src/lib/worldEngine/breakers.ts
// Circuit breaker state machine — a pure port of the legacy
// src/app/canvas/simulation/particleEngine/circuitBreakers.ts semantics (spec decision 2:
// ports, not rewrites), with three deliberate changes and NO behavioral ones:
//   1. keyed per pathKey `${fromInstanceId}->${dependencyId}` instead of per edge id,
//   2. simMs injected instead of Date.now(),
//   3. no event emission / node lookups — the facade (Task 12) observes state changes and
//      emits breaker_open / breaker_half_open / breaker_closed itself.
// Legacy force-open-on-down and health-gated reset are intentionally not here: flows.ts
// zeroes a down target's subtree and failover.ts owns health.

export type BreakerState = 'closed' | 'open' | 'half-open'

export interface BreakerConfig {
  errorThreshold: number   // windowed error rate that opens the breaker
  windowSize: number       // rolling sample window length
  resetMs: number          // open -> half-open cooldown
}

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  errorThreshold: 0.5,
  windowSize: 20,
  resetMs: 10_000,
}

// Legacy guard (circuitBreakers.ts:74): never open on a thin window — at least this many
// samples must exist before the threshold check can trip.
const MIN_SAMPLES_TO_OPEN = 10

export interface Breaker {
  state: BreakerState
  openedAt: number         // simMs when last opened
  errorWindow: number[]    // 1 = failure, 0 = success; capped at config.windowSize
  // While half-open: whether the single allowed trial has been claimed (admitRequest) and
  // is in flight. Reset on every entry to/exit from half-open.
  trialPending: boolean
  config: BreakerConfig
}

export function pathKey(fromInstanceId: string, dependencyId: string): string {
  return `${fromInstanceId}->${dependencyId}`
}

export function getBreaker(
  map: Map<string, Breaker>,
  key: string,
  config: BreakerConfig = DEFAULT_BREAKER_CONFIG,
): Breaker {
  let b = map.get(key)
  if (!b) {
    b = { state: 'closed', openedAt: 0, errorWindow: [], trialPending: false, config }
    map.set(key, b)
  }
  return b
}

export function recordResult(breaker: Breaker, failed: boolean, simMs: number): void {
  breaker.errorWindow.push(failed ? 1 : 0)
  if (breaker.errorWindow.length > breaker.config.windowSize) {
    breaker.errorWindow.splice(0, breaker.errorWindow.length - breaker.config.windowSize)
  }

  if (breaker.state === 'closed') {
    const errRate =
      breaker.errorWindow.reduce((s, v) => s + v, 0) / breaker.errorWindow.length
    if (errRate >= breaker.config.errorThreshold && breaker.errorWindow.length >= MIN_SAMPLES_TO_OPEN) {
      breaker.state = 'open'
      breaker.openedAt = simMs
      breaker.trialPending = false
    }
  } else if (breaker.state === 'half-open') {
    breaker.trialPending = false // the trial resolved one way or the other
    if (!failed) {
      breaker.state = 'closed'
      breaker.errorWindow = []
    } else {
      breaker.state = 'open'
      breaker.openedAt = simMs
    }
  }
}

export function transition(breaker: Breaker, simMs: number): BreakerState {
  if (breaker.state === 'open' && simMs - breaker.openedAt > breaker.config.resetMs) {
    breaker.state = 'half-open'
    breaker.trialPending = false // fresh half-open window — no trial claimed yet
  }
  return breaker.state
}

// May a request proceed through this breaker right now? closed: always. open: never.
// half-open: exactly once — the first caller claims the trial (side effect: sets
// trialPending), everyone else is refused until recordResult resolves it.
// This is the gate flows.ts's breakerOpen callback inverts. SKELETON CONCERNS #6.
export function admitRequest(breaker: Breaker): boolean {
  if (breaker.state === 'closed') return true
  if (breaker.state === 'half-open' && !breaker.trialPending) {
    breaker.trialPending = true
    return true
  }
  return false
}

export function clearBreakers(map: Map<string, Breaker>): void {
  map.clear()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/worldEngine/breakers.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: tsc check**

Run: `npm run build`
Expected: succeeds

- [ ] **Step 6: Commit**

```bash
git add src/lib/worldEngine/breakers.ts src/lib/worldEngine/breakers.test.ts
git commit -m "feat(engine): port circuit breakers keyed per dependency path"
```

---

### Task 8: Flow solver

**Files:**
- Create: `src/lib/worldEngine/flows.ts`
- Test: `src/lib/worldEngine/flows.test.ts`

**Interfaces:**
- Consumes: `CompiledWorld, WorldDoc, CompiledPath, InstanceId, ServerId, HopClass` from
  `../world/types`; `HealthState` from `./types`; `Rng` from `./rng`; `sampleLatencyMs`
  from `./latency` (T4); `pathKey` from `./breakers` (T7). Tests build fixtures with the
  real `../world/factories` + `compileWorld`.
- Produces (shapes verbatim from the skeleton):

```ts
interface FlowInput {
  compiled: CompiledWorld; doc: WorldDoc
  entryDemand: Record<InstanceId, number>          // rps landed on entry instances this step (from routing)
  admittedScaleByServer: Record<ServerId, number>  // from host scheduler (previous sub-step)
  latencyMultiplierByServer: Record<ServerId, number>
  breakerOpen: (pathKey: string) => boolean
  healthOf: (instanceId: InstanceId) => HealthState
  rng: Rng
}
interface InstanceFlow {
  instanceId: InstanceId
  offeredRps: number; admittedRps: number; errorRps: number; refusedRps: number
  serviceLatencyMs: number                          // sampled, multiplied
  downstream: { dependencyId: string; toInstanceId?: InstanceId; toManagedServiceId?: string; rps: number; hopClass: HopClass; blocked: boolean }[]
}
solveFlows(input: FlowInput): { flows: Record<InstanceId, InstanceFlow>; totals: { crossAzBytes: number; crossRegionBytes: number; internetBytes: number } }
BYTES_PER_REQUEST_EACH_WAY = 2048                  // named const, both directions counted
MANAGED_SERVICE_LATENCY_MS = 3                     // for T10/T11 consumers
```

Semantics (spec decision 6 + skeleton T8, all load-bearing):

- **BFS from entry instances** (keys of `entryDemand`) along compiled paths, contribution
  by contribution. Depth capped at **8**: a contribution arriving at depth 8 still lands on
  the instance (offered/admitted accounted) but fans out no further. Cycles guarded by a
  **visited set per request chain** ("request class" = the chain from one entry
  contribution): a downstream row is still recorded for a back-edge, but the demand is not
  re-propagated into an already-visited instance.
- **Admission:** `admitted = offered × admittedScaleByServer[serverId] (default 1) ×
  healthFactor` where healthFactor is down→0, degraded→0.7, healthy→1.
  `errorRps = offered − admitted` (shed + down demand errors at this instance). A down
  instance therefore zeroes its whole subtree.
- **Fan-out:** every dependency receives the FULL admitted rps (call-per-request model,
  like legacy), split **evenly across all of that dependency's compiled target paths —
  blocked ones included** (the caller can't see the misconfig; that's decision 6).
- **Blocked paths:** the blocked share adds to the CALLER's `refusedRps` and produces a
  `blocked: true` downstream row (events/particles render the refused burst from it); no
  bytes, no propagation.
- **Breakers:** `breakerOpen(pathKey(instanceId, dep.id))` short-circuits the ENTIRE
  dependency (per-dependency key): full admitted rps added to `refusedRps`, no downstream
  rows for that dependency.
- **Managed targets:** downstream row with `toManagedServiceId`, no capacity model in
  Phase 2 (fixed `MANAGED_SERVICE_LATENCY_MS = 3` exported for metrics/tracing); bytes
  bucketed like any hop.
- **Bytes:** `BYTES_PER_REQUEST_EACH_WAY = 2048` (2KB) per request **in each direction**
  (request + response ⇒ ×2) — a deliberately simple Phase-2 constant; packet templates
  refine per-protocol sizes in a later phase. Bucketed by hopClass: `cross-az` →
  `crossAzBytes`, `cross-region` → `crossRegionBytes`; localhost/same-az transfer is free
  and uncounted. Entry demand rides the public internet → `internetBytes`. Totals are
  bytes **per second** (inputs are rps); the facade integrates per step.
- **serviceLatencyMs:** sampled once per instance on first touch via
  `sampleLatencyMs(p50, p99, rng)` with `p50 = workload.cpuMsPerRequest`,
  `p99 = SERVICE_P99_OVER_P50 × p50` (see SKELETON CONCERNS #5), then multiplied by
  `latencyMultiplierByServer[serverId]`.
- Deterministic: BFS order is fixed by `entryDemand` key order + compiled path order, so a
  seeded rng reproduces identical outputs.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/worldEngine/flows.test.ts
import { describe, it, expect } from 'vitest'
import { solveFlows, BYTES_PER_REQUEST_EACH_WAY, MANAGED_SERVICE_LATENCY_MS } from './flows'
import type { FlowInput } from './flows'
import { pathKey } from './breakers'
import { createRng } from './rng'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
} from '../world/factories'
import { getPreset } from '../world/instanceCatalog'
import { compileWorld, instanceId } from '../world/compileWorld'
import type { WorldDoc, ServiceBlueprint, BlueprintDependency } from '../world/types'
import type { HealthState } from './types'

// ─── Fixture helpers (real lib/world factories through a real compile) ────────

function dep(id: string, targetBpId: string): BlueprintDependency {
  return { id, target: { kind: 'blueprint', blueprintId: targetBpId }, port: 8080, protocol: 'http', packetTemplateId: null }
}

// One region, one AZ, one server; blueprints wired by the caller. Default factory
// blueprints bind port 8080 and the default firewall allows all internal traffic, so
// same-server paths compile permitted with hopClass 'localhost'.
function oneServerWorld() {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const az = createAz(region.id, 'us-east-1a')
  const server = createServer(az.id, getPreset('dedicated-8')!)
  doc.regions[region.id] = region
  doc.azs[az.id] = az
  doc.servers[server.id] = server
  return { doc, region, az, server }
}

function addService(doc: WorldDoc, name: string, serverId: string, colorIndex = 0) {
  const bp = createBlueprint(name, colorIndex)
  doc.blueprints[bp.id] = bp
  const pl = createPlacement(bp.id, serverId)
  doc.placements[pl.id] = pl
  return { bp, pl, iid: instanceId(pl.id, 0) }
}

function baseInput(doc: WorldDoc, entryDemand: Record<string, number>, overrides: Partial<FlowInput> = {}): FlowInput {
  return {
    compiled: compileWorld(doc),
    doc,
    entryDemand,
    admittedScaleByServer: {},
    latencyMultiplierByServer: {},
    breakerOpen: () => false,
    healthOf: () => 'healthy',
    rng: createRng(11),
    ...overrides,
  }
}

describe('solveFlows — propagation', () => {
  it('propagates full rps down a linear chain (api -> svc -> db)', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const svc = addService(doc, 'svc', server.id, 1)
    const db = addService(doc, 'db', server.id, 2)
    api.bp.dependencies = [dep('d-svc', svc.bp.id)]
    svc.bp.dependencies = [dep('d-db', db.bp.id)]

    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 100 }))
    expect(flows[api.iid]).toMatchObject({ offeredRps: 100, admittedRps: 100, errorRps: 0, refusedRps: 0 })
    expect(flows[svc.iid]).toMatchObject({ offeredRps: 100, admittedRps: 100 })
    expect(flows[db.iid]).toMatchObject({ offeredRps: 100, admittedRps: 100 })
    expect(flows[api.iid].downstream).toEqual([
      { dependencyId: 'd-svc', toInstanceId: svc.iid, rps: 100, hopClass: 'localhost', blocked: false },
    ])
    expect(flows[db.iid].downstream).toEqual([])
  })

  it('fans out the FULL admitted rps to every dependency (call-per-request model)', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const cache = addService(doc, 'cache', server.id, 1)
    const db = addService(doc, 'db', server.id, 2)
    api.bp.dependencies = [dep('d-cache', cache.bp.id), dep('d-db', db.bp.id)]

    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 100 }))
    expect(flows[cache.iid].offeredRps).toBe(100)   // duplicated, not split across deps
    expect(flows[db.iid].offeredRps).toBe(100)
    expect(flows[api.iid].downstream).toHaveLength(2)
  })

  it('splits one dependency\'s demand evenly across multiple target instances', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const bp = createBlueprint('svc', 1)
    doc.blueprints[bp.id] = bp
    const pl = createPlacement(bp.id, server.id)
    pl.count = 2
    doc.placements[pl.id] = pl
    api.bp.dependencies = [dep('d-svc', bp.id)]

    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 100 }))
    expect(flows[instanceId(pl.id, 0)].offeredRps).toBe(50)
    expect(flows[instanceId(pl.id, 1)].offeredRps).toBe(50)
    const rows = flows[api.iid].downstream
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row.rps).toBe(50)
  })

  it('applies the server admittedScale and books the shed demand as errorRps', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const db = addService(doc, 'db', server.id, 1)
    api.bp.dependencies = [dep('d-db', db.bp.id)]

    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 100 }, {
      admittedScaleByServer: { [server.id]: 0.5 },
    }))
    expect(flows[api.iid].admittedRps).toBe(50)
    expect(flows[api.iid].errorRps).toBe(50)
    // downstream fans out the ADMITTED rps, then db admits 0.5 of ITS offered again
    expect(flows[api.iid].downstream[0].rps).toBe(50)
    expect(flows[db.iid].offeredRps).toBe(50)
    expect(flows[db.iid].admittedRps).toBe(25)
  })

  it('a degraded instance admits 0.7x of offered', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const healthOf = (id: string): HealthState => (id === api.iid ? 'degraded' : 'healthy')
    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 100 }, { healthOf }))
    expect(flows[api.iid].admittedRps).toBeCloseTo(70, 9)
    expect(flows[api.iid].errorRps).toBeCloseTo(30, 9)
  })

  it('a down instance zeroes its whole subtree', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const svc = addService(doc, 'svc', server.id, 1)
    const db = addService(doc, 'db', server.id, 2)
    api.bp.dependencies = [dep('d-svc', svc.bp.id)]
    svc.bp.dependencies = [dep('d-db', db.bp.id)]
    const healthOf = (id: string): HealthState => (id === svc.iid ? 'down' : 'healthy')

    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 100 }, { healthOf }))
    expect(flows[svc.iid]).toMatchObject({ offeredRps: 100, admittedRps: 0, errorRps: 100 })
    expect(flows[svc.iid].downstream).toEqual([])   // nothing fans out of a down instance
    expect(flows[db.iid]).toBeUndefined()           // subtree never reached
  })
})

describe('solveFlows — refusals', () => {
  it('blocked paths refuse at the CALLER, emit a blocked row, and never reach the target', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    // db as a separate server so the target firewall applies, then deny its port.
    const db2srv = createServer(doc.servers[server.id].azId, getPreset('dedicated-8')!)
    db2srv.firewall = [{ id: 'deny-all', action: 'deny', port: 'any', protocol: 'any', source: 'any' }]
    doc.servers[db2srv.id] = db2srv
    const db = addService(doc, 'db', db2srv.id, 1)
    api.bp.dependencies = [dep('d-db', db.bp.id)]

    const input = baseInput(doc, { [api.iid]: 100 })
    expect(input.compiled.paths[0].verdict).toBe('blocked')   // fixture sanity
    const { flows, totals } = solveFlows(input)
    expect(flows[api.iid].refusedRps).toBe(100)
    expect(flows[api.iid].downstream).toEqual([
      { dependencyId: 'd-db', toInstanceId: db.iid, rps: 100, hopClass: 'same-az', blocked: true },
    ])
    expect(flows[db.iid]).toBeUndefined()
    expect(totals.crossAzBytes).toBe(0)   // refused attempts carry no payload
  })

  it('an open breaker short-circuits the whole dependency: refused, NO downstream rows', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const db = addService(doc, 'db', server.id, 1)
    api.bp.dependencies = [dep('d-db', db.bp.id)]

    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 100 }, {
      breakerOpen: key => key === pathKey(api.iid, 'd-db'),
    }))
    expect(flows[api.iid].refusedRps).toBe(100)
    expect(flows[api.iid].downstream).toEqual([])
    expect(flows[db.iid]).toBeUndefined()
  })
})

describe('solveFlows — depth, cycles, managed', () => {
  it('caps propagation at depth 8: the 9th hop lands, the 10th is never offered', () => {
    const { doc, server } = oneServerWorld()
    // Chain of 11 services: s0 -> s1 -> ... -> s10. Depths: s0=0 ... s10=10.
    const services = Array.from({ length: 11 }, (_, i) => addService(doc, `s${i}`, server.id, i))
    for (let i = 0; i < 10; i++) {
      services[i].bp.dependencies = [dep(`d-${i}`, services[i + 1].bp.id)]
    }
    const { flows } = solveFlows(baseInput(doc, { [services[0].iid]: 100 }))
    expect(flows[services[8].iid]).toMatchObject({ offeredRps: 100 })  // depth 8 still lands
    expect(flows[services[8].iid].downstream).toEqual([])              // but fans out no further
    expect(flows[services[9].iid]).toBeUndefined()
    expect(flows[services[10].iid]).toBeUndefined()
  })

  it('guards cycles: a -> b -> a terminates and never re-inflates the entry', () => {
    const { doc, server } = oneServerWorld()
    const a = addService(doc, 'a', server.id, 0)
    const b = addService(doc, 'b', server.id, 1)
    a.bp.dependencies = [dep('d-ab', b.bp.id)]
    b.bp.dependencies = [dep('d-ba', a.bp.id)]

    const { flows } = solveFlows(baseInput(doc, { [a.iid]: 100 }))
    expect(flows[a.iid].offeredRps).toBe(100)   // the back-edge did NOT re-offer demand
    expect(flows[b.iid].offeredRps).toBe(100)
    // the back-edge is still visible as a downstream row (particles/edges render it)
    expect(flows[b.iid].downstream).toEqual([
      { dependencyId: 'd-ba', toInstanceId: a.iid, rps: 100, hopClass: 'localhost', blocked: false },
    ])
  })

  it('managed targets get a downstream row, no flow record, and a fixed-latency export', () => {
    const { doc, server, az } = oneServerWorld()
    doc.managedServices['ms-1'] = {
      id: 'ms-1', label: 'RDS', nodeType: 'rds',
      scope: { kind: 'az', azId: az.id }, provider: 'aws', port: 5432,
    }
    const api = addService(doc, 'api', server.id, 0)
    api.bp.dependencies = [{ id: 'd-ms', target: { kind: 'managed', managedServiceId: 'ms-1' }, port: 5432, protocol: 'db', packetTemplateId: null }]

    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 100 }))
    expect(flows[api.iid].downstream).toEqual([
      { dependencyId: 'd-ms', toManagedServiceId: 'ms-1', rps: 100, hopClass: 'same-az', blocked: false },
    ])
    expect(flows['ms-1']).toBeUndefined()
    expect(MANAGED_SERVICE_LATENCY_MS).toBe(3)
  })
})

describe('solveFlows — byte totals and latency', () => {
  it('buckets bytes by hopClass at 2KB per request both directions; entry demand is internet', () => {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    const region2 = createRegion('eu-west-1')
    const az1 = createAz(region.id, 'us-east-1a')
    const az2 = createAz(region.id, 'us-east-1b')
    const azEu = createAz(region2.id, 'eu-west-1a')
    Object.assign(doc.regions, { [region.id]: region, [region2.id]: region2 })
    Object.assign(doc.azs, { [az1.id]: az1, [az2.id]: az2, [azEu.id]: azEu })
    const s1 = createServer(az1.id, getPreset('dedicated-8')!)
    const s2 = createServer(az2.id, getPreset('dedicated-8')!)
    const s3 = createServer(azEu.id, getPreset('dedicated-8')!)
    Object.assign(doc.servers, { [s1.id]: s1, [s2.id]: s2, [s3.id]: s3 })

    const api = addService(doc, 'api', s1.id, 0)
    const svc = addService(doc, 'svc', s2.id, 1)     // cross-az from api
    const repl = addService(doc, 'repl', s3.id, 2)   // cross-region from api
    api.bp.dependencies = [dep('d-svc', svc.bp.id), dep('d-repl', repl.bp.id)]

    const { totals } = solveFlows(baseInput(doc, { [api.iid]: 100 }))
    const perHop = 100 * BYTES_PER_REQUEST_EACH_WAY * 2   // rps x 2KB x both directions
    expect(totals.internetBytes).toBe(perHop)             // client -> entry
    expect(totals.crossAzBytes).toBe(perHop)
    expect(totals.crossRegionBytes).toBe(perHop)
  })

  it('same-az and localhost hops cost no bytes', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const db = addService(doc, 'db', server.id, 1)   // same server: localhost
    api.bp.dependencies = [dep('d-db', db.bp.id)]
    const { totals } = solveFlows(baseInput(doc, { [api.iid]: 100 }))
    expect(totals.crossAzBytes).toBe(0)
    expect(totals.crossRegionBytes).toBe(0)
    expect(totals.internetBytes).toBe(100 * BYTES_PER_REQUEST_EACH_WAY * 2)
  })

  it('serviceLatencyMs scales with the server latency multiplier (same seed, 2x multiplier)', () => {
    const mkWorld = () => {
      const { doc, server } = oneServerWorld()
      const api = addService(doc, 'api', server.id, 0)
      return { doc, server, api }
    }
    const w1 = mkWorld()
    const base = solveFlows(baseInput(w1.doc, { [w1.api.iid]: 100 }, { rng: createRng(5) }))
    const w2 = mkWorld()
    const doubled = solveFlows(baseInput(w2.doc, { [w2.api.iid]: 100 }, {
      rng: createRng(5),
      latencyMultiplierByServer: { [w2.server.id]: 2 },
    }))
    const l1 = base.flows[w1.api.iid].serviceLatencyMs
    const l2 = doubled.flows[w2.api.iid].serviceLatencyMs
    expect(l1).toBeGreaterThan(0)
    expect(l2).toBeCloseTo(l1 * 2, 9)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/worldEngine/flows.test.ts`
Expected: FAIL — `Cannot find module './flows'`

- [ ] **Step 3: Write `flows.ts`**

```ts
// src/lib/worldEngine/flows.ts
// Per-step flow solver: contribution-based BFS from entry instances across compiled paths.
// The heart of the engine — everything downstream (host loads, metrics, particles, cost
// bytes) reads this module's output. Spec decision 6 + skeleton T8 semantics:
//   admitted = offered x admittedScale(server) x healthFactor (down 0 / degraded 0.7)
//   every dependency fans out the FULL admitted rps (call-per-request, like legacy),
//   split evenly across the dependency's compiled targets — blocked ones included
//   (the caller can't see the misconfig; attempts on blocked paths are LIVE failures)
//   blocked share -> caller refusedRps + blocked downstream row (no bytes, no propagation)
//   breakerOpen(pathKey) short-circuits the whole dependency (refused, no rows)
//   depth cap 8; cycles guarded per request chain (visited set carried on each item)
import type {
  CompiledWorld, WorldDoc, CompiledPath, InstanceId, ServerId, HopClass,
} from '../world/types'
import type { HealthState } from './types'
import type { Rng } from './rng'
import { sampleLatencyMs } from './latency'
import { pathKey } from './breakers'

// 2KB per request in EACH direction (request out + response back, so every hop books
// 2 x 2048 bytes per request). A deliberately simple Phase-2 constant — packet templates
// refine per-protocol sizes in a later phase. Totals are bytes/sec (inputs are rps).
export const BYTES_PER_REQUEST_EACH_WAY = 2048

// Managed targets have no capacity model in Phase 2: fixed service latency, always
// admits. Exported for metrics (T10) and tracing (T11) to attribute managed-hop time.
export const MANAGED_SERVICE_LATENCY_MS = 3

const MAX_DEPTH = 8                 // hop-depth cap; demand landing at depth 8 stops there
const DEGRADED_ADMIT_FACTOR = 0.7   // degraded instances still serve most of their load
const EPSILON_RPS = 1e-9            // below this, a contribution is dead — don't propagate
// Blueprints carry no authored latency model (only workload.cpuMsPerRequest), so service
// latency samples log-normal with p50 = cpuMsPerRequest and this p99 spread — legacy
// NODE_SIM_DEFAULTS spreads ran 10-12.5x. SKELETON CONCERNS #5.
const SERVICE_P99_OVER_P50 = 10

export interface FlowInput {
  compiled: CompiledWorld
  doc: WorldDoc
  entryDemand: Record<InstanceId, number>          // rps landed on entry instances this step (from routing)
  admittedScaleByServer: Record<ServerId, number>  // from host scheduler (previous sub-step)
  latencyMultiplierByServer: Record<ServerId, number>
  breakerOpen: (pathKey: string) => boolean
  healthOf: (instanceId: InstanceId) => HealthState
  rng: Rng
}

export interface DownstreamFlow {
  dependencyId: string
  toInstanceId?: InstanceId
  toManagedServiceId?: string
  rps: number
  hopClass: HopClass
  blocked: boolean
}

export interface InstanceFlow {
  instanceId: InstanceId
  offeredRps: number
  admittedRps: number
  errorRps: number
  refusedRps: number
  serviceLatencyMs: number                          // sampled, multiplied
  downstream: DownstreamFlow[]
}

export interface FlowTotals {
  crossAzBytes: number
  crossRegionBytes: number
  internetBytes: number
}

interface QueueItem {
  instanceId: InstanceId
  offered: number
  depth: number
  visited: Set<InstanceId>   // instances already on this request chain (cycle guard)
}

export function solveFlows(input: FlowInput): { flows: Record<InstanceId, InstanceFlow>; totals: FlowTotals } {
  const {
    compiled, doc, entryDemand, admittedScaleByServer, latencyMultiplierByServer,
    breakerOpen, healthOf, rng,
  } = input

  // Index candidate paths once: fromInstanceId -> dependencyId -> CompiledPath[]
  // (compiled.paths order is deterministic, so the even split is too).
  const pathsByFromDep = new Map<InstanceId, Map<string, CompiledPath[]>>()
  for (const p of compiled.paths) {
    let byDep = pathsByFromDep.get(p.fromInstanceId)
    if (!byDep) {
      byDep = new Map()
      pathsByFromDep.set(p.fromInstanceId, byDep)
    }
    const list = byDep.get(p.dependencyId)
    if (list) list.push(p)
    else byDep.set(p.dependencyId, [p])
  }

  const flows: Record<InstanceId, InstanceFlow> = {}
  const totals: FlowTotals = { crossAzBytes: 0, crossRegionBytes: 0, internetBytes: 0 }

  // First-touch flow record; serviceLatencyMs is sampled exactly once per instance, in
  // BFS creation order (deterministic under a seeded rng).
  const getFlow = (id: InstanceId): InstanceFlow => {
    let f = flows[id]
    if (!f) {
      const inst = compiled.instances[id]
      const bp = inst ? doc.blueprints[inst.blueprintId] : undefined
      const p50 = Math.max(0.1, bp?.workload.cpuMsPerRequest ?? 1)
      const multiplier = inst ? (latencyMultiplierByServer[inst.serverId] ?? 1) : 1
      f = {
        instanceId: id,
        offeredRps: 0,
        admittedRps: 0,
        errorRps: 0,
        refusedRps: 0,
        serviceLatencyMs: sampleLatencyMs(p50, p50 * SERVICE_P99_OVER_P50, rng) * multiplier,
        downstream: [],
      }
      flows[id] = f
    }
    return f
  }

  // Contributions from different entries/chains can land on the same downstream row —
  // aggregate rps into one row per (dependency, target, blocked) triple.
  const addDownstream = (
    f: InstanceFlow,
    dependencyId: string,
    target: { toInstanceId?: InstanceId; toManagedServiceId?: string },
    rps: number,
    hopClass: HopClass,
    blocked: boolean,
  ): void => {
    const row = f.downstream.find(d =>
      d.dependencyId === dependencyId &&
      d.toInstanceId === target.toInstanceId &&
      d.toManagedServiceId === target.toManagedServiceId &&
      d.blocked === blocked)
    if (row) row.rps += rps
    else f.downstream.push({ dependencyId, ...target, rps, hopClass, blocked })
  }

  const bucketBytes = (hopClass: HopClass, rps: number): void => {
    const bytes = rps * BYTES_PER_REQUEST_EACH_WAY * 2   // request + response
    if (hopClass === 'cross-az') totals.crossAzBytes += bytes
    else if (hopClass === 'cross-region') totals.crossRegionBytes += bytes
    // localhost / same-az transfer is free — no cost line for it
  }

  const queue: QueueItem[] = []
  for (const [instanceId, rps] of Object.entries(entryDemand)) {
    if (rps <= 0) continue
    queue.push({ instanceId, offered: rps, depth: 0, visited: new Set([instanceId]) })
    // Client -> entry traffic rides the public internet.
    totals.internetBytes += rps * BYTES_PER_REQUEST_EACH_WAY * 2
  }

  // BFS via head index (no O(n) shift; perf budget is 4ms/step at 2,000 instances).
  let head = 0
  while (head < queue.length) {
    const item = queue[head++]
    const inst = compiled.instances[item.instanceId]
    if (!inst) continue   // stale entry id — routing/compile drift, skip defensively
    const flow = getFlow(item.instanceId)
    flow.offeredRps += item.offered

    const health = healthOf(item.instanceId)
    const healthFactor = health === 'down' ? 0 : health === 'degraded' ? DEGRADED_ADMIT_FACTOR : 1
    const admittedScale = admittedScaleByServer[inst.serverId] ?? 1
    const admitted = item.offered * admittedScale * healthFactor
    flow.admittedRps += admitted
    flow.errorRps += item.offered - admitted   // shed + down demand errors HERE

    if (admitted <= EPSILON_RPS) continue      // a down instance zeroes its whole subtree
    if (item.depth >= MAX_DEPTH) continue      // landed, but fans out no further

    const bp = doc.blueprints[inst.blueprintId]
    if (!bp) continue
    const byDep = pathsByFromDep.get(item.instanceId)

    for (const dep of bp.dependencies) {
      // Per-dependency breaker short-circuit: whole call volume refused, no rows.
      if (breakerOpen(pathKey(item.instanceId, dep.id))) {
        flow.refusedRps += admitted
        continue
      }
      const candidates = byDep?.get(dep.id)
      if (!candidates || candidates.length === 0) continue   // dangling dep: compile emitted nothing
      // Call-per-request: the dependency sees the FULL admitted rps, split evenly across
      // ALL compiled targets — blocked ones included (the caller can't see the misconfig).
      const share = admitted / candidates.length
      if (share <= EPSILON_RPS) continue

      for (const path of candidates) {
        const target = path.to.kind === 'instance'
          ? { toInstanceId: path.to.instanceId }
          : { toManagedServiceId: path.to.managedServiceId }

        if (path.verdict === 'blocked') {
          // Refused ON THE CALLER; the blocked row is what events/particles render.
          flow.refusedRps += share
          addDownstream(flow, dep.id, target, share, path.hopClass, true)
          continue   // refused attempts carry no payload and reach nothing
        }

        addDownstream(flow, dep.id, target, share, path.hopClass, false)
        bucketBytes(path.hopClass, share)

        if (path.to.kind === 'managed') continue   // no capacity model in Phase 2
        const toId = path.to.instanceId
        if (item.visited.has(toId)) continue        // cycle guard: row recorded, no re-entry
        const visited = new Set(item.visited)
        visited.add(toId)
        queue.push({ instanceId: toId, offered: share, depth: item.depth + 1, visited })
      }
    }
  }

  return { flows, totals }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/worldEngine/flows.test.ts`
Expected: PASS (14 tests)

- [ ] **Step 5: Run the whole engine suite (guards against cross-module drift)**

Run: `npx vitest run src/lib/worldEngine/`
Expected: PASS — rng 6, engineClock (per T1), demand (per T2), routingRuntime 13,
hostScheduler 6, vpsModel (per T5), networkRuntime 13, breakers 8, flows 14; zero failures.

- [ ] **Step 6: tsc check**

Run: `npm run build`
Expected: succeeds

- [ ] **Step 7: Commit**

```bash
git add src/lib/worldEngine/flows.ts src/lib/worldEngine/flows.test.ts
git commit -m "feat(engine): add per-step flow solver across instances"
```

---

### Task 9: Failover machinery — outages, health propagation, drain, promotion

**Files:**
- Create: `src/lib/worldEngine/failover.ts`
- Test: `src/lib/worldEngine/failover.test.ts`

**Interfaces:**
- Consumes: `AzId, PlacementId, InstanceId, CompiledWorld, WorldDoc` from `../world/types`;
  `EngineEvent, HealthState` from `./types`.
- Produces (skeleton-exact, plus the additive members flagged in SKELETON CONCERNS #3, #4, #8):

```ts
interface FailoverState {
  manualOutages: Set<string>                 // scope ids forced down via setOutage
  healthByScope: Map<string, HealthState>    // last committed health per scope id (hysteresis output)
  drainUntil: Map<AzId, number>              // simMs at which a down AZ's drain completes
  promotedAt: Map<PlacementId, number>       // replica placement -> simMs it was promoted (emit-once guard)
  // additive (SKELETON CONCERNS #4): per-scope hysteresis timers
  onsetPendingSince: Map<string, number>     // first simMs a scope started worsening
  recoveryUntil: Map<string, number>         // simMs a scope may recover at (recovery lock)
}
interface HealthHysteresis { onsetMs: number; recoveryMs: number }
DEFAULT_HYSTERESIS: HealthHysteresis          // { onsetMs: 3000, recoveryMs: 5000 }
createFailoverState(): FailoverState          // additive factory (T12 uses it; SKELETON CONCERNS #7 in tasks-10-12 reconciled — this export exists)
setOutage(state, scope: 'server' | 'az' | 'region', id: string, down: boolean, simMs?: number): EngineEvent[]   // simMs optional=0, SKELETON CONCERNS #3
computeHealth(state, scopeId: string, inputs: { errorRate: number; cpuPressure: number; checkFailed: boolean; manualDown: boolean }, simMs: number, hysteresis: HealthHysteresis): HealthState
promoteReplicas(state, compiled: CompiledWorld, doc: WorldDoc, downInstanceIds: InstanceId[], simMs: number): EngineEvent[]
drainFactor(state, azId: AzId, simMs: number): number   // 1 -> 0 across DRAIN_MS after the AZ goes down; 0 when not draining
beginDrain(state, azId: AzId, simMs: number): void       // additive (SKELETON CONCERNS #8): facade calls on organic AZ->down
clearDrain(state, azId: AzId): void
```

Semantics (spec decision 7 + skeleton T9):

- **`setOutage`** is idempotent and returns events only on an actual state change: `down`
  adds the id to `manualOutages`, pins `healthByScope[id] = 'down'`, and (AZ scope only)
  `beginDrain`s; clearing removes it and (AZ scope) `clearDrain`s. Event ids are
  deterministic content-derived strings (SKELETON CONCERNS #3) — T10's ring may re-sequence.
- **`computeHealth`** ports the legacy onset-debounce / recovery-lock hysteresis (spec
  decision 2). `manualDown` forces `'down'` immediately (and clears both timers). Otherwise an
  instantaneous severity is derived from the live signals (`checkFailed` or high
  `errorRate`/`cpuPressure` → `'down'`; moderate → `'degraded'`; else `'healthy'`) and blended
  against the last committed state: **worsening** transitions must persist for `onsetMs` before
  they commit (`onsetPendingSince`); **improving** transitions must hold for `recoveryMs`
  before they commit (`recoveryUntil`). The committed state is written back to
  `healthByScope[scopeId]` and returned.
- **`promoteReplicas`**: for each down instance that is a `primary`, promote the oldest
  eligible `replica` of the same blueprint in the same **region** (deterministic: lowest
  instance id), emit `replica_promoted` exactly once per (blueprint, region) — guarded by
  `promotedAt`. Phase 2 is visual/event-only: no data ownership is modeled (spec decision 7).
- **`drainFactor`**: `max(0, min(1, (drainUntil − simMs) / DRAIN_MS))`; `0` when the AZ has no
  drain entry (not draining, or already fully drained). Existing traffic on a downed AZ ramps
  out over `DRAIN_MS = 2000`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/worldEngine/failover.test.ts
import { describe, it, expect } from 'vitest'
import {
  createFailoverState, setOutage, computeHealth, promoteReplicas, drainFactor,
  beginDrain, DEFAULT_HYSTERESIS,
} from './failover'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
} from '../world/factories'
import { getPreset } from '../world/instanceCatalog'
import { compileWorld, instanceId } from '../world/compileWorld'

const healthy = { errorRate: 0, cpuPressure: 0.5, checkFailed: false, manualDown: false }
const bad = { errorRate: 0.9, cpuPressure: 3, checkFailed: true, manualDown: false }

describe('setOutage', () => {
  it('forces a scope down, emits outage_triggered once, and is idempotent', () => {
    const state = createFailoverState()
    const events = setOutage(state, 'az', 'az-1', true, 1000)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'outage_triggered', severity: 'critical', affected: ['az-1'], simMs: 1000 })
    expect(state.manualOutages.has('az-1')).toBe(true)
    expect(state.healthByScope.get('az-1')).toBe('down')
    // idempotent — no second event for an already-down scope
    expect(setOutage(state, 'az', 'az-1', true, 2000)).toEqual([])
    // manualDown forces 'down' through computeHealth regardless of signals
    expect(computeHealth(state, 'az-1', { ...healthy, manualDown: true }, 3000, DEFAULT_HYSTERESIS)).toBe('down')
  })

  it('clears an outage and emits outage_cleared exactly once', () => {
    const state = createFailoverState()
    setOutage(state, 'region', 'r-1', true, 0)
    const cleared = setOutage(state, 'region', 'r-1', false, 5000)
    expect(cleared).toHaveLength(1)
    expect(cleared[0]).toMatchObject({ kind: 'outage_cleared', affected: ['r-1'], simMs: 5000 })
    expect(state.manualOutages.has('r-1')).toBe(false)
    expect(setOutage(state, 'region', 'r-1', false, 6000)).toEqual([]) // already cleared
  })
})

describe('computeHealth — hysteresis', () => {
  it('debounces onset: two bad ticks inside onsetMs keep the scope healthy', () => {
    const state = createFailoverState()
    expect(computeHealth(state, 's-1', bad, 0, DEFAULT_HYSTERESIS)).toBe('healthy')       // pending starts
    expect(computeHealth(state, 's-1', bad, 2000, DEFAULT_HYSTERESIS)).toBe('healthy')     // 2s < 3s
    expect(computeHealth(state, 's-1', bad, 3001, DEFAULT_HYSTERESIS)).toBe('down')        // >= onsetMs -> commit
  })

  it('locks recovery: a healed scope stays down until recoveryMs elapses', () => {
    const state = createFailoverState()
    // drive it down first
    computeHealth(state, 's-2', bad, 0, DEFAULT_HYSTERESIS)
    computeHealth(state, 's-2', bad, 3001, DEFAULT_HYSTERESIS)
    expect(state.healthByScope.get('s-2')).toBe('down')
    // now healthy signals — recovery lock holds
    expect(computeHealth(state, 's-2', healthy, 4000, DEFAULT_HYSTERESIS)).toBe('down')    // lock starts
    expect(computeHealth(state, 's-2', healthy, 8000, DEFAULT_HYSTERESIS)).toBe('down')    // 4s < 5s
    expect(computeHealth(state, 's-2', healthy, 9001, DEFAULT_HYSTERESIS)).toBe('healthy') // >= recoveryMs
  })
})

describe('drainFactor', () => {
  it('ramps 1 -> 0 across DRAIN_MS (2000) after the AZ goes down', () => {
    const state = createFailoverState()
    beginDrain(state, 'az-9', 0)
    expect(drainFactor(state, 'az-9', 0)).toBeCloseTo(1, 5)
    expect(drainFactor(state, 'az-9', 1000)).toBeCloseTo(0.5, 5)
    expect(drainFactor(state, 'az-9', 2000)).toBeCloseTo(0, 5)
    expect(drainFactor(state, 'az-9', 2500)).toBe(0)
    expect(drainFactor(state, 'az-other', 0)).toBe(0)   // no drain entry
  })
})

describe('promoteReplicas', () => {
  // 1 region, 2 AZs; a primary in az-a and a replica of the same blueprint in az-b.
  function replicaFixture() {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    const azA = createAz(region.id, 'us-east-1a')
    const azB = createAz(region.id, 'us-east-1b')
    const sA = createServer(azA.id, getPreset('dedicated-8')!)
    const sB = createServer(azB.id, getPreset('dedicated-8')!)
    const bp = createBlueprint('db', 0)
    bp.stateful = true
    const primary = createPlacement(bp.id, sA.id)          // role 'primary' by default
    const replica = createPlacement(bp.id, sB.id)
    replica.role = 'replica'
    doc.regions[region.id] = region
    Object.assign(doc.azs, { [azA.id]: azA, [azB.id]: azB })
    Object.assign(doc.servers, { [sA.id]: sA, [sB.id]: sB })
    doc.blueprints[bp.id] = bp
    Object.assign(doc.placements, { [primary.id]: primary, [replica.id]: replica })
    const compiled = compileWorld(doc)
    return { doc, compiled, primaryInst: instanceId(primary.id, 0), replicaInst: instanceId(replica.id, 0) }
  }

  it('promotes the same-blueprint same-region replica and emits replica_promoted once', () => {
    const f = replicaFixture()
    const state = createFailoverState()
    const events = promoteReplicas(state, f.compiled, f.doc, [f.primaryInst], 1000)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'replica_promoted', simMs: 1000 })
    expect(events[0].affected).toContain(f.replicaInst)
    expect(events[0].affected).toContain(f.primaryInst)
    // called again while still promoted -> no duplicate event
    expect(promoteReplicas(state, f.compiled, f.doc, [f.primaryInst], 2000)).toEqual([])
  })

  it('does nothing when the down instance is not a primary', () => {
    const f = replicaFixture()
    const state = createFailoverState()
    expect(promoteReplicas(state, f.compiled, f.doc, [f.replicaInst], 1000)).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/worldEngine/failover.test.ts`
Expected: FAIL — `Cannot find module './failover'`

- [ ] **Step 3: Write `failover.ts`**

```ts
// src/lib/worldEngine/failover.ts
// Failover machinery: manual outage switches, ported health onset/recovery hysteresis,
// AZ drain ramp, and stateful replica promotion. Spec decision 7 (and decision 2 for the
// hysteresis port), docs/superpowers/specs/2026-07-08-phase2-substrate-engine-design.md.
// Emits contract EngineEvents; the facade (Task 12) owns id re-sequencing and observation.
import type { AzId, PlacementId, InstanceId, CompiledWorld, WorldDoc } from '../world/types'
import type { EngineEvent, HealthState } from './types'

const DRAIN_MS = 2000               // existing traffic on a downed AZ ramps out over 2s (spec decision 7)

// Instantaneous-severity thresholds (ported approximations of the legacy health signals).
// Only the hysteresis timing is behaviourally load-bearing; these bands classify a single tick.
const DOWN_ERROR_RATE = 0.5
const DOWN_CPU_PRESSURE = 2
const DEGRADED_ERROR_RATE = 0.1
const DEGRADED_CPU_PRESSURE = 1

export interface HealthHysteresis {
  onsetMs: number     // a worsening must persist this long before it commits
  recoveryMs: number  // an improvement must hold this long before it commits
}

// Legacy onset debounce 3000ms / recovery lock 5000ms (skeleton T9; legacy used an 8s
// recovery lock — SKELETON CONCERNS #7 keeps the skeleton's 5s since it's a parameter).
export const DEFAULT_HYSTERESIS: HealthHysteresis = { onsetMs: 3000, recoveryMs: 5000 }

export interface FailoverState {
  manualOutages: Set<string>
  healthByScope: Map<string, HealthState>
  drainUntil: Map<AzId, number>
  promotedAt: Map<PlacementId, number>
  onsetPendingSince: Map<string, number>
  recoveryUntil: Map<string, number>
}

export function createFailoverState(): FailoverState {
  return {
    manualOutages: new Set(),
    healthByScope: new Map(),
    drainUntil: new Map(),
    promotedAt: new Map(),
    onsetPendingSince: new Map(),
    recoveryUntil: new Map(),
  }
}

const SEVERITY: Record<HealthState, number> = { healthy: 0, degraded: 1, down: 2 }

function outageEvent(
  kind: 'outage_triggered' | 'outage_cleared',
  scope: 'server' | 'az' | 'region',
  id: string,
  simMs: number,
): EngineEvent {
  const down = kind === 'outage_triggered'
  return {
    id: `outage-${scope}-${id}-${down ? 'down' : 'up'}-${simMs}`,
    simMs,
    kind,
    severity: down ? 'critical' : 'info',
    message: `${scope} ${id} manually ${down ? 'taken down' : 'restored'}`,
    affected: [id],
  }
}

export function beginDrain(state: FailoverState, azId: AzId, simMs: number): void {
  if (!state.drainUntil.has(azId)) state.drainUntil.set(azId, simMs + DRAIN_MS)
}

export function clearDrain(state: FailoverState, azId: AzId): void {
  state.drainUntil.delete(azId)
}

export function drainFactor(state: FailoverState, azId: AzId, simMs: number): number {
  const until = state.drainUntil.get(azId)
  if (until === undefined) return 0
  return Math.max(0, Math.min(1, (until - simMs) / DRAIN_MS))
}

// Idempotent manual switch: an event is returned ONLY when the outage set actually changes.
export function setOutage(
  state: FailoverState,
  scope: 'server' | 'az' | 'region',
  id: string,
  down: boolean,
  simMs = 0,
): EngineEvent[] {
  const already = state.manualOutages.has(id)
  if (down && !already) {
    state.manualOutages.add(id)
    state.healthByScope.set(id, 'down')
    if (scope === 'az') beginDrain(state, id, simMs)
    return [outageEvent('outage_triggered', scope, id, simMs)]
  }
  if (!down && already) {
    state.manualOutages.delete(id)
    if (scope === 'az') clearDrain(state, id)
    return [outageEvent('outage_cleared', scope, id, simMs)]
  }
  return []
}

export function computeHealth(
  state: FailoverState,
  scopeId: string,
  inputs: { errorRate: number; cpuPressure: number; checkFailed: boolean; manualDown: boolean },
  simMs: number,
  hysteresis: HealthHysteresis,
): HealthState {
  if (inputs.manualDown) {
    state.healthByScope.set(scopeId, 'down')
    state.onsetPendingSince.delete(scopeId)
    state.recoveryUntil.delete(scopeId)
    return 'down'
  }

  const instant: HealthState =
    inputs.checkFailed || inputs.errorRate >= DOWN_ERROR_RATE || inputs.cpuPressure >= DOWN_CPU_PRESSURE
      ? 'down'
      : inputs.errorRate >= DEGRADED_ERROR_RATE || inputs.cpuPressure >= DEGRADED_CPU_PRESSURE
        ? 'degraded'
        : 'healthy'

  const prev = state.healthByScope.get(scopeId) ?? 'healthy'
  let next = prev

  if (SEVERITY[instant] > SEVERITY[prev]) {
    // worsening — debounce onset
    state.recoveryUntil.delete(scopeId)
    const since = state.onsetPendingSince.get(scopeId)
    if (since === undefined) {
      state.onsetPendingSince.set(scopeId, simMs)
    } else if (simMs - since >= hysteresis.onsetMs) {
      next = instant
      state.onsetPendingSince.delete(scopeId)
    }
  } else if (SEVERITY[instant] < SEVERITY[prev]) {
    // improving — hold the recovery lock
    state.onsetPendingSince.delete(scopeId)
    const until = state.recoveryUntil.get(scopeId)
    if (until === undefined) {
      state.recoveryUntil.set(scopeId, simMs + hysteresis.recoveryMs)
    } else if (simMs >= until) {
      next = instant
      state.recoveryUntil.delete(scopeId)
    }
  } else {
    // stable at the current severity — cancel any pending transition
    state.onsetPendingSince.delete(scopeId)
    state.recoveryUntil.delete(scopeId)
  }

  state.healthByScope.set(scopeId, next)
  return next
}

// Primary down -> promote the oldest same-blueprint, same-region replica (spec decision 7).
// Visual/event semantics only in Phase 2: no data ownership is modeled. Emits once per
// (blueprint, region) via the promotedAt guard.
export function promoteReplicas(
  state: FailoverState,
  compiled: CompiledWorld,
  doc: WorldDoc,
  downInstanceIds: InstanceId[],
  simMs: number,
): EngineEvent[] {
  const events: EngineEvent[] = []
  const downSet = new Set(downInstanceIds)

  for (const downId of downInstanceIds) {
    const primary = compiled.instances[downId]
    if (!primary || primary.role !== 'primary') continue

    const siblingReplicas = Object.values(compiled.instances).filter(
      i => i.role === 'replica' && i.blueprintId === primary.blueprintId && i.regionId === primary.regionId,
    )
    // already promoted a replica for this (blueprint, region)? emit-once guard.
    if (siblingReplicas.some(i => state.promotedAt.has(i.placementId))) continue

    const chosen = siblingReplicas
      .filter(i => !downSet.has(i.id))
      .sort((a, b) => a.id.localeCompare(b.id))[0]
    if (!chosen) continue

    state.promotedAt.set(chosen.placementId, simMs)
    const bpName = doc.blueprints[primary.blueprintId]?.name ?? primary.blueprintId
    events.push({
      id: `promote-${chosen.id}-${simMs}`,
      simMs,
      kind: 'replica_promoted',
      severity: 'warning',
      message: `${bpName} replica ${chosen.id} promoted to primary after ${downId} failed`,
      affected: [chosen.id, downId],
    })
  }

  return events
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/worldEngine/failover.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Run the whole engine suite (guards against cross-module drift)**

Run: `npx vitest run src/lib/worldEngine/`
Expected: PASS — rng 6, engineClock (per T1), demand (per T2), routingRuntime 13,
hostScheduler 6, vpsModel 8, networkRuntime 13, breakers 8, flows 14, failover 7; zero failures.

- [ ] **Step 6: tsc check**

Run: `npm run build`
Expected: succeeds

- [ ] **Step 7: Commit**

```bash
git add src/lib/worldEngine/failover.ts src/lib/worldEngine/failover.test.ts
git commit -m "feat(engine): add failover machinery (outages, health hysteresis, drain, promotion)"
```

---
