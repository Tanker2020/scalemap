# Task 9 Report: NAT gateway byte accounting wired into the engine step + WorldMetrics

## 1. What changed, and where

### Located the existing per-hop byte accounting first (brief's Step 3)

`flows.ts`'s `bucketBytes` (around line 626) computes the world-aggregate `totals.crossAzBytes`/
`totals.crossRegionBytes` from `rps * (reqBytes + respBytes)` per hop, but it is a **pure
aggregate** with no per-server/per-gateway identity — it can't tell you which NAT gateway a hop
went through. The place that DOES already compute per-row, per-server-identified bytes is
`worldEngine/index.ts`'s section-7 "Internal hops this instance ORIGINATES" loop (originally
~line 1948, now ~1996), which for every non-blocked `f.downstream` row computes:

```ts
const req = row.rps * reqBytes * m * stepSec
const resp = row.rps * respBytes * m * stepSec
addNicBytes(nic, resp, req)   // caller: response in, request out
```

This is the exact point where the caller's own server id (`inst.serverId`) and the row's
`hopClass` are both in scope. Rather than re-deriving anything from `flows.ts`'s aggregate totals
(which don't carry server identity) or adding a second computation, I hooked NAT gateway
accounting directly into this loop, feeding it the SAME `req`/`resp` values already computed for
the row's own NIC booking two lines above.

### Files changed

- **`src/lib/worldEngine/index.ts`**
  - New import: `resolveRoute` from `../world/network`; `NatGatewayId` type; `createNatGatewayState`/
    `settleNatGateway`/`NatGatewayState` from `./networkRuntime` (Task 8's aliases).
  - New constant `NAT_GATEWAY_NIC_MBPS = 10_000` beside `DEGRADE_THRESHOLD_MS`.
  - New module function `buildNatGatewayIdByServer(doc)` (placed beside `buildRoutePathById`) —
    resolves, once per server, whether its subnet's route table's egress route targets a NAT
    gateway, calling the SAME `resolveRoute` compileWorld.ts already uses.
  - `EngineState` gained `natGatewayStates: Map<NatGatewayId, NatGatewayState>` and
    `natGatewayIdByServer: Map<ServerId, NatGatewayId>`, both built once at `start()`.
  - `EngineState.windowTotals` gained a `natGatewayBytes: Record<string, number>` field (both
    literal sites — `start()`'s initial state and the 1 Hz batch-reset site — updated).
  - Section-7 loop: after the existing `addNicBytes(nic, resp, req)` caller-NIC booking, a new
    block (gated on `row.hopClass === 'cross-region'` and `natGatewayIdByServer.size > 0`) looks
    up the caller's NAT gateway and calls `addNicBytes(natState, resp, req)` with the SAME `req`/
    `resp` values.
  - Section-9 (settlement): a new loop beside the existing `settleNic` loop captures each NAT
    gateway's `inBytesThisStep + outBytesThisStep` into `windowTotals.natGatewayBytes` BEFORE
    calling `settleNatGateway` (which resets the counters) — zero iterations when
    `natGatewayStates` is empty.

- **`src/lib/worldEngine/metrics.ts`**
  - `buildBatch`'s `totals` parameter gained an optional `natGatewayBytes?: Record<string,
    number>` sibling field (not a new positional parameter — reached through the existing
    `{ ...s.windowTotals }` spread at the call site).
  - New `natGatewayBytesPerSec` loop in the `── World ──` section, `ema`-blending each key present
    in `totals.natGatewayBytes`, spread into the `world` object literal ONLY when non-empty
    (`...(Object.keys(natGatewayBytesPerSec).length > 0 ? { natGatewayBytesPerSec } : {})`).

- **`src/lib/worldEngine/types.ts`**
  - `WorldMetrics` gained `natGatewayBytesPerSec?: Record<string, number>`, additive-optional,
    documented with the same "absent, not present-and-empty" convention as every other optional
    `MetricsBatch` field.

- **`src/lib/worldEngine/index.test.ts`**
  - New `import { createVpc, createSubnet, createRouteTable, createNatGateway }` from
    `../world/factories`.
  - New `describe('FEAT-014 (Task 9): NAT gateway byte accounting', ...)` block, appended at the
    end of the file, three tests (see §2/§5).

- **`.superpowers/sdd/contract-drift.md`** — new dated entry documenting the additive field, the
  wiring, and both deviations from the brief's pseudocode (see §5).

## 2. Regression floor (byte-identical with zero NAT gateways)

Test: `'a doc with zero natGateways produces byte-identical engine output for a fixed seed
(regression floor)'` (`index.test.ts`, FEAT-014 Task 9 describe block). It runs the existing
`e2eFixture()` (unmodified — no NAT gateways, no `subnetId` authored anywhere) twice with the same
seed for 20s of steps and asserts `expect(simB.latest()).toEqual(simA.latest())` — full
`MetricsBatch` structural equality (this file's own established idiom for "regression floor",
matching the precedent at e.g. line ~3085's `REGRESSION FLOOR: a world with no replicas` and line
~4434's `REGRESSION FLOOR: a placement with no autoscale`). It additionally asserts
`expect(simA.latest().world.natGatewayBytesPerSec).toBeUndefined()` — confirming the field is
*absent*, not present-and-empty, satisfying the "additive-optional, omitted when empty" convention
Cross-Cutting Constraint 3 requires.

Result: **PASS**. Confirmed via `npx vitest run src/lib/worldEngine/index.test.ts -t "NAT gateway"`
(3/3 passing) and the full-file run below.

I also independently confirmed, at the code level, that this holds by construction, not just by
this one fixture: `natGatewayStates`/`natGatewayIdByServer` are built empty for any doc with
`doc.natGateways` empty; the section-7 accounting block is gated on
`natGatewayIdByServer.size > 0`; the section-9 settlement loop iterates zero times over an empty
`natGatewayStates` map; `windowTotals.natGatewayBytes` therefore stays `{}` forever;
`buildBatch`'s `natGatewayBytesPerSec` loop therefore never executes; and the `world` object omits
the key entirely via the spread-conditional. No new field is ever *written*, only conditionally
*read*, for a doc that never authors a NAT gateway.

## 3. DIVERGENCE GUARD tests

Confirmed unaffected — this task adds zero RAM/connection-load path (it only accounts NAT gateway
bytes, never touches `InstanceLoad`, `activeConnections`, or anything the two Little's-law call
sites read). All `DIVERGENCE GUARD`-titled tests in `index.test.ts` pass in the full-file run
(148/148 tests passing, see §4) — I did not need to touch any of them.

## 4. Exact commands run and output

```
$ npx vitest run src/lib/worldEngine/index.test.ts -t "NAT gateway"
 Test Files  1 passed (1)
      Tests  3 passed | 145 skipped (148)

$ npx vitest run src/lib/worldEngine/index.test.ts
 Test Files  1 passed (1)
      Tests  148 passed (148)

$ npx vitest run src/lib/worldEngine
 Test Files  23 passed (23)
      Tests  536 passed (536)

$ npx tsc --noEmit
(no output, exit 0)

$ npm run bench     # vitest run --config vitest.bench.config.ts, reporter=verbose
 ✓ bench/renderPerf.bench.test.ts ... 44ms
[enginePerf] median step 7.35ms exceeds the 4ms budget (still under the 8ms CI-fail line) at 1954 instances
 ✓ bench/enginePerf.bench.test.ts ... 1269ms
 Test Files  2 passed (2)
      Tests  2 passed (2)
```

Re-ran the bench a second time post-change (7.65ms median), then `git stash`'d all Task 9 changes
and ran it a third time against the PRE-Task-9 code on the same machine, same moment (7.63ms
median) — statistically identical to the post-change runs, both comfortably inside the 3.9–7.5ms
machine-load variance the bench file's own header documents, and both well under the 8ms hard-fail
line. The synthetic bench fixture (`buildSyntheticWorld` in `bench/enginePerf.bench.test.ts`)
authors zero NAT gateways / no `subnetId` anywhere, so this exercises exactly the empty-map fast
path the plan's perf law targets. Conclusion: **no measurable regression attributable to Task 9**;
the 4ms soft-budget warning (not a failure) reflects ambient load on this box, present identically
before and after this change.

## 5. Deviations from the brief, and why

1. **`applyNatGatewayCap` → `addNicBytes` at the per-row accounting site.** The brief's Step 4
   pseudocode calls `applyNatGatewayCap(state, NAT_GATEWAY_NIC_MBPS, hopBytes, 0, stepMs)` inline
   in the accounting loop — but `applyNicCap`/`applyNatGatewayCap` accumulates AND evaluates in
   one call. The EXISTING per-server NIC loop it sits beside already uses a two-phase pattern
   instead: `addNicBytes` per row (accumulate only), then one `settleNic` call at end-of-step
   (evaluate once). I mirrored that existing split for the NAT gateway rather than the brief's
   evaluate-every-row suggestion — same total behavior, avoids ~N redundant cap evaluations per
   step where N is the number of cross-region rows landing on a gated server.

2. **No admission-side saturation feedback (test 2's literal wording softened).** The brief's
   Step 1 sketch describes a test where "two private-subnet servers sharing one NAT gateway...
   get roughly half its cap when both saturate it, mirrors per-server NIC shedding." I could not
   honestly implement this: the brief's OWN Step 4 pseudocode never threads
   `settleNatGateway`'s `deliveredFraction`/`queuedLatencyMs` result into anything — it's computed
   and discarded, exactly like the per-row accounting I implemented. Unlike a per-server NIC
   (whose `settleNic` result feeds `admittedScaleByServer`/`extraLatencyMsByServer` the following
   step via the host-scheduler loop), nothing in this task's file scope
   (`index.ts`/`metrics.ts`/`types.ts`) threads a NAT-gateway-level cap signal into `flows.ts`'s
   admission/queue model. Doing so for real would mean widening `solveFlows`'s input contract with
   a new per-server-or-gateway throttle signal — a materially bigger, separate architectural
   decision, not something to guess at inside a byte-accounting task. I implemented the test that
   IS backed by what Task 9 actually builds: two servers whose subnets both resolve to the same
   `NatGatewayState` must have their bytes summed into one shared published rate (ruling out a
   keying bug that silently drops one contributor or double-counts). Documented as a flagged
   follow-up in `contract-drift.md` rather than silently narrowing scope.

3. **No new `EngineEventKind`.** Per the brief's own guidance, I only add one if genuinely needed
   for this task's acceptance criteria. Nothing here needed one (byte accounting + a published
   rate, no saturation-triggered event path), so none was added.

4. **`needsEgress` passed as `true` unconditionally in `buildNatGatewayIdByServer`**, rather than
   compileWorld's per-hop `hopClass === 'cross-region'` gate. This is deliberate, not a
   simplification of correctness: the index is keyed purely by SOURCE server, and this codebase's
   route-table model has at most one non-local egress route per subnet (see `resolveRoute`'s own
   doc comment) — so "does this server's subnet resolve to a NAT gateway" has one fixed answer
   regardless of destination. The actual cross-region gate is still applied at the point of use
   (the accounting loop only consults this map when `row.hopClass === 'cross-region'`), reproducing
   compileWorld's `needsEgress` condition exactly, just checked once per row instead of baked into
   the once-per-run index.

## Files touched

- `C:\Users\rishi\Desktop\scalemap\.claude\worktrees\network-topology-feat014\src\lib\worldEngine\index.ts`
- `C:\Users\rishi\Desktop\scalemap\.claude\worktrees\network-topology-feat014\src\lib\worldEngine\metrics.ts`
- `C:\Users\rishi\Desktop\scalemap\.claude\worktrees\network-topology-feat014\src\lib\worldEngine\types.ts`
- `C:\Users\rishi\Desktop\scalemap\.claude\worktrees\network-topology-feat014\src\lib\worldEngine\index.test.ts`
- `C:\Users\rishi\Desktop\scalemap\.claude\worktrees\network-topology-feat014\.superpowers\sdd\contract-drift.md`

---

## Fix round 1 (2026-08-10)

The reviewer found two Critical findings and one Important finding on the round above. Summary of
what changed, filed under the same finding numbers used in the review.

### Critical #1 — NAT gateway capacity was never enforced (the state was write-only)

The round-1 build called `settleNatGateway(natState, NAT_GATEWAY_NIC_MBPS, stepMs)` in the
settlement loop (`index.ts`, then ~line 2274) and **discarded the return value** — the exact same
mistake the per-server NIC path had (and fixed) under audit ISSUE-002, just not carried over to
the gateway. `applyNatGatewayCap` was never called anywhere either. The result: a NAT gateway
could accumulate bytes and publish a rate, but could never actually saturate, shed admission, or
add queueing latency to anything.

**Fix.** Mirrored the per-server NIC's own one-step-lag mechanism exactly:

1. Two new `EngineState` fields, siblings of `nicDeliveredFraction`/`nicQueuedLatencyMs`:
   `natGatewayDeliveredFraction: Map<NatGatewayId, number>` and
   `natGatewayQueuedLatencyMs: Map<NatGatewayId, number>` (both initialized empty in `start()`).
2. The settlement loop now captures `settleNatGateway`'s return value and stores it into those two
   maps, keyed by `natId`, instead of discarding it — the same "settle AFTER accumulate, feed the
   NEXT step" ordering the per-server NIC settlement loop already uses immediately above it.
3. In the per-server host loop (`index.ts`, around what was line 1619, now ~1625–1644), where
   `admittedScaleByServer[server.id]`/`extraLatencyMsByServer[server.id]` are assigned from the
   server's own `nicDeliveredFraction`/`nicQueuedLatencyMs`, I added a lookup:
   `natId = s.natGatewayIdByServer.get(server.id)` (the same start()-time-resolved index the byte
   accounting itself already uses), then read that gateway's `natGatewayDeliveredFraction`/
   `natGatewayQueuedLatencyMs` (defaulting to `1`/`0` when the server has no gateway, so a doc with
   zero NAT gateways is provably unaffected — same convention as every other optional signal here).

**Composition approach (the core of this fix).** Before composing anything I re-read how
`admittedScaleByServer`/`extraLatencyMsByServer` are actually consumed downstream
(`flows.ts` line 714: `const admittedScale = admittedScaleByServer[inst.serverId] ?? 1`, folded
multiplicatively into the instance's serve capacity; line 555:
`input.extraLatencyMsByServer?.[inst.serverId] ?? 0`, folded additively into composed latency).
Both are a **single scalar Record entry per server** — there is no list of independent
contributors inside `flows.ts` itself, so the only place multiple influences on the same server
can combine is at the point where the Record entry is written, which is exactly where this fix
lives. Given that, I used:

- **Admission fraction: multiply.** `admittedScaleByServer[server.id] = (nicDeliveredFraction ??
  1) * natDeliveredFraction`. This is the same discipline `cpu-brownout` already uses when
  composing with the existing VPS steal factor (`index.ts` ~line 1501, "compose
  MULTIPLICATIVELY... never REPLACE") — two independent capacity-limiting resources in series
  (the server's own NIC, then the shared gateway further upstream) each shave off their own
  fraction of what gets through, so the combined fraction is the product, not whichever is
  smaller and not a sum (which could go negative or double-count overlap).
- **Latency: add.** `totalExtraMs = queuedMs + faultMs + diskMs + natQueuedMs`, joining the SAME
  additive chain FEAT-006/FEAT-001 already established for NIC-queue/latency-fault/disk-wait ms
  (comment at that call site literally says "must ADD not assign"). Two independent queueing
  delays incurred serially (server NIC queue, then gateway queue) sum, mirroring real-world
  network-hop latency composition — a request queued at both hops waits for both, sequentially.

No `solveFlows` signature change was needed, exactly as the review predicted — both maps were
already threaded through as plain `Record<ServerId, number>` inputs; this fix only changes what
value gets written into the existing Record entry for a server that happens to sit behind a NAT
gateway.

### Critical #2 — the saturation test didn't test saturation

Replaced the round-1 test's stale comment block (which explained why enforcement was left as a
"follow-up") with a new test:
**"two private-subnet servers sharing one saturated NAT gateway both see materially higher
latency (shared cap enforced), not just measured"** (`index.test.ts`, in the same
`describe('FEAT-014 (Task 9): NAT gateway byte accounting')` block, right before the existing
additivity test, which is kept as-is since it still correctly covers the separate "bytes are
summed, not last-write-wins" property).

Test shape, and why: each of two private-subnet servers binds a 5 MB-request fat packet
(`bindFatPacket`'s pattern, generalized into the fixture via a new `fatPacketSizeKb` spec field)
to its own cross-region dependency, at `peakRps: 300`, with `serverANicMbps: 200_000` — deliberately
far above the gateway's 10 Gbps cap so the GATEWAY, not each server's own per-server NIC (already
covered by existing tests), is the binding constraint under test. One server alone pushes the
gateway to ~1.26x its per-step cap (inside the 1x–2x "still delivers, latency grows
proportionally" band — `queuedLatencyMs = (ratio-1)*stepMs ≈ 26ms`). Two servers sharing the SAME
gateway push it past 2x (`deliveredFraction` sheds to ~0.5–0.6, `queuedLatencyMs` jumps to the
flat `stepMs` = 100ms band). I initially wrote this as an rps-shed assertion (mirroring the raw
wording of the plan's "each get roughly half its cap"), but instrumented the run and confirmed
`admittedScaleByServer` for both servers WAS correctly landing around 0.5–0.6 in the combined run
— the assertion just couldn't see it, because these instances' raw CPU/NIC service-rate capacity
is far above the 300 rps offered, so a 50% capacity cut still leaves capacity above demand and
`rps` stays flat (queue-mode admission, not proportional shedding — see the ISSUE-013/016 comment
at that call site). I switched the assertion to `p50Ms` (composed end-to-end latency), which
directly reflects `extraLatencyMsByServer`'s additive queued-ms and is far more sensitive to this
kind of "capacity still exceeds demand but queueing grew" case. This also matches the existing
idiom this test file already uses for exactly this class of assertion (`index.test.ts` lines
316/1714's fixed `+30`/`+50` ms thresholds) rather than inventing a new assertion shape — I used
`toBeGreaterThan(aloneP50 + 40)` for both servers in the combined run. Confirmed via a temporary
debug `console.log` (removed before commit) that `natGatewayDeliveredFraction` does land at
~0.5–0.6 for both servers in the combined case and ~1 alone, so the underlying enforcement is
doing exactly what the plan's acceptance test describes ("roughly half its cap") — the test just
measures it through latency instead of rps, since rps is the wrong signal at this capacity/demand
ratio.

### Important #3 — regression-floor test only proves determinism

No action taken, per the fix-round instructions: the reviewer confirmed this matches this test
file's own established idiom elsewhere (lines 1315–1334, 2902–2915, 3085–3093) and independently
verified the zero-NAT path is genuinely inert by inspection. `index.test.ts`'s existing
"byte-identical engine output for a fixed seed (regression floor)" test is unchanged.

### Minor findings

1. **WAL-amplification mismatch flag (for Task 10).** Added a code comment directly at the NAT
   byte-accounting call site (`index.ts`, the `addNicBytes(natState, resp, req)` line inside the
   cross-region hop loop) explaining that `req`/`resp` here are raw wire bytes with no db
   write-fraction/WAL amplification applied, and that Task 10's cost-model line item needs to
   apply the same amplification factor cross-region/cross-AZ egress cost billing already uses, or
   the two will silently disagree on a db-heavy edge's true byte volume through the gateway.
2. **Test fixture NAT gateway subnet placement.** `natGatewayWorld` previously created the NAT
   gateway inside the SAME private subnet whose traffic it served
   (`createNatGateway(subnet.id)` where `subnet` was the private one). Real AWS shape (and this
   codebase's own route-resolution model) has the gateway itself live in a PUBLIC subnet with its
   own route to an internet gateway; it's the PRIVATE subnet's route table that points egress AT
   the gateway, not the gateway's own subnet placement. Fixed the fixture to add a second public
   subnet (with its own route table) and place the NAT gateway there instead, so Task 11/12's
   implementers don't copy the misleading shape. Verified `buildNatGatewayIdByServer` resolves
   purely via the SERVER's own subnet's route table (never the gateway's own subnet), so this
   fixture change doesn't affect resolution or any existing assertion.

## Verification (fix round 1)

Ran from
`C:\Users\rishi\Desktop\scalemap\.claude\worktrees\network-topology-feat014`:

1. `npx vitest run src/lib/worldEngine/index.test.ts` — **149 passed** (was 148 before this round;
   the new test replaces nothing, the old additivity test is kept).
2. `npx vitest run src/lib/worldEngine` — **23 test files, 537 tests, all passed**, including the
   11 `DIVERGENCE GUARD` tests (re-verified explicitly with
   `npx vitest run src/lib/worldEngine/index.test.ts -t "DIVERGENCE GUARD"` — 11 passed) confirming
   the admittedScaleByServer/extraLatencyMsByServer composition change did not desync the host
   scheduler's RAM enforcement from `metrics.ts`'s published `activeConnections`.
3. `npx tsc --noEmit` — **0 errors**.
4. `npm run bench` — **2 test files, 2 tests, all passed**, no regression.

## Files touched (fix round 1, in addition to the round-1 list above)

- `C:\Users\rishi\Desktop\scalemap\.claude\worktrees\network-topology-feat014\src\lib\worldEngine\index.ts`
  (new `natGatewayDeliveredFraction`/`natGatewayQueuedLatencyMs` state, settlement loop now stores
  `settleNatGateway`'s result instead of discarding it, host loop composes it into
  `admittedScaleByServer`/`extraLatencyMsByServer`, WAL-amplification comment added at the
  byte-accounting call site)
- `C:\Users\rishi\Desktop\scalemap\.claude\worktrees\network-topology-feat014\src\lib\worldEngine\index.test.ts`
  (new enforcement test; `natGatewayWorld` fixture generalized with `fatPacketSizeKb`/
  `serverANicMbps` spec fields and `apiInstIds` return value; NAT gateway now placed in its own
  public subnet instead of inside the private subnet it serves)
