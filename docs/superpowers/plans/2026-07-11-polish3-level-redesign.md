# Polish 3: Per-Level Design Overhaul Implementation Plan

> Region v4 · Isometric Datacenter Floor (Option A) · Server Board v5 (RJ45 + rule-slat shield) ·
> Dock v2 signature headers · the rack document model · the app-wide motion budget + price token.

## How to execute this plan

This plan is executed with the superpowers **subagent-driven-development** skill: one fresh
implementer subagent per task, a task reviewer after each (spec compliance + code quality), fix
subagents for Critical/Important findings, then a whole-branch review at the end. Each implementer
works from its extracted task brief (`scripts/task-brief`) — the exact values, signatures, and
test cases in the brief are binding. Every task is **test-driven**: write the named failing tests
first (RED), then implement (GREEN), then commit. Tasks run in order T1 → T8; T2's shim keeps the
old AZ canvas alive until T4 lands its replacement, so the app never loses the AZ level between
tasks.

- **Goal:** rebuild the *look* of every zoom level to the locked mockup
  (`docs/superpowers/specs/mockups/level-redesign-v5.html`) without changing what any control
  does, and add the one authored document-model change the redesign needs (optional racks).
- **Architecture:** the four-level nav shell + compiled-world gate + engine facade + one-store-
  per-domain layout is unchanged. New: `src/app/world/az/` (the datacenter floor, replacing the
  React Flow AZ canvas), `src/lib/world/rackModel.ts` (pure rack helpers) + `WorldDoc.racks`, and
  a `price` theme token. `@xyflow/react` leaves the app entirely.
- **Tech stack:** Tauri 2 · React 19 · TypeScript · Zustand · framer-motion · DOM/SVG isometric
  rendering (no React Flow, no new 3D) · vitest/@testing-library. Spec of record:
  `docs/superpowers/specs/2026-07-11-polish3-level-redesign-design.md` (D1–D12). Binding visual
  truth: the v5 mockup — transcribe its CSS (hex, clip-paths, keyframe timings), never eyeball.

## Global Constraints

- **ZERO changes under `src/lib/worldEngine/`** (frozen contracts). Forced drift →
  `.superpowers/sdd/contract-drift.md` `## POLISH 3`, never silently.
- **Motion budget (spec D1):** at most ~8 concurrent infinite animated strokes per view; dash/
  dot speed & density = rate is the only shared motion convention; everything else static
  fills/glows. All decorative motion no-ops under `prefers-reduced-motion` (functional
  exceptions: hold-ring sweep; boot animation degrades to instant-appear).
- **Relocated-dispatch contract:** every restyled/moved control reuses its EXISTING store
  dispatch byte-for-byte. New store surface = ONLY the T2 rack CRUD in `world.store` (all
  through `mutate()`); `nav`/`simulation`/`file`/`ui` stores gain nothing.
- Token-only styling (`var(--color-*)` / kit vars); every money value uses
  `var(--color-price)` (T1); every new surface passes dark AND light screenshots.
- Existing tests are extended, never weakened. InspectorRail/inspectorForms/ruleSentence/
  gateStats test suites must pass with dispatches and aria-labels byte-identical.
- `.scalemap` stays version `"2"`; all format changes additive; a pre-Polish-3 file loads
  unchanged (racks default `{}`, missing `server.rack` → `null`).
- R3F/animation/isometric-depth work is NOT jsdom-testable — gate on named live smokes; pure
  logic extracted from those components IS unit-tested (node env).

## File Structure

```
src/lib/theme.ts                     # T1: `price` token (dark #6EE7B7 / light #047857)
src/lib/world/types.ts               # T2: Rack + RackId; Server.rack: RackPosition | null;
                                     #     WorldDoc.racks (additive)
src/lib/world/factories.ts           # T2: createRack(); createServer seeds rack: null
src/lib/world/rackModel.ts           # T2 NEW: rackUsedU/canAssign/autoArrange pure helpers
src/lib/serializer.ts                # T2: racks optional-on-load, always-written
src/app/store/world.store.ts         # T2: addRack/updateRack/removeRack/assignServerToRack/
                                     #     autoArrangeAz — all via mutate()
src/app/world/region/                # T3: RegionView/AzRow/CrossAzColumn/SplitLines restyle;
  regionData.ts                      #     + dotStreamParams(), replicaRailPairs() (pure)
src/app/world/az/                    # T4 NEW dir:
  DatacenterFloor.tsx                #   floor scene: tiles, cabinets, pods, appliances,
                                     #   traces, toolbar, boot animation
  RackCabinet.tsx, FreePoolPod.tsx   #   cabinet/pod visuals (LED strips, gauges)
  floorLayout.ts                     #   pure isometric layout + growth-ring math
  floorData.ts                       #   pure: server-pair flow aggregation (ported from
                                     #   AzCanvas) + ledParams()
src/app/world/AzCanvas.tsx           # T4 DELETE (with RackNodes.tsx, AzSimOverlay.tsx,
                                     #   src/lib/world/layoutRacks.ts); @xyflow/react removed
                                     #   from package.json
src/app/world/InspectorV2.tsx        # T4: mounts beside the floor; + rack selector on a
                                     #   selected server
src/app/world/server/
  NicBlock.tsx                       # T5: RJ45 jack (bezel/socket/pinrow/LINK+ACT LEDs)
  FirewallGate.tsx                   # T5: rule-slat shield; + shieldSlats() pure
  HardwarePlatform.tsx               # T6: core bank / DIMMs / platter / queue ticks
  ServiceChip.tsx, TraceLayer.tsx    # T6: sparkbars + one current convention
  InspectorRail.tsx                  # T6: two-line dock strip, expands upward
src/app/world/panels/WorldPanel.tsx  # T7: dock v2 signature headers (+ per-tab headers)
docs/module-boundaries.md            # T8: §R
```

---
### Task 1 — Theme: the price token + app-wide money sweep  [sonnet]

**Goal:** add a dedicated `price` color token (spec D2) and render EVERY money value in the app
through `var(--color-price)`.

