# Polish Phase: Hybrid Panel System + Examples Vault — Design

**Date:** 2026-07-10 · **Status:** Approved direction — the user chose the HYBRID option
of the panel-redesign mockup round. **Binding visual reference:**
`docs/superpowers/specs/mockups/panels-hybrid-v1.html` (Direction A's skin + Direction
B's widgets + the vault card strip; the "Today, for reference" block is the anti-goal).
**Companions:** FROZEN `2026-07-08-world-engine-contracts.md` (zero engine/contract
changes this phase), the umbrella spec (unchanged), post-rebuild backlog in
`.superpowers/sdd/progress.md`.

## Goal

The scenes got the design treatment across Phases 3–5; the authoring surfaces never did.
This phase gives every panel/config surface the approved hybrid identity — **Instrument
Rail skin** (luminous section rules, edge-lit rows, chip values, live micro-bars)
carrying **Console Card widgets** (sliders with derived-consequence hints, host preset
cards, segmented pickers, explainer microcopy) — and ships the four-example **vault** on
the home screen. Plus one carried bug: the replay scrubber offering a discarded world's
frames after New.

## Design decisions

1. **A shared UI kit, applied — not per-panel re-invention.** New
   `src/app/world/ui/` kit: `SectionHeader` (caps label + luminous gradient rule, teal
   glow default with per-section accent override — the mockup's `.a-sect`),
   `EdgeRow` (edge-lit hoverable row: status dot, content, trailing meta/chips — the
   mockup's `.a-row`/`.a-server`), `ChipValue`, `SpecBar` (label / track / tabular value
   — `.b-specbar`), `MicroBars` (3-bar cpu/ram/io glyph), `DerivedField` (numeric input
   OR slider + live derived hint line — `.b-field`+`.b-derive`), `Segmented` (the
   `.b-seg` control), `PresetCardGrid` (`.b-pcard`), `Explainer` (muted microcopy).
   All token-styled (`var(--color-*)`) so light mode works for free; the HUD glow hue
   (`#7CFFE9` on `#2DD4BF44` shadows) becomes local kit constants (scene-accent class,
   same stance as the globe/board hexes). Density: 11px base inside panels (mockup),
   `font-variant-numeric: tabular-nums` wherever digits column up.
2. **Derived hints are pure and tested.** `src/app/world/ui/derived.ts`: e.g.
   `rpsPerCore(cpuMsPerRequest)`, `hostRpsCapacity(vcpu, cpuMs)`,
   `ramAtConnections(base, perConn, conns = 2000)`, `residentRamDemand(server, doc,
   compiled)` vs `specs.ramMb`, `ttlVsDetection(routing)` (reuses the analysis rule's
   inequality, phrased as a hint before it becomes a finding). Panels never inline
   arithmetic — they call these.
3. **Surface-by-surface application (all reachable panels, one identity):**
   TopologyPanel — regions become glowing section headers with health dots, servers
   become edge-lit rows with live utilization bar + MicroBars + $/hr (metrics from
   `scrubBatch ?? latestBatch`, at-rest state without); AZ/managed rows same family.
   BlueprintPanel — signature-color tab cards; the workload editor becomes DerivedFields
   (cpu-per-request slider 1–60ms with rps/core hint; ram base/per-conn with
   at-2k-conns hint; disk io with light/moderate/heavy word). PlacementPanel — the
   `addServer` preset select becomes a PresetCardGrid (specs + tenancy badge + $/hr);
   runtime editing keeps its fields but in kit clothing. TrafficPanel — routing policy
   becomes a Segmented control with the mockup's one-line explainer per policy; TTL
   field gains the failover-lag hint. SettingsModal, AnalysisTab, server-view
   InspectorRail — already closest to the language; align spacing/headers/chips to the
   kit (AnalysisTab's severity chips and the rail's HUD header are the kit's ancestors —
   adopt, don't redesign). WorldPanel tab bar — active tab gets the edge-lit treatment.
   The firewall editor (server view) restyles to the mockup's amber-framed rule stack
   with the explicit "evaluated top-down · first match wins" flow line and the
   "everything else: DENIED" footer — reorder stays the existing aria-labeled buttons.
4. **Examples vault (data).** `src/lib/vault/exampleWorlds.ts` — four complete
   `WorldDoc` builders using the world factories, each with a `VaultEntry { id, name,
   blurb, tags, difficulty, build(): WorldDoc }`:
   `three-tier` (1 region / 2 AZs, LB'd web + api + primary/replica db, ~6 servers,
   clean analysis); `multi-region-failover` (3 regions active/active/passive,
   populations on 3 continents, `dnsTtlSec` tuned so a region kill demonstrates visible
   TTL lag before re-route); `event-driven` (services → managed queue → worker pool in
   compose stacks with internal networks + volumes, exercising the docker path model);
   `broken-teaching` (deliberately trips ≥10 analysis findings across all three
   families: exposed db port, single-AZ region, no-failover population, oversubscribed
   RAM, TTL-outlives-detection, blocked path, stateful-without-volume…). Every entry is
   test-enforced: compiles with exactly the intended findings (zero for the three clean
   worlds, ≥10 for the teaching world), and a seeded engine smoke (`__test_step` ~50
   steps) shows non-zero world rps.
5. **Vault UI (home screen).** A "Start from an example" section under the actions —
   the mockup's `.vcard` grid verbatim (SVG topology glyph, name, blurb, tag pills,
   difficulty). Opening one: `replaceWorld(entry.build())`, `setFilePath(null)`,
   pristine dirty state (same stance as New — Save asks for a location), `goGlobe()`,
   home dismissed. The teaching world opens with the Analysis tab pre-selected (its
   whole point).
6. **Carried bug: stale replay after doc swap.** `simulation.store` gains a
   `resetSession()` action (additive, contract-safe): engine `stop()` + clear
   `latestBatch/events/scrubIndex/scrubBatch/degraded`. `newWorld`/`replaceWorld` call
   it instead of bare `stop()`. `ScrubberV2` additionally gates on `latestBatch !== null`
   so a fresh doc never offers the discarded world's frames (engine buffers reset on the
   next `start()` as they always did).
7. **No engine, contract, or data-model changes.** Everything is view-layer + one
   additive store action + a pure data module. Theme discipline: kit is token-only; the
   phase smoke includes a light-mode pass over every restyled panel.

## Testing & verification

Unit: `derived.ts` (each helper, exact numbers), vault entries (compile-findings
assertions per D4, engine smoke, id/name uniqueness). Component (jsdom): kit components
(DerivedField hint updates on input, Segmented selection, PresetCardGrid select
dispatch), one representative restyled panel test per surface asserting the EXISTING
behavior survived (actions still dispatch with the same patches — restyles must not
change store semantics; extend the panels' existing test files), HomeScreen vault
(cards render, click loads world + navigates + pristine dirty state, teaching world
lands on Analysis tab), ScrubberV2 gate. Live phase-gate story: home screen → open
"Everything wrong at once" → Analysis tab pre-selected with ≥10 grouped findings →
fix one via the restyled firewall stack → open the 3-tier example → Simulate → Topology
rows show live bars → workload slider hint updates live → Stop → New → NO stale
scrubber → multi-region example → region kill → TTL-lag story still works → light-mode
screenshot pass over every panel. Zero console errors.

## Out of scope

Scene changes (globe/board/racks/region are approved as-shipped), engine work, the
umbrella parked list, keyboard-shortcut palette, onboarding tours.
