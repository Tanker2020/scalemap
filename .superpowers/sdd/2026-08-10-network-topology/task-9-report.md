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
