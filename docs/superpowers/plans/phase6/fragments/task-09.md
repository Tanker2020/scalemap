# Phase 6 plan fragment — Task 9 (FINAL: phase-gate smoke, light-mode pass, CLAUDE.md
# rewrite, module-boundaries §O, four Phase-5 carry-forwards)

> Fragment scope: Task 9 — the last task of the whole 6-phase world-model rebuild. Four small,
> surgical carry-forward fixes closing out Phase 5's backlog (`MAX_GLOBE_ARCS` export,
> population-label collision, `GlobeScene` texture-mutation hook, a `buildDrainArcs` fallback
> test), a full CLAUDE.md rewrite for the world-model app, a new `docs/module-boundaries.md` §O,
> and the phase-gate done bar (full suite + build + `cargo build`/`cargo test` green, the live
> end-to-end story including a light-mode screenshot pass, and the closing SDD ledger entry).
> Global Constraints / File Structure live in the skeleton's assembled header
> (`docs/superpowers/plans/phase6/skeleton.md`) — not repeated here.
>
> **Grounding status:** every file this task touches is real, currently-committed source, quoted
> verbatim below (verified against `main`/`phase6-analysis` HEAD `4f3ce5a`, 2026-07-10) —
> `src/lib/worldEngine/index.ts`, `src/app/world/globe/ArcsLayer.tsx`, `src/app/world/globe/
> GlobeScene.tsx`, `src/app/world/panels/TrafficPanel.tsx`, `src/app/world/GlobeView.tsx`,
> `src/lib/worldEngine/globeArcs.test.ts`, `CLAUDE.md`, `docs/module-boundaries.md`. **Tasks 1–8
> have NOT executed yet at fragment-writing time** — this fragment does not depend on any of their
> output (T9's carry-forwards and docs are independent of T1–T8's files), so there is no
> reconstruction caveat here the way Phase-5's Task-6 fragment needed one for `GlobeView.tsx`. The
> one place T9 DOES reference T1–T8's shape (§O's file table, describing `src/lib/analysis/`,
> `llmReview.ts`, `AnalysisTab.tsx`, `SettingsModal.tsx`, etc.) is written from the **pinned,
> binding contracts** in `skeleton.md`/`GROUNDING.md` §C–§K, not invented — by the time T9 actually
> runs, T1–T8 will have landed and the implementer should verify §O's prose against the real
> committed files from those tasks (names/roles should match; if any diverge, fix §O to match
> reality, not the other way around).
>
> **Note on two things found while grounding this fragment that neither `skeleton.md` nor
> `GROUNDING.md` called out (not a conflict — within the explicit "keep Design System /
> Architecture accurate" instruction, so fixed here rather than left stale):**
> 1. CLAUDE.md's current "Design System" category-accent swatch (`Compute/Orchestration #4A9EFF`,
>    `Storage/Caching #F5A623`, `Network #2DD4BF`, `Messaging #A78BFA`, `Grouping #475569`) no
>    longer matches `src/lib/theme.ts`'s actual `CATEGORY_COLORS` (`compute.accent #5B9CF6`,
>    `storage/caching.accent #E0A552`, `network.accent #3FC7B8`, `messaging.accent #9C8CE0`,
>    `grouping.accent #8391A5`) — an accessibility pass (see `theme.ts`'s inline comments)
>    retuned these after the original CLAUDE.md swatch was written, and `theme.ts` also gained a
>    full `LIGHT_COLORS` sibling with per-category `foreground.light` variants that CLAUDE.md never
>    mentioned. Step 9 below fixes the swatch and adds a short light-mode note. The `DARK_COLORS`
>    surface/text/status values (canvas/node/surface/toolbar/text/danger/success/warning) are all
>    still byte-exact — only the category row was stale.
> 2. The current Key-Architecture-Decisions bullet "**Node icons:** Route all icons through
>    `NODE_CONFIG`" is now stale: `grep -rn "NODE_CONFIG\b" src` (excluding `nodeConfig.ts` itself
>    and tests) turns up zero consumers in the world-model UI — `lucide-react` itself is only
>    imported by `HomeScreen.tsx` and `nodeConfig.ts` today. Step 9 drops this bullet rather than
>    keep asserting a decision nothing currently follows.
>
> **D6 SECURITY (non-negotiable, restated in §O and the live smoke below):** the API key is NEVER
> serialized into `.scalemap`, NEVER logged/`console.*`'d, NEVER included in the review-context
> payload, REDACTED from every error string on both sides, rendered ONLY masked after save, input
> `type=password`.

---

## Task 9: Final — phase smoke, light-mode pass, CLAUDE.md, §O, carry-forwards `[sonnet]`

**Files:** modify `src/lib/worldEngine/index.ts` (one-liner — the ONLY sanctioned
`worldEngine/` edit this phase), `src/app/world/globe/ArcsLayer.tsx`,
`src/app/world/globe/GlobeScene.tsx`, `src/app/world/panels/TrafficPanel.tsx`,
`src/app/world/GlobeView.tsx`, `src/lib/worldEngine/globeArcs.test.ts` (test-only), `CLAUDE.md`,
`docs/module-boundaries.md`; create `src/lib/world/populationLabel.ts`,
`src/lib/world/populationLabel.test.ts`; append to `.superpowers/sdd/progress.md`.

---

### Part A — the four Phase-5 carry-forwards

- [ ] **Step 1: `worldEngine/index.ts` — export `MAX_GLOBE_ARCS` (the one sanctioned engine edit)**

Current line (verbatim, `src/lib/worldEngine/index.ts:43`, in the block of module-level consts
just below the imports):

```ts
const MAX_GLOBE_ARCS = 200
```

Diff:

```diff
-const MAX_GLOBE_ARCS = 200
+export const MAX_GLOBE_ARCS = 200
```

That is the entire diff to this file. Nothing else in `worldEngine/` changes. This constant is
read later in the same file by `buildArcs()` (`if (arcs.length < MAX_GLOBE_ARCS) ...`) — that
call site is untouched, `export` doesn't change local-scope usage.

- [ ] **Step 2: `ArcsLayer.tsx` — delete the hand-duplicated copy, import the real one**

Current file head (verbatim, `src/app/world/globe/ArcsLayer.tsx:1–27`):

```tsx
// src/app/world/globe/ArcsLayer.tsx
// Live great-circle traffic arcs (Phase 5 D6): attaches the globe-scope renderer once per
// `running`, writes each frame's VisualArc[] into a ref, and drives a fixed-size pool of
// THREE.Line objects (LineDashedMaterial) — geometry rebuilt only when the arc SET's signature
// changes (endpoints/kind), opacity and dash-flow updated every frame regardless. Dash flow is
// driven by mutating the geometry's `lineDistance` attribute in place (this three.js build's
// classic LineDashedMaterial has no `dashOffset` uniform — see the PoolEntry comment below), not
// a material property. Mounted as a GlobeScene child (T3), alongside RegionPins/PopulationMarkers
// (T4) — lives in the same rotating group so arcs track the globe's orientation. R3F component;
// NOT jsdom-tested (no WebGL there) — this task's live smoke is the gate. arcsSignature is the
// one exported pure helper, unit-tested in ArcsLayer.test.ts.
import { useEffect, useRef, type ReactElement } from 'react'
import { useFrame } from '@react-three/fiber'
import { useReducedMotion } from 'framer-motion'
import * as THREE from 'three'
import { useSimulationStore } from '../../store/simulation.store'
import { greatCirclePoints } from './geo'
import type { VisualArc, FramePayload } from '../../../lib/worldEngine/types'

// Mirrors worldEngine's own (unexported) MAX_GLOBE_ARCS — the pool only ever needs to match the
// engine's own render cap (D6); not importable, so kept in sync manually here.
const MAX_GLOBE_ARCS = 200
const ARC_SEGMENTS = 48
const ARC_RADIUS = 1.001
const DASH_SIZE = 0.045
const GAP_SIZE = 0.03
const DASH_SPEED = 0.15   // dashOffset units/sec
```

Diff (import block gains one line; the two-line "mirrors worldEngine's own" comment + its
`const` are deleted — everything below, including `ARC_SEGMENTS`/`ARC_RADIUS`/etc., is
unaffected since `MAX_GLOBE_ARCS` is still an in-scope identifier, now import-bound instead of
locally declared):

```diff
 import { useEffect, useRef, type ReactElement } from 'react'
 import { useFrame } from '@react-three/fiber'
 import { useReducedMotion } from 'framer-motion'
 import * as THREE from 'three'
 import { useSimulationStore } from '../../store/simulation.store'
 import { greatCirclePoints } from './geo'
+import { MAX_GLOBE_ARCS } from '../../../lib/worldEngine'
 import type { VisualArc, FramePayload } from '../../../lib/worldEngine/types'

-// Mirrors worldEngine's own (unexported) MAX_GLOBE_ARCS — the pool only ever needs to match the
-// engine's own render cap (D6); not importable, so kept in sync manually here.
-const MAX_GLOBE_ARCS = 200
 const ARC_SEGMENTS = 48
 const ARC_RADIUS = 1.001
 const DASH_SIZE = 0.045
 const GAP_SIZE = 0.03
 const DASH_SPEED = 0.15   // dashOffset units/sec
```

Every other use of `MAX_GLOBE_ARCS` later in the file (the pool-build loop, the per-frame
truncation guards) is a bare identifier reference — unchanged text, now resolved via the import
instead of the deleted local const.

- [ ] **Step 3: verify the import resolves — no separate barrel file needed**

`src/lib/worldEngine/` has no separate `barrel.ts` — `index.ts` IS the module's resolution
target for a bare-directory import (confirmed precedent already in this repo:
`src/app/store/simulation.store.ts:11` does `import { worldEngine } from '../../lib/worldEngine'`
and `bench/enginePerf.bench.test.ts:15` does `import { createWorldEngine } from
'../src/lib/worldEngine'` — both resolve to `index.ts` today). So Step 1's `export const` is
immediately sufficient; `ArcsLayer.tsx`'s new `from '../../../lib/worldEngine'` (three `../` from
`src/app/world/globe/` to `src/lib/`, matching the file's own existing `'../../../lib/worldEngine/
types'` import one line below it) needs no additional re-export step. Run:

`npx vitest run src/app/world/globe/ArcsLayer.test.ts` → PASS (4/4, unaffected — the test file
only exercises the exported `arcsSignature` helper, never `MAX_GLOBE_ARCS` directly).
`npx tsc --noEmit` (or `npm run build`) → no new errors; `MAX_GLOBE_ARCS`'s inferred type
(`number`, literal-widened) is identical whether declared locally or imported.

