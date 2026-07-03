import {
  getBezierPath,
  useInternalNode,
  Position,
  EdgeLabelRenderer,
  type EdgeProps,
  type Edge,
  type InternalNode,
  type Node,
} from '@xyflow/react'
import type { EdgeData } from '../../../lib/nodeConfig'
import { useCanvasStore } from '../../store/canvas.store'
import { useUiStore } from '../../store/ui.store'
import { useSimulationStore } from '../../store/simulation.store'
import { CATEGORY_COLORS } from '../../../lib/theme'
import styles from './edges.module.css'

// BaseNode renders 4 unlabeled handles (Top/Left target, Bottom/Right source) so a node can
// receive/send connections from any side. Without per-handle ids, React Flow can't tell which
// physical handle a given edge actually uses and always resolves the same fixed pair — which
// forces a large S-shaped loop whenever the target ends up above or beside the source instead of
// below it. Floating-edge geometry sidesteps the ambiguity entirely: recompute the attachment
// point + side from the two nodes' live rectangles every render, so the curve always leaves
// toward wherever the other node actually is. https://reactflow.dev/examples/edges/floating-edges
function getNodeIntersection(intersectionNode: InternalNode<Node>, targetNode: InternalNode<Node>) {
  const { width, height } = intersectionNode.measured
  const intersectionNodePosition = intersectionNode.internals.positionAbsolute
  const targetPosition = targetNode.internals.positionAbsolute
  const w = (width ?? 0) / 2
  const h = (height ?? 0) / 2

  const x2 = intersectionNodePosition.x + w
  const y2 = intersectionNodePosition.y + h
  const x1 = targetPosition.x + (targetNode.measured.width ?? 0) / 2
  const y1 = targetPosition.y + (targetNode.measured.height ?? 0) / 2

  const xx1 = (x1 - x2) / (2 * w) - (y1 - y2) / (2 * h)
  const yy1 = (x1 - x2) / (2 * w) + (y1 - y2) / (2 * h)
  const a = 1 / (Math.abs(xx1) + Math.abs(yy1) || 1)
  const xx3 = a * xx1
  const yy3 = a * yy1

  return { x: w * (xx3 + yy3) + x2, y: h * (-xx3 + yy3) + y2 }
}

function getEdgePosition(node: InternalNode<Node>, intersectionPoint: { x: number; y: number }) {
  const n = node.internals.positionAbsolute
  const nx = Math.round(n.x)
  const ny = Math.round(n.y)
  const px = Math.round(intersectionPoint.x)
  const py = Math.round(intersectionPoint.y)

  if (px <= nx + 1) return Position.Left
  if (px >= nx + (node.measured.width ?? 0) - 1) return Position.Right
  if (py <= ny + 1) return Position.Top
  if (py >= ny + (node.measured.height ?? 0) - 1) return Position.Bottom
  return Position.Top
}

function getFloatingEdgeParams(source: InternalNode<Node>, target: InternalNode<Node>) {
  const sourceIntersection = getNodeIntersection(source, target)
  const targetIntersection = getNodeIntersection(target, source)
  return {
    sourceX: sourceIntersection.x,
    sourceY: sourceIntersection.y,
    targetX: targetIntersection.x,
    targetY: targetIntersection.y,
    sourcePosition: getEdgePosition(source, sourceIntersection),
    targetPosition: getEdgePosition(target, targetIntersection),
  }
}

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

// Edge colors are theme-dependent: dark mode uses each category's vivid `accent` at low alpha
// (calibrated against the near-black canvas), light mode uses the muted `foreground.light`
// variant at higher alpha (a straight accent+low-alpha swap reads as a barely-visible pale wash
// against the near-white canvas — exactly the "can't tell lines from nodes" bug this fixes).
function buildEdgeConfig(themeMode: 'dark' | 'light'): Record<string, EdgeConfig> {
  const tint = (accent: string, foregroundLight: string, darkAlpha: string, lightAlpha: string) =>
    themeMode === 'light' ? `${foregroundLight}${lightAlpha}` : `${accent}${darkAlpha}`

  return {
    request: {
      color: tint(CATEGORY_COLORS.compute.accent, CATEGORY_COLORS.compute.foreground.light, '55', 'cc'),
      markerEnd: 'url(#arrow-request)',
      markerStart: 'url(#arrow-request)',
    },
    stream: {
      color: tint(CATEGORY_COLORS.messaging.accent, CATEGORY_COLORS.messaging.foreground.light, '66', 'dd'),
      strokeDasharray: '6 4',
      animated: true,
      markerEnd: 'url(#arrow-stream)',
      className: styles.streamPath,
    },
    event: {
      color: tint(CATEGORY_COLORS.network.accent, CATEGORY_COLORS.network.foreground.light, '55', 'cc'),
      strokeDasharray: '2 4',
      markerEnd: 'url(#arrow-event)',
    },
    dependency: {
      color: themeMode === 'light' ? '#475569aa' : '#47556955',
      strokeWidth: 1,
    },
  }
}

