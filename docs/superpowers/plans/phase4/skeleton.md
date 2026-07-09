# Phase 4 Plan Skeleton — Region Flow Page + Rack Chassis

Authored by the Phase-4 planning session (Fable). The executor session expands each task
below into a full Phase-2/3-style plan section (failing-test-first, complete code, exact
commands, commit step) per the handoff runbook's Step 0. Signatures and semantics here are
exact — expand, don't redesign. Decisions cited as D1–D11 are the phase spec's
(`docs/superpowers/specs/2026-07-09-phase4-region-rack-design.md`).

Binding companions: that spec, the FROZEN contracts (NO amendment this phase — D2), and
the approved mockup `docs/superpowers/specs/mockups/views-overview-v2.html` (Level-2
region panel + Level-3 rack panel are the visual truth).

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
  actions (T7 adds ONE parameter to ONE action; nothing else).
- Renderer/effect discipline: no per-frame setState; no effects keyed on viewport/hover
  (D9/D11); all looping animation gated on `prefers-reduced-motion`
  (framer-motion `useReducedMotion`, and CSS `@media (prefers-reduced-motion)` for the
  SVG dash animations).
- Colors: theme tokens for semantics; mockup scene hexes stay local constants in the new
  `region/` files (no new global tokens). Font via `--font-mono`.
- Live Playwright smokes controller-run on strict port 1420, ZERO app console errors,
  screenshots, server stopped after.
- Ledger: `.superpowers/sdd/progress.md` under `## PHASE 4`. Boundaries doc gains §M (T8).

## File Structure

```
src/app/world/region/                # NEW — Level-2 flow page internals
  regionData.ts (+ .test.ts)         # T1: pure selectors (shares, ribbon, events, repl, sparkline)
  AlertRibbon.tsx                    # T2
  SplitLines.tsx                     # T2: animated SVG split column
  AzRow.tsx                          # T2: ring + strips + $ + outage switch + drain line
  CrossAzColumn.tsx                  # T2
  RegionView.test.tsx                # T2 (tests the composed page)
  TimelineStrip.tsx (+ .test.tsx)    # T3: failover timeline + scrub coupling
src/app/world/RegionView.tsx         # T2: REWRITTEN as the flow composition root
src/lib/world/layoutRacks.ts (+ test)# T4: pure rack layout (frames, units, fillers, PDU)
src/app/world/RackNodes.tsx          # T5: RackFrameNode + RackChassisNode (+ jsdom test)
src/app/world/WorldServerNode.tsx    # T5: WorldServerNode DELETED (WorldManagedNode moves
                                     #     into RackNodes.tsx; grep importers first)
src/app/world/AzCanvas.tsx           # T5: rewired to frames/chassis via layoutRacks
src/app/world/AzSimOverlay.tsx       # T6: absolute coords, measured dims, imperative viewport
src/app/store/world.store.ts         # T7: addManagedService provider param
src/app/world/panels/…               # T7: provider <select> in the managed-service authoring
                                     #     UI (grep for the addManagedService caller first)
src/app/world/server/{ServerBoard,inspectorForms,FirewallGate,PacketLayer}.tsx  # T7 hygiene
src/lib/costModelV2.test.ts          # T7: authored-provider pricing case
docs/module-boundaries.md            # T8: §M
```

Dependency order: T1 → T2 → T3; T4 → T5 → T6; T7, T8 last (T8 after all). Serial
execution T1…T8 is simplest and correct.

---

## Task 1: Pure region-data module `[sonnet]`

**Files:** create `src/app/world/region/regionData.ts`, `regionData.test.ts`.

**Produces (exact):**

