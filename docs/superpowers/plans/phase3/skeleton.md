# Phase 3 Plan Skeleton — Server Interior (Living Circuit Board)

Authored by the Phase-3 planning session (Fable). Fragment writers expand each task below
into a full Phase-1/2-style plan section (failing-test-first, complete code, exact commands,
commit step). Signatures and semantics here are exact — expand, don't redesign. Anything a
writer believes is wrong or ambiguous goes into a `SKELETON CONCERNS` block at the top of
their fragment, and they proceed with their best interpretation; the controller disposes of
concerns in `fragments/controller-rulings.md`.

Binding companions: `docs/superpowers/specs/2026-07-09-phase3-server-interior-design.md`
(the 12 decisions, cited as D1–D12 here), the FROZEN contracts
`docs/superpowers/specs/2026-07-08-world-engine-contracts.md` (server-scope particle
vocabulary amended 2026-07-09), approved mockup
`docs/superpowers/specs/mockups/serverview-hybrid-v3.html` (visual truth for the stage).

## Global Constraints (every task inherits these)

- Branch: `phase3-server-interior`, cut from `main` (Phase 2 merged at `3063952`).
- Contract types in `src/lib/worldEngine/types.ts` are FROZEN — additive-optional only;
  forced changes go to `.superpowers/sdd/contract-drift.md`, never silently.
- strict tsc is on (`noUnusedLocals`, `noUnusedParameters`); `npm run build` must stay
  green at every commit.
- React style objects: never spread a bare `borderColor`/`borderWidth` over a `border`
  shorthand — always write the full `border` shorthand (Phase-1 live-smoke lesson).
- Component tests: jsdom pragma (`// @vitest-environment jsdom`) + jest-dom matchers via
  the existing `vitest.setup.ts`. Engine/pure tests: default node env, seeded determinism,
  no `Math.random` anywhere under `src/lib/worldEngine/`.
- Views read `useSimulationStore` state; only store actions call the `worldEngine` facade.
  World mutations go through existing `useWorldStore` actions only (D7).
- Scrub-awareness: metric-driven UI reads `scrubBatch ?? latestBatch` (T15 pattern, D5).
- Renderer subscriptions attach once per `(serverId, running)` — never in an effect keyed
  on hover/selection/viewport (Phase-2 T14 lesson). No per-frame `setState` — canvas via
  refs (D10). Engine enforces `MAX_SERVER_PARTICLES = 50`.
- All idle/looping animation respects `prefers-reduced-motion` (D10): no scanner sweep,
  shimmer, or pulses; packet canvas throttles to ~2 redraws/s (AzSimOverlay precedent).
- Colors: theme tokens (`var(--color-*)`) for semantic colors (danger/success/text/
  surface); the mockup's scene-accent hexes (e.g. `#7CFFE9`, `#101620` PCB grid,
  `#0C1018` stage) stay local constants in `src/app/world/server/` — do NOT add new
  global tokens. Font: JetBrains Mono via existing `--font-mono`.
- Stage logical space is 1000×560, scaled to fit via `transform: scale()` (D1).
- Live Playwright smokes are controller-run on the strict dev port 1420 with ZERO app
  console errors, screenshots taken, server stopped after.
- Ledger: append per-task lines to `.superpowers/sdd/progress.md` under `## PHASE 3`.
- `docs/module-boundaries.md` gains §L in the final task.

## File Structure

