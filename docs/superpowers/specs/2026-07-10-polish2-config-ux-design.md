# Polish 2: Command Overlays + Guided Console + Motion — Design

**Date:** 2026-07-10 · **Status:** Approved direction — the user chose the HYBRID of the
config-UX mockup round and replaced button-drill with the **hold-to-enter ring**. **Binding
visual reference:** `docs/superpowers/specs/mockups/config-overlays-v1.html` (Direction A's
in-scene overlays carrying Direction B's sentence widgets, B's dock summary + traffic hero,
the shared motion inventory, and the live hold-ring demo on the green pin). **Companions:**
FROZEN `2026-07-08-world-engine-contracts.md` (zero engine changes this phase), the Polish 1
kit (`src/app/world/ui/`) which this phase extends, the umbrella spec (unchanged).

## Goal

Polish 1 gave the panels a skin; Polish 2 changes where configuration *lives* and how the app
*feels*. Three strands, one phase: (1) **command overlays** — tap a region pin or population
dot on the globe and an anchored card opens with that entity's summary and its few controls
that matter; press-and-hold charges a ring that drills into the region; (2) **guided
console** — the dock leads with a plain-English world summary, traffic gets a hero
sentence-slider you cannot miss, and the scariest editors (firewall, server rows) re-voice
their existing data as sentences; (3) **motion** — one hover grammar and six motion moments
applied app-wide. Driven verbatim by user feedback: "a lot of the config isn't intuitive…
just a bunch of numbers thrown at you", "can't even tell how to customize my incoming traffic
levels", "imagine being able to click on a region and then an overlay pops up", "almost no
hover effects or cool here and there animations".

## Design decisions

1. **Nav semantics (binding, globe level).** Tap a region pin = its overlay opens (today tap
   drills immediately — this changes). **Press-and-hold a pin ≈700 ms = an SVG ring charges
   around it; completion navigates into the region** (`nav.store.goRegion`); releasing or
   leaving before completion cancels with no navigation and no overlay. A completed hold
   suppresses the synthetic click so the overlay does not flash open. Esc or click-away
   closes an open overlay. Keyboard/a11y path: the overlay's `enter ⏎` button navigates, and
   the existing visually-hidden `RegionA11yList` keeps navigating directly — both unchanged
   gestures for non-pointer users. Population dots: tap opens their overlay (they had no
   click before — purely additive). Deeper levels (region → AZ → server) keep their existing
   navigation this phase; the ring component is built reusable so a follow-up can mount it
   there.

2. **Overlay state is one additive ui.store field.** `sceneOverlay: { kind: 'region' |
   'population'; id: string } | null` + `setSceneOverlay(o)` on `useUiStore` (same additive
   stance as `pendingPanelTab`). Pins/dots write it; `GlobeView` renders the open overlay;
   nothing else reads it. Idle rotation pauses while an overlay is open (the `autoRotate`
   prop shipped 2026-07-10 in `GlobeScene` — pass `autoRotate={!rotationLocked &&
   sceneOverlay == null}`), so the anchored card doesn't slide.

