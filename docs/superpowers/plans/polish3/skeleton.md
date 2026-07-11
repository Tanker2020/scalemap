# Polish 3 Skeleton — Region v4 · Datacenter Floor · Server Board v5 · Dock v2 (8 tasks)

Task specs for the implementation plan. The executor writes each task's full plan section
(complete code, failing-test-first, exact commands, live-smoke checklist, commit step) from
these specs after grounding in real source — see the runbook's Step 0. Spec of record:
`docs/superpowers/specs/2026-07-11-polish3-level-redesign-design.md`. Binding visual truth:
`docs/superpowers/specs/mockups/level-redesign-v5.html` (open it in a browser; transcribe its
CSS blocks — hex, clip-paths, keyframe timings — never eyeball them).

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

**Files:** modify `src/lib/theme.ts` (+ `theme.test.ts` if present, else create), sweep every
money render in `src/app/world/` (ground with `grep -rn '\\$' src/app/world --include='*.tsx'`
in Step 0 — expected: the Cost tab, region AZ card meta, globe/region overlays' `$N/hr`,
TopologyPanel server meta, instance-catalog picker, WorldPanel summary strip).

**Produces:** `ThemeColors` gains `price: string`; `DARK_COLORS.price = '#6EE7B7'`,
`LIGHT_COLORS.price = '#047857'` (comment the WCAG ratio like the neighbors do —
6.4:1 on white, normal-text AA). `useThemeBootstrap` already writes tokens generically —
verify `--color-price` lands on `:root` without further wiring, then swap every money value's
color to `var(--color-price)`.

