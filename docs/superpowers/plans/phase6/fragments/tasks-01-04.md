# Phase 6 plan fragment — Tasks 1–4 (analysis core + structural / network / capacity rule
# families + the Analysis tab)

> Fragment scope: Task 1 (`src/lib/analysis/` core: `types.ts`, `runAnalysis.ts`, `rules/structural.ts`,
> shared `__fixtures__/worlds.ts`), Task 2 (`rules/network.ts`), Task 3 (`rules/capacity.ts`), Task 4
> (`AnalysisTab.tsx` + `WorldPanel.tsx` rewire). Global Constraints / File Structure live in the
> assembled plan header — not repeated here. Every signature and DECISION below is grounded in
> `docs/superpowers/plans/phase6/GROUNDING.md` §A–G (verified against real source at `ee51f6a`). The
> rules are PURE; they read only `doc` + `compiled` (+ optional `lastBatch`) and import nothing from
> `app/`. Controller-authored (the first two sonnet fragment-writers for this range died mid-run with
> no output; this is the reliable controller-written replacement).

---

## Task 1: Analysis core + structural family `[sonnet]`

**Files:** create `src/lib/analysis/types.ts`, `src/lib/analysis/runAnalysis.ts`,
`src/lib/analysis/rules/structural.ts`, `src/lib/analysis/rules/structural.test.ts`,
`src/lib/analysis/__fixtures__/worlds.ts`.

**Grounding:** `compileWorld(doc)` → `CompiledWorld { instances:Record<InstanceId,ServiceInstance>;
paths:CompiledPath[]; routing:CompiledRouting; findings:CompileFinding[] }`;
`ServiceInstance { id; blueprintId; placementId; serverId; azId; regionId; role:'primary'|'replica'|'canary'; indexInPlacement }`;
`compiled.routing.populationRegionOrder:Record<PopulationId,RegionId[]>`;
`ServiceBlueprint { id; name; dependencies:BlueprintDependency[]; stateful; ports; ... }`;
`BlueprintDependency.target = {kind:'blueprint';blueprintId} | {kind:'managed';managedServiceId}`;
`dep.protocol:'http'|'db'|'event'|'stream'`. Factories (`src/lib/world/factories.ts`):
`createWorld/createRegion/createAz/createServer/createBlueprint/createPlacement/createPopulation`;
`getPreset(id)` from `instanceCatalog`. See GROUNDING §A/§B for the verbatim shapes.

- [ ] **Step 1: Write the shared fixtures builder `src/lib/analysis/__fixtures__/worlds.ts`**

A thin builder over the real factories (mirrors the `index.test.ts` style, GROUNDING §B) so every rule
test builds a minimal `WorldDoc` + `compileWorld(doc)` with little boilerplate. Returned entities are
mutated directly by tests (set `bp.stateful`, `pl.role`, `dep`s, firewall, container runtime).

```ts
// src/lib/analysis/__fixtures__/worlds.ts
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement, createPopulation,
} from '../../world/factories'
import { getPreset } from '../../world/instanceCatalog'
import { compileWorld } from '../../world/compileWorld'
import type {
  WorldDoc, Region, AvailabilityZone, Server, ServiceBlueprint, Placement, ClientPopulation,
} from '../../world/types'

export interface Scenario {
  doc: WorldDoc
  region(catalogId: string): Region
  az(regionId: string, label: string): AvailabilityZone
  server(azId: string, presetId?: string): Server
  blueprint(name: string, colorIndex?: number): ServiceBlueprint
  placement(blueprintId: string, serverId: string): Placement
  population(label: string, lat: number, lon: number): ClientPopulation
  compile(): ReturnType<typeof compileWorld>
}

// autoBaseline is disabled so tests exercise only what they author.
export function scenario(): Scenario {
  const doc = createWorld()
  doc.traffic.autoBaseline = false
  return {
    doc,
    region(catalogId) { const r = createRegion(catalogId); doc.regions[r.id] = r; return r },
    az(regionId, label) { const a = createAz(regionId, label); doc.azs[a.id] = a; return a },
    server(azId, presetId = 'dedicated-8') { const s = createServer(azId, getPreset(presetId)!); doc.servers[s.id] = s; return s },
    blueprint(name, colorIndex = 0) { const b = createBlueprint(name, colorIndex); doc.blueprints[b.id] = b; return b },
    placement(blueprintId, serverId) { const p = createPlacement(blueprintId, serverId); doc.placements[p.id] = p; return p },
    population(label, lat, lon) { const p = createPopulation(label, lat, lon); doc.populations[p.id] = p; return p },
    compile() { return compileWorld(doc) },
  }
}

// Helper: a blueprint dependency object (blueprint→blueprint).
export function dep(id: string, blueprintId: string, protocol: 'http' | 'db' | 'event' | 'stream', port = 8080) {
  return { id, target: { kind: 'blueprint' as const, blueprintId }, port, protocol, packetTemplateId: null }
}
```

