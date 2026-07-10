# Phase 6: Analysis Engine + LLM Reviewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the final phase of the world-model rebuild — a deterministic three-family analysis rule engine over the compiled world, a BYO-endpoint (OpenAI-compatible) LLM architecture reviewer, and a global Settings surface that makes the existing theme system's dark/light toggle live for the first time.

**Architecture:** Layer 1 is a pure `src/lib/analysis/` module (types + one file per rule family + a single `ANALYSIS_RULES` registry + `runAnalysis`) consumed by an upgraded Analysis tab that merges compile findings. Layer 2 is a Rust-side `llm_chat` Tauri command (CORS-free BYO endpoint) plus a pure `src/lib/llmReview.ts` context builder / schema validator / retrying client, surfaced as AI-tagged cards beside the deterministic findings. API keys persist only in the app data dir via Tauri commands and never touch `.scalemap`, logs, errors, or the review context.

**Tech Stack:** TypeScript + React 19 + Zustand + Tauri 2 (Rust `reqwest` 0.12 rustls). No new npm dependencies; JSON-schema validation is hand-rolled.

## Global Constraints (every task inherits these)

- Branch: `phase6-analysis`, cut from `main` (Phase 5 merged; main ≥ `ee51f6a`).
- NO changes under `src/lib/worldEngine/` except T9's sanctioned one-liner (export
  `MAX_GLOBE_ARCS` — a carry-forward). Contract types FROZEN. Forced drift →
  `.superpowers/sdd/contract-drift.md` `## PHASE 6`.
- strict tsc; `npm run build` green per commit; `cargo build` (from `src-tauri/`) green
  for every task touching Rust.
- SECURITY (spec D6, non-negotiable): the API key is never serialized into `.scalemap`
  (settings never touch `world.store`/`serializer`), never logged or `console.*`'d,
  never included in review-context payloads, REDACTED from every error string on both
  sides, rendered only masked after save, input type=password. Any test or smoke that
  can assert one of these, must.
- New dependency allowed: `reqwest = { version = "0.12", default-features = false,
  features = ["json", "rustls-tls"] }` in `src-tauri/Cargo.toml` (T5 only). NO new npm
  dependencies anywhere (JSON-schema validation is hand-rolled).
- Full `border` shorthand rule; jsdom pragma + jest-dom for component tests; pure tests
  node env; views read stores; world mutations via existing actions (this phase adds
  NONE — analysis findings are derived data, LLM settings live outside the world doc).
- Theme: all new UI uses `var(--color-*)` tokens exclusively — the theme toggle goes
  LIVE this phase, so hardcoded palette hexes are now user-visible bugs, not latent ones.
- Live smokes controller-run on strict port 1420 (browser + `tauriMock` transport), ZERO
  app console errors, screenshots, stop servers (dev + stub) after. The Rust transport's
  gate is `cargo test` + `cargo build`, NOT the browser smoke — say so in reports.
- Ledger: `.superpowers/sdd/progress.md` `## PHASE 6`. Boundaries doc gains §O (T9).

## File Structure

```
src/lib/analysis/                       # NEW — Layer 1
  types.ts                              # T1: AnalysisFinding, AnalysisRule, families
  runAnalysis.ts                        # T1: registry + runner
  rules/structural.ts (+ .test.ts)      # T1: 6 rules
  rules/network.ts (+ .test.ts)         # T2: 3 rules
  rules/capacity.ts (+ .test.ts)        # T3: 4 rules
  __fixtures__/worlds.ts                # T1 (shared rule fixtures; T2/T3 extend)
src/lib/llmReview.ts (+ .test.ts)       # T6: context builder + request/validate/retry
src/app/world/panels/AnalysisTab.tsx    # T4 (+ .test.tsx): replaces the findings tab body
src/app/world/panels/WorldPanel.tsx     # T4: tab rename findings→analysis; T8 mounts AI section
src/app/world/panels/AiReviewSection.tsx# T8 (+ .test.tsx)
src/app/world/SettingsModal.tsx         # T7 (+ .test.tsx): ⚙ gear, Appearance + AI Review
src/app/world/WorldShell.tsx            # T7: gear button in header
src/lib/tauri.ts + src/lib/tauriMock.ts # T5: llm settings + chat wrappers (+ mock)
src-tauri/src/commands.rs               # T5: save/load_llm_settings, llm_chat (+ pure helpers)
src-tauri/src/lib.rs                    # T5: register 3 commands
src-tauri/Cargo.toml                    # T5: reqwest
scripts/llm-stub.mjs                    # T8: OpenAI-compatible smoke stub (canned + malformed-first)
CLAUDE.md                               # T9: rewrite for the world-model app
docs/module-boundaries.md               # T9: §O
```

Dependency order: T1 → T2 → T3 → T4; T5 → T6; T7 after T5; T8 after {T4, T6, T7};
T9 last. Serial T1…T9.

---
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
# Phase 6 plan fragment — Tasks 5–8 (Rust+TS LLM transport · review client · settings
# modal/theme toggle · AI review section + stub)

> Fragment scope: Task 5 (Rust `save_llm_settings`/`load_llm_settings`/`llm_chat` commands + TS
> wrappers), Task 6 (`src/lib/llmReview.ts` — context builder / schema validator / retrying
> client), Task 7 (`SettingsModal.tsx` + WorldShell gear button + live theme toggle), Task 8
> (`AiReviewSection.tsx` + `scripts/llm-stub.mjs`, mounted into the Analysis tab). Global
> Constraints / File Structure live in the skeleton's assembled header
> (`docs/superpowers/plans/phase6/skeleton.md`) — not repeated here.
>
> **Grounding status:** T5, T6, and T7 are grounded against REAL, currently-committed source —
> `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`, `src/lib/tauri.ts`,
> `src/lib/tauriMock.ts`, and `src/app/world/WorldShell.tsx` all exist today exactly as quoted
> below (verified `2026-07-10`, current `main` tip `4f3ce5a` — Phase 5's traffic-authoring task
> already lifted `placeMode`/`selectedPopulationId` into `WorldShell`, so T7's diff is written
> against that real, current file). T8 is different: it depends on Task 4's
> `AnalysisTab.tsx`/`WorldPanel.tsx` output, and **Tasks 1–4 have not executed yet** at
> fragment-writing time — `WorldPanel.tsx` today still has the OLD `'findings'` tab (verified,
> quoted in T8's grounding). T8's diffs are therefore written against a **reconstruction** of
> Task 4's exact contract (pinned verbatim in `skeleton.md` §Task 4 and `GROUNDING.md` §G — not
> invented here), flagged explicitly at that step. The implementer executing T8 (after T4 has
> actually landed) must apply that step's diff **intent** against the real T4 files rather than
> pasting the reconstruction verbatim if T4's literal internal structure differs in ways that
> don't affect the pinned contract (`navigateToEntity`, `unsuppressedCompileFindings`, the
> family-grouped render, the props-less `AnalysisTab()` signature T4 leaves for T8 to extend).
>
> **D6 SECURITY (non-negotiable, carried into every one of T5–T8's sections below):** the API
> key is NEVER serialized into `.scalemap` (settings live outside `world.store`/`serializer`),
> NEVER logged or `console.*`'d, NEVER included in review-context payloads, REDACTED from every
> error string on both Rust and TS sides, rendered ONLY masked (`•••• <last4>`) after save, input
> `type=password`. Each task below names the specific test that asserts its slice of this.

---

## Task 5: Rust — LLM settings + chat commands `[sonnet]`

**D6 asserting tests this task owns:** `redact_masks_key_everywhere_and_short_keys_entirely`
(Rust) + `llm_chat_redacts_key_from_connection_refused_error` (Rust).

**Files:** modify `src-tauri/Cargo.toml`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`,
`src/lib/tauri.ts`, `src/lib/tauriMock.ts`; create `src/lib/tauri.test.ts`.

**Grounding — real current source, quoted verbatim.**

`src-tauri/src/commands.rs` (66 lines, full file) already establishes the exact pattern to mirror
for `llm_settings.json` — an app-data-dir JSON file, `fs::create_dir_all`, `serde_json`,
default-on-any-error reads:
```rust
//! Tauri commands backing the frontend file shim (`src/lib/tauri.ts`).
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

const RECENT_FILES_FILE: &str = "recent_files.json";
const MAX_RECENT: usize = 10;
const DIAGRAM_FILTER_NAME: &str = "Scalemap Diagram";
const DIAGRAM_EXTENSION: &str = "scalemap";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentFile { pub path: String, pub name: String, pub modified: String }

fn recent_files_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("could not resolve app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("could not create app data dir: {e}"))?;
    Ok(dir.join(RECENT_FILES_FILE))
}
// ... read_recent/write_recent/touch_recent/file_name_of ...

#[tauri::command]
pub fn save_diagram(app: AppHandle, path: String, data: String) -> Result<(), String> { /* ... */ }
#[tauri::command]
pub fn load_diagram(path: String) -> Result<String, String> { /* ... */ }
#[tauri::command]
pub fn get_recent_files(app: AppHandle) -> Vec<RecentFile> { read_recent(&app) }
#[tauri::command]
pub async fn open_file_dialog(app: AppHandle) -> Option<String> { /* ... */ }
#[tauri::command]
pub async fn save_file_dialog(app: AppHandle) -> Option<String> { /* ... */ }
```
`src-tauri/src/lib.rs` (full file):
```rust
mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::save_diagram,
            commands::load_diagram,
            commands::get_recent_files,
            commands::open_file_dialog,
            commands::save_file_dialog,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```
`src-tauri/Cargo.toml` `[dependencies]` (full section):
```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-opener = "2"
tauri-plugin-dialog = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
chrono = { version = "0.4", default-features = false, features = ["clock"] }
```
`src/lib/tauri.ts` (full file, 30 lines):
```ts
import { tauriMock, type RecentFile } from './tauriMock'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri) {
    const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
    return tauriInvoke<T>(cmd, args)
  }
  const fn = (tauriMock as Record<string, (...a: unknown[]) => Promise<unknown>>)[cmd]
  if (!fn) throw new Error(`Unknown command: ${cmd}`)
  const argValues = args ? Object.values(args) : []
  return fn(...argValues) as Promise<T>
}

export const saveDiagram = (path: string, data: string) => invoke<void>('save_diagram', { path, data })
export const loadDiagram = (path: string) => invoke<string>('load_diagram', { path })
export const getRecentFiles = () => invoke<RecentFile[]>('get_recent_files')
export const openFileDialog = () => invoke<string | null>('open_file_dialog')
export const saveFileDialog = () => invoke<string | null>('save_file_dialog')

export type { RecentFile }
```
`src/lib/tauriMock.ts` (full file, 50 lines) — every `tauriMock` entry is a bare async function
keyed by the exact snake_case command name, called by `invoke`'s dynamic lookup:
```ts
const RECENT_FILES_KEY = 'scalemap:recent_files'
const DIAGRAMS_KEY = 'scalemap:diagram:'
export interface RecentFile { path: string; name: string; modified: string }
function getRecentFiles(): RecentFile[] { /* ... */ }
function addToRecent(path: string) { /* ... */ }
export const tauriMock = {
  async save_diagram(path: string, data: string): Promise<void> { /* ... */ },
  async load_diagram(path: string): Promise<string> { /* ... */ },
  async get_recent_files(): Promise<RecentFile[]> { return getRecentFiles() },
  async open_file_dialog(): Promise<string | null> { /* ... */ },
  async save_file_dialog(): Promise<string | null> { /* ... */ },
}
```

**Tauri v2 casing — VERIFIED finding (state this in the implementer's PR/commit notes too):**
command SCALAR argument names are camelCased on the JS side and mapped to snake_case Rust
parameter names by Tauri's macro (`base_url` ↔ `baseUrl`, `api_key` ↔ `apiKey`) — but **struct
FIELDS go through plain serde with their Rust names**, no Tauri casing layer touches them. So
`llmChat`'s wrapper calls `invoke('llm_chat', { baseUrl, apiKey, body })` (Tauri maps these
three scalar args to the snake_case Rust params), while `LlmSettings`'s fields stay snake_case
end-to-end and the **TS wrapper does the snake↔camel mapping explicitly** — `saveLlmSettings`
sends `{ settings: { base_url, api_key, model } }`, `loadLlmSettings` receives
`{ base_url, api_key, model }` back and maps it to camelCase before returning. This means
`llm_settings.json` on disk holds snake_case keys, consistent with `recent_files.json`'s
`RecentFile { path, name, modified }` (which happens to have no camelCase fields, so this
distinction was invisible until now — first struct-with-camelCase-conceptual-fields this repo
ships). **Confirm this by grep, don't take it on faith:** `grep -n "camelCase\|rename_all" -R
src-tauri/` turns up nothing repo-side — the casing behavior is Tauri's macro default, not a
repo convention, which is exactly why it's easy to get backwards; the implementer should sanity
check the wrapper against a real `cargo build` + a manual `npm run tauri dev` round trip if time
allows, not just the mock-transport tests below (the mock never exercises the real Tauri IPC
layer's casing at all).

Also confirmed: `Object.values(args)` in `invoke()`'s mock branch passes arguments **positionally
by object-key insertion order** — so `tauriMock.llm_chat(baseUrl, apiKey, body)`'s parameter
order must match the wrapper's `{ baseUrl, apiKey, body }` key order exactly (it does, below).

**Produces (exact, per `GROUNDING.md` §H):**
```rust
const LLM_SETTINGS_FILE: &str = "llm_settings.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LlmSettings { pub base_url: String, pub api_key: String, pub model: String }

fn redact(msg: &str, key: &str) -> String

#[tauri::command] pub fn save_llm_settings(app: AppHandle, settings: LlmSettings) -> Result<(), String>
#[tauri::command] pub fn load_llm_settings(app: AppHandle) -> LlmSettings
#[tauri::command] pub async fn llm_chat(base_url: String, api_key: String, body: String) -> Result<String, String>
```
```ts
export interface LlmSettings { baseUrl: string; apiKey: string; model: string }
export async function saveLlmSettings(s: LlmSettings): Promise<void>
export async function loadLlmSettings(): Promise<LlmSettings>
export async function llmChat(baseUrl: string, apiKey: string, body: string): Promise<string>
```

**Judgment call — `redact()`'s exact algorithm.** `GROUNDING.md`'s prose ("replace every
occurrence of `key` with `•••`; keys < 8 chars are masked entirely... short/empty key ⇒ do NOT
leak... Guard empty key (no-op replace of `""`)") reads two ways: (a) short keys get the WHOLE
message nuked to a placeholder, or (b) short keys still get precise substring-replacement — the
"masked entirely" phrase just reassures that even a short key's occurrences are fully replaced
(no partial leftover), and the ONLY real special case is guarding `msg.replace("", ...)`'s
insert-between-every-character footgun for an empty key. Reading (b) is more literal (the
`redact` doc comment's own words are "return msg with any occurrence replaced" — i.e. still doing
occurrence replacement) and is simpler/more testable, so this plan implements (b): a plain
substring `replace()` for any non-empty key, and a no-op passthrough for an empty key (nothing to
redact if no key was ever configured). **Flagging this as a genuine reading ambiguity in
`GROUNDING.md`'s phrasing, not silently picking one** — if the controller/reviewer intended (a),
swap `redact`'s body for a `key.len() < 8 → "[redacted]"` whole-message-scrub branch; the test
below would need updating to match (its two assertions on `out2`/short-key behavior are the ones
that would change).

- [ ] **Step 1: Write the failing Rust tests** (append to `src-tauri/src/commands.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_masks_key_everywhere_and_short_keys_entirely() {
        let key = "sk-super-secret-key-123"; // 23 chars — normal-length key
        let msg = format!("connect failed using key {key} and again {key} here");
        let out = redact(&msg, key);
        assert!(!out.contains(key), "raw key leaked: {out}");
        assert_eq!(out.matches('\u{2022}').count(), 6, "expected two '•••' markers (3 bullets each)");

        // Short key (< 8 chars) — still fully replaced wherever it appears, not left partially
        // visible or missed due to a length-based bug.
        let short = "abc123"; // 6 chars
        let msg2 = format!("error near {short} boundary, retrying {short}");
        let out2 = redact(&msg2, short);
        assert!(!out2.contains(short), "short key leaked: {out2}");

        // Empty key — no-op passthrough (nothing configured yet, nothing to redact) and,
        // critically, must NOT call `str::replace("", ...)` which would insert the marker
        // between every character of the message.
        let unchanged = redact("some upstream error text", "");
        assert_eq!(unchanged, "some upstream error text");
    }

    #[test]
    fn settings_serde_round_trip() {
        let s = LlmSettings {
            base_url: "https://api.openai.com/v1".to_string(),
            api_key: "sk-abc-123".to_string(),
            model: "gpt-4o-mini".to_string(),
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"base_url\""));
        assert!(json.contains("\"api_key\""));
        assert!(json.contains("\"model\""));
        let back: LlmSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.base_url, s.base_url);
        assert_eq!(back.api_key, s.api_key);
        assert_eq!(back.model, s.model);
    }

    #[test]
    fn llm_chat_returns_body_from_tcp_listener_stub() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let body = r#"{"choices":[{"message":{"content":"hi"}}]}"#;

        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf); // drain the request; this stub doesn't parse it
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body,
            );
            stream.write_all(response.as_bytes()).unwrap();
        });

        let base_url = format!("http://127.0.0.1:{port}");
        // NOTE (per Global Constraints — VERIFY, don't hard-assume): tauri::async_runtime::block_on
        // needs no new Cargo.toml dependency (tauri already depends on tokio transitively and
        // every existing async #[tauri::command] in this file — open_file_dialog/save_file_dialog
        // — already proves tauri's async infra works without one). If this genuinely fails to
        // compile/run in a plain #[test] (e.g. "no reactor running" panic), the dependency-free
        // constraint is violated either way by adding `tokio` as a dev-dependency for
        // `#[tokio::test]` — do that ONLY as a fallback, and log the deviation in
        // `.superpowers/sdd/contract-drift.md` `## PHASE 6` since Global Constraints says Cargo.toml
        // adds ONLY reqwest.
        let result = tauri::async_runtime::block_on(llm_chat(
            base_url,
            "sk-test-key-0123456789".to_string(),
            "{}".to_string(),
        ));
        handle.join().unwrap();

        assert_eq!(result.unwrap(), body);
    }

    #[test]
    fn llm_chat_redacts_key_from_connection_refused_error() {
        // Bind then immediately drop — frees the ephemeral port while guaranteeing nothing else
        // grabbed it in the interim, so connecting to it is a real OS-level refusal.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let key = "sk-should-never-leak-0000";
        let base_url = format!("http://127.0.0.1:{port}");
        let result = tauri::async_runtime::block_on(llm_chat(base_url, key.to_string(), "{}".to_string()));

        let err = result.expect_err("expected a transport error against a closed port");
        assert!(!err.contains(key), "raw api key leaked into error string: {err}");
    }
}
```

- [ ] **Step 2: Run to verify the tests fail (they won't even compile yet — that's the failure)**

Run (from `src-tauri/`): `cargo test`
Expected: FAIL to compile — `error[E0433]: failed to resolve: use of undeclared type
'LlmSettings'` / `cannot find function 'redact' in this scope` / `cannot find function 'llm_chat'
in this scope` (the struct/fn/command don't exist yet).

- [ ] **Step 3: Write the Rust implementation** (insert above the `#[cfg(test)]` block, after the
existing `save_file_dialog` function)

```rust
// ─── LLM settings + chat transport (Phase 6, D5/D6) ─────────────────────────────────
// Settings persist to `llm_settings.json` in the app data dir — the exact pattern
// `recent_files.json` already uses above. This file is DELIBERATELY never touched by
// save_diagram/load_diagram — the API key must never end up inside a `.scalemap` file
// (D6). `llm_chat` exists because a webview `fetch()` to an arbitrary third-party origin
// (OpenAI, OpenRouter, etc.) dies on CORS; this command is the only place the key ever
// leaves the process, and every error path passes through `redact()` first.

const LLM_SETTINGS_FILE: &str = "llm_settings.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LlmSettings {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

/// Replace every occurrence of `key` in `msg` with "•••". A no-op for an empty key (nothing
/// configured yet, nothing to redact — and this sidesteps `str::replace("", ...)`'s footgun of
/// inserting the marker between every character). Pure, unit-tested above.
fn redact(msg: &str, key: &str) -> String {
    if key.is_empty() {
        return msg.to_string();
    }
    msg.replace(key, "\u{2022}\u{2022}\u{2022}")
}

fn llm_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("could not create app data dir: {e}"))?;
    Ok(dir.join(LLM_SETTINGS_FILE))
}

#[tauri::command]
pub fn save_llm_settings(app: AppHandle, settings: LlmSettings) -> Result<(), String> {
    let path = llm_settings_path(&app)?;
    let raw = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| format!("could not write llm settings: {e}"))
}

/// Returns `LlmSettings::default()` (all empty strings) on ANY error — missing file, corrupt
/// JSON, unresolvable app data dir — so the Settings modal always has something to render.
#[tauri::command]
pub fn load_llm_settings(app: AppHandle) -> LlmSettings {
    let Ok(path) = llm_settings_path(&app) else {
        return LlmSettings::default();
    };
    let Ok(raw) = fs::read_to_string(&path) else {
        return LlmSettings::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

/// POSTs `body` verbatim to `{base_url}/chat/completions` with a Bearer auth header, 60s
/// timeout, and returns the raw response text for ANY HTTP status (the caller reads an
/// OpenAI-style `{error:{...}}` envelope itself when the provider signals failure via 4xx/5xx
/// with a JSON body — this command doesn't interpret status codes at all). Err is reserved for
/// TRANSPORT failures (DNS, connection refused, timeout) and always passes through `redact()`.
#[tauri::command]
pub async fn llm_chat(base_url: String, api_key: String, body: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| redact(&e.to_string(), &api_key))?;

    let url = format!("{base_url}/chat/completions");
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| redact(&e.to_string(), &api_key))?;

    response
        .text()
        .await
        .map_err(|e| redact(&e.to_string(), &api_key))
}
```

