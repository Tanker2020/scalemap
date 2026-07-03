# Circuit-Breaker Edge Visualization — Design

## Problem

Today, when an edge's circuit breaker trips open or half-open, the only visual
feedback is on the **node**, not the edge: `BaseNode.module.css`'s
`.node.circuitOpen`/`.circuitHalfOpen` classes apply a pulsing amber border
around the whole node card (`circuitOpenPulse` keyframe, `BaseNode.tsx:112`),
plus a small `⊘` badge (`BaseNode.tsx:203`, `.circuitBadge` in
`BaseNode.module.css:241`). This is "just a big box" — it doesn't communicate
*which connection* tripped, doesn't scale visually (multiple simultaneously
saturated/critical/circuit-open nodes just means multiple boxes), and gives no
sense of directionality (breakers are a client-side, per-edge concept — a
node can have several inbound edges, only some of which are tripped).

There is also a **second, dead** circuit-breaker overlay in
`particleEngine.ts:2225-2256` that draws directly on the simulation canvas.
It iterates `getAllBreakers()` — a `Map<edgeId, CircuitBreakerEntry>` — but
destructures the key as `nodeId` and passes it to `getNodeCanvasRect()`,
which looks up canvas rects by *node* id. Since edge ids and node ids are
generated from disjoint prefixes (`nextId('edge')` vs `nextId(type)` in
`canvas.store.ts`), this lookup never matches, `rect` is always `null`, and
the whole block is unreachable. It has never actually drawn anything; this
spec removes it along with the node-level box.

## Goals

- Move circuit-breaker state visualization from the *node* to the *edge*
  that actually owns the breaker, so multiple inbound edges to the same node
  can show independent states.
- Replace the flat "big box" look with a deliberately stylized "neon
  tunnel/sheath" effect wrapping the edge itself — translucent enough that
  the underlying edge line stays visible through it (glass/wireframe, not a
  solid shape), with a slow scanning texture across it evoking active
  work/blockage on that connection, calibrated to be legible without being
  distracting.
- Keep this legible when many edges are in this state simultaneously (a
  cascading-failure scene), since a per-edge glued-on widget was explicitly
  rejected during design for not scaling to that case.
- Ship independent of the (separate, not-yet-fixed) circuit-breaker
  metrics/SLO semantic bug — the breaker's `open`/`half-open`/`closed` state
  is already computed correctly today via `checkBreakerTransition()`
  (`circuitBreakers.ts`); this spec only changes how that state is *drawn*.

## Non-goals

- Not fixing the metrics/SLO semantic bug in `issues.md` (rejections not
  counting as errors, SLO never reading `circuitState`/`droppedRequests`,
  half-open's steady 10%-throttle instead of fixed trial requests, `offeredRps`
  bookkeeping). That's a separate spec, deliberately sequenced after this one
  per the user's explicit choice.
- Not adding any new node-level circuit-breaker UI. The node-level border
  pulse and `⊘` badge are removed outright, not replaced with a quieter
  variant — confirmed with the user rather than assumed.
- No new Zustand store fields — `CircuitBreakerEntry`'s `state` (already
  `'closed' | 'open' | 'half-open'`, `circuitBreakers.ts:9-13`) is sufficient
  input for the new drawing logic.

## Design

### Visual states (calibrated interactively, see below for exact values)

**Closed:** no overlay at all — the edge renders exactly as it does today
(plain colored line + particles per `edgeColor()`/particle animation).

**Open:**
- A translucent "neon sheath" follows the edge's actual rendered path
  (including bowed/parallel-edge curves — see Architecture below), sized as
  a thick, low-alpha capsule with a brighter 1px wireframe border and an
  outer glow, colored with the existing `--color-warning` amber
  (`#F59E0B`) — consistent with every other warning/degraded-state color in
  the app, not a new hue. Low enough fill alpha (~6% fill, ~50% border
  alpha, glow blur ~10-12px at final calibration) that the underlying edge
  line and any particles on it remain visible through the sheath, which is
  what keeps it readable when several edges are lit up at once — a solid
  opaque tube was explicitly tried and rejected during design for looking
  fake and not scaling visually to a multi-edge failure scene.
- A holographic "scan" texture sweeps along the sheath's length on a **~3.5s
  linear cycle** (this exact duration was reached by iterating down from an
  initial ~1.1s in response to explicit "too aggressive on the eyes"
  feedback across three rounds — do not reset it to a faster value without
  re-confirming with the user).
- A single bright tick/pulse travels the full length of the edge on a
  **~2-3s ease-in-out cycle**, fading in/out at the endpoints — the one
  element allowed a slightly snappier easing than the ambient scan texture,
  since it reads as a discrete "probe" rather than ambient noise.