3. **Overlays are drei `<Html>` cards anchored to the entity group** (the same mechanism the
   pin labels use — projection tracking is free), interactive (no pointer-events:none),
   token-styled, spring-in animation (fade-only under reduced motion), max-width ~300px.
   **Region overlay content:** header (catalogId + metro + health dot/word from
   `RegionMetrics.health`), chips (`n AZs`, `n servers`, `~N rps in` from
   `RegionMetrics.rps`, `p50 N ms`, `$N/hr` summed server `hourlyUsd`), role
   active/passive `Segmented` (byte-identical dispatch to TopologyPanel's role select — the
   deliberate no-history setState + setDirty pattern), a capacity bar (mean
   `coreUtilization` across the region's servers), `⚡ kill` / `restore` chaos button
   (`simulation.store.setOutage('region', id, down)`, disabled with a title hint while not
   running), `enter ⏎`, and `esc`. At-rest (no batch): chips show authored counts, metrics
   chips show `—`. **Population overlay content:** header (label + teal dot), a demand
   slider (50–5000 rps, commit-on-release → `updatePopulation(id, { peakRps })` — the
   exact dispatch TrafficPanel's NumberField commits), a live derived hint line ("→ lands on
   <region> · N ms" from the compiled routing table, at-rest fallback "routed by <policy>"),
   `remove` (`removePopulation(id)`, closes the overlay), and `traffic panel →`
   (`setPendingPanelTab('traffic')`).

4. **`pendingPanelTab` becomes reactive.** Today WorldPanel consumes it only in its useState
   initializer (mount-time), which the vault needs; overlay→"traffic panel →" fires while
   WorldPanel is already mounted. WorldPanel additionally subscribes to the field and
   switches tab + clears it whenever it becomes non-null. One-shot semantics preserved;
   existing vault tests must keep passing untouched.

5. **Hold-to-enter is a reusable primitive.** `src/app/world/ui/HoldToEnter.tsx` (kit
   sibling): pure progress logic (`holdProgress(nowMs, startMs, durationMs) → 0..1`,
   exported and unit-tested) + a screen-space SVG ring (stroke-dashoffset driven per-frame
   via ref, never setState) with the kit's HUD accent. Duration 700 ms. The ring is
   *functional* progress feedback, so it stays under `prefers-reduced-motion` (glow/pulse
   trimmed, progress kept). RegionPin mounts it; the mesh's `onPointerDown/Up/Out` drive it.

6. **Guided console (dock).** (a) **World summary strip** — a `worldsum` card above the tab
   bar in WorldPanel (mockup verbatim): "Handling **N rps** from *n* cities across *n*
   regions" + health word, `$N/hr`, `p99 N ms`; numbers roll (D8) while the sim runs;
   at-rest it summarizes the authored doc ("3 regions · 8 servers · autobaseline 1,000
   rps"). (b) **Traffic hero** — TrafficPanel leads with the sentence-slider: "Send
   **[N]** requests/sec, routed to the **[policy ▾]** region" where N is a 100–20,000 slider
   editing `updateTraffic({ baselineTotalRps })` commit-on-release and the policy slot is
   the existing routing `Segmented`; beneath it a live capacity hint (new pure helper
   `frontlineCapacityRps(doc, compiled)` in `derived.ts` — sum of `hostRpsCapacity` over
   servers hosting entry-blueprint placements) phrased comfortable/tight/will-shed with
   warning tone ≥70%. (c) **Population sentence rows** — "**São Paulo** sends *400 rps* →
   lands on us-east-1" collapsed; expanding reveals the existing tuning fields (identical
   dispatches). Existing TrafficPanel dispatch tests extend, never weaken.

7. **Plain-words pass on the scariest surfaces.** (a) TopologyPanel server rows gain a
   health word (`healthWord(cpuMean, ramFrac) → 'comfortable' | 'tight' | 'straining'`,
   pure, in `derived.ts`; thresholds 0.70/0.90 on the max of the two fractions) rendered at
   the row's right in the status color; numbers stay where they are (already one expander
   down). (b) The server-view firewall stack (`InspectorRail.tsx`) re-voices each rule row
   as a sentence — "*1* **Let** anyone reach **https :443**" / "**Block** … " with
   port-service words (443 https, 80 http, 5432 postgres, 6379 redis, 22 ssh, else the bare
   number) — same rule data, same aria-labeled reorder/remove buttons, same dispatches, the
   flow caption and DENIED footer unchanged. Editing remains via the existing inputs
   (sentence spans are the read view; clicking a row toggles its edit inputs).

8. **Motion inventory (app-wide, one grammar).** Six patterns from the mockup, all in kit
   CSS/hooks so consumers stay one-line: row lift (EdgeRow hover: -1px translate + shadow +
   border — extends the existing `.kit-row`), button press (`:active` scale 0.96 on kit/act
   buttons), tab ink slide (WorldPanel tab underline becomes one sliding element), health
   ripple (status dots emit a slow ripple **only while `running`**), number roll
   (`useRollingNumber(target)` hook, ~150 ms ease, used by the world summary + overlay rps
   chips), flow shimmer (existing animated-dash treatment on AZ-canvas edges/region columns
   where flow > 0 — reuse React Flow's `animated` edge flag where applicable). Every pattern
   no-ops under `prefers-reduced-motion` except the hold ring (D5).

9. **No engine, contract, or schema changes.** `worldEngine/` untouched;
   `simulation.store` untouched (setOutage exists); `world.store` gains no new actions —
   every overlay/console control reuses an existing dispatch byte-for-byte (the Polish 1
   restyle contract, now covering relocation too: **same dispatches from new places**).
   `ui.store` gains only `sceneOverlay`/`setSceneOverlay`. Token-only styling; light mode
   must pass on every new surface.

## Testing & verification

Unit: `holdProgress` (0 at start, 1 at duration, clamped), `healthWord` thresholds,
`frontlineCapacityRps` exact numbers on a fixture world, `useRollingNumber` (fake timers,
reduced-motion branch snaps). Component (jsdom): ui.store sceneOverlay set/clear;
WorldPanel reactive pendingPanelTab (set while mounted → tab switches, field clears, vault
mount-time path still passes); world summary strip (authored at-rest numbers); Traffic hero
slider commit dispatch + hint tone; population sentence row expand + identical dispatch;
firewall sentence rendering (port words, order preserved) + reorder/remove dispatches
unchanged; overlay content components (rendered as plain DOM in jsdom with store fixtures —
chips, kill disabled while stopped, remove closes). R3F pieces (pin gesture, Html anchoring,
rotation pause) are live-smoke gated, not jsdom. Live phase-gate story: open multi-region
example → tap us-east-1 pin → overlay chips/role/capacity → hold the pin → ring charges →
region view opens → back → tap São Paulo → drag rps slider, hint updates, commit →
Traffic tab shows the new value → Simulate → world summary numbers roll, health dots
ripple, kill eu-west-1 from its overlay → arcs re-route (TTL story) → restore →
tab ink slides across all seven tabs → reduced-motion pass (ring still works, ripple/roll
static) → light-mode pass over every new surface. Zero console errors.

## Out of scope

Hold-to-enter on deeper levels (component is reusable; not mounted beyond the globe this
phase), server overlays in the AZ canvas, overlay editing beyond the named controls, engine
work, sound, onboarding tours, the umbrella §9 parked list.