**Grounded facts (verified in source):**
- The theme interface is named **`ColorTokens`** (NOT `ThemeColors`) in `src/lib/theme.ts`.
- `App.tsx`'s `useThemeBootstrap` writes every token generically:
  `key.replace(/[A-Z]/g, m => '-'+m.toLowerCase())` → `root.setProperty('--color-'+kebab, value)`.
  A key with no uppercase (`price`) becomes `--color-price` with ZERO extra wiring.
- `src/lib/theme.test.ts` exists — extend it.

**Files & changes:**
1. `src/lib/theme.ts` — add `price: string` to `ColorTokens`; `DARK_COLORS.price = '#6EE7B7'`;
   `LIGHT_COLORS.price = '#047857'` with a neighbor-style WCAG comment (`// 6.4:1 on white —
   normal-text AA`).
2. Money sweep — change ONLY the text color of each money render to `var(--color-price)`; keep
   the `$`, `.toFixed(2)`, `/mo`, `/hr`, thousands formatting byte-identical. Confirmed sites
   (implementer re-greps `grep -rn '/mo\|/hr\|Usd\|hourlyUsd\|monthlyUsd' src/app/world` to
   catch any missed):
   - `src/app/world/CostTab.tsx` — monthly total (`${cost.monthlyUsd.toFixed(2)} /mo`),
     per-region rows, per-AZ rows, and the three egress line items (Cross-AZ / Cross-region /
     Internet). Every `$…` figure in this tab → price color.
   - `src/app/world/panels/WorldPanel.tsx` — `WorldSummary`'s `${hourlyUsd.toFixed(2)}/hr` span.
   - `src/app/world/RegionView.tsx` + `src/app/world/region/AzRow.tsx` — the AZ-card `$N/mo`
     meta (AzRow receives `monthlyUsd`). Price color.
   - `src/app/world/panels/TopologyPanel.tsx` — any per-server hourly meta it renders.
   - `src/app/world/ui/kit.tsx` — the `ChipGrid` `price` field (`'$'+p.hourlyUsd+'/hr'`, fed by
     the instance-catalog picker in TopologyPanel and elsewhere). Color the price element.
   - Globe/region overlays that show a `$N/hr` chip:
     `src/app/world/ui/overlays/RegionOverlay.tsx`, `.../PopulationOverlay.tsx`,
     `src/app/world/GlobeView.tsx` / `GlobeCards.tsx`. Sweep whichever render `$`.
   Do NOT touch `SettingsModal.tsx`'s `•••• <last4>` key mask (not money) or `ScrubberV2`'s time.

**TDD (write failing tests first):**
- `src/lib/theme.test.ts`: `both palettes expose a price token and they differ per theme` —
  assert `DARK_COLORS.price === '#6EE7B7'`, `LIGHT_COLORS.price === '#047857'`, and they differ.
- Extend ONE existing render test per swept surface to assert the money element's
  `style.color` is `'var(--color-price)'` (not the hex), e.g. in `CostTab.test.tsx`
  (`the monthly total renders in the price color`), `TopologyPanel.test.tsx`
  (`the hourly price renders in the price color`), and a WorldPanel/kit test for the summary
  `$/hr`. Query the money node and read `.style.color`.

**Commands:** `npx vitest run src/lib/theme.test.ts src/app/world/CostTab.test.tsx
src/app/world/panels/TopologyPanel.test.tsx` (RED then GREEN), then `npx vitest run` +
`npm run build` before commit.

**Commit:** `feat(theme): dedicated price token + app-wide money sweep (Polish 3 T1)`

---

### Task 2 — Rack doc model: entity, free pool, capacity, auto-arrange, persistence  [sonnet]

**Goal:** racks become OPTIONAL authored containers (spec D4). New servers are born in the free
pool (`rack: null`). Engine/compile/analysis/cost stay untouched — racks carry zero sim
semantics.

**Grounded facts:**
- `RackPosition { rackId: string; unit: number; heightU: number }` already exists
  (`src/lib/world/types.ts:84`). `Server.rack` is currently REQUIRED `RackPosition`
  (`types.ts:98`). `createServer` seeds `rack: { rackId:'rack-1', unit:1, heightU: kind==='dedicated'?2:1 }`
  (`factories.ts:67`).
- `world.store.ts` routes every mutation through `mutate(fn: (doc)=>doc)` (pushHistory + set +
  setDirty). `addServer` labels `server-N` off count. `createWorld()` returns the 9 collections.