- [ ] **Step 4: Register the commands in `src-tauri/src/lib.rs`**

```diff
         .invoke_handler(tauri::generate_handler![
             commands::save_diagram,
             commands::load_diagram,
             commands::get_recent_files,
             commands::open_file_dialog,
             commands::save_file_dialog,
+            commands::save_llm_settings,
+            commands::load_llm_settings,
+            commands::llm_chat,
         ])
```

- [ ] **Step 5: Add the dependency to `src-tauri/Cargo.toml`**

```diff
 serde = { version = "1", features = ["derive"] }
 serde_json = "1"
 chrono = { version = "0.4", default-features = false, features = ["clock"] }
+reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }
```
This is the ONLY new dependency the whole phase adds (Global Constraints). `default-features =
false` + `rustls-tls` avoids pulling in a system OpenSSL dependency; `json` is included per the
pinned spec even though this command doesn't call `.json()` directly (it passes `body: String`
through verbatim and reads `.text()`) — don't drop it, it's the exact feature set the plan
mandates.

- [ ] **Step 6: Run `cargo test` and `cargo build` — BOTH gate this task, not the frontend build**

Run (from `src-tauri/`): `cargo test`
Expected: `running 4 tests ... test result: ok. 4 passed; 0 failed`. If
`llm_chat_returns_body_from_tcp_listener_stub`/`llm_chat_redacts_key_from_connection_refused_error`
panic with something like "there is no reactor running" or "must be called from the context of a
Tokio 1.x runtime", `tauri::async_runtime::block_on` needs an explicit runtime bootstrap in this
crate's test harness — see the judgment-call note inline above; do not silently add `tokio` as a
dependency without logging the deviation.

Run (from `src-tauri/`): `cargo build`
Expected: clean build, no warnings about unused imports.

**A green `npm run build` does NOT gate this task — say so explicitly**, per Global Constraints:
the frontend build only exercises the TS wrapper against the MOCK transport (Step 8 below); the
Rust transport itself is gated exclusively by `cargo test` + `cargo build` above.

- [ ] **Step 7: Modify `src/lib/tauri.ts`** (append after the existing exports)

```diff
 export const saveFileDialog = () =>
   invoke<string | null>('save_file_dialog')

 export type { RecentFile }
+
+export interface LlmSettings {
+  baseUrl: string
+  apiKey: string
+  model: string
+}
+
+// Field names cross the Rust boundary as snake_case: `LlmSettings`' struct FIELDS go through
+// serde with their Rust names (Tauri v2 only camelCases command SCALAR ARG names — e.g.
+// `base_url` <-> `baseUrl` — never struct field names; verified against tauri-macros' actual
+// casing behavior, see this task's grounding notes). These two wrappers are the ONLY place that
+// snake<->camel mapping happens; every other caller in the app uses the camelCase LlmSettings
+// shape below, never the raw Rust field names.
+export async function saveLlmSettings(settings: LlmSettings): Promise<void> {
+  return invoke<void>('save_llm_settings', {
+    settings: { base_url: settings.baseUrl, api_key: settings.apiKey, model: settings.model },
+  })
+}
+
+export async function loadLlmSettings(): Promise<LlmSettings> {
+  const r = await invoke<{ base_url: string; api_key: string; model: string }>('load_llm_settings')
+  return { baseUrl: r.base_url ?? '', apiKey: r.api_key ?? '', model: r.model ?? '' }
+}
+
+export async function llmChat(baseUrl: string, apiKey: string, body: string): Promise<string> {
+  return invoke<string>('llm_chat', { baseUrl, apiKey, body })
+}
```

- [ ] **Step 8: Modify `src/lib/tauriMock.ts`**

```diff
 const RECENT_FILES_KEY = 'scalemap:recent_files'
 const DIAGRAMS_KEY = 'scalemap:diagram:'
+const LLM_SETTINGS_KEY = 'scalemap:llm_settings'

 export interface RecentFile {
   path: string
   name: string
   modified: string
 }
+
+interface StoredLlmSettings { base_url: string; api_key: string; model: string }
```
```diff
   async save_file_dialog(): Promise<string | null> {
     return `diagram-${Date.now()}.scalemap`
   },
+
+  // Browser-dev only, mirrors llm_settings.json's snake_case shape. D6: this stores the settings
+  // object to localStorage for local dev convenience ONLY — it must never be reached from
+  // world.store/serializer (a completely separate persistence path — see saveWorld/serializer.ts,
+  // untouched by this phase), and must never console.* the key.
+  async save_llm_settings(settings: StoredLlmSettings): Promise<void> {
+    localStorage.setItem(LLM_SETTINGS_KEY, JSON.stringify(settings))
+  },
+
+  async load_llm_settings(): Promise<StoredLlmSettings> {
+    try {
+      return JSON.parse(localStorage.getItem(LLM_SETTINGS_KEY) ?? '')
+    } catch {
+      return { base_url: '', api_key: '', model: '' }
+    }
+  },
+
+  // Browser-dev only: a direct fetch() to whatever endpoint the user configured — fine for
+  // Ollama/LM Studio/local stubs where the user controls CORS (real desktop builds go through
+  // the Rust llm_chat command instead, which has no CORS restriction).
+  async llm_chat(baseUrl: string, apiKey: string, body: string): Promise<string> {
+    const r = await fetch(`${baseUrl}/chat/completions`, {
+      method: 'POST',
+      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
+      body,
+    })
+    return r.text()
+  },
 }
```

- [ ] **Step 9: Write the failing TS test `src/lib/tauri.test.ts`**

```ts
// src/lib/tauri.test.ts
// @vitest-environment jsdom
// The mock transport (isTauri === false in jsdom, no window.__TAURI_INTERNALS__) round-trips
// through localStorage — this proves the wrapper's snake<->camel mapping (Step 7) matches the
// mock's snake-case storage shape (Step 8) end to end, and that the stored JSON never grows a
// forbidden extra key (D6 sanity: the shape is exactly {base_url,api_key,model}, nothing else).
import { describe, it, expect, beforeEach } from 'vitest'
import { saveLlmSettings, loadLlmSettings } from './tauri'

describe('llm settings wrapper (mock transport)', () => {
  beforeEach(() => localStorage.clear())

  it('round-trips camelCase in/out through the snake_case-stored mock', async () => {
    await saveLlmSettings({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test-abc', model: 'gpt-4o-mini' })

    const raw = localStorage.getItem('scalemap:llm_settings')
    expect(raw).toBeTruthy()
    const stored = JSON.parse(raw!)
    expect(Object.keys(stored).sort()).toEqual(['api_key', 'base_url', 'model'])
    expect(stored.base_url).toBe('https://api.openai.com/v1')
    expect(stored.api_key).toBe('sk-test-abc')

    const loaded = await loadLlmSettings()
    expect(loaded).toEqual({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test-abc', model: 'gpt-4o-mini' })
  })

  it('load returns empty-string defaults when nothing is stored', async () => {
    const loaded = await loadLlmSettings()
    expect(loaded).toEqual({ baseUrl: '', apiKey: '', model: '' })
  })
})
```

- [ ] **Step 10: Run to verify it fails, then passes**

Run: `npx vitest run src/lib/tauri.test.ts`
Expected (before Steps 7–8 land): FAIL — `saveLlmSettings is not exported from './tauri'`. After:
PASS (2 tests).

- [ ] **Step 11: Full verify**

Run: `npx vitest run src/lib/tauri.test.ts` → PASS (2 tests).
Run: `npm run build` → strict tsc + vite build green.
Run (from `src-tauri/`): `cargo test` → PASS (4 tests).
Run (from `src-tauri/`): `cargo build` → clean.

- [ ] **Step 12: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/commands.rs src-tauri/src/lib.rs \
  src/lib/tauri.ts src/lib/tauriMock.ts src/lib/tauri.test.ts
git commit -m "feat(llm): rust-side llm settings persistence and chat transport"
```

---

## Task 6: Review client `[sonnet]`

**D6 asserting test this task owns:** `context contains no apiKey value (canary scan)`.

**Files:** create `src/lib/llmReview.ts`, `src/lib/llmReview.test.ts`.

**Grounding — types this file reads** (all previously pinned, re-quoted for this task's use):
`WorldDoc`/`CompiledWorld`/`CompileFinding` (`src/lib/world/types.ts`), `MetricsBatch` +
`InstanceMetrics`/`ServerMetrics`/`AzMetrics`/`RegionMetrics`/`WorldMetrics` (verbatim,
`src/lib/worldEngine/types.ts`):
```ts
export interface InstanceMetrics { instanceId; rps; errorRate; p50Ms; p99Ms; activeConnections; cpuCoresUsed; ramMb; health }
export interface ServerMetrics { serverId; coreUtilization: number[]; stealFraction; burstCredits: number | null;
  ramByInstance: { instanceId; blueprintId; ramMb }[]; ramUsedMb; ramTotalMb; nicInMbps; nicOutMbps; diskIoFraction; health }
export interface RegionMetrics { regionId; rps; errorRate; p50Ms; healthScore; health; inboundByPopulation: { populationId; rps }[] }
export interface AzMetrics { azId; rps; errorRate; p50Ms; healthScore; health; serverCount; instanceCount }
export interface WorldMetrics { totalRps; errorRate; populationRoutes: {...}[]; crossAzBytesPerSec; crossRegionBytesPerSec; internetEgressBytesPerSec }
export interface MetricsBatch { simMs; instances: Record<InstanceId, InstanceMetrics>; servers: Record<ServerId, ServerMetrics>;
  azs: Record<AzId, AzMetrics>; regions: Record<RegionId, RegionMetrics>; world: WorldMetrics }
```
`AnalysisFinding` (`src/lib/analysis/types.ts`, T1's contract, pinned in `GROUNDING.md` §C):
`{ id; ruleId; family; severity; title; why; fix; affected: string[] }`. `CompileFinding`
(`src/lib/world/types.ts`): `{ id; severity: 'error'|'warning'; kind; message; affected }`.
`LlmSettings` (T5, `src/lib/tauri.ts`): `{ baseUrl; apiKey; model }` — **imported, not redefined**
(seam per `GROUNDING.md` §M).

Test fixtures reuse `createWorld`/`createRegion` from `src/lib/world/factories.ts` and
`compileWorld` from `src/lib/world/compileWorld.ts` — same fixture-builder style as every other
Phase 6 rule-family test file.

**Produces (exact, per `GROUNDING.md` §I):**
```ts
import type { WorldDoc, CompiledWorld } from './world/types'
import type { MetricsBatch } from './worldEngine/types'
import type { AnalysisFinding } from './analysis/types'
import { llmChat, type LlmSettings } from './tauri'

export interface AiIssue {
  title: string
  severity: 'critical' | 'warning' | 'info'
  confidence: number
  affected: string[]
  reasoning: string
  recommendation: string
  estimated_effort: 'low' | 'medium' | 'high'
}

export function buildReviewContext(doc: WorldDoc, compiled: CompiledWorld, findings: AnalysisFinding[], lastBatch: MetricsBatch | null): string
export function validateReviewResponse(raw: string): AiIssue[]
export function requestReview(settings: LlmSettings, context: string, chat?: typeof llmChat): Promise<AiIssue[]>
export function pingLlm(settings: LlmSettings, chat?: typeof llmChat): Promise<void>
```

- [ ] **Step 1: Write the failing test `src/lib/llmReview.test.ts`** (pure — node env, no
`@vitest-environment` pragma; `chat` is always injected in these tests, so `tauri.ts`'s
`isTauri`/`window` guard is never exercised and never needs jsdom)

```ts
// src/lib/llmReview.test.ts
import { describe, it, expect, vi } from 'vitest'
import {
  buildReviewContext, validateReviewResponse, requestReview, pingLlm, type AiIssue,
} from './llmReview'
import { createWorld, createRegion } from './world/factories'
import { compileWorld } from './world/compileWorld'
import type { LlmSettings } from './tauri'
import type { MetricsBatch } from './worldEngine/types'

const SETTINGS: LlmSettings = { baseUrl: 'http://localhost:4141/v1', apiKey: 'sk-test', model: 'gpt-4o-mini' }

function envelope(content: string): string {
  return JSON.stringify({ choices: [{ message: { content } }] })
}

function issuesJson(issues: Partial<AiIssue>[]): string {
  return '```json\n' + JSON.stringify({ issues }) + '\n```'
}

describe('buildReviewContext', () => {
  it('contains no apiKey value (canary scan)', () => {
    const doc = createWorld()
    const compiled = compileWorld(doc)
    const context = buildReviewContext(doc, compiled, [], null)
    expect(context).not.toMatch(/apiKey/i)
    expect(context).not.toMatch(/api_key/i)
  })

  it('aggregates region metrics and omits raw instance/server maps', () => {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    doc.regions[region.id] = region
    const compiled = compileWorld(doc)

    const batch: MetricsBatch = {
      simMs: 5000,
      instances: {
        'inst-secret-1': {
          instanceId: 'inst-secret-1', rps: 10, errorRate: 0, p50Ms: 5, p99Ms: 9,
          activeConnections: 2, cpuCoresUsed: 0.3, ramMb: 128, health: 'healthy',
        },
      },
      servers: {
        'srv-secret-1': {
          serverId: 'srv-secret-1', coreUtilization: [0.4], stealFraction: 0, burstCredits: null,
          ramByInstance: [], ramUsedMb: 128, ramTotalMb: 4096, nicInMbps: 1, nicOutMbps: 1,
          diskIoFraction: 0, health: 'healthy',
        },
      },
      azs: {},
      regions: {
        [region.id]: {
          regionId: region.id, rps: 42, errorRate: 0.02, p50Ms: 18, healthScore: 91,
          health: 'healthy', inboundByPopulation: [],
        },
      },
      world: {
        totalRps: 42, errorRate: 0.02, populationRoutes: [],
        crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0,
      },
    }

    const context = buildReviewContext(doc, compiled, [], batch)
    const parsed = JSON.parse(context) as {
      metrics: { world: { totalRps: number; errorRate: number }; regions: unknown[]; azs: unknown[] }
    }
    expect(parsed.metrics.world).toEqual({ totalRps: 42, errorRate: 0.02 })
    expect(parsed.metrics.regions).toEqual([
      { id: region.id, rps: 42, errorRate: 0.02, p50Ms: 18, health: 'healthy' },
    ])
    expect(context).not.toContain('inst-secret-1')
    expect(context).not.toContain('srv-secret-1')
  })
})

describe('requestReview', () => {
  it('happy path parses fenced json', async () => {
    const chat = vi.fn().mockResolvedValue(envelope(issuesJson([
      { title: 'ok', severity: 'critical', confidence: 0.9, affected: ['x'], reasoning: 'r', recommendation: 'y', estimated_effort: 'high' },
    ])))
    const issues = await requestReview(SETTINGS, 'ctx', chat)
    expect(issues).toEqual([
      { title: 'ok', severity: 'critical', confidence: 0.9, affected: ['x'], reasoning: 'r', recommendation: 'y', estimated_effort: 'high' },
    ])
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('malformed then valid succeeds via one retry with corrective message appended', async () => {
    const chat = vi.fn()
      .mockResolvedValueOnce(envelope('not json at all'))
      .mockResolvedValueOnce(envelope(issuesJson([
        { title: 'ok', severity: 'info', confidence: 0.5, affected: [], reasoning: 'r', recommendation: 'x', estimated_effort: 'low' },
      ])))

    const issues = await requestReview(SETTINGS, 'ctx', chat)
    expect(issues).toHaveLength(1)
    expect(issues[0].title).toBe('ok')
    expect(chat).toHaveBeenCalledTimes(2)

    const secondBody = JSON.parse(chat.mock.calls[1][2] as string) as { messages: { role: string; content: string }[] }
    expect(secondBody.messages.some(m => m.role === 'system' && /previous reply/i.test(m.content))).toBe(true)
  })

  it('two malformed responses throw gracefully', async () => {
    const chat = vi.fn().mockResolvedValue(envelope('still not json'))
    await expect(requestReview(SETTINGS, 'ctx', chat)).rejects.toThrow('malformed review response')
    expect(chat).toHaveBeenCalledTimes(2)
  })

  it('error envelope surfaces provider message', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ error: { message: 'rate limited, retry later' } }))
    await expect(requestReview(SETTINGS, 'ctx', chat)).rejects.toThrow('rate limited, retry later')
    expect(chat).toHaveBeenCalledTimes(1) // a provider error envelope isn't a "malformed content" case — no retry
  })

  it('severity/confidence/effort clamping', () => {
    const raw = issuesJson([
      { title: 'a', severity: 'BOGUS' as AiIssue['severity'], confidence: 5, affected: ['ok', 42 as unknown as string, null as unknown as string], reasoning: 'r', recommendation: 'x', estimated_effort: 'urgent' as AiIssue['estimated_effort'] },
      { title: 'b', severity: 'critical', confidence: -3, affected: [], reasoning: 'r2', recommendation: 'x2', estimated_effort: 'low' },
    ])
    const issues = validateReviewResponse(raw)
    expect(issues[0]).toMatchObject({ severity: 'info', confidence: 1, affected: ['ok'], estimated_effort: 'medium' })
    expect(issues[1]).toMatchObject({ severity: 'critical', confidence: 0, estimated_effort: 'low' })
  })
})

describe('pingLlm', () => {
  it('sends max_tokens 1', async () => {
    const chat = vi.fn().mockResolvedValue(envelope('pong'))
    await pingLlm(SETTINGS, chat)
    expect(chat).toHaveBeenCalledTimes(1)
    const body = JSON.parse(chat.mock.calls[0][2] as string) as { max_tokens: number; messages: { role: string; content: string }[] }
    expect(body.max_tokens).toBe(1)
    expect(body.messages).toEqual([{ role: 'user', content: 'ping' }])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/llmReview.test.ts`
Expected: FAIL — `Cannot find module './llmReview'`.

- [ ] **Step 3: Write `src/lib/llmReview.ts`**

```ts
// src/lib/llmReview.ts
// On-demand LLM architecture review (Phase 6, D7). Pure/mock-invoke-testable — `chat` is
// injectable and defaults to T5's llmChat wrapper. D6: this file must NEVER embed settings.apiKey
// (or any settings value) into buildReviewContext's payload — the canary-scan test above enforces
// this by stringify-scanning the emitted context for the literal property names apiKey/api_key.
import type { WorldDoc, CompiledWorld } from './world/types'
import type { MetricsBatch } from './worldEngine/types'
import type { AnalysisFinding } from './analysis/types'
import { llmChat, type LlmSettings } from './tauri'

export interface AiIssue {
  title: string
  severity: 'critical' | 'warning' | 'info'
  confidence: number
  affected: string[]
  reasoning: string
  recommendation: string
  estimated_effort: 'low' | 'medium' | 'high'
}

export function buildReviewContext(
  doc: WorldDoc,
  compiled: CompiledWorld,
  findings: AnalysisFinding[],
  lastBatch: MetricsBatch | null,
): string {
  const metrics = lastBatch
    ? {
        world: { totalRps: lastBatch.world.totalRps, errorRate: lastBatch.world.errorRate },
        regions: Object.values(lastBatch.regions).map(r => ({
          id: r.regionId, rps: r.rps, errorRate: r.errorRate, p50Ms: r.p50Ms, health: r.health,
        })),
        azs: Object.values(lastBatch.azs).map(a => ({
          id: a.azId, rps: a.rps, errorRate: a.errorRate, p50Ms: a.p50Ms, health: a.health,
        })),
      }
    : null

  const payload = {
    world: doc,
    deterministicFindings: findings.map(f => ({ ruleId: f.ruleId, severity: f.severity, title: f.title, affected: f.affected })),
    compileFindings: compiled.findings.map(f => ({ kind: f.kind, severity: f.severity, message: f.message })),
    metrics,
  }
  return JSON.stringify(payload)
}

const SEVERITIES = ['critical', 'warning', 'info'] as const
const EFFORTS = ['low', 'medium', 'high'] as const

function stripJsonFence(raw: string): string {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  return fenced ? fenced[1] : trimmed
}

function clampIssue(raw: unknown): AiIssue {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const severity = (SEVERITIES as readonly string[]).includes(r.severity as string)
    ? (r.severity as AiIssue['severity'])
    : 'info'
  const confNum = Number(r.confidence)
  const confidence = Number.isFinite(confNum) ? Math.max(0, Math.min(1, confNum)) : 0
  const affected = Array.isArray(r.affected) ? r.affected.filter((x): x is string => typeof x === 'string') : []
  const estimated_effort = (EFFORTS as readonly string[]).includes(r.estimated_effort as string)
    ? (r.estimated_effort as AiIssue['estimated_effort'])
    : 'medium'
  return {
    title: typeof r.title === 'string' ? r.title : '',
    severity,
    confidence,
    affected,
    reasoning: typeof r.reasoning === 'string' ? r.reasoning : '',
    recommendation: typeof r.recommendation === 'string' ? r.recommendation : '',
    estimated_effort,
  }
}

export function validateReviewResponse(raw: string): AiIssue[] {
  const stripped = stripJsonFence(raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    throw new Error('malformed review response')
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { issues?: unknown }).issues)) {
    throw new Error('malformed review response')
  }
  return (parsed as { issues: unknown[] }).issues.map(clampIssue)
}

const SCHEMA_HINT = `Respond ONLY with a single JSON object — no prose, no markdown fence — matching
this schema: { "issues": [ { "title": string, "severity": "critical"|"warning"|"info",
"confidence": number (0-1), "affected": string[] (entity ids), "reasoning": string,
"recommendation": string, "estimated_effort": "low"|"medium"|"high" } ] }`

const SYSTEM_PROMPT = `You are a senior infrastructure architect reviewing a compiled system
topology. You are given a list of deterministic findings already detected by static analysis —
do not repeat them verbatim; focus on issues those rules cannot see (cross-cutting risk, blast
radius, sequencing, cost/perf tradeoffs). ${SCHEMA_HINT}`

const CORRECTIVE_NOTE = `Your previous reply was not valid JSON matching the schema. ${SCHEMA_HINT}`

interface ChatMessage { role: string; content: string }

async function callAndExtractContent(
  settings: LlmSettings,
  messages: ChatMessage[],
  chat: typeof llmChat,
): Promise<string> {
  const body = { model: settings.model, response_format: { type: 'json_object' }, messages }
  const raw = await chat(settings.baseUrl, settings.apiKey, JSON.stringify(body))
  const parsed = JSON.parse(raw) as { error?: { message?: string }; choices?: { message: { content: string } }[] }
  if (parsed.error) throw new Error(parsed.error.message ?? 'LLM error')
  return parsed.choices![0].message.content
}

export async function requestReview(
  settings: LlmSettings,
  context: string,
  chat: typeof llmChat = llmChat,
): Promise<AiIssue[]> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: context },
  ]
  const content = await callAndExtractContent(settings, messages, chat)
  try {
    return validateReviewResponse(content)
  } catch {
    const retryMessages: ChatMessage[] = [...messages, { role: 'system', content: CORRECTIVE_NOTE }]
    const retryContent = await callAndExtractContent(settings, retryMessages, chat)
    return validateReviewResponse(retryContent) // rethrows on a second failure — no further retry
  }
}