- [ ] **Step 2: Write the failing test `src/lib/analysis/rules/structural.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { scenario, dep } from '../__fixtures__/worlds'
import { runAnalysis } from '../runAnalysis'
import type { AnalysisFinding } from '../types'

const ids = (fs: AnalysisFinding[], ruleId: string) => fs.filter(f => f.ruleId === ruleId)
const run = (s: ReturnType<typeof scenario>) => runAnalysis(s.doc, s.compile(), null)

describe('structural: single-az-region', () => {
  it('fires when every instance of a region is in one AZ', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const srv = s.server(az.id); const bp = s.blueprint('web'); s.placement(bp.id, srv.id)
    const f = ids(run(s), 'single-az-region')
    expect(f).toHaveLength(1)
    expect(f[0].severity).toBe('warning')
    expect(f[0].affected).toEqual([r.id, az.id])
  })
  it('silent when the region spans two AZs', () => {
    const s = scenario()
    const r = s.region('us-east-1')
    const a1 = s.az(r.id, 'us-east-1a'); const a2 = s.az(r.id, 'us-east-1b')
    const bp = s.blueprint('web')
    s.placement(bp.id, s.server(a1.id).id); s.placement(bp.id, s.server(a2.id).id)
    expect(ids(run(s), 'single-az-region')).toHaveLength(0)
  })
})

describe('structural: no-failover-region', () => {
  it('fires (critical) for a population with a single-region order', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    s.placement(s.blueprint('web').id, s.server(az.id).id)
    const pop = s.population('nyc', 40.7, -74)
    const f = ids(run(s), 'no-failover-region')
    expect(f).toHaveLength(1)
    expect(f[0].severity).toBe('critical')
    expect(f[0].affected).toEqual([pop.id, r.id])
  })
  it('silent when the population has two regions to route to', () => {
    const s = scenario()
    const r1 = s.region('us-east-1'); s.az(r1.id, 'us-east-1a')
    const r2 = s.region('eu-west-1'); s.az(r2.id, 'eu-west-1a')
    s.population('nyc', 40.7, -74)
    expect(ids(run(s), 'no-failover-region')).toHaveLength(0)
  })
})

describe('structural: replicas-colocated', () => {
  it('fires when a stateful primary and all replicas share an AZ', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id); const s2 = s.server(az.id)
    const db = s.blueprint('db'); db.stateful = true
    const p = s.placement(db.id, s1.id) // primary by default
    const rep = s.placement(db.id, s2.id); rep.role = 'replica'
    const f = ids(run(s), 'replicas-colocated')
    expect(f).toHaveLength(1)
    expect(f[0].affected[0]).toBe(db.id)
    expect(f[0].affected[1]).toBe(az.id)
  })
  it('silent when a replica lives in another AZ', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const a1 = s.az(r.id, 'us-east-1a'); const a2 = s.az(r.id, 'us-east-1b')
    const db = s.blueprint('db'); db.stateful = true
    s.placement(db.id, s.server(a1.id).id)
    const rep = s.placement(db.id, s.server(a2.id).id); rep.role = 'replica'
    expect(ids(run(s), 'replicas-colocated')).toHaveLength(0)
  })
})

describe('structural: dependency-cycle', () => {
  it('fires on a two-blueprint cycle', () => {
    const s = scenario()
    const a = s.blueprint('a'); const b = s.blueprint('b')
    a.dependencies = [dep('d1', b.id, 'http')]
    b.dependencies = [dep('d2', a.id, 'http')]
    const f = ids(run(s), 'dependency-cycle')
    expect(f).toHaveLength(1)
    expect(f[0].severity).toBe('critical')
    expect(new Set(f[0].affected)).toEqual(new Set([a.id, b.id]))
  })
  it('silent on an acyclic chain', () => {
    const s = scenario()
    const a = s.blueprint('a'); const b = s.blueprint('b')
    a.dependencies = [dep('d1', b.id, 'http')]
    expect(ids(run(s), 'dependency-cycle')).toHaveLength(0)
  })
})

describe('structural: deep-sync-chain', () => {
  it('fires on a 4-hop http/db chain', () => {
    const s = scenario()
    const bps = ['a', 'b', 'c', 'd', 'e'].map(n => s.blueprint(n))
    for (let i = 0; i < bps.length - 1; i++) bps[i].dependencies = [dep(`d${i}`, bps[i + 1].id, 'http')]
    const f = ids(run(s), 'deep-sync-chain')
    expect(f).toHaveLength(1)
    expect(f[0].affected).toHaveLength(5)
  })
  it('silent on a 2-hop chain', () => {
    const s = scenario()
    const a = s.blueprint('a'); const b = s.blueprint('b'); const c = s.blueprint('c')
    a.dependencies = [dep('d1', b.id, 'http')]; b.dependencies = [dep('d2', c.id, 'db')]
    expect(ids(run(s), 'deep-sync-chain')).toHaveLength(0)
  })
})

describe('structural: unused-managed-service', () => {
  it('fires (info) for a managed service no dependency targets', () => {
    const s = scenario()
    s.doc.managedServices['ms1'] = { id: 'ms1', label: 'cache', nodeType: 'redis', scope: { kind: 'region', regionId: 'r' }, provider: 'aws', port: 6379 }
    const f = ids(run(s), 'unused-managed-service')
    expect(f).toHaveLength(1)
    expect(f[0].severity).toBe('info')
    expect(f[0].affected).toEqual(['ms1'])
  })
  it('silent when a blueprint depends on it', () => {
    const s = scenario()
    s.doc.managedServices['ms1'] = { id: 'ms1', label: 'cache', nodeType: 'redis', scope: { kind: 'region', regionId: 'r' }, provider: 'aws', port: 6379 }
    const a = s.blueprint('a')
    a.dependencies = [{ id: 'd1', target: { kind: 'managed', managedServiceId: 'ms1' }, port: 6379, protocol: 'db', packetTemplateId: null }]
    expect(ids(run(s), 'unused-managed-service')).toHaveLength(0)
  })
})

describe('runAnalysis ordering + id stability', () => {
  it('orders by severity then family', () => {
    const s = scenario()
    // critical (dependency-cycle) + warning (single-az-region) + info (unused-managed-service)
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    s.placement(s.blueprint('web').id, s.server(az.id).id)   // single-az-region (warning)
    const a = s.blueprint('a'); const b = s.blueprint('b')
    a.dependencies = [dep('d1', b.id, 'http')]; b.dependencies = [dep('d2', a.id, 'http')] // cycle (critical)
    s.doc.managedServices['ms1'] = { id: 'ms1', label: 'cache', nodeType: 'redis', scope: { kind: 'region', regionId: r.id }, provider: 'aws', port: 6379 } // unused (info)
    const sevs = run(s).map(f => f.severity)
    const firstCrit = sevs.indexOf('critical'); const firstWarn = sevs.indexOf('warning'); const firstInfo = sevs.indexOf('info')
    expect(firstCrit).toBeLessThan(firstWarn)
    expect(firstWarn).toBeLessThan(firstInfo)
  })
  it('produces stable finding ids across two runs', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    s.placement(s.blueprint('web').id, s.server(az.id).id)
    const compiled = s.compile()
    const a1 = runAnalysis(s.doc, compiled, null).map(f => f.id)
    const a2 = runAnalysis(s.doc, compiled, null).map(f => f.id)
    expect(a1).toEqual(a2)
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/lib/analysis/rules/structural.test.ts`
Expected: FAIL — `Cannot find module '../runAnalysis'` (types/runAnalysis/rules not created yet).

- [ ] **Step 4: Write `src/lib/analysis/types.ts`**

```ts
// Analysis engine types (Phase 6 D1). Pure over the compiled world; the optional MetricsBatch is
// input, never fetched. Findings are derived data — never stored or serialized.
import type { WorldDoc, CompiledWorld } from '../world/types'
import type { MetricsBatch } from '../worldEngine/types'

export type AnalysisFamily = 'structural' | 'network' | 'capacity'
export type AnalysisSeverity = 'critical' | 'warning' | 'info'

export interface AnalysisFinding {
  id: string                 // `${ruleId}:${primaryAffectedId}` (world-scoped rules use `:world`)
  ruleId: string
  family: AnalysisFamily
  severity: AnalysisSeverity
  title: string              // short, e.g. 'Single-AZ region'
  why: string                // one/two sentences with concrete entity names inlined
  fix: string                // actionable; names the panel/edit that resolves it
  affected: string[]         // entity ids, most-specific first
}

export interface AnalysisInput { doc: WorldDoc; compiled: CompiledWorld; lastBatch: MetricsBatch | null }
export interface AnalysisRule { id: string; family: AnalysisFamily; run: (input: AnalysisInput) => AnalysisFinding[] }
```

- [ ] **Step 5: Write `src/lib/analysis/rules/structural.ts`**

```ts
// Structural analysis rules (Phase 6 D2). Pure; read doc + compiled only.
import type { AnalysisFinding, AnalysisRule } from '../types'
import type { ServiceInstance, WorldDoc } from '../../world/types'

// blueprint→blueprint edges (optionally protocol-filtered) present in the world.
function blueprintEdges(doc: WorldDoc, protocols?: Array<'http' | 'db' | 'event' | 'stream'>): Map<string, string[]> {
  const adj = new Map<string, string[]>()
  for (const bp of Object.values(doc.blueprints)) {
    const targets: string[] = []
    for (const d of bp.dependencies) {
      if (d.target.kind !== 'blueprint') continue
      if (protocols && !protocols.includes(d.protocol)) continue
      if (doc.blueprints[d.target.blueprintId]) targets.push(d.target.blueprintId)
    }
    adj.set(bp.id, targets)
  }
  return adj
}

const singleAzRegion: AnalysisRule = {
  id: 'single-az-region', family: 'structural',
  run: ({ doc, compiled }) => {
    const azsByRegion = new Map<string, Set<string>>()
    for (const inst of Object.values(compiled.instances)) {
      const set = azsByRegion.get(inst.regionId) ?? new Set<string>()
      set.add(inst.azId); azsByRegion.set(inst.regionId, set)
    }
    const out: AnalysisFinding[] = []
    for (const [regionId, azs] of azsByRegion) {
      if (azs.size !== 1) continue
      const azId = [...azs][0]
      const rn = doc.regions[regionId]?.catalogId ?? regionId
      const an = doc.azs[azId]?.label ?? azId
      out.push({
        id: `single-az-region:${regionId}`, ruleId: 'single-az-region', family: 'structural', severity: 'warning',
        title: 'Single-AZ region',
        why: `Every instance in region ${rn} lives in a single AZ (${an}); one AZ outage takes the whole region down.`,
        fix: `Place replicas of these workloads in another AZ of ${rn} (Placements panel).`,
        affected: [regionId, azId],
      })
    }
    return out
  },
}

const noFailoverRegion: AnalysisRule = {
  id: 'no-failover-region', family: 'structural',
  run: ({ doc, compiled }) => {
    const out: AnalysisFinding[] = []
    for (const pop of Object.values(doc.populations)) {
      const order = compiled.routing.populationRegionOrder[pop.id] ?? []
      if (order.length !== 1) continue
      const regionId = order[0]
      const rn = doc.regions[regionId]?.catalogId ?? regionId
      // Population-scoped ⇒ critical (skeleton: "warning; critical when the world has populations" —
      // a live population with a single-region order is a real geographic SPOF).
      out.push({
        id: `no-failover-region:${pop.id}`, ruleId: 'no-failover-region', family: 'structural', severity: 'critical',
        title: 'No failover region',
        why: `Population ${pop.label} routes only to ${rn} with no failover region; a regional outage drops its traffic entirely.`,
        fix: `Add a second active region and place entry workloads there so ${pop.label} can fail over (Topology + Placements).`,
        affected: [pop.id, regionId],
      })
    }
    return out
  },
}

const replicasColocated: AnalysisRule = {
  id: 'replicas-colocated', family: 'structural',
  run: ({ doc, compiled }) => {
    const byBp = new Map<string, ServiceInstance[]>()
    for (const inst of Object.values(compiled.instances)) {
      const a = byBp.get(inst.blueprintId) ?? []; a.push(inst); byBp.set(inst.blueprintId, a)
    }
    const out: AnalysisFinding[] = []
    for (const [bpId, insts] of byBp) {
      const bp = doc.blueprints[bpId]
      if (!bp?.stateful) continue
      const primaries = insts.filter(i => i.role === 'primary')
      const replicas = insts.filter(i => i.role === 'replica')
      if (primaries.length === 0 || replicas.length === 0) continue
      const primaryAz = primaries[0].azId
      if (!replicas.every(r => r.azId === primaryAz)) continue
      const an = doc.azs[primaryAz]?.label ?? primaryAz
      const instIds = [...primaries.filter(p => p.azId === primaryAz), ...replicas].map(i => i.id)
      out.push({
        id: `replicas-colocated:${bpId}`, ruleId: 'replicas-colocated', family: 'structural', severity: 'warning',
        title: 'Replicas co-located with primary',
        why: `Stateful ${bp.name}'s primary and all ${replicas.length} replica(s) share AZ ${an}; losing that AZ loses every copy.`,
        fix: `Move at least one ${bp.name} replica to a different AZ (Placements panel).`,
        affected: [bpId, primaryAz, ...instIds],
      })
    }
    return out
  },
}

