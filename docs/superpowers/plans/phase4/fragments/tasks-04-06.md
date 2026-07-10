# Phase 4 plan fragment — Tasks 4–6 (pure rack layout · rack frame/chassis nodes · AzSimOverlay v2)

> Fragment scope: Task 4 (pure rack-frame layout), Task 5 (`RackFrameNode`/`RackChassisNode`,
> AzCanvas rewired to frames+chassis), Task 6 (AzSimOverlay v2 — absolute coords, measured
> dims, imperative viewport). Dependency chain is self-contained: T4 → T5 → T6, independent
> of T1–T3's `region/` page. Global Constraints / File Structure below are shared verbatim
> across all 8 tasks (reproduced here per the handoff brief — this fragment's own scope is
> only Tasks 4–6). Every grounding fact below was read from on-disk source or the installed
> `@xyflow/react@12.11.1` typings on 2026-07-09 (see `phase4-grounding.md`); where the
> skeleton's prose and grounding conflict, grounding governs — logged inline where it matters.
> No code changes anywhere under `src/lib/worldEngine/` in this fragment.

## Global Constraints (every task inherits these)

- Branch: `phase4-region-rack`, cut from `main` (Phase 3 merged; main ≥ `ce7c263`).
- Contract types in `src/lib/worldEngine/types.ts` are FROZEN and this phase does not
  touch `src/lib/worldEngine/` except the ONE comment permitted by D2 (buildPayload's
  region-branch comment) — no code changes under `worldEngine/` at all; forced needs go
  to `.superpowers/sdd/contract-drift.md` under `## PHASE 4`, never silently.
- strict tsc (`noUnusedLocals`, `noUnusedParameters`); `npm run build` green per commit.
- Full `border` shorthand only — never a bare `borderColor` over a shorthand.
- Component tests: `// @vitest-environment jsdom` pragma + jest-dom via `vitest.setup.ts`.
  Pure tests: node env.
- Views read `useSimulationStore`; only store actions call the facade. Metric-driven UI
  reads `scrubBatch ?? latestBatch` (D1). World mutations via existing `useWorldStore`
  actions (T7 adds ONE parameter to ONE action; nothing else — not this fragment).
- Renderer/effect discipline: no per-frame setState; no effects keyed on viewport/hover
  (D9/D11); all looping animation gated on `prefers-reduced-motion`
  (framer-motion `useReducedMotion`, and CSS `@media (prefers-reduced-motion)` for the
  SVG dash animations).
- Colors: theme tokens for semantics; mockup scene hexes stay local constants in the new
  files (no new global tokens). Font via `--font-mono`.
- Live Playwright smokes controller-run on strict port 1420, ZERO app console errors,
  screenshots, server stopped after.
- Ledger: `.superpowers/sdd/progress.md` under `## PHASE 4`. Boundaries doc gains §M (T8,
  not this fragment).

## File Structure

```text
src/app/world/region/                # NEW — Level-2 flow page internals (T1–T3, not here)
src/app/world/RegionView.tsx         # T2: REWRITTEN as the flow composition root (not here)
src/lib/world/layoutRacks.ts (+ test)# T4: pure rack layout (frames, units, fillers, PDU)
src/app/world/RackNodes.tsx          # T5: RackFrameNode + RackChassisNode (+ jsdom test)
src/app/world/WorldServerNode.tsx    # T5: WorldServerNode DELETED (WorldManagedNode moves
                                     #     into RackNodes.tsx; grep importers first)
src/app/world/AzCanvas.tsx           # T5: rewired to frames/chassis via layoutRacks
src/app/world/AzSimOverlay.tsx       # T6: absolute coords, measured dims, imperative viewport
src/app/store/world.store.ts         # T7: addManagedService provider param (not here)
src/app/world/panels/…               # T7: provider <select> (not here)
src/app/world/server/{ServerBoard,inspectorForms,FirewallGate,PacketLayer}.tsx  # T7 (not here)
src/lib/costModelV2.test.ts          # T7 (not here)
docs/module-boundaries.md            # T8: §M (not here)
```

Dependency order: T1 → T2 → T3; T4 → T5 → T6; T7, T8 last (T8 after all). Serial
execution T1…T8 is simplest and correct. This fragment is T4–T6.

---

## Task 4: Pure rack layout `[sonnet]`

**Files:** create `src/lib/world/layoutRacks.ts`, `src/lib/world/layoutRacks.test.ts`.
Leave `src/lib/world/layoutAz.ts` (+ its test) in place — Task 5 deletes it once AzCanvas
(its only importer) stops using it.

**Grounding:**

- `Server` / `ServerId` / `RackPosition` live in `src/lib/world/types.ts`:
  `RackPosition { rackId: string; unit: number; heightU: number }`, `Server { id; label;
  ...; rack: RackPosition }`. `layoutRacks` reads only `.id`, `.label`, `.rack` off each
  server — it does not need the rest of the `Server` shape.
- `src/lib/world/factories.ts`'s `createServer` (the only place servers are constructed
  today, both in the app and in tests) sets `rack: { rackId: 'rack-1', unit: 1, heightU:
  preset.kind === 'dedicated' ? 2 : 1 }` — **every** server defaults to the same rack and
  the same unit. This means "duplicate/colliding units" is the *common* case this
  function must handle correctly, not a rare edge case — reflected below in a named test
  that mirrors the factory default exactly (three servers, all `unit: 1`).
- `src/lib/world/layoutAz.ts` (being superseded) is the direct style precedent: a small,
  pure, framework-free module exporting a layout function + its tunable constants
  (`AZP_LAYOUT`-style). `layoutRacks` follows the same shape: pure function + named
  exported constants, zero React/store/engine imports. `useCompiledWorld.ts` states the
  house rule explicitly: *"Lives in app/ (not lib/world/) deliberately: lib/ must never
  import app stores."* `layoutRacks.ts` imports only `type { Server, ServerId } from
  './types'`.
- Exact exported surface (skeleton, verbatim — do not redesign):
  `U_PX=44, CHASSIS_W=220, RACK_PAD=10, RAIL_W=8, RACK_W=CHASSIS_W+2*(RACK_PAD+RAIL_W)=256,
  RACK_GAP=60, PDU_H=18, MANAGED_W=170, MANAGED_H=60`; `RackBox`, `RackFrame`,
  `RackLayout`, `layoutRacks(servers, managedIds)`.
- Geometry semantics (grounding §10, already verified below): chassis y (frame-relative)
  `= RACK_PAD + (unit − minUnit) × (U_PX + 4)`; chassis h `= heightU × U_PX`; frame x
  `= i × (RACK_W + RACK_GAP)`, frame y `= 0`; managed column x `= framesRightEdge +
  RACK_GAP` where `framesRightEdge = (n−1) × (RACK_W+RACK_GAP) + RACK_W` for `n` frames
  (`0` when there are no frames); managed entries stack in that column every
  `MANAGED_H + 20`px. Frames sorted by `rackId`; each frame's `serverIds` sorted by
  (effective) unit ascending.
- **Judgment call — blank-filler "cap 3 per frame" semantics.** The skeleton says filler
  strips "fill unit GAPS (cap 3 per frame)" without pinning whether the cap counts filler
  *strips* (one per contiguous empty-unit region) or individual empty *unit-slots*. This
  plan renders **one filler strip per contiguous gap region** (a gap spanning multiple
  empty units is ONE strip sized to span the whole gap), and caps the frame at **3 such
  strips** — extra gap regions beyond the 3rd simply render no filler (chassis positions
  past that point are unaffected; only the decorative filler is skipped). This keeps a
  frame with one server authored at `unit: 500` from drawing 498 filler strips. Verified
  deterministic below (scenario 5).
- **Judgment call — gap before the PDU strip.** The skeleton gives `PDU_H=18` (the
  strip's own height) but no named constant for the gap between the last chassis (or
  filler) and the PDU. This plan reuses `RACK_PAD` (10px) for that gap, symmetric with
  the frame's own top/bottom padding — a defensible, deterministic default with no
  competing signal from the skeleton or mockup to prefer another value.

**Arithmetic check — real script, real output (this is what makes the numbers below
trustworthy, not hand-waved).** Run from the scratchpad:

```js
// layoutRacks-check.mjs — standalone reimplementation of the exact algorithm below;
// run with `node layoutRacks-check.mjs` to reproduce every number cited in this task.
const U_PX = 44, CHASSIS_W = 220, RACK_PAD = 10, RAIL_W = 8
const RACK_W = CHASSIS_W + 2 * (RACK_PAD + RAIL_W)   // 256
const RACK_GAP = 60, PDU_H = 18, MANAGED_H = 60, MAX_FILLERS = 3