- `serializeWorld` JSON-stringifies `world` directly (so a new `racks` collection is written for
  free once it's in `WorldDoc`). `deserializeWorld` validates 9 required collections and returns
  `data as ScalemapFileV2` WITHOUT normalization.
- Two current `server.rack` consumers both die in T4: `src/lib/world/layoutRacks.ts`
  (`s.rack.rackId`, `rack.heightU`) and `src/app/world/AzCanvas.tsx` (`server.rack.rackId`,
  `frame:${server.rack.rackId}`). RackNodes.tsx reads rack metrics but not `server.rack`.

**Types (`src/lib/world/types.ts`, additive):**
```ts
export type RackId = string
export interface Rack { id: RackId; azId: AzId; label: string; capacityU: number }
// Server.rack: RackPosition | null      (null = free pool)
// WorldDoc gains:  racks: Record<RackId, Rack>
```

**`factories.ts`:**
- `createWorld()` → add `racks: {}`.
- `createServer` → `rack: null` (delete the `rack-1/unit 1` seeding).
- `export function createRack(azId: AzId, label?: string): Rack` →
  `{ id: nextWorldId('rack'), azId, label: label ?? 'rack', capacityU: RACK_CAPACITY_DEFAULT }`.

**`src/lib/world/rackModel.ts` (NEW, pure — no store/React imports):**
```ts
export const RACK_CAPACITY_DEFAULT = 8
export const RACK_CAPACITY_MIN = 4
export const RACK_CAPACITY_MAX = 42
// 2U dedicated / 1U vps — matches the old factory seeding.
export function serverHeightU(server: Server): number { return server.kind === 'dedicated' ? 2 : 1 }
export function rackUsedU(doc: WorldDoc, rackId: RackId): number
  // sum serverHeightU over servers with s.rack?.rackId === rackId
export function canAssign(doc: WorldDoc, serverId: ServerId, rackId: RackId): boolean
  // false if server/rack missing; usedU EXCLUDING this server + serverHeightU(server) <= rack.capacityU
export function autoArrangePlan(doc: WorldDoc, azId: AzId):
  { assignments: Record<ServerId, RackPosition>; newRacks: Rack[] }
```
`autoArrangePlan` (deterministic):
1. `freePool` = servers in this az with `rack === null`, sorted by `label` asc (id asc tie-break).
2. Target racks = existing racks in this az sorted by `label` asc (id tie-break). For each rack
   maintain a running `usedU` starting at `rackUsedU(doc, rackId)`; a server fits when
   `usedU + serverHeightU <= capacityU`; assign `{ rackId, unit: usedU + 1, heightU }` then
   `usedU += heightU` (units 1-based, bottom-up).
3. When existing racks are exhausted, create new racks with `capacityU: 8`, id === label ===
   `rack-<n>` where `<n>` is the smallest integer ≥1 such that `rack-<n>` is not a key of
   `doc.racks` and not already created in this plan (global uniqueness). Continue filling.
4. Return the accumulated `assignments` (ServerId → RackPosition) and `newRacks`.

**`world.store.ts` actions (ALL via `mutate()`):**
- `addRack(azId: AzId): void` — `createRack(azId, 'rack-' + (count of racks in this az + 1))`;
  insert into `d.racks`.
- `updateRack(id, patch: Partial<Pick<Rack,'label'|'capacityU'>>): void` — when patching
  `capacityU`, clamp to `[RACK_CAPACITY_MIN, RACK_CAPACITY_MAX]` AND never below
  `rackUsedU(d, id)`.
- `removeRack(id): void` — set every resident server (`s.rack?.rackId === id`) to `rack: null`,
  then delete the rack — ONE mutate (one undo step).
- `assignServerToRack(serverId, rackId: RackId | null): void` — `null` → `server.rack = null`;
  else no-op unless `canAssign(d, serverId, rackId)`, then
  `server.rack = { rackId, unit: rackUsedU(d, rackId) + 1, heightU: serverHeightU(server) }`.
- `autoArrangeAz(azId): void` — compute `autoArrangePlan(d, azId)`; apply `newRacks` + all
  `assignments` in ONE mutate (one undo step).
Add the five signatures to the `WorldStore` interface.

**`serializer.ts`:** in `deserializeWorld`, AFTER the existing validation (leave the
9-collection check unchanged — `racks` is NOT required), normalize the returned world:
`world.racks ??= {}`; for every server, `if (server.rack === undefined) server.rack = null`.
`serializeWorld` needs no change (racks rides along in `world`).

**Interim shim (keeps the app compiling until T4 deletes these):**
- `layoutRacks.ts`: skip free-pool servers — `for (const s of servers) { if (!s.rack) continue; … }`
  and use `s.rack!.rackId` / `s.rack!.heightU` thereafter.
- `AzCanvas.tsx`: filter `servers.filter(s => s.rack != null)` before `layoutRacks`, and guard
  `server.rack!.rackId` at the chassis-node mapping. Racked rendering stays visually unchanged.

**TDD named tests** (`rackModel.test.ts`, `factories.test.ts`, `serializer.test.ts`,
`world.store.test.ts` — node env for the pure ones):
- `createServer lands in the free pool` (rack === null).
- `canAssign refuses when the rack is full and allows at exactly capacity` (capacityU 4, two 2U
  dedicated servers fill it; a third refused; the second allowed at exactly 4U).
- `updateRack clamps capacity to 4–42 and never below used` (set 100 → 42; set 1 → 4; set below
  current used → stays at used).
- `removeRack sends residents to the free pool in one undo step` (residents → null; single undo
  restores rack + assignments).
- `autoArrangePlan is deterministic and creates rack-2 only when rack-1 is full` (rack-1 at 8U →
  overflow lands in a new `rack-2`; two calls give identical output).
- `a v2 file without racks loads with {} and servers without rack load as null`.
- `round-trip preserves racks and null racks` (serialize → deserialize equal, including a null
  `server.rack`).
- `undo restores both racks and server assignments after autoArrangeAz`.

**Commands:** `npx vitest run src/lib/world/rackModel.test.ts src/lib/world/factories.test.ts
src/lib/serializer.test.ts src/app/store/world.store.test.ts` (RED→GREEN), then full
`npx vitest run` + `npm run build` (shim must compile).

**Commit:** `feat(world): optional rack doc model — free pool, capacity, auto-arrange (Polish 3 T2)`

---

### Task 3 — Region v4: sources, static bars, tucked replica rail  [sonnet]

**Goal:** restyle the SHIPPED region page to the mockup `.r3` layout (spec D3) — de-lined,
motion-budgeted, replica rail tucked. **Fix the existing shape, do not replace it.**
Transcribe every CSS block from `docs/superpowers/specs/mockups/level-redesign-v5.html` `.r3`
section (hex, keyframes `dotrun`/`dashflow`/`marchr`, timings) — never eyeball.

**Grounded facts:**
- `src/app/world/region/regionData.ts` already exports `azShares`, `ribbonAlert`, `regionEvents`,
  `replicationPairs` (blueprint-level, DIFFERENT from what T3 adds), `crossAzEntries`,
  `sparklineSeries`, `dominantBlueprintColor`. T3 ADDS two NEW pure functions.
- `RegionView.tsx` already wires `goAz`, `goServer` (nav), `setOutage` + `running` +
  `healthOverrides` (simulation), `computeWorldCost`, and renders `SplitLines`, `AzRow`,
  `CrossAzColumn`. Region kill today = `setOutage('region', regionId, !isDown)`.
- Add-server dispatch (grounded from TopologyPanel): `addServer(az.id, getPreset('vps-medium')!)`
  — `getPreset` from `src/lib/world/instanceCatalog`.

**`regionData.ts` (NEW pure functions, exact):**
```ts
export function dotStreamParams(rps: number, maxRps: number): { dots: 1 | 2 | 3; periodSec: number }
```
- `ratio = maxRps > 0 ? rps / maxRps : 0`
- `dots`: `ratio < 0.25 → 1`, `ratio < 0.60 → 2`, else `3`
- `periodSec = clamp(3.0 - 1.8 * ratio, 1.2, 3.0)` (slow 3.0 at ratio 0 → fast 1.2 at ratio 1)
```ts
export function replicaRailPairs(doc: WorldDoc, compiled: CompiledWorld, regionId: RegionId):
  { primaryServerId: ServerId; replicaServerId: ServerId; blueprintId: BlueprintId }[]
```
- Consider `compiled.instances` with `regionId === regionId`. Group by `blueprintId`. For each
  blueprint, pair every `role === 'primary'` instance with every `role === 'replica'` instance
  whose servers are in DIFFERENT AZs (`primary.azId !== replica.azId`). Emit
  `{ primaryServerId, replicaServerId, blueprintId }` per cross-AZ pair; ignore same-AZ pairs.

**View (mockup `.r3`, binding):**
- **WHO'S SENDING** column (`.src`): one `.srcrow` per contributing population (name + rps in
  teal, meta line `latency · egress cost`). Egress cost figure → `var(--color-price)` (T1). Dot
  stream (`.stream`, `@keyframes dotrun`) driven by `dotStreamParams(rps, maxRps)` — only the
  **top 5 populations by rps** animate; the rest render the hairline static (no `i` dots or dots
  with animation disabled). Baseline row when `traffic.autoBaseline`. `.trunk` shows the rolling
  total.
