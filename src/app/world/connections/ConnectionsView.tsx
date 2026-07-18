// Visual service-connections editor (full-stage overlay, launched from WorldShell's header).
// Services (blueprints), managed services, and a synthetic 🌐 Internet node are laid out in a
// left→right hierarchical tree (crossing-reduced, lib/world/connections.ts's layoutNodes) that
// the user can freely re-arrange by dragging nodes; manual positions persist to the world doc
// (doc.connectionLayout) and "auto-arrange" clears them back to the computed tree. Edges are the
// authored dependency graph coloured by the COMPILED reachability verdict (permitted / partial /
// blocked / unplaced) with a direction arrowhead. Drawing an edge (drag a node's ● handle onto
// another) records intent and — with auto-provision on — opens the firewall + binds the port in
// one undo step (world.store.connectServices). Clicking an edge opens an inspector with a
// one-click "fix" (fixReachability) and remove; each service carries a 🌐 ingress toggle
// (setInternetFacing). Pure geometry/verdict logic lives in lib/world/connections.ts; this file
// is presentation + dispatch only. Theme via var(--color-*); no continuous motion.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { useWorldStore } from '../../store/world.store'
import { useCompiledWorld } from '../useCompiledWorld'
import type { BlueprintDependency, DependencyTarget } from '../../../lib/world/types'
import {
  connNodes, edgesForView, layoutNodes, INTERNET_NODE,
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
interface Draft { fromId: string; toId: string; toKind: ConnNode['kind']; port: number; protocol: BlueprintDependency['protocol']; autoProvision: boolean }
interface ConnectDrag { fromId: string; x: number; y: number }
interface MoveDrag { id: string; offX: number; offY: number; x: number; y: number; moved: boolean }

export interface ConnectionsViewProps { open: boolean; onClose: () => void }

export function ConnectionsView({ open, onClose }: ConnectionsViewProps): ReactElement | null {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const store = useWorldStore.getState()
  const canvasRef = useRef<HTMLDivElement>(null)

  const [connect, setConnect] = useState<ConnectDrag | null>(null)
  const [move, setMove] = useState<MoveDrag | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)

  const nodes = useMemo(() => connNodes(doc), [doc])
  const edges = useMemo(() => edgesForView(doc, compiled), [doc, compiled])
  const autoPos = useMemo(() => layoutNodes(nodes, edges), [nodes, edges])
  const nodeById = useMemo(() => Object.fromEntries(nodes.map(n => [n.id, n])), [nodes])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation(); e.preventDefault()
      if (draft) setDraft(null)
      else if (selectedEdgeId) setSelectedEdgeId(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose, draft, selectedEdgeId])

  if (!open) return null

  // Effective top-left of a node: a manual override (absolute canvas coords) wins over the auto
  // tree position (offset by MARGIN); the node being dragged renders at its live position.
  const basePos = (id: string): Pt => {
    const o = doc.connectionLayout[id]
    if (o) return o
    const a = autoPos[id]
    return { x: MARGIN + (a?.x ?? 0), y: MARGIN + (a?.y ?? 0) }
  }
  const nodePos = (id: string): Pt => (move?.id === id ? { x: move.x, y: move.y } : basePos(id))
  const rightAnchor = (id: string) => { const p = nodePos(id); return { x: p.x + NODE_W, y: p.y + NODE_H / 2 } }
  const leftAnchor = (id: string) => { const p = nodePos(id); return { x: p.x, y: p.y + NODE_H / 2 } }

  const canvasPoint = (e: React.MouseEvent): Pt => {
    const el = canvasRef.current
    const rect = el?.getBoundingClientRect()
    return { x: e.clientX - (rect?.left ?? 0) + (el?.scrollLeft ?? 0), y: e.clientY - (rect?.top ?? 0) + (el?.scrollTop ?? 0) }
  }

  const canvasW = Math.max(600, MARGIN + Math.max(0, ...nodes.map(n => nodePos(n.id).x)) + NODE_W + MARGIN)
  const canvasH = Math.max(360, MARGIN + Math.max(0, ...nodes.map(n => nodePos(n.id).y)) + NODE_H + MARGIN)

  // ── connect drag (● handle → target node) ──
  const startConnect = (fromId: string) => { const a = rightAnchor(fromId); setConnect({ fromId, x: a.x, y: a.y }); setSelectedEdgeId(null) }
  const dropConnect = (toId: string) => {
    if (!connect) return
    const fromId = connect.fromId
    setConnect(null)
    if (fromId === toId) return
    if (fromId === INTERNET_NODE) {
      if (nodeById[toId]?.kind !== 'blueprint') return
      const primary = doc.blueprints[toId]?.ports[0]?.port ?? 8080
      store.setInternetFacing(toId, primary, true)
      return
    }
    if (nodeById[fromId]?.kind !== 'blueprint' || toId === INTERNET_NODE) return
    const toKind = nodeById[toId]?.kind
    if (toKind !== 'blueprint' && toKind !== 'managed') return
    const defaultPort = toKind === 'managed' ? (doc.managedServices[toId]?.port ?? 8080) : 8080
    setDraft({ fromId, toId, toKind, port: defaultPort, protocol: toKind === 'managed' ? 'db' : 'http', autoProvision: true })
  }

  // ── move drag (node body) ──
  const startMove = (id: string, e: React.MouseEvent) => {
    const p = basePos(id); const c = canvasPoint(e)
    setMove({ id, offX: c.x - p.x, offY: c.y - p.y, x: p.x, y: p.y, moved: false })
    setSelectedEdgeId(null)
  }

  const onCanvasMove = (e: React.MouseEvent) => {
    if (connect) { const c = canvasPoint(e); setConnect({ ...connect, x: c.x, y: c.y }); return }
    if (move) {
      const c = canvasPoint(e)
      const x = Math.max(0, c.x - move.offX), y = Math.max(0, c.y - move.offY)
      const moved = move.moved || Math.abs(x - move.x) > 2 || Math.abs(y - move.y) > 2
      setMove({ ...move, x, y, moved })
    }
  }
  const onCanvasUp = () => {
    if (move) { if (move.moved) store.setNodePosition(move.id, { x: move.x, y: move.y }); setMove(null) }
    if (connect) setConnect(null)
  }

  const commitDraft = () => {
    if (!draft) return
    const target: DependencyTarget = draft.toKind === 'managed'
      ? { kind: 'managed', managedServiceId: draft.toId }
      : { kind: 'blueprint', blueprintId: draft.toId }
    store.connectServices(draft.fromId, target, { port: draft.port, protocol: draft.protocol, autoProvision: draft.autoProvision })
    setDraft(null)
  }

  const selectedEdge = edges.find(e => e.id === selectedEdgeId) ?? null
  const hasLayout = Object.keys(doc.connectionLayout).length > 0

  return createPortal(
    <div style={backdrop} onClick={onClose}>
      <div style={surface} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 14px', borderBottom: '1px solid var(--color-node-border)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ font: '600 12px var(--font-mono)' }}>🔗 Connections</span>
              <span style={{
                fontSize: 9, letterSpacing: 0.3, textTransform: 'uppercase', padding: '1px 6px', borderRadius: 3,
                border: '1px solid var(--color-node-border)', color: 'var(--color-text-secondary)', background: 'var(--color-node-base)',
              }}>logical service graph</span>
            </div>
            {/* Scope note (design decision 2026-07-17): this graph authors service→service INTENT,
                which lives on the blueprint and applies wherever a service is placed — it is not
                per-AZ. The physical per-server picture is the AZ-floor view (Level 3). */}
            <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 3, lineHeight: 1.5 }}>
              Edges are service→service dependencies — they apply in <strong style={{ color: 'var(--color-text-secondary)' }}>every AZ/region</strong> where a
              service runs. For the per-server physical view, open an availability-zone floor. · Drag a node to move · drag its ● handle onto another to connect · click an edge to inspect.
            </div>
          </div>
          <button data-testid="conn-autoarrange" style={smallBtn} disabled={!hasLayout} title="reset to the automatic tree layout"
            onClick={() => store.clearConnectionLayout()}>⟲ auto-arrange</button>
          <button style={smallBtn} onClick={onClose}>close</button>
        </div>

        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <div ref={canvasRef} data-testid="conn-canvas" onMouseMove={onCanvasMove} onMouseUp={onCanvasUp} onMouseLeave={onCanvasUp}
            style={{ flex: 1, overflow: 'auto', position: 'relative', background: 'var(--color-canvas)' }}>
            {nodes.length <= 1 ? (
              <div style={{ padding: 24, color: 'var(--color-text-muted)' }}>
                No services yet — add blueprints in the world panel, then wire them here.
              </div>
            ) : (
              <div style={{ position: 'relative', width: canvasW, height: canvasH }}>
                <svg width={canvasW} height={canvasH} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                  {edges.map(edge => <EdgePath key={edge.id} edge={edge} from={rightAnchor(edge.fromId)} to={leftAnchor(edge.toId)}
                    selected={edge.id === selectedEdgeId} onSelect={() => { setSelectedEdgeId(edge.id); setDraft(null) }} />)}
                  {connect && (() => { const a = rightAnchor(connect.fromId); return (
                    <line x1={a.x} y1={a.y} x2={connect.x} y2={connect.y} stroke="var(--color-accent)" strokeWidth={2} strokeDasharray="4 4" />
                  ) })()}
                </svg>
                {nodes.map(node => (
                  <NodeBox key={node.id} node={node} pos={nodePos(node.id)} dragging={move?.id === node.id}
                    onStartMove={e => startMove(node.id, e)} onStartConnect={() => startConnect(node.id)} onDropConnect={() => dropConnect(node.id)}
                    onToggleIngress={() => {
                      const primary = doc.blueprints[node.id]?.ports[0]
                      if (primary) store.setInternetFacing(node.id, primary.port, primary.visibility !== 'public')
                    }} />
                ))}
              </div>
            )}
          </div>

          {selectedEdge && (
            <EdgeInspector edge={selectedEdge} nodeById={nodeById}
              onFix={() => store.fixReachability(selectedEdge.fromId, selectedEdge.id)}
              onRemove={() => {
                if (selectedEdge.fromId === INTERNET_NODE) store.setInternetFacing(selectedEdge.toId, selectedEdge.port, false)
                else store.disconnectServices(selectedEdge.fromId, selectedEdge.id)
                setSelectedEdgeId(null)
              }}
              onClose={() => setSelectedEdgeId(null)} />
          )}
        </div>

        {draft && (
          <DraftBar draft={draft} nodeById={nodeById} onChange={setDraft} onCommit={commitDraft} onCancel={() => setDraft(null)} />
        )}
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
  // Edges enter the target's LEFT face horizontally, so the arrowhead always points right (+x)
  // into the node — a fixed triangle just left of the anchor, coloured by status.
  const ah = `${to.x - 9},${to.y - 5} ${to.x},${to.y} ${to.x - 9},${to.y + 5}`
  return (
    <g>
      <path d={d} stroke="transparent" strokeWidth={16} fill="none" style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
        data-testid={`conn-edge-${edge.id}`} onClick={onSelect} />
      <path d={d} stroke={color} strokeWidth={selected ? 3 : 1.75} fill="none"
        strokeDasharray={edge.status === 'unplaced' ? '5 4' : undefined} />
      <polygon points={ah} fill={color} />
    </g>
  )
}