```
src/app/world/server/               # NEW — everything Phase 3 adds lives here
  boardLayout.ts                    # T1: pure layout + anchors + traces + core attribution
  boardLayout.test.ts               # T1
  selection.ts                      # T6: BoardSelection union (type-only)
  ServerBoard.tsx                   # T3: stage composition (grid bg, layers, scale-to-fit)
  ServiceChip.tsx                   # T3: process/container chip block
  StackPlate.tsx                    # T3: docker stack platform plate (chips + volumes)
  FirewallGate.tsx                  # T3: gate arch (T5 adds blocked/s counter)
  NicBlock.tsx                      # T3: NIC edge connector (T4 adds live Mbps bar)
  TraceLayer.tsx                    # T3: SVG static traces w/ verdict styling + labels
  PacketLayer.tsx                   # T5: canvas packets + blocked bursts
  gateStats.ts                      # T5: pure blockedPerSecond helper
  gateStats.test.ts                 # T5
  HardwarePlatform.tsx              # T4: CPU die/ring, RAM reservoir, disk platter
  useServerDisplayMetrics.ts        # T4: scrubBatch ?? latestBatch slice for one server
  InspectorRail.tsx                 # T6: HUD rail, per-kind read panels
  InspectorRail.test.tsx            # T6/T7
  inspectorForms.tsx                # T7: Workload/Runtime/Firewall/Volumes edit forms
src/lib/worldEngine/index.ts        # T2: buildServerParticles + buildPayload server branch
src/lib/worldEngine/serverParticles.test.ts  # T2
src/lib/worldEngine/types.ts        # T2: comment-only vocabulary sync (no type change)
src/app/world/ServerView.tsx        # T3: REWRITTEN as composition root (header/stage/rail)
src/app/world/panels/PlacementPanel.tsx      # T8: MANAGED_TYPES ↔ CLOUD_REGISTRY
src/lib/costModelV2.ts (+ test)     # T8: alias table shrinks/dies
docs/module-boundaries.md           # T9: §L
```

Dependency order: T1 → T3 → {T4, T5, T6} → T7 → T9. T2 independent (needed by T5's live
verification). T8 independent. Nothing runs in parallel (SDD is serial).

---

## Task 1: Pure board layout + core attribution `[sonnet]`

**Files:** create `src/app/world/server/boardLayout.ts`, `boardLayout.test.ts`.

**Produces (exact — later tasks import these):**

```ts
import type {
  Server, WorldDoc, CompiledWorld, InstanceId, BlueprintId, ServerId,
} from '../../../lib/world/types'

export interface Box { x: number; y: number; w: number; h: number }
export interface Anchor { x: number; y: number }

export interface ChipLayout {
  instanceId: InstanceId
  blueprintId: BlueprintId
  placementId: string
  box: Box
  inAnchor: Anchor              // left edge midpoint
  outAnchor: Anchor             // right edge midpoint
  stackName: string | null      // non-null = rendered inside that stack's plate
}

export interface VolumeLayout { stackName: string; volumeName: string; sizeGb: number; box: Box }

export interface StackLayout {
  stackName: string
  box: Box
  networkLabel: string          // "net 172.18.0.0/16" style, joined if several
  chipIds: InstanceId[]
  volumes: VolumeLayout[]
}

export interface BoardLayout {
  stageW: number                // 1000
  stageH: number                // 560
  nic: { box: Box; anchor: Anchor }
  gate: { box: Box; inAnchor: Anchor; outAnchor: Anchor }
  chips: ChipLayout[]           // ALL chips: process chips AND container chips
  overflowCount: number         // instances beyond MAX_BOARD_CHIPS (see below)
  stacks: StackLayout[]
  hardware: { box: Box; cpu: Box; ram: Box; disk: Box }
  anchorFor(id: string): Anchor | null   // instanceId | `nic:${serverId}` per contracts
  tracePath(fromId: string, toId: string): string  // SVG `d`; NIC-end paths route through gate
}

export const MAX_BOARD_CHIPS = 12

export function layoutServerBoard(server: Server, doc: WorldDoc, compiled: CompiledWorld): BoardLayout

export interface StaticTrace {
  fromId: string; toId: string
  protocol: 'http' | 'db' | 'event' | 'stream'
  verdict: 'permitted' | 'blocked'
  label: string | null          // blockReason.detail when blocked, else null
  pathIds: string[]             // compiled path ids collapsed into this trace
}
// One trace per unique (fromId, toId, protocol) among the server's resident endpoints,
// plus one `nic:<sid>` → chip inbound trace per resident instance whose blueprint has a
// 'public'-visibility port. Off-server/managed targets collapse to `nic:<sid>` (D3/D6).
export function serverTraces(serverId: ServerId, doc: WorldDoc, compiled: CompiledWorld): StaticTrace[]

export interface CoreAttribution {
  dominantBlueprintId: BlueprintId | null
  shares: { instanceId: InstanceId; blueprintId: BlueprintId; fraction: number }[]
}
// Greedy attribution (D8): sort instances by cpuCoresUsed desc; each claims whole cores
// then a fraction of the next. dominant = holder of the core's largest share; null when idle.
export function attributeCores(
  coreCount: number,
  instances: { instanceId: InstanceId; blueprintId: BlueprintId; cpuCoresUsed: number }[],
): CoreAttribution[]
```