```ts
import type { WorldDoc, CompiledWorld, RegionId, AzId, ServerId, BlueprintId } from '../../../lib/world/types'
import type { MetricsBatch, EngineEvent, ReplayFrame } from '../../../lib/worldEngine/types'

export interface AzShare { azId: AzId; fraction: number; rps: number; down: boolean }
// Ordered by doc iteration order. fraction of the region's total az rps (0 when total 0);
// down = batch az health === 'down' (or healthOverride-style absence tolerated: null batch
// → fraction 0, down false).
export function azShares(regionId: RegionId, doc: WorldDoc, batch: MetricsBatch | null): AzShare[]

export interface RibbonAlert { severity: 'warning' | 'critical'; message: string; simMs: number }
// Most severe (critical > warning), then most recent, event among regionEvents() within
// the last 30_000 simMs. Message formatting: for outage/health events on an AZ append
// `— traffic redistributed to <healthy AZ labels>`; if a ttl-lagged population is still
// routed at a down region (a failover_started without matching failover_completed),
// append `· clients still arriving (DNS TTL)`. Info events never ribbon.
export function ribbonAlert(regionId: RegionId, doc: WorldDoc, events: EngineEvent[], nowSimMs: number): RibbonAlert | null

// Events whose affected ids intersect: the regionId, its AZ ids, its server ids, its
// resident instance ids (prefix match `<placementId>#` via compiled), or population ids
// currently routed to this region per batch.world.populationRoutes.
export function regionEvents(regionId: RegionId, doc: WorldDoc, compiled: CompiledWorld, events: EngineEvent[], batch: MetricsBatch | null): EngineEvent[]

export interface ReplicationPair { blueprintId: BlueprintId; blueprintName: string; fromAzId: AzId; toAzId: AzId; linkDown: boolean }
// Stateful blueprints with a primary-role instance in one of this region's AZs and a
// replica-role instance in a DIFFERENT AZ of the same region. linkDown = either AZ down.
export function replicationPairs(regionId: RegionId, doc: WorldDoc, compiled: CompiledWorld, batch: MetricsBatch | null): ReplicationPair[]

export interface CrossAzEntry { a: AzId; b: AzId; latencyMs: number; linkDown: boolean; replication: ReplicationPair[] }
// One entry per unordered AZ pair (a < b by label) connected by ≥1 cross-az compiled path
// between this region's instances OR ≥1 replication pair. latencyMs = the engine's
// cross-AZ hop constant imported from src/lib/worldEngine/latency.ts (read that file for
// the exported name; it is a pure constants module — permitted import, D5).
export function crossAzEntries(regionId: RegionId, doc: WorldDoc, compiled: CompiledWorld, batch: MetricsBatch | null): CrossAzEntry[]

// Last n frames' regions[regionId].rps (missing frames/regions → 0), oldest first.
export function sparklineSeries(frames: ReplayFrame[], regionId: RegionId, n?: number): number[]  // n default 60

