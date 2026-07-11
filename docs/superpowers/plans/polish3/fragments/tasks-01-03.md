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
