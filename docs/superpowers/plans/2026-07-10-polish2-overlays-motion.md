# Polish 2: Command Overlays + Guided Console + Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change where configuration *lives* and how the app *feels* — in-scene command overlays on the globe (tap a region pin or population dot → an anchored card with that entity's few controls that matter; press-and-hold ≈700 ms charges a ring that drills into the region), a guided console (plain-English world summary above the dock tabs, a traffic hero sentence-slider you cannot miss, population/firewall/server surfaces re-voiced as sentences), and one app-wide motion grammar (row lift · button press · tab ink slide · health ripple · number roll · flow shimmer · the hold ring). Binding visual truth: `docs/superpowers/specs/mockups/config-overlays-v1.html`; spec of record: `docs/superpowers/specs/2026-07-10-polish2-config-ux-design.md`.

**Architecture:** Kit-first — T1 lands the motion CSS grammar (`kit.tsx` injected stylesheet), `useRollingNumber` (`motion.ts`) and `healthWord` (`derived.ts`); T2 the reusable `HoldToEnter` primitive wired into RegionPins (tap keeps navigating as an interim); T3 the ONE additive ui.store field (`sceneOverlay`) + the `SceneOverlay` card shell + tap-opens-overlay wiring; T4 the region/population overlay content (every control an existing dispatch, byte-for-byte) + reactive `pendingPanelTab`; T5 the guided console (summary strip, hero slider, sentence rows, pure `frontlineCapacityRps`); T6 the plain-words pass (topology health words, firewall `ruleSentence`); T7 applies the motion inventory app-wide and runs the phase gate. Nothing under `src/lib/worldEngine/` changes; `GlobeScene.tsx` stays untouched.

**Tech Stack:** TypeScript + React 19 + Zustand + react-three-fiber/drei (existing globe) + Tauri 2. No new dependencies anywhere.

## Global Constraints (every task inherits these — skeleton verbatim)

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

## File Structure (skeleton verbatim; one grounded addition marked ★)

```
src/app/world/ui/
  kit.tsx                    # T1 extends: injected CSS (lift/press/ripple/ink), no API breaks
  motion.ts                  # T1 NEW: useRollingNumber hook (+ reduced-motion branch)
  derived.ts                 # T1 extends: healthWord(); T4 extends ★: populationLanding()
                             #   + POP_LATENCY_KM_PER_MS; T5 extends: frontlineCapacityRps()
                             #   + isEntryBlueprint()
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
src/app/world/server/ruleSentence.ts     # T6 NEW ★: pure sentence copy (sibling util the
                                         #   skeleton's "or a sibling util" sanctions)
src/lib/costModelV2.ts       # T5 ★: HOURS_PER_MONTH gains `export` (additive, zero behavior)
docs/module-boundaries.md    # T7: §Q
```

Task order: T1 → T2 → T3 → T4 → T5 → T6 → T7. T2 deliberately keeps tap = navigate as an
interim so the app never loses drill-down between tasks; T3 flips tap to overlay.

---
# Polish 2 plan fragment — Tasks 1–4 (motion foundation · hold-to-enter gesture ·
# sceneOverlay + shell · overlay content + reactive pendingPanelTab)

> Fragment scope: Task 1 (kit CSS grammar + `motion.ts` + `healthWord`), Task 2
> (`HoldToEnter.tsx` + RegionPins drill gesture), Task 3 (`sceneOverlay` ui.store field +
> `SceneOverlay.tsx` shell + globe wiring), Task 4 (`RegionOverlay`/`PopulationOverlay`
> content + WorldPanel reactive `pendingPanelTab`). Global Constraints / File Structure live
> in the assembled plan header (from `docs/superpowers/plans/polish2/skeleton.md`) — not
> repeated here.
>
> **Grounding status: everything below is grounded against REAL, currently-committed source**
> on branch `polish2-overlays-motion` (cut from `main` @ `8e798c0`), verified 2026-07-10 by
> the controller session: `RegionPins.tsx`, `PopulationMarkers.tsx`, `GlobeView.tsx`,
> `GlobeScene.tsx` (props only — file stays untouched), `WorldShell.tsx`, `TopologyPanel.tsx`,
> `TrafficPanel.tsx`, `WorldPanel.tsx` (+ its 4 tests), `HomeScreen.test.tsx`'s two
> pendingPanelTab assertions, `ui.store.ts`, `nav.store.ts`, `simulation.store.ts`,
> `world.store.ts`, `kit.tsx`, `derived.ts`, `factories.ts`, `types.ts`, `routing.ts`,
> `regionGeo.ts`, `regionConfig.ts`, `worldEngine/index.ts` (READ ONLY — entry predicate),
> `worldEngine/networkRuntime.ts` (READ ONLY — km/ms constant), and the mockup
> `config-overlays-v1.html` (CSS values transcribed from the file AND exercised live in a
> Playwright tour: full hold fires the toast + swallows the synthetic click, early release
> cancels with no overlay flash). Derived numbers verified with a scratch vitest run
> (frontlineCapacityRps = 1500 on the T5 fixture; São Paulo → us-east-1 = 7,651 km → 77 ms).
>
> **Grounded controller decisions (apply as written):**
> 1. **Timebase for the hold gesture:** the skeleton's parenthetical suggests
>    `state.clock.elapsedTime * 1000` inside `useFrame`, but pointer handlers have no access
>    to the r3f clock, and mixing timebases (clock-now vs pointer-start) breaks the pure
>    function. Both the start stamp (`onPointerDown`) and the per-frame now use
>    `performance.now()` — one coherent ms timebase, same pure `holdProgress` signature.
> 2. **Click-away without touching GlobeScene:** `GlobeScene.tsx` is UNTOUCHED, so the
>    "canvas-background onPointerMissed" is implemented as `onPointerMissed` on the OPEN
>    entity's mesh (fires whenever a click does not hit that mesh — including clicks on the
>    globe sphere). The handler re-checks `useUiStore.getState().sceneOverlay` identity
>    before clearing, so if another pin's `onClick` (same event pass) already replaced the
>    overlay, the stale close never clobbers it — converges under either r3f event order.
> 3. **Escape coexistence:** `WorldShell.tsx:57-81` already binds window `keydown` Escape →
>    `nav.up()`. At globe level `up()` is a NO-OP (`nav.store.ts:28-33` has no `'globe'`
>    branch), so GlobeView's own Escape → `setSceneOverlay(null)` listener cannot conflict.
>    Overlays exist only at globe level this phase.
> 4. **SceneOverlay dot contract:** the named test says the status dot is omitted when
>    `health` is undefined, but the population overlay's header carries a teal dot (spec D3).
>    The shell gains an additive `dotColor?: string` prop: the dot renders when `health` OR
>    `dotColor` is provided; the omit-test passes both absent.
> 5. **Overlays own their shell:** `RegionOverlay`/`PopulationOverlay` render
>    `<SceneOverlay>` themselves (title/health/footer are content decisions). "Wire into the
>    T3 shells" = RegionPins/PopulationMarkers swap their T3 placeholder shell for the T4
>    content component. Everything stays plain DOM inside drei `<Html>` — jsdom-testable.
> 6. **`populationLanding` helper lands in `derived.ts` during T4** (the File Structure
>    annotation only lists T1/T5 extensions — this is an addition, noted here): T5's sentence
>    rows need the SAME lookup, and a pure doc+compiled function belongs in `derived.ts`, not
>    exported from a component. Its km→ms constant `POP_LATENCY_KM_PER_MS = 100` purely
>    reimplements the engine's `INTERNET_KM_PER_MS` (`networkRuntime.ts:12`, "~1ms per 100km
>    great-circle") — never imported from `worldEngine/`.
> 7. **`Html occlude` note:** `PopulationMarkers.tsx:32` still carries a pre-existing
>    `occlude` on its hover label. The ban is on REINTRODUCING it for new work — the overlay
>    `<Html>` mounts never use it; the existing label line is left exactly as is.
> 8. **Rotation during a hold:** the globe may idle-rotate while a hold is charging (rotation
>    pauses on overlay-open, not on pointer-down); the pin drifting off the pointer fires
>    `onPointerOut` → cancel, which is the designed early-release path. Not a defect; the
>    live smoke only asserts the ring completes when the pointer stays on the pin.

---

## Task 1: Motion foundation — kit CSS grammar, `useRollingNumber`, `healthWord` `[sonnet]`

**Files:** modify `src/app/world/ui/kit.tsx` (injected stylesheet ONLY — zero component/API
changes), create `src/app/world/ui/motion.ts` + `src/app/world/ui/motion.test.ts`, extend
`src/app/world/ui/derived.ts` + `src/app/world/ui/derived.test.ts`, extend
`src/app/world/ui/kit.test.tsx` (stylesheet assertions only).

### Grounding

- The kit's injected-stylesheet pattern is `kit.tsx:20-51`: a `KIT_STYLE_ID` guard, one
  template string, `:root` + `:root[data-theme="light"]` `--kit-*` vars, and an existing
  `@media (prefers-reduced-motion: reduce)` block at lines 42-44 that currently only kills
  `.kit-t`. New CSS goes INSIDE this same template string.
- Existing rules that must survive byte-for-byte: `.kit-row` (line 35), `.kit-row:hover`
  (line 36 — extended, not replaced), `.kit-pcard:hover`, `.kit-t`, `:focus-visible`.
- Mockup values transcribed from `config-overlays-v1.html` (not eyeballed):
  - `.d-row:hover` (line 164): `transform: translateY(-1px)`, `box-shadow: 0 4px 14px
    #00000066, 0 0 0 1px #5b9cf622` → tokenized: `rgba(0,0,0,0.4)` + `color-mix(in srgb,
    var(--color-accent) 13%, transparent)`.
  - `.d-btn` (172-174): hover border `--hud` + glow `#7cffe922` → `var(--kit-accent)` +
    `color-mix(in srgb, var(--kit-accent) 13%, transparent)`; `:active { transform:
    scale(0.96) }`; transitions `border-color 0.12s, transform 0.08s, box-shadow 0.12s`.
  - ripple (169-171): `::after` inset 0, `animation: ripple 1.6s ease-out infinite`,
    keyframes `from { transform: scale(1); opacity: 0.5 } to { transform: scale(3.2);
    opacity: 0 }`.
  - ink (168): height 2px, `background: var(--hud)` → `var(--kit-accent)`, radius 1px,
    `transition: left 0.2s cubic-bezier(0.3, 0.8, 0.3, 1), width 0.2s cubic-bezier(0.3,
    0.8, 0.3, 1)`, `box-shadow: 0 0 6px var(--hud-dim)` → `var(--kit-accent-dim)`.
  - mockup reduced-motion (178-181): ripple/arc `animation: none`; row/btn/ink
    `transition: none`.
- Panel buttons keep INLINE styles (`panelStyles.ts` smallBtn/dangerBtn) — `.kit-press`'s
  hover border must carry `!important` to win over an inline `border: 1px solid …`
  declaration (a stylesheet `!important` beats inline non-important styles). Deliberate;
  scoped to exactly the two hover properties.
- `healthWord` thresholds are spec D7a: max(cpu, ram) < 0.70 → comfortable, < 0.90 → tight,
  else straining. Inputs are the SAME quantities TopologyPanel's ServerRow already computes
  (`TopologyPanel.tsx:159-160`: `cpuMean = mean(metrics.coreUtilization)`, `ramFrac =
  ramUsedMb / ramTotalMb`).
- jsdom (vitest 4) provides `requestAnimationFrame`; the hook must ALSO run when it is
  absent (SSR) by snapping — tests stub rAF with a manual queue for determinism.

### Step 1.1 — failing tests first: `motion.test.ts`

Create `src/app/world/ui/motion.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRollingNumber } from './motion'

let rafQueue: FrameRequestCallback[] = []
let now = 0

beforeEach(() => {
  rafQueue = []
  now = 0
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { rafQueue.push(cb); return rafQueue.length })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.spyOn(performance, 'now').mockImplementation(() => now)
})
afterEach(() => vi.unstubAllGlobals())

// Runs every queued frame callback once, advancing the mocked clock by dtMs per flush.
function flushFrame(dtMs: number) {
  now += dtMs
  const queue = rafQueue
  rafQueue = []
  act(() => { for (const cb of queue) cb(now) })
}

describe('useRollingNumber', () => {
  it('eases toward the target and lands exactly on it', () => {
    const { result, rerender } = renderHook(({ target }) => useRollingNumber(target, 150), {
      initialProps: { target: 1000 },
    })
    expect(result.current).toBe(1000)          // first render seeds at target — no roll-in
    rerender({ target: 2000 })
    flushFrame(50)
    expect(result.current).toBeGreaterThan(1000)
    expect(result.current).toBeLessThan(2000)  // mid-flight: strictly between
    for (let i = 0; i < 20 && result.current !== 2000; i++) flushFrame(50)
    expect(result.current).toBe(2000)          // lands EXACTLY, not asymptotically close
  })

  it('snaps immediately under prefers-reduced-motion', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('prefers-reduced-motion'), addEventListener: () => {}, removeEventListener: () => {},
    }))
    const { result, rerender } = renderHook(({ target }) => useRollingNumber(target), {
      initialProps: { target: 100 },
    })
    rerender({ target: 900 })
    // effect runs synchronously post-render; no frames flushed — already at target
    expect(result.current).toBe(900)
  })
})
```

### Step 1.2 — failing tests: `derived.test.ts` additions

Append to `src/app/world/ui/derived.test.ts` (existing suites untouched):

```ts
describe('healthWord', () => {
  it('thresholds at 0.70 and 0.90 on the max of the two fractions', () => {
    expect(healthWord(0.69, 0)).toBe('comfortable')
    expect(healthWord(0, 0.71)).toBe('tight')
    expect(healthWord(0.9, 0.1)).toBe('straining')
  })
  it('boundary values: exactly 0.70 is tight, exactly 0.90 is straining', () => {
    expect(healthWord(0.7, 0)).toBe('tight')
    expect(healthWord(0.9, 0)).toBe('straining')
  })
})
```

Add `healthWord` to the import list at the top of the file.

### Step 1.3 — failing tests: `kit.test.tsx` additions

Append one suite (the stylesheet is injected at module import; `kit.test.tsx` already
imports from `./kit`):