- [ ] **Step 4: population default-label collision — new shared helper**

Backlog text (`.superpowers/sdd/progress.md`'s `## PHASE 5 COMPLETE` "OPEN ITEMS for Phase 6",
verbatim): *"Duplicate default population label after remove+re-add [TrafficPanel.tsx pop-N +
GlobeView.tsx pop-N independent length counters; no uniqueness spec; labels editable] — one-line
fix (max-suffix scan / monotonic counter) if picked up."*

Create `src/lib/world/populationLabel.ts` (new file — lib-layer home, alongside `regionGeo.ts`/
`routing.ts`/etc., so both `TrafficPanel.tsx` (`app/world/panels/`) and `GlobeView.tsx`
(`app/world/`) can import it without either depending on the other):

```ts
// src/lib/world/populationLabel.ts
// Shared default-label generator for client populations (Phase 6 T9 carry-forward, closing a
// Phase-5 backlog item). TrafficPanel.tsx's "+ add" and GlobeView.tsx's click-to-place handler
// each independently derived `pop-${N}` from a LENGTH counter (`populations.length + 1` /
// `populationCount + 1`) — after a remove+re-add from either surface the two counters can
// re-issue the SAME default label (labels are user-editable free text, not unique ids, but a
// silent duplicate default is still a rough edge worth closing). This scans the actual
// populations map for the highest existing `pop-<N>` suffix and returns `pop-<max+1>`, so neither
// authoring surface can collide with the other, or with a population manually renamed back to a
// `pop-N`-shaped label.
import type { ClientPopulation, PopulationId } from './types'

const POP_LABEL_RE = /^pop-(\d+)$/

export function nextPopulationLabel(populations: Record<PopulationId, ClientPopulation>): string {
  let max = 0
  for (const pop of Object.values(populations)) {
    const m = POP_LABEL_RE.exec(pop.label)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `pop-${max + 1}`
}
```

Create `src/lib/world/populationLabel.test.ts` (pure, node env, no `@vitest-environment` pragma —
per the repo convention, §B of `GROUNDING.md`):

```ts
// src/lib/world/populationLabel.test.ts
import { describe, it, expect } from 'vitest'
import { nextPopulationLabel } from './populationLabel'
import { createPopulation } from './factories'
import type { ClientPopulation, PopulationId } from './types'

function byId(pops: ClientPopulation[]): Record<PopulationId, ClientPopulation> {
  const out: Record<PopulationId, ClientPopulation> = {}
  for (const p of pops) out[p.id] = p
  return out
}

describe('nextPopulationLabel', () => {
  it('returns pop-1 for an empty population map', () => {
    expect(nextPopulationLabel({})).toBe('pop-1')
  })

  it('scans the max existing pop-N suffix rather than counting entries', () => {
    const a = createPopulation('pop-1', 0, 0)
    const b = createPopulation('pop-3', 0, 0)
    expect(nextPopulationLabel(byId([a, b]))).toBe('pop-4')
  })

  it('ignores non-matching / manually-renamed labels', () => {
    const a = createPopulation('nyc', 0, 0)
    const b = createPopulation('pop-2', 0, 0)
    expect(nextPopulationLabel(byId([a, b]))).toBe('pop-3')
  })

  it('is stable after a remove + re-add that would collide under a length-based counter', () => {
    // Reproduces the exact Phase-5 backlog scenario: pop-1 and pop-2 both added, then pop-1
    // removed (leaving one entry — length 1). A naive `pop-${length + 1}` would re-issue
    // 'pop-2', a real duplicate. The max-suffix scan instead sees the surviving 'pop-2' and
    // correctly continues at 'pop-3'.
    const survivor = createPopulation('pop-2', 0, 0)
    expect(nextPopulationLabel(byId([survivor]))).toBe('pop-3')
  })
})
```

Run: `npx vitest run src/lib/world/populationLabel.test.ts` → PASS (4/4).

- [ ] **Step 5: wire the helper into `TrafficPanel.tsx`**

Current imports (verbatim, `src/app/world/panels/TrafficPanel.tsx:7–10`):

```tsx
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useWorldStore } from '../../store/world.store'
import type { DiurnalPattern, RegionId, RoutingPolicyKind } from '../../../lib/world/types'
import { sectionLabel, field, smallBtn, dangerBtn, row } from './panelStyles'
```

Diff:

```diff
 import { useEffect, useRef, useState, type ReactElement } from 'react'
 import { useWorldStore } from '../../store/world.store'
 import type { DiurnalPattern, RegionId, RoutingPolicyKind } from '../../../lib/world/types'
+import { nextPopulationLabel } from '../../../lib/world/populationLabel'
 import { sectionLabel, field, smallBtn, dangerBtn, row } from './panelStyles'
```

Current `addDraft` (verbatim, `src/app/world/panels/TrafficPanel.tsx:79–87`, inside
`PopulationsSection` where `doc` is already destructured via `const doc = useWorldStore(s =>
s.doc)` at the top of the function):

```tsx
  const addDraft = () => {
    const label = draftLabel.trim() || `pop-${populations.length + 1}`
    // addPopulation's factory hardcodes peakRps:500/diurnal:'flat' (src/lib/world/factories.ts)
    // — it has no param for either, so the draft rps/diurnal only reach the store via this
    // follow-up patch.
    const id = addPopulation(label, draftLat, draftLon)
    updatePopulation(id, { peakRps: draftRps, diurnal: draftDiurnal })
    setDraftLabel('')
  }
```

Diff:

```diff
   const addDraft = () => {
-    const label = draftLabel.trim() || `pop-${populations.length + 1}`
+    // Phase 6 T9 carry-forward: shared max-suffix scan (src/lib/world/populationLabel.ts)
+    // instead of `pop-${populations.length + 1}` — a length-based counter reissues a stale
+    // label after a remove+re-add (Phase-5 backlog item); GlobeView.tsx's place-on-globe
+    // handler uses the same helper so neither authoring surface can collide with the other.
+    const label = draftLabel.trim() || nextPopulationLabel(doc.populations)
     // addPopulation's factory hardcodes peakRps:500/diurnal:'flat' (src/lib/world/factories.ts)
     // — it has no param for either, so the draft rps/diurnal only reach the store via this
     // follow-up patch.
     const id = addPopulation(label, draftLat, draftLon)
     updatePopulation(id, { peakRps: draftRps, diurnal: draftDiurnal })
     setDraftLabel('')
   }
```

`populations` (the `Object.values(doc.populations)` array, used elsewhere in this same function
for the empty-state check and the `.map` render) is untouched and still used — only this one call
site changes. `doc` is already in scope; no new selector needed.

**Existing test unaffected:** `TrafficPanel.test.tsx`'s `'add and edit population dispatches
store actions with exact patches'` case starts from `useWorldStore.getState().newWorld()`
(`beforeEach`) — an empty `populations` map — so `nextPopulationLabel({})` still returns
`'pop-1'`, matching the test's existing `expect(pops[0]).toMatchObject({ label: 'pop-1', ... })`
assertion verbatim. No test file edit needed here.

- [ ] **Step 6: wire the helper into `GlobeView.tsx`**

Current imports (verbatim, `src/app/world/GlobeView.tsx:7–15`):

```tsx
import type { CSSProperties } from 'react'
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { GlobeScene } from './globe/GlobeScene'
import { GlobeCards } from './GlobeCards'
import { RegionPins } from './globe/RegionPins'
import { PopulationMarkers } from './globe/PopulationMarkers'
import { ArcsLayer } from './globe/ArcsLayer'
import { webglAvailable } from './globe/webgl'
```

Diff:

```diff
 import type { CSSProperties } from 'react'
 import { useWorldStore } from '../store/world.store'
 import { useNavStore } from '../store/nav.store'
 import { GlobeScene } from './globe/GlobeScene'
 import { GlobeCards } from './GlobeCards'
 import { RegionPins } from './globe/RegionPins'
 import { PopulationMarkers } from './globe/PopulationMarkers'
 import { ArcsLayer } from './globe/ArcsLayer'
 import { webglAvailable } from './globe/webgl'
+import { nextPopulationLabel } from '../../lib/world/populationLabel'
```

Current component body (verbatim, `src/app/world/GlobeView.tsx:45–57`):

```tsx
export function GlobeView({ placeMode, onExitPlaceMode, onPopulationPlaced }: GlobeViewProps) {
  const addPopulation = useWorldStore(s => s.addPopulation)
  const populationCount = useWorldStore(s => Object.keys(s.doc.populations).length)

  // Place-mode is armed/disarmed by WorldShell (the common ancestor of this component and
  // TrafficPanel) via the placeMode prop; a click on the globe here places a population, then
  // hands control back up so WorldShell can disarm and TrafficPanel can select+focus the new row.
  const onPlace = (lat: number, lon: number) => {
    const label = `pop-${populationCount + 1}`
    const id = addPopulation(label, lat, lon)
    onExitPlaceMode()
    onPopulationPlaced(id)
  }
```

Diff:

```diff
 export function GlobeView({ placeMode, onExitPlaceMode, onPopulationPlaced }: GlobeViewProps) {
   const addPopulation = useWorldStore(s => s.addPopulation)
-  const populationCount = useWorldStore(s => Object.keys(s.doc.populations).length)
+  const populations = useWorldStore(s => s.doc.populations)

   // Place-mode is armed/disarmed by WorldShell (the common ancestor of this component and
   // TrafficPanel) via the placeMode prop; a click on the globe here places a population, then
   // hands control back up so WorldShell can disarm and TrafficPanel can select+focus the new row.
   const onPlace = (lat: number, lon: number) => {
-    const label = `pop-${populationCount + 1}`
+    // Phase 6 T9 carry-forward: same shared max-suffix helper TrafficPanel.tsx's "+ add" uses —
+    // this file's previous `pop-${populationCount + 1}` and TrafficPanel's independent
+    // `pop-${populations.length + 1}` counter could reissue the same label after a
+    // remove+re-add from either surface (Phase-5 backlog item).
+    const label = nextPopulationLabel(populations)
     const id = addPopulation(label, lat, lon)
     onExitPlaceMode()
     onPopulationPlaced(id)
   }
```

The selector changes from a derived `number` (`Object.keys(...).length`) to the populations
record itself — still a plain Zustand selector by reference (same pattern `TrafficPanel.tsx`
already uses for `doc`), no behavior change to re-render frequency in practice (the populations
map reference only changes when populations actually change, same as every other `world.store`
selector in this codebase).