**Layout semantics (D2, mockup zones):** stage 1000×560. NIC box flush left, vertically
centered (x=0, w≈74). Gate right of NIC (x≈128, w≈48, h≈80). Process chips (stackName ===
null) in a column x≈250–340, stacked with 16px gaps, vertically centered as a group.
One StackPlate per `server.stacks` entry that has at least one container placement, placed
x≈376–530, stacked vertically; its container chips laid out inside with 8px padding;
volume cylinders along the plate's bottom edge. Stacks with no resident containers still
render (author feedback) but hold no chips. Hardware platform is a fixed right rail
(x=840, w=150, full height minus 30px margins) with cpu/ram/disk boxes stacked inside.
Chips beyond `MAX_BOARD_CHIPS` (counting process + container chips) are dropped from
`chips` and counted in `overflowCount` — deterministic order: compiled-instance iteration
order. `tracePath` = cubic bézier between the two anchors (control points at ±40px
horizontal); when either endpoint is the NIC id, the path is two chained béziers routed
through `gate.inAnchor`/`gate.outAnchor`.

**Named test cases (write these, minimum):** `lays out nic, gate, and hardware rail at
fixed zones`; `process chips column excludes container chips`; `container chips sit inside
their stack plate box`; `volume cylinders attach to their plate`; `chips overflow beyond
MAX_BOARD_CHIPS into overflowCount`; `anchorFor resolves instance and nic ids and rejects
unknown ids`; `tracePath routes through the gate for nic endpoints`; `serverTraces
collapses off-server targets to nic and carries blocked labels`; `serverTraces adds inbound
trace for public-port blueprints`; `attributeCores greedy assignment and dominant owner`;
`attributeCores returns null dominants for zero demand`; determinism: same inputs → deep-
equal output twice.

**Commit:** `feat(server-view): add pure board layout, traces, and core attribution`

---

## Task 2: Engine server-scope particles `[sonnet]`

**Files:** modify `src/lib/worldEngine/index.ts` (buildPayload server branch +
`buildServerParticles` + `MAX_SERVER_PARTICLES = 50` beside the other caps), comment-only
sync in `src/lib/worldEngine/types.ts` (copy the amended VisualParticle vocabulary comment
from the contracts doc — NO type changes); create `src/lib/worldEngine/serverParticles.test.ts`.

**Semantics (D3, mirrors `buildAzParticles` at index.ts:477 — read it first):** for each
resident instance of the server (use `groupInstancesByServer`-equivalent lookup on
`s.compiled`), from `s.prevFlows`:
- entry rps > 0 → particles `nic:<serverId>` → instanceId
- each downstream row → instanceId → (resident target ? target instanceId : `nic:<serverId>`);
  `blocked: true` rows keep flowing as blocked particles (they burst in the view)
- managed-service rows are off-server by definition → `nic:<serverId>`
Sampling: same rps-proportional mechanics and `RENDER_PROGRESS_PER_MS` phase math as
`buildAzParticles` (`PARTICLE_RATIO` rps per particle), capped at `MAX_SERVER_PARTICLES`
after building (deterministic truncation, same as the AZ cap). `colorHint`: target
instance's blueprint color for inbound/intra traces; from-instance's blueprint color for
instance→nic outbound (D3). `protocol` from the dependency (entry traffic is `http`).
`buildPayload`: `if (scope.level === 'server') return { simMs, particles:
buildServerParticles(scope.serverId, wallMs), arcs: [] }`; region stays empty with an
updated comment ("region arrives in Phase 4").