**Named tests:** `both palettes expose a price token and they differ per theme`, plus one
extended render assertion per swept surface's existing test file (e.g. `TopologyPanel renders
the hourly price in the price color`) — assert `style.color` is `var(--color-price)`, not the
hex.

---

### Task 2 — Rack doc model: entity, free pool, capacity, auto-arrange, persistence  [sonnet]

**Files:** modify `src/lib/world/types.ts`, `src/lib/world/factories.ts` (+ tests),
`src/lib/serializer.ts` (+ tests), `src/app/store/world.store.ts` (+ tests); create
`src/lib/world/rackModel.ts` + `rackModel.test.ts`. Interim shim: wherever `server.rack` is
consumed today (`layoutRacks.ts`, `AzCanvas.tsx` — both die in T4), filter to
`s.rack !== null` so the app compiles and racked rendering is unchanged until T4.

**Produces (binding types):**
```ts
export type RackId = string
export interface Rack { id: RackId; azId: AzId; label: string; capacityU: number }
// Server.rack: RackPosition | null   (null = free pool)
// WorldDoc.racks: Record<RackId, Rack>
```
- `factories.createRack(azId: AzId, label?: string): Rack` — `capacityU: 8`;
  `createServer` seeds `rack: null` (delete the `rack-1/unit 1` seeding).
- `rackModel.ts` (pure, no store imports):
  `export const RACK_CAPACITY_DEFAULT = 8`, `RACK_CAPACITY_MIN = 4`, `RACK_CAPACITY_MAX = 42`;
  `export function rackUsedU(doc: WorldDoc, rackId: RackId): number`;
  `export function canAssign(doc: WorldDoc, serverId: ServerId, rackId: RackId): boolean`
  (capacity check using the candidate server's `heightU`, 2U dedicated / 1U vps to match the
  old factory seeding); `export function autoArrangePlan(doc: WorldDoc, azId: AzId):
  { assignments: Record<ServerId, RackPosition>; newRacks: Rack[] }` — deterministic: free-pool
  servers by label asc; fill existing racks (label asc, id tie-break) to capacity; then create
  `rack-2`, `rack-3`, … (first free integer) with default capacity; units assigned bottom-up.
- `world.store` actions (ALL through `mutate()` — undo/dirty free):
  `addRack(azId: AzId): void`, `updateRack(id: RackId, patch: Partial<Pick<Rack, 'label' |
  'capacityU'>>): void` (clamp capacityU 4–42, never below current `rackUsedU`),
  `removeRack(id: RackId): void` (residents → `rack: null`),
  `assignServerToRack(serverId: ServerId, rackId: RackId | null): void` (no-op when
  `canAssign` is false; null = send to free pool),
  `autoArrangeAz(azId: AzId): void` (applies `autoArrangePlan` as ONE mutate → one undo step).
- Serializer: `racks` written always, optional on load (default `{}`); a server entry without
  `rack` loads as `null`; the 9-collection validation is unchanged (racks is NOT required).

**Named tests:** `createServer lands in the free pool`, `canAssign refuses when the rack is
full and allows at exactly capacity`, `updateRack clamps capacity to 4–42 and never below
used`, `removeRack sends residents to the free pool in one undo step`, `autoArrangePlan is
deterministic and creates rack-2 only when rack-1 is full`, `a v2 file without racks loads
with {} and servers without rack load as null`, `round-trip preserves racks and null racks`,
`undo restores both racks and server assignments after autoArrangeAz`.

---

### Task 3 — Region v4: sources, static bars, tucked replica rail  [sonnet]

**Files:** modify `src/app/world/region/RegionView.tsx`, `AzRow.tsx`, `CrossAzColumn.tsx`,
`SplitLines.tsx`, `regionData.ts` (+ all their tests). TimelineStrip/AlertRibbon stay
functionally untouched.

**regionData.ts produces (pure, exact):**
`export function dotStreamParams(rps: number, maxRps: number): { dots: 1 | 2 | 3;
periodSec: number }` — dots: <25% of max → 1, <60% → 2, else 3; periodSec lerps 3.0 (slow)
→ 1.2 (fast) on rps/maxRps.
`export function replicaRailPairs(doc: WorldDoc, compiled: CompiledWorld, regionId: RegionId):
{ primaryServerId: ServerId; replicaServerId: ServerId; blueprintId: BlueprintId }[]` —
same-blueprint primary/replica instance pairs whose servers sit in different AZs of this
region.

**View (mockup `.r3`, binding):** WHO'S SENDING column — one `srcrow` per contributing
population (top 5 by rps animate their dot stream; the rest render the hairline static) with
name/rps, the dot stream (`@keyframes dotrun`, params from `dotStreamParams`), meta line
(latency · egress cost in `var(--color-price)`); baseline row when `traffic.autoBaseline`;
merged trunk with rolling total. AZ cards: cfgbar (`⏎ enter` → existing `goAz`; `+ server` →
the existing add-server dispatch — Step 0 grounds the exact one TopologyPanel uses; `⚡ kill`/
`restore` → existing `setOutage('az', …)` gated on `running`); header meta with `$N/mo` in
the price color; server rows with STATIC bars + single glowing endpoint (mockup `.azrow .bar`)
— no animated fills. Marching dashes: exactly the two cross-AZ beams + the trunk. Replica
rail: gutter rail at opacity 0.38 with ◆→◇ glyphs, full opacity + label on hover of either
DB row (mockup's `.r3:has(.azrow.db:hover) .replrail` — reimplement with React hover state if
`:has` proves flaky in the webview).

**Named tests:** `dotStreamParams maps rps quartiles to 1/2/3 dots and clamps the period`,
`replicaRailPairs pairs primary and replica across AZs and ignores same-AZ pairs`, `sources
column renders one row per population plus baseline, top-5 animated`, `az card kill is
disabled while stopped and dispatches setOutage('az', id, true) while running` (extend the
existing region tests), `egress and monthly figures render in the price color`.
**Live smoke:** three-region example → region page shows dot streams at three visibly
different speeds; count concurrent marching strokes ≤ 8; hover a DB row → rail brightens with
label; kill an AZ → beams/card react; reduced-motion → dots static, endpoint glows remain.

---

### Task 4 — The datacenter floor: Option A replaces the React Flow AZ canvas  [sonnet]

**Files:** create `src/app/world/az/` — `DatacenterFloor.tsx`, `RackCabinet.tsx`,
`FreePoolPod.tsx`, `floorLayout.ts` + `floorLayout.test.ts`, `floorData.ts` +
`floorData.test.ts`; modify `WorldShell.tsx` (mount swap), `InspectorV2.tsx` (rack selector);
DELETE `AzCanvas.tsx`, `RackNodes.tsx`, `AzSimOverlay.tsx`, `src/lib/world/layoutRacks.ts`
(+ their tests); remove `@xyflow/react` from `package.json` after `grep -rn '@xyflow'` proves
these were the last consumers (update `docs/module-boundaries.md` + CLAUDE.md's Key
Dependencies row in T8, not here).

**floorLayout.ts produces (pure):**
`export interface FloorPlan { cols: number; rows: number; tiles: { x: number; y: number }[];
cabinets: Record<RackId, { x: number; y: number }>; pods: Record<ServerId, { x: number;
y: number }>; appliances: Record<ManagedServiceId, { x: number; y: number }> }`;
`export function layoutFloor(racks: Rack[], rackedByRack: Record<RackId, Server[]>,
freePool: Server[], managedIds: ManagedServiceId[]): FloorPlan` — cabinets fill a grid
row-major (racks sorted by label/id), pods flow after cabinets, appliances along the far
edge; the tile grid starts 4×4 and **grows one full ring** whenever occupants would overflow
(assert exact dims in tests: 4×4 → 6×6 → 8×8). Isometric projection is CSS (the mockup's
transform values) — layout stays in grid units.

**floorData.ts produces (pure):** `export function aggregateFlows(compiled: CompiledWorld,
azId: AzId, managedHere: Set<ManagedServiceId>): { source: ServerId; target: string;
total: number; blocked: number; reason: string | null }[]` — a straight port of AzCanvas's
current per-(fromServer, target) aggregation INCLUDING the same-server blocked-path badge
count (preserve its test cases); `export function ledParams(cpuMean: number): { lit: number;
color: 'success' | 'warning' | 'danger' }` (of 6 LEDs: lit = ceil(cpuMean·6); warning ≥ 0.7,
danger ≥ 0.9).

**DatacenterFloor (mockup datacenter section, binding):** tiles, cabinets (per-rack: label,
used/capacity gauge `usedU/capacityU`, one slat per resident server sized by `heightU`, LED
strip from `ledParams` on the live batch, health tint), pods for the free pool (same LED
language, standalone silhouette), appliances for managed services, floor traces from
`aggregateFlows` (top 8 by source-server rps animate — dash speed ∝ rate; blocked = static
red dash + reason label). Toolbar: `+ server` (existing dispatch), `+ rack` (`addRack(azId)`),
`auto-arrange` (`autoArrangeAz(azId)`). Interactions: click cabinet-slat/pod = select →
InspectorV2 (today's selection seam — ground it in Step 0); hold-to-enter on a slat/pod
(reuse `HoldToEnter`'s `holdProgress`/`HoldRing`) → `goServer(regionId, azId, serverId)`.
**Boot animation:** track resident server ids in a ref; a NEW id mounts its slat/pod with the
mockup's `rackin` + `bootled` keyframes (amber cascade → settle green); reduced-motion →
instant-appear. InspectorV2's selected-server pane gains the rack selector: free pool + each
rack labeled `label · usedU/capacityU U`, full racks disabled → `assignServerToRack`.

**Named tests:** `layoutFloor grows 4×4 → 6×6 at the exact occupant count`, `pods flow after
cabinets and appliances hug the far edge`, `aggregateFlows matches the AzCanvas cases`
(port them verbatim), `ledParams thresholds at 0.7/0.9`, `rack selector disables full racks
and dispatches assignServerToRack`, `only the top 8 flows by rps get the animated class`.
**Live smoke:** teaching world → floor renders cabinets + pods with depth; add a server →
boot cascade plays and it lands in the free pool; assign it to a rack via the selector →
slat appears in the cabinet; auto-arrange empties the pool; hold a slat → server view; kill a
server → LEDs/health tint react; light mode + reduced motion passes; `npm run build` proves
@xyflow/react is gone.

---

### Task 5 — Server board v5: RJ45 intake + rule-slat shield  [sonnet]

**Files:** modify `src/app/world/server/NicBlock.tsx`, `FirewallGate.tsx` (+ their tests and
`gateStats.test.ts` untouched-passing); shield slat logic as
`export function shieldSlats(rules: FirewallRule[], maxSlats = 4): { kind: 'rule';
rule: FirewallRule }[] | [...{ kind: 'rule' }[], { kind: 'more'; count: number }]` in
`FirewallGate.tsx` or a sibling util (unit-tested).

**NicBlock (mockup `.b3nic .jack`, binding):** bezel / keystone-notch socket (clip-path
verbatim) / 8-pin gold row / LINK + ACT LEDs. Live wiring: pin ripple `animation-duration`
steps with NIC throughput (ground the exact gateStats/metrics field in Step 0; idle → pins
rest at 0.45 opacity, no ripple); LINK steady `var(--color-success)` while the server is not
down, off when down; ACT blink period ∝ rps (idle → dark). The board's intake lanes
(PacketLayer) converge to the jack's mouth — adjust the NIC anchor in `boardLayout.ts` if
needed (layout values only; no layout API reshape).

**FirewallGate:** shield clip-path + rim/inner layers verbatim; slats from `shieldSlats(server
.firewall)` — allow slat green with edge-dot firing only when gateStats shows passed traffic;
deny slat red; `+n more` slat opens the full list; scan sweep + beacon (beacon = firewall
active, i.e. ≥1 rule); reject sparks driven by the real blocked count (one spark stroke max —
motion budget). Clicking shield or slat opens today's firewall editing surface (InspectorRail
selection seam) — dispatches/aria-labels byte-identical.

**Named tests:** `shieldSlats returns all rules under the cap and folds the tail into a more
slat with the exact count`, `LINK LED reflects down state and ACT is dark at zero rps`
(render-level, class/style assertions), `clicking a slat opens the firewall editor with
dispatches unchanged` (extend existing FirewallGate/InspectorRail tests), `pins do not ripple
when throughput is zero`.
**Live smoke:** traffic on → pins ripple, ACT flickers, allow slat's edge-dot fires; add a
deny rule hit by traffic → sparks; kill the server → LINK goes dark; reduced motion → LEDs
static-on, no ripple/sparks; light mode pass.

---

### Task 6 — Server board v5: substrate instruments, chips, inspector strip  [sonnet]

**Files:** modify `src/app/world/server/HardwarePlatform.tsx`, `ServiceChip.tsx`,
`TraceLayer.tsx`, `InspectorRail.tsx` (+ all their tests; `inspectorForms`/`ruleSentence`
suites untouched-passing), extend `useServerDisplayMetrics.ts` only if a needed metric isn't
already surfaced (additive).

**HardwarePlatform (mockup `.b3hw`, binding):** core bank — one cell per vCPU (grid, fill
height = that core's utilization from the batch's `coreUtilization`, `hot` class ≥ 0.85,
violet `stealx` interference overlay on stolen cores when the VPS steal metric is nonzero —
ground the exact field in Step 0); DIMM sticks — RAM strata per resident blueprint in its
signature `blueprint.color`, free space dark, notch detail; platter — spin animation duration
∝ disk-IO fraction (stopped at idle; this is ONE of the view's animated strokes); queue-depth
ticks from the connection/queue metric (ground in Step 0). Pure derivations exported for
tests: `export function coreCells(coreUtilization: number[], stealFraction: number):
{ h: number; hot: boolean; steal: boolean }[]`, `export function dimmStrata(instances:
…, blueprints: …, ramTotalMb: number): { color: string; frac: number }[][]` (per-stick), with
exact expected values in tests.

**ServiceChip:** 12-bucket activity sparkbar (rolling rps samples kept in component state),
hover lift (`translateY(-2px)` + shadow), signature-color identity — existing drag behavior
and dispatches unchanged. **TraceLayer:** one convention — etched base path at rest, flowing
dash overlay under load (`currentColor`, speed ∝ rate, top-N cap shared with the board's
motion budget), selecting any element highlights its up/downstream paths.
**InspectorRail:** collapsed two-line dock strip (selection name + one metric line) docked to
the board's bottom-right; expands upward on selection to the existing full forms — every
form, dispatch, and aria-label byte-identical (this is a re-house, not a rebuild).

**Named tests:** `coreCells marks hot at 0.85 and applies steal only when stealing`,
`dimmStrata partitions sticks by blueprint color with exact fractions`, `sparkbar keeps at
most 12 samples`, `inspector strip expands to the existing forms and their dispatches are
unchanged` (extend the existing InspectorRail tests), `platter is static at zero IO`.
**Live smoke:** the one-wired-machine read — traffic flows jack → shield → chips → substrate
with the same current convention end-to-end; steal scenario shows violet interference ON
cores; select a chip → path highlight + inspector expands upward; reduced motion + light mode.

---

### Task 7 — Dock v2: signature headers  [sonnet]

**Files:** modify `src/app/world/panels/WorldPanel.tsx` (+ test) and, where a tab's header
needs its live one-liner, the tab files (`TopologyPanel.tsx`, `TrafficPanel.tsx`,
`AnalysisTab.tsx`, cost/events tabs — ground the cost tab's file in Step 0) — header-only
additions; body dispatches untouched.

**Binding (mockup dock section):** each tab gains a signature header — glyph, per-tab accent
(reuse CATEGORY_COLORS-adjacent tokens, no new hexes), and a one-line live summary (topology:
`n regions · n AZs · n servers`; traffic: `N rps baseline · n populations`; analysis:
`n findings (n errors)`; cost: `$N/hr` in the price color; events: `n events · last Xs ago`).
Headers are DOM-identical in structure across tabs but visually distinct via accent + glyph —
NOT uniform boxes. World-summary strip, tab ink, and `pendingPanelTab` behavior byte-identical
(the Polish 1/2 tests around them pass untouched).

**Named tests:** `every tab renders a signature header with its live one-liner`, `cost header
uses the price color`, `tab ink and pendingPanelTab tests pass untouched` (assert by running
the existing suites), `header summaries show — at rest where metrics-driven`.
**Live smoke:** flip through all tabs dark + light; headers read distinct-at-a-glance; no
dispatch regressions (spot-check role select + traffic hero).

---

### Task 8 — Motion-budget enforcement, docs, phase gate  [sonnet]

**Files:** sweep all four level views + dock; `docs/module-boundaries.md` §R; CLAUDE.md's Key
Dependencies table (@xyflow/react row removed, az/ + rackModel rows added — keep edits
surgical); `.superpowers/sdd/progress.md` `## POLISH 3`.

**Sweep (binding):** per view, inventory every infinite animation (grep `animation:` +
`animate` props) into a table in §R; each view's concurrent-stroke count ≤ 8 with the counted
list written down; reduced-motion renders every view with zero infinite animations (hold-ring
excepted); light-mode screenshots for region/floor/board/dock.

**Phase gate (live, fresh session, zero console errors):** the full story — globe → region
(dot streams, replica-rail hover, kill AZ) → hold-drill to floor (add server → boot cascade →
assign to rack → auto-arrange) → hold-drill to board (RJ45 pins + ACT under load, slat
edge-dot, steal interference, inspector strip) → dock tab sweep → reduced-motion pass →
light-mode pass — all screenshotted to `.superpowers/sdd/screenshots/polish3-*`.

**Module boundaries §R lists:** the az/ module map, the rack doc-model change + serializer
compat rule, the @xyflow/react removal, the price token, the motion-budget inventory, and the
relocated-dispatch statement.
