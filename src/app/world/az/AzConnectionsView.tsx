// Read-only, AZ-scoped connections graph (2026-07-25) — same visual language as
// connections/ConnectionsView.tsx (the world-scope EDITOR: drag-to-connect, move nodes, fix/
// remove edges), but this is a VIEWER only: no drag, no connect handle, no draft bar, no
// fix/remove. Nodes/edges come from lib/world/connections.ts's azConnectionGraph, which
// pre-filters edgesForView's exact aggregation down to only the dependencies with a leg touching
// this AZ (see that function's comment for why there is no per-AZ AUTHORING surface — dependencies
// live on the blueprint, not the AZ). Auto-layout only (layoutNodes) — no doc.connectionLayout
// here; persisting manual positions for a read-only, per-AZ-filtered subgraph isn't worth a new
// doc field when the world-scope graph already owns node placement.
import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { useWorldStore } from '../../store/world.store'
import { useCompiledWorld } from '../useCompiledWorld'
import {
  azConnectionGraph, layoutNodes,
  NODE_W, NODE_H, type ConnEdge, type ConnNode, type EdgeStatus,
} from '../../../lib/world/connections'

const MARGIN = 40

const STATUS_COLOR: Record<EdgeStatus, string> = {
  permitted: 'var(--color-success)',
  partial: 'var(--color-warning)',
  blocked: 'var(--color-danger)',
  unplaced: 'var(--color-text-muted)',
}

const backdrop: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
}
const surface: CSSProperties = {
  width: '94vw', height: '90vh', background: 'var(--color-surface)',
  border: '1px solid var(--color-node-border)', borderRadius: 8,
  display: 'flex', flexDirection: 'column',
  font: '11px var(--font-mono)', color: 'var(--color-text-primary)',
}
const smallBtn: CSSProperties = {
  background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
  borderRadius: 4, padding: '3px 10px', cursor: 'pointer',
  font: '11px var(--font-mono)', color: 'var(--color-text-secondary)',
}

interface Pt { x: number; y: number }

export interface AzConnectionsViewProps { azId: string; open: boolean; onClose: () => void }