**Named test cases (drive via `createWorldEngine(seed)` + `__test_step`, fixture world
with 2 servers, a public entry blueprint, an intra-server dep, a cross-server dep, a
managed dep, and one firewall-blocked dep):** `server scope emits nic→instance entry
particles`; `intra-server dependency emits instance→instance particles`; `cross-server and
managed targets collapse to nic endpoint`; `blocked path emits blocked particles`;
`respects MAX_SERVER_PARTICLES cap` (crank peakRps); `colorHint carries the target
blueprint color`; `other servers' flows never leak into this scope`; `deterministic for a
fixed seed`; `az and globe payloads unchanged` (guard: az particle count for the same
fixture equals pre-change snapshot).

**Commit:** `feat(engine): emit server-scope render particles (cap 50)`

---

## Task 3: Static stage — ServerBoard, chips, plates, gate, NIC, traces `[sonnet]`

**Files:** create `ServerBoard.tsx`, `ServiceChip.tsx`, `StackPlate.tsx`,
`FirewallGate.tsx`, `NicBlock.tsx`, `TraceLayer.tsx` under `src/app/world/server/`;
REWRITE `src/app/world/ServerView.tsx` as the composition root. jsdom test file
`ServerBoard.test.tsx` co-located.

**Produces (exact):**

```tsx
// ServerBoard.tsx — owns scale-to-fit (ResizeObserver → transform: scale), PCB grid bg,
// layer stack: TraceLayer (SVG, z0) → DOM blocks (z1) → PacketLayer slot (z2, T5).
export interface ServerBoardProps {
  serverId: ServerId
  layout: BoardLayout
  traces: StaticTrace[]
  selection: BoardSelection | null            // T6 wires; T3 passes null and a noop
  onSelect: (s: BoardSelection | null) => void
  hoveredBlueprintId: BlueprintId | null      // T6 wires; T3 passes null
  onHoverBlueprint: (id: BlueprintId | null) => void
}
export function ServerBoard(props: ServerBoardProps): ReactElement
```