- **AZ cards** (`.azcard`): hover-revealed `.cfgbar` with three controls reusing existing
  dispatches ONLY — `⏎ enter` → `goAz(regionId, az.id)`; `+ server` →
  `addServer(az.id, getPreset('vps-medium')!)`; `⚡ kill`/`restore` →
  `setOutage('az', az.id, !azDown)` where `azDown = healthOverrides[az.id] ?? false`, the button
  **disabled unless `running`**. Header meta shows `$N/mo` in the price color. Server rows
  (`.azrow`) use **static** fill bars with a single glowing endpoint (`.azrow .bar i` +
  `i::after`) — NO animated fills.
- **Marching dashes budget:** exactly the two cross-AZ ingress beams + the trunk animate
  (`dashflow`/`marchr`). Everything else is static.
- **Replica rail** (`.replrail`): gutter SVG at `opacity: 0.38`, always-on `◆→◇` glyphs;
  brightens to full opacity WITH its label when either DB row is hovered. Use **React hover
  state** (e.g. `hoveredDbRow`), not CSS `:has()` (webview-flaky), to toggle a `railActive`
  class/opacity. Rail joins exactly the two DB rows through the right gutter.
- `TimelineStrip` and `AlertRibbon` stay functionally untouched (restyle only if you must).

**TDD named tests** (extend `regionData.test.ts` + `RegionView.test.tsx`):
- `dotStreamParams maps rps quartiles to 1/2/3 dots and clamps the period` (rps 0 → {1, 3.0};
  0.2·max → {1,…}; 0.5·max → {2, 2.1}; max → {3, 1.2}).
- `replicaRailPairs pairs primary and replica across AZs and ignores same-AZ pairs`.
- `sources column renders one row per population plus baseline, top-5 animated`.
- `az card kill is disabled while stopped and dispatches setOutage('az', id, true) while running`.
- `egress and monthly figures render in the price color` (assert `style.color` includes
  `var(--color-price)`).

**Live smoke (REQUIRED — port 1420, dark + light):** author/load a three-region example →
region page shows dot streams at 3 visibly different speeds; count concurrent marching strokes
≤ 8; hover a DB row → rail brightens with its label; kill an AZ (while running) → beams/card
react; reduced-motion → dots static, endpoint glows remain. Screenshot to
`.superpowers/sdd/screenshots/polish3-region-{dark,light}.png`. Zero app console errors.

**Commands:** `npx vitest run src/app/world/region/regionData.test.ts
src/app/world/RegionView.test.tsx` (RED→GREEN), full `npx vitest run`, `npm run build`.

**Commit:** `feat(region): Region v4 — dot-stream sources, static bars, tucked replica rail (Polish 3 T3)`
### Task 4 — The datacenter floor: Option A replaces the React Flow AZ canvas  [sonnet]

**Goal:** replace `AzCanvas.tsx` (React Flow) with a DOM/SVG isometric datacenter floor (spec D5)
and remove `@xyflow/react` from the app — this was its last surface. Transcribe the mockup's
`.iso3` datacenter section (floor diamond, cabinet 3-face polygons + slots + LED circles,
free-pool pods, ghost slot, labels, keyframes `rackin`/`bootled`/`blink`) — never eyeball.

> **If this task BLOCKS or thrashes**, split its dispatch into (a) `floorLayout.ts` +
> `floorData.ts` + their tests (pure), then (b) the scene assembly — do NOT escalate model first.

**Grounded facts:**
- WorldShell mounts `nav.level === 'az' ? <AzCanvas /> : <ServerView />` (`WorldShell.tsx:92`).
  AzCanvas today renders `<ReactFlow>` + `<AzSimOverlay azId>` + `<InspectorV2 azId>` inside a
  `<ReactFlowProvider>`; chassis click → `goServer(regionId, azId, node.id)` (immediate drill,
  no select, no hold).
- **InspectorV2 has NO server-selection today** — it only polls `getTracedRequests({level:'az'})`
  and lists them (`InspectorV2.tsx`, props `{ azId }`). The selection seam for a selected server
  + rack selector is NEW work this task introduces.
- AzCanvas aggregation (`AzCanvas.tsx:40–73`) is the verbatim source for `aggregateFlows`:
  iterate `compiled.paths`; `from = compiled.instances[p.fromInstanceId]`, skip if
  `from.azId !== azId`; `targetId` = `p.to.managedServiceId` (managed) else `to.serverId`;
  same-server pairs draw NO edge (count as internal-blocked badge, not an edge); aggregate per
  `${from.serverId}->${targetId}` with `total`, `blocked`, first `reason`.
- Hold primitive (`ui/HoldToEnter.tsx`): `HOLD_DURATION_MS = 700`, `holdProgress(now, startMs,
  dur?)`, `HOLD_TAP_MS = 250`, `HOLD_SLOP_PX = 12`, `exceedsHoldSlop(dx,dy)`,
  `HoldRing({progressRef, size})`. Reuse — never fork. tap = select / hold = drill is app law.
