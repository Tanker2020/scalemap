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
