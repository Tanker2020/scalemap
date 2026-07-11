# Polish 2 Skeleton — Command Overlays + Guided Console + Motion (7 tasks)

Task specs for the implementation plan. The executor writes each task's full plan section
(complete code, failing-test-first, exact commands, live-smoke checklist, commit step) from
these specs after grounding in real source — see the runbook's Step 0. Spec of record:
`docs/superpowers/specs/2026-07-10-polish2-config-ux-design.md`. Binding visual truth:
`docs/superpowers/specs/mockups/config-overlays-v1.html`.

## Global Constraints

- **ZERO changes under `src/lib/worldEngine/`** (frozen contracts). Forced drift →
  `.superpowers/sdd/contract-drift.md` `## POLISH 2`, never silently.
- **Relocated-dispatch contract (extends Polish 1's restyle contract):** every control this
  phase adds or moves reuses an EXISTING store dispatch byte-for-byte. New store surface is
  exactly ONE additive ui.store field (`sceneOverlay` + setter). `world.store`,
  `simulation.store`, `file.store`, `nav.store`: no new actions, no changed signatures.
- Token-only styling (`var(--color-*)` / `--kit-*`); the only sanctioned raw hexes remain
  kit.tsx's glow constants. Every new surface must pass a light-mode screenshot.
- All motion respects `prefers-reduced-motion` (no-op) EXCEPT the hold ring's progress
  sweep, which is functional feedback and stays (its glow trims off).
- Existing tests are extended, never weakened. The three Polish 1 vault tests around
  `pendingPanelTab` must pass UNTOUCHED after T4's reactive extension.
- 11px base font inside panels/overlays; `font-variant-numeric: tabular-nums` wherever
  digits column up. JetBrains Mono via the existing `--font-mono`.
- R3F components (pin gestures, Html anchoring, rotation pause) are NOT jsdom-testable —
  their gate is the named live smoke. Pure logic extracted from them IS unit-tested.

## File Structure

```
src/app/world/ui/
  kit.tsx                    # T1 extends: injected CSS (lift/press/ripple/ink), no API breaks
  motion.ts                  # T1 NEW: useRollingNumber hook (+ reduced-motion branch)
  derived.ts                 # T1 extends: healthWord(); T5 extends: frontlineCapacityRps()
  HoldToEnter.tsx            # T2 NEW: holdProgress() pure + <HoldRing> SVG component
  SceneOverlay.tsx           # T3 NEW: overlay card shell (header/chips/rows/footer slots)
  overlays/
    RegionOverlay.tsx        # T4 NEW: region overlay content (plain DOM, jsdom-testable)
    PopulationOverlay.tsx    # T4 NEW: population overlay content
src/app/store/ui.store.ts    # T3 extends: sceneOverlay + setSceneOverlay (additive)
src/app/world/globe/
  RegionPins.tsx             # T2 (hold gesture) + T3 (tap → setSceneOverlay, overlay mount)
  PopulationMarkers.tsx      # T3 (tap → setSceneOverlay, overlay mount)
  GlobeScene.tsx             # UNTOUCHED (autoRotate prop already exists)
src/app/world/GlobeView.tsx  # T3: autoRotate={!rotationLocked && sceneOverlay == null} + esc
src/app/world/panels/
  WorldPanel.tsx             # T4 (reactive pendingPanelTab) + T5 (summary strip) + T7 (ink)
  TrafficPanel.tsx           # T5: hero sentence-slider + population sentence rows
  TopologyPanel.tsx          # T6: healthWord on server rows
src/app/world/server/InspectorRail.tsx   # T6: firewall sentence re-voicing
docs/module-boundaries.md    # T7: §Q
```

---

### Task 1 — Motion foundation: kit CSS grammar, useRollingNumber, healthWord  [sonnet]

**Files:** modify `src/app/world/ui/kit.tsx` (injected stylesheet only — no component API
changes), create `src/app/world/ui/motion.ts` + `motion.test.ts`, extend
`src/app/world/ui/derived.ts` + `derived.test.ts`.

**Produces (later tasks consume):**
- kit CSS classes: `.kit-row` gains hover `transform: translateY(-1px)` + shadow (extend
  the existing `.kit-row:hover` rule); `.kit-press` (`:active { transform: scale(0.96) }`
  + border-hover glow) for buttons; `.kit-ripple` (a status-dot wrapper whose `::after`
  ripples at 1.6 s — applied only when a consumer adds the class, i.e. while running);
  `.kit-ink` (positioned underline bar, `transition: left/width 0.2s cubic-bezier(0.3, 0.8,
  0.3, 1)`); all inside the existing `@media (prefers-reduced-motion: reduce)` block →
  `transition: none; animation: none`.
- `motion.ts`: `export function useRollingNumber(target: number, durationMs = 150): number`
  — eases displayed value toward target on rAF; under reduced motion returns target
  directly. SSR/jsdom-safe (no rAF → snap).
- `derived.ts`: `export function healthWord(cpuFraction: number, ramFraction: number):
  'comfortable' | 'tight' | 'straining'` — max(cpu, ram) < 0.70 → comfortable, < 0.90 →
  tight, else straining.

**Named tests:** `useRollingNumber eases toward the target and lands exactly on it`,
`useRollingNumber snaps immediately under prefers-reduced-motion`, `healthWord thresholds at
0.70 and 0.90 on the max of the two fractions` (0.69/0 → comfortable, 0/0.71 → tight,
0.9/0.1 → straining).

---

### Task 2 — HoldToEnter primitive + region-pin drill gesture  [sonnet]

**Files:** create `src/app/world/ui/HoldToEnter.tsx` + `HoldToEnter.test.ts`, modify
`src/app/world/globe/RegionPins.tsx`.

**Produces:**
- `export function holdProgress(nowMs: number, startMs: number | null, durationMs =
  HOLD_DURATION_MS): number` — 0 when startMs null, clamped 0..1. `export const
  HOLD_DURATION_MS = 700`.
- `export function HoldRing({ progressRef, size = 34 }: { progressRef:
  { current: number }; size?: number }): ReactElement` — screen-space SVG circle (r = 15 at
  size 34, stroke `var(--kit-accent)` 2.5px, round cap, `stroke-dasharray = 2πr`), parent
  updates `stroke-dashoffset` per frame by mutating the ref the component exposes via an
  imperative `<circle ref>` — NO setState per frame. Hidden (opacity 0) at progress 0.
  Glow (`drop-shadow`) trimmed under reduced motion; the sweep itself always renders.

**RegionPins wiring (semantics, binding):** the pin mesh gets `onPointerDown` (record
`holdStartMs`, capture pointer), `onPointerUp`/`onPointerOut` (cancel if incomplete). The
existing `useFrame` computes `holdProgress(state.clock.elapsedTime * 1000, …)` and drives
the ring; at ≥1 it sets a `holdFiredRef`, clears the hold, and calls `goRegion(regionId)`.
The mesh's `onClick` becomes: if `holdFiredRef` was just set, swallow it (reset the flag);
else `setSceneOverlay({ kind: 'region', id: regionId })` — **but T3 owns the overlay call;
in this task the else-branch keeps today's `goRegion` so the app never loses navigation
between tasks.** Ring mounts as a `<Html>` sibling of the pin (same anchoring as the label,
`pointerEvents: 'none'`).

**Named tests (pure):** `holdProgress is 0 with a null start`, `holdProgress reaches exactly
1 at the duration and clamps beyond`, `holdProgress is 0.5 at half the duration`.
**Live smoke:** hold the pin → ring sweeps ~0.7 s → region view opens; release at ~half →
stays on globe, no overlay flash, ring resets; tap still navigates (T3 flips this to
overlay).

---

### Task 3 — sceneOverlay state + SceneOverlay shell + globe wiring  [sonnet]

**Files:** modify `src/app/store/ui.store.ts` (+ its test if one exists, else create
`ui.store.test.ts`), create `src/app/world/ui/SceneOverlay.tsx` + `SceneOverlay.test.tsx`,
modify `src/app/world/globe/RegionPins.tsx`, `PopulationMarkers.tsx`,
`src/app/world/GlobeView.tsx`.

**Produces:**
- ui.store additive: `sceneOverlay: { kind: 'region' | 'population'; id: string } | null`
  (initial null) + `setSceneOverlay(o: … | null): void`. Nothing existing changes.
- `SceneOverlay.tsx`: `export function SceneOverlay({ title, health, subtitle, onClose,
  children, footer }: { title: string; health?: 'healthy' | 'degraded' | 'down' | null;
  subtitle?: string; onClose: () => void; children: ReactNode; footer?: ReactNode })` —
  the mockup's `.ovl` card verbatim (296px, `#12151dee`-equivalent via
  `color-mix(in srgb, var(--color-node-base) 93%, transparent)` + blur, spring-in keyframe,
  fade-only under reduced motion, header dot + title + status word, footer slot with an
  `esc` button wired to onClose). Plain DOM — jsdom-testable.

