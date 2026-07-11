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