- Add-server dispatch: `addServer(azId, getPreset('vps-medium')!)` (`getPreset` from
  `src/lib/world/instanceCatalog`). New store actions from T2: `addRack(azId)`,
  `autoArrangeAz(azId)`, `assignServerToRack(serverId, rackId|null)`; pure helpers
  `rackUsedU`, `canAssign`, `serverHeightU` in `src/lib/world/rackModel.ts`.

**`src/app/world/az/floorLayout.ts` (NEW, pure):**
```ts
export interface FloorPlan {
  cols: number; rows: number;
  tiles: { x: number; y: number }[];
  cabinets: Record<RackId, { x: number; y: number }>;
  pods: Record<ServerId, { x: number; y: number }>;
  appliances: Record<ManagedServiceId, { x: number; y: number }>;
}
export function layoutFloor(
  racks: Rack[], rackedByRack: Record<RackId, Server[]>,
  freePool: Server[], managedIds: ManagedServiceId[]): FloorPlan
```
- `occupantCount = racks.length + freePool.length`. `cols = rows = 4`; while
  `cols*rows < occupantCount` grow one full ring (`cols += 2; rows += 2`) → 4×4 (cap 16) → 6×6
  (cap 36) → 8×8 (cap 64).
- `tiles` = every cell row-major: idx → `{ x: idx % cols, y: Math.floor(idx / cols) }`.
- Cabinets fill first cells (racks sorted by `label` then `id`), then pods (freePool sorted by
  `label` then `id`) continue row-major from cell index `racks.length`.
- `appliances[msId] = { x: cols, y: i }` (i in given order) — one lane past the grid's right
  edge = "hug the far edge". Isometric projection is CSS (mockup transforms); layout stays grid
  units.

**`src/app/world/az/floorData.ts` (NEW, pure):**
```ts
export function aggregateFlows(compiled: CompiledWorld, azId: AzId, managedHere: Set<ManagedServiceId>):
  { source: ServerId; target: string; total: number; blocked: number; reason: string | null }[]
export function ledParams(cpuMean: number): { lit: number; color: 'success' | 'warning' | 'danger' }
```
- `aggregateFlows` = verbatim port of the AzCanvas block above. Same-server pairs are EXCLUDED
  from the edge list (they render as a per-server internal-blocked badge, not an edge). Preserve
  the per-`(fromServer,target)` totals/blocked/reason semantics exactly.
- `ledParams` (6 LEDs): `lit = clamp(Math.ceil(cpuMean * 6), 0, 6)`; `color = cpuMean >= 0.9 ?
  'danger' : cpuMean >= 0.7 ? 'warning' : 'success'`.

**`src/app/world/az/DatacenterFloor.tsx` + `RackCabinet.tsx` + `FreePoolPod.tsx` (NEW):**
- DatacenterFloor reads doc (world.store), `compiled` (`useCompiledWorld`), batch
  (`scrubBatch ?? latestBatch`), nav (`regionId`, `azId`, `goServer`), and store actions. Builds
  `layoutFloor(...)` from this az's racks/servers/managed, renders tiles + `RackCabinet` per rack
  + `FreePoolPod` per free-pool server + appliance per managed service.
- `RackCabinet`: label, `usedU/capacityU` gauge, one slat per resident server sized by
  `serverHeightU`, LED strip from `ledParams(cpuMean)` on the live batch, health tint.
  `cpuMean` = mean of that server's `coreUtilization`. `FreePoolPod`: same LED language,
  standalone pod silhouette.
- **Floor traces** from `aggregateFlows`: only the **top 8 by source-server rps** get the
  animated (marching-dash) class — dash speed ∝ rate (motion budget D1); blocked flows render a
  **static** red dash + reason label. Apply an explicit `data-animated`/class you can assert.
- **Selection seam (NEW):** DatacenterFloor owns `selectedServerId` state. Tap a cabinet-slat /
  pod → `setSelectedServerId`. Hold-to-enter (reuse `holdProgress`/`HoldRing` + pointer + slop)
  → `goServer(regionId, azId, serverId)`. Render `<InspectorV2 azId={azId}
  selectedServerId={selectedServerId} onClearSelection={…} />`.
- **Boot animation:** keep resident server ids in a ref; a server id NEW since last render mounts
  its slat/pod with the mockup `rackin` + `bootled` keyframes (amber cascade → settle green);
  `prefers-reduced-motion` → instant-appear (functional exception per D1). A server born via the
  toolbar lands in the free pool → its pod boots.
- **Toolbar:** `+ server` → `addServer(azId, getPreset('vps-medium')!)`; `+ rack` →
  `addRack(azId)`; `auto-arrange` → `autoArrangeAz(azId)`.

**`InspectorV2.tsx` extension (additive props):** add optional `selectedServerId?: string | null`
and `onClearSelection?: () => void`. Keep the traced-requests list. When `selectedServerId` is
set, render a "selected server" pane with a **rack selector**: options = `free pool` + each rack
in this az labeled `${rack.label} · ${rackUsedU(doc, rack.id)}/${rack.capacityU} U`, an option
**disabled** when `!canAssign(doc, selectedServerId, rack.id)` (full). Selecting →
`assignServerToRack(selectedServerId, rackId | null)`. No other store surface.

**Deletions (after `grep -rn '@xyflow' src/` proves these are the last consumers):**
`AzCanvas.tsx`, `RackNodes.tsx`, `AzSimOverlay.tsx`, `src/lib/world/layoutRacks.ts` + all their
`*.test.ts(x)`; swap the WorldShell mount to `<DatacenterFloor />`; remove `@xyflow/react` from
`package.json` dependencies. **Do NOT edit `docs/module-boundaries.md` or CLAUDE.md here — T8
owns both.**

**TDD named tests** (`floorLayout.test.ts`, `floorData.test.ts`, node env; a jsdom test for the
selector/animated class):
- `layoutFloor grows 4×4 → 6×6 at the exact occupant count` (16 occupants → 4×4; 17 → 6×6;
  36 → 6×6; 37 → 8×8).
- `pods flow after cabinets and appliances hug the far edge` (cabinet cells precede pod cells
  row-major; `appliances[ms].x === cols`).