export function AzConnectionsView({ azId, open, onClose }: AzConnectionsViewProps): ReactElement | null {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)

  const { nodes, edges } = useMemo(() => azConnectionGraph(doc, compiled, azId), [doc, compiled, azId])
  const pos = useMemo(() => layoutNodes(nodes, edges), [nodes, edges])
  const nodeById = useMemo(() => Object.fromEntries(nodes.map(n => [n.id, n])), [nodes])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation(); e.preventDefault()
      if (selectedEdgeId) setSelectedEdgeId(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose, selectedEdgeId])

  if (!open) return null

  const nodePos = (id: string): Pt => {
    const a = pos[id]
    return { x: MARGIN + (a?.x ?? 0), y: MARGIN + (a?.y ?? 0) }
  }
  const rightAnchor = (id: string) => { const p = nodePos(id); return { x: p.x + NODE_W, y: p.y + NODE_H / 2 } }
  const leftAnchor = (id: string) => { const p = nodePos(id); return { x: p.x, y: p.y + NODE_H / 2 } }

  const canvasW = Math.max(600, MARGIN + Math.max(0, ...nodes.map(n => nodePos(n.id).x)) + NODE_W + MARGIN)
  const canvasH = Math.max(360, MARGIN + Math.max(0, ...nodes.map(n => nodePos(n.id).y)) + NODE_H + MARGIN)

  const selectedEdge = edges.find(e => e.id === selectedEdgeId) ?? null
  const az = doc.azs[azId]

  return createPortal(
    <div style={backdrop} onClick={onClose}>
      <div style={surface} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 14px', borderBottom: '1px solid var(--color-node-border)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ font: '600 12px var(--font-mono)' }}>🔗 Connections — {az?.label ?? azId}</span>
              <span style={{
                fontSize: 9, letterSpacing: 0.3, textTransform: 'uppercase', padding: '1px 6px', borderRadius: 3,
                border: '1px solid var(--color-node-border)', color: 'var(--color-text-secondary)', background: 'var(--color-node-base)',
              }}>read-only</span>
            </div>
            <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 3, lineHeight: 1.5 }}>
              Only the edges with a leg touching this AZ — derived from the world's Connections
              graph, filtered by placement. To edit a dependency, open the world-scope Connections
              tab; edits apply wherever the service is placed. · Click an edge to inspect.
            </div>
          </div>
          <button style={smallBtn} onClick={onClose}>close</button>
        </div>

        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <div data-testid="az-conn-canvas" style={{ flex: 1, overflow: 'auto', position: 'relative', background: 'var(--color-canvas)' }}>
            {nodes.length === 0 ? (
              <div style={{ padding: 24, color: 'var(--color-text-muted)' }}>
                No connections touch this AZ yet.
              </div>
            ) : (
              <div style={{ position: 'relative', width: canvasW, height: canvasH }}>
                <svg width={canvasW} height={canvasH} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                  {edges.map(edge => (
                    <EdgePath key={edge.id} edge={edge} from={rightAnchor(edge.fromId)} to={leftAnchor(edge.toId)}
                      selected={edge.id === selectedEdgeId} onSelect={() => setSelectedEdgeId(edge.id)} />
                  ))}
                </svg>
                {nodes.map(node => (
                  <NodeBox key={node.id} node={node} pos={nodePos(node.id)} />
                ))}
              </div>
            )}
          </div>

          {selectedEdge && (
            <EdgeInspector edge={selectedEdge} nodeById={nodeById} onClose={() => setSelectedEdgeId(null)} />
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function EdgePath({ edge, from, to, selected, onSelect }: {
  edge: ConnEdge; from: Pt; to: Pt; selected: boolean; onSelect: () => void
}) {
  const color = STATUS_COLOR[edge.status]
  const d = `M ${from.x} ${from.y} C ${from.x + 50} ${from.y}, ${to.x - 50} ${to.y}, ${to.x} ${to.y}`
  const ah = `${to.x - 9},${to.y - 5} ${to.x},${to.y} ${to.x - 9},${to.y + 5}`
  return (
    <g>
      <path d={d} stroke="transparent" strokeWidth={16} fill="none" style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
        data-testid={`az-conn-edge-${edge.id}`} onClick={onSelect} />
      <path d={d} stroke={color} strokeWidth={selected ? 3 : 1.75} fill="none"
        strokeDasharray={edge.status === 'unplaced' ? '5 4' : undefined} />
      <polygon points={ah} fill={color} />
    </g>
  )
}

// No move/connect handlers, no ● handle, no ingress toggle — read-only, so a node is inert
// beyond carrying its position and identity.
function NodeBox({ node, pos }: { node: ConnNode; pos: Pt }) {
  const isInternet = node.kind === 'internet'
  const accent = isInternet ? 'var(--color-accent)' : node.kind === 'managed' ? 'var(--color-warning)' : (node.color ?? 'var(--color-accent)')
  return (
    <div data-testid={`az-conn-node-${node.id}`}
      style={{
        position: 'absolute', left: pos.x, top: pos.y, width: NODE_W, height: NODE_H,
        background: 'var(--color-node-base)', border: `1px solid var(--color-node-border)`,
        borderLeft: `3px solid ${accent}`, borderRadius: 6, boxSizing: 'border-box',
        padding: '6px 8px', display: 'flex', flexDirection: 'column', justifyContent: 'center',
        userSelect: 'none', boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 12 }}>{isInternet ? '🌐' : node.kind === 'managed' ? '🗄' : '▦'}</span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.label}</span>
      </div>
      <div style={{ fontSize: 9, color: 'var(--color-text-muted)', marginTop: 2 }}>
        {isInternet ? 'ingress source' : node.kind === 'managed' ? 'managed service' : node.publicPort ? 'service · public' : 'service'}
      </div>
    </div>
  )
}

// No fix/remove — this is a VIEWER, so the inspector is read-only detail: endpoints, port,
// protocol, verdict, and the block reason's explanation when blocked.
function EdgeInspector({ edge, nodeById, onClose }: {
  edge: ConnEdge; nodeById: Record<string, ConnNode>; onClose: () => void
}) {
  return (
    <div style={{ width: 240, borderLeft: '1px solid var(--color-node-border)', padding: 14, background: 'var(--color-surface)', overflow: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ font: '600 11px var(--font-mono)' }}>Edge</span>
        <button style={smallBtn} onClick={onClose}>×</button>
      </div>
      <div style={{ marginTop: 8 }}>{nodeById[edge.fromId]?.label} <span style={{ color: 'var(--color-text-muted)' }}>→</span> {nodeById[edge.toId]?.label}</div>
      <div style={{ marginTop: 4, color: 'var(--color-text-muted)' }}>port {edge.port} · {edge.protocol}</div>
      <div style={{ marginTop: 8, color: STATUS_COLOR[edge.status] }}>● {edge.status}
        {edge.totalPaths > 0 && edge.status !== 'permitted' && ` (${edge.blockedPaths}/${edge.totalPaths} blocked)`}
      </div>
      {edge.blockReason && <div style={{ marginTop: 6, fontSize: 10, color: 'var(--color-text-secondary)' }}>{edge.blockReason.detail}</div>}
    </div>
  )
}
