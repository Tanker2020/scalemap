# Reverse-Proxy / Load-Balancer Blueprint Kind (`'proxy'`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user run a real self-hosted reverse proxy / load balancer (nginx, HAProxy, Envoy)
as a service on a server. It must behave like one: **each request goes to exactly ONE upstream**
(not fanned out to all of them), the proxy itself is cheap per request, it can do L4 weighted
upstream splits anywhere and L7 path routing when it is the entry tier, it prefers same-AZ
upstreams, and the analysis engine flags a single-instance proxy and a proxy tier that only
duplicates the regional LB.

**Motivation (2026-10-01):** the "Classic three-tier" vault world used to model an `lb` as a
generic `kind: 'api'` service (removed in `80dac27`). That exposed the gap: a non-DB service calls
**every** dependency with its **full** admitted rps (`flows.ts` "Call-per-request", ~line 799), so
`nginx → web` + `nginx → api` would send 100% of traffic to BOTH, doubling load. There is no way to
author a component that *routes* rather than *fans out*.

**Architecture:** One new `BlueprintKind`, `'proxy'`, plus an optional `ServiceBlueprint.proxyConfig`.
A proxy's **upstreams ARE its existing dependency edges**, so the Connections graph, firewall/path
compilation, packet mixes, wire bytes, connection profiles, cost, and NIC accounting all keep
working without a second model. The only engine change is in the flow solver: for a proxy
instance, each dependency receives `admitted × fraction(dep)` (fractions sum to ≤ 1) instead of
`admitted`. The fractions come from ONE new pure module, `src/lib/worldEngine/proxyRouting.ts`.
Everything that already reads flow **rows** (connection blending at `index.ts` ~1341, composed
latency's rps-weighted mean at `flows.ts` ~1045, bytes, cost, metrics) becomes proxy-correct for
free, because rows will carry the real per-upstream rps.

**Decisions locked in (user, 2026-10-01):**
1. **Scope:** L4 everywhere; L7 path routing only for traffic the proxy receives **directly from the
   regional LB** (entry-origin). Route identity does not survive internal hops (internal per-route
   routing is parked, see CLAUDE.md), so internal-origin traffic at an L7 proxy goes to its default
   upstream.
2. **Health:** instant, using the flow solver's existing `healthWeightOf` (down ⇒ 0, degraded ⇒
   `DEGRADED_ADMIT_FACTOR`). No interval × threshold detection lag in v1 (parked).
3. **Least-connections:** parked. Spread **within** an upstream group stays the existing
   health-weighted even split (round-robin). "Weighted" means weighting **between upstream
   groups** (`upstreamWeights`, e.g. blue/green or canary between two backend blueprints).
4. **Authoring:** a fourth kind in the VPS "add service" form (`HOSTABLE_KINDS`), co-locatable with
   other services on a general-purpose host. NOT an appliance box (`ownerServerKind` stays null).

**Tech Stack:** TypeScript, Zustand (`world.store.ts`), Vitest, React (dock drawers), existing
engine facade.

## Global Constraints

- **Regression floor:** a world with no `kind: 'proxy'` blueprint produces **byte-identical**
  `compileWorld()` and `solveFlows()`/`runStep()` output to pre-feature, asserted with `toBe`/
  `toEqual` on exact values, never `toBeCloseTo`. Every new code path is gated on
  `bp.kind === 'proxy'` (a positive test).
- `proxyConfig` is optional on `ServiceBlueprint`. `.scalemap` stays v3, with no version bump. The
  serializer defaults a missing `proxyConfig` on a `kind: 'proxy'` blueprint.
- `simulation.store.ts` remains the ONLY caller of the engine facade. `worldEngine/types.ts` changes
  (if any) are additive and logged in `.superpowers/sdd/contract-drift.md`.
- No `Math.random()` in `worldEngine`. Proxy routing is deterministic arithmetic (fractions), with
  no rng draws, so replay determinism and the rng stream are untouched.