- `aggregateFlows matches the AzCanvas cases` (permitted edge total; blocked edge carries first
  reason; a same-server blocked path produces NO edge). Build a small compiled fixture.
- `ledParams thresholds at 0.7/0.9` (0 → {0,'success'}; 0.7 → {5,'warning'}; 0.9 → {6,'danger'}).
- `rack selector disables full racks and dispatches assignServerToRack`.
- `only the top 8 flows by rps get the animated class`.

**Live smoke (REQUIRED — port 1420, dark + light):** teaching world → floor renders cabinets +
pods with isometric depth; `+ server` → boot cascade plays and it lands in the free pool; select
it → rack selector → assign to a rack → its slat appears in the cabinet; `auto-arrange` empties
the pool; hold a slat → server view; kill a server → LEDs/health tint react; reduced-motion +
light mode pass; `npm run build` (proves `@xyflow/react` is gone). Screenshots to
`.superpowers/sdd/screenshots/polish3-floor-{dark,light}.png`. Zero app console errors.

**Commands:** `npx vitest run src/app/world/az/floorLayout.test.ts
src/app/world/az/floorData.test.ts` (RED→GREEN) → full `npx vitest run` → `npm run build`.

**Commit:** `feat(az): isometric datacenter floor replaces React Flow AZ canvas (Polish 3 T4)`

---

### Task 5 — Server board v5: RJ45 intake + rule-slat shield  [sonnet]

**Goal:** `NicBlock` becomes a physical RJ45 jack (spec D6); `FirewallGate` becomes a shield
built from its own rules (spec D7). Transcribe the mockup `.b3nic .jack` and `.b3fw2` CSS
verbatim (bezel, keystone-notch `socket` clip-path, `pinrow`, LINK/ACT LEDs, shield clip-path,
slats, `scan`, `beacon`, `spark`; keyframes `pinseq`/`actblink`/`scanline`/`blink`/`fwspark`).

**Grounded facts:**
- `ServerMetrics` (frozen contract, read via `useServerDisplayMetrics(serverId)`) surfaces
  `nicInMbps`, `nicOutMbps`, `coreUtilization`, `stealFraction`, `diskIoFraction`, `ramByInstance`,
  `health`, etc. There is NO server-level `rps`; derive inbound rps as
  `Σ instances[i].rps` over resident instances when a rate is needed.
