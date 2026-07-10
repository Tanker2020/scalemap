# Phase 4: Region Flow Page + Rack Chassis Implementation Plan

**Date:** 2026-07-09 · **Branch:** `phase4-region-rack` (cut from `main` at `999e41d`; Phase 3 merged)
**Binding specs:** `docs/superpowers/specs/2026-07-09-phase4-region-rack-design.md` (the 11 decisions
D1–D11) and the FROZEN `docs/superpowers/specs/2026-07-08-world-engine-contracts.md` (NO amendment
this phase — D2). Approved mockup (visual truth): `docs/superpowers/specs/mockups/views-overview-v2.html`
(Level-2 region page + Level-3 rack chassis panels; the Level-1 globe panel is Phase 5's). Umbrella:
`docs/superpowers/specs/2026-07-08-world-model-multiscale-simulation-design.md` §5 Levels 2–3.

> Assembled by the Phase-4 execution session from the task fragments in
> `docs/superpowers/plans/phase4/fragments/` (`tasks-01-03.md`, `tasks-04-06.md`, `tasks-07-08.md`),
> authored at full fidelity from `phase4/skeleton.md` (no pre-written fragments existed — planning
> shifted fragment-writing to the executor). Signatures/semantics/named-test-cases are the
> skeleton's, expanded not redesigned; `layoutRacks` and `regionData` numbers were arithmetic-
> verified with a scratch Node script before baking into tests. **This phase makes NO engine or
> contract change (D2)** — nothing under `src/lib/worldEngine/` is modified. One binding correction
> to the skeleton is carried throughout: design D5 names `worldEngine/latency.ts` as the source of
> an importable cross-AZ hop constant, but that file exports only `sampleLatencyMs` and the real
> value (`CROSS_AZ_MS = 1.5`) is a private const in `worldEngine/networkRuntime.ts`; since D2 forbids
> editing `worldEngine/` to export it, Task 1 mirrors the value as a local `CROSS_AZ_HOP_MS = 1.5`
> constant. This is a deviation from D5's *plan text*, not an engine/contract change — logged as a
> RESOLVED item in `.superpowers/sdd/contract-drift.md` §PHASE 4 (item 8). No other drift is expected.

## Goal

Replace the Phase-1 placeholder `RegionView` with the Level-2 flow story — global-edge inbound →
animated split lines with per-AZ shares → AZ rows (health ring, clickable server strips,
rps/p50/err/$) → cross-AZ column — with one alert ribbon, a failover timeline, and per-AZ outage
switches. On the Level-3 AZ canvas, flat server cards become realistic rack chassis stacked inside
per-rack frame groups (rails, drive-bay LEDs, vent grills, status LEDs, live cpu/ram/io micro-bars,
blank-U fillers, PDU strip). The AZ particle overlay is reworked to track chassis nested inside
frame nodes without drift and without re-subscribing on pan/zoom. Phase-3 carry-forwards
(managed-service provider selection + server-view hygiene) are absorbed. Zero engine changes.

## Architecture

- **`src/app/world/region/`** — everything the Level-2 page adds. `regionData.ts` is a PURE,
  unit-tested selector hub deriving `azShares` / `ribbonAlert` / `regionEvents` / `replicationPairs`
  / `crossAzEntries` / `sparklineSeries` / `dominantBlueprintColor` from `scrubBatch ?? latestBatch`
  + `events` + `doc`/`compiled` — the page is fully scrub-aware and renders a meaningful static
  state before anything runs. `RegionView.tsx` is a flex composition (no canvas): inbound column →
  animated SVG `SplitLines` (widths from per-AZ rps shares) → `AzRow` stack → `CrossAzColumn`, with
  `AlertRibbon` above and `TimelineStrip` (click-to-scrub) below. The engine's
  `attachRenderer({level:'region'})` payload stays EMPTY (D2) — split-line motion is pure CSS/SVG.
- **`src/lib/world/layoutRacks.ts`** — a PURE, deterministic rack layout (frames side-by-side,
  chassis stacked by `rack.unit`, chassis height = `heightU × U_PX`, blank-U fillers, PDU strip,
  managed column) replacing `layoutAz.ts` for the AZ canvas. **`src/app/world/RackNodes.tsx`** —
  `RackFrameNode` (non-interactive backdrop: rails, caption, fillers, PDU) + `RackChassisNode`
  (LEDs, drive bays, micro-bars from `ServerMetrics`, noisy tag) + the relocated `WorldManagedNode`.
  `AzCanvas.tsx` rewires to `{ worldRackFrame, worldChassis, worldManaged }` node types via
  `layoutRacks` (frames are parent nodes, chassis are `extent:'parent'` children); its
  edge-aggregation block is copied VERBATIM (source/target ids are still serverIds/managedIds).
- **`src/app/world/AzSimOverlay.tsx`** — reworked (D9) to read `getInternalNode(id).internals.
  positionAbsolute` + measured dims (so particles track chassis nested inside frames) and to read
  `getViewport()` imperatively inside the draw callback (so pan/zoom no longer re-subscribes the
  renderer). Attaches once per `(running, azId)`.
- **State seam** — views read `useSimulationStore` (`scrubBatch ?? latestBatch`, `events`,
  `running`, `healthOverrides`) and `useWorldStore` (`doc`); only store actions call the facade
  (`setOutage`, `setScrubIndex`, `attachRenderer`, `getReplayFrames`). World mutations go through
  existing `useWorldStore` actions only — Task 7 adds ONE trailing parameter to ONE action
  (`addManagedService` provider); nothing else in the world store changes.

## Tech stack

Tauri 2 + React 19 + TypeScript, Zustand (one store per domain), `@xyflow/react` v12.11.1 (AZ canvas
only — the region page is plain flex/SVG, no React Flow), `framer-motion` (`useReducedMotion`),
`vitest` + Testing Library. **No new dependencies.**

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

**Files:** create `src/app/world/region/regionData.ts`, `src/app/world/region/regionData.test.ts`.

**Grounding:** Id types and `WorldDoc`/`CompiledWorld` live in `src/lib/world/types.ts` — import
them from there, never from `worldEngine/types`. `src/lib/worldEngine/types.ts` supplies
`MetricsBatch`/`EngineEvent`/`ReplayFrame` (frozen contracts, read-only). `compileWorld(doc)`
(`src/lib/world/compileWorld.ts`) resolves `ServiceInstance { id; blueprintId; placementId;
serverId; azId; regionId; role; indexInPlacement }` (`id = ${placementId}#${index}`, via the
exported `instanceId()`) and `CompiledPath { fromInstanceId; to: {kind:'instance'|'managed',...};
hopClass; verdict; blockReason }`; `hopClassBetween` (`src/lib/world/network.ts`) derives
`'cross-az'` purely from two different AZs sharing one region — hopClass is independent of
verdict (permitted/blocked). Test fixtures use the real `createWorld/createRegion/createAz/
createServer/createBlueprint/createPlacement` factories + `getPreset` + the REAL `compileWorld`
(same pattern as `compileWorld.test.ts`'s `tinyWorld()`), not hand-authored `CompiledWorld`
objects — this exercises the real hopClass/instance-id resolution instead of asserting against
invented fixtures. Pure test — node env, no `@vitest-environment` pragma.

- [ ] **Step 1: Write the failing test `regionData.test.ts`**

```ts
// src/app/world/region/regionData.test.ts
import { describe, it, expect } from 'vitest'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
} from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'
import { compileWorld } from '../../../lib/world/compileWorld'
import {
  azShares, ribbonAlert, regionEvents, replicationPairs, crossAzEntries, sparklineSeries, dominantBlueprintColor,
} from './regionData'
import type { MetricsBatch, EngineEvent, AzMetrics, RegionMetrics, ReplayFrame } from '../../../lib/worldEngine/types'

function emptyWorldMetrics(): MetricsBatch['world'] {
  return { totalRps: 0, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 }
}
function fakeBatch(
  simMs: number, azs: Record<string, AzMetrics> = {}, regions: Record<string, RegionMetrics> = {}, world = emptyWorldMetrics(),
): MetricsBatch {
  return { simMs, instances: {}, servers: {}, azs, regions, world }
}
function az(over: Partial<AzMetrics>): AzMetrics {
  return { azId: '', rps: 0, errorRate: 0, p50Ms: 0, healthScore: 100, health: 'healthy', serverCount: 0, instanceCount: 0, ...over }
}
function evt(over: Partial<EngineEvent>): EngineEvent {
  return { id: 'e', simMs: 0, kind: 'engine_degraded', severity: 'info', message: '', affected: [], ...over }
}

// Two-region fixture shared by the region-scoping tests (ribbonAlert, regionEvents, replicationPairs).
function tworegionWorld() {
  const doc = createWorld()
  const regionA = createRegion('us-east-1')
  const regionB = createRegion('eu-west-1')
  const azA = createAz(regionA.id, 'us-east-1a')
  const azB = createAz(regionA.id, 'us-east-1b')
  const azX = createAz(regionB.id, 'eu-west-1a')
  const serverA = createServer(azA.id, getPreset('vps-medium')!)
  const serverB = createServer(azB.id, getPreset('vps-medium')!)
  const serverX = createServer(azX.id, getPreset('vps-medium')!)
  doc.regions[regionA.id] = regionA; doc.regions[regionB.id] = regionB
  doc.azs[azA.id] = azA; doc.azs[azB.id] = azB; doc.azs[azX.id] = azX
  doc.servers[serverA.id] = serverA; doc.servers[serverB.id] = serverB; doc.servers[serverX.id] = serverX
  return { doc, regionA, regionB, azA, azB, azX, serverA, serverB, serverX }
}

describe('azShares', () => {
  it('splits by rps and pins down AZs to zero', () => {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    const azA = createAz(region.id, 'us-east-1a')
    const azB = createAz(region.id, 'us-east-1b')
    const azC = createAz(region.id, 'us-east-1c')
    doc.regions[region.id] = region
    doc.azs[azA.id] = azA; doc.azs[azB.id] = azB; doc.azs[azC.id] = azC
    const batch = fakeBatch(1000, {
      [azA.id]: az({ azId: azA.id, rps: 600, health: 'healthy' }),
      [azB.id]: az({ azId: azB.id, rps: 400, health: 'healthy' }),
      [azC.id]: az({ azId: azC.id, rps: 250, health: 'down' }),   // stale rps while down — must still pin to 0
    })
    const shares = azShares(region.id, doc, batch)
    expect(shares).toHaveLength(3)
    const a = shares.find(s => s.azId === azA.id)!
    const b = shares.find(s => s.azId === azB.id)!
    const c = shares.find(s => s.azId === azC.id)!
    expect(a.fraction).toBeCloseTo(0.6, 5)
    expect(b.fraction).toBeCloseTo(0.4, 5)
    expect(c.down).toBe(true)
    expect(c.fraction).toBe(0)
    expect(c.rps).toBe(0)
  })

  it('handles null batch', () => {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    const azA = createAz(region.id, 'us-east-1a')
    doc.regions[region.id] = region
    doc.azs[azA.id] = azA
    const shares = azShares(region.id, doc, null)
    expect(shares).toEqual([{ azId: azA.id, fraction: 0, rps: 0, down: false }])
  })
})

describe('ribbonAlert', () => {
  it('picks critical over newer warning', () => {
    const { doc, regionA, azA } = tworegionWorld()
    const events: EngineEvent[] = [
      evt({ id: 'w1', kind: 'health_check_failed', severity: 'warning', simMs: 9500, affected: [azA.id], message: 'az flaky' }),
      evt({ id: 'c1', kind: 'outage_triggered', severity: 'critical', simMs: 8000, affected: [azA.id], message: `${azA.label} unhealthy` }),
    ]
    const alert = ribbonAlert(regionA.id, doc, events, 10_000)
    expect(alert).not.toBeNull()
    expect(alert!.severity).toBe('critical')
    expect(alert!.simMs).toBe(8000)
  })

  it('appends redistribution targets for an az outage', () => {
    const { doc, regionA, azA, azB } = tworegionWorld()
    const events: EngineEvent[] = [
      evt({ id: 'c1', kind: 'outage_triggered', severity: 'critical', simMs: 8000, affected: [azB.id], message: `${azB.label} unhealthy` }),
    ]
    const alert = ribbonAlert(regionA.id, doc, events, 10_000)
    expect(alert).not.toBeNull()
    expect(alert!.message).toContain(azA.label)
    expect(alert!.message).toContain('redistributed to')
  })

  it('null when only info events', () => {
    const { doc, regionA, azA } = tworegionWorld()
    const events: EngineEvent[] = [
      evt({ id: 'i1', kind: 'instance_restarted', severity: 'info', simMs: 9000, affected: [azA.id] }),
    ]
    expect(ribbonAlert(regionA.id, doc, events, 10_000)).toBeNull()
  })

  it('appends the DNS-TTL note for an unresolved failover (additional coverage beyond the named minimum)', () => {
    const { doc, regionA, azA } = tworegionWorld()
    const events: EngineEvent[] = [
      evt({ id: 'w1', kind: 'health_check_failed', severity: 'warning', simMs: 8000, affected: [azA.id], message: 'unhealthy' }),
      evt({ id: 'f1', kind: 'failover_started', severity: 'warning', simMs: 8100, affected: [regionA.id], message: 'failing over' }),
    ]
    const alert = ribbonAlert(regionA.id, doc, events, 10_000)
    expect(alert!.message).toContain('DNS TTL')
  })
})

describe('regionEvents', () => {
  it('matches az, server, instance, and routed-population ids and excludes other regions', () => {
    const { doc, regionA, azA, serverA, azX, serverX } = tworegionWorld()
    const bp = createBlueprint('web', 0)
    doc.blueprints[bp.id] = bp
    const pl = createPlacement(bp.id, serverA.id)
    doc.placements[pl.id] = pl
    const compiled = compileWorld(doc)
    const instId = Object.keys(compiled.instances)[0]

    const events: EngineEvent[] = [
      evt({ id: 'byRegion', affected: [regionA.id] }),
      evt({ id: 'byAz', affected: [azA.id] }),
      evt({ id: 'byServer', affected: [serverA.id] }),
      evt({ id: 'byInstance', affected: [instId] }),
      evt({ id: 'byPopulation', affected: ['pop-1'] }),
      evt({ id: 'otherRegionAz', affected: [azX.id] }),
      evt({ id: 'otherRegionServer', affected: [serverX.id] }),
    ]
    const batch = fakeBatch(1000, {}, {}, {
      ...emptyWorldMetrics(), populationRoutes: [{ populationId: 'pop-1', regionId: regionA.id, rps: 10 }],
    })
    const matched = regionEvents(regionA.id, doc, compiled, events, batch).map(e => e.id)
    expect(matched).toEqual(expect.arrayContaining(['byRegion', 'byAz', 'byServer', 'byInstance', 'byPopulation']))
    expect(matched).not.toContain('otherRegionAz')
    expect(matched).not.toContain('otherRegionServer')
    expect(matched).toHaveLength(5)
  })
})

describe('replicationPairs', () => {
  it('pairs primary and replica across azs and flags down links', () => {
    const { doc, regionA, azA, azB, serverA, serverB } = tworegionWorld()
    const db = createBlueprint('db', 2)
    db.stateful = true
    db.volumeName = 'data'
    doc.blueprints[db.id] = db
    const primary = createPlacement(db.id, serverB.id)   // primary in azB
    const replica = createPlacement(db.id, serverA.id)
    replica.role = 'replica'                              // replica in azA
    doc.placements[primary.id] = primary
    doc.placements[replica.id] = replica
    const compiled = compileWorld(doc)

    const batchHealthy = fakeBatch(1000, {
      [azA.id]: az({ azId: azA.id, health: 'healthy' }),
      [azB.id]: az({ azId: azB.id, health: 'healthy' }),
    })
    const pairs = replicationPairs(regionA.id, doc, compiled, batchHealthy)
    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toMatchObject({ blueprintId: db.id, blueprintName: 'db', fromAzId: azB.id, toAzId: azA.id, linkDown: false })

    const batchDown = fakeBatch(1000, {
      [azA.id]: az({ azId: azA.id, health: 'down' }),
      [azB.id]: az({ azId: azB.id, health: 'healthy' }),
    })
    expect(replicationPairs(regionA.id, doc, compiled, batchDown)[0].linkDown).toBe(true)
  })
})

describe('crossAzEntries', () => {
  it('derives pairs from cross-az paths and replication, deduped', () => {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    const azA = createAz(region.id, 'us-east-1a')
    const azB = createAz(region.id, 'us-east-1b')
    const azC = createAz(region.id, 'us-east-1c')
    doc.regions[region.id] = region
    doc.azs[azA.id] = azA; doc.azs[azB.id] = azB; doc.azs[azC.id] = azC
    const serverA = createServer(azA.id, getPreset('vps-medium')!)
    const serverB = createServer(azB.id, getPreset('vps-medium')!)
    const serverC = createServer(azC.id, getPreset('vps-medium')!)
    doc.servers[serverA.id] = serverA; doc.servers[serverB.id] = serverB; doc.servers[serverC.id] = serverC

    const web = createBlueprint('web', 0)
    const db = createBlueprint('db', 2)
    const cache = createBlueprint('cache', 3)
    db.stateful = true
    db.volumeName = 'data'
    web.dependencies = [
      { id: 'dep-db', target: { kind: 'blueprint', blueprintId: db.id }, port: 8080, protocol: 'http', packetTemplateId: null },
      { id: 'dep-cache', target: { kind: 'blueprint', blueprintId: cache.id }, port: 8080, protocol: 'http', packetTemplateId: null },
    ]
    doc.blueprints[web.id] = web; doc.blueprints[db.id] = db; doc.blueprints[cache.id] = cache

    const webPl = createPlacement(web.id, serverA.id)          // web primary @ azA
    const dbPrimary = createPlacement(db.id, serverB.id)       // db primary @ azB
    const dbReplicaOnA = createPlacement(db.id, serverA.id)
    dbReplicaOnA.role = 'replica'                               // db replica @ azA (same server as web)
    const cachePl = createPlacement(cache.id, serverC.id)       // cache primary @ azC
    doc.placements[webPl.id] = webPl
    doc.placements[dbPrimary.id] = dbPrimary
    doc.placements[dbReplicaOnA.id] = dbReplicaOnA
    doc.placements[cachePl.id] = cachePl

    const compiled = compileWorld(doc)
    // Sanity: web(azA) -> db-primary(azB) and web(azA) -> cache(azC) really compile to cross-az
    // paths (proves the fixture exercises the path-derived half of crossAzEntries, not just the
    // replication half).
    expect(compiled.paths.some(p => p.hopClass === 'cross-az')).toBe(true)

    const entries = crossAzEntries(region.id, doc, compiled, null)
    const key = (a: string, b: string) => [a, b].sort().join('::')
    const byPair = new Map(entries.map(e => [key(e.a, e.b), e]))

    // {A,B}: contributed by BOTH the compiled cross-az path (web->db-primary) AND the
    // replication pair (db primary@B / replica@A) — must collapse to exactly one entry.
    expect(byPair.has(key(azA.id, azB.id))).toBe(true)
    expect(byPair.get(key(azA.id, azB.id))!.replication).toHaveLength(1)
    // {A,C}: cross-az path only (web -> cache), no replication.
    expect(byPair.has(key(azA.id, azC.id))).toBe(true)
    expect(byPair.get(key(azA.id, azC.id))!.replication).toHaveLength(0)
    expect(entries).toHaveLength(2)
    expect(byPair.get(key(azA.id, azB.id))!.latencyMs).toBe(1.5)
  })
})

describe('sparklineSeries', () => {
  it('pads and orders oldest-first', () => {
    const regionId = 'r1'
    const frames: ReplayFrame[] = [1000, 2000, 3000].map((simMs, i) => ({
      simMs, events: [],
      batch: fakeBatch(simMs, {}, { [regionId]: { regionId, rps: (i + 1) * 10, errorRate: 0, p50Ms: 0, healthScore: 100, health: 'healthy', inboundByPopulation: [] } }),
    }))
    const series = sparklineSeries(frames, regionId, 5)
    expect(series).toEqual([0, 0, 10, 20, 30])
  })
})

describe('dominantBlueprintColor', () => {
  it('picks the most-placed blueprint', () => {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    const azA = createAz(region.id, 'us-east-1a')
    const server = createServer(azA.id, getPreset('vps-medium')!)
    doc.regions[region.id] = region; doc.azs[azA.id] = azA; doc.servers[server.id] = server
    const minor = createBlueprint('cache', 0)
    const major = createBlueprint('web', 1)
    doc.blueprints[minor.id] = minor; doc.blueprints[major.id] = major
    const plMinor = createPlacement(minor.id, server.id)
    plMinor.count = 1
    const plMajor = createPlacement(major.id, server.id)
    plMajor.count = 3
    doc.placements[plMinor.id] = plMinor; doc.placements[plMajor.id] = plMajor

    const compiled = compileWorld(doc)
    expect(dominantBlueprintColor(server.id, doc, compiled)).toBe(major.color)
  })
})
```

- [ ] **Step 2: Arithmetic check (scratch verification — not part of the test suite)**

Ran this Node script (in the scratchpad) to confirm the `azShares` fractions and the
`crossAzEntries` dedup count used in Step 1's fixtures are real numbers, not guesses:

```js
// azShares: total up-rps = 600+400 = 1000; fraction A = 600/1000, B = 400/1000, C pinned to 0.
const azs = [{ id: 'A', rps: 600, down: false }, { id: 'B', rps: 400, down: false }, { id: 'C', rps: 250, down: true }]
const total = azs.reduce((sum, a) => sum + (a.down ? 0 : a.rps), 0)
const shares = azs.map(a => ({ id: a.id, rps: a.down ? 0 : a.rps, fraction: a.down || total <= 0 ? 0 : a.rps / total }))
console.log('total up-rps:', total)
console.log(shares)

// crossAzEntries dedup: raw (path, path, replication) contributions collapse to 2 unique pairs.
const rawPairs = [['A', 'B'], ['A', 'C'], ['B', 'A']]
const key = ([x, y]) => (x < y ? `${x}::${y}` : `${y}::${x}`)
const uniq = new Map()
for (const p of rawPairs) { const k = key(p); uniq.set(k, (uniq.get(k) ?? []).concat([p])) }
console.log('unique pair count:', uniq.size)
for (const [k, hits] of uniq) console.log(' ', k, '<-', hits.length, 'raw contribution(s)')
```

Output:

```
total up-rps: 1000
[
  { id: 'A', rps: 600, fraction: 0.6 },
  { id: 'B', rps: 400, fraction: 0.4 },
  { id: 'C', rps: 0, fraction: 0 }
]
unique pair count: 2
  A::B <- 2 raw contribution(s)
  A::C <- 1 raw contribution(s)
```

Confirms: `fraction A === 0.6`, `fraction B === 0.4` (asserted with `toBeCloseTo`), and the
`crossAzEntries` fixture's A::B pair really is hit twice (path + replication) yet must collapse
to one entry while A::C stays separate — exactly what Step 1's test asserts.

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/app/world/region/regionData.test.ts`
Expected: FAIL — `Cannot find module './regionData'`.

- [ ] **Step 4: Write `regionData.ts`**

```ts
// src/app/world/region/regionData.ts
// Pure region-page selectors (Phase 4 D3): everything the Level-2 flow page renders is derived
// here from doc/compiled/batch/events — no store access, no JSX, no randomness. Mirrors the
// server board's boardLayout.ts precedent (Phase 3 §L): one pure data module per composed view.
import type { WorldDoc, CompiledWorld, RegionId, AzId, ServerId, BlueprintId } from '../../../lib/world/types'
import type { MetricsBatch, EngineEvent, ReplayFrame } from '../../../lib/worldEngine/types'

export interface AzShare { azId: AzId; fraction: number; rps: number; down: boolean }

// Ordered by doc iteration order. fraction of the region's total az rps (0 when total 0);
// down = batch az health === 'down' (or healthOverride-style absence tolerated: null batch
// → fraction 0, down false). A down AZ's `rps`/`fraction` are BOTH pinned to 0 regardless of
// what the batch reports for it (mockup line 244 shows "0 rps" on a down row, not a stale
// number) — the denominator used for the other AZs' fractions excludes the down AZ's rps too,
// so the remaining shares still sum to 1 (the "redistribution" the ribbon/split-lines depict).
export function azShares(regionId: RegionId, doc: WorldDoc, batch: MetricsBatch | null): AzShare[] {
  const azIds = Object.values(doc.azs).filter(a => a.regionId === regionId).map(a => a.id)
  const raw = azIds.map(azId => {
    const m = batch?.azs[azId] ?? null
    return { azId, rawRps: m?.rps ?? 0, down: m?.health === 'down' }
  })
  const total = raw.reduce((sum, a) => sum + (a.down ? 0 : a.rawRps), 0)
  return raw.map(a => ({
    azId: a.azId,
    down: a.down,
    rps: a.down ? 0 : a.rawRps,
    fraction: a.down || total <= 0 ? 0 : a.rawRps / total,
  }))
}

export interface RibbonAlert { severity: 'warning' | 'critical'; message: string; simMs: number }

const RIBBON_WINDOW_MS = 30_000
const SEVERITY_RANK: Record<EngineEvent['severity'], number> = { info: 0, warning: 1, critical: 2 }

// ribbonAlert's own scope test — NOT the exported regionEvents() (that function additionally
// needs `compiled`/`batch` for instance- and population-routing membership, which this
// function's fixed signature doesn't receive). Region/az/server ids cover every event kind the
// ribbon actually surfaces (outage/health/failover all stamp az or region ids into `affected`
// per the frozen contracts) — see the fragment's judgment-call note.
function inRegionScope(regionId: RegionId, doc: WorldDoc, affected: string[]): boolean {
  if (affected.includes(regionId)) return true
  for (const az of Object.values(doc.azs)) {
    if (az.regionId === regionId && affected.includes(az.id)) return true
  }
  for (const server of Object.values(doc.servers)) {
    if (doc.azs[server.azId]?.regionId === regionId && affected.includes(server.id)) return true
  }
  return false
}

// Most severe (critical > warning), then most recent, event affecting this region within the
// last 30 sim-seconds. Message formatting: an az-scoped outage/health event gets
// "— traffic redistributed to <healthy AZ labels>" appended (full AZ labels — this is a pure
// data function, not a display layer, so it doesn't invent the mockup's "1a/1b" abbreviation);
// an unresolved failover (a region-scoped failover_started with no later matching
// failover_completed, anywhere in `events`, not just the 30s window) gets
// "· clients still arriving (DNS TTL)" appended. Info events never ribbon.
export function ribbonAlert(regionId: RegionId, doc: WorldDoc, events: EngineEvent[], nowSimMs: number): RibbonAlert | null {
  const azEntries = Object.values(doc.azs).filter(a => a.regionId === regionId).map(a => [a.id, a.label] as const)
  const azLabelById = new Map(azEntries)

  const candidates = events.filter(e =>
    (e.severity === 'warning' || e.severity === 'critical') &&
    e.simMs > nowSimMs - RIBBON_WINDOW_MS && e.simMs <= nowSimMs &&
    inRegionScope(regionId, doc, e.affected))
  if (candidates.length === 0) return null

  candidates.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
    return bySeverity !== 0 ? bySeverity : b.simMs - a.simMs
  })
  const top = candidates[0]
  const severity: 'warning' | 'critical' = top.severity === 'critical' ? 'critical' : 'warning'
  let message = top.message

  if (top.kind === 'outage_triggered' || top.kind === 'health_check_failed') {
    const downAzIds = top.affected.filter(id => azLabelById.has(id))
    if (downAzIds.length > 0) {
      const healthyLabels = azEntries.filter(([id]) => !downAzIds.includes(id)).map(([, label]) => label)
      if (healthyLabels.length > 0) message += ` — traffic redistributed to ${healthyLabels.join('/')}`
    }
  }

  const pendingTtl = events.some(e =>
    e.kind === 'failover_started' && inRegionScope(regionId, doc, e.affected) &&
    !events.some(c => c.kind === 'failover_completed' && c.simMs > e.simMs && inRegionScope(regionId, doc, c.affected)))
  if (pendingTtl) message += ' · clients still arriving (DNS TTL)'

  return { severity, message, simMs: top.simMs }
}

