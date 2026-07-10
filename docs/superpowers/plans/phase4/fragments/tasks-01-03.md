# Phase 4 plan fragment — Tasks 1–3 (pure region-data module · region flow page · failover timeline)

> Fragment scope: Task 1 (`regionData.ts` pure selectors), Task 2 (region flow page — alert
> ribbon, split lines, AZ rows, cross-AZ column, `RegionView` rewrite), Task 3 (failover
> timeline strip + click-to-scrub). Global Constraints / File Structure live in the skeleton's
> assembled header (`docs/superpowers/plans/phase4/skeleton.md`) — not repeated here.
>
> **RULING R1 governs Task 1's `crossAzEntries`:** its cross-AZ latency constant is a LOCAL
> `CROSS_AZ_HOP_MS = 1.5`, NOT an import from `latency.ts` (D5's named source has no such
> export — see Task 1 Step 4 for the full ruling text). **R2** governs color sourcing
> throughout: semantic health/severity → `var(--color-success|--color-warning|--color-danger)`;
> pure scene chrome and alpha-tinted status variants (which aren't expressible as a plain
> `var()` substitution) → local hex consts per file, same carve-out Phase 3's
> `FirewallGate.tsx` `AMBER` constant already established. **R3** governs the sparkline poll
> (gate the 1 Hz interval on `running`; read once when stopped). **R4** governs per-AZ dollars
> (`computeWorldCost(doc, batch?.world ?? null).byAz.find(...)`). **R5** governs the timeline
> axis (last `120_000` simMs ending at the display batch's simMs, or the newest event when no
> batch).
>
> **Verification note:** every file below was written into an isolated scratch harness (real
> copies of `src/lib/world/*`, `src/lib/worldEngine/*`, the three stores, `costModelV2`,
> `cloudRegistry`, `nodeConfig`, `theme`, `regionConfig`) and compiled with the project's exact
> `tsconfig.json` (`strict`, `noUnusedLocals`, `noUnusedParameters`) — zero errors — then run
> with real `vitest`: **21/21 tests pass** (11 + 6 + 4), including against the intermediate
> Task-2-only state (before `TimelineStrip.tsx` exists). This is reported so the reviewer knows
> the code in this fragment is real and exercised, not hand-waved; the steps below still walk
> through it as normal TDD (write test → verify red → implement → green).

**Shared local scene constants introduced across these three tasks** (each component declares
only what it uses — no new global tokens per R2): `TEAL = '#2DD4BF'` (inbound glyph/rps/
sparkline in `RegionView`, healthy strokes in `SplitLines`), `DOWN_RED = '#EF4444'`
(`SplitLines`' down stub), AZ-row chrome `ROW_BG = '#12151C'` / `ROW_BORDER = '#232833'` /
`RING_TRACK = '#1E2430'` / `STRIP_TRACK = '#1E2430'` (`AzRow`), timeline chrome
`TRACK_BG = '#1E2430'` / `TRACK_BORDER = '#232833'` (`TimelineStrip`). Alpha-tinted status
variants (`#EF444412`/`#EF444433`/`#FCA5A5`, `#F59E0B12`/`#F59E0B33`/`#FDE68A`) are local per
R2 — they aren't a plain `var()` substitution.

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