const dependencyCycle: AnalysisRule = {
  id: 'dependency-cycle', family: 'structural',
  run: ({ doc }) => {
    const adj = blueprintEdges(doc)
    const WHITE = 0, GRAY = 1, BLACK = 2
    const color = new Map<string, number>()
    const stack: string[] = []
    const seen = new Set<string>()
    const out: AnalysisFinding[] = []
    const emit = (cycle: string[]) => {
      let min = 0
      for (let i = 1; i < cycle.length; i++) if (cycle[i] < cycle[min]) min = i
      const rot = [...cycle.slice(min), ...cycle.slice(0, min)]
      const key = rot.join('>')
      if (seen.has(key)) return
      seen.add(key)
      const names = rot.map(id => doc.blueprints[id]?.name ?? id)
      out.push({
        id: `dependency-cycle:${rot[0]}`, ruleId: 'dependency-cycle', family: 'structural', severity: 'critical',
        title: 'Dependency cycle',
        why: `Blueprints form a dependency cycle: ${names.join(' → ')} → ${names[0]}. Requests can loop and failures cascade.`,
        fix: `Break the cycle by removing or inverting one dependency (Blueprints panel).`,
        affected: rot,
      })
    }
    const dfs = (u: string) => {
      color.set(u, GRAY); stack.push(u)
      for (const v of adj.get(u) ?? []) {
        if (color.get(v) === GRAY) {
          const idx = stack.indexOf(v)
          if (idx >= 0) emit(stack.slice(idx))
        } else if ((color.get(v) ?? WHITE) === WHITE) {
          dfs(v)
        }
      }
      stack.pop(); color.set(u, BLACK)
    }
    for (const id of adj.keys()) if ((color.get(id) ?? WHITE) === WHITE) dfs(id)
    return out
  },
}

const deepSyncChain: AnalysisRule = {
  id: 'deep-sync-chain', family: 'structural',
  run: ({ doc }) => {
    const adj = blueprintEdges(doc, ['http', 'db'])
    let best: string[] = []
    const dfs = (u: string, path: string[], visited: Set<string>) => {
      if (path.length > best.length) best = [...path]
      for (const v of adj.get(u) ?? []) {
        if (visited.has(v)) continue
        visited.add(v); dfs(v, [...path, v], visited); visited.delete(v)
      }
    }
    for (const id of adj.keys()) dfs(id, [id], new Set([id]))
    if (best.length - 1 < 4) return []
    const names = best.map(id => doc.blueprints[id]?.name ?? id)
    return [{
      id: `deep-sync-chain:${best[0]}`, ruleId: 'deep-sync-chain', family: 'structural', severity: 'warning',
      title: 'Deep synchronous chain',
      why: `A synchronous http/db call chain is ${best.length - 1} hops deep: ${names.join(' → ')}. Latency and failure risk compound with depth.`,
      fix: `Introduce async messaging or caching to shorten the critical path (Blueprints panel).`,
      affected: best,
    }]
  },
}

const unusedManagedService: AnalysisRule = {
  id: 'unused-managed-service', family: 'structural',
  run: ({ doc }) => {
    const targeted = new Set<string>()
    for (const bp of Object.values(doc.blueprints))
      for (const d of bp.dependencies)
        if (d.target.kind === 'managed') targeted.add(d.target.managedServiceId)
    const out: AnalysisFinding[] = []
    for (const ms of Object.values(doc.managedServices)) {
      if (targeted.has(ms.id)) continue
      out.push({
        id: `unused-managed-service:${ms.id}`, ruleId: 'unused-managed-service', family: 'structural', severity: 'info',
        title: 'Unused managed service',
        why: `Managed service ${ms.label} is not the target of any blueprint dependency; it bills but serves no traffic.`,
        fix: `Wire a blueprint dependency to ${ms.label} or remove it (Placements panel).`,
        affected: [ms.id],
      })
    }
    return out
  },
}

export const structuralRules: AnalysisRule[] = [
  singleAzRegion, noFailoverRegion, replicasColocated, dependencyCycle, deepSyncChain, unusedManagedService,
]
```

- [ ] **Step 6: Write `src/lib/analysis/runAnalysis.ts`** (registry + runner — T2/T3 append here)

```ts
// The analysis registry + runner (Phase 6 D1/D3). ONE array; T2 appends network, T3 appends capacity.
// Pure: builds the input once, concatenates every rule's output, sorts severity→family→ruleId.
import type { WorldDoc, CompiledWorld } from '../world/types'
import type { MetricsBatch } from '../worldEngine/types'
import type { AnalysisFinding, AnalysisRule, AnalysisInput } from './types'
import { structuralRules } from './rules/structural'
// T2: import { networkRules } from './rules/network'
// T3: import { capacityRules } from './rules/capacity'

export const ANALYSIS_RULES: AnalysisRule[] = [
  ...structuralRules,
  // ...networkRules,   // ← T2 uncomments/adds
  // ...capacityRules,  // ← T3 uncomments/adds
]

const SEV_RANK: Record<AnalysisFinding['severity'], number> = { critical: 0, warning: 1, info: 2 }
const FAM_RANK: Record<AnalysisFinding['family'], number> = { structural: 0, network: 1, capacity: 2 }

export function runAnalysis(doc: WorldDoc, compiled: CompiledWorld, lastBatch: MetricsBatch | null): AnalysisFinding[] {
  const input: AnalysisInput = { doc, compiled, lastBatch }
  const findings = ANALYSIS_RULES.flatMap(rule => rule.run(input))
  return findings.sort((a, b) =>
    (SEV_RANK[a.severity] - SEV_RANK[b.severity]) ||
    (FAM_RANK[a.family] - FAM_RANK[b.family]) ||
    (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0),
  )
}
```

- [ ] **Step 7: Run to verify pass**

Run: `npx vitest run src/lib/analysis/rules/structural.test.ts`
Expected: PASS (14 tests: 6×[fires+silent] + ordering + id stability). Then `npx vitest run` → full
suite green; `npm run build` → strict tsc + vite green.

- [ ] **Step 8: Commit**

```bash
git add src/lib/analysis/types.ts src/lib/analysis/runAnalysis.ts \
  src/lib/analysis/rules/structural.ts src/lib/analysis/rules/structural.test.ts \
  src/lib/analysis/__fixtures__/worlds.ts
git commit -m "feat(analysis): analysis core, registry, and structural rule family"
```

---

## Task 2: Network/security family `[sonnet]`

**Files:** create `src/lib/analysis/rules/network.ts`, `src/lib/analysis/rules/network.test.ts`; modify
`src/lib/analysis/runAnalysis.ts` (register `networkRules` in the ONE `ANALYSIS_RULES` array).

**Grounding:** `compiled.paths: CompiledPath[]` with `verdict:'permitted'|'blocked'`,
`blockReason:{kind:'no-port-binding'|'firewall-deny'|'network-isolation'; detail; firewallRuleId}`,
`to:{kind:'instance';instanceId}|{kind:'managed';managedServiceId}`. Blocked compile findings have
`id = `finding-${path.id}``. `FirewallRule { id; action:'allow'|'deny'; port:number|'any';
protocol:'tcp'|'udp'|'any'; source:'any'|'internal'|CIDR }`. `network.ts`'s `evaluateFirewall` IGNORES
`source`, so these rules replicate a **source-aware** first-match loop (GROUNDING §E). Default server
firewall (`createServer`) is `{allow, port:'any', protocol:'any', source:'internal'}` — NOT `'any'`.

- [ ] **Step 1: Write the failing test `src/lib/analysis/rules/network.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { scenario, dep } from '../__fixtures__/worlds'
import { runAnalysis } from '../runAnalysis'
import type { AnalysisFinding } from '../types'
import type { FirewallRule } from '../../world/types'

