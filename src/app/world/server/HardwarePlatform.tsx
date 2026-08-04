// src/app/world/server/HardwarePlatform.tsx
// Polish 3 T6 (spec D8): the substrate instruments, transcribed from the mockup's `.b3hw` section
// (docs/superpowers/specs/mockups/level-redesign-v5.html — CSS lines 196-220, markup 472-507): a
// per-core bank (one `.corecell` per vCPU, live-utilization fill, `hot` >= 0.85, a violet
// `.stealx` interference overlay ON the stolen cores — steal is physical, not a bar), 4 DIMM
// sticks stratified by resident blueprint's signature color + free headroom, a spinning disk
// platter (spin duration ∝ diskIoFraction, stopped at 0 — one of the board's animated strokes),
// and queue-depth ticks driven by Σ resident instance activeConnections. Replaces the D4/D5
// CPU-ring/RAM-reservoir/disk-slice-per-volume design; that design's oom warning and per-volume
// detail now live elsewhere (InspectorRail's `instance` panel already computes its own oom flag;
// StackPlate's volume cylinders dispatch `{kind:'volume',...}` independently of this panel), so
// this component no longer needs memLimits/instanceRamMb/volumeConsumers/attribution.
import type { CSSProperties, ReactElement } from 'react'
import { useReducedMotion } from 'framer-motion'
import type { Server, InstanceId, BlueprintId, ServiceBlueprint } from '../../../lib/world/types'
import type { ServerMetrics } from '../../../lib/worldEngine/types'
import type { BoardSelection } from './selection'
import './hwStyles'

const CORE_BLUE = '#5B9CF6', CORE_BLUE_HI = '#7cb2ff'      // mockup --blue
const TEAL = '#3FC7B8'                                     // mockup --teal
const STEAL_VIOLET = '#9c8ce0aa'                            // mockup .stealx repeating-gradient stop
const FREE_GREY = '#4a5361'                                 // dimmStrata's own free-stratum color
const CORE_BG = '#141a24', CORE_BORDER = '#1e2530'
const DIMM_BG = '#10151d', DIMM_BORDER = '#232b38'
const PLATTER_RING = '#232b38'

const STICK_COUNT = 4
const QTICK_COUNT = 12
// Mirrors capacity.ts's `IOPS_SATURATION_THRESHOLD` (the iops-saturated analysis rule) — the
// bar redlines at the same fraction the rule fires at, so what the board shows and what the
// analysis tab flags never disagree.
const DISK_SATURATION_THRESHOLD = 0.9
// Motion budget (D1, T8 sweep): `hw-coreflicker`/`hw-glitch` were gated on nothing but hot/steal
// state, so a large dedicated box (up to 32 vCPU — see instanceCatalog.ts's `dedicated-32`)
// could animate every one of its 32 core cells at once, unbounded. Capped to the top
// MAX_ANIMATED_CORES busiest cores (by utilization) — the same "rank by magnitude, render the
// rest static" shape as `az/DatacenterFloor.tsx`'s `MAX_ANIMATED_LEDS` and region's dot-stream/
// beam/rail caps; a core outside the top-N still shows its exact fill height, just without the
// flicker/steal-glitch overlay animating.
const MAX_ANIMATED_CORES = 4
// No true "max io-queue depth" metric exists on ServerMetrics/InstanceMetrics — this is a
// documented, deliberately soft visual scale (connections per lit tick), not a spec'd constant.
const QUEUE_CONN_PER_TICK = 3

// ── Pure derivations (exported for tests, brief's exact signatures) ──

export function coreCells(
  coreUtilization: number[], stealFraction: number,
): { h: number; hot: boolean; steal: boolean }[] {
  const stealCount = stealFraction > 0 ? Math.ceil(stealFraction * coreUtilization.length) : 0
  return coreUtilization.map((u, i) => ({ h: u, hot: u >= 0.85, steal: stealFraction > 0 && i < stealCount }))
}

interface TaggedSeg { blueprintId: BlueprintId | null; color: string; frac: number }