**Wiring:** RegionPin tap (non-hold) → `setSceneOverlay({ kind: 'region', id })` (replaces
the T2 interim goRegion). PopulationMarker gains `onClick` → `setSceneOverlay({ kind:
'population', id })` (`stopPropagation`; markers previously had no click). The open
entity's pin/marker renders `<Html zIndexRange={[100, 90]}>` containing the overlay
(content components arrive in T4 — this task mounts the shell with title/subtitle/close
only). GlobeView: `autoRotate={!rotationLocked && sceneOverlay == null}`; a `keydown`
Escape listener and a canvas-background `onPointerMissed` both `setSceneOverlay(null)`;
overlay state also clears on unmount (level change).

**Named tests:** `setSceneOverlay stores and clears the selection`, `SceneOverlay renders
title, status word, children and fires onClose from the esc button`, `SceneOverlay omits
the status dot when health is undefined`.
**Live smoke:** tap us-east-1 → shell opens anchored, rotation pauses; esc closes and
rotation resumes; tap São Paulo dot → shell opens; click-away closes; hold-drill still
works and never flashes the overlay.

---

### Task 4 — Region + Population overlay content, reactive pendingPanelTab  [sonnet]

**Files:** create `src/app/world/ui/overlays/RegionOverlay.tsx` + `RegionOverlay.test.tsx`,
`src/app/world/ui/overlays/PopulationOverlay.tsx` + `PopulationOverlay.test.tsx`; modify
`src/app/world/panels/WorldPanel.tsx` + `WorldPanel.test.tsx`; wire both into the T3 shells
in `RegionPins.tsx` / `PopulationMarkers.tsx`.