function layoutRacks(servers, managedIds) {
  const byRack = new Map()
  for (const s of servers) { const l = byRack.get(s.rack.rackId) ?? []; l.push(s); byRack.set(s.rack.rackId, l) }
  const rackIds = [...byRack.keys()].sort()
  const frames = [], chassis = {}
  rackIds.forEach((rackId, i) => {
    const sorted = [...byRack.get(rackId)].sort((a, b) => a.rack.unit - b.rack.unit || a.label.localeCompare(b.label))
    const minUnit = Math.min(...sorted.map(s => s.rack.unit))
    let nextUnit = minUnit
    const placed = []
    for (const s of sorted) { const unit = Math.max(nextUnit, s.rack.unit); placed.push({ server: s, unit }); nextUnit = unit + s.rack.heightU }
    const frameX = i * (RACK_W + RACK_GAP)
    const serverIds = [], blankUnits = []
    let maxBottom = 0
    placed.forEach((p, idx) => {
      const y = RACK_PAD + (p.unit - minUnit) * (U_PX + 4)
      const h = p.server.rack.heightU * U_PX
      chassis[p.server.id] = { rackId, x: RACK_PAD + RAIL_W, y, w: CHASSIS_W, h }
      serverIds.push(p.server.id)
      maxBottom = Math.max(maxBottom, y + h)
      const next = placed[idx + 1]
      if (next) {
        const curBottomUnit = p.unit + p.server.rack.heightU
        const gapUnits = next.unit - curBottomUnit
        if (gapUnits > 0 && blankUnits.length < MAX_FILLERS) {
          blankUnits.push({ y: RACK_PAD + (curBottomUnit - minUnit) * (U_PX + 4), h: gapUnits * U_PX + (gapUnits - 1) * 4 })
        }
      }
    })
    const pduY = maxBottom + RACK_PAD
    frames.push({ rackId, box: { x: frameX, y: 0, w: RACK_W, h: pduY + PDU_H + RACK_PAD }, serverIds, blankUnits, pduY })
  })
  const n = frames.length
  const framesRightEdge = n === 0 ? 0 : (n - 1) * (RACK_W + RACK_GAP) + RACK_W
  const managedX = n === 0 ? 0 : framesRightEdge + RACK_GAP
  const managed = {}
  managedIds.forEach((id, i) => { managed[id] = { x: managedX, y: i * (MANAGED_H + 20) } })
  return { frames, chassis, managed }
}

const srv = (id, rackId, unit, heightU, label = id) => ({ id, label, rack: { rackId, unit, heightU } })

console.log('RACK_W =', RACK_W)
console.log('1. heightU scaling (1U+2U back to back):', JSON.stringify(layoutRacks([srv('web-01','rack-1',1,1), srv('db-01','rack-1',2,2)], [])))
console.log('2. duplicate units (factory default, all unit:1):', JSON.stringify(layoutRacks([srv('a','rack-1',1,1), srv('b','rack-1',1,1), srv('c','rack-1',1,1)], [])))
console.log('3. gap + cap-3 fillers (5 servers, 4 gaps):', JSON.stringify(layoutRacks([srv('a','rack-1',1,1), srv('b','rack-1',3,1), srv('c','rack-1',5,1), srv('d','rack-1',7,1), srv('e','rack-1',9,1)], [])))
console.log('4. two frames + two managed:', JSON.stringify(layoutRacks([srv('s1','rack-1',1,1), srv('s2','rack-2',1,1)], ['m1','m2'])))
console.log('5. empty AZ:', JSON.stringify(layoutRacks([], ['m1'])))
```

Real output (`node layoutRacks-check.mjs`, condensed to the load-bearing numbers — full
JSON is reproducible by re-running the script above):

```text
RACK_W = 256

1. heightU scaling:
   chassis.web-01 = { x:18, y:10,  w:220, h:44 }
   chassis.db-01  = { x:18, y:58,  w:220, h:88 }
   frame.pduY = 156   frame.box.h = 184

2. duplicate units (all authored unit:1):
   chassis.a.y = 10   chassis.b.y = 58   chassis.c.y = 106   (48px pitch, zero overlap)

3. gap + cap-3 fillers (a@1,b@3,c@5,d@7,e@9 — 4 real 1-unit gaps):
   blankUnits = [ {y:58,h:44}, {y:154,h:44}, {y:250,h:44} ]   <- exactly 3, not 4
   chassis.e.y = 394   frame.pduY = 448

4. two frames + two managed:
   frame[0] = { rackId:'rack-1', box.x:0   }
   frame[1] = { rackId:'rack-2', box.x:316 }             (= RACK_W + RACK_GAP)
   managed.m1 = { x:632, y:0 }    managed.m2 = { x:632, y:80 }
   (632 = (2-1)*316 + 256 + 60;  80 = MANAGED_H(60) + 20)

5. empty AZ: frames = []   managed.m1 = { x:0, y:0 }

determinism: two calls with identical input produce deep-equal output — verified true.
```

- [ ] **Step 1: Write the failing test `src/lib/world/layoutRacks.test.ts`**

```ts
// src/lib/world/layoutRacks.test.ts
import { describe, it, expect } from 'vitest'
import { layoutRacks, U_PX, CHASSIS_W, RACK_PAD, RAIL_W, RACK_W, RACK_GAP, PDU_H, MANAGED_H } from './layoutRacks'
import type { Server } from './types'

// Minimal Server fixture — layoutRacks only reads .id/.label/.rack, so the rest of the
// Server shape is filled with harmless placeholder values (mirrors the factory's own
// createServer defaults closely enough without dragging in region/az/preset ceremony
// for a function that doesn't care about any of that).
function mkServer(id: string, rackId: string, unit: number, heightU: 1 | 2, label = id): Server {
  return {
    id, label, azId: 'az-1', kind: heightU === 2 ? 'dedicated' : 'vps', catalogId: null,
    specs: { vcpu: 2, threadsPerCore: 1, ramMb: 4096, diskGb: 40, nicMbps: 500 },
    hourlyUsd: 0.02, oversubscriptionRatio: null, burstable: false,
    firewall: [], stacks: [], rack: { rackId, unit, heightU },
  }
}