// Signature color of the blueprint with the highest instance count on this server
// (ties → first by compiled iteration); fallback 'var(--color-text-muted)'.
export function dominantBlueprintColor(serverId: ServerId, doc: WorldDoc, compiled: CompiledWorld): string
```

**Named test cases (minimum):** `azShares splits by rps and pins down AZs to zero`;
`azShares handles null batch`; `ribbonAlert picks critical over newer warning`;
`ribbonAlert appends redistribution targets for an az outage`; `ribbonAlert null when
only info events`; `regionEvents matches az, server, instance, and routed-population
ids and excludes other regions`; `replicationPairs pairs primary and replica across azs
and flags down links`; `crossAzEntries derives pairs from cross-az paths and replication,
deduped`; `sparklineSeries pads and orders oldest-first`; `dominantBlueprintColor picks
the most-placed blueprint`.

**Commit:** `feat(region): add pure region-data selectors`

---

## Task 2: Region flow page `[sonnet]`

**Files:** create `AlertRibbon.tsx`, `SplitLines.tsx`, `AzRow.tsx`, `CrossAzColumn.tsx`,
`RegionView.test.tsx` under `src/app/world/region/`; REWRITE `src/app/world/RegionView.tsx`.

**Produces (exact):**

```tsx
export function AlertRibbon(props: { alert: RibbonAlert | null; onTimelineClick: () => void }): ReactElement | null
export function SplitLines(props: { shares: AzShare[]; height: number }): ReactElement
// One cubic path per share from a common left origin to each row's vertical center;
// stroke width 1 + 2×fraction, teal; down shares thin red `2 7` dash at 0%; percentage
// labels at path midpoints; dash-offset animation suppressed under reduced motion.
export function AzRow(props: {
  azId: AzId
  regionId: RegionId
  onNavigateAz: () => void
  onNavigateServer: (serverId: ServerId) => void
}): ReactElement
export function CrossAzColumn(props: { regionId: RegionId }): ReactElement
```

`RegionView` composition top-to-bottom: header (region catalogId + `<label> · <n> AZs ·
<m> servers · <k> service instances`, routing-policy chip + health-interval chip from
`doc.routing`, the EXISTING region outage button preserved) → `AlertRibbon` → flow row
(inbound column: ◍ glyph, `global edge`, region rps, `sparklineSeries` polyline polled at
1 Hz while running — reuse InspectorV2's poll pattern; → `SplitLines`; → `AzRow` stack; →
`CrossAzColumn`) → `TimelineStrip` slot (T3 fills; T2 renders nothing there).
`AzRow` per D4: health ring (healthScore arc + numeral, health color), label + counts,
one strip per server (height % = mean coreUtilization, `borderTop: 2px solid
<dominantBlueprintColor>`, title = server label, click → `onNavigateServer` with
stopPropagation), metrics right column with per-AZ `$<n>/mo` from costModelV2 (read its
exports first — the per-AZ breakdown shipped in Phase 2 T16), per-row ⚡ outage switch
(running-gated, `setOutage('az', …)`, stopPropagation); down rows: dim 0.8, red left
border, drain line `draining → <healthy az labels>` + `· replicas promoting` when a
`replica_promoted` event touched this AZ's servers within 30s. Row click → `onNavigateAz`.
Empty region (no AZs) keeps today's hint text.

**Named jsdom tests:** `renders one AzRow per az with ring score`; `down az row shows
drain targets instead of strips`; `az outage switch dispatches setOutage('az')`; `server
strip click navigates to server, row click to az`; `ribbon renders redistribution message
and timeline link`; `renders static skeleton with no batch`.

**Live smoke:** 2-AZ region under load → shares sum to ~100%, $ figures render, strips
move; kill an AZ via its row switch → ribbon appears, splits re-share, drain line shows.

**Commit:** `feat(region): region flow page — ribbon, split lines, az rows, cross-az column`

---

## Task 3: Failover timeline strip `[sonnet]`

**Files:** create `src/app/world/region/TimelineStrip.tsx`, `TimelineStrip.test.tsx`;
mount in `RegionView.tsx` (replace T2's empty slot); AlertRibbon's `timeline` link scrolls
to it (`ref` + `scrollIntoView` + a one-shot highlight class).

**Produces (exact):**

```tsx
export function TimelineStrip(props: { regionId: RegionId }): ReactElement | null
// Renders null when regionEvents() is empty. Axis = last 120_000 simMs ending at the
// display batch's simMs (or the newest event when no batch). Glyph per kind:
// outage_triggered/cleared ⚡, health_check_failed ♺, failover_started/completed ⇄,
// ttl_lag_expired ◷, replica_promoted ⬆, oom_kill ☠, noisy_neighbor ▲, others ●.
// Color by severity (danger/warning/muted-info). Hover tooltip: message + `t+<s>s`.
// Click while NOT running and replay frames exist → setScrubIndex(nearest frame index by
// |frame.simMs − event.simMs|); while running, clicks are inert (title explains).
```

**Named jsdom tests:** `renders glyphs for region-scoped events only`; `click while
stopped scrubs to nearest frame` (mock store: getReplayFrames + setScrubIndex spy);
`clicks inert while running`; `null with no events`.

**Live smoke:** after the T2 kill scenario, Stop → click the outage event → ScrubberV2
shows scrub state and the page reflects the historical frame.

**Commit:** `feat(region): failover timeline with click-to-scrub`

---

## Task 4: Pure rack layout `[sonnet]`

**Files:** create `src/lib/world/layoutRacks.ts`, `layoutRacks.test.ts`. (Leave
`layoutAz.ts` in place until T5 removes its last importer, then T5 deletes it —
grep-verify there.)

**Produces (exact):**

```ts
import type { Server, ServerId } from './types'

