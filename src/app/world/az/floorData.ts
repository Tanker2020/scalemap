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
