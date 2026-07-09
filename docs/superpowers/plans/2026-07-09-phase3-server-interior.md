# Phase 3: Server Interior Implementation Plan

**Date:** 2026-07-09 · **Branch:** `phase3-server-interior` (cut from `main`, Phase-2 head `3063952`)
**Binding specs:** `docs/superpowers/specs/2026-07-09-phase3-server-interior-design.md` (the 12
decisions D1–D12) and the FROZEN `docs/superpowers/specs/2026-07-08-world-engine-contracts.md`
(server-scope particle id vocabulary amended 2026-07-09). Approved mockup (visual truth):
`docs/superpowers/specs/mockups/serverview-hybrid-v3.html`. Umbrella:
`docs/superpowers/specs/2026-07-08-world-model-multiscale-simulation-design.md` §5 Level 4.

> Assembled by the Phase-3 execution session from the task fragments in
> `docs/superpowers/plans/phase3/fragments/` (`tasks-01-02.md`, `tasks-03-05.md`,
> `tasks-06-09.md`), authored at full fidelity from `phase3/skeleton.md` (the planning
> session's fragment writers were lost to a usage limit, so the controller wrote every task).
> Fragment preambles and `<!-- COMPLETE -->` sentinels were removed at assembly; no
> SKELETON CONCERNS blocks were raised (single-author fragments). Signatures/semantics are the
> skeleton's, expanded not redesigned; geometry + `attributeCores` values were arithmetic-
> verified before baking into tests. The only engine-surface addition is a test-only
> `__test_render` hook alongside `__test_step` (not part of the frozen `WorldEngineApi`) — logged
> in `.superpowers/sdd/contract-drift.md` §PHASE 3 if any forced drift occurs; none is expected.

## Goal

Replace the Phase-1 placeholder `ServerView` with the Level-4 living circuit board (D-goal): a
dark PCB stage where the NIC edge connector feeds a firewall gate arch, engine particles run the
traces to service chips and docker stack plates, and a unified hardware platform renders the
host's CPU die, stratified RAM reservoir, and sliced disk platter live from `ServerMetrics`.
Service signature colors bind chip ↔ RAM stratum ↔ core share ↔ disk slice; a HUD inspector rail
makes every element clickable and editable through existing `world.store` actions. One engine
addition: server-scope particle payloads (currently empty-but-valid per `buildPayload`).

## Architecture

- **`src/app/world/server/`** — everything Phase 3 adds. `boardLayout.ts` is a PURE, deterministic
  layout hub (fixed 1000×560 logical space, D1/D2): boxes, anchors, cubic-bézier traces routed
  through the gate for NIC endpoints, and greedy `attributeCores`. Every stage component imports
  it. `ServerBoard.tsx` composes three layers — `TraceLayer` (SVG, z0) → DOM blocks
  (NIC/gate/chips/plates, z1) → `PacketLayer` (canvas, z2) — inside a `transform: scale()`
  scale-to-fit wrapper. `HardwarePlatform.tsx` reads `ServerMetrics` (scrub-aware via
  `useServerDisplayMetrics`, `scrubBatch ?? latestBatch`). `InspectorRail.tsx` + `inspectorForms.tsx`
  read/edit the selected entity; edits write ONLY through `useWorldStore` actions and recompile via
  `useCompiledWorld`.
- **`src/lib/worldEngine/index.ts`** — the ONLY engine change: `buildServerParticles` fills the
  server branch of `buildPayload` (cap `MAX_SERVER_PARTICLES = 50`, engine-enforced), mirroring
  `buildAzParticles`. Every off-server endpoint collapses to `nic:<serverId>` (contracts
  amendment). No frozen-type change.
- **State seam** — views read `useSimulationStore` (live/scrub batches, events, `running`) and
  `useWorldStore` (doc); only store actions call the facade; renderers attach once per
  `(serverId, running)`, never on hover/selection (T14 lesson).

## Tech stack

Tauri 2 + React 19 + TypeScript, Zustand (one store per domain), `framer-motion` (reduced-motion),
`vitest` + Testing Library. The stage is DOM + SVG + canvas — **no React Flow** at server scope
(D1) and **no new dependencies**.

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
  selection.ts                      # T6 (created T3, type-only): BoardSelection union
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
src/lib/worldEngine/index.ts        # T2: buildServerParticles + buildPayload server branch (+ __test_render)
src/lib/worldEngine/serverParticles.test.ts  # T2
src/lib/worldEngine/types.ts        # T2: comment-only vocabulary sync (no type change)
src/app/world/ServerView.tsx        # T3: REWRITTEN as composition root (header/stage/rail)
src/app/world/panels/PlacementPanel.tsx      # T8: MANAGED_TYPES ↔ CLOUD_REGISTRY
src/lib/costModelV2.ts (+ test)     # T8: alias table kept for legacy; new authoring emits keys
docs/module-boundaries.md           # T9: §L
```

Dependency order: T1 → T3 → {T4, T5, T6} → T7 → T9. T2 independent (needed by T5's live
verification). T8 independent. Nothing runs in parallel (SDD is serial). Task execution order:
T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9.

---

## Task 1: Pure board layout + core attribution `[sonnet]`

**Files:** create `src/app/world/server/boardLayout.ts`, `src/app/world/server/boardLayout.test.ts`.

**Grounding (verified against real source, do not re-derive):**
- `Server`, `ComposeStack { name, networks[{name,cidr}], volumes[{name,sizeGb}] }`,
  `ServiceInstance { id, blueprintId, placementId, serverId, ... }`,
  `CompiledPath { id, dependencyId, fromInstanceId, to: {kind:'instance',instanceId}|{kind:'managed',managedServiceId}, verdict, blockReason:{detail} }`,
  `ServiceBlueprint { ports:[{visibility:'public'|'internal'}], dependencies:[{id,protocol}] }`,
  `Placement.runtime = {type:'process'} | {type:'container', stackName, ...}` — all in
  `src/lib/world/types.ts`.
- Resident instances of a server = `Object.values(compiled.instances).filter(i => i.serverId === server.id)`
  (compiled-instance iteration order is the deterministic order used for overflow).
- attributeCores greedy example is arithmetic-verified: `attributeCores(4, [a(1.2,bpX), b(0.8,bpY)])`
  → core0 dom bpX shares `[{a,1.0}]`; core1 dom bpY shares `[{a,~0.2}, {b,0.8}]`; core2/3 dom
  null, shares `[]`. The `0.2` share is float `0.19999999999999996` — tests MUST use
  `toBeCloseTo`, never exact equality, on fractions.

**Produces (exact — later tasks import these verbatim):** the interfaces `Box`, `Anchor`,
`ChipLayout`, `VolumeLayout`, `StackLayout`, `BoardLayout`, `StaticTrace`, `CoreAttribution`,
the const `MAX_BOARD_CHIPS = 12`, and the functions `layoutServerBoard`, `serverTraces`,
`attributeCores` exactly as written in Step 3 below.

- [ ] **Step 1: Write the failing test `boardLayout.test.ts`**

```ts
// src/app/world/server/boardLayout.test.ts
import { describe, it, expect } from 'vitest'
import {
  layoutServerBoard, serverTraces, attributeCores, MAX_BOARD_CHIPS,
} from './boardLayout'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
} from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'
import { compileWorld, instanceId } from '../../../lib/world/compileWorld'
import type { WorldDoc, ServiceBlueprint, Placement, ComposeStack } from '../../../lib/world/types'

// ── Fixtures: real factories through a real compile ──
function base() {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const az = createAz(region.id, 'us-east-1a')
  const server = createServer(az.id, getPreset('vps-medium')!)
  doc.regions[region.id] = region
  doc.azs[az.id] = az
  doc.servers[server.id] = server
  return { doc, server }
}
function addProcess(doc: WorldDoc, name: string, serverId: string, i: number) {
  const bp = createBlueprint(name, i)
  doc.blueprints[bp.id] = bp
  const pl = createPlacement(bp.id, serverId)
  doc.placements[pl.id] = pl
  return { bp, pl, iid: instanceId(pl.id, 0) }
}
function addContainer(doc: WorldDoc, name: string, serverId: string, stackName: string, i: number) {
  const { bp, pl, iid } = addProcess(doc, name, serverId, i)
  pl.runtime = { type: 'container', stackName, networkNames: [], portMappings: [], cpuLimit: null, memLimitMb: null }
  return { bp, pl, iid }
}
const stack = (name: string, volumes: ComposeStack['volumes'] = []): ComposeStack =>
  ({ name, networks: [{ name: 'net', cidr: '172.18.0.0/16' }], volumes })

describe('layoutServerBoard — zones', () => {
  it('lays out nic, gate, and hardware rail at fixed zones', () => {
    const { doc, server } = base()
    const l = layoutServerBoard(server, doc, compileWorld(doc))
    expect(l.stageW).toBe(1000)
    expect(l.stageH).toBe(560)
    expect(l.nic.box.x).toBe(0)                                  // flush left
    expect(l.gate.box.x).toBeGreaterThanOrEqual(l.nic.box.x + l.nic.box.w)   // gate right of nic
    expect(l.hardware.box.x).toBe(840)                           // fixed right rail
    // cpu/ram/disk nested inside the hardware box
    for (const part of [l.hardware.cpu, l.hardware.ram, l.hardware.disk]) {
      expect(part.x).toBeGreaterThanOrEqual(l.hardware.box.x)
      expect(part.x + part.w).toBeLessThanOrEqual(l.hardware.box.x + l.hardware.box.w)
      expect(part.y).toBeGreaterThanOrEqual(l.hardware.box.y)
      expect(part.y + part.h).toBeLessThanOrEqual(l.hardware.box.y + l.hardware.box.h)
    }
  })

  it('process chips column excludes container chips', () => {
    const { doc, server } = base()
    server.stacks = [stack('app')]
    addProcess(doc, 'nginx', server.id, 0)
    addContainer(doc, 'api', server.id, 'app', 1)
    const l = layoutServerBoard(server, doc, compileWorld(doc))
    const proc = l.chips.filter(c => c.stackName === null)
    const cont = l.chips.filter(c => c.stackName !== null)
    expect(proc).toHaveLength(1)
    expect(cont).toHaveLength(1)
    // process chip sits in the middle column (x within 250..340)
    expect(proc[0].box.x).toBeGreaterThanOrEqual(250)
    expect(proc[0].box.x + proc[0].box.w).toBeLessThanOrEqual(340)
  })

  it('container chips sit inside their stack plate box', () => {
    const { doc, server } = base()
    server.stacks = [stack('app')]
    addContainer(doc, 'api', server.id, 'app', 0)
    addContainer(doc, 'pg', server.id, 'app', 1)
    const l = layoutServerBoard(server, doc, compileWorld(doc))
    const plate = l.stacks.find(s => s.stackName === 'app')!
    expect(plate).toBeDefined()
    const cont = l.chips.filter(c => c.stackName === 'app')
    expect(cont).toHaveLength(2)
    for (const c of cont) {
      expect(c.box.x).toBeGreaterThanOrEqual(plate.box.x)
      expect(c.box.x + c.box.w).toBeLessThanOrEqual(plate.box.x + plate.box.w)
      expect(c.box.y).toBeGreaterThanOrEqual(plate.box.y)
      expect(c.box.y + c.box.h).toBeLessThanOrEqual(plate.box.y + plate.box.h)
    }
    expect(plate.chipIds).toEqual(cont.map(c => c.instanceId))
  })

  it('volume cylinders attach to their plate', () => {
    const { doc, server } = base()
    server.stacks = [stack('app', [{ name: 'pgdata', sizeGb: 12 }])]
    addContainer(doc, 'pg', server.id, 'app', 0)
    const l = layoutServerBoard(server, doc, compileWorld(doc))
    const plate = l.stacks.find(s => s.stackName === 'app')!
    expect(plate.volumes).toHaveLength(1)
    const v = plate.volumes[0]
    expect(v.volumeName).toBe('pgdata')
    expect(v.sizeGb).toBe(12)
    expect(v.box.x).toBeGreaterThanOrEqual(plate.box.x)
    expect(v.box.x + v.box.w).toBeLessThanOrEqual(plate.box.x + plate.box.w)
    expect(v.box.y + v.box.h).toBeLessThanOrEqual(plate.box.y + plate.box.h)
  })

  it('chips overflow beyond MAX_BOARD_CHIPS into overflowCount', () => {
    const { doc, server } = base()
    for (let i = 0; i < MAX_BOARD_CHIPS + 3; i++) addProcess(doc, `svc${i}`, server.id, i)
    const l = layoutServerBoard(server, doc, compileWorld(doc))
    expect(l.chips).toHaveLength(MAX_BOARD_CHIPS)
    expect(l.overflowCount).toBe(3)
  })

  it('anchorFor resolves instance and nic ids and rejects unknown ids', () => {
    const { doc, server } = base()
    const { iid } = addProcess(doc, 'nginx', server.id, 0)
    const l = layoutServerBoard(server, doc, compileWorld(doc))
    expect(l.anchorFor(iid)).not.toBeNull()
    expect(l.anchorFor(`nic:${server.id}`)).toEqual(l.nic.anchor)
    expect(l.anchorFor('does-not-exist')).toBeNull()
  })

  it('tracePath routes through the gate for nic endpoints', () => {
    const { doc, server } = base()
    const { iid } = addProcess(doc, 'nginx', server.id, 0)
    const l = layoutServerBoard(server, doc, compileWorld(doc))
    const viaGate = l.tracePath(`nic:${server.id}`, iid)
    // contains both gate anchors' coordinates → the packet threads the gate
    expect(viaGate).toContain(`${l.gate.inAnchor.x} ${l.gate.inAnchor.y}`)
    expect(viaGate).toContain(`${l.gate.outAnchor.x} ${l.gate.outAnchor.y}`)
    // a non-nic path is a single cubic (no gate anchors)
    const direct = l.tracePath(iid, iid)
    expect(direct).not.toContain(`${l.gate.outAnchor.x} ${l.gate.outAnchor.y}`)
  })

  it('is deterministic — same inputs produce deep-equal output twice', () => {
    const { doc, server } = base()
    server.stacks = [stack('app', [{ name: 'pgdata', sizeGb: 12 }])]
    addProcess(doc, 'nginx', server.id, 0)
    addContainer(doc, 'api', server.id, 'app', 1)
    const compiled = compileWorld(doc)
    const a = layoutServerBoard(server, doc, compiled)
    const b = layoutServerBoard(server, doc, compiled)
    // compare the serialisable core (functions excluded)
    const strip = (l: ReturnType<typeof layoutServerBoard>) =>
      ({ ...l, anchorFor: undefined, tracePath: undefined })
    expect(strip(a)).toEqual(strip(b))
  })
})