- `connectionModel.ts`'s two-call-site invariant is NOT touched. Both call sites read flow rows, which
  this feature makes correct at the source. The `DIVERGENCE GUARD` test must stay green.
- Analysis rules go only into `ANALYSIS_RULES` via `rules/structural.ts`, and never duplicate
  `compiled.findings`.
- Theme law: `var(--color-*)` only, verified in dark and light. No emojis. All motion respects
  `prefers-reduced-motion` (this feature adds none).
- Edit-lock: every new authoring control is disabled while the simulation is running, matching
  `AddServiceForm`'s `running` pattern.
- Hub files, edited sequentially, never by two tasks in parallel: `src/lib/world/types.ts`,
  `src/lib/worldEngine/flows.ts`, `src/lib/worldEngine/index.ts`, `src/lib/world/compileWorld.ts`,
  `src/app/store/world.store.ts`.
- Done bar per task: `npx tsc --noEmit` clean, then `npx vitest run <touched test files>` green.
  The full suite, `npm run build`, `npm run bench`, and a live `npm run tauri dev` smoke run once in
  the final task.

---

## Semantics (the contract every task implements)

```ts
// types.ts
export type BlueprintKind = 'api' | 'worker' | 'db-sql' | 'db-nosql' | 'cache' | 'proxy'

export interface ProxyRule {
  id: string
  pathPattern: string      // same glob-prefix grammar as ListenerRule (nodeConfig.routeMatchesPattern)
  dependencyId: string     // one of THIS blueprint's dependencies — the upstream group
}

export interface ProxyConfig {
  mode: LbMode                                   // 'l4' | 'l7' (reuses the regional LB's type)
  // L4: share of traffic per upstream (dependency id → relative weight). Missing ⇒ 1, so one
  // upstream = forward everything and two upstreams = an even split. Weight 0 = drained upstream.
  upstreamWeights?: Record<string, number>
  // L7: first-match over entry-origin traffic's route path (authored order).
  listenerRules: ProxyRule[]                     // [] in L4
  // L7: where unmatched / pathless / internal-origin traffic goes. null ⇒ dropped (HTTP 503),
  // counted as structural refusal (a misconfiguration, not overload).
  defaultDependencyId: string | null
  // Prefer upstream instances in the proxy's own AZ while any is healthy; cross AZs only when
  // none is (nginx/Envoy zone-aware routing). Ignored for DB-blueprint upstreams: SQL writes must
  // reach the primary wherever it lives.
  preferLocalAz: boolean
}

// ServiceBlueprint
proxyConfig?: ProxyConfig   // meaningful only when kind === 'proxy'
```

**Per-request routing, one flow-solver queue item at a time** (`flows.ts`, the `for (const dep of
bp.dependencies)` loop, ~line 776):

| Item origin | L4 | L7 |
|---|---|---|
| Entry-origin (`item.parent === null` and the instance has an entry route breakdown) | fraction(dep) = w(dep) / Σw | each route's rps goes to its first-matching rule's dependency, unmatched goes to `defaultDependencyId` (null ⇒ dropped); fraction = routed rps / item total |
| Internal-origin (any other item) | same as above | 100% to `defaultDependencyId` (null ⇒ dropped) |