const ids = (fs: AnalysisFinding[], ruleId: string) => fs.filter(f => f.ruleId === ruleId)
const run = (s: ReturnType<typeof scenario>) => runAnalysis(s.doc, s.compile(), null)
const allowAny = (port: number): FirewallRule => ({ id: `fw-open-${port}`, action: 'allow', port, protocol: 'tcp', source: 'any' })

describe('network: blocked-dependency-path', () => {
  it('fires for a firewall-denied cross-server path and names the rule in the fix', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id); const s2 = s.server(az.id)
    // web (process) → db (process on s2) over port 5432, but s2's firewall denies 5432.
    s2.firewall = [{ id: 'deny-5432', action: 'deny', port: 5432, protocol: 'tcp', source: 'internal' }, ...s2.firewall]
    const web = s.blueprint('web', 0); const db = s.blueprint('db', 1)
    db.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
    web.dependencies = [dep('d-db', db.id, 'db', 5432)]
    s.placement(web.id, s1.id); s.placement(db.id, s2.id)
    const f = ids(run(s), 'blocked-dependency-path')
    expect(f.length).toBeGreaterThanOrEqual(1)
    expect(f[0].severity).toBe('critical')
    expect(f[0].id.startsWith('blocked-dependency-path:')).toBe(true)
    expect(f[0].fix).toMatch(/firewall/i)
  })
  it('silent when the path is permitted', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id)
    const web = s.blueprint('web', 0); const api = s.blueprint('api', 1)
    api.ports = [{ port: 8080, protocol: 'tcp', visibility: 'internal' }]
    web.dependencies = [dep('d-api', api.id, 'http', 8080)]
    s.placement(web.id, s1.id); s.placement(api.id, s1.id) // localhost → permitted
    expect(ids(run(s), 'blocked-dependency-path')).toHaveLength(0)
  })
})

describe('network: db-port-exposed', () => {
  it('fires when a db target server allows the port from any source', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id); const s2 = s.server(az.id)
    s2.firewall = [allowAny(5432), ...s2.firewall]
    const web = s.blueprint('web', 0); const db = s.blueprint('db', 1)
    db.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
    web.dependencies = [dep('d-db', db.id, 'db', 5432)]
    s.placement(web.id, s1.id); s.placement(db.id, s2.id)
    const f = ids(run(s), 'db-port-exposed')
    expect(f.length).toBeGreaterThanOrEqual(1)
    expect(f[0].affected).toContain(s2.id)
  })
  it('fires via public visibility even without a firewall hole', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id)
    const web = s.blueprint('web', 0); const db = s.blueprint('db', 1)
    db.ports = [{ port: 5432, protocol: 'tcp', visibility: 'public' }] // public db port
    web.dependencies = [dep('d-db', db.id, 'db', 5432)]
    s.placement(web.id, s1.id); s.placement(db.id, s1.id)
    const f = ids(run(s), 'db-port-exposed')
    expect(f.some(x => x.affected[0] === db.id)).toBe(true)
  })
  it('silent for a db target behind the default internal firewall', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id)
    const web = s.blueprint('web', 0); const db = s.blueprint('db', 1)
    db.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
    web.dependencies = [dep('d-db', db.id, 'db', 5432)]
    s.placement(web.id, s1.id); s.placement(db.id, s1.id)
    expect(ids(run(s), 'db-port-exposed')).toHaveLength(0)
  })
})

describe('network: entry-unreachable', () => {
  it('fires for a public port with no hosting server allowing it from any', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id) // default firewall: source 'internal', not 'any'
    const web = s.blueprint('web', 0)
    web.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
    s.placement(web.id, s1.id)
    const f = ids(run(s), 'entry-unreachable')
    expect(f).toHaveLength(1)
    expect(f[0].affected[0]).toBe(web.id)
  })
  it('silent once a hosting server allows the port from any', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id); s1.firewall = [allowAny(443), ...s1.firewall]
    const web = s.blueprint('web', 0)
    web.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
    s.placement(web.id, s1.id)
    expect(ids(run(s), 'entry-unreachable')).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/analysis/rules/network.test.ts`
Expected: FAIL — `Cannot find module './network'` (referenced via runAnalysis) / no `network`-family
findings emitted.

- [ ] **Step 3: Write `src/lib/analysis/rules/network.ts`**

```ts
// Network/security analysis rules (Phase 6 D2). Pure. Replicates a SOURCE-aware first-match firewall
// loop because src/lib/world/network.ts's evaluateFirewall ignores `source` (Phase-1 all-internal).
import type { AnalysisFinding, AnalysisRule } from '../types'
import type { FirewallRule } from '../../world/types'

// First rule (array order) that matches the port+tcp; null = default deny. Source-aware callers read
// match.action + match.source themselves.
function firewallFirstMatch(rules: FirewallRule[], port: number): FirewallRule | null {
  for (const r of rules) {
    const portOk = r.port === 'any' || r.port === port
    const protoOk = r.protocol === 'any' || r.protocol === 'tcp'
    if (portOk && protoOk) return r
  }
  return null
}
const openToAny = (rules: FirewallRule[], port: number): FirewallRule | null => {
  const m = firewallFirstMatch(rules, port)
  return m && m.action === 'allow' && m.source === 'any' ? m : null
}

const blockedDependencyPath: AnalysisRule = {
  id: 'blocked-dependency-path', family: 'network',
  run: ({ doc, compiled }) => {
    const out: AnalysisFinding[] = []
    for (const path of compiled.paths) {
      if (path.verdict !== 'blocked' || !path.blockReason || path.to.kind !== 'instance') continue
      const targetId = path.to.instanceId
      const targetServerId = compiled.instances[targetId]?.serverId ?? ''
      const server = doc.servers[targetServerId]
      const br = path.blockReason
      let fix: string
      if (br.kind === 'firewall-deny') {
        fix = `Rule ${br.firewallRuleId ?? '(default deny)'} on ${server?.label ?? targetServerId} blocks this port — add an allow rule above it in the server's firewall (Server view → firewall).`
      } else if (br.kind === 'network-isolation') {
        fix = `${br.detail} — put both containers on a shared compose network or publish the port on the host (Server view → runtime).`
      } else {
        fix = `${br.detail} — bind the port or publish it via a host port mapping (Server view → runtime).`
      }
      const fromName = doc.blueprints[compiled.instances[path.fromInstanceId]?.blueprintId ?? '']?.name ?? path.fromInstanceId
      const toName = doc.blueprints[compiled.instances[targetId]?.blueprintId ?? '']?.name ?? targetId
      out.push({
        id: `blocked-dependency-path:${path.id}`, // embeds the compiled path id for D4 suppression
        ruleId: 'blocked-dependency-path', family: 'network', severity: 'critical',
        title: 'Blocked dependency path',
        why: `${fromName} cannot reach ${toName}: ${br.detail}.`,
        fix,
        affected: [path.fromInstanceId, targetId, targetServerId].filter(Boolean),
      })
    }
    return out
  },
}

const dbPortExposed: AnalysisRule = {
  id: 'db-port-exposed', family: 'network',
  run: ({ doc, compiled }) => {
    const out: AnalysisFinding[] = []
    const emitted = new Set<string>()
    const push = (f: AnalysisFinding) => { if (!emitted.has(f.id)) { emitted.add(f.id); out.push(f) } }

    // (a) db-protocol dependency whose target instance's server firewall allows the port from 'any'.
    for (const bp of Object.values(doc.blueprints)) {
      for (const d of bp.dependencies) {
        if (d.protocol !== 'db' || d.target.kind !== 'blueprint') continue
        const targetBpId = d.target.blueprintId
        for (const inst of Object.values(compiled.instances)) {
          if (inst.blueprintId !== targetBpId) continue
          const server = doc.servers[inst.serverId]; if (!server) continue
          const open = openToAny(server.firewall, d.port)
          if (!open) continue
          push({
            id: `db-port-exposed:${server.id}`, ruleId: 'db-port-exposed', family: 'network', severity: 'critical',
            title: 'Database port exposed to the internet',
            why: `Server ${server.label} allows db port ${d.port} from any source (rule ${open.id}); the database is reachable from the internet.`,
            fix: `Restrict rule ${open.id} to an internal/CIDR source or remove it (Server view → firewall).`,
            affected: [server.id, open.id],
          })
        }
      }
    }

    // (b) a blueprint that is a db-dependency target AND declares a public-visibility port.
    const dbTargets = new Set<string>()
    for (const bp of Object.values(doc.blueprints))
      for (const d of bp.dependencies)
        if (d.protocol === 'db' && d.target.kind === 'blueprint') dbTargets.add(d.target.blueprintId)
    for (const bpId of dbTargets) {
      const bp = doc.blueprints[bpId]
      if (!bp || !bp.ports.some(p => p.visibility === 'public')) continue
      push({
        id: `db-port-exposed:${bp.id}`, ruleId: 'db-port-exposed', family: 'network', severity: 'critical',
        title: 'Database blueprint has a public port',
        why: `${bp.name} is used as a database dependency but declares a public-visibility port; its data plane is internet-facing.`,
        fix: `Change ${bp.name}'s port visibility to internal (Blueprints panel).`,
        affected: [bp.id],
      })
    }
    return out
  },
}