export const U_PX = 44
export const CHASSIS_W = 220
export const RACK_PAD = 10          // frame padding around the chassis column
export const RAIL_W = 8
export const RACK_W = CHASSIS_W + 2 * (RACK_PAD + RAIL_W)   // 256
export const RACK_GAP = 60
export const PDU_H = 18
export const MANAGED_W = 170
export const MANAGED_H = 60

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
export function layoutRacks(servers: Server[], managedIds: string[]): RackLayout
```

Semantics: group by `rack.rackId`; within a frame, chassis at `y = RACK_PAD +
(unit − minUnit) × (U_PX + 4)` — colliding/duplicate units resolve by re-stacking in
unit-then-label order (never overlap); frame height fits chassis + one blank-U filler in
each unit gap (cap 3 fillers) + PDU. Frames laid left-to-right at `x = i × (RACK_W +
RACK_GAP)`, `y = 0`. Managed column at `x = frames' right edge + RACK_GAP`, entries
stacked with 20px gaps. Deterministic; empty-server AZ → empty frames array, managed
still laid out.

**Named test cases:** `groups servers into frames by rackId sorted by unit`; `chassis
height scales with heightU`; `duplicate units re-stack without overlap`; `blank fillers
appear in unit gaps, capped`; `pdu sits below last chassis`; `managed column right of all
frames`; `deterministic output`.

**Commit:** `feat(world): pure rack-frame layout for the AZ canvas`

---

## Task 5: Rack frame + chassis nodes, AzCanvas rewire `[sonnet]`

**Files:** create `src/app/world/RackNodes.tsx` (+ `RackNodes.test.tsx`); REWIRE
`src/app/world/AzCanvas.tsx` (nodes/edges from `layoutRacks`; nodeTypes
`{ worldRackFrame, worldChassis, worldManaged }`); DELETE `src/app/world/WorldServerNode.tsx`
after moving `WorldManagedNode` into `RackNodes.tsx` (grep importers first — AzSimOverlay
references node TYPE strings, and Phase-3 files import nothing from it; verify).

**Produces (exact):**

```tsx
export interface RackFrameNodeData { rackId: string; azLabel: string; blankUnits: { y: number; h: number }[]; pduY: number; [k: string]: unknown }
export function RackFrameNode({ data }: NodeProps): ReactElement
// Non-interactive backdrop: rails (radial-gradient mounting-hole pattern per mockup line
// 56), caption `RACK <id> · <azLabel>`, filler strips, PDU bar `PDU · <n>kW` (kW = Σ
// resident chassis vcpu × 0.05, 1 decimal) with two green LEDs. zIndex below chassis.

export interface RackChassisNodeData {
  server: Server
  chips: { color: string; name: string }[]      // for the tooltip/title only
  internalBlocked: number
  health?: HealthState
  metrics?: { cpuMean: number; ramFrac: number; diskIo: number; nicFrac: number; rps: number } | null
  noisy: boolean                                 // noisy_neighbor event within 30s
  [k: string]: unknown
}
export function RackChassisNode({ data }: NodeProps): ReactElement
```

Chassis per D8/mockup: header line + LED trio (pwr = health color; act = 0.8s blink when
`metrics.rps > 0`, static dot under reduced motion; net lit when `nicFrac > 0.05`), body =
drive-bay grid (`min(8, 2×heightU+2)` bays, LEDs green on ~`ceil(diskIo × bays)` bays),
vent grill (repeating-linear-gradient), micro-bars (cpu blue `#4A9EFF`, ram amber
`#F5A623`, io teal `#2DD4BF`, heights = fractions), `▲ noisy neighbor` amber tag when
`noisy`, blocked badge `✕ <n> blocked internal path(s)` carried over. Handles left/right
as today. AzCanvas: frames become parent nodes (`type: 'worldRackFrame'`, `selectable:
false`, `zIndex: -1`), chassis children (`parentId`, `extent: 'parent'`, frame-relative
positions from `layoutRacks`), managed nodes absolute; edge aggregation logic is UNCHANGED
(copy it verbatim — source/target ids are still serverIds/managedIds); node click routes
`worldChassis` → `goServer`. `noisy` computed from store events (kind `noisy_neighbor`,
serverId ∈ affected, within 30s of display simMs).

**Named jsdom tests:** `chassis renders U-height, LEDs, and micro-bars from metrics`;
`noisy tag appears for recent noisy_neighbor`; `frame renders caption, fillers, and pdu`;
`blocked badge carries over`.