**Existing test unaffected:** `GlobeView.test.tsx`'s two cases only exercise the WebGL-unavailable
fallback branch (`webglAvailable` mocked false) — `onPlace`/`populations` are never reached by
either case (grep-verified: no `pop-` or `onPlace`/`addPopulation` reference in that test file).
No test file edit needed here.

- [ ] **Step 7: `GlobeScene.tsx` — texture mutation `useMemo` → `useLayoutEffect`**

Current imports (verbatim, `src/app/world/globe/GlobeScene.tsx:7`):

```tsx
import { Suspense, useCallback, useMemo, useRef, type ReactElement, type ReactNode } from 'react'
```

Diff (adds `useLayoutEffect`; `useMemo` stays imported — `Atmosphere()`'s `uniforms` still uses
it further down the same file, untouched by this step):

```diff
-import { Suspense, useCallback, useMemo, useRef, type ReactElement, type ReactNode } from 'react'
+import { Suspense, useCallback, useLayoutEffect, useMemo, useRef, type ReactElement, type ReactNode } from 'react'
```

Current `Earth` body (verbatim, `src/app/world/globe/GlobeScene.tsx:61–72`):

```tsx
function Earth({ placeMode, onPlace }: EarthProps): ReactElement {
  const texture = useTexture(earthTextureUrl)
  useMemo(() => {
    texture.wrapS = THREE.RepeatWrapping
    texture.offset.x = TEXTURE_LON_OFFSET
    texture.colorSpace = THREE.SRGBColorSpace
    // useTexture returns an already-uploaded texture; changing wrap mode after upload needs
    // needsUpdate so the GPU sampler is re-configured — otherwise some three.js versions keep
    // ClampToEdge and smear a seam at the offset's wrap boundary. (wrapT/repeat unchanged: the
    // offset only shifts horizontally and the image already spans the full 0..1 V range.)
    texture.needsUpdate = true
  }, [texture])
```

Diff:

```diff
 function Earth({ placeMode, onPlace }: EarthProps): ReactElement {
   const texture = useTexture(earthTextureUrl)
-  useMemo(() => {
+  // Phase 6 T9 carry-forward: this texture wrap/offset mutation is a SIDE EFFECT (mutating a
+  // shared THREE.Texture instance + flagging it for a GPU re-upload), not a memoized pure
+  // derivation — useLayoutEffect is the conventional home for a synchronous, pre-paint
+  // side effect. useMemo happened to work because its body also runs synchronously during
+  // render, but React does not guarantee a useMemo body runs exactly once per input or is
+  // never re-invoked/discarded (e.g. under future concurrent-rendering behavior) the way an
+  // effect's cleanup/rerun contract is guaranteed. Same dependency array, same body, same
+  // texture.needsUpdate=true flag — behavior-preserving.
+  useLayoutEffect(() => {
     texture.wrapS = THREE.RepeatWrapping
     texture.offset.x = TEXTURE_LON_OFFSET
     texture.colorSpace = THREE.SRGBColorSpace
     // useTexture returns an already-uploaded texture; changing wrap mode after upload needs
     // needsUpdate so the GPU sampler is re-configured — otherwise some three.js versions keep
     // ClampToEdge and smear a seam at the offset's wrap boundary. (wrapT/repeat unchanged: the
     // offset only shifts horizontally and the image already spans the full 0..1 V range.)
     texture.needsUpdate = true
   }, [texture])
```

