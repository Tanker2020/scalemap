// src/app/world/RackNodes.tsx
// React Flow node components for the AZ canvas's rack visualization (Phase 4 D7/D8).
// Servers stack into per-rack RackFrameNode groups (parent nodes, non-interactive
// backdrop); each server renders as a RackChassisNode child (parentId + extent:'parent',
// frame-relative position from layoutRacks). WorldManagedNode is unchanged, just
// relocated here from the deleted WorldServerNode.tsx (managed services aren't
// rack-mounted — dashed border, absolute position, untouched by this phase).
import { type ReactElement } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { motion, useReducedMotion } from 'framer-motion'
import type { Server } from '../../lib/world/types'
import type { HealthState } from '../../lib/worldEngine/types'
import { RACK_PAD, RAIL_W, CHASSIS_W, PDU_H } from '../../lib/world/layoutRacks'

// ─── RackFrameNode ──────────────────────────────────────────────────────────────
// Non-interactive rack backdrop: mounting rails, caption, blank-U fillers, PDU strip.
// Chassis are separate sibling React Flow nodes (not DOM children of this component) —
// AzCanvas positions them via layoutRacks; this component only paints the chrome behind
// and around them. Scene-chrome hexes below are LOCAL consts (R2) — no semantic meaning.

const FRAME_BG = 'linear-gradient(180deg,#0A0C10,#080A0D)'
const FRAME_BORDER = '#232833'
const RAIL_DOTS = 'radial-gradient(circle,#3A4150 1.1px,transparent 1.3px)'
const FILLER_BG = 'repeating-linear-gradient(90deg,#0B0E13 0 6px,#0D1119 6px 12px)'
const PDU_BG = '#0E1218'

export interface RackFrameNodeData {
  rackId: string
  azLabel: string
  blankUnits: { y: number; h: number }[]
  pduY: number
  // Additive beyond the skeleton's 4 named fields — AzCanvas computes it (Σ resident
  // chassis vcpu × 0.05) since this data shape alone doesn't carry server/vcpu info.
  pduKw: number
  [k: string]: unknown
}