function NodeBox({ node, pos, dragging, onStartMove, onStartConnect, onDropConnect, onToggleIngress }: {
  node: ConnNode; pos: Pt; dragging: boolean; onStartMove: (e: React.MouseEvent) => void
  onStartConnect: () => void; onDropConnect: () => void; onToggleIngress: () => void
}) {
  const isInternet = node.kind === 'internet'
  const accent = isInternet ? 'var(--color-accent)' : node.kind === 'managed' ? 'var(--color-warning)' : (node.color ?? 'var(--color-accent)')
  return (
    <div data-testid={`conn-node-${node.id}`} onMouseDown={onStartMove} onMouseUp={onDropConnect}
      style={{
        position: 'absolute', left: pos.x, top: pos.y, width: NODE_W, height: NODE_H,
        background: 'var(--color-node-base)', border: `1px solid var(--color-node-border)`,
        borderLeft: `3px solid ${accent}`, borderRadius: 6, boxSizing: 'border-box',
        padding: '6px 8px', display: 'flex', flexDirection: 'column', justifyContent: 'center',
        cursor: dragging ? 'grabbing' : 'grab', userSelect: 'none',
        boxShadow: dragging ? '0 6px 18px rgba(0,0,0,0.4)' : '0 1px 3px rgba(0,0,0,0.25)',
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 12 }}>{isInternet ? '🌐' : node.kind === 'managed' ? '🗄' : '▦'}</span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.label}</span>
        {node.kind === 'blueprint' && (
          <button data-testid={`conn-expose-${node.id}`} title={node.publicPort ? 'internet-facing (click to make private)' : 'make internet-facing'}
            onClick={onToggleIngress} onMouseDown={e => e.stopPropagation()}
            style={{ ...smallBtn, padding: '0 5px', color: node.publicPort ? 'var(--color-success)' : 'var(--color-text-muted)' }}>🌐</button>
        )}
      </div>
      <div style={{ fontSize: 9, color: 'var(--color-text-muted)', marginTop: 2 }}>
        {isInternet ? 'ingress source' : node.kind === 'managed' ? 'managed service' : node.publicPort ? 'service · public' : 'service'}
      </div>
      {node.kind !== 'managed' && (
        <div data-testid={`conn-handle-${node.id}`} onMouseDown={e => { e.stopPropagation(); onStartConnect() }}
          title="drag to connect"
          style={{
            position: 'absolute', right: -7, top: NODE_H / 2 - 7, width: 14, height: 14, borderRadius: 7,
            background: accent, border: '2px solid var(--color-surface)', cursor: 'crosshair',
          }} />
      )}
    </div>
  )
}

