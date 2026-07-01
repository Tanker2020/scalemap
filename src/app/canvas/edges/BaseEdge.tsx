import {
  getBezierPath,
  EdgeLabelRenderer,
  type EdgeProps,
  type Edge,
} from '@xyflow/react'
import type { EdgeData } from '../../../lib/nodeConfig'
import { useCanvasStore } from '../../store/canvas.store'
import styles from './edges.module.css'

const PARALLEL_GAP = 22  // px between sibling edges in the same corridor

// A cubic bezier from source→target whose two control points are displaced perpendicular to the
// straight line by `offset`, so parallel edges in the same corridor bow apart while their
// endpoints stay anchored to the node handles. Returns the SVG path plus the bowed midpoint.
function bowedPath(sx: number, sy: number, tx: number, ty: number, offset: number): [string, number, number] {
  const dx = tx - sx, dy = ty - sy
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len, ny = dx / len            // unit perpendicular
  const c1x = sx + dx / 3 + nx * offset, c1y = sy + dy / 3 + ny * offset
  const c2x = sx + (dx * 2) / 3 + nx * offset, c2y = sy + (dy * 2) / 3 + ny * offset
  const midX = (sx + tx) / 2 + nx * offset * 0.75
  const midY = (sy + ty) / 2 + ny * offset * 0.75
  return [`M${sx},${sy} C${c1x},${c1y} ${c2x},${c2y} ${tx},${ty}`, midX, midY]
}

type EdgeConfig = {
  color: string
  strokeDasharray?: string
  animated?: boolean
  markerStart?: string
  markerEnd?: string
  strokeWidth?: number
  className?: string
}

const EDGE_CONFIG: Record<string, EdgeConfig> = {
  request: {
    color: '#4A9EFF55',
    markerEnd: 'url(#arrow-request)',
    markerStart: 'url(#arrow-request)',
  },
  stream: {
    color: '#A78BFA66',
    strokeDasharray: '6 4',
    animated: true,
    markerEnd: 'url(#arrow-stream)',
    className: styles.streamPath,
  },
  event: {
    color: '#2DD4BF55',
    strokeDasharray: '2 4',
    markerEnd: 'url(#arrow-event)',
  },
  dependency: {
    color: '#47556955',
    strokeWidth: 1,
  },
}

export function ScalemapEdge({
  id, source, target,
  sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition,
  data, selected,
}: EdgeProps<Edge<EdgeData>>) {
  const edgeData = data as EdgeData | undefined
  const edgeType = edgeData?.edgeType ?? 'request'
  const cfg = EDGE_CONFIG[edgeType] ?? EDGE_CONFIG.request

  // Fan parallel edges apart: find siblings sharing this unordered {source,target} corridor and
  // this edge's index among them, then bow by a perpendicular offset. Single edges are unchanged.
  // Select the stable edges array (not a derived one) so the snapshot stays referentially cached.
  const allEdges = useCanvasStore(s => s.edges)
  const siblings = allEdges.filter(e =>
    (e.source === source && e.target === target) || (e.source === target && e.target === source),
  )
  const n = siblings.length
  const idx = Math.max(0, siblings.findIndex(e => e.id === id))
  const offset = n > 1 ? (idx - (n - 1) / 2) * PARALLEL_GAP : 0

  const [straightPath, straightLabelX, straightLabelY] = getBezierPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
  })
  const [edgePath, labelX, labelY] = offset === 0
    ? [straightPath, straightLabelX, straightLabelY]
    : bowedPath(sourceX, sourceY, targetX, targetY, offset)

  const stroke = selected
    ? cfg.color.replace(/[0-9a-f]{2}$/i, 'cc')
    : cfg.color

  return (
    <>
      <EdgeDefs />
      {/* Invisible wide hit area for easy clicking */}
      <path
        d={edgePath}
        stroke="transparent"
        strokeWidth={16}
        fill="none"
        style={{ cursor: 'pointer' }}
      />
      <path
        id={id}
        className={`${styles.edgePath} ${cfg.className ?? ''}`}
        d={edgePath}
        stroke={stroke}
        strokeWidth={selected ? (cfg.strokeWidth ?? 1.5) + 1 : cfg.strokeWidth ?? 1.5}
        strokeDasharray={cfg.strokeDasharray}
        markerEnd={cfg.markerEnd}
        markerStart={cfg.markerStart}
        style={{ filter: selected ? `drop-shadow(0 0 4px ${cfg.color})` : undefined }}
      />
      {edgeData?.label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: 'all',
            }}
          >
            <span className={styles.edgeLabel}>{edgeData.label}</span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

function EdgeDefs() {
  return (
    <svg style={{ position: 'absolute', width: 0, height: 0 }}>
      <defs>
        <marker id="arrow-request" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M0,0 L0,6 L6,3 z" fill="#4A9EFF55" />
        </marker>
        <marker id="arrow-stream" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M0,0 L0,6 L6,3 z" fill="#A78BFA66" />
        </marker>
        <marker id="arrow-event" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M0,0 L0,6 L6,3 z" fill="#2DD4BF55" />
        </marker>
      </defs>
    </svg>
  )
}