**RegionOverlay props:** `{ regionId: RegionId; onClose: () => void }` — reads stores
directly (world/simulation/nav) like the panels do. Content (mockup + spec D3, binding):
chips `n AZs` / `n servers` / `~N rps in` (RegionMetrics.rps, rolled via useRollingNumber)
/ `p50 N ms` / `$N/hr` (sum of the region's servers' `hourlyUsd`, 2 dp); metrics chips show
`—` with no batch. Role `Segmented` reusing TopologyPanel's EXACT role dispatch (the
deliberate no-history `useWorldStore.setState` + `setDirty(true)` pattern — copy it
verbatim, cite the same comment). Capacity bar = mean coreUtilization across the region's
servers from the display batch. Footer: `enter ⏎` → `goRegion(regionId)`; `⚡ kill` /
`restore` → `setOutage('region', regionId, !currentlyDown)` keyed off
`healthOverrides[regionId]`, `disabled` + title "start the simulation to break things"
while `!running`; `esc` → onClose.

**PopulationOverlay props:** `{ populationId: PopulationId; onClose: () => void }`. Demand
slider 50–5000 step 50, commit-on-release → `updatePopulation(id, { peakRps })` (drag
updates only local draft + hint — the exact commit discipline TrafficPanel uses); hint line
"→ lands on <catalogId> · N ms" from the compiled routing table for this population
(ground the exact CompiledWorld field in Step 0; fall back to "routed by <policy>" when no
route resolves). `remove` → `removePopulation(id)` then onClose. `traffic panel →` →
`setPendingPanelTab('traffic')` then onClose.