const entryUnreachable: AnalysisRule = {
  id: 'entry-unreachable', family: 'network',
  run: ({ doc, compiled }) => {
    const out: AnalysisFinding[] = []
    for (const bp of Object.values(doc.blueprints)) {
      const publicPorts = bp.ports.filter(p => p.visibility === 'public')
      if (publicPorts.length === 0) continue
      const serverIds = new Set<string>()
      for (const inst of Object.values(compiled.instances)) if (inst.blueprintId === bp.id) serverIds.add(inst.serverId)
      if (serverIds.size === 0) continue // not placed — not a live front door
      const unreachable = publicPorts.find(p => ![...serverIds].some(sid => openToAny(doc.servers[sid]?.firewall ?? [], p.port)))
      if (!unreachable) continue
      const names = [...serverIds].map(sid => doc.servers[sid]?.label ?? sid).join(', ')
      out.push({
        id: `entry-unreachable:${bp.id}`, ruleId: 'entry-unreachable', family: 'network', severity: 'warning',
        title: 'Entry point unreachable from the internet',
        why: `${bp.name} exposes public port ${unreachable.port} but none of its hosting servers (${names}) allow that port from the internet; the front door is firewalled shut.`,
        fix: `Add an allow rule for port ${unreachable.port} from source 'any' on a hosting server's firewall (Server view → firewall).`,
        affected: [bp.id, ...serverIds],
      })
    }
    return out
  },
}

export const networkRules: AnalysisRule[] = [blockedDependencyPath, dbPortExposed, entryUnreachable]
```

- [ ] **Step 4: Register in `runAnalysis.ts`**

```diff
 import { structuralRules } from './rules/structural'
-// T2: import { networkRules } from './rules/network'
+import { networkRules } from './rules/network'
 // T3: import { capacityRules } from './rules/capacity'

 export const ANALYSIS_RULES: AnalysisRule[] = [
   ...structuralRules,
-  // ...networkRules,   // ← T2 uncomments/adds
+  ...networkRules,
   // ...capacityRules,  // ← T3 uncomments/adds
 ]
```

- [ ] **Step 5: Run + build**

Run: `npx vitest run src/lib/analysis/rules/network.test.ts` → PASS (7 tests). Then `npx vitest run`
→ full suite green; `npm run build` → green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/analysis/rules/network.ts src/lib/analysis/rules/network.test.ts src/lib/analysis/runAnalysis.ts
git commit -m "feat(analysis): network/security rule family"
```

---

## Task 3: Capacity/geo family `[sonnet]`

**Files:** create `src/lib/analysis/rules/capacity.ts`, `src/lib/analysis/rules/capacity.test.ts`;
modify `src/lib/analysis/runAnalysis.ts` (register `capacityRules`).

**Grounding:** `server.specs.ramMb`, `server.burstable`; container `runtime.memLimitMb:number|null`;
`bp.workload.ramBaseMb`; `MetricsBatch.servers[id].coreUtilization:number[]`;
`compiled.routing.populationRegionOrder`; `doc.routing.{dnsTtlSec, healthCheckIntervalMs,
healthCheckFailureThreshold}`. **Distance source (GROUNDING §F DECISION):** import `REGION_GEO,
greatCircleKm` from `../../world/regionGeo` (lib→lib — regionGeo is lib-layer and already used by
routing.ts; DO NOT re-implement a local haversine and DO NOT import app-layer `geo.ts`; design D2:
"reuse the haversine already implicit in regionGeo / pick ONE distance source and cite it"). Verified
`greatCircleKm(40.7,-74, 51.5,-0.1) = 5572.8 km`. Burstable presets: `vps-small`/`vps-medium`/
`aws-t3-medium`.

- [ ] **Step 1: Write the failing test `src/lib/analysis/rules/capacity.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { scenario } from '../__fixtures__/worlds'
import { runAnalysis } from '../runAnalysis'
import { greatCircleKm } from '../../world/regionGeo'
import type { AnalysisFinding } from '../types'
import type { MetricsBatch } from '../../worldEngine/types'

const ids = (fs: AnalysisFinding[], ruleId: string) => fs.filter(f => f.ruleId === ruleId)

// Minimal batch stub — the capacity rules read only servers[id].coreUtilization.
function batchWith(serverId: string, util: number[]): MetricsBatch {
  return { servers: { [serverId]: { coreUtilization: util } } } as unknown as MetricsBatch
}

describe('capacity: ram-oversubscribed', () => {
  it('fires when reserved RAM exceeds the host and names both numbers', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const srv = s.server(az.id) // dedicated-8 → 32768 MB
    const bp = s.blueprint('web')
    const pl = s.placement(bp.id, srv.id)
    pl.runtime = { type: 'container', stackName: 'app', networkNames: [], portMappings: [], cpuLimit: null, memLimitMb: 40000 }
    const f = ids(runAnalysis(s.doc, s.compile(), null), 'ram-oversubscribed')
    expect(f).toHaveLength(1)
    expect(f[0].affected[0]).toBe(srv.id)
    expect(f[0].why).toMatch(/40000/); expect(f[0].why).toMatch(/32768/)
  })
  it('silent when reserved RAM fits', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const srv = s.server(az.id); const bp = s.blueprint('web')
    const pl = s.placement(bp.id, srv.id)
    pl.runtime = { type: 'container', stackName: 'app', networkNames: [], portMappings: [], cpuLimit: null, memLimitMb: 1000 }
    expect(ids(runAnalysis(s.doc, s.compile(), null), 'ram-oversubscribed')).toHaveLength(0)
  })
})

describe('capacity: burstable-sustained-load', () => {
  it('fires when a burstable VPS averages > 40% CPU', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const srv = s.server(az.id, 'vps-small') // burstable
    s.placement(s.blueprint('web').id, srv.id)
    const f = ids(runAnalysis(s.doc, s.compile(), batchWith(srv.id, [0.5, 0.5])), 'burstable-sustained-load')
    expect(f).toHaveLength(1)
    expect(f[0].affected).toEqual([srv.id])
  })
  it('silent below the 40% threshold', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const srv = s.server(az.id, 'vps-small')
    s.placement(s.blueprint('web').id, srv.id)
    expect(ids(runAnalysis(s.doc, s.compile(), batchWith(srv.id, [0.2, 0.2])), 'burstable-sustained-load')).toHaveLength(0)
  })
  it('silent with a null batch', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const srv = s.server(az.id, 'vps-small')
    s.placement(s.blueprint('web').id, srv.id)
    expect(ids(runAnalysis(s.doc, s.compile(), null), 'burstable-sustained-load')).toHaveLength(0)
  })
})

describe('capacity: ocean-crossing-population', () => {
  it('fires when the first region is > 1.5× the nearest', () => {
    const s = scenario()
    const r1 = s.region('us-east-1'); s.az(r1.id, 'us-east-1a')
    const r2 = s.region('eu-west-1'); s.az(r2.id, 'eu-west-1a')
    s.doc.routing.policy = 'priority'
    s.doc.routing.priorityOrder = [r1.id, r2.id] // forces us-east-1 first for a London pop
    const pop = s.population('london', 51.5, -0.1)
    const f = ids(runAnalysis(s.doc, s.compile(), null), 'ocean-crossing-population')
    expect(f).toHaveLength(1)
    expect(f[0].affected).toEqual([pop.id, r1.id, r2.id])
  })
  it('silent when the nearest region is first', () => {
    const s = scenario()
    const r1 = s.region('us-east-1'); s.az(r1.id, 'us-east-1a')
    const r2 = s.region('eu-west-1'); s.az(r2.id, 'eu-west-1a')
    s.doc.routing.policy = 'priority'
    s.doc.routing.priorityOrder = [r2.id, r1.id]
    s.population('london', 51.5, -0.1)
    expect(ids(runAnalysis(s.doc, s.compile(), null), 'ocean-crossing-population')).toHaveLength(0)
  })
  it('haversine sanity: NYC→London ≈ 5570 km (±2%)', () => {
    const km = greatCircleKm(40.7, -74, 51.5, -0.1)
    expect(km).toBeGreaterThan(5570 * 0.98)
    expect(km).toBeLessThan(5570 * 1.02)
  })
})

describe('capacity: ttl-outlives-detection', () => {
  it('fires when DNS TTL is shorter than the detection window', () => {
    const s = scenario()
    s.doc.routing.dnsTtlSec = 5 // 5000ms < 10000×3 = 30000ms
    const f = ids(runAnalysis(s.doc, s.compile(), null), 'ttl-outlives-detection')
    expect(f).toHaveLength(1)
    expect(f[0].affected).toEqual([])
    expect(f[0].id).toBe('ttl-outlives-detection:world')
    expect(f[0].why).toMatch(/5000/); expect(f[0].why).toMatch(/30000/)
  })
  it('silent at the default TTL/detection balance', () => {
    const s = scenario() // dnsTtlSec 30 → 30000ms == 30000ms detection, not <
    expect(ids(runAnalysis(s.doc, s.compile(), null), 'ttl-outlives-detection')).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/analysis/rules/capacity.test.ts`