// Events whose affected ids intersect: the regionId, its AZ ids, its server ids, its resident
// instance ids, or population ids currently routed to this region per batch.world.populationRoutes.
// Instance membership is read straight off `compiled.instances[...].regionId` (already resolved
// by compileWorld) rather than re-deriving it by string-prefixing an instance id against
// placement ids — same information the skeleton's "prefix match `<placementId>#`" phrasing
// describes, sourced from the compiled graph instead of re-parsing id strings.
export function regionEvents(
  regionId: RegionId, doc: WorldDoc, compiled: CompiledWorld, events: EngineEvent[], batch: MetricsBatch | null,
): EngineEvent[] {
  const azIds = new Set(Object.values(doc.azs).filter(a => a.regionId === regionId).map(a => a.id))
  const serverIds = new Set(Object.values(doc.servers).filter(s => azIds.has(s.azId)).map(s => s.id))
  const instanceIds = new Set(Object.values(compiled.instances).filter(i => i.regionId === regionId).map(i => i.id))
  const routedPopulationIds = new Set(
    (batch?.world.populationRoutes ?? []).filter(r => r.regionId === regionId).map(r => r.populationId))

  const isRelevant = (id: string): boolean =>
    id === regionId || azIds.has(id) || serverIds.has(id) || instanceIds.has(id) || routedPopulationIds.has(id)

  return events.filter(e => e.affected.some(isRelevant))
}

export interface ReplicationPair { blueprintId: BlueprintId; blueprintName: string; fromAzId: AzId; toAzId: AzId; linkDown: boolean }

// Stateful blueprints with a primary-role instance in one of this region's AZs and a
// replica-role instance in a DIFFERENT AZ of the same region. linkDown = either AZ down.
// Deduped by (blueprint, fromAz, toAz) — count>1 placements would otherwise repeat a pair.
export function replicationPairs(
  regionId: RegionId, doc: WorldDoc, compiled: CompiledWorld, batch: MetricsBatch | null,
): ReplicationPair[] {
  const regionInstances = Object.values(compiled.instances).filter(i => i.regionId === regionId)
  const pairs: ReplicationPair[] = []
  const seen = new Set<string>()

  for (const bp of Object.values(doc.blueprints)) {
    if (!bp.stateful) continue
    const primaries = regionInstances.filter(i => i.blueprintId === bp.id && i.role === 'primary')
    const replicas = regionInstances.filter(i => i.blueprintId === bp.id && i.role === 'replica')
    for (const p of primaries) {
      for (const r of replicas) {
        if (r.azId === p.azId) continue
        const key = `${bp.id}:${p.azId}:${r.azId}`
        if (seen.has(key)) continue
        seen.add(key)
        const linkDown = batch?.azs[p.azId]?.health === 'down' || batch?.azs[r.azId]?.health === 'down'
        pairs.push({ blueprintId: bp.id, blueprintName: bp.name, fromAzId: p.azId, toAzId: r.azId, linkDown })
      }
    }
  }
  return pairs
}

export interface CrossAzEntry { a: AzId; b: AzId; latencyMs: number; linkDown: boolean; replication: ReplicationPair[] }

// R1 — mirrors CROSS_AZ_MS (private) in src/lib/worldEngine/networkRuntime.ts. D2 forbids
// editing worldEngine/ to export it, and latency.ts (D5's named source) has no such constant.
// Value is a stable engine design constant; kept in sync manually. See contract-drift.md §PHASE 4.
const CROSS_AZ_HOP_MS = 1.5

