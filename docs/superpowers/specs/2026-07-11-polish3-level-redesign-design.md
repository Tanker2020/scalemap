# Polish 3 — Per-Level Design Overhaul (Region v4 · Datacenter Floor · Server Board v5 · Dock v2)

Locked across five mockup rounds with the user (final artifact label `v5-locked-rj45`).
The committed mockup `docs/superpowers/specs/mockups/level-redesign-v5.html` is the **binding
visual truth** — open it in a browser; every CSS block referenced below lives in that file and
is meant to be transcribed (hex, spacing, clip-paths, keyframe timings), not eyeballed.
Option B (a three.js 3D datacenter room) is explicitly OUT of this phase — it is parked as
GitHub issue #23 and this phase's rack model must keep it a pure view-swap later.

## The problem this phase solves

Four user critiques, verbatim themes: the region page was "a bunch of lines" and lagged; the
AZ view didn't feel like a place ("an AZ should be represented as a datacenter"); the server
view's intake/firewall were "straight up boxes" and the page read as disconnected cards, not
one wired machine; the dock was "a bunch of boxes… no creativity". Polish 3 rebuilds the look
of every level to the locked mockups without changing what any control does.

## Design decisions (binding)

**D1 — Motion law + motion budget (app-wide, this phase's constitution).** No animation
unless it carries information. Per view, at most **~8 concurrent infinite animated strokes**;
everything else encodes with static fills, glows, and numbers. Dash/dot **speed and density =
rate**, everywhere, as the one shared convention. All decorative motion no-ops under
`prefers-reduced-motion`; the only exceptions are functional feedback (the existing hold-ring
sweep; the add-server boot animation degrades to instant-appear).

**D2 — Dedicated price color.** New theme token `price` (user's amendment, round 5): dark
`#6EE7B7`, light `#047857` (6.4:1 on white — normal-text AA). EVERY money value in the app
renders `var(--color-price)`: the Cost tab's rollups, region egress/monthly figures, overlay
`$N/hr` chips, TopologyPanel's hourly meta, the instance-catalog picker prices, the dock
summary's `$N/hr`. One token, both themes, no other use of that hue.

**D3 — Region v4 ("calmer, shapelier").** The region page becomes the mockup's `.r3` layout:
a **WHO'S SENDING** sources column — one row per contributing population with a **dot stream**
(dots on a hairline; dot count and speed ∝ that population's rps; cap the animated rows at the
top 5 by rps) and a meta line (latency, egress cost in the price color) — merging into a
trunk; AZ cards with a config bar (`⏎ enter` / `+ server` / `⚡ kill` — existing dispatches
only), server rows with **static** utilization bars whose single glowing endpoint replaces
the v3 animated fills; exactly two cross-AZ beams + the trunk as the marching-dash strokes.
The **replica rail** tucks into the gutter at 38% opacity showing only ◆→◇ glyphs and
brightens to full opacity with its label when either DB row is hovered. TimelineStrip and
AlertRibbon remain (restyle only if a task touches them).

**D4 — Rack model (the one document-model change).** Racks become **optional authored
organizational containers**:
- New entity `Rack { id, azId, label, capacityU }`; `capacityU` defaults to **8**, clamped
  **4–42**. New `WorldDoc.racks: Record<RackId, Rack>` collection.
- `Server.rack` becomes `RackPosition | null`; **null = the free pool** (the VPS/cloud mental
  model). `createServer` seeds `rack: null` — a new server is born unracked.
- Assignment is capacity-checked (sum of resident `heightU` never exceeds `capacityU`); an
  **auto-arrange** action racks the whole free pool deterministically.
- Serializer stays version `"2"`, additively: `racks` optional on load (default `{}`),
  always written; a server without a `rack` field loads as `null`. Old files load unchanged.
- `compileWorld`, the engine, analysis rules, cost model: **untouched** — racks carry zero
  simulation semantics.

**D5 — AZ level = Option A, the isometric datacenter floor.** `AzCanvas.tsx` (React Flow) is
**replaced** by a DOM/SVG isometric floor (the mockup's datacenter section): floor tiles that
grow an outer ring when racks + pods need room; **rack cabinets that render exactly their real
contents** (server slats sized by `heightU`, LED strips driven by live metrics, a used/capacity
gauge); **free-pool pods** for unracked servers; managed services as edge appliances. The
**add-server boot animation** (faceplate drops in with a bounce, amber LED boot cascade
settling green — mockup keyframes `rackin`/`bootled`) plays wherever a server is born. Click
selects (InspectorV2 stays); hold-to-enter (the existing Polish 2 primitive) drills into the
server view; a floor toolbar carries `+ server`, `+ rack`, `auto-arrange`. Aggregated
server-pair flows draw as floor traces — only the top 8 by rps animate (D1); blocked paths
stay static red-dashed with their reason. **`@xyflow/react` is removed from the app** (this
was its last surface). Rack assignment UI: the selected server's inspector gains a rack
selector (free pool / each rack with remaining capacity; full racks disabled) — drag-to-rack
is deliberately deferred (parked, not partially built).

**D6 — Server board v5: the RJ45 intake (user's amendment, round 5).** `NicBlock` becomes a
**physical RJ45 jack, face-on** (mockup `.b3nic .jack`): metal bezel, the keystone-notch
socket silhouette (clip-path), **8 gold pins that ripple left-to-right as packets land** (ripple
cadence ∝ NIC throughput), and the two LEDs everyone already reads: **green LINK steady**
while the server is up, **amber ACT flickering** with traffic (blink rate ∝ rps; dark when
idle). The intake packet lanes visibly converge INTO the port. No container rectangle.

**D7 — Server board v5: the rule-slat shield.** `FirewallGate` becomes a **shield built from
its own rules** (mockup `.b3fw2`): a clip-path shield whose slats ARE the server's actual
firewall rules in evaluation order (allow = green slat whose edge-dot fires when traffic
passes; deny = red slat; more rules than fit → a "+n more" slat), a scan sweep patrolling the
face, a beacon crowning it, and reject sparks driven by the real blocked counts (gateStats).
Clicking the shield (or a slat) opens the existing firewall editing surface — every dispatch
and aria-label byte-identical.

**D8 — Server board v5: substrate + one wired machine.** `HardwarePlatform` renders the locked
instruments: a **per-core bank** (grid of core cells filled by live per-core utilization,
`hot` ≥ 0.85, **violet interference overlay on the stolen cores** when VPS steal is active —
steal is physical, not a bar), **DIMM sticks** (per-blueprint RAM strata in each blueprint's
signature color + free headroom), a **spinning platter** (spin ∝ disk-IO fraction, stopped
when idle), and queue-depth ticks. Service chips get activity sparkbars and hover lift. The
whole board shares one current convention: **etched trace at rest, flowing dashes under load,
selection highlights the up/downstream path**. `InspectorRail` shrinks to a two-line dock
strip that expands upward on selection and never eats the board — forms, dispatches, and
aria-labels unchanged.

**D9 — Dock v2 (locked round 2).** The WorldPanel tab bar and tab bodies adopt the mockup's
signature-header dock: each tab keeps its content and dispatches but gains a per-tab identity
header (glyph, accent, one-line live summary) and an internal layout that is not a uniform box
stack. The Polish 2 world-summary strip and tab ink survive unchanged.

**D10 — Relocated-dispatch contract (carried forward).** Every control this phase restyles or
moves reuses its EXISTING store dispatch byte-for-byte. The only new store surface is the rack
CRUD in `world.store` (genuinely new authoring, routed through `mutate()` so undo/dirty come
free) — `nav`, `simulation`, `file`, `ui` stores gain nothing.

**D11 — Engine frozen.** ZERO changes under `src/lib/worldEngine/`. Forced drift →
`.superpowers/sdd/contract-drift.md` `## POLISH 3`, never silently.

**D12 — Both themes, token-only.** All new styling through `var(--color-*)` (plus kit vars);
every new surface passes a light-mode screenshot. The mockup is dark-mode; light mode maps
through the token system, not a second hand-tuned design.

## Testing posture

Pure derivations (dot-stream params, floor layout growth, slat derivation, capacity math,
auto-arrange determinism, serializer round-trips) get node-env unit tests with exact expected
values. Component structure gets jsdom render tests that assert content and dispatches, never
animation. Anything whose truth is visual/interactive (isometric depth, boot animation, pin
ripple, hover reveals) gates on named live smokes with dark + light screenshots into
`.superpowers/sdd/screenshots/polish3-*`.

## Out of scope (do not build)

Option B (issue #23); drag-to-rack on the floor; rack power/cooling simulation semantics;
any engine change; persistence of analysis/LLM output; everything on the umbrella spec's §9
parked list.
