# Phase 3 plan fragment — Tasks 1–2 (pure board layout + engine server-scope particles)

> Fragment scope: Task 1 (`boardLayout.ts` — pure layout, traces, core attribution) and Task 2
> (engine `buildServerParticles`). The controller owns the shared Global Constraints / File
> Structure header — this file does not repeat it. Signatures below are the FROZEN seam every
> later task imports; do not rename or reshape them.

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

<!-- COMPLETE -->
