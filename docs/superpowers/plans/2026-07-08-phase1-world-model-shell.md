# Phase 1: World Model & Navigation Shell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the world data model (world → region → AZ → server → service), the pure `compileWorld()` resolver with golden tests, the `.scalemap` v2 serializer, the 4-level navigation shell with authoring panels, and a static AZ canvas — while deleting the old linter.

**Architecture:** Normalized `WorldDoc` entity maps in a new `world.store.ts` (undo/redo mirrors `canvas.store.ts`'s snapshot pattern). A pure `compileWorld(doc) → CompiledWorld` expands blueprints × placements into service instances, resolves every dependency into permitted/blocked paths (firewall + port + docker-network enforcement), and computes routing tables. Views are thin renderers over the compiled output. Umbrella spec: `docs/superpowers/specs/2026-07-08-world-model-multiscale-simulation-design.md`.

**Tech Stack:** TypeScript, React 19, Zustand 5, @xyflow/react 12, framer-motion, vitest (jsdom), Testing Library.

## Global Constraints

- **Branch:** all work on `world-rebuild` (create at start: `git checkout -b world-rebuild`). Phases 1–2 stay off `main` until sim visuals are back (spec §10).
- **Old UI is unmounted, not deleted** (except the linter, which IS deleted in Task 9). `Toolbar`, `Canvas`, `PropertiesPanel`, `particleEngine`, `canvas.store`, etc. stay in-tree (they must still compile — `npm run build` runs `tsc` over everything) and are removed in later phases as each consumer is rebuilt. Do not import old-UI modules from any new `world/` file.
- **Serializer keeps v1 exports** (`serialize`/`deserialize`) untouched so unmounted legacy files compile; the new app flow only uses the v2 functions. v1 *files* are rejected at load by the v2 parser (spec D2).
- **No new dependencies** in Phase 1 (three.js arrives in Phase 5).
- Theme: use `var(--color-*)` CSS custom properties, never hardcoded hex (except blueprint signature colors, which are data). Font: JetBrains Mono via existing `--font-mono`.
- All animations respect `prefers-reduced-motion` (use framer-motion's `useReducedMotion`).
- Run tests with `npx vitest run <path>`; full build check is `npm run build`.
- Commit after every task (message style: `feat(world): …`, `refactor(world): …`).

---

## File Structure

```
src/lib/world/
  types.ts            # WorldDoc entity types + compiled-output types (Task 1)
  factories.ts        # createWorld/createRegion/…; id generation; signature colors (Task 1)
  regionGeo.ts        # lat/lon per WORLD_REGIONS entry + greatCircleKm (Task 2)
  instanceCatalog.ts  # dedicated/VPS/cloud presets with specs + pricing (Task 3)
  compileWorld.ts     # expansion + orchestration of network/routing (Tasks 4–6)
  network.ts          # pure firewall/port/docker-network path evaluation (Task 5)
  routing.ts          # pure routing-table computation (Task 6)
  layoutAz.ts         # deterministic grid layout for the static AZ canvas (Task 13)
  *.test.ts           # colocated vitest suites
src/app/store/
  world.store.ts      # WorldDoc + undo/redo + CRUD actions (Task 7)
  nav.store.ts        # current level + focus ids (Task 10)
src/lib/serializer.ts # + v2 functions (Task 8)
src/app/world/
  useCompiledWorld.ts # memoized compileWorld hook over world.store (Task 7)
  WorldShell.tsx      # header (breadcrumb + file actions) + level router (Task 10)
  Breadcrumb.tsx      # world › region › az › server (Task 10)
  GlobeView.tsx       # placeholder region-card grid (Task 10)
  RegionView.tsx      # placeholder AZ-card list (Task 10)
  ServerView.tsx      # placeholder server readout (Task 14)
  AzCanvas.tsx        # static React Flow canvas (Task 13)
  WorldServerNode.tsx # server node w/ instance chips (Task 13)
  panels/WorldPanel.tsx      # authoring dock shell (Task 11)
  panels/TopologyPanel.tsx   # region/AZ/server CRUD (Task 11)
  panels/BlueprintPanel.tsx  # blueprint + dependency editing (Task 12)
  panels/PlacementPanel.tsx  # placement editing (Task 12)
DELETED: src/lib/lint/** , src/app/store/diagnostics.store.ts,
         src/app/diagnostics/DiagnosticsPanel.tsx (Task 9)
```

Semantics locked here (all tasks must follow):

- **Same-server traffic never hits the firewall** (loopback). Cross-server traffic evaluates the **target** server's firewall, first-matching-rule-wins in array order, **default deny** when no rule matches. In Phase 1 all in-world traffic counts as `internal`; CIDR sources match internal traffic (documented simplification until the engine exists).
- **Containers on the same server reach each other only via a shared compose network** (then the *container* port must be in the blueprint's `ports`). Without a shared network they may still connect through a **host port mapping** (`portMappings.container === dep.port`); if neither, the path is blocked with `network-isolation`.
- **Cross-server container targets** require a host `portMapping` for the dependency port; the *host* port is what the firewall evaluates.
- **Managed-service targets are always permitted** (provider side); hop class comes from scope (same AZ → `same-az`, same region → `cross-az`, else `cross-region`).
- **Paths are emitted per (from-instance, to-instance) pair** across all instances of the target blueprint. Worlds are small in Phase 1; the engine dedupes at runtime in Phase 2.
- Passive regions always sort to the **end** of every population's region order.

---

### Task 1: World types + factories

**Files:**
- Create: `src/lib/world/types.ts`
- Create: `src/lib/world/factories.ts`
- Test: `src/lib/world/factories.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces: every type below (later tasks import from `./types`), plus
  `createWorld(): WorldDoc`, `createRegion(catalogId: string): Region`,
  `createAz(regionId: string, label: string): AvailabilityZone`,
  `createServer(azId: string, preset: InstancePresetLike): Server`,
  `createBlueprint(name: string, colorIndex: number): ServiceBlueprint`,
  `createPlacement(blueprintId: string, serverId: string): Placement`,
  `nextWorldId(prefix: string): string`, `BLUEPRINT_COLORS: string[]`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/world/factories.test.ts
import { describe, it, expect } from 'vitest'
import { createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement, BLUEPRINT_COLORS } from './factories'

describe('world factories', () => {
  it('creates an empty world with sane routing defaults', () => {
    const w = createWorld()
    expect(w.routing.policy).toBe('latency')
    expect(w.routing.healthCheckIntervalMs).toBe(10_000)
    expect(w.routing.dnsTtlSec).toBe(30)
    expect(Object.keys(w.regions)).toHaveLength(0)
    expect(w.traffic.autoBaseline).toBe(true)
  })

  it('creates linked region → az → server with default-internal firewall', () => {
    const region = createRegion('us-east-1')
    const az = createAz(region.id, 'us-east-1a')
    const server = createServer(az.id, {
      id: 'vps-medium', kind: 'vps',
      specs: { vcpu: 4, threadsPerCore: 2, ramMb: 8192, diskGb: 80, nicMbps: 1000 },
      hourlyUsd: 0.04, oversubscriptionRatio: 4, burstable: true,
    })
    expect(az.regionId).toBe(region.id)
    expect(server.azId).toBe(az.id)
    expect(server.kind).toBe('vps')
    expect(server.oversubscriptionRatio).toBe(4)
    expect(server.firewall).toHaveLength(1)
    expect(server.firewall[0]).toMatchObject({ action: 'allow', port: 'any', source: 'internal' })
  })

  it('assigns cycling signature colors to blueprints', () => {
    const a = createBlueprint('api', 0)
    const b = createBlueprint('db', 1)
    expect(a.color).toBe(BLUEPRINT_COLORS[0])
    expect(b.color).toBe(BLUEPRINT_COLORS[1])
    expect(createBlueprint('x', BLUEPRINT_COLORS.length).color).toBe(BLUEPRINT_COLORS[0])
  })

  it('creates placements defaulting to a single process instance', () => {
    const p = createPlacement('bp-1', 'srv-1')
    expect(p).toMatchObject({ blueprintId: 'bp-1', serverId: 'srv-1', count: 1, role: 'primary', runtime: { type: 'process' } })
  })

  it('generates unique ids', () => {
    const ids = new Set([createRegion('us-east-1').id, createRegion('us-east-1').id, createRegion('us-east-1').id])
    expect(ids.size).toBe(3)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/world/factories.test.ts`
Expected: FAIL — `Cannot find module './factories'`

- [ ] **Step 3: Write the types**

```ts
// src/lib/world/types.ts
// World document entities (normalized, id-keyed) + compiled output types.
// Spec: docs/superpowers/specs/2026-07-08-world-model-multiscale-simulation-design.md §3

export type RegionId = string
export type AzId = string
export type ServerId = string
export type BlueprintId = string
export type PlacementId = string
export type ManagedServiceId = string
export type PopulationId = string
export type InstanceId = string

export type RoutingPolicyKind = 'latency' | 'geo' | 'weighted' | 'priority'

export interface RoutingConfig {
  policy: RoutingPolicyKind
  weights: Record<RegionId, number>   // policy === 'weighted'
  priorityOrder: RegionId[]           // policy === 'priority'
  healthCheckIntervalMs: number
  healthCheckFailureThreshold: number
  dnsTtlSec: number
}

export interface TrafficConfig {
  autoBaseline: boolean
  baselineTotalRps: number
}

export type DiurnalPattern = 'flat' | 'day-night'

export interface ClientPopulation {
  id: PopulationId
  label: string
  lat: number
  lon: number
  peakRps: number
  diurnal: DiurnalPattern
}

export type RegionRole = 'active' | 'passive'

export interface Region {
  id: RegionId
  catalogId: string   // WORLD_REGIONS id, e.g. 'us-east-1'
  role: RegionRole
}

export interface AvailabilityZone {
  id: AzId
  label: string       // e.g. 'us-east-1a'
  regionId: RegionId
}

export interface ServerSpecs {
  vcpu: number
  threadsPerCore: number
  ramMb: number
  diskGb: number
  nicMbps: number
}

export type FirewallSource = 'any' | 'internal' | string  // string = CIDR, e.g. '10.0.0.0/8'
export type FirewallProtocol = 'tcp' | 'udp' | 'any'

export interface FirewallRule {
  id: string
  action: 'allow' | 'deny'
  port: number | 'any'
  protocol: FirewallProtocol
  source: FirewallSource
}

export interface ComposeNetwork { name: string; cidr: string }
export interface ComposeVolume { name: string; sizeGb: number }

export interface ComposeStack {
  name: string
  networks: ComposeNetwork[]
  volumes: ComposeVolume[]
}

export type ServerKind = 'dedicated' | 'vps'

export interface RackPosition { rackId: string; unit: number; heightU: number }

export interface Server {
  id: ServerId
  label: string
  azId: AzId
  kind: ServerKind
  catalogId: string | null            // instanceCatalog preset id; null = custom specs
  specs: ServerSpecs
  hourlyUsd: number
  oversubscriptionRatio: number | null // vps only
  burstable: boolean                   // vps only
  firewall: FirewallRule[]             // evaluated in array order, first match wins, default deny
  stacks: ComposeStack[]
  rack: RackPosition
}

export interface ServicePort {
  port: number
  protocol: 'tcp' | 'udp'
  visibility: 'public' | 'internal'
}

export interface WorkloadProfile {
  cpuMsPerRequest: number
  ramBaseMb: number
  ramPerConnMb: number
  diskIoPerRequest: number
}

export type DependencyTarget =
  | { kind: 'blueprint'; blueprintId: BlueprintId }
  | { kind: 'managed'; managedServiceId: ManagedServiceId }

export interface BlueprintDependency {
  id: string
  target: DependencyTarget
  port: number
  protocol: 'http' | 'db' | 'event' | 'stream'
  packetTemplateId: number | null
}

export interface ServiceBlueprint {
  id: BlueprintId
  name: string
  color: string   // signature color (hex) — binds chip/RAM stratum/core share across views
  workload: WorkloadProfile
  ports: ServicePort[]
  dependencies: BlueprintDependency[]
  stateful: boolean
  volumeName: string | null   // required when stateful
}

export type PlacementRole = 'primary' | 'replica' | 'canary'

export interface PortMapping { host: number; container: number }

export type PlacementRuntime =
  | { type: 'process' }
  | {
      type: 'container'
      stackName: string
      networkNames: string[]
      portMappings: PortMapping[]
      cpuLimit: number | null
      memLimitMb: number | null
    }

export interface Placement {
  id: PlacementId
  blueprintId: BlueprintId
  serverId: ServerId
  count: number
  role: PlacementRole
  runtime: PlacementRuntime
}

export type ManagedScope =
  | { kind: 'region'; regionId: RegionId }
  | { kind: 'az'; azId: AzId }

export interface ManagedService {
  id: ManagedServiceId
  label: string
  nodeType: string   // existing NodeType from src/lib/nodeConfig.ts, e.g. 'rds', 's3', 'sqs'
  scope: ManagedScope
  provider: 'generic' | 'aws' | 'gcp' | 'azure'
  port: number       // endpoint port, participates in path semantics
}

export interface WorldDoc {
  routing: RoutingConfig
  traffic: TrafficConfig
  populations: Record<PopulationId, ClientPopulation>
  regions: Record<RegionId, Region>
  azs: Record<AzId, AvailabilityZone>
  servers: Record<ServerId, Server>
  blueprints: Record<BlueprintId, ServiceBlueprint>
  placements: Record<PlacementId, Placement>
  managedServices: Record<ManagedServiceId, ManagedService>
}

// ─── Compiled output (produced by compileWorld, consumed by views/engine) ────

export type HopClass = 'localhost' | 'same-az' | 'cross-az' | 'cross-region'

export interface ServiceInstance {
  id: InstanceId            // `${placementId}#${index}`
  blueprintId: BlueprintId
  placementId: PlacementId
  serverId: ServerId
  azId: AzId
  regionId: RegionId
  role: PlacementRole
  indexInPlacement: number
}

export type BlockReasonKind = 'no-port-binding' | 'firewall-deny' | 'network-isolation'

export interface BlockReason {
  kind: BlockReasonKind
  detail: string
  firewallRuleId: string | null
}

export type PathTarget =
  | { kind: 'instance'; instanceId: InstanceId }
  | { kind: 'managed'; managedServiceId: ManagedServiceId }

export interface CompiledPath {
  id: string
  dependencyId: string
  fromInstanceId: InstanceId
  to: PathTarget
  hopClass: HopClass
  verdict: 'permitted' | 'blocked'
  blockReason: BlockReason | null
}

export interface CompiledRouting {
  populationRegionOrder: Record<PopulationId, RegionId[]>
  regionAzSpread: Record<RegionId, AzId[]>
  azBlueprintTargets: Record<AzId, Record<BlueprintId, InstanceId[]>>
}

export interface CompileFinding {
  id: string
  severity: 'error' | 'warning'
  kind: 'blocked-path' | 'stateful-without-volume' | 'missing-volume'
  message: string
  affected: string[]   // entity ids (instance/server/blueprint/placement ids)
}

export interface CompiledWorld {
  instances: Record<InstanceId, ServiceInstance>
  paths: CompiledPath[]
  routing: CompiledRouting
  findings: CompileFinding[]
}
```

- [ ] **Step 4: Write the factories**

```ts
// src/lib/world/factories.ts
import type {
  WorldDoc, Region, AvailabilityZone, Server, ServiceBlueprint, Placement,
  ServerKind, ServerSpecs, ClientPopulation,
} from './types'

let worldCounter = 0
export function nextWorldId(prefix: string): string {
  return `${prefix}-${++worldCounter}-${Date.now().toString(36)}`
}

// Signature colors: teal, blue, purple, amber, pink, green (dark-canvas calibrated).
export const BLUEPRINT_COLORS = ['#2DD4BF', '#4A9EFF', '#A78BFA', '#F5A623', '#F472B6', '#22C55E']

export function createWorld(): WorldDoc {
  return {
    routing: {
      policy: 'latency',
      weights: {},
      priorityOrder: [],
      healthCheckIntervalMs: 10_000,
      healthCheckFailureThreshold: 3,
      dnsTtlSec: 30,
    },
    traffic: { autoBaseline: true, baselineTotalRps: 1000 },
    populations: {},
    regions: {},
    azs: {},
    servers: {},
    blueprints: {},
    placements: {},
    managedServices: {},
  }
}

export function createRegion(catalogId: string): Region {
  return { id: nextWorldId('region'), catalogId, role: 'active' }
}

export function createAz(regionId: string, label: string): AvailabilityZone {
  return { id: nextWorldId('az'), label, regionId }
}

// Anything with the preset's shape works (the full InstancePreset from Task 3 satisfies this).
export interface InstancePresetLike {
  id: string
  kind: ServerKind
  specs: ServerSpecs
  hourlyUsd: number
  oversubscriptionRatio: number | null
  burstable: boolean
}

export function createServer(azId: string, preset: InstancePresetLike): Server {
  return {
    id: nextWorldId('srv'),
    label: 'server',
    azId,
    kind: preset.kind,
    catalogId: preset.id,
    specs: { ...preset.specs },
    hourlyUsd: preset.hourlyUsd,
    oversubscriptionRatio: preset.oversubscriptionRatio,
    burstable: preset.burstable,
    // Default: allow all in-world traffic; internet exposure must be opted into explicitly.
    firewall: [{ id: nextWorldId('fw'), action: 'allow', port: 'any', protocol: 'any', source: 'internal' }],
    stacks: [],
    rack: { rackId: 'rack-1', unit: 1, heightU: preset.kind === 'dedicated' ? 2 : 1 },
  }
}

export function createBlueprint(name: string, colorIndex: number): ServiceBlueprint {
  return {
    id: nextWorldId('bp'),
    name,
    color: BLUEPRINT_COLORS[colorIndex % BLUEPRINT_COLORS.length],
    workload: { cpuMsPerRequest: 5, ramBaseMb: 128, ramPerConnMb: 0.5, diskIoPerRequest: 0 },
    ports: [{ port: 8080, protocol: 'tcp', visibility: 'internal' }],
    dependencies: [],
    stateful: false,
    volumeName: null,
  }
}

export function createPlacement(blueprintId: string, serverId: string): Placement {
  return {
    id: nextWorldId('pl'),
    blueprintId,
    serverId,
    count: 1,
    role: 'primary',
    runtime: { type: 'process' },
  }
}

export function createPopulation(label: string, lat: number, lon: number): ClientPopulation {
  return { id: nextWorldId('pop'), label, lat, lon, peakRps: 500, diurnal: 'flat' }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/world/factories.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add src/lib/world/types.ts src/lib/world/factories.ts src/lib/world/factories.test.ts
git commit -m "feat(world): add world document types and entity factories"
```

### Task 2: Region geo catalog + great-circle distance

**Files:**
- Create: `src/lib/world/regionGeo.ts`
- Test: `src/lib/world/regionGeo.test.ts`

**Interfaces:**
- Consumes: `WORLD_REGIONS` from `src/lib/regionConfig.ts` (existing, untouched).
- Produces: `REGION_GEO: Record<string, { lat: number; lon: number }>` (keyed by
  `WORLD_REGIONS` catalog ids), `greatCircleKm(lat1, lon1, lat2, lon2): number`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/world/regionGeo.test.ts
import { describe, it, expect } from 'vitest'
import { WORLD_REGIONS } from '../regionConfig'
import { REGION_GEO, greatCircleKm } from './regionGeo'

describe('regionGeo', () => {
  it('has coordinates for every catalog region', () => {
    for (const r of WORLD_REGIONS) {
      expect(REGION_GEO[r.id], `missing geo for ${r.id}`).toBeDefined()
      expect(Math.abs(REGION_GEO[r.id].lat)).toBeLessThanOrEqual(90)
      expect(Math.abs(REGION_GEO[r.id].lon)).toBeLessThanOrEqual(180)
    }
  })

  it('computes plausible great-circle distances', () => {
    // Virginia → Oregon is ~3,700 km; allow generous tolerance.
    const va = REGION_GEO['us-east-1']
    const or = REGION_GEO['us-west-2']
    const d = greatCircleKm(va.lat, va.lon, or.lat, or.lon)
    expect(d).toBeGreaterThan(3000)
    expect(d).toBeLessThan(4500)
    expect(greatCircleKm(va.lat, va.lon, va.lat, va.lon)).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/world/regionGeo.test.ts`
Expected: FAIL — `Cannot find module './regionGeo'`

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/world/regionGeo.ts
// Approximate datacenter-metro coordinates for each WORLD_REGIONS entry (globe pins, Phase 5)
// and client→region distance ordering (routing tables, Task 6).

export const REGION_GEO: Record<string, { lat: number; lon: number }> = {
  'us-east-1':      { lat: 38.9,  lon: -77.5 },   // N. Virginia
  'us-east-2':      { lat: 40.0,  lon: -83.0 },   // Ohio
  'us-west-1':      { lat: 37.4,  lon: -121.9 },  // N. California
  'us-west-2':      { lat: 45.8,  lon: -119.7 },  // Oregon
  'ca-central-1':   { lat: 45.5,  lon: -73.6 },   // Montreal
  'sa-east-1':      { lat: -23.5, lon: -46.6 },   // São Paulo
  'eu-west-1':      { lat: 53.3,  lon: -6.3 },    // Ireland
  'eu-west-2':      { lat: 51.5,  lon: -0.1 },    // London
  'eu-west-3':      { lat: 48.9,  lon: 2.4 },     // Paris
  'eu-central-1':   { lat: 50.1,  lon: 8.7 },     // Frankfurt
  'eu-south-1':     { lat: 45.5,  lon: 9.2 },     // Milan
  'eu-north-1':     { lat: 59.3,  lon: 18.1 },    // Stockholm
  'me-south-1':     { lat: 26.1,  lon: 50.6 },    // Bahrain
  'af-south-1':     { lat: -33.9, lon: 18.4 },    // Cape Town
  'ap-south-1':     { lat: 19.1,  lon: 72.9 },    // Mumbai
  'ap-southeast-1': { lat: 1.35,  lon: 103.8 },   // Singapore
  'ap-southeast-2': { lat: -33.9, lon: 151.2 },   // Sydney
  'ap-northeast-1': { lat: 35.7,  lon: 139.7 },   // Tokyo
  'ap-northeast-2': { lat: 37.6,  lon: 127.0 },   // Seoul
  'ap-northeast-3': { lat: 34.7,  lon: 135.5 },   // Osaka
  'ap-east-1':      { lat: 22.3,  lon: 114.2 },   // Hong Kong
}

const EARTH_RADIUS_KM = 6371

export function greatCircleKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a))
}
```

Note: `regionConfig.ts`'s catalog currently lists 22 regions but one (`eu-south-1` vs the
count in older docs) — the test iterates `WORLD_REGIONS` itself, so if the catalog and this
map ever drift, the test names the missing id. If the test fails listing an id not in the
map above, add that id with its metro coordinates rather than editing the test.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/world/regionGeo.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/world/regionGeo.ts src/lib/world/regionGeo.test.ts
git commit -m "feat(world): add region geo coordinates and great-circle distance"
```