export async function pingLlm(settings: LlmSettings, chat: typeof llmChat = llmChat): Promise<void> {
  const body = { model: settings.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }
  await chat(settings.baseUrl, settings.apiKey, JSON.stringify(body))
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/llmReview.test.ts` → PASS (8 tests: 2 buildReviewContext + 5
requestReview + 1 pingLlm).

- [ ] **Step 5: Full verify**

Run: `npx vitest run` → full suite green.
Run: `npm run build` → strict tsc + vite build green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/llmReview.ts src/lib/llmReview.test.ts
git commit -m "feat(llm): review context builder, schema validation, and retrying client"
```

---

## Task 7: Settings modal + theme toggle `[sonnet]`

**D6 asserting test this task owns:** `saved key renders masked and is not echoed into the input
value`.

**Files:** create `src/app/world/SettingsModal.tsx`, `src/app/world/SettingsModal.test.tsx`;
modify `src/app/world/WorldShell.tsx`.

**Grounding — real current source, quoted verbatim.**

`src/app/store/ui.store.ts` (full file — theme system is fully wired, NO new plumbing needed):
```ts
interface UiStore {
  themeMode: 'dark' | 'light'
  setThemeMode: (mode: 'dark' | 'light') => void
}
export const useUiStore = create<UiStore>((set) => ({
  themeMode: (localStorage.getItem('scalemap-theme-mode') as 'dark' | 'light') ?? 'dark',
  setThemeMode: (mode) => { localStorage.setItem('scalemap-theme-mode', mode); set({ themeMode: mode }) },
}))
```
`src/App.tsx`'s `useThemeBootstrap()` applies `--color-*` custom properties and
`document.documentElement.dataset.theme` on every `themeMode` change — the toggle below only
needs to call `setThemeMode`; the visual flip is already automatic.

`src/lib/theme.ts` `CATEGORY_COLORS.messaging.accent = '#9C8CE0'` (verified, line 77) — the
violet AI-chip color T8 needs; not this task's concern but confirmed here since both tasks read
the same file.

`src/index.css` confirms every token this modal uses already exists: `--color-node-border`,
`--color-surface`, `--color-node-base`, `--color-danger`, `--color-warning`, `--color-success`,
`--color-accent`, `--color-text-primary/secondary/muted`.

**The capture-phase Esc precedent** (`src/app/world/ServerView.tsx`, real source, verbatim —
Phase 3 already solved exactly this problem for its own escape-without-nav-change need):
```tsx
// WorldShell owns a `window` keydown listener in the BUBBLE phase that calls
// `useNavStore.getState().up()` on Escape, but first bails if `e.defaultPrevented`
// (WorldShell.tsx:44-49). ServerView mounts AFTER WorldShell, so a bubble-phase listener
// registered here would fire second and couldn't call preventDefault() in time. Registering
// in the CAPTURE phase instead guarantees this handler runs before WorldShell's bubble
// handler regardless of mount order — capture always precedes bubble for a `window` listener
// on an event that originates from a descendant node.
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
```
`SettingsModal` reuses this exact mechanism, with `stopPropagation()` added as the primary
mechanism (the modal isn't a `window`-scoped state clear like ServerView's selection — it must
guarantee WorldShell's bubble handler, ALSO on `window`, never runs at all for this keydown, not
just that it sees `defaultPrevented`; `stopPropagation` during the capture pass halts the event's
entire remaining traversal, including its own return trip through `window`'s bubble phase, so
`preventDefault` here is redundant belt-and-suspenders matching ServerView's own comment style,
not the sole guard).

`src/app/world/WorldShell.tsx` (full file, current real source, 144 lines — quoted in full since
this task's diff touches the header, the state list, and the render tree):
```tsx
// The app's entire post-home body: breadcrumb header + animated level router.
// AZ level renders <AzCanvas/> (Task 13); Task 14 adds file actions here.
import { useEffect, useState, type CSSProperties } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useNavStore } from '../store/nav.store'
import { useFileStore } from '../store/file.store'
import { useWorldStore } from '../store/world.store'
import { useSimulationStore } from '../store/simulation.store'
import { Breadcrumb } from './Breadcrumb'
import { SimControls } from './SimControls'
import { ScrubberV2 } from './ScrubberV2'
import { GlobeView } from './GlobeView'
import { RegionView } from './RegionView'
import { ServerView } from './ServerView'
import { WorldPanel } from './panels/WorldPanel'
import { AzCanvas } from './AzCanvas'
import { openWorldViaDialog, saveWorld } from './fileOps'

const hdrBtn: CSSProperties = {
  background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
  borderRadius: 4, padding: '3px 10px', cursor: 'pointer',
  font: '11px var(--font-mono)', color: 'var(--color-text-secondary)',
}

export function WorldShell() {
  const nav = useNavStore()
  const reduced = useReducedMotion()
  const dirty = useFileStore(s => s.dirty)
  const [fileError, setFileError] = useState<string | null>(null)
  const running = useSimulationStore(s => s.running)
  const [placeMode, setPlaceMode] = useState(false)
  const [selectedPopulationId, setSelectedPopulationId] = useState<string | null>(null)

  useEffect(() => {
    if (nav.level !== 'globe' && placeMode) setPlaceMode(false)
  }, [nav.level, placeMode])

  useEffect(() => { /* dev-only __scalemapDebug hook, unchanged */ }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return
      if (e.key === 'Escape') { useNavStore.getState().up(); return }
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); useWorldStore.getState().redo(); return }
      if (meta && e.key.toLowerCase() === 'z') { e.preventDefault(); useWorldStore.getState().undo(); return }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const view =
    nav.level === 'globe' ? (
      <GlobeView placeMode={placeMode} onExitPlaceMode={() => setPlaceMode(false)} onPopulationPlaced={setSelectedPopulationId} />
    ) :
    nav.level === 'region' ? <RegionView /> :
    nav.level === 'az' ? <AzCanvas /> :
    <ServerView />

  const viewKey = `${nav.level}:${nav.regionId ?? ''}:${nav.azId ?? ''}:${nav.serverId ?? ''}`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: 'var(--color-canvas)' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 16px', borderBottom: '1px solid var(--color-toolbar-border)', background: 'var(--color-toolbar)' }}>
        <Breadcrumb />
        <SimControls />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ font: '10px var(--font-mono)', color: 'var(--color-text-muted)' }}>esc = up one level</span>
          {dirty && <span style={{ color: 'var(--color-warning)', font: '10px var(--font-mono)' }}>● unsaved</span>}
          <button style={hdrBtn} onClick={() => { /* New */ }}>New</button>
          <button style={hdrBtn} onClick={() => { /* Open */ }}>Open</button>
          <button style={hdrBtn} onClick={() => { /* Save */ }}>Save</button>
          <button style={hdrBtn} onClick={() => { /* Save As */ }}>Save As</button>
        </div>
      </header>
      {fileError && ( /* unchanged */ )}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <main style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
          <AnimatePresence mode="wait">
            <motion.div key={viewKey} /* unchanged */>{view}</motion.div>
          </AnimatePresence>
        </main>
        <WorldPanel running={running} placeMode={placeMode} onTogglePlaceMode={() => setPlaceMode(p => !p)} selectedPopulationId={selectedPopulationId} />
      </div>
      <ScrubberV2 />
    </div>
  )
}
```

**Produces (exact, per `GROUNDING.md` §J):**
```tsx
export interface SettingsModalProps { open: boolean; onClose: () => void }
export function SettingsModal(props: SettingsModalProps): ReactElement | null
```

- [ ] **Step 1: Write the failing test `src/app/world/SettingsModal.test.tsx`**

```tsx
// src/app/world/SettingsModal.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SettingsModal } from './SettingsModal'
import { useUiStore } from '../store/ui.store'
import { useNavStore } from '../store/nav.store'
import * as tauri from '../../lib/tauri'

vi.mock('../../lib/tauri', () => ({
  loadLlmSettings: vi.fn(),
  saveLlmSettings: vi.fn(),
  pingLlm: vi.fn(),
}))

const mockLoad = tauri.loadLlmSettings as unknown as ReturnType<typeof vi.fn>
const mockSave = tauri.saveLlmSettings as unknown as ReturnType<typeof vi.fn>
const mockPing = tauri.pingLlm as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  mockLoad.mockReset().mockResolvedValue({ baseUrl: '', apiKey: '', model: '' })
  mockSave.mockReset().mockResolvedValue(undefined)
  mockPing.mockReset().mockResolvedValue(undefined)
  useUiStore.setState({ themeMode: 'dark' })
  useNavStore.setState({ level: 'globe', regionId: null, azId: null, serverId: null })
})

describe('SettingsModal', () => {
  it('returns null when closed', () => {
    const { container } = render(<SettingsModal open={false} onClose={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('theme toggle reflects and sets themeMode', async () => {
    render(<SettingsModal open={true} onClose={() => {}} />)
    await waitFor(() => expect(mockLoad).toHaveBeenCalled())

    expect(screen.getByText('dark')).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByText('light'))
    expect(useUiStore.getState().themeMode).toBe('light')
    expect(screen.getByText('light')).toHaveAttribute('aria-pressed', 'true')
  })

  it('esc closes without changing nav level', async () => {
    // Mirrors WorldShell's real bubble-phase Escape handler verbatim (see this task's grounding
    // quote) — bail if defaultPrevented, else nav.up(). Registered on window BEFORE the modal
    // mounts, so a bubble-phase listener here would fire FIRST if registration order (not
    // capture-vs-bubble) were what determined the outcome — same proof technique as
    // ServerView.interaction.test.tsx.
    const worldShellLikeHandler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (e.key === 'Escape') useNavStore.getState().up()
    }
    window.addEventListener('keydown', worldShellLikeHandler)
    const onClose = vi.fn()
    try {
      render(<SettingsModal open={true} onClose={onClose} />)
      await waitFor(() => expect(mockLoad).toHaveBeenCalled())
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(useNavStore.getState().level).toBe('globe')
    } finally {
      window.removeEventListener('keydown', worldShellLikeHandler)
    }
  })

  it('saved key renders masked and is not echoed into the input value', async () => {
    mockLoad.mockResolvedValue({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-abcdefgh1234', model: 'gpt-4o-mini' })
    render(<SettingsModal open={true} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByLabelText('apiKey')).toHaveAttribute('placeholder', '•••• 1234'))
    expect(screen.getByLabelText('apiKey')).toHaveValue('')
  })

  it('save dispatches saveLlmSettings with typed values', async () => {
    render(<SettingsModal open={true} onClose={() => {}} />)
    await waitFor(() => expect(mockLoad).toHaveBeenCalled())

    fireEvent.change(screen.getByLabelText('baseUrl'), { target: { value: 'http://localhost:4141/v1' } })
    fireEvent.change(screen.getByLabelText('apiKey'), { target: { value: 'sk-new-key-999' } })
    fireEvent.change(screen.getByLabelText('model'), { target: { value: 'gpt-4o-mini' } })
    fireEvent.click(screen.getByText('Save'))

    expect(mockSave).toHaveBeenCalledWith({ baseUrl: 'http://localhost:4141/v1', apiKey: 'sk-new-key-999', model: 'gpt-4o-mini' })
  })

  it('test connection surfaces ping success and failure', async () => {
    render(<SettingsModal open={true} onClose={() => {}} />)
    await waitFor(() => expect(mockLoad).toHaveBeenCalled())

    mockPing.mockResolvedValueOnce(undefined)
    fireEvent.click(screen.getByText('Test connection'))
    await waitFor(() => expect(screen.getByText('ok')).toBeInTheDocument())

    mockPing.mockRejectedValueOnce(new Error('connection refused'))
    fireEvent.click(screen.getByText('Test connection'))
    await waitFor(() => expect(screen.getByText('connection refused')).toBeInTheDocument())
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/world/SettingsModal.test.tsx`
Expected: FAIL — `Cannot find module './SettingsModal'`.

- [ ] **Step 3: Write `src/app/world/SettingsModal.tsx`**

```tsx
// src/app/world/SettingsModal.tsx
// Global Settings surface (spec D8): the app's theme toggle and BYO LLM endpoint config live
// here — the ONLY sanctioned home for either concern. Appearance flips a fully-wired-but-so-far
// UI-less theme system (see this task's grounding — the toggle only calls setThemeMode, nothing
// else to plumb). AI Review persists { baseUrl, apiKey, model } through T5's Rust-backed
// commands, OUTSIDE world.store/serializer per D6 — this modal must never import either.
import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { useUiStore } from '../store/ui.store'
import { loadLlmSettings, saveLlmSettings, pingLlm, type LlmSettings } from '../../lib/tauri'

export interface SettingsModalProps {
  open: boolean
  onClose: () => void
}

const backdropStyle: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
}
const surfaceStyle: CSSProperties = {
  width: 420, maxWidth: '92vw', background: 'var(--color-surface)',
  border: '1px solid var(--color-node-border)', borderRadius: 8, padding: 16,
  font: '11px var(--font-mono)', color: 'var(--color-text-primary)',
}
const sectionLabelStyle: CSSProperties = {
  font: '600 10px var(--font-mono)', color: 'var(--color-text-muted)',
  textTransform: 'uppercase', letterSpacing: '0.06em', margin: '14px 0 6px',
}
const fieldLabelStyle: CSSProperties = { display: 'block', marginBottom: 2, color: 'var(--color-text-secondary)' }
const fieldInputStyle: CSSProperties = {
  width: '100%', boxSizing: 'border-box', background: 'var(--color-node-base)',
  border: '1px solid var(--color-node-border)', borderRadius: 4, padding: '5px 7px',
  font: '11px var(--font-mono)', color: 'var(--color-text-primary)', marginBottom: 6,
}
const smallBtnStyle: CSSProperties = {
  background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
  borderRadius: 4, padding: '4px 10px', cursor: 'pointer',
  font: '11px var(--font-mono)', color: 'var(--color-text-secondary)',
}
function segBtnStyle(active: boolean): CSSProperties {
  return {
    flex: 1, padding: '5px 0', textAlign: 'center', cursor: 'pointer',
    background: active ? 'var(--color-accent)' : 'var(--color-node-base)',
    border: '1px solid var(--color-node-border)',
    color: active ? '#fff' : 'var(--color-text-secondary)',
  }
}

function maskedPlaceholder(apiKey: string): string {
  if (!apiKey) return ''
  return `•••• ${apiKey.slice(-4)}`
}

export function SettingsModal({ open, onClose }: SettingsModalProps): ReactElement | null {
  const themeMode = useUiStore(s => s.themeMode)
  const setThemeMode = useUiStore(s => s.setThemeMode)

  // savedKey is kept ONLY to derive the masked placeholder below — it is NEVER rendered into an
  // input's `value` (D6: the stored key must never be echoed back into an editable field).
  const [savedKey, setSavedKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKeyInput, setApiKeyInput] = useState('') // stays '' until the user types a NEW key
  const [model, setModel] = useState('')
  const [testStatus, setTestStatus] = useState<'idle' | 'pending' | 'ok' | 'error'>('idle')
  const [testError, setTestError] = useState('')

  useEffect(() => {
    if (!open) return
    let cancelled = false
    loadLlmSettings().then(s => {
      if (cancelled) return
      setSavedKey(s.apiKey)
      setBaseUrl(s.baseUrl)
      setModel(s.model)
      setApiKeyInput('')
      setTestStatus('idle')
      setTestError('')
    })
    return () => { cancelled = true }
  }, [open])

  // Capture-phase Esc: fires BEFORE WorldShell's bubble-phase Escape-goes-up handler (same
  // mechanism ServerView.tsx already uses — capture always precedes bubble for a `window`
  // listener regardless of mount order). stopPropagation halts the event's entire remaining
  // traversal, including its own return trip through window's bubble phase, so WorldShell's
  // handler never runs for this keydown at all; preventDefault is belt-and-suspenders in case
  // that return trip somehow still occurs (WorldShell's handler also bails on defaultPrevented).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true) // CAPTURE
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open) return null

  const save = () => {
    const settings: LlmSettings = { baseUrl, apiKey: apiKeyInput || savedKey, model }
    saveLlmSettings(settings).then(() => {
      setSavedKey(settings.apiKey)
      setApiKeyInput('')
    })
  }

  const testConnection = () => {
    setTestStatus('pending')
    setTestError('')
    pingLlm({ baseUrl, apiKey: apiKeyInput || savedKey, model })
      .then(() => setTestStatus('ok'))
      .catch(e => {
        setTestStatus('error')
        setTestError(e instanceof Error ? e.message : 'connection failed')
      })
  }

  return createPortal(
    <div style={backdropStyle} onClick={onClose}>
      <div style={surfaceStyle} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ font: '600 12px var(--font-mono)' }}>Settings</span>
          <button style={smallBtnStyle} onClick={onClose}>close</button>
        </div>

        <div style={sectionLabelStyle}>Appearance</div>
        <div style={{ display: 'flex', border: '1px solid var(--color-node-border)', borderRadius: 4, overflow: 'hidden' }}>
          <button type="button" aria-pressed={themeMode === 'dark'} style={segBtnStyle(themeMode === 'dark')} onClick={() => setThemeMode('dark')}>dark</button>
          <button type="button" aria-pressed={themeMode === 'light'} style={segBtnStyle(themeMode === 'light')} onClick={() => setThemeMode('light')}>light</button>
        </div>

        <div style={sectionLabelStyle}>AI Review</div>
        <label style={fieldLabelStyle}>base URL</label>
        <input style={fieldInputStyle} aria-label="baseUrl" placeholder="https://api.openai.com/v1"
          value={baseUrl} onChange={e => setBaseUrl(e.target.value)} />

        <label style={fieldLabelStyle}>API key</label>
        <input style={fieldInputStyle} aria-label="apiKey" type="password"
          placeholder={maskedPlaceholder(savedKey) || 'sk-...'}
          value={apiKeyInput} onChange={e => setApiKeyInput(e.target.value)} />

        <label style={fieldLabelStyle}>model</label>
        <input style={fieldInputStyle} aria-label="model" placeholder="gpt-4o-mini"
          value={model} onChange={e => setModel(e.target.value)} />

        <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }}>
          <button style={smallBtnStyle} onClick={save}>Save</button>
          <button style={smallBtnStyle} onClick={testConnection} disabled={testStatus === 'pending'}>
            {testStatus === 'pending' ? 'testing…' : 'Test connection'}
          </button>
          {testStatus === 'ok' && <span style={{ color: 'var(--color-success)' }}>ok</span>}
          {testStatus === 'error' && <span style={{ color: 'var(--color-danger)' }}>{testError}</span>}
        </div>
      </div>
    </div>,
    document.body,
  )
}
```

- [ ] **Step 4: Modify `src/app/world/WorldShell.tsx`**

```diff
 import { WorldPanel } from './panels/WorldPanel'
 import { AzCanvas } from './AzCanvas'
 import { openWorldViaDialog, saveWorld } from './fileOps'
+import { SettingsModal } from './SettingsModal'
```
```diff
   const [fileError, setFileError] = useState<string | null>(null)
   const running = useSimulationStore(s => s.running)
+  const [settingsOpen, setSettingsOpen] = useState(false)
   const [placeMode, setPlaceMode] = useState(false)
```
```diff
         <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
+          <button style={hdrBtn} aria-label="settings" onClick={() => setSettingsOpen(true)}>⚙</button>
           <span style={{ font: '10px var(--font-mono)', color: 'var(--color-text-muted)' }}>esc = up one level</span>
```
```diff
       <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
         ...(unchanged)...
       </div>
+      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
       <ScrubberV2 />
     </div>
   )
 }
```
The gear is the FIRST child of the right-side header `<div>` (i.e. right of `<SimControls/>`,
left of the `esc = up one level` hint) — per `GROUNDING.md` §J.

- [ ] **Step 5: Run tests + build**

Run: `npx vitest run src/app/world/SettingsModal.test.tsx` → PASS (6 tests).
Run: `npx vitest run` → full suite green (WorldShell has no dedicated test file to update — its
only consumers are integration-level, unaffected by an additively-added button/portal).
Run: `npm run build` → succeeds.

- [ ] **Step 6: Live smoke**

Strict port 1420, zero app console errors, screenshots, stop server after. Story: click the ⚙ →
modal opens over the current view → click `light` → **entire app flips to light mode live**
(globe/panel backgrounds, text, borders — screenshot before/after) → click `dark` → flips back →
reload the page → theme persisted (localStorage `scalemap-theme-mode`) → reopen Settings, type a
`baseUrl`/`apiKey`/`model`, Save → reopen Settings again → apiKey input shows empty with
placeholder `•••• <last4>` (never the raw key) → Esc closes the modal without changing the
current nav level (verify breadcrumb unchanged) → click the backdrop → also closes.

- [ ] **Step 7: Commit**

```bash
git add src/app/world/SettingsModal.tsx src/app/world/SettingsModal.test.tsx src/app/world/WorldShell.tsx
git commit -m "feat(settings): global settings modal — live theme toggle and AI endpoint config"
```

---

## Task 8: AI review section + smoke stub `[sonnet]`

**D6 asserting step this task owns:** the live smoke's grep of the saved `.scalemap` (localStorage
mock) for the API key → absent.

**Files:** create `src/app/world/panels/AiReviewSection.tsx`,
`src/app/world/panels/AiReviewSection.test.tsx`, `scripts/llm-stub.mjs`; modify
`src/app/world/panels/AnalysisTab.tsx`, `src/app/world/panels/WorldPanel.tsx`,
`src/app/world/WorldShell.tsx` (post-T7 version, real by the time this task executes).

> **Reconstruction disclaimer (read before applying this task's AnalysisTab/WorldPanel diffs):**
> Tasks 1–4 have not executed yet at fragment-writing time. `WorldPanel.tsx` TODAY (verified,
> quoted below) still has the OLD `'findings'` tab with inline findings JSX — Task 4 replaces
> that with `'analysis'` + `AnalysisTab.tsx` per the EXACT contract pinned in `skeleton.md`'s
> Task 4 spec and `GROUNDING.md` §G (`navigateToEntity`, `unsuppressedCompileFindings`, family
> sections, `AnalysisTab()` with **no props yet**). The two blocks below reconstruct that
> contract-accurate T4 output so this task's diff has something concrete to apply against; when
> T8 actually executes (after T1–T4 have really landed, per the serial task order), apply the
> diff's **intent** — add an `openSettings` prop to `AnalysisTab`/`WorldPanelProps`, mount
> `AiReviewSection` at the top of the family sections, thread `openSettings` through
> `WorldPanel` — against the REAL T4 files rather than pasting the reconstruction verbatim if
> their literal internal structure (styling, helper names) differs in ways that don't affect the
> pinned contract.

**Grounding — real current `WorldPanel.tsx` (quoted in full, 79 lines, confirms the CURRENT
pre-T4 state so the reconstruction below is legible as a diff, not asserted as-is):**
```tsx
import { useState } from 'react'
import { TopologyPanel } from './TopologyPanel'
import { BlueprintPanel } from './BlueprintPanel'
import { PlacementPanel } from './PlacementPanel'
import { TrafficPanel } from './TrafficPanel'
import { useCompiledWorld } from '../useCompiledWorld'
import { EventsTab } from '../EventsTab'
import { CostTab } from '../CostTab'
import { panel, smallBtn, sectionLabel } from './panelStyles'

type Tab = 'topology' | 'blueprints' | 'placements' | 'traffic' | 'findings' | 'events' | 'cost'

export interface WorldPanelProps {
  running: boolean
  placeMode: boolean
  onTogglePlaceMode: () => void
  selectedPopulationId: string | null
}

export function WorldPanel({ running, placeMode, onTogglePlaceMode, selectedPopulationId }: WorldPanelProps) {
  const [tab, setTab] = useState<Tab>('topology')
  const { findings } = useCompiledWorld()
  const tabs: { id: Tab; label: string }[] = [
    { id: 'topology', label: 'Topology' },
    { id: 'blueprints', label: 'Blueprints' },
    { id: 'placements', label: 'Placements' },
    { id: 'traffic', label: 'Traffic' },
    { id: 'findings', label: `Findings (${findings.length})` },
    { id: 'events', label: 'Events' },
    { id: 'cost', label: 'Cost' },
  ]
  return (
    <aside style={panel}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
        {tabs.map(t => ( /* ... */ ))}
      </div>
      <fieldset disabled={running} style={{ border: 'none', margin: 0, padding: 0 }}>
        {tab === 'topology' && <TopologyPanel />}
        {tab === 'blueprints' && <BlueprintPanel />}
        {tab === 'placements' && <PlacementPanel />}
        {tab === 'traffic' && ( <TrafficPanel placeMode={placeMode} onTogglePlaceMode={onTogglePlaceMode} selectedPopulationId={selectedPopulationId} /> )}
        {tab === 'findings' && ( /* inline findings JSX — T4 deletes this */ )}
        {tab === 'events' && <EventsTab />}
        {tab === 'cost' && <CostTab />}
      </fieldset>
    </aside>
  )
}
```

**Reconstructed T4 output — `AnalysisTab.tsx` (contract per `skeleton.md` Task 4 /
`GROUNDING.md` §G; props-less, as G explicitly states "In T4, AnalysisTab takes no props yet"):**
```tsx
// src/app/world/panels/AnalysisTab.tsx (T4 output, reconstructed)
import { useMemo, type ReactElement } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useNavStore } from '../../store/nav.store'
import { useCompiledWorld } from '../useCompiledWorld'
import { runAnalysis } from '../../../lib/analysis/runAnalysis'
import type { AnalysisFinding, AnalysisFamily } from '../../../lib/analysis/types'
import type { CompileFinding, CompiledWorld, WorldDoc } from '../../../lib/world/types'
import { sectionLabel } from './panelStyles'

interface NavApi {
  goRegion: (regionId: string) => void
  goAz: (regionId: string, azId: string) => void
  goServer: (regionId: string, azId: string, serverId: string) => void
}

export function navigateToEntity(id: string, doc: WorldDoc, compiled: CompiledWorld, nav: NavApi): boolean {
  if (doc.regions[id]) { nav.goRegion(id); return true }
  if (doc.azs[id]) { nav.goAz(doc.azs[id].regionId, id); return true }
  if (doc.servers[id]) {
    const az = doc.azs[doc.servers[id].azId]
    if (az) { nav.goServer(az.regionId, az.id, id); return true }
  }
  const inst = compiled.instances[id]
  if (inst) { nav.goServer(inst.regionId, inst.azId, inst.serverId); return true }
  return false
}

export function unsuppressedCompileFindings(analysis: AnalysisFinding[], compile: CompileFinding[]): CompileFinding[] {
  const suppressedPathIds = new Set(
    analysis.filter(f => f.ruleId === 'blocked-dependency-path')
      .map(f => f.id.slice('blocked-dependency-path:'.length)),
  )
  return compile.filter(c => {
    if (c.kind !== 'blocked-path') return true
    return !suppressedPathIds.has(c.id.slice('finding-'.length))
  })
}

const FAMILY_LABEL: Record<AnalysisFamily, string> = { structural: 'Structural', network: 'Network', capacity: 'Capacity' }

export function AnalysisTab(): ReactElement {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const displayBatch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const findings = useMemo(() => runAnalysis(doc, compiled, displayBatch), [compiled, displayBatch?.simMs])
  const compileFindings = useMemo(() => unsuppressedCompileFindings(findings, compiled.findings), [findings, compiled.findings])

  return (
    <div>
      {(['structural', 'network', 'capacity'] as const).map(family => {
        const group = findings.filter(f => f.family === family)
        if (group.length === 0) return null
        return (
          <div key={family}>
            <div style={sectionLabel}>{FAMILY_LABEL[family]}</div>
            {/* ... finding rows: severity chip, title, why, fix, affected chips calling
                navigateToEntity(id, doc, compiled, useNavStore.getState()) ... */}
          </div>
        )
      })}
      {compileFindings.length > 0 && ( <div><div style={sectionLabel}>Compile</div>{/* ... */}</div> )}
      {findings.length === 0 && compileFindings.length === 0 && (
        <div style={{ color: 'var(--color-text-muted)' }}>No findings — the compiled world is clean.</div>
      )}
    </div>
  )
}
```
**Reconstructed T4 output — `WorldPanel.tsx`'s relevant diff** (rename tab, merged count, no
`openSettings` yet):
```tsx
type Tab = 'topology' | 'blueprints' | 'placements' | 'traffic' | 'analysis' | 'events' | 'cost'
// ... tabs array: { id: 'analysis', label: `Analysis (${analysisCount})` } ...
// ... {tab === 'analysis' && <AnalysisTab />} ...
```

**Now this task's actual diffs, on top of the reconstruction above:**

- [ ] **Step 1: Write the failing test `src/app/world/panels/AiReviewSection.test.tsx`**

```tsx
// src/app/world/panels/AiReviewSection.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AiReviewSection } from './AiReviewSection'
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import * as tauri from '../../../lib/tauri'
import * as llmReview from '../../../lib/llmReview'
import { createRegion } from '../../../lib/world/factories'

vi.mock('../../../lib/tauri', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../lib/tauri')>()
  return { ...actual, loadLlmSettings: vi.fn() }
})
vi.mock('../../../lib/llmReview', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../lib/llmReview')>()
  return { ...actual, buildReviewContext: vi.fn(() => '{}'), requestReview: vi.fn() }
})

const mockLoad = tauri.loadLlmSettings as unknown as ReturnType<typeof vi.fn>
const mockRequestReview = llmReview.requestReview as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useNavStore.setState({ level: 'globe', regionId: null, azId: null, serverId: null })
  mockLoad.mockReset()
  mockRequestReview.mockReset()
})

describe('AiReviewSection', () => {
  it('unconfigured state links to settings', async () => {
    mockLoad.mockResolvedValue({ baseUrl: '', apiKey: '', model: '' })
    const openSettings = vi.fn()
    render(<AiReviewSection openSettings={openSettings} />)
    await waitFor(() => expect(screen.getByText(/Open Settings/i)).toBeInTheDocument())
    fireEvent.click(screen.getByText(/Open Settings/i))
    expect(openSettings).toHaveBeenCalledTimes(1)
  })

  it('review renders cards on success', async () => {
    mockLoad.mockResolvedValue({ baseUrl: 'http://localhost:4141/v1', apiKey: '', model: 'x' })
    mockRequestReview.mockResolvedValue([{
      title: 'Consider a read replica', severity: 'warning', confidence: 0.8, affected: [],
      reasoning: 'single writer under sustained load', recommendation: 'add a replica',
      estimated_effort: 'medium',
    }])
    render(<AiReviewSection openSettings={() => {}} />)
    await waitFor(() => expect(screen.getByText('Review architecture')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Review architecture'))
    await waitFor(() => expect(screen.getByText('Consider a read replica')).toBeInTheDocument())
    expect(screen.getByText('80%')).toBeInTheDocument()
  })

  it('in-flight disables the button', async () => {
    mockLoad.mockResolvedValue({ baseUrl: 'http://localhost:4141/v1', apiKey: '', model: 'x' })
    let resolveReview: (v: unknown) => void = () => {}
    mockRequestReview.mockReturnValue(new Promise(res => { resolveReview = res }))
    render(<AiReviewSection openSettings={() => {}} />)
    await waitFor(() => expect(screen.getByText('Review architecture')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Review architecture'))
    await waitFor(() => expect(screen.getByText('reviewing…')).toBeInTheDocument())
    expect(screen.getByText('reviewing…').closest('button')).toBeDisabled()
    resolveReview([])
  })

  it('error keeps prior cards and shows message', async () => {
    mockLoad.mockResolvedValue({ baseUrl: 'http://localhost:4141/v1', apiKey: '', model: 'x' })
    mockRequestReview.mockResolvedValueOnce([{
      title: 'first issue', severity: 'info', confidence: 0.5, affected: [],
      reasoning: 'r', recommendation: 'x', estimated_effort: 'low',
    }])
    render(<AiReviewSection openSettings={() => {}} />)
    await waitFor(() => expect(screen.getByText('Review architecture')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Review architecture'))
    await waitFor(() => expect(screen.getByText('first issue')).toBeInTheDocument())

    mockRequestReview.mockRejectedValueOnce(new Error('malformed review response'))
    fireEvent.click(screen.getByText('Review architecture'))
    await waitFor(() => expect(screen.getByText('malformed review response')).toBeInTheDocument())
    expect(screen.getByText('first issue')).toBeInTheDocument() // prior card retained
  })

  it('card affected chip navigates to a server', async () => {
    const region = createRegion('us-east-1')
    useWorldStore.setState(s => ({ doc: { ...s.doc, regions: { ...s.doc.regions, [region.id]: region } } }))
    mockLoad.mockResolvedValue({ baseUrl: 'http://localhost:4141/v1', apiKey: '', model: 'x' })
    mockRequestReview.mockResolvedValue([{
      title: 'region risk', severity: 'warning', confidence: 0.6, affected: [region.id],
      reasoning: 'r', recommendation: 'x', estimated_effort: 'low',
    }])
    render(<AiReviewSection openSettings={() => {}} />)
    await waitFor(() => expect(screen.getByText('Review architecture')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Review architecture'))
    await waitFor(() => expect(screen.getByText(region.id)).toBeInTheDocument())
    fireEvent.click(screen.getByText(region.id))
    expect(useNavStore.getState().level).toBe('region')
    expect(useNavStore.getState().regionId).toBe(region.id)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/world/panels/AiReviewSection.test.tsx`
Expected: FAIL — `Cannot find module './AiReviewSection'`.

- [ ] **Step 3: Write `src/app/world/panels/AiReviewSection.tsx`**

**Judgment call — the `openSettings`-only prop vs. passing `currentAnalysisFindings` down.**
`skeleton.md`'s "Produces (exact)" line for this component is literally
`{ openSettings: () => void }` — one prop — but the surrounding prose says
`currentAnalysisFindings` "= the runAnalysis(...) result AnalysisTab already computes; pass it
down **or recompute in the section** — prefer passing... to avoid a second run." Those two
sentences pull in different directions (an exact one-prop signature vs. a stated preference for
a second prop). Since `skeleton.md`'s header mandates expanding signatures exactly, not
redesigning them, and the prose explicitly names "recompute in the section" as a sanctioned
alternative, this plan keeps the literal one-prop signature and has `AiReviewSection` recompute
`runAnalysis` itself (a cheap, pure call per spec D3 — "analysis runs continuously, cheaply").
**Flagging this choice explicitly**, since it resolves a real tension rather than a
non-existent one — if a reviewer prefers the "avoid a second run" reading instead, add a
`findings: AnalysisFinding[]` prop here and pass `AnalysisTab`'s own `findings` down (the diff
in Step 4 below would drop one line and gain another).

