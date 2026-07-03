# Circuit-Breaker Edge Visualization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move circuit-breaker visualization from a pulsing "big box" on the node to a translucent neon sheath that follows the actual edge path, calibrated to be legible without being distracting even when several edges are tripped at once.

**Architecture:** A new self-contained canvas-drawing module (`circuitVisual.ts`) is called once per frame from the existing particle-engine draw loop, sampling each open/half-open edge's real on-screen geometry via the same function particles already use to travel along edges. The old node-level border/badge UI in `BaseNode.tsx` is removed, including a genuinely dead code path in `particleEngine.ts` that has never executed due to a key-type mismatch.

**Tech Stack:** TypeScript, HTML5 Canvas 2D API (no new dependencies).

## Global Constraints

- No Zustand store changes — `CircuitBreakerEntry.state` (`'closed' | 'open' | 'half-open'`, already computed correctly by `checkBreakerTransition()`) is the only input.
- No new automated test infrastructure — this is canvas-drawing code (side effects on a `CanvasRenderingContext2D`), consistent with every other draw-loop function in `particleEngine.ts` (`advanceAndDraw`, `spawnParticles`, etc.), none of which have unit test coverage today. Verify manually via `npm run dev` + Playwright.
- Exact calibrated values below (thickness, alpha, cycle durations) were reached through five rounds of interactive visual iteration with the user — do not "improve" them without re-confirming; in particular the ~3.5s (open) / ~7s (half-open) scan cycle was slowed down three separate times in response to explicit "too aggressive on the eyes" feedback.
- The node-level circuit-breaker badge/border is removed entirely, not replaced with a quieter variant — confirmed explicitly with the user, not assumed.

---

### Task 1: New `circuitVisual.ts` module + wire into the draw loop