// Shared walk behind both `dimmStrata` (exported, exact-shape tested) and the component's own
// render (which additionally needs each segment's blueprintId for cross-highlight dim + legend +
// hover — a strict superset, stripped below to produce the public shape).
function dimmStrataTagged(
  ramByInstance: { blueprintId: BlueprintId; ramMb: number }[],
  blueprints: Record<BlueprintId, ServiceBlueprint>,
  ramTotalMb: number,
): TaggedSeg[][] {
  const sticks: TaggedSeg[][] = Array.from({ length: STICK_COUNT }, () => [])
  if (ramTotalMb <= 0) return sticks

  const byBp = new Map<BlueprintId, number>()
  for (const r of ramByInstance) byBp.set(r.blueprintId, (byBp.get(r.blueprintId) ?? 0) + r.ramMb)
  const usedTotal = [...byBp.values()].reduce((a, b) => a + b, 0)

  const strata: { blueprintId: BlueprintId | null; color: string; mb: number }[] =
    [...byBp.keys()].sort().map(id => ({ blueprintId: id, color: blueprints[id]?.color ?? '#888', mb: byBp.get(id)! }))
  strata.push({ blueprintId: null, color: FREE_GREY, mb: Math.max(0, ramTotalMb - usedTotal) })

  const capPerStick = ramTotalMb / STICK_COUNT
  let stickIdx = 0
  let stickRemaining = capPerStick
  for (const s of strata) {
    let mbLeft = s.mb
    while (mbLeft > 1e-9 && stickIdx < STICK_COUNT) {
      const take = Math.min(mbLeft, stickRemaining)
      if (take > 1e-9) sticks[stickIdx].push({ blueprintId: s.blueprintId, color: s.color, frac: take / capPerStick })
      mbLeft -= take
      stickRemaining -= take
      if (stickRemaining <= 1e-9) { stickIdx++; stickRemaining = capPerStick }
    }
  }
  return sticks
}

export function dimmStrata(
  ramByInstance: { blueprintId: BlueprintId; ramMb: number }[],
  blueprints: Record<BlueprintId, ServiceBlueprint>,
  ramTotalMb: number,
): { color: string; frac: number }[][] {
  return dimmStrataTagged(ramByInstance, blueprints, ramTotalMb).map(stick => stick.map(({ color, frac }) => ({ color, frac })))
}

export interface HardwarePlatformProps {
  server: Server
  metrics: ServerMetrics | null
  // Identity pairs only (D5 at-rest synthesis needs "which instances are resident"; the RAM
  // baseline itself comes from `blueprints[blueprintId].workload.ramBaseMb`).
  residentInstances: { instanceId: InstanceId; blueprintId: BlueprintId }[]
  blueprints: Record<BlueprintId, ServiceBlueprint>
  hoveredBlueprintId: BlueprintId | null
  onHoverBlueprint: (id: BlueprintId | null) => void
  onSelect: (s: BoardSelection | null) => void
  queueDepth?: number   // Σ resident instance activeConnections
}