// One entry per unordered AZ pair (a < b by label) connected by ≥1 cross-az compiled path
// between this region's instances OR ≥1 replication pair. Verdict is NOT filtered on
// 'permitted' — a blocked cross-az dependency still represents the topology WANTING to talk
// cross-AZ, which is the pairing this column depicts.
export function crossAzEntries(
  regionId: RegionId, doc: WorldDoc, compiled: CompiledWorld, batch: MetricsBatch | null,
): CrossAzEntry[] {
  const regionAzIds = new Set(Object.values(doc.azs).filter(a => a.regionId === regionId).map(a => a.id))
  const pairs = new Map<string, { a: AzId; b: AzId }>()

  const addPair = (x: AzId, y: AzId) => {
    if (x === y || !regionAzIds.has(x) || !regionAzIds.has(y)) return
    const [a, b] = doc.azs[x].label <= doc.azs[y].label ? [x, y] : [y, x]
    pairs.set(`${a}::${b}`, { a, b })
  }

  for (const path of compiled.paths) {
    if (path.hopClass !== 'cross-az') continue
    const from = compiled.instances[path.fromInstanceId]
    if (!from || from.regionId !== regionId) continue
    if (path.to.kind === 'instance') {
      const to = compiled.instances[path.to.instanceId]
      if (to) addPair(from.azId, to.azId)
    } else {
      const ms = doc.managedServices[path.to.managedServiceId]
      if (ms?.scope.kind === 'az') addPair(from.azId, ms.scope.azId)
    }
  }

  const replication = replicationPairs(regionId, doc, compiled, batch)
  for (const r of replication) addPair(r.fromAzId, r.toAzId)

  return [...pairs.values()]
    .sort((x, y) => (doc.azs[x.a].label + doc.azs[x.b].label).localeCompare(doc.azs[y.a].label + doc.azs[y.b].label))
    .map(({ a, b }) => ({
      a, b,
      latencyMs: CROSS_AZ_HOP_MS,
      linkDown: batch?.azs[a]?.health === 'down' || batch?.azs[b]?.health === 'down',
      replication: replication.filter(r => (r.fromAzId === a && r.toAzId === b) || (r.fromAzId === b && r.toAzId === a)),
    }))
}

// Last n frames' regions[regionId].rps (missing frames/regions → 0), oldest first. `frames` is
// assumed already chronological (getReplayFrames()'s ring-buffer read order, same assumption
// ScrubberV2 makes). Always returns exactly `n` entries, zero-padded at the front when fewer
// than n frames exist yet.
export function sparklineSeries(frames: ReplayFrame[], regionId: RegionId, n = 60): number[] {
  const tail = frames.slice(Math.max(0, frames.length - n)).map(f => f.batch.regions[regionId]?.rps ?? 0)
  return tail.length >= n ? tail : [...new Array(n - tail.length).fill(0), ...tail]
}

// Signature color of the blueprint with the highest instance count on this server (ties →
// first by compiled iteration order); fallback 'var(--color-text-muted)'.
export function dominantBlueprintColor(serverId: ServerId, doc: WorldDoc, compiled: CompiledWorld): string {
  const counts = new Map<BlueprintId, number>()
  for (const inst of Object.values(compiled.instances)) {
    if (inst.serverId !== serverId) continue
    counts.set(inst.blueprintId, (counts.get(inst.blueprintId) ?? 0) + 1)
  }
  let bestId: BlueprintId | null = null
  let bestCount = 0
  for (const [id, count] of counts) {
    if (count > bestCount) { bestCount = count; bestId = id }
  }
  return (bestId && doc.blueprints[bestId]?.color) || 'var(--color-text-muted)'
}
```

- [ ] **Step 5: Run tests + build**

Run: `npx vitest run src/app/world/region/regionData.test.ts` → PASS (11 tests).
Run: `npm run build` → succeeds (tsc clean under `strict`/`noUnusedLocals`/`noUnusedParameters`, vite build completes).
Run: `npx vitest run` → all suites green.

- [ ] **Step 6: Commit**

```bash
git add src/app/world/region/regionData.ts src/app/world/region/regionData.test.ts
git commit -m "feat(region): add pure region-data selectors"
```

---

## Task 2: Region flow page `[sonnet]`

**Files:** create `AlertRibbon.tsx`, `SplitLines.tsx`, `AzRow.tsx`, `CrossAzColumn.tsx`,
`RegionView.test.tsx` under `src/app/world/region/`; REWRITE `src/app/world/RegionView.tsx`.

**Grounding:** `region/` files import lib via `../../../lib/...`, stores via `../../store/...`,
and `useCompiledWorld` via `../useCompiledWorld` (it lives directly in `src/app/world/`, one
level up from `region/`) — `RegionView.tsx` itself (NOT in the `region/` subfolder) uses one
level shallower: `../store/...`, `../../lib/...`, `./useCompiledWorld`, `./region/Component`.
Store surfaces (verified verbatim against source): `useWorldStore` → `doc`; `useNavStore` →
`{level, regionId, azId, serverId, goRegion, goAz(regionId,azId), goServer(regionId,azId,
serverId), up, goGlobe}`; `useSimulationStore` → `{running, latestBatch, scrubBatch, events,
healthOverrides, setOutage(scope,id,down), getReplayFrames()}` — metric-driven UI reads
`scrubBatch ?? latestBatch` (D1). `computeWorldCost(doc, world)` (`src/lib/costModelV2.ts`)
returns `{monthlyUsd, byRegion, byAz, egress}` — R4's per-AZ read is `byAz.find(e => e.azId ===
azId)?.monthlyUsd ?? 0`. `WORLD_REGIONS` (`src/lib/regionConfig.ts`) maps a region's
`catalogId` to its human label (e.g. `'us-east-1'` → `'US East (N. Virginia)'`) — used for the
header's `<label>`. `AzMetrics.healthScore` is 0..100; ring geometry mirrors the mockup's `r=14`
circle (circumference ≈ 88, verified the mockup's own `dashoffset` values — 8/12/80 for scores
91/87/9 — match `circumference × (1 − score/100)` to within rounding). The EXISTING region
outage button (`RegionView.tsx` today) is preserved verbatim: `isDown = useSimulationStore(s =>
s.healthOverrides[regionId ?? ''] ?? false)`, `setOutage('region', regionId, !isDown)`, labels
`"⚡ Simulate region outage"` / `"✓ Clear region outage"`, `running`-gated.

- [ ] **Step 1: Write the failing test `RegionView.test.tsx`**

This is the ONLY jsdom test file for Task 2 — `AlertRibbon`/`SplitLines`/`AzRow`/
`CrossAzColumn` have no test files of their own (per the skeleton's File Structure); it renders
the real composed `<RegionView/>` against seeded store state.

```tsx
// src/app/world/region/RegionView.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RegionView } from '../RegionView'
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import { useSimulationStore } from '../../store/simulation.store'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
} from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'
import type { WorldDoc } from '../../../lib/world/types'
import type { MetricsBatch, EngineEvent, AzMetrics } from '../../../lib/worldEngine/types'

function emptyWorldMetrics(): MetricsBatch['world'] {
  return { totalRps: 0, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 }
}
function fakeBatch(simMs: number, azs: Record<string, AzMetrics>): MetricsBatch {
  return { simMs, instances: {}, servers: {}, azs, regions: {}, world: emptyWorldMetrics() }
}
function az(over: Partial<AzMetrics>): AzMetrics {
  return { azId: '', rps: 0, errorRate: 0, p50Ms: 0, healthScore: 100, health: 'healthy', serverCount: 0, instanceCount: 0, ...over }
}

function seedRegion() {
  const doc: WorldDoc = createWorld()
  const region = createRegion('us-east-1')
  const azA = createAz(region.id, 'us-east-1a')
  const azB = createAz(region.id, 'us-east-1b')
  const serverA = createServer(azA.id, getPreset('vps-medium')!)
  const serverB = createServer(azB.id, getPreset('vps-medium')!)
  serverA.label = 'web-01'
  serverB.label = 'web-02'
  doc.regions[region.id] = region
  doc.azs[azA.id] = azA; doc.azs[azB.id] = azB
  doc.servers[serverA.id] = serverA; doc.servers[serverB.id] = serverB
  const bp = createBlueprint('web', 0)
  doc.blueprints[bp.id] = bp
  doc.placements['p1'] = createPlacement(bp.id, serverA.id)
  doc.placements['p2'] = createPlacement(bp.id, serverB.id)
  useWorldStore.setState({ doc, history: [], future: [] })
  useNavStore.setState({ level: 'region', regionId: region.id, azId: null, serverId: null })
  return { doc, region, azA, azB, serverA, serverB }
}

// Captured once, pristine — restored by resetSim() every test so a spy installed by one test
// (e.g. the outage-switch test overriding setOutage) never leaks into the next.
const realSetOutage = useSimulationStore.getState().setOutage

function resetSim() {
  useSimulationStore.setState({
    running: false, timeScale: 1, latestBatch: null, events: [], healthOverrides: {},
    scrubIndex: null, scrubBatch: null, degraded: false, setOutage: realSetOutage,
  })
}

describe('RegionView (Phase 4 flow page)', () => {
  beforeEach(() => {
    useWorldStore.getState().newWorld()
    resetSim()
  })

  it('renders one AzRow per az with ring score', () => {
    const { azA, azB } = seedRegion()
    useSimulationStore.setState({
      latestBatch: fakeBatch(1000, {
        [azA.id]: az({ azId: azA.id, healthScore: 91, health: 'healthy' }),
        [azB.id]: az({ azId: azB.id, healthScore: 87, health: 'healthy' }),
      }),
    })
    render(<RegionView />)
    expect(screen.getByText('us-east-1a')).toBeInTheDocument()
    expect(screen.getByText('us-east-1b')).toBeInTheDocument()
    expect(screen.getByText('91')).toBeInTheDocument()
    expect(screen.getByText('87')).toBeInTheDocument()
  })

  it('down az row shows drain targets instead of strips', () => {
    const { azA, azB } = seedRegion()
    useSimulationStore.setState({
      latestBatch: fakeBatch(1000, {
        [azA.id]: az({ azId: azA.id, healthScore: 91, health: 'healthy' }),
        [azB.id]: az({ azId: azB.id, healthScore: 9, health: 'down' }),
      }),
    })
    render(<RegionView />)
    expect(screen.getByText(/draining/)).toBeInTheDocument()
    expect(screen.getByTitle('web-01')).toBeInTheDocument()          // healthy row still shows its strip
    expect(screen.queryByTitle('web-02')).not.toBeInTheDocument()    // down row swapped strip for drain line
  })

  it("az outage switch dispatches setOutage('az')", () => {
    const { azA } = seedRegion()
    const setOutageSpy = vi.fn()
    useSimulationStore.setState({ running: true, setOutage: setOutageSpy })
    render(<RegionView />)
    fireEvent.click(screen.getByLabelText('Simulate outage for us-east-1a'))
    expect(setOutageSpy).toHaveBeenCalledWith('az', azA.id, true)
  })

  it('server strip click navigates to server, row click to az', () => {
    const { region, azA, azB, serverA } = seedRegion()
    render(<RegionView />)
    fireEvent.click(screen.getByTitle('web-01'))
    expect(useNavStore.getState()).toMatchObject({ level: 'server', regionId: region.id, azId: azA.id, serverId: serverA.id })

    fireEvent.click(screen.getByText('us-east-1b'))
    expect(useNavStore.getState()).toMatchObject({ level: 'az', regionId: region.id, azId: azB.id, serverId: null })
  })

  it('ribbon renders redistribution message and timeline link', () => {
    const { azA, azB } = seedRegion()
    useSimulationStore.setState({
      latestBatch: fakeBatch(10_000, {
        [azA.id]: az({ azId: azA.id, health: 'healthy' }),
        [azB.id]: az({ azId: azB.id, health: 'down' }),
      }),
      events: [{
        id: 'e1', simMs: 9000, kind: 'outage_triggered', severity: 'critical',
        message: 'us-east-1b unhealthy', affected: [azB.id],
      }],
    })
    render(<RegionView />)
    expect(screen.getByText(/redistributed to/)).toBeInTheDocument()
    expect(screen.getByText('timeline')).toBeInTheDocument()
  })

  it('renders static skeleton with no batch', () => {
    seedRegion()
    render(<RegionView />)
    expect(screen.getByText('us-east-1a')).toBeInTheDocument()
    expect(screen.getByText('us-east-1b')).toBeInTheDocument()
    expect(screen.getAllByText('—')).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/world/region/RegionView.test.tsx`
Expected: FAIL — all 6 tests fail against the current Phase-1 placeholder (no ring numerals, no
per-AZ server strips/outage switches, no `AlertRibbon`) — e.g. `Unable to find an element with
the text: 91.` The failure mode here is assertion mismatches, not a module error: unlike Task
1's brand-new file, `RegionView.tsx` already exists (as the placeholder being rewritten) and the
test imports it successfully.

- [ ] **Step 3: Write `AlertRibbon.tsx`**

```tsx
// src/app/world/region/AlertRibbon.tsx
// Single alert ribbon above the region flow (D3/D6, mockup line 174). Renders the region's
// single most-severe active event; null renders nothing (no persistent "all clear" chrome,
// mirroring InspectorV2's null-when-empty convention).
import type { ReactElement } from 'react'
import type { RibbonAlert } from './regionData'

// Alpha-tinted bg/border + a lighter text tint for contrast aren't expressible via a plain
// var() substitution — same local-hex-constant carve-out as Phase 3's FirewallGate.tsx AMBER
// constant (R2).
const RIBBON_BG: Record<RibbonAlert['severity'], string> = { critical: '#EF444412', warning: '#F59E0B12' }
const RIBBON_BORDER: Record<RibbonAlert['severity'], string> = { critical: '#EF444433', warning: '#F59E0B33' }
const RIBBON_TEXT: Record<RibbonAlert['severity'], string> = { critical: '#FCA5A5', warning: '#FDE68A' }

export interface AlertRibbonProps { alert: RibbonAlert | null; onTimelineClick: () => void }

export function AlertRibbon({ alert, onTimelineClick }: AlertRibbonProps): ReactElement | null {
  if (!alert) return null
  return (
    <div
      role="alert"
      style={{
        background: RIBBON_BG[alert.severity], border: `1px solid ${RIBBON_BORDER[alert.severity]}`,
        borderRadius: 6, padding: '5px 10px', font: '9px var(--font-mono)',
        color: RIBBON_TEXT[alert.severity], marginBottom: 14,
      }}
    >
      ⚠ {alert.message}{' · '}
      <span
        role="button" tabIndex={0}
        style={{ textDecoration: 'underline', cursor: 'pointer' }}
        onClick={onTimelineClick}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onTimelineClick() } }}
      >
        timeline
      </span>
    </div>
  )
}
```

- [ ] **Step 4: Write `SplitLines.tsx`**

```tsx
// src/app/world/region/SplitLines.tsx
// Animated SVG split column between the inbound reading and the AZ row stack (D1, mockup
// lines 189-196). One cubic path per AZ share, its width scaling with the share's fraction; a
// down AZ gets a thin dashed red stub pinned to 0%.
import { useReducedMotion } from 'framer-motion'
import type { ReactElement } from 'react'
import type { AzShare } from './regionData'

const TEAL = '#2DD4BF'
const DOWN_RED = '#EF4444'
const LABEL_COLOR = '#94A3B8'
const SVG_W = 90
const ORIGIN_X = 5
const TARGET_X = 85

export interface SplitLinesProps { shares: AzShare[]; height: number }

export function SplitLines({ shares, height }: SplitLinesProps): ReactElement {
  const reduced = useReducedMotion()
  const originY = height / 2
  const rowY = (i: number) => ((i + 0.5) * height) / Math.max(1, shares.length)
  const midX = (ORIGIN_X + TARGET_X) / 2

  return (
    <svg width={SVG_W} height={height} style={{ flexShrink: 0 }} aria-hidden="true">
      {shares.map((s, i) => {
        const y = rowY(i)
        const d = `M${ORIGIN_X},${originY} C${midX - 5},${originY} ${midX},${y} ${TARGET_X},${y}`
        const pct = Math.round(s.fraction * 100)
        const strokeWidth = s.down ? 1 : 1 + 2 * s.fraction
        const stroke = s.down ? DOWN_RED : TEAL
        const dash = s.down ? '2 7' : '6 5'
        return (
          <g key={s.azId}>
            <path d={d} fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeDasharray={dash} opacity={s.down ? 0.5 : 0.75 + 0.1 * s.fraction}>
              {!reduced && !s.down && (
                <animate attributeName="stroke-dashoffset" values="22;0" dur="1s" repeatCount="indefinite" />
              )}
            </path>
            <text x={midX} y={y - 6} fill={s.down ? DOWN_RED : LABEL_COLOR} fontSize={9}>
              {pct}%
            </text>
          </g>
        )
      })}
    </svg>
  )
}
```

- [ ] **Step 5: Write `AzRow.tsx`**

```tsx
// src/app/world/region/AzRow.tsx
// One AZ's row in the region flow (D4, mockup lines 199-246): health ring, clickable server
// strips (or the drain line when down), per-AZ $/mo, and a running-gated outage switch.
import type { CSSProperties, ReactElement } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useCompiledWorld } from '../useCompiledWorld'
import { computeWorldCost } from '../../../lib/costModelV2'
import { dominantBlueprintColor } from './regionData'
import type { AzId, RegionId, ServerId } from '../../../lib/world/types'
import type { HealthState } from '../../../lib/worldEngine/types'