describe('layoutRacks', () => {
  it('groups servers into frames by rackId sorted by unit', () => {
    // rack-2's server authored FIRST in the input array — frames must still come out
    // rack-1 then rack-2 (sorted by rackId, not input order).
    const layout = layoutRacks([
      mkServer('r2-a', 'rack-2', 1, 1),
      mkServer('b', 'rack-1', 5, 1),
      mkServer('a', 'rack-1', 1, 1),
    ], [])
    expect(layout.frames.map(f => f.rackId)).toEqual(['rack-1', 'rack-2'])
    expect(layout.frames[0].serverIds).toEqual(['a', 'b'])   // sorted by unit ascending
    expect(layout.frames[1].serverIds).toEqual(['r2-a'])
    expect(layout.frames[0].box.x).toBe(0)
    expect(layout.frames[1].box.x).toBe(RACK_W + RACK_GAP)   // 316
    expect(layout.frames[0].box.y).toBe(0)
  })

  it('chassis height scales with heightU', () => {
    const layout = layoutRacks([
      mkServer('web-01', 'rack-1', 1, 1), mkServer('db-01', 'rack-1', 2, 2),
    ], [])
    expect(layout.chassis['web-01']).toEqual({ rackId: 'rack-1', x: RACK_PAD + RAIL_W, y: 10, w: CHASSIS_W, h: U_PX })
    expect(layout.chassis['db-01']).toEqual({ rackId: 'rack-1', x: RACK_PAD + RAIL_W, y: 58, w: CHASSIS_W, h: 2 * U_PX })
  })

  it('duplicate units re-stack without overlap', () => {
    // Mirrors factories.createServer's own default (rack.unit is ALWAYS 1) — this is the
    // common case in practice, not a contrived edge case.
    const layout = layoutRacks([
      mkServer('a', 'rack-1', 1, 1), mkServer('b', 'rack-1', 1, 1), mkServer('c', 'rack-1', 1, 1),
    ], [])
    expect(layout.chassis['a'].y).toBe(10)
    expect(layout.chassis['b'].y).toBe(58)
    expect(layout.chassis['c'].y).toBe(106)
    expect(layout.chassis['b'].y).toBeGreaterThanOrEqual(layout.chassis['a'].y + layout.chassis['a'].h)
    expect(layout.chassis['c'].y).toBeGreaterThanOrEqual(layout.chassis['b'].y + layout.chassis['b'].h)
  })

  it('blank fillers appear in unit gaps, capped at 3 per frame', () => {
    // 5 servers, each separated by a 1-unit gap -> 4 real gaps, only 3 fillers rendered.
    const layout = layoutRacks([
      mkServer('a', 'rack-1', 1, 1), mkServer('b', 'rack-1', 3, 1), mkServer('c', 'rack-1', 5, 1),
      mkServer('d', 'rack-1', 7, 1), mkServer('e', 'rack-1', 9, 1),
    ], [])
    expect(layout.frames[0].blankUnits).toHaveLength(3)
    expect(layout.frames[0].blankUnits[0]).toEqual({ y: 58, h: U_PX })
  })

  it('pdu sits below last chassis', () => {
    const layout = layoutRacks([
      mkServer('web-01', 'rack-1', 1, 1), mkServer('db-01', 'rack-1', 2, 2),
    ], [])
    const last = layout.chassis['db-01']
    expect(layout.frames[0].pduY).toBe(last.y + last.h + RACK_PAD)   // 58+88+10 = 156
    expect(layout.frames[0].box.h).toBe(layout.frames[0].pduY + PDU_H + RACK_PAD)
  })

  it('managed column right of all frames', () => {
    const layout = layoutRacks([
      mkServer('s1', 'rack-1', 1, 1), mkServer('s2', 'rack-2', 1, 1),
    ], ['m1', 'm2'])
    const expectedX = 1 * (RACK_W + RACK_GAP) + RACK_W + RACK_GAP   // (n-1)*316 + 256 + 60 = 632
    expect(layout.managed['m1']).toEqual({ x: expectedX, y: 0 })
    expect(layout.managed['m2']).toEqual({ x: expectedX, y: MANAGED_H + 20 })
  })

  it('deterministic output; empty AZ still lays out managed services', () => {
    expect(layoutRacks([], [])).toEqual({ frames: [], chassis: {}, managed: {} })
    const empty = layoutRacks([], ['m1'])
    expect(empty.frames).toEqual([])
    expect(empty.managed['m1']).toEqual({ x: 0, y: 0 })
    const a = layoutRacks([mkServer('a', 'rack-1', 1, 1)], ['m1'])
    const b = layoutRacks([mkServer('a', 'rack-1', 1, 1)], ['m1'])
    expect(a).toEqual(b)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/world/layoutRacks.test.ts`
Expected: FAIL — `Cannot find module './layoutRacks'`.

- [ ] **Step 3: Write `src/lib/world/layoutRacks.ts`**

```ts
// src/lib/world/layoutRacks.ts
// Pure, deterministic rack-frame layout for the AZ canvas (Phase 4 D7). Replaces
// layoutAzGrid (deleted in Task 5 once AzCanvas stops importing it): servers group into
// per-rack frames (React Flow parent/group nodes, Task 5); chassis stack inside a frame
// by rack.unit, with colliding/duplicate units re-stacking without overlap; blank-U
// filler strips mark unused unit gaps (capped at 3 per frame); a PDU strip sits at the
// frame's bottom. Managed services lay out in a single column right of all frames. No
// React/store/engine imports — lib/ code stays framework-free (see useCompiledWorld.ts's
// own "lib/ must never import app stores" note; layoutRacks goes one further and avoids
// even app-shaped concepts like ids-with-semantics, staying pure geometry).
import type { Server, ServerId } from './types'

export const U_PX = 44
export const CHASSIS_W = 220
export const RACK_PAD = 10          // frame padding around the chassis column (and the gap before the PDU strip)
export const RAIL_W = 8
export const RACK_W = CHASSIS_W + 2 * (RACK_PAD + RAIL_W)   // 256
export const RACK_GAP = 60
export const PDU_H = 18
export const MANAGED_W = 170
export const MANAGED_H = 60

const MAX_FILLERS = 3
const UNIT_PITCH = U_PX + 4          // one rack-unit slot + a 4px gutter, 48px

export interface RackBox { x: number; y: number; w: number; h: number }

export interface RackFrame {
  rackId: string
  box: RackBox                       // absolute canvas coords
  serverIds: ServerId[]              // sorted by rack.unit ascending
  blankUnits: { y: number; h: number }[]   // frame-relative filler strips
  pduY: number                       // frame-relative
}

export interface RackLayout {
  frames: RackFrame[]                            // sorted by rackId
  chassis: Record<ServerId, { rackId: string; x: number; y: number; w: number; h: number }>
  // chassis x/y are FRAME-RELATIVE (React Flow child positions); h = rack.heightU × U_PX
  managed: Record<string, { x: number; y: number }>  // absolute, single column right of frames
}

export function layoutRacks(servers: Server[], managedIds: string[]): RackLayout {
  const byRack = new Map<string, Server[]>()
  for (const s of servers) {
    const list = byRack.get(s.rack.rackId) ?? []
    list.push(s)
    byRack.set(s.rack.rackId, list)
  }
  const rackIds = [...byRack.keys()].sort()

  const frames: RackFrame[] = []
  const chassis: RackLayout['chassis'] = {}

  rackIds.forEach((rackId, frameIndex) => {
    const rackServers = byRack.get(rackId)!
    // Stacking + collision-resolution order: authored unit ascending, label as a
    // deterministic tie-break. This order matters because factories.createServer always
    // seeds unit:1 — every server in a frame collides on the same unit unless the
    // caller/UI has moved it, so re-stacking is the common path, not an edge case.
    const sorted = [...rackServers].sort((a, b) => a.rack.unit - b.rack.unit || a.label.localeCompare(b.label))
    const minUnit = Math.min(...sorted.map(s => s.rack.unit))

    // Re-stack: each server claims max(its own authored unit, the next free slot), so
    // occupied spans never overlap regardless of how many servers share a unit number or
    // how far apart authored units jump.
    let nextUnit = minUnit
    const placed: { server: Server; unit: number }[] = []
    for (const s of sorted) {
      const unit = Math.max(nextUnit, s.rack.unit)
      placed.push({ server: s, unit })
      nextUnit = unit + s.rack.heightU
    }

    const frameX = frameIndex * (RACK_W + RACK_GAP)
    const serverIds: ServerId[] = []
    const blankUnits: { y: number; h: number }[] = []
    let maxBottom = 0

    placed.forEach((p, i) => {
      const y = RACK_PAD + (p.unit - minUnit) * UNIT_PITCH
      const h = p.server.rack.heightU * U_PX
      chassis[p.server.id] = { rackId, x: RACK_PAD + RAIL_W, y, w: CHASSIS_W, h }
      serverIds.push(p.server.id)
      maxBottom = Math.max(maxBottom, y + h)

      const next = placed[i + 1]
      if (next) {
        const curBottomUnit = p.unit + p.server.rack.heightU
        const gapUnits = next.unit - curBottomUnit
        // One filler strip per contiguous gap region (not per empty unit-slot), capped at
        // 3 strips per frame — a server authored far from its neighbors shouldn't draw
        // dozens of filler strips. Chassis positions are unaffected either way.
        if (gapUnits > 0 && blankUnits.length < MAX_FILLERS) {
          blankUnits.push({
            y: RACK_PAD + (curBottomUnit - minUnit) * UNIT_PITCH,
            h: gapUnits * U_PX + (gapUnits - 1) * 4,
          })
        }
      }
    })

    const pduY = maxBottom + RACK_PAD
    const frameH = pduY + PDU_H + RACK_PAD

    frames.push({ rackId, box: { x: frameX, y: 0, w: RACK_W, h: frameH }, serverIds, blankUnits, pduY })
  })

  const n = frames.length
  const framesRightEdge = n === 0 ? 0 : (n - 1) * (RACK_W + RACK_GAP) + RACK_W
  const managedX = n === 0 ? 0 : framesRightEdge + RACK_GAP

  const managed: RackLayout['managed'] = {}
  managedIds.forEach((id, i) => { managed[id] = { x: managedX, y: i * (MANAGED_H + 20) } })

  return { frames, chassis, managed }
}
```

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run src/lib/world/layoutRacks.test.ts` → PASS (7 tests).
Run: `npm run build` → succeeds (new pure module, nothing imports it yet).
Run: `npx vitest run` → all existing suites still green (untouched — `layoutAz.ts` is
still in place and still the one AzCanvas imports until Task 5).

- [ ] **Step 5: Commit**

```bash
git add src/lib/world/layoutRacks.ts src/lib/world/layoutRacks.test.ts
git commit -m "feat(world): pure rack-frame layout for the AZ canvas"
```

---

## Task 5: Rack frame + chassis nodes, AzCanvas rewire `[sonnet]`

**Files:** create `src/app/world/RackNodes.tsx` (+ `src/app/world/RackNodes.test.tsx`);
REWIRE `src/app/world/AzCanvas.tsx`; DELETE `src/app/world/WorldServerNode.tsx`,
`src/lib/world/layoutAz.ts`, and `src/lib/world/layoutAz.test.ts`.

**Grounding:**

- **Grep-verified importer scope (real commands, real output — this is why the deletions
  below are safe):**

  ```text
  $ grep -rn "WorldServerNode\|WorldManagedNode" src/ --include="*.tsx" --include="*.ts"
  src/app/world/AzSimOverlay.tsx:11:  // Approximate on-screen footprint of WorldServerNode/WorldManagedNode. ...  (COMMENT ONLY)
  src/app/world/AzCanvas.tsx:11:import { WorldServerNode, WorldManagedNode } from './WorldServerNode'
  src/app/world/AzCanvas.tsx:15:const nodeTypes = { worldServer: WorldServerNode, worldManaged: WorldManagedNode }
  src/app/world/WorldServerNode.tsx: (its own definitions)

  $ grep -rn "layoutAz" src/ --include="*.tsx" --include="*.ts"
  src/app/world/AzCanvas.tsx:10:import { layoutAzGrid } from '../../lib/world/layoutAz'
  src/app/world/AzCanvas.tsx:29:    const pos = layoutAzGrid(...)
  src/lib/world/layoutAz.ts: (its own definitions)
  src/lib/world/layoutAz.test.ts: (its own tests, importing only from './layoutAz')
  ```

  `AzCanvas.tsx` is the **only** real importer of both `WorldServerNode`/`WorldManagedNode`
  and `layoutAzGrid`. `AzSimOverlay.tsx` only mentions `WorldServerNode` in a comment and
  references the node-type *strings* `'worldServer'`/`'worldManaged'` (Task 6 territory).
  Once this task rewires `AzCanvas.tsx` off both, `WorldServerNode.tsx`, `layoutAz.ts`, and
  `layoutAz.test.ts` have zero importers left and are deleted outright (this goes slightly
  beyond the skeleton's literal Task 5 file list, which names only `WorldServerNode.tsx`
  for deletion — Task 4's own note says *"Leave layoutAz.ts in place until T5 removes its
  last importer, then T5 deletes it"*, so the two `layoutAz*` deletions belong here too;
  flagged as a judgment call).
- `RackFrameNodeData`/`RackChassisNodeData` field lists below are EXACT from the skeleton
  (lines 276–292) plus one additive field on the frame data (see judgment call below).
- **xyflow v12.11.1 parent/child API, verified against the installed package** (not
  memory): `@xyflow/system/dist/esm/types/nodes.d.ts` — `NodeBase` has `width?: number`,
  `height?: number`, `parentId?: string`, `zIndex?: number`,
  `extent?: 'parent' | CoordinateExtent | null`, `selectable?: boolean`,
  `draggable?: boolean` as first-class top-level `Node` properties (not `style`). React
  Flow requires parent nodes to appear **before** their children in the `nodes` array —
  the node list built below is `[...frameNodes, ...chassisNodes, ...managedNodes]`.
- Data flow into each chassis (all computed in `AzCanvas.tsx`, all already-available
  pieces threaded through slightly differently):
  - `health` — unchanged: `batch?.servers[server.id]?.health`.
  - `internalBlocked` — unchanged: the existing `internalBlockedByServer` map from the
    verbatim-copied aggregation block.
  - `chips` — same `compiled.instances` filter as before, narrowed to
    `{ color, name }[]` per the new interface ("for the tooltip/title only" — rendered as
    a native `title=` attribute on the chassis root, not visible chip rows; that visual
    space is now the drive-bay/vent/micro-bar chrome per D8).
  - `metrics.{cpuMean,ramFrac,diskIo,nicFrac}` — straightforward derivations off
    `ServerMetrics` (`coreUtilization` mean, `ramUsedMb/ramTotalMb`, `diskIoFraction`,
    `(nicInMbps+nicOutMbps)/specs.nicMbps`).
  - **`metrics.rps` has no direct source** — `ServerMetrics` (worldEngine/types.ts) has
    NO `rps` field (only `Az/Region/WorldMetrics` do). This plan derives it by summing
    `batch.instances[instanceId]?.rps` over every `ServiceInstance` resident on that
    server (`compiled.instances` filtered by `serverId`) — the only sensible source,
    verified against the frozen contract shape; not spelled out verbatim in the skeleton
    or grounding doc, called out here explicitly.
  - `noisy` — `useSimulationStore(s => s.events)` filtered to `kind === 'noisy_neighbor'`,
    `affected.includes(server.id)`, and within 30s of the *display* simMs
    (`(scrubBatch ?? latestBatch)?.simMs`, per D1 — same scrub-aware pattern the rest of
    the app uses, e.g. the existing `batch` selector in this very file).
- **Judgment call — PDU kW needs data `RackFrameNodeData` doesn't carry.** D8/skeleton:
  `PDU · <n>kW` where `kW = Σ resident chassis vcpu × 0.05` (1 decimal). The frame's own
  exact data (`rackId, azLabel, blankUnits, pduY`) has no server/vcpu info. `AzCanvas`
  already has `frame.serverIds` + the full `servers` list, so it computes the wattage and
  passes it as an additive `pduKw: number` field on `RackFrameNodeData` (the interface's
  `[k: string]: unknown` escape hatch is exactly what `WorldServerNodeData` already used
  for its own additive optional fields — same pattern, just declared as a real field here
  for type safety instead of an `unknown` runtime check).
- **Judgment call — drive-bay count formula vs. the mockup's hand-drawn example.** The
  skeleton states the drive-bay count formula twice, identically: `min(8, 2×heightU+2)`.
  For `heightU=1` this gives 4 (matches the mockup's web-01 example exactly). For
  `heightU=2` it gives `min(8,6)=6` — but the mockup's own db-primary (2U) illustration
  hand-draws **8** bays (`repeat(8,1fr)`, mockup line 97), which would actually match a
  simpler `4 × heightU` formula instead. Since `heightU` only ever takes the values 1 or 2
  in this app (vps→1, dedicated→2 per `createServer`), this is a real, only-partially-
  overlapping discrepancy between the skeleton's explicit prose (repeated twice, so not a
  stray typo) and the mockup's illustration. Per the brief's "signatures/semantics are
  exact — do not redesign," this plan implements the skeleton's literal formula
  (`min(8, 2×heightU+2)`, giving 6 bays for a 2U chassis) rather than silently matching
  the mockup. **Flagged for review** — if the mockup's 8-bay 2U look is actually wanted,
  swap the one-line formula in `RackChassisNode`.
- **Judgment call — LED trio and micro-bars rendered uniformly.** The mockup's three
  hand-drawn chassis examples are inconsistent with each other (web-01 shows 3 LEDs + 3
  micro-bars; db-primary shows 2 LEDs + a single vent-style bar + a text summary instead
  of 3 bars; cache-01 shows 2 LEDs + 2 bars). The skeleton's prose is unambiguous ("header
  line + LED trio (pwr/act/net)" and "micro-bars (cpu/ram/io)") — this plan renders the
  full trio and all 3 bars on **every** chassis regardless of U-height, treating the
  skeleton's prose as authoritative over the mockup's illustrative inconsistency.
- **Judgment call — act-LED blink via framer-motion, not a new CSS keyframe.** Phase 3
  precedent exists for BOTH mechanisms (`HardwarePlatform.tsx` added a raw
  `@keyframes spin` to `src/index.css`; `PacketLayer.tsx`/`AzSimOverlay.tsx` gate
  animation via framer-motion's `useReducedMotion` inside canvas draw code). This plan
  uses framer-motion's `motion.span` + `animate`/`transition` for the 0.8s blink, keeping
  the change fully scoped to `RackNodes.tsx` with no edit to the shared `index.css` hub
  file. Either approach is defensible; this is the lower-blast-radius one.
- R2 (colors): health/status → theme tokens (`var(--color-success|warning|danger)`); pure
  scene chrome (rail dots, PDU/bay/vent backgrounds, chassis gradients) → local hex
  consts, cited from grounding §9 (mockup `views-overview-v2.html` lines 52–148).
- `nav.store.ts`: `goServer(regionId, azId, serverId)` — unchanged signature, called from
  `onNodeClick` exactly as today, just gated on `node.type === 'worldChassis'` now instead
  of `'worldServer'`.

- [ ] **Step 1: Write the failing jsdom test `src/app/world/RackNodes.test.tsx`**

```tsx
// src/app/world/RackNodes.test.tsx
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ReactFlowProvider, type NodeProps } from '@xyflow/react'
import { RackFrameNode, RackChassisNode, type RackFrameNodeData, type RackChassisNodeData } from './RackNodes'
import { createRegion, createAz, createServer } from '../../lib/world/factories'
import { getPreset } from '../../lib/world/instanceCatalog'

// RackFrameNode/RackChassisNode only destructure `data` from their props — building a
// fully-compliant NodeProps object (13 required fields) for every test would be pure
// ceremony, so this casts through `data` the same way production code already casts
// `data as WorldServerNodeData` (see the deleted WorldServerNode.tsx).
function nodeProps<T>(data: T): NodeProps {
  return { data } as unknown as NodeProps
}

// RackChassisNode renders <Handle> (unlike RackFrameNode), and @xyflow/react's Handle
// reaches into React Flow's internal store context — verified live: it throws "Seems
// like you have not used ReactFlowProvider as an ancestor" if rendered bare. Wrap every
// chassis render (RackFrameNode has no Handle and needs no wrapper).
function renderChassis(data: RackChassisNodeData) {
  return render(<ReactFlowProvider><RackChassisNode {...nodeProps(data)} /></ReactFlowProvider>)
}

// createServer only needs a valid azId string plus a preset — it never reads the doc
// itself, so this helper skips assembling a full WorldDoc (would be unused otherwise).
function seedServer(presetId: string, label: string) {
  const region = createRegion('us-east-1')
  const az = createAz(region.id, 'us-east-1a')
  const server = createServer(az.id, getPreset(presetId)!)
  server.label = label
  return server
}

describe('RackChassisNode', () => {
  it('chassis renders U-height, LEDs, and micro-bars from metrics', () => {
    const server = seedServer('dedicated-8', 'db-primary')   // heightU 2, vcpu 8, 32G
    const data: RackChassisNodeData = {
      server, chips: [{ color: '#4A9EFF', name: 'api' }], internalBlocked: 0, health: 'healthy',
      metrics: { cpuMean: 0.38, ramFrac: 0.52, diskIo: 0.12, nicFrac: 0.2, rps: 40 }, noisy: false,
    }
    renderChassis(data)
    expect(screen.getByText(/db-primary/)).toBeInTheDocument()
    expect(screen.getByText(/2U/)).toBeInTheDocument()
    // min(8, 2×heightU+2) at heightU=2 -> 6 (skeleton's literal formula — see the plan's
    // flagged discrepancy note against the mockup's own 8-bay 2U illustration).
    expect(screen.getAllByTestId('drive-bay')).toHaveLength(6)
    expect(screen.getAllByTestId('chassis-led')).toHaveLength(3)
    expect(screen.getByTestId('micro-bar-cpu').style.height).toBe('38%')
    expect(screen.getByTestId('micro-bar-ram').style.height).toBe('52%')
    expect(screen.getByTestId('micro-bar-io').style.height).toBe('12%')
  })

  it('noisy tag appears for recent noisy_neighbor', () => {
    const server = seedServer('vps-small', 'cache-01')
    const base: RackChassisNodeData = { server, chips: [], internalBlocked: 0, metrics: null, noisy: false }
    const { rerender } = renderChassis(base)
    expect(screen.queryByText(/noisy neighbor/)).not.toBeInTheDocument()
    rerender(<ReactFlowProvider><RackChassisNode {...nodeProps({ ...base, noisy: true })} /></ReactFlowProvider>)
    expect(screen.getByText(/noisy neighbor/)).toBeInTheDocument()
  })

  it('blocked badge carries over', () => {
    const server = seedServer('vps-small', 'web-01')
    const data: RackChassisNodeData = { server, chips: [], internalBlocked: 2, metrics: null, noisy: false }
    renderChassis(data)
    expect(screen.getByText(/✕ 2 blocked internal path/)).toBeInTheDocument()
  })
})

describe('RackFrameNode', () => {
  it('frame renders caption, fillers, and pdu', () => {
    const data: RackFrameNodeData = {
      rackId: 'rack-1', azLabel: 'us-east-1a',
      blankUnits: [{ y: 58, h: 44 }], pduY: 106, pduKw: 0.4,
    }
    render(<RackFrameNode {...nodeProps(data)} />)
    expect(screen.getByText(/RACK rack-1/)).toBeInTheDocument()
    expect(screen.getByText(/us-east-1a/)).toBeInTheDocument()
    expect(screen.getAllByTestId('blank-filler')).toHaveLength(1)
    expect(screen.getByText(/PDU/)).toBeInTheDocument()
    expect(screen.getByText(/0\.4kW/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/world/RackNodes.test.tsx`
Expected: FAIL — `Cannot find module './RackNodes'`.

- [ ] **Step 3: Write `src/app/world/RackNodes.tsx`**

```tsx
// src/app/world/RackNodes.tsx
// React Flow node components for the AZ canvas's rack visualization (Phase 4 D7/D8).
// Servers stack into per-rack RackFrameNode groups (parent nodes, non-interactive
// backdrop); each server renders as a RackChassisNode child (parentId + extent:'parent',
// frame-relative position from layoutRacks). WorldManagedNode is unchanged, just
// relocated here from the deleted WorldServerNode.tsx (managed services aren't
// rack-mounted — dashed border, absolute position, untouched by this phase).
import { type ReactElement } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { motion, useReducedMotion } from 'framer-motion'
import type { Server } from '../../lib/world/types'
import type { HealthState } from '../../lib/worldEngine/types'
import { RACK_PAD, RAIL_W, CHASSIS_W, PDU_H } from '../../lib/world/layoutRacks'

// ─── RackFrameNode ──────────────────────────────────────────────────────────────
// Non-interactive rack backdrop: mounting rails, caption, blank-U fillers, PDU strip.
// Chassis are separate sibling React Flow nodes (not DOM children of this component) —
// AzCanvas positions them via layoutRacks; this component only paints the chrome behind
// and around them. Scene-chrome hexes below are LOCAL consts (R2) — no semantic meaning.

const FRAME_BG = 'linear-gradient(180deg,#0A0C10,#080A0D)'
const FRAME_BORDER = '#232833'
const RAIL_DOTS = 'radial-gradient(circle,#3A4150 1.1px,transparent 1.3px)'
const FILLER_BG = 'repeating-linear-gradient(90deg,#0B0E13 0 6px,#0D1119 6px 12px)'
const PDU_BG = '#0E1218'

export interface RackFrameNodeData {
  rackId: string
  azLabel: string
  blankUnits: { y: number; h: number }[]
  pduY: number
  // Additive beyond the skeleton's 4 named fields — AzCanvas computes it (Σ resident
  // chassis vcpu × 0.05) since this data shape alone doesn't carry server/vcpu info.
  pduKw: number
  [k: string]: unknown
}

export function RackFrameNode({ data }: NodeProps): ReactElement {
  const { rackId, azLabel, blankUnits, pduY, pduKw } = data as RackFrameNodeData

  return (
    <div style={{
      position: 'relative', width: '100%', height: '100%', boxSizing: 'border-box',
      background: FRAME_BG, border: `1px solid ${FRAME_BORDER}`, borderRadius: 6,
      font: '9px var(--font-mono)', pointerEvents: 'none',
    }}>
      <div style={{
        position: 'absolute', top: -16, left: 0, width: '100%', textAlign: 'center',
        color: '#64748B', letterSpacing: '0.08em', fontSize: 9, whiteSpace: 'nowrap',
      }}>
        RACK {rackId} · {azLabel}
      </div>

      {/* mounting rails */}
      <div style={{ position: 'absolute', left: RACK_PAD, top: RACK_PAD, bottom: RACK_PAD, width: RAIL_W, backgroundImage: RAIL_DOTS, backgroundSize: '8px 9px', borderRadius: 2 }} />
      <div style={{ position: 'absolute', left: RACK_PAD + RAIL_W + CHASSIS_W, top: RACK_PAD, bottom: RACK_PAD, width: RAIL_W, backgroundImage: RAIL_DOTS, backgroundSize: '8px 9px', borderRadius: 2 }} />

      {blankUnits.map((b, i) => (
        <div key={i} data-testid="blank-filler" style={{
          position: 'absolute', left: RACK_PAD + RAIL_W, top: b.y, width: CHASSIS_W, height: b.h,
          background: FILLER_BG, border: '1px dashed #1E242E', borderRadius: 2, opacity: 0.6,
        }} />
      ))}

      <div style={{
        position: 'absolute', left: RACK_PAD + RAIL_W, top: pduY, width: CHASSIS_W, height: PDU_H,
        background: PDU_BG, border: `1px solid ${FRAME_BORDER}`, borderRadius: 3, padding: '0 5px',
        boxSizing: 'border-box', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span style={{ color: '#475569', fontSize: 7 }}>PDU · {pduKw.toFixed(1)}kW</span>
        <span style={{ display: 'flex', gap: 3 }}>
          <span style={{ width: 3, height: 3, borderRadius: '50%', background: '#22C55E' }} />
          <span style={{ width: 3, height: 3, borderRadius: '50%', background: '#22C55E' }} />
        </span>
      </div>
    </div>
  )
}

// ─── RackChassisNode ────────────────────────────────────────────────────────────

const HEALTH_COLOR: Record<HealthState, string> = {
  healthy: 'var(--color-success)', degraded: 'var(--color-warning)', down: 'var(--color-danger)',
}
const CHASSIS_BORDER: Record<HealthState, string> = {
  healthy: '1px solid #2A303C', degraded: '1px solid #F59E0B55', down: '1px solid var(--color-danger)',
}
const BAY_BG = '#0D1017', BAY_BORDER = '#2A303C'
const VENT_BG = 'repeating-linear-gradient(90deg,#1E2430 0 2px,#0D1017 2px 4px)'

export interface RackChassisNodeData {
  server: Server
  chips: { color: string; name: string }[]      // for the tooltip/title only
  internalBlocked: number
  health?: HealthState
  metrics?: { cpuMean: number; ramFrac: number; diskIo: number; nicFrac: number; rps: number } | null
  noisy: boolean                                 // noisy_neighbor event within 30s
  [k: string]: unknown
}

export function RackChassisNode({ data }: NodeProps): ReactElement {
  const { server, chips, internalBlocked, health, metrics, noisy } = data as RackChassisNodeData
  const reduced = useReducedMotion()
  const heightU = server.rack.heightU
  const gb = Math.round(server.specs.ramMb / 1024)
  // D8/mockup formula, verbatim from the skeleton — only ever evaluated at heightU 1 or 2
  // in this app (vps/dedicated). See the plan's flagged note: this undershoots the
  // mockup's own hand-drawn 2U example (8 bays) — implemented literally per "do not
  // redesign"; swap this one line if the mockup's look is what's actually wanted.
  const bays = Math.min(8, 2 * heightU + 2)
  const litBays = metrics ? Math.min(bays, Math.ceil(metrics.diskIo * bays)) : 0
  const h = health ?? 'healthy'
  const blinkAct = !reduced && !!metrics && metrics.rps > 0
  const netLit = !!metrics && metrics.nicFrac > 0.05

  return (
    <div
      title={chips.length ? chips.map(c => c.name).join(', ') : 'empty'}
      style={{
        width: '100%', height: '100%', boxSizing: 'border-box', overflow: 'hidden',
        background: 'linear-gradient(180deg,#1B202B,#12161E)', border: CHASSIS_BORDER[h],
        borderRadius: 3, padding: '4px 5px', font: '8px var(--font-mono)', color: '#E2E8F0',
        cursor: 'pointer',
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {server.label} <span style={{ color: '#64748B' }}>· {heightU}U · {server.kind} · {server.specs.vcpu}vCPU/{gb}G</span>
          {noisy && <span style={{ color: '#F59E0B' }}> ▲ noisy neighbor</span>}
        </span>
        <span style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
          <span data-testid="chassis-led" style={{ width: 4, height: 4, borderRadius: '50%', background: HEALTH_COLOR[h], boxShadow: `0 0 4px ${HEALTH_COLOR[h]}` }} />
          <motion.span
            data-testid="chassis-led"
            style={{ width: 4, height: 4, borderRadius: '50%', background: '#F59E0B', boxShadow: '0 0 4px #F59E0B' }}
            animate={blinkAct ? { opacity: [1, 0.3, 1] } : { opacity: 1 }}
            transition={blinkAct ? { duration: 0.8, repeat: Infinity, ease: 'easeInOut' } : undefined}
          />
          <span data-testid="chassis-led" style={{ width: 4, height: 4, borderRadius: '50%', background: '#4A9EFF', boxShadow: netLit ? '0 0 4px #4A9EFF' : 'none', opacity: netLit ? 1 : 0.25 }} />
        </span>
      </div>
      <div style={{ display: 'flex', gap: 3, marginTop: 3, alignItems: 'center' }}>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${bays}, 1fr)`, gap: 1.5 }}>
          {Array.from({ length: bays }).map((_, i) => (
            <div key={i} data-testid="drive-bay" style={{ height: 7, background: BAY_BG, border: `0.5px solid ${BAY_BORDER}`, borderRadius: 1, position: 'relative' }}>
              {i < litBays && <span style={{ position: 'absolute', right: 1, top: 2, width: 2, height: 2, borderRadius: '50%', background: '#22C55E' }} />}
            </div>
          ))}
        </div>
        <div style={{ flex: 1, height: 9, background: VENT_BG, borderRadius: 1, opacity: 0.9 }} />
        <div style={{ display: 'flex', gap: 1.5, alignItems: 'flex-end', height: 9 }}>
          <div data-testid="micro-bar-cpu" style={{ width: 3, height: `${Math.round((metrics?.cpuMean ?? 0) * 100)}%`, background: '#4A9EFF', borderRadius: 1 }} />
          <div data-testid="micro-bar-ram" style={{ width: 3, height: `${Math.round((metrics?.ramFrac ?? 0) * 100)}%`, background: '#F5A623', borderRadius: 1 }} />
          <div data-testid="micro-bar-io" style={{ width: 3, height: `${Math.round((metrics?.diskIo ?? 0) * 100)}%`, background: '#2DD4BF', borderRadius: 1 }} />
        </div>
      </div>
      {internalBlocked > 0 && (
        <div style={{ color: 'var(--color-danger)', fontSize: 7, marginTop: 2 }}>
          ✕ {internalBlocked} blocked internal path{internalBlocked > 1 ? 's' : ''}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

// ─── WorldManagedNode ───────────────────────────────────────────────────────────
// Unchanged from the deleted WorldServerNode.tsx — managed services aren't rack-mounted.

export function WorldManagedNode({ data }: NodeProps) {
  const { label, nodeType, port } = data as { label: string; nodeType: string; port: number }
  return (
    <div style={{
      width: 170, background: 'var(--color-node-base)', border: '1px dashed var(--color-text-muted)',
      borderRadius: 8, padding: 10, font: '11px var(--font-mono)', color: 'var(--color-text-primary)',
    }}>
      <Handle type="target" position={Position.Left} />
      <strong>{label}</strong>
      <div style={{ color: 'var(--color-text-muted)', fontSize: 10 }}>managed · {nodeType} · :{port}</div>
    </div>
  )
}
```

- [ ] **Step 4: Rewire `src/app/world/AzCanvas.tsx`**

The edge-aggregation block (`agg`/`internalBlockedByServer`/`inAz`/`managedHere` + the
`for (const p of compiled.paths)` loop) below is **copied verbatim** from the current
file — only the node-building code around it changes.

```tsx
// src/app/world/AzCanvas.tsx
// Read-only render of the focused AZ from the compiled world. Instance-level paths are
// aggregated to server-pair edges; any blocked path turns the whole edge red/dashed.
// Servers stack into per-rack frame nodes (React Flow parent/group nodes); chassis are
// frame-relative child nodes positioned by layoutRacks. Managed services stay absolute,
// in a column right of the frames.
import { useMemo } from 'react'
import { ReactFlow, ReactFlowProvider, Background, type Node, type Edge } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { useSimulationStore } from '../store/simulation.store'
import { useCompiledWorld } from './useCompiledWorld'
import { layoutRacks } from '../../lib/world/layoutRacks'
import { RackFrameNode, RackChassisNode, WorldManagedNode } from './RackNodes'
import { AzSimOverlay } from './AzSimOverlay'
import { InspectorV2 } from './InspectorV2'

const nodeTypes = { worldRackFrame: RackFrameNode, worldChassis: RackChassisNode, worldManaged: WorldManagedNode }
const NOISY_WINDOW_MS = 30_000
const PDU_KW_PER_VCPU = 0.05

export function AzCanvas() {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const batch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const events = useSimulationStore(s => s.events)
  const { regionId, azId, goServer } = useNavStore()

  const { nodes, edges } = useMemo(() => {
    if (!azId || !regionId) return { nodes: [] as Node[], edges: [] as Edge[] }
    const servers = Object.values(doc.servers).filter(s => s.azId === azId)
    const managed = Object.values(doc.managedServices).filter(m =>
      (m.scope.kind === 'az' && m.scope.azId === azId) ||
      (m.scope.kind === 'region' && m.scope.regionId === regionId))
    const azLabel = doc.azs[azId]?.label ?? azId
    const layout = layoutRacks(servers, managed.map(m => m.id))
    const displaySimMs = batch?.simMs ?? 0

    // Aggregate instance-level compiled paths into one edge per (fromServer, target).
    // Same-server blocked paths never become edges — they surface as a badge on the server node.
    const agg = new Map<string, { source: string; target: string; total: number; blocked: number; reason: string | null }>()
    const internalBlockedByServer = new Map<string, number>()
    const inAz = new Set(servers.map(s => s.id))
    const managedHere = new Set(managed.map(m => m.id))
    for (const p of compiled.paths) {
      const from = compiled.instances[p.fromInstanceId]
      if (!from || !inAz.has(from.serverId)) continue
      let targetId: string
      if (p.to.kind === 'managed') {
        if (!managedHere.has(p.to.managedServiceId)) continue
        targetId = p.to.managedServiceId
      } else {
        const to = compiled.instances[p.to.instanceId]
        if (!to || !inAz.has(to.serverId)) continue // cross-AZ links render at region level (Phase 4)
        if (to.serverId === from.serverId) {
          // Same-server paths draw no edge; blocked ones (e.g. docker network-isolation) badge the server node.
          if (p.verdict === 'blocked') {
            internalBlockedByServer.set(from.serverId, (internalBlockedByServer.get(from.serverId) ?? 0) + 1)
          }
          continue
        }
        targetId = to.serverId
      }
      const key = `${from.serverId}->${targetId}`
      const entry = agg.get(key) ?? { source: from.serverId, target: targetId, total: 0, blocked: 0, reason: null }
      entry.total++
      if (p.verdict === 'blocked') {
        entry.blocked++
        entry.reason = entry.reason ?? p.blockReason?.kind ?? 'blocked'
      }
      agg.set(key, entry)
    }

    const serverById = new Map(servers.map(s => [s.id, s]))

    const frameNodes: Node[] = layout.frames.map(frame => {
      const kw = frame.serverIds.reduce((sum, sid) => sum + (serverById.get(sid)?.specs.vcpu ?? 0), 0) * PDU_KW_PER_VCPU
      return {
        id: `frame:${frame.rackId}`, type: 'worldRackFrame' as const,
        position: { x: frame.box.x, y: frame.box.y },
        width: frame.box.w, height: frame.box.h,
        selectable: false, zIndex: -1,
        data: { rackId: frame.rackId, azLabel, blankUnits: frame.blankUnits, pduY: frame.pduY, pduKw: kw },
      }
    })

    const chassisNodes: Node[] = servers.map(server => {
      const box = layout.chassis[server.id]
      const serverMetrics = batch?.servers[server.id]
      const residentInstances = Object.values(compiled.instances).filter(i => i.serverId === server.id)
      const metrics = serverMetrics ? {
        cpuMean: serverMetrics.coreUtilization.length
          ? serverMetrics.coreUtilization.reduce((a, b) => a + b, 0) / serverMetrics.coreUtilization.length
          : 0,
        ramFrac: serverMetrics.ramTotalMb > 0 ? serverMetrics.ramUsedMb / serverMetrics.ramTotalMb : 0,
        diskIo: serverMetrics.diskIoFraction,
        nicFrac: server.specs.nicMbps > 0 ? (serverMetrics.nicInMbps + serverMetrics.nicOutMbps) / server.specs.nicMbps : 0,
        rps: residentInstances.reduce((sum, i) => sum + (batch?.instances[i.id]?.rps ?? 0), 0),
      } : null
      const noisy = events.some(e =>
        e.kind === 'noisy_neighbor' && e.affected.includes(server.id) &&
        e.simMs <= displaySimMs && displaySimMs - e.simMs <= NOISY_WINDOW_MS)
      return {
        id: server.id, type: 'worldChassis' as const,
        parentId: `frame:${server.rack.rackId}`, extent: 'parent' as const, draggable: false,
        position: { x: box.x, y: box.y }, width: box.w, height: box.h,
        data: {
          server,
          chips: residentInstances.map(i => {
            const bp = doc.blueprints[i.blueprintId]
            return { color: bp?.color ?? '#888', name: bp?.name ?? '?' }
          }),
          internalBlocked: internalBlockedByServer.get(server.id) ?? 0,
          health: serverMetrics?.health,
          metrics,
          noisy,
        },
      }
    })

    const managedNodes: Node[] = managed.map(m => ({
      id: m.id, type: 'worldManaged' as const, position: layout.managed[m.id],
      data: { label: m.label, nodeType: m.nodeType, port: m.port },
    }))

    // Parents (frames) must precede their children (chassis) in React Flow's node array.
    const nodes: Node[] = [...frameNodes, ...chassisNodes, ...managedNodes]

    const edges: Edge[] = [...agg.entries()].map(([key, e]) => ({
      id: key,
      source: e.source,
      target: e.target,
      label: e.blocked > 0 ? `✕ ${e.reason}` : `${e.total} dep${e.total > 1 ? 's' : ''}`,
      style: e.blocked > 0
        ? { stroke: 'var(--color-danger)', strokeDasharray: '5 4' }
        : { stroke: 'var(--color-success)' },
      labelStyle: { fill: e.blocked > 0 ? 'var(--color-danger)' : 'var(--color-text-muted)', fontSize: 10, fontFamily: 'var(--font-mono)' },
    }))

    return { nodes, edges }
  }, [doc, compiled, azId, regionId, batch, events])

  if (!azId || !regionId) return null

  return (
    // ReactFlowProvider wraps both <ReactFlow> and its sibling <AzSimOverlay>: React Flow's own
    // internal provider (established inside <ReactFlow>) only covers elements passed as ITS
    // children (e.g. <Background>), not later JSX siblings — useReactFlow()/useViewport() in a
    // sibling throw without an ambient provider. Wrapping here supplies one context for both.
    <ReactFlowProvider>
      <div style={{ width: '100%', height: '100%', position: 'relative' }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          nodesDraggable={false}
          nodesConnectable={false}
          onNodeClick={(_, node) => {
            if (node.type === 'worldChassis') goServer(regionId, azId, node.id)
          }}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} color="var(--color-canvas-dots)" />
        </ReactFlow>
        <AzSimOverlay azId={azId} />
        <InspectorV2 azId={azId} />
      </div>
    </ReactFlowProvider>
  )
}
```

- [ ] **Step 5: Delete the superseded files**

```bash
rm src/app/world/WorldServerNode.tsx
rm src/lib/world/layoutAz.ts
rm src/lib/world/layoutAz.test.ts
# Re-verify nothing else references them (expect zero matches other than this fragment/history):
grep -rn "WorldServerNode\|layoutAzGrid\|from '\.\./\.\./lib/world/layoutAz'\|from '\./layoutAz'" src/
```

Expected: the `grep` prints nothing (empty output).

- [ ] **Step 6: Run tests + build**

Run: `npx vitest run src/app/world/RackNodes.test.tsx` → PASS (4 tests).
Run: `npm run build` → succeeds (confirms no dangling imports of the deleted files).
Run: `npx vitest run` → all suites green.

- [ ] **Step 7: Live Playwright smoke (controller-run, port 1420)**

1. `npm run dev` (background); wait for `Local:   http://localhost:1420/`.
2. `browser_navigate` → `http://localhost:1420`; `browser_click` "New World".
3. World panel, **Topology** tab (default active): click "+ Region" (default selection is
   fine), then "+ AZ". In the per-AZ preset row, leave the default preset selected ("VPS
   Medium (4 vCPU / 8 GB)") and click "+ Server" — a 1U server. Change the preset select
   to "Dedicated 8-core / 32 GB" and click "+ Server" again — a 2U server. Both default to
   `rack-1`/`unit:1` (factory default) — same frame, colliding units, exercising the
   re-stack logic live.
4. **Placements** tab: pick a managed-service type (default "SQL DB"), set the scope
   select to the AZ just created (`az <label>`), click "+ Add" — confirms "managed node
   still dashed" visually in the next step.
5. Navigate in: `browser_click` the region card (its `catalogId`, e.g. `us-east-1`) on the
   Globe view, then `browser_click` the AZ card (its `label`, e.g. `us-east-1a`) on the
   Region view.
6. `browser_snapshot` → confirm: a rack frame captioned `RACK rack-1 · us-east-1a`; two
   stacked chassis of visibly different heights (1U vps server on top, 2U dedicated server
   below it, no overlap); the managed service node still present with a dashed border;
   PDU strip text `PDU · <n>kW` at the bottom of the frame.
7. Click "Simulate" (header). Wait ~2s. `browser_take_screenshot` → scratchpad
   `task5-rack-chassis-live.png` — visually confirm drive-bay LEDs and cpu/ram/io
   micro-bars reflect non-zero live metrics, and the amber "act" LED is mid-blink on at
   least one chassis (reduced-motion off by default in a fresh browser context).
8. `browser_click` one of the chassis (its label, e.g. `db-primary`) → confirm navigation
   lands on the server interior (Phase 3's `ServerView`: assert `eth0`/`FIREWALL` text via
   `browser_snapshot`, matching the Phase 3 smoke precedent).
9. `browser_console_messages` → assert ZERO error-level entries across the whole flow.
10. Stop the dev server.

- [ ] **Step 8: Commit**

```bash
git add src/app/world/RackNodes.tsx src/app/world/RackNodes.test.tsx src/app/world/AzCanvas.tsx
git rm src/app/world/WorldServerNode.tsx src/lib/world/layoutAz.ts src/lib/world/layoutAz.test.ts
git commit -m "feat(az-canvas): rack frames and realistic chassis nodes replace flat server cards"
```

---

## Task 6: AzSimOverlay v2 — absolute coords, measured dims, imperative viewport `[sonnet]`

**Files:** modify `src/app/world/AzSimOverlay.tsx`. No new test file — see the explicit
"no jsdom seam" rationale below; the live smoke is this task's gate.

**Grounding:**

- **Why this fix is needed (D9):** chassis are now React Flow CHILD nodes (`parentId` +
  `extent:'parent'`, Task 5), so a plain `node.position` is **parent-relative**, not
  absolute — the old code's `node.position.x/y` math silently breaks for every chassis
  once frames exist. `getInternalNode(id).internals.positionAbsolute` resolves the true
  canvas position correctly for both parented and top-level nodes.
- **xyflow v12.11.1 API, verified against the installed package (not memory):**
  - `@xyflow/system/dist/esm/types/nodes.d.ts` (`InternalNodeBase`, lines ~83–100):
    `internals: { positionAbsolute: XYPosition; ... }` and `measured: { width?: number;
    height?: number }` — both present on every `InternalNode`, parented or not.
  - `@xyflow/react/dist/esm/index.js` (`useReactFlow`, ~line 1042): `getInternalNode =
    (id) => store.getState().nodeLookup.get(id)` is defined inside a
    `useMemo(() => {...}, [])` block (`generalHelper`) — **referentially stable** across
    re-renders for the component's whole lifetime.
  - `useViewportHelper` (same file, ~line 500) similarly wraps its `getViewport: () => {
    const [x,y,zoom] = store.getState().transform; ... }` in a `useMemo` keyed on the
    (itself-stable) `store` object — **`getViewport` is also referentially stable.**
  - Net result: destructuring `const { getInternalNode, getViewport } = useReactFlow()`
    gives two functions whose *identity* never changes across re-renders, even though
    `useReactFlow()`'s own returned wrapper object gets recreated once early on
    (`viewportInitialized` flips). This is exactly why it's correct and safe to list both
    in the effect's dependency array — they satisfy exhaustive-deps without ever actually
    causing the effect to re-run on their account. (Confirms the grounding doc's claim
    with the real source, not just citing it.)
  - `Viewport = { x: number; y: number; zoom: number }` (`@xyflow/system/panzoom.d.ts`).
- Everything else is unchanged: the reduced-motion 500ms redraw throttle, the blocked-path
  burst at `progress > 0.85`, `PROTOCOL_COLOR`, and the `edge:`-prefixed off-screen-left
  handling (`x = -40 * zoom + viewport.x`).
- Node-footprint fallback constants (`SERVER_W/H`, `MANAGED_W/H`) are **kept as-is** — they
  only matter for the few frames before React Flow's own `ResizeObserver`-based
  measurement populates `node.measured`. D9: "fallback to the old constants pre-paint
  since chassis heights vary by U" — i.e. don't try to make the fallback U-height-aware;
  it's a coarse, brief-window guess, not a second source of truth.
- **Judgment call — no jsdom test for this task.** The skeleton explicitly allows this
  ("if none emerges the LIVE SMOKE is the gate; SAY SO explicitly"). This plan makes that
  call for two concrete reasons, both grounded in this codebase's own existing test
  patterns rather than a general "canvas is hard to test" hand-wave:
  1. **Canvas draw math has no jsdom precedent here.** `PacketLayer.test.tsx` (Phase 3,
     the only other `attachRenderer` + `<canvas>` component in this codebase) tests
     **only** attach-on-running / detach-on-unmount by mocking `attachRenderer` itself —
     it never asserts anything about what gets drawn, because jsdom doesn't implement
     canvas 2D rendering. The same ceiling applies here.
  2. **The specific regression being fixed needs a real viewport + real measured DOM.**
     D9's actual claim — "pan/zoom no longer re-subscribes the renderer, and particle
     positions track real (possibly parented, possibly non-default-sized) chassis" —
     requires an actual React Flow instance with real layout/measurement and a real
     pointer-driven pan/zoom to observe meaningfully. A jsdom test could only prove the
     weaker, largely tautological claim "the effect doesn't re-run when an unrelated prop
     changes," which doesn't exercise the parent-relative-position bug this task exists
     to fix. A mocked-attach-count test would be busywork, not a real regression check.
  Given that, the live smoke below is written to be the actual gate, per the brief's
  instruction to "make the smoke rigorous."

- [ ] **Step 1: Write the new `src/app/world/AzSimOverlay.tsx`**

```tsx
// src/app/world/AzSimOverlay.tsx
// Canvas overlay for the focused AZ: draws live particles from the engine's per-frame
// attachRenderer payload along the same chassis/managed-node positions AzCanvas lays out.
// Read-only, pointer-events: none — all real interaction stays on the ReactFlow pane underneath.
//
// v2 (Phase 4 D9): chassis are React Flow CHILD nodes (parentId + extent:'parent'), so a
// plain node.position is parent-relative, not absolute — getInternalNode(id)
// .internals.positionAbsolute resolves the real canvas position for both parented and
// top-level nodes. Node footprint comes from React Flow's own measured DOM size
// (node.measured) once painted; the old fixed constants are kept ONLY as a pre-paint
// fallback (chassis heights vary 1U/2U, unlike the old flat cards — this fallback is a
// coarse, brief-window guess, not a second source of truth). getViewport() is read
// imperatively inside the frame callback instead of subscribing to useViewport(), so
// panning/zooming the canvas no longer re-runs this effect (no re-attach churn) —
// getInternalNode/getViewport are both referentially stable across re-renders (verified
// against @xyflow/react's source: each is produced inside a `useMemo(..., [])`-style
// memo), so including them in the deps array below is correct and never itself
// retriggers the effect.
import { useEffect, useRef } from 'react'
import { useReactFlow } from '@xyflow/react'
import { useReducedMotion } from 'framer-motion'
import { useSimulationStore } from '../store/simulation.store'
import type { VisualParticle } from '../../lib/worldEngine/types'

// Pre-paint fallback footprint only — real dimensions come from node.measured once React
// Flow has laid the DOM out. Deliberately NOT U-height-aware (see file header).
const SERVER_W = 220, SERVER_H = 96
const MANAGED_W = 170, MANAGED_H = 60

const PROTOCOL_COLOR: Record<VisualParticle['protocol'], string> = {
  http: '#4A9EFF', db: '#F5A623', event: '#A78BFA', stream: '#2DD4BF',
}

interface Props { azId: string }

export function AzSimOverlay({ azId }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { getInternalNode, getViewport } = useReactFlow()
  const running = useSimulationStore(s => s.running)
  const reduced = useReducedMotion()
  const lastDrawRef = useRef(0)

  // Keep the canvas's pixel buffer matched to its container — avoids CSS-stretch distortion,
  // which would otherwise throw off the screen-space math below.
  useEffect(() => {
    const canvas = canvasRef.current
    const parent = canvas?.parentElement
    if (!canvas || !parent) return
    const resize = () => { canvas.width = parent.clientWidth; canvas.height = parent.clientHeight }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(parent)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!running) {
      const ctx = canvasRef.current?.getContext('2d')
      if (ctx && canvasRef.current) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height)
      return
    }

    const detach = useSimulationStore.getState().attachRenderer({ level: 'az', azId }, (payload) => {
      // Reduced-motion: throttle redraws to ~2/sec (still shows real, current state, just not
      // smooth motion) rather than fully suppressing the visualization — this canvas IS the
      // simulation's primary information channel here, not decorative chrome.
      const now = performance.now()
      if (reduced && now - lastDrawRef.current < 500) return
      lastDrawRef.current = now

      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) return
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      // Read the viewport imperatively, once per frame — NOT via the useViewport() hook,
      // which would re-run this whole effect (and re-attach the renderer) on every
      // pan/zoom tick (D9).
      const viewport = getViewport()

      const toScreen = (id: string, fallback: { x: number; y: number }) => {
        if (id.startsWith('edge:')) return { x: -40 * viewport.zoom + viewport.x, y: fallback.y }
        const node = getInternalNode(id)
        if (!node) return fallback
        const w = node.measured?.width ?? (node.type === 'worldManaged' ? MANAGED_W : SERVER_W)
        const hgt = node.measured?.height ?? (node.type === 'worldManaged' ? MANAGED_H : SERVER_H)
        const abs = node.internals.positionAbsolute
        return {
          x: (abs.x + w / 2) * viewport.zoom + viewport.x,
          y: (abs.y + hgt / 2) * viewport.zoom + viewport.y,
        }
      }

      for (const p of payload.particles) {
        const to = toScreen(p.toId, { x: canvas.width / 2, y: canvas.height / 2 })
        const from = toScreen(p.fromId, to)
        const x = from.x + (to.x - from.x) * p.progress
        const y = from.y + (to.y - from.y) * p.progress

        if (p.blocked && p.progress > 0.85) {
          const burst = (p.progress - 0.85) / 0.15
          ctx.beginPath()
          ctx.arc(to.x, to.y, 4 + burst * 10, 0, Math.PI * 2)
          ctx.strokeStyle = `rgba(239, 68, 68, ${1 - burst})`   // var(--color-danger) #EF4444
          ctx.lineWidth = 2
          ctx.stroke()
          continue
        }

        ctx.beginPath()
        ctx.arc(x, y, 3, 0, Math.PI * 2)
        ctx.fillStyle = p.colorHint ?? PROTOCOL_COLOR[p.protocol]
        ctx.fill()
      }
    })

    return detach
  }, [running, azId, reduced, getInternalNode, getViewport])

  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
    />
  )
}
```

- [ ] **Step 2: Run tests + build**

Run: `npx vitest run` → all suites green (no new tests added; this confirms nothing else
regressed — `AzCanvas.tsx`'s own rewire from Task 5 already covers node-type wiring).
Run: `npm run build` → succeeds.

- [ ] **Step 3: Live Playwright smoke (controller-run, port 1420) — this is the gate**

1. **Instrument the attach count (temporary, reverted before commit):** in the copy of
   `AzSimOverlay.tsx` under test, add one line inside the `useEffect` that calls
   `attachRenderer`, right before `const detach = useSimulationStore.getState()
   .attachRenderer(...)`:
   `console.info('[smoke] az-overlay-attach', ++attachCount.current)` — with a
   `const attachCount = useRef(0)` declared alongside the other refs at the top of the
   component. This is the "counter/log" the skeleton asks for; it is source-level (not a
   page-injected script) because the attach happens inside a `useEffect` closure that
   `browser_evaluate` cannot reach from outside React. Remove this instrumentation (the
   `useRef` line and the `console.info` line) before Step 4's commit — it must not ship.
2. `npm run dev` (background); wait for `Local:   http://localhost:1420/`.
3. Repeat the Task 5 smoke's setup (New World → region → AZ → a 1U and a 2U server in the
   same rack → one managed service) and navigate to the AZ canvas.
4. Click "Simulate".
5. `browser_console_messages` → confirm exactly ONE `[smoke] az-overlay-attach 1` line so
   far (the effect ran once for this mount).
6. **Pan/zoom drift check:** with the sim running, `browser_drag` the AZ canvas background
   to pan it, then use scroll/zoom controls (wheel or the pane's zoom buttons) to zoom in
   and back out, repeatedly, over several seconds while particles are actively animating.
7. `browser_console_messages` again → the `[smoke] az-overlay-attach` count must **still
   read 1** — no new attach lines were logged despite the pan/zoom above. This is the
   literal, non-hand-wavy proof of "no re-subscribe on pan/zoom."
8. `browser_take_screenshot` → scratchpad `task6-overlay-panzoom.png`, taken **while**
   panned/zoomed away from the default `fitView` framing → confirm particles visually
   still travel along the chassis/managed-node edges at their new screen positions (not
   frozen at the pre-pan coordinates, not drifting away from the nodes they're supposed to
   connect).
9. `browser_console_messages` → assert ZERO error-level entries through the entire
   pan/zoom sequence (the `[smoke]`-prefixed `console.info` lines are informational, not
   errors, and are expected/ignored by this check).
10. Stop the dev server, then remove the temporary instrumentation from
    `AzSimOverlay.tsx` (per item 1) before the commit below.

- [ ] **Step 4: Commit**

```bash
git add src/app/world/AzSimOverlay.tsx
git commit -m "fix(az-canvas): overlay tracks rack-nested nodes via absolute coords; no re-subscribe on pan/zoom"
```

<!-- FRAGMENT COMPLETE (Tasks 4–6) -->