```tsx
// src/app/world/panels/AiReviewSection.tsx
// On-demand AI architecture review UI (Phase 6, D8). Mounted at the top of AnalysisTab (Step 4).
// A circular import with AnalysisTab.tsx is deliberate and safe here: AnalysisTab imports the
// AiReviewSection COMPONENT, and this file imports AnalysisTab's navigateToEntity HELPER — both
// bindings are used only inside render/event-handler bodies (never at module top-level), so ESM's
// live-binding resolution handles the cycle the same way React container/child components
// routinely reference each other's siblings-exported helpers.
import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useCompiledWorld } from '../useCompiledWorld'
import { runAnalysis } from '../../../lib/analysis/runAnalysis'
import { loadLlmSettings } from '../../../lib/tauri'
import { buildReviewContext, requestReview, type AiIssue } from '../../../lib/llmReview'
import { navigateToEntity } from './AnalysisTab'
import { CATEGORY_COLORS } from '../../../lib/theme'

export interface AiReviewSectionProps {
  openSettings: () => void
}

type ReviewState = 'idle' | 'in-flight' | 'done' | 'error'

const chipStyle: CSSProperties = {
  display: 'inline-block', padding: '1px 6px', borderRadius: 3,
  font: '10px var(--font-mono)', color: '#fff', background: CATEGORY_COLORS.messaging.accent,
}
const smallBtnStyle: CSSProperties = {
  background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
  borderRadius: 4, padding: '3px 8px', cursor: 'pointer',
  font: '11px var(--font-mono)', color: 'var(--color-text-secondary)',
}
const linkBtnStyle: CSSProperties = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
  font: '11px var(--font-mono)', color: 'var(--color-accent)', textDecoration: 'underline',
}
const SEVERITY_COLOR = { critical: 'var(--color-danger)', warning: 'var(--color-warning)', info: 'var(--color-text-muted)' } as const

export function AiReviewSection({ openSettings }: AiReviewSectionProps): ReactElement {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const displayBatch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const nav = useNavStore()

  // Recomputed here rather than threaded down as a prop — see this step's judgment-call note.
  const currentAnalysisFindings = useMemo(
    () => runAnalysis(doc, compiled, displayBatch),
    [doc, compiled, displayBatch],
  )

  const [configured, setConfigured] = useState<boolean | null>(null)
  const [state, setState] = useState<ReviewState>('idle')
  const [issues, setIssues] = useState<AiIssue[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    loadLlmSettings().then(s => setConfigured(s.baseUrl.trim().length > 0))
  }, [])

  const review = async () => {
    setState('in-flight')
    setError('')
    try {
      const settings = await loadLlmSettings()
      const context = buildReviewContext(doc, compiled, currentAnalysisFindings, displayBatch)
      const result = await requestReview(settings, context)
      setIssues(result)
      setState('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'review failed')
      setState('error') // previous cards (issues state) are intentionally left untouched
    }
  }

  if (configured === false) {
    return (
      <div style={{ marginBottom: 12 }}>
        <span style={chipStyle}>AI</span>
        <div style={{ marginTop: 4, color: 'var(--color-text-muted)' }}>
          No AI endpoint configured. <button style={linkBtnStyle} onClick={openSettings}>Open Settings</button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={chipStyle}>AI</span>
        <button disabled={state === 'in-flight'} onClick={review} style={smallBtnStyle}>
          {state === 'in-flight' ? 'reviewing…' : 'Review architecture'}
        </button>
      </div>
      {state === 'error' && <div style={{ color: 'var(--color-danger)', marginTop: 4 }}>{error}</div>}
      {issues.map((issue, i) => (
        <div key={i} style={{ marginTop: 8, borderTop: '1px solid var(--color-node-border)', paddingTop: 6 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={chipStyle}>AI</span>
            <span>{issue.title}</span>
            <span style={{ color: SEVERITY_COLOR[issue.severity] }}>{issue.severity}</span>
            <span style={{ color: 'var(--color-text-muted)' }}>{`${Math.round(issue.confidence * 100)}%`}</span>
          </div>
          <div>{issue.reasoning}</div>
          <div style={{ color: 'var(--color-text-muted)' }}>{`→ ${issue.recommendation}`}</div>
          <div style={{ color: 'var(--color-text-muted)' }}>{`${issue.estimated_effort} effort`}</div>
          <div style={{ display: 'flex', gap: 4, marginTop: 2, flexWrap: 'wrap' }}>
            {issue.affected.map(id => (
              <button key={id} style={smallBtnStyle} onClick={() => navigateToEntity(id, doc, compiled, nav)}>{id}</button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: Modify `src/app/world/panels/AnalysisTab.tsx`** (on top of the T4 reconstruction
above)

```diff
 import { useMemo, type ReactElement } from 'react'
 import { useWorldStore } from '../../store/world.store'
 import { useSimulationStore } from '../../store/simulation.store'
 import { useNavStore } from '../../store/nav.store'
 import { useCompiledWorld } from '../useCompiledWorld'
 import { runAnalysis } from '../../../lib/analysis/runAnalysis'
 import type { AnalysisFinding, AnalysisFamily } from '../../../lib/analysis/types'
 import type { CompileFinding, CompiledWorld, WorldDoc } from '../../../lib/world/types'
 import { sectionLabel } from './panelStyles'