const ROW_BG = '#12151C'
const ROW_BORDER = '#232833'
const RING_TRACK = '#1E2430'
const STRIP_TRACK = '#1E2430'
const RING_NUMERAL_OK = '#E2E8F0'
// Ring-numeral/az-label tint for a down row — lighter than --color-danger for legibility on
// the dark ring/row background; the mockup uses this exact literal hex too, no token match (R2).
const DOWN_TINT = '#FCA5A5'
const RING_R = 14
const RING_CIRC = 2 * Math.PI * RING_R
const HEALTH_COLOR: Record<HealthState, string> = {
  healthy: 'var(--color-success)', degraded: 'var(--color-warning)', down: 'var(--color-danger)',
}
const PROMOTE_WINDOW_MS = 30_000

export interface AzRowProps {
  azId: AzId
  regionId: RegionId
  onNavigateAz: () => void
  onNavigateServer: (serverId: ServerId) => void
}

export function AzRow({ azId, regionId, onNavigateAz, onNavigateServer }: AzRowProps): ReactElement {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const batch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const running = useSimulationStore(s => s.running)
  const events = useSimulationStore(s => s.events)
  const isManuallyDown = useSimulationStore(s => s.healthOverrides[azId] ?? false)
  const setOutage = useSimulationStore(s => s.setOutage)

  const az = doc.azs[azId]
  const servers = Object.values(doc.servers).filter(s => s.azId === azId)
  const instanceCount = Object.values(compiled.instances).filter(i => i.azId === azId).length
  const metrics = batch?.azs[azId] ?? null
  const isDown = metrics?.health === 'down'
  const usd = computeWorldCost(doc, batch?.world ?? null).byAz.find(e => e.azId === azId)?.monthlyUsd ?? 0

  const residentInstanceIds = Object.values(compiled.instances).filter(i => i.azId === azId).map(i => i.id)
  const promoting = batch != null && events.some(e =>
    e.kind === 'replica_promoted' && e.simMs > batch.simMs - PROMOTE_WINDOW_MS && e.simMs <= batch.simMs &&
    e.affected.some(id => residentInstanceIds.includes(id)))

  const healthyAzLabels = Object.values(doc.azs)
    .filter(a => a.regionId === regionId && a.id !== azId && batch?.azs[a.id]?.health !== 'down')
    .map(a => a.label)

  const score = metrics?.healthScore
  const dashOffset = score == null ? RING_CIRC : RING_CIRC * (1 - score / 100)
  const ringColor = HEALTH_COLOR[metrics?.health ?? 'healthy']

  const rowStyle: CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 14, background: ROW_BG,
    border: `1px solid ${isDown ? 'var(--color-danger)' : ROW_BORDER}`,
    borderLeft: `2px solid ${ringColor}`,
    borderRadius: 8, padding: '8px 14px', cursor: 'pointer', opacity: isDown ? 0.8 : 1,
    font: '11px var(--font-mono)',
  }

  return (
    <div data-az-row={azId} style={rowStyle} onClick={onNavigateAz}>
      <svg width={34} height={34} viewBox="0 0 34 34" style={{ flexShrink: 0 }}>
        <circle cx={17} cy={17} r={RING_R} fill="none" stroke={RING_TRACK} strokeWidth={3.5} />
        {score != null && (
          <circle
            cx={17} cy={17} r={RING_R} fill="none" stroke={ringColor} strokeWidth={3.5}
            strokeDasharray={RING_CIRC} strokeDashoffset={dashOffset} strokeLinecap="round"
            transform="rotate(-90 17 17)"
          />
        )}
        <text x={17} y={21} fill={isDown ? DOWN_TINT : RING_NUMERAL_OK} fontSize={9} textAnchor="middle">
          {score != null ? Math.round(score) : '—'}
        </text>
      </svg>

      <div style={{ width: 110, flexShrink: 0 }}>
        <div style={{ color: isDown ? DOWN_TINT : 'var(--color-text-primary)' }}>{az?.label ?? azId}</div>
        <div style={{ color: isDown ? 'var(--color-danger)' : 'var(--color-text-muted)' }}>
          {isDown ? 'outage (manual)' : `${servers.length} srv · ${instanceCount} svc`}
        </div>
      </div>

      {isDown ? (
        <div style={{ flex: 1, color: 'var(--color-text-secondary)' }}>
          draining → {healthyAzLabels.map(label => (
            <span key={label} style={{ color: 'var(--color-success)', marginRight: 4 }}>{label}</span>
          ))}
          {promoting && <span> · replicas promoting</span>}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 2.5, alignItems: 'flex-end', height: 22, flex: 1 }}>
          {servers.map(server => {
            const sm = batch?.servers[server.id]
            const mean = sm && sm.coreUtilization.length
              ? sm.coreUtilization.reduce((a, b) => a + b, 0) / sm.coreUtilization.length
              : 0
            const heightPct = batch ? Math.max(4, mean * 100) : 6
            const color = dominantBlueprintColor(server.id, doc, compiled)
            return (
              <div
                key={server.id} title={server.label}
                style={{ width: 9, height: `${heightPct}%`, background: STRIP_TRACK, borderTop: `2px solid ${color}`, borderRadius: 1, cursor: 'pointer' }}
                onClick={e => { e.stopPropagation(); onNavigateServer(server.id) }}
              />
            )
          })}
        </div>
      )}

      <div style={{ textAlign: 'right', color: 'var(--color-text-secondary)', width: 130, flexShrink: 0 }}>
        {isDown ? (
          <span style={{ color: 'var(--color-text-muted)' }}>0 rps · —</span>
        ) : (
          <>
            {(metrics?.rps ?? 0).toFixed(0)} rps · p50 {(metrics?.p50Ms ?? 0).toFixed(0)}ms<br />
            <span style={{ color: 'var(--color-text-muted)' }}>
              err {((metrics?.errorRate ?? 0) * 100).toFixed(1)}% · ${Math.round(usd)}/mo
            </span>
          </>
        )}
      </div>

      {running && (
        <button
          aria-label={`${isManuallyDown ? 'Clear' : 'Simulate'} outage for ${az?.label ?? azId}`}
          style={{
            background: 'var(--color-node-base)',
            border: `1px solid ${isManuallyDown ? 'var(--color-danger)' : 'var(--color-node-border)'}`,
            borderRadius: 4, padding: '3px 6px', cursor: 'pointer', flexShrink: 0,
            font: '10px var(--font-mono)', color: isManuallyDown ? 'var(--color-danger)' : 'var(--color-text-secondary)',
          }}
          onClick={e => { e.stopPropagation(); setOutage('az', azId, !isManuallyDown) }}
        >
          {isManuallyDown ? '✓' : '⚡'}
        </button>
      )}
    </div>
  )
}
```

- [ ] **Step 6: Write `CrossAzColumn.tsx`**

```tsx
// src/app/world/region/CrossAzColumn.tsx
// Fixed-width column right of the AZ row stack (D5, mockup lines 249-253): one line per AZ
// pair sharing cross-az traffic or replication, its latency, and replication summaries.
import type { ReactElement } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useCompiledWorld } from '../useCompiledWorld'
import { crossAzEntries } from './regionData'
import type { RegionId } from '../../../lib/world/types'

const HEADING_COLOR = 'var(--color-text-muted)'
const BODY_COLOR = 'var(--color-text-secondary)'
const LATENCY_COLOR = '#2DD4BF'
const DOWN_COLOR = 'var(--color-danger)'

export interface CrossAzColumnProps { regionId: RegionId }

