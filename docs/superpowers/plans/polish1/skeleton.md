# Polish Phase Plan Skeleton — Hybrid Panel System + Examples Vault

Authored by the planning session (Fable). The executor expands each task into a full plan
section per the handoff runbook's Step 0. Signatures and semantics are exact — expand,
don't redesign. D1–D7 cite the phase spec
(`docs/superpowers/specs/2026-07-10-polish-panels-vault-design.md`). The mockup
`docs/superpowers/specs/mockups/panels-hybrid-v1.html` is the binding visual truth:
Direction A blocks define the skin, Direction B blocks define the widgets, the vault
grid defines the home-screen cards. Open it in a browser before writing anything.

## Global Constraints (every task inherits these)

- Branch: `polish-panels-vault`, cut from `main` (≥ `bf0b78e`).
- ZERO changes under `src/lib/worldEngine/` and zero contract/data-model changes (D7).
  Forced drift → `.superpowers/sdd/contract-drift.md` `## POLISH 1`, never silently.
- **Restyles must not change store semantics.** Every panel keeps dispatching the same
  actions with the same patch shapes — the panels' EXISTING test files are extended,
  never weakened; a restyle task that has to touch an assertion about a dispatched patch
  is doing something wrong.
- strict tsc; `npm run build` green per commit; full `border` shorthand rule; jsdom
  pragma + jest-dom for component tests; pure tests node env.
- Kit is token-only (`var(--color-*)`); the HUD glow hexes (`#7CFFE9`, `#2DD4BF44`
  shadows) live as named constants in `src/app/world/ui/kit.ts` ONLY — no other file
  hardcodes them. Panel base font 11px, `tabular-nums` for digit columns (D1).
- Metrics-driven UI reads `scrubBatch ?? latestBatch`; every restyled surface keeps a
  meaningful at-rest state with no batch.
- All animation/hover transitions respect `prefers-reduced-motion` (kit centralizes
  this: one shared transition constant that collapses to none under the media query).
- Live smokes controller-run on strict port 1420, ZERO app console errors, screenshots
  (dark AND light for every restyled panel — the theme toggle is live now), stop the
  server after.
- Ledger: `.superpowers/sdd/progress.md` under `## POLISH 1`. Boundaries doc gains §P (T8).

## File Structure

```
src/app/world/ui/                     # NEW — the hybrid kit (T1)
  kit.tsx (+ kit.test.tsx)            # SectionHeader, EdgeRow, ChipValue, SpecBar,
                                      #   MicroBars, DerivedField, Segmented,
                                      #   PresetCardGrid, Explainer  (one file: they are
                                      #   small and always used together)
  derived.ts (+ derived.test.ts)      # pure hint math (T1)
src/app/world/panels/TopologyPanel.tsx      # T2 restyle (+ extend existing test)
src/app/world/panels/BlueprintPanel.tsx     # T3 restyle (+ extend existing test)
src/app/world/panels/PlacementPanel.tsx     # T3 restyle
src/app/world/panels/TrafficPanel.tsx       # T4 restyle (+ extend existing test)
src/app/world/panels/WorldPanel.tsx         # T4: tab bar treatment
src/app/world/SettingsModal.tsx             # T4: kit alignment
src/app/world/panels/AnalysisTab.tsx        # T4: kit alignment (headers/chips only)
src/app/world/server/inspectorForms.tsx     # T4: firewall stack restyle (mockup A block)
src/app/world/server/InspectorRail.tsx      # T4: header/spacing alignment
src/lib/vault/exampleWorlds.ts (+ .test.ts) # T5: the four VaultEntry builders
src/app/home/HomeScreen.tsx (+ .module.css) # T6: vault section
src/app/home/VaultCard.tsx (+ test)         # T6
src/app/store/simulation.store.ts           # T7: resetSession action (additive)
src/app/store/world.store.ts (+ test)       # T7: newWorld/replaceWorld call resetSession
src/app/world/ScrubberV2.tsx                # T7: latestBatch gate
docs/module-boundaries.md                   # T8: §P
```

Dependency order: T1 → T2 → T3 → T4; T5 → T6; T7 independent; T8 last. Serial T1…T8.

---

## Task 1: The kit + derived-hint math `[sonnet]`

**Files:** create `src/app/world/ui/kit.tsx`, `kit.test.tsx`, `derived.ts`,
`derived.test.ts`.

