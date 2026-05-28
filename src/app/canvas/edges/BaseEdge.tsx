import {
  getBezierPath,
  EdgeLabelRenderer,
  type EdgeProps,
  type Edge,
} from '@xyflow/react'
import type { EdgeData } from '../../../lib/nodeConfig'
import styles from './edges.module.css'

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
  id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition,
  data, selected,
}: EdgeProps<Edge<EdgeData>>) {
  const edgeData = data as EdgeData | undefined
  const edgeType = edgeData?.edgeType ?? 'request'
  const cfg = EDGE_CONFIG[edgeType] ?? EDGE_CONFIG.request

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
  })

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