export function HardwarePlatform(props: HardwarePlatformProps): ReactElement {
  const { server, metrics, residentInstances, blueprints, hoveredBlueprintId, onHoverBlueprint, onSelect, queueDepth = 0 } = props
  const reduced = useReducedMotion()
  const vcpu = server.specs.vcpu
  const cols = Math.min(8, Math.max(1, vcpu))
  const dimFor = (bpId: BlueprintId | null): number => (bpId && hoveredBlueprintId && bpId !== hoveredBlueprintId ? 0.45 : 1)

  const atRest = metrics === null
  const cores = metrics?.coreUtilization ?? new Array(vcpu).fill(0)
  const steal = metrics?.stealFraction ?? 0
  const io = metrics?.diskIoFraction ?? 0
  const cells = coreCells(cores, steal)
  const animatedCoreIndices = new Set(
    cells
      .map((c, i) => ({ i, h: c.h }))
      .sort((a, b) => b.h - a.h)
      .slice(0, MAX_ANIMATED_CORES)
      .map(x => x.i),
  )

  const ramTotalMb = metrics?.ramTotalMb ?? server.specs.ramMb
  const ramByInstance = atRest
    ? residentInstances.map(r => ({ blueprintId: r.blueprintId, ramMb: blueprints[r.blueprintId]?.workload.ramBaseMb ?? 0 }))
    : metrics!.ramByInstance.map(s => ({ blueprintId: s.blueprintId, ramMb: s.ramMb }))
  const ramUsedMb = metrics?.ramUsedMb ?? ramByInstance.reduce((a, s) => a + s.ramMb, 0)
  const sticks = dimmStrataTagged(ramByInstance, blueprints, ramTotalMb)

  const legend = new Map<BlueprintId, { name: string; color: string }>()
  for (const stick of sticks) for (const seg of stick) {
    if (seg.blueprintId && !legend.has(seg.blueprintId)) {
      legend.set(seg.blueprintId, { name: blueprints[seg.blueprintId]?.name ?? '?', color: seg.color })
    }
  }

  const spinning = !reduced && io > 0
  const platterDurationS = Math.max(0.4, 1.4 / Math.max(io, 0.05))
  const onTicks = Math.min(QTICK_COUNT, Math.round(queueDepth / QUEUE_CONN_PER_TICK))
  const ticks = Array.from({ length: QTICK_COUNT }, (_, i) => ({ on: i < onTicks, warn: i === QTICK_COUNT - 1 && onTicks >= QTICK_COUNT }))

  const legendSwatch: CSSProperties = { display: 'inline-block', width: 5, height: 5, borderRadius: 1, marginRight: 3, verticalAlign: -0.5 }

  return (
    <div data-hardware style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', gap: 9, padding: 8, font: '7px var(--font-mono)', color: 'var(--color-text-secondary)', overflowY: 'auto' }}>
      <div style={{ fontSize: 7, letterSpacing: '0.12em', color: 'var(--color-text-muted)' }}>
        SUBSTRATE — {vcpu} vCPU · {server.kind === 'vps' ? 'SHARED TENANCY' : 'DEDICATED'}
      </div>

      {/* Core bank (mockup .corebank/.corecell) */}
      <div data-corebank onClick={() => onSelect({ kind: 'hardware', part: 'cpu' })}
        style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 3, cursor: 'pointer' }}>
        {cells.map((c, i) => {
          const flickering = !reduced && animatedCoreIndices.has(i)
          return (
            <div key={i} data-testid="core-cell" data-hot={c.hot} data-steal={c.steal}
              style={{ height: 14, borderRadius: 2, background: CORE_BG, border: `1px solid ${CORE_BORDER}`, position: 'relative', overflow: 'hidden' }}>
              <div className={flickering ? 'hw-flicker' : undefined} style={{
                position: 'absolute', left: 0, right: 0, bottom: 0, height: `${Math.round(c.h * 100)}%`,
                background: c.hot ? 'linear-gradient(180deg,#ffd28a,var(--color-warning))' : `linear-gradient(180deg,${CORE_BLUE_HI},${CORE_BLUE})`,
                animation: flickering ? 'hw-coreflicker 1.7s ease-in-out infinite' : undefined,
              }} />
              {c.steal && (
                <div data-testid="core-steal" className={flickering ? 'hw-steal' : undefined} style={{
                  position: 'absolute', inset: 0,
                  background: `repeating-linear-gradient(45deg, transparent 0 3px, ${STEAL_VIOLET} 3px 5px)`,
                  animation: flickering ? `hw-glitch 3.2s steps(1) infinite ${(i % 2) * 1.4}s` : undefined,
                }} />
              )}
            </div>
          )
        })}
      </div>
      <div style={{ fontSize: 6.5, color: 'var(--color-text-muted)' }}>
        core load · ▨ = neighbor steal
        {steal > 0 && <span style={{ color: '#9c8ce0' }}> · +{Math.round(steal * 100)}% steal</span>}
      </div>

      {/* DIMM sticks (mockup .dimms/.dimm/.seg/.notch) */}
      <div data-dimms onClick={() => onSelect({ kind: 'hardware', part: 'ram' })}
        style={{ display: 'flex', gap: 5, height: 56, alignItems: 'flex-end', cursor: 'pointer' }}>
        {sticks.map((segs, i) => (
          <div key={i} data-testid="dimm-stick" style={{
            flex: 1, height: '100%', position: 'relative', overflow: 'hidden',
            border: `1px solid ${DIMM_BORDER}`, borderRadius: '3px 3px 5px 5px', background: DIMM_BG,
          }}>
            <div style={{ position: 'absolute', top: 3, left: '50%', width: 8, height: 3, background: DIMM_BORDER, transform: 'translateX(-50%)', borderRadius: 1 }} />
            {(() => {
              let acc = 0
              return segs.map((seg, k) => {
                const el = (
                  <div key={k} data-testid="dimm-seg" data-blueprint={seg.blueprintId ?? 'free'}
                    onMouseEnter={() => seg.blueprintId && onHoverBlueprint(seg.blueprintId)}
                    onMouseLeave={() => seg.blueprintId && onHoverBlueprint(null)}
                    style={{
                      position: 'absolute', left: 2, right: 2, bottom: `${acc * 100}%`, height: `${seg.frac * 100}%`,
                      background: seg.color, opacity: dimFor(seg.blueprintId), borderRadius: 1,
                    }} />
                )
                acc += seg.frac
                return el
              })
            })()}
          </div>
        ))}
      </div>
      <div style={{ fontSize: 6, color: 'var(--color-text-muted)', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {[...legend.entries()].map(([id, l]) => (
          <span key={id}><span style={{ ...legendSwatch, background: l.color }} />{l.name}</span>
        ))}
        <span><span style={{ ...legendSwatch, background: FREE_GREY }} />free</span>
        <span style={{ marginLeft: 'auto' }}>
          {(ramUsedMb / 1024).toFixed(1)} / {(ramTotalMb / 1024).toFixed(0)} G{atRest && ' (at rest)'}
        </span>
      </div>

      {/* Disk platter + queue-depth ticks (mockup .platter/.qdepth/.qticks) */}
      <div data-disk onClick={() => onSelect({ kind: 'hardware', part: 'disk' })}
        style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, cursor: 'pointer', marginTop: 2 }}>
        <div data-testid="platter" style={{
          position: 'relative', width: 44, height: 44, borderRadius: '50%', flexShrink: 0,
          background: `repeating-radial-gradient(circle, ${CORE_BG} 0 4px, ${DIMM_BG} 4px 8px)`, border: `1px solid ${PLATTER_RING}`,
        }}>
          <div data-testid="platter-spin" data-spinning={spinning} className={spinning ? 'hw-spin' : undefined} style={{
            position: 'absolute', inset: 0, borderRadius: '50%',
            background: `conic-gradient(from 0deg, transparent 0 330deg, ${TEAL}cc 352deg, transparent 360deg)`,
            animation: spinning ? `spin ${platterDurationS.toFixed(2)}s linear infinite` : undefined,
          }} />
          <div style={{ position: 'absolute', left: '50%', top: '50%', width: 8, height: 8, borderRadius: '50%', background: PLATTER_RING, transform: 'translate(-50%,-50%)' }} />
        </div>
        <div style={{ color: 'var(--color-text-secondary)' }}>
          {server.specs.diskType ?? 'nvme0'} · io {Math.round(io * 100)}%
        </div>
        {/* Disk saturation bar (Task 22, FEAT-006): same visual language as the core-cell fill —
            a track + fill, redlining to var(--color-danger) once ServerMetrics.diskIoFraction
            crosses the same threshold the iops-saturated analysis rule fires at. */}
        <div style={{ width: '100%' }}>
          <div data-testid="disk-io-track" style={{
            position: 'relative', width: '100%', height: 5, borderRadius: 3,
            background: CORE_BG, border: `1px solid ${CORE_BORDER}`, overflow: 'hidden',
          }}>
            <div data-testid="disk-io-fill" data-saturated={io >= DISK_SATURATION_THRESHOLD} style={{
              position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.min(100, Math.round(io * 100))}%`,
              background: io >= DISK_SATURATION_THRESHOLD ? 'var(--color-danger)' : TEAL,
            }} />
          </div>
        </div>
        <div style={{ width: '100%' }}>
          <div style={{ fontSize: 6, color: 'var(--color-text-muted)', display: 'flex', justifyContent: 'space-between' }}>
            <span>io queue</span><span>depth {Math.round(queueDepth)} / {QTICK_COUNT * QUEUE_CONN_PER_TICK}</span>
          </div>
          <div style={{ display: 'flex', gap: 2, marginTop: 3, justifyContent: 'center' }}>
            {ticks.map((t, i) => (
              <i key={i} data-testid="qtick" data-on={t.on} data-warn={t.warn} style={{
                width: 5, height: 12, borderRadius: 1,
                background: t.warn ? 'var(--color-warning)' : (t.on ? TEAL : '#1a212c'),
                boxShadow: t.on && !t.warn ? `0 0 3px ${TEAL}66` : undefined,
                opacity: t.warn ? 0.35 : 1,
              }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