```tsx
describe('kit motion grammar (Polish 2 T1)', () => {
  const css = () => document.getElementById('scalemap-kit-styles')?.textContent ?? ''
  it('ships the four motion classes', () => {
    expect(css()).toContain('.kit-press:active')
    expect(css()).toContain('.kit-ripple::after')
    expect(css()).toContain('.kit-ink')
    expect(css()).toContain('.kit-row:hover')
  })
  it('every motion class is inside the reduced-motion no-op block', () => {
    const reduced = css().split('@media (prefers-reduced-motion: reduce)')[1] ?? ''
    for (const cls of ['.kit-press', '.kit-ink', '.kit-ripple::after', '.kit-row:hover']) {
      expect(reduced).toContain(cls)
    }
  })
})
```

### Step 1.4 — `motion.ts`

Create `src/app/world/ui/motion.ts`:

```ts
// Motion hooks for the hybrid kit (Polish 2 D8). No store imports.
import { useEffect, useRef, useState } from 'react'

/** Eases the displayed number toward `target` on rAF (~durationMs to land), landing exactly
 *  on the target. Under prefers-reduced-motion — or with no rAF (SSR) — it snaps. */
export function useRollingNumber(target: number, durationMs = 150): number {
  const [display, setDisplay] = useState(target)
  const displayRef = useRef(target)

  useEffect(() => {
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced || typeof requestAnimationFrame !== 'function') {
      displayRef.current = target
      setDisplay(target)
      return
    }
    if (displayRef.current === target) return
    let raf = 0
    let last = performance.now()
    const tick = (nowMs: number) => {
      const dt = Math.max(0, nowMs - last)
      last = nowMs
      const cur = displayRef.current
      // Exponential approach scaled so the value covers ~95% of the gap within durationMs.
      let next = cur + (target - cur) * Math.min(1, (dt * 3) / durationMs)
      if (Math.abs(target - next) < Math.max(0.5, Math.abs(target) * 1e-4)) next = target
      displayRef.current = next
      setDisplay(next)
      if (next !== target) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, durationMs])

  return display
}
```

### Step 1.5 — `derived.ts` addition

Append to `src/app/world/ui/derived.ts`:

```ts
// Plain-words health for a server row (spec D7a): worst of the two pressure fractions.
export function healthWord(cpuFraction: number, ramFraction: number): 'comfortable' | 'tight' | 'straining' {
  const worst = Math.max(cpuFraction, ramFraction)
  if (worst < 0.70) return 'comfortable'
  if (worst < 0.90) return 'tight'
  return 'straining'
}
```

### Step 1.6 — kit.tsx stylesheet extension

Inside the existing template string (`kit.tsx:24-49`), replace the `.kit-row:hover` rule and
extend the reduced-motion block; add the new classes between `.kit-t`'s block and the
reduced-motion block:

```css
.kit-row:hover {
  background: var(--color-surface-hover); border-color: var(--color-node-border);
  transform: translateY(-1px);
  box-shadow: 0 4px 14px rgba(0,0,0,0.4), 0 0 0 1px color-mix(in srgb, var(--color-accent) 13%, transparent);
}
.kit-press { transition: border-color 0.12s ease, transform 0.08s ease, box-shadow 0.12s ease; }
.kit-press:hover {
  border-color: var(--kit-accent) !important;
  box-shadow: 0 0 10px color-mix(in srgb, var(--kit-accent) 13%, transparent);
}
.kit-press:active { transform: scale(0.96); }
.kit-ripple { position: relative; }
.kit-ripple::after {
  content: ''; position: absolute; inset: 0; border-radius: 50%;
  background: currentColor; animation: kit-ripple 1.6s ease-out infinite; pointer-events: none;
}
@keyframes kit-ripple {
  from { transform: scale(1); opacity: 0.5; }
  to { transform: scale(3.2); opacity: 0; }
}
.kit-ink {
  position: absolute; bottom: 0; height: 2px; background: var(--kit-accent);
  border-radius: 1px; box-shadow: 0 0 6px var(--kit-accent-dim);
  transition: left 0.2s cubic-bezier(0.3, 0.8, 0.3, 1), width 0.2s cubic-bezier(0.3, 0.8, 0.3, 1);
}
```

Reduced-motion block becomes:

```css
@media (prefers-reduced-motion: reduce) {
  .kit-t, .kit-press, .kit-ink { transition: none; }
  .kit-ripple::after { animation: none; opacity: 0; }
  .kit-row:hover { transform: none; box-shadow: none; }
  .react-flow__edge.animated .react-flow__edge-path { animation: none; }
}
```

(The last line pre-arms T7's flow shimmer for reduced motion — React Flow's `animated` edge
class animates `stroke-dashoffset` via its own CSS; this scopes the no-op app-wide.)

No component bodies change. `KIT_GLOW_TEXT` and every export stay byte-identical.

### Step 1.7 — verify

```bash
npx vitest run src/app/world/ui/motion.test.ts src/app/world/ui/derived.test.ts src/app/world/ui/kit.test.tsx
# expect: all pass (2 new motion tests, 2 new derived tests, 2 new kit tests, zero prior failures)
npx vitest run
# expect: full suite green
npm run build
# expect: tsc + vite build clean
```

**Commit:** `feat(ui): motion foundation — kit hover/press/ripple/ink grammar, useRollingNumber, healthWord`

---

## Task 2: HoldToEnter primitive + region-pin drill gesture `[sonnet]`

**Files:** create `src/app/world/ui/HoldToEnter.tsx` + `src/app/world/ui/HoldToEnter.test.ts`,
modify `src/app/world/globe/RegionPins.tsx`.

### Grounding

- `RegionPins.tsx` today (read in full): pin mesh `onClick` at line 110 (`e.stopPropagation();
  goRegion(regionId)`), `useFrame` at 90-104 (horizon test writing `labelVisible` state only
  on crossings + pulse scale via ref), `<Html>` label mount at 129-135 with
  `pointerEvents: 'none'`. `goRegion` comes from `useNavStore` (line 69). Do NOT regress:
  the horizon test, the pulse, the hover cursor/emissive handlers at 111-112, the
  fixed-10px label, and the `isPulsing`/`pinColor` exports with their existing tests
  (`RegionPins.test.ts` — node env, untouched by this task).
- Mockup ring truth (`config-overlays-v1.html:59-62` + live tour): 34×34 SVG, circle r=15,
  stroke `--hud` 2.5px round cap, `stroke-dasharray: 94.2` (=2π·15), `rotate(-90deg)` so the
  sweep starts at 12 o'clock, `drop-shadow(0 0 4px var(--hud-dim))` glow, hidden at rest.
  Hold semantics verified live: 700 ms to completion; completion sets a `holdFired` flag that
  the click handler consumes-and-swallows; `pointerup`/`pointerleave` before 700 ms cancel
  with no navigation and no overlay.
- T2 is the INTERIM step: tap (non-hold click) KEEPS `goRegion` so the app never loses
  drill-down between tasks. T3 flips the else-branch to `setSceneOverlay`.
- Controller decision 1 (header): `performance.now()` is the single timebase.

### Step 2.1 — failing tests first: `HoldToEnter.test.ts`

Create `src/app/world/ui/HoldToEnter.test.ts` (node env — pure logic only; the ring
component and gesture are live-smoke gated):

```ts
import { describe, it, expect } from 'vitest'
import { holdProgress, HOLD_DURATION_MS } from './HoldToEnter'

describe('holdProgress', () => {
  it('is 0 with a null start', () => {
    expect(holdProgress(12345, null)).toBe(0)
  })
  it('reaches exactly 1 at the duration and clamps beyond', () => {
    expect(holdProgress(1000 + HOLD_DURATION_MS, 1000)).toBe(1)
    expect(holdProgress(1000 + HOLD_DURATION_MS * 3, 1000)).toBe(1)
  })
  it('is 0.5 at half the duration', () => {
    expect(holdProgress(1000 + HOLD_DURATION_MS / 2, 1000)).toBe(0.5)
  })
  it('clamps a pre-start now to 0', () => {
    expect(holdProgress(500, 1000)).toBe(0)
  })
})
```

### Step 2.2 — `HoldToEnter.tsx`

Create `src/app/world/ui/HoldToEnter.tsx`:

```tsx
// Hold-to-enter drill primitive (Polish 2 D5): pure progress math + a screen-space SVG ring.
// Reusable beyond the globe (region → AZ → server mounts are a parked follow-up). The ring is
// FUNCTIONAL progress feedback, so its sweep stays under prefers-reduced-motion — only the
// glow is trimmed (Global Constraints).
import { useEffect, useRef, type ReactElement } from 'react'
import { useReducedMotion } from 'framer-motion'

export const HOLD_DURATION_MS = 700

const RING_R = 15                       // viewBox units — matches the mockup's r=15 @ 34×34
const RING_C = 2 * Math.PI * RING_R     // 94.248 — the mockup's stroke-dasharray

export function holdProgress(nowMs: number, startMs: number | null, durationMs = HOLD_DURATION_MS): number {
  if (startMs === null) return 0
  return Math.min(1, Math.max(0, (nowMs - startMs) / durationMs))
}

export interface HoldRingProps {
  /** Parent-owned progress cell (0..1), mutated per frame — never setState per frame. */
  progressRef: { current: number }
  size?: number
}

export function HoldRing({ progressRef, size = 34 }: HoldRingProps): ReactElement {
  const circleRef = useRef<SVGCircleElement>(null)
  const reduced = useReducedMotion() ?? false

  // rAF loop applies progressRef to stroke-dashoffset/opacity — DOM writes only, no React
  // state. jsdom/SSR-safe: without rAF the ring simply stays hidden (live-smoke gated).
  useEffect(() => {
    if (typeof requestAnimationFrame !== 'function') return
    let raf = 0
    const tick = () => {
      const el = circleRef.current
      if (el) {
        const p = Math.min(1, Math.max(0, progressRef.current))
        el.style.strokeDashoffset = String(RING_C * (1 - p))
        if (el.ownerSVGElement) el.ownerSVGElement.style.opacity = p > 0 ? '1' : '0'
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [progressRef])

  return (
    <svg
      width={size} height={size} viewBox="0 0 34 34" aria-hidden="true"
      style={{ opacity: 0, transform: 'rotate(-90deg)', pointerEvents: 'none', display: 'block' }}
    >
      <circle
        ref={circleRef}
        cx="17" cy="17" r={RING_R} fill="none"
        stroke="var(--kit-accent)" strokeWidth="2.5" strokeLinecap="round"
        strokeDasharray={RING_C} strokeDashoffset={RING_C}
        style={reduced ? undefined : { filter: 'drop-shadow(0 0 4px var(--kit-accent-dim))' }}
      />
    </svg>
  )
}
```

### Step 2.3 — RegionPins gesture wiring

In `src/app/world/globe/RegionPins.tsx`:

1. Add imports: `import { HoldRing, holdProgress } from '../ui/HoldToEnter'`.
2. Inside `RegionPin`, add refs next to the existing ones:

```tsx
  const holdStartRef = useRef<number | null>(null)
  const holdFiredRef = useRef(false)
  const holdProgressRef = useRef(0)
```

3. Extend the existing `useFrame` — APPEND this block after the pulse-scale code (the
   horizon-test and pulse blocks stay byte-identical above it):

```tsx
    // Hold-to-enter (Polish 2 D5): drive the ring from performance.now() (pointer handlers
    // can't read the r3f clock — one coherent timebase, see plan header decision 1).
    const p = holdProgress(performance.now(), holdStartRef.current)
    holdProgressRef.current = p
    if (p >= 1 && holdStartRef.current !== null) {
      holdStartRef.current = null
      holdProgressRef.current = 0
      holdFiredRef.current = true      // swallow the synthetic click that follows pointerup
      goRegion(regionId)
    }
```

4. Replace the pin mesh's THREE pointer handlers (lines 110-112). `onClick`'s else-branch
   keeps `goRegion` in this task (T3 swaps it for `setSceneOverlay`):

```tsx
        onClick={e => {
          e.stopPropagation()
          if (holdFiredRef.current) { holdFiredRef.current = false; return }   // hold completed — not a tap
          goRegion(regionId)
        }}
        onPointerDown={e => {
          e.stopPropagation()
          ;(e.target as Element | undefined)?.setPointerCapture?.(e.pointerId)
          holdStartRef.current = performance.now()
        }}
        onPointerUp={e => {
          ;(e.target as Element | undefined)?.releasePointerCapture?.(e.pointerId)
          holdStartRef.current = null      // released early → cancel (completion already cleared it)
        }}
        onPointerOver={() => { document.body.style.cursor = 'pointer'; setHovered(true) }}
        onPointerOut={() => {
          document.body.style.cursor = 'default'; setHovered(false)
          holdStartRef.current = null      // left the pin mid-hold → cancel (mockup pointerleave)
        }}
```

   (`onPointerOver`/`onPointerOut` bodies extend the existing ones — cursor + hover lines
   byte-identical, cancel line appended.)

5. Mount the ring as an `<Html>` sibling of the label (inside the same `<group>`, after the
   glow mesh), always mounted — the ring hides itself at progress 0:

```tsx
      <Html center zIndexRange={[50, 40]} style={{ pointerEvents: 'none' }}>
        <HoldRing progressRef={holdProgressRef} />
      </Html>
```

### Step 2.4 — verify

```bash
npx vitest run src/app/world/ui/HoldToEnter.test.ts src/app/world/globe/RegionPins.test.ts
# expect: 4 new holdProgress tests pass; the existing pinColor/isPulsing tests untouched and green
npx vitest run && npm run build
```

### Step 2.5 — live smoke (controller runs it)