Expected: FAIL — no `capacity`-family findings (rules not registered yet).

- [ ] **Step 3: Write `src/lib/analysis/rules/capacity.ts`**

```ts
// Capacity/geo analysis rules (Phase 6 D2). Pure. Distance via regionGeo.greatCircleKm (lib→lib;
// the single cited distance source per design D2 — NOT a local haversine, NOT app-layer geo.ts).
import type { AnalysisFinding, AnalysisRule } from '../types'
import type { ServiceInstance } from '../../world/types'
import { REGION_GEO, greatCircleKm } from '../../world/regionGeo'

const ramOversubscribed: AnalysisRule = {
  id: 'ram-oversubscribed', family: 'capacity',
  run: ({ doc, compiled }) => {
    const byServer = new Map<string, ServiceInstance[]>()
    for (const inst of Object.values(compiled.instances)) {
      const a = byServer.get(inst.serverId) ?? []; a.push(inst); byServer.set(inst.serverId, a)
    }
    const out: AnalysisFinding[] = []
    for (const [serverId, insts] of byServer) {
      const server = doc.servers[serverId]; if (!server) continue
      let sum = 0
      for (const inst of insts) {
        const pl = doc.placements[inst.placementId]
        const memLimit = pl?.runtime.type === 'container' ? pl.runtime.memLimitMb : null
        sum += memLimit ?? doc.blueprints[inst.blueprintId]?.workload.ramBaseMb ?? 0
      }
      if (sum <= server.specs.ramMb) continue
      out.push({
        id: `ram-oversubscribed:${serverId}`, ruleId: 'ram-oversubscribed', family: 'capacity', severity: 'warning',
        title: 'Host RAM oversubscribed',
        why: `Reserved RAM on ${server.label} totals ${sum} MB but the host only has ${server.specs.ramMb} MB; instances will contend and may OOM.`,
        fix: `Lower container memory limits, move instances off ${server.label}, or use a larger host (Placements / Server view).`,
        affected: [serverId, ...insts.map(i => i.id)],
      })
    }
    return out
  },
}

const burstableSustainedLoad: AnalysisRule = {
  id: 'burstable-sustained-load', family: 'capacity',
  run: ({ doc, lastBatch }) => {
    if (!lastBatch) return []
    const out: AnalysisFinding[] = []
    for (const server of Object.values(doc.servers)) {
      if (!server.burstable) continue
      const util = lastBatch.servers[server.id]?.coreUtilization
      if (!util || util.length === 0) continue
      const mean = util.reduce((a, b) => a + b, 0) / util.length
      if (mean <= 0.4) continue
      out.push({
        id: `burstable-sustained-load:${server.id}`, ruleId: 'burstable-sustained-load', family: 'capacity', severity: 'warning',
        title: 'Sustained load on a burstable VPS',
        why: `Burstable VPS ${server.label} is averaging ${(mean * 100).toFixed(0)}% CPU (> 40%); it will drain its CPU credits and throttle.`,
        fix: `Move this workload to a non-burstable instance or a larger host (Placements panel).`,
        affected: [server.id],
      })
    }
    return out
  },
}

const oceanCrossingPopulation: AnalysisRule = {
  id: 'ocean-crossing-population', family: 'capacity',
  run: ({ doc, compiled }) => {
    const regions = Object.values(doc.regions)
    if (regions.length < 2) return []
    const out: AnalysisFinding[] = []
    for (const pop of Object.values(doc.populations)) {
      const order = compiled.routing.populationRegionOrder[pop.id] ?? []
      if (order.length === 0) continue
      const firstId = order[0]
      const firstGeo = REGION_GEO[doc.regions[firstId]?.catalogId ?? '']
      if (!firstGeo) continue
      const firstKm = greatCircleKm(pop.lat, pop.lon, firstGeo.lat, firstGeo.lon)
      let nearestId = firstId, nearestKm = firstKm
      for (const region of regions) {
        const geo = REGION_GEO[region.catalogId]; if (!geo) continue
        const km = greatCircleKm(pop.lat, pop.lon, geo.lat, geo.lon)
        if (km < nearestKm) { nearestKm = km; nearestId = region.id }
      }
      if (nearestId === firstId || firstKm <= 1.5 * nearestKm) continue
      const fn = doc.regions[firstId]?.catalogId ?? firstId
      const nn = doc.regions[nearestId]?.catalogId ?? nearestId
      out.push({
        id: `ocean-crossing-population:${pop.id}`, ruleId: 'ocean-crossing-population', family: 'capacity', severity: 'warning',
        title: 'Population routed across an ocean',
        why: `${pop.label} routes first to ${fn} (${Math.round(firstKm)} km) when ${nn} (${Math.round(nearestKm)} km) is far nearer; needless latency.`,
        fix: `Adjust routing policy/weights or add capacity in ${nn} so ${pop.label} lands closer (Traffic panel).`,
        affected: [pop.id, firstId, nearestId],
      })
    }
    return out
  },
}

const ttlOutlivesDetection: AnalysisRule = {
  id: 'ttl-outlives-detection', family: 'capacity',
  run: ({ doc }) => {
    const { dnsTtlSec, healthCheckIntervalMs, healthCheckFailureThreshold } = doc.routing
    const ttlMs = dnsTtlSec * 1000
    const detectMs = healthCheckIntervalMs * healthCheckFailureThreshold
    if (ttlMs >= detectMs) return []
    return [{
      id: 'ttl-outlives-detection:world', ruleId: 'ttl-outlives-detection', family: 'capacity', severity: 'warning',
      title: 'DNS TTL shorter than failure detection',
      why: `DNS TTL is ${ttlMs} ms but failure detection takes ${detectMs} ms (${healthCheckIntervalMs} ms × ${healthCheckFailureThreshold}); clients re-resolve faster than a failed region is detected, so failover lags.`,
      fix: `Raise dnsTtlSec above the detection window, or lower the health-check interval/threshold (Traffic panel → routing).`,
      affected: [],
    }]
  },
}

export const capacityRules: AnalysisRule[] = [
  ramOversubscribed, burstableSustainedLoad, oceanCrossingPopulation, ttlOutlivesDetection,
]
```

- [ ] **Step 4: Register in `runAnalysis.ts`**

```diff
 import { networkRules } from './rules/network'
-// T3: import { capacityRules } from './rules/capacity'
+import { capacityRules } from './rules/capacity'

 export const ANALYSIS_RULES: AnalysisRule[] = [
   ...structuralRules,
   ...networkRules,
-  // ...capacityRules,  // ← T3 uncomments/adds
+  ...capacityRules,
 ]
```

- [ ] **Step 5: Run + build**