**Live smoke:** AZ canvas shows a rack frame with stacked chassis of differing U-heights,
live micro-bars while simulating, chassis click opens the server interior, managed node
still dashed. Screenshot.

**Commit:** `feat(az-canvas): rack frames and realistic chassis nodes replace flat server cards`

---

## Task 6: AzSimOverlay v2 — absolute coords, measured dims, imperative viewport `[sonnet]`

**Files:** modify `src/app/world/AzSimOverlay.tsx` (+ add `AzSimOverlay.test.tsx` if a
jsdom-testable seam emerges; otherwise the live smoke is the gate — say so in the plan).

**Semantics (D9):** replace `getNode` math with `getInternalNode(id)` →
`internals.positionAbsolute` (React Flow v12 — verify the exact property against the
installed `@xyflow/react` typings before writing code); node w/h from
`node.measured?.width/height` with the old constants as pre-paint fallback (chassis
heights vary by U). Remove `useViewport()` from the effect: read
`const { x, y, zoom } = getViewport()` INSIDE the frame callback so pan/zoom no longer
re-subscribes the renderer (the effect deps become `[running, azId, reduced]` +
stable fns). Everything else (reduced-motion throttle, blocked burst, colors) unchanged.

**Live smoke:** simulate, pan and zoom the AZ canvas continuously — particles track
chassis positions inside frames with no drift and no console errors; confirm via a
counter/log that the renderer attaches exactly once per run.

**Commit:** `fix(az-canvas): overlay tracks rack-nested nodes via absolute coords; no re-subscribe on pan/zoom`

---

## Task 7: Carry-forwards — provider selector + Phase-3 hygiene `[sonnet]`

**Files:** modify `src/app/store/world.store.ts` (`addManagedService(nodeType, label,
scope, port, provider: ManagedService['provider'] = 'generic')` — additive trailing
param), the managed-service authoring UI (grep the `addManagedService` caller — a panel
under `src/app/world/panels/` — add a provider `<select>` with options
aws/gcp/azure/generic, DEFAULT 'aws', wired through), `src/lib/costModelV2.test.ts` (new
case: a doc authored with provider 'aws' + nodeType from CLOUD_REGISTRY prices > 0),
`src/app/world/server/ServerBoard.tsx` (useMemo the derived values named in the Phase-3
ledger: residentBlueprints/attribution/memLimits/volumeConsumers/gateBlockedPerSecond
inputs), `src/app/world/server/inspectorForms.tsx` (falsy-zero: explicit
`Number.isFinite`/null checks where `0` is meaningful — port, cpuLimit, memLimitMb),
`src/app/world/server/FirewallGate.tsx` (blocked/s uses the DISPLAY batch's simMs —
scrub-correct), `src/app/world/server/PacketLayer.tsx` (wrap `getPointAtLength` in
try/catch; fallback = linear interpolation between the two anchors).

**Named tests:** `addManagedService stores the given provider` (store test);
`authored aws managed service prices non-zero` (costModelV2); existing suites stay green
(memoization and fallback are behavior-neutral — state that the covering tests are the
existing ServerBoard/inspectorForms/gateStats files and re-run them).

**Commit:** `fix(world): managed-service provider selection + server-view hygiene carry-forwards`

---

## Task 8: Final integration, phase smoke, boundaries §M `[sonnet]`

**Files:** `docs/module-boundaries.md` §M (region module + rack nodes: file list;
boundaries — `region/` imports lib + stores + `worldEngine/latency` constants only;
`RackNodes` owns all chassis chrome; `layoutAz.ts` deleted in T5 noted); fix queued
Minors; run the battery.

**Done bar:** full suite + build green; the spec's phase-gate live story executed
end-to-end (region flow under load → AZ kill via row switch → ribbon/splits/drain/
timeline → stop → timeline click scrubs → rack frame + chassis live → chassis click →
server interior) with zero console errors + screenshots; ledger `## PHASE 4` summary
(per-task lines, open items, drift state — expected: no drift entries).

**Commit:** `docs: update module boundaries for region flow page and rack chassis (§M)`