Port 1420 (reuse the user's dev server if the port is occupied — §2(a) of the runbook).

- [ ] Multi-region example → globe. Press-and-hold the us-east-1 pin: teal ring charges
      clockwise from 12 o'clock over ~0.7 s → region view opens. Zero console errors.
- [ ] Back to globe. Press, release at ~half ring: stays on globe, ring vanishes, NO
      navigation, no overlay flash.
- [ ] Plain tap on a pin still navigates into the region (T2 interim behavior).
- [ ] Hold with reduced motion emulated (DevTools rendering panel): ring still sweeps (no
      glow) — the sweep is functional feedback.
- [ ] Pin hover still brightens + pointer cursor; label still hides behind the horizon while
      rotating; no regression to the pulse on failover events.

**Commit:** `feat(globe): hold-to-enter ring primitive + region-pin drill gesture`

---

## Task 3: `sceneOverlay` state + `SceneOverlay` shell + globe wiring `[sonnet]`

**Files:** modify `src/app/store/ui.store.ts`, create `src/app/store/ui.store.test.ts`,
create `src/app/world/ui/SceneOverlay.tsx` + `src/app/world/ui/SceneOverlay.test.tsx`,
modify `src/app/world/globe/RegionPins.tsx`, `src/app/world/globe/PopulationMarkers.tsx`,
`src/app/world/GlobeView.tsx`.

### Grounding

- `ui.store.ts` (28 lines, read in full): `themeMode` + `pendingPanelTab`, both additive
  precedents. `sceneOverlay` follows the same stance. No existing `ui.store.test.ts` — create
  one (jsdom env — the store touches `localStorage` at module init).
- `GlobeView.tsx:77`: `autoRotate={!rotationLocked}` — becomes
  `autoRotate={!rotationLocked && sceneOverlay == null}` (spec D2 verbatim; `GlobeScene`
  already accepts the prop, `GlobeScene.tsx:151`, file untouched).
- `PopulationMarkers.tsx` (52 lines, read in full): markers have NO click today — `onClick`
  is purely additive. `PopulationMarker` needs the population `id` added to its props (only
  `label/lat/lon/peakRps` today).
- Mockup `.ovl` card (`config-overlays-v1.html:67-100`), transcribed: width 296, radius 9,
  bg `#12151dee` → `color-mix(in srgb, var(--color-node-base) 93%, transparent)` +
  `backdrop-filter: blur(6px)`, border `--border`, shadow `0 14px 40px #000000a8, 0 0 0 1px
  #7cffe912` → `rgba(0,0,0,0.66)` + `color-mix(in srgb, var(--kit-accent) 7%, transparent)`,
  spring-in `ovl-in 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.2)` from
  `scale(0.92) translateY(-6px)`, `transform-origin: top left`; header `11px 13px 9px` padding,
  8px dot with 0-0-6px glow, 12px 600 title, 10px muted right-aligned small; footer flex gap 7
  padding `10px 13px 12px`, top border; `.act` buttons 11px mono, radius 5, padding `5px 12px`,
  border `--border`, bg `--node`, primary = accent-dim border + accent text, danger = danger
  text. Reduced motion (line 76): animation swapped for fade-only.
- Escape / click-away / event-order: controller decisions 2 and 3 in the fragment header.
- The T3 shell mount is a PLACEHOLDER (title = catalogId / population label, subtitle only);
  T4 replaces it with the content components.

### Step 3.1 — failing tests first

`src/app/store/ui.store.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { useUiStore } from './ui.store'

beforeEach(() => useUiStore.setState({ sceneOverlay: null }))

describe('ui.store sceneOverlay', () => {
  it('setSceneOverlay stores and clears the selection', () => {
    useUiStore.getState().setSceneOverlay({ kind: 'region', id: 'r-1' })
    expect(useUiStore.getState().sceneOverlay).toEqual({ kind: 'region', id: 'r-1' })
    useUiStore.getState().setSceneOverlay(null)
    expect(useUiStore.getState().sceneOverlay).toBeNull()
  })
  it('starts null and leaves the existing fields untouched', () => {
    expect(useUiStore.getState().sceneOverlay).toBeNull()
    expect(typeof useUiStore.getState().setThemeMode).toBe('function')
    expect(useUiStore.getState().pendingPanelTab).toBeNull()
  })
})
```

`src/app/world/ui/SceneOverlay.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SceneOverlay } from './SceneOverlay'

describe('SceneOverlay', () => {
  it('renders title, status word, children and fires onClose from the esc button', () => {
    const onClose = vi.fn()
    render(
      <SceneOverlay title="us-east-1 · N. Virginia" health="healthy" onClose={onClose}>
        <div>chips here</div>
      </SceneOverlay>,
    )
    expect(screen.getByText('us-east-1 · N. Virginia')).toBeInTheDocument()
    expect(screen.getByText('healthy')).toBeInTheDocument()
    expect(screen.getByText('chips here')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'esc' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('omits the status dot when health is undefined', () => {
    render(<SceneOverlay title="São Paulo" subtitle="client population" onClose={() => {}}>x</SceneOverlay>)
    expect(screen.queryByTestId('scene-ovl-dot')).not.toBeInTheDocument()
    expect(screen.getByText('client population')).toBeInTheDocument()
  })

  it('renders a dot for an explicit dotColor even without health', () => {
    render(<SceneOverlay title="São Paulo" dotColor="var(--kit-teal)" onClose={() => {}}>x</SceneOverlay>)
    expect(screen.getByTestId('scene-ovl-dot')).toBeInTheDocument()
  })

  it('renders the footer slot', () => {
    render(
      <SceneOverlay title="t" onClose={() => {}} footer={<button>enter ⏎</button>}>x</SceneOverlay>,
    )
    expect(screen.getByRole('button', { name: 'enter ⏎' })).toBeInTheDocument()
  })
})
```

### Step 3.2 — ui.store extension

In `src/app/store/ui.store.ts` — additive only (append a dated comment line to the header
block noting the Polish 2 field, same style as the existing Polish 1 note):

```ts
export interface SceneOverlayTarget { kind: 'region' | 'population'; id: string }
```

Add to the interface:

```ts
  sceneOverlay: SceneOverlayTarget | null
  setSceneOverlay: (o: SceneOverlayTarget | null) => void
```

Add to the creator:

```ts
  sceneOverlay: null,
  setSceneOverlay: (o) => set({ sceneOverlay: o }),
```

Nothing existing changes.

### Step 3.3 — `SceneOverlay.tsx`

Create `src/app/world/ui/SceneOverlay.tsx`:

```tsx
// In-scene overlay card shell (Polish 2 D3) — the mockup's .ovl, tokenized. Plain DOM
// (mounted inside drei <Html> by the globe layers) so it and its content stay jsdom-testable.
import type { CSSProperties, ReactNode } from 'react'

const OVL_STYLE_ID = 'scalemap-scene-overlay-styles'
if (typeof document !== 'undefined' && !document.getElementById(OVL_STYLE_ID)) {
  const style = document.createElement('style')
  style.id = OVL_STYLE_ID
  style.textContent = `
@keyframes scene-ovl-in { from { opacity: 0; transform: scale(0.92) translateY(-6px); } }
@keyframes scene-ovl-fade { from { opacity: 0; } }
.scene-ovl { animation: scene-ovl-in 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.2); transform-origin: top left; }
@media (prefers-reduced-motion: reduce) {
  .scene-ovl { animation: scene-ovl-fade 0.15s ease; }
}
`
  document.head.appendChild(style)
}

const HEALTH_DOT: Record<'healthy' | 'degraded' | 'down', string> = {
  healthy: 'var(--color-success)', degraded: 'var(--color-warning)', down: 'var(--color-danger)',
}

// Shared action-button styles for overlay footers (the mockup's .act family) — consumed by
// the T4 content components; exported here so every overlay speaks one dialect.
export const ovlAct: CSSProperties = {
  font: '11px var(--font-mono)', borderRadius: 5, padding: '5px 12px', cursor: 'pointer',
  border: '1px solid var(--color-node-border)', background: 'var(--color-node-base)',
  color: 'var(--color-text-primary)',
}
export const ovlActPrimary: CSSProperties = {
  ...ovlAct, borderColor: 'var(--kit-accent-dim)', color: 'var(--kit-accent)',
}
export const ovlActDanger: CSSProperties = { ...ovlAct, color: 'var(--color-danger)' }

export interface SceneOverlayProps {
  title: string
  health?: 'healthy' | 'degraded' | 'down' | null
  subtitle?: string
  /** Header dot for non-health entities (population teal). Health wins when both given. */
  dotColor?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}

export function SceneOverlay({ title, health, subtitle, dotColor, onClose, children, footer }: SceneOverlayProps) {
  const dot = health ? HEALTH_DOT[health] : dotColor
  return (
    <div
      className="scene-ovl"
      style={{
        width: 296, borderRadius: 9,
        background: 'color-mix(in srgb, var(--color-node-base) 93%, transparent)',
        border: '1px solid var(--color-node-border)', backdropFilter: 'blur(6px)',
        boxShadow: '0 14px 40px rgba(0,0,0,0.66), 0 0 0 1px color-mix(in srgb, var(--kit-accent) 7%, transparent)',
        font: '11px var(--font-mono)', color: 'var(--color-text-primary)',
      }}
    >
      <header style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '11px 13px 9px',
        borderBottom: '1px solid var(--color-toolbar-border)',
      }}>
        {dot && (
          <span data-testid="scene-ovl-dot" style={{
            width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
            background: dot, boxShadow: `0 0 6px ${dot}`,
          }} />
        )}
        <b style={{ fontSize: 12, fontWeight: 600 }}>{title}</b>
        <small style={{ color: 'var(--color-text-muted)', fontSize: 10, marginLeft: 'auto' }}>
          {health ?? subtitle}
        </small>
      </header>
      {children}
      <footer style={{
        display: 'flex', gap: 7, padding: '10px 13px 12px', marginTop: 6,
        borderTop: '1px solid var(--color-toolbar-border)',
      }}>
        {footer}
        <button type="button" className="kit-press" style={{ ...ovlAct, marginLeft: 'auto' }} onClick={onClose}>
          esc
        </button>
      </footer>
    </div>
  )
}
```

### Step 3.4 — globe wiring

**RegionPins.tsx** — `RegionPin` additions:

```tsx
import { useUiStore } from '../../store/ui.store'
import { SceneOverlay } from '../ui/SceneOverlay'
```

```tsx
  const sceneOverlay = useUiStore(s => s.sceneOverlay)
  const setSceneOverlay = useUiStore(s => s.setSceneOverlay)
  const overlayOpen = sceneOverlay?.kind === 'region' && sceneOverlay.id === regionId
```

The `onClick` else-branch (T2 interim `goRegion`) becomes:

```tsx
          setSceneOverlay({ kind: 'region', id: regionId })
```

The mesh additionally gets (decision 2 — click-away that converges under either event order):

```tsx
        onPointerMissed={() => {
          const cur = useUiStore.getState().sceneOverlay
          if (cur?.kind === 'region' && cur.id === regionId) useUiStore.getState().setSceneOverlay(null)
        }}
```

Overlay mount — inside the pin `<group>`, after the ring `<Html>` (T3 placeholder content;
T4 swaps the `<SceneOverlay>` for `<RegionOverlay>`):

```tsx
      {overlayOpen && (
        <Html zIndexRange={[100, 90]} style={{ pointerEvents: 'auto' }}>
          <div style={{ transform: 'translate(14px, -8px)' }}>
            <SceneOverlay title={catalogId} health={health} onClose={() => setSceneOverlay(null)}>
              <div style={{ padding: '10px 13px 2px', color: 'var(--color-text-muted)' }}>
                region controls arrive in T4
              </div>
            </SceneOverlay>
          </div>
        </Html>
      )}
```