describe('serverTraces', () => {
  // web(public) -> api(intra, same server) ; api -> db(cross-server) ; api -> managed(off) ;
  // a firewall-blocked dep produces a blocked trace.
  function tracedWorld() {
    const { doc, server } = base()
    const az = doc.azs[Object.keys(doc.azs)[0]]
    const server2 = createServer(az.id, getPreset('vps-medium')!)
    doc.servers[server2.id] = server2

    const web = createBlueprint('web', 0)
    web.ports = [{ port: 8080, protocol: 'tcp', visibility: 'public' }]
    const api = createBlueprint('api', 1)
    const db = createBlueprint('db', 2)
    web.dependencies = [{ id: 'd-api', target: { kind: 'blueprint', blueprintId: api.id }, port: 8080, protocol: 'http', packetTemplateId: null }]
    api.dependencies = [{ id: 'd-db', target: { kind: 'blueprint', blueprintId: db.id }, port: 5432, protocol: 'db', packetTemplateId: null }]
    Object.assign(doc.blueprints, { [web.id]: web, [api.id]: api, [db.id]: db })

    createPlacementInto(doc, web.id, server.id)
    createPlacementInto(doc, api.id, server.id)
    createPlacementInto(doc, db.id, server2.id)   // db off-server → collapses to nic
    return { doc, server, web, api, db }
  }
  function createPlacementInto(doc: WorldDoc, bpId: string, serverId: string) {
    const pl = createPlacement(bpId, serverId); doc.placements[pl.id] = pl; return pl
  }

  it('collapses off-server targets to nic and carries blocked labels', () => {
    const { doc, server } = tracedWorld()
    // block the api->db path with a firewall deny on 5432
    server.firewall = [
      { id: 'fw-deny', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' },
      { id: 'fw-allow', action: 'allow', port: 'any', protocol: 'any', source: 'internal' },
    ]
    const traces = serverTraces(server.id, doc, compileWorld(doc))
    const off = traces.find(t => t.toId === `nic:${server.id}` && t.protocol === 'db')
    expect(off).toBeDefined()                          // api -> db collapsed to nic
    if (off?.verdict === 'blocked') expect(off.label).not.toBeNull()
  })

  it('adds an inbound trace for public-port blueprints', () => {
    const { doc, server } = tracedWorld()
    const traces = serverTraces(server.id, doc, compileWorld(doc))
    const inbound = traces.filter(t => t.fromId === `nic:${server.id}`)
    expect(inbound.length).toBeGreaterThanOrEqual(1)
    expect(inbound.every(t => t.verdict === 'permitted')).toBe(true)
  })
})

describe('attributeCores', () => {
  it('greedy assignment and dominant owner', () => {
    const r = attributeCores(4, [
      { instanceId: 'a', blueprintId: 'bpX', cpuCoresUsed: 1.2 },
      { instanceId: 'b', blueprintId: 'bpY', cpuCoresUsed: 0.8 },
    ])
    expect(r).toHaveLength(4)
    expect(r[0].dominantBlueprintId).toBe('bpX')
    expect(r[0].shares).toHaveLength(1)
    expect(r[0].shares[0].fraction).toBeCloseTo(1.0)
    expect(r[1].dominantBlueprintId).toBe('bpY')          // b's 0.8 beats a's 0.2 on core1
    const aShare = r[1].shares.find(s => s.instanceId === 'a')!
    const bShare = r[1].shares.find(s => s.instanceId === 'b')!
    expect(aShare.fraction).toBeCloseTo(0.2)
    expect(bShare.fraction).toBeCloseTo(0.8)
    expect(r[2].dominantBlueprintId).toBeNull()
    expect(r[3].shares).toEqual([])
  })

  it('returns null dominants for zero demand', () => {
    const r = attributeCores(2, [
      { instanceId: 'a', blueprintId: 'bpX', cpuCoresUsed: 0 },
      { instanceId: 'b', blueprintId: 'bpY', cpuCoresUsed: 0 },
    ])
    expect(r.map(c => c.dominantBlueprintId)).toEqual([null, null])
    expect(r.every(c => c.shares.length === 0)).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/world/server/boardLayout.test.ts`
Expected: FAIL — `Cannot find module './boardLayout'`.

- [ ] **Step 3: Write `boardLayout.ts`**

```ts
// src/app/world/server/boardLayout.ts
// Pure, deterministic layout of the Level-4 server board in a fixed 1000x560 logical space
// (D1/D2). No React, no DOM, no store reads — every box/anchor/trace is a function of
// (server, doc, compiled). Unit-tested; consumed by ServerBoard/TraceLayer/PacketLayer/
// HardwarePlatform/InspectorRail.
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
  overflowCount: number         // instances beyond MAX_BOARD_CHIPS
  stacks: StackLayout[]
  hardware: { box: Box; cpu: Box; ram: Box; disk: Box }
  anchorFor(id: string): Anchor | null   // instanceId | `nic:${serverId}`
  tracePath(fromId: string, toId: string): string  // SVG `d`; NIC-end paths route through gate
}

export const MAX_BOARD_CHIPS = 12

// ── Fixed logical zones (D2) ──
const STAGE_W = 1000
const STAGE_H = 560
const CY = STAGE_H / 2
const CHIP_W = 90, CHIP_H = 52, CHIP_GAP = 16, PROC_X = 250
const PLATE_X = 376, PLATE_W = 154, PLATE_PAD = 8, PLATE_HEADER = 22, PLATE_TOP = 40, PLATE_GAP = 16
const CC_W = 130, CC_H = 44, CC_GAP = 8, CC_INSET = 4
const VOL_W = 26, VOL_H = 30, VOL_GAP = 8

const mid = (box: Box): number => box.y + box.h / 2

export function layoutServerBoard(server: Server, doc: WorldDoc, compiled: CompiledWorld): BoardLayout {
  const nic = { box: { x: 0, y: CY - 32, w: 74, h: 64 }, anchor: { x: 74, y: CY } }
  const gate = { box: { x: 128, y: CY - 40, w: 48, h: 80 }, inAnchor: { x: 128, y: CY }, outAnchor: { x: 176, y: CY } }
  const hardware = {
    box: { x: 840, y: 30, w: 150, h: STAGE_H - 60 },
    cpu: { x: 850, y: 60, w: 130, h: 130 },
    ram: { x: 850, y: 210, w: 130, h: 130 },
    disk: { x: 850, y: 360, w: 130, h: 120 },
  }

  // Resident instances in deterministic compiled iteration order; overflow past MAX_BOARD_CHIPS.
  const residents = Object.values(compiled.instances).filter(i => i.serverId === server.id)
  const kept = residents.slice(0, MAX_BOARD_CHIPS)
  const overflowCount = residents.length - kept.length

  const stackNameOf = (placementId: string): string | null => {
    const rt = doc.placements[placementId]?.runtime
    return rt && rt.type === 'container' ? rt.stackName : null
  }

  // Split kept chips into process vs container(stackName).
  const procInsts = kept.filter(i => stackNameOf(i.placementId) === null)
  const contInsts = kept.filter(i => stackNameOf(i.placementId) !== null)
  const containersByStack = new Map<string, typeof contInsts>()
  for (const i of contInsts) {
    const name = stackNameOf(i.placementId)!
    const arr = containersByStack.get(name)
    if (arr) arr.push(i); else containersByStack.set(name, [i])
  }

  const chips: ChipLayout[] = []
  const chipFor = (i: (typeof residents)[number], box: Box, stackName: string | null): ChipLayout => ({
    instanceId: i.id, blueprintId: i.blueprintId, placementId: i.placementId, box, stackName,
    inAnchor: { x: box.x, y: mid(box) }, outAnchor: { x: box.x + box.w, y: mid(box) },
  })

  // Process chips: centered column.
  const procTotalH = procInsts.length ? procInsts.length * CHIP_H + (procInsts.length - 1) * CHIP_GAP : 0
  const procStartY = (STAGE_H - procTotalH) / 2
  procInsts.forEach((i, k) => {
    const box = { x: PROC_X, y: procStartY + k * (CHIP_H + CHIP_GAP), w: CHIP_W, h: CHIP_H }
    chips.push(chipFor(i, box, null))
  })

  // Stack plates: every server.stacks entry renders (author feedback); container chips seat inside.
  const stacks: StackLayout[] = []
  let plateY = PLATE_TOP
  for (const st of server.stacks) {
    const mine = containersByStack.get(st.name) ?? []
    const chipsH = mine.length ? mine.length * CC_H + (mine.length - 1) * CC_GAP : 0
    const plateH = PLATE_HEADER + PLATE_PAD + chipsH + (mine.length ? CC_GAP : 0) + VOL_H + PLATE_PAD
    const box = { x: PLATE_X, y: plateY, w: PLATE_W, h: plateH }
    mine.forEach((i, k) => {
      const cbox = { x: box.x + PLATE_PAD + CC_INSET, y: box.y + PLATE_HEADER + PLATE_PAD + k * (CC_H + CC_GAP), w: CC_W, h: CC_H }
      chips.push(chipFor(i, cbox, st.name))
    })
    const volumes: VolumeLayout[] = st.volumes.map((v, k) => ({
      stackName: st.name, volumeName: v.name, sizeGb: v.sizeGb,
      box: { x: box.x + PLATE_PAD + k * (VOL_W + VOL_GAP), y: box.y + box.h - PLATE_PAD - VOL_H, w: VOL_W, h: VOL_H },
    }))
    stacks.push({
      stackName: st.name, box,
      networkLabel: st.networks.map(n => `net ${n.cidr}`).join(' · ') || 'net —',
      chipIds: mine.map(i => i.id), volumes,
    })
    plateY += plateH + PLATE_GAP
  }

  const nicId = `nic:${server.id}`
  const chipById = new Map(chips.map(c => [c.instanceId, c]))

  const anchorFor = (id: string): Anchor | null => {
    if (id === nicId) return nic.anchor
    const c = chipById.get(id)
    return c ? c.inAnchor : null
  }

  // Directional endpoints: source uses right edge, target uses left edge; nic uses its anchor.
  const fromAnchor = (id: string): Anchor | null =>
    id === nicId ? nic.anchor : (chipById.get(id)?.outAnchor ?? null)
  const toAnchor = (id: string): Anchor | null =>
    id === nicId ? nic.anchor : (chipById.get(id)?.inAnchor ?? null)

  const cubic = (a: Anchor, b: Anchor): string =>
    `M ${a.x} ${a.y} C ${a.x + 40} ${a.y}, ${b.x - 40} ${b.y}, ${b.x} ${b.y}`

  const tracePath = (fromId: string, toId: string): string => {
    const a = fromAnchor(fromId)
    const b = toAnchor(toId)
    if (!a || !b) return ''
    if (fromId === nicId) {
      // nic -> gate.in -> gate.out -> target: two chained béziers threaded through the gate.
      return `${cubic(a, gate.inAnchor)} L ${gate.outAnchor.x} ${gate.outAnchor.y} ` +
        `C ${gate.outAnchor.x + 40} ${gate.outAnchor.y}, ${b.x - 40} ${b.y}, ${b.x} ${b.y}`
    }
    if (toId === nicId) {
      // source -> gate.out -> gate.in -> nic (mirror).
      return `${cubic(a, gate.outAnchor)} L ${gate.inAnchor.x} ${gate.inAnchor.y} ` +
        `C ${gate.inAnchor.x - 40} ${gate.inAnchor.y}, ${b.x + 40} ${b.y}, ${b.x} ${b.y}`
    }
    return cubic(a, b)
  }

  return { stageW: STAGE_W, stageH: STAGE_H, nic, gate, chips, overflowCount, stacks, hardware, anchorFor, tracePath }
}

export interface StaticTrace {
  fromId: string; toId: string
  protocol: 'http' | 'db' | 'event' | 'stream'
  verdict: 'permitted' | 'blocked'
  label: string | null          // blockReason.detail when blocked, else null
  pathIds: string[]             // compiled path ids collapsed into this trace
}

// One trace per unique (fromId, toId, protocol) among the server's resident source endpoints,
// plus one nic->chip inbound trace per resident instance whose blueprint has a 'public' port.
// Off-server / managed targets collapse to `nic:<sid>` (D3/D6).
export function serverTraces(serverId: ServerId, doc: WorldDoc, compiled: CompiledWorld): StaticTrace[] {
  const nicId = `nic:${serverId}`
  const byKey = new Map<string, StaticTrace>()

  for (const path of compiled.paths) {
    const from = compiled.instances[path.fromInstanceId]
    if (!from || from.serverId !== serverId) continue
    let toId: string
    if (path.to.kind === 'instance') {
      const t = compiled.instances[path.to.instanceId]
      toId = t && t.serverId === serverId ? t.id : nicId   // off-server → nic
    } else {
      toId = nicId                                          // managed → nic
    }
    const dep = doc.blueprints[from.blueprintId]?.dependencies.find(d => d.id === path.dependencyId)
    const protocol = dep?.protocol ?? 'http'
    const key = `${path.fromInstanceId}→${toId}→${protocol}`
    const existing = byKey.get(key)
    if (existing) {
      existing.pathIds.push(path.id)
      if (path.verdict === 'blocked' && existing.verdict !== 'blocked') {
        existing.verdict = 'blocked'
        existing.label = path.blockReason?.detail ?? null
      }
    } else {
      byKey.set(key, {
        fromId: path.fromInstanceId, toId, protocol, verdict: path.verdict,
        label: path.verdict === 'blocked' ? (path.blockReason?.detail ?? null) : null,
        pathIds: [path.id],
      })
    }
  }

  // Inbound public-port traces.
  for (const inst of Object.values(compiled.instances)) {
    if (inst.serverId !== serverId) continue
    const bp = doc.blueprints[inst.blueprintId]
    if (!bp?.ports.some(p => p.visibility === 'public')) continue
    const key = `${nicId}→${inst.id}→http`
    if (!byKey.has(key)) {
      byKey.set(key, { fromId: nicId, toId: inst.id, protocol: 'http', verdict: 'permitted', label: null, pathIds: [] })
    }
  }

  return [...byKey.values()]
}

export interface CoreAttribution {
  dominantBlueprintId: BlueprintId | null
  shares: { instanceId: InstanceId; blueprintId: BlueprintId; fraction: number }[]
}

// Greedy attribution (D8): sort instances by cpuCoresUsed desc; each claims whole cores then a
// fraction of the next. dominant = holder of the core's largest share; null when the core is idle.
export function attributeCores(
  coreCount: number,
  instances: { instanceId: InstanceId; blueprintId: BlueprintId; cpuCoresUsed: number }[],
): CoreAttribution[] {
  const sorted = [...instances].sort((a, b) => b.cpuCoresUsed - a.cpuCoresUsed)
  const out: CoreAttribution[] = []
  let idx = 0
  let remaining = sorted.length ? sorted[0].cpuCoresUsed : 0
  for (let c = 0; c < coreCount; c++) {
    let filled = 0
    const shares: CoreAttribution['shares'] = []
    while (idx < sorted.length && filled < 1 - 1e-9) {
      if (remaining <= 1e-9) { idx++; remaining = idx < sorted.length ? sorted[idx].cpuCoresUsed : 0; continue }
      const take = Math.min(remaining, 1 - filled)
      shares.push({ instanceId: sorted[idx].instanceId, blueprintId: sorted[idx].blueprintId, fraction: take })
      filled += take
      remaining -= take
    }
    let dominant: BlueprintId | null = null
    let best = 0
    for (const s of shares) if (s.fraction > best) { best = s.fraction; dominant = s.blueprintId }
    out.push({ dominantBlueprintId: dominant, shares })
  }
  return out
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/app/world/server/boardLayout.test.ts`
Expected: PASS (all `layoutServerBoard`, `serverTraces`, `attributeCores` cases).

- [ ] **Step 5: Type-check + full suite**

Run: `npm run build` → succeeds (strict tsc).
Run: `npx vitest run` → all suites green.

- [ ] **Step 6: Commit**

```bash
git add src/app/world/server/boardLayout.ts src/app/world/server/boardLayout.test.ts
git commit -m "feat(server-view): add pure board layout, traces, and core attribution"
```

---

## Task 2: Engine server-scope particles `[sonnet]`

**Files:** modify `src/lib/worldEngine/index.ts` (add `MAX_SERVER_PARTICLES = 50` beside the
other caps at ~line 42, add `buildServerParticles`, fill the server branch of `buildPayload`,
and add a test-only `__test_render` hook); comment-only vocabulary sync in
`src/lib/worldEngine/types.ts` (copy the amended `VisualParticle` id-vocabulary comment from
the contracts doc — NO type change); create `src/lib/worldEngine/serverParticles.test.ts`.

**Grounding (verified):** `buildAzParticles` lives at `index.ts:477`; `buildPayload` at
`index.ts:451` (`if (scope.level === 'server') return { simMs, particles: [], arcs: [] }` today).
`InstanceFlow { instanceId, offeredRps, downstream: DownstreamFlow[] }`,
`DownstreamFlow { dependencyId, toInstanceId?, toManagedServiceId?, rps, blocked }` (flows.ts:47).
Module-level helpers already in scope: `frac` (index.ts:576), `PARTICLE_RATIO = 10`,
`RENDER_PROGRESS_PER_MS` (index.ts:41,48), `s.entryBlueprintIds`, `s.prevFlows`,
`s.compiled.instances`, `s.doc.blueprints`. `__test_step` (index.ts:569) calls `runFrame` but
NOT `renderAll` — so renderers do not fire during stepping; the additive `__test_render` hook
below drives `renderAll(wallMs)` deterministically for tests (test-only surface on the same
intersection type `__test_step` already extends — not part of the frozen `WorldEngineApi`, so
no contract drift; note in ledger).

- [ ] **Step 1: Write the failing test `serverParticles.test.ts`**

```ts
// src/lib/worldEngine/serverParticles.test.ts
import { describe, it, expect } from 'vitest'
import { createWorldEngine } from './index'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement, createPopulation,
} from '../world/factories'
import { getPreset } from '../world/instanceCatalog'
import { compileWorld, instanceId } from '../world/compileWorld'
import type { WorldDoc } from '../world/types'
import type { FramePayload, RenderScope } from './types'

// web(public) on s1 -> api on s1 (intra) ; api -> db on s2 (cross-server) ;
// api -> managed queue (off-server) ; web -> blockedDep on s1 firewall-denied.
function fixture(peakRps = 200) {
  const doc = createWorld()
  doc.traffic.autoBaseline = false
  const region = createRegion('us-east-1')
  const az = createAz(region.id, 'us-east-1a')
  const s1 = createServer(az.id, getPreset('dedicated-8')!)
  const s2 = createServer(az.id, getPreset('dedicated-8')!)
  // block one downstream port on s1 so at least one path compiles 'blocked'
  s1.firewall = [
    { id: 'deny-9999', action: 'deny', port: 9999, protocol: 'tcp', source: 'any' },
    { id: 'allow-int', action: 'allow', port: 'any', protocol: 'any', source: 'internal' },
  ]
  Object.assign(doc.regions, { [region.id]: region })
  Object.assign(doc.azs, { [az.id]: az })
  Object.assign(doc.servers, { [s1.id]: s1, [s2.id]: s2 })

  const web = createBlueprint('web', 0); web.ports = [{ port: 8080, protocol: 'tcp', visibility: 'public' }]
  const api = createBlueprint('api', 1)
  const db = createBlueprint('db', 2)
  const blocked = createBlueprint('audit', 3)
  const ms = { id: 'ms-q', label: 'Q', nodeType: 'queue', scope: { kind: 'az' as const, azId: az.id }, provider: 'aws' as const, port: 5672 }
  doc.managedServices[ms.id] = ms
  web.dependencies = [
    { id: 'd-api', target: { kind: 'blueprint', blueprintId: api.id }, port: 8080, protocol: 'http', packetTemplateId: null },
    { id: 'd-blk', target: { kind: 'blueprint', blueprintId: blocked.id }, port: 9999, protocol: 'http', packetTemplateId: null },
  ]
  api.dependencies = [
    { id: 'd-db', target: { kind: 'blueprint', blueprintId: db.id }, port: 5432, protocol: 'db', packetTemplateId: null },
    { id: 'd-q', target: { kind: 'managed', managedServiceId: ms.id }, port: 5672, protocol: 'event', packetTemplateId: null },
  ]
  Object.assign(doc.blueprints, { [web.id]: web, [api.id]: api, [db.id]: db, [blocked.id]: blocked })

  const place = (bpId: string, serverId: string) => { const pl = createPlacement(bpId, serverId); doc.placements[pl.id] = pl; return pl }
  const webPl = place(web.id, s1.id)
  const apiPl = place(api.id, s1.id)
  place(db.id, s2.id)
  place(blocked.id, s1.id)

  const pop = createPopulation('nyc', 40.7, -74.0); pop.peakRps = peakRps
  doc.populations[pop.id] = pop
  return { doc, s1, s2, api, apiInst: instanceId(apiPl.id, 0), webInst: instanceId(webPl.id, 0) }
}

// Drive the engine to steady flows, then render one server-scope frame deterministically.
function serverFrame(doc: WorldDoc, serverId: string, seconds = 3): FramePayload {
  const engine = createWorldEngine(1)
  const compiled = compileWorld(doc)
  const frames: FramePayload[] = []
  const scope: RenderScope = { level: 'server', serverId }
  // attachRenderer returns a no-op before start() (state is null) and start() resets the renderer
  // map — so attach AFTER start(), then step to build flows, then render one deterministic frame.
  engine.start(doc, compiled, { onMetrics: () => {}, onEvent: () => {}, onHealthChange: () => {} })
  const detach = engine.attachRenderer(scope, p => frames.push(p))
  engine.__test_step(seconds * 10)
  engine.__test_render(1000)               // deterministic wallMs → deterministic progress
  detach(); engine.stop()
  return frames[frames.length - 1]
}

describe('buildServerParticles', () => {
  it('server scope emits nic->instance entry particles', () => {
    const f = fixture()
    const frame = serverFrame(f.doc, f.s1.id)
    expect(frame.particles.some(p => p.fromId === `nic:${f.s1.id}` && p.toId === f.webInst)).toBe(true)
  })

  it('intra-server dependency emits instance->instance particles', () => {
    const f = fixture()
    const frame = serverFrame(f.doc, f.s1.id)
    expect(frame.particles.some(p => p.fromId === f.webInst && p.toId === f.apiInst)).toBe(true)
  })

  it('cross-server and managed targets collapse to the nic endpoint', () => {
    const f = fixture()
    const frame = serverFrame(f.doc, f.s1.id)
    // api -> db (cross-server) and api -> queue (managed) both leave via nic
    expect(frame.particles.some(p => p.fromId === f.apiInst && p.toId === `nic:${f.s1.id}`)).toBe(true)
  })

  it('blocked path emits blocked particles', () => {
    const f = fixture()
    const frame = serverFrame(f.doc, f.s1.id)
    expect(frame.particles.some(p => p.blocked)).toBe(true)
  })

  it('respects MAX_SERVER_PARTICLES cap', () => {
    const f = fixture(50_000)                // crank demand
    const frame = serverFrame(f.doc, f.s1.id)
    expect(frame.particles.length).toBeLessThanOrEqual(50)
  })

  it('colorHint carries the target blueprint color for intra traces', () => {
    const f = fixture()
    const frame = serverFrame(f.doc, f.s1.id)
    const intra = frame.particles.find(p => p.fromId === f.webInst && p.toId === f.apiInst)
    expect(intra?.colorHint).toBe(f.api.color)
  })

  it("other servers' flows never leak into this scope", () => {
    const f = fixture()
    const frame = serverFrame(f.doc, f.s1.id)
    // s2 hosts db only; no particle should originate from an s2-resident instance
    expect(frame.particles.every(p => !p.fromId.includes(f.s2.id) || p.fromId === `nic:${f.s1.id}`)).toBe(true)
    // db instance id (s2 resident) must not be a from-endpoint
    expect(frame.particles.some(p => p.fromId === f.apiInst || p.fromId === f.webInst || p.fromId === `nic:${f.s1.id}`)).toBe(true)
  })

  it('is deterministic for a fixed seed', () => {
    const f = fixture()
    const a = serverFrame(f.doc, f.s1.id)
    const b = serverFrame(f.doc, f.s1.id)
    expect(a.particles).toEqual(b.particles)
  })

  it('az and globe payloads are unchanged (guard)', () => {
    const f = fixture()
    const engine = createWorldEngine(1)
    const azFrames: FramePayload[] = []
    const az = Object.keys(f.doc.azs)[0]
    engine.start(f.doc, compileWorld(f.doc), { onMetrics: () => {}, onEvent: () => {}, onHealthChange: () => {} })
    engine.attachRenderer({ level: 'az', azId: az }, p => azFrames.push(p))   // attach after start
    engine.__test_step(30)
    engine.__test_render(1000)
    engine.stop()
    // az scope still produces server-keyed endpoints (not instance ids) — vocabulary intact
    const last = azFrames[azFrames.length - 1]
    expect(last.arcs).toEqual([])
    expect(last.particles.every(p => p.toId !== f.apiInst)).toBe(true)  // az uses serverId endpoints
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/worldEngine/serverParticles.test.ts`
Expected: FAIL — `engine.__test_render is not a function` (and empty server particles).

- [ ] **Step 3: Add `MAX_SERVER_PARTICLES`, `buildServerParticles`, the `buildPayload` branch, and `__test_render`**

In `src/lib/worldEngine/index.ts`, beside the other caps (after line 43
`const MAX_GLOBE_ARCS = 200`):

```ts
const MAX_SERVER_PARTICLES = 50              // server render cap (contracts: server ≤ 50 traces)
```

Change the `buildPayload` server/region fallback (currently at index.ts:456-457):

```ts
    if (scope.level === 'az') return { simMs, particles: buildAzParticles(scope.azId, wallMs), arcs: [] }
    if (scope.level === 'server') return { simMs, particles: buildServerParticles(scope.serverId, wallMs), arcs: [] }
    // region rich particle surface arrives in Phase 4; ships empty-but-valid until then.
    return { simMs, particles: [], arcs: [] }
```

Add `buildServerParticles` immediately after `buildAzParticles` (after index.ts:506):

```ts
  // Server-scope particles (D3): every off-server endpoint collapses to the NIC; the view routes
  // nic-originated traffic through the firewall gate. Mirrors buildAzParticles' sampling/phase.
  function buildServerParticles(serverId: ServerId, wallMs: number): VisualParticle[] {
    const s = state!
    const phase = wallMs * RENDER_PROGRESS_PER_MS
    const particles: VisualParticle[] = []
    let pid = 0
    const nicId = `nic:${serverId}`
    for (const f of Object.values(s.prevFlows)) {
      const from = s.compiled.instances[f.instanceId]
      if (!from || from.serverId !== serverId) continue
      const fromBp = s.doc.blueprints[from.blueprintId]
      const isEntry = s.entryBlueprintIds.includes(from.blueprintId)
      // inbound entry: nic -> receiving instance; colorHint = the receiving service's hue
      if (isEntry && f.offeredRps > 0) {
        const n = Math.min(MAX_SERVER_PARTICLES, Math.round(f.offeredRps / PARTICLE_RATIO))
        for (let k = 0; k < n && particles.length < MAX_SERVER_PARTICLES; k++) {
          particles.push({ id: pid++, fromId: nicId, toId: from.id, progress: frac(phase + k * 0.137), protocol: 'http', blocked: false, colorHint: fromBp?.color ?? null })
        }
      }
      for (const row of f.downstream) {
        const target = row.toInstanceId ? s.compiled.instances[row.toInstanceId] : undefined
        const resident = !!target && target.serverId === serverId
        const toId = resident ? target!.id : nicId          // off-server/managed -> nic
        const dep = fromBp?.dependencies.find(d => d.id === row.dependencyId)
        // intra: receiving service's hue; instance->nic outbound: the sending service's hue
        const colorHint = resident ? (s.doc.blueprints[target!.blueprintId]?.color ?? null) : (fromBp?.color ?? null)
        const n = Math.min(MAX_SERVER_PARTICLES, Math.max(row.blocked ? 1 : 0, Math.round(row.rps / PARTICLE_RATIO)))
        for (let k = 0; k < n && particles.length < MAX_SERVER_PARTICLES; k++) {
          particles.push({ id: pid++, fromId: from.id, toId, progress: frac(phase + k * 0.191), protocol: dep?.protocol ?? 'http', blocked: row.blocked, colorHint })
        }
      }
    }
    return particles
  }
```

Add the test-only render hook to the returned api intersection (beside `__test_step` at ~569):

```ts
    __test_render(wallMs = 1) { renderAll(wallMs) },
```

and widen the return type annotation on `createWorldEngine` and the `api` const to
`WorldEngineApi & { __test_step: (steps?: number) => void; __test_render: (wallMs?: number) => void }`.

> Note: `ServerId`/`VisualParticle` are already imported at the top of index.ts (used by the AZ
> path and cap comments); if strict-tsc reports either unused-before, they are now used here.

- [ ] **Step 4: Vocabulary comment sync in `types.ts`**

Confirm the `VisualParticle.fromId/toId` comment block in `src/lib/worldEngine/types.ts`
matches the contracts amendment (server scope: `resident instanceId | 'nic:<serverId>'`, every
off-server endpoint collapses to the NIC). Phase-2 T1 transcribed the contracts verbatim, so this
is expected to already read correctly — if it does, make NO edit (avoid a no-op diff); if it drifts,
correct the comment only. NO type change.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/lib/worldEngine/serverParticles.test.ts` → PASS (9 tests).
Run: `npx vitest run src/lib/worldEngine/index.test.ts` → still PASS (facade integration intact).
Run: `npm run build` → succeeds.
Run: `npx vitest run` → all suites green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/worldEngine/index.ts src/lib/worldEngine/serverParticles.test.ts src/lib/worldEngine/types.ts
git commit -m "feat(engine): emit server-scope render particles (cap 50)"
```

**Shared local scene constants (each component declares only what it uses):**
`PCB_GRID = '#101620'`, `STAGE_BG = 'radial-gradient(ellipse at 40% 35%, #0C1018 0%, #07090D 70%)'`,
`ACCENT_TEAL = '#2DD4BF'`, `TEAL_TEXT = '#7CFFE9'`, `NIC_BG = 'linear-gradient(90deg,#0A2A26,#0E1A18)'`,
`GATE_AMBER = '#F59E0B'`, `PROTOCOL_COLOR = { http:'#4A9EFF', db:'#F5A623', event:'#A78BFA', stream:'#2DD4BF' }`.

---

## Task 3: Static stage — ServerBoard, chips, plates, gate, NIC, traces `[sonnet]`

**Files:** create `ServerBoard.tsx`, `ServiceChip.tsx`, `StackPlate.tsx`, `FirewallGate.tsx`,
`NicBlock.tsx`, `TraceLayer.tsx`, `ServerBoard.test.tsx` under `src/app/world/server/`;
REWRITE `src/app/world/ServerView.tsx`.

**Grounding:** `nav.store` exposes `serverId` (view is only mounted at `level==='server'`);
`useCompiledWorld()` returns `{ instances, paths, findings, ... }`; `doc.azs[server.azId].label`
is the AZ label; `server.rack = { rackId, unit }`; `ServiceBlueprint.ports[].visibility`,
`Placement.runtime` (process|container with `portMappings:[{host,container}]`). Views may read
`useWorldStore`/`useSimulationStore`; world writes go only through store actions (none here).

- [ ] **Step 1: Write the failing jsdom test `ServerBoard.test.tsx`**

```tsx
// src/app/world/server/ServerBoard.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ServerBoard } from './ServerBoard'
import { ServerView } from '../ServerView'
import { layoutServerBoard, serverTraces, MAX_BOARD_CHIPS } from './boardLayout'
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
} from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'
import { compileWorld } from '../../../lib/world/compileWorld'
import type { WorldDoc, ComposeStack } from '../../../lib/world/types'

beforeAll(() => {
  // jsdom lacks ResizeObserver, which ServerBoard uses for scale-to-fit.
  class RO { observe() {} unobserve() {} disconnect() {} }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO
})

const stack = (name: string): ComposeStack => ({ name, networks: [{ name: 'net', cidr: '172.18.0.0/16' }], volumes: [] })

function seed(configure: (doc: WorldDoc, serverId: string) => void) {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const az = createAz(region.id, 'us-east-1a')
  const server = createServer(az.id, getPreset('vps-medium')!)
  server.label = 'web-01'
  doc.regions[region.id] = region; doc.azs[az.id] = az; doc.servers[server.id] = server
  configure(doc, server.id)
  useWorldStore.setState({ doc, history: [], future: [] })
  useNavStore.setState({ level: 'server', regionId: region.id, azId: az.id, serverId: server.id })
  return { doc, server }
}

function renderBoard(doc: WorldDoc, serverId: string) {
  const compiled = compileWorld(doc)
  const server = doc.servers[serverId]
  const layout = layoutServerBoard(server, doc, compiled)
  const traces = serverTraces(serverId, doc, compiled)
  render(
    <ServerBoard
      serverId={serverId} layout={layout} traces={traces}
      selection={null} onSelect={() => {}} hoveredBlueprintId={null} onHoverBlueprint={() => {}}
    />,
  )
  return { layout, traces }
}

describe('ServerBoard (static stage)', () => {
  beforeEach(() => useWorldStore.getState().newWorld())

  it('renders a chip per resident instance with signature color', () => {
    const { doc, server } = seed((d, sid) => {
      const bp = createBlueprint('nginx', 0)
      d.blueprints[bp.id] = bp
      d.placements['p'] = createPlacement(bp.id, sid)
    })
    renderBoard(doc, server.id)
    const chip = screen.getByText('nginx').closest('[data-chip]') as HTMLElement
    expect(chip).toBeInTheDocument()
    // signature-color tab present
    expect(chip.querySelector('[data-chip-tab]')).toBeTruthy()
  })

  it('container chips render inside their stack plate', () => {
    const { doc, server } = seed((d, sid) => {
      d.servers[sid].stacks = [stack('app')]
      const bp = createBlueprint('api', 1)
      d.blueprints[bp.id] = bp
      const pl = createPlacement(bp.id, sid)
      pl.runtime = { type: 'container', stackName: 'app', networkNames: [], portMappings: [{ host: 3000, container: 8080 }], cpuLimit: null, memLimitMb: null }
      d.placements[pl.id] = pl
    })
    renderBoard(doc, server.id)
    expect(screen.getByText(/stack: app/)).toBeInTheDocument()
    expect(screen.getByText('api')).toBeInTheDocument()
    expect(screen.getByText(/3000.*8080/)).toBeInTheDocument()   // :host→container
  })

  it('blocked trace renders dashed with rule label', () => {
    const { doc, server } = seed((d, sid) => {
      const web = createBlueprint('web', 0); web.ports = [{ port: 8080, protocol: 'tcp', visibility: 'public' }]
      const db = createBlueprint('db', 2)
      web.dependencies = [{ id: 'd', target: { kind: 'blueprint', blueprintId: db.id }, port: 5432, protocol: 'db', packetTemplateId: null }]
      d.blueprints[web.id] = web; d.blueprints[db.id] = db
      d.placements['p1'] = createPlacement(web.id, sid)
      d.placements['p2'] = createPlacement(db.id, sid)
      d.servers[sid].firewall = [
        { id: 'deny', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' },
        { id: 'allow', action: 'allow', port: 'any', protocol: 'any', source: 'internal' },
      ]
    })
    const { traces } = renderBoard(doc, server.id)
    expect(traces.some(t => t.verdict === 'blocked')).toBe(true)
    const dashed = document.querySelector('path[stroke-dasharray]')
    expect(dashed).toBeTruthy()
  })

  it('renders overflow chip when instances exceed MAX_BOARD_CHIPS', () => {
    const { doc, server } = seed((d, sid) => {
      for (let i = 0; i < MAX_BOARD_CHIPS + 2; i++) {
        const bp = createBlueprint(`svc${i}`, i); d.blueprints[bp.id] = bp
        d.placements[`p${i}`] = createPlacement(bp.id, sid)
      }
    })
    renderBoard(doc, server.id)
    expect(screen.getByText(/\+2 more/)).toBeInTheDocument()
  })

  it('header shows specs and rack position', () => {
    seed((d, sid) => { d.servers[sid].rack = { rackId: 'A1', unit: 7, heightU: 1 } })
    render(<ServerView />)
    expect(screen.getByText(/web-01/)).toBeInTheDocument()
    expect(screen.getByText(/vCPU/)).toBeInTheDocument()
    expect(screen.getByText(/A1/)).toBeInTheDocument()
    expect(screen.getByText(/U7/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/world/server/ServerBoard.test.tsx`
Expected: FAIL — `Cannot find module './ServerBoard'`.

- [ ] **Step 3: Write `TraceLayer.tsx`**

```tsx
// src/app/world/server/TraceLayer.tsx
// SVG etched traces beneath the DOM blocks (z0). One <path> per StaticTrace via
// layout.tracePath; permitted = protocol-colored with a soft glow, blocked = danger dashed with
// the rule label at the path midpoint. Paths are clickable (T6 refines to trace inspect).
import type { ReactElement } from 'react'
import type { BoardLayout, StaticTrace } from './boardLayout'
import type { BlueprintId } from '../../../lib/world/types'
import type { BoardSelection } from './selection'

const PROTOCOL_COLOR: Record<StaticTrace['protocol'], string> = {
  http: '#4A9EFF', db: '#F5A623', event: '#A78BFA', stream: '#2DD4BF',
}

export interface TraceLayerProps {
  layout: BoardLayout
  traces: StaticTrace[]
  selection: BoardSelection | null
  onSelect: (s: BoardSelection | null) => void
  hoveredBlueprintId: BlueprintId | null
}

export function TraceLayer({ layout, traces, onSelect }: TraceLayerProps): ReactElement {
  return (
    <svg width={layout.stageW} height={layout.stageH}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {traces.map((t, i) => {
        const d = layout.tracePath(t.fromId, t.toId)
        if (!d) return null
        const blocked = t.verdict === 'blocked'
        const color = blocked ? 'var(--color-danger)' : PROTOCOL_COLOR[t.protocol]
        const a = layout.anchorFor(t.fromId)
        const b = layout.anchorFor(t.toId)
        const mx = a && b ? (a.x + b.x) / 2 : 0
        const my = a && b ? (a.y + b.y) / 2 : 0
        return (
          <g key={i}>
            <path
              d={d} fill="none" stroke={color}
              strokeWidth={blocked ? 1.6 : 2.2}
              strokeDasharray={blocked ? '4 4' : undefined}
              opacity={blocked ? 0.85 : 0.85}
              style={{ filter: blocked ? undefined : `drop-shadow(0 0 4px ${color})`, cursor: 'pointer', pointerEvents: 'stroke' }}
              onClick={() => onSelect(null)}
            />
            {blocked && t.label && (
              <text x={mx + 6} y={my - 4} fill="#FF8A8A" fontSize={8} style={{ pointerEvents: 'none' }}>
                refused — {t.label}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}
```

- [ ] **Step 4: Write `NicBlock.tsx`**

```tsx
// src/app/world/server/NicBlock.tsx
// Teal edge connector on the left rail. T4 adds the live in/out bar; T3 shows the link speed.
import type { CSSProperties, ReactElement } from 'react'
import type { Box } from './boardLayout'

const TEAL = '#2DD4BF', TEAL_TEXT = '#7CFFE9'

export interface NicBlockProps {
  box: Box
  nicMbps: number
  inMbps?: number
  outMbps?: number
  utilFraction?: number        // (in+out)/nicMbps, 0..1 — T4
  selected?: boolean
  dimmed?: boolean
  onSelect?: () => void
  onHover?: (v: boolean) => void
}

export function NicBlock({ box, nicMbps, inMbps, outMbps, utilFraction, selected, dimmed, onSelect, onHover }: NicBlockProps): ReactElement {
  const style: CSSProperties = {
    position: 'absolute', left: box.x, top: box.y, width: box.w,
    background: 'linear-gradient(90deg,#0A2A26,#0E1A18)',
    border: `1px solid ${selected ? TEAL : '#2DD4BF66'}`, borderLeft: `3px solid ${TEAL}`,
    borderRadius: '0 6px 6px 0', padding: 6, boxShadow: '0 0 14px #2DD4BF22', cursor: 'pointer',
    opacity: dimmed ? 0.45 : 1, font: '8px var(--font-mono)',
  }
  return (
    <div data-nic style={style} onClick={onSelect}
      onMouseEnter={() => onHover?.(true)} onMouseLeave={() => onHover?.(false)}>
      <div style={{ color: TEAL_TEXT, fontSize: 8.5 }}>eth0</div>
      <div style={{ color: '#5EEAD4', opacity: 0.8 }}>{nicMbps} Mbps</div>
      {inMbps !== undefined && outMbps !== undefined && (
        <div style={{ color: 'var(--color-text-secondary)', marginTop: 3 }}>↓{Math.round(inMbps)} ↑{Math.round(outMbps)} Mb/s</div>
      )}
      <div style={{ height: 3, background: '#0F2B27', borderRadius: 2, marginTop: 3 }}>
        <div style={{ width: `${Math.min(100, (utilFraction ?? 0) * 100)}%`, height: '100%', background: TEAL, borderRadius: 2, boxShadow: `0 0 4px ${TEAL}` }} />
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Write `FirewallGate.tsx`**

```tsx
// src/app/world/server/FirewallGate.tsx
// Amber gate arch the NIC traffic threads through. T5 adds the blocked/s line.
import type { CSSProperties, ReactElement } from 'react'
import type { Box } from './boardLayout'

const AMBER = '#F59E0B'

export interface FirewallGateProps {
  box: Box
  ruleCount: number
  blockedPerSecond?: number       // T5
  selected?: boolean
  dimmed?: boolean
  onSelect?: () => void
}

export function FirewallGate({ box, ruleCount, blockedPerSecond, selected, dimmed, onSelect }: FirewallGateProps): ReactElement {
  const arch: CSSProperties = {
    position: 'absolute', inset: 0, border: `1.5px solid ${selected ? AMBER : '#F59E0BAA'}`,
    borderRadius: 8, background: 'linear-gradient(180deg,#F59E0B11,#F59E0B04)',
    boxShadow: '0 0 16px #F59E0B33, inset 0 0 12px #F59E0B22',
  }
  return (
    <div data-firewall
      style={{ position: 'absolute', left: box.x, top: box.y, width: box.w, height: box.h, cursor: 'pointer', opacity: dimmed ? 0.45 : 1 }}
      onClick={onSelect}>
      <div style={arch} />
      <div style={{ position: 'absolute', top: -14, width: '100%', textAlign: 'center', fontSize: 9, color: '#FBBF24', textShadow: `0 0 6px ${AMBER}` }}>🛡</div>
      <div style={{ position: 'absolute', bottom: -26, width: 130, left: (box.w - 130) / 2, textAlign: 'center', fontSize: 7, color: '#D9A24A', font: '7px var(--font-mono)' }}>
        FIREWALL · {ruleCount} rules
        {blockedPerSecond !== undefined && blockedPerSecond > 0 && (
          <><br /><span style={{ color: 'var(--color-danger)' }}>✕ {blockedPerSecond.toFixed(0)}/s blocked</span></>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 6: Write `ServiceChip.tsx`**

```tsx
// src/app/world/server/ServiceChip.tsx
// Process/container service chip. T4 fills the conn/p50 line + health dot; T6 adds dim/glow.
import type { CSSProperties, ReactElement } from 'react'
import type { ChipLayout } from './boardLayout'
import type { HealthState } from '../../../lib/worldEngine/types'

const HEALTH_COLOR: Record<HealthState, string> = {
  healthy: 'var(--color-success)', degraded: 'var(--color-warning)', down: 'var(--color-danger)',
}

export interface ServiceChipProps {
  chip: ChipLayout
  name: string
  color: string
  portsLabel: string           // ":443 :80" or ":3000→8080"
  health?: HealthState
  connLabel?: string           // "1.1k conn · p50 2.1ms" — T4; T3 passes "—"
  selected?: boolean
  hovered?: boolean
  dimmed?: boolean
  onSelect?: () => void
  onHover?: (v: boolean) => void
}

export function ServiceChip({ chip, name, color, portsLabel, health = 'healthy', connLabel = '—', selected, hovered, dimmed, onSelect, onHover }: ServiceChipProps): ReactElement {
  const style: CSSProperties = {
    position: 'absolute', left: chip.box.x, top: chip.box.y, width: chip.box.w, minHeight: chip.box.h,
    background: 'linear-gradient(160deg,#16202E,#0E141E)',
    border: `1px solid ${selected || hovered ? color : color + '88'}`, borderRadius: 6, padding: 6,
    boxShadow: hovered ? `0 0 16px ${color}` : `0 0 10px ${color}22`,
    opacity: dimmed ? 0.45 : 1, cursor: 'pointer', font: '9px var(--font-mono)',
    transition: 'opacity 0.15s, box-shadow 0.15s',
  }
  return (
    <div data-chip data-instance={chip.instanceId} style={style} onClick={onSelect}
      onMouseEnter={() => onHover?.(true)} onMouseLeave={() => onHover?.(false)}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ color: '#DBEAFE' }}><span data-chip-tab style={{ color }}>▮</span> {name}</span>
        <span style={{ width: 4, height: 4, borderRadius: '50%', background: HEALTH_COLOR[health], boxShadow: `0 0 5px ${HEALTH_COLOR[health]}` }} />
      </div>
      <div style={{ color: '#7CFFE9', marginTop: 2, fontSize: 7 }}>{portsLabel}</div>
      <div style={{ color: 'var(--color-text-secondary)', fontSize: 7 }}>{connLabel}</div>
    </div>
  )
}
```

- [ ] **Step 7: Write `StackPlate.tsx`**

```tsx
// src/app/world/server/StackPlate.tsx
// Raised docker-stack plate (dashed purple). Container chips are rendered by ServerBoard on top;
// the plate owns the header + volume cylinders.
import type { CSSProperties, ReactElement } from 'react'
import type { StackLayout } from './boardLayout'
import type { BoardSelection } from './selection'

const PURPLE = '#A78BFA'

export interface StackPlateProps {
  stack: StackLayout
  selection?: BoardSelection | null
  dimmed?: boolean
  onSelect?: (s: BoardSelection) => void
}

export function StackPlate({ stack, dimmed, onSelect }: StackPlateProps): ReactElement {
  const style: CSSProperties = {
    position: 'absolute', left: stack.box.x, top: stack.box.y, width: stack.box.w, height: stack.box.h,
    background: 'linear-gradient(160deg,#1A1430 0%,#120E22 100%)', border: `1px dashed ${PURPLE}88`,
    borderRadius: 10, boxShadow: '0 8px 24px #00000066, 0 0 18px #A78BFA22', padding: 6,
    opacity: dimmed ? 0.45 : 1, cursor: 'pointer', font: '7px var(--font-mono)',
  }
  return (
    <div data-stack={stack.stackName} style={style} onClick={() => onSelect?.({ kind: 'stack', stackName: stack.stackName })}>
      <div style={{ color: '#C4B5FD', textShadow: `0 0 6px ${PURPLE}` }}>▣ stack: {stack.stackName} · {stack.networkLabel}</div>
      <svg style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} width={stack.box.w} height={stack.box.h}>
        {stack.volumes.map(v => {
          const lx = v.box.x - stack.box.x, ty = v.box.y - stack.box.y
          return (
            <g key={v.volumeName} style={{ pointerEvents: 'auto', cursor: 'pointer' }}
              onClick={e => { e.stopPropagation(); onSelect?.({ kind: 'volume', stackName: stack.stackName, volumeName: v.volumeName }) }}>
              <ellipse cx={lx + v.box.w / 2} cy={ty + 4} rx={v.box.w / 2} ry={4} fill="#F5A62388" stroke="#F5A623" />
              <rect x={lx} y={ty + 4} width={v.box.w} height={v.box.h - 8} fill="#F5A62333" stroke="#F5A623" strokeWidth={0.5} />
              <ellipse cx={lx + v.box.w / 2} cy={ty + v.box.h - 4} rx={v.box.w / 2} ry={4} fill="#F5A623AA" stroke="#F5A623" />
              <text x={lx + v.box.w / 2} y={ty + v.box.h + 6} fill="var(--color-text-muted)" fontSize={5.5} textAnchor="middle">{v.volumeName}</text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
```

- [ ] **Step 8: Write `ServerBoard.tsx`**

```tsx
// src/app/world/server/ServerBoard.tsx
// Fixed-composition stage (D1): scale-to-fit a 1000x560 logical space; PCB grid bg; layer stack
// TraceLayer (SVG z0) → DOM blocks (z1) → PacketLayer slot (z2, added by T5).
import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { BoardLayout, StaticTrace } from './boardLayout'
import type { BlueprintId, ServerId } from '../../../lib/world/types'
import type { BoardSelection } from './selection'
import { useWorldStore } from '../../store/world.store'
import { TraceLayer } from './TraceLayer'
import { NicBlock } from './NicBlock'
import { FirewallGate } from './FirewallGate'
import { ServiceChip } from './ServiceChip'
import { StackPlate } from './StackPlate'

const PCB_GRID = '#101620'

export interface ServerBoardProps {
  serverId: ServerId
  layout: BoardLayout
  traces: StaticTrace[]
  selection: BoardSelection | null
  onSelect: (s: BoardSelection | null) => void
  hoveredBlueprintId: BlueprintId | null
  onHoverBlueprint: (id: BlueprintId | null) => void
}

export function ServerBoard(props: ServerBoardProps): ReactElement {
  const { serverId, layout, traces } = props
  const doc = useWorldStore(s => s.doc)
  const server = doc.servers[serverId]
  const containerRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const fit = () => setScale(Math.min(el.clientWidth / layout.stageW, el.clientHeight / layout.stageH) || 1)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [layout.stageW, layout.stageH])

  const portsLabel = (chip: (typeof layout.chips)[number]): string => {
    const pl = doc.placements[chip.placementId]
    if (pl?.runtime.type === 'container' && pl.runtime.portMappings.length) {
      return pl.runtime.portMappings.map(m => `:${m.host}→${m.container}`).join(' ')
    }
    const bp = doc.blueprints[chip.blueprintId]
    return bp?.ports.map(p => `:${p.port}`).join(' ') || 'internal'
  }

  return (
    <div ref={containerRef} style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden', background: 'radial-gradient(ellipse at 40% 35%, #0C1018 0%, #07090D 70%)' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: layout.stageW, height: layout.stageH, transformOrigin: '0 0', transform: `scale(${scale})` }}>
        {/* PCB grid */}
        <div style={{ position: 'absolute', inset: 0, backgroundImage: `linear-gradient(${PCB_GRID} 1px,transparent 1px),linear-gradient(90deg,${PCB_GRID} 1px,transparent 1px)`, backgroundSize: '26px 26px', opacity: 0.5 }} />
        {/* z0 traces */}
        <TraceLayer layout={layout} traces={traces} selection={props.selection} onSelect={props.onSelect} hoveredBlueprintId={props.hoveredBlueprintId} />
        {/* z1 DOM blocks */}
        {layout.stacks.map(st => <StackPlate key={st.stackName} stack={st} selection={props.selection} onSelect={props.onSelect} />)}
        <NicBlock box={layout.nic.box} nicMbps={server?.specs.nicMbps ?? 0} onSelect={() => props.onSelect({ kind: 'nic' })} onHover={() => {}} />
        <FirewallGate box={layout.gate.box} ruleCount={server?.firewall.length ?? 0} onSelect={() => props.onSelect({ kind: 'firewall' })} />
        {layout.chips.map(chip => {
          const bp = doc.blueprints[chip.blueprintId]
          return (
            <ServiceChip
              key={chip.instanceId} chip={chip} name={bp?.name ?? '?'} color={bp?.color ?? '#888'}
              portsLabel={portsLabel(chip)}
              onSelect={() => props.onSelect({ kind: 'instance', instanceId: chip.instanceId })}
              onHover={v => props.onHoverBlueprint(v ? chip.blueprintId : null)}
            />
          )
        })}
        {layout.overflowCount > 0 && (
          <div style={{ position: 'absolute', left: 250, bottom: 8, color: 'var(--color-text-muted)', font: '9px var(--font-mono)' }}>
            +{layout.overflowCount} more instance{layout.overflowCount > 1 ? 's' : ''}
          </div>
        )}
        {/* z2: PacketLayer mounts here in T5 */}
      </div>
    </div>
  )
}
```

- [ ] **Step 9: Rewrite `ServerView.tsx` as the composition root**

```tsx
// src/app/world/ServerView.tsx
// Level-4 server interior composition root (Phase 3): header strip + circuit-board stage +
// inspector rail placeholder (T6 replaces the <aside>). Selection/hover are held here in T6.
import { useMemo, type ReactElement } from 'react'
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { useCompiledWorld } from './useCompiledWorld'
import { layoutServerBoard, serverTraces } from './server/boardLayout'
import { ServerBoard } from './server/ServerBoard'

export function ServerView(): ReactElement | null {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const serverId = useNavStore(s => s.serverId)
  const server = serverId ? doc.servers[serverId] : null

  const layout = useMemo(() => (server ? layoutServerBoard(server, doc, compiled) : null), [server, doc, compiled])
  const traces = useMemo(() => (server && serverId ? serverTraces(serverId, doc, compiled) : []), [server, serverId, doc, compiled])

  if (!server || !serverId || !layout) return null
  const az = doc.azs[server.azId]
  const gb = Math.round(server.specs.ramMb / 1024)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--color-node-border)', font: '11px var(--font-mono)', color: 'var(--color-text-secondary)' }}>
        <span style={{ color: 'var(--color-text-primary)' }}>{server.label}</span> · {server.kind} · {server.specs.vcpu} vCPU / {gb} GB
        {' — '}{az?.label ?? '?'} › {server.rack.rackId} › U{server.rack.unit}
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ flex: 2.6, display: 'flex', minWidth: 0 }}>
          <ServerBoard
            serverId={serverId} layout={layout} traces={traces}
            selection={null} onSelect={() => {}} hoveredBlueprintId={null} onHoverBlueprint={() => {}}
          />
        </div>
        <aside style={{ width: 240, borderLeft: '1px solid var(--color-node-border)', background: 'var(--color-surface)' }} />
      </div>
    </div>
  )
}
```

> Note: T3 imports `./server/boardLayout`'s `serverTraces`/`layoutServerBoard` and ServerBoard
> imports `./selection` (BoardSelection) which T6 creates. To keep T3's build green BEFORE T6,
> T3 also creates the type-only `src/app/world/server/selection.ts` with the full `BoardSelection`
> union now (it is T6's deliverable but a pure type file; T6 will already find it present and
> only add its consumers). Copy the union verbatim from the T6 section. If the controller
> sequences strictly, create it here — a type-only file breaks nothing downstream.

- [ ] **Step 10: Run tests + build**

Run: `npx vitest run src/app/world/server/ServerBoard.test.tsx` → PASS (5 tests).
Run: `npm run build` → succeeds.
Run: `npx vitest run` → all suites green.

- [ ] **Step 11: Live Playwright smoke (controller-run, port 1420)**

1. `npm run dev` (background); wait for `Local:   http://localhost:1420/`.
2. `browser_navigate` → `http://localhost:1420`; `browser_click` "New World".
3. Topology tab: add region `us-east-1` → "+ AZ" → "+ Server".
4. Blueprints tab: create `web`; expand it, give it a public port (if UI exposes it) — otherwise
   author via the DEV `window.__scalemapDebug` hook to set a `public` port and a stack + a
   container placement + a dependency the firewall blocks (mirror Phase-2 T14/T18 smoke pattern;
   the debug hook exposes `useWorldStore` — use `updateBlueprint`/`updateServer`/`updatePlacement`).
5. Navigate into the server (breadcrumb region → AZ card → server chassis/card).
6. `browser_snapshot` → confirm NIC (`eth0`), firewall gate (`FIREWALL · N rules`), a service
   chip with signature color, the stack plate (`stack: …`), and a red dashed blocked trace with a
   `refused …` label.
7. `browser_console_messages` → assert ZERO error-level entries.
8. `browser_take_screenshot` → scratchpad `task3-static-board.png`.
9. Stop the dev server.

- [ ] **Step 12: Commit**

```bash
git add src/app/world/server/ServerBoard.tsx src/app/world/server/ServiceChip.tsx \
        src/app/world/server/StackPlate.tsx src/app/world/server/FirewallGate.tsx \
        src/app/world/server/NicBlock.tsx src/app/world/server/TraceLayer.tsx \
        src/app/world/server/ServerBoard.test.tsx src/app/world/server/selection.ts \
        src/app/world/ServerView.tsx
git commit -m "feat(server-view): static circuit-board stage replacing the Phase-1 readout"
```

---

## Task 4: Hardware platform + live display metrics `[sonnet]`

**Files:** create `HardwarePlatform.tsx`, `useServerDisplayMetrics.ts`; extend `NicBlock.tsx`
(live bar) and `ServiceChip.tsx` (conn/p50 line, health dot) call sites in `ServerBoard.tsx`;
create jsdom test `HardwarePlatform.test.tsx`.

**Grounding:** `ServerMetrics { coreUtilization:number[], stealFraction, burstCredits:number|null,
ramByInstance:[{instanceId,blueprintId,ramMb}], ramUsedMb, ramTotalMb, nicInMbps, nicOutMbps,
diskIoFraction, health }` and `InstanceMetrics { activeConnections, p50Ms, ramMb, health }`
(contracts, order-stable). Store: `useSimulationStore` v2 has `latestBatch: MetricsBatch|null`
and `scrubBatch: MetricsBatch|null` (T15). Scrub-aware read = `scrubBatch ?? latestBatch` (D5).
`server.specs.diskGb/nicMbps`, blueprint `workload.ramBaseMb` for at-rest estimate.

- [ ] **Step 1: Write `useServerDisplayMetrics.ts`**

```ts
// src/app/world/server/useServerDisplayMetrics.ts
// Scrub-aware slice of the metrics pyramid for one server + its resident instances (D5).
import { useSimulationStore } from '../../store/simulation.store'
import type { ServerMetrics, InstanceMetrics } from '../../../lib/worldEngine/types'
import type { InstanceId } from '../../../lib/world/types'   // id types live in world/types, NOT re-exported by worldEngine/types

export interface ServerDisplay {
  server: ServerMetrics | null
  instances: Record<InstanceId, InstanceMetrics>
  scrubbing: boolean
}

export function useServerDisplayMetrics(serverId: string): ServerDisplay {
  return useSimulationStore(s => {
    const batch = s.scrubBatch ?? s.latestBatch
    if (!batch) return { server: null, instances: {}, scrubbing: s.scrubBatch !== null }
    const server = batch.servers[serverId] ?? null
    const instances: Record<InstanceId, InstanceMetrics> = {}
    for (const [id, m] of Object.entries(batch.instances)) {
      if (server && batch.servers[serverId] && m) instances[id] = m   // filtered below by caller via resident set
    }
    return { server, instances: batch.instances, scrubbing: s.scrubBatch !== null }
  })
}
```

> Note: returning the full `batch.instances` map is intentional — `HardwarePlatform`/`ServiceChip`
> index it by the resident instance ids they already hold from the layout; filtering here would
> duplicate the layout's resident set. `useSimulationStore(selector)` must return a stable-enough
> object; if reference churn causes re-render storms, wrap the slice in a `useMemo` keyed on
> `[batch, serverId]` inside the hook (zustand selector returning a fresh object each call is a
> known footgun — prefer selecting `scrubBatch`/`latestBatch` separately then `useMemo`). Prefer
> the `useMemo` form:

```ts
import { useMemo } from 'react'
import { useSimulationStore } from '../../store/simulation.store'
import type { ServerMetrics, InstanceMetrics } from '../../../lib/worldEngine/types'
import type { InstanceId } from '../../../lib/world/types'   // id types live in world/types, NOT re-exported by worldEngine/types

export interface ServerDisplay {
  server: ServerMetrics | null
  instances: Record<InstanceId, InstanceMetrics>
  scrubbing: boolean
}

export function useServerDisplayMetrics(serverId: string): ServerDisplay {
  const scrubBatch = useSimulationStore(s => s.scrubBatch)
  const latestBatch = useSimulationStore(s => s.latestBatch)
  return useMemo(() => {
    const batch = scrubBatch ?? latestBatch
    return {
      server: batch?.servers[serverId] ?? null,
      instances: batch?.instances ?? {},
      scrubbing: scrubBatch !== null,
    }
  }, [scrubBatch, latestBatch, serverId])
}
```

Use the `useMemo` version (delete the first sketch).

- [ ] **Step 2: Write the failing jsdom test `HardwarePlatform.test.tsx`**

```tsx
// src/app/world/server/HardwarePlatform.test.tsx
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HardwarePlatform } from './HardwarePlatform'
import { createWorld, createRegion, createAz, createServer } from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'
import type { ServerMetrics } from '../../../lib/worldEngine/types'

function server(kind: 'vps' | 'dedicated' = 'vps') {
  const doc = createWorld()
  const r = createRegion('us-east-1'); const az = createAz(r.id, 'us-east-1a')
  const s = createServer(az.id, getPreset(kind === 'vps' ? 'vps-medium' : 'dedicated-8')!)
  return s
}
const metrics = (over: Partial<ServerMetrics> = {}): ServerMetrics => ({
  serverId: 's', coreUtilization: [0.6, 0.4, 0.9, 0.1], stealFraction: 0, burstCredits: null,
  ramByInstance: [{ instanceId: 'i1', blueprintId: 'b1', ramMb: 1400 }, { instanceId: 'i2', blueprintId: 'b2', ramMb: 610 }],
  ramUsedMb: 5900, ramTotalMb: 8192, nicInMbps: 214, nicOutMbps: 118, diskIoFraction: 0.12, health: 'healthy', ...over,
})
const residents = [
  { instanceId: 'i1', blueprintId: 'b1', color: '#A78BFA', name: 'postgres', ramBaseMb: 256 },
  { instanceId: 'i2', blueprintId: 'b2', color: '#4A9EFF', name: 'api', ramBaseMb: 128 },
]

describe('HardwarePlatform', () => {
  it('renders one core cell per vcpu', () => {
    const s = server()
    render(<HardwarePlatform server={s} metrics={metrics()} residentBlueprints={residents} attribution={[]} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}} />)
    expect(screen.getAllByTestId('core-cell')).toHaveLength(4)
  })

  it('steal arc appears only for vps with steal', () => {
    const s = server('vps')
    const { rerender } = render(<HardwarePlatform server={s} metrics={metrics({ stealFraction: 0.18 })} residentBlueprints={residents} attribution={[]} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}} />)
    expect(screen.getByText(/steal/)).toBeInTheDocument()
    rerender(<HardwarePlatform server={s} metrics={metrics({ stealFraction: 0 })} residentBlueprints={residents} attribution={[]} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}} />)
    expect(screen.queryByText(/steal/)).not.toBeInTheDocument()
  })

  it('ram strata follow ramByInstance order and include os+cache remainder', () => {
    const s = server()
    render(<HardwarePlatform server={s} metrics={metrics()} residentBlueprints={residents} attribution={[]} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}} />)
    const strata = screen.getAllByTestId('ram-stratum')
    // 2 instance strata + os+cache remainder
    expect(strata.length).toBe(3)
    expect(screen.getByText(/os \+ cache/i)).toBeInTheDocument()
  })

  it('at-rest estimate uses ramBaseMb when no batch', () => {
    const s = server()
    render(<HardwarePlatform server={s} metrics={null} residentBlueprints={residents} attribution={[]} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}} />)
    expect(screen.getByText(/at rest/i)).toBeInTheDocument()
  })

  it('disk slices proportional to volume sizes', () => {
    const s = server()
    s.stacks = [{ name: 'app', networks: [], volumes: [{ name: 'pgdata', sizeGb: 12 }] }]
    render(<HardwarePlatform server={s} metrics={metrics()} residentBlueprints={residents} attribution={[]} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}} />)
    expect(screen.getByText(/pgdata/)).toBeInTheDocument()
  })

  it('oom warning appears at 90% of memLimit', () => {
    const s = server()
    render(<HardwarePlatform server={s} metrics={metrics()} residentBlueprints={residents}
      attribution={[]} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}}
      memLimits={{ i2: 640 }} instanceRamMb={{ i2: 610 }} />)
    expect(screen.getByText(/oom/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Write `HardwarePlatform.tsx`**

```tsx
// src/app/world/server/HardwarePlatform.tsx
// Unified host platform (D4): CPU die + utilization ring (hatched amber steal arc for VPS),
// stratified RAM reservoir (one colored stratum per resident + os/cache remainder), sliced disk
// platter with an io scanner. All numbers from ServerMetrics (order-stable); at-rest estimate
// from blueprint ramBaseMb when metrics is null (D5). prefers-reduced-motion parks the scanner
// and drops idle shimmer.
import type { ReactElement } from 'react'
import { useReducedMotion } from 'framer-motion'
import type { Server, InstanceId } from '../../../lib/world/types'   // id types from world/types (not re-exported by worldEngine/types)
import type { ServerMetrics } from '../../../lib/worldEngine/types'
import type { CoreAttribution } from './boardLayout'
import type { BoardSelection } from './selection'

const AMBER = '#F5A623', CPU_BLUE = '#4A9EFF'

export interface HardwarePlatformProps {
  server: Server
  metrics: ServerMetrics | null
  residentBlueprints: { instanceId: InstanceId; blueprintId: string; color: string; name: string; ramBaseMb: number }[]
  attribution: CoreAttribution[]
  hoveredBlueprintId: string | null
  onHoverBlueprint: (id: string | null) => void
  onSelect: (s: BoardSelection | null) => void
  box?: { x: number; y: number; w: number; h: number }   // hardware.box from layout (optional)
  memLimits?: Record<InstanceId, number>                  // container memLimitMb by instance
  instanceRamMb?: Record<InstanceId, number>              // live per-instance ramMb (oom check)
}

export function HardwarePlatform(props: HardwarePlatformProps): ReactElement {
  const { server, metrics, residentBlueprints, attribution, hoveredBlueprintId, onHoverBlueprint, onSelect } = props
  const reduced = useReducedMotion()
  const vcpu = server.specs.vcpu
  const cols = Math.ceil(Math.sqrt(vcpu))
  const dimFor = (bpId: string | null) => (hoveredBlueprintId && bpId !== hoveredBlueprintId ? 0.45 : 1)

  const cores = metrics?.coreUtilization ?? new Array(vcpu).fill(0)
  const meanUtil = cores.length ? cores.reduce((a, b) => a + b, 0) / cores.length : 0
  const steal = metrics?.stealFraction ?? 0

  // RAM strata: instance slices in order + os/cache remainder (D4).
  const atRest = metrics === null
  const strata = atRest
    // at-rest estimate (D5): each resident blueprint's workload.ramBaseMb
    ? residentBlueprints.map(r => ({ instanceId: r.instanceId, blueprintId: r.blueprintId, color: r.color, name: r.name, ramMb: r.ramBaseMb }))
    : (metrics!.ramByInstance).map(s => {
        const rb = residentBlueprints.find(r => r.instanceId === s.instanceId)
        return { instanceId: s.instanceId, blueprintId: s.blueprintId, color: rb?.color ?? CPU_BLUE, name: rb?.name ?? '?', ramMb: s.ramMb }
      })
  const ramUsed = metrics?.ramUsedMb ?? strata.reduce((a, s) => a + s.ramMb, 0)
  const ramTotal = metrics?.ramTotalMb ?? server.specs.ramMb
  const osCache = Math.max(0, ramUsed - strata.reduce((a, s) => a + s.ramMb, 0))

  // Disk slices: system 15% + one per volume, remainder free (D4).
  const diskGb = server.specs.diskGb
  const volumes = server.stacks.flatMap(st => st.volumes)
  const systemGb = diskGb * 0.15
  const usedGb = systemGb + volumes.reduce((a, v) => a + v.sizeGb, 0)
  const io = metrics?.diskIoFraction ?? 0
  const HEALTH_COLOR = { healthy: 'var(--color-success)', degraded: 'var(--color-warning)', down: 'var(--color-danger)' } as const
  const hostHealth = metrics?.health ?? 'healthy'

  return (
    <div data-hardware style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 8, font: '7px var(--font-mono)', color: 'var(--color-text-secondary)' }}>
      <div style={{ color: '#8FA8C7', letterSpacing: '0.12em', display: 'flex', alignItems: 'center', gap: 4 }}>
        <span data-host-health style={{ width: 5, height: 5, borderRadius: '50%', background: HEALTH_COLOR[hostHealth], boxShadow: `0 0 5px ${HEALTH_COLOR[hostHealth]}` }} />
        ⬢ HOST · {server.kind}{server.kind === 'vps' ? ' (shared tenancy)' : ''}
      </div>

      {/* CPU die */}
      <div data-cpu onClick={() => onSelect({ kind: 'hardware', part: 'cpu' })} style={{ cursor: 'pointer' }}>
        <svg width={100} height={100} viewBox="0 0 100 100">
          <circle cx={50} cy={50} r={45} fill="none" stroke="#16202E" strokeWidth={5} />
          <circle cx={50} cy={50} r={45} fill="none" stroke={CPU_BLUE} strokeWidth={5} strokeLinecap="round"
            strokeDasharray={`${meanUtil * 283} 283`} transform="rotate(-90 50 50)" style={{ filter: `drop-shadow(0 0 5px ${CPU_BLUE})` }} />
          {steal > 0 && (
            <circle cx={50} cy={50} r={45} fill="none" stroke={AMBER} strokeWidth={5}
              strokeDasharray="2 3.1" strokeDashoffset={-meanUtil * 283} pathLength={283} transform="rotate(-90 50 50)" opacity={0.9} />
          )}
        </svg>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 3, width: 56, margin: '-78px auto 0' }}>
          {cores.map((u, i) => {
            const dom = attribution[i]?.dominantBlueprintId ?? null
            const color = residentBlueprints.find(r => r.blueprintId === dom)?.color ?? CPU_BLUE
            return <div key={i} data-testid="core-cell" style={{ height: 18, borderRadius: 2, background: `linear-gradient(0deg, ${color} ${Math.round(u * 100)}%, #141B26 ${Math.round(u * 100)}%)`, opacity: dimFor(dom) }} />
          })}
        </div>
        <div style={{ textAlign: 'center', color: '#9CC8FF', marginTop: 6 }}>
          cpu {Math.round(meanUtil * 100)}%{steal > 0 && <span style={{ color: AMBER }}> +{Math.round(steal * 100)}% steal</span>}
        </div>
        {metrics?.burstCredits != null && (
          <div style={{ height: 2, background: '#0F2B27', marginTop: 2 }}><div style={{ width: `${metrics.burstCredits * 100}%`, height: '100%', background: AMBER }} /></div>
        )}
      </div>

      {/* RAM reservoir */}
      <div data-ram onClick={() => onSelect({ kind: 'hardware', part: 'ram' })} style={{ display: 'flex', gap: 6, alignItems: 'flex-end', cursor: 'pointer' }}>
        <div style={{ width: 34, height: 64, background: '#0C1119', border: '1px solid #2A3648', borderRadius: '5px 5px 3px 3px', position: 'relative', overflow: 'hidden' }}>
          {(() => { let acc = 0; return strata.map(s => {
            const pct = ramTotal ? (s.ramMb / ramTotal) * 100 : 0
            const el = <div key={s.instanceId} data-testid="ram-stratum" onMouseEnter={() => onHoverBlueprint(s.blueprintId)} onMouseLeave={() => onHoverBlueprint(null)}
              style={{ position: 'absolute', bottom: `${acc}%`, width: '100%', height: `${pct}%`, background: s.color, opacity: dimFor(s.blueprintId) }} />
            acc += pct; return el
          }) })()}
          <div data-testid="ram-stratum" style={{ position: 'absolute', bottom: `${ramTotal ? (ramUsed - osCache) / ramTotal * 100 : 0}%`, width: '100%', height: `${ramTotal ? osCache / ramTotal * 100 : 0}%`, background: 'linear-gradient(0deg,#F5A62388,#F5A62333)' }} />
        </div>
        <div style={{ flex: 1, lineHeight: 1.7 }}>
          <div style={{ color: '#E2E8F0' }}>ram {(ramUsed / 1024).toFixed(1)}/{(ramTotal / 1024).toFixed(0)}G {atRest && <span style={{ color: 'var(--color-text-muted)' }}>(at rest)</span>}</div>
          {strata.map(s => {
            const oom = props.memLimits?.[s.instanceId] && props.instanceRamMb?.[s.instanceId] && props.instanceRamMb[s.instanceId] >= props.memLimits[s.instanceId] * 0.9
            return <div key={s.instanceId} style={{ opacity: dimFor(s.blueprintId) }}><span style={{ color: s.color }}>▮</span> {s.name} {Math.round(s.ramMb)}M {oom && <span style={{ color: 'var(--color-danger)' }}>⚠oom</span>}</div>
          })}
          <div><span style={{ color: AMBER }}>▮</span> os + cache {Math.round(osCache)}M</div>
        </div>
      </div>

      {/* Disk platter */}
      <div data-disk onClick={() => onSelect({ kind: 'hardware', part: 'disk' })} style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
        <svg width={52} height={52} viewBox="0 0 52 52">
          <circle cx={26} cy={26} r={23} fill="#0C1119" stroke="#2A3648" strokeWidth={1} />
          {(() => {
            const circ = 2 * Math.PI * 11.5
            let off = 0
            const slices: ReactElement[] = []
            const push = (gb: number, color: string, key: string) => {
              const len = diskGb ? (gb / diskGb) * circ : 0
              slices.push(<circle key={key} cx={26} cy={26} r={11.5} fill="none" stroke={color} strokeWidth={21} strokeDasharray={`${len} ${circ - len}`} strokeDashoffset={-off} transform="rotate(-90 26 26)" opacity={0.85} />)
              off += len
            }
            push(systemGb, '#33415888', 'system')
            volumes.forEach(v => push(v.sizeGb, AMBER, v.name))
            return slices
          })()}
          <line x1={26} y1={26} x2={26} y2={4} stroke="#7CFFE9" strokeWidth={1} opacity={0.7}
            style={reduced || !metrics ? undefined : { transformOrigin: '26px 26px', animation: `spin ${(3.5 / Math.max(io, 0.05)).toFixed(2)}s linear infinite` }} />
          <circle cx={26} cy={26} r={3} fill="#141B26" stroke="#2A3648" />
        </svg>
        <div style={{ flex: 1, lineHeight: 1.7 }}>
          <div style={{ color: '#E2E8F0' }}>nvme0 {Math.round(usedGb)}/{diskGb}G · io {Math.round(io * 100)}%</div>
          {volumes.map(v => <div key={v.name}><span style={{ color: AMBER }}>▮</span> vol {v.name} {v.sizeGb}G</div>)}
          <div><span style={{ color: '#64748B' }}>▮</span> system {Math.round(systemGb)}G · free {Math.round(diskGb - usedGb)}G</div>
        </div>
      </div>
    </div>
  )
}
```

> `@keyframes spin { to { transform: rotate(360deg) } }` must exist — add it once to
> `src/index.css` if absent (a generic util, not a scene token). The at-rest RAM estimate (D5)
> uses each resident blueprint's `workload.ramBaseMb`: when `metrics === null`, replace the empty
> `ramMb: 0` sketch with `doc.blueprints[r.blueprintId]?.workload.ramBaseMb ?? 0` — pass a
> `restRamByBlueprint` prop from `ServerView` (which has `doc`) OR read the base directly by
> threading the resident blueprint's base into `residentBlueprints`. Simplest: extend
> `residentBlueprints` items with `ramBaseMb: number` and use it for the at-rest slice. Wire this
> in ServerView's memo.

- [ ] **Step 4: Mount `HardwarePlatform` in `ServerBoard.tsx` and wire live chip/NIC metrics**

In `ServerBoard.tsx`, call `useServerDisplayMetrics(serverId)` and `attributeCores` over the live
`cpuCoresUsed` (from `batch.instances[iid].cpuCoresUsed`), then:
- render `<HardwarePlatform>` absolutely-positioned at `layout.hardware.box` (a right-rail
  wrapper `div` at `left/top/width/height` = the box), passing `metrics = display.server`,
  `residentBlueprints` (built from `doc` + resident chips, incl. `ramBaseMb`), `attribution`,
  and `memLimits`/`instanceRamMb` from placements + `display.instances`.
- pass live `connLabel`/`health` into each `ServiceChip`:
  `connLabel = m ? \`${m.activeConnections} conn · p50 ${m.p50Ms.toFixed(1)}ms\` : '—'`,
  `health = m?.health`.
- pass `inMbps`/`outMbps`/`utilFraction` into `NicBlock`:
  `utilFraction = server ? (server.nicInMbps + server.nicOutMbps) / server.specs... ` →
  `(metrics.nicInMbps + metrics.nicOutMbps) / server.specs.nicMbps`.
- add a small "scrubbing" pill in the board corner when `display.scrubbing`.

- [ ] **Step 5: Run tests + build**

Run: `npx vitest run src/app/world/server/HardwarePlatform.test.tsx` → PASS (6 tests).
Run: `npm run build`, `npx vitest run` → green.

- [ ] **Step 6: Live smoke** — simulate the T3 world; verify the ring fills, RAM strata stack in
blueprint colors, NIC bar moves, disk scanner rotates; `browser_console_messages` zero errors;
screenshot `task4-hardware.png`; Stop then scrub → strata reflect the scrubbed frame (a
"scrubbing" pill shows). Stop the dev server.

- [ ] **Step 7: Commit**

```bash
git add src/app/world/server/HardwarePlatform.tsx src/app/world/server/useServerDisplayMetrics.ts \
        src/app/world/server/HardwarePlatform.test.tsx src/app/world/server/ServerBoard.tsx \
        src/app/world/server/ServiceChip.tsx src/app/world/server/NicBlock.tsx src/index.css
git commit -m "feat(server-view): live unified hardware platform (cpu die, ram reservoir, disk platter)"
```

---

## Task 5: Packet layer + gate stats `[sonnet]`

**Files:** create `PacketLayer.tsx`, `gateStats.ts`, `gateStats.test.ts`; extend
`FirewallGate.tsx` call site (blocked/s) and `ServerBoard.tsx` (mount PacketLayer at z2).

**Grounding:** `useSimulationStore.attachRenderer({level:'server',serverId}, onFrame)` returns a
`DetachFn`; `onFrame` gets a `FramePayload { particles: VisualParticle[] }`. `EngineEvent
{ kind, simMs, affected[] }`; `connection_refused` is the blocked-path kind. Store has `events`
and `latestBatch.simMs`. Canvas draws via refs only (D10); attach once per `(serverId, running)`
(T14 lesson) — never on hover/selection. Reduced motion → ≥500ms between redraws (AzSimOverlay
precedent).

- [ ] **Step 1: Write the failing test `gateStats.test.ts`**

```ts
// src/app/world/server/gateStats.test.ts
import { describe, it, expect } from 'vitest'
import { blockedPerSecond } from './gateStats'
import type { EngineEvent } from '../../../lib/worldEngine/types'

const ev = (simMs: number, affected: string[], kind: EngineEvent['kind'] = 'connection_refused'): EngineEvent =>
  ({ id: `${simMs}-${affected.join()}`, simMs, kind, severity: 'warning', message: '', affected })

describe('blockedPerSecond', () => {
  it('counts only this server refused events in the window', () => {
    const events = [
      ev(9000, ['srv-1']), ev(9500, ['srv-1']), ev(9800, ['srv-2']),
      ev(9900, ['srv-1'], 'oom_kill'),
    ]
    // window (5000, 10000], 5s → 2 srv-1 refused / 5 = 0.4
    expect(blockedPerSecond(events, 'srv-1', 10000)).toBeCloseTo(0.4)
  })

  it('returns 0 outside the window', () => {
    const events = [ev(1000, ['srv-1']), ev(2000, ['srv-1'])]
    expect(blockedPerSecond(events, 'srv-1', 10000)).toBe(0)
  })

  it('scales to per-second by the window width', () => {
    const events = [ev(9000, ['srv-1']), ev(9200, ['srv-1']), ev(9400, ['srv-1'])]
    expect(blockedPerSecond(events, 'srv-1', 10000, 2000)).toBeCloseTo(1.5)   // 3 / (2000/1000)
  })
})
```

- [ ] **Step 2: Run to verify it fails**, then write `gateStats.ts`

```ts
// src/app/world/server/gateStats.ts
import type { EngineEvent } from '../../../lib/worldEngine/types'

// Refused connections attributed to this server within the trailing window, per second.
export function blockedPerSecond(
  events: EngineEvent[], serverId: string, nowSimMs: number, windowMs = 5000,
): number {
  const lo = nowSimMs - windowMs
  let count = 0
  for (const e of events) {
    if (e.kind !== 'connection_refused') continue
    if (e.simMs <= lo || e.simMs > nowSimMs) continue
    if (e.affected.includes(serverId)) count++
  }
  return count / (windowMs / 1000)
}
```

Run: `npx vitest run src/app/world/server/gateStats.test.ts` → PASS (3 tests).

- [ ] **Step 3: Write the failing jsdom test `PacketLayer.test.tsx`**

```tsx
// src/app/world/server/PacketLayer.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { PacketLayer } from './PacketLayer'
import { useSimulationStore } from '../../store/simulation.store'
import { layoutServerBoard } from './boardLayout'
import { createWorld, createRegion, createAz, createServer } from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'
import { compileWorld } from '../../../lib/world/compileWorld'

function layout() {
  const doc = createWorld()
  const r = createRegion('us-east-1'); const az = createAz(r.id, 'us-east-1a')
  const s = createServer(az.id, getPreset('vps-medium')!)
  doc.regions[r.id] = r; doc.azs[az.id] = az; doc.servers[s.id] = s
  return { layout: layoutServerBoard(s, doc, compileWorld(doc)), serverId: s.id }
}

describe('PacketLayer', () => {
  beforeEach(() => useSimulationStore.setState({ running: false }))

  it('attaches the renderer when running and detaches on unmount', () => {
    const detach = vi.fn()
    const attach = vi.fn(() => detach)
    useSimulationStore.setState({ running: true, attachRenderer: attach as never })
    const { layout: l, serverId } = layout()
    const { unmount } = render(<PacketLayer serverId={serverId} layout={l} />)
    expect(attach).toHaveBeenCalledTimes(1)
    expect(attach.mock.calls[0][0]).toEqual({ level: 'server', serverId })
    unmount()
    expect(detach).toHaveBeenCalledTimes(1)
  })

  it('does not attach when stopped', () => {
    const attach = vi.fn(() => vi.fn())
    useSimulationStore.setState({ running: false, attachRenderer: attach as never })
    const { layout: l, serverId } = layout()
    render(<PacketLayer serverId={serverId} layout={l} />)
    expect(attach).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 4: Write `PacketLayer.tsx`**

```tsx
// src/app/world/server/PacketLayer.tsx
// Canvas over the (unscaled) 1000x560 stage — lives INSIDE the scaled stage div so logical coords
// need no conversion. Attaches the server renderer once per (serverId, running); draws via refs.
// Particle position = point at `progress` along layout.tracePath, resolved with a cached hidden
// SVG path per unique pair. Blocked bursts render at the gate (nic origin) or target anchor (D6).
import { useEffect, useRef, type ReactElement } from 'react'
import { useReducedMotion } from 'framer-motion'
import { useSimulationStore } from '../../store/simulation.store'
import type { BoardLayout } from './boardLayout'
import type { VisualParticle } from '../../../lib/worldEngine/types'

const PROTOCOL_COLOR: Record<VisualParticle['protocol'], string> = {
  http: '#4A9EFF', db: '#F5A623', event: '#A78BFA', stream: '#2DD4BF',
}

export interface PacketLayerProps { serverId: string; layout: BoardLayout }

export function PacketLayer({ serverId, layout }: PacketLayerProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const running = useSimulationStore(s => s.running)
  const reduced = useReducedMotion()
  const lastDrawRef = useRef(0)
  const pathCache = useRef(new Map<string, SVGPathElement>())

  useEffect(() => {
    if (!running) {
      const ctx = canvasRef.current?.getContext('2d')
      if (ctx && canvasRef.current) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height)
      return
    }
    const svgNS = 'http://www.w3.org/2000/svg'
    const pointAt = (fromId: string, toId: string, progress: number) => {
      const key = `${fromId}→${toId}`
      let path = pathCache.current.get(key)
      if (!path) {
        const d = layout.tracePath(fromId, toId)
        if (!d) return null
        path = document.createElementNS(svgNS, 'path')
        path.setAttribute('d', d)
        pathCache.current.set(key, path)
      }
      const len = path.getTotalLength?.() ?? 0
      if (!len) return null
      return path.getPointAtLength(len * progress)
    }
    const detach = useSimulationStore.getState().attachRenderer({ level: 'server', serverId }, payload => {
      const now = performance.now()
      if (reduced && now - lastDrawRef.current < 500) return
      lastDrawRef.current = now
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) return
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      for (const p of payload.particles) {
        if (p.blocked && p.progress > 0.85) {
          const burstAt = p.fromId.startsWith('nic:') ? layout.gate.inAnchor : layout.anchorFor(p.toId)
          if (!burstAt) continue
          const t = (p.progress - 0.85) / 0.15
          ctx.beginPath(); ctx.arc(burstAt.x, burstAt.y, 4 + t * 10, 0, Math.PI * 2)
          ctx.strokeStyle = `rgba(239,68,68,${1 - t})`; ctx.lineWidth = 2; ctx.stroke()
          continue
        }
        const pt = pointAt(p.fromId, p.toId, p.progress)
        if (!pt) continue
        ctx.beginPath(); ctx.arc(pt.x, pt.y, 2.6, 0, Math.PI * 2)
        ctx.fillStyle = p.colorHint ?? PROTOCOL_COLOR[p.protocol]; ctx.fill()
      }
    })
    return detach
  }, [running, serverId, layout, reduced])

  return <canvas ref={canvasRef} width={layout.stageW} height={layout.stageH}
    style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
}
```

- [ ] **Step 5: Mount PacketLayer at z2 in `ServerBoard.tsx` and wire the gate counter**

Replace the `{/* z2: PacketLayer mounts here in T5 */}` comment with
`<PacketLayer serverId={serverId} layout={layout} />`. Compute
`blockedPerSecond(events, serverId, latestBatch?.simMs ?? 0)` from
`useSimulationStore(s => s.events)` + `latestBatch` and pass it into `<FirewallGate blockedPerSecond={…}>`.

- [ ] **Step 6: Run tests + build**

Run: `npx vitest run src/app/world/server/gateStats.test.ts src/app/world/server/PacketLayer.test.tsx` → PASS.
Run: `npm run build`, `npx vitest run` → green.

- [ ] **Step 7: Live smoke** — simulate → packets visibly traverse nic→gate→chip and
chip→plate traces; a blocked burst pulses at the gate and `✕ N/s blocked` increments; emulate
reduced motion (`browser` `emulateMedia prefers-reduced-motion: reduce`) → still shows
current-state redraws (throttled). Zero console errors; screenshot `task5-packets.png`. Stop dev.

- [ ] **Step 8: Commit**

```bash
git add src/app/world/server/PacketLayer.tsx src/app/world/server/gateStats.ts \
        src/app/world/server/gateStats.test.ts src/app/world/server/PacketLayer.test.tsx \
        src/app/world/server/FirewallGate.tsx src/app/world/server/ServerBoard.tsx
git commit -m "feat(server-view): engine-driven packet layer and firewall block counter"
```

---

## Task 6: Selection model, inspector rail (read), cross-highlight `[sonnet]`

**Files:** `src/app/world/server/selection.ts` already exists (T3 created the type-only union to
keep its build green) — verify it matches the union below verbatim, else reconcile. Create
`InspectorRail.tsx`, `InspectorRail.test.tsx`; wire selection + hover through `ServerView.tsx`
and `ServerBoard.tsx` (replace T3's `null`/noop props); confirm dim/glow treatment in
`ServiceChip`/`StackPlate`/`HardwarePlatform`/`TraceLayer` (props already accept `dimmed`/
`hovered` from T3/T4 — wire the values).

**Grounding — Esc handling (verified against `WorldShell.tsx:42-66`):** WorldShell registers a
`window` `keydown` (bubble phase) that calls `useNavStore.getState().up()` on `Escape`, but FIRST
does `if (e.defaultPrevented) return`. It also ignores events whose target is INPUT/TEXTAREA/
SELECT/contentEditable. Therefore ServerView's own Esc handler must register in the **capture
phase** (`addEventListener('keydown', h, true)`) so it runs before WorldShell's bubble handler
regardless of mount order, and call `e.preventDefault()` when a selection is active — WorldShell
then sees `defaultPrevented` and does NOT navigate up. (Registration-order tricks are unreliable
here: ServerView mounts after WorldShell, so its bubble listener would fire second. Capture phase
is the robust mechanism — document this in the report.)

- [ ] **Step 1: Confirm `selection.ts` (type-only)**

```ts
// src/app/world/server/selection.ts
import type { InstanceId } from '../../../lib/world/types'

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

- [ ] **Step 2: Write the failing jsdom test `InspectorRail.test.tsx`**

```tsx
// src/app/world/server/InspectorRail.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { InspectorRail } from './InspectorRail'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
} from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'
import { compileWorld, instanceId } from '../../../lib/world/compileWorld'
import type { WorldDoc } from '../../../lib/world/types'

function seed(configure: (doc: WorldDoc, serverId: string) => void) {
  const doc = createWorld()
  const r = createRegion('us-east-1'); const az = createAz(r.id, 'us-east-1a')
  const s = createServer(az.id, getPreset('vps-medium')!)
  doc.regions[r.id] = r; doc.azs[az.id] = az; doc.servers[s.id] = s
  configure(doc, s.id)
  useWorldStore.setState({ doc, history: [], future: [] })
  useSimulationStore.setState({ running: false, latestBatch: null, scrubBatch: null })
  return { doc, serverId: s.id }
}

describe('InspectorRail (read panels)', () => {
  beforeEach(() => useWorldStore.getState().newWorld())

  it('instance selection shows runtime, limits, and host resources', () => {
    const { doc, serverId } = seed((d, sid) => {
      d.servers[sid].stacks = [{ name: 'app', networks: [{ name: 'n', cidr: '172.18.0.0/16' }], volumes: [] }]
      const bp = createBlueprint('api', 1); d.blueprints[bp.id] = bp
      const pl = createPlacement(bp.id, sid)
      pl.runtime = { type: 'container', stackName: 'app', networkNames: ['n'], portMappings: [{ host: 3000, container: 8080 }], cpuLimit: 2, memLimitMb: 640 }
      d.placements['p'] = pl
    })
    const iid = instanceId('p', 0)
    render(<InspectorRail serverId={serverId} selection={{ kind: 'instance', instanceId: iid }} onSelect={() => {}} />)
    expect(screen.getByText('api')).toBeInTheDocument()
    expect(screen.getByText(/stack: app/)).toBeInTheDocument()
    expect(screen.getByText(/640/)).toBeInTheDocument()          // mem limit
  })

  it('firewall selection lists rules in order and drills into a rule', () => {
    const onSelect = vi.fn()
    const { serverId } = seed((d, sid) => {
      d.servers[sid].firewall = [
        { id: 'r1', action: 'allow', port: 443, protocol: 'tcp', source: 'any' },
        { id: 'r2', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' },
      ]
    })
    render(<InspectorRail serverId={serverId} selection={{ kind: 'firewall' }} onSelect={onSelect} />)
    expect(screen.getByText(/first match wins/i)).toBeInTheDocument()
    const rows = screen.getAllByTestId('fw-rule-row')
    expect(rows).toHaveLength(2)
    fireEvent.click(rows[1])
    expect(onSelect).toHaveBeenCalledWith({ kind: 'rule', ruleId: 'r2' })
  })

  it('volume panel lists consumers by volumeName', () => {
    const { serverId } = seed((d, sid) => {
      d.servers[sid].stacks = [{ name: 'app', networks: [], volumes: [{ name: 'pgdata', sizeGb: 12 }] }]
      const pg = createBlueprint('postgres', 2); pg.stateful = true; pg.volumeName = 'pgdata'
      d.blueprints[pg.id] = pg
      d.placements['p'] = createPlacement(pg.id, sid)
    })
    render(<InspectorRail serverId={serverId} selection={{ kind: 'volume', stackName: 'app', volumeName: 'pgdata' }} onSelect={() => {}} />)
    expect(screen.getByText(/postgres/)).toBeInTheDocument()
  })

  it('empty selection shows a hint', () => {
    const { serverId } = seed(() => {})
    render(<InspectorRail serverId={serverId} selection={null} onSelect={() => {}} />)
    expect(screen.getByText(/click any element/i)).toBeInTheDocument()
  })
})

import { vi } from 'vitest'
```

> Move the `import { vi } from 'vitest'` to the top with the other imports (shown at the bottom
> only for readability of this skeleton).

- [ ] **Step 3: Write `InspectorRail.tsx` (read panels)**

```tsx
// src/app/world/server/InspectorRail.tsx
// HUD inspector rail: a read panel per BoardSelection kind. Reads doc (useWorldStore) + live
// metrics (useServerDisplayMetrics); world writes arrive in T7's forms mounted here. Rule rows
// drill into `{kind:'rule'}`.
import type { ReactElement } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useCompiledWorld } from '../useCompiledWorld'
import { useServerDisplayMetrics } from './useServerDisplayMetrics'
import type { BoardSelection } from './selection'

const railText = { font: '7.5px var(--font-mono)', color: 'var(--color-text-secondary)', lineHeight: 1.9 } as const

export interface InspectorRailProps {
  serverId: string
  selection: BoardSelection | null
  onSelect: (s: BoardSelection | null) => void
}

export function InspectorRail({ serverId, selection, onSelect }: InspectorRailProps): ReactElement {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const display = useServerDisplayMetrics(serverId)
  const server = doc.servers[serverId]

  const header = (title: string) => (
    <div style={{ font: '8px var(--font-mono)', color: '#7CFFE9', letterSpacing: '0.1em', borderBottom: '1px solid #14332E', paddingBottom: 5 }}>▸ INSPECTOR — {title}</div>
  )

  let body: ReactElement
  if (!selection) {
    body = <div style={{ ...railText, color: 'var(--color-text-muted)', marginTop: 8 }}>click any element (chip · trace · gate · rule · core · volume) to inspect</div>
  } else if (selection.kind === 'instance') {
    const inst = compiled.instances[selection.instanceId]
    const bp = inst ? doc.blueprints[inst.blueprintId] : undefined
    const pl = inst ? doc.placements[inst.placementId] : undefined
    const m = display.instances[selection.instanceId]
    const rt = pl?.runtime
    const memLimit = rt?.type === 'container' ? rt.memLimitMb : null
    const oom = memLimit && m ? m.ramMb >= memLimit * 0.9 : false
    body = (
      <div style={{ ...railText, marginTop: 6 }}>
        <div style={{ color: '#DBEAFE' }}>{bp?.name}</div>
        <div>runtime <span style={{ color: '#C4B5FD' }}>{rt?.type}{rt?.type === 'container' ? ` · stack: ${rt.stackName}` : ''}</span></div>
        {rt?.type === 'container' && <div>binds <span style={{ color: '#9CC8FF' }}>{rt.portMappings.map(p => `:${p.host}→${p.container}`).join(' ') || '—'}</span></div>}
        {rt?.type === 'container' && <div>cpu {m?.cpuCoresUsed?.toFixed(1) ?? '—'}c of {rt.cpuLimit ?? '∞'}</div>}
        {rt?.type === 'container' && <div style={{ color: oom ? 'var(--color-danger)' : undefined }}>mem {m ? Math.round(m.ramMb) : '—'}M / {memLimit ?? '∞'}M {oom && '⚠'}</div>}
        <div style={{ marginTop: 7, color: '#475569', letterSpacing: '0.08em' }}>RESOURCES ON HOST</div>
        <div>p50 {m?.p50Ms?.toFixed(1) ?? '—'}ms · {m?.activeConnections ?? '—'} conn</div>
        {/* T7 mounts WorkloadForm + RuntimeForm below this line */}
      </div>
    )
  } else if (selection.kind === 'nic') {
    const sm = display.server
    body = <div style={{ ...railText, marginTop: 6 }}>
      <div>speed {server?.specs.nicMbps} Mbps</div>
      <div>in {sm ? Math.round(sm.nicInMbps) : '—'} · out {sm ? Math.round(sm.nicOutMbps) : '—'} Mb/s</div>
    </div>
  } else if (selection.kind === 'firewall' || selection.kind === 'rule') {
    body = <div style={{ ...railText, marginTop: 6 }}>
      <div style={{ color: '#475569' }}>first match wins · default deny</div>
      {(server?.firewall ?? []).map(r => (
        <div key={r.id} data-testid="fw-rule-row" onClick={() => onSelect({ kind: 'rule', ruleId: r.id })}
          style={{ cursor: 'pointer', color: r.action === 'allow' ? 'var(--color-success)' : 'var(--color-danger)', background: selection.kind === 'rule' && selection.ruleId === r.id ? '#ffffff08' : undefined }}>
          {r.action.toUpperCase()} :{r.port} {r.protocol} from {r.source}
        </div>
      ))}
      {/* T7 mounts FirewallEditor below */}
    </div>
  } else if (selection.kind === 'stack') {
    const st = server?.stacks.find(s => s.name === selection.stackName)
    const members = Object.values(compiled.instances).filter(i => {
      const pl = doc.placements[i.placementId]
      return i.serverId === serverId && pl?.runtime.type === 'container' && pl.runtime.stackName === selection.stackName
    })
    body = <div style={{ ...railText, marginTop: 6 }}>
      <div>networks {st?.networks.map(n => n.cidr).join(', ') || '—'}</div>
      <div>volumes {st?.volumes.map(v => `${v.name} ${v.sizeGb}G`).join(', ') || '—'}</div>
      <div>members {members.map(i => doc.blueprints[i.blueprintId]?.name).join(', ') || '—'}</div>
      {/* T7 mounts VolumesEditor below */}
    </div>
  } else if (selection.kind === 'volume') {
    const consumers = Object.values(doc.blueprints).filter(b => b.volumeName === selection.volumeName)
    const vol = server?.stacks.find(s => s.name === selection.stackName)?.volumes.find(v => v.name === selection.volumeName)
    body = <div style={{ ...railText, marginTop: 6 }}>
      <div>size {vol?.sizeGb ?? '—'}G</div>
      <div>consumers {consumers.map(b => b.name).join(', ') || '—'}</div>
    </div>
  } else if (selection.kind === 'hardware') {
    const sm = display.server
    body = <div style={{ ...railText, marginTop: 6 }}>
      {selection.part === 'cpu' && <div>cores {sm?.coreUtilization.length ?? server?.specs.vcpu} · steal {sm ? Math.round(sm.stealFraction * 100) : 0}%</div>}
      {selection.part === 'ram' && <div>ram {sm ? (sm.ramUsedMb / 1024).toFixed(1) : '—'}/{sm ? (sm.ramTotalMb / 1024).toFixed(0) : Math.round((server?.specs.ramMb ?? 0) / 1024)}G</div>}
      {selection.part === 'disk' && <div>io {sm ? Math.round(sm.diskIoFraction * 100) : 0}% · {server?.specs.diskGb}G</div>}
    </div>
  } else { // core
    const sm = display.server
    body = <div style={{ ...railText, marginTop: 6 }}>core {selection.coreIndex} · {sm ? Math.round((sm.coreUtilization[selection.coreIndex] ?? 0) * 100) : 0}%</div>
  }

  const title = selection?.kind === 'instance'
    ? (doc.blueprints[compiled.instances[selection.instanceId]?.blueprintId]?.name ?? 'instance')
    : (selection?.kind ?? 'server')
  return (
    <aside style={{ width: 240, borderLeft: '1px solid #1E2734', background: 'linear-gradient(180deg,#0D1117EE,#0A0D12EE)', padding: 10, overflowY: 'auto' }}>
      {header(title)}
      {body}
    </aside>
  )
}
```

- [ ] **Step 4: Hold selection + hover in `ServerView.tsx`; wire the rail + Esc**

Replace the T3 `<aside>` placeholder and noop props:

```tsx
const [selection, setSelection] = useState<BoardSelection | null>(null)
const [hoveredBlueprintId, setHoveredBlueprintId] = useState<BlueprintId | null>(null)
const selRef = useRef(selection)
selRef.current = selection

useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && selRef.current) {
      e.preventDefault()          // capture phase → WorldShell's bubble Esc sees defaultPrevented and skips nav.up
      setSelection(null)
    }
  }
  window.addEventListener('keydown', onKey, true)     // CAPTURE
  return () => window.removeEventListener('keydown', onKey, true)
}, [])

// clear selection when navigating to a different server
useEffect(() => { setSelection(null); setHoveredBlueprintId(null) }, [serverId])
```

Pass real props to `<ServerBoard selection={selection} onSelect={setSelection} hoveredBlueprintId={hoveredBlueprintId} onHoverBlueprint={setHoveredBlueprintId} />` and render
`<InspectorRail serverId={serverId} selection={selection} onSelect={setSelection} />` instead of the `<aside>`.

- [ ] **Step 5: Wire dim/glow in `ServerBoard.tsx`**

Compute per-chip `dimmed = hoveredBlueprintId !== null && chip.blueprintId !== hoveredBlueprintId`
and `hovered = chip.blueprintId === hoveredBlueprintId`; pass into `ServiceChip`. Compute
`selected` from `selection` (`selection?.kind==='instance' && selection.instanceId===chip.instanceId`).
Pass `dimmed` to `StackPlate` (dim when its members aren't the hovered blueprint), and pass
`hoveredBlueprintId` to `HardwarePlatform` (already dims per-stratum/core in T4) and `TraceLayer`.
Under `prefers-reduced-motion` the components already omit transitions (T3/T4 used inline
transitions — gate them behind `useReducedMotion()` where present).

- [ ] **Step 6: Tests + build + commit**

Run: `npx vitest run src/app/world/server/InspectorRail.test.tsx` → PASS (4 tests).
Run: `npm run build`, `npx vitest run` → green.

Add a jsdom test `esc clears selection without changing nav level` and `hovering a chip dims
unrelated chips and highlights its ram stratum` (render `ServerView` with seeded stores; fire a
capture-phase `keydown` Escape and assert `useNavStore.getState().level` stays `'server'`; fire
`mouseEnter` on one chip and assert unrelated chips get opacity 0.45). These live in
`InspectorRail.test.tsx` or a sibling `ServerView.interaction.test.tsx`.

```bash
git add src/app/world/server/selection.ts src/app/world/server/InspectorRail.tsx \
        src/app/world/server/InspectorRail.test.tsx src/app/world/ServerView.tsx \
        src/app/world/server/ServerBoard.tsx src/app/world/server/ServiceChip.tsx \
        src/app/world/server/StackPlate.tsx src/app/world/server/TraceLayer.tsx \
        src/app/world/server/HardwarePlatform.tsx
git commit -m "feat(server-view): selection model, HUD inspector rail, signature cross-highlight"
```

---

## Task 7: Inspector editing forms + edit-lock `[sonnet]`

**Files:** create `inspectorForms.tsx`; extend `InspectorRail.tsx` to mount the matching form
under each read panel; extend `InspectorRail.test.tsx`.

**Grounding:** write surface (verified `world.store.ts:72-78`): `updateBlueprint(id, patch:
Partial<ServiceBlueprint>)`, `updatePlacement(id, patch: Partial<Placement>)`, `updateServer(id,
patch: Partial<Server>)` — all patch-merge via `mutate` (pushes history). `WorkloadProfile =
{ cpuMsPerRequest, ramBaseMb, ramPerConnMb, diskIoPerRequest }`. Container runtime =
`{ type:'container', stackName, networkNames, portMappings:[{host,container}], cpuLimit:number|null,
memLimitMb:number|null }`. `FirewallRule = { id, action:'allow'|'deny', port:number|'any',
protocol:'tcp'|'udp'|'any', source }`. `ComposeStack.volumes = [{name,sizeGb}]`. `running` from
`useSimulationStore`. All edits recompile automatically via `useCompiledWorld` (doc-keyed memo).

- [ ] **Step 1: Write the failing tests (append to `InspectorRail.test.tsx`)**

```tsx
describe('inspector editing forms', () => {
  it('workload form patches blueprint via updateBlueprint', () => {
    const spy = vi.spyOn(useWorldStore.getState(), 'updateBlueprint')
    const { doc } = seed((d, sid) => {
      const bp = createBlueprint('api', 1); d.blueprints[bp.id] = bp
      d.placements['p'] = createPlacement(bp.id, sid)
    })
    const bpId = Object.keys(doc.blueprints)[0]
    render(<WorkloadForm blueprintId={bpId} />)
    const input = screen.getByLabelText('cpuMsPerRequest')
    fireEvent.change(input, { target: { value: '12' } })
    fireEvent.blur(input)
    expect(spy).toHaveBeenCalledWith(bpId, expect.objectContaining({ workload: expect.objectContaining({ cpuMsPerRequest: 12 }) }))
  })

  it('firewall reorder swaps array order', () => {
    const spy = vi.spyOn(useWorldStore.getState(), 'updateServer')
    const { serverId } = seed((d, sid) => {
      d.servers[sid].firewall = [
        { id: 'r1', action: 'allow', port: 443, protocol: 'tcp', source: 'any' },
        { id: 'r2', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' },
      ]
    })
    render(<FirewallEditor serverId={serverId} />)
    fireEvent.click(screen.getAllByLabelText('move rule down')[0])
    expect(spy).toHaveBeenCalledWith(serverId, { firewall: [
      expect.objectContaining({ id: 'r2' }), expect.objectContaining({ id: 'r1' }),
    ] })
  })

  it('adding an allow rule above the deny unblocks the compiled path', () => {
    // recompiled-fixture assertion (not DOM): allow :5432 above deny → path permitted
    const { doc, serverId } = seed((d, sid) => {
      const web = createBlueprint('web', 0); web.ports = [{ port: 8080, protocol: 'tcp', visibility: 'public' }]
      const db = createBlueprint('db', 2)
      web.dependencies = [{ id: 'd', target: { kind: 'blueprint', blueprintId: db.id }, port: 5432, protocol: 'db', packetTemplateId: null }]
      d.blueprints[web.id] = web; d.blueprints[db.id] = db
      d.placements['p1'] = createPlacement(web.id, sid); d.placements['p2'] = createPlacement(db.id, sid)
      d.servers[sid].firewall = [{ id: 'deny', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' }]
    })
    expect(compileWorld(doc).paths.some(p => p.verdict === 'blocked')).toBe(true)
    useWorldStore.getState().updateServer(serverId, { firewall: [
      { id: 'allow', action: 'allow', port: 5432, protocol: 'tcp', source: 'any' },
      { id: 'deny', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' },
    ] })
    expect(compileWorld(useWorldStore.getState().doc).paths.some(p => p.verdict === 'blocked')).toBe(false)
  })

  it('invalid numeric input does not fire an update', () => {
    const spy = vi.spyOn(useWorldStore.getState(), 'updateBlueprint')
    const { doc } = seed((d, sid) => { const bp = createBlueprint('api', 1); d.blueprints[bp.id] = bp; d.placements['p'] = createPlacement(bp.id, sid) })
    render(<WorkloadForm blueprintId={Object.keys(doc.blueprints)[0]} />)
    const input = screen.getByLabelText('ramBaseMb')
    fireEvent.change(input, { target: { value: 'abc' } })
    fireEvent.blur(input)
    expect(spy).not.toHaveBeenCalled()
  })

  it('all forms disabled while running', () => {
    useSimulationStore.setState({ running: true })
    const { serverId } = seed(() => {})
    render(<FirewallEditor serverId={serverId} />)
    expect(screen.getByLabelText('add rule')).toBeDisabled()
  })
})
```

(imports: add `WorkloadForm`, `FirewallEditor` from `./inspectorForms`.)

- [ ] **Step 2: Write `inspectorForms.tsx`**

```tsx
// src/app/world/server/inspectorForms.tsx
// Edit forms mounted inside the InspectorRail panels. Every form sits in <fieldset
// disabled={running}> (D9); numeric inputs clamp ≥0 and reject NaN (keep last valid). All writes
// go through existing world.store actions; recompile is automatic via useCompiledWorld.
import { useState, type ReactElement } from 'react'
import { useSimulationStore } from '../../store/simulation.store'
import { useWorldStore } from '../../store/world.store'
import type { WorkloadProfile, FirewallRule, ComposeVolume } from '../../../lib/world/types'

const lockNote = { font: '6.5px var(--font-mono)', color: 'var(--color-text-muted)', marginTop: 4 } as const
const fs = (running: boolean): React.CSSProperties => ({ border: 'none', margin: 0, padding: 0, opacity: running ? 0.55 : 1 })
const inp: React.CSSProperties = { width: 52, background: 'var(--color-node-base)', border: '1px solid #2A3648', borderRadius: 3, color: '#E2E8F0', font: '7px var(--font-mono)', padding: '1px 4px' }

function NumberField({ label, value, onCommit }: { label: string; value: number; onCommit: (n: number) => void }) {
  const [text, setText] = useState(String(value))
  return (
    <label style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
      <span>{label}</span>
      <input aria-label={label} style={inp} value={text}
        onChange={e => setText(e.target.value)}
        onBlur={() => { const n = Number(text); if (Number.isFinite(n) && n >= 0) onCommit(n); else setText(String(value)) }}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
    </label>
  )
}

export function WorkloadForm({ blueprintId }: { blueprintId: string }): ReactElement {
  const running = useSimulationStore(s => s.running)
  const bp = useWorldStore(s => s.doc.blueprints[blueprintId])
  const update = useWorldStore(s => s.updateBlueprint)
  if (!bp) return <></>
  const set = (patch: Partial<WorkloadProfile>) => update(blueprintId, { workload: { ...bp.workload, ...patch } })
  return (
    <fieldset disabled={running} style={fs(running)}>
      <div style={{ font: '6.5px var(--font-mono)', color: '#475569', marginTop: 7, letterSpacing: '0.08em' }}>WORKLOAD</div>
      <NumberField label="cpuMsPerRequest" value={bp.workload.cpuMsPerRequest} onCommit={v => set({ cpuMsPerRequest: v })} />
      <NumberField label="ramBaseMb" value={bp.workload.ramBaseMb} onCommit={v => set({ ramBaseMb: v })} />
      <NumberField label="ramPerConnMb" value={bp.workload.ramPerConnMb} onCommit={v => set({ ramPerConnMb: v })} />
      <NumberField label="diskIoPerRequest" value={bp.workload.diskIoPerRequest} onCommit={v => set({ diskIoPerRequest: v })} />
      <label style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
        <span>color</span>
        <input aria-label="signature color" type="color" value={bp.color} onChange={e => update(blueprintId, { color: e.target.value })} />
      </label>
      {running && <div style={lockNote}>stop simulation to edit</div>}
    </fieldset>
  )
}

export function RuntimeForm({ placementId }: { placementId: string }): ReactElement {
  const running = useSimulationStore(s => s.running)
  const pl = useWorldStore(s => s.doc.placements[placementId])
  const server = useWorldStore(s => (pl ? s.doc.servers[pl.serverId] : undefined))
  const update = useWorldStore(s => s.updatePlacement)
  if (!pl) return <></>
  if (pl.runtime.type !== 'container') {
    return <div style={{ ...lockNote, marginTop: 6 }}>process runtime — limits/ports are container-only. Switch runtime in the Placements panel.</div>
  }
  const rt = pl.runtime
  const setRt = (patch: Partial<typeof rt>) => update(placementId, { runtime: { ...rt, ...patch } })
  const networks = server?.stacks.find(s => s.name === rt.stackName)?.networks ?? []
  return (
    <fieldset disabled={running} style={fs(running)}>
      <div style={{ font: '6.5px var(--font-mono)', color: '#475569', marginTop: 7, letterSpacing: '0.08em' }}>LIMITS</div>
      <NumberField label="cpuLimit" value={rt.cpuLimit ?? 0} onCommit={v => setRt({ cpuLimit: v || null })} />
      <NumberField label="memLimitMb" value={rt.memLimitMb ?? 0} onCommit={v => setRt({ memLimitMb: v || null })} />
      <div style={{ marginTop: 4 }}>networks: {networks.map(n => (
        <label key={n.name} style={{ marginRight: 6 }}>
          <input type="checkbox" checked={rt.networkNames.includes(n.name)}
            onChange={e => setRt({ networkNames: e.target.checked ? [...rt.networkNames, n.name] : rt.networkNames.filter(x => x !== n.name) })} />
          {n.name}
        </label>
      ))}</div>
      {running && <div style={lockNote}>stop simulation to edit</div>}
    </fieldset>
  )
}

export function FirewallEditor({ serverId }: { serverId: string }): ReactElement {
  const running = useSimulationStore(s => s.running)
  const server = useWorldStore(s => s.doc.servers[serverId])
  const update = useWorldStore(s => s.updateServer)
  if (!server) return <></>
  const rules = server.firewall
  const commit = (next: FirewallRule[]) => update(serverId, { firewall: next })
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= rules.length) return
    const next = [...rules]; [next[i], next[j]] = [next[j], next[i]]; commit(next)
  }
  const patch = (i: number, p: Partial<FirewallRule>) => commit(rules.map((r, k) => (k === i ? { ...r, ...p } : r)))
  return (
    <fieldset disabled={running} style={fs(running)}>
      {rules.map((r, i) => (
        <div key={r.id} style={{ display: 'flex', gap: 3, alignItems: 'center', marginTop: 3 }}>
          <select aria-label="action" value={r.action} onChange={e => patch(i, { action: e.target.value as FirewallRule['action'] })}><option value="allow">allow</option><option value="deny">deny</option></select>
          <input aria-label="port" style={{ ...inp, width: 40 }} value={String(r.port)} onChange={e => patch(i, { port: e.target.value === 'any' ? 'any' : (Number(e.target.value) || 'any') })} />
          <select aria-label="protocol" value={r.protocol} onChange={e => patch(i, { protocol: e.target.value as FirewallRule['protocol'] })}><option value="tcp">tcp</option><option value="udp">udp</option><option value="any">any</option></select>
          <button aria-label="move rule up" onClick={() => move(i, -1)}>↑</button>
          <button aria-label="move rule down" onClick={() => move(i, 1)}>↓</button>
          <button aria-label="remove rule" onClick={() => commit(rules.filter((_, k) => k !== i))}>✕</button>
        </div>
      ))}
      <button aria-label="add rule" style={{ marginTop: 4 }} onClick={() => commit([...rules, { id: `fw-${Date.now().toString(36)}`, action: 'allow', port: 'any', protocol: 'tcp', source: 'any' }])}>+ add rule</button>
      {running && <div style={lockNote}>stop simulation to edit</div>}
    </fieldset>
  )
}

export function VolumesEditor({ serverId, stackName }: { serverId: string; stackName: string }): ReactElement {
  const running = useSimulationStore(s => s.running)
  const server = useWorldStore(s => s.doc.servers[serverId])
  const update = useWorldStore(s => s.updateServer)
  if (!server) return <></>
  const stack = server.stacks.find(s => s.name === stackName)
  if (!stack) return <></>
  const commitVols = (volumes: ComposeVolume[]) => update(serverId, { stacks: server.stacks.map(s => (s.name === stackName ? { ...s, volumes } : s)) })
  return (
    <fieldset disabled={running} style={fs(running)}>
      {stack.volumes.map((v, i) => (
        <div key={v.name} style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 3 }}>
          <span>{v.name}</span>
          <NumberField label={`size-${v.name}`} value={v.sizeGb} onCommit={n => commitVols(stack.volumes.map((x, k) => (k === i ? { ...x, sizeGb: n } : x)))} />
          <button aria-label={`remove volume ${v.name}`} onClick={() => commitVols(stack.volumes.filter((_, k) => k !== i))}>✕</button>
        </div>
      ))}
      <button aria-label="add volume" onClick={() => commitVols([...stack.volumes, { name: `vol-${stack.volumes.length + 1}`, sizeGb: 10 }])}>+ add volume</button>
      {running && <div style={lockNote}>stop simulation to edit</div>}
    </fieldset>
  )
}
```

- [ ] **Step 3: Mount forms in `InspectorRail.tsx`**

Under the instance read panel render `<WorkloadForm blueprintId={inst.blueprintId} />` and, when
the placement is a container, `<RuntimeForm placementId={inst.placementId} />`. Under the
firewall/rule panel render `<FirewallEditor serverId={serverId} />`. Under the stack panel render
`<VolumesEditor serverId={serverId} stackName={selection.stackName} />`.

- [ ] **Step 4: Tests + build**

Run: `npx vitest run src/app/world/server/InspectorRail.test.tsx` → PASS.
Run: `npm run build`, `npx vitest run` → green.

- [ ] **Step 5: Live smoke** — with the T3 blocked world: Stop → select the firewall → add an
allow rule above the deny → the red trace flips teal (recompiled). Select the api chip → raise
`memLimitMb`; nav away and back → the value persists. Start the sim → all rail edit controls
disabled. Zero console errors; screenshot `task7-edit-unblock.png`. Stop dev.

- [ ] **Step 6: Commit**

```bash
git add src/app/world/server/inspectorForms.tsx src/app/world/server/InspectorRail.tsx \
        src/app/world/server/InspectorRail.test.tsx
git commit -m "feat(server-view): inspector editing (workload, runtime, firewall, volumes) with sim edit-lock"
```

---

## Task 8: PlacementPanel MANAGED_TYPES ↔ CLOUD_REGISTRY alignment `[haiku]`

**Files:** modify `src/app/world/panels/PlacementPanel.tsx`, `src/lib/costModelV2.ts` (+ its test).

**Grounding (verified):** `PlacementPanel.tsx:6` `const MANAGED_TYPES = ['rds','s3','sqs','redis',
'cdn','apiGateway','lambda']`; the select writes `msType` verbatim into `nodeType` and
`msType.toUpperCase()` into the label (`PlacementPanel.tsx:48-51`). `costModelV2.ts:19-20`
`MANAGED_TYPE_ALIASES = { rds:'dbSql', s3:'objectStorage', sqs:'queue' }`, used by
`managedServiceMonthlyUsd` (`getServiceSpec(MANAGED_TYPE_ALIASES[nodeType] ?? nodeType, provider)`).
So the registry keys for the three human aliases are `dbSql`/`objectStorage`/`queue`; `redis`,
`cdn`, `apiGateway`, `lambda` already ARE registry keys.

- [ ] **Step 1: Change `MANAGED_TYPES` to registry keys with readable labels**

In `PlacementPanel.tsx`, replace line 6 and the select + add handler:

```tsx
// Author managed services with CLOUD_REGISTRY keys directly (D12) so Cost v2 prices them without
// the alias table. Labels stay human-readable.
const MANAGED_TYPES: { key: string; label: string }[] = [
  { key: 'dbSql', label: 'SQL DB' },
  { key: 'objectStorage', label: 'Object store' },
  { key: 'queue', label: 'Queue' },
  { key: 'redis', label: 'Redis' },
  { key: 'cdn', label: 'CDN' },
  { key: 'apiGateway', label: 'API Gateway' },
  { key: 'lambda', label: 'Lambda' },
]
```

Update `useState(MANAGED_TYPES[0])` → `useState(MANAGED_TYPES[0].key)`; the `<select>` options to
`<option key={t.key} value={t.key}>{t.label}</option>`; and the add handler to use the key for
`nodeType` and the label for the display label:
`store.addManagedService(msType, MANAGED_TYPES.find(t => t.key === msType)?.label ?? msType, scope, 5432)`.

- [ ] **Step 2: costModelV2 — keep aliases (legacy load-bearing), update the comment**

Do NOT delete `MANAGED_TYPE_ALIASES` — old `.scalemap` files saved with `rds`/`s3`/`sqs` still
load and must price. Update the comment above it to note new authoring emits registry keys
directly; the aliases now only bridge legacy documents. No behavior change.

- [ ] **Step 3: Tests (`costModelV2.test.ts`)**

Add two cases: (a) a doc authored with the NEW key prices without the alias —
`managedServiceMonthlyUsd('dbSql','aws') > 0` (assert via the public cost function on a fixture
world whose managed service has `nodeType: 'dbSql'`); (b) a LEGACY doc with `nodeType:'rds'`
still prices `> 0`. Run: `npx vitest run src/lib/costModelV2.test.ts` → PASS.

- [ ] **Step 4: Build + commit**

Run: `npm run build`, `npx vitest run` → green.

```bash
git add src/app/world/panels/PlacementPanel.tsx src/lib/costModelV2.ts src/lib/costModelV2.test.ts
git commit -m "refactor(world): author managed services with CLOUD_REGISTRY keys"
```

---

## Task 9: Final integration, full live smoke, boundaries §L `[sonnet]`

**Files:** modify `docs/module-boundaries.md` (add §L); fix any accumulated Minors the controller
queued; run the whole verification battery; append the `## PHASE 3` ledger summary.

- [ ] **Step 1: Add `docs/module-boundaries.md` §L — Server interior (Level 4)**

Document: the `src/app/world/server/` file list (boardLayout + 10 components + hooks/forms);
boundary rules — `server/` imports `lib/` (world types, worldEngine types, boardLayout) and app
stores (`world.store`, `simulation.store`, `nav.store` read; `world.store` actions for writes) but
NOTHING under `panels/`; the engine facade is untouched except T2's server-particle branch +
`__test_render` test hook; `boardLayout.ts` is a pure hub imported by every server component
(low-risk, high fan-in — change its exported shapes deliberately). Note the scale-to-fit /
fixed-1000×560 stage invariant and the "renderer attaches once per (serverId, running)" rule.

- [ ] **Step 2: Full verification battery**

Run: `npx vitest run` → ALL suites green (record the count).
Run: `npm run build` → succeeds (strict tsc + vite).

- [ ] **Step 3: Full end-to-end live smoke (the phase gate — controller-run, port 1420)**

Execute the spec's Testing script end-to-end and capture screenshots at each milestone:
author region→AZ→server with a compose stack + a process placement + a firewall-blocked
dependency (via UI + the DEV `window.__scalemapDebug` hook where the UI can't author public
ports/deps) → the server board renders all zones (NIC, gate, chips, stack plate, hardware
platform) → a static red-dashed blocked trace shows its rule label → Simulate → packets traverse
the traces, the hardware platform is live (cores/ring/steal, RAM strata, disk scanner, NIC bar),
the gate counts blocks → Stop → fix the firewall via the inspector rail → the trace flips
permitted (teal) → hover a chip → cross-highlight dims unrelated elements and glows its
stratum/core/slice → scrub → historical strata render. Assert ZERO app console errors throughout
(benign Vite HMR WS blips excepted). Save screenshots to `.superpowers/sdd/screenshots/`.

- [ ] **Step 4: Ledger + drift**

Append to `.superpowers/sdd/progress.md` under `## PHASE 3`: per-task completion lines, open
items, and contract-drift state (the `__test_render` additive test hook is the only engine-surface
addition; no frozen-type change). If any forced contract change occurred, it is already logged in
`.superpowers/sdd/contract-drift.md` under `## PHASE 3`.

- [ ] **Step 5: Commit**

```bash
git add docs/module-boundaries.md .superpowers/sdd/progress.md
git commit -m "docs: update module boundaries for the server interior (§L)"
```