+import { AiReviewSection } from './AiReviewSection'
```
```diff
-export function AnalysisTab(): ReactElement {
+export interface AnalysisTabProps {
+  openSettings: () => void
+}
+
+export function AnalysisTab({ openSettings }: AnalysisTabProps): ReactElement {
   const doc = useWorldStore(s => s.doc)
   const compiled = useCompiledWorld()
   const displayBatch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
   const findings = useMemo(() => runAnalysis(doc, compiled, displayBatch), [compiled, displayBatch?.simMs])
   const compileFindings = useMemo(() => unsuppressedCompileFindings(findings, compiled.findings), [findings, compiled.findings])

   return (
     <div>
+      <AiReviewSection openSettings={openSettings} />
       {(['structural', 'network', 'capacity'] as const).map(family => {
```
`navigateToEntity`/`unsuppressedCompileFindings` are unchanged — `AiReviewSection` imports
`navigateToEntity` directly from this file (Step 3), not through a prop.

- [ ] **Step 5: Modify `src/app/world/panels/WorldPanel.tsx`** (on top of the T4 reconstruction)

```diff
 export interface WorldPanelProps {
   running: boolean
   placeMode: boolean
   onTogglePlaceMode: () => void
   selectedPopulationId: string | null
+  openSettings: () => void
 }

-export function WorldPanel({ running, placeMode, onTogglePlaceMode, selectedPopulationId }: WorldPanelProps) {
+export function WorldPanel({ running, placeMode, onTogglePlaceMode, selectedPopulationId, openSettings }: WorldPanelProps) {
```
```diff
-        {tab === 'analysis' && <AnalysisTab />}
+        {tab === 'analysis' && <AnalysisTab openSettings={openSettings} />}
```
If T4's real `WorldPanel.test.tsx` renders `<WorldPanel>` without stubbing `../../../lib/tauri`,
`AiReviewSection`'s mount effect will call the REAL `loadLlmSettings()` (resolving to empty
defaults via the mock transport) — harmless, but add `openSettings={() => {}}` to that file's
existing render call sites when this step lands, and wrap any assertion that follows a tab switch
in `waitFor` if an act()-async warning shows up.

- [ ] **Step 6: Modify `src/app/world/WorldShell.tsx`** (post-T7 version — `settingsOpen` already
exists from Task 7)

```diff
-        <WorldPanel
-          running={running}
-          placeMode={placeMode}
-          onTogglePlaceMode={() => setPlaceMode(p => !p)}
-          selectedPopulationId={selectedPopulationId}
-        />
+        <WorldPanel
+          running={running}
+          placeMode={placeMode}
+          onTogglePlaceMode={() => setPlaceMode(p => !p)}
+          selectedPopulationId={selectedPopulationId}
+          openSettings={() => setSettingsOpen(true)}
+        />
```
This reuses the EXACT `settingsOpen` state Task 7 introduced for the gear button — one state,
two triggers (the gear, and this "open Settings" link chain), per `GROUNDING.md` §M.

- [ ] **Step 7: Write `scripts/llm-stub.mjs`**

```js
#!/usr/bin/env node
// scripts/llm-stub.mjs — OpenAI-compatible smoke stub for Phase 6's live review-with-retry story
// (spec D9). Usage: node scripts/llm-stub.mjs [port=4141]
//
// POST /v1/chat/completions: the FIRST request ever received returns a malformed content string
// (exercises llmReview.ts's one-shot retry live); every request after that returns a canned,
// valid, fenced `{ issues: [...] }` payload. CORS is wide-open (OPTIONS preflight +
// Access-Control-Allow-*) since the browser mock transport (tauriMock.ts's llm_chat) calls this
// via a direct fetch() from the webview/browser origin.
import http from 'node:http'

const port = Number(process.argv[2]) || 4141
let hitCount = 0

const CANNED_ISSUES = {
  issues: [
    {
      title: 'us-east-1a is a single point of failure for the web tier',
      severity: 'warning',
      confidence: 0.82,
      affected: ['az-us-east-1a'],
      reasoning: 'Every web instance resolved to one AZ; an AZ-level outage takes the whole tier down with no failover path.',
      recommendation: 'Spread web placements across at least two AZs in the region.',
      estimated_effort: 'medium',
    },
    {
      title: 'Database reachable from the public internet',
      severity: 'critical',
      confidence: 0.91,
      affected: ['srv-db-1'],
      reasoning: 'The firewall rule ahead of the db port allows source any, so the datastore is internet-facing.',
      recommendation: 'Restrict the db port to internal source CIDRs only; front it with the app tier.',
      estimated_effort: 'low',
    },
  ],
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      hitCount += 1
      console.log(`[llm-stub] hit #${hitCount}`)
      const content = hitCount === 1
        ? 'not json at all'
        : '```json\n' + JSON.stringify(CANNED_ISSUES) + '\n```'
      const body = JSON.stringify({ choices: [{ message: { content } }] })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(body)
    })
    return
  }

  res.writeHead(404)
  res.end()
})

server.listen(port, () => {
  console.log(`[llm-stub] listening on http://localhost:${port}/v1`)
})
```

- [ ] **Step 8: Run to verify the new test passes**

Run: `npx vitest run src/app/world/panels/AiReviewSection.test.tsx` → PASS (5 tests).

- [ ] **Step 9: Full verify**

Run: `npx vitest run` → full suite green (including T4's `AnalysisTab.test.tsx` and
`WorldPanel.test.tsx`, updated per Step 5's note).
Run: `npm run build` → strict tsc + vite build green.

- [ ] **Step 10: Live smoke**

Strict port 1420, zero app console errors, screenshots, stop the dev server AND the stub after.
Story: `node scripts/llm-stub.mjs 4141` in a separate terminal → open the app, Settings → set
baseUrl `http://localhost:4141/v1`, model `stub`, Save → Analysis tab → the AI section shows
`Review architecture` (no longer the unconfigured hint) → click it → button shows `reviewing…`
and is disabled → stub terminal log shows **TWO hits** (`hit #1`, `hit #2` — proves the
malformed→retry→success path fired live, not just in the unit test) → two AI-chipped cards
render beside the deterministic findings, with clickable affected chips that navigate → Save the
world (mock localStorage path) → **grep the saved `.scalemap` payload in localStorage for the
configured API key string → confirm it is ABSENT** (this is the D6 assertion this task owns —
the settings never touch `world.store`/`serializer`, so there is nothing to find). Stop the stub
(`Ctrl-C`) and the dev server.

- [ ] **Step 11: Commit**

```bash
git add src/app/world/panels/AiReviewSection.tsx src/app/world/panels/AiReviewSection.test.tsx \
  src/app/world/panels/AnalysisTab.tsx src/app/world/panels/WorldPanel.tsx \
  src/app/world/WorldShell.tsx scripts/llm-stub.mjs
git commit -m "feat(llm): on-demand AI architecture review with retrying stub-proven flow"
```
# Phase 6 plan fragment — Task 9 (FINAL: phase-gate smoke, light-mode pass, CLAUDE.md
# rewrite, module-boundaries §O, four Phase-5 carry-forwards)

> Fragment scope: Task 9 — the last task of the whole 6-phase world-model rebuild. Four small,
> surgical carry-forward fixes closing out Phase 5's backlog (`MAX_GLOBE_ARCS` export,
> population-label collision, `GlobeScene` texture-mutation hook, a `buildDrainArcs` fallback
> test), a full CLAUDE.md rewrite for the world-model app, a new `docs/module-boundaries.md` §O,
> and the phase-gate done bar (full suite + build + `cargo build`/`cargo test` green, the live
> end-to-end story including a light-mode screenshot pass, and the closing SDD ledger entry).
> Global Constraints / File Structure live in the skeleton's assembled header
> (`docs/superpowers/plans/phase6/skeleton.md`) — not repeated here.
>
> **Grounding status:** every file this task touches is real, currently-committed source, quoted
> verbatim below (verified against `main`/`phase6-analysis` HEAD `4f3ce5a`, 2026-07-10) —
> `src/lib/worldEngine/index.ts`, `src/app/world/globe/ArcsLayer.tsx`, `src/app/world/globe/
> GlobeScene.tsx`, `src/app/world/panels/TrafficPanel.tsx`, `src/app/world/GlobeView.tsx`,
> `src/lib/worldEngine/globeArcs.test.ts`, `CLAUDE.md`, `docs/module-boundaries.md`. **Tasks 1–8
> have NOT executed yet at fragment-writing time** — this fragment does not depend on any of their
> output (T9's carry-forwards and docs are independent of T1–T8's files), so there is no
> reconstruction caveat here the way Phase-5's Task-6 fragment needed one for `GlobeView.tsx`. The
> one place T9 DOES reference T1–T8's shape (§O's file table, describing `src/lib/analysis/`,
> `llmReview.ts`, `AnalysisTab.tsx`, `SettingsModal.tsx`, etc.) is written from the **pinned,
> binding contracts** in `skeleton.md`/`GROUNDING.md` §C–§K, not invented — by the time T9 actually
> runs, T1–T8 will have landed and the implementer should verify §O's prose against the real
> committed files from those tasks (names/roles should match; if any diverge, fix §O to match
> reality, not the other way around).
>
> **Note on two things found while grounding this fragment that neither `skeleton.md` nor
> `GROUNDING.md` called out (not a conflict — within the explicit "keep Design System /
> Architecture accurate" instruction, so fixed here rather than left stale):**
> 1. CLAUDE.md's current "Design System" category-accent swatch (`Compute/Orchestration #4A9EFF`,
>    `Storage/Caching #F5A623`, `Network #2DD4BF`, `Messaging #A78BFA`, `Grouping #475569`) no
>    longer matches `src/lib/theme.ts`'s actual `CATEGORY_COLORS` (`compute.accent #5B9CF6`,
>    `storage/caching.accent #E0A552`, `network.accent #3FC7B8`, `messaging.accent #9C8CE0`,
>    `grouping.accent #8391A5`) — an accessibility pass (see `theme.ts`'s inline comments)
>    retuned these after the original CLAUDE.md swatch was written, and `theme.ts` also gained a
>    full `LIGHT_COLORS` sibling with per-category `foreground.light` variants that CLAUDE.md never
>    mentioned. Step 9 below fixes the swatch and adds a short light-mode note. The `DARK_COLORS`
>    surface/text/status values (canvas/node/surface/toolbar/text/danger/success/warning) are all
>    still byte-exact — only the category row was stale.
> 2. The current Key-Architecture-Decisions bullet "**Node icons:** Route all icons through
>    `NODE_CONFIG`" is now stale: `grep -rn "NODE_CONFIG\b" src` (excluding `nodeConfig.ts` itself
>    and tests) turns up zero consumers in the world-model UI — `lucide-react` itself is only
>    imported by `HomeScreen.tsx` and `nodeConfig.ts` today. Step 9 drops this bullet rather than
>    keep asserting a decision nothing currently follows.
>
> **D6 SECURITY (non-negotiable, restated in §O and the live smoke below):** the API key is NEVER
> serialized into `.scalemap`, NEVER logged/`console.*`'d, NEVER included in the review-context
> payload, REDACTED from every error string on both sides, rendered ONLY masked after save, input
> `type=password`.

---

## Task 9: Final — phase smoke, light-mode pass, CLAUDE.md, §O, carry-forwards `[sonnet]`

**Files:** modify `src/lib/worldEngine/index.ts` (one-liner — the ONLY sanctioned
`worldEngine/` edit this phase), `src/app/world/globe/ArcsLayer.tsx`,
`src/app/world/globe/GlobeScene.tsx`, `src/app/world/panels/TrafficPanel.tsx`,
`src/app/world/GlobeView.tsx`, `src/lib/worldEngine/globeArcs.test.ts` (test-only), `CLAUDE.md`,
`docs/module-boundaries.md`; create `src/lib/world/populationLabel.ts`,
`src/lib/world/populationLabel.test.ts`; append to `.superpowers/sdd/progress.md`.

---

### Part A — the four Phase-5 carry-forwards

- [ ] **Step 1: `worldEngine/index.ts` — export `MAX_GLOBE_ARCS` (the one sanctioned engine edit)**

Current line (verbatim, `src/lib/worldEngine/index.ts:43`, in the block of module-level consts
just below the imports):

```ts
const MAX_GLOBE_ARCS = 200
```

Diff:

```diff
-const MAX_GLOBE_ARCS = 200
+export const MAX_GLOBE_ARCS = 200
```

That is the entire diff to this file. Nothing else in `worldEngine/` changes. This constant is
read later in the same file by `buildArcs()` (`if (arcs.length < MAX_GLOBE_ARCS) ...`) — that
call site is untouched, `export` doesn't change local-scope usage.

- [ ] **Step 2: `ArcsLayer.tsx` — delete the hand-duplicated copy, import the real one**

Current file head (verbatim, `src/app/world/globe/ArcsLayer.tsx:1–27`):

```tsx
// src/app/world/globe/ArcsLayer.tsx
// Live great-circle traffic arcs (Phase 5 D6): attaches the globe-scope renderer once per
// `running`, writes each frame's VisualArc[] into a ref, and drives a fixed-size pool of
// THREE.Line objects (LineDashedMaterial) — geometry rebuilt only when the arc SET's signature
// changes (endpoints/kind), opacity and dash-flow updated every frame regardless. Dash flow is
// driven by mutating the geometry's `lineDistance` attribute in place (this three.js build's
// classic LineDashedMaterial has no `dashOffset` uniform — see the PoolEntry comment below), not
// a material property. Mounted as a GlobeScene child (T3), alongside RegionPins/PopulationMarkers
// (T4) — lives in the same rotating group so arcs track the globe's orientation. R3F component;
// NOT jsdom-tested (no WebGL there) — this task's live smoke is the gate. arcsSignature is the
// one exported pure helper, unit-tested in ArcsLayer.test.ts.
import { useEffect, useRef, type ReactElement } from 'react'
import { useFrame } from '@react-three/fiber'
import { useReducedMotion } from 'framer-motion'
import * as THREE from 'three'
import { useSimulationStore } from '../../store/simulation.store'
import { greatCirclePoints } from './geo'
import type { VisualArc, FramePayload } from '../../../lib/worldEngine/types'

// Mirrors worldEngine's own (unexported) MAX_GLOBE_ARCS — the pool only ever needs to match the
// engine's own render cap (D6); not importable, so kept in sync manually here.
const MAX_GLOBE_ARCS = 200
const ARC_SEGMENTS = 48
const ARC_RADIUS = 1.001
const DASH_SIZE = 0.045
const GAP_SIZE = 0.03
const DASH_SPEED = 0.15   // dashOffset units/sec
```

Diff (import block gains one line; the two-line "mirrors worldEngine's own" comment + its
`const` are deleted — everything below, including `ARC_SEGMENTS`/`ARC_RADIUS`/etc., is
unaffected since `MAX_GLOBE_ARCS` is still an in-scope identifier, now import-bound instead of
locally declared):

```diff
 import { useEffect, useRef, type ReactElement } from 'react'
 import { useFrame } from '@react-three/fiber'
 import { useReducedMotion } from 'framer-motion'
 import * as THREE from 'three'
 import { useSimulationStore } from '../../store/simulation.store'
 import { greatCirclePoints } from './geo'
+import { MAX_GLOBE_ARCS } from '../../../lib/worldEngine'
 import type { VisualArc, FramePayload } from '../../../lib/worldEngine/types'

-// Mirrors worldEngine's own (unexported) MAX_GLOBE_ARCS — the pool only ever needs to match the
-// engine's own render cap (D6); not importable, so kept in sync manually here.
-const MAX_GLOBE_ARCS = 200
 const ARC_SEGMENTS = 48
 const ARC_RADIUS = 1.001
 const DASH_SIZE = 0.045
 const GAP_SIZE = 0.03
 const DASH_SPEED = 0.15   // dashOffset units/sec
```

Every other use of `MAX_GLOBE_ARCS` later in the file (the pool-build loop, the per-frame
truncation guards) is a bare identifier reference — unchanged text, now resolved via the import
instead of the deleted local const.

- [ ] **Step 3: verify the import resolves — no separate barrel file needed**

`src/lib/worldEngine/` has no separate `barrel.ts` — `index.ts` IS the module's resolution
target for a bare-directory import (confirmed precedent already in this repo:
`src/app/store/simulation.store.ts:11` does `import { worldEngine } from '../../lib/worldEngine'`
and `bench/enginePerf.bench.test.ts:15` does `import { createWorldEngine } from
'../src/lib/worldEngine'` — both resolve to `index.ts` today). So Step 1's `export const` is
immediately sufficient; `ArcsLayer.tsx`'s new `from '../../../lib/worldEngine'` (three `../` from
`src/app/world/globe/` to `src/lib/`, matching the file's own existing `'../../../lib/worldEngine/
types'` import one line below it) needs no additional re-export step. Run:

`npx vitest run src/app/world/globe/ArcsLayer.test.ts` → PASS (4/4, unaffected — the test file
only exercises the exported `arcsSignature` helper, never `MAX_GLOBE_ARCS` directly).
`npx tsc --noEmit` (or `npm run build`) → no new errors; `MAX_GLOBE_ARCS`'s inferred type
(`number`, literal-widened) is identical whether declared locally or imported.

- [ ] **Step 4: population default-label collision — new shared helper**

Backlog text (`.superpowers/sdd/progress.md`'s `## PHASE 5 COMPLETE` "OPEN ITEMS for Phase 6",
verbatim): *"Duplicate default population label after remove+re-add [TrafficPanel.tsx pop-N +
GlobeView.tsx pop-N independent length counters; no uniqueness spec; labels editable] — one-line
fix (max-suffix scan / monotonic counter) if picked up."*

Create `src/lib/world/populationLabel.ts` (new file — lib-layer home, alongside `regionGeo.ts`/
`routing.ts`/etc., so both `TrafficPanel.tsx` (`app/world/panels/`) and `GlobeView.tsx`
(`app/world/`) can import it without either depending on the other):

```ts
// src/lib/world/populationLabel.ts
// Shared default-label generator for client populations (Phase 6 T9 carry-forward, closing a
// Phase-5 backlog item). TrafficPanel.tsx's "+ add" and GlobeView.tsx's click-to-place handler
// each independently derived `pop-${N}` from a LENGTH counter (`populations.length + 1` /
// `populationCount + 1`) — after a remove+re-add from either surface the two counters can
// re-issue the SAME default label (labels are user-editable free text, not unique ids, but a
// silent duplicate default is still a rough edge worth closing). This scans the actual
// populations map for the highest existing `pop-<N>` suffix and returns `pop-<max+1>`, so neither
// authoring surface can collide with the other, or with a population manually renamed back to a
// `pop-N`-shaped label.
import type { ClientPopulation, PopulationId } from './types'

const POP_LABEL_RE = /^pop-(\d+)$/

export function nextPopulationLabel(populations: Record<PopulationId, ClientPopulation>): string {
  let max = 0
  for (const pop of Object.values(populations)) {
    const m = POP_LABEL_RE.exec(pop.label)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `pop-${max + 1}`
}
```

Create `src/lib/world/populationLabel.test.ts` (pure, node env, no `@vitest-environment` pragma —
per the repo convention, §B of `GROUNDING.md`):

```ts
// src/lib/world/populationLabel.test.ts
import { describe, it, expect } from 'vitest'
import { nextPopulationLabel } from './populationLabel'
import { createPopulation } from './factories'
import type { ClientPopulation, PopulationId } from './types'

function byId(pops: ClientPopulation[]): Record<PopulationId, ClientPopulation> {
  const out: Record<PopulationId, ClientPopulation> = {}
  for (const p of pops) out[p.id] = p
  return out
}

describe('nextPopulationLabel', () => {
  it('returns pop-1 for an empty population map', () => {
    expect(nextPopulationLabel({})).toBe('pop-1')
  })

  it('scans the max existing pop-N suffix rather than counting entries', () => {
    const a = createPopulation('pop-1', 0, 0)
    const b = createPopulation('pop-3', 0, 0)
    expect(nextPopulationLabel(byId([a, b]))).toBe('pop-4')
  })

  it('ignores non-matching / manually-renamed labels', () => {
    const a = createPopulation('nyc', 0, 0)
    const b = createPopulation('pop-2', 0, 0)
    expect(nextPopulationLabel(byId([a, b]))).toBe('pop-3')
  })

  it('is stable after a remove + re-add that would collide under a length-based counter', () => {
    // Reproduces the exact Phase-5 backlog scenario: pop-1 and pop-2 both added, then pop-1
    // removed (leaving one entry — length 1). A naive `pop-${length + 1}` would re-issue
    // 'pop-2', a real duplicate. The max-suffix scan instead sees the surviving 'pop-2' and
    // correctly continues at 'pop-3'.
    const survivor = createPopulation('pop-2', 0, 0)
    expect(nextPopulationLabel(byId([survivor]))).toBe('pop-3')
  })
})
```

Run: `npx vitest run src/lib/world/populationLabel.test.ts` → PASS (4/4).

- [ ] **Step 5: wire the helper into `TrafficPanel.tsx`**

Current imports (verbatim, `src/app/world/panels/TrafficPanel.tsx:7–10`):

```tsx
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useWorldStore } from '../../store/world.store'
import type { DiurnalPattern, RegionId, RoutingPolicyKind } from '../../../lib/world/types'
import { sectionLabel, field, smallBtn, dangerBtn, row } from './panelStyles'
```

Diff:

```diff
 import { useEffect, useRef, useState, type ReactElement } from 'react'
 import { useWorldStore } from '../../store/world.store'
 import type { DiurnalPattern, RegionId, RoutingPolicyKind } from '../../../lib/world/types'
+import { nextPopulationLabel } from '../../../lib/world/populationLabel'
 import { sectionLabel, field, smallBtn, dangerBtn, row } from './panelStyles'
```

Current `addDraft` (verbatim, `src/app/world/panels/TrafficPanel.tsx:79–87`, inside
`PopulationsSection` where `doc` is already destructured via `const doc = useWorldStore(s =>
s.doc)` at the top of the function):

```tsx
  const addDraft = () => {
    const label = draftLabel.trim() || `pop-${populations.length + 1}`
    // addPopulation's factory hardcodes peakRps:500/diurnal:'flat' (src/lib/world/factories.ts)
    // — it has no param for either, so the draft rps/diurnal only reach the store via this
    // follow-up patch.
    const id = addPopulation(label, draftLat, draftLon)
    updatePopulation(id, { peakRps: draftRps, diurnal: draftDiurnal })
    setDraftLabel('')
  }
```

Diff:

```diff
   const addDraft = () => {
-    const label = draftLabel.trim() || `pop-${populations.length + 1}`
+    // Phase 6 T9 carry-forward: shared max-suffix scan (src/lib/world/populationLabel.ts)
+    // instead of `pop-${populations.length + 1}` — a length-based counter reissues a stale
+    // label after a remove+re-add (Phase-5 backlog item); GlobeView.tsx's place-on-globe
+    // handler uses the same helper so neither authoring surface can collide with the other.
+    const label = draftLabel.trim() || nextPopulationLabel(doc.populations)
     // addPopulation's factory hardcodes peakRps:500/diurnal:'flat' (src/lib/world/factories.ts)
     // — it has no param for either, so the draft rps/diurnal only reach the store via this
     // follow-up patch.
     const id = addPopulation(label, draftLat, draftLon)
     updatePopulation(id, { peakRps: draftRps, diurnal: draftDiurnal })
     setDraftLabel('')
   }
```

`populations` (the `Object.values(doc.populations)` array, used elsewhere in this same function
for the empty-state check and the `.map` render) is untouched and still used — only this one call
site changes. `doc` is already in scope; no new selector needed.

**Existing test unaffected:** `TrafficPanel.test.tsx`'s `'add and edit population dispatches
store actions with exact patches'` case starts from `useWorldStore.getState().newWorld()`
(`beforeEach`) — an empty `populations` map — so `nextPopulationLabel({})` still returns
`'pop-1'`, matching the test's existing `expect(pops[0]).toMatchObject({ label: 'pop-1', ... })`
assertion verbatim. No test file edit needed here.

- [ ] **Step 6: wire the helper into `GlobeView.tsx`**

Current imports (verbatim, `src/app/world/GlobeView.tsx:7–15`):