**WorldPanel reactive pendingPanelTab (spec D4):** add an effect subscribing to the store
field: whenever it becomes non-null while mounted → `setTab(value)` + clear. The mount-time
initializer path stays byte-identical; the three existing vault tests pass untouched.

**Named tests:** `RegionOverlay renders authored chips at rest and — for metrics`,
`RegionOverlay role segmented dispatches the exact TopologyPanel role patch`,
`RegionOverlay kill is disabled while stopped and dispatches setOutage('region', id, true)
while running`, `PopulationOverlay slider commit dispatches updatePopulation with peakRps on
release only`, `PopulationOverlay remove dispatches removePopulation and closes`,
`WorldPanel switches to a pendingPanelTab set while mounted and clears it`.
**Live smoke:** the full overlay story — chips live under simulation, kill eu-west-1 →
pins/arcs react → restore; São Paulo slider drag shows the hint move, release persists (check
Traffic tab); `traffic panel →` switches the dock tab while WorldPanel is mounted.

---

### Task 5 — Guided console: world summary strip + traffic hero + sentence rows  [sonnet]

**Files:** modify `src/app/world/panels/WorldPanel.tsx` (+ test),
`src/app/world/panels/TrafficPanel.tsx` (+ test), extend `src/app/world/ui/derived.ts`
(+ test).

**derived.ts produces:** `export function frontlineCapacityRps(doc: WorldDoc, compiled:
CompiledWorld): number` — sum of `hostRpsCapacity(server.specs.vcpu,
blueprint.workload.cpuMsPerRequest)` over every placement of an entry blueprint (ground
"entry blueprint" the way the engine's `entryBlueprintIds` does — Step 0 reads
`src/lib/worldEngine/index.ts`'s helper WITHOUT modifying it; reimplement the same
predicate in pure form here rather than importing engine internals).

**World summary strip (WorldPanel, above the tab bar, mockup `.worldsum` verbatim):**
running → "Handling **N rps** from *n* cities across *n* regions" (N =
`world`-level batch rps via useRollingNumber; cities = population count) + line 2 health
word (● all healthy / ● 1 region degraded …), `$N/hr` (existing cost rollup the CostTab
uses — reuse its helper, don't re-derive), `p99 N ms` if the world metrics expose it (else
p50 — ground in Step 0). At rest → "3 regions · 8 servers · baseline 1,000 rps".

**Traffic hero (TrafficPanel, replaces the current bare `baselineTotalRps` NumberField
position — the NumberField itself moves under an "exact value" expander, dispatch
unchanged):** the mockup's sentence — "Send **[slider value]** requests/sec, routed to the
**[policy]** region" — slider 100–20,000 step 100, commit-on-release →
`updateTraffic({ baselineTotalRps })`; the policy slot IS the existing routing Segmented
(same dispatch, relocated). Hint line: `≈ N rps per frontline replica — comfortable (est.
M% cpu)` phrased off `frontlineCapacityRps`, warning tone when demand/capacity ≥ 0.7,
danger wording ("will shed load") ≥ 1.0; hide the hint when the world has no entry
placements. **Population sentence rows:** each population renders collapsed as
"**label** sends *N rps* → lands on <region>" (same routing lookup as T4); clicking
expands the EXISTING tuning fields unchanged beneath (identical dispatches — this is a
re-wrap, not a rebuild).

