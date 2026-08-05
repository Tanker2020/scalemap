// src/app/world/server/ServiceChip.tsx
// Process/container service chip. T4 filled the conn/p50 line + health dot; T6 (D8, mockup
// `.b3chip .act`) adds a 12-bucket activity sparkbar fed by a rolling window of `rps` samples
// kept in component state (cap 12, drop oldest) plus a hover lift (translateY(-2px) + glow,
// mockup `.b3chip:hover`). Existing drag/select/hover dispatches (onSelect/onHover, both already
// wired to the same handlers as before) are UNCHANGED — this is additive only.
import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { useReducedMotion } from 'framer-motion'
import type { ChipLayout } from './boardLayout'
import type { HealthState } from '../../../lib/worldEngine/types'
import { HEALTH_COLOR } from './healthColor'

const SPARK_CAP = 12
const SPARK_MIN_HEIGHT_PCT = 6   // floor so a real-but-tiny sample stays visible
const SPARK_ON_THRESHOLD_PCT = 50

export interface ServiceChipProps {
  chip: ChipLayout
  name: string
  color: string
  portsLabel: string           // ":443 :80" or ":3000→8080"
  health?: HealthState
  connLabel?: string           // "1.1k conn · p50 2.1ms" — T4; T3 passes "—"
  rps?: number                 // live admitted rps — T6 sparkbar sample source
  // FEAT-004: the cache's effective hit ratio this batch (InstanceMetrics.cacheHitRatio) — present
  // only for a cache-kind instance. `cacheWarming` (effective < the blueprint's steady-state
  // target) drives the amber "still climbing" treatment vs. the steady teal readout.
  cacheHitRatio?: number
  cacheWarming?: boolean
  // FEAT-005 (Task 15): live replication lag readout — present only for a `role: 'replica'`
  // instance whose cluster has a resolvable lag this batch (src/lib/world/replicaLag.ts).
  // `replicaLagOverRpo` mirrors `cacheWarming`'s shape: true when the instance's own blueprint
  // authored an `rpoTargetSec` that this lag already exceeds, driving the same
  // steady/attention color split the cache readout uses.
  replicaLagSec?: number
  replicaLagOverRpo?: boolean
  // FEAT-007 (Task 8): live cold-start ramp readout — InstanceMetrics.warmth, present only while
  // an instance is warming (0..1, absent once it reaches 1 — see metrics.ts's `warmth01 < 1`
  // gate). Drives a partial-fill bar that interpolates from a dim/amber "still ramping" look
  // toward the chip's normal steady-state look as warmth approaches 1.
  warmth?: number
  selected?: boolean
  hovered?: boolean
  dimmed?: boolean
  onSelect?: () => void
  onHover?: (v: boolean) => void
}