Run: `npx vitest run src/lib/analysis/rules/capacity.test.ts` → PASS (9 tests incl. haversine sanity +
null-batch silent). `npx vitest run` → full suite green; `npm run build` → green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/analysis/rules/capacity.ts src/lib/analysis/rules/capacity.test.ts src/lib/analysis/runAnalysis.ts
git commit -m "feat(analysis): capacity/geo rule family"
```

---

## Task 4: Analysis tab `[sonnet]`

**Files:** create `src/app/world/panels/AnalysisTab.tsx`, `src/app/world/panels/AnalysisTab.test.tsx`;
modify `src/app/world/panels/WorldPanel.tsx` (tab `findings`→`analysis`, move findings JSX into the tab,
merged count) and `src/app/world/panels/WorldPanel.test.tsx` (click `Analysis (…)`).

**Grounding:** `useCompiledWorld()` (`src/app/world/useCompiledWorld.ts`) → memoized `compileWorld(doc)`;
`useWorldStore(s=>s.doc)`; `useSimulationStore(s => s.scrubBatch ?? s.latestBatch)`; nav
(`src/app/store/nav.store.ts`): `goRegion(regionId)`, `goAz(regionId, azId)`, `goServer(regionId, azId,
serverId)`. Blocked compile finding id = `finding-${path.id}`. Panel styles: `sectionLabel`, `row` from
`./panelStyles`. In T4, `AnalysisTab` takes **NO props** (T8 later adds `openSettings`). Severity chip
colors: critical→`var(--color-danger)`, warning→`var(--color-warning)`, info→`var(--color-text-muted)`.

- [ ] **Step 1: Write the failing test `src/app/world/panels/AnalysisTab.test.tsx`**

```tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AnalysisTab, navigateToEntity, unsuppressedCompileFindings } from './AnalysisTab'
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import { useSimulationStore } from '../../store/simulation.store'
import { compileWorld } from '../../../lib/world/compileWorld'
import { getPreset } from '../../../lib/world/instanceCatalog'
import type { AnalysisFinding } from '../../../lib/analysis/types'
import type { CompileFinding } from '../../../lib/world/types'

// Author a world with a single-AZ region (structural warning) via the store's real actions.
// addServer(azId, preset) requires a preset (verified world.store signature).
function seedSingleAzRegion() {
  const w = useWorldStore.getState()
  const rId = w.addRegion('us-east-1')
  const azId = w.addAz(rId, 'us-east-1a')
  const srvId = w.addServer(azId, getPreset('dedicated-8')!)
  const bpId = w.addBlueprint('web')
  w.addPlacement(bpId, srvId)
  return { rId, azId, srvId, bpId }
}

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useNavStore.getState().goGlobe()
  useSimulationStore.setState({ latestBatch: null, scrubBatch: null })
})

describe('AnalysisTab', () => {
  it('groups findings by family and lists a structural warning', () => {
    seedSingleAzRegion()
    render(<AnalysisTab />)
    expect(screen.getByText('Structural')).toBeInTheDocument()
    expect(screen.getByText('Single-AZ region')).toBeInTheDocument()
  })

  it('affected chip navigates to a server (goServer)', () => {
    const { srvId } = seedSingleAzRegion()
    // Add a ram-oversubscribed finding path by oversubscribing the server so a server chip appears.
    const w = useWorldStore.getState()
    // Force server RAM tiny so ram-oversubscribed fires and yields a serverId chip.
    w.updateServer(srvId, { specs: { ...w.doc.servers[srvId].specs, ramMb: 1 } })
    render(<AnalysisTab />)
    const chip = screen.getAllByText(w.doc.servers[srvId].label)[0]
    fireEvent.click(chip)
    expect(useNavStore.getState().level).toBe('server')
    expect(useNavStore.getState().serverId).toBe(srvId)
  })

  it('navigateToEntity resolves entity kinds', () => {
    const { rId, azId, srvId } = seedSingleAzRegion()
    const doc = useWorldStore.getState().doc
    const compiled = compileWorld(doc)
    const calls: string[] = []
    const nav = {
      goRegion: (r: string) => calls.push(`region:${r}`),
      goAz: (r: string, a: string) => calls.push(`az:${a}`),
      goServer: (r: string, a: string, s: string) => calls.push(`server:${s}`),
    }
    expect(navigateToEntity(rId, doc, compiled, nav)).toBe(true)
    expect(navigateToEntity(azId, doc, compiled, nav)).toBe(true)
    expect(navigateToEntity(srvId, doc, compiled, nav)).toBe(true)
    const instId = Object.keys(compiled.instances)[0]
    expect(navigateToEntity(instId, doc, compiled, nav)).toBe(true)          // instance → its server
    expect(navigateToEntity('bp-does-not-navigate', doc, compiled, nav)).toBe(false)
    expect(calls).toEqual([`region:${rId}`, `az:${azId}`, `server:${srvId}`, `server:${srvId}`])
  })

  it('suppresses the compile duplicate covered by a blocked-dependency-path finding', () => {
    const analysis: AnalysisFinding[] = [
      { id: 'blocked-dependency-path:i1->d->i2', ruleId: 'blocked-dependency-path', family: 'network', severity: 'critical', title: 't', why: 'w', fix: 'f', affected: [] },
    ]
    const compile: CompileFinding[] = [
      { id: 'finding-i1->d->i2', severity: 'error', kind: 'blocked-path', message: 'm', affected: [] },
      { id: 'finding-vol-x', severity: 'warning', kind: 'stateful-without-volume', message: 'm2', affected: [] },
    ]
    const kept = unsuppressedCompileFindings(analysis, compile)
    expect(kept.map(f => f.id)).toEqual(['finding-vol-x'])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/world/panels/AnalysisTab.test.tsx`
Expected: FAIL — `Cannot find module './AnalysisTab'`.

- [ ] **Step 3: Write `src/app/world/panels/AnalysisTab.tsx`**

```tsx
// Analysis tab (Phase 6 D4): merges deterministic analysis findings (runAnalysis) with the
// unsuppressed compile findings, grouped by family, with clickable affected chips that navigate.
import { useMemo, type ReactElement, type CSSProperties } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useNavStore } from '../../store/nav.store'
import { useCompiledWorld } from '../useCompiledWorld'
import { runAnalysis } from '../../../lib/analysis/runAnalysis'
import type { AnalysisFinding, AnalysisFamily, AnalysisSeverity } from '../../../lib/analysis/types'
import type { WorldDoc, CompiledWorld, CompileFinding } from '../../../lib/world/types'
import { sectionLabel } from './panelStyles'

export interface NavApi {
  goRegion: (regionId: string) => void
  goAz: (regionId: string, azId: string) => void
  goServer: (regionId: string, azId: string, serverId: string) => void
}

// Resolve an entity id against doc → compiled maps and navigate; returns whether nav happened.
export function navigateToEntity(id: string, doc: WorldDoc, compiled: CompiledWorld, nav: NavApi): boolean {
  if (doc.regions[id]) { nav.goRegion(id); return true }
  const az = doc.azs[id]
  if (az) { nav.goAz(az.regionId, id); return true }
  const server = doc.servers[id]
  if (server) {
    const a = doc.azs[server.azId]
    if (a) { nav.goServer(a.regionId, a.id, id); return true }
  }
  const inst = compiled.instances[id]
  if (inst) { nav.goServer(inst.regionId, inst.azId, inst.serverId); return true }
  return false // blueprint/placement/population/managed → no nav (shown in panels)
}

// Compile findings not already claimed by a blocked-dependency-path analysis finding (D4).
export function unsuppressedCompileFindings(analysis: AnalysisFinding[], compile: CompileFinding[]): CompileFinding[] {
  const claimed = new Set(
    analysis.filter(f => f.ruleId === 'blocked-dependency-path').map(f => f.id.slice('blocked-dependency-path:'.length)),
  )
  return compile.filter(cf => {
    if (cf.kind !== 'blocked-path') return true
    const pathId = cf.id.startsWith('finding-') ? cf.id.slice('finding-'.length) : cf.id
    return !claimed.has(pathId)
  })
}

const FAMILY_LABEL: Record<AnalysisFamily, string> = { structural: 'Structural', network: 'Network', capacity: 'Capacity' }
const SEV_COLOR: Record<AnalysisSeverity, string> = {
  critical: 'var(--color-danger)', warning: 'var(--color-warning)', info: 'var(--color-text-muted)',
}
const chipBtn: CSSProperties = {
  background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)', borderRadius: 3,
  padding: '1px 6px', margin: '0 4px 4px 0', cursor: 'pointer',
  font: '10px var(--font-mono)', color: 'var(--color-text-secondary)',
}
const sevChip = (sev: AnalysisSeverity | 'error' | 'warning'): CSSProperties => ({
  padding: '1px 6px', borderRadius: 3, font: '10px var(--font-mono)', color: '#fff',
  background: sev === 'critical' || sev === 'error' ? 'var(--color-danger)'
    : sev === 'warning' ? 'var(--color-warning)' : 'var(--color-text-muted)',
})

function entityLabel(id: string, doc: WorldDoc, compiled: CompiledWorld): string {
  if (doc.regions[id]) return doc.regions[id].catalogId
  if (doc.azs[id]) return doc.azs[id].label
  if (doc.servers[id]) return doc.servers[id].label
  if (doc.blueprints[id]) return doc.blueprints[id].name
  if (doc.managedServices[id]) return doc.managedServices[id].label
  if (doc.populations[id]) return doc.populations[id].label
  const inst = compiled.instances[id]
  if (inst) return `${doc.servers[inst.serverId]?.label ?? inst.serverId}·${doc.blueprints[inst.blueprintId]?.name ?? ''}`
  return id
}

function AffectedChips({ ids, doc, compiled }: { ids: string[]; doc: WorldDoc; compiled: CompiledWorld }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', marginTop: 4 }}>
      {ids.map(id => {
        const canNav = navigateToEntity(id, doc, compiled, { goRegion: () => {}, goAz: () => {}, goServer: () => {} })
        return (
          <button key={id} style={chipBtn} title={canNav ? 'navigate' : 'edit via panels'}
            onClick={() => navigateToEntity(id, doc, compiled, useNavStore.getState())}>
            {entityLabel(id, doc, compiled)}
          </button>
        )
      })}
    </div>
  )
}

function FindingRow({ f, doc, compiled }: { f: AnalysisFinding; doc: WorldDoc; compiled: CompiledWorld }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={sevChip(f.severity)}>{f.severity}</span>
        <span style={{ color: 'var(--color-text-primary)' }}>{f.title}</span>
      </div>
      <div style={{ marginTop: 2, color: 'var(--color-text-secondary)' }}>{f.why}</div>
      <div style={{ marginTop: 2, color: 'var(--color-text-muted)' }}>→ {f.fix}</div>
      {f.affected.length > 0 && <AffectedChips ids={f.affected} doc={doc} compiled={compiled} />}
    </div>
  )
}