```tsx
import type { CSSProperties } from 'react'
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { GlobeScene } from './globe/GlobeScene'
import { GlobeCards } from './GlobeCards'
import { RegionPins } from './globe/RegionPins'
import { PopulationMarkers } from './globe/PopulationMarkers'
import { ArcsLayer } from './globe/ArcsLayer'
import { webglAvailable } from './globe/webgl'
```

Diff:

```diff
 import type { CSSProperties } from 'react'
 import { useWorldStore } from '../store/world.store'
 import { useNavStore } from '../store/nav.store'
 import { GlobeScene } from './globe/GlobeScene'
 import { GlobeCards } from './GlobeCards'
 import { RegionPins } from './globe/RegionPins'
 import { PopulationMarkers } from './globe/PopulationMarkers'
 import { ArcsLayer } from './globe/ArcsLayer'
 import { webglAvailable } from './globe/webgl'
+import { nextPopulationLabel } from '../../lib/world/populationLabel'
```

Current component body (verbatim, `src/app/world/GlobeView.tsx:45–57`):

```tsx
export function GlobeView({ placeMode, onExitPlaceMode, onPopulationPlaced }: GlobeViewProps) {
  const addPopulation = useWorldStore(s => s.addPopulation)
  const populationCount = useWorldStore(s => Object.keys(s.doc.populations).length)

  // Place-mode is armed/disarmed by WorldShell (the common ancestor of this component and
  // TrafficPanel) via the placeMode prop; a click on the globe here places a population, then
  // hands control back up so WorldShell can disarm and TrafficPanel can select+focus the new row.
  const onPlace = (lat: number, lon: number) => {
    const label = `pop-${populationCount + 1}`
    const id = addPopulation(label, lat, lon)
    onExitPlaceMode()
    onPopulationPlaced(id)
  }
```

Diff:

```diff
 export function GlobeView({ placeMode, onExitPlaceMode, onPopulationPlaced }: GlobeViewProps) {
   const addPopulation = useWorldStore(s => s.addPopulation)
-  const populationCount = useWorldStore(s => Object.keys(s.doc.populations).length)
+  const populations = useWorldStore(s => s.doc.populations)

   // Place-mode is armed/disarmed by WorldShell (the common ancestor of this component and
   // TrafficPanel) via the placeMode prop; a click on the globe here places a population, then
   // hands control back up so WorldShell can disarm and TrafficPanel can select+focus the new row.
   const onPlace = (lat: number, lon: number) => {
-    const label = `pop-${populationCount + 1}`
+    // Phase 6 T9 carry-forward: same shared max-suffix helper TrafficPanel.tsx's "+ add" uses —
+    // this file's previous `pop-${populationCount + 1}` and TrafficPanel's independent
+    // `pop-${populations.length + 1}` counter could reissue the same label after a
+    // remove+re-add from either surface (Phase-5 backlog item).
+    const label = nextPopulationLabel(populations)
     const id = addPopulation(label, lat, lon)
     onExitPlaceMode()
     onPopulationPlaced(id)
   }
```

The selector changes from a derived `number` (`Object.keys(...).length`) to the populations
record itself — still a plain Zustand selector by reference (same pattern `TrafficPanel.tsx`
already uses for `doc`), no behavior change to re-render frequency in practice (the populations
map reference only changes when populations actually change, same as every other `world.store`
selector in this codebase).

**Existing test unaffected:** `GlobeView.test.tsx`'s two cases only exercise the WebGL-unavailable
fallback branch (`webglAvailable` mocked false) — `onPlace`/`populations` are never reached by
either case (grep-verified: no `pop-` or `onPlace`/`addPopulation` reference in that test file).
No test file edit needed here.

- [ ] **Step 7: `GlobeScene.tsx` — texture mutation `useMemo` → `useLayoutEffect`**

Current imports (verbatim, `src/app/world/globe/GlobeScene.tsx:7`):

```tsx
import { Suspense, useCallback, useMemo, useRef, type ReactElement, type ReactNode } from 'react'
```

Diff (adds `useLayoutEffect`; `useMemo` stays imported — `Atmosphere()`'s `uniforms` still uses
it further down the same file, untouched by this step):

```diff
-import { Suspense, useCallback, useMemo, useRef, type ReactElement, type ReactNode } from 'react'
+import { Suspense, useCallback, useLayoutEffect, useMemo, useRef, type ReactElement, type ReactNode } from 'react'
```

Current `Earth` body (verbatim, `src/app/world/globe/GlobeScene.tsx:61–72`):

```tsx
function Earth({ placeMode, onPlace }: EarthProps): ReactElement {
  const texture = useTexture(earthTextureUrl)
  useMemo(() => {
    texture.wrapS = THREE.RepeatWrapping
    texture.offset.x = TEXTURE_LON_OFFSET
    texture.colorSpace = THREE.SRGBColorSpace
    // useTexture returns an already-uploaded texture; changing wrap mode after upload needs
    // needsUpdate so the GPU sampler is re-configured — otherwise some three.js versions keep
    // ClampToEdge and smear a seam at the offset's wrap boundary. (wrapT/repeat unchanged: the
    // offset only shifts horizontally and the image already spans the full 0..1 V range.)
    texture.needsUpdate = true
  }, [texture])
```

Diff:

```diff
 function Earth({ placeMode, onPlace }: EarthProps): ReactElement {
   const texture = useTexture(earthTextureUrl)
-  useMemo(() => {
+  // Phase 6 T9 carry-forward: this texture wrap/offset mutation is a SIDE EFFECT (mutating a
+  // shared THREE.Texture instance + flagging it for a GPU re-upload), not a memoized pure
+  // derivation — useLayoutEffect is the conventional home for a synchronous, pre-paint
+  // side effect. useMemo happened to work because its body also runs synchronously during
+  // render, but React does not guarantee a useMemo body runs exactly once per input or is
+  // never re-invoked/discarded (e.g. under future concurrent-rendering behavior) the way an
+  // effect's cleanup/rerun contract is guaranteed. Same dependency array, same body, same
+  // texture.needsUpdate=true flag — behavior-preserving.
+  useLayoutEffect(() => {
     texture.wrapS = THREE.RepeatWrapping
     texture.offset.x = TEXTURE_LON_OFFSET
     texture.colorSpace = THREE.SRGBColorSpace
     // useTexture returns an already-uploaded texture; changing wrap mode after upload needs
     // needsUpdate so the GPU sampler is re-configured — otherwise some three.js versions keep
     // ClampToEdge and smear a seam at the offset's wrap boundary. (wrapT/repeat unchanged: the
     // offset only shifts horizontally and the image already spans the full 0..1 V range.)
     texture.needsUpdate = true
   }, [texture])
```

