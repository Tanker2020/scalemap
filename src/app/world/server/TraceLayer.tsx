// src/app/world/server/TraceLayer.tsx
// SVG etched traces beneath the DOM blocks (z0). Polish 3 T6 (D8): "one current convention" —
// every permitted trace draws a dim ETCHED base path at rest plus, when its rate > 0 AND it's
// among the board's top-N loudest traces (a shared motion-budget cap, same discipline as
// region/ReplicaRail.tsx's MAX_ANIMATED_RAILS), a brighter FLOWING-DASH overlay whose speed is
// proportional to rate. Blocked paths keep their own pre-existing danger-dashed + label
// treatment (a different, deliberate "denied" visual language, not a load indicator).
// Cross-highlight now has two independent sources feeding the same `related`/`dimmed` pair:
// hoveredBlueprintId (unchanged) and the current BoardSelection — selecting a chip/nic/firewall
// highlights its up/downstream traces (previously a dead prop: `selection` was destructured out
// and never read).
import type { ReactElement } from 'react'
import { useReducedMotion } from 'framer-motion'
import type { BoardLayout, StaticTrace } from './boardLayout'
import type { BlueprintId, InstanceId } from '../../../lib/world/types'
import type { InstanceMetrics } from '../../../lib/worldEngine/types'
import type { BoardSelection } from './selection'
import './hwStyles'

const PROTOCOL_COLOR: Record<StaticTrace['protocol'], string> = {
  http: '#4A9EFF', db: '#F5A623', event: '#A78BFA', stream: '#2DD4BF',
}

const MAX_ANIMATED_TRACES = 8
const MIN_FLOW_DURATION_S = 0.5
const MAX_FLOW_DURATION_S = 2.2

export interface TraceLayerProps {
  layout: BoardLayout
  traces: StaticTrace[]
  selection: BoardSelection | null
  onSelect: (s: BoardSelection | null) => void
  hoveredBlueprintId: BlueprintId | null
  serverId: string
  instances: Record<InstanceId, InstanceMetrics>
}

const traceKey = (t: StaticTrace): string => `${t.fromId}→${t.toId}→${t.protocol}`

export function TraceLayer({ layout, traces, selection, onSelect, hoveredBlueprintId, serverId, instances }: TraceLayerProps): ReactElement {
  const reducedMotion = useReducedMotion()
  const blueprintOf = (id: string): BlueprintId | null => layout.chips.find(c => c.instanceId === id)?.blueprintId ?? null
  const nicId = `nic:${serverId}`
  const rateOf = (t: StaticTrace): number => (t.fromId === nicId ? instances[t.toId]?.rps : instances[t.fromId]?.rps) ?? 0

  const selectedEndpointId: string | null =
    selection?.kind === 'instance' ? selection.instanceId
      : (selection?.kind === 'nic' || selection?.kind === 'firewall' || selection?.kind === 'rule') ? nicId
        : null

  // Motion budget (D8, mirrors ReplicaRail.tsx's MAX_ANIMATED_RAILS): rank permitted, currently-
  // loaded traces by rate and only the top N get the flowing-dash overlay; every other trace
  // (including rate-0 ones) still renders its identical static etched base.
  const animatedKeys = new Set(
    traces
      .filter(t => t.verdict !== 'blocked')
      .map(t => ({ key: traceKey(t), rate: rateOf(t) }))
      .filter(x => x.rate > 0)
      .sort((a, b) => b.rate - a.rate)
      .slice(0, MAX_ANIMATED_TRACES)
      .map(x => x.key),
  )

  return (
    <svg width={layout.stageW} height={layout.stageH}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {traces.map((t, i) => {
        const d = layout.tracePath(t.fromId, t.toId)
        if (!d) return null
        const blocked = t.verdict === 'blocked'
        const color = blocked ? 'var(--color-danger)' : PROTOCOL_COLOR[t.protocol]
        const bpRelated = hoveredBlueprintId !== null && (blueprintOf(t.fromId) === hoveredBlueprintId || blueprintOf(t.toId) === hoveredBlueprintId)
        const selRelated = selectedEndpointId !== null && (t.fromId === selectedEndpointId || t.toId === selectedEndpointId)
        const related = bpRelated || selRelated
        const dimmed = (hoveredBlueprintId !== null || selectedEndpointId !== null) && !related
        const a = layout.anchorFor(t.fromId)
        const b = layout.anchorFor(t.toId)
        const mx = a && b ? (a.x + b.x) / 2 : 0
        const my = a && b ? (a.y + b.y) / 2 : 0

        const rate = blocked ? 0 : rateOf(t)
        const animated = !reducedMotion && animatedKeys.has(traceKey(t))
        const durationS = Math.max(MIN_FLOW_DURATION_S, Math.min(MAX_FLOW_DURATION_S, 2.4 / Math.max(rate, 1)))

        return (
          <g key={i}>
            {/* etched base — always present, dim at rest, brighter when related to hover/selection */}
            <path
              d={d} fill="none" stroke={color}
              strokeWidth={blocked ? 1.6 : (related ? 2.8 : 2.2)}
              strokeDasharray={blocked ? '4 4' : undefined}
              opacity={dimmed ? 0.45 : (blocked ? 0.85 : 0.55)}
              style={{ filter: blocked ? undefined : `drop-shadow(0 0 ${related ? 7 : 4}px ${color})`, cursor: 'pointer', pointerEvents: 'stroke' }}
              onClick={() => onSelect(null)}
            />
            {/* flowing-dash overlay — only permitted traces currently carrying load, capped */}
            {!blocked && rate > 0 && (
              <path
                data-testid="trace-flow" data-animated={animated} d={d} fill="none" stroke={color}
                strokeWidth={related ? 2.4 : 1.8} strokeDasharray="7 8" strokeLinecap="round"
                opacity={dimmed ? 0.25 : 0.9} pointerEvents="none"
                className={animated ? 'hw-flow' : undefined}
                style={animated ? { animation: `hw-dashflow ${durationS.toFixed(2)}s linear infinite` } : undefined}
              />
            )}
            {blocked && t.label && (
              <text x={mx + 6} y={my - 4} fill="#FF8A8A" fontSize={8} style={{ pointerEvents: 'none' }}>
                refused — {t.label}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}