export function AnalysisTab(): ReactElement {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const displayBatch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const findings = useMemo(() => runAnalysis(doc, compiled, displayBatch), [compiled, displayBatch?.simMs])
  const compileExtra = useMemo(() => unsuppressedCompileFindings(findings, compiled.findings), [findings, compiled.findings])

  const families: AnalysisFamily[] = ['structural', 'network', 'capacity']
  const groups = families.map(fam => ({ fam, items: findings.filter(f => f.family === fam) })).filter(g => g.items.length > 0)
  const empty = groups.length === 0 && compileExtra.length === 0

  return (
    <div>
      {empty && <div style={{ color: 'var(--color-text-muted)' }}>No findings — the compiled world is clean.</div>}
      {groups.map(g => (
        <div key={g.fam}>
          <div style={sectionLabel}>{FAMILY_LABEL[g.fam]}</div>
          {g.items.map(f => <FindingRow key={f.id} f={f} doc={doc} compiled={compiled} />)}
        </div>
      ))}
      {compileExtra.length > 0 && (
        <div>
          <div style={sectionLabel}>Compile</div>
          {compileExtra.map(cf => (
            <div key={cf.id} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={sevChip(cf.severity)}>{cf.severity}</span>
                <span style={{ color: 'var(--color-text-secondary)' }}>{cf.kind}</span>
              </div>
              <div style={{ marginTop: 2 }}>{cf.message}</div>
              {cf.affected.length > 0 && <AffectedChips ids={cf.affected} doc={doc} compiled={compiled} />}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

> `AffectedChips` computes `canNav` with a no-op nav to decide the tooltip, then navigates with the real
> `useNavStore.getState()` on click — the double call is cheap (pure lookups) and keeps navigation logic
> in the single `navigateToEntity` helper.

- [ ] **Step 4: Modify `src/app/world/panels/WorldPanel.tsx`** (tab rename + merged count + mount)

```diff
 import { useState } from 'react'
+import { useMemo } from 'react'
 import { TopologyPanel } from './TopologyPanel'
 import { BlueprintPanel } from './BlueprintPanel'
 import { PlacementPanel } from './PlacementPanel'
 import { TrafficPanel } from './TrafficPanel'
+import { AnalysisTab, unsuppressedCompileFindings } from './AnalysisTab'
 import { useCompiledWorld } from '../useCompiledWorld'
+import { useWorldStore } from '../../store/world.store'
+import { useSimulationStore } from '../../store/simulation.store'
+import { runAnalysis } from '../../../lib/analysis/runAnalysis'
 import { EventsTab } from '../EventsTab'
 import { CostTab } from '../CostTab'
-import { panel, smallBtn, sectionLabel } from './panelStyles'
+import { panel, smallBtn } from './panelStyles'

-type Tab = 'topology' | 'blueprints' | 'placements' | 'traffic' | 'findings' | 'events' | 'cost'
+type Tab = 'topology' | 'blueprints' | 'placements' | 'traffic' | 'analysis' | 'events' | 'cost'

 export function WorldPanel({ running, placeMode, onTogglePlaceMode, selectedPopulationId }: WorldPanelProps) {
   const [tab, setTab] = useState<Tab>('topology')
-  const { findings } = useCompiledWorld()
+  const compiled = useCompiledWorld()
+  const doc = useWorldStore(s => s.doc)
+  const displayBatch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
+  const analysis = useMemo(() => runAnalysis(doc, compiled, displayBatch), [compiled, displayBatch?.simMs])
+  const analysisCount = analysis.length + unsuppressedCompileFindings(analysis, compiled.findings).length
   const tabs: { id: Tab; label: string }[] = [
     { id: 'topology', label: 'Topology' },
     { id: 'blueprints', label: 'Blueprints' },
     { id: 'placements', label: 'Placements' },
     { id: 'traffic', label: 'Traffic' },
-    { id: 'findings', label: `Findings (${findings.length})` },
+    { id: 'analysis', label: `Analysis (${analysisCount})` },
     { id: 'events', label: 'Events' },
     { id: 'cost', label: 'Cost' },
   ]
```

And replace the inline findings block with the tab component:
```diff
-        {tab === 'findings' && (
-          <div>
-            <div style={sectionLabel}>Findings</div>
-            {findings.length === 0 && (
-              <div style={{ color: 'var(--color-text-muted)' }}>No findings — the compiled world is clean.</div>
-            )}
-            {findings.map(f => ( ...inline JSX... ))}
-          </div>
-        )}
+        {tab === 'analysis' && <AnalysisTab />}
```

(Delete the now-unused `sectionLabel` import if nothing else uses it — the diff above already drops it
from the import list; verify no other reference remains in the file before removing.)

- [ ] **Step 5: Modify `src/app/world/panels/WorldPanel.test.tsx`** (click `Analysis (…)`)

```diff
   it('shows the stateful-without-volume finding for a stateful blueprint with no volume', () => {
     const bpId = useWorldStore.getState().addBlueprint('api')
     useWorldStore.getState().updateBlueprint(bpId, { stateful: true, volumeName: null })

     render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} />)
-    fireEvent.click(screen.getByText(/Findings \(\d+\)/))
+    fireEvent.click(screen.getByText(/Analysis \(\d+\)/))

     expect(screen.getByText(/is stateful but has no volume configured/)).toBeInTheDocument()
   })

   it('shows the empty state when there are no findings', () => {
     render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} />)
-    fireEvent.click(screen.getByText(/Findings \(0\)/))
+    fireEvent.click(screen.getByText(/Analysis \(0\)/))
     expect(screen.getByText('No findings — the compiled world is clean.')).toBeInTheDocument()
   })
```

(The stateful-without-volume message is an unsuppressed compile finding rendered in AnalysisTab's
"Compile" section, so it still shows.)

- [ ] **Step 6: Run + build**

Run: `npx vitest run src/app/world/panels/AnalysisTab.test.tsx src/app/world/panels/WorldPanel.test.tsx`
→ PASS. `npx vitest run` → full suite green; `npm run build` → strict tsc + vite green.

- [ ] **Step 7: Live smoke** (controller-run, strict port 1420, ZERO app console errors, screenshots,
stop server after)

Author (via `__scalemapDebug`) a world tripping ≥4 rules across families: a single-AZ region
(single-az-region), a db target server with an allow-from-any rule (db-port-exposed), a tiny-RAM host
with a large container memLimit (ram-oversubscribed), and `dnsTtlSec=5` (ttl-outlives-detection). Open
the Analysis tab → the three family sections appear with the findings; click a server/AZ/region affected
chip → the app navigates to that scope (screenshot per hop). Stop the dev server.

- [ ] **Step 8: Commit**

```bash
git add src/app/world/panels/AnalysisTab.tsx src/app/world/panels/AnalysisTab.test.tsx \
  src/app/world/panels/WorldPanel.tsx src/app/world/panels/WorldPanel.test.tsx
git commit -m "feat(analysis): analysis tab with family grouping and entity navigation"
```