**Named tests:** `frontlineCapacityRps sums vcpu·1000/cpuMs over entry placements only`
(exact number on a two-placement fixture), `world summary at rest counts the authored doc`,
`traffic hero slider commits baselineTotalRps on release with the exact patch`,
`traffic hero hint turns warning at 70% of frontline capacity`, `population sentence row
expands to the existing fields and their dispatch is unchanged` (extend the current
TrafficPanel dispatch test).
**Live smoke:** drag the hero to 12,000 on the three-tier example → hint flips to warning →
Simulate → summary numbers roll; population row expand/commit round-trips.

---

### Task 6 — Plain words: topology health words + firewall sentences  [sonnet]

**Files:** modify `src/app/world/panels/TopologyPanel.tsx` (+ test),
`src/app/world/server/InspectorRail.tsx` (+ test).

**TopologyPanel:** ServerRow gains `healthWord(cpuMean, ramFrac)` rendered at the row's
trailing edge in the matching status color (comfortable → success, tight → warning,
straining → danger), only when metrics exist. Nothing else moves; every existing dispatch
assertion in TopologyPanel.test.tsx still passes.

**InspectorRail firewall sentences (spec D7, binding):** each rule row's READ view becomes
a sentence — ordinal, then `Let`/`Block` (success/danger tint), then the source in words
(`anyone` / `internal traffic` / the CIDR verbatim), then "reach", then
`<service word> :<port>` where the service word maps 443 https · 80 http · 5432 postgres ·
6379 redis · 22 ssh · anything else nothing (bare port), protocol appended only when not
tcp. Clicking the sentence toggles that row's existing edit inputs (which keep their
aria-labels and dispatches byte-for-byte). Reorder ↑/↓ and × keep their aria-labels,
positions, and dispatches. The `▼ evaluated top-down · first match wins ▼` caption and the
"everything else: DENIED" footer are untouched (tests reference them). Export the pure
`export function ruleSentence(rule: FirewallRule): string` from InspectorRail (or a sibling
util) for unit testing.

**Named tests:** `healthWord chip appears only with metrics and uses the status color`,
`ruleSentence: allow 443 tcp any → "Let anyone reach https :443"`, `ruleSentence: deny 6379
tcp internal → "Block internal traffic reaching redis :6379"` (match the exact copy the
implementer lands, fixed at plan-write time), `firewall reorder and remove dispatches are
unchanged after the re-voicing` (extend the existing InspectorRail tests).
**Live smoke:** teaching world → cache server → the deny :6379 rule reads as a sentence →
click it → inputs appear → fix the rule → Analysis count drops live (the Polish 1 story
still works through the new clothes).

---

### Task 7 — Motion application pass + phase gate  [sonnet]

**Files:** modify `src/app/world/panels/WorldPanel.tsx` (tab ink), sweep `.kit-press` onto
kit/act/smallBtn-family buttons (`panelStyles.ts` consumers keep inline styles — add the
class), add `.kit-ripple` to status dots in TopologyPanel/WorldPanel summary/overlays gated
on `running`, apply flow shimmer to AZ-canvas edges (React Flow `animated` when the edge's
flow > 0 — presentation-only; ground the edge-building file in Step 0) and the RegionView
cross-AZ columns if they render a flow line; `docs/module-boundaries.md` §Q;
`.superpowers/sdd/progress.md` `## POLISH 2`.

**Tab ink (binding):** the WorldPanel tab bar's per-button `borderBottom` is replaced by one
absolutely-positioned `.kit-ink` element that slides to the active tab (hover previews,
mouse-leave returns to active — mockup behavior). Tab click dispatches unchanged.

**Phase gate (live, fresh session, zero console errors):** the spec's full story — overlay
chips/kill/hold-drill → population slider → traffic hero warning → sim numbers rolling +
ripples + ink + shimmer → reduced-motion pass (ring sweeps, everything else static) →
light-mode pass over overlays, summary strip, hero, sentences → dark+light screenshots per
new surface into `.superpowers/sdd/screenshots/polish2-*`.

**Module boundaries §Q lists:** ui kit additions (motion.ts, HoldToEnter, SceneOverlay,
overlays/), the one additive ui.store field, the reactive pendingPanelTab note, and the
relocated-dispatch contract statement.