**Produces (exact — component props are the kit's contract; T2–T4 import these):**

```tsx
export function SectionHeader(props: { label: string; accent?: string;  // hex, default kit teal glow
  trailing?: ReactNode }): ReactElement
export function EdgeRow(props: { edgeColor?: string; status?: 'healthy' | 'degraded' | 'down' | null;
  onClick?: () => void; trailing?: ReactNode; children: ReactNode }): ReactElement
export function ChipValue(props: { children: ReactNode; title?: string }): ReactElement
export function SpecBar(props: { label: string; fraction: number; color: string; value: string }): ReactElement
export function MicroBars(props: { cpu: number; ram: number; io: number }): ReactElement  // 0..1 each
export function DerivedField(props: {
  label: string
  value: number
  onCommit: (v: number) => void        // clamp/NaN discipline INSIDE the kit (Phase-4 T7 convention)
  min?: number; max?: number; step?: number
  mode?: 'input' | 'slider'            // slider renders range + numeric readout
  unit?: string
  derive?: (v: number) => string       // live hint line, teal (mockup .b-derive)
  disabled?: boolean
}): ReactElement
export function Segmented<T extends string>(props: {
  options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; ariaLabel: string
}): ReactElement
export function PresetCardGrid<T extends string>(props: {
  options: { value: T; name: string; detail: string; price: string }[]
  value: T; onChange: (v: T) => void
}): ReactElement
export function Explainer(props: { children: ReactNode }): ReactElement
```

```ts
// derived.ts — pure, exact signatures
export function rpsPerCore(cpuMsPerRequest: number): number            // 1000/ms, 0-safe
export function hostRpsCapacity(vcpu: number, cpuMsPerRequest: number): number
export function ramAtConnections(baseMb: number, perConnMb: number, conns?: number): number  // default 2000
export function residentRamDemandMb(serverId: string, doc: WorldDoc, compiled: CompiledWorld): number
  // Σ resident (memLimitMb ?? workload.ramBaseMb) — the SAME quantity the
  // ram-oversubscribed analysis rule sums; read that rule first and extract/share
  // rather than duplicating if a clean export exists.
export function ttlLagHint(routing: RoutingConfig): string | null
  // null when TTL ≥ detection time; else the mockup-style one-liner with both numbers.
export function diskIoWord(diskIoPerRequest: number): 'light' | 'moderate' | 'heavy'  // <0.5 / <2 / ≥2
```

**Named test cases:** every derived fn with exact numbers (incl. 0/NaN guards);
DerivedField `commits clamped value on blur and Enter`, `slider updates the derive line
live`, `rejects NaN keeping last valid`, `disabled renders inert`; Segmented
`fires onChange and marks selection`; PresetCardGrid `select dispatches value`; EdgeRow
`status maps to dot color`; SpecBar `clamps fraction to [0,1]`.

**Commit:** `feat(ui): hybrid panel kit — instrument skin, console widgets, derived hints`

---

## Task 2: TopologyPanel restyle `[sonnet]`

**Files:** modify `src/app/world/panels/TopologyPanel.tsx`; EXTEND
`TopologyPanel.test.tsx` (existing assertions untouched).

**Semantics (D3, mockup A left panel):** read the CURRENT file first — every add/remove/
update dispatch survives byte-for-byte in behavior. Regions → `SectionHeader` per region
(`▸ US-EAST-1 · N. VIRGINIA` style label from `WORLD_REGIONS`, health dot trailing from
display batch, region-scoped accent). Servers → `EdgeRow` (edgeColor = kind: blue
dedicated / blue vps — degraded/down rows shift edge to warning/danger), content = label
+ meta line + utilization `SpecBar`-thin bar when a batch exists, trailing = `MicroBars`
(server metrics cpu-mean/ram-frac/diskIo) + `$X/hr` meta. AZ rows and managed rows in
the same family; add-controls (`+ Region`/`+ AZ`/`+ Server` etc.) keep their exact
handlers, restyled. At rest (no batch): bars empty, dots muted, no fake numbers.

**Named jsdom tests (added):** `server row shows micro-bars from a batch`; `at rest
renders without utilization`; `all existing add/remove flows still dispatch` (the
existing cases, re-run).

**Live smoke:** 3-tier-shaped world simulating → rows show live bars; light-mode
screenshot.

**Commit:** `feat(panels): topology tab in the hybrid instrument style`

---

## Task 3: BlueprintPanel + PlacementPanel restyle `[sonnet]`

**Files:** modify both panels; EXTEND `BlueprintPanel.test.tsx`; ADD
`PlacementPanel.test.tsx` if none exists (check first).

**Semantics (D3, mockup B right panel):** BlueprintPanel — blueprint cards with
signature-color tab (mockup `.b-head`), ports/deps meta, instance-count `ChipValue`;
the workload editor becomes FOUR `DerivedField`s: cpuMsPerRequest (`mode: 'slider'`,
1–60, derive = `→ one core sustains ~N rps; …` via `rpsPerCore`/`hostRpsCapacity` — host
line only when the blueprint has placements, using its FIRST placement's server vcpu),
ramBaseMb + ramPerConnMb (input mode, shared derive line via `ramAtConnections`),
diskIoPerRequest (derive = `diskIoWord`). Color stays an input but presents as the
signature swatch. Dependencies/ports editing keeps existing controls in kit clothing.
PlacementPanel — the add-server preset select becomes `PresetCardGrid` (options from
`INSTANCE_CATALOG`: name, `4 vCPU · 8 GB · shared tenancy` detail line, `$/hr` price);
count/role/runtime-type keep their exact update dispatches (`Segmented` for role).

**Named jsdom tests:** `workload slider commits updateBlueprint with exact patch`;
`derive line reflects committed cpu ms`; `preset card select feeds addServer with the
chosen preset`; existing dispatch cases re-run green.

**Live smoke:** drag the cpu slider → hint updates live; add server via preset card.

**Commit:** `feat(panels): blueprint and placement editing with derived-hint widgets`

---

## Task 4: TrafficPanel, WorldPanel chrome, Settings/Analysis/rail alignment, firewall stack `[sonnet]`

**Files:** modify `TrafficPanel.tsx` (+ extend its test), `WorldPanel.tsx` (+ test),
`SettingsModal.tsx`, `AnalysisTab.tsx`, `server/InspectorRail.tsx`,
`server/inspectorForms.tsx` (+ extend `InspectorRail.test.tsx`).

**Semantics (D3):** TrafficPanel — routing policy → `Segmented` (labels
`⚡ latency / 🌍 geo / ⚖ weighted / priority`) + per-policy `Explainer` one-liner
(latency: "each population is served by its fastest healthy region"; weighted/priority
keep their existing sub-editors below, kit-styled); `dnsTtlSec` becomes a `DerivedField`
whose derive = `ttlLagHint` (amber when non-null); populations list → `EdgeRow`s with
teal signature dots. WorldPanel tab bar — active tab edge-lit (border-bottom accent +
text-primary), counts as `ChipValue`. SettingsModal + AnalysisTab + InspectorRail —
adopt `SectionHeader`/`ChipValue`/`Explainer` for their existing sections (NO structural
changes; AnalysisTab keeps its severity chips as-is — they're already the kit's
ancestors). Firewall editor (`inspectorForms.tsx`) — restyle to the mockup's
amber-framed stack: `▼ evaluated top-down · first match wins ▼` header line, per-rule
rows (order number, ALLOW teal / DENY red, port/proto, source, existing ✕ and
aria-labeled ↑↓ buttons), `▼ everything else: DENIED ▼` footer in danger color. Same
`updateServer` dispatches, same tests extended.

**Named jsdom tests:** `policy segmented dispatches updateRouting`; `ttl hint appears
when TTL outlives detection and clears otherwise`; `firewall stack renders order
numbers and flow captions`; existing reorder/edit assertions re-run green.

**Live smoke:** flip policies, see explainers; set TTL 5s w/ 12s×3 detection → amber
hint; firewall stack screenshot dark + light.

**Commit:** `feat(panels): traffic, chrome, settings, and firewall stack in the hybrid style`

---

## Task 5: Examples vault — data `[sonnet]`

**Files:** create `src/lib/vault/exampleWorlds.ts`, `exampleWorlds.test.ts`.

**Produces (exact):**

```ts
import type { WorldDoc } from '../world/types'

export interface VaultEntry {
  id: 'three-tier' | 'multi-region-failover' | 'event-driven' | 'broken-teaching'
  name: string                    // mockup card names: 'Classic three-tier',
                                  // 'Multi-region failover', 'Event-driven microservices',
                                  // 'Everything wrong at once'
  blurb: string                   // mockup card blurbs, verbatim
  tags: string[]                  // mockup pill texts
  difficulty: 'beginner' | 'intermediate' | 'teaching'
  build: () => WorldDoc
}
export const VAULT: VaultEntry[]
```

**World contents (D4 — binding, built via `src/lib/world/factories.ts` helpers; read
an engine/analysis test fixture first for the doc-building idiom):**
- `three-tier`: us-east-1, 2 AZs; blueprints lb(public :443)→web→api→db(stateful,
  volume, primary+replica across AZs); ~6 servers; ONE population (NYC). Compiles with
  ZERO analysis findings and zero compile findings (tune firewalls/networks until true).
- `multi-region-failover`: us-east-1 + eu-west-1 active, ap-southeast-1 passive; web+api+db
  in each active region; populations NYC/London/Singapore; `dnsTtlSec: 20`,
  `healthCheckIntervalMs: 3000`, threshold 2 (TTL comfortably outlives detection — no
  hint, real lag drama on kill). Zero findings.
- `event-driven`: one region, 2 AZs; api(public) → managed queue (sqs-equivalent
  CLOUD_REGISTRY key, provider 'aws') and worker placements consuming… (workers DEPEND
  on the queue — model as worker blueprint with a managed dependency) in a compose stack
  with an internal network + volume for a stateful store. Zero findings.
- `broken-teaching`: one region ONE AZ (single-az-region), population with a one-region
  order (no-failover), db with :5432 allowed from 'any' (db-port-exposed) AND a public
  port (double exposure), a burstable VPS packed past its RAM (ram-oversubscribed), a
  dependency blocked by firewall (blocked-dependency-path + compile finding), a stateful
  blueprint without a volume, `dnsTtlSec: 5` vs 12s×3 detection (ttl-outlives-detection).
  Test asserts ≥10 analysis findings spanning all three families.

**Named test cases:** per entry — `compiles with the intended findings` (exact-zero or
≥10-spanning-families), `simulates: seeded engine reaches non-zero world rps in 50
steps` (createWorldEngine + `__test_step`, same harness as engine tests), `entry ids
and names unique`; `every build() returns a fresh deep copy` (two calls not reference-
equal).

**Commit:** `feat(vault): four example worlds with enforced findings contracts`

---

## Task 6: Examples vault — home screen `[sonnet]`

**Files:** create `src/app/home/VaultCard.tsx` (+ `VaultCard.test.tsx`); modify
`HomeScreen.tsx` + `HomeScreen.module.css`.

**Semantics (D5, mockup vault grid):** a `Start from an example` section (eyebrow-caps
header) below the actions row; one `VaultCard` per `VAULT` entry — inline SVG topology
glyph per the mockup (transcribe the four `<svg class="vg">` blocks), name, blurb, tag
pills, difficulty pill (beginner=success, intermediate=warning, teaching=danger);
hover lift (reduced-motion gated). Click: `replaceWorld(entry.build())`,
`setFilePath(null)`, dirty FALSE + createdIso null (pristine, the New stance — read
`newWorld` and mirror its file-store resets), `goGlobe()`, `setShowHome(false)`;
`broken-teaching` additionally lands with the WorldPanel's Analysis tab active — thread
via a one-shot `initialTab` mechanism: simplest is a `useUiStore` additive field
`pendingPanelTab: Tab | null` consumed-and-cleared by WorldPanel on mount (additive
store field, sanctioned).

**Named jsdom tests:** `renders all four cards with difficulty pills`; `click loads the
world, resets file state, and dismisses home` (assert store states); `teaching card
queues the analysis tab`; `cards render glyphs` (svg presence).

**Live smoke:** home → open teaching world → Analysis tab active with ≥10 findings →
back via New → home NOT shown (New stays in-shell; that is existing behavior) — instead
relaunch home via a fresh reload → open 3-tier → Simulate → live world. Screenshots.

**Commit:** `feat(vault): start-from-example cards on the home screen`

---

## Task 7: Stale replay after doc swap `[sonnet]`

**Files:** modify `src/app/store/simulation.store.ts` (additive `resetSession()`),
`src/app/store/world.store.ts` (call it from `newWorld`/`replaceWorld` instead of bare
`stop()`), `src/app/world/ScrubberV2.tsx` (render gate), EXTEND
`world.store.test.ts` + the scrubber's test file (check name first).

**Produces (exact):**

```ts
resetSession: () => void
// worldEngine.stop() + set({ running: false, latestBatch: null, events: [],
// scrubIndex: null, scrubBatch: null, degraded: false }) — healthOverrides also cleared
// (they referenced the discarded world's ids).
```

`ScrubberV2` renders only when frames exist AND `latestBatch !== null` (a fresh doc has
neither). Existing stop-then-scrub flow unaffected (stop() keeps latestBatch).

**Named tests:** `newWorld clears batch, events, scrub state, and health overrides`;
`replaceWorld likewise`; `scrubber hidden after doc swap, shown after a normal stop`.

**Commit:** `fix(replay): doc swap clears the sim session — no scrubbing a discarded world`

---

## Task 8: Final — phase smoke, light-mode pass, boundaries §P `[sonnet]`

**Files:** `docs/module-boundaries.md` §P (ui kit + vault modules; kit import rule:
panels import kit, kit imports nothing from panels; vault imports world factories only);
fix queued Minors; run the battery.

**Done bar:** full suite + build green; the spec's phase-gate live story end-to-end
(teaching world → fix-a-finding → 3-tier live bars → slider hints → New with no stale
scrubber → multi-region TTL story intact → EVERY panel screenshotted dark AND light);
ledger `## POLISH 1` summary + open items.

**Commit:** `docs: module boundaries §P — hybrid ui kit and examples vault`
