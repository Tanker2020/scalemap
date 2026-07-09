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
