// src/app/world/az/floorData.ts
// Pure floor-scene data derivation (Polish 3 T4). `aggregateFlows` is a verbatim port of
// AzCanvas.tsx's edge-aggregation block (deleted this task) — same per-`(fromServer,target)`
// totals/blocked/first-reason semantics, same same-server-pairs-draw-no-edge rule — just
// relocated out of the React Flow component into a testable pure function operating on
// `CompiledWorld` (which already carries each `ServiceInstance.azId`, so no separate `servers`
// list is needed to test AZ membership the way AzCanvas's `inAz` Set did). `ledParams` is the
// six-LED CPU-threshold language RackCabinet/FreePoolPod both render. `serverAccents` (Polish 4
// T3) is a behavior-identical extraction of DatacenterFloor.tsx's formerly-inline
// `accentsByServer` useMemo — every resident-blueprint signature color per server, deduped,
// insertion order preserved — now shared by DatacenterFloor's faceplate ticks AND the dock's
// FloorPlanHeader/AzConfigTab (spec D5), so the two surfaces can never drift on "what color is
// this server." No React/store imports.
import type { AzId, CompiledWorld, ManagedServiceId, ServerId, WorldDoc } from '../../../lib/world/types'

export interface FlowEdge {
  source: ServerId
  target: string   // ServerId or ManagedServiceId
  total: number
  blocked: number
  reason: string | null
}

export function aggregateFlows(
  compiled: CompiledWorld, azId: AzId, managedHere: Set<ManagedServiceId>,
): FlowEdge[] {
  const agg = new Map<string, FlowEdge>()

  for (const p of compiled.paths) {
    const from = compiled.instances[p.fromInstanceId]
    if (!from || from.azId !== azId) continue

    let targetId: string
    if (p.to.kind === 'managed') {
      if (!managedHere.has(p.to.managedServiceId)) continue
      targetId = p.to.managedServiceId
    } else {
      const to = compiled.instances[p.to.instanceId]
      if (!to || to.azId !== azId) continue   // cross-AZ links render at region level
      if (to.serverId === from.serverId) continue   // same-server: badge, never an edge
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

  return [...agg.values()]
}

export interface LedParams {
  lit: number
  color: 'success' | 'warning' | 'danger'
}

const LED_COUNT = 6

export function ledParams(cpuMean: number): LedParams {
  const lit = Math.min(LED_COUNT, Math.max(0, Math.ceil(cpuMean * LED_COUNT)))
  const color: LedParams['color'] = cpuMean >= 0.9 ? 'danger' : cpuMean >= 0.7 ? 'warning' : 'success'
  return { lit, color }
}

// Shared with `RackCabinet.tsx`/`FreePoolPod.tsx` (each already computed its own copy for its
// own slot's LED) and `DatacenterFloor.tsx` (T8 motion-budget sweep — needs the same figure,
// AZ-wide, to rank which servers' LEDs are allowed to blink; see `MAX_ANIMATED_LEDS`).
export function meanUtilization(values?: number[]): number {
  if (!values || values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

// Per-server identity (Polish 4 T3 extraction — verbatim from DatacenterFloor.tsx's pre-T3
// inline `accentsByServer` useMemo, user request 2026-07-11: "each server should have its own
// visual"): every resident instance's blueprint color, deduped in first-seen order. A server
// hosting no colored blueprint (or none at all) simply has no entry — callers read via
// `.get(id) ?? []`, matching every existing consumer's fallback.
export function serverAccents(doc: WorldDoc, compiled: CompiledWorld): Map<ServerId, string[]> {
  const m = new Map<ServerId, string[]>()
  for (const inst of Object.values(compiled.instances)) {
    const color = doc.blueprints[inst.blueprintId]?.color
    if (!color) continue
    const list = m.get(inst.serverId) ?? []
    if (!list.includes(color)) list.push(color)
    m.set(inst.serverId, list)
  }
  return m
}

export interface IngressEdge {
  serverId: ServerId
  /** true = the public port's first-match firewall rule is allow·source-any (traffic gets in);
   *  false = a public blueprint lives here but the front door is firewalled shut. */
  allowed: boolean
  port: number
}

// Internet-ingress edges for the floor's ISP box (user request 2026-07-12: "how do I see which
// server is receiving traffic from outside"). One edge per AZ server hosting an instance of a
// public-port blueprint. Reachability replicates the analysis rules' entry convention
// (rules/network.ts `openToAny`: first port+tcp match must be allow with source 'any' —
// world/network.ts's evaluateFirewall ignores `source`, so it can't be reused here), keeping
// the floor and the entry-unreachable finding in agreement about what "reachable" means.
export function internetIngress(doc: WorldDoc, compiled: CompiledWorld, azId: AzId): IngressEdge[] {
  const firstMatchOpen = (serverId: ServerId, port: number): boolean => {
    for (const r of doc.servers[serverId]?.firewall ?? []) {
      const portOk = r.port === 'any' || r.port === port
      const protoOk = r.protocol === 'any' || r.protocol === 'tcp'
      if (portOk && protoOk) return r.action === 'allow' && r.source === 'any'
    }
    return false   // default deny
  }

  const byServer = new Map<ServerId, IngressEdge>()
  for (const inst of Object.values(compiled.instances)) {
    if (inst.azId !== azId) continue
    const publicPorts = (doc.blueprints[inst.blueprintId]?.ports ?? []).filter(p => p.visibility === 'public')
    for (const p of publicPorts) {
      const allowed = firstMatchOpen(inst.serverId, p.port)
      const existing = byServer.get(inst.serverId)
      // A server with several public ports counts as reachable if ANY of them is open.
      if (!existing || (allowed && !existing.allowed)) {
        byServer.set(inst.serverId, { serverId: inst.serverId, allowed, port: p.port })
      }
    }
  }
  return [...byServer.values()]
}