**PopulationMarkers.tsx** — `MarkerProps` gains `id: string` (passed from the map:
`id={p.id}`); the mesh gains a click + missed pair and the hover handlers gain the pointer
cursor (matching the pins' affordance — additive):

```tsx
import { useUiStore } from '../../store/ui.store'
import { SceneOverlay } from '../ui/SceneOverlay'
```

```tsx
      <mesh
        onClick={e => { e.stopPropagation(); useUiStore.getState().setSceneOverlay({ kind: 'population', id }) }}
        onPointerMissed={() => {
          const cur = useUiStore.getState().sceneOverlay
          if (cur?.kind === 'population' && cur.id === id) useUiStore.getState().setSceneOverlay(null)
        }}
        onPointerOver={() => { document.body.style.cursor = 'pointer'; setHovered(true) }}
        onPointerOut={() => { document.body.style.cursor = 'default'; setHovered(false) }}
      >
```

Overlay mount (subscribe via hook so the marker re-renders on open/close):

```tsx
  const overlayOpen = useUiStore(s => s.sceneOverlay?.kind === 'population' && s.sceneOverlay.id === id)
```

```tsx
      {overlayOpen && (
        <Html zIndexRange={[100, 90]} style={{ pointerEvents: 'auto' }}>
          <div style={{ transform: 'translate(14px, -8px)' }}>
            <SceneOverlay
              title={label} subtitle="client population" dotColor="var(--kit-teal)"
              onClose={() => useUiStore.getState().setSceneOverlay(null)}
            >
              <div style={{ padding: '10px 13px 2px', color: 'var(--color-text-muted)' }}>
                demand controls arrive in T4
              </div>
            </SceneOverlay>
          </div>
        </Html>
      )}
```

The existing hover-label `<Html occlude …>` line stays byte-identical (decision 7).

**GlobeView.tsx**:

```tsx
import { useUiStore } from '../store/ui.store'
```

```tsx
  const sceneOverlay = useUiStore(s => s.sceneOverlay)

  // Escape closes an open overlay; WorldShell's own Escape → nav.up() is a no-op at globe
  // level (nav.store.ts:28-33), so the two listeners cannot fight. Overlay state also clears
  // on unmount (level change) so a stale overlay never survives navigation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && useUiStore.getState().sceneOverlay) useUiStore.getState().setSceneOverlay(null)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      useUiStore.getState().setSceneOverlay(null)
    }
  }, [])
```

Line 77 becomes:

```tsx
        <GlobeScene placeMode={placeMode} onPlace={onPlace} autoRotate={!rotationLocked && sceneOverlay == null}>
```

(`useEffect` joins the existing `useState` import from react.)

### Step 3.5 — verify

```bash
npx vitest run src/app/store/ui.store.test.ts src/app/world/ui/SceneOverlay.test.tsx src/app/world/globe/RegionPins.test.ts
npx vitest run && npm run build
```

### Step 3.6 — live smoke (controller runs it)

- [ ] Tap us-east-1 pin → shell card opens anchored beside the pin, spring-in; idle rotation
      PAUSES while it is open.
- [ ] `esc` button and the Escape key both close it; rotation resumes.
- [ ] Tap the São Paulo dot → population shell opens (teal dot, "client population").
- [ ] Click empty space / the globe sphere → overlay closes (click-away).
- [ ] Tap pin A then pin B directly: B's overlay replaces A's (no flicker to null).
- [ ] Hold-drill still enters the region and the overlay never flashes open on completion.
- [ ] Navigate into a region and back — no overlay is open on return (unmount clear).
- [ ] Dark + light screenshots of both shells → `.superpowers/sdd/screenshots/polish2-t3-*`.

**Commit:** `feat(globe): sceneOverlay state, overlay card shell, tap-opens-overlay wiring`

---

## Task 4: Region + Population overlay content, reactive pendingPanelTab `[sonnet]`

**Files:** create `src/app/world/ui/overlays/RegionOverlay.tsx` + `RegionOverlay.test.tsx`,
`src/app/world/ui/overlays/PopulationOverlay.tsx` + `PopulationOverlay.test.tsx`; extend
`src/app/world/ui/derived.ts` + `derived.test.ts` (`populationLanding`, decision 6); modify
`src/app/world/panels/WorldPanel.tsx` + `WorldPanel.test.tsx`; swap the T3 placeholder
shells in `RegionPins.tsx` / `PopulationMarkers.tsx` for the content components.

### Grounding — dispatch inventory that MUST survive byte-for-byte

| Control | Source of truth | Exact dispatch |
|---|---|---|
| Region role segmented | `TopologyPanel.tsx:88-95` | `useWorldStore.setState(s => ({ doc: { ...s.doc, regions: { ...s.doc.regions, [region.id]: { ...region, role: <v> } } } }))` then `useFileStore.getState().setDirty(true)` — deliberately NO history push (cite the same comment) |
| Kill/restore | `simulation.store.ts:80-83`, precedent `RegionView.tsx:97` | `setOutage('region', regionId, !isDown)` where `isDown = healthOverrides[regionId] ?? false` |
| Enter | `nav.store.ts:24` | `goRegion(regionId)` |
| Demand slider commit | `TrafficPanel.tsx:113-114` | `updatePopulation(id, { peakRps: n })` — commit-on-release only; drag mutates a local draft (the slider discipline is `kit.tsx:251-256` `commitSlider`: `interacted` ref, commit on mouseup/touchend/keyup/blur, skip when not interacted) |
| Remove population | `TrafficPanel.tsx:120` | `removePopulation(id)` then `onClose()` |
| Traffic panel jump | `ui.store.ts:27` | `setPendingPanelTab('traffic')` then `onClose()` |

Other verified facts:

- `RegionMetrics` (`worldEngine/types.ts`, frozen): `rps`, `p50Ms`, `health` — there is no
  region p99; the mockup's "p99 84 ms" chip is rendered as **`p50 N ms`** from
  `RegionMetrics.p50Ms` (the frozen contract exposes no region p99 — chip label says what it
  shows).
- `$N/hr` chip = Σ `server.hourlyUsd` over `doc.servers` with `azId` in the region's AZs,
  `.toFixed(2)` (authored data — always available, not batch-gated).
- Capacity = mean of `mean(coreUtilization)` across the region's servers from the display
  batch (`scrubBatch ?? latestBatch` — same read every panel uses). Rendered with the kit's
  **`SpecBar`** (`kit.tsx:155-172`, built-but-unconsumed) — consuming it retires the Polish 1
  carry-forward. At rest: fraction 0, value `'—'`.
- Rolling rps chip uses T1's `useRollingNumber` — hook called unconditionally
  (`useRollingNumber(metrics?.rps ?? 0)`), chip text gated on `metrics` presence.
- `populationLanding`: first entry of `compiled.routing.populationRegionOrder[popId]`
  (`types.ts:224` — policy-ordered, passive regions last, `routing.ts:22-44`); latency =
  `Math.round(greatCircleKm(pop.lat, pop.lon, geo.lat, geo.lon) / POP_LATENCY_KM_PER_MS)`
  with geo from `REGION_GEO[region.catalogId]`. Scratch-verified: São Paulo (-23.55,-46.63)
  → us-east-1 = 77 ms. Fallback (no regions / unknown geo): `null` → hint renders
  `routed by <doc.routing.policy>`.
- WorldPanel today: initializer `WorldPanel.tsx:26` (BYTE-IDENTICAL after this task) + one-shot
  mount-clear effect at 27-33 (REPLACED by the reactive effect below, which subsumes it).
  The three vault tests that must pass UNTOUCHED: `HomeScreen.test.tsx:39` (non-teaching
  card leaves the field null), `HomeScreen.test.tsx:45` (teaching card queues `'analysis'`),
  `WorldPanel.test.tsx:33-38` (`consumes a pending panel tab once on mount`).
- Overlay slider bounds are the SPEC's (D3): 50–5000 step 50 (the mockup's max 2000 was
  illustrative; spec wins).
- Store-action spies follow the `InspectorRail.test.tsx:104-114` idiom: spy BEFORE render,
  `vi.clearAllMocks()` in `afterEach` (Zustand carries spied references forward).

### Step 4.1 — failing tests first: `derived.test.ts` addition

```ts
describe('populationLanding', () => {
  it('lands on the first policy-ordered region with its km-derived latency', () => {
    const doc = createWorld()
    const r1 = createRegion('us-east-1'); doc.regions[r1.id] = r1
    const r2 = createRegion('eu-west-1'); doc.regions[r2.id] = r2
    const pop = createPopulation('São Paulo', -23.55, -46.63); doc.populations[pop.id] = pop
    const compiled = compileWorld(doc)
    const landing = populationLanding(pop, doc, compiled)
    expect(landing).toEqual({ regionCatalogId: 'us-east-1', latencyMs: 77 })
  })
  it('returns null with no regions', () => {
    const doc = createWorld()
    const pop = createPopulation('nyc', 40.7, -74); doc.populations[pop.id] = pop
    expect(populationLanding(pop, doc, compileWorld(doc))).toBeNull()
  })
})
```

(`createPopulation` joins the existing factories import; `populationLanding` joins the
derived import.)

### Step 4.2 — `derived.ts` addition

```ts
import { REGION_GEO, greatCircleKm } from '../../../lib/world/regionGeo'
import type { ClientPopulation } from '../../../lib/world/types'
```

```ts
// Pure reimplementation of the engine's client→region latency convention
// (worldEngine/networkRuntime.ts INTERNET_KM_PER_MS = 100, "~1ms per 100km great-circle") —
// never imported from worldEngine (Global Constraints).
export const POP_LATENCY_KM_PER_MS = 100

// Where a population's traffic lands: the first region in the compiled policy order (the
// same order resolveRegion consumes), with a great-circle latency estimate. Null when no
// route resolves (no regions, or a region whose catalogId has no geo entry).
export function populationLanding(
  pop: ClientPopulation, doc: WorldDoc, compiled: CompiledWorld,
): { regionCatalogId: string; latencyMs: number } | null {
  const first = compiled.routing.populationRegionOrder[pop.id]?.[0]
  const region = first ? doc.regions[first] : undefined
  const geo = region ? REGION_GEO[region.catalogId] : undefined
  if (!region || !geo) return null
  return {
    regionCatalogId: region.catalogId,
    latencyMs: Math.round(greatCircleKm(pop.lat, pop.lon, geo.lat, geo.lon) / POP_LATENCY_KM_PER_MS),
  }
}
```

### Step 4.3 — failing tests: `RegionOverlay.test.tsx`

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RegionOverlay } from './RegionOverlay'
import { useWorldStore } from '../../../store/world.store'
import { useSimulationStore } from '../../../store/simulation.store'
import { useFileStore } from '../../../store/file.store'
import { createWorld, createRegion, createAz, createServer } from '../../../../lib/world/factories'
import { getPreset } from '../../../../lib/world/instanceCatalog'

function seedRegion() {
  const doc = createWorld()
  const r = createRegion('us-east-1'); doc.regions[r.id] = r
  const az1 = createAz(r.id, 'us-east-1a'); doc.azs[az1.id] = az1
  const az2 = createAz(r.id, 'us-east-1b'); doc.azs[az2.id] = az2
  const s1 = createServer(az1.id, getPreset('vps-medium')!); doc.servers[s1.id] = s1   // $0.036/hr
  const s2 = createServer(az2.id, getPreset('vps-medium')!); doc.servers[s2.id] = s2
  useWorldStore.setState({ doc, history: [], future: [] })
  useSimulationStore.setState({ running: false, latestBatch: null, scrubBatch: null, healthOverrides: {} })
  return { regionId: r.id, serverIds: [s1.id, s2.id] }
}

afterEach(() => vi.clearAllMocks())

describe('RegionOverlay', () => {
  it('renders authored chips at rest and — for metrics', () => {
    const { regionId } = seedRegion()
    render(<RegionOverlay regionId={regionId} onClose={() => {}} />)
    expect(screen.getByText('2 AZs')).toBeInTheDocument()
    expect(screen.getByText('2 servers')).toBeInTheDocument()
    expect(screen.getByText('$0.07/hr')).toBeInTheDocument()          // 2 × 0.036 → toFixed(2)
    expect(screen.getByText('~— rps in')).toBeInTheDocument()         // metrics chips dashed at rest
    expect(screen.getByText('p50 — ms')).toBeInTheDocument()
  })

  it('role segmented dispatches the exact TopologyPanel role patch (no history push)', () => {
    const { regionId } = seedRegion()
    const historyBefore = useWorldStore.getState().history.length
    useFileStore.getState().setDirty(false)
    render(<RegionOverlay regionId={regionId} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'passive' }))
    expect(useWorldStore.getState().doc.regions[regionId].role).toBe('passive')
    expect(useWorldStore.getState().history.length).toBe(historyBefore)   // deliberate no-history
    expect(useFileStore.getState().dirty).toBe(true)
  })

  it('kill is disabled while stopped and dispatches setOutage("region", id, true) while running', () => {
    const { regionId } = seedRegion()
    const spy = vi.spyOn(useSimulationStore.getState(), 'setOutage').mockImplementation(() => {})
    const { rerender } = render(<RegionOverlay regionId={regionId} onClose={() => {}} />)
    const kill = screen.getByRole('button', { name: /kill/ })
    expect(kill).toBeDisabled()
    expect(kill).toHaveAttribute('title', 'start the simulation to break things')

    useSimulationStore.setState({ running: true })
    rerender(<RegionOverlay regionId={regionId} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /kill/ }))
    expect(spy).toHaveBeenCalledWith('region', regionId, true)
  })

  it('enter ⏎ navigates into the region', () => {
    const { regionId } = seedRegion()
    useNavStore.getState().goGlobe()
    render(<RegionOverlay regionId={regionId} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'enter ⏎' }))
    expect(useNavStore.getState().level).toBe('region')
    expect(useNavStore.getState().regionId).toBe(regionId)
  })
})
```

(`useNavStore` joins the store imports at the top:
`import { useNavStore } from '../../../store/nav.store'`.)

### Step 4.4 — failing tests: `PopulationOverlay.test.tsx`

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PopulationOverlay } from './PopulationOverlay'
import { useWorldStore } from '../../../store/world.store'
import { useUiStore } from '../../../store/ui.store'
import { createWorld, createRegion, createPopulation } from '../../../../lib/world/factories'

function seedPop() {
  const doc = createWorld()
  const r = createRegion('us-east-1'); doc.regions[r.id] = r
  const pop = createPopulation('São Paulo', -23.55, -46.63); doc.populations[pop.id] = pop
  useWorldStore.setState({ doc, history: [], future: [] })
  return { popId: pop.id }
}

afterEach(() => vi.clearAllMocks())

describe('PopulationOverlay', () => {
  it('slider commit dispatches updatePopulation with peakRps on release only', () => {
    const { popId } = seedPop()
    const spy = vi.spyOn(useWorldStore.getState(), 'updatePopulation')
    render(<PopulationOverlay populationId={popId} onClose={() => {}} />)
    const slider = screen.getByLabelText('demand')
    fireEvent.change(slider, { target: { value: '1600' } })
    expect(spy).not.toHaveBeenCalled()                                  // drag = draft only
    fireEvent.mouseUp(slider)
    expect(spy).toHaveBeenCalledWith(popId, { peakRps: 1600 })          // exact TrafficPanel patch
  })

  it('renders the landing hint from the compiled routing table', () => {
    const { popId } = seedPop()
    render(<PopulationOverlay populationId={popId} onClose={() => {}} />)
    expect(screen.getByText('→ lands on us-east-1 · 77 ms away')).toBeInTheDocument()
  })

  it('falls back to the policy wording when no route resolves', () => {
    const doc = createWorld()
    const pop = createPopulation('nowhere', 0, 0); doc.populations[pop.id] = pop
    useWorldStore.setState({ doc, history: [], future: [] })
    render(<PopulationOverlay populationId={pop.id} onClose={() => {}} />)
    expect(screen.getByText('routed by latency')).toBeInTheDocument()
  })

  it('remove dispatches removePopulation and closes', () => {
    const { popId } = seedPop()
    const onClose = vi.fn()
    render(<PopulationOverlay populationId={popId} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'remove' }))
    expect(useWorldStore.getState().doc.populations[popId]).toBeUndefined()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('traffic panel → queues the tab and closes', () => {
    const { popId } = seedPop()
    useUiStore.setState({ pendingPanelTab: null })
    const onClose = vi.fn()
    render(<PopulationOverlay populationId={popId} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'traffic panel →' }))
    expect(useUiStore.getState().pendingPanelTab).toBe('traffic')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
```

### Step 4.5 — failing test: WorldPanel reactive pendingPanelTab

Append to `WorldPanel.test.tsx` (the four existing tests stay byte-identical):

```tsx
  it('switches to a pendingPanelTab set while mounted and clears it', () => {
    useUiStore.setState({ pendingPanelTab: null })
    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)
    expect(screen.queryByLabelText('autoBaseline')).not.toBeInTheDocument()   // starts on Topology
    act(() => useUiStore.getState().setPendingPanelTab('traffic'))
    expect(screen.getByLabelText('autoBaseline')).toBeInTheDocument()         // switched to Traffic
    expect(useUiStore.getState().pendingPanelTab).toBeNull()                  // one-shot consumed
  })
```

(`act` joins the testing-library import.)

### Step 4.6 — `RegionOverlay.tsx`

Create `src/app/world/ui/overlays/RegionOverlay.tsx`:

```tsx
// Region command overlay content (Polish 2 D3). Plain DOM inside the pin's <Html> — reads
// stores directly like the panels do. EVERY control reuses an existing dispatch byte-for-byte
// (Global Constraints: relocated-dispatch contract).
import type { ReactElement } from 'react'
import { useWorldStore } from '../../../store/world.store'
import { useFileStore } from '../../../store/file.store'
import { useNavStore } from '../../../store/nav.store'
import { useSimulationStore } from '../../../store/simulation.store'
import { WORLD_REGIONS } from '../../../../lib/regionConfig'
import type { RegionId } from '../../../../lib/world/types'
import { SceneOverlay, ovlAct, ovlActPrimary, ovlActDanger } from '../SceneOverlay'
import { Segmented, SpecBar, ChipValue } from '../kit'
import { useRollingNumber } from '../motion'

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

// 'us-east-1 · N. Virginia' — metro from the WORLD_REGIONS label's parens (same extraction
// TopologyPanel's regionSectLabel does, without the uppercase treatment).
function regionTitle(catalogId: string): string {
  const label = WORLD_REGIONS.find(w => w.id === catalogId)?.label ?? catalogId
  const metro = label.match(/\(([^)]+)\)/)?.[1]
  return metro ? `${catalogId} · ${metro}` : catalogId
}

export function RegionOverlay({ regionId, onClose }: { regionId: RegionId; onClose: () => void }): ReactElement | null {
  const doc = useWorldStore(s => s.doc)
  const displayBatch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const running = useSimulationStore(s => s.running)
  const isDown = useSimulationStore(s => s.healthOverrides[regionId] ?? false)
  const setOutage = useSimulationStore(s => s.setOutage)
  const goRegion = useNavStore(s => s.goRegion)

  const region = doc.regions[regionId]
  const metrics = displayBatch?.regions[regionId]
  const rolledRps = useRollingNumber(metrics?.rps ?? 0)
  if (!region) return null

  const azs = Object.values(doc.azs).filter(a => a.regionId === regionId)
  const servers = Object.values(doc.servers).filter(sv => azs.some(a => a.id === sv.azId))
  const hourly = servers.reduce((sum, sv) => sum + sv.hourlyUsd, 0)
  const capacity = metrics
    ? mean(servers.map(sv => mean(displayBatch?.servers[sv.id]?.coreUtilization ?? [])))
    : null

  return (
    <SceneOverlay
      title={regionTitle(region.catalogId)}
      health={metrics?.health ?? null}
      subtitle="region"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="kit-press" style={ovlActPrimary}
            title="Keyboard path — the pointer gesture is hold-the-pin"
            onClick={() => goRegion(regionId)}>
            enter ⏎
          </button>
          <button type="button" className="kit-press" style={ovlActDanger}
            disabled={!running}
            title={running ? 'Chaos: simulate a full region outage' : 'start the simulation to break things'}
            onClick={() => setOutage('region', regionId, !isDown)}>
            {isDown ? 'restore' : '⚡ kill'}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', gap: 6, padding: '10px 13px 2px', flexWrap: 'wrap' }}>
        <ChipValue>{azs.length} AZ{azs.length === 1 ? '' : 's'}</ChipValue>
        <ChipValue>{servers.length} server{servers.length === 1 ? '' : 's'}</ChipValue>
        <ChipValue>{metrics ? `~${Math.round(rolledRps)} rps in` : '~— rps in'}</ChipValue>
        <ChipValue>{metrics ? `p50 ${Math.round(metrics.p50Ms)} ms` : 'p50 — ms'}</ChipValue>
        <ChipValue>${hourly.toFixed(2)}/hr</ChipValue>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 13px', fontSize: 11 }}>
        <span style={{ color: 'var(--color-text-muted)', fontSize: 10, width: 64, flexShrink: 0 }}>role</span>
        <Segmented<'active' | 'passive'>
          ariaLabel="region-role"
          value={region.role}
          onChange={v => {
            // Role toggle writes via setState directly — deliberately no history push for a
            // two-value toggle (see plan Task 11 note). History bypass is deliberate;
            // dirty-marking is still required. [TopologyPanel.tsx:88-95, copied verbatim]
            useWorldStore.setState(s => ({ doc: { ...s.doc, regions: { ...s.doc.regions, [region.id]: { ...region, role: v } } } }))
            useFileStore.getState().setDirty(true)
          }}
          options={[{ value: 'active', label: 'active' }, { value: 'passive', label: 'passive' }]}
        />
      </div>
      <div style={{ padding: '0 13px' }}>
        <SpecBar
          label="capacity"
          fraction={capacity ?? 0}
          color="var(--color-accent)"
          value={capacity === null ? '—' : `${Math.round(capacity * 100)}%`}
        />
      </div>
    </SceneOverlay>
  )
}
```

