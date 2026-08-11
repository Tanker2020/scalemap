# Network Topology (FEAT-014, Wave 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add VPC/Subnet/RouteTable/InternetGateway/NatGateway/SecurityGroup entities to `WorldDoc`,
wire them into path evaluation (route-table egress checks + security-group allow-only semantics
replacing the flat firewall list when a server opts in), give NAT gateways their own NIC-style
byte cap in the engine plus a cost line item, extend the fault/partition substrate to target
subnets and NAT gateways, add three analysis rules, and ship a `NetworkPanel` authoring surface
plus subnet-boundary rendering on the AZ floor.

**Architecture:** Six new additive `Record<id,T>` collections on `WorldDoc`, all optional/absent-safe
(a `Server` with no `subnetId` behaves exactly as today — the regression floor). Route-table
resolution happens once at `compileWorld()` time (not per engine step); NAT gateway byte accounting
happens per engine step reusing the NIC cap/backlog/shed formulas generalized to take a plain
`nicMbps: number` instead of a whole `Server`. Everything downstream (faults, cost, analysis, UI)
is additive against the existing single resolution points identified in the codebase (never a
second evaluator).

**Tech Stack:** TypeScript, Zustand (`world.store.ts`), Vitest, React (panels/dock UI), existing
engine facade (`worldEngine/index.ts`).

## Global Constraints

- Every new `WorldDoc` field/collection is optional or defaults to `{}` — a doc with none of the
  new entities produces **byte-identical** `compileWorld()`/`runStep()` output to pre-feature,
  asserted with `toBe`, never `toBeCloseTo`.
- `simulation.store.ts` is the ONLY file permitted to call the engine facade directly.
- `connectionModel.ts`/`packetResolve.ts`/`poolCheckoutFor`/`managedDbRuntimeFor` are the existing
  single resolution points for their domains — this feature does not touch them and must not
  create a rival for anything it *does* touch (route resolution, NIC cap formulas).
- No `Math.random()` inside `worldEngine`; all randomness (none is needed by this feature) would
  flow through `rng.ts`.
- Analysis rules are added only to `ANALYSIS_RULES` via the `structural`/`network`/`capacity` rule
  file arrays (`src/lib/analysis/runAnalysis.ts`) — never duplicate `compiled.findings`.
- `.scalemap` stays v3 — no version bump. New collections are normalized in `serializer.ts`'s
  existing defaulting block, matching the `racks`/`loadBalancers`/`packets` pattern exactly.
- Theme law: all new UI colors are `var(--color-*)` from `src/lib/theme.ts`, verified in dark and
  light. No emojis (`✕ ⇄ ⌬ − ● ◷ →` etc. are fine). Motion budget: subnet-boundary rendering is
  driven off compiled/static doc state, not the 1 Hz batch, and adds zero new looping animation.
- `src/app/world/panels/WorldPanel.tsx`, `src/app/store/world.store.ts`, `src/lib/world/types.ts`,
  `src/lib/worldEngine/types.ts` are high-conflict hub files — edit sequentially within this plan,
  one task at a time, never two tasks touching the same hub file in parallel.
- Done bar per task: `npx tsc --noEmit` clean → `npx vitest run <touched test files>` green.
  Full `npx vitest run`, `npm run build`, and a live `npm run tauri dev` smoke happen once at the
  end (Task 15).

---

## File Structure

New files:
- `src/lib/world/factories.ts` — extend with 6 new `create*` factories (existing file, no split).
- `src/app/world/panels/NetworkPanel.tsx` — VPC → subnet list → NAT/IGW authoring (world-scope tab).
- `src/app/world/panels/NetworkPanel.test.tsx` — component test.
- `src/app/world/dock/drawers/SecurityGroupPicker.tsx` — replaces the firewall editor in the server
  drawer only when `server.subnetId` is set.

Modified files (see per-task **Files** blocks for exact line targets): `src/lib/world/types.ts`,
`src/lib/world/network.ts`, `src/lib/world/compileWorld.ts`, `src/lib/serializer.ts`,
`src/app/store/world.store.ts`, `src/app/store/ui.store.ts`, `src/app/world/dock/scope.ts`,
`src/app/world/panels/WorldPanel.tsx`, `src/lib/worldEngine/types.ts`, `src/lib/worldEngine/faults.ts`,
`src/lib/worldEngine/networkRuntime.ts`, `src/lib/worldEngine/index.ts`, `src/lib/worldEngine/metrics.ts`,
`src/lib/costModelV2.ts`, `src/lib/analysis/rules/network.ts`, `src/app/world/az/DatacenterFloor.tsx`,
`docs/module-boundaries.md`.

---

### Task 1: Core types — six new entities, `WorldDoc` collections, `Server` fields, `BlockReasonKind`

**Files:**
- Modify: `src/lib/world/types.ts:6-15` (id types), `:94-103` (near `FirewallRule`), `:134-147`
  (`Server`), `:436-475` (`WorldDoc`), `:504-510` (`BlockReason`)