**Half-open:** the same sheath at roughly half opacity, a dashed/lighter
border, and the scan cycle roughly doubled (**~7s**) — visually "the same
thing, but calmer and less certain," matching the semantic difference from
`open` without needing a distinct visual language. No bright pulse tick in
this state (kept exclusive to `open` per the final approved mockup).

### Architecture

**New file:** `src/app/canvas/simulation/particleEngine/circuitVisual.ts` —
follows this codebase's existing pattern (`circuitBreakers.ts`,
`backpressure.ts`, `chaos.ts`) of extracting a self-contained concern out of
the 2400+ line `particleEngine.ts` hub file rather than growing it further.
Exports one function, e.g. `drawCircuitOverlay(ctx, now)`, called once per
frame from the same place the existing node-glow drawing loop lives (near
`particleEngine.ts:2225`, which this replaces).

The function:
1. Iterates `getAllBreakers()` (already correctly keyed by edge id — the
   *consumer* of this map was buggy, not the map itself).
2. Skips any entry with `state === 'closed'`.
3. Resolves that edge's on-screen path using the **same path-sampling
   mechanism the particles themselves already use** to travel along an
   edge (whatever internal function currently maps `(edgeId, t) → {x, y}`
   for particle placement) — this guarantees the sheath correctly follows
   bowed/parallel-edge curves from `BaseEdge.tsx` instead of assuming a
   straight line between node centers, and means this module has no
   independent, potentially-divergent notion of edge geometry.
4. Draws the sheath (steps above) using `ctx.save()`/`ctx.shadowBlur`/
   translucent `strokeStyle`/`fillStyle`, matching the existing "Soft Halo"
   rendering conventions already used for node glow elsewhere in this file
   (`ctx.shadowColor`/`ctx.shadowBlur` already appear on the glow-drawing
   code this sits next to).
5. Draws the scan texture and (open-only) pulse tick as short segments/dots
   positioned by arc-length along the path, phase-shifted each frame by a
   value derived from `now` at the calibrated cycle durations — this is the
   idiomatic canvas equivalent of the CSS `repeating-linear-gradient` +
   `background-position` animation used to prototype the look, adapted to
   discrete draw calls since canvas has no repeating-gradient-along-a-curved-
   path primitive.

**Removed:**
- `particleEngine.ts:2225-2256` (the dead box+`⊘` overlay) — deleted
  outright, not refactored, since it never executed.
- `BaseNode.module.css`: `.node.circuitOpen`, `.node.circuitHalfOpen`,
  `circuitOpenPulse` keyframe, `.circuitBadge`.
- `BaseNode.tsx`: the `isCircuitOpen`/`isCircuitHalf` badge JSX
  (`:202-207`) and their contribution to the node's className list
  (`:112`). The underlying `circuitState`/`isCircuitOpen`/`isCircuitHalf`
  local variables can go too if nothing else in `BaseNode.tsx` reads them —
  verify at implementation time rather than assuming.

**Performance:** cost is proportional to the number of `open`/`half-open`
edges only (a handful of stroke/arc calls each), not total edge count — zero
marginal cost while the system is healthy, and still cheap in a
cascading-failure scene with many simultaneously-tripped edges, consistent
with the rest of this file's existing per-frame budget.

### Testing / verification

No automated visual-regression tooling exists for canvas-drawn simulation
output (consistent with the rest of this codebase's simulation layer). Verify
manually via `npm run dev` + Playwright, per this project's established
convention:
- Trip a single edge's breaker open (e.g. via Chaos traffic mode or manually
  saturating a node past its `circuitBreaker.errorThreshold`) and confirm the
  sheath renders along that edge's actual path, including on a curved/bowed
  edge (parallel edges between the same two nodes).
- Confirm the breaker naturally transitions to `half-open` after
  `resetMs` and the visual correctly dims/slows without code changes beyond
  what's specified here (state-driven, not a separate half-open code path).
- Confirm `closed` shows no overlay at all.
- Trigger a multi-node cascading failure (chaos mode against a small
  cluster) and confirm several simultaneous open sheaths stay legible rather
  than visually merging into noise.
- Confirm the node card itself no longer shows any circuit-breaker-specific
  border/badge in any state.
- Both light and dark theme (this app's `--color-warning` token already
  resolves per-theme; confirm the sheath's fixed-hex glow/fill values still
  read correctly against a light canvas background, adjusting alpha if
  needed — this wasn't tested during the mockup phase, which only used a
  dark canvas).

## Out of scope / follow-ups

- The circuit-breaker metrics/SLO semantic fix (`issues.md`) is a separate,
  already-scoped-but-unwritten spec, intentionally sequenced after this one.
- No changes to `NODE_SIM_DEFAULTS`' `circuitBreaker` config shape
  (`errorThreshold`, `resetMs`) — purely a rendering change.