(`ovlAct` stays imported for future rows; drop it from the import list if the linter flags
it — only `ovlActPrimary`/`ovlActDanger` are consumed here. The kill button's `title`
switches on `running` exactly as shown — the skeleton's disabled-hint contract.)

### Step 4.7 — `PopulationOverlay.tsx`

Create `src/app/world/ui/overlays/PopulationOverlay.tsx`:

```tsx
// Population command overlay content (Polish 2 D3). Demand slider commits on release with
// TrafficPanel's exact updatePopulation patch; drag only moves a local draft (the
// DerivedField commitSlider discipline, kit.tsx:251-256, transcribed — the overlay needs
// step=50, which DerivedField does not expose).
import { useRef, useState, type ReactElement } from 'react'
import { useWorldStore } from '../../../store/world.store'
import { useUiStore } from '../../../store/ui.store'
import { useCompiledWorld } from '../../useCompiledWorld'
import type { PopulationId } from '../../../../lib/world/types'
import { SceneOverlay, ovlAct, ovlActPrimary, ovlActDanger } from '../SceneOverlay'
import { populationLanding } from '../derived'

export function PopulationOverlay({ populationId, onClose }: { populationId: PopulationId; onClose: () => void }): ReactElement | null {
  const doc = useWorldStore(s => s.doc)
  const updatePopulation = useWorldStore(s => s.updatePopulation)
  const removePopulation = useWorldStore(s => s.removePopulation)
  const setPendingPanelTab = useUiStore(s => s.setPendingPanelTab)
  const compiled = useCompiledWorld()

  const pop = doc.populations[populationId]
  const [draft, setDraft] = useState(pop?.peakRps ?? 0)
  const interacted = useRef(false)
  if (!pop) return null

  const commit = () => {
    if (!interacted.current) return
    interacted.current = false
    if (draft !== pop.peakRps) updatePopulation(populationId, { peakRps: draft })
  }

  const landing = populationLanding(pop, doc, compiled)
  const hint = landing
    ? `→ lands on ${landing.regionCatalogId} · ${landing.latencyMs} ms away`
    : `routed by ${doc.routing.policy}`

  return (
    <SceneOverlay title={pop.label} subtitle="client population" dotColor="var(--kit-teal)" onClose={onClose}
      footer={
        <>
          <button type="button" className="kit-press" style={ovlActPrimary}
            onClick={() => { setPendingPanelTab('traffic'); onClose() }}>
            traffic panel →
          </button>
          <button type="button" className="kit-press" style={ovlActDanger}
            onClick={() => { removePopulation(populationId); onClose() }}>
            remove
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 13px 2px', fontSize: 11 }}>
        <span style={{ color: 'var(--color-text-muted)', fontSize: 10, width: 64, flexShrink: 0 }}>demand</span>
        <input
          type="range" aria-label="demand" min={50} max={5000} step={50} value={draft}
          style={{ flex: 1, accentColor: 'var(--kit-teal)', height: 3 }}
          onChange={e => { interacted.current = true; setDraft(Number(e.target.value)) }}
          onMouseUp={commit} onTouchEnd={commit} onKeyUp={commit} onBlur={commit}
        />
        <span style={{ width: 70, textAlign: 'right', fontSize: 11.5, fontVariantNumeric: 'tabular-nums' }}>
          {draft} rps
        </span>
      </div>
      <div style={{ fontSize: 10, color: 'var(--kit-teal)', padding: '4px 13px 4px 85px' }}>{hint}</div>
    </SceneOverlay>
  )
}
```

### Step 4.8 — WorldPanel reactive pendingPanelTab

In `WorldPanel.tsx`, the initializer (line 26) stays BYTE-IDENTICAL. The mount-clear effect
(lines 27-33) is REPLACED by a reactive consume that subsumes it:

```tsx
  const [tab, setTab] = useState<PanelTab>(() => useUiStore.getState().pendingPanelTab ?? 'topology')
  const pendingPanelTab = useUiStore(s => s.pendingPanelTab)
  useEffect(() => {
    // One-shot consume, now reactive (Polish 2 D4): the vault path still lands via the
    // mount-time initializer above (this effect's first run just re-selects the same tab and
    // clears the field — the previous mount-only effect's behavior, subsumed); a
    // pendingPanelTab set while the panel is ALREADY mounted (scene overlay "traffic panel →")
    // now switches the tab too. Clear via getState() so the write doesn't re-fire the effect.
    if (pendingPanelTab) {
      setTab(pendingPanelTab)
      useUiStore.getState().setPendingPanelTab(null)
    }
  }, [pendingPanelTab])
```

### Step 4.9 — swap the T3 placeholders

- `RegionPins.tsx`: replace the placeholder `<SceneOverlay …>…</SceneOverlay>` inside the
  `overlayOpen` Html with `<RegionOverlay regionId={regionId} onClose={() => setSceneOverlay(null)} />`;
  drop the now-unused `SceneOverlay` import (keep `useUiStore`).
- `PopulationMarkers.tsx`: replace its placeholder with
  `<PopulationOverlay populationId={id} onClose={() => useUiStore.getState().setSceneOverlay(null)} />`.

### Step 4.10 — verify

```bash
npx vitest run src/app/world/ui/overlays src/app/world/panels/WorldPanel.test.tsx src/app/home/HomeScreen.test.tsx src/app/world/ui/derived.test.ts
# expect: all new overlay tests green; the four pre-existing WorldPanel tests and both
# HomeScreen pendingPanelTab assertions pass UNTOUCHED
npx vitest run && npm run build
```

### Step 4.11 — live smoke (controller runs it)

- [ ] Multi-region example → tap us-east-1: chips show authored counts + `—` metrics at
      rest; `⚡ kill` disabled with the hint title.
- [ ] Simulate → chips fill in, rps chip ROLLS as load changes; capacity bar moves.
- [ ] Kill eu-west-1 from its own overlay → pins/arcs react (TTL story), button flips to
      `restore`; restore works.
- [ ] Role toggle in the overlay → Topology tab's role select reflects it (same doc field).
- [ ] `enter ⏎` → region view; back → overlay is closed.
- [ ] Tap São Paulo → drag slider: hint stays, value updates live, release persists (check
      the Traffic tab shows the new rps); `traffic panel →` switches the dock tab WHILE
      WorldPanel is mounted; `remove` deletes the dot and closes the overlay.
- [ ] Dark + light screenshots of both overlays → `.superpowers/sdd/screenshots/polish2-t4-*`.

**Commit:** `feat(overlays): region + population command overlays, reactive pendingPanelTab`

---

# Polish 2 plan fragment — Tasks 5–7 (guided console · plain words · motion pass + phase gate)

> Fragment scope: Task 5 (world summary strip + traffic hero + population sentence rows +
> `frontlineCapacityRps`), Task 6 (topology health words + firewall rule sentences), Task 7
> (motion application pass, module-boundaries §Q, phase gate). Global Constraints / File
> Structure live in the assembled plan header.
>
> Grounding status: same controller-verified base as the tasks-01-04 fragment (branch
> `polish2-overlays-motion` from `main` @ `8e798c0`, 2026-07-10). Additional files read in
> full for THIS fragment: `TopologyPanel.test.tsx` (the `serverBatch` fixture at 66-81:
> coreUtilization [0.62, 0.62], ram 4096/8192 → healthWord 'comfortable'), `SimControls.tsx`,
> `CostTab.tsx`, `costModelV2.ts` exports, `AzCanvas.tsx` (edge building at 130-139),
> `RegionView.tsx` + `CrossAzColumn.tsx` (no flow line — see decision 12), `InspectorRail.tsx`
> + `InspectorRail.test.tsx` + `inspectorForms.tsx` (FirewallEditor at 86-120).
>
> **Grounded controller decisions (apply as written; continues the numbering from
> tasks-01-04):**
> 9. **World-level latency figure:** the frozen `WorldMetrics` exposes NO p50/p99
>    (`worldEngine/types.ts:87-96`) — the spec's "p99 N ms if the world metrics expose it
>    (else p50)" resolves to the **rps-weighted mean of region `p50Ms`**, labeled `p50 N ms`
>    (the same weighting idiom `metrics.ts` uses to aggregate az → region).
> 10. **$/hr reuse:** the CostTab's helper is `computeWorldCost(doc, batch?.world ?? null)`
>    (`CostTab.tsx:11`), which is MONTHLY. The summary divides by `HOURS_PER_MONTH` (730) —
>    T5 changes `const HOURS_PER_MONTH` → `export const HOURS_PER_MONTH` in `costModelV2.ts`
>    (additive export, zero behavior change) rather than re-deriving the constant.
> 11. **ruleSentence protocol suffix — refinement of the skeleton's "not tcp":** appended
>    only for `udp`. Every fresh server ships the factory rule `allow any any internal`
>    (`factories.ts:65`), which under a literal "not tcp" rule would read "Let internal
>    traffic reach any port any" — the most common rule in the app must not be the ugliest.
>    Canonical copy (scratch-verified): `Let anyone reach https :443` ·
>    `Block internal traffic reaching redis :6379` · `Let internal traffic reach any port` ·
>    `Let 10.0.0.0/8 reach :9200 udp` · `Block anyone reaching ssh :22`.
> 12. **Flow shimmer scope:** AzCanvas edges only. `CrossAzColumn.tsx` renders text lines
>    (labels + latency), not a flow line, and `SplitLines` already animates — the skeleton's
>    "RegionView cross-AZ columns if they render a flow line" resolves to NO region-view
>    change (ledger note, not silent).
> 13. **Per-edge "flow > 0" signal in AzCanvas:** compiled paths carry no rps. The grounded
>    proxy: an edge shimmer-animates when it is unblocked AND its SOURCE server's resident
>    instances sum to > 0 rps in the display batch (the same per-server rps quantity the
>    chassis metrics block already computes, `AzCanvas.tsx:99`).
> 14. **Existing-test mechanical updates (restyle-contract precedent, Polish 1 correction
>    #2):** where THIS spec relocates or re-voices a control, the affected tests' interaction
>    or text-assertion lines are mechanically updated to drive/read the new widget, and every
>    STORE assertion stays byte-identical. The full inventory of touched tests is enumerated
>    per task below — nothing outside that inventory may change.
> 15. **Selected population rows auto-expand:** `TrafficPanel`'s `selectedPopulationId`
>    auto-focus (`TrafficPanel.tsx:78-80`, test at `TrafficPanel.test.tsx:60`) targets a
>    field that now lives inside a collapsed row. Rows render EXPANDED when
>    `pop.id === selectedPopulationId` (and the focus effect re-runs after expansion) so the
>    place-on-globe → tune flow and its test keep working untouched.

---

## Task 5: Guided console — world summary strip, traffic hero, sentence rows `[sonnet]`

**Files:** extend `src/app/world/ui/derived.ts` + `derived.test.ts`; modify
`src/lib/costModelV2.ts` (export keyword only), `src/app/world/panels/WorldPanel.tsx` +
`WorldPanel.test.tsx`, `src/app/world/panels/TrafficPanel.tsx` + `TrafficPanel.test.tsx`.

### Grounding — dispatch inventory that MUST survive byte-for-byte

| Control | Today | Exact dispatch (unchanged) |
|---|---|---|
| Hero rps slider (NEW position for the same field) | `TrafficPanel.tsx:164-165` NumberField | `updateTraffic({ baselineTotalRps: n })` — commit on release only |
| "exact value" NumberField (relocated under expander) | `TrafficPanel.tsx:162-166` | same `updateTraffic({ baselineTotalRps: n })`, same `aria-label="baselineTotalRps"` |
| autoBaseline checkbox | `TrafficPanel.tsx:157-161` | `updateTraffic({ autoBaseline: e.target.checked })` — NOT moved |
| Policy Segmented (relocated into the hero sentence) | `TrafficPanel.tsx:196-206` | identical JSX: `ariaLabel="routing-policy"`, same 4 options, `onChange={v => updateRouting({ policy: v })}` |
| Population tuning fields (re-wrapped, not rebuilt) | `TrafficPanel.tsx:100-123` | `updatePopulation(pop.id, { label/lat/lon/peakRps/diurnal })`, `removePopulation(pop.id)` — same aria-labels |

Other verified facts:

- Entry-blueprint predicate (READ ONLY, reimplemented purely): `worldEngine/index.ts:122-123`
  — `bp.ports.some(p => p.visibility === 'public')`.
- `frontlineCapacityRps` fixture number scratch-verified: web (cpuMs 8, public) on
  vps-medium (4 vcpu) + dedicated-8 (8 vcpu) = 500 + 1000 = **1500**; an internal `api`
  blueprint placement on the same host adds nothing.
- `hostRpsCapacity` already exists (`derived.ts:11-14`).
- WorldPanel summary sits ABOVE the tab bar, OUTSIDE the `<fieldset disabled={running}>` —
  it is a read surface and must not gray out while running.
- Mockup `.worldsum` (transcribed): border `--border` radius 7, padding `11px 13px`,
  `linear-gradient(180deg, #13161e, #10131a)` → `linear-gradient(180deg,
  var(--color-surface-hover), var(--color-node-base))`; line1 12.5px with `--hud` bold
  numbers → `var(--kit-accent)`, weight 600; line2 10.5px muted, flex gap 10.
- Mockup `.bigslider`/`.hint` (transcribed): top row 10px muted "quiet day"/"launch day"
  justify-between; hint 10.5px teal, `.warn` → `--warning`.
- Existing `TrafficPanel.test.tsx` inventory this task touches (decision 14 — mechanical
  updates ONLY, store assertions byte-identical):
  - `add and edit population dispatches store actions with exact patches` — insert one
    `fireEvent.click` on the new population sentence row before driving the per-row fields.
  - `remove population dispatches removePopulation` — same one-line expand-first insert.
  - `lat clamps to [-90,90]` — same insert.
  - `selectedPopulationId row auto-focuses its label input` — UNTOUCHED (decision 15).
  - `traffic toggles dispatch updateTraffic` — insert one click on the `exact value`
    expander before `getByLabelText('baselineTotalRps')`.
  - All routing tests — UNTOUCHED (the Segmented's buttons render in the hero with the same
    text; the Explainer stays in the ROUTING section).

### Step 5.1 — failing tests first: `derived.test.ts` addition

```ts
describe('frontlineCapacityRps', () => {
  it('sums vcpu·1000/cpuMs over entry placements only', () => {
    const doc = createWorld()
    const r = createRegion('us-east-1'); doc.regions[r.id] = r
    const az = createAz(r.id, 'us-east-1a'); doc.azs[az.id] = az
    const s1 = createServer(az.id, getPreset('vps-medium')!); doc.servers[s1.id] = s1      // 4 vcpu
    const s2 = createServer(az.id, getPreset('dedicated-8')!); doc.servers[s2.id] = s2     // 8 vcpu
    const web = createBlueprint('web', 0)
    web.ports = [{ port: 8080, protocol: 'tcp', visibility: 'public' }]
    web.workload.cpuMsPerRequest = 8
    doc.blueprints[web.id] = web
    const api = createBlueprint('api', 1)          // default port is internal → not an entry
    doc.blueprints[api.id] = api
    const p1 = createPlacement(web.id, s1.id); doc.placements[p1.id] = p1
    const p2 = createPlacement(web.id, s2.id); doc.placements[p2.id] = p2
    const p3 = createPlacement(api.id, s1.id); doc.placements[p3.id] = p3
    expect(frontlineCapacityRps(doc, compileWorld(doc))).toBe(1500)   // 4·125 + 8·125, api excluded
  })
  it('is 0 with no entry placements', () => {
    expect(frontlineCapacityRps(createWorld(), compileWorld(createWorld()))).toBe(0)
  })
})
```

### Step 5.2 — `derived.ts` additions

```ts
import type { ServiceBlueprint } from '../../../lib/world/types'
```

```ts
// The engine's client-entry predicate (worldEngine/index.ts:122-123), reimplemented purely —
// never imported from engine internals (Global Constraints).
export function isEntryBlueprint(bp: ServiceBlueprint): boolean {
  return bp.ports.some(p => p.visibility === 'public')
}

// Total rps the frontline (entry-blueprint placements) can absorb at 100% cpu: Σ
// hostRpsCapacity(host vcpu, blueprint cpuMs) over every placement of an entry blueprint.
// The compiled world is accepted for signature symmetry with its consumers (and future
// instance-count refinements) — the sum itself is authored-doc math.
export function frontlineCapacityRps(doc: WorldDoc, _compiled: CompiledWorld): number {
  let sum = 0
  for (const pl of Object.values(doc.placements)) {
    const bp = doc.blueprints[pl.blueprintId]
    const server = doc.servers[pl.serverId]
    if (!bp || !server || !isEntryBlueprint(bp)) continue
    sum += hostRpsCapacity(server.specs.vcpu, bp.workload.cpuMsPerRequest)
  }
  return sum
}
```

`costModelV2.ts`: `const HOURS_PER_MONTH = 730` → `export const HOURS_PER_MONTH = 730`
(line 7 — the only change to the file).

### Step 5.3 — failing test: WorldPanel summary at rest

Append to `WorldPanel.test.tsx`:

```tsx
  it('world summary at rest counts the authored doc', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)
    expect(screen.getByText(/1 region · 1 server · baseline 1,000 rps/)).toBeInTheDocument()
  })
```

(`getPreset` joins the imports. Pluralization: `region`/`regions`, `server`/`servers` by
count; `baseline` uses `doc.traffic.baselineTotalRps.toLocaleString('en-US')`.)

### Step 5.4 — WorldPanel summary strip

In `WorldPanel.tsx`, above the tab-bar `<div>` (inside `<aside>`, OUTSIDE the fieldset),
insert a `WorldSummary` sibling component (same file, below `WorldPanel`):

```tsx
function WorldSummary() {
  const doc = useWorldStore(s => s.doc)
  const displayBatch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const rolledRps = useRollingNumber(displayBatch?.world.totalRps ?? 0)

  const regionCount = Object.keys(doc.regions).length
  const serverCount = Object.keys(doc.servers).length
  const cityCount = Object.keys(doc.populations).length

  const box: CSSProperties = {
    border: '1px solid var(--color-node-border)', borderRadius: 7, padding: '11px 13px',
    background: 'linear-gradient(180deg, var(--color-surface-hover), var(--color-node-base))',
    marginBottom: 8,
  }

  if (!displayBatch) {
    return (
      <div style={box} data-testid="world-summary">
        <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
          {regionCount} region{regionCount === 1 ? '' : 's'} · {serverCount} server{serverCount === 1 ? '' : 's'} · baseline {doc.traffic.baselineTotalRps.toLocaleString('en-US')} rps
        </div>
      </div>
    )
  }

  const regions = Object.values(displayBatch.regions)
  const downCount = regions.filter(r => r.health === 'down').length
  const degradedCount = regions.filter(r => r.health === 'degraded').length
  const healthText = downCount > 0
    ? `● ${downCount} region${downCount === 1 ? '' : 's'} down`
    : degradedCount > 0
      ? `● ${degradedCount} region${degradedCount === 1 ? '' : 's'} degraded`
      : '● all healthy'
  const healthColor = downCount > 0 ? 'var(--color-danger)' : degradedCount > 0 ? 'var(--color-warning)' : 'var(--color-success)'
  // Decision 9: WorldMetrics exposes no latency — rps-weighted mean of region p50Ms.
  const totalRps = regions.reduce((s, r) => s + r.rps, 0)
  const p50 = totalRps > 0 ? regions.reduce((s, r) => s + r.p50Ms * r.rps, 0) / totalRps : 0
  const hourlyUsd = computeWorldCost(doc, displayBatch.world).monthlyUsd / HOURS_PER_MONTH

  return (
    <div style={box} data-testid="world-summary">
      <div style={{ fontSize: 12.5 }}>
        Handling <b style={{ color: 'var(--kit-accent)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{Math.round(rolledRps).toLocaleString('en-US')} rps</b>
        {' '}from {cityCount} {cityCount === 1 ? 'city' : 'cities'} across {regionCount} region{regionCount === 1 ? '' : 's'}
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--color-text-muted)', marginTop: 3, display: 'flex', gap: 10, flexWrap: 'wrap', fontVariantNumeric: 'tabular-nums' }}>
        <span style={{ color: healthColor }}>{healthText}</span>
        <span>${hourlyUsd.toFixed(2)}/hr</span>
        <span>p50 {Math.round(p50)} ms</span>
      </div>
    </div>
  )
}
```

Imports added to WorldPanel.tsx: `useRollingNumber` from `../ui/motion`, `computeWorldCost`
+ `HOURS_PER_MONTH` from `../../../lib/costModelV2`, `type CSSProperties` from react.
Mount: `<WorldSummary />` as the first child of `<aside>`.

### Step 5.5 — failing tests: traffic hero

Append to `TrafficPanel.test.tsx`:

```tsx
describe('TrafficPanel — hero sentence (Polish 2)', () => {
  function seedFrontline() {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    const s1 = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)     // 4 vcpu
    const s2 = useWorldStore.getState().addServer(azId, getPreset('dedicated-8')!)    // 8 vcpu
    const bpId = useWorldStore.getState().addBlueprint('web')
    useWorldStore.getState().updateBlueprint(bpId, {
      ports: [{ port: 8080, protocol: 'tcp', visibility: 'public' }],
      workload: { cpuMsPerRequest: 8, ramBaseMb: 128, ramPerConnMb: 0.5, diskIoPerRequest: 0 },
    })
    useWorldStore.getState().addPlacement(bpId, s1)
    useWorldStore.getState().addPlacement(bpId, s2)
    // frontline capacity = 1500 rps across 2 entry placements
  }

  it('hero slider commits baselineTotalRps on release with the exact patch', () => {
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)
    const slider = screen.getByLabelText('hero-baseline-rps')
    fireEvent.change(slider, { target: { value: '5000' } })
    expect(useWorldStore.getState().doc.traffic.baselineTotalRps).toBe(1000)   // drag = draft only
    fireEvent.mouseUp(slider)
    expect(useWorldStore.getState().doc.traffic.baselineTotalRps).toBe(5000)
  })

  it('hero hint turns warning at 70% of frontline capacity and sheds at 100%', () => {
    seedFrontline()
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)
    const slider = screen.getByLabelText('hero-baseline-rps')

    fireEvent.change(slider, { target: { value: '900' } })    // 60% of 1500
    expect(screen.getByText('≈ 450 rps per frontline replica — comfortable (est. 60% cpu)')).toBeInTheDocument()

    fireEvent.change(slider, { target: { value: '1200' } })   // 80%
    expect(screen.getByText('≈ 600 rps per frontline replica — tight (est. 80% cpu)')).toBeInTheDocument()

    fireEvent.change(slider, { target: { value: '1600' } })   // 107%
    expect(screen.getByText('≈ 800 rps per frontline replica — ✗ will shed load (est. 107% cpu). Add replicas or bigger presets.')).toBeInTheDocument()
  })

  it('hero hint hides when the world has no entry placements', () => {
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)
    expect(screen.queryByText(/frontline replica/)).not.toBeInTheDocument()
  })

  it('population sentence row expands to the existing fields and their dispatch is unchanged', () => {
    const id = useWorldStore.getState().addPopulation('São Paulo', -23.55, -46.63)
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)
    expect(screen.queryByLabelText(`rps-${id}`)).not.toBeInTheDocument()          // collapsed
    fireEvent.click(screen.getByText(/São Paulo/))
    const rpsInput = screen.getByLabelText(`rps-${id}`)                            // same aria-label
    fireEvent.change(rpsInput, { target: { value: '250' } })
    fireEvent.blur(rpsInput)
    expect(useWorldStore.getState().doc.populations[id].peakRps).toBe(250)         // same dispatch
  })
})
```

(`getPreset` joins the imports. Mechanical updates to the five existing tests per the
Grounding inventory — expand-row / open-expander clicks inserted, every store assertion
byte-identical.)

### Step 5.6 — TrafficPanel reshape

Order inside the component: **hero → populations (sentence rows) → routing** (the traffic
hero absorbs the old TrafficSection position at the top — it IS the headline control now).

**Hero block** (new `TrafficHero` function in the same file, replacing `TrafficSection`'s
slider role — `TrafficSection` itself is dissolved into it):

```tsx
function TrafficHero() {
  const doc = useWorldStore(s => s.doc)
  const updateTraffic = useWorldStore(s => s.updateTraffic)
  const updateRouting = useWorldStore(s => s.updateRouting)
  const compiled = useCompiledWorld()
  const [draft, setDraft] = useState(doc.traffic.baselineTotalRps)
  const interacted = useRef(false)
  const [exactOpen, setExactOpen] = useState(false)
  useEffect(() => { setDraft(doc.traffic.baselineTotalRps); interacted.current = false }, [doc.traffic.baselineTotalRps])

  const commit = () => {
    if (!interacted.current) return
    interacted.current = false
    if (draft !== doc.traffic.baselineTotalRps) updateTraffic({ baselineTotalRps: draft })
  }

  const capacity = frontlineCapacityRps(doc, compiled)
  const entryPlacements = Object.values(doc.placements)
    .filter(pl => { const bp = doc.blueprints[pl.blueprintId]; return bp != null && isEntryBlueprint(bp) }).length
  const ratio = capacity > 0 ? draft / capacity : 0
  const cpuPct = Math.round(ratio * 100)
  const perReplica = entryPlacements > 0 ? Math.round(draft / entryPlacements) : 0
  const hint = capacity <= 0 ? null
    : ratio >= 1 ? { text: `≈ ${perReplica} rps per frontline replica — ✗ will shed load (est. ${cpuPct}% cpu). Add replicas or bigger presets.`, tone: 'var(--color-danger)' }
    : ratio >= 0.7 ? { text: `≈ ${perReplica} rps per frontline replica — tight (est. ${cpuPct}% cpu)`, tone: 'var(--color-warning)' }
    : { text: `≈ ${perReplica} rps per frontline replica — comfortable (est. ${cpuPct}% cpu)`, tone: 'var(--kit-teal)' }

  return (
    <div>
      <SectionHeader label="▸ INCOMING TRAFFIC" />
      <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 2.15 }}>
        Send <b style={{ color: 'var(--color-text-primary)', fontVariantNumeric: 'tabular-nums' }}>{draft.toLocaleString('en-US')}</b> requests/sec,
        routed to the
      </div>
      <Segmented<RoutingPolicyKind>
        ariaLabel="routing-policy"
        value={doc.routing.policy}
        onChange={v => updateRouting({ policy: v })}
        options={[
          { value: 'latency', label: '⚡ latency' },
          { value: 'geo', label: '🌍 geo' },
          { value: 'weighted', label: '⚖ weighted' },
          { value: 'priority', label: '1-2-3 priority' },
        ]}
      />
      <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginLeft: 6 }}>region.</span>
      <div style={{ margin: '10px 0 2px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 3 }}>
          <span>quiet day</span><span>launch day</span>
        </div>
        <input
          type="range" aria-label="hero-baseline-rps" min={100} max={20000} step={100} value={draft}
          style={{ width: '100%', accentColor: 'var(--color-accent)' }}
          onChange={e => { interacted.current = true; setDraft(Number(e.target.value)) }}
          onMouseUp={commit} onTouchEnd={commit} onKeyUp={commit} onBlur={commit}
        />
        {hint && <div style={{ fontSize: 10.5, marginTop: 5, color: hint.tone }}>{hint.text}</div>}
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '6px 0 4px' }}>
        <input type="checkbox" aria-label="autoBaseline" checked={doc.traffic.autoBaseline}
          onChange={e => updateTraffic({ autoBaseline: e.target.checked })} />
        <span>auto-baseline traffic</span>
      </label>
      <button type="button" className="kit-press" style={{ ...smallBtn }} aria-expanded={exactOpen}
        onClick={() => setExactOpen(o => !o)}>
        {exactOpen ? '▾' : '▸'} exact value
      </button>
      {exactOpen && (
        <label style={{ display: 'flex', justifyContent: 'space-between', gap: 6, marginTop: 4 }}>
          <span>baselineTotalRps</span>
          <NumberField label="baselineTotalRps" value={doc.traffic.baselineTotalRps} min={0} max={Infinity}
            onCommit={n => updateTraffic({ baselineTotalRps: n })} />
        </label>
      )}
    </div>
  )
}
```

The RANGE and the NumberField are two inputs over the SAME field with the SAME dispatch
shape — `updateTraffic({ baselineTotalRps: … })` — which is the relocated-dispatch contract
holding for both.

**RoutingSection**: DELETE the `Segmented` block (relocated above — the section keeps its
`SectionHeader`, the `Explainer` line, the weighted/priority editors, and the
ttl/health fields, all byte-identical).

**Population sentence rows** (`PopulationsSection`'s map body re-wrapped — the fields and
the add-draft row below stay byte-identical inside the expanded branch):

```tsx
      {populations.map(pop => {
        const landing = populationLanding(pop, doc, compiled)
        const open = expanded === pop.id || pop.id === selectedPopulationId   // decision 15
        return (
          <div key={pop.id} className="kit-row kit-t"
            style={{ borderLeft: '2px solid var(--kit-teal)', background: 'var(--color-node-base)', borderRadius: 5, padding: '8px 11px', marginBottom: 6, cursor: 'pointer' }}
            onClick={() => setExpanded(e => (e === pop.id ? null : pop.id))}>
            <div style={{ fontSize: 11.5 }}>
              <b style={{ color: 'var(--color-text-primary)' }}>{pop.label}</b> sends{' '}
              <em style={{ color: 'var(--kit-teal)', fontStyle: 'normal' }}>{pop.peakRps} rps</em>
              {landing ? <> → lands on {landing.regionCatalogId}</> : <> · routed by {doc.routing.policy}</>}
            </div>
            <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 2 }}>
              {landing ? `${landing.latencyMs} ms away · ` : ''}routed by {doc.routing.policy} · click to tune
            </div>
            {open && (
              <div style={{ borderTop: '1px dashed var(--color-toolbar-border)', marginTop: 8, paddingTop: 8 }}
                onClick={e => e.stopPropagation()}>
                {/* EXISTING field row, byte-identical: label input, lat/lon/rps NumberFields,
                    diurnal select, remove button — moved inside, aria-labels unchanged */}
              </div>
            )}
          </div>
        )
      })}
```

(`expanded` is new local state `useState<string | null>(null)`; `compiled` via
`useCompiledWorld()`; `populationLanding` imported from `../ui/derived`. The EdgeRow wrapper
for population rows is replaced by this sentence row — presentation only; the inner
`<div style={{ display:'flex', … }}>` with all fields moves verbatim into the expanded
branch.)

### Step 5.7 — verify

```bash
npx vitest run src/app/world/ui/derived.test.ts src/app/world/panels/TrafficPanel.test.tsx src/app/world/panels/WorldPanel.test.tsx
# expect: new frontline/hero/summary/sentence tests green; every pre-existing store
# assertion untouched and green (5 tests carry the enumerated one-line mechanical updates)
npx vitest run && npm run build
```

### Step 5.8 — live smoke (controller runs it)

- [ ] Three-tier example → Traffic tab: hero sentence with the policy segmented embedded;
      drag to 12,000 → hint flips to the ✗ shed wording before release; release persists
      (exact value expander shows 12000).
- [ ] Simulate → world summary strip: numbers ROLL, health dot line, $/hr and p50 populate.
      At rest it shows the authored counts line.
- [ ] Population sentence row: collapsed shows "São Paulo sends N rps → lands on …";
      expand → existing tuning fields; commit round-trips; place-on-globe still lands
      focused in the new population's label field (auto-expand).
- [ ] Dark + light screenshots: summary strip + hero + sentence rows →
      `.superpowers/sdd/screenshots/polish2-t5-*`.

**Commit:** `feat(console): world summary strip, traffic hero sentence-slider, population sentence rows`

---

## Task 6: Plain words — topology health words + firewall sentences `[sonnet]`

**Files:** modify `src/app/world/panels/TopologyPanel.tsx` + `TopologyPanel.test.tsx`;
create `src/app/world/server/ruleSentence.ts` + `ruleSentence.test.ts`; modify
`src/app/world/server/InspectorRail.tsx` + `InspectorRail.test.tsx`.
`src/app/world/server/inspectorForms.tsx` is NOT touched — every firewall dispatch lives
there and stays byte-identical by construction.

### Grounding

- `TopologyPanel.tsx:159-160` already computes `cpuMean`/`ramFrac`; the word renders in the
  trailing cluster after `MicroBars`, only when `metrics` exists. Existing `serverBatch`
  fixture (`TopologyPanel.test.tsx:66-81`): coreUtilization [0.62, 0.62], ram 4096/8192 →
  `healthWord(0.62, 0.5) === 'comfortable'`.
- `InspectorRail.tsx:79-92` rule rows: ordinal, `ALLOW`/`DENY` tint, `:{port} {protocol}`,
  `from {source}`, `data-testid="fw-rule-row"`, click → `onSelect({ kind: 'rule', ruleId })`.
  `FirewallEditor` mounts at line 93 (currently ALWAYS); caption line 78 and DENIED footer
  line 94 are untouched (tests reference them).
- Existing InspectorRail tests touched (decision 14 inventory — text assertions only):
  - `firewall stack renders order numbers and flow captions`: `'ALLOW'` →
    `'Let'`; `'DENY'` → `'Block'`; `'from any'` → `'anyone'`; the ordinal, caption, and
    DENIED assertions stay byte-identical. Store assertions: none in this test.
  - `firewall selection lists rules in order and drills into a rule`: UNTOUCHED (click →
    `onSelect({kind:'rule', ruleId:'r2'})` still fires — see behavior below).
  - Every `inspector editing forms` test: UNTOUCHED (inspectorForms.tsx unchanged).
- New behavior: clicking a sentence row toggles — not-selected → `onSelect({ kind: 'rule',
  ruleId })`; already-selected → `onSelect({ kind: 'firewall' })` (collapse back). The
  `FirewallEditor` block renders ONLY when `selection.kind === 'rule'` — "clicking a row
  toggles its edit inputs" (spec D7) with the editor's dispatches untouched.
- `ruleSentence` copy: decision 11's canonical five, scratch-verified.

### Step 6.1 — failing tests first: `ruleSentence.test.ts`

Create `src/app/world/server/ruleSentence.test.ts` (node env):

```ts
import { describe, it, expect } from 'vitest'
import { ruleSentence } from './ruleSentence'

describe('ruleSentence', () => {
  it('allow 443 tcp any → "Let anyone reach https :443"', () => {
    expect(ruleSentence({ id: 'r', action: 'allow', port: 443, protocol: 'tcp', source: 'any' }))
      .toBe('Let anyone reach https :443')
  })
  it('deny 6379 tcp internal → "Block internal traffic reaching redis :6379"', () => {
    expect(ruleSentence({ id: 'r', action: 'deny', port: 6379, protocol: 'tcp', source: 'internal' }))
      .toBe('Block internal traffic reaching redis :6379')
  })
  it('factory default allow any any internal reads clean (no protocol noise)', () => {
    expect(ruleSentence({ id: 'r', action: 'allow', port: 'any', protocol: 'any', source: 'internal' }))
      .toBe('Let internal traffic reach any port')
  })
  it('udp is the only spelled protocol; unknown ports stay bare; CIDRs verbatim', () => {
    expect(ruleSentence({ id: 'r', action: 'allow', port: 9200, protocol: 'udp', source: '10.0.0.0/8' }))
      .toBe('Let 10.0.0.0/8 reach :9200 udp')
    expect(ruleSentence({ id: 'r', action: 'deny', port: 22, protocol: 'tcp', source: 'any' }))
      .toBe('Block anyone reaching ssh :22')
  })
})
```

### Step 6.2 — `ruleSentence.ts`

```ts
// Plain-words rendering of a firewall rule (Polish 2 D7). Pure — the InspectorRail renders
// the pieces with tint/bold spans; this string form is the single copy source both use.
import type { FirewallRule } from '../../../lib/world/types'

export const PORT_SERVICE_WORDS: Record<number, string> = {
  443: 'https', 80: 'http', 5432: 'postgres', 6379: 'redis', 22: 'ssh',
}

export function ruleSourceWords(source: FirewallRule['source']): string {
  return source === 'any' ? 'anyone' : source === 'internal' ? 'internal traffic' : source
}

export function rulePortPhrase(rule: FirewallRule): string {
  if (rule.port === 'any') return 'any port'
  const svc = PORT_SERVICE_WORDS[rule.port]
  return `${svc ? `${svc} ` : ''}:${rule.port}`
}

// Protocol appended only for udp — tcp is the default voice, and 'any' on the factory
// default rule (`allow any any internal`) would read "…any port any" (plan decision 11).
export function ruleSentence(rule: FirewallRule): string {
  const proto = rule.protocol === 'udp' ? ' udp' : ''
  return rule.action === 'allow'
    ? `Let ${ruleSourceWords(rule.source)} reach ${rulePortPhrase(rule)}${proto}`
    : `Block ${ruleSourceWords(rule.source)} reaching ${rulePortPhrase(rule)}${proto}`
}
```

### Step 6.3 — InspectorRail re-voicing

Rule rows (`InspectorRail.tsx:79-92`) become sentence rows — testid, key, ordinal span, and
row styling preserved; click toggles per the Grounding note:

```tsx
        {rules.map((r, i) => {
          const selected = selection.kind === 'rule' && selection.ruleId === r.id
          return (
            <div key={r.id} data-testid="fw-rule-row"
              onClick={() => onSelect(selected ? { kind: 'firewall' } : { kind: 'rule', ruleId: r.id })}
              style={{
                display: 'flex', gap: 6, fontSize: 10.5, padding: '4px 6px', borderRadius: 4,
                cursor: 'pointer', alignItems: 'baseline',
                background: selected ? 'color-mix(in srgb, var(--color-text-primary) 3%, transparent)' : undefined,
              }}>
              <span style={{ color: 'var(--color-text-muted)', width: 12, fontVariantNumeric: 'tabular-nums' }}>{i + 1}</span>
              <span>
                <span style={{ color: r.action === 'allow' ? 'var(--color-success)' : 'var(--color-danger)' }}>
                  {r.action === 'allow' ? 'Let' : 'Block'}
                </span>{' '}
                <b style={{ color: '#DBEAFE' }}>{ruleSourceWords(r.source)}</b>{' '}
                {r.action === 'allow' ? 'reach' : 'reaching'}{' '}
                <b style={{ color: '#DBEAFE' }}>{rulePortPhrase(r)}</b>
                {r.protocol === 'udp' ? ' udp' : ''}
              </span>
            </div>
          )
        })}
        {selection.kind === 'rule' && <FirewallEditor key={serverId} serverId={serverId} />}
```

(The `#DBEAFE` bold tint is the rail's existing always-dark emphasis color,
`InspectorRail.tsx:52` — this rail keeps a hardcoded dark background by design, see its
header comment.) Imports: `ruleSentence` pieces from `./ruleSentence`.

### Step 6.4 — TopologyPanel health word

In `ServerRow`'s trailing cluster, insert after `{metrics && <MicroBars …/>}`:

```tsx
            {metrics && (() => {
              const word = healthWord(cpuMean, ramFrac)
              const color = word === 'comfortable' ? 'var(--color-success)'
                : word === 'tight' ? 'var(--color-warning)' : 'var(--color-danger)'
              return <span style={{ fontSize: 10, color }}>{word}</span>
            })()}
```

Import `healthWord` from `../ui/derived`.

### Step 6.5 — failing tests: extensions

`TopologyPanel.test.tsx` — append to the instrument-restyle describe:

```tsx
  it('healthWord chip appears only with metrics and uses the status color', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    useSimulationStore.setState({ latestBatch: serverBatch(serverId, regionId) })
    render(<TopologyPanel />)
    const word = screen.getByText('comfortable')          // healthWord(0.62, 0.5)
    expect(word).toHaveStyle({ color: 'var(--color-success)' })
    useSimulationStore.setState({ latestBatch: null })
  })

  it('no health word at rest', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(<TopologyPanel />)
    expect(screen.queryByText(/comfortable|tight|straining/)).not.toBeInTheDocument()
  })
```

`InspectorRail.test.tsx` — mechanical text updates to `firewall stack renders order numbers
and flow captions` per the Grounding inventory, plus one NEW test:

```tsx
  it('firewall reorder and remove dispatches are unchanged after the re-voicing', () => {
    const spy = vi.spyOn(useWorldStore.getState(), 'updateServer')
    const { serverId } = seed((d, sid) => {
      d.servers[sid].firewall = [
        { id: 'r1', action: 'allow', port: 443, protocol: 'tcp', source: 'any' },
        { id: 'r2', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' },
      ]
    })
    render(<InspectorRail serverId={serverId} selection={{ kind: 'rule', ruleId: 'r1' }} onSelect={() => {}} />)
    expect(screen.getByText('Let')).toBeInTheDocument()                       // sentence read view
    expect(screen.getByText('postgres :5432')).toBeInTheDocument()            // service word
    fireEvent.click(screen.getAllByLabelText('move rule down')[0])            // FirewallEditor visible when a rule is selected
    expect(spy).toHaveBeenCalledWith(serverId, { firewall: [
      expect.objectContaining({ id: 'r2' }), expect.objectContaining({ id: 'r1' }),
    ] })
  })
```

Also mechanically update `firewall selection lists rules in order and drills into a rule` —
NO change needed to its assertions (click on rows[1] from `{kind:'firewall'}` still calls
`onSelect({kind:'rule', ruleId:'r2'})`); verify it passes as-is.

### Step 6.6 — verify

```bash
npx vitest run src/app/world/server src/app/world/panels/TopologyPanel.test.tsx
# expect: 4 ruleSentence tests + 2 topology tests + 1 rail test new-green; every existing
# rail/forms test green (one test carries the enumerated text-assertion updates)
npx vitest run && npm run build
```

### Step 6.7 — live smoke (controller runs it)

- [ ] Teaching world → cache server → server view → firewall: the deny :6379 rule reads
      "Block … redis :6379" as a sentence; the factory rule reads "Let internal traffic
      reach any port".
- [ ] Click the deny sentence → edit inputs appear beneath the stack; fix the rule (deny →
      allow) → Analysis count drops live; click the row again → inputs collapse.
- [ ] Reorder ↑/↓ and ✕ still work from the editor; caption + DENIED footer unchanged.
- [ ] Topology tab under simulation: each server row shows its word in the right color;
      stress one server (kill its sibling) → word flips tight/straining.
- [ ] Dark + light screenshots: firewall sentences + topology words →
      `.superpowers/sdd/screenshots/polish2-t6-*`.

**Commit:** `feat(words): topology health words + firewall rule sentences`

---

## Task 7: Motion application pass + phase gate `[sonnet]`

**Files:** modify `src/app/world/panels/WorldPanel.tsx` (+ test — tab ink), className sweep
across `src/app/world/panels/TopologyPanel.tsx` / `TrafficPanel.tsx` / `BlueprintPanel.tsx` /
`PlacementPanel.tsx`, `src/app/world/WorldShell.tsx` (hdrBtn), `src/app/world/SimControls.tsx`,
`src/app/world/ui/kit.tsx` (className additions inside `Segmented`/`PresetCardGrid` buttons
— presentation-only, zero API change), `src/app/world/AzCanvas.tsx` (flow shimmer);
`docs/module-boundaries.md` §Q; `.superpowers/sdd/progress.md` `## POLISH 2`.

### Grounding

- Tab bar today: `WorldPanel.tsx:50-67` — per-button `borderBottom: tab === t.id ? '2px
  solid var(--color-accent)' : '2px solid transparent'`. The ink replaces exactly that
  border; the click dispatch `onClick={() => setTab(t.id)}` and the Analysis ChipValue stay.
- Mockup ink behavior (`config-overlays-v1.html:436-442`, exercised live): ink sits under
  the ACTIVE tab; hovering another tab slides the ink there as a preview;
  `mouseleave` on the bar returns it to the active tab; clicking commits.
- `.kit-ink` CSS shipped in T1 (`position: absolute; bottom: 0; height: 2px; …transition
  left/width`); the bar container needs `position: relative`.
- Flow shimmer: decision 13 (source-server rps proxy); edges built at `AzCanvas.tsx:130-139`;
  per-server rps already computed for chassis at line 99 — lift it into a `Map` before the
  edge map. React Flow's `animated: true` renders the dashed-flow treatment; reduced-motion
  no-op shipped in T1's stylesheet block.
- Ripples: `.kit-ripple` wraps a dot; color rides `currentColor`. Consumers gated on
  `running`:
  - `EdgeRow` (kit.tsx): additive optional prop `ripple?: boolean` — when true AND status is
    non-null, the dot span gains `className="kit-ripple"` and `style.color = STATUS_COLOR[status]`.
    Additive prop = allowed (the T1 no-API-change constraint bound T1 only; Global
    Constraints bind dispatches and worldEngine, not kit props).
  - `TopologyPanel` ServerRow passes `ripple={running}` (add `const running =
    useSimulationStore(s => s.running)` — a read, not a dispatch).
  - `WorldSummary`'s health `●` (T5) — wrap in a `.kit-ripple` span while a batch is live.
  - `SceneOverlay` gains additive `ripple?: boolean`; `RegionOverlay` passes
    `ripple={running}`.
- Button-press sweep — `className="kit-press"` added to every `<button>` currently styled
  with `smallBtn`/`dangerBtn` in the four panels, WorldShell's `hdrBtn` buttons, SimControls'
  Simulate/Stop button, and the `Segmented`/`PresetCardGrid` buttons inside kit.tsx.
  EXCLUDE: TopologyPanel's `unstyledButton` ChipValue wrapper (no border to glow) and any
  button already carrying `kit-press` from T3/T4.

### Step 7.1 — tab ink

In `WorldPanel.tsx`, the tab bar becomes:

```tsx
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const barRef = useRef<HTMLDivElement>(null)
  const [ink, setInk] = useState<{ left: number; width: number; top: number }>({ left: 0, width: 0, top: 0 })

  const placeInk = (id: PanelTab) => {
    const el = tabRefs.current[id]
    // top is tracked per-tab because the bar WRAPS (flexWrap, 7 tabs in a 360px dock) — a
    // bottom-anchored ink would underline the container's last row for every tab. With an
    // explicit height + top, the .kit-ink CSS `bottom: 0` is overconstrained-ignored.
    if (el) setInk({ left: el.offsetLeft, width: el.offsetWidth, top: el.offsetTop + el.offsetHeight - 2 })
  }
  useLayoutEffect(() => { placeInk(tab) }, [tab])
```

```tsx
      <div ref={barRef} onMouseLeave={() => placeInk(tab)}
        style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap', position: 'relative' }}>
        {tabs.map(t => (
          <button key={t.id}
            ref={el => { tabRefs.current[t.id] = el }}
            type="button"
            onMouseEnter={() => placeInk(t.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '5px 10px', background: 'transparent',
              border: '1px solid transparent',
              color: tab === t.id ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
              cursor: 'pointer', font: '11px var(--font-mono)',
            }}
            onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === 'analysis' && <ChipValue>{analysisCount}</ChipValue>}
          </button>
        ))}
        <span className="kit-ink" aria-hidden style={{ left: ink.left, width: ink.width, top: ink.top }} />
      </div>
```

(The per-button `borderBottom` line is DELETED — the ink is the underline now. `useRef`/
`useLayoutEffect` join the react import. Every tab-click dispatch and the ChipValue stay
byte-identical; all five WorldPanel tests plus T4/T5's additions must stay green — jsdom
gives offsetLeft/Width = 0, which renders a 0-width ink and breaks nothing.)

### Step 7.2 — ripples + press sweep + shimmer

Per the Grounding list:

1. `kit.tsx` `EdgeRow`: additive `ripple?: boolean` prop; dot span gains
   `className={ripple && status ? 'kit-ripple' : undefined}` and, when rippling,
   `color: STATUS_COLOR[status]` in its style (background/boxShadow lines unchanged).
2. `kit.tsx` `Segmented` + `PresetCardGrid` buttons: `className="kit-press"` (PresetCardGrid
   keeps its existing `"kit-pcard kit-t"` — append: `"kit-pcard kit-t kit-press"`).
3. `TopologyPanel` ServerRow: `ripple={running}` on its EdgeRow; `className="kit-press"` on
   every smallBtn/dangerBtn button in the file.
4. `TrafficPanel` / `BlueprintPanel` / `PlacementPanel`: `className="kit-press"` on every
   smallBtn/dangerBtn button.
5. `WorldShell.tsx` hdrBtn buttons (⚙/New/Open/Save/Save As/dismiss) + `SimControls.tsx`
   Simulate/Stop: `className="kit-press"`.
6. `WorldSummary` (T5): health `●` wrapped in `<span className={batch ? 'kit-ripple' : undefined} …>`
   with the dot's color as `color` — display batch presence is the running-gate at this
   surface (scrub replays ripple too, matching every other live read).
7. `SceneOverlay`: additive `ripple?: boolean`; header dot gains the class when set;
   `RegionOverlay` passes `ripple={running}` (running selector already in scope).
8. `AzCanvas.tsx`: before the edge map, build
   `const rpsByServer = new Map(servers.map(s => [s.id, Object.values(compiled.instances).filter(i => i.serverId === s.id).reduce((sum, i) => sum + (batch?.instances[i.id]?.rps ?? 0), 0)]))`
   then in the edge object add:
   `animated: e.blocked === 0 && (rpsByServer.get(e.source) ?? 0) > 0,`
   (Blocked edges keep their static red dash — never shimmer a refused path.)

### Step 7.3 — failing test guard (tab dispatch survives the ink)

Append to `WorldPanel.test.tsx`:

```tsx
  it('tab ink slides — clicking a tab still switches content with the ink element present', () => {
    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)
    fireEvent.click(screen.getByText('Traffic'))
    expect(screen.getByLabelText('autoBaseline')).toBeInTheDocument()
    expect(document.querySelector('.kit-ink')).not.toBeNull()
  })
```

### Step 7.4 — docs

- `docs/module-boundaries.md` — append **§Q — Polish 2: command overlays, guided console,
  motion**, listing: the ui kit additions (`motion.ts`, `HoldToEnter.tsx`, `SceneOverlay.tsx`,
  `overlays/RegionOverlay.tsx`, `overlays/PopulationOverlay.tsx`, `ruleSentence.ts`), the ONE
  additive ui.store field (`sceneOverlay` + setter), the reactive `pendingPanelTab` note
  (initializer + reactive one-shot consume), the relocated-dispatch contract statement
  ("every relocated/added control reuses an existing store dispatch byte-for-byte; new store
  surface = sceneOverlay only"), the `HOURS_PER_MONTH`/`isEntryBlueprint`/
  `frontlineCapacityRps`/`populationLanding` derived additions, the SpecBar carry-forward
  retirement (consumed by RegionOverlay), and the decision-12 region-view shimmer no-op.
- `.superpowers/sdd/progress.md` — `## POLISH 2` phase summary + open items + drift state
  (expected: none) — written at the phase gate, after the final review.

### Step 7.5 — verify

```bash
npx vitest run
npm run build
```

### Step 7.6 — PHASE GATE (live, fresh session, zero console errors — controller runs it)

The spec's full story, in order, screenshotting every new surface dark AND light into
`.superpowers/sdd/screenshots/polish2-*`:

- [ ] Open the multi-region failover example.
- [ ] Tap us-east-1 → overlay chips/role/capacity · hold the pin → ring charges → region
      view opens → back.
- [ ] Tap São Paulo → drag rps slider (hint updates) → release → Traffic tab shows the value.
- [ ] Traffic hero → 12,000 → warning wording.
- [ ] Simulate → world summary rolls · health dots ripple · kill eu-west-1 from its overlay
      → arcs re-route (TTL story) → restore.
- [ ] Tab ink slides across all seven tabs (hover previews, leave returns).
- [ ] AZ canvas: unblocked edges shimmer while flow runs; blocked edge stays static red.
- [ ] Firewall sentences + topology words (T6 story still green through the motion pass).
- [ ] Reduced-motion pass: hold ring still sweeps; ripple/roll/ink/shimmer static.
- [ ] Light-mode pass over overlays, summary strip, hero, sentence rows, firewall sentences.
- [ ] Zero app console errors across the whole story.

**Commit:** `feat(motion): app-wide motion pass — tab ink, press states, health ripples, flow shimmer`
(docs commit alongside: module-boundaries §Q + progress.md at the gate.)