**Files:**
- Create: `src/app/canvas/simulation/particleEngine/circuitVisual.ts`
- Modify: `src/app/canvas/simulation/particleEngine.ts` (import line ~14-27; `advanceAndDraw`'s dead block at lines 2225-2256)

**Interfaces:**
- Consumes: `getAllBreakers()` from `./circuitBreakers` (existing, `Map<string, CircuitBreakerEntry>` keyed by edge id, `CircuitBreakerEntry = { state: CircuitState; openedAt: number; errorWindow: number[] }`); `getEdgePoint(edgeId: string, t: number): [number, number] | null` (existing, `particleEngine.ts:539`, samples the edge's live rendered SVG path — already pan/zoom-correct).
- Produces: `drawCircuitOverlay(ctx: CanvasRenderingContext2D, now: number, getPoint: (edgeId: string, t: number) => [number, number] | null): void`, called from `particleEngine.ts`'s `advanceAndDraw`.

- [ ] **Step 1: Create the new module**

```typescript
// src/app/canvas/simulation/particleEngine/circuitVisual.ts
import { getAllBreakers } from './circuitBreakers'

// ─── Circuit-breaker edge overlay ──────────────────────────────────────────
// Draws a translucent "neon sheath" along an open/half-open edge's actual rendered
// path (sampled via the same getEdgePoint the particles themselves use, so it
// correctly follows bowed/parallel-edge curves and stays pan/zoom-correct).
// Calibrated interactively — see docs/superpowers/specs/2026-07-03-circuit-breaker-edge-visualization-design.md.
// Do not speed up the scan cycle without re-confirming with the user; it was
// slowed down three times in response to "too aggressive on the eyes" feedback.

const SHEATH_COLOR = '#F59E0B'
const SHEATH_THICKNESS = 14
const SAMPLE_COUNT = 24        // polyline segments approximating the edge's curve
const TICK_COUNT = 10          // number of scan ticks visible along the edge at once
const TICK_HALF_LENGTH = 10    // px, each side of the tick's center point
const OPEN_SCAN_CYCLE_MS = 3500
const HALF_OPEN_SCAN_CYCLE_MS = 7000
const PULSE_CYCLE_MS = 2500
const PULSE_FADE_FRACTION = 0.08 // fraction of the cycle spent fading in/out at each end

// Samples the edge's path into a polyline. Returns null if the underlying SVG path
// element isn't in the DOM yet (getEdgePoint's own contract) — callers must skip
// drawing entirely for this edge on this frame rather than drawing a partial shape.
function samplePath(
  getPoint: (edgeId: string, t: number) => [number, number] | null,
  edgeId: string,
): [number, number][] | null {
  const pts: [number, number][] = []
  for (let i = 0; i <= SAMPLE_COUNT; i++) {
    const p = getPoint(edgeId, i / SAMPLE_COUNT)
    if (!p) return null
    pts.push(p)
  }
  return pts
}

function strokePolyline(ctx: CanvasRenderingContext2D, pts: [number, number][]) {
  ctx.beginPath()
  ctx.moveTo(pts[0][0], pts[0][1])
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1])
  ctx.stroke()
}

// Thick translucent glow pass + a crisper lighter border pass on top — the glow is
// what keeps the underlying edge line/particles visible through it (a solid opaque
// tube was tried and explicitly rejected during design for not scaling visually to
// several simultaneously-failing edges).
function drawSheath(ctx: CanvasRenderingContext2D, pts: [number, number][], opacityMul: number, dashedBorder: boolean) {
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  ctx.globalAlpha = 0.16 * opacityMul
  ctx.strokeStyle = SHEATH_COLOR
  ctx.shadowColor = SHEATH_COLOR
  ctx.shadowBlur = 10 * opacityMul
  ctx.lineWidth = SHEATH_THICKNESS
  strokePolyline(ctx, pts)

  ctx.shadowBlur = 0
  ctx.globalAlpha = 0.5 * opacityMul
  ctx.lineWidth = 1.5
  if (dashedBorder) ctx.setLineDash([4, 3])
  strokePolyline(ctx, pts)

  ctx.restore()
}

// A short bright tick perpendicular to the path at parameter t, using two nearby
// samples to derive the local tangent (and therefore perpendicular) direction.
function drawTickAt(
  ctx: CanvasRenderingContext2D,
  getPoint: (edgeId: string, t: number) => [number, number] | null,
  edgeId: string,
  t: number,
  halfLength: number,
  color: string,
  alpha: number,
  lineWidth: number,
) {
  const p1 = getPoint(edgeId, t)
  const p2 = getPoint(edgeId, Math.min(0.999, t + 0.01))
  if (!p1 || !p2) return
  const dx = p2[0] - p1[0]
  const dy = p2[1] - p1[1]
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len
  const ny = dx / len
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  ctx.beginPath()
  ctx.moveTo(p1[0] - nx * halfLength, p1[1] - ny * halfLength)
  ctx.lineTo(p1[0] + nx * halfLength, p1[1] + ny * halfLength)
  ctx.stroke()
  ctx.restore()
}

function drawScanTicks(
  ctx: CanvasRenderingContext2D,
  getPoint: (edgeId: string, t: number) => [number, number] | null,
  edgeId: string,
  now: number,
  cycleMs: number,
  alpha: number,
) {
  const phase = (now % cycleMs) / cycleMs
  for (let i = 0; i < TICK_COUNT; i++) {
    const t = (i / TICK_COUNT + phase) % 1
    drawTickAt(ctx, getPoint, edgeId, t, TICK_HALF_LENGTH, SHEATH_COLOR, alpha, 2)
  }
}

// Single bright "probe" pulse traveling the full edge — open state only (half-open
// deliberately has no pulse, per the final approved design).
function drawPulse(
  ctx: CanvasRenderingContext2D,
  getPoint: (edgeId: string, t: number) => [number, number] | null,
  edgeId: string,
  now: number,
) {
  const t = (now % PULSE_CYCLE_MS) / PULSE_CYCLE_MS
  const fade =
    t < PULSE_FADE_FRACTION ? t / PULSE_FADE_FRACTION
    : t > 1 - PULSE_FADE_FRACTION ? (1 - t) / PULSE_FADE_FRACTION
    : 1
  ctx.save()
  ctx.shadowColor = SHEATH_COLOR
  ctx.shadowBlur = 8
  drawTickAt(ctx, getPoint, edgeId, t, 7, '#FFFFFF', 0.85 * fade, 2)
  ctx.restore()
}

// Called once per frame from particleEngine.ts's advanceAndDraw. Draws nothing for
// closed edges (the common case) and nothing at all if the DOM path element for an
// open/half-open edge isn't resolvable yet on this frame.
export function drawCircuitOverlay(
  ctx: CanvasRenderingContext2D,
  now: number,
  getPoint: (edgeId: string, t: number) => [number, number] | null,
): void {
  for (const [edgeId, breaker] of getAllBreakers()) {
    if (breaker.state === 'closed') continue

    const pts = samplePath(getPoint, edgeId)
    if (!pts) continue

    const isOpen = breaker.state === 'open'
    const opacityMul = isOpen ? 1 : 0.55

    drawSheath(ctx, pts, opacityMul, !isOpen)
    drawScanTicks(ctx, getPoint, edgeId, now, isOpen ? OPEN_SCAN_CYCLE_MS : HALF_OPEN_SCAN_CYCLE_MS, isOpen ? 0.5 : 0.25)
    if (isOpen) drawPulse(ctx, getPoint, edgeId, now)
  }
}
```

- [ ] **Step 2: Wire it into `particleEngine.ts`**

Add to the existing multi-line import block from `./particleEngine/circuitBreakers` area (current lines ~14-17), as a new import statement immediately after it:

```typescript
import { drawCircuitOverlay } from './particleEngine/circuitVisual'
```

Then replace the dead block in `advanceAndDraw` (current lines 2225-2256 — starts at the `// Draw circuit-open overlay (amber ⊘)` comment, ends at the closing `}` right before the `// Advance particles` comment):

```typescript
  // Draw circuit-open overlay (amber ⊘)
  for (const [nodeId, breaker] of getAllBreakers()) {
    if (breaker.state === 'closed') continue
    const rect = getNodeCanvasRect(nodeId)
    if (!rect) continue
    const [nx, ny, nw, nh] = rect
    const cx = nx + nw / 2
    const cy = ny + nh / 2

    ctx.save()
    ctx.globalAlpha = breaker.state === 'open' ? 0.7 : 0.4
    ctx.strokeStyle = '#F59E0B'
    ctx.lineWidth   = breaker.state === 'open' ? 2 : 1.5
    if (breaker.state === 'half-open') ctx.setLineDash([4, 3])
    roundRectPath(ctx, nx, ny, nw, nh, 8)
    ctx.stroke()
    ctx.setLineDash([])

    if (breaker.state === 'open') {
      // Draw ⊘ symbol
      const r = 8
      ctx.beginPath()
      ctx.arc(cx, cy - nh / 2 + 8, r, 0, Math.PI * 2)
      ctx.strokeStyle = '#F59E0B'
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(cx - r * 0.7, cy - nh / 2 + 8 - r * 0.7)
      ctx.lineTo(cx + r * 0.7, cy - nh / 2 + 8 + r * 0.7)
      ctx.stroke()
    }
    ctx.restore()
  }
```

with:

```typescript
  // Draw circuit-breaker edge overlay (neon sheath along open/half-open edges)
  drawCircuitOverlay(ctx, now, getEdgePoint)
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. (`getNodeCanvasRect` remains used elsewhere in this file for node glow, so no unused-function error there; the only removed call site is this one block.)

- [ ] **Step 4: Verify in-browser**

Run `npm run dev` (background), use the Playwright MCP browser tools:
1. Load a diagram with at least one request edge that has a `circuitBreaker` config (e.g. the "Load Balanced Cluster" vault template), start a simulation, and drive traffic/failures until a breaker trips open (Chaos traffic mode is the fastest way, or manually push a node's error rate past `circuitBreaker.errorThreshold` via the Simulation Inspector).
2. Confirm the sheath renders along that edge's actual path (not at a fixed/wrong position), including once the edge is a curved/bowed one (create a second parallel edge between the same two nodes to force the bowed-path case).
3. Let the breaker naturally reach `half-open` (wait past `resetMs`, or reduce it via the Inspector for faster testing) and confirm the sheath dims, the border goes dashed, and the scan cycle visibly slows — with no code changes needed beyond what's in this task (state-driven).
4. Confirm a `closed` edge shows no overlay at all.
5. Confirm the old "big box" is no longer visible around the node (note: the node-level removal is Task 2 — if `BaseNode.tsx` still shows its old badge/border at this point in the plan, that's expected and will be removed next, not a bug in this task).

- [ ] **Step 5: Commit**

```bash
git add src/app/canvas/simulation/particleEngine/circuitVisual.ts src/app/canvas/simulation/particleEngine.ts
git commit -m "$(cat <<'EOF'
feat: draw circuit-breaker state as a neon sheath along the edge

Replaces the node-box overlay's role with a translucent sheath that
follows the edge's actual rendered path (reusing the same
getEdgePoint particles already use), calibrated interactively for
motion intensity. Also removes a genuinely dead code path: the old
overlay destructured getAllBreakers()'s edge-id keys as node ids and
passed them to getNodeCanvasRect, which never matched — it has never
drawn anything.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Remove the node-level circuit-breaker UI

**Files:**
- Modify: `src/app/canvas/nodes/BaseNode.tsx` (lines ~40-52, ~112, ~201-209)
- Modify: `src/app/canvas/nodes/BaseNode.module.css` (lines 240-285)

**Interfaces:**
- Consumes: nothing new — this task only removes code.
- Produces: nothing new — no other file depends on the removed classes/variables (verify via a repo-wide grep in Step 1 before removing, in case something outside `BaseNode.tsx` also references `.circuitBadge`/`.circuitHalfBadge`/`.circuitOpen`/`.circuitHalfOpen`).

- [ ] **Step 1: Confirm nothing else references these classes**

```bash
grep -rn "circuitBadge\|circuitHalfBadge\|\.circuitOpen\b\|\.circuitHalfOpen\b\|circuitOpenPulse" src/ --include="*.tsx" --include="*.css" --include="*.ts"
```

Expected: only matches inside `BaseNode.tsx` and `BaseNode.module.css`. If anything else matches, stop and report it rather than deleting — this plan doesn't cover cleaning up other files.

- [ ] **Step 2: Remove from `BaseNode.tsx`**

Change:

```tsx
  const utilization  = metrics?.utilization ?? 0
  const circuitState = metrics?.circuitState ?? 'closed'
  const isCircuitOpen = running && circuitState === 'open'
  const isCircuitHalf = running && circuitState === 'half-open'
  const isSaturated  = utilization >= 1.0
```

to:

```tsx
  const utilization  = metrics?.utilization ?? 0
  const isSaturated  = utilization >= 1.0
```

Change the `metrics` construction a few lines above (remove the now-unused `circuitState` field):

```tsx
  const metrics = m
    ? { utilization: m.utilization, errorRate: m.errorRate, circuitState: m.circuitState, healthState: m.healthState, droppedRequests: m.droppedRequests }
    : null
```

to:

```tsx
  const metrics = m
    ? { utilization: m.utilization, errorRate: m.errorRate, healthState: m.healthState, droppedRequests: m.droppedRequests }
    : null
```

Change the className list:

```tsx
        isCircuitOpen ? styles.circuitOpen : isCircuitHalf ? styles.circuitHalfOpen : isSaturated ? styles.saturated : isCritical ? styles.critical : '',
```

to:

```tsx
        isSaturated ? styles.saturated : isCritical ? styles.critical : '',
```

Remove the circuit badge JSX block and simplify the bottleneck badge's guard condition (it previously existed to avoid double-badging alongside the now-removed circuit badges):

```tsx
        {/* Circuit breaker badge */}
        {isCircuitOpen && (
          <div className={styles.circuitBadge} title="Circuit open — rejecting all requests">⊘</div>
        )}
        {isCircuitHalf && (
          <div className={styles.circuitHalfBadge} title="Circuit half-open — testing recovery">⊘</div>
        )}
        {/* Bottleneck badge — simulation-driven, does not mutate NodeData.status */}
        {running && isCritical && !isCircuitOpen && !isCircuitHalf && (
```

to:

```tsx
        {/* Bottleneck badge — simulation-driven, does not mutate NodeData.status */}
        {running && isCritical && (
```

(The `<div className={styles.bottleneckBadge}>...</div>` block and its closing `)}` immediately after stay exactly as they are — only the opening JSX-condition line above them changes.)

- [ ] **Step 3: Remove from `BaseNode.module.css`**

Delete lines 240-285 in full — from the `/* Circuit breaker open — amber ⊘ */` comment through the closing `}` of `.node.circuitHalfOpen`:

```css
/* Circuit breaker open — amber ⊘ */
.circuitBadge {
  font-size: 10px;
  font-weight: 700;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--color-warning) 13%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-warning) 53%, transparent);
  color: var(--color-warning);
  cursor: help;
}

.circuitHalfBadge {
  font-size: 10px;
  font-weight: 700;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--color-warning) 7%, transparent);
  border: 1px dashed color-mix(in srgb, var(--color-warning) 33%, transparent);
  color: color-mix(in srgb, var(--color-warning) 53%, transparent);
  cursor: help;
}

/* Circuit breaker node states */
@keyframes circuitOpenPulse {
  0%, 100% { border-color: var(--color-warning); box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-warning) 20%, transparent), 0 4px 18px rgba(0,0,0,0.55); }
  50%       { border-color: color-mix(in srgb, var(--color-warning) 70%, white); box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-warning) 13%, transparent), 0 0 12px color-mix(in srgb, var(--color-warning) 27%, transparent), 0 4px 18px rgba(0,0,0,0.55); }
}

.node.circuitOpen {
  animation: circuitOpenPulse 1.6s ease-in-out infinite;
}

.node.circuitHalfOpen {
  border-color: var(--color-warning);
  border-style: dashed;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-warning) 13%, transparent), 0 4px 18px rgba(0,0,0,0.55);
}
```

Leave the surrounding blank lines and the following `/* Diagnostics-panel "look here" pulse ... */` comment block untouched.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors (no unused-variable errors, since `circuitState`/`isCircuitOpen`/`isCircuitHalf` are fully removed, not left dangling).

- [ ] **Step 5: Verify in-browser**

Using Playwright against `npm run dev`, trip a breaker open the same way as Task 1's Step 4, and confirm:
1. The node card shows no border-pulse and no `⊘` badge in any state (open, half-open, closed).
2. The edge's neon sheath from Task 1 is now the sole visual indicator.
3. The bottleneck badge (▲/●) still renders correctly for a saturated/critical node that is *not* circuit-tripped (confirms the simplified guard condition didn't break that unrelated badge).

- [ ] **Step 6: Commit**

```bash
git add src/app/canvas/nodes/BaseNode.tsx src/app/canvas/nodes/BaseNode.module.css
git commit -m "$(cat <<'EOF'
refactor: remove node-level circuit-breaker border/badge

The edge-level neon sheath (previous commit) is now the sole circuit-
breaker indicator, confirmed with the user rather than keeping a
quieter node-level fallback.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Full verification pass + docs update

**Files:**
- Modify: `docs/module-boundaries.md`
- No source changes — verification + documentation only.

**Interfaces:**
- Consumes: everything from Tasks 1-2.
- Produces: nothing — terminal task.

- [ ] **Step 1: Run the full spec verification checklist**

```bash
npx tsc --noEmit
npx vitest run
```

Expected: `tsc` clean, existing vitest suite still passing (this feature adds no new test files, so the count should be unchanged from before this plan).

Then in-browser via Playwright, using a diagram with at least 4-5 nodes (e.g. a small cluster template) and Chaos traffic mode to reliably produce multiple simultaneous circuit-open edges:

1. Trigger a cascading failure and confirm several simultaneously-open sheaths stay legible (don't visually merge into indistinguishable noise) — this was the specific scalability concern that ruled out the earlier "gate" design during brainstorming.
2. Confirm `closed` → `open` → `half-open` → `closed` all render correctly as the breaker naturally transitions through its lifecycle within one continuous run.
3. Confirm behavior in **both light and dark theme** — the sheath's colors/glow are fixed hex values (not theme-reactive, consistent with this file's existing "particle/edge colors are dark-mode-only by design" convention per `docs/module-boundaries.md`), but confirm it's still legible against a light canvas background. If it reads poorly in light mode, note this as a finding rather than silently shipping it — this wasn't tested during the mockup phase (which only used a dark background).
4. Confirm the node card shows no circuit-breaker-specific styling in any state (Task 2's removal holds).

- [ ] **Step 2: Update `docs/module-boundaries.md`**

Find the `### B. Simulation engine & live metrics` section's file table (it already lists `particleEngine/circuitBreakers.ts`, `particleEngine/backpressure.ts`, `particleEngine/chaos.ts`). Add a new row immediately after the `circuitBreakers.ts` row:

```markdown
| `src/app/canvas/simulation/particleEngine/circuitVisual.ts` (2026-07-03) | Draws the circuit-breaker edge overlay (translucent neon sheath + scan ticks + open-state pulse) once per frame from `advanceAndDraw`, keyed off `getAllBreakers()` and the same `getEdgePoint` path-sampling particles use. Replaces the old node-level border/badge in `BaseNode.tsx` (removed) and a dead canvas overlay in `particleEngine.ts` that never executed due to an edge-id/node-id key mismatch. Calibrated interactively with the user — see `docs/superpowers/specs/2026-07-03-circuit-breaker-edge-visualization-design.md` before changing motion/timing values |
```

Also add one sentence to that section's existing "Blast radius" paragraph noting the new file: `circuitVisual.ts` has 1 caller (`particleEngine.ts`), no exports consumed elsewhere.

- [ ] **Step 3: Commit**

```bash
git add docs/module-boundaries.md
git commit -m "$(cat <<'EOF'
docs: document the circuit-breaker edge visualization module

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