export function ServiceChip({ chip, name, color, portsLabel, health = 'healthy', connLabel = '—', rps = 0, cacheHitRatio, cacheWarming, replicaLagSec, replicaLagOverRpo, warmth, selected, hovered, dimmed, onSelect, onHover }: ServiceChipProps): ReactElement {
  const reduced = useReducedMotion()
  const [samples, setSamples] = useState<number[]>([])

  useEffect(() => {
    setSamples(prev => [...prev, rps].slice(-SPARK_CAP))
  }, [rps])

  const style: CSSProperties = {
    position: 'absolute', left: chip.box.x, top: chip.box.y, width: chip.box.w, minHeight: chip.box.h,
    background: 'linear-gradient(160deg,#16202E,#0E141E)',
    border: `1px solid ${selected || hovered ? color : color + '88'}`, borderRadius: 6, padding: 6,
    boxShadow: hovered ? `0 0 16px ${color}` : `0 0 10px ${color}22`,
    opacity: dimmed ? 0.45 : 1, cursor: 'pointer', font: '9px var(--font-mono)',
    transform: hovered ? 'translateY(-2px)' : undefined,
    transition: reduced ? undefined : 'transform 0.14s, box-shadow 0.14s, opacity 0.15s',
  }

  // Always render SPARK_CAP bars — pad the front with empty (no-sample-yet) placeholders so the
  // sparkbar's width is stable from the chip's first render, filling in from the right as real
  // samples arrive (D8: "12-bucket activity sparkbar").
  const padCount = Math.max(0, SPARK_CAP - samples.length)
  const bars: (number | null)[] = [...new Array(padCount).fill(null), ...samples]
  const maxSample = Math.max(1, ...samples)

  return (
    <div data-chip data-instance={chip.instanceId} style={style} onClick={onSelect}
      onMouseEnter={() => onHover?.(true)} onMouseLeave={() => onHover?.(false)}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ color: '#DBEAFE' }}><span data-chip-tab style={{ color }}>▮</span> {name}</span>
        <span style={{ width: 4, height: 4, borderRadius: '50%', background: HEALTH_COLOR[health], boxShadow: `0 0 5px ${HEALTH_COLOR[health]}` }} />
      </div>
      <div style={{ color: '#7CFFE9', marginTop: 2, fontSize: 7 }}>{portsLabel}</div>
      <div style={{ color: 'var(--color-text-secondary)', fontSize: 7 }}>{connLabel}</div>
      {cacheHitRatio != null && (
        <div
          data-testid="cache-hit-readout" data-warming={cacheWarming ? 'true' : 'false'}
          style={{
            marginTop: 1, fontSize: 7,
            color: cacheWarming ? 'var(--color-warning)' : 'var(--color-success)',
            opacity: cacheWarming ? 0.75 : 1,
          }}
        >
          ⌬ {Math.round(cacheHitRatio * 100)}%
        </div>
      )}
      {replicaLagSec != null && (
        <div
          data-testid="replica-lag-readout" data-over-rpo={replicaLagOverRpo ? 'true' : 'false'}
          style={{
            marginTop: 1, fontSize: 7,
            color: replicaLagOverRpo ? 'var(--color-danger)' : 'var(--color-text-secondary)',
          }}
        >
          ⏎ {replicaLagSec.toFixed(1)}s
        </div>
      )}
      {warmth != null && (
        <div data-testid="warmth-readout" style={{ marginTop: 2 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 6.5, color: 'var(--color-warning)' }}>
            <span>warming</span><span>{Math.round(warmth * 100)}%</span>
          </div>
          <div style={{ position: 'relative', width: '100%', height: 3, borderRadius: 2, marginTop: 1, background: '#1a212c', overflow: 'hidden' }}>
            {/* Static partial fill at the current warmth value under reduced motion (no CSS
                transition) — Step 2's motion budget: the fill still moves as new metrics batches
                arrive (each render simply jumps to the new width), it just never animates the
                move itself. */}
            <div
              data-testid="warmth-fill"
              style={{
                position: 'absolute', left: 0, top: 0, bottom: 0,
                width: `${Math.round(Math.max(0, Math.min(1, warmth)) * 100)}%`,
                background: `color-mix(in srgb, var(--color-warning) ${Math.round((1 - warmth) * 100)}%, var(--color-success) ${Math.round(warmth * 100)}%)`,
                transition: reduced ? undefined : 'width 0.3s linear',
              }}
            />
          </div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 1.5, marginTop: 6, height: 9, alignItems: 'flex-end' }}>
        {bars.map((v, i) => {
          const pct = v == null ? 0 : Math.max(SPARK_MIN_HEIGHT_PCT, Math.round((v / maxSample) * 100))
          const on = v != null && pct >= SPARK_ON_THRESHOLD_PCT
          return (
            <i key={i} data-testid="spark-bar" data-on={on} style={{
              width: 3, display: 'block', height: `${pct}%`,
              background: on ? color : '#232a36', boxShadow: on ? `0 0 3px ${color}88` : undefined,
            }} />
          )
        })}
      </div>
    </div>
  )
}