export function RackFrameNode({ data }: NodeProps): ReactElement {
  const { rackId, azLabel, blankUnits, pduY, pduKw } = data as RackFrameNodeData

  return (
    <div style={{
      position: 'relative', width: '100%', height: '100%', boxSizing: 'border-box',
      background: FRAME_BG, border: `1px solid ${FRAME_BORDER}`, borderRadius: 6,
      font: '9px var(--font-mono)', pointerEvents: 'none',
    }}>
      <div style={{
        position: 'absolute', top: -16, left: 0, width: '100%', textAlign: 'center',
        color: '#64748B', letterSpacing: '0.08em', fontSize: 9, whiteSpace: 'nowrap',
      }}>
        RACK {rackId} · {azLabel}
      </div>

      {/* mounting rails */}
      <div style={{ position: 'absolute', left: RACK_PAD, top: RACK_PAD, bottom: RACK_PAD, width: RAIL_W, backgroundImage: RAIL_DOTS, backgroundSize: '8px 9px', borderRadius: 2 }} />
      <div style={{ position: 'absolute', left: RACK_PAD + RAIL_W + CHASSIS_W, top: RACK_PAD, bottom: RACK_PAD, width: RAIL_W, backgroundImage: RAIL_DOTS, backgroundSize: '8px 9px', borderRadius: 2 }} />

      {blankUnits.map((b, i) => (
        <div key={i} data-testid="blank-filler" style={{
          position: 'absolute', left: RACK_PAD + RAIL_W, top: b.y, width: CHASSIS_W, height: b.h,
          background: FILLER_BG, border: '1px dashed #1E242E', borderRadius: 2, opacity: 0.6,
        }} />
      ))}

      <div style={{
        position: 'absolute', left: RACK_PAD + RAIL_W, top: pduY, width: CHASSIS_W, height: PDU_H,
        background: PDU_BG, border: `1px solid ${FRAME_BORDER}`, borderRadius: 3, padding: '0 5px',
        boxSizing: 'border-box', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span style={{ color: '#475569', fontSize: 7 }}>PDU · {pduKw.toFixed(1)}kW</span>
        <span style={{ display: 'flex', gap: 3 }}>
          <span style={{ width: 3, height: 3, borderRadius: '50%', background: '#22C55E' }} />
          <span style={{ width: 3, height: 3, borderRadius: '50%', background: '#22C55E' }} />
        </span>
      </div>
    </div>
  )
}

// ─── RackChassisNode ────────────────────────────────────────────────────────────

const HEALTH_COLOR: Record<HealthState, string> = {
  healthy: 'var(--color-success)', degraded: 'var(--color-warning)', down: 'var(--color-danger)',
}
const CHASSIS_BORDER: Record<HealthState, string> = {
  healthy: '1px solid #2A303C', degraded: '1px solid #F59E0B55', down: '1px solid var(--color-danger)',
}
const BAY_BG = '#0D1017', BAY_BORDER = '#2A303C'
const VENT_BG = 'repeating-linear-gradient(90deg,#1E2430 0 2px,#0D1017 2px 4px)'

export interface RackChassisNodeData {
  server: Server
  chips: { color: string; name: string }[]      // for the tooltip/title only
  internalBlocked: number
  health?: HealthState
  metrics?: { cpuMean: number; ramFrac: number; diskIo: number; nicFrac: number; rps: number } | null
  noisy: boolean                                 // noisy_neighbor event within 30s
  [k: string]: unknown
}

export function RackChassisNode({ data }: NodeProps): ReactElement {
  const { server, chips, internalBlocked, health, metrics, noisy } = data as RackChassisNodeData
  const reduced = useReducedMotion()
  const heightU = server.rack.heightU
  const gb = Math.round(server.specs.ramMb / 1024)
  // D8/mockup formula, verbatim from the skeleton — only ever evaluated at heightU 1 or 2
  // in this app (vps/dedicated). See the plan's flagged note: this undershoots the
  // mockup's own hand-drawn 2U example (8 bays) — implemented literally per "do not
  // redesign"; swap this one line if the mockup's look is what's actually wanted.
  const bays = Math.min(8, 2 * heightU + 2)
  const litBays = metrics ? Math.min(bays, Math.ceil(metrics.diskIo * bays)) : 0
  const h = health ?? 'healthy'
  const blinkAct = !reduced && !!metrics && metrics.rps > 0
  const netLit = !!metrics && metrics.nicFrac > 0.05

  return (
    <div
      title={chips.length ? chips.map(c => c.name).join(', ') : 'empty'}
      style={{
        width: '100%', height: '100%', boxSizing: 'border-box', overflow: 'hidden',
        background: 'linear-gradient(180deg,#1B202B,#12161E)', border: CHASSIS_BORDER[h],
        borderRadius: 3, padding: '4px 5px', font: '8px var(--font-mono)', color: '#E2E8F0',
        cursor: 'pointer',
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {server.label} <span style={{ color: '#64748B' }}>· {heightU}U · {server.kind} · {server.specs.vcpu}vCPU/{gb}G</span>
          {noisy && <span style={{ color: '#F59E0B' }}> ▲ noisy neighbor</span>}
        </span>
        <span style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
          <span data-testid="chassis-led" style={{ width: 4, height: 4, borderRadius: '50%', background: HEALTH_COLOR[h], boxShadow: `0 0 4px ${HEALTH_COLOR[h]}` }} />
          <motion.span
            data-testid="chassis-led"
            style={{ width: 4, height: 4, borderRadius: '50%', background: '#F59E0B', boxShadow: '0 0 4px #F59E0B' }}
            animate={blinkAct ? { opacity: [1, 0.3, 1] } : { opacity: 1 }}
            transition={blinkAct ? { duration: 0.8, repeat: Infinity, ease: 'easeInOut' } : undefined}
          />
          <span data-testid="chassis-led" style={{ width: 4, height: 4, borderRadius: '50%', background: '#4A9EFF', boxShadow: netLit ? '0 0 4px #4A9EFF' : 'none', opacity: netLit ? 1 : 0.25 }} />
        </span>
      </div>
      <div style={{ display: 'flex', gap: 3, marginTop: 3, alignItems: 'center' }}>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${bays}, 1fr)`, gap: 1.5 }}>
          {Array.from({ length: bays }).map((_, i) => (
            <div key={i} data-testid="drive-bay" style={{ height: 7, background: BAY_BG, border: `0.5px solid ${BAY_BORDER}`, borderRadius: 1, position: 'relative' }}>
              {i < litBays && <span style={{ position: 'absolute', right: 1, top: 2, width: 2, height: 2, borderRadius: '50%', background: '#22C55E' }} />}
            </div>
          ))}
        </div>
        <div style={{ flex: 1, height: 9, background: VENT_BG, borderRadius: 1, opacity: 0.9 }} />
        <div style={{ display: 'flex', gap: 1.5, alignItems: 'flex-end', height: 9 }}>
          <div data-testid="micro-bar-cpu" style={{ width: 3, height: `${Math.round((metrics?.cpuMean ?? 0) * 100)}%`, background: '#4A9EFF', borderRadius: 1 }} />
          <div data-testid="micro-bar-ram" style={{ width: 3, height: `${Math.round((metrics?.ramFrac ?? 0) * 100)}%`, background: '#F5A623', borderRadius: 1 }} />
          <div data-testid="micro-bar-io" style={{ width: 3, height: `${Math.round((metrics?.diskIo ?? 0) * 100)}%`, background: '#2DD4BF', borderRadius: 1 }} />
        </div>
      </div>
      {internalBlocked > 0 && (
        <div style={{ color: 'var(--color-danger)', fontSize: 7, marginTop: 2 }}>
          ✕ {internalBlocked} blocked internal path{internalBlocked > 1 ? 's' : ''}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

// ─── WorldManagedNode ───────────────────────────────────────────────────────────
// Unchanged from the deleted WorldServerNode.tsx — managed services aren't rack-mounted.

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