No test file covers this (R3F components aren't jsdom-tested in this repo, per `ArcsLayer.tsx`'s
own header comment) — the live smoke (Step 15 below) re-verifies the globe texture still renders
correctly (not mirrored, seam-free) after this change, since it's the phase's known
highest-calibration-risk surface (see `GlobeScene.tsx`'s own `TEXTURE_LON_OFFSET` comment).

- [ ] **Step 8: `buildDrainArcs` missing-geo fallback test — TEST-ONLY addition to `globeArcs.test.ts`**

Backlog text (verbatim): *"buildDrainArcs `?? [pop.lat,pop.lon]` fallback untested [reachable
only if a prev region's catalogId lacks REGION_GEO; defensive, low-risk]."* This is a test-only
addition — **no `worldEngine/` source change** (the fallback logic in `buildDrainArcs`,
`src/lib/worldEngine/index.ts:556`, is untouched).

The fallback triggers when `geoOfRegion(prevRegionId)` returns `null` for the population's
PREVIOUS region during a pending failover — i.e. that region's `catalogId` has no entry in
`REGION_GEO` (`src/lib/world/regionGeo.ts`). `'geo'`/`'latency'` routing policies rank a
geo-less region LAST (`distanceScore` in `src/lib/world/routing.ts:9-13` returns
`Number.MAX_SAFE_INTEGER` for a missing geo entry), so reaching a scenario where a geo-less
region is the population's FIRST (and therefore "previous", once it fails over) resolved region
needs `'priority'` policy to force it there regardless of distance.

Add a new fixture function to `src/lib/worldEngine/globeArcs.test.ts`, placed after
`singleRegionFixture` and before the `drive` helper (i.e. immediately following the existing
`singleRegionFixture(popCount)` function, verbatim end at line 209, and before `function
drive(...)` at line 211):

```ts
// Reproduces the exact carry-forward scenario Phase 5's final review flagged as untested:
// buildDrainArcs' `?? [pop.lat,pop.lon]` fallback (index.ts ~line 556) only triggers when the
// POPULATION'S PREVIOUS region (captured in the engine's internal popPrevRegion map at the
// moment failover starts) has a catalogId missing from REGION_GEO — geoOfRegion(prevRegionId)
// returns null, and the drain arc's fromLatLon falls back to the population's own lat/lon
// instead of the (unresolvable) previous region's geo. 'priority' routing (not 'geo'/'latency',
// which would rank the geo-less region LAST via distanceScore's Number.MAX_SAFE_INTEGER
// fallback, src/lib/world/routing.ts) forces the population onto the geo-less region FIRST
// regardless of distance, so the failover's "previous" region is the one missing from REGION_GEO.
function missingGeoFailoverFixture() {
  const doc = createWorld()
  doc.traffic.autoBaseline = false
  doc.routing.policy = 'priority'
  doc.routing.dnsTtlSec = 5

  const r1 = createRegion('not-a-real-region')   // catalogId deliberately absent from REGION_GEO
  const r2 = createRegion('us-east-1')
  doc.routing.priorityOrder = [r1.id, r2.id]
  Object.assign(doc.regions, { [r1.id]: r1, [r2.id]: r2 })

  const az1 = createAz(r1.id, 'not-a-real-region-a')
  const az2 = createAz(r2.id, 'us-east-1a')
  Object.assign(doc.azs, { [az1.id]: az1, [az2.id]: az2 })

  const s1 = createServer(az1.id, getPreset('dedicated-8')!)
  const s2 = createServer(az2.id, getPreset('dedicated-8')!)
  Object.assign(doc.servers, { [s1.id]: s1, [s2.id]: s2 })

  const web = publicBlueprint('web', 0)
  Object.assign(doc.blueprints, { [web.id]: web })

  const place = (bpId: string, serverId: string) => { const pl = createPlacement(bpId, serverId); doc.placements[pl.id] = pl; return pl }
  place(web.id, s1.id)
  place(web.id, s2.id)

  const pop = createPopulation('nyc', 40.7, -74.0)
  pop.peakRps = 50
  doc.populations[pop.id] = pop

  const compiled = compileWorld(doc)
  return { doc, compiled, r1, r2, pop }
}
```

Add a new `it(...)` to the `describe('buildArcs v2 (globe scope)', ...)` block, immediately
after the existing `'drain arc from old to new region during pending failover, then clears'` case
(ends at line 361) and before `'cap truncates drain last, keeping client arcs first'`:

```ts
  it("drain arc falls back to the population's own lat/lon when the previous region has no REGION_GEO entry", () => {
    // Phase-5 final-review MINOR, closed as a Phase-6 T9 carry-forward: the buildDrainArcs
    // `?? [pop.lat,pop.lon]` fallback branch had no test — it's reachable only when the
    // FAILED-OVER-FROM region's catalogId is missing from REGION_GEO (geoOfRegion returns null).
    const f = missingGeoFailoverFixture()
    const sim = drive(f.doc, f.compiled)
    const frames: FramePayload[] = []
    sim.engine.attachRenderer({ level: 'globe' }, p => frames.push(p))
    sim.stepFor(3)                                    // warm DNS cache -> r1 (priority-first, despite no geo)
    sim.engine.setOutage('region', f.r1.id, true)

    // Same step-until-event-fires pattern as the "drain arc from old to new region" case above.
    let startedFrame: FramePayload | null = null
    for (let i = 0; i < 100 && !startedFrame; i++) {
      sim.engine.__test_step(1)
      sim.engine.__test_render(1000)
      if (sim.events.some(e => e.kind === 'failover_started')) startedFrame = frames[frames.length - 1]
    }
    expect(startedFrame).not.toBeNull()
    const drainArcs = startedFrame!.arcs.filter(a => a.kind === 'drain')
    expect(drainArcs).toHaveLength(1)
    // r1's catalogId ('not-a-real-region') has no REGION_GEO entry, so geoOfRegion(r1.id) is
    // null and fromLatLon falls back to the population's own [lat, lon] instead of r1's geo.
    expect(drainArcs[0].fromLatLon).toEqual([f.pop.lat, f.pop.lon])
    const geoR2 = REGION_GEO['us-east-1']
    expect(drainArcs[0].toLatLon).toEqual([geoR2.lat, geoR2.lon])
    sim.engine.stop()
  })
```

No import changes needed — `createWorld`/`createRegion`/`createAz`/`createServer`/
`createPlacement`/`createPopulation`/`getPreset`/`compileWorld`/`REGION_GEO`/`publicBlueprint`/
`drive` are all already imported/defined earlier in this file.

Run: `npx vitest run src/lib/worldEngine/globeArcs.test.ts` → PASS (9/9 — the 8 existing cases
plus this new one).

- [ ] **Step 9: run the full suite + build to verify all four carry-forwards together**

Run: `npx vitest run` → full suite green (adds 1 new file `populationLabel.test.ts` [4 tests] + 1
new case in `globeArcs.test.ts` [now 9]; `TrafficPanel.test.tsx`/`GlobeView.test.tsx`/
`ArcsLayer.test.ts` all still green, no edits needed to any of them per Steps 5/6/3's "existing
test unaffected" notes).
Run: `npm run build` → strict tsc + vite build green (no new deps, no type changes).

---

### Part B — CLAUDE.md rewrite

- [ ] **Step 10: replace the "Project Overview" section**

Current section (verbatim, `CLAUDE.md` lines 5–21):

```md
## Project Overview

Scalemap is a desktop application (Tauri 2 + React 19 + TypeScript) for visualizing and simulating infrastructure systems. Users drag infrastructure nodes onto a canvas, wire them together, and run a client-side traffic simulation that animates request/event/stream particles across the graph, computes per-node metrics (throughput, latency, error rate, queue depth), estimates cloud cost, and flags structural design issues (SPOFs, exposed databases, unbalanced load balancers, etc.).

The app is well past scaffold stage. Core systems that exist today:

- **Canvas** (`@xyflow/react`) with 18 custom compute/network/storage/messaging/caching node types and 8 group/container node types (VPC, subnet, AZ, region, k8s cluster, ECS cluster, Docker Compose, namespace), all with fully custom node/edge rendering.
- **Simulation engine** — a `requestAnimationFrame` particle engine driving live per-node metrics, replay/scrubbing, and a request inspector.
- **Packet system** — a Flyweight-style registry of packet templates (generic or user-defined protocols: http, event, stream, db) shared across edges.
- **Structural linter** — 9 rules that flag design smells in the graph (see below).
- **Cost model** — per-provider (AWS/GCP/Azure) pricing keyed off simulated traffic volume, with tiered egress billing.
- **ScaleScript** — a declarative JSON DSL for parameterizing a simulation run (node/edge overrides, timed scenarios, global SLOs).
- **Terraform export** (one-way: diagram → HCL). There is no Terraform *import*/parsing — see Roadmap.
- **Vault templates** — prebuilt starter diagrams (web, serverless, event-driven, k8s, data, network patterns).
- **.scalemap file persistence** via Tauri commands, with a `localStorage`-backed mock for browser-only dev.

There is no `prd.txt` in the repo (it has been removed); this file is the source of truth for scope and architecture.
```

Replace with:

```md
## Project Overview

Scalemap is a desktop application (Tauri 2 + React 19 + TypeScript) for authoring and simulating
multi-region infrastructure "worlds." Users build a world at four zoom levels — globe → region →
availability zone → server — out of regions, AZs, servers, service blueprints, placements, and
managed services; `compileWorld()` resolves that document into concrete service instances and
permitted/blocked network paths; a from-scratch client-side simulation engine
(`src/lib/worldEngine/`) ticks the compiled world at a fixed step rate and publishes live
per-instance/server/AZ/region metrics, engine events, and replay frames that drive every view. A
deterministic analysis-rule engine and an on-demand LLM architecture reviewer surface design
issues (structural SPOFs, exposed databases, capacity/geo problems, plus free-form AI-found
issues) alongside a cost model and traffic-authoring tools.

This is the app's SECOND full architecture: the original React-Flow "canvas" prototype —
hand-wired nodes/edges, a particle-based `requestAnimationFrame` simulation, a 9-rule structural
linter, a ScaleScript DSL, one-way Terraform export, and vault templates — was deleted wholesale
in Phase 2 of a ground-up rebuild (2026-07-08) and replaced by everything described below. None
of the legacy systems exist in the codebase today; do not assume any of them do (see
`docs/module-boundaries.md`'s §1A–§1I for exactly what was removed and why, if that history is
ever needed).

Core systems that exist today:

- **World document model** (`src/lib/world/`) — a normalized `WorldDoc` (regions, AZs, servers,
  service blueprints, placements, managed services, client populations, routing/traffic config)
  plus `compileWorld(doc)`, the pure gate every other system reads through: it resolves
  placements into concrete `ServiceInstance`s, evaluates firewall/port/network-isolation rules
  into permitted/blocked `CompiledPath`s, builds routing tables, and emits structural
  `CompileFinding`s. Nothing downstream — views, the engine, analysis rules — reads the raw
  `WorldDoc` for anything derived; always `compiled`.
- **World engine** (`src/lib/worldEngine/`) — a from-scratch, deliberately-ported (not reused)
  discrete fixed-step simulation: demand generation, DNS-TTL-cached region routing with health
  checks and failover, per-host CPU/RAM scheduling, VPS burstable-credit/noisy-neighbor modeling,
  NIC byte-rate caps, per-dependency circuit breakers, a BFS flow solver, replica promotion, a 1
  Hz metrics pyramid (instance→server→AZ→region→world), an event ring, and a replay buffer.
  Exposed as one facade — `createWorldEngine()` / the shared `worldEngine` singleton — driven
  ONLY by `simulation.store.ts`; every view reads that store, never the engine directly.
- **Four-level navigation shell** (`src/app/world/`, `nav.store.ts`'s `WorldLevel`) — a
  react-three-fiber globe (night-earth, health-colored region pins, population markers,
  engine-driven great-circle traffic arcs) → a region flow page (cross-AZ traffic columns, rack
  chassis) → a live React Flow AZ canvas → a per-server "circuit board" view (NIC/firewall gate,
  service chips, a unified hardware platform). All four are live-metrics-aware and
  replay-scrubbable.
- **Traffic authoring** — client populations (placed by hand or by clicking the globe),
  auto-baseline synthetic per-region demand, and routing policy (latency/geo/weighted/priority)
  with DNS TTL + health-check tuning.
- **Analysis engine** (`src/lib/analysis/`) — three rule families (structural/network-security/
  capacity, 13 rules) run over the compiled world plus the latest metrics batch, rendered in an
  `Analysis` tab merged with compile findings, with clickable affected-entity chips that jump to
  the region/AZ/server in question.
- **LLM architecture reviewer** (`src/lib/llmReview.ts`) — on-demand, schema-validated review
  against any OpenAI-compatible endpoint, rendered as AI-tagged cards beside the deterministic
  findings. The actual HTTP call is Rust-side (`llm_chat` Tauri command — a webview `fetch` to
  arbitrary hosts dies on CORS); settings persist to the app data dir and are never serialized
  into `.scalemap`, logged, or echoed unmasked (see Key Architecture Decisions).
- **Cost model** (`src/lib/costModelV2.ts`) — per-server hourly cost + managed-service pricing
  (`cloudRegistry.ts`) rolled up by region/AZ, plus tiered cross-AZ/cross-region/internet egress
  costed off live simulated byte rates.
- **Global Settings** (⚙ button, `SettingsModal.tsx`) — the app's dark/light theme toggle (now
  actually reachable from the UI) and the LLM endpoint configuration above.
- **`.scalemap` v2 file persistence** via Tauri commands, with a `localStorage`-backed mock for
  browser-only dev, plus a 30-second dirty-triggered autosave snapshot.

There is no `prd.txt` in the repo; this file is the source of truth for scope and architecture.
`docs/module-boundaries.md` is the detailed, file-by-file companion — more current than the prose
above for any specific file's history.
```

- [ ] **Step 11: fix the one stale line in "Commands"**

Current line (verbatim, `CLAUDE.md` lines 40–41):

```md
# Run frontend tests (vitest is configured; no test files exist yet — see Roadmap)
npx vitest
```

Diff (rest of the Commands section, including the code fence and every other command, is
byte-unchanged):

```diff
-# Run frontend tests (vitest is configured; no test files exist yet — see Roadmap)
+# Run frontend tests (extensive vitest coverage — jsdom for components, node env for pure
+# rule/engine logic)
 npx vitest
```

- [ ] **Step 12: replace the "Architecture" ASCII tree**

Current section (verbatim, `CLAUDE.md` lines 52–116, the whole fenced tree between `## Architecture`
and the following `---`) — reproduced in full in the current file, omitted here for length; every
line under it describes files deleted in Phase 2 (`canvas.store.ts`, `particleEngine.ts`,
`lint/`, `terraform/`, etc. — see `docs/module-boundaries.md` §1A–§1I). Replace the entire fenced
block with:

````md
```
src/
  App.tsx                        # useThemeBootstrap + ⌘N/⌘Z/⇧⌘Z global handlers + 30s
                                  # dirty-triggered autosave + HomeScreen/WorldShell gate
  main.tsx
  app/
    store/                       # Zustand, one store per domain — no monolithic store
      nav.store.ts                # WorldLevel ('globe'|'region'|'az'|'server') + regionId/azId/
                                   # serverId focus; deliberately has no dependency on world.store
      world.store.ts              # WorldDoc CRUD + undo/redo (history/future snapshots) +
                                   # dirty-marking on every mutation
      simulation.store.ts         # running/timeScale/latestBatch/events/healthOverrides/
                                   # scrubIndex/scrubBatch/degraded — the ONLY caller of
                                   # worldEngine directly; every view reads this store instead
      file.store.ts               # File path, dirty flag, recent files
      ui.store.ts                 # themeMode ('dark'|'light') + setThemeMode — persisted,
                                   # now user-facing via the Settings modal
    world/
      WorldShell.tsx               # Header (breadcrumb, SimControls, ⚙ Settings gear, file
                                    # actions) + active-level view + WorldPanel dock +
                                    # ScrubberV2 bottom bar
      GlobeView.tsx, globe/         # Level 1: react-three-fiber night-earth globe (GlobeScene,
                                    # RegionPins, PopulationMarkers, ArcsLayer engine-driven
                                    # traffic arcs) or GlobeCards fallback when WebGL is
                                    # unavailable
      RegionView.tsx, region/       # Level 2: cross-AZ traffic columns, timeline strip, rack
                                    # chassis (SplitLines, AzRow, CrossAzColumn)
      AzCanvas.tsx, AzSimOverlay.tsx # Level 3: live React Flow render of the focused AZ (the
                                    # app's one remaining @xyflow/react surface) + particle
                                    # overlay canvas
      ServerView.tsx, server/       # Level 4: the "circuit board" — NIC/firewall gate, service
                                    # chips, HardwarePlatform, PacketLayer, InspectorRail
      SettingsModal.tsx             # ⚙ modal — Appearance (theme toggle) + AI Review (LLM
                                    # endpoint config)
      panels/                       # WorldPanel dock tabs: Topology, Blueprints, Placements,
                                    # Traffic, Analysis (+ AiReviewSection), Events, Cost
      fileOps.ts, Breadcrumb.tsx, SimControls.tsx, EventsTab.tsx, useCompiledWorld.ts
  lib/
    world/                        # Pure document model + compiler — the schema of .scalemap v2
      types.ts                     # WorldDoc entities + CompiledWorld output types
      factories.ts, instanceCatalog.ts, regionGeo.ts, layoutRacks.ts, populationLabel.ts
      compileWorld.ts (+ network.ts, routing.ts)  # doc -> instances, permitted/blocked paths,
                                    # routing tables, compile findings — the gate every
                                    # consumer reads through instead of the raw doc
    worldEngine/                  # The simulation engine — a from-scratch port (not a reuse)
                                   # of the deleted canvas app's particleEngine mechanisms
      index.ts                     # createWorldEngine() facade — sequences every subsystem
                                    # below into one fixed-step run; exports MAX_GLOBE_ARCS
      rng.ts, engineClock.ts, demand.ts, routingRuntime.ts, hostScheduler.ts, vpsModel.ts,
      networkRuntime.ts, breakers.ts, flows.ts, failover.ts, metrics.ts, events.ts, replay.ts
      types.ts                     # Frozen WorldEngineApi/MetricsBatch/EngineEvent/render-
                                    # payload contract — additive-only, see contract-drift.md
    analysis/                     # Deterministic rule engine over the compiled world
      types.ts, runAnalysis.ts, rules/{structural,network,capacity}.ts
    llmReview.ts                  # LLM review context builder + schema-validated, retrying
                                   # request client
    costModelV2.ts, cloudRegistry.ts, regionConfig.ts
    serializer.ts                 # .scalemap v2 (de)serialization
    nodeConfig.ts                 # NODE_CONFIG icon/category registry (no live consumer in the
                                   # world-model UI today) + surviving packet-template types
                                   # (PacketTemplate/PacketMode/PacketRegistry)
    theme.ts                      # DARK_COLORS/LIGHT_COLORS/CATEGORY_COLORS/FONT — the
                                   # --color-* token source for both themes
    tauri.ts / tauriMock.ts       # Tauri command wrappers + browser-dev localStorage/fetch
                                   # fallback (file I/O + LLM settings/chat)

src-tauri/src/
  main.rs, lib.rs
  commands.rs                    # All Tauri commands: save/load diagram, file dialogs, recent
                                  # files, save/load_llm_settings, llm_chat
```
````

- [ ] **Step 13: replace "Key Architecture Decisions"**

Current section (verbatim, `CLAUDE.md` lines 120–138):

```md
## Key Architecture Decisions

**Canvas engine:** `@xyflow/react` (React Flow) with fully custom node/edge components — never the library's default visual style.

**State management:** Zustand, one store per domain (listed above). No monolithic store.

**Simulation particles:** Particle state lives inside `particleEngine.ts`'s internal `EngineState`, mutated directly inside the `requestAnimationFrame` loop — never in Zustand. Only derived, lower-frequency data (`NodeMetrics`, events, bottleneck/SLO status) is published to `simulation.store.ts`, batched via the `onNodeMetrics` callback in `SimulationOverlay.tsx`. Do not add raw particle arrays to any reactive store.

**Packet registry (Flyweight):** Edges reference a shared `PacketTemplate` by id (`canvas.store.ts`) rather than embedding protocol config per-edge. `packetMode` toggles between `generic` (built-in defaults per protocol) and `custom` (user-authored templates).

**Node icons:** Route all icons through `NODE_CONFIG` in `src/lib/nodeConfig.ts`. Never hard-code icon elements in node JSX.

**Lint rules:** Structural checks run on-demand over the graph (`lintGraph.ts` builds in/out-edge adjacency once, then runs each rule from `rules.ts`). Current rules: `isolatedNode`, `exposedDatabase`, `noQueueConsumer`, `noQueueProducer`, `lambdaDirectDb`, `circularDependency`, `singleEntryPointSpof`, `unbalancedLoadBalancer`, `deepSyncChain`. Add new rules to `rules.ts` and register them in the same array — don't special-case rule execution elsewhere.

**Terraform:** Export-only (`exportTerraform.ts`, diagram → HCL string). There is currently no HCL parsing, no `hcl-rs` dependency, and no import path. Do not assume an import feature exists — treat any reference to Terraform *import* as future work, not current behavior.

**Undo/redo:** Immutable history stack in `canvas.store.ts` (`history`/`future` snapshot arrays of `{ nodes, edges }`).

**Cross-platform:** All Tauri API calls (file dialogs, path resolution) must use Tauri's cross-platform abstractions — no OS-specific system calls. Rust code is currently a single `commands.rs`; keep new commands there unless the file grows large enough to warrant splitting (not yet planned/required).
```

Replace with:

```md
## Key Architecture Decisions

**Four-level nav + compiled-world gate:** the app has exactly one document model, `WorldDoc`
(`src/lib/world/types.ts`), navigated at four zoom levels — globe → region → AZ → server
(`nav.store.ts`'s `WorldLevel`). Every view, the engine, and the analysis rules read
`compileWorld(doc)`'s output (`CompiledWorld`: instances, permitted/blocked paths, routing
tables, compile findings) for anything derived — never the raw doc. Extend `CompiledWorld`
additively; never reshape it (it fans out to every view, the engine's `start()`, and every
analysis rule).

**Engine facade + store seam:** `src/lib/worldEngine/index.ts`'s `createWorldEngine()` is the
ONLY simulation engine; `simulation.store.ts` is the ONLY file in the app allowed to call it
directly (`start`/`stop`/`attachRenderer`/`getReplayFrames`/`getTracedRequests`/`setOutage`).
Every view reads the store, never the engine facade. `worldEngine/types.ts` is a frozen contract
— additive-only changes, logged in `.superpowers/sdd/contract-drift.md` when they happen.

**AZ canvas:** `@xyflow/react` (React Flow) still renders one thing — the live AZ-level canvas
(`AzCanvas.tsx`), read-only (servers + managed services as nodes, aggregated compiled paths as
edges). It is not a general node/edge authoring surface the way the deleted canvas app was;
don't assume React Flow appears anywhere else.

**State management:** Zustand, one store per domain (`nav`, `world`, `simulation`, `file`, `ui` —
no monolithic store). `nav.store.ts` deliberately has no dependency on `world.store.ts`:
navigating never pushes undo/redo history.

**Undo/redo:** immutable history stack in `world.store.ts` (`history`/`future` snapshot arrays of
`{ doc }`), routed through one internal `mutate()` helper that also marks the file dirty — new
CRUD actions get both for free by going through it.

**Analysis rules:** one registry, `ANALYSIS_RULES` (`src/lib/analysis/runAnalysis.ts`) —
`structural`/`network`/`capacity` rule files each export their rule objects, spread into the same
array. Add new rules there; don't special-case execution elsewhere. Rules never duplicate
`compiled.findings` — the Analysis tab merges both lists and suppresses the compile-side
duplicate of any rule that re-surfaces a compile finding (e.g. `blocked-dependency-path`).

**Packet system's current role:** the Flyweight packet-template *types*
(`PacketTemplate`/`PacketMode`/`PacketRegistry`, `src/lib/nodeConfig.ts`) survive from the
deleted canvas app and are read by `BlueprintDependency.packetTemplateId` and
`ScalemapFileV2.packets` — but there is no authoring UI for them in the world model today. Don't
assume a packet editor exists; adding one would be new work, not a restoration.

**LLM reviewer + key security (non-negotiable):** `src/lib/llmReview.ts` builds a review context
from the compiled world + deterministic findings + aggregated metrics (never raw instance maps),
sends it to any OpenAI-compatible endpoint via the Rust-side `llm_chat` Tauri command (a webview
`fetch` to arbitrary hosts dies on CORS), and validates/retries against a hand-rolled JSON schema
check. Settings (`baseUrl`/`apiKey`/`model`) persist to `llm_settings.json` in the app data dir.
The API key is NEVER serialized into `.scalemap` (settings never touch `world.store`/
`serializer`), NEVER logged or `console.*`'d, NEVER included in the review-context payload,
REDACTED from every error string on both the Rust and TS sides, and rendered only masked
(`•••• <last4>`) after save — the Settings modal's password input never echoes a saved key back
into its value.

**Theme:** `--color-*` CSS custom properties (`theme.ts`'s `DARK_COLORS`/`LIGHT_COLORS`,
bootstrapped by `App.tsx`'s `useThemeBootstrap`) are the only sanctioned color source for new UI
— no hardcoded hexes. The dark/light toggle is live and user-facing via the ⚙ Settings modal
(`ui.store.ts`'s `themeMode`); design new UI to look correct in both.

**Cross-platform:** all Tauri API calls (file dialogs, path resolution, the LLM HTTP transport)
must use Tauri's cross-platform abstractions — no OS-specific system calls. Rust code is
currently a single `commands.rs`; keep new commands there unless the file grows large enough to
warrant splitting (not yet planned/required).
```

- [ ] **Step 14: replace "Diagram File Format"**

Current section (verbatim, `CLAUDE.md` lines 164–179):

````md
## Diagram File Format

`.scalemap` files are JSON (`src/lib/serializer.ts`):

```json
{
  "version": "1",
  "meta": { "name": "", "created": "", "modified": "" },
  "viewport": { "x": 0, "y": 0, "zoom": 1 },
  "nodes": [{ "id": "", "type": "", "position": {}, "data": {} }],
  "edges": [{ "id": "", "source": "", "target": "", "type": "", "data": {} }],
  "packets": { "mode": "generic", "templates": {}, "nextId": 1 }
}
```

`packets` is optional (only present when the diagram uses custom packet templates).
````

Replace with:

````md
## Diagram File Format

`.scalemap` files are JSON, version `"2"` (`src/lib/serializer.ts` — the v1 canvas-era format
was removed with the legacy app in Phase 2 and is explicitly rejected on load with a dedicated
error message):

```json
{
  "version": "2",
  "meta": { "name": "", "created": "", "modified": "" },
  "world": {
    "routing": { "policy": "latency", "weights": {}, "priorityOrder": [], "healthCheckIntervalMs": 10000, "healthCheckFailureThreshold": 3, "dnsTtlSec": 30 },
    "traffic": { "autoBaseline": true, "baselineTotalRps": 1000 },
    "populations": {},
    "regions": {},
    "azs": {},
    "servers": {},
    "blueprints": {},
    "placements": {},
    "managedServices": {}
  },
  "packets": {},
  "viewState": { "level": "globe" }
}
```

`world` is the full `WorldDoc` (`src/lib/world/types.ts`) — every entity collection
(`regions`/`azs`/`servers`/`blueprints`/`placements`/`managedServices`/`populations`) plus
`routing`/`traffic` config, keyed by id. `deserializeWorld` validates that `meta` and all 9
top-level `WorldDoc` collections are present and non-null objects before accepting a file,
throwing a single "missing or malformed world document" error otherwise. `packets` is optional —
present only when the world uses custom (non-generic) packet templates (`PacketRegistry`,
`src/lib/nodeConfig.ts`; see Key Architecture Decisions for the packet system's current, reduced
role). `viewState` is optional — `{ level, regionId?, azId?, serverId? }`, the nav focus at save
time, restored on reopen so a saved file reopens where you left it. There is no analysis-finding
or LLM-review persistence in this format — both are derived/ephemeral (see Key Architecture
Decisions).
````

- [ ] **Step 15: fix the "Design System" category-accent swatch + add a light-mode note**

Current section (verbatim, `CLAUDE.md` lines 142–160):

````md
## Design System

```
Canvas bg:         #0D0F12   /  canvas dots: #1A1D22
Node base:         #161920   /  border: #2A2E38
Surface:           #0F1117   /  surface hover: #13161E
Toolbar:           #111318   /  toolbar border: #1E2128

Compute/Orchestration: #4A9EFF (blue)
Storage/Caching:       #F5A623 (amber)
Network:               #2DD4BF (teal)
Messaging:              #A78BFA (purple)
Grouping:               #475569 (slate, transparent bg)

Text primary: #F1F5F9 / secondary: #94A3B8 / muted: #64748B
Status: danger #EF4444 / success #22C55E / warning #F59E0B
```

Source of truth: `src/lib/theme.ts` (`COLORS`, `CATEGORY_COLORS`). Font: `JetBrains Mono` throughout. All animations must respect `prefers-reduced-motion`.
````

The `canvas`/`node`/`surface`/`toolbar`/text/status swatch (all `DARK_COLORS` values) is still
byte-exact — only the category row (`CATEGORY_COLORS`) drifted after an accessibility retune. Diff:

`````diff
 Canvas bg:         #0D0F12   /  canvas dots: #1A1D22
 Node base:         #161920   /  border: #2A2E38
 Surface:           #0F1117   /  surface hover: #13161E
 Toolbar:           #111318   /  toolbar border: #1E2128

-Compute/Orchestration: #4A9EFF (blue)
-Storage/Caching:       #F5A623 (amber)
-Network:               #2DD4BF (teal)
-Messaging:              #A78BFA (purple)
-Grouping:               #475569 (slate, transparent bg)
+Compute/Orchestration: #5B9CF6 (blue)
+Storage/Caching:       #E0A552 (amber)
+Network:               #3FC7B8 (teal)
+Messaging:              #9C8CE0 (violet)
+Grouping:               #8391A5 (slate-blue accent, transparent bg)

 Text primary: #F1F5F9 / secondary: #94A3B8 / muted: #64748B
 Status: danger #EF4444 / success #22C55E / warning #F59E0B
 ```

-Source of truth: `src/lib/theme.ts` (`COLORS`, `CATEGORY_COLORS`). Font: `JetBrains Mono` throughout. All animations must respect `prefers-reduced-motion`.
+Source of truth: `src/lib/theme.ts` (`DARK_COLORS`, `CATEGORY_COLORS`). Font: `JetBrains Mono`
+throughout. All animations must respect `prefers-reduced-motion`.
+
+**Light mode:** `theme.ts` also exports a full `LIGHT_COLORS` sibling (WCAG-AA-checked
+replacements — e.g. `danger` #DC2626, `success` #16A34A/`successText` #11823B, `warning`
+#B45309, `accent` #3F6DAC) and every `CATEGORY_COLORS` entry carries a `foreground.light`
+variant for icon/text use on a light card. The dark/light toggle (`ui.store.ts`'s `themeMode`,
+live via the ⚙ Settings modal) swaps the whole set at runtime through `App.tsx`'s
+`useThemeBootstrap`, which writes every token as a `--color-*` CSS custom property — new UI
+must use `var(--color-*)` exclusively, never a hardcoded hex, since both modes are now genuinely
+reachable in the running app.
`````

- [ ] **Step 16: replace "Key Dependencies"**

Current section (verbatim, `CLAUDE.md` lines 183–194):

```md
## Key Dependencies

| Package | Purpose |
|---|---|
| `@xyflow/react` | Canvas — node/edge rendering, pan/zoom |
| `zustand` | State management |
| `dagre` | Graph layout (installed; verify usage before relying on it) |
| `framer-motion` | Panel/node animations |
| `lucide-react` | Node icons |
| `vitest` / `@testing-library/react` | Test harness (configured, unused — see Roadmap) |

Rust (`src-tauri/Cargo.toml`): `tauri`, `tauri-plugin-opener`, `tauri-plugin-dialog`, `serde`/`serde_json`, `chrono`. No `hcl-rs`.
```

Replace with:

```md
## Key Dependencies

| Package | Purpose |
|---|---|
| `@react-three/fiber` | React renderer for three.js — the globe scene (`Canvas`, `useFrame`, hooks) |
| `@react-three/drei` | `OrbitControls`, `useTexture`, and other r3f scene helpers used by the globe |
| `three` | The WebGL scene graph underlying the globe (night-earth sphere, atmosphere shader, arc geometry) |
| `@xyflow/react` | The AZ-level canvas (`AzCanvas.tsx`) — node/edge rendering, pan/zoom. The only remaining React Flow surface; the original node-authoring canvas app that used it more broadly was deleted in Phase 2 |
| `zustand` | State management — one store per domain (`nav`/`world`/`simulation`/`file`/`ui`) |
| `framer-motion` | Panel/globe/board animations; every animated component also checks `useReducedMotion()` |
| `lucide-react` | Icons — today's only live consumer is `HomeScreen.tsx`; `nodeConfig.ts`'s `NODE_CONFIG` icon registry has no consumer in the world-model UI (see Key Architecture Decisions) |
| `vitest` / `@testing-library/react` | Test harness — extensively used (see Known Issues / Roadmap) |

Rust (`src-tauri/Cargo.toml`): `tauri`, `tauri-plugin-opener`, `tauri-plugin-dialog`,
`serde`/`serde_json`, `chrono`, `reqwest` (`default-features = false`, features `["json",
"rustls-tls"]` — added in Phase 6 for the `llm_chat` command; no OpenSSL dependency).
```

`dagre` stays in `package.json` (this task does not uninstall anything — it was already unused
before this phase, `grep -rln "dagre" src` finds zero matches) but is dropped from this table
since it plays no role in the current architecture.

- [ ] **Step 17: replace "Known Issues / Roadmap"**

Current section (verbatim, `CLAUDE.md` lines 198–203, immediately before the standing
module-boundaries instruction paragraph — that final paragraph is UNCHANGED, keep it verbatim
exactly where it is):

```md
## Known Issues / Roadmap

- **No test coverage.** `vitest` and Testing Library are installed but there isn't a single `*.test.ts(x)` file yet. New non-trivial logic (lint rules, cost model, ScaleScript resolver) is a good place to start.
- **Terraform import doesn't exist.** If this is picked back up, decide whether to keep parsing client-side or reintroduce a Rust-side `hcl-rs` sidecar before writing code.
- **`ReportsPanel.tsx` exports aren't persisted to disk** — wire up a Tauri command instead of leaving it browser-only.
- **Rust commands are a single flat file.** Fine at the current size; revisit modularization only if `commands.rs` becomes hard to navigate.
```

Replace with:

```md
## Known Issues / Roadmap

Test coverage is now extensive (`lib/analysis`'s rule files, `lib/worldEngine`'s subsystems,
`lib/world`, and most of `app/world`'s panels/board/rack/globe components all have
`*.test.ts(x)` coverage — jsdom for anything rendering React, plain node env for pure logic).
`src-tauri/src/commands.rs` remains a single flat file — still fine at its current size (file
I/O commands + the LLM settings/chat commands); revisit modularization only if it becomes hard
to navigate.

This file, `docs/module-boundaries.md`, and the six phase-completion summaries in
`.superpowers/sdd/progress.md` are the current architectural record. The rebuild's scope is
complete as of Phase 6; the following is intentionally parked, not partially built or in
progress — do not assume any of it exists:

- k8s/ECS schedulers (blueprint/placement scheduling semantics beyond the current explicit
  server-by-server placement model)
- ScaleScript v2 (a declarative scenario/override DSL — the original ScaleScript was deleted
  with the legacy canvas app and never ported)
- Terraform v2 (diagram/world → HCL export, or any HCL import/parsing — the original
  export-only Terraform support was deleted with the legacy canvas app and never ported; there
  has never been an import path in any version of this app)
- AI watch-mode (continuous/background LLM review, vs. today's on-demand `Review architecture`
  button)
- Spot-instance cost/interruption modeling
- Managed-service pseudo-internals (today's `ManagedService` is a black-box cost/routing
  target, not a simulated internal engine)
- LLM review persistence/history (today's AI cards are ephemeral — never persisted, never
  serialized into `.scalemap`)
- Streaming LLM responses / request cancellation (today's review request is a single blocking
  round trip with one retry; no cancel button, no token streaming)
```

- [ ] **Step 18: verify the rewritten CLAUDE.md reads cleanly end-to-end**

No automated test covers a markdown file — read the whole rewritten `CLAUDE.md` top to bottom
and confirm: every section flows (`## Project Overview` → `## Commands` → `## Architecture` →
`## Key Architecture Decisions` → `## Design System` → `## Diagram File Format` → `## Key
Dependencies` → `## Known Issues / Roadmap` → the standing module-boundaries instruction
paragraph, same order as today); no leftover mention of `canvas.store`, `particleEngine`,
`lint/`, `ScaleScript`, `dagre`, `hcl-rs`, or "no test coverage" survives anywhere in the file.

---

### Part C — `docs/module-boundaries.md` §O

- [ ] **Step 19: insert §O**

Insert immediately after §N's closing content and its trailing `---` separator (current file:
§N's "Blast radius / Phase-4 backlog closed this task" paragraph ends at line 504, followed by a
`---` at line 506, then `## 2. Shared "hub" files...` starts at line 508) — i.e. §O goes between
that `---` and `## 2.`, as the new last entry of "## 1. Feature modules":

```md
### O. Analysis engine + LLM reviewer + Settings — Phase 6 final layer (`src/lib/analysis/`, `src/lib/llmReview.ts`, `src/app/world/SettingsModal.tsx`, `src/app/world/panels/AnalysisTab.tsx`/`AiReviewSection.tsx`, 2026-07-10)

The rebuild's final phase. Layer 1 is a deterministic analysis-rule engine — three families
(`structural`/`network`/`capacity`, 13 rules total across Tasks 1–3) run over `compileWorld`'s
output (+ the latest `MetricsBatch`, optional), replacing the plain `Findings` tab with a
family-grouped `Analysis` tab that merges unsuppressed compile findings and gives every affected
entity id a clickable navigation chip (Task 4). Layer 2 is an on-demand LLM architecture review
against any OpenAI-compatible endpoint, schema-validated and retried once on a malformed reply
(Task 6), transported through a new Rust command since a webview `fetch` to arbitrary hosts dies
on CORS (Task 5), rendered as AI-tagged cards beside the deterministic findings (Task 8). A new
global Settings modal (⚙, Task 7) is the first UI ever to expose the app's already-wired
dark/light theme toggle, plus the LLM endpoint configuration. Spec:
`docs/superpowers/specs/2026-07-10-phase6-analysis-llm-design.md`.

| File | Role |
|---|---|
| `src/lib/analysis/types.ts` (Task 1) | `AnalysisFinding`/`AnalysisRule`/`AnalysisInput`/`AnalysisFamily`/`AnalysisSeverity` — the shape every rule file and `runAnalysis.ts` share. `id` is `` `${ruleId}:${primaryAffectedId}` `` (or `` `${ruleId}:world` `` when `affected` is empty), stable across runs — never derived from array position |
| `src/lib/analysis/runAnalysis.ts` (Task 1, appended Tasks 2–3) | `ANALYSIS_RULES: AnalysisRule[]` — ONE registry; `structural.ts`/`network.ts`/`capacity.ts` each export their rule objects and are spread into this same array, never executed through a separate path (same "one array, no special-casing" convention the deleted §1C structural linter established and this phase inherits). `runAnalysis(doc, compiled, lastBatch)` builds one `AnalysisInput`, concatenates every rule's findings, and sorts by severity (critical→warning→info) then family (structural→network→capacity) then `ruleId` — a stable composite-key sort |
| `src/lib/analysis/rules/structural.ts` (Task 1, 6 rules) | `single-az-region`, `no-failover-region`, `replicas-colocated`, `dependency-cycle`, `deep-sync-chain`, `unused-managed-service` — read `compiled.instances`/`compiled.routing.populationRegionOrder`/`doc.blueprints` only |
| `src/lib/analysis/rules/network.ts` (Task 2, 3 rules) | `blocked-dependency-path` (id embeds the compiled path id so the Analysis tab can suppress the raw compile-side duplicate, D4), `db-port-exposed`, `entry-unreachable` — replicate a source-aware firewall first-match-wins loop rather than importing `src/lib/world/network.ts`'s `evaluateFirewall` (that helper ignores `source` by design, Phase-1 scope; documented in-file, `network.ts` itself is untouched) |
| `src/lib/analysis/rules/capacity.ts` (Task 3, 4 rules) | `ram-oversubscribed`, `burstable-sustained-load` (silent without `lastBatch`), `ocean-crossing-population` (imports `REGION_GEO`/`greatCircleKm` from `src/lib/world/regionGeo.ts` — the SAME distance source `routing.ts` already uses; no second haversine implementation), `ttl-outlives-detection` (`affected: []`, world-scoped id) |
| `src/lib/analysis/__fixtures__/worlds.ts` (Task 1, extended Tasks 2–3) | Shared doc-builder fixtures for rule tests, in the same "small local factory functions, no cross-file test imports" style every `worldEngine/*.test.ts` file already uses (§K) |
| `src/lib/llmReview.ts` (Task 6) | Pure, mock-`chat`-testable: `buildReviewContext(doc, compiled, findings, lastBatch)` (JSON string — world doc + deterministic/compile finding summaries + aggregated region/AZ metrics; NEVER instance-level maps, NEVER any settings value), `validateReviewResponse(raw)` (hand-rolled schema check + clamping, no new deps), `requestReview(settings, context, chat?)` (builds the chat request, retries ONCE on a malformed reply), `pingLlm(settings, chat?)`. `chat` defaults to `src/lib/tauri.ts`'s `llmChat` wrapper, injectable for tests |
| `src/app/world/panels/AnalysisTab.tsx` (Task 4, mounts `AiReviewSection` Task 8) | Replaces the old inline `Findings` tab body. `useMemo(runAnalysis(doc, compiled, displayBatch), [compiled, displayBatch?.simMs])` where `displayBatch = scrubBatch ?? latestBatch`; renders `structural`/`network`/`capacity` sections (non-empty only) then an unsuppressed-compile section. Exports `navigateToEntity(id, doc, compiled, nav)` (regionId→`goRegion`, azId→`goAz`, serverId→`goServer`, instanceId→its server's interior, else no-op) and `unsuppressedCompileFindings(analysis, compile)` (strips the `` `finding-` `` prefix off a compile id and checks it against the analysis id set) — both are the ONE place either kind of suppression/navigation logic lives; `WorldPanel.tsx`'s tab-count label calls the same `unsuppressedCompileFindings`, not a second computation |
| `src/app/world/panels/WorldPanel.tsx` (Task 4 tab rename, Task 8 threads `openSettings`) | `Tab` union's `'findings'` → `'analysis'`; label `` `Analysis (${n})` `` where `n` = analysis findings + unsuppressed compile findings (via the same helper above). Gained an `openSettings: () => void` prop in Task 8, threaded straight to `AnalysisTab` → `AiReviewSection` — a plain prop chain, not a store (see Boundary rules) |
| `src/app/world/panels/AiReviewSection.tsx` (Task 8) | `unconfigured`/`idle`/`in-flight`/`done`/`error` states. Violet AI chip uses `CATEGORY_COLORS.messaging.accent` (`theme.ts`) — a local hex const for this color is forbidden (Global Constraints; `theme.ts` already carries the exact violet, no new token needed). Review click calls `buildReviewContext` + `requestReview`; cards reuse `AnalysisTab`'s `navigateToEntity` for affected chips. Mounted at the top of `AnalysisTab` |
| `src/app/world/SettingsModal.tsx` (Task 7) | Portal overlay (`createPortal`, `position:fixed` backdrop, token-styled). Two sections: **Appearance** (`dark`\|`light` segmented control over `useUiStore(s=>s.themeMode)`/`setThemeMode` — no new plumbing, `App.tsx`'s `useThemeBootstrap` already applies the effect live) and **AI Review** (`baseUrl`/`apiKey type=password`/`model`, `Save`→`saveLlmSettings`, `Test connection`→`pingLlm`). Registers its OWN capture-phase `window` `keydown` listener for Escape (`stopPropagation`+`preventDefault`+`onClose`) so `WorldShell.tsx`'s bubble-phase nav-Escape handler bails — same mechanism Phase 3's inspector (§L) established for exactly this kind of overlay-vs-nav-shell conflict |
| `src/app/world/WorldShell.tsx` (Task 7) | Gained a ⚙ ghost button (first child of the header's right-side button cluster) + local `settingsOpen` state + `<SettingsModal open onClose>`; the `openSettings` prop threaded to `WorldPanel` in Task 8 is `() => setSettingsOpen(true)` — the SAME state the gear opens |
| `src/lib/tauri.ts` / `src/lib/tauriMock.ts` (Task 5) | `LlmSettings { baseUrl; apiKey; model }` + `saveLlmSettings`/`loadLlmSettings`/`llmChat` wrappers (explicit snake↔camel field mapping to/from the Rust struct — Tauri v2 camelCases command ARG names but not struct fields, verified against the existing `commands.rs` conventions). The mock mirrors settings to `localStorage` and does a direct `fetch()` for `llm_chat` (fine for local stubs/Ollama/LM Studio, where the user controls CORS) |
| `src-tauri/src/commands.rs` (Task 5) | `save_llm_settings`/`load_llm_settings` (mirrors the existing `recent_files.json` app-data-dir pattern exactly) + `llm_chat` (async, `reqwest` POST, 60s timeout, returns the raw response body text for ANY HTTP status so the frontend can read an OpenAI-style error envelope itself) + `redact(msg, key)` (pure, unit-tested — masks every occurrence of the key, short keys masked entirely) |
| `scripts/llm-stub.mjs` (Task 8) | ~40-line stdlib-`http` OpenAI-compatible stub for the live smoke: CORS-enabled `POST /v1/chat/completions`, first hit returns malformed content (proves the retry live), every later hit returns a canned valid review |

**Boundary rules:** `src/lib/analysis/*` imports ONLY `src/lib/world/types` and
`src/lib/worldEngine/types` (types-only — never the executable `worldEngine/index.ts` facade,
never any `app/` store, never React) — every rule file is plain, node-env-testable logic, exactly
like the deleted §1C linter and the live `worldEngine/` subsystems (§K) before it. `llmReview.ts`
imports only `src/lib/tauri.ts`'s wrappers (`llmChat`, `LlmSettings`) — never calls Tauri's
`invoke` itself, never imports `tauriMock.ts` directly (that split is `tauri.ts`'s own concern, an
existing pattern this phase didn't change). `AnalysisTab.tsx`/`AiReviewSection.tsx` are the ONE
place either the analysis findings or the AI review reach the DOM — both compose `runAnalysis`,
`navigateToEntity`, and (for AI) `buildReviewContext`/`requestReview`, rather than any other file
duplicating that wiring. `SettingsModal.tsx` NEVER imports `world.store.ts` or `serializer.ts` —
by construction, not convention: LLM settings are not world-document state and must never become
reachable from a save/serialize path.

**D6 key-security invariants (restated, non-negotiable — every one of these has a dedicated
test):** the API key is never serialized into `.scalemap` (enforced by `SettingsModal.tsx` never
importing `world.store`/`serializer.ts` at all — there is no code path for it to reach either);
never logged or `console.*`'d on either side; never included in `buildReviewContext`'s payload
(canary-string-tested); redacted (`commands.rs`'s `redact()`) from every error string the Rust
transport can produce; rendered only masked (`•••• <last4>`) in the Settings modal after a key has
been saved, and the masked placeholder is never echoed back into the input's live `value` (typing
a NEW value is the only way to overwrite a saved key — leaving the field empty on Save keeps the
existing one); the API key input is `type="password"`. Any task whose test suite can assert one of
these, does.

**The `openSettings` prop chain** (`WorldShell` → `WorldPanel` → `AnalysisTab` →
`AiReviewSection`) is this phase's one plain-prop thread across what would otherwise be a store
boundary — the same narrow, deliberate exception class §N's `placeMode` thread already
established (two components down a fixed hierarchy needing to share one boolean/callback that a
common ancestor owns), not a precedent for skipping stores generally elsewhere in `world/`.

**Carry-forwards closed this task (closing out Phase 5's backlog, `.superpowers/sdd/progress.md`
`## PHASE 5 COMPLETE`'s "OPEN ITEMS for Phase 6" list — see §N's own note above for the Phase-4
backlog, closed by Phase 5):** `worldEngine/index.ts:43`'s `MAX_GLOBE_ARCS` is now `export const`
(the ONE sanctioned `worldEngine/` edit this phase) and `ArcsLayer.tsx` imports it from the
engine facade instead of hand-duplicating the literal; a new `src/lib/world/populationLabel.ts`
(pure, `nextPopulationLabel(populations)` — scans existing `pop-N` labels for the max suffix) is
shared by `TrafficPanel.tsx`'s "+ add" and `GlobeView.tsx`'s place-on-globe handler, so the two
authoring surfaces can no longer reissue the same default label after a remove+re-add;
`GlobeScene.tsx`'s texture wrap/offset mutation moved from a `useMemo` (a memoized-derivation
hook being used for a side effect) to `useLayoutEffect` (the conventional home for a synchronous
pre-paint side effect), same body, same `texture.needsUpdate=true` flag; `globeArcs.test.ts`
gained a test for `buildDrainArcs`'s `?? [pop.lat,pop.lon]` fallback (a previous-region catalogId
missing from `REGION_GEO`), the one named gap Phase 5's final review left explicitly untested.
The other three Phase-5 backlog items (`NumberField` no external re-sync on undo/redo,
`PopulationMarkers`' aspirational "matches theme teal" comment, `health_check_failed`'s no-pulse
tradeoff) are cosmetic/documented-tradeoff and remain open — not part of this phase's scope.

**This is the rebuild's final phase.** With Task 9's docs landing, all six phases (world model +
navigation shell, substrate simulation engine, server interior board, region flow page + rack
chassis, R3F globe + traffic authoring, analysis engine + LLM reviewer + settings) are complete;
see `.superpowers/sdd/progress.md`'s `## PHASE 6 COMPLETE` entry for the closing summary and the
umbrella-spec §9 parked list of intentionally-unscoped future work.

---
```

(the trailing `---` above is the same section-separator convention every lettered section in
this file already ends with, immediately followed by `## 2. Shared "hub" files...`.)

---

### Part D — full verify, live phase-gate smoke, ledger, commit

- [ ] **Step 20: full verify**

Run: `npx vitest run` → full suite green (every T1–T8 test file plus this task's
`populationLabel.test.ts` and the extra `globeArcs.test.ts` case).
Run: `npm run build` → strict tsc + vite build green.
Run (from `src-tauri/`): `cargo build` → green.
Run (from `src-tauri/`): `cargo test` → green (T5's `redact`/settings-roundtrip/`llm_chat`-stub
tests). Per Global Constraints: the Rust transport's gate is `cargo test` + `cargo build`, NOT
the browser smoke below — state this split explicitly when reporting results.

- [ ] **Step 21: live phase-gate smoke (controller-run, strict port 1420, zero app console
  errors, screenshots, stop the dev server AND the stub after)**

Full end-to-end story (spec's Testing & Verification section + skeleton's Task 9 done bar):

1. Author a world tripping ≥4 analysis rules across all three families in one document:
   a **single-AZ region** (`single-az-region`, structural), a **db-port-exposed** server
   (`db-port-exposed`, network), a **ram-oversubscribed** server (`ram-oversubscribed`,
   capacity), and a **`dnsTtlSec` set shorter than `healthCheckIntervalMs ×
   healthCheckFailureThreshold`** (`ttl-outlives-detection`, capacity).
2. Open the `Analysis` tab — findings are grouped by family (structural/network/capacity),
   severity-ordered within each, plus a compile section for anything not suppressed. Click
   several affected-entity chips and confirm navigation (region chip → `goRegion`, server chip →
   `goServer`, etc.) — screenshot each hop.
3. Open Settings (⚙) → configure the AI Review endpoint against
   `node scripts/llm-stub.mjs 4141` (`baseUrl: http://localhost:4141/v1`, any `model` string) →
   Save.
4. Back in the Analysis tab's AI section, click `Review architecture` → confirm the stub's
   terminal log shows **TWO hits** (the first malformed reply triggers the one corrective retry,
   proven live, not just in `llmReview.test.ts`'s mocked case) → AI-tagged cards render beside the
   deterministic findings, with working affected-chip navigation.
5. Reload the app (or reopen Settings) → the saved API key renders masked (`•••• <last4>`), never
   echoed into the input's live value.
6. Save the world; grep the saved `.scalemap` payload (the `tauriMock` localStorage path in
   browser dev) for the configured API key string → confirm it is **ABSENT** (this is the D6
   assertion this task owns at the whole-app level — settings never touch `world.store`/
   `serializer`, so there is nothing to find).
7. Open Settings → Appearance → flip the theme to **light** — confirm the ENTIRE app (not just
   one panel) switches live, then take a screenshot pass over all four nav levels in light mode:
   globe, a region page, the AZ canvas, and a server board. Read every screenshot for
   unreadable/low-contrast stragglers (a hex that was never migrated to `var(--color-*)`, or a
   `globe/`-style local-const color that happens to read poorly on the light background) — fix
   any found (route it through the correct `--color-*` token or an appropriately-contrasted
   `CATEGORY_COLORS.*.foreground.light`/`color-mix()` value, matching the R2 carve-out convention
   §N already established for scene-chrome consts). Flip back to dark and confirm it still reads
   correctly there too (a light-mode fix must not regress the dark palette).
8. Stop the stub (`Ctrl-C`) and the dev server.

Confirm ZERO app console errors were logged at any point in the story above.

- [ ] **Step 22: append the `## PHASE 6 COMPLETE` ledger entry**

By the time this task runs, `.superpowers/sdd/progress.md` already has a `## PHASE 6 —
Analysis Rule Engine + LLM Reviewer` header (written when the plan was assembled/dispatched,
mirroring `## PHASE 5 — R3F globe + traffic authoring`'s opening entry, lines 257–263) with one
`Task N: complete (commit ...)` line appended by each of Tasks 1–8 as they land. Task 9 does
**not** rewrite those — it appends its own `Task 9: complete (...)` line, an `=== ALL 9 TASKS
COMPLETE ===` marker, and the closing `## PHASE 6 COMPLETE` section, mirroring
`## PHASE 5 COMPLETE`'s shape (lines 275–296) but for the whole 6-phase rebuild. Fill in the
angle-bracketed placeholders with the real commit hash / test counts / review verdict / smoke
findings at execution time — the surrounding prose (the parked list, the "REBUILD COMPLETE"
framing) is exact wording to carry over, not a placeholder:

```
Task 9: complete (commit <hash>, review <verdict> — <one-line reviewer summary>). CLAUDE.md
rewritten (Project Overview/Architecture/Key Decisions/Design System note/Diagram File
Format/Key Dependencies/Roadmap); docs/module-boundaries.md gained §O (analysis+llm+settings,
boundary rules, D6 restated); 4 Phase-5 carry-forwards closed (MAX_GLOBE_ARCS exported +
ArcsLayer import, nextPopulationLabel shared helper, GlobeScene useLayoutEffect,
buildDrainArcs missing-geo test). Full suite <N>/<N> green, build green, cargo build + cargo
test green.

=== ALL 9 TASKS COMPLETE. Suite <N>/<N> green, build green, cargo build/test green. HEAD <hash>. ===

## PHASE 6 COMPLETE — Analysis Rule Engine + LLM Reviewer (branch phase6-analysis, HEAD <hash>)

Final whole-branch review (<model>) verdict: <VERDICT>. <2-4 sentence summary of what the
reviewer independently verified — mirror Phase 5's COMPLETE-section density: frozen contracts
held, D6 invariants verified end-to-end, ANALYSIS_RULES is one array, no worldEngine/ edit
beyond the sanctioned MAX_GLOBE_ARCS export, etc.>

DONE BAR — all met:
1. Full suite <N>/<N> green; npm run build green (strict tsc + vite); cargo build + cargo test
   green at HEAD <hash>.
2. Final whole-branch review verdict <...>; <fix wave summary if any, else "no fix wave
   required">.
3. CONTROLLER PHASE-GATE LIVE STORY PASSED end-to-end (dev :1420, ZERO app console errors
   throughout): <fill in from Step 21 above — the ≥4-rule world tripped across all three
   families, Analysis tab grouping + chip navigation, Settings-configured stub review with a
   proven two-hit retry, AI cards beside deterministic findings, masked key after reload,
   grep-confirmed absence of the key in the saved .scalemap, and the LIVE light-mode theme
   flip + screenshot pass over globe/region/AZ/server with any straggler hexes fixed>.
4. docs/module-boundaries.md §O documents the analysis+llm+settings modules + boundary rules
   + the restated D6 invariants.
5. contract-drift.md `## PHASE 6` current — expect ZERO entries (no worldEngine/ change beyond
   the one sanctioned MAX_GLOBE_ARCS export, which is a carry-forward closing a Phase-5 backlog
   item, not new engine behavior).

Task commit chain (Phase 6): <branch point> → <plan commit> → <T1 commit> → ... → <T9 commit>.
<N> tests green.

REBUILD COMPLETE: all six phases of the world-model rebuild have shipped — Phase 1 (world
model + navigation shell), Phase 2 (substrate simulation engine), Phase 3 (server interior
board), Phase 4 (region flow page + rack chassis), Phase 5 (R3F globe + traffic authoring),
Phase 6 (analysis rule engine + LLM reviewer + global settings). Parked list (umbrella §9,
intentionally NOT picked up by any phase): k8s/ECS schedulers, ScaleScript v2, Terraform v2,
AI watch-mode (continuous review), spot instances, managed-service pseudo-internals, review
persistence/history, streaming LLM responses, request cancellation. Leave `phase6-analysis`
for the user's own merge decision — this task does not merge to `main`.
```

- [ ] **Step 23: commit**

```bash
git add CLAUDE.md docs/module-boundaries.md \
  src/lib/worldEngine/index.ts src/app/world/globe/ArcsLayer.tsx \
  src/app/world/globe/GlobeScene.tsx src/app/world/panels/TrafficPanel.tsx \
  src/app/world/GlobeView.tsx src/lib/worldEngine/globeArcs.test.ts \
  src/lib/world/populationLabel.ts src/lib/world/populationLabel.test.ts
# NOTE: .superpowers/sdd/ is gitignored — the ledger update is NOT committed (Phase-4 precedent).
git commit -m "docs: CLAUDE.md for the world-model app; module boundaries §O; globe carry-forwards"
```