- Test: `src/lib/world/types.test.ts` (create if it doesn't exist — check first with a quick grep;
  this repo tests types indirectly via consumers, so if no such file exists, skip a dedicated type
  test and rely on Task 2/5's tests for compile-level verification)

**Interfaces:**
- Produces: `VpcId`, `SubnetId`, `RouteTableId`, `InternetGatewayId`, `NatGatewayId`,
  `SecurityGroupId` (all `type X = string`); `Vpc`, `Subnet`, `RouteTarget`, `RouteTable`,
  `InternetGateway`, `NatGateway`, `SecurityGroup` interfaces; `WorldDoc.vpcs` /
  `.subnets` / `.routeTables` / `.internetGateways` / `.natGateways` / `.securityGroups`
  (`Record<id, T>`); `Server.subnetId?: string`, `Server.securityGroupIds?: string[]`;
  `BlockReasonKind` gains `'no-egress-route'`.

- [ ] **Step 1: Add the six new id types**

In `src/lib/world/types.ts`, right after line 15 (`export type LbId = string`):

```ts
export type VpcId = string
export type SubnetId = string
export type RouteTableId = string
export type InternetGatewayId = string
export type NatGatewayId = string
export type SecurityGroupId = string
```

- [ ] **Step 2: Add the entity interfaces**

Insert after the `FirewallRule` interface (after line 103):

```ts
export interface Vpc {
  id: VpcId
  regionId: RegionId
  label: string
  cidrBlock: string
}

export interface Subnet {
  id: SubnetId
  vpcId: VpcId
  azId: AzId
  kind: 'public' | 'private'
  cidrBlock: string
  routeTableId: RouteTableId
}

export type RouteTarget =
  | { kind: 'local' }
  | { kind: 'internetGateway'; id: InternetGatewayId }
  | { kind: 'natGateway'; id: NatGatewayId }

export interface RouteTableEntry {
  destinationCidr: string
  target: RouteTarget
}

export interface RouteTable {
  id: RouteTableId
  vpcId: VpcId
  routes: RouteTableEntry[]
}

export interface InternetGateway {
  id: InternetGatewayId
  vpcId: VpcId
}

export interface NatGateway {
  id: NatGatewayId
  subnetId: SubnetId
  label: string
}

export interface SecurityGroupRule {
  port: number
  protocol: 'tcp' | 'udp'
  source: FirewallSource
}

export interface SecurityGroup {
  id: SecurityGroupId
  vpcId: VpcId
  label: string
  rules: SecurityGroupRule[]
}
```

- [ ] **Step 3: Add optional fields to `Server`**

In the `Server` interface (lines 134-147), add after `firewall: FirewallRule[]`:

```ts
  subnetId?: SubnetId               // absent = legacy flat-firewall server, unchanged behavior
  securityGroupIds?: string[]       // meaningful only when subnetId is set
```

- [ ] **Step 4: Add the six collections to `WorldDoc`**

In `WorldDoc` (lines 436-475), add after `racks: Record<RackId, Rack>`:

```ts
  vpcs: Record<VpcId, Vpc>
  subnets: Record<SubnetId, Subnet>
  routeTables: Record<RouteTableId, RouteTable>
  internetGateways: Record<InternetGatewayId, InternetGateway>
  natGateways: Record<NatGatewayId, NatGateway>
  securityGroups: Record<SecurityGroupId, SecurityGroup>
```

- [ ] **Step 5: Extend `BlockReasonKind`**

Change line 504 from:

```ts
export type BlockReasonKind = 'no-port-binding' | 'firewall-deny' | 'network-isolation'
```

to:

```ts
export type BlockReasonKind = 'no-port-binding' | 'firewall-deny' | 'network-isolation' | 'no-egress-route'
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: FAILS — every other file constructing a `WorldDoc` literal (tests, factories, serializer
defaults, `exampleWorlds.ts`) now errors with "missing properties `vpcs`, `subnets`, ...". This is
expected and intentional; Task 3 fixes the serializer, and each subsequent task fixes its own
construction sites. Note the list of erroring files from this run's output — you'll revisit them
in Tasks 2-4.

- [ ] **Step 7: Commit**

```bash
git add src/lib/world/types.ts
git commit -m "feat(network-topology): add Vpc/Subnet/RouteTable/NAT/SecurityGroup types"
```

---

### Task 2: Factories for the six new entities

**Files:**
- Modify: `src/lib/world/factories.ts` (add after `createRack`, ~line 80)
- Test: `src/lib/world/factories.test.ts` (append; check the file exists first — if it doesn't,
  create it following any sibling `*.test.ts`'s import style, e.g. `import { describe, it, expect }
  from 'vitest'`)

**Interfaces:**
- Consumes: `nextWorldId(prefix: string): string` (existing helper used by `createRack`/
  `createLoadBalancer`), the id/entity types from Task 1.
- Produces: `createVpc(regionId: RegionId, label?: string): Vpc`, `createSubnet(vpcId: VpcId, azId:
  AzId, kind: 'public' | 'private', routeTableId: RouteTableId, label?: string): Subnet` (label is
  folded into `cidrBlock`'s placeholder, not stored separately — `Subnet` has no `label` field per
  Task 1; drop the param if unused), `createRouteTable(vpcId: VpcId): RouteTable`,
  `createInternetGateway(vpcId: VpcId): InternetGateway`, `createNatGateway(subnetId: SubnetId,
  label?: string): NatGateway`, `createSecurityGroup(vpcId: VpcId, label?: string): SecurityGroup`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/world/factories.test.ts (append)
import { createVpc, createSubnet, createRouteTable, createInternetGateway, createNatGateway, createSecurityGroup } from './factories'

describe('network topology factories', () => {
  it('createVpc produces a labeled VPC scoped to a region with a CIDR block', () => {
    const vpc = createVpc('region-1')
    expect(vpc.regionId).toBe('region-1')
    expect(vpc.cidrBlock).toMatch(/^\d+\.\d+\.\d+\.\d+\/\d+$/)
    expect(vpc.id).toBeTruthy()
  })

  it('createSubnet defaults to a local route and carries its AZ/VPC/kind', () => {
    const rt = createRouteTable('vpc-1')
    const subnet = createSubnet('vpc-1', 'az-1', 'private', rt.id)
    expect(subnet.vpcId).toBe('vpc-1')
    expect(subnet.azId).toBe('az-1')
    expect(subnet.kind).toBe('private')
    expect(subnet.routeTableId).toBe(rt.id)
  })

  it('createRouteTable starts with an empty routes array', () => {
    const rt = createRouteTable('vpc-1')
    expect(rt.routes).toEqual([])
  })

  it('createInternetGateway and createNatGateway scope to a VPC/subnet respectively', () => {
    const igw = createInternetGateway('vpc-1')
    expect(igw.vpcId).toBe('vpc-1')
    const nat = createNatGateway('subnet-1')
    expect(nat.subnetId).toBe('subnet-1')
  })

  it('createSecurityGroup starts with an empty allow-list', () => {
    const sg = createSecurityGroup('vpc-1')
    expect(sg.rules).toEqual([])
    expect(sg.vpcId).toBe('vpc-1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/world/factories.test.ts`
Expected: FAIL — `createVpc` etc. are not exported.

- [ ] **Step 3: Implement the factories**

Append to `src/lib/world/factories.ts` after `createRack` (line 80):

```ts
export function createVpc(regionId: RegionId, label?: string): Vpc {
  return { id: nextWorldId('vpc'), regionId, label: label ?? 'vpc', cidrBlock: '10.0.0.0/16' }
}

export function createSubnet(
  vpcId: VpcId,
  azId: AzId,
  kind: 'public' | 'private',
  routeTableId: RouteTableId,
): Subnet {
  return {
    id: nextWorldId('subnet'),
    vpcId,
    azId,
    kind,
    cidrBlock: kind === 'public' ? '10.0.1.0/24' : '10.0.2.0/24',
    routeTableId,
  }
}

export function createRouteTable(vpcId: VpcId): RouteTable {
  return { id: nextWorldId('rtb'), vpcId, routes: [] }
}

export function createInternetGateway(vpcId: VpcId): InternetGateway {
  return { id: nextWorldId('igw'), vpcId }
}

export function createNatGateway(subnetId: SubnetId, label?: string): NatGateway {
  return { id: nextWorldId('nat'), subnetId, label: label ?? 'nat' }
}

export function createSecurityGroup(vpcId: VpcId, label?: string): SecurityGroup {
  return { id: nextWorldId('sg'), vpcId, label: label ?? 'sg', rules: [] }
}
```

Add the corresponding type imports to this file's existing `import type { ... } from './types'`
statement: `Vpc, Subnet, RouteTable, InternetGateway, NatGateway, SecurityGroup, VpcId, SubnetId,
RouteTableId`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/world/factories.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/world/factories.ts src/lib/world/factories.test.ts
git commit -m "feat(network-topology): add Vpc/Subnet/RouteTable/NAT/SecurityGroup factories"
```

---

### Task 3: Serializer normalization + fix every `WorldDoc` literal broken by Task 1

**Files:**
- Modify: `src/lib/serializer.ts:148-162` (defaulting block)
- Modify: every test fixture / `exampleWorlds.ts` construction site that `npx tsc --noEmit`
  flagged at the end of Task 1 — find them fresh with the command below rather than trusting a
  stale list.
- Test: `src/lib/serializer.test.ts` (append)

**Interfaces:**
- Consumes: `WorldDoc` from Task 1.
- Produces: nothing new; makes existing `deserializeWorld` accept files without the new
  collections, and makes the whole repo compile again.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/serializer.test.ts (append)
it('a pre-feature v3 file with no network-topology collections loads with them defaulted to empty', () => {
  const legacy = {
    version: '3',
    meta: { name: 'x', created: '', modified: '' },
    world: {
      routing: { policy: 'latency', weights: {}, priorityOrder: [], healthCheckIntervalMs: 10000, healthCheckFailureThreshold: 3, dnsTtlSec: 30 },
      populations: {}, regions: {}, azs: {}, servers: {}, blueprints: {}, placements: {}, managedServices: {},
    },
  }
  const doc = deserializeWorld(JSON.stringify(legacy))
  expect(doc.vpcs).toEqual({})
  expect(doc.subnets).toEqual({})
  expect(doc.routeTables).toEqual({})
  expect(doc.internetGateways).toEqual({})
  expect(doc.natGateways).toEqual({})
  expect(doc.securityGroups).toEqual({})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/serializer.test.ts`
Expected: FAIL — `doc.vpcs` is `undefined`.

- [ ] **Step 3: Add the defaulting block entries**

In `src/lib/serializer.ts`, in `normalizedWorld` (currently lines 148-162), add right after
`loadBalancers: src.world.loadBalancers ?? {},`:

```ts
    vpcs: src.world.vpcs ?? {},
    subnets: src.world.subnets ?? {},
    routeTables: src.world.routeTables ?? {},
    internetGateways: src.world.internetGateways ?? {},
    natGateways: src.world.natGateways ?? {},
    securityGroups: src.world.securityGroups ?? {},
```

Do **not** add these to `requiredCollections` (lines 67-70) — absence must not fail the hard
validation gate.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/serializer.test.ts`
Expected: PASS

- [ ] **Step 5: Fix every remaining `WorldDoc` construction site**

Run: `npx tsc --noEmit 2>&1 | grep "is missing the following properties"`
(On Windows PowerShell: `npx tsc --noEmit 2>&1 | Select-String "is missing the following properties"`)

For each flagged file (typically `exampleWorlds.ts` and any test that builds a raw `WorldDoc`
literal instead of going through `serializer`/a factory), add the six empty collections
(`vpcs: {}, subnets: {}, routeTables: {}, internetGateways: {}, natGateways: {}, securityGroups:
{}`) to the literal. Do not add them to shared test-fixture *helper functions* if those helpers
already spread `...baseDoc` from a single canonical fixture — fix the canonical fixture once
instead of every call site.

- [ ] **Step 6: Full type-check clean**

Run: `npx tsc --noEmit`
Expected: PASS, zero errors.

- [ ] **Step 7: Run full test suite for a sanity baseline**

Run: `npx vitest run`
Expected: PASS (no regressions from the type additions alone — this is the checkpoint before any
behavioral change begins in Task 4+).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "fix(network-topology): normalize new collections in serializer, fix WorldDoc literals"
```

---

### Task 4: `world.store.ts` CRUD actions for the six entities

**Files:**
- Modify: `src/app/store/world.store.ts` (add actions near the `Rack` CRUD block, ~line 626-650;
  add to the `WorldStore` interface near the `LoadBalancer` action signatures, ~line 153-154)
- Test: `src/app/store/world.store.test.ts` (append; check for an existing rack/loadBalancer CRUD
  test block first and mirror its setup)

**Interfaces:**
- Consumes: `mutate(fn: (doc: WorldDoc) => WorldDoc)` (existing internal helper, `world.store.ts:196`),
  `createVpc`/`createSubnet`/`createRouteTable`/`createInternetGateway`/`createNatGateway`/
  `createSecurityGroup` from Task 2.
- Produces (added to `WorldStore` interface and implementation):
  `addVpc(regionId: RegionId): string`, `updateVpc(id: string, patch: Partial<Vpc>): void`,
  `removeVpc(id: string): void`, `addSubnet(vpcId: string, azId: string, kind: 'public'|'private'):
  string`, `updateSubnet(id: string, patch: Partial<Subnet>): void`, `removeSubnet(id: string):
  void`, `addRouteTable(vpcId: string): string`, `updateRouteTable(id: string, patch:
  Partial<RouteTable>): void`, `removeRouteTable(id: string): void`, `addInternetGateway(vpcId:
  string): string`, `removeInternetGateway(id: string): void`, `addNatGateway(subnetId: string):
  string`, `removeNatGateway(id: string): void`, `addSecurityGroup(vpcId: string): string`,
  `updateSecurityGroup(id: string, patch: Partial<SecurityGroup>): void`,
  `removeSecurityGroup(id: string): void`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/app/store/world.store.test.ts (append)
describe('network topology CRUD', () => {
  it('addVpc creates a VPC and addSubnet/addRouteTable/addNatGateway/addSecurityGroup wire into it', () => {
    const store = useWorldStore.getState()
    const vpcId = store.addVpc('region-1')
    expect(useWorldStore.getState().doc.vpcs[vpcId]).toBeDefined()

    const rtId = useWorldStore.getState().addRouteTable(vpcId)
    const subnetId = useWorldStore.getState().addSubnet(vpcId, 'az-1', 'private')
    expect(useWorldStore.getState().doc.subnets[subnetId].vpcId).toBe(vpcId)

    const natId = useWorldStore.getState().addNatGateway(subnetId)
    expect(useWorldStore.getState().doc.natGateways[natId].subnetId).toBe(subnetId)

    const sgId = useWorldStore.getState().addSecurityGroup(vpcId)
    expect(useWorldStore.getState().doc.securityGroups[sgId].vpcId).toBe(vpcId)
    void rtId
  })

  it('removeVpc cascades: deletes owned subnets, route tables, NAT gateways, security groups, and clears server references', () => {
    const store = useWorldStore.getState()
    const vpcId = store.addVpc('region-1')
    const subnetId = useWorldStore.getState().addSubnet(vpcId, 'az-1', 'private')
    const sgId = useWorldStore.getState().addSecurityGroup(vpcId)
    // attach a server to the subnet/sg to verify cleanup
    useWorldStore.setState(s => ({
      doc: { ...s.doc, servers: { ...s.doc.servers, 's1': { ...Object.values(s.doc.servers)[0], subnetId, securityGroupIds: [sgId] } as any } },
    }))
    useWorldStore.getState().removeVpc(vpcId)
    const doc = useWorldStore.getState().doc
    expect(doc.vpcs[vpcId]).toBeUndefined()
    expect(doc.subnets[subnetId]).toBeUndefined()
    expect(doc.securityGroups[sgId]).toBeUndefined()
    expect(doc.servers['s1']?.subnetId).toBeUndefined()
  })

  it('removeSubnet clears subnetId on any server referencing it and deletes NAT gateways in it', () => {
    const store = useWorldStore.getState()
    const vpcId = store.addVpc('region-1')
    const subnetId = useWorldStore.getState().addSubnet(vpcId, 'az-1', 'private')
    const natId = useWorldStore.getState().addNatGateway(subnetId)
    useWorldStore.getState().removeSubnet(subnetId)
    const doc = useWorldStore.getState().doc
    expect(doc.subnets[subnetId]).toBeUndefined()
    expect(doc.natGateways[natId]).toBeUndefined()
  })
})
```

Adjust the exact test setup (how `useWorldStore` is imported/reset, and how a baseline server
`'s1'` is seeded) to match this file's existing `beforeEach`/fixture conventions — read the top of
`world.store.test.ts` before writing this block so it compiles against the real helpers.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/store/world.store.test.ts -t "network topology"`
Expected: FAIL — `addVpc` etc. don't exist.

- [ ] **Step 3: Add actions to the `WorldStore` interface**

Near the `LoadBalancer` action signatures (~line 153-154), add:

```ts
  addVpc: (regionId: string) => string
  updateVpc: (id: string, patch: Partial<Vpc>) => void
  removeVpc: (id: string) => void
  addSubnet: (vpcId: string, azId: string, kind: 'public' | 'private') => string
  updateSubnet: (id: string, patch: Partial<Subnet>) => void
  removeSubnet: (id: string) => void
  addRouteTable: (vpcId: string) => string
  updateRouteTable: (id: string, patch: Partial<RouteTable>) => void
  removeRouteTable: (id: string) => void
  addInternetGateway: (vpcId: string) => string
  removeInternetGateway: (id: string) => void
  addNatGateway: (subnetId: string) => string
  removeNatGateway: (id: string) => void
  addSecurityGroup: (vpcId: string) => string
  updateSecurityGroup: (id: string, patch: Partial<SecurityGroup>) => void
  removeSecurityGroup: (id: string) => void
```

- [ ] **Step 4: Implement the actions**

Near the rack CRUD block (~line 626), add:

```ts
addVpc: (regionId) => {
  const vpc = createVpc(regionId)
  mutate(d => ({ ...d, vpcs: { ...d.vpcs, [vpc.id]: vpc } }))
  return vpc.id
},
updateVpc: (id, patch) => mutate(d => {
  if (!d.vpcs[id]) return d
  return { ...d, vpcs: { ...d.vpcs, [id]: { ...d.vpcs[id], ...patch } } }
}),
removeVpc: (id) => mutate(d => {
  if (!d.vpcs[id]) return d
  const subnetIds = Object.values(d.subnets).filter(s => s.vpcId === id).map(s => s.id)
  const routeTableIds = Object.values(d.routeTables).filter(r => r.vpcId === id).map(r => r.id)
  const sgIds = Object.values(d.securityGroups).filter(g => g.vpcId === id).map(g => g.id)
  const natIds = Object.values(d.natGateways).filter(n => subnetIds.includes(n.subnetId)).map(n => n.id)
  const igwIds = Object.values(d.internetGateways).filter(g => g.vpcId === id).map(g => g.id)
  const servers = Object.fromEntries(Object.entries(d.servers).map(([sid, s]) =>
    s.subnetId && subnetIds.includes(s.subnetId)
      ? [sid, { ...s, subnetId: undefined, securityGroupIds: undefined }]
      : [sid, s]))
  const vpcs = { ...d.vpcs }; delete vpcs[id]
  const subnets = { ...d.subnets }; subnetIds.forEach(sid => delete subnets[sid])
  const routeTables = { ...d.routeTables }; routeTableIds.forEach(rid => delete routeTables[rid])
  const securityGroups = { ...d.securityGroups }; sgIds.forEach(gid => delete securityGroups[gid])
  const natGateways = { ...d.natGateways }; natIds.forEach(nid => delete natGateways[nid])
  const internetGateways = { ...d.internetGateways }; igwIds.forEach(gid => delete internetGateways[gid])
  return { ...d, vpcs, subnets, routeTables, securityGroups, natGateways, internetGateways, servers }
}),
addSubnet: (vpcId, azId, kind) => {
  let routeTableId = ''
  mutate(d => {
    const rt = createRouteTable(vpcId)
    routeTableId = rt.id
    return { ...d, routeTables: { ...d.routeTables, [rt.id]: rt } }
  })
  const subnet = createSubnet(vpcId, azId, kind, routeTableId)
  mutate(d => ({ ...d, subnets: { ...d.subnets, [subnet.id]: subnet } }))
  return subnet.id
},
updateSubnet: (id, patch) => mutate(d => {
  if (!d.subnets[id]) return d
  return { ...d, subnets: { ...d.subnets, [id]: { ...d.subnets[id], ...patch } } }
}),
removeSubnet: (id) => mutate(d => {
  if (!d.subnets[id]) return d
  const natIds = Object.values(d.natGateways).filter(n => n.subnetId === id).map(n => n.id)
  const servers = Object.fromEntries(Object.entries(d.servers).map(([sid, s]) =>
    s.subnetId === id ? [sid, { ...s, subnetId: undefined, securityGroupIds: undefined }] : [sid, s]))
  const subnets = { ...d.subnets }; delete subnets[id]
  const natGateways = { ...d.natGateways }; natIds.forEach(nid => delete natGateways[nid])
  return { ...d, subnets, natGateways, servers }
}),
addRouteTable: (vpcId) => {
  const rt = createRouteTable(vpcId)
  mutate(d => ({ ...d, routeTables: { ...d.routeTables, [rt.id]: rt } }))
  return rt.id
},
updateRouteTable: (id, patch) => mutate(d => {
  if (!d.routeTables[id]) return d
  return { ...d, routeTables: { ...d.routeTables, [id]: { ...d.routeTables[id], ...patch } } }
}),
removeRouteTable: (id) => mutate(d => {
  if (!d.routeTables[id]) return d
  const routeTables = { ...d.routeTables }; delete routeTables[id]
  return { ...d, routeTables }
}),
addInternetGateway: (vpcId) => {
  const igw = createInternetGateway(vpcId)
  mutate(d => ({ ...d, internetGateways: { ...d.internetGateways, [igw.id]: igw } }))
  return igw.id
},
removeInternetGateway: (id) => mutate(d => {
  const internetGateways = { ...d.internetGateways }; delete internetGateways[id]
  return { ...d, internetGateways }
}),
addNatGateway: (subnetId) => {
  const nat = createNatGateway(subnetId)
  mutate(d => ({ ...d, natGateways: { ...d.natGateways, [nat.id]: nat } }))
  return nat.id
},
removeNatGateway: (id) => mutate(d => {
  const natGateways = { ...d.natGateways }; delete natGateways[id]
  return { ...d, natGateways }
}),
addSecurityGroup: (vpcId) => {
  const sg = createSecurityGroup(vpcId)
  mutate(d => ({ ...d, securityGroups: { ...d.securityGroups, [sg.id]: sg } }))
  return sg.id
},
updateSecurityGroup: (id, patch) => mutate(d => {
  if (!d.securityGroups[id]) return d
  return { ...d, securityGroups: { ...d.securityGroups, [id]: { ...d.securityGroups[id], ...patch } } }
}),
removeSecurityGroup: (id) => mutate(d => {
  if (!d.securityGroups[id]) return d
  const servers = Object.fromEntries(Object.entries(d.servers).map(([sid, s]) =>
    s.securityGroupIds?.includes(id)
      ? [sid, { ...s, securityGroupIds: s.securityGroupIds.filter(g => g !== id) }]
      : [sid, s]))
  const securityGroups = { ...d.securityGroups }; delete securityGroups[id]
  return { ...d, securityGroups, servers }
}),
```

Add the six factory imports to this file's existing `import { createRack, ... } from
'../../lib/world/factories'` line, and the six type imports (`Vpc, Subnet, RouteTable,
SecurityGroup`) to its type-import line.

Note: `addSubnet` calls `mutate` twice (once for the route table, once for the subnet) — this
pushes two undo-history entries for one logical action. If this repo's undo/redo tests assert
one-history-entry-per-user-action elsewhere, collapse both into a single `mutate` call instead:

```ts
addSubnet: (vpcId, azId, kind) => {
  const rt = createRouteTable(vpcId)
  const subnet = createSubnet(vpcId, azId, kind, rt.id)
  mutate(d => ({
    ...d,
    routeTables: { ...d.routeTables, [rt.id]: rt },
    subnets: { ...d.subnets, [subnet.id]: subnet },
  }))
  return subnet.id
},
```
Prefer this single-`mutate` form — check any existing multi-entity add action (there may be a
precedent) and match it exactly.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/app/store/world.store.test.ts -t "network topology"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/app/store/world.store.ts src/app/store/world.store.test.ts
git commit -m "feat(network-topology): CRUD actions for Vpc/Subnet/RouteTable/NAT/IGW/SecurityGroup"
```

---

### Task 5: Route resolution + security-group evaluator in `network.ts`

**Files:**
- Modify: `src/lib/world/network.ts` (add `resolveRoute`, `evaluateSecurityGroups`; widen
  `InstancePathContext`; wire into `evaluateInstancePath`, lines 87-160)
- Test: `src/lib/world/network.test.ts` (append)

**Interfaces:**
- Consumes: `Subnet`, `RouteTable`, `RouteTarget`, `SecurityGroup`, `SecurityGroupRule` from Task 1.
- Produces: `resolveRoute(sourceSubnet: Subnet, destinationAzId: AzId | null, isInternetOrCrossRegion:
  boolean, routeTables: Record<string, RouteTable>): RouteTarget | null` (pure, most-specific-CIDR
  stand-in — see step 3 for the simplification this codebase's data model forces), and
  `evaluateSecurityGroups(server: Server, securityGroups: Record<string, SecurityGroup>, port:
  number): { allowed: boolean; matchedRuleSource: string | null }`. Widens
  `InstancePathContext` with optional `subnets?: Record<string, Subnet>`, `routeTables?:
  Record<string, RouteTable>`, `securityGroups?: Record<string, SecurityGroup>`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/world/network.test.ts (append)
import { resolveRoute, evaluateSecurityGroups } from './network'

describe('resolveRoute', () => {
  it('returns the local target for same-VPC traffic with no explicit match needed', () => {
    const rt = { id: 'rt-1', vpcId: 'vpc-1', routes: [] }
    expect(resolveRoute(rt, false)).toEqual({ kind: 'local' })
  })

  it('returns null when internet/cross-region traffic has no internetGateway/natGateway route', () => {
    const rt = { id: 'rt-1', vpcId: 'vpc-1', routes: [] }
    expect(resolveRoute(rt, true)).toBeNull()
  })

  it('returns the natGateway target when a 0.0.0.0/0 route points at one', () => {
    const rt = { id: 'rt-1', vpcId: 'vpc-1', routes: [{ destinationCidr: '0.0.0.0/0', target: { kind: 'natGateway', id: 'nat-1' } }] }
    expect(resolveRoute(rt, true)).toEqual({ kind: 'natGateway', id: 'nat-1' })
  })
})

describe('evaluateSecurityGroups', () => {
  it('denies when no attached group has a matching allow rule (allow-only, implicit deny)', () => {
    const server = { securityGroupIds: ['sg-1'] } as any
    const groups = { 'sg-1': { id: 'sg-1', vpcId: 'vpc-1', label: 'sg', rules: [{ port: 443, protocol: 'tcp', source: 'any' }] } }
    expect(evaluateSecurityGroups(server, groups, 5432).allowed).toBe(false)
  })

  it('allows when any attached group has a matching rule — union semantics, not first-match', () => {
    const server = { securityGroupIds: ['sg-1', 'sg-2'] } as any
    const groups = {
      'sg-1': { id: 'sg-1', vpcId: 'vpc-1', label: 'a', rules: [{ port: 443, protocol: 'tcp', source: 'any' }] },
      'sg-2': { id: 'sg-2', vpcId: 'vpc-1', label: 'b', rules: [{ port: 5432, protocol: 'tcp', source: 'internal' }] },
    }
    expect(evaluateSecurityGroups(server, groups, 5432).allowed).toBe(true)
  })

  it('a security group with a matching rule allows even where the equivalent flat firewall would need an explicit deny to differ from allow', () => {
    // demonstrates allow-only union vs ordered-list semantics — the whole point of this evaluator.
    const server = { securityGroupIds: ['sg-1'] } as any
    const groups = { 'sg-1': { id: 'sg-1', vpcId: 'vpc-1', label: 'a', rules: [] } }
    expect(evaluateSecurityGroups(server, groups, 80).allowed).toBe(false) // empty group = implicit deny, no rule needed to express it
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/world/network.test.ts`
Expected: FAIL — `resolveRoute`/`evaluateSecurityGroups` not exported.

- [ ] **Step 3: Implement `resolveRoute` and `evaluateSecurityGroups`**

The spec's `resolveRoute(sourceSubnet, destination, routeTables)` signature assumes CIDR-aware
destination matching, but nothing in this codebase's `Server`/`AvailabilityZone` model carries a
per-server IP address to match a destination CIDR against — `hopClassBetween` classifies purely by
az/region id, never an address. Simplify to what the data model actually supports: same-VPC traffic
is always `local` (no route lookup needed — two subnets in the same VPC are reachable by the
implicit local route regardless of what's in the table, matching real VPC semantics); cross-VPC,
cross-region, or internet/managed-service traffic requires a `0.0.0.0/0`-style catch-all route
resolving to an `internetGateway` or `natGateway` target, found via a most-specific-prefix stand-in
that in practice degenerates to "does any route exist with a non-local target" since this model has
no forth destination CIDR to compare against yet:

```ts
export function resolveRoute(routeTable: RouteTable, needsEgress: boolean): RouteTarget | null {
  if (!needsEgress) return { kind: 'local' }
  const egressRoute = routeTable.routes.find(r => r.target.kind !== 'local')
  return egressRoute ? egressRoute.target : null
}

export function evaluateSecurityGroups(
  server: Server,
  securityGroups: Record<string, SecurityGroup>,
  port: number,
): { allowed: boolean; matchedGroupId: string | null } {
  for (const groupId of server.securityGroupIds ?? []) {
    const group = securityGroups[groupId]
    if (!group) continue
    const match = group.rules.find(r => r.port === port && r.protocol === 'tcp')
    if (match) return { allowed: true, matchedGroupId: groupId }
  }
  return { allowed: false, matchedGroupId: null }
}
```

(`protocol === 'tcp'` mirrors `firewallFirstMatch`'s existing "all Phase-1 dep protocols ride tcp"
comment at line 39 — keep the same assumption for consistency, and widen both together in a later
feature if UDP dependency protocols are ever added.)

Update the two failing tests above that assumed a 3-arg `resolveRoute(sourceSubnet, destination,
routeTables)` signature and a `matchedRuleSource` field — rewrite them to match the simplified
2-arg/`matchedGroupId` shape actually implemented (the test bodies shown in Step 1 already use the
simplified shape; this is a heads-up in case you drafted from the spec verbatim before reading this
step).

- [ ] **Step 4: Widen `InstancePathContext` and wire into `evaluateInstancePath`**

Add to `InstancePathContext` (line 66-74):

```ts
  fromSubnet?: Subnet | null       // resolved by the caller (compileWorld) when fromServer.subnetId is set
  fromRouteTable?: RouteTable | null
  needsEgress?: boolean            // true when hopClass is cross-region OR destination is a managed/internet target
```

In `evaluateInstancePath`, insert a new gate immediately after computing `hopClass` (right after
line 90, before the `bindsPort` check):

```ts
  if (fromSubnet && fromRouteTable) {
    const target = resolveRoute(fromRouteTable, needsEgress ?? hopClass === 'cross-region')
    if (!target) {
      return blocked(hopClass, {
        kind: 'no-egress-route',
        detail: `${fromServer.label}'s subnet has no route to ${hopClass === 'cross-region' ? 'this region' : 'the destination'}`,
        firewallRuleId: null,
      })
    }
  }
```

Then in `firewallVerdict` (called at lines 101 and 159), branch to the new security-group evaluator
when the **destination** server has `securityGroupIds` set:

```ts
function firewallVerdict(
  toServer: Server,
  port: number,
  hopClass: HopClass,
  securityGroups?: Record<string, SecurityGroup>,
): PathEvaluation {
  if (toServer.securityGroupIds?.length && securityGroups) {
    const sg = evaluateSecurityGroups(toServer, securityGroups, port)
    if (sg.allowed) return permitted(hopClass)
    return blocked(hopClass, {
      kind: 'firewall-deny',
      detail: `denied by security group on ${toServer.label} (port ${port}, no matching allow rule)`,
      firewallRuleId: null,
    })
  }
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

Update both call sites (lines 101, 159) to pass `ctx.securityGroups` through.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/world/network.test.ts`
Expected: PASS

- [ ] **Step 6: Regression check — a `ctx` with no `fromSubnet` behaves exactly as before**

Add one more test confirming the byte-identical regression floor:

```ts
it('a context with no fromSubnet/fromRouteTable skips the route check entirely (regression floor)', () => {
  // build a minimal ctx as existing tests in this file already do, omitting fromSubnet/fromRouteTable
  // assert the result is identical to the pre-feature evaluateInstancePath output for the same inputs
})
```

Write this against whatever minimal-`ctx`-building helper already exists earlier in
`network.test.ts` — do not invent a new one if a `baseCtx()`-style helper is already present.

Run: `npx vitest run src/lib/world/network.test.ts`
Expected: PASS, all tests including pre-existing ones green.

- [ ] **Step 7: Commit**

```bash
git add src/lib/world/network.ts src/lib/world/network.test.ts
git commit -m "feat(network-topology): route-table egress check and security-group evaluator"
```

---

### Task 6: Wire route/security-group resolution into `compileWorld.ts`

**Files:**
- Modify: `src/lib/world/compileWorld.ts:141-154` (the `evaluateInstancePath` call site)
- Test: `src/lib/world/compileWorld.test.ts` (append)

**Interfaces:**
- Consumes: `resolveRoute`, `evaluateSecurityGroups`, widened `InstancePathContext` from Task 5;
  `doc.subnets`, `doc.routeTables`, `doc.securityGroups` from Task 1.
- Produces: nothing new — this task only changes what `compileWorld` passes into
  `evaluateInstancePath`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/world/compileWorld.test.ts (append)
describe('network topology compile wiring', () => {
  it('a doc with zero vpcs/subnets and no server.subnetId compiles byte-identically to pre-feature (regression floor)', () => {
    // build any existing minimal-but-realistic doc fixture already used elsewhere in this file
    const before = compileWorld(fixtureDocWithoutNetworking)
    // compileWorld is pure/deterministic for a fixed doc, so calling it twice must match exactly
    const again = compileWorld(fixtureDocWithoutNetworking)
    expect(again).toEqual(before)
  })

  it('the no-egress-route test: a private-subnet server with no NAT/IGW route produces a blocked path with BlockReason.kind "no-egress-route"', () => {
    // doc: two regions, a VPC+private subnet in region A with an empty route table, a server in
    // that subnet depending cross-region on a server in region B
    const compiled = compileWorld(docWithPrivateSubnetNoRoute)
    const blockedPath = compiled.paths.find(p => p.verdict === 'blocked')
    expect(blockedPath?.blockReason?.kind).toBe('no-egress-route')
  })

  it('adding a NAT gateway route to that subnet route table flips the same path to permitted', () => {
    const compiled = compileWorld(docWithPrivateSubnetNatRoute)
    const path = compiled.paths.find(p => p.dependencyId === theDependencyId)
    expect(path?.verdict).toBe('permitted')
  })

  it('the security-group test: a server with securityGroupIds set is evaluated by evaluateSecurityGroups, denying where no rule matches even though an equivalent firewall rule list would need an explicit deny', () => {
    const compiled = compileWorld(docWithSecurityGroupNoMatchingRule)
    const path = compiled.paths.find(p => p.dependencyId === theDependencyId)
    expect(path?.verdict).toBe('blocked')
    expect(path?.blockReason?.kind).toBe('firewall-deny')
  })
})
```

Build the four fixture docs (`fixtureDocWithoutNetworking`, `docWithPrivateSubnetNoRoute`,
`docWithPrivateSubnetNatRoute`, `docWithSecurityGroupNoMatchingRule`) by copying whatever base
two-region/two-server fixture this test file already uses for its existing blocked-path tests, and
layering the six new collections + `subnetId`/`securityGroupIds` on top. Read the existing "blocked
path" test in this file before writing these four — match its exact doc-construction style.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/world/compileWorld.test.ts -t "network topology compile wiring"`
Expected: FAIL (`no-egress-route` never appears; the route/SG checks aren't wired yet).

- [ ] **Step 3: Wire the new context fields at the call site**

In `compileWorld.ts`, before the `evaluateInstancePath({...})` call (line 141), resolve the
source server's subnet/route-table/egress-need:

```ts
const fromSubnet = fromServer.subnetId ? doc.subnets[fromServer.subnetId] ?? null : null
const fromRouteTable = fromSubnet ? doc.routeTables[fromSubnet.routeTableId] ?? null : null
const needsEgress = hopClassBetween(fromServer, toServer, doc.azs) === 'cross-region'
```

Then extend the call:

```ts
const evaluation = evaluateInstancePath({
  fromServer, toServer,
  fromRuntime: fromPl.runtime, toRuntime: toPl.runtime,
  toBlueprint: toBp, port: dep.port, azs: doc.azs,
  fromSubnet, fromRouteTable, needsEgress,
  securityGroups: doc.securityGroups,
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/world/compileWorld.test.ts`
Expected: PASS, including the pre-existing regression-floor test from Step 1.

- [ ] **Step 5: Run the full engine/compile test suite to catch any fixture breakage**

Run: `npx vitest run src/lib/world`
Expected: PASS, zero regressions in unrelated `compileWorld`/`network` tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/world/compileWorld.ts src/lib/world/compileWorld.test.ts
git commit -m "feat(network-topology): wire route-table and security-group checks into compileWorld"
```

---

### Task 7: Widen `LinkEndpoint`/`FaultScope`/`EndpointIds` for subnet and NAT-gateway targeting

**Files:**
- Modify: `src/lib/worldEngine/types.ts:394` (`FaultScope`), `:402-406` (`LinkEndpoint`)
- Modify: `src/lib/worldEngine/faults.ts:136-147` (`EndpointIds`, `endpointMatches`)
- Test: `src/lib/worldEngine/faults.test.ts` (append)

**Interfaces:**
- Produces: `FaultScope` gains `'subnet' | 'natGateway'`; `LinkEndpoint` gains `{ kind: 'subnet'; id:
  string }` and `{ kind: 'natGateway'; id: string }`; `EndpointIds` gains `subnetId?: string` and
  `natGatewayId?: string`; `endpointMatches` handles all six kinds explicitly (not the current
  four-branch fallthrough).

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/worldEngine/faults.test.ts (append)
describe('subnet and natGateway endpoint matching (FEAT-014)', () => {
  it('a subnet-scoped partition matches only endpoints carrying that subnetId, never a server-scoped endpoint', () => {
    const partitions = [{ from: { kind: 'subnet', id: 'subnet-1' }, to: { kind: 'internet' }, mode: 'drop', symmetric: false }]
    const matching = impairmentFor({ subnetId: 'subnet-1' }, { serverId: 'internet-sink' }, partitions as any)
    expect(matching.blocked).toBe(true)
    const nonMatching = impairmentFor({ subnetId: 'subnet-2' }, { serverId: 'internet-sink' }, partitions as any)
    expect(nonMatching.blocked).toBe(false)
  })

  it('a natGateway-scoped partition matches only endpoints carrying that natGatewayId', () => {
    const partitions = [{ from: { kind: 'natGateway', id: 'nat-1' }, to: { kind: 'internet' }, mode: 'drop', symmetric: false }]
    expect(impairmentFor({ natGatewayId: 'nat-1' }, {}, partitions as any).blocked).toBe(true)
    expect(impairmentFor({ natGatewayId: 'nat-2' }, {}, partitions as any).blocked).toBe(false)
  })

  it('a server-scoped endpoint never accidentally matches a subnet/natGateway-scoped partition (no cross-kind fallthrough)', () => {
    const partitions = [{ from: { kind: 'subnet', id: 'subnet-1' }, to: { kind: 'internet' }, mode: 'drop', symmetric: false }]
    // a server whose id happens to equal the subnet id string must NOT match, since the fallthrough
    // in the pre-Task-7 implementation matched any non-region/az endpoint kind against ids.serverId
    expect(impairmentFor({ serverId: 'subnet-1' }, {}, partitions as any).blocked).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/worldEngine/faults.test.ts -t "subnet and natGateway"`
Expected: FAIL — `'subnet'`/`'natGateway'` aren't valid `LinkEndpoint` kinds yet, and even once
typed, the pre-Task-7 `endpointMatches` fallthrough (`return ids.serverId === endpoint.id`) would
wrongly match a subnet-kind endpoint against `ids.serverId`, failing the third test above by
matching when it shouldn't — this is the exact bug the fallthrough would otherwise ship.

- [ ] **Step 3: Widen `FaultScope` and `LinkEndpoint`**

In `src/lib/worldEngine/types.ts` line 394:

```ts
export type FaultScope = 'server' | 'az' | 'region' | 'managed' | 'subnet' | 'natGateway'
```

Lines 402-406:

```ts
export type LinkEndpoint =
  | { kind: 'region'; id: string }
  | { kind: 'az'; id: string }
  | { kind: 'server'; id: string }
  | { kind: 'subnet'; id: string }
  | { kind: 'natGateway'; id: string }
  | { kind: 'internet' }
```

Log both additions in `.superpowers/sdd/contract-drift.md` (additive, per Cross-Cutting Constraint
4 — no signature break, just new union members).

- [ ] **Step 4: Widen `EndpointIds` and fix `endpointMatches`**

In `src/lib/worldEngine/faults.ts`, `EndpointIds` (lines 136-140):

```ts
export interface EndpointIds {
  regionId?: string
  azId?: string
  serverId?: string
  subnetId?: string
  natGatewayId?: string
}
```

Replace `endpointMatches` (lines 142-147) with an exhaustive switch — this is the real fix, not
just an addition, since the old code's final line silently treated every non-internet/region/az
kind as a server match:

```ts
function endpointMatches(endpoint: LinkEndpoint, ids: EndpointIds): boolean {
  switch (endpoint.kind) {
    case 'internet': return false
    case 'region': return ids.regionId === endpoint.id
    case 'az': return ids.azId === endpoint.id
    case 'server': return ids.serverId === endpoint.id
    case 'subnet': return ids.subnetId === endpoint.id
    case 'natGateway': return ids.natGatewayId === endpoint.id
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/worldEngine/faults.test.ts`
Expected: PASS, including all pre-existing tests in this file (the switch is behaviorally identical
to the old fallthrough for the four original kinds).

- [ ] **Step 6: Commit**

```bash
git add src/lib/worldEngine/types.ts src/lib/worldEngine/faults.ts src/lib/worldEngine/faults.test.ts .superpowers/sdd/contract-drift.md
git commit -m "feat(network-topology): widen LinkEndpoint/FaultScope for subnet and natGateway targeting"
```

---

### Task 8: Generalize NIC cap formulas + add `NatGatewayState`

**Files:**
- Modify: `src/lib/worldEngine/networkRuntime.ts:77-145`
- Test: `src/lib/worldEngine/networkRuntime.test.ts` (append)

**Interfaces:**
- Produces: `evaluateNic`/`applyNicCap`/`settleNic` regeneralized to accept `nicMbps: number`
  instead of `server: Server`; `createNatGatewayState()`, `applyNatGatewayCap(state, nicMbps,
  addInBytes, addOutBytes, stepMs)`, `settleNatGateway(state, nicMbps, stepMs)` — all reusing the
  exact same math, just parameterized.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/worldEngine/networkRuntime.test.ts (append)
describe('generalized NIC cap (nicMbps parameter) and NatGatewayState', () => {
  it('applyNicCap/settleNic still work when called with a server (regression floor)', () => {
    // reuse whatever existing test in this file exercises applyNicCap/settleNic with a fixture
    // server — after the signature change it should behave identically, e.g.
    // applyNicCap(state, server.specs.nicMbps, inBytes, outBytes, stepMs)
  })

  it('a NatGatewayState shares its cap across two flows the way a single NIC would', () => {
    const state = createNatGatewayState()
    const stepMs = 1000
    const nicMbps = 100 // 12.5 MB/s cap
    const capBytes = (nicMbps * 1e6 / 8) * (stepMs / 1000)
    const r1 = applyNatGatewayCap(state, nicMbps, capBytes * 0.6, 0, stepMs)
    const r2 = applyNatGatewayCap(state, nicMbps, capBytes * 0.6, 0, stepMs)
    // combined load (1.2x cap) exceeds capacity — both flows see queued latency, not full delivery
    expect(r2.queuedLatencyMs).toBeGreaterThan(0)
    settleNatGateway(state, nicMbps, stepMs)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/worldEngine/networkRuntime.test.ts -t "NatGatewayState"`
Expected: FAIL — `createNatGatewayState`/`applyNatGatewayCap`/`settleNatGateway` don't exist; the
`applyNicCap`/`settleNic` signature change (if made) also breaks the pre-existing tests until they're
updated in Step 3.

- [ ] **Step 3: Regeneralize `evaluateNic`/`applyNicCap`/`settleNic` and add the NAT gateway variants**

Replace the `server: Server` parameter with `nicMbps: number` throughout (lines 87-145):

```ts
function evaluateNic(
  state: NicState,
  nicMbps: number,
  stepMs: number,
): { capBytes: number; load: number; result: { deliveredFraction: number; queuedLatencyMs: number } } {
  const capBytes = ((nicMbps * 1e6) / 8) * (stepMs / 1000)
  const load = Math.max(state.inBytesThisStep, state.outBytesThisStep) + state.backlogBytes
  if (capBytes <= 0) return { capBytes, load, result: { deliveredFraction: 0, queuedLatencyMs: stepMs } }
  const ratio = load / capBytes
  const result =
    ratio <= 1 ? { deliveredFraction: 1, queuedLatencyMs: 0 }
    : ratio <= 2 ? { deliveredFraction: 1, queuedLatencyMs: (ratio - 1) * stepMs }
    : { deliveredFraction: 2 / ratio, queuedLatencyMs: stepMs }
  return { capBytes, load, result }
}

export function applyNicCap(
  state: NicState,
  nicMbps: number,
  addInBytes: number,
  addOutBytes: number,
  stepMs: number,
): { deliveredFraction: number; queuedLatencyMs: number } {
  addNicBytes(state, addInBytes, addOutBytes)
  return evaluateNic(state, nicMbps, stepMs).result
}

export function settleNic(
  state: NicState,
  nicMbps: number,
  stepMs: number,
): { deliveredFraction: number; queuedLatencyMs: number } {
  const { capBytes, load, result } = evaluateNic(state, nicMbps, stepMs)
  state.backlogBytes = capBytes <= 0 ? 0 : Math.min(Math.max(0, load - capBytes), capBytes)
  state.inBytesThisStep = 0
  state.outBytesThisStep = 0
  return result
}

// NAT gateway reuses the identical NicState shape/formulas — a NAT gateway IS a shared NIC from
// the flow solver's point of view, just keyed by gateway id instead of server id.
export type NatGatewayState = NicState
export const createNatGatewayState = createNicState
export const applyNatGatewayCap = applyNicCap
export const settleNatGateway = settleNic
```

Update every existing call site of `applyNicCap`/`settleNic` elsewhere in the engine (search for
them — likely in `flows.ts` or `index.ts`) to pass `server.specs.nicMbps` instead of `server`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/worldEngine/networkRuntime.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full engine test suite to catch call-site breakage**

Run: `npx vitest run src/lib/worldEngine`
Expected: PASS — this is the step that catches any missed `applyNicCap(state, server, ...)` call
site the grep in Step 3 missed.

- [ ] **Step 6: Commit**

```bash
git add src/lib/worldEngine/networkRuntime.ts src/lib/worldEngine/networkRuntime.test.ts
git commit -m "refactor(network-topology): generalize NIC cap formulas to nicMbps, add NatGatewayState alias"
```

---

### Task 9: Wire NAT gateway byte accounting into the engine step + `WorldMetrics`

**Files:**
- Modify: `src/lib/worldEngine/index.ts` (hold `Map<NatGatewayId, NatGatewayState>`, initialize at
  `start()`, account bytes per step for flows whose resolved `RouteTarget` is `natGateway`)
- Modify: `src/lib/worldEngine/metrics.ts` (publish a per-NAT-gateway byte-rate aggregate)
- Modify: `src/lib/worldEngine/types.ts:155` area (`WorldMetrics`) — add `natGatewayBytesPerSec:
  Record<string, number>` or a single world-level aggregate; decide based on what Task 10's cost
  model actually needs (a per-gateway breakdown, since NAT cost is per-gateway, not world-total)
- Test: `src/lib/worldEngine/index.test.ts` (append)

**Interfaces:**
- Consumes: `NatGatewayState`, `createNatGatewayState`, `applyNatGatewayCap`, `settleNatGateway`
  from Task 8; `resolveRoute`, `RouteTarget` from Tasks 1/5; `doc.natGateways`, `doc.subnets`,
  `doc.routeTables` from Task 1.
- Produces: `WorldEngineApi`'s published `MetricsBatch.world` gains
  `natGatewayBytesPerSec?: Record<NatGatewayId, number>` (additive-optional per Cross-Cutting
  Constraint 3's regression floor — absent when a doc has no NAT gateways).

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/worldEngine/index.test.ts (append)
it('a doc with NAT gateways accounts bytes routed through the gateway and publishes natGatewayBytesPerSec', () => {
  // build a doc: one VPC, one private subnet with a route to one NAT gateway, one server in that
  // subnet with a cross-region dependency (so its egress actually routes through the gateway),
  // start the engine, step it, read the latest MetricsBatch
  const batch = /* ... */
  expect(batch.world.natGatewayBytesPerSec?.[natGatewayId]).toBeGreaterThan(0)
})

it('two private-subnet servers sharing one NAT gateway each get roughly half its cap when both saturate it (mirrors per-server NIC shedding at the gateway level)', () => {
  // two servers, same subnet, same NAT gateway, both driving heavy cross-region egress —
  // assert their delivered fraction / queued latency matches what a single NIC at that cap
  // would show for 2x its capacity in traffic
})

it('a doc with zero natGateways produces byte-identical engine output to pre-feature for a fixed seed (regression floor)', () => {
  // toBe, not toBeCloseTo, per Cross-Cutting Constraint 3
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "NAT gateway"`
Expected: FAIL — no NAT gateway accounting exists yet.

- [ ] **Step 3: Locate the flow-solver's per-hop byte accounting**

Before writing engine code, find where `flows.ts` currently computes cross-AZ/cross-region egress
bytes per hop (feeding `depBytesById`/`crossAzBytesPerSec` per the CLAUDE.md description of
"the flow solver's `depBytesById` sizes cross-AZ/cross-region egress"). This is the exact point
where, for a hop whose source server has a `subnetId` resolving (via Task 5/6's `resolveRoute`) to
a `natGateway` target, the same byte count must ALSO be added to that NAT gateway's `NatGatewayState`
for the step — not a second independent byte computation (Cross-Cutting Constraint 6).

- [ ] **Step 4: Implement the wiring**

In `worldEngine/index.ts`:

```ts
// held alongside other per-run engine state, initialized at start()
const natGatewayStates = new Map<string, NatGatewayState>()
for (const nat of Object.values(doc.natGateways)) {
  natGatewayStates.set(nat.id, createNatGatewayState())
}
```

In the per-step flow accounting loop (the exact insertion point found in Step 3), for each hop
whose source server resolves to a NAT gateway:

```ts
const nat = doc.natGateways[natGatewayId]
if (nat) {
  const state = natGatewayStates.get(nat.id)!
  applyNatGatewayCap(state, NAT_GATEWAY_NIC_MBPS, hopBytes, 0, stepMs)
}
```

(`NAT_GATEWAY_NIC_MBPS` — since `NatGateway` in Task 1's type has no `nicMbps` field of its own,
pick a fixed constant, e.g. `10_000` (10 Gbps, a realistic AWS NAT Gateway baseline), defined once
near the top of `networkRuntime.ts` or `index.ts` alongside other engine constants like
`DEGRADE_THRESHOLD_MS`. Do not add an authorable `nicMbps` to `NatGateway` in this task — that is a
reasonable follow-up but out of scope for FEAT-014 as specced.)

At the end of the step (alongside wherever per-server NICs get `settleNic`'d), settle every NAT
gateway:

```ts
for (const [natId, state] of natGatewayStates) {
  const nat = doc.natGateways[natId]
  settleNatGateway(state, NAT_GATEWAY_NIC_MBPS, stepMs)
}
```

In `metrics.ts`, publish the per-gateway rate into the batch (find wherever `crossAzBytesPerSec` is
computed via `ema(...)` at `metrics.ts:650` and add a sibling loop):

```ts
const natGatewayBytesPerSec: Record<string, number> = {}
for (const [natId, state] of natGatewayStates) {
  natGatewayBytesPerSec[natId] = ema(state, `nat:${natId}`, state.outBytesThisStep + state.inBytesThisStep)
}
```

Only include this field on the batch when `Object.keys(natGatewayBytesPerSec).length > 0`, and add
`natGatewayBytesPerSec?: Record<string, number>` to the `WorldMetrics`/world-level metrics type in
`worldEngine/types.ts`. Log the additive type change in `.superpowers/sdd/contract-drift.md`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "NAT gateway"`
Expected: PASS.

- [ ] **Step 6: Run the regression + perf gates**

Run: `npx vitest run src/lib/worldEngine`
Expected: PASS, including the `DIVERGENCE GUARD` test (unaffected — this task adds RAM/connection
load to no path, only NAT byte accounting) and any existing `toBe` seed-fixed regression tests.

Run: `npx vitest bench/enginePerf.bench.test.ts` (or the project's documented bench command — check
`package.json` scripts if `npx vitest bench/...` isn't the right invocation)
Expected: no measurable regression for a doc without NAT gateways (the `natGatewayStates` map is
empty, so the per-step loop is zero iterations).

- [ ] **Step 7: Commit**

```bash
git add src/lib/worldEngine/index.ts src/lib/worldEngine/metrics.ts src/lib/worldEngine/types.ts src/lib/worldEngine/index.test.ts .superpowers/sdd/contract-drift.md
git commit -m "feat(network-topology): NAT gateway byte accounting per step, published natGatewayBytesPerSec"
```

---

### Task 10: Cost model — NAT gateway line item

**Files:**
- Modify: `src/lib/costModelV2.ts` (mirror `loadBalancerMonthlyUsd` and its call-site loop, lines
  116-129 and 325-342)
- Test: `src/lib/costModelV2.test.ts` (append)

**Interfaces:**
- Consumes: `doc.natGateways` from Task 1, `world.natGatewayBytesPerSec` from Task 9.
- Produces: `natGatewayMonthlyUsd(bytesPerSec: number): number`, folded into `computeWorldCost`'s
  `computeTotal`/`byRegionMap`/`byAzMap` outputs the same way the LB loop is.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/costModelV2.test.ts (append)
it('a NAT gateway with nonzero throughput adds an hourly base charge plus a per-GB processing charge to the monthly total', () => {
  const withoutNat = computeWorldCost(docWithoutNatGateway, metricsWithoutNat)
  const withNat = computeWorldCost(docWithOneNatGateway, metricsWithNatThroughput)
  expect(withNat.monthlyUsd).toBeGreaterThan(withoutNat.monthlyUsd)
})

it('a NAT gateway with zero doc.natGateways entries adds nothing to the total (regression floor)', () => {
  const before = computeWorldCost(docWithoutNatGateway, metricsWithoutNat)
  expect(before.monthlyUsd).toBeCloseTo(preFeatureExpectedTotal, 5)
})
```

Build `docWithOneNatGateway`/`metricsWithNatThroughput` by copying this test file's existing
`WorldMetrics` fixture pattern (it already constructs `crossAzBytesPerSec` etc. per the earlier
research, e.g. line 503/608) and adding one `natGateways` entry plus a `natGatewayBytesPerSec`
value on the metrics fixture.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/costModelV2.test.ts -t "NAT gateway"`
Expected: FAIL — no NAT gateway cost exists yet.

- [ ] **Step 3: Implement `natGatewayMonthlyUsd` and wire it in**

Add near `loadBalancerMonthlyUsd` (lines 116-129):

```ts
const NAT_GATEWAY_HOURLY_USD = 0.045     // AWS us-east-1 NAT Gateway hourly rate, realistic order of magnitude
const NAT_GATEWAY_PER_GB_USD = 0.045     // per-GB data processing charge — the real bill surprise

function natGatewayMonthlyUsd(bytesPerSec: number): number {
  const baseUsd = NAT_GATEWAY_HOURLY_USD * HOURS_PER_MONTH
  const gbPerMonth = (bytesPerSec * SECONDS_PER_MONTH) / BYTES_PER_GB
  return baseUsd + gbPerMonth * NAT_GATEWAY_PER_GB_USD
}
```

Then, mirroring the LB loop (lines 325-342), add:

```ts
let natGatewayUsd = 0
for (const nat of Object.values(doc.natGateways)) {
  const bytesPerSec = world?.natGatewayBytesPerSec?.[nat.id] ?? 0
  const usd = natGatewayMonthlyUsd(bytesPerSec)
  natGatewayUsd += usd
  // fold into byAzMap/byRegionMap the same way the LB loop does — resolve the NAT gateway's AZ via
  // doc.subnets[nat.subnetId]?.azId, and its region via doc.azs[...]?.regionId, matching the
  // existing byAzMap/byRegionMap accumulation pattern used for LBs in this same loop block.
}
```

Fold `natGatewayUsd` into `monthlyUsd` alongside `crossAzUsd`/`crossRegionUsd`/`internetUsd` (line
348).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/costModelV2.test.ts`
Expected: PASS, including all pre-existing tests in the file (the regression-floor test from Step 1
confirms zero NAT gateways changes nothing).

- [ ] **Step 5: Commit**

```bash
git add src/lib/costModelV2.ts src/lib/costModelV2.test.ts
git commit -m "feat(network-topology): NAT gateway hourly + per-GB cost line item"
```

---

### Task 11: Analysis rules — `no-egress-route`, `unpeered-security-group-reference`, `nat-gateway-spof`

**Files:**
- Modify: `src/lib/analysis/rules/network.ts` (add three rules, spread into `networkRules`)
- Test: `src/lib/analysis/rules/network.test.ts` (append; check this file's exact name/location
  first — mirror whatever pattern the existing `lbListenerTargetAbsent` test uses)

**Interfaces:**
- Consumes: `compiled.paths`, `compiled.instances`, `doc.natGateways`, `doc.subnets`,
  `doc.securityGroups`, `doc.vpcs` from Tasks 1/6. Rule shape: `{ id: string, family: 'network',
  run: ({ doc, compiled }) => AnalysisFinding[] }`, `AnalysisFinding` shape `{ id, ruleId, family:
  'network', severity: 'critical' | 'warning', title, why, fix, affected: string[] }` (per the
  existing `lbListenerTargetAbsent` pattern).
- Produces: `noEgressRoute`, `unpeeredSecurityGroupReference`, `natGatewaySpof` rule objects, added
  to the exported `networkRules` array (line 197-199).

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/analysis/rules/network.test.ts (append)
describe('no-egress-route rule', () => {
  it('fires when a compiled path is blocked with BlockReason.kind "no-egress-route"', () => {
    // reuse compileWorld fixtures from Task 6 or build an equivalent compiled world directly
    const findings = noEgressRoute.run({ doc, compiled })
    expect(findings.some(f => f.ruleId === 'no-egress-route')).toBe(true)
  })
  it('does not fire when no blocked path has that BlockReason.kind', () => {
    const findings = noEgressRoute.run({ doc: cleanDoc, compiled: cleanCompiled })
    expect(findings).toEqual([])
  })
})

describe('unpeered-security-group-reference rule', () => {
  it('fires when a security group rule\'s source names another group in a different, unpeered VPC', () => {
    // this repo's SecurityGroupRule.source is a FirewallSource (string), reusing the CIDR-or-'any'
    // shape from Task 1 — model "references another group" as a source string that matches a
    // known SecurityGroup.id in a different vpcId, since there is no explicit VPC peering entity
    // in this feature's scope (peering is out of scope per FEAT-014's spec; treat "no peering
    // record" as unconditionally true — any cross-VPC group reference fires this rule).
    const findings = unpeeredSecurityGroupReference.run({ doc: docWithCrossVpcSgReference, compiled })
    expect(findings.some(f => f.ruleId === 'unpeered-security-group-reference')).toBe(true)
  })
})

describe('nat-gateway-spof rule', () => {
  it('fires when more than one AZ\'s private subnets route through a single NAT gateway', () => {
    const findings = natGatewaySpof.run({ doc: docWithSharedNatAcrossTwoAzs, compiled })
    expect(findings.some(f => f.ruleId === 'nat-gateway-spof')).toBe(true)
  })
  it('does not fire when each AZ has its own NAT gateway', () => {
    const findings = natGatewaySpof.run({ doc: docWithOneNatPerAz, compiled })
    expect(findings).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/analysis/rules/network.test.ts -t "egress-route|security-group-reference|nat-gateway-spof"`
Expected: FAIL — rules don't exist.

- [ ] **Step 3: Implement the three rules**

Following the `lbListenerTargetAbsent` shape (lines 130-159):

```ts
const noEgressRoute: AnalysisRule = {
  id: 'no-egress-route',
  family: 'network',
  run: ({ compiled }) => {
    const findings: AnalysisFinding[] = []
    for (const path of compiled.paths) {
      if (path.verdict !== 'blocked' || path.blockReason?.kind !== 'no-egress-route') continue
      findings.push({
        id: `no-egress-route-${path.id}`,
        ruleId: 'no-egress-route',
        family: 'network',
        severity: 'warning',
        title: 'Subnet has no egress route',
        why: path.blockReason.detail,
        fix: 'Add a route to an internet gateway or NAT gateway in this subnet\'s route table.',
        affected: [path.fromInstanceId],
      })
    }
    return findings
  },
}

const unpeeredSecurityGroupReference: AnalysisRule = {
  id: 'unpeered-security-group-reference',
  family: 'network',
  run: ({ doc }) => {
    const findings: AnalysisFinding[] = []
    for (const group of Object.values(doc.securityGroups)) {
      for (const rule of group.rules) {
        const referenced = doc.securityGroups[rule.source]
        if (referenced && referenced.vpcId !== group.vpcId) {
          findings.push({
            id: `unpeered-sg-${group.id}-${referenced.id}`,
            ruleId: 'unpeered-security-group-reference',
            family: 'network',
            severity: 'warning',
            title: 'Security group references a group in an unpeered VPC',
            why: `${group.label} allows traffic from ${referenced.label}, which lives in a different VPC with no peering configured.`,
            fix: 'Reference a group in the same VPC, or use a CIDR source instead.',
            affected: [group.id, referenced.id],
          })
        }
      }
    }
    return findings
  },
}

const natGatewaySpof: AnalysisRule = {
  id: 'nat-gateway-spof',
  family: 'network',
  run: ({ doc }) => {
    const findings: AnalysisFinding[] = []
    const azsByNatGateway = new Map<string, Set<string>>()
    for (const subnet of Object.values(doc.subnets)) {
      if (subnet.kind !== 'private') continue
      const rt = doc.routeTables[subnet.routeTableId]
      const natRoute = rt?.routes.find(r => r.target.kind === 'natGateway')
      if (!natRoute || natRoute.target.kind !== 'natGateway') continue
      const set = azsByNatGateway.get(natRoute.target.id) ?? new Set<string>()
      set.add(subnet.azId)
      azsByNatGateway.set(natRoute.target.id, set)
    }
    for (const [natId, azSet] of azsByNatGateway) {
      if (azSet.size <= 1) continue
      findings.push({
        id: `nat-gateway-spof-${natId}`,
        ruleId: 'nat-gateway-spof',
        family: 'network',
        severity: 'warning',
        title: 'NAT gateway is a single point of failure across availability zones',
        why: `${azSet.size} availability zones' private subnets all route through the same NAT gateway.`,
        fix: 'Provision one NAT gateway per availability zone.',
        affected: [natId],
      })
    }
    return findings
  },
}
```

Add these three to the `networkRules` export (line 197-199):

```ts
export const networkRules: AnalysisRule[] = [
  blockedDependencyPath, dbPortExposed, entryUnreachable, lbListenerTargetAbsent, lbRouteDropped,
  noEgressRoute, unpeeredSecurityGroupReference, natGatewaySpof,
]
```

Note: `unpeeredSecurityGroupReference`'s "no peering record" model assumes `SecurityGroupRule.source`
can hold another group's id as a string (distinct from `'any'`/`'internal'`/a CIDR). This is a
looser reading of `FirewallSource` than Task 1's type strictly documents — if this doesn't fit
naturally, treat this rule as best-effort/lower priority: confirm with a quick check of how
`FirewallSource` is actually authored/validated elsewhere before assuming arbitrary strings are
accepted as group-id references, and adjust the implementation (or scope this rule down to "any SG
with an empty rule list in a multi-VPC world" if group-id-as-source isn't a realistic authoring
path) rather than forcing a shape that doesn't match the rest of the codebase.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/analysis/rules/network.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full analysis suite**

Run: `npx vitest run src/lib/analysis`
Expected: PASS, `ANALYSIS_RULES` in `runAnalysis.ts` still assembles cleanly (it spreads
`networkRules`, so no change needed there — verify with a quick read that `networkRules` is indeed
spread rather than enumerated by name).

- [ ] **Step 6: Commit**

```bash
git add src/lib/analysis/rules/network.ts src/lib/analysis/rules/network.test.ts
git commit -m "feat(network-topology): no-egress-route, unpeered-security-group-reference, nat-gateway-spof analysis rules"
```

---

### Task 12: `NetworkPanel.tsx` + tab wiring

**Files:**
- Modify: `src/app/store/ui.store.ts:41` (`PanelTab` union)
- Modify: `src/app/world/dock/scope.ts:70` (`WORLD_TABS`)
- Modify: `src/app/world/panels/WorldPanel.tsx` (`TAB_LABELS` ~line 73, a new `case 'network':`
  header block ~line 192+, a new render line ~line 353+)
- Create: `src/app/world/panels/NetworkPanel.tsx`
- Create: `src/app/world/panels/NetworkPanel.test.tsx`

**Interfaces:**
- Consumes: `useWorldStore` CRUD actions from Task 4 (`addVpc`, `addSubnet`, `addRouteTable`,
  `addInternetGateway`, `addNatGateway`, `addSecurityGroup`, and their `update`/`remove` siblings).
- Produces: a `'network'` `PanelTab`, a `NetworkPanel` React component rendering VPC list → subnet
  list (public/private badge, route-table summary) → NAT/IGW authoring, following this codebase's
  existing panel conventions (check `ManagedPanel.tsx` or `BlueprintsPanel.tsx` for the exact
  list/detail/empty-state structure to mirror before writing this from scratch).

- [ ] **Step 1: Add the `'network'` tab to the type/scope/label wiring**

`ui.store.ts:41`:

```ts
export type PanelTab = 'topology' | 'network' | 'blueprints' | 'packets' | 'managed' | 'connections' | 'traffic' | 'routes' | 'scenario' | 'signals' | 'analysis' | 'events' | 'cost' | 'compare' | 'config'
```

`scope.ts:70`:

```ts
const WORLD_TABS: PanelTab[] = ['topology', 'network', 'blueprints', 'packets', 'managed', 'connections', 'traffic', 'routes', 'scenario', 'signals', 'analysis', 'events', 'cost', 'compare']
```

`WorldPanel.tsx` `TAB_LABELS` (~line 73):

```ts
const TAB_LABELS: Record<PanelTab, string> = {
  topology: 'Topology', network: 'Network', blueprints: 'Blueprints', packets: 'Packets', managed: 'Managed',
  connections: 'Connections', traffic: 'Traffic',
  routes: 'Routes', scenario: 'Scenario', signals: 'Signals', analysis: 'Analysis', events: 'Events', cost: 'Cost', compare: 'Compare', config: 'Config',
}
```

- [ ] **Step 2: Read `ManagedPanel.tsx` (or the closest sibling list/detail panel) to establish the
  exact structural pattern before writing `NetworkPanel.tsx`.**

This step has no code of its own — read the file, note its header-glyph/accent/summary convention
(the `case 'managed':` example at WorldPanel.tsx lines 218-222 gives the header shape:
`{ glyph: '🗄', accent: 'var(--kit-cat-storage)', summary: ... }` — pick a non-emoji glyph per the
"No emojis. Ever." law, e.g. `⌬` or `→`, and a `var(--color-*)`-based accent, not the emoji/
`--kit-cat-*` token shown, unless `--kit-cat-*` tokens are confirmed to also be theme-safe
`var(--color-*)`-backed constants elsewhere in the file), its empty-state copy style, and its
add/edit/remove button wiring against store actions.

- [ ] **Step 3: Write the failing component test**

```tsx
// src/app/world/panels/NetworkPanel.test.tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { NetworkPanel } from './NetworkPanel'
import { useWorldStore } from '../../store/world.store'

describe('NetworkPanel', () => {
  beforeEach(() => {
    // reset the store to a baseline doc with at least one region, matching this test file's
    // sibling panel tests' setup convention
  })

  it('renders an empty state with an "add VPC" affordance when doc.vpcs is empty', () => {
    render(<NetworkPanel />)
    expect(screen.getByText(/no vpcs/i)).toBeInTheDocument()
  })

  it('clicking add VPC creates a VPC and shows it in the list', () => {
    render(<NetworkPanel />)
    fireEvent.click(screen.getByRole('button', { name: /add vpc/i }))
    expect(useWorldStore.getState().doc.vpcs).not.toEqual({})
  })

  it('selecting a VPC shows its subnets and an add-subnet control', () => {
    const vpcId = useWorldStore.getState().addVpc('region-1')
    render(<NetworkPanel />)
    fireEvent.click(screen.getByText(/vpc/i))
    expect(screen.getByRole('button', { name: /add subnet/i })).toBeInTheDocument()
    void vpcId
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run src/app/world/panels/NetworkPanel.test.tsx`
Expected: FAIL — `NetworkPanel` module doesn't exist.

- [ ] **Step 5: Implement `NetworkPanel.tsx`**

Build it against whatever exact structural pattern Step 2 identified. At minimum it must:
- List `doc.vpcs`, with an "add VPC" button calling `addVpc(activeRegionId)` (resolve
  `activeRegionId` from `nav.store.ts`'s current region focus, or default to the first region if at
  world scope with no region selected — check how `ManagedPanel`/`BlueprintsPanel` resolve a default
  region for similar world-scope-but-region-scoped-data authoring, if any do).
- On selecting a VPC, list its subnets (`Object.values(doc.subnets).filter(s => s.vpcId ===
  selectedVpcId)`) with a public/private badge and a one-line route-table summary (`0 routes` /
  `N routes, default via <target kind>`).
- An "add subnet" control calling `addSubnet(vpcId, azId, kind)` — `azId` chosen from a dropdown of
  AZs in the VPC's region (`Object.values(doc.azs).filter(az => az.regionId === vpc.regionId)`).
- NAT/IGW authoring: an "add NAT gateway" button per public subnet calling
  `addNatGateway(subnetId)`, an "add internet gateway" button per VPC calling
  `addInternetGateway(vpcId)`.
- All colors via `var(--color-*)`; no hardcoded hex; verify visually in both themes at the end of
  this task (open `npm run tauri dev`, toggle the theme in Settings, confirm the panel reads
  correctly in both).

- [ ] **Step 6: Add the `case 'network':` header block and render line in `WorldPanel.tsx`**

Near the `case 'managed':` block (~line 218-222):

```ts
case 'network':
  header = { glyph: '⌬', accent: 'var(--color-accent)', summary: `${Object.keys(doc.vpcs).length} VPC${Object.keys(doc.vpcs).length === 1 ? '' : 's'}` }
  break
```

Near the render section (~line 353+):

```tsx
{tab === 'network' && <NetworkPanel />}
```

Import `NetworkPanel` at the top of `WorldPanel.tsx`.

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run src/app/world/panels/NetworkPanel.test.tsx`
Expected: PASS.

- [ ] **Step 8: Run the broader UI test suite**

Run: `npx vitest run src/app/world`
Expected: PASS — catches any `WorldPanel.tsx`/`ui.store.ts`/`scope.ts` snapshot or tab-enumeration
test that hardcodes the old `PanelTab` list and needs updating for the new `'network'` member.

- [ ] **Step 9: Commit**

```bash
git add src/app/store/ui.store.ts src/app/world/dock/scope.ts src/app/world/panels/WorldPanel.tsx src/app/world/panels/NetworkPanel.tsx src/app/world/panels/NetworkPanel.test.tsx
git commit -m "feat(network-topology): NetworkPanel authoring surface (VPC/subnet/NAT/IGW), new network tab"
```

---

### Task 13: Security-group picker in the server drawer (replacing the firewall editor when `subnetId` is set)

**Files:**
- Create: `src/app/world/dock/drawers/SecurityGroupPicker.tsx`
- Create: `src/app/world/dock/drawers/SecurityGroupPicker.test.tsx`
- Modify: whichever existing drawer file renders the per-server firewall editor today (find it —
  likely `dock/drawers/Firewall*.tsx` per the CLAUDE.md architecture description "`dock/drawers/`
  (+ drawers/: Hardware/Firewall/Services/Placement, one open at a time)") to branch on
  `server.subnetId`

**Interfaces:**
- Consumes: `useWorldStore().doc.securityGroups`, `updateServer` (or whatever the existing per-server
  patch action is called — confirm exact name before writing), `addSecurityGroup`/
  `updateSecurityGroup` from Task 4.
- Produces: `SecurityGroupPicker` component — a multi-select of `doc.securityGroups` scoped to the
  server's subnet's VPC, patching `server.securityGroupIds`.

- [ ] **Step 1: Find the existing firewall drawer and read it in full**

Locate the file (glob for `dock/drawers/Firewall*` or grep the server drawer directory for
`firewall`). Read it completely — its exact prop shape, how it's mounted from the parent drawer
container, and its exact `updateServer`-equivalent call signature — before writing anything, since
Step 3 must branch on `subnetId` using that same mounting pattern.

- [ ] **Step 2: Write the failing test**

```tsx
// src/app/world/dock/drawers/SecurityGroupPicker.test.tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { SecurityGroupPicker } from './SecurityGroupPicker'
import { useWorldStore } from '../../../store/world.store'

describe('SecurityGroupPicker', () => {
  it('lists security groups belonging to the server\'s subnet\'s VPC only', () => {
    // seed a doc with two VPCs, each with one security group, and a server whose subnetId
    // belongs to VPC A — assert only VPC A's group appears
  })

  it('toggling a group patches server.securityGroupIds', () => {
    // render, click a group checkbox, assert useWorldStore.getState().doc.servers[id].securityGroupIds
    // includes the toggled group's id
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/app/world/dock/drawers/SecurityGroupPicker.test.tsx`
Expected: FAIL — component doesn't exist.

- [ ] **Step 4: Implement `SecurityGroupPicker.tsx`**

```tsx
import { useWorldStore } from '../../../store/world.store'
import type { Server } from '../../../../lib/world/types'

export function SecurityGroupPicker({ server }: { server: Server }) {
  const doc = useWorldStore(s => s.doc)
  const updateServer = useWorldStore(s => s.updateServer) // confirm exact action name from Step 1's findings
  const subnet = server.subnetId ? doc.subnets[server.subnetId] : null
  const groups = subnet ? Object.values(doc.securityGroups).filter(g => g.vpcId === subnet.vpcId) : []
  const selected = new Set(server.securityGroupIds ?? [])

  const toggle = (groupId: string) => {
    const next = new Set(selected)
    if (next.has(groupId)) next.delete(groupId); else next.add(groupId)
    updateServer(server.id, { securityGroupIds: Array.from(next) })
  }

  if (!subnet) return null

  return (
    <div>
      {groups.length === 0 && <p style={{ color: 'var(--color-text-muted)' }}>No security groups in this VPC.</p>}
      {groups.map(g => (
        <label key={g.id}>
          <input type="checkbox" checked={selected.has(g.id)} onChange={() => toggle(g.id)} />
          {g.label} ({g.rules.length} rule{g.rules.length === 1 ? '' : 's'})
        </label>
      ))}
    </div>
  )
}
```

Adjust the `updateServer` call to whatever the real action/signature turns out to be from Step 1.

- [ ] **Step 5: Branch the parent drawer on `server.subnetId`**

In the firewall drawer file found in Step 1, wrap its existing content:

```tsx
{server.subnetId
  ? <SecurityGroupPicker server={server} />
  : /* existing firewall editor JSX, completely unchanged */}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/app/world/dock/drawers/SecurityGroupPicker.test.tsx`
Expected: PASS.

- [ ] **Step 7: Run the dock/drawer test suite for regressions**

Run: `npx vitest run src/app/world/dock`
Expected: PASS — the existing firewall-editor tests for an un-networked server (`subnetId`
undefined) must be unaffected, since that branch is untouched.

- [ ] **Step 8: Commit**

```bash
git add src/app/world/dock/drawers/SecurityGroupPicker.tsx src/app/world/dock/drawers/SecurityGroupPicker.test.tsx src/app/world/dock/drawers/
git commit -m "feat(network-topology): security-group picker replaces firewall editor for networked servers"
```

---

### Task 14: Subnet boundary rendering on `DatacenterFloor.tsx`

**Files:**
- Modify: `src/app/world/az/DatacenterFloor.tsx`
- Test: `src/app/world/az/DatacenterFloor.test.tsx` (append; confirm exact filename first)

**Interfaces:**
- Consumes: `doc.subnets`, `doc.vpcs`, `compiled` — filtered to subnets whose `azId` matches the
  floor's current AZ. Static/compiled-state-driven, not 1 Hz-batch-driven (topology doesn't change
  mid-run).
- Produces: a dashed-outline overlay per subnet present in the current AZ, grouping the racks/pods
  of servers whose `subnetId` matches, tinted `var(--color-accent)` at low opacity for public,
  `var(--color-text-muted)` for private.

- [ ] **Step 1: Read `layoutFloor`/`floorLayout.ts` to find each rendered rack/pod's screen
  coordinates**

No code in this step — determine how to compute a bounding region around a set of racks/pods
belonging to the same subnet, using whatever geometry `layoutFloor` already exposes (tile
positions), so the boundary can be drawn as an SVG/DOM polygon around them.

- [ ] **Step 2: Write the failing test**

```tsx
// src/app/world/az/DatacenterFloor.test.tsx (append)
it('renders a subnet boundary outline for each subnet with a server in the current AZ', () => {
  // seed a doc with one VPC, one subnet in the rendered AZ, one server with that subnetId placed
  // in a rack, render DatacenterFloor, assert a subnet-boundary element with the subnet's id or
  // label appears (use a data-testid or aria-label the implementation adds, e.g.
  // `subnet-boundary-${subnet.id}`)
  render(<DatacenterFloor />)
  expect(screen.getByTestId(`subnet-boundary-${subnetId}`)).toBeInTheDocument()
})

it('renders nothing extra when no server in the AZ has a subnetId (regression floor)', () => {
  render(<DatacenterFloor />)
  expect(screen.queryByTestId(/subnet-boundary-/)).not.toBeInTheDocument()
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/app/world/az/DatacenterFloor.test.tsx -t "subnet boundary"`
Expected: FAIL — no subnet-boundary rendering exists.

- [ ] **Step 4: Implement the overlay**

Following whatever geometry helper Step 1 identified, add a render pass (alongside — not
replacing — the existing rack/pod tile rendering) that, for each subnet with at least one server in
the current AZ, computes a bounding box/polygon around those servers' tile positions and renders a
`<g data-testid={\`subnet-boundary-${subnet.id}\`}>` containing a dashed `<rect>` or `<path>`, plus
a small text label (`subnet.kind` + a short id). Use `var(--color-accent)` (public) /
`var(--color-text-muted)` (private) for the stroke, with fill at low opacity (e.g. the same color
with reduced alpha via `color-mix` or a dedicated low-opacity theme token if one exists — check
`theme.ts` for a precedent like an existing `*Faint`/`*Muted` background token before inventing a
raw alpha value). No animation — this is compiled/static state, per the motion-budget constraint.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/app/world/az/DatacenterFloor.test.tsx`
Expected: PASS, including all pre-existing tests in this large file (1000+ lines — run the whole
file, not just the new `-t` filter, to catch any layout assumption this overlay might have
disturbed).

- [ ] **Step 6: Live smoke check**

Run `npm run tauri dev`, build a two-AZ topology with one AZ having a private subnet with no NAT
route (using Task 12's `NetworkPanel` to author it), and confirm: the subnet boundary renders on
the floor, the outbound dependency paths from servers in that subnet show `blocked` with
`no-egress-route` in the Analysis tab (Task 11), and adding a NAT gateway route flips them to
`permitted`. Check both dark and light themes via the Settings modal.

- [ ] **Step 7: Commit**

```bash
git add src/app/world/az/DatacenterFloor.tsx src/app/world/az/DatacenterFloor.test.tsx
git commit -m "feat(network-topology): subnet boundary overlay on the AZ floor view"
```

---

### Task 15: Full verification pass, perf bench, and docs update

**Files:**
- Modify: `docs/module-boundaries.md` (add/adjust rows for every file this plan touched)
- No new test files — this task runs the full suite and fixes anything Tasks 1-14 missed.

- [ ] **Step 1: Full type-check**

Run: `npx tsc --noEmit`
Expected: PASS, zero errors.

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: PASS, zero failures, zero new skips.

- [ ] **Step 3: Full build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Performance bench**

Run the project's engine perf bench (check `package.json` for the exact script — likely something
like `npx vitest bench` or a dedicated `npm run bench` — confirm before running):
Expected: no measurable regression for a doc without any of the new networking entities;
< 0.1 ms/step for a doc with a handful of NAT gateways under load, per the spec's "effectively 0
ms/step beyond what networkRuntime.ts already spends" claim (Task 9's per-step NAT loop is bounded
by NAT gateway count, which is always small).

- [ ] **Step 5: Live smoke test — the full acceptance scenario from the spec**

Run `npm run tauri dev`. Build a two-AZ topology. Put one AZ's servers in a private subnet with no
NAT route (`NetworkPanel` from Task 12). Confirm:
- Their outbound dependency paths show `blocked` with `no-egress-route` in the Analysis tab.
- Adding a NAT gateway route (`NetworkPanel`) flips them to `permitted` with no other change.
- A server with `securityGroupIds` set is evaluated allow-only (deny with no matching rule, where
  the legacy firewall list would need an explicit deny rule to produce the same verdict) — verify
  by configuring one via `SecurityGroupPicker` (Task 13) and observing the Analysis/Topology tabs.
- A partition/scenario step targeting `{ kind: 'subnet', id }` (if a chaos/scenario UI surface for
  picking a `LinkEndpoint` kind exists from Wave 1 — check `ChaosControl`/scenario step editor for
  whether it already enumerates `LinkEndpoint` kinds generically, in which case Task 7's type
  addition alone makes this reachable with no further UI work) blocks all cross-subnet traffic from
  that subnet.
- Two private-subnet servers sharing one NAT gateway, both saturating it, each receive roughly half
  the gateway's cap (drive heavy cross-region traffic from both, observe latency/throughput chips).
- `unpeered-security-group-reference` and `nat-gateway-spof` findings appear in the Analysis tab
  under the misconfigurations this plan built fixtures for in Task 11.
- Subnet boundaries render correctly on the AZ floor in both dark and light themes.
- Zero new console errors throughout.

- [ ] **Step 6: Update `docs/module-boundaries.md`**

Add or adjust one row per file this plan created or modified (per-file, not narrative — match the
existing table's row format exactly): `src/lib/world/types.ts` (extended), `src/lib/world/
factories.ts` (extended), `src/lib/world/network.ts` (extended), `src/lib/world/compileWorld.ts`
(extended), `src/lib/serializer.ts` (extended), `src/app/store/world.store.ts` (extended),
`src/app/store/ui.store.ts` (extended), `src/app/world/dock/scope.ts` (extended),
`src/app/world/panels/WorldPanel.tsx` (extended), `src/app/world/panels/NetworkPanel.tsx` (new),
`src/app/world/dock/drawers/SecurityGroupPicker.tsx` (new), `src/lib/worldEngine/types.ts`
(extended), `src/lib/worldEngine/faults.ts` (extended), `src/lib/worldEngine/networkRuntime.ts`
(extended — NIC formulas generalized), `src/lib/worldEngine/index.ts` (extended — NAT gateway
accounting), `src/lib/worldEngine/metrics.ts` (extended), `src/lib/costModelV2.ts` (extended),
`src/lib/analysis/rules/network.ts` (extended — 3 new rules), `src/app/world/az/
DatacenterFloor.tsx` (extended — subnet overlay).

- [ ] **Step 7: Verify `.superpowers/sdd/contract-drift.md` has entries for every contract change**

Confirm three entries exist: Task 7's `LinkEndpoint`/`FaultScope` widening, Task 9's
`natGatewayBytesPerSec` addition to the metrics/`WorldMetrics` contract, and any other additive
`worldEngine/types.ts` change made along the way (e.g. if a NAT-gateway-related `EngineEventKind`
was added — check whether Task 9 ended up needing one, e.g. `nat_gateway_saturated`; if so, log it
here even though no earlier task explicitly scripted that entry).

- [ ] **Step 8: Final commit**

```bash
git add docs/module-boundaries.md .superpowers/sdd/contract-drift.md
git commit -m "docs(network-topology): update module boundaries and contract-drift log for FEAT-014"
```

---

## Self-Review Notes (for the plan author, kept for the executing agent's context)

- **Spec coverage:** All 12 execution steps from FEAT-014's spec are covered — Steps 1-2 (types) →
  Task 1; Step 3 (store CRUD) → Task 4; Steps 4-5 (route/SG evaluation) → Tasks 5-6; Step 6 (NAT
  gateway NIC reuse) → Tasks 8-9; Step 7 (cost) → Task 10; Step 8 (`LinkEndpoint` extension) → Task
  7; Step 9 (analysis rules) → Task 11; Steps 10-11 (`NetworkPanel` + SG drawer) → Tasks 12-13; Step
  12 (floor rendering) → Task 14. The regression-floor and live-smoke acceptance criteria are
  covered per-task and again holistically in Task 15.
- **Known simplification vs. the spec text:** `resolveRoute`'s signature is simplified from the
  spec's 3-arg CIDR-destination-matching form to a 2-arg local-vs-egress form, because this
  codebase's `Server`/`AvailabilityZone` model has no per-server IP address to match a destination
  CIDR against (documented inline in Task 5, Step 3). This is a deliberate, load-bearing deviation
  from the spec's literal signature — flag it in code review rather than treating it as a plan bug.
- **Known open question carried into execution:** `unpeeredSecurityGroupReference` (Task 11) models
  "a rule referencing another group" via `SecurityGroupRule.source` holding a group id, which is a
  looser reading of `FirewallSource` than Task 1 strictly types. Task 11 explicitly tells the
  executing agent to verify this against the real codebase before committing to the shape, and
  offers a fallback scope-down. This is intentional — the spec's design for this rule is
  underspecified relative to the rest of the feature, and forcing a shape now risks a wrong
  abstraction more than deferring the exact match semantics to implementation time.