- Dependencies with `protocol === 'event'` get fraction 0 (a proxy doesn't forward async events),
  backed by a compile error.
- The dropped share is added to `flow.refusedRps` and `flow.structuralRefusedRps`.
- A breaker-open short-circuit refuses `admitted × fraction(dep)`, not `admitted`.
- `writeRpsByCluster` attribution uses `admitted × cacheMissFraction × fraction(dep) × writeFraction`.
- **`preferLocalAz`:** for a non-DB target, wrap `healthWeightOf` for that dependency's candidates.
  If any candidate in the proxy instance's `azId` has weight > 0, every out-of-AZ candidate's weight
  becomes 0. Otherwise weights are unchanged and traffic crosses AZs. Implemented as a weight
  override passed into `splitDependencyShares`'s existing `healthWeightOf` parameter, so there is no
  new split code.

---

## File Structure

New files:
- `src/lib/worldEngine/proxyRouting.ts` (+ `.test.ts`): pure `proxyDependencyFractions()` and
  `localAzWeightOverride()`. No React, no store, node-env tested.
- `src/lib/world/proxyFindings.ts` (+ `.test.ts`): pure compile-time validation, called from
  `compileWorld.ts`.
- `src/app/world/dock/drawers/ProxyConfigSection.tsx` (+ `.test.tsx`): mode / upstream weights /
  rules / default upstream / prefer-local-AZ editor, rendered inside `EditServiceForm`.

Modified: `world/types.ts`, `world/factories.ts`, `serializer.ts`, `world/compileWorld.ts`,
`worldEngine/flows.ts`, `worldEngine/index.ts`, `world/serviceDraft.ts`,
`dock/drawers/AddServiceForm.tsx`, `dock/drawers/EditServiceForm.tsx`, `panels/BlueprintModal.tsx`,
`connections/ConnectionsView.tsx` (EdgeInspector read-only line), `analysis/rules/structural.ts`,
`aiChat/context.ts`, `llmReview.ts`, `vault/exampleWorlds.ts` (teaching world only),
`docs/module-boundaries.md`, `CLAUDE.md`.

---

### Task 1: Types, factory default, serializer normalization

**Files:** `src/lib/world/types.ts`, `src/lib/world/factories.ts`, `src/lib/serializer.ts`
(+ `serializer.test.ts`, `factories.test.ts`)

- [ ] Add `'proxy'` to `BlueprintKind`, plus `ProxyRule` and `ProxyConfig` exactly as in **Semantics**,
  and the optional `proxyConfig?` field on `ServiceBlueprint` with a comment in the file's idiom.
- [ ] Extend `CompileFinding['kind']` with `'proxy-unknown-upstream' | 'proxy-event-upstream' |
  'proxy-l7-no-default' | 'proxy-no-upstreams'`.
- [ ] `factories.ts`: `export function defaultProxyConfig(): ProxyConfig` returning
  `{ mode: 'l4', listenerRules: [], defaultDependencyId: null, preferLocalAz: true }`.
- [ ] `serializer.ts`: in the existing `blueprints` normalization map, add: if `bp.kind === 'proxy'`
  and `proxyConfig` is absent, set `proxyConfig: defaultProxyConfig()`. Leave every other blueprint
  object reference-identical (the existing early-return pattern), so a proxy-free file round-trips
  byte-identically.
- [ ] Grep for exhaustive `switch`/`Record<BlueprintKind, …>` maps (`BlueprintModal.tsx` kind
  options, any `KIND_*` tables) and add the `'proxy'` entry so `tsc` stays clean. Labels: `'proxy'`
  ⇒ `"Reverse proxy / LB"`.
- [ ] Tests: a proxy blueprint without `proxyConfig` loads with the default. A proxy-free v3 fixture
  round-trips `toEqual` its input.

### Task 2: Pure routing module `proxyRouting.ts`

**Files:** new `src/lib/worldEngine/proxyRouting.ts` + `proxyRouting.test.ts`

```ts
export interface ProxyFractions {
  byDep: Record<string, number>   // dependency id → fraction of the item's admitted rps, Σ ≤ 1
  dropped: number                 // fraction refused (L7 unmatched with null default)
}

export function proxyDependencyFractions(
  cfg: ProxyConfig,
  deps: readonly BlueprintDependency[],
  // Entry-origin route breakdown for THIS item: route path ('' = pathless/default route) → rps.
  // undefined ⇒ internal-origin item.
  routeRps: Record<string, number> | undefined,
): ProxyFractions

export function localAzWeightOverride(
  baseWeightOf: (id: InstanceId) => number,
  candidates: readonly CompiledPath[],
  proxyAzId: AzId,
  azOf: (id: InstanceId) => AzId | undefined,
): (id: InstanceId) => number
```

- [ ] Implement per the **Semantics** table. Exclude `protocol === 'event'` deps. In L4, ignore
  weights for unknown dep ids and clamp negative weights to 0. If Σw = 0, everything is dropped
  (all upstreams drained). In L7, match with `nodeConfig.routeMatchesPattern` (the SAME matcher the
  regional LB uses, never a second implementation). A rule pointing at a non-existent or event
  dependency falls through to the next rule.
- [ ] Tests: L4 single upstream ⇒ `{dep: 1}`. L4 two upstreams ⇒ 0.5/0.5. Weights 3:1 ⇒
  0.75/0.25. All-zero ⇒ dropped 1. L7 entry with `/api/*` rule plus default ⇒ the correct split by
  route rps. L7 internal-origin ⇒ 100% default. L7 null default with unmatched ⇒ dropped share.
  Event dep excluded. Fractions sum to 1 − dropped within 1e-12. `localAzWeightOverride`:
  same-AZ healthy ⇒ remote zeroed; same-AZ all down ⇒ unchanged.

### Task 3: Compile-time validation `proxyFindings.ts`

**Files:** new `src/lib/world/proxyFindings.ts` + test, `src/lib/world/compileWorld.ts`

- [ ] `proxyFindings(doc): CompileFinding[]`, for each `kind === 'proxy'` blueprint:
  - `proxy-no-upstreams` (warning): no non-event dependencies.
  - `proxy-unknown-upstream` (error): a rule's `dependencyId`, `defaultDependencyId`, or an
    `upstreamWeights` key that isn't one of its dependencies.
  - `proxy-event-upstream` (error): a dependency with `protocol === 'event'`.
  - `proxy-l7-no-default` (warning): L7 with `defaultDependencyId === null`, with the message
    "unmatched and internal traffic will be dropped (503)".
- [ ] Append to `compiled.findings` in `compileWorld.ts`, beside `volumeFindings`. A proxy-free doc
  adds nothing, so findings stay byte-identical.
- [ ] Tests for each finding, plus one asserting `compileWorld` on every vault world is unchanged
  (`exampleWorlds.test.ts` already enforces zero findings for the clean worlds, so keep it green).

### Task 4: Flow solver applies proxy fractions (`flows.ts`, hub)

**Files:** `src/lib/worldEngine/flows.ts` + `flows.test.ts`

- [ ] Add optional `FlowInput.entryRouteRpsByInstance?: Record<InstanceId, Record<string, number>>`,
  with a comment that it is populated only for L7-proxy entry instances and absent means none.
- [ ] In the per-item dependency loop: if `bp.kind === 'proxy'`, compute once per item
  `pf = proxyDependencyFractions(bp.proxyConfig ?? defaultProxyConfig(), bp.dependencies,
  item.parent === null ? input.entryRouteRpsByInstance?.[item.instanceId] : undefined)`.
  Then for each dep, `depAdmitted = admitted * (pf.byDep[dep.id] ?? 0)`. Skip deps with 0. Use
  `depAdmitted` in place of `admitted` in the breaker refusal, `splitDependencyShares`, and
  `writeRpsByCluster`. After the loop, add `admitted * pf.dropped` to `refusedRps` and
  `structuralRefusedRps`.
- [ ] `preferLocalAz` (non-DB target only): pass
  `localAzWeightOverride(healthWeightOf, candidates, inst.azId, id => compiled.instances[id]?.azId)`
  as `splitDependencyShares`'s weight function.
- [ ] Non-proxy blueprints take exactly the old code path. Structure it so `depAdmitted === admitted`
  for them without extra arithmetic, preserving bit-identical floats.
- [ ] Tests: (a) **regression floor**: an existing fixture's `solveFlows` output is `toEqual` a
  snapshot captured before the change; (b) a proxy with two upstreams (web, api) sends ~50/50
  instead of 100/100; (c) a proxy in AZ-a with web in AZ-a and AZ-b sends 100% to AZ-a, then
  splits to AZ-b when the AZ-a web is down; (d) composed latency for the proxy is its own latency
  plus the weighted mean of its upstreams (not a sum); (e) breaker-open refuses only that
  upstream's fraction; (f) L7 null default drops into `structuralRefusedRps`.

### Task 5: Entry route breakdown for L7 proxies (`index.ts`, hub)

**Files:** `src/lib/worldEngine/index.ts` + `index.test.ts`

- [ ] At `start()`, precompute `s.l7ProxyBlueprintIds: Set<BlueprintId>` (kind `'proxy'` and mode
  `'l7'`). When empty, skip everything below (regression floor plus zero per-step cost).
- [ ] In the entry routing loop (`for (const { routeId, rps } of routeDemands)`, ~line 774), when
  the set is non-empty, distribute each route into a per-route `target` map (the existing
  `weightAccum` branch already does this, so reuse that shape and do not add a parallel loop), and
  for each `iid` whose blueprint is in the set, accumulate
  `entryRouteRps[iid][path ?? ''] += r`.
- [ ] Pass `entryRouteRpsByInstance: entryRouteRps` into `solveFlows` (~line 1891).
- [ ] Tests: a regional L4 LB → L7 proxy with rules `/api/*` → api and default → web, and a
  population with a 30% `/api/x` / 70% `/` mix: api receives ~30% and web ~70% of entry rps.
  The `DIVERGENCE GUARD` test still passes. A proxy-free world's batch is byte-identical.

### Task 6: Authoring: add-service form + draft vocabulary

**Files:** `src/lib/world/serviceDraft.ts` (+ test), `dock/drawers/AddServiceForm.tsx` (+ test)

- [ ] `HOSTABLE_KINDS = ['api', 'worker', 'cache', 'proxy']`. `defaultDraft('proxy')` ⇒
  `{ cost: 'light', memory: 'small', port: 443, visibility: 'public' }`.
- [ ] `draftWorkload('proxy', …)` uses its own CPU table `PROXY_COST_MS = { light: 0.2, medium:
  0.5, heavy: 1.5 }` (an L4 forward vs. L7 with TLS termination vs. heavy filtering/WAF), with
  `cpuMsPerKb: 0.01` so large payloads cost TLS/copy CPU. Keep `MEMORY_MB` presets. Explain the
  numbers in a comment, in the same "teaching decision" voice as `COST_MS`.
- [ ] `AddServiceForm`: label `"reverse proxy / LB"`, plus a one-line hint under the kind picker
  when `proxy` is selected: "routes each request to one upstream; add upstreams in Connections".
  On create, stamp `proxyConfig: defaultProxyConfig()`.
- [ ] Tests: the draft defaults; the form creates a proxy blueprint with a config; the kind picker
  lists four kinds.

### Task 7: Authoring: `ProxyConfigSection` in the edit form

**Files:** new `dock/drawers/ProxyConfigSection.tsx` (+ test), `dock/drawers/EditServiceForm.tsx`

- [ ] Rendered only for `kind === 'proxy'`. Upstreams are the blueprint's non-event dependencies,
  labeled by target name and port. With none, show an empty state pointing at the Connections graph.
- [ ] Controls: an L4/L7 segmented toggle, plus a `prefer same-AZ upstreams` checkbox.
  - L4: one numeric weight per upstream (`NumberField`, min 0) with a live percentage readout.
  - L7: an ordered rules list (pattern text input, upstream select, move up/down, remove), "+ rule",
    and a default-upstream select that includes "none (503)". Offer route-catalog paths
    (`listRoutes(doc.packets)`) as a datalist on the pattern input.
- [ ] All writes go through `updateBlueprint(id, { proxyConfig })`, so undo and dirty-marking come
  for free. Everything is disabled while `running`.
- [ ] Tests: toggling mode, editing a weight, adding/reordering a rule, choosing "none (503)", and
  the disabled-while-running state.

### Task 8: Analysis rules

**Files:** `src/lib/analysis/rules/structural.ts` (+ test)

- [ ] `proxy-single-instance` (warning): a proxy blueprint whose instances in a region number exactly
  1 while it has at least one upstream. Message: "All traffic through <name> in <region> depends on
  one instance (<server>, <az>). Run a proxy per AZ." Affected: blueprint, server, AZ.
- [ ] `redundant-proxy-tier` (info): a proxy that is an entry blueprint (public port), L4 (or L7
  whose rules and default all resolve to the same dependency), has exactly one non-event upstream,
  and whose upstream blueprint is not itself public. Message: "The regional LB already balances
  across <upstream>'s instances; <name> adds a hop and a failure point without routing anything.
  Make <upstream> public and remove the proxy, or give the proxy routing rules." This is exactly the
  pre-`80dac27` three-tier setup.
- [ ] Neither duplicates a `compiled.findings` kind.
- [ ] Tests: each rule fires and doesn't fire, and all three clean vault worlds still produce zero
  findings.

### Task 9: Read-only surfaces

**Files:** `connections/ConnectionsView.tsx`, `panels/BlueprintModal.tsx`, `aiChat/context.ts`,
`llmReview.ts` (+ their tests)

- [ ] EdgeInspector: for an edge whose source is a proxy, show a read-only line "upstream · 37% of
  traffic (L4 weight 3)" or "upstream · rules: /api/*, default", so a user can see that edges out of
  a proxy are one-of, not fan-out.
- [ ] BlueprintModal: `'proxy'` in the kind options. The catalog does not create proxies with
  config UI; it only edits generic fields, as for other kinds.
- [ ] `aiChat/context.ts` digest and the `llmReview` context: include a compact per-proxy summary
  (`mode`, upstream names with weights or rules, `preferLocalAz`). Confirm by test that no
  `LlmSettings` parameter is introduced (the key-security structural guarantee).

### Task 10: Teaching world + docs + full verification

**Files:** `src/lib/vault/exampleWorlds.ts`, `docs/module-boundaries.md`, `CLAUDE.md`

- [ ] `broken-teaching`: add a single public L4 `edge-proxy` in its one AZ in front of its existing
  entry service (make that service internal), so the teaching world also trips
  `redundant-proxy-tier` and `proxy-single-instance`. Its contract is "≥10 findings", so adding
  findings is safe. Keep the three clean worlds proxy-free.
- [ ] `docs/module-boundaries.md`: a new section covering the kind, the one-of semantics, the
  `proxyRouting.ts` single resolution point, the entry-origin-only L7 limitation, and the parked
  follow-ups (detection-lag health checks, least-connections, internal per-route L7).
- [ ] `CLAUDE.md`: mention `'proxy'` in the Core systems / Key Architecture Decisions text where
  blueprint kinds and the regional LB are described, and add `proxyRouting.ts` to the architecture
  tree.
- [ ] Full pass: `npx tsc --noEmit`, the full `npx vitest run`, `npm run build`, `npm run bench`
  (no regression on a proxy-free doc).
- [ ] Live smoke (`npm run tauri dev`, both themes): build regional LB → 2 proxies (one per AZ, L7)
  → web + api; add a population with a mixed route mix; confirm the split matches the rules, a
  proxy stays in its own AZ, killing one AZ's web reroutes that proxy cross-AZ, and the two
  analysis rules appear on the teaching world. No new console errors.

---

## Parked (explicitly not in this plan)

- Health-check detection lag (interval × failure threshold) at the proxy.
- Least-connections / EWMA / consistent-hash upstream selection.
- Route identity across internal hops (internal L7 proxies, service meshes).
- Proxy-specific features: response caching (use `kind: 'cache'`), rate limiting, retries/timeouts
  per upstream, TLS passthrough vs. termination as distinct modes, a connection-reuse multiplier to
  upstreams.