export function ScalemapEdge({
  id, source, target,
  sourceX: fallbackSourceX, sourceY: fallbackSourceY,
  targetX: fallbackTargetX, targetY: fallbackTargetY,
  sourcePosition: fallbackSourcePosition, targetPosition: fallbackTargetPosition,
  data, selected,
}: EdgeProps<Edge<EdgeData>>) {
  const edgeData = data as EdgeData | undefined
  const edgeType = edgeData?.edgeType ?? 'request'
  const themeMode = useUiStore(s => s.themeMode)
  const edgeConfig = buildEdgeConfig(themeMode)
  const cfg = edgeConfig[edgeType] ?? edgeConfig.request
  // While a simulation runs, editing is locked and clicking an edge exists only to intercept
  // click-to-inspect-a-particle (Canvas.tsx's onPaneClick + pickParticleAtPoint) before it ever
  // reaches the pane — since particles travel exactly along this path, every attempted particle
  // click landed on this hit-stroke instead. Dropping pointer events here (mirroring the
  // nodesDraggable/nodesConnectable/nodesFocusable running-gate already used for nodes) lets
  // clicks fall through to the pane, restoring click-to-inspect without touching that logic.
  const running = useSimulationStore(s => s.running)

  // Recompute attachment points/sides from the nodes' current rectangles rather than trusting
  // the handle-derived props above — see getFloatingEdgeParams for why those props aren't
  // reliable here. Falls back to the handle-derived props only if internals aren't ready yet
  // (e.g. the very first render before node measurement completes).
  const sourceNode = useInternalNode(source)
  const targetNode = useInternalNode(target)
  const floating = sourceNode && targetNode ? getFloatingEdgeParams(sourceNode, targetNode) : null
  const sourceX = floating?.sourceX ?? fallbackSourceX
  const sourceY = floating?.sourceY ?? fallbackSourceY
  const targetX = floating?.targetX ?? fallbackTargetX
  const targetY = floating?.targetY ?? fallbackTargetY
  const sourcePosition = floating?.sourcePosition ?? fallbackSourcePosition
  const targetPosition = floating?.targetPosition ?? fallbackTargetPosition

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
      <EdgeDefs themeMode={themeMode} />
      {/* Invisible wide hit area for easy clicking */}
      <path
        d={edgePath}
        stroke="transparent"
        strokeWidth={16}
        fill="none"
        style={{ cursor: running ? 'default' : 'pointer', pointerEvents: running ? 'none' : 'stroke' }}
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
        style={{
          filter: selected ? `drop-shadow(0 0 4px ${cfg.color})` : undefined,
          pointerEvents: running ? 'none' : 'stroke',
        }}
      />
      {edgeData?.label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: running ? 'none' : 'all',
            }}
          >
            <span className={styles.edgeLabel}>{edgeData.label}</span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

function EdgeDefs({ themeMode }: { themeMode: 'dark' | 'light' }) {
  const cfg = buildEdgeConfig(themeMode)
  return (
    <svg style={{ position: 'absolute', width: 0, height: 0 }}>
      <defs>
        <marker id="arrow-request" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M0,0 L0,6 L6,3 z" fill={cfg.request.color} />
        </marker>
        <marker id="arrow-stream" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M0,0 L0,6 L6,3 z" fill={cfg.stream.color} />
        </marker>
        <marker id="arrow-event" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M0,0 L0,6 L6,3 z" fill={cfg.event.color} />
        </marker>
      </defs>
    </svg>
  )
}