---

### Task 3: Instance catalog

**Files:**
- Create: `src/lib/world/instanceCatalog.ts`
- Test: `src/lib/world/instanceCatalog.test.ts`

**Interfaces:**
- Consumes: `ServerKind`, `ServerSpecs` from `./types`.
- Produces: `InstancePreset` (interface), `INSTANCE_CATALOG: InstancePreset[]`,
  `getPreset(id: string): InstancePreset | undefined`. `InstancePreset` structurally
  satisfies Task 1's `InstancePresetLike`, so presets feed `createServer` directly.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/world/instanceCatalog.test.ts
import { describe, it, expect } from 'vitest'
import { INSTANCE_CATALOG, getPreset } from './instanceCatalog'

describe('instance catalog', () => {
  it('has unique ids and positive specs/pricing', () => {
    const ids = new Set(INSTANCE_CATALOG.map(p => p.id))
    expect(ids.size).toBe(INSTANCE_CATALOG.length)
    for (const p of INSTANCE_CATALOG) {
      expect(p.specs.vcpu).toBeGreaterThan(0)
      expect(p.specs.ramMb).toBeGreaterThan(0)
      expect(p.specs.diskGb).toBeGreaterThan(0)
      expect(p.specs.nicMbps).toBeGreaterThan(0)
      expect(p.hourlyUsd).toBeGreaterThan(0)
    }
  })

  it('vps presets carry oversubscription, dedicated never do', () => {
    for (const p of INSTANCE_CATALOG) {
      if (p.kind === 'dedicated') {
        expect(p.oversubscriptionRatio).toBeNull()
        expect(p.burstable).toBe(false)
      } else {
        expect(p.oversubscriptionRatio).toBeGreaterThan(1)
      }
    }
  })

  it('contains both kinds and resolves by id', () => {
    expect(INSTANCE_CATALOG.some(p => p.kind === 'vps')).toBe(true)
    expect(INSTANCE_CATALOG.some(p => p.kind === 'dedicated')).toBe(true)
    expect(getPreset('vps-medium')?.specs.vcpu).toBe(4)
    expect(getPreset('nope')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/world/instanceCatalog.test.ts`
Expected: FAIL — `Cannot find module './instanceCatalog'`

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/world/instanceCatalog.ts
import type { ServerKind, ServerSpecs } from './types'

export interface InstancePreset {
  id: string
  label: string
  kind: ServerKind
  specs: ServerSpecs
  hourlyUsd: number
  oversubscriptionRatio: number | null  // vps only
  burstable: boolean                    // vps only (t3-style credits, engine models in Phase 2)
}

// Pricing is indicative-realistic (2026 commodity market), not provider-quoted; the cloud
// presets approximate their namesakes so the cost model (Phase 2) lands in the right decade.
export const INSTANCE_CATALOG: InstancePreset[] = [
  { id: 'vps-small',    label: 'VPS Small (2 vCPU / 4 GB)',    kind: 'vps', specs: { vcpu: 2,  threadsPerCore: 1, ramMb: 4096,   diskGb: 40,  nicMbps: 500 },   hourlyUsd: 0.018, oversubscriptionRatio: 6, burstable: true },
  { id: 'vps-medium',   label: 'VPS Medium (4 vCPU / 8 GB)',   kind: 'vps', specs: { vcpu: 4,  threadsPerCore: 1, ramMb: 8192,   diskGb: 80,  nicMbps: 1000 },  hourlyUsd: 0.036, oversubscriptionRatio: 4, burstable: true },
  { id: 'vps-large',    label: 'VPS Large (8 vCPU / 16 GB)',   kind: 'vps', specs: { vcpu: 8,  threadsPerCore: 1, ramMb: 16384,  diskGb: 160, nicMbps: 2000 },  hourlyUsd: 0.071, oversubscriptionRatio: 3, burstable: false },
  { id: 'aws-t3-medium',  label: 'AWS t3.medium (2 vCPU / 4 GB)',   kind: 'vps', specs: { vcpu: 2, threadsPerCore: 2, ramMb: 4096,  diskGb: 60,  nicMbps: 1000 }, hourlyUsd: 0.0416, oversubscriptionRatio: 4, burstable: true },
  { id: 'aws-m7i-large', label: 'AWS m7i.large (2 vCPU / 8 GB)',   kind: 'vps', specs: { vcpu: 2, threadsPerCore: 2, ramMb: 8192,  diskGb: 100, nicMbps: 2500 }, hourlyUsd: 0.1008, oversubscriptionRatio: 2, burstable: false },
  { id: 'gcp-e2-standard-4', label: 'GCP e2-standard-4 (4 vCPU / 16 GB)', kind: 'vps', specs: { vcpu: 4, threadsPerCore: 2, ramMb: 16384, diskGb: 100, nicMbps: 2000 }, hourlyUsd: 0.134, oversubscriptionRatio: 3, burstable: false },
  { id: 'dedicated-8',  label: 'Dedicated 8-core / 32 GB',  kind: 'dedicated', specs: { vcpu: 8,  threadsPerCore: 2, ramMb: 32768,  diskGb: 500,  nicMbps: 10000 }, hourlyUsd: 0.34, oversubscriptionRatio: null, burstable: false },
  { id: 'dedicated-16', label: 'Dedicated 16-core / 64 GB', kind: 'dedicated', specs: { vcpu: 16, threadsPerCore: 2, ramMb: 65536,  diskGb: 1000, nicMbps: 10000 }, hourlyUsd: 0.67, oversubscriptionRatio: null, burstable: false },
  { id: 'dedicated-32', label: 'Dedicated 32-core / 128 GB', kind: 'dedicated', specs: { vcpu: 32, threadsPerCore: 2, ramMb: 131072, diskGb: 2000, nicMbps: 25000 }, hourlyUsd: 1.32, oversubscriptionRatio: null, burstable: false },
]

export function getPreset(id: string): InstancePreset | undefined {
  return INSTANCE_CATALOG.find(p => p.id === id)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/world/instanceCatalog.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/world/instanceCatalog.ts src/lib/world/instanceCatalog.test.ts
git commit -m "feat(world): add server instance catalog with dedicated/vps/cloud presets"
```

---

### Task 4: compileWorld — instance expansion

**Files:**
- Create: `src/lib/world/compileWorld.ts`
- Test: `src/lib/world/compileWorld.test.ts`

**Interfaces:**
- Consumes: all types from `./types`; factories from `./factories` (tests only).
- Produces: `compileWorld(doc: WorldDoc): CompiledWorld` and
  `instanceId(placementId: string, index: number): string`. In this task `paths`,
  `findings`, and `routing` are returned **empty** (`routing` as
  `{ populationRegionOrder: {}, regionAzSpread: {}, azBlueprintTargets: {} }`); Tasks 5–6
  fill them by calling into `network.ts`/`routing.ts` from this same function.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/world/compileWorld.test.ts
import { describe, it, expect } from 'vitest'
import { createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement } from './factories'
import { getPreset } from './instanceCatalog'
import { compileWorld, instanceId } from './compileWorld'
import type { WorldDoc } from './types'

// Shared fixture builder: 1 region, 1 AZ, 1 server, 1 blueprint. Tests mutate from here.
export function tinyWorld() {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const az = createAz(region.id, 'us-east-1a')
  const server = createServer(az.id, getPreset('vps-medium')!)
  const bp = createBlueprint('api', 1)
  doc.regions[region.id] = region
  doc.azs[az.id] = az
  doc.servers[server.id] = server
  doc.blueprints[bp.id] = bp
  return { doc, region, az, server, bp }
}

describe('compileWorld — instance expansion', () => {
  it('expands a placement of count N into N instances with full lineage', () => {
    const { doc, region, az, server, bp } = tinyWorld()
    const pl = createPlacement(bp.id, server.id)
    pl.count = 3
    pl.role = 'replica'
    doc.placements[pl.id] = pl

    const compiled = compileWorld(doc)
    const ids = Object.keys(compiled.instances)
    expect(ids).toHaveLength(3)
    expect(ids).toContain(instanceId(pl.id, 0))
    const inst = compiled.instances[instanceId(pl.id, 1)]
    expect(inst).toMatchObject({
      blueprintId: bp.id, placementId: pl.id, serverId: server.id,
      azId: az.id, regionId: region.id, role: 'replica', indexInPlacement: 1,
    })
  })

  it('skips placements whose blueprint or server no longer exists (dangling refs)', () => {
    const { doc, server, bp } = tinyWorld()
    const good = createPlacement(bp.id, server.id)
    const noBp = createPlacement('bp-gone', server.id)
    const noSrv = createPlacement(bp.id, 'srv-gone')
    doc.placements[good.id] = good
    doc.placements[noBp.id] = noBp
    doc.placements[noSrv.id] = noSrv

    const compiled = compileWorld(doc)
    expect(Object.keys(compiled.instances)).toHaveLength(1)
  })

  it('returns empty collections for an empty world', () => {
    const compiled = compileWorld(createWorld())
    expect(compiled.instances).toEqual({})
    expect(compiled.paths).toEqual([])
    expect(compiled.findings).toEqual([])
  })

  it('is pure: same input object → deep-equal output, input untouched', () => {
    const { doc, server, bp } = tinyWorld()
    doc.placements['p1'] = { ...createPlacement(bp.id, server.id), id: 'p1' }
    const snapshot = JSON.parse(JSON.stringify(doc)) as WorldDoc
    const a = compileWorld(doc)
    const b = compileWorld(doc)
    expect(a).toEqual(b)
    expect(doc).toEqual(snapshot)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/world/compileWorld.test.ts`
Expected: FAIL — `Cannot find module './compileWorld'`

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/world/compileWorld.ts
// Pure resolver: WorldDoc → CompiledWorld. The single gate between authored data and
// everything that renders or simulates. No store access, no side effects, no randomness.
import type {
  WorldDoc, CompiledWorld, ServiceInstance, InstanceId,
} from './types'

export function instanceId(placementId: string, index: number): InstanceId {
  return `${placementId}#${index}`
}

export function compileWorld(doc: WorldDoc): CompiledWorld {
  const instances: Record<InstanceId, ServiceInstance> = {}

  for (const pl of Object.values(doc.placements)) {
    const bp = doc.blueprints[pl.blueprintId]
    const server = doc.servers[pl.serverId]
    if (!bp || !server) continue                    // dangling placement — authoring UI prevents, files may not
    const az = doc.azs[server.azId]
    if (!az) continue
    const region = doc.regions[az.regionId]
    if (!region) continue

    for (let i = 0; i < pl.count; i++) {
      const id = instanceId(pl.id, i)
      instances[id] = {
        id,
        blueprintId: bp.id,
        placementId: pl.id,
        serverId: server.id,
        azId: az.id,
        regionId: region.id,
        role: pl.role,
        indexInPlacement: i,
      }
    }
  }

  return {
    instances,
    paths: [],       // Task 5
    findings: [],    // Tasks 5–6
    routing: { populationRegionOrder: {}, regionAzSpread: {}, azBlueprintTargets: {} }, // Task 6
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/world/compileWorld.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/world/compileWorld.ts src/lib/world/compileWorld.test.ts
git commit -m "feat(world): add compileWorld instance expansion"
```

### Task 5: compileWorld — network path evaluation (firewall / ports / docker networks)

**Files:**
- Create: `src/lib/world/network.ts`
- Modify: `src/lib/world/compileWorld.ts` (emit `paths` + blocked-path `findings`)
- Test: `src/lib/world/network.test.ts`

**Interfaces:**
- Consumes: Task 1 types; Task 4's `instances` map and `instanceId`.
- Produces:
  - `evaluateFirewall(rules: FirewallRule[], port: number): { allowed: boolean; matchedRuleId: string | null }`
  - `hopClassBetween(fromServer: Server, toServer: Server, azs: Record<string, AvailabilityZone>): HopClass`
  - `evaluateInstancePath(ctx: InstancePathContext): PathEvaluation` where
    `InstancePathContext = { fromServer: Server; toServer: Server; fromRuntime: PlacementRuntime; toRuntime: PlacementRuntime; toBlueprint: ServiceBlueprint; port: number; azs: Record<string, AvailabilityZone> }`
    and `PathEvaluation = { hopClass: HopClass; verdict: 'permitted' | 'blocked'; blockReason: BlockReason | null }`
  - `compileWorld` now returns populated `paths` and one `blocked-path` finding per blocked path.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/world/network.test.ts
import { describe, it, expect } from 'vitest'
import { evaluateFirewall, evaluateInstancePath } from './network'
import { createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement } from './factories'
import { getPreset } from './instanceCatalog'
import { compileWorld } from './compileWorld'
import type { FirewallRule, PlacementRuntime } from './types'

const allowAll: FirewallRule = { id: 'r-allow', action: 'allow', port: 'any', protocol: 'any', source: 'internal' }
const denyDb: FirewallRule = { id: 'r-deny-db', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' }
const proc: PlacementRuntime = { type: 'process' }

describe('evaluateFirewall', () => {
  it('first matching rule wins, in array order', () => {
    expect(evaluateFirewall([denyDb, allowAll], 5432)).toEqual({ allowed: false, matchedRuleId: 'r-deny-db' })
    expect(evaluateFirewall([allowAll, denyDb], 5432)).toEqual({ allowed: true, matchedRuleId: 'r-allow' })
    expect(evaluateFirewall([denyDb, allowAll], 8080)).toEqual({ allowed: true, matchedRuleId: 'r-allow' })
  })

  it('default-denies when nothing matches', () => {
    expect(evaluateFirewall([], 443)).toEqual({ allowed: false, matchedRuleId: null })
    expect(evaluateFirewall([denyDb], 443)).toEqual({ allowed: false, matchedRuleId: null })
  })
})

// Two servers in one AZ + a third in another region, wired through a full compile.
function twoServerWorld() {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const region2 = createRegion('eu-west-1')
  const az = createAz(region.id, 'us-east-1a')
  const az2 = createAz(region.id, 'us-east-1b')
  const azEu = createAz(region2.id, 'eu-west-1a')
  const web = createServer(az.id, getPreset('vps-medium')!)
  const db = createServer(az.id, getPreset('dedicated-8')!)
  const dbB = createServer(az2.id, getPreset('dedicated-8')!)
  const dbEu = createServer(azEu.id, getPreset('dedicated-8')!)
  Object.assign(doc.regions, { [region.id]: region, [region2.id]: region2 })
  Object.assign(doc.azs, { [az.id]: az, [az2.id]: az2, [azEu.id]: azEu })
  Object.assign(doc.servers, { [web.id]: web, [db.id]: db, [dbB.id]: dbB, [dbEu.id]: dbEu })
  return { doc, region, az, az2, azEu, web, db, dbB, dbEu }
}

describe('evaluateInstancePath / compileWorld paths', () => {
  it('permits a cross-server path through an allow rule with same-az hop class', () => {
    const { doc, web, db } = twoServerWorld()
    const api = createBlueprint('api', 0)
    const pg = createBlueprint('pg', 1)
    pg.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
    api.dependencies = [{ id: 'dep-1', target: { kind: 'blueprint', blueprintId: pg.id }, port: 5432, protocol: 'db', packetTemplateId: null }]
    Object.assign(doc.blueprints, { [api.id]: api, [pg.id]: pg })
    const plApi = createPlacement(api.id, web.id)
    const plPg = createPlacement(pg.id, db.id)
    Object.assign(doc.placements, { [plApi.id]: plApi, [plPg.id]: plPg })

    const compiled = compileWorld(doc)
    expect(compiled.paths).toHaveLength(1)
    expect(compiled.paths[0]).toMatchObject({ verdict: 'permitted', hopClass: 'same-az' })
    expect(compiled.findings).toHaveLength(0)
  })

  it('blocks with firewall-deny (and emits a finding) when the target denies the port', () => {
    const { doc, web, db } = twoServerWorld()
    db.firewall = [{ id: 'deny5432', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' }]
    const api = createBlueprint('api', 0)
    const pg = createBlueprint('pg', 1)
    pg.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
    api.dependencies = [{ id: 'dep-1', target: { kind: 'blueprint', blueprintId: pg.id }, port: 5432, protocol: 'db', packetTemplateId: null }]
    Object.assign(doc.blueprints, { [api.id]: api, [pg.id]: pg })
    Object.assign(doc.placements, {
      a: { ...createPlacement(api.id, web.id), id: 'a' },
      b: { ...createPlacement(pg.id, db.id), id: 'b' },
    })

    const compiled = compileWorld(doc)
    expect(compiled.paths[0].verdict).toBe('blocked')
    expect(compiled.paths[0].blockReason).toMatchObject({ kind: 'firewall-deny', firewallRuleId: 'deny5432' })
    expect(compiled.findings.some(f => f.kind === 'blocked-path' && f.severity === 'error')).toBe(true)
  })

  it('blocks with no-port-binding when the blueprint never binds the port', () => {
    const { doc, web, db } = twoServerWorld()
    const api = createBlueprint('api', 0)
    const pg = createBlueprint('pg', 1)
    pg.ports = []   // nothing bound
    api.dependencies = [{ id: 'dep-1', target: { kind: 'blueprint', blueprintId: pg.id }, port: 5432, protocol: 'db', packetTemplateId: null }]
    Object.assign(doc.blueprints, { [api.id]: api, [pg.id]: pg })
    Object.assign(doc.placements, {
      a: { ...createPlacement(api.id, web.id), id: 'a' },
      b: { ...createPlacement(pg.id, db.id), id: 'b' },
    })
    expect(compileWorld(doc).paths[0].blockReason?.kind).toBe('no-port-binding')
  })

  it('same-server loopback skips the firewall entirely', () => {
    const { doc, web } = twoServerWorld()
    web.firewall = []   // default deny everything — loopback must still pass
    const api = createBlueprint('api', 0)
    const pg = createBlueprint('pg', 1)
    pg.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
    api.dependencies = [{ id: 'dep-1', target: { kind: 'blueprint', blueprintId: pg.id }, port: 5432, protocol: 'db', packetTemplateId: null }]
    Object.assign(doc.blueprints, { [api.id]: api, [pg.id]: pg })
    Object.assign(doc.placements, {
      a: { ...createPlacement(api.id, web.id), id: 'a' },
      b: { ...createPlacement(pg.id, web.id), id: 'b' },
    })
    const compiled = compileWorld(doc)
    expect(compiled.paths[0]).toMatchObject({ verdict: 'permitted', hopClass: 'localhost' })
  })

  it('containers on the same server need a shared network — else network-isolation', () => {
    const { doc, web } = twoServerWorld()
    web.stacks = [{ name: 'app', networks: [{ name: 'front', cidr: '172.18.0.0/16' }, { name: 'back', cidr: '172.19.0.0/16' }], volumes: [] }]
    const api = createBlueprint('api', 0)
    const pg = createBlueprint('pg', 1)
    pg.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
    api.dependencies = [{ id: 'dep-1', target: { kind: 'blueprint', blueprintId: pg.id }, port: 5432, protocol: 'db', packetTemplateId: null }]
    Object.assign(doc.blueprints, { [api.id]: api, [pg.id]: pg })
    const mk = (bp: string, nets: string[]): PlacementRuntime =>
      ({ type: 'container', stackName: 'app', networkNames: nets, portMappings: [], cpuLimit: null, memLimitMb: null })
    Object.assign(doc.placements, {
      a: { ...createPlacement(api.id, web.id), id: 'a', runtime: mk(api.id, ['front']) },
      b: { ...createPlacement(pg.id, web.id), id: 'b', runtime: mk(pg.id, ['back']) },
    })
    expect(compileWorld(doc).paths[0].blockReason?.kind).toBe('network-isolation')

    // Now join both to 'back' → permitted via the shared bridge.
    ;(doc.placements['a'].runtime as Extract<PlacementRuntime, { type: 'container' }>).networkNames = ['front', 'back']
    expect(compileWorld(doc).paths[0].verdict).toBe('permitted')
  })

  it('cross-server container targets require a host port mapping, firewalled on the host port', () => {
    const { doc, web, db } = twoServerWorld()
    db.stacks = [{ name: 'data', networks: [{ name: 'default', cidr: '172.18.0.0/16' }], volumes: [] }]
    db.firewall = [{ id: 'allow15432', action: 'allow', port: 15432, protocol: 'tcp', source: 'internal' }]
    const api = createBlueprint('api', 0)
    const pg = createBlueprint('pg', 1)
    pg.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
    api.dependencies = [{ id: 'dep-1', target: { kind: 'blueprint', blueprintId: pg.id }, port: 5432, protocol: 'db', packetTemplateId: null }]
    Object.assign(doc.blueprints, { [api.id]: api, [pg.id]: pg })
    const pgRuntime: PlacementRuntime = { type: 'container', stackName: 'data', networkNames: ['default'], portMappings: [{ host: 15432, container: 5432 }], cpuLimit: null, memLimitMb: null }
    Object.assign(doc.placements, {
      a: { ...createPlacement(api.id, web.id), id: 'a' },
      b: { ...createPlacement(pg.id, db.id), id: 'b', runtime: pgRuntime },
    })
    expect(compileWorld(doc).paths[0].verdict).toBe('permitted')

    // Remove the mapping → unreachable from off-host.
    ;(doc.placements['b'].runtime as Extract<PlacementRuntime, { type: 'container' }>).portMappings = []
    expect(compileWorld(doc).paths[0].blockReason?.kind).toBe('no-port-binding')
  })

  it('classifies cross-az and cross-region hops', () => {
    const { doc, web, dbB, dbEu } = twoServerWorld()
    const api = createBlueprint('api', 0)
    const pg = createBlueprint('pg', 1)
    pg.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
    api.dependencies = [{ id: 'dep-1', target: { kind: 'blueprint', blueprintId: pg.id }, port: 5432, protocol: 'db', packetTemplateId: null }]
    Object.assign(doc.blueprints, { [api.id]: api, [pg.id]: pg })
    Object.assign(doc.placements, {
      a: { ...createPlacement(api.id, web.id), id: 'a' },
      b: { ...createPlacement(pg.id, dbB.id), id: 'b' },
      c: { ...createPlacement(pg.id, dbEu.id), id: 'c' },
    })
    const compiled = compileWorld(doc)
    const classes = compiled.paths.map(p => p.hopClass).sort()
    expect(classes).toEqual(['cross-az', 'cross-region'])
  })

  it('managed targets are always permitted, hop class from scope', () => {
    const { doc, az, web } = twoServerWorld()
    doc.managedServices['ms-1'] = { id: 'ms-1', label: 'RDS', nodeType: 'rds', scope: { kind: 'az', azId: az.id }, provider: 'aws', port: 5432 }
    const api = createBlueprint('api', 0)
    api.dependencies = [{ id: 'dep-1', target: { kind: 'managed', managedServiceId: 'ms-1' }, port: 5432, protocol: 'db', packetTemplateId: null }]
    doc.blueprints[api.id] = api
    doc.placements['a'] = { ...createPlacement(api.id, web.id), id: 'a' }
    const compiled = compileWorld(doc)
    expect(compiled.paths[0]).toMatchObject({ verdict: 'permitted', hopClass: 'same-az', to: { kind: 'managed', managedServiceId: 'ms-1' } })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/world/network.test.ts`
Expected: FAIL — `Cannot find module './network'`

- [ ] **Step 3: Write `network.ts`**

```ts
// src/lib/world/network.ts
// Pure network-path evaluation: firewall rules, port bindings, docker-network isolation.
// Semantics (spec D10 + plan "Semantics locked here"): same-server traffic never hits the
// firewall; cross-server evaluates the TARGET server's rules first-match-wins with default
// deny; in Phase 1 every in-world flow counts as 'internal' and CIDR sources match it.
import type {
  Server, AvailabilityZone, FirewallRule, ServiceBlueprint, PlacementRuntime,
  HopClass, BlockReason,
} from './types'

export function evaluateFirewall(
  rules: FirewallRule[],
  port: number,
): { allowed: boolean; matchedRuleId: string | null } {
  for (const rule of rules) {
    const portMatches = rule.port === 'any' || rule.port === port
    const protocolMatches = rule.protocol === 'any' || rule.protocol === 'tcp' // all Phase-1 dep protocols ride tcp
    if (portMatches && protocolMatches) {
      return { allowed: rule.action === 'allow', matchedRuleId: rule.id }
    }
  }
  return { allowed: false, matchedRuleId: null } // default deny
}

export function hopClassBetween(
  fromServer: Server,
  toServer: Server,
  azs: Record<string, AvailabilityZone>,
): HopClass {
  if (fromServer.id === toServer.id) return 'localhost'
  if (fromServer.azId === toServer.azId) return 'same-az'
  const fromRegion = azs[fromServer.azId]?.regionId
  const toRegion = azs[toServer.azId]?.regionId
  return fromRegion === toRegion ? 'cross-az' : 'cross-region'
}

export interface InstancePathContext {
  fromServer: Server
  toServer: Server
  fromRuntime: PlacementRuntime
  toRuntime: PlacementRuntime
  toBlueprint: ServiceBlueprint
  port: number
  azs: Record<string, AvailabilityZone>
}

export interface PathEvaluation {
  hopClass: HopClass
  verdict: 'permitted' | 'blocked'
  blockReason: BlockReason | null
}

const blocked = (hopClass: HopClass, reason: BlockReason): PathEvaluation =>
  ({ hopClass, verdict: 'blocked', blockReason: reason })
const permitted = (hopClass: HopClass): PathEvaluation =>
  ({ hopClass, verdict: 'permitted', blockReason: null })

export function evaluateInstancePath(ctx: InstancePathContext): PathEvaluation {
  const { fromServer, toServer, fromRuntime, toRuntime, toBlueprint, port, azs } = ctx
  const hopClass = hopClassBetween(fromServer, toServer, azs)
  const bindsPort = toBlueprint.ports.some(p => p.port === port)

  if (toRuntime.type === 'process') {
    if (!bindsPort) {
      return blocked(hopClass, {
        kind: 'no-port-binding',
        detail: `${toBlueprint.name} does not bind port ${port}`,
        firewallRuleId: null,
      })
    }
    if (hopClass === 'localhost') return permitted(hopClass)
    return firewallVerdict(toServer, port, hopClass)
  }

  // Container target.
  const sameServer = fromServer.id === toServer.id
  const sharedNetwork =
    sameServer &&
    fromRuntime.type === 'container' &&
    fromRuntime.stackName === toRuntime.stackName &&
    fromRuntime.networkNames.some(n => toRuntime.networkNames.includes(n))

  if (sharedNetwork) {
    // Container-to-container over the compose bridge: the CONTAINER port must be bound.
    if (!bindsPort) {
      return blocked('localhost', {
        kind: 'no-port-binding',
        detail: `${toBlueprint.name} container does not bind port ${port}`,
        firewallRuleId: null,
      })
    }
    return permitted('localhost')
  }

  // Off-network access needs the container port published on the host.
  const mapping = toRuntime.portMappings.find(m => m.container === port)
  if (!mapping) {
    if (sameServer && fromRuntime.type === 'container') {
      return blocked('localhost', {
        kind: 'network-isolation',
        detail: `no shared docker network between containers and port ${port} is not published on the host`,
        firewallRuleId: null,
      })
    }
    return blocked(hopClass, {
      kind: 'no-port-binding',
      detail: `container port ${port} is not published via a host port mapping`,
      firewallRuleId: null,
    })
  }
  if (!bindsPort) {
    return blocked(hopClass, {
      kind: 'no-port-binding',
      detail: `${toBlueprint.name} does not bind container port ${port}`,
      firewallRuleId: null,
    })
  }
  if (hopClass === 'localhost') return permitted(hopClass)
  return firewallVerdict(toServer, mapping.host, hopClass)
}

function firewallVerdict(toServer: Server, port: number, hopClass: HopClass): PathEvaluation {
  const fw = evaluateFirewall(toServer.firewall, port)
  if (fw.allowed) return permitted(hopClass)
  return blocked(hopClass, {
    kind: 'firewall-deny',
    detail: fw.matchedRuleId
      ? `denied by firewall rule on ${toServer.label} (port ${port})`
      : `no matching allow rule on ${toServer.label} (default deny, port ${port})`,
    firewallRuleId: fw.matchedRuleId,
  })
}
```

- [ ] **Step 4: Wire paths into `compileWorld.ts`**

Replace the `return` block of `compileWorld` (and add imports/helpers) so the full function
body becomes:

```ts
// src/lib/world/compileWorld.ts  (full file after this task)
import type {
  WorldDoc, CompiledWorld, ServiceInstance, InstanceId, CompiledPath, CompileFinding,
  HopClass,
} from './types'
import { evaluateInstancePath, hopClassBetween } from './network'

export function instanceId(placementId: string, index: number): InstanceId {
  return `${placementId}#${index}`
}

export function compileWorld(doc: WorldDoc): CompiledWorld {
  const instances: Record<InstanceId, ServiceInstance> = {}

  for (const pl of Object.values(doc.placements)) {
    const bp = doc.blueprints[pl.blueprintId]
    const server = doc.servers[pl.serverId]
    if (!bp || !server) continue
    const az = doc.azs[server.azId]
    if (!az) continue
    const region = doc.regions[az.regionId]
    if (!region) continue

    for (let i = 0; i < pl.count; i++) {
      const id = instanceId(pl.id, i)
      instances[id] = {
        id, blueprintId: bp.id, placementId: pl.id, serverId: server.id,
        azId: az.id, regionId: region.id, role: pl.role, indexInPlacement: i,
      }
    }
  }

  const paths: CompiledPath[] = []
  const findings: CompileFinding[] = []

  for (const from of Object.values(instances)) {
    const fromBp = doc.blueprints[from.blueprintId]
    const fromPl = doc.placements[from.placementId]
    const fromServer = doc.servers[from.serverId]
    if (!fromBp || !fromPl || !fromServer) continue

    for (const dep of fromBp.dependencies) {
      if (dep.target.kind === 'managed') {
        const ms = doc.managedServices[dep.target.managedServiceId]
        if (!ms) continue // dangling dependency
        paths.push({
          id: `${from.id}->${dep.id}->${ms.id}`,
          dependencyId: dep.id,
          fromInstanceId: from.id,
          to: { kind: 'managed', managedServiceId: ms.id },
          hopClass: managedHopClass(doc, from.azId, from.regionId, ms.id),
          verdict: 'permitted', // provider side — always reachable (spec D12)
          blockReason: null,
        })
        continue
      }

      const targetBpId = dep.target.blueprintId
      for (const to of Object.values(instances)) {
        if (to.blueprintId !== targetBpId) continue
        const toPl = doc.placements[to.placementId]
        const toServer = doc.servers[to.serverId]
        const toBp = doc.blueprints[to.blueprintId]
        if (!toPl || !toServer || !toBp) continue

        const evaluation = evaluateInstancePath({
          fromServer, toServer,
          fromRuntime: fromPl.runtime, toRuntime: toPl.runtime,
          toBlueprint: toBp, port: dep.port, azs: doc.azs,
        })
        const path: CompiledPath = {
          id: `${from.id}->${dep.id}->${to.id}`,
          dependencyId: dep.id,
          fromInstanceId: from.id,
          to: { kind: 'instance', instanceId: to.id },
          hopClass: evaluation.hopClass,
          verdict: evaluation.verdict,
          blockReason: evaluation.blockReason,
        }
        paths.push(path)
        if (path.verdict === 'blocked' && path.blockReason) {
          findings.push({
            id: `finding-${path.id}`,
            severity: 'error',
            kind: 'blocked-path',
            message: `${fromBp.name} → ${toBp.name}:${dep.port} is blocked: ${path.blockReason.detail}`,
            affected: [from.id, to.id, toServer.id],
          })
        }
      }
    }
  }

  return {
    instances,
    paths,
    findings,
    routing: { populationRegionOrder: {}, regionAzSpread: {}, azBlueprintTargets: {} }, // Task 6
  }
}

function managedHopClass(doc: WorldDoc, fromAzId: string, fromRegionId: string, msId: string): HopClass {
  const ms = doc.managedServices[msId]
  if (!ms) return 'cross-region'
  if (ms.scope.kind === 'az') {
    if (ms.scope.azId === fromAzId) return 'same-az'
    return doc.azs[ms.scope.azId]?.regionId === fromRegionId ? 'cross-az' : 'cross-region'
  }
  return ms.scope.regionId === fromRegionId ? 'cross-az' : 'cross-region'
}
```

Note `hopClassBetween` is imported for future callers (AzCanvas Task 13 uses it); if tsc
flags it unused here, drop it from this file's import and keep it exported from `network.ts`.

- [ ] **Step 5: Run tests to verify they pass (both suites)**

Run: `npx vitest run src/lib/world/network.test.ts src/lib/world/compileWorld.test.ts`
Expected: PASS (network: 9 tests; compileWorld: 4 tests still green)

- [ ] **Step 6: Commit**

```bash
git add src/lib/world/network.ts src/lib/world/network.test.ts src/lib/world/compileWorld.ts
git commit -m "feat(world): enforce firewall/port/docker-network semantics in compiled paths"
```

---

### Task 6: compileWorld — routing tables + volume findings

**Files:**
- Create: `src/lib/world/routing.ts`
- Modify: `src/lib/world/compileWorld.ts` (call `computeRouting` + `volumeFindings`)
- Test: `src/lib/world/routing.test.ts`

**Interfaces:**
- Consumes: Task 1 types, Task 2's `REGION_GEO`/`greatCircleKm`, `WORLD_REGIONS` from
  `src/lib/regionConfig.ts`, Task 4/5's `compileWorld` internals.
- Produces:
  - `computeRouting(doc: WorldDoc, instances: Record<InstanceId, ServiceInstance>): CompiledRouting`
  - `volumeFindings(doc: WorldDoc): CompileFinding[]`
  - `compileWorld` returns fully-populated `routing` and appends volume findings.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/world/routing.test.ts
import { describe, it, expect } from 'vitest'
import { createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement, createPopulation } from './factories'
import { getPreset } from './instanceCatalog'
import { compileWorld, instanceId } from './compileWorld'
import { volumeFindings } from './routing'

function geoWorld() {
  const doc = createWorld()
  const useast = createRegion('us-east-1')
  const euwest = createRegion('eu-west-1')
  const sydney = createRegion('ap-southeast-2')
  for (const r of [useast, euwest, sydney]) doc.regions[r.id] = r
  const az1 = createAz(useast.id, 'us-east-1a')
  const az2 = createAz(useast.id, 'us-east-1b')
  const azEu = createAz(euwest.id, 'eu-west-1a')
  const azAp = createAz(sydney.id, 'ap-southeast-2a')
  for (const a of [az1, az2, azEu, azAp]) doc.azs[a.id] = a
  return { doc, useast, euwest, sydney, az1, az2, azEu, azAp }
}

describe('computeRouting (via compileWorld)', () => {
  it('latency policy orders regions by proximity to each population', () => {
    const { doc, useast, euwest, sydney } = geoWorld()
    const nyc = createPopulation('NYC users', 40.7, -74.0)
    const berlin = createPopulation('Berlin users', 52.5, 13.4)
    doc.populations[nyc.id] = nyc
    doc.populations[berlin.id] = berlin

    const { routing } = compileWorld(doc)
    expect(routing.populationRegionOrder[nyc.id][0]).toBe(useast.id)
    expect(routing.populationRegionOrder[nyc.id][2]).toBe(sydney.id)
    expect(routing.populationRegionOrder[berlin.id][0]).toBe(euwest.id)
  })

  it('passive regions always sort last regardless of proximity', () => {
    const { doc, useast, euwest } = geoWorld()
    doc.regions[useast.id] = { ...useast, role: 'passive' }
    const nyc = createPopulation('NYC users', 40.7, -74.0)
    doc.populations[nyc.id] = nyc
    const { routing } = compileWorld(doc)
    const order = routing.populationRegionOrder[nyc.id]
    expect(order[order.length - 1]).toBe(useast.id)
    expect(order[0]).toBe(euwest.id)
  })

  it('priority policy follows priorityOrder, weighted follows weights desc', () => {
    const { doc, useast, euwest, sydney } = geoWorld()
    const nyc = createPopulation('NYC users', 40.7, -74.0)
    doc.populations[nyc.id] = nyc

    doc.routing = { ...doc.routing, policy: 'priority', priorityOrder: [sydney.id, euwest.id, useast.id] }
    expect(compileWorld(doc).routing.populationRegionOrder[nyc.id][0]).toBe(sydney.id)

    doc.routing = { ...doc.routing, policy: 'weighted', weights: { [euwest.id]: 100, [useast.id]: 10, [sydney.id]: 1 } }
    expect(compileWorld(doc).routing.populationRegionOrder[nyc.id]).toEqual([euwest.id, useast.id, sydney.id])
  })

  it('builds regionAzSpread (sorted by label) and azBlueprintTargets', () => {
    const { doc, useast, az1, az2 } = geoWorld()
    const srv = createServer(az1.id, getPreset('vps-medium')!)
    doc.servers[srv.id] = srv
    const bp = createBlueprint('api', 0)
    doc.blueprints[bp.id] = bp
    const pl = createPlacement(bp.id, srv.id)
    pl.count = 2
    doc.placements[pl.id] = pl

    const { routing } = compileWorld(doc)
    expect(routing.regionAzSpread[useast.id]).toEqual([az1.id, az2.id])
    expect(routing.azBlueprintTargets[az1.id][bp.id]).toEqual([instanceId(pl.id, 0), instanceId(pl.id, 1)])
  })
})

describe('volumeFindings', () => {
  it('warns on stateful blueprint without a volume name', () => {
    const { doc, az1 } = geoWorld()
    const srv = createServer(az1.id, getPreset('dedicated-8')!)
    doc.servers[srv.id] = srv
    const bp = createBlueprint('pg', 1)
    bp.stateful = true // volumeName left null
    doc.blueprints[bp.id] = bp
    const findings = volumeFindings(doc)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ kind: 'stateful-without-volume', severity: 'warning', affected: [bp.id] })
  })

  it('errors when a container placement of a stateful blueprint lacks the volume in its stack', () => {
    const { doc, az1 } = geoWorld()
    const srv = createServer(az1.id, getPreset('dedicated-8')!)
    srv.stacks = [{ name: 'data', networks: [{ name: 'default', cidr: '172.18.0.0/16' }], volumes: [] }] // no volumes!
    doc.servers[srv.id] = srv
    const bp = createBlueprint('pg', 1)
    bp.stateful = true
    bp.volumeName = 'pgdata'
    doc.blueprints[bp.id] = bp
    const pl = createPlacement(bp.id, srv.id)
    pl.runtime = { type: 'container', stackName: 'data', networkNames: ['default'], portMappings: [], cpuLimit: null, memLimitMb: null }
    doc.placements[pl.id] = pl

    const findings = volumeFindings(doc)
    expect(findings.some(f => f.kind === 'missing-volume' && f.severity === 'error')).toBe(true)

    // Add the volume → clean.
    srv.stacks[0].volumes = [{ name: 'pgdata', sizeGb: 20 }]
    expect(volumeFindings(doc)).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/world/routing.test.ts`
Expected: FAIL — `Cannot find module './routing'`

- [ ] **Step 3: Write `routing.ts`**

```ts
// src/lib/world/routing.ts
// Pure routing-table + volume-consistency computation. Static ordering only — live health
// state and TTL-lagged cutover are the Phase-2 engine's job; it consumes these orders.
import type {
  WorldDoc, CompiledRouting, CompileFinding, ServiceInstance, InstanceId, Region,
} from './types'
import { REGION_GEO, greatCircleKm } from './regionGeo'
import { WORLD_REGIONS } from '../regionConfig'

function distanceScore(popLat: number, popLon: number, region: Region): number {
  const geo = REGION_GEO[region.catalogId]
  if (!geo) return Number.MAX_SAFE_INTEGER
  return greatCircleKm(popLat, popLon, geo.lat, geo.lon)
}

export function computeRouting(
  doc: WorldDoc,
  instances: Record<InstanceId, ServiceInstance>,
): CompiledRouting {
  const regions = Object.values(doc.regions)
  const populationRegionOrder: CompiledRouting['populationRegionOrder'] = {}

  for (const pop of Object.values(doc.populations)) {
    const scored = regions.map(region => {
      const km = distanceScore(pop.lat, pop.lon, region)
      const baseLatency = WORLD_REGIONS.find(w => w.id === region.catalogId)?.baseLatencyMs ?? 0
      let score: number
      switch (doc.routing.policy) {
        case 'geo':      score = km; break
        case 'latency':  score = km + baseLatency * 10; break
        case 'weighted': score = -(doc.routing.weights[region.id] ?? 0) * 1e9 + km; break
        case 'priority': {
          const idx = doc.routing.priorityOrder.indexOf(region.id)
          score = (idx === -1 ? 1e6 : idx) * 1e9 + km
          break
        }
      }
      return { region, score }
    })
    scored.sort((a, b) => a.score - b.score)
    // Stable partition: passive regions to the end (spec D8 active-passive semantics).
    const active = scored.filter(s => s.region.role === 'active')
    const passive = scored.filter(s => s.region.role === 'passive')
    populationRegionOrder[pop.id] = [...active, ...passive].map(s => s.region.id)
  }

  const regionAzSpread: CompiledRouting['regionAzSpread'] = {}
  for (const region of regions) {
    regionAzSpread[region.id] = Object.values(doc.azs)
      .filter(az => az.regionId === region.id)
      .sort((a, b) => a.label.localeCompare(b.label))
      .map(az => az.id)
  }

  const azBlueprintTargets: CompiledRouting['azBlueprintTargets'] = {}
  for (const inst of Object.values(instances)) {
    const byBp = (azBlueprintTargets[inst.azId] ??= {})
    ;(byBp[inst.blueprintId] ??= []).push(inst.id)
  }
  for (const byBp of Object.values(azBlueprintTargets)) {
    for (const list of Object.values(byBp)) list.sort()
  }

  return { populationRegionOrder, regionAzSpread, azBlueprintTargets }
}

export function volumeFindings(doc: WorldDoc): CompileFinding[] {
  const findings: CompileFinding[] = []

  for (const bp of Object.values(doc.blueprints)) {
    if (bp.stateful && !bp.volumeName) {
      findings.push({
        id: `finding-vol-${bp.id}`,
        severity: 'warning',
        kind: 'stateful-without-volume',
        message: `${bp.name} is stateful but has no volume configured — data is lost on restart`,
        affected: [bp.id],
      })
    }
  }

  for (const pl of Object.values(doc.placements)) {
    const bp = doc.blueprints[pl.blueprintId]
    const server = doc.servers[pl.serverId]
    if (!bp || !server || !bp.stateful || !bp.volumeName) continue
    if (pl.runtime.type !== 'container') continue
    const { stackName } = pl.runtime
    const stack = server.stacks.find(s => s.name === stackName)
    const hasVolume = stack?.volumes.some(v => v.name === bp.volumeName) ?? false
    if (!hasVolume) {
      findings.push({
        id: `finding-vol-${pl.id}`,
        severity: 'error',
        kind: 'missing-volume',
        message: `${bp.name} needs volume "${bp.volumeName}" but stack "${stackName}" on ${server.label} does not define it`,
        affected: [pl.id, server.id, bp.id],
      })
    }
  }

  return findings
}
```

- [ ] **Step 4: Wire into `compileWorld.ts`**

In `compileWorld.ts`, add the import and change the final return:

```ts
import { computeRouting, volumeFindings } from './routing'
// … existing body unchanged …
  return {
    instances,
    paths,
    findings: [...findings, ...volumeFindings(doc)],
    routing: computeRouting(doc, instances),
  }
```

- [ ] **Step 5: Run all world tests**

Run: `npx vitest run src/lib/world/`
Expected: PASS — factories 5, regionGeo 2, instanceCatalog 3, compileWorld 4, network 9, routing 6.

- [ ] **Step 6: Commit**

```bash
git add src/lib/world/routing.ts src/lib/world/routing.test.ts src/lib/world/compileWorld.ts
git commit -m "feat(world): add routing tables and volume findings to compileWorld"
```

### Task 7: world.store — document state + undo/redo + cascading CRUD

**Files:**
- Create: `src/app/store/world.store.ts`
- Test: `src/app/store/world.store.test.ts`

**Interfaces:**
- Consumes: Task 1 types + factories, Task 3's `InstancePreset` (via `InstancePresetLike`).
- Produces: `useWorldStore` (Zustand) with the exact store shape below. Views and panels
  (Tasks 10–13) read `useWorldStore(s => s.doc)` and call these actions. Undo/redo mirrors
  `canvas.store.ts`'s deep-copy snapshot pattern (cap 100).

Store shape (write this interface verbatim into the file):

```ts
interface WorldStore {
  doc: WorldDoc
  history: WorldDoc[]
  future: WorldDoc[]

  newWorld: () => void
  replaceWorld: (doc: WorldDoc) => void   // load from file: clears history

  addRegion: (catalogId: string) => string
  removeRegion: (id: string) => void
  addAz: (regionId: string, label: string) => string
  removeAz: (id: string) => void
  addServer: (azId: string, preset: InstancePresetLike) => string
  updateServer: (id: string, patch: Partial<Server>) => void
  removeServer: (id: string) => void
  addBlueprint: (name: string) => string
  updateBlueprint: (id: string, patch: Partial<ServiceBlueprint>) => void
  removeBlueprint: (id: string) => void
  addPlacement: (blueprintId: string, serverId: string) => string
  updatePlacement: (id: string, patch: Partial<Placement>) => void
  removePlacement: (id: string) => void
  addManagedService: (nodeType: string, label: string, scope: ManagedScope, port: number) => string
  removeManagedService: (id: string) => void
  addPopulation: (label: string, lat: number, lon: number) => string
  updatePopulation: (id: string, patch: Partial<ClientPopulation>) => void
  removePopulation: (id: string) => void
  updateRouting: (patch: Partial<RoutingConfig>) => void
  updateTraffic: (patch: Partial<TrafficConfig>) => void

  pushHistory: () => void
  undo: () => void
  redo: () => void
}
```

Cascade rules (implement as pure helpers inside the file, each `(doc, id) → WorldDoc`):

- `removeRegion` → removes its AZs → each AZ's servers → each server's placements, plus managed services scoped to the region or its AZs, and drops the region from `routing.weights`/`priorityOrder`.
- `removeAz` → its servers → their placements, plus AZ-scoped managed services.
- `removeServer` → its placements.
- `removeBlueprint` → its placements, plus strips any `BlueprintDependency` in OTHER blueprints whose target is this blueprint.
- `removeManagedService` → strips dependencies targeting it.

- [ ] **Step 1: Write the failing test**

```ts
// src/app/store/world.store.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useWorldStore } from './world.store'
import { getPreset } from '../../lib/world/instanceCatalog'

beforeEach(() => useWorldStore.getState().newWorld())

function buildChain() {
  const s = useWorldStore.getState()
  const regionId = s.addRegion('us-east-1')
  const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
  const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
  const bpId = useWorldStore.getState().addBlueprint('api')
  const plId = useWorldStore.getState().addPlacement(bpId, serverId)
  return { regionId, azId, serverId, bpId, plId }
}

describe('world.store', () => {
  it('builds a linked region→az→server→blueprint→placement chain', () => {
    const { regionId, azId, serverId, bpId, plId } = buildChain()
    const doc = useWorldStore.getState().doc
    expect(doc.azs[azId].regionId).toBe(regionId)
    expect(doc.servers[serverId].azId).toBe(azId)
    expect(doc.placements[plId]).toMatchObject({ blueprintId: bpId, serverId })
  })

  it('removeRegion cascades through azs, servers, placements, managed services', () => {
    const { regionId, azId } = buildChain()
    useWorldStore.getState().addManagedService('rds', 'RDS', { kind: 'az', azId }, 5432)
    useWorldStore.getState().removeRegion(regionId)
    const doc = useWorldStore.getState().doc
    expect(Object.keys(doc.regions)).toHaveLength(0)
    expect(Object.keys(doc.azs)).toHaveLength(0)
    expect(Object.keys(doc.servers)).toHaveLength(0)
    expect(Object.keys(doc.placements)).toHaveLength(0)
    expect(Object.keys(doc.managedServices)).toHaveLength(0)
  })

  it('removeBlueprint drops its placements and strips dependencies pointing at it', () => {
    const { serverId, bpId } = buildChain()
    const webId = useWorldStore.getState().addBlueprint('web')
    useWorldStore.getState().updateBlueprint(webId, {
      dependencies: [{ id: 'd1', target: { kind: 'blueprint', blueprintId: bpId }, port: 8080, protocol: 'http', packetTemplateId: null }],
    })
    useWorldStore.getState().addPlacement(webId, serverId)
    useWorldStore.getState().removeBlueprint(bpId)
    const doc = useWorldStore.getState().doc
    expect(doc.blueprints[bpId]).toBeUndefined()
    expect(Object.values(doc.placements).every(p => p.blueprintId !== bpId)).toBe(true)
    expect(doc.blueprints[webId].dependencies).toHaveLength(0)
  })

  it('undo/redo restore document snapshots', () => {
    const { regionId } = buildChain()
    const before = Object.keys(useWorldStore.getState().doc.servers).length
    expect(before).toBe(1)
    useWorldStore.getState().removeRegion(regionId)
    expect(Object.keys(useWorldStore.getState().doc.servers)).toHaveLength(0)
    useWorldStore.getState().undo()
    expect(Object.keys(useWorldStore.getState().doc.servers)).toHaveLength(1)
    useWorldStore.getState().redo()
    expect(Object.keys(useWorldStore.getState().doc.servers)).toHaveLength(0)
  })

  it('every mutation replaces doc immutably (reference changes)', () => {
    const s = useWorldStore.getState()
    const before = s.doc
    s.addRegion('eu-west-1')
    expect(useWorldStore.getState().doc).not.toBe(before)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/store/world.store.test.ts`
Expected: FAIL — `Cannot find module './world.store'`

- [ ] **Step 3: Write the store**

```ts
// src/app/store/world.store.ts
// Source of truth for the .scalemap v2 document. Normalized WorldDoc + immutable-snapshot
// undo/redo (same pattern as canvas.store.ts). Every mutation goes through pushHistory()
// and replaces `doc` wholesale so useCompiledWorld()'s useMemo invalidates.
import { create } from 'zustand'
import type {
  WorldDoc, Server, ServiceBlueprint, Placement, ManagedScope, ClientPopulation,
  RoutingConfig, TrafficConfig,
} from '../../lib/world/types'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
  createPopulation, nextWorldId, type InstancePresetLike,
} from '../../lib/world/factories'

const deepCopy = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

// ─── Pure cascade helpers ────────────────────────────────────────────────────

function withoutServer(doc: WorldDoc, serverId: string): WorldDoc {
  const servers = { ...doc.servers }
  delete servers[serverId]
  const placements = Object.fromEntries(
    Object.entries(doc.placements).filter(([, p]) => p.serverId !== serverId))
  return { ...doc, servers, placements }
}

function withoutAz(doc: WorldDoc, azId: string): WorldDoc {
  let next: WorldDoc = doc
  for (const s of Object.values(doc.servers)) if (s.azId === azId) next = withoutServer(next, s.id)
  const azs = { ...next.azs }
  delete azs[azId]
  const managedServices = Object.fromEntries(
    Object.entries(next.managedServices).filter(([, m]) => !(m.scope.kind === 'az' && m.scope.azId === azId)))
  return { ...next, azs, managedServices }
}

function withoutRegion(doc: WorldDoc, regionId: string): WorldDoc {
  let next: WorldDoc = doc
  for (const az of Object.values(doc.azs)) if (az.regionId === regionId) next = withoutAz(next, az.id)
  const regions = { ...next.regions }
  delete regions[regionId]
  const managedServices = Object.fromEntries(
    Object.entries(next.managedServices).filter(([, m]) => !(m.scope.kind === 'region' && m.scope.regionId === regionId)))
  const weights = { ...next.routing.weights }
  delete weights[regionId]
  return {
    ...next, regions, managedServices,
    routing: { ...next.routing, weights, priorityOrder: next.routing.priorityOrder.filter(id => id !== regionId) },
  }
}

function stripDependencies(doc: WorldDoc, matches: (dep: ServiceBlueprint['dependencies'][number]) => boolean): WorldDoc {
  const blueprints = Object.fromEntries(Object.entries(doc.blueprints).map(([id, bp]) => [
    id, { ...bp, dependencies: bp.dependencies.filter(d => !matches(d)) },
  ]))
  return { ...doc, blueprints }
}

// ─── Store ───────────────────────────────────────────────────────────────────

interface WorldStore {
  doc: WorldDoc
  history: WorldDoc[]
  future: WorldDoc[]
  newWorld: () => void
  replaceWorld: (doc: WorldDoc) => void
  addRegion: (catalogId: string) => string
  removeRegion: (id: string) => void
  addAz: (regionId: string, label: string) => string
  removeAz: (id: string) => void
  addServer: (azId: string, preset: InstancePresetLike) => string
  updateServer: (id: string, patch: Partial<Server>) => void
  removeServer: (id: string) => void
  addBlueprint: (name: string) => string
  updateBlueprint: (id: string, patch: Partial<ServiceBlueprint>) => void
  removeBlueprint: (id: string) => void
  addPlacement: (blueprintId: string, serverId: string) => string
  updatePlacement: (id: string, patch: Partial<Placement>) => void
  removePlacement: (id: string) => void
  addManagedService: (nodeType: string, label: string, scope: ManagedScope, port: number) => string
  removeManagedService: (id: string) => void
  addPopulation: (label: string, lat: number, lon: number) => string
  updatePopulation: (id: string, patch: Partial<ClientPopulation>) => void
  removePopulation: (id: string) => void
  updateRouting: (patch: Partial<RoutingConfig>) => void
  updateTraffic: (patch: Partial<TrafficConfig>) => void
  pushHistory: () => void
  undo: () => void
  redo: () => void
}

export const useWorldStore = create<WorldStore>((set, get) => {
  // Wraps a doc-transform as a history-pushing mutation.
  const mutate = (fn: (doc: WorldDoc) => WorldDoc) => {
    get().pushHistory()
    set(s => ({ doc: fn(s.doc) }))
  }

  return {
    doc: createWorld(),
    history: [],
    future: [],

    newWorld: () => set({ doc: createWorld(), history: [], future: [] }),
    replaceWorld: (doc) => set({ doc, history: [], future: [] }),

    addRegion: (catalogId) => {
      const region = createRegion(catalogId)
      mutate(d => ({ ...d, regions: { ...d.regions, [region.id]: region } }))
      return region.id
    },
    removeRegion: (id) => mutate(d => withoutRegion(d, id)),

    addAz: (regionId, label) => {
      const az = createAz(regionId, label)
      mutate(d => ({ ...d, azs: { ...d.azs, [az.id]: az } }))
      return az.id
    },
    removeAz: (id) => mutate(d => withoutAz(d, id)),

    addServer: (azId, preset) => {
      const server = createServer(azId, preset)
      server.label = `server-${Object.keys(get().doc.servers).length + 1}`
      mutate(d => ({ ...d, servers: { ...d.servers, [server.id]: server } }))
      return server.id
    },
    updateServer: (id, patch) => mutate(d => {
      const existing = d.servers[id]
      if (!existing) return d
      return { ...d, servers: { ...d.servers, [id]: { ...existing, ...patch, id } } }
    }),
    removeServer: (id) => mutate(d => withoutServer(d, id)),

    addBlueprint: (name) => {
      const bp = createBlueprint(name, Object.keys(get().doc.blueprints).length)
      mutate(d => ({ ...d, blueprints: { ...d.blueprints, [bp.id]: bp } }))
      return bp.id
    },
    updateBlueprint: (id, patch) => mutate(d => {
      const existing = d.blueprints[id]
      if (!existing) return d
      return { ...d, blueprints: { ...d.blueprints, [id]: { ...existing, ...patch, id } } }
    }),
    removeBlueprint: (id) => mutate(d => {
      const blueprints = { ...d.blueprints }
      delete blueprints[id]
      const placements = Object.fromEntries(
        Object.entries(d.placements).filter(([, p]) => p.blueprintId !== id))
      return stripDependencies({ ...d, blueprints, placements },
        dep => dep.target.kind === 'blueprint' && dep.target.blueprintId === id)
    }),

    addPlacement: (blueprintId, serverId) => {
      const pl = createPlacement(blueprintId, serverId)
      mutate(d => ({ ...d, placements: { ...d.placements, [pl.id]: pl } }))
      return pl.id
    },
    updatePlacement: (id, patch) => mutate(d => {
      const existing = d.placements[id]
      if (!existing) return d
      return { ...d, placements: { ...d.placements, [id]: { ...existing, ...patch, id } } }
    }),
    removePlacement: (id) => mutate(d => {
      const placements = { ...d.placements }
      delete placements[id]
      return { ...d, placements }
    }),

    addManagedService: (nodeType, label, scope, port) => {
      const id = nextWorldId('ms')
      mutate(d => ({ ...d, managedServices: { ...d.managedServices, [id]: { id, label, nodeType, scope, provider: 'generic', port } } }))
      return id
    },
    removeManagedService: (id) => mutate(d => {
      const managedServices = { ...d.managedServices }
      delete managedServices[id]
      return stripDependencies({ ...d, managedServices },
        dep => dep.target.kind === 'managed' && dep.target.managedServiceId === id)
    }),

    addPopulation: (label, lat, lon) => {
      const pop = createPopulation(label, lat, lon)
      mutate(d => ({ ...d, populations: { ...d.populations, [pop.id]: pop } }))
      return pop.id
    },
    updatePopulation: (id, patch) => mutate(d => {
      const existing = d.populations[id]
      if (!existing) return d
      return { ...d, populations: { ...d.populations, [id]: { ...existing, ...patch, id } } }
    }),
    removePopulation: (id) => mutate(d => {
      const populations = { ...d.populations }
      delete populations[id]
      return { ...d, populations }
    }),

    updateRouting: (patch) => mutate(d => ({ ...d, routing: { ...d.routing, ...patch } })),
    updateTraffic: (patch) => mutate(d => ({ ...d, traffic: { ...d.traffic, ...patch } })),

    pushHistory: () => {
      const { doc, history } = get()
      const trimmed = history.length >= 100 ? history.slice(1) : history
      set({ history: [...trimmed, deepCopy(doc)], future: [] })
    },
    undo: () => {
      const { history, doc, future } = get()
      if (history.length === 0) return
      set({
        doc: history[history.length - 1],
        history: history.slice(0, -1),
        future: [deepCopy(doc), ...future],
      })
    },
    redo: () => {
      const { future, doc, history } = get()
      if (future.length === 0) return
      set({
        doc: future[0],
        history: [...history, deepCopy(doc)],
        future: future.slice(1),
      })
    },
  }
})
```

Also create the compile hook (no separate test — pure delegation to already-tested code):

```ts
// src/app/world/useCompiledWorld.ts
// Lives in app/ (not lib/world/) deliberately: lib/ must never import app stores.
import { useMemo } from 'react'
import { useWorldStore } from '../store/world.store'
import { compileWorld } from '../../lib/world/compileWorld'

export function useCompiledWorld() {
  const doc = useWorldStore(s => s.doc)
  return useMemo(() => compileWorld(doc), [doc])
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/store/world.store.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/app/store/world.store.ts src/app/store/world.store.test.ts src/app/world/useCompiledWorld.ts
git commit -m "feat(world): add world.store with cascading CRUD and undo/redo, plus useCompiledWorld hook"
```

---

### Task 8: `.scalemap` v2 serializer

**Files:**
- Modify: `src/lib/serializer.ts` (append v2 — leave the v1 `serialize`/`deserialize` exports byte-for-byte untouched; unmounted legacy UI still imports them)
- Test: `src/lib/serializer.test.ts`

**Interfaces:**
- Consumes: `WorldDoc` from `./world/types`, `PacketRegistry` from `./nodeConfig` (existing).
- Produces:
  - `WorldViewState = { level: 'globe' | 'region' | 'az' | 'server'; regionId?: string; azId?: string; serverId?: string }`
  - `ScalemapFileV2 = { version: '2'; meta: { name: string; created: string; modified: string }; world: WorldDoc; packets?: PacketRegistry; viewState?: WorldViewState }`
  - `serializeWorld(world: WorldDoc, name: string, created: string, packets?: PacketRegistry, viewState?: WorldViewState): string`
  - `deserializeWorld(raw: string): ScalemapFileV2` — throws with a v1-specific message for `version === '1'`, a generic unsupported-version message otherwise, and a shape error when `world` is missing.
- Task 10's nav store uses a structurally-identical level union; Task 12/14's file flows call these two functions.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/serializer.test.ts
import { describe, it, expect } from 'vitest'
import { serializeWorld, deserializeWorld } from './serializer'
import { createWorld, createRegion } from './world/factories'

describe('scalemap v2 serializer', () => {
  it('round-trips a world document with meta and viewState', () => {
    const world = createWorld()
    const region = createRegion('us-east-1')
    world.regions[region.id] = region
    const raw = serializeWorld(world, 'my-world', '2026-07-08T00:00:00.000Z', undefined, { level: 'region', regionId: region.id })
    const parsed = deserializeWorld(raw)
    expect(parsed.version).toBe('2')
    expect(parsed.meta.name).toBe('my-world')
    expect(parsed.meta.created).toBe('2026-07-08T00:00:00.000Z')
    expect(parsed.world.regions[region.id].catalogId).toBe('us-east-1')
    expect(parsed.viewState).toEqual({ level: 'region', regionId: region.id })
  })

  it('rejects v1 files with a message that names the old format', () => {
    const v1 = JSON.stringify({ version: '1', meta: {}, viewport: {}, nodes: [], edges: [] })
    expect(() => deserializeWorld(v1)).toThrowError(/v1|older/i)
  })

  it('rejects unknown versions and malformed shapes', () => {
    expect(() => deserializeWorld(JSON.stringify({ version: '3' }))).toThrowError(/version/i)
    expect(() => deserializeWorld(JSON.stringify({ version: '2' }))).toThrowError(/world/i)
    expect(() => deserializeWorld('not json')).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/serializer.test.ts`
Expected: FAIL — `serializeWorld` is not exported

- [ ] **Step 3: Append the v2 implementation to `src/lib/serializer.ts`**

```ts
// ─── .scalemap v2 (world model) ──────────────────────────────────────────────
// v1 exports above are retained ONLY so unmounted legacy UI keeps compiling; the app's
// live file flow (HomeScreen/WorldShell) uses exclusively the v2 functions below.
import type { WorldDoc } from './world/types'

export interface WorldViewState {
  level: 'globe' | 'region' | 'az' | 'server'
  regionId?: string
  azId?: string
  serverId?: string
}

export interface ScalemapFileV2 {
  version: '2'
  meta: { name: string; created: string; modified: string }
  world: WorldDoc
  packets?: PacketRegistry
  viewState?: WorldViewState
}

export function serializeWorld(
  world: WorldDoc,
  name: string,
  created: string,
  packets?: PacketRegistry,
  viewState?: WorldViewState,
): string {
  const file: ScalemapFileV2 = {
    version: '2',
    meta: { name, created, modified: new Date().toISOString() },
    world,
    ...(packets ? { packets } : {}),
    ...(viewState ? { viewState } : {}),
  }
  return JSON.stringify(file, null, 2)
}

export function deserializeWorld(raw: string): ScalemapFileV2 {
  const data = JSON.parse(raw) as Partial<ScalemapFileV2> & { version?: string }
  if (data.version === '1') {
    throw new Error('This is a v1 diagram from an older Scalemap and predates the world model — v1 files are not supported.')
  }
  if (data.version !== '2') {
    throw new Error(`Unsupported scalemap version: ${String(data.version)}`)
  }
  if (!data.world || typeof data.world !== 'object' || !('regions' in data.world)) {
    throw new Error('Invalid .scalemap file: missing world document')
  }
  return data as ScalemapFileV2
}
```

(`PacketRegistry` is already imported at the top of the file for v1 — reuse that import.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/serializer.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/serializer.ts src/lib/serializer.test.ts
git commit -m "feat(world): add .scalemap v2 serializer with v1 rejection"
```

### Task 9: Delete the structural linter + diagnostics

**Files:**
- Delete: `src/lib/lint/` (entire directory: `rules.ts`, `lintGraph.ts`, `classify.ts`, `types.ts`, plus any `*.test.ts` in it)
- Delete: `src/app/store/diagnostics.store.ts`
- Delete: `src/app/diagnostics/` (entire directory: `DiagnosticsPanel.tsx` + its `.module.css`)
- Modify: every remaining importer (enumerated below; verify with grep)

**Interfaces:**
- Consumes: nothing new.
- Produces: a tree with zero references to `lint`, `lintGraph`, `LintIssue`, `diagnostics.store`, or `DiagnosticsPanel`, and a green `npm run build`. The Analysis system replaces all of this in Phase 6 (spec §7); nothing in Phases 1–5 needs a shim.

- [ ] **Step 1: Enumerate every reference before deleting**

Run: `grep -rln "lint\|Lint\|diagnostics\|Diagnostics" src/ --include='*.ts' --include='*.tsx'`

Expected referencing files (from the CodeGraph index; the grep may surface more — treat
any extra hit the same way: remove the import and its usages):
- `src/app/toolbar/Toolbar.tsx` — calls `lintGraph` (2 call sites) and opens the diagnostics dock tab
- `src/app/dock/UtilityDock.tsx` — imports `DiagnosticsPanel`, renders the `Diagnostics` tab
- `src/App.tsx` — imports `useDiagnosticsStore`, calls `clearDiagnostics()` in the ⌘N handler (line ~76)
- `src/app/store/ui.store.ts` — `dockTab: 'diagnostics' | 'reports'` + `openDockTab`
- `src/app/canvas/nodes/BaseNode.tsx` — lint ring/color derived from diagnostics index
- `src/app/sidebar/PropertiesPanel.tsx` and/or `ContextMenu.tsx` — possible per-node issue strips

- [ ] **Step 2: Delete the linter and diagnostics modules**

```bash
git rm -r src/lib/lint src/app/diagnostics src/app/store/diagnostics.store.ts
```

- [ ] **Step 3: Fix each importer**

For each file from Step 1, apply the minimal removal (these files are legacy-unmounted
after Task 10 but MUST keep compiling):

- `Toolbar.tsx`: delete the `lintGraph`/diagnostics imports, the "run lint" invocation(s), and any Diagnostics button; leave the rest of the toolbar intact.
- `UtilityDock.tsx`: delete the `DiagnosticsPanel` import; collapse the tab strip to the single `Reports` tab (keep the dock shell working).
- `App.tsx`: delete the `useDiagnosticsStore` import and the `clearDiagnostics()` line.
- `ui.store.ts`: change `dockTab` to `'reports'` (single-member union), simplify `openDockTab` accordingly. Keep `highlightedNodeIds`/`setHighlightedNodes` — `Canvas.tsx`'s fitView effect and `BaseNode`'s pulse read them and they're diagnostics-agnostic.
- `BaseNode.tsx`: remove the lint-derived color/badge logic only (keep status/saturation coloring).
- Any other hit: remove the import + usage; do not leave commented-out code.

- [ ] **Step 4: Verify no references remain and the build is green**

Run: `grep -rn "lintGraph\|LintIssue\|diagnostics.store\|DiagnosticsPanel" src/ ; npm run build`
Expected: grep prints nothing (exit 1); `npm run build` succeeds.

Run: `npx vitest run`
Expected: PASS — the deleted `rules.test.ts` no longer runs; all remaining suites green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(world)!: delete structural linter and diagnostics (replaced by Analysis system in Phase 6)"
```

---

### Task 10: Navigation shell — nav.store, Breadcrumb, WorldShell, placeholder views

**Files:**
- Create: `src/app/store/nav.store.ts`
- Create: `src/app/world/WorldShell.tsx`
- Create: `src/app/world/Breadcrumb.tsx`
- Create: `src/app/world/GlobeView.tsx`
- Create: `src/app/world/RegionView.tsx`
- Create: `src/app/world/ServerView.tsx`
- Modify: `src/App.tsx` (mount WorldShell; unmount all legacy panels)
- Test: `src/app/store/nav.store.test.ts`, `src/app/world/Breadcrumb.test.tsx`

**Interfaces:**
- Consumes: `useWorldStore` (Task 7), `useCompiledWorld` (Task 7), `WORLD_REGIONS` (existing).
- Produces:
  - `useNavStore` with `WorldLevel = 'globe' | 'region' | 'az' | 'server'` and actions
    `goGlobe()`, `goRegion(regionId)`, `goAz(regionId, azId)`, `goServer(regionId, azId, serverId)`, `up()`
    (structurally compatible with Task 8's `WorldViewState`).
  - `<WorldShell />` — the app's entire post-home body. Task 13 swaps its AZ placeholder for
    `<AzCanvas />`; Task 14 adds file actions to its header.

- [ ] **Step 1: Write the failing nav.store test**

```ts
// src/app/store/nav.store.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useNavStore } from './nav.store'

beforeEach(() => useNavStore.getState().goGlobe())

describe('nav.store', () => {
  it('descends globe → region → az → server carrying full lineage', () => {
    useNavStore.getState().goServer('r1', 'az1', 'srv1')
    expect(useNavStore.getState()).toMatchObject({ level: 'server', regionId: 'r1', azId: 'az1', serverId: 'srv1' })
  })

  it('up() climbs one level at a time and clears the abandoned focus', () => {
    useNavStore.getState().goServer('r1', 'az1', 'srv1')
    useNavStore.getState().up()
    expect(useNavStore.getState()).toMatchObject({ level: 'az', azId: 'az1', serverId: null })
    useNavStore.getState().up()
    expect(useNavStore.getState()).toMatchObject({ level: 'region', regionId: 'r1', azId: null })
    useNavStore.getState().up()
    expect(useNavStore.getState()).toMatchObject({ level: 'globe', regionId: null })
    useNavStore.getState().up() // no-op at the top
    expect(useNavStore.getState().level).toBe('globe')
  })

  it('goRegion resets deeper focus', () => {
    useNavStore.getState().goServer('r1', 'az1', 'srv1')
    useNavStore.getState().goRegion('r2')
    expect(useNavStore.getState()).toMatchObject({ level: 'region', regionId: 'r2', azId: null, serverId: null })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/store/nav.store.test.ts`
Expected: FAIL — `Cannot find module './nav.store'`

- [ ] **Step 3: Write nav.store**

```ts
// src/app/store/nav.store.ts
import { create } from 'zustand'

export type WorldLevel = 'globe' | 'region' | 'az' | 'server'

interface NavStore {
  level: WorldLevel
  regionId: string | null
  azId: string | null
  serverId: string | null
  goGlobe: () => void
  goRegion: (regionId: string) => void
  goAz: (regionId: string, azId: string) => void
  goServer: (regionId: string, azId: string, serverId: string) => void
  up: () => void
}

export const useNavStore = create<NavStore>((set, get) => ({
  level: 'globe',
  regionId: null,
  azId: null,
  serverId: null,

  goGlobe: () => set({ level: 'globe', regionId: null, azId: null, serverId: null }),
  goRegion: (regionId) => set({ level: 'region', regionId, azId: null, serverId: null }),
  goAz: (regionId, azId) => set({ level: 'az', regionId, azId, serverId: null }),
  goServer: (regionId, azId, serverId) => set({ level: 'server', regionId, azId, serverId }),

  up: () => {
    const { level, regionId, azId } = get()
    if (level === 'server' && regionId && azId) return get().goAz(regionId, azId)
    if (level === 'az' && regionId) return get().goRegion(regionId)
    if (level === 'region') return get().goGlobe()
  },
}))
```

- [ ] **Step 4: Run nav test to verify it passes**

Run: `npx vitest run src/app/store/nav.store.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the Breadcrumb + its failing test, then the component**

Setup prerequisite: `toBeInTheDocument` needs jest-dom's vitest matchers. Open
`vitest.setup.ts` (repo root, already wired via `vite.config.ts`'s `test.setupFiles`) and
add `import '@testing-library/jest-dom/vitest'` as its first line if it isn't there.

Test first:

```tsx
// src/app/world/Breadcrumb.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Breadcrumb } from './Breadcrumb'
import { useNavStore } from '../store/nav.store'
import { useWorldStore } from '../store/world.store'
import { getPreset } from '../../lib/world/instanceCatalog'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useNavStore.getState().goGlobe()
})

describe('Breadcrumb', () => {
  it('renders the full lineage at server level and climbs on segment click', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    useNavStore.getState().goServer(regionId, azId, serverId)

    render(<Breadcrumb />)
    expect(screen.getByText('World')).toBeInTheDocument()
    expect(screen.getByText(/us-east-1a/)).toBeInTheDocument()

    fireEvent.click(screen.getByText('us-east-1'))
    expect(useNavStore.getState().level).toBe('region')
  })

  it('renders only World at globe level', () => {
    render(<Breadcrumb />)
    expect(screen.getByText('World')).toBeInTheDocument()
    expect(screen.queryByText('us-east-1')).not.toBeInTheDocument()
  })
})
```

Run: `npx vitest run src/app/world/Breadcrumb.test.tsx` → FAIL (`Cannot find module './Breadcrumb'`), then implement:

```tsx
// src/app/world/Breadcrumb.tsx
import type { CSSProperties } from 'react'
import { useNavStore } from '../store/nav.store'
import { useWorldStore } from '../store/world.store'

const seg: CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px',
  font: '500 12px var(--font-mono)', color: 'var(--color-text-secondary)',
}
const current: CSSProperties = { ...seg, cursor: 'default', color: 'var(--color-text-primary)' }
const sep = <span style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>›</span>

export function Breadcrumb() {
  const nav = useNavStore()
  const doc = useWorldStore(s => s.doc)

  const region = nav.regionId ? doc.regions[nav.regionId] : null
  const az = nav.azId ? doc.azs[nav.azId] : null
  const server = nav.serverId ? doc.servers[nav.serverId] : null

  const parts: { label: string; onClick: (() => void) | null }[] = [
    { label: 'World', onClick: nav.level === 'globe' ? null : () => nav.goGlobe() },
  ]
  if (region) parts.push({
    label: region.catalogId,
    onClick: nav.level === 'region' ? null : () => nav.goRegion(region.id),
  })
  if (az) parts.push({
    label: az.label,
    onClick: nav.level === 'az' ? null : () => nav.goAz(az.regionId, az.id),
  })
  if (server) parts.push({ label: server.label, onClick: null })

  return (
    <nav style={{ display: 'flex', alignItems: 'center', gap: 4 }} aria-label="World navigation">
      {parts.map((p, i) => (
        <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {i > 0 && sep}
          {p.onClick
            ? <button style={seg} onClick={p.onClick}>{p.label}</button>
            : <span style={current}>{p.label}</span>}
        </span>
      ))}
    </nav>
  )
}
```

Run: `npx vitest run src/app/world/Breadcrumb.test.tsx` → PASS (2 tests).

- [ ] **Step 6: Write the placeholder views**

These are deliberately spartan — Phases 3–5 replace their bodies with the approved mockup
designs; only the data wiring and navigation contracts matter here.

```tsx
// src/app/world/GlobeView.tsx
// Phase-1 placeholder for the Level-1 globe (real three.js globe lands in Phase 5).
import type { CSSProperties } from 'react'
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { useCompiledWorld } from './useCompiledWorld'
import { WORLD_REGIONS } from '../../lib/regionConfig'

const card: CSSProperties = {
  background: 'var(--color-surface)', border: '1px solid var(--color-node-border)',
  borderRadius: 10, padding: 14, cursor: 'pointer', textAlign: 'left',
  font: '12px var(--font-mono)', color: 'var(--color-text-primary)',
}

export function GlobeView() {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const goRegion = useNavStore(s => s.goRegion)
  const regions = Object.values(doc.regions)

  return (
    <div style={{ padding: 24 }}>
      <div style={{ font: '600 14px var(--font-mono)', color: 'var(--color-text-primary)', marginBottom: 4 }}>
        World — {regions.length} region{regions.length === 1 ? '' : 's'} · {Object.keys(compiled.instances).length} service instances
      </div>
      <div style={{ font: '11px var(--font-mono)', color: 'var(--color-text-muted)', marginBottom: 16 }}>
        {compiled.findings.length > 0
          ? `${compiled.findings.length} finding(s) — see the World panel`
          : 'no findings'}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
        {regions.map(r => {
          const azs = Object.values(doc.azs).filter(a => a.regionId === r.id)
          const serverCount = Object.values(doc.servers).filter(s => azs.some(a => a.id === s.azId)).length
          const label = WORLD_REGIONS.find(w => w.id === r.catalogId)?.label ?? r.catalogId
          return (
            <button key={r.id} style={card} onClick={() => goRegion(r.id)}>
              <div style={{ fontWeight: 600 }}>{r.catalogId}</div>
              <div style={{ color: 'var(--color-text-secondary)', marginTop: 2 }}>{label}</div>
              <div style={{ color: 'var(--color-text-muted)', marginTop: 8 }}>
                {azs.length} AZ · {serverCount} server{serverCount === 1 ? '' : 's'} · {r.role}
              </div>
            </button>
          )
        })}
        {regions.length === 0 && (
          <div style={{ color: 'var(--color-text-muted)', font: '12px var(--font-mono)' }}>
            No regions yet — add one in the World panel →
          </div>
        )}
      </div>
    </div>
  )
}
```

```tsx
// src/app/world/RegionView.tsx
// Phase-1 placeholder for the Level-2 region flow page (real design lands in Phase 4).
import type { CSSProperties } from 'react'
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { useCompiledWorld } from './useCompiledWorld'

const card: CSSProperties = {
  background: 'var(--color-surface)', border: '1px solid var(--color-node-border)',
  borderRadius: 10, padding: 14, cursor: 'pointer', textAlign: 'left',
  font: '12px var(--font-mono)', color: 'var(--color-text-primary)',
}

export function RegionView() {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const { regionId, goAz } = useNavStore()
  if (!regionId || !doc.regions[regionId]) return null
  const azs = Object.values(doc.azs).filter(a => a.regionId === regionId)

  return (
    <div style={{ padding: 24 }}>
      <div style={{ font: '600 14px var(--font-mono)', color: 'var(--color-text-primary)', marginBottom: 16 }}>
        {doc.regions[regionId].catalogId} — {azs.length} availability zone{azs.length === 1 ? '' : 's'}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
        {azs.map(az => {
          const servers = Object.values(doc.servers).filter(s => s.azId === az.id)
          const instanceCount = Object.values(compiled.instances).filter(i => i.azId === az.id).length
          return (
            <button key={az.id} style={card} onClick={() => goAz(regionId, az.id)}>
              <div style={{ fontWeight: 600 }}>{az.label}</div>
              <div style={{ color: 'var(--color-text-muted)', marginTop: 8 }}>
                {servers.length} server{servers.length === 1 ? '' : 's'} · {instanceCount} instance{instanceCount === 1 ? '' : 's'}
              </div>
            </button>
          )
        })}
        {azs.length === 0 && (
          <div style={{ color: 'var(--color-text-muted)', font: '12px var(--font-mono)' }}>
            No AZs yet — add one in the World panel →
          </div>
        )}
      </div>
    </div>
  )
}
```

```tsx
// src/app/world/ServerView.tsx
// Phase-1 placeholder for the Level-4 circuit-board view (Phase 3): a faithful readout of
// everything compiled for this server, so the model is verifiable end-to-end today.
import type { CSSProperties } from 'react'
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { useCompiledWorld } from './useCompiledWorld'

const section: CSSProperties = {
  background: 'var(--color-surface)', border: '1px solid var(--color-node-border)',
  borderRadius: 10, padding: 14, font: '12px var(--font-mono)', color: 'var(--color-text-primary)',
}

export function ServerView() {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const serverId = useNavStore(s => s.serverId)
  const server = serverId ? doc.servers[serverId] : null
  if (!server) return null

  const instances = Object.values(compiled.instances).filter(i => i.serverId === server.id)

  return (
    <div style={{ padding: 24, display: 'grid', gap: 12, maxWidth: 720 }}>
      <div style={section}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{server.label}</div>
        <div style={{ color: 'var(--color-text-secondary)', marginTop: 4 }}>
          {server.kind} · {server.specs.vcpu} vCPU / {Math.round(server.specs.ramMb / 1024)} GB · {server.specs.diskGb} GB disk · {server.specs.nicMbps} Mbps
          {server.kind === 'vps' && server.oversubscriptionRatio ? ` · ${server.oversubscriptionRatio}:1 oversubscribed` : ''}
          {' '}· ${server.hourlyUsd.toFixed(3)}/hr
        </div>
      </div>

      <div style={section}>
        <div style={{ color: 'var(--color-text-muted)', marginBottom: 8 }}>SERVICES ({instances.length})</div>
        {instances.map(i => {
          const bp = doc.blueprints[i.blueprintId]
          const pl = doc.placements[i.placementId]
          return (
            <div key={i.id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: bp?.color ?? 'var(--color-text-muted)' }} />
              <span>{bp?.name ?? i.blueprintId}</span>
              <span style={{ color: 'var(--color-text-muted)' }}>
                {i.role} · {pl?.runtime.type ?? 'process'}
                {pl?.runtime.type === 'container' ? ` (stack: ${pl.runtime.stackName})` : ''}
              </span>
            </div>
          )
        })}
        {instances.length === 0 && <div style={{ color: 'var(--color-text-muted)' }}>nothing deployed — add a placement in the World panel</div>}
      </div>

      <div style={section}>
        <div style={{ color: 'var(--color-text-muted)', marginBottom: 8 }}>FIREWALL ({server.firewall.length} rules, default deny)</div>
        {server.firewall.map(r => (
          <div key={r.id} style={{ color: r.action === 'allow' ? 'var(--color-success)' : 'var(--color-danger)' }}>
            {r.action.toUpperCase()} :{r.port} {r.protocol} from {r.source}
          </div>
        ))}
      </div>

      {server.stacks.length > 0 && (
        <div style={section}>
          <div style={{ color: 'var(--color-text-muted)', marginBottom: 8 }}>COMPOSE STACKS</div>
          {server.stacks.map(st => (
            <div key={st.name} style={{ marginBottom: 6 }}>
              <div>{st.name}</div>
              <div style={{ color: 'var(--color-text-muted)' }}>
                nets: {st.networks.map(n => `${n.name} (${n.cidr})`).join(', ') || '—'} · vols: {st.volumes.map(v => `${v.name} ${v.sizeGb}GB`).join(', ') || '—'}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 7: Write WorldShell and rewire App.tsx**

```tsx
// src/app/world/WorldShell.tsx
// The app's entire post-home body: breadcrumb header + animated level router.
// Task 13 replaces the AZ placeholder with <AzCanvas/>; Task 14 adds file actions here.
import { useEffect } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useNavStore } from '../store/nav.store'
import { Breadcrumb } from './Breadcrumb'
import { GlobeView } from './GlobeView'
import { RegionView } from './RegionView'
import { ServerView } from './ServerView'
import { WorldPanel } from './panels/WorldPanel'

function AzView() {
  // Placeholder until Task 13's AzCanvas.
  return <div style={{ padding: 24, font: '12px var(--font-mono)', color: 'var(--color-text-muted)' }}>AZ canvas arrives in Task 13.</div>
}

export function WorldShell() {
  const nav = useNavStore()
  const reduced = useReducedMotion()

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useNavStore.getState().up()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const view =
    nav.level === 'globe' ? <GlobeView /> :
    nav.level === 'region' ? <RegionView /> :
    nav.level === 'az' ? <AzView /> :
    <ServerView />

  // Key by full focus path so descending re-animates even within one level.
  const viewKey = `${nav.level}:${nav.regionId ?? ''}:${nav.azId ?? ''}:${nav.serverId ?? ''}`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: 'var(--color-canvas-bg)' }}>
      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 16px', borderBottom: '1px solid var(--color-toolbar-border)',
        background: 'var(--color-toolbar)',
      }}>
        <Breadcrumb />
        <span style={{ font: '10px var(--font-mono)', color: 'var(--color-text-muted)' }}>esc = up one level</span>
      </header>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <main style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
          <AnimatePresence mode="wait">
            <motion.div
              key={viewKey}
              initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
              animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 1.04 }}
              transition={{ duration: 0.18 }}
              style={{ height: '100%' }}
            >
              {view}
            </motion.div>
          </AnimatePresence>
        </main>
        <WorldPanel />
      </div>
    </div>
  )
}
```

Note: `WorldPanel` doesn't exist until Task 11. **For this task only**, create the stub
below so the build stays green; Task 11 replaces it wholesale:

```tsx
// src/app/world/panels/WorldPanel.tsx  (Task-10 stub — replaced in Task 11)
export function WorldPanel() {
  return null
}
```

Then modify `src/App.tsx`: keep `useThemeBootstrap`, the font imports, and the
`showHome ? <HomeScreen/> : …` gate, but the non-home branch becomes exactly
`<WorldShell />`. Remove the imports/mounts of `Toolbar`, `NodePalette`, `Canvas`,
`PropertiesPanel`, `StatusBar`, `MetricsDrawer`, `SimConfigPanel`, `UtilityDock`,
`PacketEditor`, the `drawerOpen` state + its effects, the 30s v1 autosave effect
(v2 autosave arrives in Task 14), and change the ⌘N handler body to:

```ts
useWorldStore.getState().newWorld()
useFileStore.getState().setFilePath(null)
useFileStore.getState().setShowHome(false)
```

(with `useWorldStore` imported from `./app/store/world.store` and the now-unused store
imports removed). `HomeScreen` still compiles against v1 flows until Task 12 rewires it —
do not touch it in this task.

- [ ] **Step 8: Verify build + tests + manual smoke**

Run: `npm run build` → succeeds.
Run: `npx vitest run` → all suites green.
Run: `npm run dev`, open http://localhost:1420 → from Home, "New Diagram" still opens the
old-canvas… **no** — after this task it opens `WorldShell` at globe level showing "No
regions yet". Breadcrumb shows `World`. (Authoring arrives in Task 11, so the world is
empty; that's expected.)

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(world): add navigation shell (nav.store, breadcrumb, level router) and mount it as the app body"
```

### Task 11: Authoring — WorldPanel shell + TopologyPanel (regions / AZs / servers / firewall / stacks)

**Files:**
- Create: `src/app/world/panels/WorldPanel.tsx` (replaces the Task-10 stub wholesale)
- Create: `src/app/world/panels/TopologyPanel.tsx`
- Test: `src/app/world/panels/TopologyPanel.test.tsx`

**Interfaces:**
- Consumes: `useWorldStore` actions (Task 7), `INSTANCE_CATALOG`/`getPreset` (Task 3), `WORLD_REGIONS` (existing), `useNavStore` (Task 10).
- Produces: `<WorldPanel />` — a 300px right-side dock with a `Topology | Blueprints | Placements` tab strip. This task implements the shell + Topology tab; Task 12 fills the other two (they render `null` stubs here, replaced in Task 12).

Shared form styling: create one tiny style constants module used by all three panels —

```tsx
// src/app/world/panels/panelStyles.ts
import type { CSSProperties } from 'react'

export const panel: CSSProperties = {
  width: 300, flexShrink: 0, overflowY: 'auto', padding: 12,
  borderLeft: '1px solid var(--color-toolbar-border)', background: 'var(--color-surface)',
  font: '11px var(--font-mono)', color: 'var(--color-text-primary)',
}
export const sectionLabel: CSSProperties = {
  font: '600 10px var(--font-mono)', color: 'var(--color-text-muted)',
  textTransform: 'uppercase', letterSpacing: '0.06em', margin: '12px 0 6px',
}
export const field: CSSProperties = {
  width: '100%', boxSizing: 'border-box', background: 'var(--color-node-base)',
  border: '1px solid var(--color-node-border)', borderRadius: 4, padding: '4px 6px',
  font: '11px var(--font-mono)', color: 'var(--color-text-primary)', marginBottom: 4,
}
export const smallBtn: CSSProperties = {
  background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
  borderRadius: 4, padding: '3px 8px', cursor: 'pointer',
  font: '11px var(--font-mono)', color: 'var(--color-text-secondary)',
}
export const dangerBtn: CSSProperties = { ...smallBtn, color: 'var(--color-danger)' }
export const row: CSSProperties = { display: 'flex', gap: 4, alignItems: 'center', marginBottom: 4 }
```

- [ ] **Step 1: Write the failing test**

```tsx
// src/app/world/panels/TopologyPanel.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TopologyPanel } from './TopologyPanel'
import { useWorldStore } from '../../store/world.store'

beforeEach(() => useWorldStore.getState().newWorld())

describe('TopologyPanel', () => {
  it('adds a region from the catalog select', () => {
    render(<TopologyPanel />)
    fireEvent.change(screen.getByLabelText('add-region-select'), { target: { value: 'eu-west-1' } })
    fireEvent.click(screen.getByText('+ Region'))
    const regions = Object.values(useWorldStore.getState().doc.regions)
    expect(regions).toHaveLength(1)
    expect(regions[0].catalogId).toBe('eu-west-1')
  })

  it('adds an AZ with an auto-suffixed label, then a server from a preset', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    render(<TopologyPanel />)
    fireEvent.click(screen.getByText('+ AZ'))
    const azs = Object.values(useWorldStore.getState().doc.azs)
    expect(azs).toHaveLength(1)
    expect(azs[0]).toMatchObject({ regionId, label: 'us-east-1a' })

    fireEvent.click(screen.getByText('+ Server'))
    const servers = Object.values(useWorldStore.getState().doc.servers)
    expect(servers).toHaveLength(1)
    expect(servers[0].azId).toBe(azs[0].id)
  })

  it('adds a firewall rule to an expanded server', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, { id: 'vps-small', kind: 'vps', specs: { vcpu: 2, threadsPerCore: 1, ramMb: 4096, diskGb: 40, nicMbps: 500 }, hourlyUsd: 0.018, oversubscriptionRatio: 6, burstable: true })
    render(<TopologyPanel />)
    fireEvent.click(screen.getByText(/server-1/))       // expand the server editor
    fireEvent.click(screen.getByText('+ Rule'))
    const server = Object.values(useWorldStore.getState().doc.servers)[0]
    expect(server.firewall.length).toBe(2)              // default-internal + new rule
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/world/panels/TopologyPanel.test.tsx`
Expected: FAIL — `Cannot find module './TopologyPanel'`

- [ ] **Step 3: Write TopologyPanel**

```tsx
// src/app/world/panels/TopologyPanel.tsx
// Region → AZ → server authoring, including per-server firewall + compose-stack editing.
import { useState } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import { WORLD_REGIONS } from '../../../lib/regionConfig'
import { INSTANCE_CATALOG, getPreset } from '../../../lib/world/instanceCatalog'
import { nextWorldId } from '../../../lib/world/factories'
import type { Server } from '../../../lib/world/types'
import { sectionLabel, field, smallBtn, dangerBtn, row } from './panelStyles'

export function TopologyPanel() {
  const doc = useWorldStore(s => s.doc)
  const store = useWorldStore.getState()
  const [newRegion, setNewRegion] = useState(WORLD_REGIONS[0].id)
  const [presetByAz, setPresetByAz] = useState<Record<string, string>>({})
  const [expandedServer, setExpandedServer] = useState<string | null>(null)

  const available = WORLD_REGIONS.filter(w => !Object.values(doc.regions).some(r => r.catalogId === w.id))

  const nextAzLabel = (catalogId: string, regionId: string) => {
    const count = Object.values(doc.azs).filter(a => a.regionId === regionId).length
    return `${catalogId}${String.fromCharCode(97 + count)}`   // a, b, c…
  }

  return (
    <div>
      <div style={sectionLabel}>Regions</div>
      <div style={row}>
        <select aria-label="add-region-select" style={{ ...field, marginBottom: 0, flex: 1 }}
          value={newRegion} onChange={e => setNewRegion(e.target.value)}>
          {available.map(w => <option key={w.id} value={w.id}>{w.id}</option>)}
        </select>
        <button style={smallBtn} disabled={available.length === 0}
          onClick={() => store.addRegion(newRegion)}>+ Region</button>
      </div>

      {Object.values(doc.regions).map(region => (
        <div key={region.id} style={{ border: '1px solid var(--color-node-border)', borderRadius: 6, padding: 8, marginTop: 8 }}>
          <div style={row}>
            <strong style={{ flex: 1 }}>{region.catalogId}</strong>
            <select style={{ ...field, width: 76, marginBottom: 0 }} value={region.role}
              onChange={e => useWorldStore.setState(s => ({ doc: { ...s.doc, regions: { ...s.doc.regions, [region.id]: { ...region, role: e.target.value as 'active' | 'passive' } } } }))}>
              <option value="active">active</option>
              <option value="passive">passive</option>
            </select>
            <button style={dangerBtn} onClick={() => store.removeRegion(region.id)}>×</button>
          </div>
          <button style={smallBtn} onClick={() => store.addAz(region.id, nextAzLabel(region.catalogId, region.id))}>+ AZ</button>

          {Object.values(doc.azs).filter(a => a.regionId === region.id).map(az => (
            <div key={az.id} style={{ marginTop: 6, paddingLeft: 8, borderLeft: '2px solid var(--color-node-border)' }}>
              <div style={row}>
                <span style={{ flex: 1 }}>{az.label}</span>
                <button style={dangerBtn} onClick={() => store.removeAz(az.id)}>×</button>
              </div>
              <div style={row}>
                <select style={{ ...field, marginBottom: 0, flex: 1 }}
                  value={presetByAz[az.id] ?? 'vps-medium'}
                  onChange={e => setPresetByAz(p => ({ ...p, [az.id]: e.target.value }))}>
                  {INSTANCE_CATALOG.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
                <button style={smallBtn}
                  onClick={() => store.addServer(az.id, getPreset(presetByAz[az.id] ?? 'vps-medium')!)}>+ Server</button>
              </div>

              {Object.values(doc.servers).filter(sv => sv.azId === az.id).map(server => (
                <ServerRow key={server.id} server={server}
                  expanded={expandedServer === server.id}
                  onToggle={() => setExpandedServer(e => e === server.id ? null : server.id)} />
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function ServerRow({ server, expanded, onToggle }: { server: Server; expanded: boolean; onToggle: () => void }) {
  const store = useWorldStore.getState()
  const nav = useNavStore.getState()
  const doc = useWorldStore(s => s.doc)
  const az = doc.azs[server.azId]

  const upd = (patch: Partial<Server>) => store.updateServer(server.id, patch)

  return (
    <div style={{ marginTop: 4, background: 'var(--color-node-base)', borderRadius: 4, padding: 6 }}>
      <div style={row}>
        <button style={{ ...smallBtn, border: 'none', padding: 0, flex: 1, textAlign: 'left' }} onClick={onToggle}>
          {expanded ? '▾' : '▸'} {server.label} <span style={{ color: 'var(--color-text-muted)' }}>({server.kind})</span>
        </button>
        {az && <button style={smallBtn} title="Open server view"
          onClick={() => nav.goServer(az.regionId, az.id, server.id)}>→</button>}
        <button style={dangerBtn} onClick={() => store.removeServer(server.id)}>×</button>
      </div>

      {expanded && (
        <div style={{ marginTop: 6 }}>
          <input style={field} value={server.label} aria-label="server-label"
            onChange={e => upd({ label: e.target.value })} />

          <div style={sectionLabel}>Firewall (top-down, default deny)</div>
          {server.firewall.map((r, i) => (
            <div key={r.id} style={row}>
              <select style={{ ...field, width: 60, marginBottom: 0 }} value={r.action}
                onChange={e => upd({ firewall: server.firewall.map((x, j) => j === i ? { ...x, action: e.target.value as 'allow' | 'deny' } : x) })}>
                <option value="allow">allow</option><option value="deny">deny</option>
              </select>
              <input style={{ ...field, width: 56, marginBottom: 0 }} value={String(r.port)} aria-label={`fw-port-${i}`}
                onChange={e => {
                  const v = e.target.value.trim()
                  upd({ firewall: server.firewall.map((x, j) => j === i ? { ...x, port: v === 'any' ? 'any' : Number(v) || 0 } : x) })
                }} />
              <select style={{ ...field, width: 56, marginBottom: 0 }} value={r.protocol}
                onChange={e => upd({ firewall: server.firewall.map((x, j) => j === i ? { ...x, protocol: e.target.value as 'tcp' | 'udp' | 'any' } : x) })}>
                <option value="tcp">tcp</option><option value="udp">udp</option><option value="any">any</option>
              </select>
              <select style={{ ...field, width: 78, marginBottom: 0 }} value={r.source === 'any' || r.source === 'internal' ? r.source : 'cidr'}
                onChange={e => upd({ firewall: server.firewall.map((x, j) => j === i ? { ...x, source: e.target.value === 'cidr' ? '10.0.0.0/8' : e.target.value } : x) })}>
                <option value="internal">internal</option><option value="any">any</option><option value="cidr">cidr…</option>
              </select>
              <button style={dangerBtn} onClick={() => upd({ firewall: server.firewall.filter((_, j) => j !== i) })}>×</button>
            </div>
          ))}
          <button style={smallBtn}
            onClick={() => upd({ firewall: [...server.firewall, { id: nextWorldId('fw'), action: 'allow', port: 443, protocol: 'tcp', source: 'any' }] })}>
            + Rule
          </button>

          <div style={sectionLabel}>Compose stacks</div>
          {server.stacks.map((st, i) => (
            <div key={st.name + i} style={{ marginBottom: 6 }}>
              <div style={row}>
                <input style={{ ...field, marginBottom: 0, flex: 1 }} value={st.name} aria-label={`stack-name-${i}`}
                  onChange={e => upd({ stacks: server.stacks.map((x, j) => j === i ? { ...x, name: e.target.value } : x) })} />
                <button style={dangerBtn} onClick={() => upd({ stacks: server.stacks.filter((_, j) => j !== i) })}>×</button>
              </div>
              <input style={field} placeholder="networks: name@cidr, name@cidr" aria-label={`stack-nets-${i}`}
                value={st.networks.map(n => `${n.name}@${n.cidr}`).join(', ')}
                onChange={e => upd({ stacks: server.stacks.map((x, j) => j === i ? {
                  ...x,
                  networks: e.target.value.split(',').map(t => t.trim()).filter(Boolean).map(t => {
                    const [name, cidr] = t.split('@')
                    return { name: name?.trim() ?? '', cidr: cidr?.trim() ?? '172.18.0.0/16' }
                  }),
                } : x) })} />
              <input style={field} placeholder="volumes: name@sizeGb, name@sizeGb" aria-label={`stack-vols-${i}`}
                value={st.volumes.map(v => `${v.name}@${v.sizeGb}`).join(', ')}
                onChange={e => upd({ stacks: server.stacks.map((x, j) => j === i ? {
                  ...x,
                  volumes: e.target.value.split(',').map(t => t.trim()).filter(Boolean).map(t => {
                    const [name, size] = t.split('@')
                    return { name: name?.trim() ?? '', sizeGb: Number(size) || 10 }
                  }),
                } : x) })} />
            </div>
          ))}
          <button style={smallBtn}
            onClick={() => upd({ stacks: [...server.stacks, { name: `stack-${server.stacks.length + 1}`, networks: [{ name: 'default', cidr: '172.18.0.0/16' }], volumes: [] }] })}>
            + Stack
          </button>
        </div>
      )}
    </div>
  )
}
```

Note the region-role select writes via `useWorldStore.setState` directly (no dedicated
action, and deliberately no history push for a two-value toggle) — acceptable for Phase 1;
if undo for role changes is wanted later, add an `updateRegion` action then.

- [ ] **Step 4: Write WorldPanel (replacing the Task-10 stub)**

```tsx
// src/app/world/panels/WorldPanel.tsx
import { useState } from 'react'
import { TopologyPanel } from './TopologyPanel'
import { panel, smallBtn } from './panelStyles'

// Filled in Task 12:
function BlueprintPanel() { return null }
function PlacementPanel() { return null }

type Tab = 'topology' | 'blueprints' | 'placements'

export function WorldPanel() {
  const [tab, setTab] = useState<Tab>('topology')
  const tabs: { id: Tab; label: string }[] = [
    { id: 'topology', label: 'Topology' },
    { id: 'blueprints', label: 'Blueprints' },
    { id: 'placements', label: 'Placements' },
  ]
  return (
    <aside style={panel}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
        {tabs.map(t => (
          <button key={t.id}
            style={{ ...smallBtn, ...(tab === t.id ? { color: 'var(--color-text-primary)', borderColor: 'var(--color-text-muted)' } : {}) }}
            onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'topology' && <TopologyPanel />}
      {tab === 'blueprints' && <BlueprintPanel />}
      {tab === 'placements' && <PlacementPanel />}
    </aside>
  )
}
```

- [ ] **Step 5: Run tests + build, verify authoring manually**

Run: `npx vitest run src/app/world/panels/TopologyPanel.test.tsx` → PASS (3 tests).
Run: `npm run build` → succeeds.
Run: `npm run dev` → from Home → new world → add region/AZ/server in the panel; the
GlobeView cards update live; clicking `→` on a server jumps to ServerView showing its
firewall.

- [ ] **Step 6: Commit**

```bash
git add src/app/world/panels/
git commit -m "feat(world): add WorldPanel shell and Topology authoring panel"
```

---

### Task 12: Authoring — BlueprintPanel, PlacementPanel, HomeScreen rewire

**Files:**
- Create: `src/app/world/panels/BlueprintPanel.tsx`
- Create: `src/app/world/panels/PlacementPanel.tsx`
- Modify: `src/app/world/panels/WorldPanel.tsx` (import the real panels, delete the stubs)
- Modify: `src/app/home/HomeScreen.tsx` (v2 file flow, drop vault templates)
- Test: `src/app/world/panels/BlueprintPanel.test.tsx`

**Interfaces:**
- Consumes: Task 7 store actions, Task 8's `deserializeWorld`, existing `loadDiagram` tauri wrapper + `useFileStore`.
- Produces: complete authoring for blueprints (ports, workload, stateful/volume, dependencies), placements (server, count, role, runtime incl. container stack/networks/mappings/limits), and managed services; HomeScreen that opens v2 worlds.

- [ ] **Step 1: Write the failing test**

```tsx
// src/app/world/panels/BlueprintPanel.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BlueprintPanel } from './BlueprintPanel'
import { useWorldStore } from '../../store/world.store'

beforeEach(() => useWorldStore.getState().newWorld())

describe('BlueprintPanel', () => {
  it('adds a blueprint by name', () => {
    render(<BlueprintPanel />)
    fireEvent.change(screen.getByPlaceholderText('new blueprint name'), { target: { value: 'api' } })
    fireEvent.click(screen.getByText('+ Blueprint'))
    expect(Object.values(useWorldStore.getState().doc.blueprints)[0].name).toBe('api')
  })

  it('adds a dependency between two blueprints', () => {
    const apiId = useWorldStore.getState().addBlueprint('api')
    useWorldStore.getState().addBlueprint('pg')
    render(<BlueprintPanel />)
    fireEvent.click(screen.getAllByText('▸ deps')[0])         // expand api's dependency editor
    fireEvent.click(screen.getByText('+ Dependency'))
    const api = useWorldStore.getState().doc.blueprints[apiId]
    expect(api.dependencies).toHaveLength(1)
    expect(api.dependencies[0].target.kind).toBe('blueprint')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/world/panels/BlueprintPanel.test.tsx`
Expected: FAIL — `Cannot find module './BlueprintPanel'`

- [ ] **Step 3: Write BlueprintPanel**

```tsx
// src/app/world/panels/BlueprintPanel.tsx
import { useState } from 'react'
import { useWorldStore } from '../../store/world.store'
import { nextWorldId } from '../../../lib/world/factories'
import type { ServiceBlueprint, BlueprintDependency } from '../../../lib/world/types'
import { sectionLabel, field, smallBtn, dangerBtn, row } from './panelStyles'

export function BlueprintPanel() {
  const doc = useWorldStore(s => s.doc)
  const store = useWorldStore.getState()
  const [name, setName] = useState('')

  return (
    <div>
      <div style={sectionLabel}>Blueprints</div>
      <div style={row}>
        <input style={{ ...field, marginBottom: 0, flex: 1 }} placeholder="new blueprint name"
          value={name} onChange={e => setName(e.target.value)} />
        <button style={smallBtn} disabled={!name.trim()}
          onClick={() => { store.addBlueprint(name.trim()); setName('') }}>+ Blueprint</button>
      </div>
      {Object.values(doc.blueprints).map(bp => <BlueprintCard key={bp.id} bp={bp} />)}
    </div>
  )
}

function BlueprintCard({ bp }: { bp: ServiceBlueprint }) {
  const doc = useWorldStore(s => s.doc)
  const store = useWorldStore.getState()
  const [showDeps, setShowDeps] = useState(false)
  const upd = (patch: Partial<ServiceBlueprint>) => store.updateBlueprint(bp.id, patch)

  const targets = [
    ...Object.values(doc.blueprints).filter(b => b.id !== bp.id).map(b => ({ key: `bp:${b.id}`, label: b.name })),
    ...Object.values(doc.managedServices).map(m => ({ key: `ms:${m.id}`, label: `${m.label} (managed)` })),
  ]

  const addDep = () => {
    if (targets.length === 0) return
    const [kind, id] = targets[0].key.split(':')
    const dep: BlueprintDependency = {
      id: nextWorldId('dep'),
      target: kind === 'bp' ? { kind: 'blueprint', blueprintId: id } : { kind: 'managed', managedServiceId: id },
      port: 8080, protocol: 'http', packetTemplateId: null,
    }
    upd({ dependencies: [...bp.dependencies, dep] })
  }

  const setDepTarget = (i: number, key: string) => {
    const [kind, id] = key.split(':')
    upd({ dependencies: bp.dependencies.map((d, j) => j === i ? {
      ...d, target: kind === 'bp' ? { kind: 'blueprint', blueprintId: id } : { kind: 'managed', managedServiceId: id },
    } : d) })
  }

  return (
    <div style={{ border: '1px solid var(--color-node-border)', borderRadius: 6, padding: 8, marginTop: 8 }}>
      <div style={row}>
        <span style={{ width: 10, height: 10, borderRadius: 3, background: bp.color, flexShrink: 0 }} />
        <input style={{ ...field, marginBottom: 0, flex: 1 }} value={bp.name} aria-label="bp-name"
          onChange={e => upd({ name: e.target.value })} />
        <button style={dangerBtn} onClick={() => store.removeBlueprint(bp.id)}>×</button>
      </div>

      <div style={sectionLabel}>Ports</div>
      {bp.ports.map((p, i) => (
        <div key={i} style={row}>
          <input style={{ ...field, width: 64, marginBottom: 0 }} type="number" value={p.port} aria-label={`port-${i}`}
            onChange={e => upd({ ports: bp.ports.map((x, j) => j === i ? { ...x, port: Number(e.target.value) } : x) })} />
          <select style={{ ...field, width: 80, marginBottom: 0 }} value={p.visibility}
            onChange={e => upd({ ports: bp.ports.map((x, j) => j === i ? { ...x, visibility: e.target.value as 'public' | 'internal' } : x) })}>
            <option value="internal">internal</option><option value="public">public</option>
          </select>
          <button style={dangerBtn} onClick={() => upd({ ports: bp.ports.filter((_, j) => j !== i) })}>×</button>
        </div>
      ))}
      <button style={smallBtn} onClick={() => upd({ ports: [...bp.ports, { port: 8080, protocol: 'tcp', visibility: 'internal' }] })}>+ Port</button>

      <div style={sectionLabel}>Workload</div>
      {([
        ['cpuMsPerRequest', 'cpu ms/req'], ['ramBaseMb', 'ram base MB'],
        ['ramPerConnMb', 'ram/conn MB'], ['diskIoPerRequest', 'disk io/req'],
      ] as const).map(([key, label]) => (
        <div key={key} style={row}>
          <span style={{ flex: 1, color: 'var(--color-text-muted)' }}>{label}</span>
          <input style={{ ...field, width: 70, marginBottom: 0 }} type="number" value={bp.workload[key]}
            onChange={e => upd({ workload: { ...bp.workload, [key]: Number(e.target.value) } })} />
        </div>
      ))}

      <div style={row}>
        <label style={{ flex: 1, color: 'var(--color-text-muted)' }}>
          <input type="checkbox" checked={bp.stateful}
            onChange={e => upd({ stateful: e.target.checked, volumeName: e.target.checked ? (bp.volumeName ?? `${bp.name}-data`) : null })} />
          {' '}stateful
        </label>
        {bp.stateful && (
          <input style={{ ...field, width: 110, marginBottom: 0 }} placeholder="volume name"
            value={bp.volumeName ?? ''} onChange={e => upd({ volumeName: e.target.value || null })} />
        )}
      </div>

      <button style={smallBtn} onClick={() => setShowDeps(s => !s)}>{showDeps ? '▾ deps' : '▸ deps'}</button>
      {showDeps && (
        <div style={{ marginTop: 4 }}>
          {bp.dependencies.map((d, i) => {
            const key = d.target.kind === 'blueprint' ? `bp:${d.target.blueprintId}` : `ms:${d.target.managedServiceId}`
            return (
              <div key={d.id} style={row}>
                <select style={{ ...field, flex: 1, marginBottom: 0 }} value={key} onChange={e => setDepTarget(i, e.target.value)}>
                  {targets.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
                </select>
                <input style={{ ...field, width: 56, marginBottom: 0 }} type="number" value={d.port} aria-label={`dep-port-${i}`}
                  onChange={e => upd({ dependencies: bp.dependencies.map((x, j) => j === i ? { ...x, port: Number(e.target.value) } : x) })} />
                <select style={{ ...field, width: 64, marginBottom: 0 }} value={d.protocol}
                  onChange={e => upd({ dependencies: bp.dependencies.map((x, j) => j === i ? { ...x, protocol: e.target.value as BlueprintDependency['protocol'] } : x) })}>
                  <option value="http">http</option><option value="db">db</option>
                  <option value="event">event</option><option value="stream">stream</option>
                </select>
                <button style={dangerBtn} onClick={() => upd({ dependencies: bp.dependencies.filter((_, j) => j !== i) })}>×</button>
              </div>
            )
          })}
          <button style={smallBtn} disabled={targets.length === 0} onClick={addDep}>+ Dependency</button>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Write PlacementPanel (placements + managed services)**

```tsx
// src/app/world/panels/PlacementPanel.tsx
import { useState } from 'react'
import { useWorldStore } from '../../store/world.store'
import type { Placement, PlacementRuntime } from '../../../lib/world/types'
import { sectionLabel, field, smallBtn, dangerBtn, row } from './panelStyles'

const MANAGED_TYPES = ['rds', 's3', 'sqs', 'redis', 'cdn', 'apiGateway', 'lambda']

export function PlacementPanel() {
  const doc = useWorldStore(s => s.doc)
  const store = useWorldStore.getState()
  const blueprints = Object.values(doc.blueprints)
  const servers = Object.values(doc.servers)
  const [msType, setMsType] = useState(MANAGED_TYPES[0])
  const [msScope, setMsScope] = useState('')

  const scopeOptions = [
    ...Object.values(doc.regions).map(r => ({ key: `region:${r.id}`, label: `region ${r.catalogId}` })),
    ...Object.values(doc.azs).map(a => ({ key: `az:${a.id}`, label: `az ${a.label}` })),
  ]

  return (
    <div>
      <div style={sectionLabel}>Placements</div>
      {blueprints.length === 0 && <div style={{ color: 'var(--color-text-muted)' }}>create a blueprint first</div>}
      {blueprints.map(bp => (
        <div key={bp.id} style={{ border: '1px solid var(--color-node-border)', borderRadius: 6, padding: 8, marginTop: 8 }}>
          <div style={row}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: bp.color }} />
            <strong style={{ flex: 1 }}>{bp.name}</strong>
            <button style={smallBtn} disabled={servers.length === 0}
              onClick={() => store.addPlacement(bp.id, servers[0].id)}>+ Place</button>
          </div>
          {Object.values(doc.placements).filter(p => p.blueprintId === bp.id).map(pl => (
            <PlacementRow key={pl.id} pl={pl} />
          ))}
        </div>
      ))}

      <div style={sectionLabel}>Managed services</div>
      <div style={row}>
        <select style={{ ...field, flex: 1, marginBottom: 0 }} value={msType} onChange={e => setMsType(e.target.value)}>
          {MANAGED_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select style={{ ...field, flex: 1, marginBottom: 0 }} value={msScope} onChange={e => setMsScope(e.target.value)}>
          <option value="">scope…</option>
          {scopeOptions.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        <button style={smallBtn} disabled={!msScope} onClick={() => {
          const [kind, id] = msScope.split(':')
          store.addManagedService(msType, msType.toUpperCase(),
            kind === 'region' ? { kind: 'region', regionId: id } : { kind: 'az', azId: id }, 5432)
        }}>+ Add</button>
      </div>
      {Object.values(doc.managedServices).map(ms => (
        <div key={ms.id} style={row}>
          <span style={{ flex: 1 }}>{ms.label} <span style={{ color: 'var(--color-text-muted)' }}>:{ms.port}</span></span>
          <button style={dangerBtn} onClick={() => store.removeManagedService(ms.id)}>×</button>
        </div>
      ))}
    </div>
  )
}

function PlacementRow({ pl }: { pl: Placement }) {
  const doc = useWorldStore(s => s.doc)
  const store = useWorldStore.getState()
  const upd = (patch: Partial<Placement>) => store.updatePlacement(pl.id, patch)
  const server = doc.servers[pl.serverId]
  const isContainer = pl.runtime.type === 'container'

  const setRuntimeType = (type: 'process' | 'container') => {
    if (type === 'process') return upd({ runtime: { type: 'process' } })
    const stackName = server?.stacks[0]?.name ?? 'stack-1'
    const networkNames = server?.stacks[0]?.networks.map(n => n.name) ?? []
    upd({ runtime: { type: 'container', stackName, networkNames, portMappings: [], cpuLimit: null, memLimitMb: null } })
  }

  return (
    <div style={{ marginTop: 6, paddingLeft: 8, borderLeft: '2px solid var(--color-node-border)' }}>
      <div style={row}>
        <select style={{ ...field, flex: 1, marginBottom: 0 }} value={pl.serverId}
          onChange={e => upd({ serverId: e.target.value })}>
          {Object.values(doc.servers).map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <input style={{ ...field, width: 44, marginBottom: 0 }} type="number" min={1} value={pl.count} aria-label="pl-count"
          onChange={e => upd({ count: Math.max(1, Number(e.target.value)) })} />
        <select style={{ ...field, width: 76, marginBottom: 0 }} value={pl.role}
          onChange={e => upd({ role: e.target.value as Placement['role'] })}>
          <option value="primary">primary</option><option value="replica">replica</option><option value="canary">canary</option>
        </select>
        <button style={dangerBtn} onClick={() => store.removePlacement(pl.id)}>×</button>
      </div>
      <div style={row}>
        <select style={{ ...field, width: 90, marginBottom: 0 }} value={pl.runtime.type}
          onChange={e => setRuntimeType(e.target.value as 'process' | 'container')}>
          <option value="process">process</option><option value="container">container</option>
        </select>
        {isContainer && pl.runtime.type === 'container' && (
          <>
            <select style={{ ...field, flex: 1, marginBottom: 0 }} value={pl.runtime.stackName}
              onChange={e => {
                const stack = server?.stacks.find(s => s.name === e.target.value)
                upd({ runtime: { ...pl.runtime, stackName: e.target.value, networkNames: stack?.networks.map(n => n.name) ?? [] } as PlacementRuntime })
              }}>
              {(server?.stacks ?? []).map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
              {(server?.stacks.length ?? 0) === 0 && <option value={pl.runtime.stackName}>{pl.runtime.stackName} (missing)</option>}
            </select>
          </>
        )}
      </div>
      {isContainer && pl.runtime.type === 'container' && (
        <input style={field} placeholder="port mappings: host:container, host:container" aria-label="pl-mappings"
          value={pl.runtime.portMappings.map(m => `${m.host}:${m.container}`).join(', ')}
          onChange={e => upd({ runtime: { ...pl.runtime, portMappings: e.target.value.split(',').map(t => t.trim()).filter(Boolean).map(t => {
            const [host, container] = t.split(':').map(Number)
            return { host: host || 0, container: container || 0 }
          }) } as PlacementRuntime })} />
      )}
    </div>
  )
}
```

- [ ] **Step 5: Swap the stubs in WorldPanel**

In `WorldPanel.tsx`, delete the two local stub functions and add:

```tsx
import { BlueprintPanel } from './BlueprintPanel'
import { PlacementPanel } from './PlacementPanel'
```

- [ ] **Step 6: Rewire HomeScreen to v2**

Modify `src/app/home/HomeScreen.tsx`:
- Delete the imports of `useCanvasStore`, `useSimulationStore`, `useMetricsHistoryStore`, `useCostHistoryStore`, `deserialize`, and `VAULT_TEMPLATES` (+ the `CATEGORY_ICONS`/`CATEGORY_COLORS_*` constants and the entire Template Vault JSX block and `loadTemplate` — templates return as world files in a later phase).
- Add imports: `useWorldStore` from `../store/world.store`, `useNavStore` from `../store/nav.store`, `deserializeWorld` from `../../lib/serializer`.
- Replace `openNew` and `openFile` with:

```tsx
const openNew = () => {
  useWorldStore.getState().newWorld()
  useNavStore.getState().goGlobe()
  useFileStore.getState().setFilePath(null)
  setShowHome(false)
}

const openFile = async (path: string) => {
  try {
    const raw = await loadDiagram(path)
    const file = deserializeWorld(raw)
    useWorldStore.getState().replaceWorld(file.world)
    const vs = file.viewState
    const nav = useNavStore.getState()
    if (vs?.level === 'server' && vs.regionId && vs.azId && vs.serverId) nav.goServer(vs.regionId, vs.azId, vs.serverId)
    else if (vs?.level === 'az' && vs.regionId && vs.azId) nav.goAz(vs.regionId, vs.azId)
    else if (vs?.level === 'region' && vs.regionId) nav.goRegion(vs.regionId)
    else nav.goGlobe()
    markSaved(path)
    setShowHome(false)
  } catch (e) {
    console.error('Failed to open file:', e)
    setOpenError(e instanceof Error ? e.message : 'Failed to open file')
  }
}
```

- Add `const [openError, setOpenError] = useState<string | null>(null)` and render it under the recents list when set: `{openError && <div style={{ color: 'var(--color-danger)', font: '11px var(--font-mono)', marginTop: 8 }}>{openError}</div>}` — this is how the v1-rejection message (Task 8) reaches the user.
- Rename the "New Diagram" button label to "New World".

- [ ] **Step 7: Run tests + build + manual smoke**

Run: `npx vitest run src/app/world/panels/ && npm run build` → all green.
Run: `npm run dev` → build a real world end-to-end: region + 2 AZs + 2 servers, blueprints
`web`/`api`/`pg` with dependencies web→api→pg, placements incl. a container on a stack.
GlobeView/RegionView/ServerView all reflect it; ServerView shows the pg instance with its
stack; opening a v1 `.scalemap` from recents shows the rejection message on Home.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(world): add blueprint/placement/managed-service authoring and v2 home-screen file flow"
```

### Task 13: Static AZ canvas

**Files:**
- Create: `src/lib/world/layoutAz.ts`
- Create: `src/app/world/AzCanvas.tsx`
- Create: `src/app/world/WorldServerNode.tsx`
- Modify: `src/app/world/WorldShell.tsx` (swap the AzView placeholder for `<AzCanvas />`)
- Test: `src/lib/world/layoutAz.test.ts`

**Interfaces:**
- Consumes: `useCompiledWorld`, `useWorldStore`, `useNavStore`, `@xyflow/react`.
- Produces: `layoutAzGrid(serverIds: string[], managedIds: string[]): Record<string, { x: number; y: number }>`; `<AzCanvas />` rendering the focused AZ read-only (servers as nodes with instance chips, managed services, compiled paths as edges — red dashed when blocked). Rack-chassis styling replaces `WorldServerNode`'s body in Phase 4; the node's data contract is what matters here.

- [ ] **Step 1: Write the failing layout test**

```ts
// src/lib/world/layoutAz.test.ts
import { describe, it, expect } from 'vitest'
import { layoutAzGrid, AZ_LAYOUT } from './layoutAz'

describe('layoutAzGrid', () => {
  it('lays servers in rows of 3 and managed services below', () => {
    const pos = layoutAzGrid(['a', 'b', 'c', 'd'], ['m1'])
    expect(pos['a']).toEqual({ x: 0, y: 0 })
    expect(pos['c']).toEqual({ x: 2 * AZ_LAYOUT.xGap, y: 0 })
    expect(pos['d']).toEqual({ x: 0, y: AZ_LAYOUT.yGap })
    expect(pos['m1'].y).toBe(2 * AZ_LAYOUT.yGap + AZ_LAYOUT.managedYExtra)
  })

  it('is deterministic and total', () => {
    expect(layoutAzGrid([], [])).toEqual({})
    expect(layoutAzGrid(['x'], [])).toEqual(layoutAzGrid(['x'], []))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/world/layoutAz.test.ts`
Expected: FAIL — `Cannot find module './layoutAz'`

- [ ] **Step 3: Write the layout util**

```ts
// src/lib/world/layoutAz.ts
// Deterministic grid layout for the static AZ canvas. Positions are derived per render —
// Phase 1 has no drag-persistence; a future phase can add a positions map to the doc.
export const AZ_LAYOUT = { cols: 3, xGap: 280, yGap: 190, managedYExtra: 80 }

export function layoutAzGrid(
  serverIds: string[],
  managedIds: string[],
): Record<string, { x: number; y: number }> {
  const pos: Record<string, { x: number; y: number }> = {}
  serverIds.forEach((id, i) => {
    pos[id] = { x: (i % AZ_LAYOUT.cols) * AZ_LAYOUT.xGap, y: Math.floor(i / AZ_LAYOUT.cols) * AZ_LAYOUT.yGap }
  })
  const managedRow = Math.ceil(serverIds.length / AZ_LAYOUT.cols)
  managedIds.forEach((id, i) => {
    pos[id] = { x: (i % AZ_LAYOUT.cols) * AZ_LAYOUT.xGap, y: managedRow * AZ_LAYOUT.yGap + AZ_LAYOUT.managedYExtra }
  })
  return pos
}
```

Run: `npx vitest run src/lib/world/layoutAz.test.ts` → PASS (2 tests).

- [ ] **Step 4: Write the node component and canvas**

```tsx
// src/app/world/WorldServerNode.tsx
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { Server } from '../../lib/world/types'

export interface WorldServerNodeData {
  server: Server
  chips: { color: string; name: string; role: string; runtime: string }[]
  [key: string]: unknown
}

export function WorldServerNode({ data }: NodeProps) {
  const { server, chips } = data as WorldServerNodeData
  return (
    <div style={{
      width: 220, background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
      borderRadius: 8, padding: 10, font: '11px var(--font-mono)', color: 'var(--color-text-primary)',
    }}>
      <Handle type="target" position={Position.Left} />
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <strong>{server.label}</strong>
        <span style={{ color: 'var(--color-text-muted)' }}>{server.kind}</span>
      </div>
      <div style={{ color: 'var(--color-text-muted)', fontSize: 10, marginBottom: 6 }}>
        {server.specs.vcpu} vCPU · {Math.round(server.specs.ramMb / 1024)} GB · {server.firewall.length} fw rules
      </div>
      {chips.map((c, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <span style={{ width: 7, height: 7, borderRadius: 2, background: c.color, flexShrink: 0 }} />
          <span>{c.name}</span>
          <span style={{ color: 'var(--color-text-muted)', fontSize: 10 }}>{c.role} · {c.runtime}</span>
        </div>
      ))}
      {chips.length === 0 && <div style={{ color: 'var(--color-text-muted)', fontSize: 10 }}>empty</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

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

```tsx
// src/app/world/AzCanvas.tsx
// Read-only render of the focused AZ from the compiled world. Instance-level paths are
// aggregated to server-pair edges; any blocked path turns the whole edge red/dashed.
import { useMemo } from 'react'
import { ReactFlow, Background, type Node, type Edge } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { useCompiledWorld } from './useCompiledWorld'
import { layoutAzGrid } from '../../lib/world/layoutAz'
import { WorldServerNode, WorldManagedNode } from './WorldServerNode'

const nodeTypes = { worldServer: WorldServerNode, worldManaged: WorldManagedNode }

export function AzCanvas() {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const { regionId, azId, goServer } = useNavStore()

  const { nodes, edges } = useMemo(() => {
    if (!azId || !regionId) return { nodes: [] as Node[], edges: [] as Edge[] }
    const servers = Object.values(doc.servers).filter(s => s.azId === azId)
    const managed = Object.values(doc.managedServices).filter(m =>
      (m.scope.kind === 'az' && m.scope.azId === azId) ||
      (m.scope.kind === 'region' && m.scope.regionId === regionId))
    const pos = layoutAzGrid(servers.map(s => s.id), managed.map(m => m.id))

    const nodes: Node[] = [
      ...servers.map(server => ({
        id: server.id, type: 'worldServer' as const, position: pos[server.id],
        data: {
          server,
          chips: Object.values(compiled.instances)
            .filter(i => i.serverId === server.id)
            .map(i => {
              const bp = doc.blueprints[i.blueprintId]
              const pl = doc.placements[i.placementId]
              return { color: bp?.color ?? '#888', name: bp?.name ?? '?', role: i.role, runtime: pl?.runtime.type ?? 'process' }
            }),
        },
      })),
      ...managed.map(m => ({
        id: m.id, type: 'worldManaged' as const, position: pos[m.id],
        data: { label: m.label, nodeType: m.nodeType, port: m.port },
      })),
    ]

    // Aggregate instance-level compiled paths into one edge per (fromServer, target).
    const agg = new Map<string, { source: string; target: string; total: number; blocked: number; reason: string | null }>()
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
        if (!to || !inAz.has(to.serverId) || to.serverId === from.serverId) continue // cross-AZ links render at region level (Phase 4)
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
  }, [doc, compiled, azId, regionId])

  if (!azId || !regionId) return null

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        onNodeClick={(_, node) => {
          if (node.type === 'worldServer') goServer(regionId, azId, node.id)
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} color="var(--color-canvas-dots)" />
      </ReactFlow>
    </div>
  )
}
```

- [ ] **Step 5: Swap the placeholder in WorldShell**

In `WorldShell.tsx`: delete the local `AzView` function, add `import { AzCanvas } from './AzCanvas'`, and change the ternary's AZ branch to `<AzCanvas />`.

- [ ] **Step 6: Verify build + manual smoke**

Run: `npm run build && npx vitest run` → green.
Run: `npm run dev` → in a world with web→api→pg placements across two servers, the AZ view
shows server cards with colored instance chips and green labeled edges; adding a
`deny :5432` firewall rule on the pg server flips that edge red with `✕ firewall-deny`;
clicking a server zooms to ServerView.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(world): render the focused AZ as a static React Flow canvas from compiled paths"
```

---

### Task 14: File operations, autosave, dirty tracking, boundaries doc, final verification

**Files:**
- Create: `src/app/world/fileOps.ts`
- Modify: `src/app/store/file.store.ts` (add `createdIso`)
- Modify: `src/app/store/world.store.ts` (dirty-flag hook in `mutate`)
- Modify: `src/app/world/WorldShell.tsx` (header file actions)
- Modify: `src/app/home/HomeScreen.tsx` (reuse `openWorldFromPath`)
- Modify: `src/App.tsx` (v2 autosave)
- Modify: `docs/module-boundaries.md`

**Interfaces:**
- Consumes: Task 8 serializer, existing tauri wrappers (`saveDiagram`, `loadDiagram`, `openFileDialog`, `saveFileDialog`), Task 7/10 stores.
- Produces: `openWorldFromPath(path: string): Promise<void>` and `saveWorld(opts?: { forceDialog?: boolean }): Promise<void>`.

- [ ] **Step 1: Add `createdIso` to file.store**

In `src/app/store/file.store.ts`, add to the interface and store:

```ts
createdIso: string | null
setCreatedIso: (iso: string | null) => void
```

```ts
createdIso: null,
setCreatedIso: (iso) => set({ createdIso: iso }),
```

- [ ] **Step 2: Make world mutations mark the file dirty**

In `src/app/store/world.store.ts`, import `useFileStore` from `./file.store` and change the
`mutate` helper to:

```ts
const mutate = (fn: (doc: WorldDoc) => WorldDoc) => {
  get().pushHistory()
  set(s => ({ doc: fn(s.doc) }))
  useFileStore.getState().setDirty(true)
}
```

Run: `npx vitest run src/app/store/world.store.test.ts` → still PASS (the file store is a
plain zustand store; no jsdom needed).

- [ ] **Step 3: Write fileOps**

```ts
// src/app/world/fileOps.ts
// Shared v2 file flows for HomeScreen and WorldShell.
import { saveDiagram, loadDiagram, openFileDialog, saveFileDialog } from '../../lib/tauri'
import { serializeWorld, deserializeWorld } from '../../lib/serializer'
import { useWorldStore } from '../store/world.store'
import { useFileStore } from '../store/file.store'
import { useNavStore } from '../store/nav.store'

export async function openWorldFromPath(path: string): Promise<void> {
  const raw = await loadDiagram(path)
  const file = deserializeWorld(raw)   // throws on v1/invalid — caller shows the message
  useWorldStore.getState().replaceWorld(file.world)
  useFileStore.getState().setCreatedIso(file.meta.created)
  const vs = file.viewState
  const nav = useNavStore.getState()
  if (vs?.level === 'server' && vs.regionId && vs.azId && vs.serverId) nav.goServer(vs.regionId, vs.azId, vs.serverId)
  else if (vs?.level === 'az' && vs.regionId && vs.azId) nav.goAz(vs.regionId, vs.azId)
  else if (vs?.level === 'region' && vs.regionId) nav.goRegion(vs.regionId)
  else nav.goGlobe()
  useFileStore.getState().markSaved(path)
}

export async function openWorldViaDialog(): Promise<string | null> {
  const path = await openFileDialog()
  if (!path) return null
  await openWorldFromPath(path)
  return path
}

export async function saveWorld(opts: { forceDialog?: boolean } = {}): Promise<void> {
  let path = opts.forceDialog ? null : useFileStore.getState().filePath
  if (!path) path = await saveFileDialog()
  if (!path) return
  const nav = useNavStore.getState()
  const created = useFileStore.getState().createdIso ?? new Date().toISOString()
  const name = (path.split('/').pop() ?? 'world').replace('.scalemap', '')
  const json = serializeWorld(useWorldStore.getState().doc, name, created, undefined, {
    level: nav.level,
    regionId: nav.regionId ?? undefined,
    azId: nav.azId ?? undefined,
    serverId: nav.serverId ?? undefined,
  })
  await saveDiagram(path, json)
  useFileStore.getState().setCreatedIso(created)
  useFileStore.getState().markSaved(path)
}
```

- [ ] **Step 4: Header file actions in WorldShell**

In `WorldShell.tsx`, replace the `esc = up one level` span with a right-side cluster (keep
the hint as the leftmost item in it):

```tsx
<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
  <span style={{ font: '10px var(--font-mono)', color: 'var(--color-text-muted)' }}>esc = up one level</span>
  {dirty && <span style={{ color: 'var(--color-warning)', font: '10px var(--font-mono)' }}>● unsaved</span>}
  <button style={hdrBtn} onClick={() => { useWorldStore.getState().newWorld(); useFileStore.getState().setFilePath(null); useFileStore.getState().setCreatedIso(null); useNavStore.getState().goGlobe() }}>New</button>
  <button style={hdrBtn} onClick={() => { openWorldViaDialog().catch(e => setFileError(e instanceof Error ? e.message : 'open failed')) }}>Open</button>
  <button style={hdrBtn} onClick={() => { saveWorld().catch(e => setFileError(e instanceof Error ? e.message : 'save failed')) }}>Save</button>
  <button style={hdrBtn} onClick={() => { saveWorld({ forceDialog: true }).catch(e => setFileError(e instanceof Error ? e.message : 'save failed')) }}>Save As</button>
</div>
```

with the supporting pieces inside `WorldShell`:

```tsx
const dirty = useFileStore(s => s.dirty)
const [fileError, setFileError] = useState<string | null>(null)
const hdrBtn: CSSProperties = {
  background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
  borderRadius: 4, padding: '3px 10px', cursor: 'pointer',
  font: '11px var(--font-mono)', color: 'var(--color-text-secondary)',
}
```

and render `fileError` in a slim ribbon under the header when set:

```tsx
{fileError && (
  <div style={{ padding: '4px 16px', font: '11px var(--font-mono)', color: 'var(--color-danger)', borderBottom: '1px solid var(--color-toolbar-border)' }}>
    {fileError} <button style={{ ...hdrBtn, padding: '0 6px' }} onClick={() => setFileError(null)}>dismiss</button>
  </div>
)}
```

(new imports in `WorldShell.tsx`: extend the react import to
`import { useEffect, useState, type CSSProperties } from 'react'`; add `useFileStore`,
`useWorldStore`, `openWorldViaDialog`, `saveWorld`.)

- [ ] **Step 5: HomeScreen reuses openWorldFromPath**

In `HomeScreen.tsx`, replace the body of `openFile` with:

```tsx
const openFile = async (path: string) => {
  try {
    await openWorldFromPath(path)
    setShowHome(false)
  } catch (e) {
    console.error('Failed to open file:', e)
    setOpenError(e instanceof Error ? e.message : 'Failed to open file')
  }
}
```

and delete the now-duplicated imports (`deserializeWorld`, `loadDiagram`, direct
store wiring) in favor of `import { openWorldFromPath } from '../world/fileOps'`.

- [ ] **Step 6: v2 autosave in App.tsx**

Add back a 30-second autosave effect (the Task-10 rewire removed the v1 one):

```tsx
useEffect(() => {
  const id = setInterval(() => {
    const { dirty, fileName, createdIso } = useFileStore.getState()
    if (!dirty) return
    try {
      const json = serializeWorld(
        useWorldStore.getState().doc,
        fileName?.replace('.scalemap', '') || 'untitled',
        createdIso ?? new Date().toISOString(),
      )
      localStorage.setItem('scalemap-autosave-v2', json)
      useFileStore.getState().setLastAutosave(new Date())
    } catch {
      // localStorage full or unavailable — silently skip
    }
  }, 30_000)
  return () => clearInterval(id)
}, [])
```

(import `serializeWorld` from `./lib/serializer`. Note: unlike v1's autosave this does NOT
call `markSaved()` — an autosave snapshot in localStorage is not the user's file; the
dirty dot must survive until a real Save.)

- [ ] **Step 7: Update docs/module-boundaries.md**

Append this section (adjust the section letter to the next free one) and mark the old
linter section (§C) header with `**DELETED 2026-07-08** — replaced by the Phase-6 Analysis
system; see docs/superpowers/specs/2026-07-08-world-model-multiscale-simulation-design.md`:

```markdown
### §J. World model & navigation shell (Phase 1 of the world rebuild, 2026-07-08)

Branch: `world-rebuild`. Spec: `docs/superpowers/specs/2026-07-08-world-model-multiscale-simulation-design.md`;
plan: `docs/superpowers/plans/2026-07-08-phase1-world-model-shell.md`.

| File | Role |
|---|---|
| `src/lib/world/types.ts` | WorldDoc entities + CompiledWorld output types — the schema of `.scalemap` v2 |
| `src/lib/world/factories.ts`, `instanceCatalog.ts`, `regionGeo.ts` | Entity constructors, server presets, region coordinates |
| `src/lib/world/compileWorld.ts` (+ `network.ts`, `routing.ts`) | Pure resolver: blueprints × placements → instances, permitted/blocked paths (firewall/ports/docker networks), routing tables, findings. Golden-tested; every consumer (views now, engine in Phase 2, analysis in Phase 6) reads its output, never the raw doc, for derived facts |
| `src/app/store/world.store.ts` | Document store + undo/redo + cascading CRUD; marks file dirty on every mutation |
| `src/app/store/nav.store.ts` | Level + focus (globe/region/az/server) |
| `src/app/world/` | WorldShell (breadcrumb header, level router, file actions), GlobeView/RegionView/ServerView placeholders, AzCanvas (static React Flow), authoring panels |
| `src/lib/serializer.ts` | v1 exports retained for unmounted legacy files; v2 (`serializeWorld`/`deserializeWorld`) is the live format |

**Blast radius:** `types.ts` is imported by everything above — additive changes are safe,
renames fan out to the whole world module. `compileWorld` output shape is consumed by all
views; extend it rather than reshaping. **Legacy UI (Toolbar/Canvas/PropertiesPanel/
particleEngine/canvas.store etc.) is unmounted but still compiling** — it is reference
material for Phases 2–4; don't import it from `world/` files, don't delete it piecemeal.
The linter (`src/lib/lint/`), `diagnostics.store`, and `DiagnosticsPanel` were deleted.
```

- [ ] **Step 8: Final verification (whole phase)**

```bash
npm run build
npx vitest run
```

Expected: build green; suites green — world lib (factories 5, regionGeo 2, instanceCatalog 3,
compileWorld 4, network 9, routing 6, layoutAz 2, serializer 3), stores (world.store 5,
nav.store 3), components (Breadcrumb 2, TopologyPanel 3, BlueprintPanel 2), plus all
pre-existing engine suites untouched.

Manual smoke (`npm run tauri dev` for real file dialogs, or `npm run dev` for the
localStorage mock): new world → author region/2 AZ/2 servers/3 blueprints with deps/
placements → navigate all 4 levels (click down, Esc up, breadcrumb jump) → break a path
with a deny rule and see the red edge → Save → New → Open the saved file → world and view
position restore; dirty dot appears on edit, clears on save.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(world): v2 file operations, autosave, dirty tracking; update module boundaries"
```

---

## Execution notes

- Tasks 1–8 are pure logic and safely parallelizable in principle, but the plan assumes
  sequential execution (each commit builds on the last).
- Task 9 (deletion) MUST come after Task 8 and before Task 10, as written — Task 10's
  App.tsx rewire assumes the diagnostics import is already gone.
- If any legacy file surfaces a compile error not covered by Task 9's list, fix it by
  removing the dead import/usage in that file — never by resurrecting a deleted module.
- Routing/traffic **config UI** is intentionally absent in Phase 1 (the store actions and
  compiled routing tables exist and are tested; the editing surface belongs to the region
  page in Phase 4 and the globe in Phase 5). Do not add ad-hoc UI for it here.
- After the final task, run the repo's verification skill (`/verify`) or the manual smoke
  above before reporting the phase complete.