export function CrossAzColumn({ regionId }: CrossAzColumnProps): ReactElement {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const batch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const entries = crossAzEntries(regionId, doc, compiled, batch)

  return (
    <div style={{
      width: 130, flexShrink: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center',
      gap: 6, paddingLeft: 14, font: '9px var(--font-mono)',
    }}>
      <div style={{ color: HEADING_COLOR, textTransform: 'uppercase', letterSpacing: '0.06em' }}>cross-AZ</div>
      {entries.length === 0 && <div style={{ color: HEADING_COLOR }}>no cross-AZ links</div>}
      {entries.map(entry => {
        const labelA = doc.azs[entry.a]?.label ?? entry.a
        const labelB = doc.azs[entry.b]?.label ?? entry.b
        return (
          <div key={`${entry.a}::${entry.b}`} style={{ color: BODY_COLOR }}>
            <div>
              {labelA} ⇄ {labelB}{' '}
              {entry.linkDown
                ? <span style={{ color: DOWN_COLOR }}>✕ link down</span>
                : <span style={{ color: LATENCY_COLOR }}>{entry.latencyMs}ms</span>}
            </div>
            {entry.replication.map(r => <div key={r.blueprintId}>{r.blueprintName} repl</div>)}
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 7: Rewrite `RegionView.tsx`**

Note: this version renders nothing at the `TimelineStrip` slot yet — Task 3 fills it. Its
`AlertRibbon`'s `onTimelineClick` is a harmless no-op here for the same reason (there's nothing
to scroll to until Task 3 mounts the strip and adds the `ref`).

```tsx
// src/app/world/RegionView.tsx
// Level-2 region flow page (Phase 4 D1-D6, mockup "Level 2 · Region page (v2)"): global-edge
// inbound -> animated split shares -> AZ rows (health ring, clickable server strips, $/mo) ->
// cross-AZ column, with one alert ribbon above and (T3) a failover timeline below. Fully
// scrub-aware: every metric reads `scrubBatch ?? latestBatch` (D1) and renders a meaningful
// static state ("—", doc-derived counts) before the sim has ever produced a batch.
import { useEffect, useState, type CSSProperties } from 'react'
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { useSimulationStore } from '../store/simulation.store'
import { useCompiledWorld } from './useCompiledWorld'
import { WORLD_REGIONS } from '../../lib/regionConfig'
import type { RoutingPolicyKind } from '../../lib/world/types'
import { azShares, ribbonAlert, sparklineSeries } from './region/regionData'
import { AlertRibbon } from './region/AlertRibbon'
import { SplitLines } from './region/SplitLines'
import { AzRow } from './region/AzRow'
import { CrossAzColumn } from './region/CrossAzColumn'

const POLICY_LABEL: Record<RoutingPolicyKind, string> = {
  latency: 'latency-based routing', geo: 'geo-based routing',
  weighted: 'weighted routing', priority: 'priority routing',
}
const TEAL = '#2DD4BF'
const CHIP: CSSProperties = { borderRadius: 10, padding: '2px 8px', font: '9px var(--font-mono)' }
const ACCENT_CHIP_BORDER = '#4A9EFF44'
const SUCCESS_CHIP_BORDER = '#22C55E44'
// Schematic estimate for SplitLines' height, not a live DOM measurement — see the fragment's
// judgment-call note (D11 budgets the page at ~1Hz re-render; a ResizeObserver-driven height
// sync would add churn for a purely schematic diagram).
const ROW_HEIGHT_ESTIMATE = 64
const SPARK_W = 80
const SPARK_H = 20

export function RegionView() {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const { regionId, goAz, goServer } = useNavStore()
  const batch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const running = useSimulationStore(s => s.running)
  const events = useSimulationStore(s => s.events)
  const isDown = useSimulationStore(s => s.healthOverrides[regionId ?? ''] ?? false)
  const setOutage = useSimulationStore(s => s.setOutage)
  const [spark, setSpark] = useState<number[]>([])

  useEffect(() => {
    if (!regionId) return
    const poll = () => setSpark(sparklineSeries(useSimulationStore.getState().getReplayFrames(), regionId))
    poll()
    if (!running) return
    const id = setInterval(poll, 1000)
    return () => clearInterval(id)
  }, [running, regionId])

  if (!regionId || !doc.regions[regionId]) return null

  const region = doc.regions[regionId]
  const azs = Object.values(doc.azs).filter(a => a.regionId === regionId)
  const servers = Object.values(doc.servers).filter(s => azs.some(a => a.id === s.azId))
  const instanceCount = Object.values(compiled.instances).filter(i => i.regionId === regionId).length
  const worldLabel = WORLD_REGIONS.find(r => r.id === region.catalogId)?.label ?? region.catalogId

  const shares = azShares(regionId, doc, batch)
  const alert = ribbonAlert(regionId, doc, events, batch?.simMs ?? 0)
  const regionRps = batch?.regions[regionId]?.rps ?? 0
  const rowsHeight = Math.max(140, azs.length * ROW_HEIGHT_ESTIMATE)
  const maxSpark = Math.max(1, ...spark)

  return (
    <div style={{ padding: 18, font: '12px var(--font-mono)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <div>
          <span style={{ font: '16px var(--font-mono)', color: 'var(--color-text-primary)' }}>{region.catalogId}</span>
          <span style={{ font: '10px var(--font-mono)', color: 'var(--color-text-muted)' }}>
            {' '}{worldLabel} · {azs.length} AZ{azs.length === 1 ? '' : 's'} · {servers.length} server{servers.length === 1 ? '' : 's'} · {instanceCount} service instance{instanceCount === 1 ? '' : 's'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ ...CHIP, border: `1px solid ${ACCENT_CHIP_BORDER}`, color: 'var(--color-accent)' }}>
            {POLICY_LABEL[doc.routing.policy]}
          </span>
          <span style={{ ...CHIP, border: `1px solid ${SUCCESS_CHIP_BORDER}`, color: 'var(--color-success)' }}>
            health: {Math.round(doc.routing.healthCheckIntervalMs / 1000)}s interval
          </span>
          {running && (
            <button
              style={{
                background: 'var(--color-node-base)',
                border: `1px solid ${isDown ? 'var(--color-danger)' : 'var(--color-node-border)'}`,
                borderRadius: 4, padding: '3px 8px', cursor: 'pointer',
                font: '11px var(--font-mono)', color: isDown ? 'var(--color-danger)' : 'var(--color-text-secondary)',
              }}
              onClick={() => setOutage('region', regionId, !isDown)}
            >
              {isDown ? '✓ Clear region outage' : '⚡ Simulate region outage'}
            </button>
          )}
        </div>
      </div>

      <AlertRibbon alert={alert} onTimelineClick={() => {}} />

      {azs.length === 0 ? (
        <div style={{ color: 'var(--color-text-muted)', font: '12px var(--font-mono)' }}>
          No AZs yet — add one in the World panel →
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'stretch', gap: 0 }}>
          <div style={{ width: 120, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            <div style={{ fontSize: 20, color: TEAL }}>◍</div>
            <div style={{ fontSize: 10, color: 'var(--color-text-primary)' }}>global edge</div>
            <div style={{ fontSize: 12, color: TEAL }}>{regionRps.toFixed(0)} rps</div>
            <svg width={SPARK_W} height={SPARK_H}>
              <polyline
                points={spark.map((v, i) => `${(i / Math.max(1, spark.length - 1)) * SPARK_W},${SPARK_H - (v / maxSpark) * SPARK_H}`).join(' ')}
                fill="none" stroke={TEAL} strokeWidth={1.2} opacity={0.8}
              />
            </svg>
          </div>

          <SplitLines shares={shares} height={rowsHeight} />

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {azs.map(az => (
              <AzRow
                key={az.id} azId={az.id} regionId={regionId}
                onNavigateAz={() => goAz(regionId, az.id)}
                onNavigateServer={serverId => goServer(regionId, az.id, serverId)}
              />
            ))}
          </div>

          <CrossAzColumn regionId={regionId} />
        </div>
      )}

      {/* TimelineStrip mounts here (T3) */}
    </div>
  )
}
```

- [ ] **Step 8: Run tests + build**

Run: `npx vitest run src/app/world/region/RegionView.test.tsx` → PASS (6 tests).
Run: `npm run build` → succeeds.
Run: `npx vitest run` → all suites green (17 tests across Tasks 1–2's two new files, plus every
pre-existing suite untouched).

- [ ] **Step 9: Live Playwright smoke (controller-run, port 1420)**

1. `npm run dev` (background); wait for `Local:   http://localhost:1420/`.
2. `browser_navigate` → `http://localhost:1420`; `browser_click` "New World" (HomeScreen).
3. World panel, Topology tab (default): click "+ Region" (adds `us-east-1`, the preselected
   first `WORLD_REGIONS` entry) → click "+ AZ" twice (adds `us-east-1a`, `us-east-1b`) → for
   EACH az block, click its own "+ Server" (default preset `VPS Medium`) once.
4. `browser_snapshot` on the main canvas (still at globe level) → click the `us-east-1` region
   card to navigate into `RegionView`.
5. `browser_snapshot` → confirm the NEW flow layout: header chips (routing policy, health
   interval, no outage button yet since not running), empty ribbon slot, inbound column, split
   lines, 2 AZ rows with rings at "—", cross-AZ column showing "no cross-AZ links" (no
   dependencies authored), and an empty area below where the timeline will land in Task 3.
6. Click "Simulate" (header `SimControls`).
7. `browser_wait_for` ~2s, then `browser_snapshot` → both AZ rows now show live rps/p50/err/$
   figures and non-trivial server-strip heights; split-line percentage labels are populated.
8. Click one AZ row's ⚡ outage switch → `browser_snapshot` → the `AlertRibbon` now shows an
   outage message with "redistributed to" + a "timeline" link; the other AZ row's split share
   increased; the down row shows the drain line instead of strips.
9. `browser_console_messages` → assert ZERO error-level entries.
10. `browser_take_screenshot` → scratchpad `task2-region-flow.png`.
11. Click "Stop".
12. Stop the dev server.

- [ ] **Step 10: Commit**

```bash
git add src/app/world/region/AlertRibbon.tsx src/app/world/region/SplitLines.tsx \
        src/app/world/region/AzRow.tsx src/app/world/region/CrossAzColumn.tsx \
        src/app/world/region/RegionView.test.tsx src/app/world/RegionView.tsx
git commit -m "feat(region): region flow page — ribbon, split lines, az rows, cross-az column"
```

---

## Task 3: Failover timeline strip `[sonnet]`

**Files:** create `src/app/world/region/TimelineStrip.tsx`, `TimelineStrip.test.tsx`; edit
`src/app/world/RegionView.tsx` (mount `TimelineStrip` in T2's empty slot; wire `AlertRibbon`'s
`onTimelineClick` to scroll + one-shot-highlight it); edit `src/index.css` (the highlight
keyframes).

**Grounding:** `regionEvents(regionId, doc, compiled, events, batch)` (Task 1) is the scoping
function this component uses directly. `EngineEventKind` (`src/lib/worldEngine/types.ts`) has
16 members — the glyph map below is exhaustive over all of them (`Record<EngineEventKind,
string>` — TS would error on a missing key). `useSimulationStore.getState().getReplayFrames()`
is a plain (non-reactive) method — same imperative-call convention `ScrubberV2.tsx`/
`InspectorV2.tsx` already use — called only inside the click handler, not a hook selector.
`setScrubIndex(i: number | null)` drives the SAME global `ScrubberV2` bottom bar already
mounted by `WorldShell.tsx`; this component doesn't render its own scrubber UI. jsdom note: a
native `<button disabled>` never dispatches its click handler (matches real browsers), which is
exactly the "clicks inert while running" behavior — no extra guard needed to make that test
pass, though the handler ALSO checks `running` defensively since `disabled` is a presentation
concern, not a substitute for the real guard.

- [ ] **Step 1: Write the failing test `TimelineStrip.test.tsx`**

```tsx
// src/app/world/region/TimelineStrip.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TimelineStrip } from './TimelineStrip'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { createWorld, createRegion, createAz, createServer } from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'
import type { MetricsBatch, EngineEvent, ReplayFrame } from '../../../lib/worldEngine/types'

function emptyWorldMetrics(): MetricsBatch['world'] {
  return { totalRps: 0, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 }
}
function fakeBatch(simMs: number): MetricsBatch {
  return { simMs, instances: {}, servers: {}, azs: {}, regions: {}, world: emptyWorldMetrics() }
}

function seedTwoRegions() {
  const doc = createWorld()
  const regionA = createRegion('us-east-1')
  const regionB = createRegion('eu-west-1')
  const azA = createAz(regionA.id, 'us-east-1a')
  const azX = createAz(regionB.id, 'eu-west-1a')
  const serverA = createServer(azA.id, getPreset('vps-medium')!)
  const serverX = createServer(azX.id, getPreset('vps-medium')!)
  doc.regions[regionA.id] = regionA; doc.regions[regionB.id] = regionB
  doc.azs[azA.id] = azA; doc.azs[azX.id] = azX
  doc.servers[serverA.id] = serverA; doc.servers[serverX.id] = serverX
  useWorldStore.setState({ doc, history: [], future: [] })
  return { doc, regionA, regionB, azA, azX }
}

// Captured once, pristine — restored by resetSim() every test (see the same note in
// RegionView.test.tsx; this file overrides getReplayFrames/setScrubIndex per-test).
const realSetScrubIndex = useSimulationStore.getState().setScrubIndex
const realGetReplayFrames = useSimulationStore.getState().getReplayFrames

function resetSim() {
  useSimulationStore.setState({
    running: false, timeScale: 1, latestBatch: null, events: [], healthOverrides: {},
    scrubIndex: null, scrubBatch: null, degraded: false,
    setScrubIndex: realSetScrubIndex, getReplayFrames: realGetReplayFrames,
  })
}

describe('TimelineStrip', () => {
  beforeEach(() => {
    useWorldStore.getState().newWorld()
    resetSim()
  })

  it('renders glyphs for region-scoped events only', () => {
    const { regionA, azA, azX } = seedTwoRegions()
    const events: EngineEvent[] = [
      { id: 'in-scope', simMs: 9000, kind: 'outage_triggered', severity: 'critical', message: 'a', affected: [azA.id] },
      { id: 'out-of-scope', simMs: 9000, kind: 'oom_kill', severity: 'critical', message: 'b', affected: [azX.id] },
    ]
    useSimulationStore.setState({ latestBatch: fakeBatch(10_000), events })
    render(<TimelineStrip regionId={regionA.id} />)
    expect(screen.getByTitle('a · t+9.0s')).toBeInTheDocument()
    expect(screen.queryByTitle('b · t+9.0s')).not.toBeInTheDocument()
  })

  it('click while stopped scrubs to nearest frame', () => {
    const { regionA, azA } = seedTwoRegions()
    const events: EngineEvent[] = [
      { id: 'e1', simMs: 5200, kind: 'failover_started', severity: 'warning', message: 'failing over', affected: [azA.id] },
    ]
    const frames: ReplayFrame[] = [1000, 5000, 9000].map(simMs => ({ simMs, batch: fakeBatch(simMs), events: [] }))
    const setScrubIndexSpy = vi.fn()
    useSimulationStore.setState({
      running: false, latestBatch: fakeBatch(10_000), events,
      getReplayFrames: () => frames, setScrubIndex: setScrubIndexSpy,
    })
    render(<TimelineStrip regionId={regionA.id} />)
    fireEvent.click(screen.getByTitle(/failing over/))
    expect(setScrubIndexSpy).toHaveBeenCalledWith(1)   // frame simMs=5000 is nearest to event simMs=5200
  })

  it('clicks inert while running', () => {
    const { regionA, azA } = seedTwoRegions()
    const events: EngineEvent[] = [
      { id: 'e1', simMs: 5200, kind: 'failover_started', severity: 'warning', message: 'failing over', affected: [azA.id] },
    ]
    const setScrubIndexSpy = vi.fn()
    useSimulationStore.setState({ running: true, latestBatch: fakeBatch(10_000), events, setScrubIndex: setScrubIndexSpy })
    render(<TimelineStrip regionId={regionA.id} />)
    fireEvent.click(screen.getByTitle('stop the simulation to scrub to this event'))
    expect(setScrubIndexSpy).not.toHaveBeenCalled()
  })

  it('null with no events', () => {
    const { regionA } = seedTwoRegions()
    useSimulationStore.setState({ latestBatch: fakeBatch(10_000), events: [] })
    const { container } = render(<TimelineStrip regionId={regionA.id} />)
    expect(container).toBeEmptyDOMElement()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/world/region/TimelineStrip.test.tsx`
Expected: FAIL — `Cannot find module './TimelineStrip'`.

- [ ] **Step 3: Write `TimelineStrip.tsx`**

```tsx
// src/app/world/region/TimelineStrip.tsx
// Region-scoped failover timeline under the flow (D6, skeleton T3): horizontal simMs axis
// covering the last 120s, one glyph per event, click-to-scrub while stopped. Mounted by
// RegionView; AlertRibbon's "timeline" link scrolls/flashes it (wired in RegionView.tsx, not
// here — this component only renders the strip itself).
import type { ReactElement } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useCompiledWorld } from '../useCompiledWorld'
import { regionEvents } from './regionData'
import type { RegionId } from '../../../lib/world/types'
import type { EngineEvent, EngineEventKind } from '../../../lib/worldEngine/types'

const WINDOW_MS = 120_000
const TRACK_BG = '#1E2430'
const TRACK_BORDER = '#232833'

const GLYPH: Record<EngineEventKind, string> = {
  outage_triggered: '⚡', outage_cleared: '⚡',
  health_check_failed: '♺',
  failover_started: '⇄', failover_completed: '⇄',
  ttl_lag_expired: '◷',
  replica_promoted: '⬆',
  oom_kill: '☠',
  noisy_neighbor: '▲',
  connection_refused: '●', instance_restarted: '●', burst_credits_exhausted: '●',
  breaker_open: '●', breaker_half_open: '●', breaker_closed: '●', engine_degraded: '●',
}
const SEVERITY_COLOR: Record<EngineEvent['severity'], string> = {
  critical: 'var(--color-danger)', warning: 'var(--color-warning)', info: 'var(--color-text-muted)',
}

export interface TimelineStripProps { regionId: RegionId }

export function TimelineStrip({ regionId }: TimelineStripProps): ReactElement | null {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const batch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const running = useSimulationStore(s => s.running)
  const events = useSimulationStore(s => s.events)
  const setScrubIndex = useSimulationStore(s => s.setScrubIndex)

  const scoped = regionEvents(regionId, doc, compiled, events, batch)
  if (scoped.length === 0) return null

  const endMs = batch?.simMs ?? Math.max(...scoped.map(e => e.simMs))
  const startMs = endMs - WINDOW_MS

  const onEventClick = (e: EngineEvent) => {
    if (running) return
    const frames = useSimulationStore.getState().getReplayFrames()
    if (frames.length === 0) return
    let nearest = 0
    let best = Infinity
    frames.forEach((f, i) => {
      const d = Math.abs(f.simMs - e.simMs)
      if (d < best) { best = d; nearest = i }
    })
    setScrubIndex(nearest)
  }

  return (
    <div style={{ marginTop: 12, font: '9px var(--font-mono)' }}>
      <div style={{ color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
        failover timeline
      </div>
      <div style={{ position: 'relative', height: 28, background: TRACK_BG, border: `1px solid ${TRACK_BORDER}`, borderRadius: 4 }}>
        {scoped.map(e => {
          const clamped = Math.min(endMs, Math.max(startMs, e.simMs))
          const pct = ((clamped - startMs) / WINDOW_MS) * 100
          return (
            <button
              key={e.id}
              title={running ? 'stop the simulation to scrub to this event' : `${e.message} · t+${(e.simMs / 1000).toFixed(1)}s`}
              onClick={() => onEventClick(e)}
              disabled={running}
              style={{
                position: 'absolute', left: `${pct}%`, top: '50%', transform: 'translate(-50%, -50%)',
                background: 'none', border: 'none', padding: 2, cursor: running ? 'default' : 'pointer',
                color: SEVERITY_COLOR[e.severity], fontSize: 11, lineHeight: 1,
              }}
            >
              {GLYPH[e.kind]}
            </button>
          )
        })}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Edit `RegionView.tsx`** — mount `TimelineStrip` and wire the ribbon's timeline link

Apply these five changes to the Task 2 file (each shown as the exact old text to find and the
new text to replace it with):

Change 1 — add `useRef` to the react import:

```tsx
// OLD
import { useEffect, useState, type CSSProperties } from 'react'
// NEW
import { useEffect, useRef, useState, type CSSProperties } from 'react'
```

Change 2 — import `TimelineStrip`:

```tsx
// OLD
import { CrossAzColumn } from './region/CrossAzColumn'
// NEW
import { CrossAzColumn } from './region/CrossAzColumn'
import { TimelineStrip } from './region/TimelineStrip'
```

Change 3 — add the ref, right after the existing `spark` state:

```tsx
// OLD
  const [spark, setSpark] = useState<number[]>([])

  useEffect(() => {
// NEW
  const [spark, setSpark] = useState<number[]>([])
  const timelineRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
```

Change 4 — replace the no-op `onTimelineClick` with the real scroll + one-shot highlight:

```tsx
// OLD
      <AlertRibbon alert={alert} onTimelineClick={() => {}} />
// NEW
      <AlertRibbon
        alert={alert}
        onTimelineClick={() => {
          const el = timelineRef.current
          if (!el) return
          el.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
          el.classList.add('region-timeline-flash')
          setTimeout(() => el.classList.remove('region-timeline-flash'), 1200)
        }}
      />
```

Change 5 — replace the placeholder comment with the real, ref-wrapped mount:

```tsx
// OLD
      {/* TimelineStrip mounts here (T3) */}
// NEW
      <div ref={timelineRef}>
        <TimelineStrip regionId={regionId} />
      </div>
```

- [ ] **Step 5: Edit `src/index.css`** — add the one-shot highlight animation

Append after the existing `shimmer` keyframes block (the file's last rule):

```css
/* One-shot highlight when AlertRibbon's "timeline" link scrolls the failover timeline into
   view (RegionView / TimelineStrip, Phase 4 T3). The blanket prefers-reduced-motion override
   above (animation-duration: 0.01ms) already collapses this to a near-instant flash under
   reduced motion — no separate media query needed here. */
.region-timeline-flash {
  animation: region-timeline-flash-kf 1.1s ease-out;
}
@keyframes region-timeline-flash-kf {
  0% { box-shadow: 0 0 0 2px var(--color-danger); }
  100% { box-shadow: 0 0 0 2px transparent; }
}
```

- [ ] **Step 6: Run tests + build**

Run: `npx vitest run src/app/world/region/TimelineStrip.test.tsx` → PASS (4 tests).
Run: `npx vitest run src/app/world/region/RegionView.test.tsx` → still PASS (6 tests — the
Step 4 edit is additive to `RegionView.tsx` and doesn't change any of Task 2's assertions).
Run: `npm run build` → succeeds.
Run: `npx vitest run` → all suites green (21 tests across the three files this fragment adds,
plus every pre-existing suite untouched).

- [ ] **Step 7: Live Playwright smoke (controller-run, port 1420)**

Continues directly from Task 2's smoke (same session), or repeat setup fresh:

1. `npm run dev` (background); wait for ready.
2. Repeat Task 2 Step 9's setup through "kill an AZ via its row switch" (steps 2–8 there).
3. Click "Stop".
4. `browser_snapshot` → the failover timeline now renders below the flow, showing glyphs for
   the events the kill scenario logged (⚡ outage_triggered at minimum; possibly ♺/⇄ depending
   on how the engine reacted).
5. Click one event glyph (e.g. the ⚡ outage glyph).
6. `browser_snapshot` → confirm: the bottom `ScrubberV2` bar's label switched from `live` to a
   timestamp and its "Exit scrub" button appeared; the region page's AZ ring/numerals now
   reflect that historical frame rather than the latest one.
7. `browser_console_messages` → assert ZERO error-level entries.
8. `browser_take_screenshot` → scratchpad `task3-timeline-scrub.png`.
9. Stop the dev server.

- [ ] **Step 8: Commit**

```bash
git add src/app/world/region/TimelineStrip.tsx src/app/world/region/TimelineStrip.test.tsx \
        src/app/world/RegionView.tsx src/index.css
git commit -m "feat(region): failover timeline with click-to-scrub"
```

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


---

## Task 7: Carry-forwards — provider selector + Phase-3 hygiene `[sonnet]`

**Files:** modify `src/app/store/world.store.ts`, `src/app/world/panels/PlacementPanel.tsx`,
`src/lib/costModelV2.test.ts`, `src/app/store/world.store.test.ts`,
`src/app/world/server/ServerBoard.tsx`, `src/app/world/server/inspectorForms.tsx`,
`src/app/world/server/FirewallGate.tsx` (verify only — see Step 8), `src/app/world/server/PacketLayer.tsx`.

**Grounding (verified against current source, all five carry-forward items = design D10 a–e):**
- `world.store.ts:80` (interface) and `:176-180` (impl) — `addManagedService` currently hardcodes
  `provider: 'generic'` in the impl and has no `provider` parameter at all. The store's default
  export doc.managedServices entry today is always priced at $0 via `getServiceSpec` (confirmed
  in `costModelV2.ts`: `if (!spec) return 0 // 'generic' provider or unmapped nodeType`). This is
  the exact Phase-3 backlog item: *"world.store.addManagedService hardcodes provider:'generic' →
  getServiceSpec returns $0, so managed services added via the REAL UI price $0 regardless of
  nodeType"* (progress.md, PHASE 3 open items).
- `PlacementPanel.tsx:58-62` — the `+ Add` button's `onClick` calls
  `store.addManagedService(msType, label, scope, 5432)` — 4 args, no provider. `MANAGED_TYPES`
  already authors canonical `CLOUD_REGISTRY` keys (`dbSql`/`objectStorage`/`queue`/…, Phase-3
  Task 8) so pricing only needs a non-generic `provider` to stop being $0.
  `ManagedService.provider: 'generic' | 'aws' | 'gcp' | 'azure'` already exists on the type
  (`src/lib/world/types.ts:170`) — nothing to add there.
  `cloudRegistry.ts`'s `dbSql.aws` entry has `instanceHourly` pricing
  (`defaultRateUsdHr: 0.068, defaultCount: 1`), so an `aws`-provider `dbSql` service prices
  `0.068 × 730 ≈ $49.64/mo` — confirmed non-zero.
- `costModelV2.test.ts` already has (do NOT duplicate) a case named
  *"prices new managed services authored with CLOUD_REGISTRY keys directly (dbSql)"* that
  hand-builds a `doc.managedServices['ms-new']` literal with `provider: 'aws'` directly — R6
  (grounding §0): the NEW case must instead drive the **store-authored path**
  (`useWorldStore.getState().addManagedService(...)`), proving the new `provider` param actually
  flows from the store action into a priced document, not just that the pricing function handles
  a hand-built fixture.
- `inspectorForms.tsx` — three falsy-zero bugs, all `x || y` patterns that silently discard a
  legitimate `0`:
  - `RuntimeForm` (`cpuLimit`/`memLimitMb`, lines ~65-66): `onCommit={v => setRt({ cpuLimit: v || null })}`.
    `NumberField`'s `onBlur` (same file, `NumberField`) already guarantees `v` is
    `Number.isFinite(v) && v >= 0` before calling `onCommit` — so `v` is never `NaN`/negative here,
    only ever a real number that happens to sometimes be `0`. `v || null` maps that `0` to `null`
    (meaning "unlimited"), so a user can never actually set/keep an explicit zero limit.
  - `FirewallEditor` (`port`, line ~97):
    `onChange={e => patch(i, { port: e.target.value === 'any' ? 'any' : (Number(e.target.value) || 'any') })}`.
    Typing literal `0` into the port field: `Number('0') === 0` (falsy) → coerced to `'any'`
    instead of being stored as the number `0`.
- `ServerBoard.tsx` — `residentBlueprints`/`attribution`/`memLimits`+`instanceRamMb`/
  `volumeConsumers` are five plain `const`/loop computations, recomputed on every render
  (documented Phase-3 Minor: *"ServerBoard derived values [...] unmemoized — cheap at ≤12 chips +
  1Hz events but tidier with useMemo"*). Separately, `gateBlockedPerSecond` (line 44) reads
  `latestBatch?.simMs ?? 0` — **not** `scrubBatch ?? latestBatch` — so the blocked/s counter keeps
  advancing off the live clock even while the board is showing a scrubbed historical frame
  (documented Minor: *"gate block counter not scrub-aware"*). R7 (grounding §0) is explicit: the
  fix reads the **display** batch's simMs.
- `FirewallGate.tsx` — pure presentational component; it only renders whatever
  `blockedPerSecond` prop it's given (verified: no `simMs`/store read anywhere in the file). The
  R7 fix therefore has **no code change in this file** — it is entirely in its caller
  (`ServerBoard.tsx`). This file is listed in the skeleton/grounding's Files sections because it's
  the visible surface of the fix, not because its source changes; Step 8 below is a verification
  step, not an edit.
- `PacketLayer.tsx` `pointAt` (lines ~36-49) calls `path.getTotalLength?.()` then
  `path.getPointAtLength(...)` with no exception handling — documented Phase-3 Minor:
  *"getPointAtLength packet positioning unverified in WebKit/Tauri native build"*. D10e: wrap in
  try/catch, fall back to a linear interpolation between the trace's two anchors
  (`layout.anchorFor(fromId)`/`layout.anchorFor(toId)`, both already used identically in
  `TraceLayer.tsx` — `Anchor = { x: number; y: number }`, `anchorFor(id): Anchor | null`).

**Scope note:** all five items are additive/behavior-preserving except the two genuinely new
behaviors (provider pricing, falsy-zero, scrub-correct blocked/s) — none of them touch
`worldEngine/`, none change any frozen contract, none add a new store action.

- [ ] **Step 1: Write the two new failing tests**

Append to `src/app/store/world.store.test.ts` (inside the existing `describe('world.store', ...)`
block, after the `removeManagedService strips dependencies targeting it` case):

```ts
  it('addManagedService stores the given provider', () => {
    const { azId } = buildChain()
    const msId = useWorldStore.getState().addManagedService('dbSql', 'SQL DB', { kind: 'az', azId }, 5432, 'aws')
    const doc = useWorldStore.getState().doc
    expect(doc.managedServices[msId].provider).toBe('aws')
  })
```

Append to `src/lib/costModelV2.test.ts` (inside `describe('computeWorldCost', ...)`, after the
existing `prices new managed services authored with CLOUD_REGISTRY keys directly (dbSql)` case).
This file currently has no store import — add one:

```ts
import { describe, it, expect } from 'vitest'
import { computeWorldCost } from './costModelV2'
import { createWorld, createRegion, createAz, createServer } from './world/factories'
import { getPreset } from './world/instanceCatalog'
import { useWorldStore } from '../app/store/world.store'
import type { WorldDoc } from './world/types'
```

```ts
  it('authored aws managed service prices non-zero', () => {
    // R6 (grounding §0): unlike the hand-built-fixture case above, this drives the STORE-authored
    // path — proving addManagedService's new provider param actually reaches a priced document,
    // not just that computeWorldCost can price a manually-constructed ManagedService literal.
    useWorldStore.getState().newWorld()
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addManagedService('dbSql', 'SQL DB', { kind: 'az', azId }, 5432, 'aws')
    const doc = useWorldStore.getState().doc
    expect(computeWorldCost(doc, null).monthlyUsd).toBeGreaterThan(0)
  })
```

- [ ] **Step 2: Run to verify both fail**

Run: `npx vitest run src/app/store/world.store.test.ts`
Expected: FAIL — `addManagedService` only accepts 4 args; the 5th (`'aws'`) is a **type error**
under strict tsc (`vitest` still executes untyped, so the case runs but
`doc.managedServices[msId].provider` is `'generic'`, not `'aws'` → assertion fails).

Run: `npx vitest run src/lib/costModelV2.test.ts`
Expected: FAIL — same reason; `addManagedService('dbSql', …, 'aws')`'s 5th arg is silently
dropped by the pre-T7 signature, so the service is stored with `provider: 'generic'` and
`getServiceSpec` returns `undefined` → `monthlyUsd` stays `0` → `toBeGreaterThan(0)` fails.

- [ ] **Step 3: `world.store.ts` — thread the `provider` parameter**

Add `ManagedService` to the existing type-only import (needed for `ManagedService['provider']`):

```ts
import type {
  WorldDoc, Server, ServiceBlueprint, Placement, ManagedScope, ManagedService, ClientPopulation,
  RoutingConfig, TrafficConfig,
} from '../../lib/world/types'
```

Interface (`WorldStore`), change the `addManagedService` signature:

```ts
  addManagedService: (nodeType: string, label: string, scope: ManagedScope, port: number) => string
```
→
```ts
  addManagedService: (nodeType: string, label: string, scope: ManagedScope, port: number, provider?: ManagedService['provider']) => string
```

Implementation, replace the hardcoded `provider: 'generic'`:

```ts
    addManagedService: (nodeType, label, scope, port) => {
      const id = nextWorldId('ms')
      mutate(d => ({ ...d, managedServices: { ...d.managedServices, [id]: { id, label, nodeType, scope, provider: 'generic', port } } }))
      return id
    },
```
→
```ts
    addManagedService: (nodeType, label, scope, port, provider = 'generic') => {
      const id = nextWorldId('ms')
      mutate(d => ({ ...d, managedServices: { ...d.managedServices, [id]: { id, label, nodeType, scope, provider, port } } }))
      return id
    },
```

The trailing param is additive with a default — every existing 4-arg call site
(`PlacementPanel.tsx` pre-Step-4, both `world.store.test.ts` pre-existing cases, both
`costModelV2.test.ts` pre-existing cases) keeps compiling and keeps defaulting to `'generic'`,
unchanged.

- [ ] **Step 4: `PlacementPanel.tsx` — provider `<select>`, default `'aws'`**

Add `ManagedService` to the existing type import:

```tsx
import type { Placement, PlacementRuntime } from '../../../lib/world/types'
```
→
```tsx
import type { ManagedService, Placement, PlacementRuntime } from '../../../lib/world/types'
```

Add a `PROVIDERS` table next to `MANAGED_TYPES` (top of file, after the `MANAGED_TYPES` array):

```tsx
// Phase 4 D10a: the authoring UI defaults to 'aws' (not the store's 'generic' default) so a
// freshly added managed service prices non-zero immediately — see world.store.ts's
// addManagedService, whose own default stays 'generic' for callers that omit the param.
const PROVIDERS: { key: ManagedService['provider']; label: string }[] = [
  { key: 'aws', label: 'AWS' },
  { key: 'gcp', label: 'GCP' },
  { key: 'azure', label: 'Azure' },
  { key: 'generic', label: 'Generic' },
]
```

Add state (next to the existing `msType`/`msScope` state):

```tsx
  const [msType, setMsType] = useState(MANAGED_TYPES[0].key)
  const [msScope, setMsScope] = useState('')
```
→
```tsx
  const [msType, setMsType] = useState(MANAGED_TYPES[0].key)
  const [msScope, setMsScope] = useState('')
  const [msProvider, setMsProvider] = useState<ManagedService['provider']>('aws')
```

Add the `<select>` and thread `msProvider` through as the 5th arg:

```tsx
      <div style={row}>
        <select style={{ ...field, flex: 1, marginBottom: 0 }} value={msType} onChange={e => setMsType(e.target.value)}>
          {MANAGED_TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <select style={{ ...field, flex: 1, marginBottom: 0 }} value={msScope} onChange={e => setMsScope(e.target.value)}>
          <option value="">scope…</option>
          {scopeOptions.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        <button style={smallBtn} disabled={!msScope} onClick={() => {
          const [kind, id] = msScope.split(':')
          store.addManagedService(msType, MANAGED_TYPES.find(t => t.key === msType)?.label ?? msType,
            kind === 'region' ? { kind: 'region', regionId: id } : { kind: 'az', azId: id }, 5432)
        }}>+ Add</button>
      </div>
```
→
```tsx
      <div style={row}>
        <select style={{ ...field, flex: 1, marginBottom: 0 }} value={msType} onChange={e => setMsType(e.target.value)}>
          {MANAGED_TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <select style={{ ...field, flex: 1, marginBottom: 0 }} value={msScope} onChange={e => setMsScope(e.target.value)}>
          <option value="">scope…</option>
          {scopeOptions.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        <select style={{ ...field, width: 74, marginBottom: 0 }} aria-label="provider" value={msProvider}
          onChange={e => setMsProvider(e.target.value as ManagedService['provider'])}>
          {PROVIDERS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        <button style={smallBtn} disabled={!msScope} onClick={() => {
          const [kind, id] = msScope.split(':')
          store.addManagedService(msType, MANAGED_TYPES.find(t => t.key === msType)?.label ?? msType,
            kind === 'region' ? { kind: 'region', regionId: id } : { kind: 'az', azId: id }, 5432, msProvider)
        }}>+ Add</button>
      </div>
```

No `PlacementPanel.test.tsx` exists today (verified — only `BlueprintPanel.test.tsx`/
`TopologyPanel.test.tsx`/`WorldPanel.test.tsx` do) and Phase-3 Task 8 set the precedent of not
adding one when re-keying this same managed-services picker — coverage stays at the store/cost
layer (Step 1's two cases) plus the live smoke in Task 8, which exercises this exact control.

- [ ] **Step 5: Run the two new tests — confirm they pass**

Run: `npx vitest run src/app/store/world.store.test.ts` → PASS (12 tests; 11 existing + 1 new).
Run: `npx vitest run src/lib/costModelV2.test.ts` → PASS (6 tests; 5 existing + 1 new).

- [ ] **Step 6: `ServerBoard.tsx` hygiene — memoize the derived values, scrub-correct the gate counter**

Add `useMemo` to the React import:

```tsx
import { useEffect, useRef, useState, type ReactElement } from 'react'
```
→
```tsx
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
```

Replace the `display`/`events`/`latestBatch`/`gateBlockedPerSecond` block:

```tsx
  const display = useServerDisplayMetrics(serverId)
  const events = useSimulationStore(s => s.events)
  const latestBatch = useSimulationStore(s => s.latestBatch)
  const gateBlockedPerSecond = blockedPerSecond(events, serverId, layout.residentInstanceIds, latestBatch?.simMs ?? 0)
```
→
```tsx
  const display = useServerDisplayMetrics(serverId)
  const events = useSimulationStore(s => s.events)
  const latestBatch = useSimulationStore(s => s.latestBatch)
  const scrubBatch = useSimulationStore(s => s.scrubBatch)
  // D10d/R7: the blocked/s counter must be scrub-correct — read the DISPLAY batch's simMs
  // (scrubBatch ?? latestBatch), not latestBatch unconditionally. Previously the counter kept
  // advancing off the live clock even while the board displayed a scrubbed historical frame.
  const displaySimMs = (scrubBatch ?? latestBatch)?.simMs ?? 0
  const gateBlockedPerSecond = useMemo(
    () => blockedPerSecond(events, serverId, layout.residentInstanceIds, displaySimMs),
    [events, serverId, layout.residentInstanceIds, displaySimMs],
  )
```

Replace the `residentBlueprints`/`attribution`/`memLimits`+`instanceRamMb`/`volumeConsumers` block:

```tsx
  // Resident blueprints for the hardware platform (D4): signature color/name + at-rest ramBaseMb
  // (D5, used when metrics is null).
  const residentBlueprints = layout.chips.map(chip => {
    const bp = doc.blueprints[chip.blueprintId]
    return {
      instanceId: chip.instanceId, blueprintId: chip.blueprintId,
      color: bp?.color ?? '#888', name: bp?.name ?? '?', ramBaseMb: bp?.workload.ramBaseMb ?? 0,
    }
  })

  // Live per-core attribution (D8): dominant blueprint per vCPU from live cpuCoresUsed.
  const attribution: CoreAttribution[] = attributeCores(
    server?.specs.vcpu ?? 0,
    layout.chips.map(chip => ({
      instanceId: chip.instanceId, blueprintId: chip.blueprintId,
      cpuCoresUsed: display.instances[chip.instanceId]?.cpuCoresUsed ?? 0,
    })),
  )

  // Container memLimitMb by instance (oom check) + live per-instance ramMb.
  const memLimits: Record<InstanceId, number> = {}
  for (const chip of layout.chips) {
    const rt = doc.placements[chip.placementId]?.runtime
    if (rt?.type === 'container' && rt.memLimitMb != null) memLimits[chip.instanceId] = rt.memLimitMb
  }
  const instanceRamMb: Record<InstanceId, number> = {}
  for (const chip of layout.chips) {
    const m = display.instances[chip.instanceId]
    if (m) instanceRamMb[chip.instanceId] = m.ramMb
  }

  // Volume -> consumer blueprint id (D8 disk-slice cross-highlight): attribute each volume to
  // the resident blueprint whose volumeName matches it.
  const volumeConsumers: Record<string, string> = {}
  for (const st of server?.stacks ?? []) {
    for (const v of st.volumes) {
      const bp = Object.values(doc.blueprints).find(b => b.volumeName === v.name)
      if (bp) volumeConsumers[v.name] = bp.id
    }
  }
```
→
```tsx
  // Resident blueprints for the hardware platform (D4): signature color/name + at-rest ramBaseMb
  // (D5, used when metrics is null). Memoized (T7 hygiene, Phase-3 carry-forward) — recomputed
  // only when the chip list or blueprint table changes, not on every render/1Hz metrics tick.
  const residentBlueprints = useMemo(() => layout.chips.map(chip => {
    const bp = doc.blueprints[chip.blueprintId]
    return {
      instanceId: chip.instanceId, blueprintId: chip.blueprintId,
      color: bp?.color ?? '#888', name: bp?.name ?? '?', ramBaseMb: bp?.workload.ramBaseMb ?? 0,
    }
  }), [layout.chips, doc.blueprints])

  // Live per-core attribution (D8): dominant blueprint per vCPU from live cpuCoresUsed.
  const attribution: CoreAttribution[] = useMemo(() => attributeCores(
    server?.specs.vcpu ?? 0,
    layout.chips.map(chip => ({
      instanceId: chip.instanceId, blueprintId: chip.blueprintId,
      cpuCoresUsed: display.instances[chip.instanceId]?.cpuCoresUsed ?? 0,
    })),
  ), [server?.specs.vcpu, layout.chips, display.instances])

  // Container memLimitMb by instance (oom check) + live per-instance ramMb. Grouped into one
  // memo — both loops walk the same layout.chips list and feed the same HardwarePlatform props,
  // so memoizing them separately would be an arbitrary split of one logical derivation.
  const { memLimits, instanceRamMb } = useMemo(() => {
    const memLimits: Record<InstanceId, number> = {}
    for (const chip of layout.chips) {
      const rt = doc.placements[chip.placementId]?.runtime
      if (rt?.type === 'container' && rt.memLimitMb != null) memLimits[chip.instanceId] = rt.memLimitMb
    }
    const instanceRamMb: Record<InstanceId, number> = {}
    for (const chip of layout.chips) {
      const m = display.instances[chip.instanceId]
      if (m) instanceRamMb[chip.instanceId] = m.ramMb
    }
    return { memLimits, instanceRamMb }
  }, [layout.chips, doc.placements, display.instances])

  // Volume -> consumer blueprint id (D8 disk-slice cross-highlight): attribute each volume to
  // the resident blueprint whose volumeName matches it.
  const volumeConsumers: Record<string, string> = useMemo(() => {
    const consumers: Record<string, string> = {}
    for (const st of server?.stacks ?? []) {
      for (const v of st.volumes) {
        const bp = Object.values(doc.blueprints).find(b => b.volumeName === v.name)
        if (bp) consumers[v.name] = bp.id
      }
    }
    return consumers
  }, [server, doc.blueprints])
```

Nothing below this point in the file changes — the JSX return block references
`residentBlueprints`/`attribution`/`memLimits`/`instanceRamMb`/`volumeConsumers`/
`gateBlockedPerSecond` by the same names with the same shapes, so every prop passed to
`HardwarePlatform`/`FirewallGate` is byte-identical to before; this is a pure memoization + input
change, not a rendering change.

- [ ] **Step 7: `inspectorForms.tsx` hygiene — stop coalescing meaningful zeros**

`RuntimeForm`:

```tsx
      <NumberField label="cpuLimit" value={rt.cpuLimit ?? 0} onCommit={v => setRt({ cpuLimit: v || null })} />
      <NumberField label="memLimitMb" value={rt.memLimitMb ?? 0} onCommit={v => setRt({ memLimitMb: v || null })} />
```
→
```tsx
      <NumberField label="cpuLimit" value={rt.cpuLimit ?? 0} onCommit={v => setRt({ cpuLimit: Number.isFinite(v) ? v : null })} />
      <NumberField label="memLimitMb" value={rt.memLimitMb ?? 0} onCommit={v => setRt({ memLimitMb: Number.isFinite(v) ? v : null })} />
```

`FirewallEditor`'s port input:

```tsx
          <input aria-label="port" style={{ ...inp, width: 40 }} value={String(r.port)} onChange={e => patch(i, { port: e.target.value === 'any' ? 'any' : (Number(e.target.value) || 'any') })} />
```
→
```tsx
          <input aria-label="port" style={{ ...inp, width: 40 }} value={String(r.port)} onChange={e => {
            const raw = e.target.value
            if (raw === 'any' || raw === '') { patch(i, { port: 'any' }); return }
            const n = Number(raw)
            patch(i, { port: Number.isFinite(n) && n >= 0 ? n : 'any' })
          }} />
```

The blank-input branch is kept explicit (clearing the field still resolves to `'any'`, matching
today's UX) — only a genuinely-typed `0` (or any other finite ≥0 number) now survives as that
number instead of being falsy-coalesced away. `NumberField` itself is untouched (its own
`onBlur` already does the correct `Number.isFinite(n) && n >= 0` check — the bug was only in the
two call sites above, both of which used `v || null` / `Number(...) || 'any'` after that guard
already ran).

- [ ] **Step 8: `FirewallGate.tsx` — verify, no edit**

Open the file and confirm it contains no `simMs`/store read of its own — it only destructures
`blockedPerSecond` from props and renders it (`✕ {blockedPerSecond…}/s blocked` when `> 0`). The
R7 scrub-correctness fix is entirely upstream in `ServerBoard.tsx` (Step 6); this file needs no
change. Do not stage a no-op diff.

- [ ] **Step 9: `PacketLayer.tsx` hygiene — geometry-throw fallback**

```tsx
    const pathCache = new Map<string, SVGPathElement>()
    const svgNS = 'http://www.w3.org/2000/svg'
    const pointAt = (fromId: string, toId: string, progress: number) => {
      const key = `${fromId}→${toId}`
      let path = pathCache.get(key)
      if (!path) {
        const d = layout.tracePath(fromId, toId)
        if (!d) return null
        path = document.createElementNS(svgNS, 'path')
        path.setAttribute('d', d)
        pathCache.set(key, path)
      }
      const len = path.getTotalLength?.() ?? 0
      if (!len) return null
      return path.getPointAtLength(len * progress)
    }
```
→
```tsx
    const pathCache = new Map<string, SVGPathElement>()
    const svgNS = 'http://www.w3.org/2000/svg'
    // D10e (Phase-3 carry-forward): getPointAtLength (and, defensively, getTotalLength) can throw
    // in some native WebView SVG implementations — never verified against an actual native Tauri
    // build (documented Phase-3 open item). A thrown geometry call must never crash the frame
    // loop; fall back to a straight-line lerp between the trace's two cached anchors — visually
    // close enough for a single degraded frame, and cheap (anchorFor is a plain lookup).
    const pointAt = (fromId: string, toId: string, progress: number): { x: number; y: number } | null => {
      const key = `${fromId}→${toId}`
      let path = pathCache.get(key)
      if (!path) {
        const d = layout.tracePath(fromId, toId)
        if (!d) return null
        path = document.createElementNS(svgNS, 'path')
        path.setAttribute('d', d)
        pathCache.set(key, path)
      }
      try {
        const len = path.getTotalLength?.() ?? 0
        if (!len) return null
        return path.getPointAtLength(len * progress)
      } catch {
        const a = layout.anchorFor(fromId)
        const b = layout.anchorFor(toId)
        if (!a || !b) return null
        return { x: a.x + (b.x - a.x) * progress, y: a.y + (b.y - a.y) * progress }
      }
    }
```

The explicit `{ x: number; y: number } | null` return annotation is required so both branches
(the native `DOMPoint` from `getPointAtLength` and the plain-object lerp fallback) unify to one
type — `DOMPoint` is structurally assignable to `{x,y}` (it has `x`/`y`/`z`/`w`, all numbers), so
this compiles under strict tsc with no cast. `pathCache`'s per-attach rebuild (a Phase-3 Task-5
fix) and every call site (`ctx.arc(pt.x, pt.y, …)`) are unaffected — callers only ever read
`.x`/`.y`.

- [ ] **Step 10: Full verification**

Run: `npx vitest run src/app/store/world.store.test.ts` → PASS (12 tests).
Run: `npx vitest run src/lib/costModelV2.test.ts` → PASS (6 tests).

Re-run the existing suites the hygiene edits must NOT change (behavior-neutral — memoization,
explicit finite-checks, and a try/catch fallback are not new behavior on any path these suites
already exercise; per the skeleton, no throwaway tests are added for them):

Run: `npx vitest run src/app/world/server/ServerBoard.test.tsx` → PASS (5 tests, unchanged) — the
regression guard for the memoization + scrub-correct-simMs edit (Step 6). None of these 5 cases
assert on `gateBlockedPerSecond`'s scrub behavior specifically (there is no scrubbing in this
file's fixtures) — they prove the board still renders every zone correctly with the same derived
values, which is exactly what a behavior-preserving refactor should leave unchanged.
Run: `npx vitest run src/app/world/server/InspectorRail.test.tsx` → PASS (11 tests, unchanged) —
covers `inspectorForms.tsx` (there is no separate `inspectorForms.test.tsx`; its forms are
exercised here, per `docs/module-boundaries.md` §L). Confirms `RuntimeForm`/`FirewallEditor`
still commit correctly for the non-zero values these tests already use.
Run: `npx vitest run src/app/world/server/gateStats.test.ts` → PASS (5 tests, unchanged) — pure
unit tests of `blockedPerSecond` itself (untouched by Step 6; only its caller's `nowSimMs`
argument changed).
Run: `npx vitest run src/app/world/server/PacketLayer.test.tsx` → PASS (2 tests, unchanged) —
both tests mock `attachRenderer` entirely and never invoke `pointAt`, so they only prove
attach/detach still works after the Step 9 edit, not the fallback path itself (there is no
practical way to make jsdom's `SVGPathElement.getPointAtLength` throw without reaching into
happy-dom/jsdom internals — the fallback is defensive insurance for a native-WebView failure
mode this project cannot reproduce in jsdom; it remains unverified in a real Tauri build, same as
before this task).

Run: `npm run build` → succeeds (strict tsc + vite).
Run: `npx vitest run` → **276 tests green** (274 baseline + 2 new from Step 1; confirm the exact
number against the repo's current state before committing — it was 274/46 files at the time this
fragment was written, immediately after Phase 3 merged to main at `c7771d0`).

**Live verification:** no separate live-smoke gate is defined for this task (the skeleton names
one for T2/T3/T5/T6 but not T7 or T8's sibling pure-module tasks). The provider `<select>` this
task adds IS a real, on-screen UI control, so it should not go completely unverified outside unit
tests — Task 8's phase-gate live smoke (Step 3 there) adds one extra beat exercising it end to
end (author a managed service via the new selector, confirm the Cost tab prices it). Flagged
there as an addition beyond the spec's literal phase-gate story.

- [ ] **Step 11: Commit**

```bash
git add src/app/store/world.store.ts src/app/store/world.store.test.ts \
        src/app/world/panels/PlacementPanel.tsx src/lib/costModelV2.test.ts \
        src/app/world/server/ServerBoard.tsx src/app/world/server/inspectorForms.tsx \
        src/app/world/server/PacketLayer.tsx
git commit -m "fix(world): managed-service provider selection + server-view hygiene carry-forwards"
```

(`FirewallGate.tsx` is intentionally absent from this list — Step 8 verified it needs no change.)

---

## Task 8: Final integration, phase smoke, `docs/module-boundaries.md` §M `[sonnet]`

**Files:** modify `docs/module-boundaries.md` (append §M); modify `.superpowers/sdd/progress.md`
(append `## PHASE 4`); no source changes except whatever Step 2 turns up.

**Precondition:** Tasks 1–7 are committed on `phase4-region-rack`. This task is the phase's final
gate — it verifies the whole branch, not just T7's diff. Mirrors Phase 3's Task 9
(`phase3/fragments/tasks-06-09.md`), which is the structural precedent for this task's shape.

- [ ] **Step 1: Fix queued Minors**

Check each of T1–T7's own completion notes (whatever the controller/implementer logged per-task
during actual execution — analogous to how Phase 3's T4 queued a `HEALTH_COLOR` dedup that T9
picked up) for anything flagged as deferred-to-final-integration, and apply the trivial/safe ones
here. At minimum, confirm the following Phase-3-backlog items (`progress.md`'s "OPEN ITEMS for
Phase 4 / backlog") are now resolved by this phase's actual work, and record their disposition in
Step 5's ledger entry — don't leave the ledger vague:

| Backlog item | Expected disposition after T1–T7 |
|---|---|
| `addManagedService` hardcodes `provider:'generic'` → managed services price $0 | **RESOLVED** (T7) |
| Falsy-zero coalescing (`port 0→'any'`, `cpuLimit`/`memLimitMb 0→null`) | **RESOLVED** (T7) |
| `ServerBoard` derived values unmemoized | **RESOLVED** (T7) |
| Gate block counter not scrub-aware | **RESOLVED** (T7) |
| `AzSimOverlay` re-subscribes the renderer on every pan/zoom (Phase-2 standing deferral) | **RESOLVED** (T6, per D9) — confirm `AzSimOverlay.tsx`'s effect deps are exactly `[running, azId, reduced]` before crediting this |
| Overflow residents (>12 chips) not color-attributed | **STILL OPEN** — out of scope this phase, not touched by any T1–T7 task |
| `getPointAtLength` unverified in a native Tauri build | **MITIGATED, NOT VERIFIED** (T7 added a try/catch + lerp fallback; no native `tauri build` smoke exists to actually exercise the throw path) |
| Fold hop latency into instance p50/p99; `applyNicCap` shed/queue; per-step grouping-map caching (Phase-2 standing deferrals) | **STILL OPEN** — engine-side, out of scope (Global Constraints forbid `worldEngine/` changes this phase anyway) |

- [ ] **Step 2: Full verification battery**

Run: `npx vitest run` → **ALL suites green — record the exact count** (baseline 274 before this
phase's T1–T6 add their own new test files/cases, +2 from T7 Step 1; the true final number
depends on T1–T6's actual test counts as executed — do not hardcode a number here, report what
the run actually prints).
Run: `npm run build` → succeeds (strict tsc + vite).

If either fails, stop and fix before proceeding — Step 3's live smoke assumes a green, buildable
tree.

- [ ] **Step 3: Full end-to-end live smoke — the phase gate (controller-run, port 1420)**

This is the spec's (`2026-07-09-phase4-region-rack-design.md`, "Testing & verification") gating
story end-to-end, plus one addition (marked below) exercising T7's provider selector, which the
spec's story doesn't otherwise touch. Zero console errors throughout is a hard requirement, not a
nice-to-have — treat any red console line as a blocking bug, not a note.

1. `npm run dev` (background); wait for `Local:   http://localhost:1420/`.
2. `browser_navigate` → `http://localhost:1420`; `browser_click` "New World".
3. Author a 2-AZ region under load, via the real UI (Topology/Blueprints/Placements tabs,
   established across Phases 2–3) plus the `window.__scalemapDebug` DEV hook only where the UI
   still can't author something (population traffic, per Phase 2/3 precedent):
   - Topology: add region `us-east-1` → two AZs (`us-east-1a`, `us-east-1b`) → 2–3 servers per AZ
     (`vps-medium`/`dedicated-8` presets).
   - Blueprints: a `web` blueprint with a public port; an entry-tier dependency chain deep enough
     to generate real cross-AZ traffic once populations are added.
   - Placements: place `web` (and its dependencies) across both AZs' servers.
   - **[Addition, exercising T7]** Managed services: using the new provider `<select>` added in
     Task 7, add one `dbSql` managed service scoped to `us-east-1a` with provider **`aws`** (the
     UI's default) — leave it at the default, don't change it, to prove the default itself prices.
   - Populations: author via `window.__scalemapDebug.useWorldStore.getState().addPopulation(...)`
     with enough `peakRps` to drive visible load (Phase 2/3 precedent — no population-authoring
     UI exists yet).
4. Open the Cost tab — confirm the `dbSql`/`aws` managed service from step 3 contributes a
   non-zero line (proves T7's provider selector end-to-end, not just unit-level).
5. Navigate to the region view (Level 2). `browser_snapshot` — confirm: header shows
   `<catalogId> · 2 AZs · <n> servers · <k> service instances` + routing/health-interval chips;
   `AlertRibbon` slot present but empty (no alert yet); inbound column shows a nonzero rps +
   moving sparkline; `SplitLines` shares sum to ~100% across the two AZ rows; each `AzRow` shows a
   health ring, per-server strips with visible height (mean coreUtilization), and a `$<n>/mo`
   figure; `CrossAzColumn` shows the `1a ⇄ 1b` pair with the `1.5`ms cross-AZ latency figure.
6. Click `us-east-1b`'s row outage switch (⚡). `browser_snapshot` — confirm: `AlertRibbon`
   appears with a redistribution message naming `us-east-1a`; the split re-shares toward ~100%
   `1a`/~0% `1b`; `1b`'s row dims, shows the red left border, and swaps its strips for the drain
   line (`draining → us-east-1a` [`· replicas promoting`] if any stateful blueprint has a replica
   there); `TimelineStrip` logs `outage_triggered`/`health_check_failed`/failover-adjacent events.
7. Click "Stop" (`SimControls`). Click an event glyph on `TimelineStrip`. `browser_snapshot` —
   confirm `ScrubberV2` shows a scrubbed state (not "live") and the region page's numbers now
   reflect that historical frame (ring scores / strips / $ figures change from the live-stopped
   snapshot to the scrubbed one).
8. Navigate into `us-east-1a`'s AZ canvas (Level 3, still scrubbed or re-run live — either
   demonstrates the rack chassis). `browser_snapshot` — confirm: server nodes are now rack
   **frames** (not flat cards) with stacked **chassis** at varying U-heights, rail dot pattern,
   `RACK <id> · <az label>` caption, blank-U filler strips where units are gapped, a `PDU · <n>kW`
   strip; each chassis shows the LED trio, drive-bay grid, vent grill, and cpu/ram/io micro-bars;
   if simulating live, confirm the micro-bars/LEDs are actually animating (re-`Simulate` if still
   scrubbed, to see this on real live data at least once). Managed node still dashed-border.
9. Click a chassis. `browser_snapshot` — confirm navigation lands on that server's Level-4 board
   (unchanged from Phase 3 — proves `worldChassis` click routing survived the T5 rewire).
10. Pan and zoom the AZ canvas continuously for several seconds while simulating — confirm (via
    `browser_console_messages` and visual inspection) particles keep tracking chassis positions
    with no drift and the renderer does not visibly stutter/reset (T6's no-re-subscribe fix).
11. `browser_console_messages` at each of the above milestones → assert ZERO error-level entries
    across the whole run (benign Vite HMR WS blips excepted, per established precedent).
12. `browser_take_screenshot` at steps 5, 6, 7, 8, 9 → save to
    `.superpowers/sdd/screenshots/phase4/` (create the directory if absent):
    `region-under-load.png`, `region-az-down.png`, `region-scrubbed.png`, `az-rack-chassis.png`,
    `server-interior-from-chassis.png`.
13. Stop the dev server.

- [ ] **Step 4: `docs/module-boundaries.md` — append §M**

Append after §L (Server interior board) and before "## 2. Shared "hub" files". Read the actual
T1–T6 source first and correct any prose below that drifted from what was really built (this is
a draft grounded in the skeleton + design spec, written before T1–T6 exist as code — reconcile,
don't transcribe blindly):

```markdown
---

### M. Region flow page & rack chassis — Phase 4 Levels 2–3 (`src/app/world/region/`, `src/lib/world/layoutRacks.ts`, `src/app/world/RackNodes.tsx`, 2026-07-09)

Replaces the Phase-1 placeholder `RegionView` with the Level-2 flow story (global-edge inbound →
animated split lines → AZ rows → cross-AZ column, one alert ribbon, a failover timeline, per-AZ
outage switches) and replaces the Level-3 AZ canvas's flat server cards with realistic rack-frame
groups of chassis (Task 5/6). Built across Tasks 1–6; Task 7 (§1J's `world.store.ts`/
`PlacementPanel.tsx` rows) and this task (integration) close out the phase. Spec:
`docs/superpowers/specs/2026-07-09-phase4-region-rack-design.md`.

| File | Role |
|---|---|
| `src/app/world/region/regionData.ts` (Task 1) | Pure selectors the whole region page derives from: `azShares` (per-AZ fraction of region rps, down AZs pinned to 0), `ribbonAlert` (most-severe recent region-scoped event, formatted with redistribution targets), `regionEvents` (events scoped to the region/its AZs/servers/resident instances/routed populations), `replicationPairs` (primary/replica pairs across this region's AZs), `crossAzEntries` (AZ-pair latency + replication, using a **local mirrored constant** `CROSS_AZ_HOP_MS = 1.5` — see the Frozen-contract note below, this is NOT an import from `worldEngine/`), `sparklineSeries`, `dominantBlueprintColor`. No React, no store reads — same "pure hub" shape as `server/boardLayout.ts` (§L) |
| `src/app/world/region/AlertRibbon.tsx`, `SplitLines.tsx`, `AzRow.tsx`, `CrossAzColumn.tsx` (Task 2) | The flow page's four visual sections, each a presentation component reading no store directly — `RegionView.tsx` computes everything from `regionData.ts` + `useSimulationStore`/`useWorldStore`/`useCompiledWorld` and passes it down as props |
| `src/app/world/region/TimelineStrip.tsx` (Task 3) | Failover timeline — region-scoped events on a simMs axis; click-to-scrub when stopped (`setScrubIndex`), inert while running |
| `src/app/world/RegionView.tsx` (Task 2, REWRITTEN) | Composition root: header + `AlertRibbon` + inbound/`SplitLines`/`AzRow`-stack/`CrossAzColumn` flow row + `TimelineStrip`. Preserves the existing Phase-2 region-outage button verbatim (`healthOverrides`/`setOutage('region', …)`) |
| `src/lib/world/layoutRacks.ts` (Task 4) | Pure rack-frame layout — the Level-3 analog of `server/boardLayout.ts` (§L): groups `Server`s by `rack.rackId` into frames, stacks chassis by `rack.unit` (height = `heightU × U_PX`), blank-unit fillers, PDU strip, a separate managed-service column. Deterministic; imported by both `AzCanvas.tsx` and `RackNodes.tsx`. Replaces `layoutAzGrid` for the AZ canvas |
| `src/lib/world/layoutAz.ts` — **DELETED (Task 5)** | `layoutAzGrid`'s only caller (`AzCanvas.tsx`) was rewired to `layoutRacks` in Task 5; grep-verified zero remaining importers before deletion. Superseded, not ported — its grid-position algorithm has no successor because rack framing replaces the whole positioning model, not just the numbers |
| `src/app/world/RackNodes.tsx` (Task 5) | `RackFrameNode` (non-interactive backdrop: rails, caption, filler strips, PDU) + `RackChassisNode` (LED trio, drive-bay grid, vent grill, cpu/ram/io micro-bars, noisy-neighbor tag, blocked-path badge) + `WorldManagedNode` (moved here verbatim from the deleted `WorldServerNode.tsx`, dashed-border managed-service node, unchanged visuals). **`RackNodes.tsx` owns all chassis chrome** — `AzCanvas.tsx` only positions nodes (via `layoutRacks`) and aggregates edges; it renders no chassis-internal markup itself |
| `src/app/world/WorldServerNode.tsx` — **DELETED (Task 5)** | `WorldServerNode` (flat server card) had no more callers once Task 5 rewired `AzCanvas.tsx` to `RackFrameNode`/`RackChassisNode`; `WorldManagedNode` was moved (not duplicated) into `RackNodes.tsx` before deletion — grep-verified no other importer existed (Phase-3 files reference the node TYPE STRINGS `'worldManaged'`/etc. in `AzSimOverlay.tsx`, not this file, and were updated to the new type strings in Task 6) |
| `src/app/world/AzCanvas.tsx` (Task 5, rewired) | Same edge-aggregation logic as Phase 1–3 (copied verbatim — `compiled.paths` → one aggregate edge per server pair, `internalBlockedByServer`, same-server-skip), but node-building now goes through `layoutRacks`: frames as React Flow parent nodes (`type: 'worldRackFrame'`, non-selectable, `zIndex: -1`), chassis as `parentId`-linked children (`extent: 'parent'`), managed nodes absolute. `worldChassis` click still routes to `goServer` |
| `src/app/world/AzSimOverlay.tsx` (Task 6, v2) | Switched from `getNode(id).position` + `useViewport()`-in-effect-deps to `getInternalNode(id).internals.positionAbsolute` (works through parent/child nesting) + `node.measured?.width/height` (falls back to the old fixed constants pre-paint, since chassis heights now vary by `heightU`) + an imperative `getViewport()` read **inside** the frame callback. Effect deps are now `[running, azId, reduced]` only — **this closes the Phase-2/3 standing "re-subscribes on every pan/zoom" deferral** (previously `useViewport()` sat in the deps array, causing a re-subscribe on every pan/zoom tick) |
| `src/app/store/world.store.ts` (Task 7) | `addManagedService` gained a 5th, optional `provider` parameter (`ManagedService['provider']`, default `'generic'` — additive, every pre-existing 4-arg call site is unaffected) |
| `src/app/world/panels/PlacementPanel.tsx` (Task 7) | Managed-service authoring gained a provider `<select>` (`aws`/`gcp`/`azure`/`generic`, UI default `'aws'` — deliberately different from the store's own `'generic'` default, so a freshly authored managed service prices non-zero without the user having to know to change it) |
| `src/app/world/server/{ServerBoard,inspectorForms,PacketLayer}.tsx` (Task 7, hygiene) | Behavior-preserving carry-forwards from the Phase-3 backlog: `ServerBoard.tsx` memoizes its five per-render derived values and reads the blocked/s counter's simMs from `scrubBatch ?? latestBatch` (scrub-correct); `inspectorForms.tsx` stops falsy-zero-coalescing a legitimately-typed `0` in the port/cpuLimit/memLimitMb fields; `PacketLayer.tsx` wraps its SVG geometry calls in try/catch with a linear-interpolation fallback. `FirewallGate.tsx` needed no change (pure presentational, verified) |

**Boundary rules:** `src/app/world/region/*` imports only `lib/` (world types,
`worldEngine/types` for **type-only** imports — `MetricsBatch`/`EngineEvent`/`ReplayFrame`/
`HealthState`, never a value/executable import) and app stores (`useSimulationStore` — read
`scrubBatch`/`latestBatch`/`events`/`running`, call `setOutage`/`setScrubIndex`;
`useWorldStore` — read `doc`; `useNavStore` — navigation callbacks passed down as props), plus
the ONE local constant `CROSS_AZ_HOP_MS` in `regionData.ts` — a documented, manually-synced
mirror of `worldEngine/networkRuntime.ts`'s private `CROSS_AZ_MS`, **not** an import (see the
Frozen-contract note below and `.superpowers/sdd/contract-drift.md` §PHASE 4 item 8). Like
`server/` (§L), nothing in `region/` imports `worldEngine/index.ts` (the executable facade)
directly — only `useSimulationStore` does that; the seam established in §K holds for a second
feature module in a row. `RackNodes.tsx` owns all chassis/frame/managed-node chrome; `AzCanvas.tsx`
and `layoutRacks.ts` only compute positions and aggregate edges, never render chassis internals.
`layoutAz.ts` is gone — nothing outside git history depends on `layoutAzGrid` anymore.

**Frozen-contract note:** `regionData.ts`'s `CROSS_AZ_HOP_MS = 1.5` is a **local mirror**, not an
import, of `worldEngine/networkRuntime.ts:10`'s private (non-exported) `CROSS_AZ_MS` — the design
spec's D5 named `worldEngine/latency.ts` as the source, but that file exports no such constant
(it's a function-only module); exporting the real constant would be a code change under
`worldEngine/`, which this phase's Global Constraints forbid. If the engine ever varies cross-AZ
latency, this mirror must be updated by hand (or the engine can additively export the constant,
at which point the mirror becomes a real import — additive, no reshape). Logged in
`.superpowers/sdd/contract-drift.md` §PHASE 4 item 8 — this doc entry doesn't restate the
reasoning, just cross-references it.

**Blast radius:** `layoutRacks.ts`'s `RackLayout`/`RackFrame` types fan out to `AzCanvas.tsx` and
`RackNodes.tsx` only (two consumers) — extend additively. `regionData.ts`'s exported types
(`AzShare`/`RibbonAlert`/`ReplicationPair`/`CrossAzEntry`) fan out to `RegionView.tsx` and the
four `region/` components — same extend-don't-reshape rule as `boardLayout.ts` (§L).
`world.store.ts`'s `addManagedService` now has two call sites (`PlacementPanel.tsx`, plus
whatever test fixtures call it directly) — the new param is optional/defaulted, so no existing
caller needed to change.
```

- [ ] **Step 5: Append the `## PHASE 4` ledger to `.superpowers/sdd/progress.md`**

Follow the exact structure of the `## PHASE 2`/`## PHASE 3` sections already in this file: a
`## PHASE 4 — Region flow page + rack chassis` heading, `Plan:`/`Branch:` lines, then one line per
task (`Task 1: complete (commits …, review …; <notable findings>)` — using the REAL commit hashes
and REAL findings from T1–T7's actual execution, not placeholders), then a `PHASE 4 COMPLETE`
block modeled on Phase 3's (final-review verdict, DONE BAR checklist, task commit chain, open
items for Phase 5). Two things must appear, precisely, regardless of what else T1–T6 turned up:

1. **Drift state** — cite `contract-drift.md`'s already-logged `## PHASE 4` / item 8 (the
   `CROSS_AZ_HOP_MS` local-mirror resolution, R1/Task 1) as the phase's only drift entry, and
   state explicitly that it is a **RESOLVED, view-side deviation from the plan text — not an
   engine or frozen-contract change** (no code under `src/lib/worldEngine/` was touched). This
   matches the skeleton's own expectation ("no drift entries" beyond this one).
2. **Phase-3 backlog disposition** — transcribe Step 1's table (which backlog items got resolved
   by which task, which remain open for Phase 5) so a future reader doesn't have to re-derive it
   from T7's commit alone.

Also carry forward, unresolved, into the "OPEN ITEMS for Phase 5" line: the mockup's
`recovery in 41s` timer and numeric replication lag (D4/D5, parked — no engine surface exists),
r3f globe (Phase 5 proper), analysis/LLM reviewer (Phase 6), overflow-resident color attribution,
and the Phase-2 engine-side deferrals that remain untouched (hop-latency-in-p50/p99, NIC
shed/queue, per-step grouping-map caching) — none of these are Phase-4 regressions, all were
already-known deferrals this phase didn't claim to fix.

- [ ] **Step 6: Commit**

```bash
# NOTE: .superpowers/ is gitignored (scratch) — do NOT `git add` progress.md (it would error on an
# ignored path, and Phases 1–3 never committed the ledger either). The §M doc is the only tracked
# change here; the progress.md ledger append (Step 5) lives on disk as scratch, uncommitted.
git add docs/module-boundaries.md
git commit -m "docs: update module boundaries for region flow page and rack chassis (§M)"
```