function DraftBar({ draft, nodeById, onChange, onCommit, onCancel }: {
  draft: Draft; nodeById: Record<string, ConnNode>; onChange: (d: Draft) => void; onCommit: () => void; onCancel: () => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderTop: '1px solid var(--color-node-border)', background: 'var(--color-toolbar)' }}>
      <span>{nodeById[draft.fromId]?.label} <span style={{ color: 'var(--color-text-muted)' }}>→</span> {nodeById[draft.toId]?.label}</span>
      <label style={{ color: 'var(--color-text-secondary)' }}>port
        <input aria-label="draft-port" type="number" value={draft.port} onChange={e => onChange({ ...draft, port: Number(e.target.value) })}
          style={{ ...smallBtn, width: 64, marginLeft: 4 }} />
      </label>
      <label style={{ color: 'var(--color-text-secondary)' }}>protocol
        <select aria-label="draft-protocol" value={draft.protocol} onChange={e => onChange({ ...draft, protocol: e.target.value as BlueprintDependency['protocol'] })}
          style={{ ...smallBtn, marginLeft: 4 }}>
          <option value="http">http</option><option value="db">db</option><option value="event">event</option><option value="stream">stream</option>
        </select>
      </label>
      <label style={{ color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: 4 }}>
        <input aria-label="draft-autoprovision" type="checkbox" checked={draft.autoProvision} onChange={e => onChange({ ...draft, autoProvision: e.target.checked })} />
        auto-provision reachability
      </label>
      <button data-testid="conn-draft-connect" style={{ ...smallBtn, color: 'var(--color-success)' }} onClick={onCommit}>Connect</button>
      <button style={smallBtn} onClick={onCancel}>cancel</button>
    </div>
  )
}

function EdgeInspector({ edge, nodeById, onFix, onRemove, onClose }: {
  edge: ConnEdge; nodeById: Record<string, ConnNode>; onFix: () => void; onRemove: () => void; onClose: () => void
}) {
  const fixable = edge.fromId !== INTERNET_NODE && (edge.status === 'blocked' || edge.status === 'partial')
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
      <div style={{ display: 'flex', gap: 6, marginTop: 14, flexWrap: 'wrap' }}>
        {fixable && <button data-testid="conn-fix" style={{ ...smallBtn, color: 'var(--color-success)' }} onClick={onFix}>Open firewall (fix)</button>}
        <button data-testid="conn-remove" style={{ ...smallBtn, color: 'var(--color-danger)' }} onClick={onRemove}>
          {edge.fromId === INTERNET_NODE ? 'Make private' : 'Remove'}
        </button>
      </div>
    </div>
  )
}
