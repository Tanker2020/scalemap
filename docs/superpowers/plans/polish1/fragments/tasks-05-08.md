# Polish 1 plan fragment — Tasks 5–8 (examples vault data · vault home screen · stale-replay
# fix · phase gate)

> Fragment scope: Task 5 (`src/lib/vault/exampleWorlds.ts` + tests), Task 6 (HomeScreen vault
> section + `VaultCard`), Task 7 (`resetSession` + scrubber gate), Task 8 (phase smoke,
> light-mode pass, `docs/module-boundaries.md` §P, ledger). Global Constraints / File
> Structure live in the assembled plan header.
>
> **Grounding status:** the four world builders below are NOT designs — they are the exact
> compositions the controller session verified with a scratch `vite-node` run against real
> `compileWorld`/`runAnalysis`/`createWorldEngine` on 2026-07-10. Verified results:
>
> | world | compile findings | analysis findings | engine rps @ 50 steps (seed 1) |
> |---|---|---|---|
> | three-tier | 0 | 0 | 2000.0 |
> | multi-region-failover | 0 | 0 | 1495.3 |
> | event-driven | 0 | 0 | 1000.0 |
> | broken-teaching | 2 (`blocked-path`, `stateful-without-volume`) | **11** — structural 5 / network 4 / capacity 2 | 1999.4 |
>
> **Grounded corrections to the skeleton (controller decisions, verified necessary):**
> 1. **`three-tier` and `event-driven` ship with NO population.** The `no-failover-region`
>    rule (structural.ts:46-67) fires **critical** for ANY population whose compiled region
>    order has exactly one entry — in a single-region world that is every population. The
>    skeleton's "ONE population (NYC)" cannot coexist with its own binding zero-findings
>    contract. Demand comes from `traffic.autoBaseline` (verified: 2000/1000 rps — the
>    engine synthesizes one baseline population per region, demand.ts:24-40).
> 2. **`multi-region-failover`'s third population is São Paulo, not Singapore.** Passive
>    regions are stably partitioned to the END of every population's region order
>    (routing.ts:41-43), while `ocean-crossing-population` (capacity.ts:59-91) compares the
>    FIRST routed region against the nearest region regardless of role — a Singapore
>    population with passive `ap-southeast-1` always fires it. NYC/London/São Paulo keeps
>    the "populations on 3 continents" design intent (design D4) with zero findings
>    (verified: São Paulo's nearest doc region IS its first-routed region, us-east-1).
> 3. **The teaching card's findings pill reads `12 findings`**, not the mockup's decorative
>    `14`: verified 11 analysis findings + 1 unsuppressed compile finding
>    (`stateful-without-volume`; the `blocked-path` compile finding is suppressed by its
>    `blocked-dependency-path` analysis twin per AnalysisTab D4) = 12 in the Analysis tab
>    count.
> 4. The teaching world's front door (web :443) is deliberately REACHABLE — the
>    `entry-unreachable` finding comes from a separate firewalled-shut `admin` blueprint —
>    so the engine smoke and the phase-gate live story still show traffic flowing.

---

## Task 5: Examples vault — data `[sonnet]`

**Files:** create `src/lib/vault/exampleWorlds.ts`, `src/lib/vault/exampleWorlds.test.ts`.

### Step 5.1 — failing tests first: `exampleWorlds.test.ts`

Node env (pure — no jsdom pragma). Same engine harness as `src/lib/worldEngine/index.test.ts`
(seeded `createWorldEngine(1)` + `__test_step`):

```ts
import { describe, it, expect } from 'vitest'
import { VAULT } from './exampleWorlds'
import { compileWorld } from '../world/compileWorld'
import { runAnalysis } from '../analysis/runAnalysis'
import { createWorldEngine } from '../worldEngine'
import type { MetricsBatch } from '../worldEngine/types'

const entry = (id: string) => VAULT.find(e => e.id === id)!

describe('VAULT registry', () => {
  it('has the four entries with unique ids and names', () => {
    expect(VAULT).toHaveLength(4)
    expect(new Set(VAULT.map(e => e.id)).size).toBe(4)
    expect(new Set(VAULT.map(e => e.name)).size).toBe(4)
    expect(VAULT.map(e => e.id)).toEqual(['three-tier', 'multi-region-failover', 'event-driven', 'broken-teaching'])
  })

  it('every build() returns a fresh document', () => {
    for (const e of VAULT) {
      const a = e.build()
      const b = e.build()
      expect(a).not.toBe(b)
      expect(Object.keys(a.servers)).not.toEqual(Object.keys(b.servers)) // fresh ids, no shared refs
    }
  })
})

describe.each([['three-tier'], ['multi-region-failover'], ['event-driven']])('%s (clean world)', (id) => {
  it('compiles with zero compile findings and zero analysis findings', () => {
    const doc = entry(id).build()
    const compiled = compileWorld(doc)
    expect(compiled.findings).toEqual([])
    expect(runAnalysis(doc, compiled, null)).toEqual([])
    expect(compiled.paths.some(p => p.verdict === 'blocked')).toBe(false)
  })
})

describe('broken-teaching (teaching world)', () => {
  it('trips ≥10 analysis findings spanning all three families', () => {
    const doc = entry('broken-teaching').build()
    const compiled = compileWorld(doc)
    const findings = runAnalysis(doc, compiled, null)
    expect(findings.length).toBeGreaterThanOrEqual(10)
    for (const family of ['structural', 'network', 'capacity'] as const) {
      expect(findings.some(f => f.family === family)).toBe(true)
    }
    const ruleIds = new Set(findings.map(f => f.ruleId))
    for (const expected of [
      'single-az-region', 'no-failover-region', 'replicas-colocated', 'deep-sync-chain',
      'unused-managed-service', 'blocked-dependency-path', 'db-port-exposed',
      'entry-unreachable', 'ram-oversubscribed', 'ttl-outlives-detection',
    ]) expect(ruleIds.has(expected), `expected rule ${expected}`).toBe(true)
    expect(compiled.findings.map(f => f.kind).sort()).toEqual(['blocked-path', 'stateful-without-volume'])
  })
})

describe.each(VAULT.map(e => [e.id] as const))('%s engine smoke', (id) => {
  it('seeded engine reaches non-zero world rps in 50 steps', () => {
    const doc = entry(id).build()
    const compiled = compileWorld(doc)
    const engine = createWorldEngine(1)
    const batches: MetricsBatch[] = []
    engine.start(doc, compiled, { onMetrics: b => batches.push(b), onEvent: () => {}, onHealthChange: () => {} })
    engine.__test_step(50)
    engine.stop()
    expect(batches.length).toBeGreaterThan(0)
    expect(batches[batches.length - 1].world.totalRps).toBeGreaterThan(0)
  })
})
```

Run: `npx vitest run src/lib/vault/exampleWorlds.test.ts` → FAILS (module missing).

### Step 5.2 — `exampleWorlds.ts`

The module below is the verified scratch composition reshaped into the `VaultEntry`
contract. Transcribe it faithfully — every port, firewall rule, placement role, and routing
number is load-bearing for the findings contracts above. Names/blurbs/tags are the mockup's
vault cards verbatim (except the findings pill per grounded correction #3).

```ts
// src/lib/vault/exampleWorlds.ts
// The examples vault (Polish 1 D4): four complete WorldDoc builders. Pure data — imports the
// world factories only (module-boundaries §P). Every entry's findings contract is enforced by
// exampleWorlds.test.ts: the three clean worlds compile to ZERO compile+analysis findings; the
// teaching world trips ≥10 analysis findings across all three families. Composition notes:
// - Single-region worlds carry NO population: no-failover-region fires critical for any
//   population whose region order has one entry; autoBaseline supplies their demand.
// - multi-region's third population is São Paulo (not Singapore): passive regions sort to the
//   end of every routing order, so a population nearest the passive region would always trip
//   ocean-crossing-population.
import type { WorldDoc, Server, ServiceBlueprint, FirewallRule } from '../world/types'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
  createPopulation,
} from '../world/factories'
import { getPreset } from '../world/instanceCatalog'

export interface VaultEntry {
  id: 'three-tier' | 'multi-region-failover' | 'event-driven' | 'broken-teaching'
  name: string
  blurb: string
  tags: string[]
  difficulty: 'beginner' | 'intermediate' | 'teaching'
  build: () => WorldDoc
}

// ── doc-building helpers (same idiom as src/lib/analysis/__fixtures__/worlds.ts) ──
function region(doc: WorldDoc, catalogId: string, role: 'active' | 'passive' = 'active') {
  const r = createRegion(catalogId); r.role = role; doc.regions[r.id] = r; return r
}
function az(doc: WorldDoc, regionId: string, label: string) {
  const a = createAz(regionId, label); doc.azs[a.id] = a; return a
}
function server(doc: WorldDoc, azId: string, presetId: string, label: string): Server {
  const s = createServer(azId, getPreset(presetId)!); s.label = label; doc.servers[s.id] = s; return s
}
function blueprint(doc: WorldDoc, name: string, colorIndex: number): ServiceBlueprint {
  const b = createBlueprint(name, colorIndex); doc.blueprints[b.id] = b; return b
}
function place(doc: WorldDoc, blueprintId: string, serverId: string, role: 'primary' | 'replica' = 'primary') {
  const p = createPlacement(blueprintId, serverId); p.role = role; doc.placements[p.id] = p; return p
}
function dep(id: string, target: { kind: 'blueprint'; blueprintId: string } | { kind: 'managed'; managedServiceId: string },
  port: number, protocol: 'http' | 'db' | 'event' | 'stream') {
  return { id, target, port, protocol, packetTemplateId: null }
}
const allowAny = (port: number): FirewallRule =>
  ({ id: `fw-${port}-any`, action: 'allow', port, protocol: 'tcp', source: 'any' })
const denyAny = (port: number): FirewallRule =>
  ({ id: `fw-${port}-deny`, action: 'deny', port, protocol: 'tcp', source: 'any' })

function threeTier(): WorldDoc {
  const doc = createWorld()
  const r = region(doc, 'us-east-1')
  const aza = az(doc, r.id, 'us-east-1a')
  const azb = az(doc, r.id, 'us-east-1b')

  const lb1 = server(doc, aza.id, 'vps-large', 'lb-01')
  const web1 = server(doc, aza.id, 'vps-large', 'web-01')
  const web2 = server(doc, azb.id, 'vps-large', 'web-02')
  const api1 = server(doc, azb.id, 'vps-large', 'api-01')
  const dbP = server(doc, aza.id, 'dedicated-8', 'db-primary')
  const dbR = server(doc, azb.id, 'dedicated-8', 'db-replica')

  lb1.firewall = [allowAny(443), ...lb1.firewall]

  const lb = blueprint(doc, 'lb', 1)
  lb.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
  const web = blueprint(doc, 'web', 0)
  web.ports = [{ port: 8080, protocol: 'tcp', visibility: 'internal' }]
  const api = blueprint(doc, 'api', 2)
  api.ports = [{ port: 8081, protocol: 'tcp', visibility: 'internal' }]
  const db = blueprint(doc, 'db', 3)
  db.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
  db.stateful = true; db.volumeName = 'pgdata'
  lb.dependencies = [dep('d-lb-web', { kind: 'blueprint', blueprintId: web.id }, 8080, 'http')]
  web.dependencies = [dep('d-web-api', { kind: 'blueprint', blueprintId: api.id }, 8081, 'http')]
  api.dependencies = [dep('d-api-db', { kind: 'blueprint', blueprintId: db.id }, 5432, 'db')]

  place(doc, lb.id, lb1.id)
  place(doc, web.id, web1.id)
  place(doc, web.id, web2.id)
  place(doc, api.id, api1.id)
  place(doc, db.id, dbP.id, 'primary')
  place(doc, db.id, dbR.id, 'replica')
  // No populations (grounded correction #1) — autoBaseline (factory default) supplies demand.
  return doc
}

function multiRegion(): WorldDoc {
  const doc = createWorld()
  doc.routing.dnsTtlSec = 20
  doc.routing.healthCheckIntervalMs = 3000
  doc.routing.healthCheckFailureThreshold = 2
  doc.traffic.autoBaseline = false

  const web = blueprint(doc, 'web', 0)
  web.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
  const api = blueprint(doc, 'api', 1)
  api.ports = [{ port: 8080, protocol: 'tcp', visibility: 'internal' }]
  const db = blueprint(doc, 'db', 2)
  db.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
  db.stateful = true; db.volumeName = 'pgdata'
  web.dependencies = [dep('d-web-api', { kind: 'blueprint', blueprintId: api.id }, 8080, 'http')]
  api.dependencies = [dep('d-api-db', { kind: 'blueprint', blueprintId: db.id }, 5432, 'db')]

  for (const catalogId of ['us-east-1', 'eu-west-1']) {
    const r = region(doc, catalogId)
    const aza = az(doc, r.id, `${catalogId}a`)
    const azb = az(doc, r.id, `${catalogId}b`)
    const webS = server(doc, aza.id, 'vps-large', `web-${catalogId}`)
    webS.firewall = [allowAny(443), ...webS.firewall]
    const apiS = server(doc, azb.id, 'vps-large', `api-${catalogId}`)
    const dbP = server(doc, aza.id, 'dedicated-8', `db-primary-${catalogId}`)
    const dbR = server(doc, azb.id, 'dedicated-8', `db-replica-${catalogId}`)
    place(doc, web.id, webS.id)
    place(doc, api.id, apiS.id)
    place(doc, db.id, dbP.id, 'primary')
    place(doc, db.id, dbR.id, 'replica')
  }
  const passive = region(doc, 'ap-southeast-1', 'passive')
  az(doc, passive.id, 'ap-southeast-1a')
  az(doc, passive.id, 'ap-southeast-1b')
  // Warm-standby placeholder: no servers — regions without instances are exempt from
  // single-az-region, and a population near a passive region would trip
  // ocean-crossing-population (grounded correction #2), hence São Paulo below.

  const nyc = createPopulation('NYC', 40.7, -74.0); nyc.peakRps = 400; doc.populations[nyc.id] = nyc
  const lon = createPopulation('London', 51.5, -0.1); lon.peakRps = 400; doc.populations[lon.id] = lon
  const sp = createPopulation('São Paulo', -23.5, -46.6); sp.peakRps = 200; doc.populations[sp.id] = sp
  return doc
}

function eventDriven(): WorldDoc {
  const doc = createWorld()
  const r = region(doc, 'us-east-1')
  const aza = az(doc, r.id, 'us-east-1a')
  const azb = az(doc, r.id, 'us-east-1b')

  const msId = 'ms-queue'
  doc.managedServices[msId] = { id: msId, label: 'Queue', nodeType: 'queue', scope: { kind: 'region', regionId: r.id }, provider: 'aws', port: 443 }

  const api = blueprint(doc, 'api', 0)
  api.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
  const worker = blueprint(doc, 'worker', 1)
  worker.ports = [{ port: 9000, protocol: 'tcp', visibility: 'internal' }]
  const store = blueprint(doc, 'store', 2)
  store.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
  store.stateful = true; store.volumeName = 'eventdata'
  api.dependencies = [dep('d-api-q', { kind: 'managed', managedServiceId: msId }, 443, 'event')]
  worker.dependencies = [
    dep('d-w-q', { kind: 'managed', managedServiceId: msId }, 443, 'event'),
    dep('d-w-store', { kind: 'blueprint', blueprintId: store.id }, 5432, 'db'),
  ]

  const api1 = server(doc, aza.id, 'vps-large', 'api-01')
  api1.firewall = [allowAny(443), ...api1.firewall]
  const api2 = server(doc, azb.id, 'vps-large', 'api-02')
  api2.firewall = [allowAny(443), ...api2.firewall]
  const w1 = server(doc, aza.id, 'vps-large', 'worker-01')
  w1.stacks = [{ name: 'workers', networks: [{ name: 'wnet', cidr: '172.19.0.0/16' }], volumes: [] }]
  const w2 = server(doc, azb.id, 'vps-large', 'worker-02')
  w2.stacks = [{ name: 'workers', networks: [{ name: 'wnet', cidr: '172.19.0.0/16' }], volumes: [] }]
  const st1 = server(doc, aza.id, 'dedicated-8', 'store-01')
  st1.stacks = [{ name: 'data', networks: [{ name: 'datanet', cidr: '172.20.0.0/16' }], volumes: [{ name: 'eventdata', sizeGb: 20 }] }]

  place(doc, api.id, api1.id)
  place(doc, api.id, api2.id)
  const wp1 = place(doc, worker.id, w1.id); wp1.count = 2
  wp1.runtime = { type: 'container', stackName: 'workers', networkNames: ['wnet'], portMappings: [], cpuLimit: null, memLimitMb: null }
  const wp2 = place(doc, worker.id, w2.id); wp2.count = 2
  wp2.runtime = { type: 'container', stackName: 'workers', networkNames: ['wnet'], portMappings: [], cpuLimit: null, memLimitMb: null }
  const sp1 = place(doc, store.id, st1.id)
  // The host port mapping is what keeps worker→store permitted cross-server.
  sp1.runtime = { type: 'container', stackName: 'data', networkNames: ['datanet'], portMappings: [{ host: 5432, container: 5432 }], cpuLimit: null, memLimitMb: null }
  // No populations (grounded correction #1) — autoBaseline supplies demand.
  return doc
}

function brokenTeaching(): WorldDoc {
  const doc = createWorld()
  doc.routing.dnsTtlSec = 5                    // ttl-outlives-detection: 5s TTL vs
  doc.routing.healthCheckIntervalMs = 12000    // 12s × 3 = 36s detection window
  doc.routing.healthCheckFailureThreshold = 3

  const r = region(doc, 'us-east-1')
  const aza = az(doc, r.id, 'us-east-1a')      // ONE AZ — single-az-region

  const webS = server(doc, aza.id, 'vps-medium', 'web-01')
  webS.firewall = [allowAny(443), ...webS.firewall]      // front door stays REACHABLE (correction #4)
  const apiS = server(doc, aza.id, 'vps-medium', 'api-01')
  const dbS = server(doc, aza.id, 'vps-small', 'db-01')
  dbS.firewall = [allowAny(5432), ...dbS.firewall]       // db-port-exposed (a)
  const cacheS = server(doc, aza.id, 'vps-small', 'cache-01')
  cacheS.firewall = [denyAny(6379), ...cacheS.firewall]  // blocked-dependency-path
  const adminS = server(doc, aza.id, 'vps-small', 'admin-01')  // default internal-only → entry-unreachable

  const web = blueprint(doc, 'web', 0)
  web.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
  const api = blueprint(doc, 'api', 1)
  api.ports = [{ port: 8080, protocol: 'tcp', visibility: 'internal' }]
  const auth = blueprint(doc, 'auth', 4)
  auth.ports = [{ port: 8100, protocol: 'tcp', visibility: 'internal' }]
  const profile = blueprint(doc, 'profile', 5)
  profile.ports = [{ port: 8200, protocol: 'tcp', visibility: 'internal' }]
  const db = blueprint(doc, 'db', 2)
  db.ports = [{ port: 5432, protocol: 'tcp', visibility: 'public' }]   // db-port-exposed (b)
  db.stateful = true; db.volumeName = null                             // stateful-without-volume (compile)
  db.workload = { ...db.workload, ramBaseMb: 2400 }                    // 2 × 2400 > 4096 → ram-oversubscribed
  const cache = blueprint(doc, 'cache', 3)
  cache.ports = [{ port: 6379, protocol: 'tcp', visibility: 'internal' }]
  const admin = blueprint(doc, 'admin', 1)
  admin.ports = [{ port: 8443, protocol: 'tcp', visibility: 'public' }]

  web.dependencies = [dep('d-web-api', { kind: 'blueprint', blueprintId: api.id }, 8080, 'http')]
  api.dependencies = [
    dep('d-api-auth', { kind: 'blueprint', blueprintId: auth.id }, 8100, 'http'),
    dep('d-api-db', { kind: 'blueprint', blueprintId: db.id }, 5432, 'db'),
    dep('d-api-cache', { kind: 'blueprint', blueprintId: cache.id }, 6379, 'stream'),
  ]
  auth.dependencies = [dep('d-auth-profile', { kind: 'blueprint', blueprintId: profile.id }, 8200, 'http')]
  profile.dependencies = [dep('d-profile-db', { kind: 'blueprint', blueprintId: db.id }, 5432, 'db')]
  // web→api→auth→profile→db = 4 http/db hops → deep-sync-chain

  place(doc, web.id, webS.id)
  place(doc, api.id, apiS.id)
  place(doc, auth.id, apiS.id)
  place(doc, profile.id, apiS.id)
  place(doc, db.id, dbS.id, 'primary')
  place(doc, db.id, dbS.id, 'replica')   // primary + replica in the same AZ → replicas-colocated
  place(doc, cache.id, cacheS.id)
  place(doc, admin.id, adminS.id)

  doc.managedServices['ms-metrics'] = { id: 'ms-metrics', label: 'Metrics store', nodeType: 'redis', scope: { kind: 'az', azId: aza.id }, provider: 'aws', port: 6380 }
  // nothing depends on it → unused-managed-service

  const pop = createPopulation('customers', 40.7, -74.0)   // 1-region order → no-failover-region
  pop.peakRps = 500
  doc.populations[pop.id] = pop
  return doc
}

export const VAULT: VaultEntry[] = [
  {
    id: 'three-tier',
    name: 'Classic three-tier',
    blurb: 'LB-fronted web + api + replicated db across two AZs. The on-ramp.',
    tags: ['1 region', '6 servers'],
    difficulty: 'beginner',
    build: threeTier,
  },
  {
    id: 'multi-region-failover',
    name: 'Multi-region failover',
    blurb: 'Active/passive across three continents, TTL tuned so killing a region tells the whole DNS-lag story.',
    tags: ['3 regions', 'populations'],
    difficulty: 'intermediate',
    build: multiRegion,
  },
  {
    id: 'event-driven',
    name: 'Event-driven microservices',
    blurb: 'Services publishing through a managed queue to worker pools in compose stacks — networks, volumes, the works.',
    tags: ['1 region', 'queue + workers'],
    difficulty: 'intermediate',
    build: eventDriven,
  },
  {
    id: 'broken-teaching',
    name: 'Everything wrong at once',
    blurb: 'Exposed database, single-AZ SPOF, oversubscribed RAM, TTL slower than detection. Run the analysis, then fix it.',
    tags: ['teaching world', '12 findings'],
    difficulty: 'teaching',
    build: brokenTeaching,
  },
]
```

**Builder reference (verified composition — implement these exactly):**

- `threeTier()`: us-east-1 (active); AZs `us-east-1a`/`us-east-1b`. Servers: `lb-01`
  (vps-large, 1a, firewall `[allowAny(443), ...factory internal rule]`), `web-01`
  (vps-large, 1a), `web-02` (vps-large, 1b), `api-01` (vps-large, 1b), `db-primary`
  (dedicated-8, 1a), `db-replica` (dedicated-8, 1b) — 6 servers, both AZs populated
  (single-az-region needs ≥2 AZs WITH instances). Blueprints: `lb` (public :443 →
  dep http :8080 → web), `web` (:8080 internal → dep http :8081 → api), `api` (:8081
  internal → dep db :5432 → db), `db` (:5432 internal, `stateful: true`,
  `volumeName: 'pgdata'`). Every blueprint's `ports` array must BIND the port its
  dependents call (no-port-binding is checked before the firewall). Placements: lb→lb-01,
  web→web-01, web→web-02, api→api-01, db→db-primary (primary), db→db-replica (**replica**,
  different AZ — replicas-colocated). Routing/traffic: factory defaults (TTL 30s ≥ 10s×3
  detection; autoBaseline true). NO populations.
- `multiRegion()`: routing `{ dnsTtlSec: 20, healthCheckIntervalMs: 3000, healthCheckFailureThreshold: 2 }`
  (TTL 20s comfortably ≥ 6s detection — no hint, real lag drama on a kill);
  `traffic.autoBaseline = false` (populations carry all demand). Shared blueprints web
  (public :443 → api http :8080), api (:8080 → db db :5432), db (:5432, stateful,
  'pgdata'). Per active region (us-east-1, eu-west-1): AZs `<id>a`/`<id>b`; servers
  `web-<id>` (vps-large, a, `allowAny(443)` prepended), `api-<id>` (vps-large, b),
  `db-primary-<id>` (dedicated-8, a, role primary), `db-replica-<id>` (dedicated-8, b,
  role replica). Passive `ap-southeast-1` with AZs `ap-southeast-1a`/`b` and NO servers
  (a warm-standby placeholder; regions without instances are exempt from
  single-az-region). Populations: `NYC` (40.7, −74.0, 400 rps), `London` (51.5, −0.1,
  400 rps), `São Paulo` (−23.5, −46.6, 200 rps), all `diurnal: 'flat'`.
- `eventDriven()`: us-east-1, AZs a/b. Managed service `{ id: 'ms-queue', label: 'Queue',
  nodeType: 'queue', scope: { kind: 'region', regionId }, provider: 'aws', port: 443 }`
  (authored inline — `nodeType: 'queue'` is the CLOUD_REGISTRY key PlacementPanel's
  MANAGED_TYPES uses). Blueprints: `api` (public :443; dep event :443 → queue), `worker`
  (:9000 internal; deps event :443 → queue AND db :5432 → store), `store` (:5432 internal,
  stateful, `volumeName: 'eventdata'`). Servers: `api-01` (vps-large, a, allowAny(443)),
  `api-02` (vps-large, b, allowAny(443)), `worker-01` (vps-large, a, stack
  `workers`/network `wnet@172.19.0.0/16`), `worker-02` (vps-large, b, same stack shape),
  `store-01` (dedicated-8, a, stack `data`/network `datanet@172.20.0.0/16`/volume
  `eventdata@20`). Placements: api on both api servers (process); worker on both worker
  servers, `count: 2`, container runtime `{ stackName: 'workers', networkNames: ['wnet'],
  portMappings: [], cpuLimit: null, memLimitMb: null }`; store on store-01, container
  `{ stackName: 'data', networkNames: ['datanet'], portMappings: [{ host: 5432,
  container: 5432 }], … }` — the host mapping is what keeps worker→store permitted
  cross-server. autoBaseline stays true (demand source). NO populations.
- `brokenTeaching()`: routing `{ dnsTtlSec: 5, healthCheckIntervalMs: 12000,
  healthCheckFailureThreshold: 3 }` (ttl-outlives-detection). us-east-1 with ONE AZ
  (single-az-region). Servers (all 1a): `web-01` (vps-medium, allowAny(443) prepended),
  `api-01` (vps-medium), `db-01` (vps-small, **allowAny(5432)** prepended →
  db-port-exposed (a)), `cache-01` (vps-small, **denyAny(6379)** prepended →
  blocked-dependency-path + blocked-path compile finding), `admin-01` (vps-small,
  factory default internal-only → entry-unreachable). Blueprints: `web` (public :443 →
  api http :8080), `api` (:8080; deps http :8100 → auth, db :5432 → db, stream :6379 →
  cache), `auth` (:8100 → profile http :8200), `profile` (:8200 → db db :5432) — the
  web→api→auth→profile→db chain is 4 http/db hops (deep-sync-chain); `db` (**public**
  :5432 → db-port-exposed (b); `stateful: true`, `volumeName: null` →
  stateful-without-volume compile finding; `workload.ramBaseMb = 2400` so primary+replica
  on the 4096 MB vps-small oversubscribe RAM), `cache` (:6379 internal), `admin`
  (**public :8443**, placed on admin-01, no allow rule → entry-unreachable while web
  stays reachable). Placements: web→web-01; api, auth, profile→api-01; db→db-01 primary
  AND db→db-01 **replica** (replicas-colocated); cache→cache-01; admin→admin-01. Managed
  service `{ id: 'ms-metrics', label: 'Metrics store', nodeType: 'redis', scope:
  { kind: 'az', azId }, provider: 'aws', port: 6380 }` with no dependent
  (unused-managed-service). ONE population `customers` (40.7, −74.0, 500 rps) —
  no-failover-region (critical). Expected: exactly the verified 11 analysis + 2 compile
  findings.

Every builder constructs a brand-new doc per call (factories mint fresh ids) — that is the
"fresh deep copy" contract; no module-level doc singletons.

### Step 5.3 — verify

```
npx vitest run src/lib/vault/exampleWorlds.test.ts
```
Expected: 4 + 3 + 1 + 4 = 12 cases green. Then `npx vitest run && npm run build` green.
Delete nothing else; the controller removes `scratch-verify-polish1.ts` at plan-assembly
commit time.

**Commit:** `feat(vault): four example worlds with enforced findings contracts`

---

## Task 6: Examples vault — home screen `[sonnet]`

**Files:** create `src/app/home/VaultCard.tsx`, `src/app/home/VaultCard.test.tsx`; modify
`src/app/home/HomeScreen.tsx`, `src/app/home/HomeScreen.module.css`,
`src/app/store/ui.store.ts`, `src/app/world/panels/WorldPanel.tsx` (+ its test), create
`src/app/home/HomeScreen.test.tsx`.

### Grounding

- `HomeScreen.tsx` (79 lines, read in full): `openNew()` is the New stance to mirror —
  `newWorld()` + `goGlobe()` + `setFilePath(null)` + `setShowHome(false)`. `newWorld()`
  itself resets dirty=false and createdIso=null (world.store.ts:106-117); `replaceWorld`
  does NOT touch the file store — the vault opener must do those resets explicitly.
- `HomeScreen.module.css` still carries LEGACY vault classes (`.vault`, `.vaultHeader`,
  `.vaultCount`, `.vaultGrid`, `.templateCard`, `.template*` — the deleted canvas app's
  template grid, zero consumers, verified). DELETE that whole block and write the mockup's
  card styles fresh under the same section banner.
- `WorldPanel.tsx` holds a local `type Tab` union and `useState<Tab>('topology')`. The
  one-shot open-on-Analysis mechanism: move the union to `ui.store.ts` as `PanelTab`,
  WorldPanel imports it (view→store type import, correct direction).
- Mockup vault CSS (transcribed): `.vault` grid `repeat(auto-fit, minmax(220px, 1fr))` gap
  12; `.vcard` gradient `165deg #12151D → #0D1015` (→ tokens: `var(--color-node-base)` to
  `var(--color-canvas)`), border `1px solid #232833` (≈ node-border), radius 10, padding
  14; hover border `#3A4150`, `translateY(-2px)`, shadow `0 10px 26px #00000060`;
  reduced-motion kills transform+transition; `.vg` height 64 margin-bottom 10; `.vn`
  12.5px 600; `.vd` muted 10px lh 1.5 margin `3px 0 8px`; `.vm` flex gap 6 9px; `.vpill`
  padding `1px 7px` radius 8 border 1px node-border secondary text. Teaching card border
  tint `#EF444433` → `color-mix(in srgb, var(--color-danger) 20%, transparent)`.
- The four SVG glyphs: transcribe the mockup's `<svg class="vg" viewBox="0 0 200 64">`
  blocks 1:1 into JSX (self-closing tags, `strokeWidth`/`strokeDasharray` camelCase).
  Stroke mapping: `#4A9EFF` → `var(--color-accent)`, `#EF4444` → `var(--color-danger)`,
  `#2A2E38` → `var(--color-node-border)`, `#F59E0B` → `var(--color-warning)`; the teal
  `#2DD4BF` and violet `#A78BFA` strokes stay as two named constants in `VaultCard.tsx`
  (`GLYPH_TEAL`, `GLYPH_VIOLET`) — decorative glyph art, the same stance as the
  globe/board scene hexes (documented inline).

### Step 6.1 — failing tests first

`src/app/home/VaultCard.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { VaultCard } from './VaultCard'
import { VAULT } from '../../lib/vault/exampleWorlds'

describe('VaultCard', () => {
  it('renders glyph, name, blurb, tags, and difficulty pill', () => {
    const entry = VAULT[0]
    const { container } = render(<VaultCard entry={entry} onOpen={() => {}} />)
    expect(container.querySelector('svg')).toBeInTheDocument()
    expect(screen.getByText('Classic three-tier')).toBeInTheDocument()
    expect(screen.getByText(/The on-ramp/)).toBeInTheDocument()
    expect(screen.getByText('1 region')).toBeInTheDocument()
    expect(screen.getByText('beginner')).toBeInTheDocument()
  })
  it('click fires onOpen with the entry', () => {
    const onOpen = vi.fn()
    render(<VaultCard entry={VAULT[3]} onOpen={onOpen} />)
    fireEvent.click(screen.getByText('Everything wrong at once'))
    expect(onOpen).toHaveBeenCalledWith(VAULT[3])
  })
})
```

`src/app/home/HomeScreen.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { HomeScreen } from './HomeScreen'
import { useWorldStore } from '../store/world.store'
import { useFileStore } from '../store/file.store'
import { useNavStore } from '../store/nav.store'
import { useUiStore } from '../store/ui.store'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useFileStore.setState({ showHome: true, filePath: 'old.scalemap', dirty: true, createdIso: 'x' })
  useUiStore.setState({ pendingPanelTab: null })
})

describe('HomeScreen vault', () => {
  it('renders all four cards with difficulty pills', () => {
    render(<HomeScreen />)
    expect(screen.getByText('Start from an example')).toBeInTheDocument()
    expect(screen.getByText('Classic three-tier')).toBeInTheDocument()
    expect(screen.getByText('Multi-region failover')).toBeInTheDocument()
    expect(screen.getByText('Event-driven microservices')).toBeInTheDocument()
    expect(screen.getByText('Everything wrong at once')).toBeInTheDocument()
    expect(screen.getByText('teaching')).toBeInTheDocument()
  })

  it('opening an example loads the world, resets file state, and dismisses home', () => {
    render(<HomeScreen />)
    fireEvent.click(screen.getByText('Classic three-tier'))
    const s = useWorldStore.getState()
    expect(Object.keys(s.doc.servers)).toHaveLength(6)
    expect(s.history).toHaveLength(0)
    const f = useFileStore.getState()
    expect(f.showHome).toBe(false)
    expect(f.filePath).toBeNull()
    expect(f.dirty).toBe(false)
    expect(f.createdIso).toBeNull()
    expect(useNavStore.getState().level).toBe('globe')
    expect(useUiStore.getState().pendingPanelTab).toBeNull()   // only the teaching card queues a tab
  })

  it('the teaching card queues the analysis tab', () => {
    render(<HomeScreen />)
    fireEvent.click(screen.getByText('Everything wrong at once'))
    expect(useUiStore.getState().pendingPanelTab).toBe('analysis')
  })
})
```

Append to `WorldPanel.test.tsx`:

```tsx
it('consumes a pending panel tab once on mount', () => {
  useUiStore.setState({ pendingPanelTab: 'analysis' })
  render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)
  expect(screen.getByText('No findings — the compiled world is clean.')).toBeInTheDocument()
  expect(useUiStore.getState().pendingPanelTab).toBeNull()
})
```

(import `useUiStore` there.) Run → all red where expected.

### Step 6.2 — `ui.store.ts` additive field

```ts
export type PanelTab = 'topology' | 'blueprints' | 'placements' | 'traffic' | 'analysis' | 'events' | 'cost'
```
Add `pendingPanelTab: PanelTab | null` (initial `null`) and
`setPendingPanelTab: (tab: PanelTab | null) => void`. Additive — the themeMode contract is
untouched.

### Step 6.3 — WorldPanel consume-on-mount

Replace the local `type Tab` with `import { useUiStore, type PanelTab } from '../../store/ui.store'`;
`const [tab, setTab] = useState<PanelTab>(() => useUiStore.getState().pendingPanelTab ?? 'topology')`
plus a mount effect that clears it:
`useEffect(() => { if (useUiStore.getState().pendingPanelTab) useUiStore.getState().setPendingPanelTab(null) }, [])`.
(Read in the initializer, clear in an effect — no setState-during-render.)

### Step 6.4 — `VaultCard.tsx` + HomeScreen wiring + CSS

`VaultCard`: a `<button type="button" className={styles.vcard} data-teaching={entry.difficulty === 'teaching' || undefined}>`
rendering glyph / name / blurb / tag pills / difficulty pill. Difficulty pill colors via
tokens: beginner → `var(--color-success-text)` + border
`color-mix(in srgb, var(--color-success) 27%, transparent)`; intermediate →
`var(--color-warning)`; teaching → `var(--color-danger)`. Glyphs: a `GLYPHS: Record<VaultEntry['id'], ReactElement>`
map, transcribed per the grounding note. Card takes `{ entry, onOpen }` and calls
`onOpen(entry)` on click.

HomeScreen: below `.actions`, a vault section:

```tsx
<div className={styles.vaultSection}>
  <div className={styles.vaultHeader}>Start from an example</div>
  <div className={styles.vaultGrid}>
    {VAULT.map(e => <VaultCard key={e.id} entry={e} onOpen={openExample} />)}
  </div>
</div>
```

```tsx
const openExample = (entry: VaultEntry) => {
  useWorldStore.getState().replaceWorld(entry.build())
  useFileStore.getState().setFilePath(null)
  useFileStore.getState().setDirty(false)         // pristine — the New stance; Save will ask for a location
  useFileStore.getState().setCreatedIso(null)
  if (entry.id === 'broken-teaching') useUiStore.getState().setPendingPanelTab('analysis')
  useNavStore.getState().goGlobe()
  setShowHome(false)
}
```

CSS: delete the legacy `.vault…/.template…` block; add `.vaultSection` (width 100%),
`.vaultHeader` (the existing eyebrow-caps recipe: 11px 600, letter-spacing 0.07em,
uppercase, muted, margin-bottom 14), `.vaultGrid`
(`grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px`), `.vcard` per
the transcription (tokens; `text-align: left; font-family: var(--font-mono); cursor:
pointer; transition: border-color 0.15s, transform 0.15s, box-shadow 0.15s`), `.vcard:hover`
(border `var(--color-text-muted)`-mixed, `transform: translateY(-2px)`, shadow),
`.vcard[data-teaching]` danger-tinted border, glyph/name/desc/meta/pill classes, and
`@media (prefers-reduced-motion: reduce) { .vcard { transition: none } .vcard:hover { transform: none } }`.

### Step 6.5 — verify

```
npx vitest run src/app/home src/app/world/panels/WorldPanel.test.tsx
npx vitest run && npm run build
```

### Step 6.6 — live smoke

1. Reload → home shows the four cards under the actions.
2. Open "Everything wrong at once" → lands on globe with the WorldPanel's **Analysis tab
   pre-selected**, count chip ≥ 12, findings grouped by family; title bar shows no file
   path; Save prompts for a location.
3. Fix one finding via the T4 firewall stack (cache-01: remove/reorder the deny :6379) →
   blocked-dependency-path clears from the tab live.
4. New (⌘N) → stays in-shell (existing behavior, home NOT shown); reload → home again →
   open "Classic three-tier" → Simulate → topology rows light up.
5. Dark + light screenshots of the home screen →
   `.superpowers/sdd/screenshots/polish1-t6-home-{dark,light}.png`. Zero console errors.

**Commit:** `feat(vault): start-from-example cards on the home screen`

---

## Task 7: Stale replay after doc swap `[sonnet]`

**Files:** modify `src/app/store/simulation.store.ts`, `src/app/store/world.store.ts`,
`src/app/world/ScrubberV2.tsx`; EXTEND `src/app/store/world.store.test.ts`; CREATE
`src/app/world/ScrubberV2.test.tsx` (verified: no scrubber test file exists).

### Grounding

- The bug: `worldEngine`'s replay ring survives `stop()` (it only resets on the next
  `start()`); `ScrubberV2` fetches frames whenever `running` flips false
  (ScrubberV2.tsx:27-30) and renders whenever `frames.length > 0` — so after New/Open the
  discarded world's frames are offered against a fresh doc.
- `newWorld`/`replaceWorld` currently call `useSimulationStore.getState().stop()`
  (world.store.ts:111/120) and both existing tests assert `running` flips false — those
  assertions must keep passing (resetSession also sets `running: false`).
- `stop()` deliberately KEEPS `latestBatch` (the stop-then-scrub flow) — the new gate uses
  `latestBatch === null` as the "fresh session" signal, which only `resetSession`/`start`
  produce.

### Step 7.1 — failing tests first

Extend `world.store.test.ts`:

```ts
it('newWorld clears batch, events, scrub state, and health overrides', () => {
  useSimulationStore.setState({
    running: true, latestBatch: { simMs: 1 } as never, events: [{ id: 'e' } as never],
    scrubIndex: 3, scrubBatch: { simMs: 1 } as never, degraded: true, healthOverrides: { srv: true },
  })
  useWorldStore.getState().newWorld()
  const s = useSimulationStore.getState()
  expect(s.running).toBe(false)
  expect(s.latestBatch).toBeNull()
  expect(s.events).toEqual([])
  expect(s.scrubIndex).toBeNull()
  expect(s.scrubBatch).toBeNull()
  expect(s.degraded).toBe(false)
  expect(s.healthOverrides).toEqual({})
})

it('replaceWorld likewise clears the sim session', () => {
  useSimulationStore.setState({ latestBatch: { simMs: 1 } as never, scrubIndex: 2, healthOverrides: { x: true } })
  useWorldStore.getState().replaceWorld(useWorldStore.getState().doc)
  const s = useSimulationStore.getState()
  expect(s.latestBatch).toBeNull()
  expect(s.scrubIndex).toBeNull()
  expect(s.healthOverrides).toEqual({})
})
```

New `src/app/world/ScrubberV2.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ScrubberV2 } from './ScrubberV2'
import { useSimulationStore } from '../store/simulation.store'
import type { ReplayFrame, MetricsBatch } from '../../lib/worldEngine/types'

const batch = (simMs: number): MetricsBatch => ({
  simMs, instances: {}, servers: {}, azs: {}, regions: {},
  world: { totalRps: 0, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 },
})
const frames: ReplayFrame[] = [{ simMs: 1000, batch: batch(1000), events: [] }]

beforeEach(() => useSimulationStore.setState({ running: false, latestBatch: null, scrubIndex: null, scrubBatch: null }))

describe('ScrubberV2 session gate', () => {
  it('shown after a normal stop (frames + latestBatch)', () => {
    useSimulationStore.setState({ latestBatch: batch(1000), getReplayFrames: () => frames })
    render(<ScrubberV2 />)
    expect(screen.getByLabelText('replay-scrubber')).toBeInTheDocument()
  })
  it('hidden after a doc swap even when the engine still holds frames', () => {
    useSimulationStore.setState({ latestBatch: null, getReplayFrames: () => frames })
    render(<ScrubberV2 />)
    expect(screen.queryByLabelText('replay-scrubber')).not.toBeInTheDocument()
  })
})
```

Run → the two store cases fail (fields survive), the scrubber hidden case fails (renders).

### Step 7.2 — implement

`simulation.store.ts` — additive action (contracts: additive store fields/actions are
sanctioned; no engine change, it calls the existing facade `stop()`):

```ts
resetSession: () => {
  worldEngine.stop()
  set({
    running: false, latestBatch: null, events: [], scrubIndex: null, scrubBatch: null,
    degraded: false, healthOverrides: {},
  })
},
```
(+ the interface line `resetSession: () => void` with the comment: doc swaps call this
instead of `stop()` — healthOverrides referenced the discarded world's ids.)

`world.store.ts`: in `newWorld` and `replaceWorld`, replace
`useSimulationStore.getState().stop()` with `useSimulationStore.getState().resetSession()`
(keep each site's explanatory comment, extended one line: the session state references the
discarded doc's ids, so the swap clears it wholesale).

`ScrubberV2.tsx`: subscribe `const latestBatch = useSimulationStore(s => s.latestBatch)` and
gate `if (running || frames.length === 0 || latestBatch === null) return null` (comment: a
fresh doc has neither frames nor a batch; engine buffers reset on the next start as they
always did).

### Step 7.3 — verify

```
npx vitest run src/app/store/world.store.test.ts src/app/world/ScrubberV2.test.tsx
npx vitest run && npm run build
```
Expected: 15 + 2 store cases, 2 scrubber cases, full suite green.

**Commit:** `fix(replay): doc swap clears the sim session — no scrubbing a discarded world`

---

## Task 8: Final — phase smoke, light-mode pass, boundaries §P `[sonnet]`

**Files:** `docs/module-boundaries.md` (add §P); fix any Minors queued in the ledger during
T1–T7; no product code beyond those fixes.

### Step 8.1 — full battery

```
npx vitest run          # expected: every suite green
npm run build           # expected: tsc + vite green
```

### Step 8.2 — phase-gate live story (controller-run, port 1420, zero console errors)

The spec's Testing story end-to-end, in one session:
1. Reload → home → open **Everything wrong at once** → Analysis tab pre-selected, ≥12 in
   the count chip, findings grouped structural/network/capacity + Compile.
2. Navigate to cache-01's server view → firewall stack (amber frame, flow captions) →
   remove/reorder the deny :6379 → the blocked-dependency-path finding clears live.
3. Home (reload) → **Classic three-tier** → Simulate → Topology rows show live utilization
   bars + micro-bars; Blueprints tab → drag the cpu slider → derive hint updates live.
4. Stop → New (⌘N) → **no scrubber appears** for the discarded session; controls unlocked.
5. Reload → **Multi-region failover** → Simulate → globe arcs; kill us-east-1 (region
   outage switch) → traffic drains to eu-west-1 after the visible TTL lag (ttl_lag events
   in the Events tab).
6. ⚙ → light theme → walk every restyled surface (Topology, Blueprints, Placements,
   Traffic, Analysis, Events, Cost tabs; Settings modal; server-view rail + firewall
   stack; home screen) — screenshot each dark AND light →
   `.superpowers/sdd/screenshots/polish1-t8-<surface>-{dark,light}.png`.
7. Console: zero errors across the whole story (webgl-context warnings from the globe are
   pre-existing and out of scope ONLY if they already occur on main — verify before
   waving anything through).

### Step 8.3 — `docs/module-boundaries.md` §P

Append a §P documenting: `src/app/world/ui/` (kit + derived — panels import the kit; the
kit imports NOTHING from panels; the two sanctioned glow hexes live in kit.tsx alone;
`derived.ts` shares `reservedRamMb` with `lib/analysis/rules/capacity.ts`),
`src/lib/vault/` (imports world factories/types + instanceCatalog only; consumed by
HomeScreen; findings contracts test-enforced), the `ui.store.pendingPanelTab` one-shot
channel (HomeScreen writes, WorldPanel consumes-and-clears), and
`simulation.store.resetSession` (the ONLY doc-swap reset path; `stop()` remains the
scrub-preserving user stop). Update §-references/file lists the phase touched (panels,
ScrubberV2, HomeScreen). Follow the existing section voice.

### Step 8.4 — ledger

Append to `.superpowers/sdd/progress.md` under `## POLISH 1`: per-task lines (already
written during execution), then the phase summary: what shipped, the four grounded
corrections (fragment headers), open items (expected: cosmetic Minors only), drift state
(expected: NONE — nothing under `src/lib/worldEngine/` changed; verify with
`git diff main..HEAD --stat -- src/lib/worldEngine/` printing empty).

**Commit:** `docs: module boundaries §P — hybrid ui kit and examples vault`