No test file covers this (R3F components aren't jsdom-tested in this repo, per `ArcsLayer.tsx`'s
own header comment) — the live smoke (Step 15 below) re-verifies the globe texture still renders
correctly (not mirrored, seam-free) after this change, since it's the phase's known
highest-calibration-risk surface (see `GlobeScene.tsx`'s own `TEXTURE_LON_OFFSET` comment).

- [ ] **Step 8: `buildDrainArcs` missing-geo fallback test — TEST-ONLY addition to `globeArcs.test.ts`**

Backlog text (verbatim): *"buildDrainArcs `?? [pop.lat,pop.lon]` fallback untested [reachable
only if a prev region's catalogId lacks REGION_GEO; defensive, low-risk]."* This is a test-only
addition — **no `worldEngine/` source change** (the fallback logic in `buildDrainArcs`,
`src/lib/worldEngine/index.ts:556`, is untouched).

The fallback triggers when `geoOfRegion(prevRegionId)` returns `null` for the population's
PREVIOUS region during a pending failover — i.e. that region's `catalogId` has no entry in
`REGION_GEO` (`src/lib/world/regionGeo.ts`). `'geo'`/`'latency'` routing policies rank a
geo-less region LAST (`distanceScore` in `src/lib/world/routing.ts:9-13` returns
`Number.MAX_SAFE_INTEGER` for a missing geo entry), so reaching a scenario where a geo-less
region is the population's FIRST (and therefore "previous", once it fails over) resolved region
needs `'priority'` policy to force it there regardless of distance.

Add a new fixture function to `src/lib/worldEngine/globeArcs.test.ts`, placed after
`singleRegionFixture` and before the `drive` helper (i.e. immediately following the existing
`singleRegionFixture(popCount)` function, verbatim end at line 209, and before `function
drive(...)` at line 211):

```ts
// Reproduces the exact carry-forward scenario Phase 5's final review flagged as untested:
// buildDrainArcs' `?? [pop.lat,pop.lon]` fallback (index.ts ~line 556) only triggers when the
// POPULATION'S PREVIOUS region (captured in the engine's internal popPrevRegion map at the
// moment failover starts) has a catalogId missing from REGION_GEO — geoOfRegion(prevRegionId)
// returns null, and the drain arc's fromLatLon falls back to the population's own lat/lon
// instead of the (unresolvable) previous region's geo. 'priority' routing (not 'geo'/'latency',
// which would rank the geo-less region LAST via distanceScore's Number.MAX_SAFE_INTEGER
// fallback, src/lib/world/routing.ts) forces the population onto the geo-less region FIRST
// regardless of distance, so the failover's "previous" region is the one missing from REGION_GEO.
function missingGeoFailoverFixture() {
  const doc = createWorld()
  doc.traffic.autoBaseline = false
  doc.routing.policy = 'priority'
  doc.routing.dnsTtlSec = 5

  const r1 = createRegion('not-a-real-region')   // catalogId deliberately absent from REGION_GEO
  const r2 = createRegion('us-east-1')
  doc.routing.priorityOrder = [r1.id, r2.id]
  Object.assign(doc.regions, { [r1.id]: r1, [r2.id]: r2 })

  const az1 = createAz(r1.id, 'not-a-real-region-a')
  const az2 = createAz(r2.id, 'us-east-1a')
  Object.assign(doc.azs, { [az1.id]: az1, [az2.id]: az2 })

  const s1 = createServer(az1.id, getPreset('dedicated-8')!)
  const s2 = createServer(az2.id, getPreset('dedicated-8')!)
  Object.assign(doc.servers, { [s1.id]: s1, [s2.id]: s2 })

  const web = publicBlueprint('web', 0)
  Object.assign(doc.blueprints, { [web.id]: web })

  const place = (bpId: string, serverId: string) => { const pl = createPlacement(bpId, serverId); doc.placements[pl.id] = pl; return pl }
  place(web.id, s1.id)
  place(web.id, s2.id)

  const pop = createPopulation('nyc', 40.7, -74.0)
  pop.peakRps = 50
  doc.populations[pop.id] = pop

  const compiled = compileWorld(doc)
  return { doc, compiled, r1, r2, pop }
}
```

Add a new `it(...)` to the `describe('buildArcs v2 (globe scope)', ...)` block, immediately
after the existing `'drain arc from old to new region during pending failover, then clears'` case
(ends at line 361) and before `'cap truncates drain last, keeping client arcs first'`:

```ts
  it("drain arc falls back to the population's own lat/lon when the previous region has no REGION_GEO entry", () => {
    // Phase-5 final-review MINOR, closed as a Phase-6 T9 carry-forward: the buildDrainArcs
    // `?? [pop.lat,pop.lon]` fallback branch had no test — it's reachable only when the
    // FAILED-OVER-FROM region's catalogId is missing from REGION_GEO (geoOfRegion returns null).
    const f = missingGeoFailoverFixture()
    const sim = drive(f.doc, f.compiled)
    const frames: FramePayload[] = []
    sim.engine.attachRenderer({ level: 'globe' }, p => frames.push(p))
    sim.stepFor(3)                                    // warm DNS cache -> r1 (priority-first, despite no geo)
    sim.engine.setOutage('region', f.r1.id, true)

    // Same step-until-event-fires pattern as the "drain arc from old to new region" case above.
    let startedFrame: FramePayload | null = null
    for (let i = 0; i < 100 && !startedFrame; i++) {
      sim.engine.__test_step(1)
      sim.engine.__test_render(1000)
      if (sim.events.some(e => e.kind === 'failover_started')) startedFrame = frames[frames.length - 1]
    }
    expect(startedFrame).not.toBeNull()
    const drainArcs = startedFrame!.arcs.filter(a => a.kind === 'drain')
    expect(drainArcs).toHaveLength(1)
    // r1's catalogId ('not-a-real-region') has no REGION_GEO entry, so geoOfRegion(r1.id) is
    // null and fromLatLon falls back to the population's own [lat, lon] instead of r1's geo.
    expect(drainArcs[0].fromLatLon).toEqual([f.pop.lat, f.pop.lon])
    const geoR2 = REGION_GEO['us-east-1']
    expect(drainArcs[0].toLatLon).toEqual([geoR2.lat, geoR2.lon])
    sim.engine.stop()
  })
```

No import changes needed — `createWorld`/`createRegion`/`createAz`/`createServer`/
`createPlacement`/`createPopulation`/`getPreset`/`compileWorld`/`REGION_GEO`/`publicBlueprint`/
`drive` are all already imported/defined earlier in this file.

Run: `npx vitest run src/lib/worldEngine/globeArcs.test.ts` → PASS (9/9 — the 8 existing cases
plus this new one).

- [ ] **Step 9: run the full suite + build to verify all four carry-forwards together**

Run: `npx vitest run` → full suite green (adds 1 new file `populationLabel.test.ts` [4 tests] + 1
new case in `globeArcs.test.ts` [now 9]; `TrafficPanel.test.tsx`/`GlobeView.test.tsx`/
`ArcsLayer.test.ts` all still green, no edits needed to any of them per Steps 5/6/3's "existing
test unaffected" notes).
Run: `npm run build` → strict tsc + vite build green (no new deps, no type changes).

---

### Part B — CLAUDE.md rewrite

- [ ] **Step 10: replace the "Project Overview" section**

Current section (verbatim, `CLAUDE.md` lines 5–21):

```md
## Project Overview

Scalemap is a desktop application (Tauri 2 + React 19 + TypeScript) for visualizing and simulating infrastructure systems. Users drag infrastructure nodes onto a canvas, wire them together, and run a client-side traffic simulation that animates request/event/stream particles across the graph, computes per-node metrics (throughput, latency, error rate, queue depth), estimates cloud cost, and flags structural design issues (SPOFs, exposed databases, unbalanced load balancers, etc.).

The app is well past scaffold stage. Core systems that exist today:

- **Canvas** (`@xyflow/react`) with 18 custom compute/network/storage/messaging/caching node types and 8 group/container node types (VPC, subnet, AZ, region, k8s cluster, ECS cluster, Docker Compose, namespace), all with fully custom node/edge rendering.
- **Simulation engine** — a `requestAnimationFrame` particle engine driving live per-node metrics, replay/scrubbing, and a request inspector.
- **Packet system** — a Flyweight-style registry of packet templates (generic or user-defined protocols: http, event, stream, db) shared across edges.
- **Structural linter** — 9 rules that flag design smells in the graph (see below).
- **Cost model** — per-provider (AWS/GCP/Azure) pricing keyed off simulated traffic volume, with tiered egress billing.
- **ScaleScript** — a declarative JSON DSL for parameterizing a simulation run (node/edge overrides, timed scenarios, global SLOs).
- **Terraform export** (one-way: diagram → HCL). There is no Terraform *import*/parsing — see Roadmap.
- **Vault templates** — prebuilt starter diagrams (web, serverless, event-driven, k8s, data, network patterns).
- **.scalemap file persistence** via Tauri commands, with a `localStorage`-backed mock for browser-only dev.

There is no `prd.txt` in the repo (it has been removed); this file is the source of truth for scope and architecture.
```

Replace with:

```md
## Project Overview

Scalemap is a desktop application (Tauri 2 + React 19 + TypeScript) for authoring and simulating
multi-region infrastructure "worlds." Users build a world at four zoom levels — globe → region →
availability zone → server — out of regions, AZs, servers, service blueprints, placements, and
managed services; `compileWorld()` resolves that document into concrete service instances and
permitted/blocked network paths; a from-scratch client-side simulation engine
(`src/lib/worldEngine/`) ticks the compiled world at a fixed step rate and publishes live
per-instance/server/AZ/region metrics, engine events, and replay frames that drive every view. A
deterministic analysis-rule engine and an on-demand LLM architecture reviewer surface design
issues (structural SPOFs, exposed databases, capacity/geo problems, plus free-form AI-found
issues) alongside a cost model and traffic-authoring tools.

This is the app's SECOND full architecture: the original React-Flow "canvas" prototype —
hand-wired nodes/edges, a particle-based `requestAnimationFrame` simulation, a 9-rule structural
linter, a ScaleScript DSL, one-way Terraform export, and vault templates — was deleted wholesale
in Phase 2 of a ground-up rebuild (2026-07-08) and replaced by everything described below. None
of the legacy systems exist in the codebase today; do not assume any of them do (see
`docs/module-boundaries.md`'s §1A–§1I for exactly what was removed and why, if that history is
ever needed).

Core systems that exist today:

- **World document model** (`src/lib/world/`) — a normalized `WorldDoc` (regions, AZs, servers,
  service blueprints, placements, managed services, client populations, routing/traffic config)
  plus `compileWorld(doc)`, the pure gate every other system reads through: it resolves
  placements into concrete `ServiceInstance`s, evaluates firewall/port/network-isolation rules
  into permitted/blocked `CompiledPath`s, builds routing tables, and emits structural
  `CompileFinding`s. Nothing downstream — views, the engine, analysis rules — reads the raw
  `WorldDoc` for anything derived; always `compiled`.
- **World engine** (`src/lib/worldEngine/`) — a from-scratch, deliberately-ported (not reused)
  discrete fixed-step simulation: demand generation, DNS-TTL-cached region routing with health
  checks and failover, per-host CPU/RAM scheduling, VPS burstable-credit/noisy-neighbor modeling,
  NIC byte-rate caps, per-dependency circuit breakers, a BFS flow solver, replica promotion, a 1
  Hz metrics pyramid (instance→server→AZ→region→world), an event ring, and a replay buffer.
  Exposed as one facade — `createWorldEngine()` / the shared `worldEngine` singleton — driven
  ONLY by `simulation.store.ts`; every view reads that store, never the engine directly.
- **Four-level navigation shell** (`src/app/world/`, `nav.store.ts`'s `WorldLevel`) — a
  react-three-fiber globe (night-earth, health-colored region pins, population markers,
  engine-driven great-circle traffic arcs) → a region flow page (cross-AZ traffic columns, rack
  chassis) → a live React Flow AZ canvas → a per-server "circuit board" view (NIC/firewall gate,
  service chips, a unified hardware platform). All four are live-metrics-aware and
  replay-scrubbable.
- **Traffic authoring** — client populations (placed by hand or by clicking the globe),
  auto-baseline synthetic per-region demand, and routing policy (latency/geo/weighted/priority)
  with DNS TTL + health-check tuning.
- **Analysis engine** (`src/lib/analysis/`) — three rule families (structural/network-security/
  capacity, 13 rules) run over the compiled world plus the latest metrics batch, rendered in an
  `Analysis` tab merged with compile findings, with clickable affected-entity chips that jump to
  the region/AZ/server in question.
- **LLM architecture reviewer** (`src/lib/llmReview.ts`) — on-demand, schema-validated review
  against any OpenAI-compatible endpoint, rendered as AI-tagged cards beside the deterministic
  findings. The actual HTTP call is Rust-side (`llm_chat` Tauri command — a webview `fetch` to
  arbitrary hosts dies on CORS); settings persist to the app data dir and are never serialized
  into `.scalemap`, logged, or echoed unmasked (see Key Architecture Decisions).
- **Cost model** (`src/lib/costModelV2.ts`) — per-server hourly cost + managed-service pricing
  (`cloudRegistry.ts`) rolled up by region/AZ, plus tiered cross-AZ/cross-region/internet egress
  costed off live simulated byte rates.
- **Global Settings** (⚙ button, `SettingsModal.tsx`) — the app's dark/light theme toggle (now
  actually reachable from the UI) and the LLM endpoint configuration above.
- **`.scalemap` v2 file persistence** via Tauri commands, with a `localStorage`-backed mock for
  browser-only dev, plus a 30-second dirty-triggered autosave snapshot.

There is no `prd.txt` in the repo; this file is the source of truth for scope and architecture.
`docs/module-boundaries.md` is the detailed, file-by-file companion — more current than the prose
above for any specific file's history.
```

- [ ] **Step 11: fix the one stale line in "Commands"**

Current line (verbatim, `CLAUDE.md` lines 40–41):

```md
# Run frontend tests (vitest is configured; no test files exist yet — see Roadmap)
npx vitest
```

Diff (rest of the Commands section, including the code fence and every other command, is
byte-unchanged):

```diff
-# Run frontend tests (vitest is configured; no test files exist yet — see Roadmap)
+# Run frontend tests (extensive vitest coverage — jsdom for components, node env for pure
+# rule/engine logic)
 npx vitest
```

- [ ] **Step 12: replace the "Architecture" ASCII tree**

Current section (verbatim, `CLAUDE.md` lines 52–116, the whole fenced tree between `## Architecture`
and the following `---`) — reproduced in full in the current file, omitted here for length; every
line under it describes files deleted in Phase 2 (`canvas.store.ts`, `particleEngine.ts`,
`lint/`, `terraform/`, etc. — see `docs/module-boundaries.md` §1A–§1I). Replace the entire fenced
block with:

````md
```
src/
  App.tsx                        # useThemeBootstrap + ⌘N/⌘Z/⇧⌘Z global handlers + 30s
                                  # dirty-triggered autosave + HomeScreen/WorldShell gate
  main.tsx
  app/
    store/                       # Zustand, one store per domain — no monolithic store
      nav.store.ts                # WorldLevel ('globe'|'region'|'az'|'server') + regionId/azId/
                                   # serverId focus; deliberately has no dependency on world.store
      world.store.ts              # WorldDoc CRUD + undo/redo (history/future snapshots) +
                                   # dirty-marking on every mutation
      simulation.store.ts         # running/timeScale/latestBatch/events/healthOverrides/
                                   # scrubIndex/scrubBatch/degraded — the ONLY caller of
                                   # worldEngine directly; every view reads this store instead
      file.store.ts               # File path, dirty flag, recent files
      ui.store.ts                 # themeMode ('dark'|'light') + setThemeMode — persisted,
                                   # now user-facing via the Settings modal
    world/
      WorldShell.tsx               # Header (breadcrumb, SimControls, ⚙ Settings gear, file
                                    # actions) + active-level view + WorldPanel dock +
                                    # ScrubberV2 bottom bar
      GlobeView.tsx, globe/         # Level 1: react-three-fiber night-earth globe (GlobeScene,
                                    # RegionPins, PopulationMarkers, ArcsLayer engine-driven
                                    # traffic arcs) or GlobeCards fallback when WebGL is
                                    # unavailable
      RegionView.tsx, region/       # Level 2: cross-AZ traffic columns, timeline strip, rack
                                    # chassis (SplitLines, AzRow, CrossAzColumn)
      AzCanvas.tsx, AzSimOverlay.tsx # Level 3: live React Flow render of the focused AZ (the
                                    # app's one remaining @xyflow/react surface) + particle
                                    # overlay canvas
      ServerView.tsx, server/       # Level 4: the "circuit board" — NIC/firewall gate, service
                                    # chips, HardwarePlatform, PacketLayer, InspectorRail
      SettingsModal.tsx             # ⚙ modal — Appearance (theme toggle) + AI Review (LLM
                                    # endpoint config)
      panels/                       # WorldPanel dock tabs: Topology, Blueprints, Placements,
                                    # Traffic, Analysis (+ AiReviewSection), Events, Cost
      fileOps.ts, Breadcrumb.tsx, SimControls.tsx, EventsTab.tsx, useCompiledWorld.ts
  lib/
    world/                        # Pure document model + compiler — the schema of .scalemap v2
      types.ts                     # WorldDoc entities + CompiledWorld output types
      factories.ts, instanceCatalog.ts, regionGeo.ts, layoutRacks.ts, populationLabel.ts
      compileWorld.ts (+ network.ts, routing.ts)  # doc -> instances, permitted/blocked paths,
                                    # routing tables, compile findings — the gate every
                                    # consumer reads through instead of the raw doc
    worldEngine/                  # The simulation engine — a from-scratch port (not a reuse)
                                   # of the deleted canvas app's particleEngine mechanisms
      index.ts                     # createWorldEngine() facade — sequences every subsystem
                                    # below into one fixed-step run; exports MAX_GLOBE_ARCS
      rng.ts, engineClock.ts, demand.ts, routingRuntime.ts, hostScheduler.ts, vpsModel.ts,
      networkRuntime.ts, breakers.ts, flows.ts, failover.ts, metrics.ts, events.ts, replay.ts
      types.ts                     # Frozen WorldEngineApi/MetricsBatch/EngineEvent/render-
                                    # payload contract — additive-only, see contract-drift.md
    analysis/                     # Deterministic rule engine over the compiled world
      types.ts, runAnalysis.ts, rules/{structural,network,capacity}.ts
    llmReview.ts                  # LLM review context builder + schema-validated, retrying
                                   # request client
    costModelV2.ts, cloudRegistry.ts, regionConfig.ts
    serializer.ts                 # .scalemap v2 (de)serialization
    nodeConfig.ts                 # NODE_CONFIG icon/category registry (no live consumer in the
                                   # world-model UI today) + surviving packet-template types
                                   # (PacketTemplate/PacketMode/PacketRegistry)
    theme.ts                      # DARK_COLORS/LIGHT_COLORS/CATEGORY_COLORS/FONT — the
                                   # --color-* token source for both themes
    tauri.ts / tauriMock.ts       # Tauri command wrappers + browser-dev localStorage/fetch
                                   # fallback (file I/O + LLM settings/chat)

src-tauri/src/
  main.rs, lib.rs
  commands.rs                    # All Tauri commands: save/load diagram, file dialogs, recent
                                  # files, save/load_llm_settings, llm_chat
```
````

- [ ] **Step 13: replace "Key Architecture Decisions"**

Current section (verbatim, `CLAUDE.md` lines 120–138):

```md
## Key Architecture Decisions

**Canvas engine:** `@xyflow/react` (React Flow) with fully custom node/edge components — never the library's default visual style.

**State management:** Zustand, one store per domain (listed above). No monolithic store.

**Simulation particles:** Particle state lives inside `particleEngine.ts`'s internal `EngineState`, mutated directly inside the `requestAnimationFrame` loop — never in Zustand. Only derived, lower-frequency data (`NodeMetrics`, events, bottleneck/SLO status) is published to `simulation.store.ts`, batched via the `onNodeMetrics` callback in `SimulationOverlay.tsx`. Do not add raw particle arrays to any reactive store.

**Packet registry (Flyweight):** Edges reference a shared `PacketTemplate` by id (`canvas.store.ts`) rather than embedding protocol config per-edge. `packetMode` toggles between `generic` (built-in defaults per protocol) and `custom` (user-authored templates).

**Node icons:** Route all icons through `NODE_CONFIG` in `src/lib/nodeConfig.ts`. Never hard-code icon elements in node JSX.

**Lint rules:** Structural checks run on-demand over the graph (`lintGraph.ts` builds in/out-edge adjacency once, then runs each rule from `rules.ts`). Current rules: `isolatedNode`, `exposedDatabase`, `noQueueConsumer`, `noQueueProducer`, `lambdaDirectDb`, `circularDependency`, `singleEntryPointSpof`, `unbalancedLoadBalancer`, `deepSyncChain`. Add new rules to `rules.ts` and register them in the same array — don't special-case rule execution elsewhere.

**Terraform:** Export-only (`exportTerraform.ts`, diagram → HCL string). There is currently no HCL parsing, no `hcl-rs` dependency, and no import path. Do not assume an import feature exists — treat any reference to Terraform *import* as future work, not current behavior.

**Undo/redo:** Immutable history stack in `canvas.store.ts` (`history`/`future` snapshot arrays of `{ nodes, edges }`).

**Cross-platform:** All Tauri API calls (file dialogs, path resolution) must use Tauri's cross-platform abstractions — no OS-specific system calls. Rust code is currently a single `commands.rs`; keep new commands there unless the file grows large enough to warrant splitting (not yet planned/required).
```

Replace with:

```md
## Key Architecture Decisions

**Four-level nav + compiled-world gate:** the app has exactly one document model, `WorldDoc`
(`src/lib/world/types.ts`), navigated at four zoom levels — globe → region → AZ → server
(`nav.store.ts`'s `WorldLevel`). Every view, the engine, and the analysis rules read
`compileWorld(doc)`'s output (`CompiledWorld`: instances, permitted/blocked paths, routing
tables, compile findings) for anything derived — never the raw doc. Extend `CompiledWorld`
additively; never reshape it (it fans out to every view, the engine's `start()`, and every
analysis rule).

**Engine facade + store seam:** `src/lib/worldEngine/index.ts`'s `createWorldEngine()` is the
ONLY simulation engine; `simulation.store.ts` is the ONLY file in the app allowed to call it
directly (`start`/`stop`/`attachRenderer`/`getReplayFrames`/`getTracedRequests`/`setOutage`).
Every view reads the store, never the engine facade. `worldEngine/types.ts` is a frozen contract
— additive-only changes, logged in `.superpowers/sdd/contract-drift.md` when they happen.

**AZ canvas:** `@xyflow/react` (React Flow) still renders one thing — the live AZ-level canvas
(`AzCanvas.tsx`), read-only (servers + managed services as nodes, aggregated compiled paths as
edges). It is not a general node/edge authoring surface the way the deleted canvas app was;
don't assume React Flow appears anywhere else.

**State management:** Zustand, one store per domain (`nav`, `world`, `simulation`, `file`, `ui` —
no monolithic store). `nav.store.ts` deliberately has no dependency on `world.store.ts`:
navigating never pushes undo/redo history.

**Undo/redo:** immutable history stack in `world.store.ts` (`history`/`future` snapshot arrays of
`{ doc }`), routed through one internal `mutate()` helper that also marks the file dirty — new
CRUD actions get both for free by going through it.

**Analysis rules:** one registry, `ANALYSIS_RULES` (`src/lib/analysis/runAnalysis.ts`) —
`structural`/`network`/`capacity` rule files each export their rule objects, spread into the same
array. Add new rules there; don't special-case execution elsewhere. Rules never duplicate
`compiled.findings` — the Analysis tab merges both lists and suppresses the compile-side
duplicate of any rule that re-surfaces a compile finding (e.g. `blocked-dependency-path`).

**Packet system's current role:** the Flyweight packet-template *types*
(`PacketTemplate`/`PacketMode`/`PacketRegistry`, `src/lib/nodeConfig.ts`) survive from the
deleted canvas app and are read by `BlueprintDependency.packetTemplateId` and
`ScalemapFileV2.packets` — but there is no authoring UI for them in the world model today. Don't
assume a packet editor exists; adding one would be new work, not a restoration.

**LLM reviewer + key security (non-negotiable):** `src/lib/llmReview.ts` builds a review context
from the compiled world + deterministic findings + aggregated metrics (never raw instance maps),
sends it to any OpenAI-compatible endpoint via the Rust-side `llm_chat` Tauri command (a webview
`fetch` to arbitrary hosts dies on CORS), and validates/retries against a hand-rolled JSON schema
check. Settings (`baseUrl`/`apiKey`/`model`) persist to `llm_settings.json` in the app data dir.
The API key is NEVER serialized into `.scalemap` (settings never touch `world.store`/
`serializer`), NEVER logged or `console.*`'d, NEVER included in the review-context payload,
REDACTED from every error string on both the Rust and TS sides, and rendered only masked
(`•••• <last4>`) after save — the Settings modal's password input never echoes a saved key back
into its value.

**Theme:** `--color-*` CSS custom properties (`theme.ts`'s `DARK_COLORS`/`LIGHT_COLORS`,
bootstrapped by `App.tsx`'s `useThemeBootstrap`) are the only sanctioned color source for new UI
— no hardcoded hexes. The dark/light toggle is live and user-facing via the ⚙ Settings modal
(`ui.store.ts`'s `themeMode`); design new UI to look correct in both.

**Cross-platform:** all Tauri API calls (file dialogs, path resolution, the LLM HTTP transport)
must use Tauri's cross-platform abstractions — no OS-specific system calls. Rust code is
currently a single `commands.rs`; keep new commands there unless the file grows large enough to
warrant splitting (not yet planned/required).
```

- [ ] **Step 14: replace "Diagram File Format"**

Current section (verbatim, `CLAUDE.md` lines 164–179):

````md
## Diagram File Format

`.scalemap` files are JSON (`src/lib/serializer.ts`):

```json
{
  "version": "1",
  "meta": { "name": "", "created": "", "modified": "" },
  "viewport": { "x": 0, "y": 0, "zoom": 1 },
  "nodes": [{ "id": "", "type": "", "position": {}, "data": {} }],
  "edges": [{ "id": "", "source": "", "target": "", "type": "", "data": {} }],
  "packets": { "mode": "generic", "templates": {}, "nextId": 1 }
}
```

`packets` is optional (only present when the diagram uses custom packet templates).
````

Replace with:

````md
## Diagram File Format

`.scalemap` files are JSON, version `"2"` (`src/lib/serializer.ts` — the v1 canvas-era format
was removed with the legacy app in Phase 2 and is explicitly rejected on load with a dedicated
error message):

```json
{
  "version": "2",
  "meta": { "name": "", "created": "", "modified": "" },
  "world": {
    "routing": { "policy": "latency", "weights": {}, "priorityOrder": [], "healthCheckIntervalMs": 10000, "healthCheckFailureThreshold": 3, "dnsTtlSec": 30 },
    "traffic": { "autoBaseline": true, "baselineTotalRps": 1000 },
    "populations": {},
    "regions": {},
    "azs": {},
    "servers": {},
    "blueprints": {},
    "placements": {},
    "managedServices": {}
  },
  "packets": {},
  "viewState": { "level": "globe" }
}
```

`world` is the full `WorldDoc` (`src/lib/world/types.ts`) — every entity collection
(`regions`/`azs`/`servers`/`blueprints`/`placements`/`managedServices`/`populations`) plus
`routing`/`traffic` config, keyed by id. `deserializeWorld` validates that `meta` and all 9
top-level `WorldDoc` collections are present and non-null objects before accepting a file,
throwing a single "missing or malformed world document" error otherwise. `packets` is optional —
present only when the world uses custom (non-generic) packet templates (`PacketRegistry`,
`src/lib/nodeConfig.ts`; see Key Architecture Decisions for the packet system's current, reduced
role). `viewState` is optional — `{ level, regionId?, azId?, serverId? }`, the nav focus at save
time, restored on reopen so a saved file reopens where you left it. There is no analysis-finding
or LLM-review persistence in this format — both are derived/ephemeral (see Key Architecture
Decisions).
````

- [ ] **Step 15: fix the "Design System" category-accent swatch + add a light-mode note**

Current section (verbatim, `CLAUDE.md` lines 142–160):

````md
## Design System

```
Canvas bg:         #0D0F12   /  canvas dots: #1A1D22
Node base:         #161920   /  border: #2A2E38
Surface:           #0F1117   /  surface hover: #13161E
Toolbar:           #111318   /  toolbar border: #1E2128

Compute/Orchestration: #4A9EFF (blue)
Storage/Caching:       #F5A623 (amber)
Network:               #2DD4BF (teal)
Messaging:              #A78BFA (purple)
Grouping:               #475569 (slate, transparent bg)

Text primary: #F1F5F9 / secondary: #94A3B8 / muted: #64748B
Status: danger #EF4444 / success #22C55E / warning #F59E0B
```

Source of truth: `src/lib/theme.ts` (`COLORS`, `CATEGORY_COLORS`). Font: `JetBrains Mono` throughout. All animations must respect `prefers-reduced-motion`.
````

The `canvas`/`node`/`surface`/`toolbar`/text/status swatch (all `DARK_COLORS` values) is still
byte-exact — only the category row (`CATEGORY_COLORS`) drifted after an accessibility retune. Diff:

`````diff
 Canvas bg:         #0D0F12   /  canvas dots: #1A1D22
 Node base:         #161920   /  border: #2A2E38
 Surface:           #0F1117   /  surface hover: #13161E
 Toolbar:           #111318   /  toolbar border: #1E2128

-Compute/Orchestration: #4A9EFF (blue)
-Storage/Caching:       #F5A623 (amber)
-Network:               #2DD4BF (teal)
-Messaging:              #A78BFA (purple)
-Grouping:               #475569 (slate, transparent bg)
+Compute/Orchestration: #5B9CF6 (blue)
+Storage/Caching:       #E0A552 (amber)
+Network:               #3FC7B8 (teal)
+Messaging:              #9C8CE0 (violet)
+Grouping:               #8391A5 (slate-blue accent, transparent bg)

 Text primary: #F1F5F9 / secondary: #94A3B8 / muted: #64748B
 Status: danger #EF4444 / success #22C55E / warning #F59E0B
 ```

-Source of truth: `src/lib/theme.ts` (`COLORS`, `CATEGORY_COLORS`). Font: `JetBrains Mono` throughout. All animations must respect `prefers-reduced-motion`.
+Source of truth: `src/lib/theme.ts` (`DARK_COLORS`, `CATEGORY_COLORS`). Font: `JetBrains Mono`
+throughout. All animations must respect `prefers-reduced-motion`.
+
+**Light mode:** `theme.ts` also exports a full `LIGHT_COLORS` sibling (WCAG-AA-checked
+replacements — e.g. `danger` #DC2626, `success` #16A34A/`successText` #11823B, `warning`
+#B45309, `accent` #3F6DAC) and every `CATEGORY_COLORS` entry carries a `foreground.light`
+variant for icon/text use on a light card. The dark/light toggle (`ui.store.ts`'s `themeMode`,
+live via the ⚙ Settings modal) swaps the whole set at runtime through `App.tsx`'s
+`useThemeBootstrap`, which writes every token as a `--color-*` CSS custom property — new UI
+must use `var(--color-*)` exclusively, never a hardcoded hex, since both modes are now genuinely
+reachable in the running app.
`````

- [ ] **Step 16: replace "Key Dependencies"**

Current section (verbatim, `CLAUDE.md` lines 183–194):

```md
## Key Dependencies

| Package | Purpose |
|---|---|
| `@xyflow/react` | Canvas — node/edge rendering, pan/zoom |
| `zustand` | State management |
| `dagre` | Graph layout (installed; verify usage before relying on it) |
| `framer-motion` | Panel/node animations |
| `lucide-react` | Node icons |
| `vitest` / `@testing-library/react` | Test harness (configured, unused — see Roadmap) |

Rust (`src-tauri/Cargo.toml`): `tauri`, `tauri-plugin-opener`, `tauri-plugin-dialog`, `serde`/`serde_json`, `chrono`. No `hcl-rs`.
```

Replace with:

```md
## Key Dependencies

| Package | Purpose |
|---|---|
| `@react-three/fiber` | React renderer for three.js — the globe scene (`Canvas`, `useFrame`, hooks) |
| `@react-three/drei` | `OrbitControls`, `useTexture`, and other r3f scene helpers used by the globe |
| `three` | The WebGL scene graph underlying the globe (night-earth sphere, atmosphere shader, arc geometry) |
| `@xyflow/react` | The AZ-level canvas (`AzCanvas.tsx`) — node/edge rendering, pan/zoom. The only remaining React Flow surface; the original node-authoring canvas app that used it more broadly was deleted in Phase 2 |
| `zustand` | State management — one store per domain (`nav`/`world`/`simulation`/`file`/`ui`) |
| `framer-motion` | Panel/globe/board animations; every animated component also checks `useReducedMotion()` |
| `lucide-react` | Icons — today's only live consumer is `HomeScreen.tsx`; `nodeConfig.ts`'s `NODE_CONFIG` icon registry has no consumer in the world-model UI (see Key Architecture Decisions) |
| `vitest` / `@testing-library/react` | Test harness — extensively used (see Known Issues / Roadmap) |

Rust (`src-tauri/Cargo.toml`): `tauri`, `tauri-plugin-opener`, `tauri-plugin-dialog`,
`serde`/`serde_json`, `chrono`, `reqwest` (`default-features = false`, features `["json",
"rustls-tls"]` — added in Phase 6 for the `llm_chat` command; no OpenSSL dependency).
```

`dagre` stays in `package.json` (this task does not uninstall anything — it was already unused
before this phase, `grep -rln "dagre" src` finds zero matches) but is dropped from this table
since it plays no role in the current architecture.

- [ ] **Step 17: replace "Known Issues / Roadmap"**

Current section (verbatim, `CLAUDE.md` lines 198–203, immediately before the standing
module-boundaries instruction paragraph — that final paragraph is UNCHANGED, keep it verbatim
exactly where it is):

```md
## Known Issues / Roadmap

- **No test coverage.** `vitest` and Testing Library are installed but there isn't a single `*.test.ts(x)` file yet. New non-trivial logic (lint rules, cost model, ScaleScript resolver) is a good place to start.
- **Terraform import doesn't exist.** If this is picked back up, decide whether to keep parsing client-side or reintroduce a Rust-side `hcl-rs` sidecar before writing code.
- **`ReportsPanel.tsx` exports aren't persisted to disk** — wire up a Tauri command instead of leaving it browser-only.
- **Rust commands are a single flat file.** Fine at the current size; revisit modularization only if `commands.rs` becomes hard to navigate.
```

Replace with:

```md
## Known Issues / Roadmap

Test coverage is now extensive (`lib/analysis`'s rule files, `lib/worldEngine`'s subsystems,
`lib/world`, and most of `app/world`'s panels/board/rack/globe components all have
`*.test.ts(x)` coverage — jsdom for anything rendering React, plain node env for pure logic).
`src-tauri/src/commands.rs` remains a single flat file — still fine at its current size (file
I/O commands + the LLM settings/chat commands); revisit modularization only if it becomes hard
to navigate.

This file, `docs/module-boundaries.md`, and the six phase-completion summaries in
`.superpowers/sdd/progress.md` are the current architectural record. The rebuild's scope is
complete as of Phase 6; the following is intentionally parked, not partially built or in
progress — do not assume any of it exists:

- k8s/ECS schedulers (blueprint/placement scheduling semantics beyond the current explicit
  server-by-server placement model)
- ScaleScript v2 (a declarative scenario/override DSL — the original ScaleScript was deleted
  with the legacy canvas app and never ported)
- Terraform v2 (diagram/world → HCL export, or any HCL import/parsing — the original
  export-only Terraform support was deleted with the legacy canvas app and never ported; there
  has never been an import path in any version of this app)
- AI watch-mode (continuous/background LLM review, vs. today's on-demand `Review architecture`
  button)
- Spot-instance cost/interruption modeling
- Managed-service pseudo-internals (today's `ManagedService` is a black-box cost/routing
  target, not a simulated internal engine)
- LLM review persistence/history (today's AI cards are ephemeral — never persisted, never
  serialized into `.scalemap`)
- Streaming LLM responses / request cancellation (today's review request is a single blocking
  round trip with one retry; no cancel button, no token streaming)
```

- [ ] **Step 18: verify the rewritten CLAUDE.md reads cleanly end-to-end**

No automated test covers a markdown file — read the whole rewritten `CLAUDE.md` top to bottom
and confirm: every section flows (`## Project Overview` → `## Commands` → `## Architecture` →
`## Key Architecture Decisions` → `## Design System` → `## Diagram File Format` → `## Key
Dependencies` → `## Known Issues / Roadmap` → the standing module-boundaries instruction
paragraph, same order as today); no leftover mention of `canvas.store`, `particleEngine`,
`lint/`, `ScaleScript`, `dagre`, `hcl-rs`, or "no test coverage" survives anywhere in the file.

---

### Part C — `docs/module-boundaries.md` §O

- [ ] **Step 19: insert §O**

Insert immediately after §N's closing content and its trailing `---` separator (current file:
§N's "Blast radius / Phase-4 backlog closed this task" paragraph ends at line 504, followed by a
`---` at line 506, then `## 2. Shared "hub" files...` starts at line 508) — i.e. §O goes between
that `---` and `## 2.`, as the new last entry of "## 1. Feature modules":

```md
### O. Analysis engine + LLM reviewer + Settings — Phase 6 final layer (`src/lib/analysis/`, `src/lib/llmReview.ts`, `src/app/world/SettingsModal.tsx`, `src/app/world/panels/AnalysisTab.tsx`/`AiReviewSection.tsx`, 2026-07-10)

The rebuild's final phase. Layer 1 is a deterministic analysis-rule engine — three families
(`structural`/`network`/`capacity`, 13 rules total across Tasks 1–3) run over `compileWorld`'s
output (+ the latest `MetricsBatch`, optional), replacing the plain `Findings` tab with a
family-grouped `Analysis` tab that merges unsuppressed compile findings and gives every affected
entity id a clickable navigation chip (Task 4). Layer 2 is an on-demand LLM architecture review
against any OpenAI-compatible endpoint, schema-validated and retried once on a malformed reply
(Task 6), transported through a new Rust command since a webview `fetch` to arbitrary hosts dies
on CORS (Task 5), rendered as AI-tagged cards beside the deterministic findings (Task 8). A new
global Settings modal (⚙, Task 7) is the first UI ever to expose the app's already-wired
dark/light theme toggle, plus the LLM endpoint configuration. Spec:
`docs/superpowers/specs/2026-07-10-phase6-analysis-llm-design.md`.

| File | Role |
|---|---|
| `src/lib/analysis/types.ts` (Task 1) | `AnalysisFinding`/`AnalysisRule`/`AnalysisInput`/`AnalysisFamily`/`AnalysisSeverity` — the shape every rule file and `runAnalysis.ts` share. `id` is `` `${ruleId}:${primaryAffectedId}` `` (or `` `${ruleId}:world` `` when `affected` is empty), stable across runs — never derived from array position |
| `src/lib/analysis/runAnalysis.ts` (Task 1, appended Tasks 2–3) | `ANALYSIS_RULES: AnalysisRule[]` — ONE registry; `structural.ts`/`network.ts`/`capacity.ts` each export their rule objects and are spread into this same array, never executed through a separate path (same "one array, no special-casing" convention the deleted §1C structural linter established and this phase inherits). `runAnalysis(doc, compiled, lastBatch)` builds one `AnalysisInput`, concatenates every rule's findings, and sorts by severity (critical→warning→info) then family (structural→network→capacity) then `ruleId` — a stable composite-key sort |
| `src/lib/analysis/rules/structural.ts` (Task 1, 6 rules) | `single-az-region`, `no-failover-region`, `replicas-colocated`, `dependency-cycle`, `deep-sync-chain`, `unused-managed-service` — read `compiled.instances`/`compiled.routing.populationRegionOrder`/`doc.blueprints` only |
| `src/lib/analysis/rules/network.ts` (Task 2, 3 rules) | `blocked-dependency-path` (id embeds the compiled path id so the Analysis tab can suppress the raw compile-side duplicate, D4), `db-port-exposed`, `entry-unreachable` — replicate a source-aware firewall first-match-wins loop rather than importing `src/lib/world/network.ts`'s `evaluateFirewall` (that helper ignores `source` by design, Phase-1 scope; documented in-file, `network.ts` itself is untouched) |
| `src/lib/analysis/rules/capacity.ts` (Task 3, 4 rules) | `ram-oversubscribed`, `burstable-sustained-load` (silent without `lastBatch`), `ocean-crossing-population` (imports `REGION_GEO`/`greatCircleKm` from `src/lib/world/regionGeo.ts` — the SAME distance source `routing.ts` already uses; no second haversine implementation), `ttl-outlives-detection` (`affected: []`, world-scoped id) |
| `src/lib/analysis/__fixtures__/worlds.ts` (Task 1, extended Tasks 2–3) | Shared doc-builder fixtures for rule tests, in the same "small local factory functions, no cross-file test imports" style every `worldEngine/*.test.ts` file already uses (§K) |
| `src/lib/llmReview.ts` (Task 6) | Pure, mock-`chat`-testable: `buildReviewContext(doc, compiled, findings, lastBatch)` (JSON string — world doc + deterministic/compile finding summaries + aggregated region/AZ metrics; NEVER instance-level maps, NEVER any settings value), `validateReviewResponse(raw)` (hand-rolled schema check + clamping, no new deps), `requestReview(settings, context, chat?)` (builds the chat request, retries ONCE on a malformed reply), `pingLlm(settings, chat?)`. `chat` defaults to `src/lib/tauri.ts`'s `llmChat` wrapper, injectable for tests |
| `src/app/world/panels/AnalysisTab.tsx` (Task 4, mounts `AiReviewSection` Task 8) | Replaces the old inline `Findings` tab body. `useMemo(runAnalysis(doc, compiled, displayBatch), [compiled, displayBatch?.simMs])` where `displayBatch = scrubBatch ?? latestBatch`; renders `structural`/`network`/`capacity` sections (non-empty only) then an unsuppressed-compile section. Exports `navigateToEntity(id, doc, compiled, nav)` (regionId→`goRegion`, azId→`goAz`, serverId→`goServer`, instanceId→its server's interior, else no-op) and `unsuppressedCompileFindings(analysis, compile)` (strips the `` `finding-` `` prefix off a compile id and checks it against the analysis id set) — both are the ONE place either kind of suppression/navigation logic lives; `WorldPanel.tsx`'s tab-count label calls the same `unsuppressedCompileFindings`, not a second computation |
| `src/app/world/panels/WorldPanel.tsx` (Task 4 tab rename, Task 8 threads `openSettings`) | `Tab` union's `'findings'` → `'analysis'`; label `` `Analysis (${n})` `` where `n` = analysis findings + unsuppressed compile findings (via the same helper above). Gained an `openSettings: () => void` prop in Task 8, threaded straight to `AnalysisTab` → `AiReviewSection` — a plain prop chain, not a store (see Boundary rules) |
| `src/app/world/panels/AiReviewSection.tsx` (Task 8) | `unconfigured`/`idle`/`in-flight`/`done`/`error` states. Violet AI chip uses `CATEGORY_COLORS.messaging.accent` (`theme.ts`) — a local hex const for this color is forbidden (Global Constraints; `theme.ts` already carries the exact violet, no new token needed). Review click calls `buildReviewContext` + `requestReview`; cards reuse `AnalysisTab`'s `navigateToEntity` for affected chips. Mounted at the top of `AnalysisTab` |
| `src/app/world/SettingsModal.tsx` (Task 7) | Portal overlay (`createPortal`, `position:fixed` backdrop, token-styled). Two sections: **Appearance** (`dark`\|`light` segmented control over `useUiStore(s=>s.themeMode)`/`setThemeMode` — no new plumbing, `App.tsx`'s `useThemeBootstrap` already applies the effect live) and **AI Review** (`baseUrl`/`apiKey type=password`/`model`, `Save`→`saveLlmSettings`, `Test connection`→`pingLlm`). Registers its OWN capture-phase `window` `keydown` listener for Escape (`stopPropagation`+`preventDefault`+`onClose`) so `WorldShell.tsx`'s bubble-phase nav-Escape handler bails — same mechanism Phase 3's inspector (§L) established for exactly this kind of overlay-vs-nav-shell conflict |
| `src/app/world/WorldShell.tsx` (Task 7) | Gained a ⚙ ghost button (first child of the header's right-side button cluster) + local `settingsOpen` state + `<SettingsModal open onClose>`; the `openSettings` prop threaded to `WorldPanel` in Task 8 is `() => setSettingsOpen(true)` — the SAME state the gear opens |
| `src/lib/tauri.ts` / `src/lib/tauriMock.ts` (Task 5) | `LlmSettings { baseUrl; apiKey; model }` + `saveLlmSettings`/`loadLlmSettings`/`llmChat` wrappers (explicit snake↔camel field mapping to/from the Rust struct — Tauri v2 camelCases command ARG names but not struct fields, verified against the existing `commands.rs` conventions). The mock mirrors settings to `localStorage` and does a direct `fetch()` for `llm_chat` (fine for local stubs/Ollama/LM Studio, where the user controls CORS) |
| `src-tauri/src/commands.rs` (Task 5) | `save_llm_settings`/`load_llm_settings` (mirrors the existing `recent_files.json` app-data-dir pattern exactly) + `llm_chat` (async, `reqwest` POST, 60s timeout, returns the raw response body text for ANY HTTP status so the frontend can read an OpenAI-style error envelope itself) + `redact(msg, key)` (pure, unit-tested — masks every occurrence of the key, short keys masked entirely) |
| `scripts/llm-stub.mjs` (Task 8) | ~40-line stdlib-`http` OpenAI-compatible stub for the live smoke: CORS-enabled `POST /v1/chat/completions`, first hit returns malformed content (proves the retry live), every later hit returns a canned valid review |

**Boundary rules:** `src/lib/analysis/*` imports ONLY `src/lib/world/types` and
`src/lib/worldEngine/types` (types-only — never the executable `worldEngine/index.ts` facade,
never any `app/` store, never React) — every rule file is plain, node-env-testable logic, exactly
like the deleted §1C linter and the live `worldEngine/` subsystems (§K) before it. `llmReview.ts`
imports only `src/lib/tauri.ts`'s wrappers (`llmChat`, `LlmSettings`) — never calls Tauri's
`invoke` itself, never imports `tauriMock.ts` directly (that split is `tauri.ts`'s own concern, an
existing pattern this phase didn't change). `AnalysisTab.tsx`/`AiReviewSection.tsx` are the ONE
place either the analysis findings or the AI review reach the DOM — both compose `runAnalysis`,
`navigateToEntity`, and (for AI) `buildReviewContext`/`requestReview`, rather than any other file
duplicating that wiring. `SettingsModal.tsx` NEVER imports `world.store.ts` or `serializer.ts` —
by construction, not convention: LLM settings are not world-document state and must never become
reachable from a save/serialize path.

**D6 key-security invariants (restated, non-negotiable — every one of these has a dedicated
test):** the API key is never serialized into `.scalemap` (enforced by `SettingsModal.tsx` never
importing `world.store`/`serializer.ts` at all — there is no code path for it to reach either);
never logged or `console.*`'d on either side; never included in `buildReviewContext`'s payload
(canary-string-tested); redacted (`commands.rs`'s `redact()`) from every error string the Rust
transport can produce; rendered only masked (`•••• <last4>`) in the Settings modal after a key has
been saved, and the masked placeholder is never echoed back into the input's live `value` (typing
a NEW value is the only way to overwrite a saved key — leaving the field empty on Save keeps the
existing one); the API key input is `type="password"`. Any task whose test suite can assert one of
these, does.

**The `openSettings` prop chain** (`WorldShell` → `WorldPanel` → `AnalysisTab` →
`AiReviewSection`) is this phase's one plain-prop thread across what would otherwise be a store
boundary — the same narrow, deliberate exception class §N's `placeMode` thread already
established (two components down a fixed hierarchy needing to share one boolean/callback that a
common ancestor owns), not a precedent for skipping stores generally elsewhere in `world/`.

**Carry-forwards closed this task (closing out Phase 5's backlog, `.superpowers/sdd/progress.md`
`## PHASE 5 COMPLETE`'s "OPEN ITEMS for Phase 6" list — see §N's own note above for the Phase-4
backlog, closed by Phase 5):** `worldEngine/index.ts:43`'s `MAX_GLOBE_ARCS` is now `export const`
(the ONE sanctioned `worldEngine/` edit this phase) and `ArcsLayer.tsx` imports it from the
engine facade instead of hand-duplicating the literal; a new `src/lib/world/populationLabel.ts`
(pure, `nextPopulationLabel(populations)` — scans existing `pop-N` labels for the max suffix) is
shared by `TrafficPanel.tsx`'s "+ add" and `GlobeView.tsx`'s place-on-globe handler, so the two
authoring surfaces can no longer reissue the same default label after a remove+re-add;
`GlobeScene.tsx`'s texture wrap/offset mutation moved from a `useMemo` (a memoized-derivation
hook being used for a side effect) to `useLayoutEffect` (the conventional home for a synchronous
pre-paint side effect), same body, same `texture.needsUpdate=true` flag; `globeArcs.test.ts`
gained a test for `buildDrainArcs`'s `?? [pop.lat,pop.lon]` fallback (a previous-region catalogId
missing from `REGION_GEO`), the one named gap Phase 5's final review left explicitly untested.
The other three Phase-5 backlog items (`NumberField` no external re-sync on undo/redo,
`PopulationMarkers`' aspirational "matches theme teal" comment, `health_check_failed`'s no-pulse
tradeoff) are cosmetic/documented-tradeoff and remain open — not part of this phase's scope.

**This is the rebuild's final phase.** With Task 9's docs landing, all six phases (world model +
navigation shell, substrate simulation engine, server interior board, region flow page + rack
chassis, R3F globe + traffic authoring, analysis engine + LLM reviewer + settings) are complete;
see `.superpowers/sdd/progress.md`'s `## PHASE 6 COMPLETE` entry for the closing summary and the
umbrella-spec §9 parked list of intentionally-unscoped future work.

---
```

(the trailing `---` above is the same section-separator convention every lettered section in
this file already ends with, immediately followed by `## 2. Shared "hub" files...`.)

---

### Part D — full verify, live phase-gate smoke, ledger, commit

- [ ] **Step 20: full verify**

Run: `npx vitest run` → full suite green (every T1–T8 test file plus this task's
`populationLabel.test.ts` and the extra `globeArcs.test.ts` case).
Run: `npm run build` → strict tsc + vite build green.
Run (from `src-tauri/`): `cargo build` → green.
Run (from `src-tauri/`): `cargo test` → green (T5's `redact`/settings-roundtrip/`llm_chat`-stub
tests). Per Global Constraints: the Rust transport's gate is `cargo test` + `cargo build`, NOT
the browser smoke below — state this split explicitly when reporting results.

- [ ] **Step 21: live phase-gate smoke (controller-run, strict port 1420, zero app console
  errors, screenshots, stop the dev server AND the stub after)**

Full end-to-end story (spec's Testing & Verification section + skeleton's Task 9 done bar):

1. Author a world tripping ≥4 analysis rules across all three families in one document:
   a **single-AZ region** (`single-az-region`, structural), a **db-port-exposed** server
   (`db-port-exposed`, network), a **ram-oversubscribed** server (`ram-oversubscribed`,
   capacity), and a **`dnsTtlSec` set shorter than `healthCheckIntervalMs ×
   healthCheckFailureThreshold`** (`ttl-outlives-detection`, capacity).
2. Open the `Analysis` tab — findings are grouped by family (structural/network/capacity),
   severity-ordered within each, plus a compile section for anything not suppressed. Click
   several affected-entity chips and confirm navigation (region chip → `goRegion`, server chip →
   `goServer`, etc.) — screenshot each hop.
3. Open Settings (⚙) → configure the AI Review endpoint against
   `node scripts/llm-stub.mjs 4141` (`baseUrl: http://localhost:4141/v1`, any `model` string) →
   Save.
4. Back in the Analysis tab's AI section, click `Review architecture` → confirm the stub's
   terminal log shows **TWO hits** (the first malformed reply triggers the one corrective retry,
   proven live, not just in `llmReview.test.ts`'s mocked case) → AI-tagged cards render beside the
   deterministic findings, with working affected-chip navigation.
5. Reload the app (or reopen Settings) → the saved API key renders masked (`•••• <last4>`), never
   echoed into the input's live value.
6. Save the world; grep the saved `.scalemap` payload (the `tauriMock` localStorage path in
   browser dev) for the configured API key string → confirm it is **ABSENT** (this is the D6
   assertion this task owns at the whole-app level — settings never touch `world.store`/
   `serializer`, so there is nothing to find).
7. Open Settings → Appearance → flip the theme to **light** — confirm the ENTIRE app (not just
   one panel) switches live, then take a screenshot pass over all four nav levels in light mode:
   globe, a region page, the AZ canvas, and a server board. Read every screenshot for
   unreadable/low-contrast stragglers (a hex that was never migrated to `var(--color-*)`, or a
   `globe/`-style local-const color that happens to read poorly on the light background) — fix
   any found (route it through the correct `--color-*` token or an appropriately-contrasted
   `CATEGORY_COLORS.*.foreground.light`/`color-mix()` value, matching the R2 carve-out convention
   §N already established for scene-chrome consts). Flip back to dark and confirm it still reads
   correctly there too (a light-mode fix must not regress the dark palette).
8. Stop the stub (`Ctrl-C`) and the dev server.

Confirm ZERO app console errors were logged at any point in the story above.

- [ ] **Step 22: append the `## PHASE 6 COMPLETE` ledger entry**

By the time this task runs, `.superpowers/sdd/progress.md` already has a `## PHASE 6 —
Analysis Rule Engine + LLM Reviewer` header (written when the plan was assembled/dispatched,
mirroring `## PHASE 5 — R3F globe + traffic authoring`'s opening entry, lines 257–263) with one
`Task N: complete (commit ...)` line appended by each of Tasks 1–8 as they land. Task 9 does
**not** rewrite those — it appends its own `Task 9: complete (...)` line, an `=== ALL 9 TASKS
COMPLETE ===` marker, and the closing `## PHASE 6 COMPLETE` section, mirroring
`## PHASE 5 COMPLETE`'s shape (lines 275–296) but for the whole 6-phase rebuild. Fill in the
angle-bracketed placeholders with the real commit hash / test counts / review verdict / smoke
findings at execution time — the surrounding prose (the parked list, the "REBUILD COMPLETE"
framing) is exact wording to carry over, not a placeholder:

```
Task 9: complete (commit <hash>, review <verdict> — <one-line reviewer summary>). CLAUDE.md
rewritten (Project Overview/Architecture/Key Decisions/Design System note/Diagram File
Format/Key Dependencies/Roadmap); docs/module-boundaries.md gained §O (analysis+llm+settings,
boundary rules, D6 restated); 4 Phase-5 carry-forwards closed (MAX_GLOBE_ARCS exported +
ArcsLayer import, nextPopulationLabel shared helper, GlobeScene useLayoutEffect,
buildDrainArcs missing-geo test). Full suite <N>/<N> green, build green, cargo build + cargo
test green.

=== ALL 9 TASKS COMPLETE. Suite <N>/<N> green, build green, cargo build/test green. HEAD <hash>. ===

## PHASE 6 COMPLETE — Analysis Rule Engine + LLM Reviewer (branch phase6-analysis, HEAD <hash>)

Final whole-branch review (<model>) verdict: <VERDICT>. <2-4 sentence summary of what the
reviewer independently verified — mirror Phase 5's COMPLETE-section density: frozen contracts
held, D6 invariants verified end-to-end, ANALYSIS_RULES is one array, no worldEngine/ edit
beyond the sanctioned MAX_GLOBE_ARCS export, etc.>

DONE BAR — all met:
1. Full suite <N>/<N> green; npm run build green (strict tsc + vite); cargo build + cargo test
   green at HEAD <hash>.
2. Final whole-branch review verdict <...>; <fix wave summary if any, else "no fix wave
   required">.
3. CONTROLLER PHASE-GATE LIVE STORY PASSED end-to-end (dev :1420, ZERO app console errors
   throughout): <fill in from Step 21 above — the ≥4-rule world tripped across all three
   families, Analysis tab grouping + chip navigation, Settings-configured stub review with a
   proven two-hit retry, AI cards beside deterministic findings, masked key after reload,
   grep-confirmed absence of the key in the saved .scalemap, and the LIVE light-mode theme
   flip + screenshot pass over globe/region/AZ/server with any straggler hexes fixed>.
4. docs/module-boundaries.md §O documents the analysis+llm+settings modules + boundary rules
   + the restated D6 invariants.
5. contract-drift.md `## PHASE 6` current — expect ZERO entries (no worldEngine/ change beyond
   the one sanctioned MAX_GLOBE_ARCS export, which is a carry-forward closing a Phase-5 backlog
   item, not new engine behavior).

Task commit chain (Phase 6): <branch point> → <plan commit> → <T1 commit> → ... → <T9 commit>.
<N> tests green.

REBUILD COMPLETE: all six phases of the world-model rebuild have shipped — Phase 1 (world
model + navigation shell), Phase 2 (substrate simulation engine), Phase 3 (server interior
board), Phase 4 (region flow page + rack chassis), Phase 5 (R3F globe + traffic authoring),
Phase 6 (analysis rule engine + LLM reviewer + global settings). Parked list (umbrella §9,
intentionally NOT picked up by any phase): k8s/ECS schedulers, ScaleScript v2, Terraform v2,
AI watch-mode (continuous review), spot instances, managed-service pseudo-internals, review
persistence/history, streaming LLM responses, request cancellation. Leave `phase6-analysis`
for the user's own merge decision — this task does not merge to `main`.
```

- [ ] **Step 23: commit**

```bash
git add CLAUDE.md docs/module-boundaries.md \
  src/lib/worldEngine/index.ts src/app/world/globe/ArcsLayer.tsx \
  src/app/world/globe/GlobeScene.tsx src/app/world/panels/TrafficPanel.tsx \
  src/app/world/GlobeView.tsx src/lib/worldEngine/globeArcs.test.ts \
  src/lib/world/populationLabel.ts src/lib/world/populationLabel.test.ts \
  .superpowers/sdd/progress.md
git commit -m "docs: CLAUDE.md for the world-model app; module boundaries §O; globe carry-forwards"
```