`ServiceChip` renders name, signature-color tab (`bp.color`), status dot (instance health
from display metrics when available — T4 refines; T3 renders the green dot statically),
ports line (`:443 :80` from blueprint ports; container chips show `:host→container` from
portMappings), conn/p50 line (T4 fills; T3 renders `—`). `StackPlate` per mockup: dashed
purple plate, `▣ stack: <name> · <networkLabel>` header, contained chips, volume cylinders
(SVG ellipse-topped cylinders) along the bottom. `FirewallGate`: amber arch + shield glyph
+ `FIREWALL · <n> rules` caption (blocked/s line arrives in T5). `NicBlock`: teal edge
connector, `eth0`, `<nicMbps> Mbps` (live bar arrives in T4). `TraceLayer`: one `<path>`
per StaticTrace using `layout.tracePath`, permitted = protocol color at 0.85 opacity with
drop-shadow glow, blocked = `var(--color-danger)` dashed `4 4` with the label rendered at
the path midpoint (mockup's `refused :5432 — rule 6` style); paths are clickable → select
`{kind:'instance'}` of the from-endpoint (T6 refines this to a trace inspect; T3 wires
the click to `onSelect(null)`-safe noop). New `ServerView.tsx`: header strip
(`<label> · <kind> · <vcpu> vCPU / <GB> GB — <az label> › <rackId> › U<unit>` per mockup
header), flex row = stage (flex 2.6) + rail placeholder (`<aside>` 240px, T6 replaces).
Reuse `useCompiledWorld()`; `layout`/`traces` via `useMemo` on `[doc, serverId]`.

**Named jsdom tests:** `renders a chip per resident instance with signature color`;
`container chips render inside their stack plate`; `blocked trace renders dashed with rule
label`; `renders overflow chip when instances exceed MAX_BOARD_CHIPS`; `header shows
specs and rack position`.

**Live smoke (controller-run):** author region→AZ→server, blueprint with public port +
container placement in a stack, second blueprint with a dependency the firewall blocks →
navigate to server → board shows NIC/gate/chips/plate, red dashed trace with label, zero
console errors, screenshot.

**Commit:** `feat(server-view): static circuit-board stage replacing the Phase-1 readout`

---

## Task 4: Hardware platform + live display metrics `[sonnet]`

**Files:** create `HardwarePlatform.tsx`, `useServerDisplayMetrics.ts`; extend
`NicBlock.tsx` (live bar) and `ServiceChip.tsx` (conn/p50 line, health dot); jsdom test
`HardwarePlatform.test.tsx`.

**Produces (exact):**

```ts
export interface ServerDisplay {
  server: ServerMetrics | null
  instances: Record<InstanceId, InstanceMetrics>
  scrubbing: boolean
}
export function useServerDisplayMetrics(serverId: ServerId): ServerDisplay
// zustand selector over useSimulationStore: (scrubBatch ?? latestBatch) sliced to this
// server + its resident instances; scrubbing = scrubBatch !== null.
```

```tsx
export interface HardwarePlatformProps {
  server: Server                      // doc entity (specs, stacks, kind)
  metrics: ServerMetrics | null       // null = at-rest (D5)
  residentBlueprints: { instanceId: InstanceId; blueprintId: BlueprintId; color: string; name: string }[]
  attribution: CoreAttribution[]      // from attributeCores (T1) over live cpuCoresUsed
  hoveredBlueprintId: BlueprintId | null
  onHoverBlueprint: (id: BlueprintId | null) => void
  onSelect: (s: BoardSelection | null) => void
}
export function HardwarePlatform(props: HardwarePlatformProps): ReactElement
```

**Bindings (D4, mockup right rail):** CPU die = `⌈√vcpu⌉`-column grid of core cells, each
filled bottom-up by `coreUtilization[i]`, colored by attribution dominant blueprint (blue
`#4A9EFF` fallback); ring = SVG circle pair, aggregate arc (mean utilization) + hatched
amber steal arc (`stealFraction`, dasharray hatching per mockup line 91); caption
`cpu <n>% + <m>% steal` (steal omitted when 0); burstCredits non-null → thin credit bar
under the caption. RAM reservoir = strata per `ramByInstance` in array order bottom-up,
blueprint colors, + amber `os + cache` remainder = `max(0, ramUsedMb − Σ)`, meniscus
shimmer line (suppressed under reduced motion); legend rows right of the tank, `⚠oom`
mark on any instance whose `ramMb` ≥ 90% of its container `memLimitMb`. Disk platter =
SVG donut slices: one per compose volume (`sizeGb/diskGb`, amber family), muted `system`
slice = 15% of diskGb (D4), remainder dark = free; scanner line rotates with period
`3.5s / max(diskIoFraction, 0.05)`, parked at 12 o'clock when metrics null or reduced
motion; caption `nvme0 <used>/<total>G · io <n>%` (used = system + Σ volumes).
At rest (metrics null): cores/ring 0, strata estimated from each resident blueprint's
`workload.ramBaseMb` with a muted `at rest` caption (D5). NIC bar: `(nicIn+nicOut)/nicMbps`
width. Chips gain `<activeConnections> conn · p50 <p50Ms>ms` and health-colored dot.
All hardware sub-elements fire `onSelect` (`hardware`/`core` kinds) and hover-report their
dominant blueprint.

**Named jsdom tests:** `renders one core cell per vcpu`; `steal arc appears only for vps
with steal`; `ram strata follow ramByInstance order and include os+cache remainder`;
`at-rest estimate uses ramBaseMb when no batch`; `disk slices proportional to volume
sizes`; `oom warning appears at 90% of memLimit`; `scrubbing pill visible when scrubBatch
set`.

**Live smoke:** simulate the T3 world; verify ring/strata/nic bar move, screenshot;
scrub after Stop → strata reflect the scrubbed frame.

**Commit:** `feat(server-view): live unified hardware platform (cpu die, ram reservoir, disk platter)`

---

## Task 5: Packet layer + gate stats `[sonnet]`

**Files:** create `PacketLayer.tsx`, `gateStats.ts`, `gateStats.test.ts`; extend
`FirewallGate.tsx` (blocked/s line) and `ServerBoard.tsx` (mount PacketLayer at z2).

**Produces (exact):**

```tsx
export interface PacketLayerProps { serverId: ServerId; layout: BoardLayout }
export function PacketLayer(props: PacketLayerProps): ReactElement
// Canvas absolutely covering the (unscaled) 1000×560 stage — it lives INSIDE the scaled
// stage div so logical coords need no conversion. attachRenderer({level:'server',
// serverId}) once per (serverId, running); draw via refs: for each particle, position =
// point at `progress` along layout.tracePath(fromId,toId) — implement with a cached
// Path2D + getPointAtLength on a hidden SVG path element per unique pair (cache in a
// ref Map keyed `${fromId}→${toId}`). blocked && progress > 0.85 → red burst ring at the
// gate anchor when fromId is the nic, else at the target anchor (D6). Reduced motion →
// ≥500ms between redraws.
```

```ts
export function blockedPerSecond(
  events: EngineEvent[], serverId: ServerId, nowSimMs: number, windowMs?: number, // default 5000
): number
// count of kind === 'connection_refused' events with serverId ∈ affected and
// simMs ∈ (nowSimMs − windowMs, nowSimMs], divided by windowMs/1000.
```

`FirewallGate` renders `✕ <blockedPerSecond>/s blocked` in danger color when > 0
(reads `events` + latest batch `simMs` from the store).

**Named tests:** gateStats — `counts only this server's refused events in the window`;
`returns 0 outside window`; `scales to per-second`. PacketLayer (jsdom): `attaches
renderer when running and detaches on unmount` (mock store's attachRenderer, assert
detach called); `does not attach when stopped`.

**Live smoke:** simulate → packets visibly traverse nic→gate→chip and chip→plate traces;
blocked burst at the gate with the counter incrementing; reduced-motion emulation
(Playwright `emulateMedia`) still shows current-state redraws.

**Commit:** `feat(server-view): engine-driven packet layer and firewall block counter`

---

## Task 6: Selection model, inspector rail (read), cross-highlight `[sonnet]`

**Files:** create `selection.ts`, `InspectorRail.tsx`, `InspectorRail.test.tsx`; wire
selection + hover through `ServerView.tsx`/`ServerBoard.tsx` (replace T3's noops); add
dim/glow treatment to `ServiceChip`/`StackPlate`/`HardwarePlatform`/`TraceLayer`.

**Produces (exact):**

```ts
export type BoardSelection =
  | { kind: 'instance'; instanceId: InstanceId }
  | { kind: 'nic' }
  | { kind: 'firewall' }
  | { kind: 'rule'; ruleId: string }
  | { kind: 'stack'; stackName: string }
  | { kind: 'volume'; stackName: string; volumeName: string }
  | { kind: 'hardware'; part: 'cpu' | 'ram' | 'disk' }
  | { kind: 'core'; coreIndex: number }
```

```tsx
export interface InspectorRailProps {
  serverId: ServerId
  selection: BoardSelection | null
  onSelect: (s: BoardSelection | null) => void
}
export function InspectorRail(props: InspectorRailProps): ReactElement
```

Read panels per kind (mockup rail): instance → blueprint name, runtime + stack, binds,
cpu of limit, mem of limit (danger at ≥90%), host-resource rows (ram stratum %, hottest
core share via attribution); nic → speed, live in/out; firewall → rule list in order with
`first match wins · default deny` note, each row clickable → `rule` selection; rule → its
fields; stack → networks/volumes/members; volume → size, consumers (blueprints whose
`volumeName` matches); hardware/core → the matching live numbers. Empty selection → hint
text (`click any element…`). Esc with a selection clears it WITHOUT navigating up a level
(stopPropagation before the nav-shell Esc handler; note: verify against WorldShell's
key handling and document in the fragment). Hover: chips, strata, core cells, disk
slices, and volume cylinders call `onHoverBlueprint`; hovered blueprint's elements get
glow (`box-shadow` accent), everything else drops to opacity 0.45 (D8); no transition
under reduced motion.

**Named jsdom tests:** `instance selection shows runtime, limits, and host resources`;
`firewall selection lists rules in order and drills into a rule`; `volume panel lists
consumers by volumeName`; `esc clears selection without changing nav level`; `hovering a
chip dims unrelated chips and highlights its ram stratum`.

**Commit:** `feat(server-view): selection model, HUD inspector rail, signature cross-highlight`

---

## Task 7: Inspector editing forms + edit-lock `[sonnet]`

**Files:** create `inspectorForms.tsx`; extend `InspectorRail.tsx` to mount forms;
extend `InspectorRail.test.tsx`.

**Produces (exact):**

```tsx
export function WorkloadForm(props: { blueprintId: BlueprintId }): ReactElement
// numeric inputs for the 4 WorkloadProfile fields + color input for bp.color →
// useWorldStore.updateBlueprint(id, { workload }) / ({ color }) on commit (blur/Enter).
export function RuntimeForm(props: { placementId: string }): ReactElement
// container runtime only: cpuLimit (nullable), memLimitMb (nullable), portMappings rows
// (host/container add/remove), networkNames checkboxes from the server's stack networks →
// updatePlacement(id, { runtime }). Process runtime → explanatory text, no form. Count/
// role/runtime-type switching intentionally absent (D7 boundary — PlacementPanel owns it).
export function FirewallEditor(props: { serverId: ServerId }): ReactElement
// rows in array order: action/port/protocol/source editors, ✕ remove, ↑↓ reorder buttons
// with aria-labels 'move rule up'/'move rule down', + add rule (defaults allow/tcp/any).
// Every change → updateServer(serverId, { firewall: nextArray }).
export function VolumesEditor(props: { serverId: ServerId; stackName: string }): ReactElement
// volume rows (name readonly, sizeGb numeric, ✕) + add → updateServer(serverId,
// { stacks: nextStacks }).
```

All forms render inside `<fieldset disabled={running} style={…}>` (D9); a muted
`stop simulation to edit` note when running. Numeric inputs clamp to ≥0 and reject NaN
(keep last valid). After any edit the board recompiles via the existing `useCompiledWorld`
memo — a firewall allow added ABOVE a blocking deny must flip the static trace to
permitted (this is the acceptance story).

**Named jsdom tests:** `workload form patches blueprint via updateBlueprint`; `runtime
form patches container limits and port mappings`; `firewall reorder swaps array order`
(assert exact array passed to updateServer); `adding an allow rule above the deny unblocks
the compiled path` (assert on a recompiled fixture, not the DOM trace); `volume resize
patches stacks`; `all forms disabled while running`; `invalid numeric input does not fire
an update`.

**Live smoke:** with the T3 blocked world: Stop → select firewall → add allow rule above
the deny → red trace turns teal; select the api chip → raise memLimitMb → value persists
after nav away/back; run → forms disabled.

**Commit:** `feat(server-view): inspector editing (workload, runtime, firewall, volumes) with sim edit-lock`

---

## Task 8: PlacementPanel MANAGED_TYPES ↔ CLOUD_REGISTRY alignment `[haiku]`

**Files:** modify `src/app/world/panels/PlacementPanel.tsx`, `src/lib/costModelV2.ts`
(+ its test) — read both first; the exact alias set lives in costModelV2's alias table
(Phase-2 rulings item: `rds→dbSql`, `s3→objectStorage`, `sqs→queue`).

**Semantics:** PlacementPanel's managed-service type options change to the CLOUD_REGISTRY
keys the aliases pointed at (label text stays human-readable); `costModelV2`'s alias
table shrinks to only what's still needed for worlds saved with the old keys (keep the
aliases for backward compat of existing `.scalemap` files — they are load-bearing for
loaded docs — but new authoring emits registry keys directly). Add/adjust tests: new
authoring path prices without aliases; a doc using legacy `rds` still prices.

**Commit:** `refactor(world): author managed services with CLOUD_REGISTRY keys`

---

## Task 9: Final integration, full live smoke, boundaries §L `[sonnet]`

**Files:** modify `docs/module-boundaries.md` (add §L: server interior — file list,
boundaries: `server/` imports lib + stores but nothing under `panels/`; engine facade
untouched except T2), fix any accumulated Minors the controller queued, run the whole
verification battery.

**Done bar (this task's checklist):** full suite green; `npm run build` green; the spec's
live-smoke script executed end-to-end (author → blocked trace → simulate → packets/
hardware live → stop → firewall fix flips trace → hover highlight → scrub strata) with
zero console errors and screenshots; ledger `## PHASE 3` summary appended (per-task lines
+ open items + drift-log state).

**Commit:** `docs: update module boundaries for the server interior (§L)`