- `src/app/world/server/gateStats.ts` exports `blockedPerSecond(...)` (read its exact signature;
  it's the blocked-count source). `boardLayout.ts` NIC anchor: `nic.anchor = { x: 74, y: CY }`;
  the intake `tracePath`s already route NIC-end paths through the gate — adjust the NIC anchor
  ONLY if the jack mouth needs it (layout values only; do NOT reshape the layout API).
- `NicBlock`/`FirewallGate` are mounted by `ServerBoard.tsx`; FirewallGate already dispatches a
  selection into `InspectorRail` on click (preserve that onClick + its `aria-label` BYTE-FOR-BYTE).

**Shield-slat logic (unit-tested; in `FirewallGate.tsx` or a sibling util):**
```ts
export function shieldSlats(rules: FirewallRule[], maxSlats = 4):
  | { kind: 'rule'; rule: FirewallRule }[]
  | [ ...{ kind: 'rule'; rule: FirewallRule }[], { kind: 'more'; count: number } ]
```
- `rules.length <= maxSlats` → every rule as a `{kind:'rule'}` slat.
- else → first `maxSlats - 1` rules as `{kind:'rule'}` slats + one
  `{ kind:'more', count: rules.length - (maxSlats - 1) }` (total slats = `maxSlats`).

**NicBlock (mockup `.b3nic .jack`):** bezel / keystone-notch socket (clip-path verbatim) / 8-pin
gold row (`.pinrow i`, staggered `animation-delay`) / LINK + ACT LEDs. Live wiring:
- Pin ripple: `animation-duration` steps with NIC throughput (`nicInMbps + nicOutMbps`). Idle
  (throughput 0 or no batch) → pins rest at `opacity: 0.45`, NO ripple animation.
- LINK LED: steady `var(--color-success)` while `server.health !== 'down'`; off when down.
- ACT LED: blink period ∝ inbound rps (`Σ resident instance rps`); dark when idle (rps 0).
- Intake packet lanes (`.pk2` laneA/B/C) converge to the jack mouth; keep the existing
  PacketLayer traversal — adjust the NIC anchor in `boardLayout.ts` only if the mouth moved.
- No container rectangle (`background: none; border: none`).

**FirewallGate (mockup `.b3fw2`):** shield clip-path + `shield`/`inner` stacked layers verbatim;
slats from `shieldSlats(server.firewall)` — allow slat green with its edge-dot firing ONLY when
traffic is passing (server inbound rps > 0); deny slat red; a `{more}` slat opens the full rule
list. Scan sweep (`.scan`) + beacon (`.beacon`, present when firewall has ≥1 rule); reject sparks
(`.spark`) driven by the real blocked count from `gateStats.blockedPerSecond` — **one spark
stroke max** (motion budget). Clicking the shield OR a slat opens today's firewall editing
surface via the EXISTING InspectorRail selection dispatch — dispatches + `aria-label`s
byte-identical to the current FirewallGate.

**TDD named tests** (extend `NicBlock.test.tsx`, `FirewallGate.test.tsx`; `gateStats.test.ts`
must pass untouched):
- `shieldSlats returns all rules under the cap and folds the tail into a more slat with the exact
  count` (3 rules,cap 4 → 3 rule slats; 6 rules,cap 4 → 3 rule slats + {more,count:3}).
- `LINK LED reflects down state and ACT is dark at zero rps` (class/style assertions).
- `pins do not ripple when throughput is zero` (no ripple animation / pins at 0.45).
- `clicking a slat opens the firewall editor with dispatches unchanged` (extend the existing
  FirewallGate/InspectorRail interaction test — assert the same selection dispatch fires).

**Live smoke (REQUIRED — port 1420, dark + light):** simulate → pins ripple, ACT flickers,
allow slat's edge-dot fires; add a deny rule hit by traffic → sparks; kill the server → LINK goes
dark; reduced-motion → LEDs static-on, no ripple/sparks; light mode pass. Screenshot to
`.superpowers/sdd/screenshots/polish3-board-intake-{dark,light}.png`. Zero app console errors.

**Commands:** `npx vitest run src/app/world/server/NicBlock.test.tsx
src/app/world/server/FirewallGate.test.tsx src/app/world/server/gateStats.test.ts` (RED→GREEN) →
full `npx vitest run` → `npm run build`.

**Commit:** `feat(server): RJ45 intake jack + rule-slat firewall shield (Polish 3 T5)`
### Task 6 — Server board v5: substrate instruments, chips, inspector strip  [sonnet]

**Goal:** render the locked substrate instruments (spec D8): a per-core bank, DIMM sticks, a
spinning platter, queue-depth ticks; give service chips activity sparkbars + hover lift; unify
the board on one current convention; re-house `InspectorRail` as a two-line dock strip that
expands upward. Transcribe the mockup `.b3hw` (corebank/corecell/stealx, dimms/dimm/seg/notch,
platter, qdepth/qticks), `.b3chip .act`, and `.b3insp` CSS verbatim.

**Grounded facts:**
- `useServerDisplayMetrics(serverId)` returns `{ server: ServerMetrics|null, instances, scrubbing }`.
  `ServerMetrics` surfaces `coreUtilization: number[]` (per-vCPU 0..1, index = vCPU),
  `stealFraction`, `diskIoFraction`, `ramByInstance: {instanceId, blueprintId, ramMb}[]`,
  `ramTotalMb`, `health`. `InstanceMetrics.activeConnections` for queue depth. All already
  surfaced — extend `useServerDisplayMetrics` ONLY if a field is genuinely missing (additive; never
  touch the engine).
- `HardwarePlatform`/`ServiceChip`/`TraceLayer`/`InspectorRail` exist from Phase 3 with full test
  suites; `inspectorForms.tsx` + `ruleSentence` suites must pass UNTOUCHED. InspectorRail today is
  the full read/edit panel — T6 re-houses its shell, keeping every form/dispatch/aria-label.

**Pure derivations (exported for tests):**
```ts
export function coreCells(coreUtilization: number[], stealFraction: number):
  { h: number; hot: boolean; steal: boolean }[]
```
- per core `u` at index `i`: `h = u`, `hot = u >= 0.85`,
  `steal = stealFraction > 0 && i < Math.ceil(stealFraction * coreUtilization.length)`.
```ts
export function dimmStrata(ramByInstance: {blueprintId: BlueprintId; ramMb: number}[],
  blueprints: Record<BlueprintId, ServiceBlueprint>, ramTotalMb: number): { color: string; frac: number }[][]
```
- `STICK_COUNT = 4`. Aggregate RAM per blueprint (sum `ramMb`); ordered global strata = each
  blueprint (sorted by `blueprintId`) in `blueprints[id].color`, then a `free` stratum in
  `'#4a5361'` with `mb = max(0, ramTotalMb - Σ used)`. `capPerStick = ramTotalMb / STICK_COUNT`;
  walk the strata filling sticks 0..3, splitting a stratum across a stick boundary; each entry is
  `{ color, frac }` = portion-of-that-stick (0..1). Returns `STICK_COUNT` arrays.
  - Worked example (also the test): `ramTotalMb=16000`, one blueprint color `#4A9EFF` using
    `8000`, free `8000` → sticks `[[{#4A9EFF,1}],[{#4A9EFF,1}],[{#4a5361,1}],[{#4a5361,1}]]`.

**HardwarePlatform (mockup `.b3hw`):**
- Core bank: one `.corecell` per vCPU (grid), fill height = `coreCells(...)[i].h`, `hot` class at
  `≥ 0.85`, violet `.stealx` interference overlay on cells where `steal` is true (steal is
  physical, not a bar).
- DIMM sticks: `dimmStrata(...)` → 4 `.dimm` sticks with per-blueprint `.seg` strata in signature
  color + free space dark, notch detail.
- Platter: spin `animation-duration` ∝ `diskIoFraction` (stopped when 0 — this is ONE of the
  board's animated strokes).
- Queue-depth ticks: from `Σ resident instance activeConnections` mapped to the tick row.

**ServiceChip:** 12-bucket activity sparkbar — keep a rolling array of rps samples in component
state, cap at 12 (drop oldest). Hover lift (`translateY(-2px)` + shadow). Signature-color
identity. Existing drag behavior + dispatches UNCHANGED.

**TraceLayer:** one convention — etched base path at rest, flowing dash overlay under load
(`currentColor`, speed ∝ rate, top-N cap shared with the board's motion budget); selecting any
element highlights its up/downstream paths (existing selection model).

**InspectorRail:** collapsed two-line dock strip (selection name + one metric line) docked to the
board's bottom-right; on selection it expands upward to the EXISTING full forms — every form,
dispatch, and `aria-label` byte-identical (re-house, not rebuild).

**TDD named tests** (extend `HardwarePlatform.test.tsx`, `ServiceChip.test.tsx`,
`InspectorRail.test.tsx`; `inspectorForms`/`ruleSentence` untouched-passing):
- `coreCells marks hot at 0.85 and applies steal only when stealing` (stealFraction 0 → no steal;
  0.3 of 8 cores → cores 0–2 steal; a 0.85 core is hot).
- `dimmStrata partitions sticks by blueprint color with exact fractions` (the worked example).
- `sparkbar keeps at most 12 samples`.
- `inspector strip expands to the existing forms and their dispatches are unchanged`.
- `platter is static at zero IO`.

**Live smoke (REQUIRED — port 1420, dark + light):** the one-wired-machine read — traffic flows
jack → shield → chips → substrate with the SAME current convention end-to-end; a VPS-steal
scenario shows violet interference ON the cores (not a bar); select a chip → up/downstream path
highlight + inspector expands upward; reduced-motion + light mode pass. Screenshot to
`.superpowers/sdd/screenshots/polish3-board-substrate-{dark,light}.png`. Zero app console errors.

**Commands:** `npx vitest run src/app/world/server/HardwarePlatform.test.tsx
src/app/world/server/ServiceChip.test.tsx src/app/world/server/InspectorRail.test.tsx` (RED→GREEN)
→ full `npx vitest run` → `npm run build`.

**Commit:** `feat(server): substrate instruments, chip sparkbars, dock inspector strip (Polish 3 T6)`

---

### Task 7 — Dock v2: signature headers  [sonnet]

**Goal:** each WorldPanel tab gains a per-tab signature header (glyph, accent, one-line live
summary) with an identity that reads distinct-at-a-glance (spec D9), while the Polish 1/2
world-summary strip, tab ink, and `pendingPanelTab` behavior stay byte-identical. Transcribe the
mockup's dock header treatment.

**Grounded facts:**
- `WorldPanel.tsx`: `WorldSummary` strip (line 71, OUTSIDE the fieldset), a 7-tab bar with the
  `.kit-ink` underline (lines 72–92) + `pendingPanelTab` one-shot (lines 28–40), and a
  `<fieldset disabled={running}>` body (lines 98–108) rendering Topology/Blueprints/Placements/
  Traffic/Analysis/Events/Cost. It already reads `doc`, `compiled`, `analysis`/`analysisCount`,
  and `displayBatch` — the data for most summaries is already in scope here.
- Money one-liners use `var(--color-price)` (T1). Accents come from existing tokens /
  `CATEGORY_COLORS` — NO new hexes.

**Implementation:** add a small `SignatureHeader({ glyph, accent, summary })` and a per-tab config
in `WorldPanel.tsx`. Render the header for the active tab BETWEEN the tab bar and the fieldset
(so the disabled fieldset never grays a header out; identical DOM structure across tabs, distinct
only via `glyph` + `accent`). Compute each live summary from stores WorldPanel already reads;
touch a tab file only if a summary needs data that isn't in scope. Summaries:
- topology: `${nRegions} regions · ${nAzs} AZs · ${nServers} servers`
- blueprints: `${nBlueprints} blueprints` · placements: `${nPlacements} placements`
- traffic: `${baselineTotalRps} rps baseline · ${nPopulations} populations`
- analysis: `${analysisCount} findings (${errorCount} errors)`
- cost: `$${hourlyUsd.toFixed(2)}/hr` in `var(--color-price)`
- events: `${nEvents} events · last ${Xs} ago` (from the simulation events ring; "—" at rest)
Accent suggestions (existing tokens only): topology `var(--color-accent)`, blueprints
`CATEGORY_COLORS.compute.accent`, placements `CATEGORY_COLORS.messaging.accent`, traffic
`CATEGORY_COLORS.network.accent`, analysis `var(--color-warning)`, events
`var(--color-text-muted)`, cost `var(--color-price)`.

**TDD named tests** (extend `WorldPanel.test.tsx`):
- `every tab renders a signature header with its live one-liner`.
- `cost header uses the price color` (assert `style.color` includes `var(--color-price)`).
- `tab ink and pendingPanelTab tests pass untouched` (the existing Polish 1/2 assertions still
  pass — run the existing suite).
- `header summaries show at rest where metrics-driven` (topology counts render without a batch).

**Live smoke (REQUIRED — port 1420, dark + light):** flip through all tabs — headers read
distinct-at-a-glance; no dispatch regressions (spot-check a Placements role select + the Traffic
hero). Screenshot to `.superpowers/sdd/screenshots/polish3-dock-{dark,light}.png`. Zero console
errors.

**Commands:** `npx vitest run src/app/world/panels/WorldPanel.test.tsx` (RED→GREEN) → full
`npx vitest run` → `npm run build`.

**Commit:** `feat(dock): Dock v2 signature tab headers (Polish 3 T7)`

---

### Task 8 — Motion-budget enforcement, docs, phase gate  [sonnet]

**Goal:** enforce the app-wide motion budget (spec D1), document the phase in
`docs/module-boundaries.md` §R + CLAUDE.md, and run the live phase gate.

**Motion sweep (binding):** per view (region, floor, board, dock) inventory every infinite
animation — grep `animation:` and `animate` props across `src/app/world/region/`,
`src/app/world/az/`, `src/app/world/server/`, `src/app/world/panels/` — into a table in §R. Each
view's count of CONCURRENT infinite animated strokes must be **≤ 8** with the counted list
written down. Verify `prefers-reduced-motion` renders every view with ZERO infinite animations
(the hold-ring sweep is the only functional exception; the boot animation degrades to
instant-appear). If any view is over budget, reduce it (convert decorative motion to static
fills/glows) before writing the inventory.

**`docs/module-boundaries.md` §R (append a new section) lists:**
- the `src/app/world/az/` module map (DatacenterFloor/RackCabinet/FreePoolPod/floorLayout/
  floorData) and its boundary rules;
- the rack doc-model change (`Rack`, `WorldDoc.racks`, `Server.rack: RackPosition | null`,
  `src/lib/world/rackModel.ts`) + the serializer additive-compat rule (racks default `{}`,
  missing `server.rack` → `null`, old files load unchanged);
- the `@xyflow/react` removal (AzCanvas/RackNodes/AzSimOverlay/layoutRacks deleted; it was the
  last consumer);
- the `price` token;
- the motion-budget inventory table;
- the relocated-dispatch statement (every restyled control reuses its existing dispatch; only new
  store surface = rack CRUD in `world.store`).

**CLAUDE.md Key Dependencies table (surgical edits):** remove the `@xyflow/react` row; add rows
for the `az/` datacenter-floor module and `rackModel`. Update the "AZ canvas" architecture note
if it still claims React Flow renders the AZ level.

**Phase gate (live, fresh dev server on 1420, ZERO app console errors):** run the full story end
to end and screenshot each beat to `.superpowers/sdd/screenshots/polish3-*`:
globe → region (dot streams, replica-rail hover, kill an AZ) → hold-drill to the floor (add a
server → boot cascade → assign to a rack → auto-arrange) → hold-drill to the board (RJ45 pins +
ACT under load, slat edge-dot, steal interference, inspector strip) → dock tab sweep →
reduced-motion pass → light-mode pass.

**Backward-compat check:** a pre-Polish-3 `.scalemap` file (any example/vault world) opens,
edits, saves, reopens.

**Commands:** full `npx vitest run` + `npm run build` green.

**Commit:** `docs: Polish 3 motion-budget inventory, §R module boundaries, phase gate (Polish 3 T8)`
