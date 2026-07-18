// src/app/world/panels/ConnectionsPanel.tsx
// The world-scope "Connections" tab (node-model Phase 2).
//
// Connections used to be reachable ONLY from a header button that opened a full-screen overlay —
// discoverable by accident, and absent from the tab set that otherwise describes the world. This
// panel makes it a first-class tab: a scannable index of every service dependency, with the
// full-screen canvas one click away for actual graph editing.
//
// Division of labour: this list ANSWERS "what talks to what, over which port, and is it working?"
// The canvas ANSWERS "how do I rewire it?" Both read the same `edgesForView` projection
// (via connectionRows), so the list and the graph can never disagree.
import type { CSSProperties, ReactElement } from 'react'
import { useMemo } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useCompiledWorld } from '../useCompiledWorld'
import { connectionRows, type ConnectionRow } from '../../../lib/world/connections'
import type { EdgeStatus } from '../../../lib/world/connections'

// A blocked edge is the most valuable thing this list can surface — it is a misconfiguration the
// user cannot otherwise see without opening the graph. 'unplaced' is intent without hardware:
// authored, but nothing is running it yet, so it is a warning rather than an error.
const STATUS_COLOR: Record<EdgeStatus, string> = {
  permitted: 'var(--color-success)',
  partial: 'var(--color-warning)',
  blocked: 'var(--color-danger)',
  unplaced: 'var(--color-text-muted)',
}

const STATUS_WORD: Record<EdgeStatus, string> = {
  permitted: 'ok', partial: 'partial', blocked: 'blocked', unplaced: 'unplaced',
}

const rowStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  font: '10px var(--font-mono)', padding: '5px 8px', marginBottom: 3,
  background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
  borderRadius: 5, color: 'var(--color-text-secondary)',
}

const actionBtn: CSSProperties = {
  font: '10px var(--font-mono)', background: 'var(--color-node-base)',
  border: '1px solid var(--color-node-border)', borderRadius: 5, padding: '4px 12px',
  color: 'var(--color-text-secondary)', cursor: 'pointer',
}

export interface ConnectionsPanelProps {
  /** Opens the full-screen graph editor — the dock is the index, the canvas is the editor. */
  onOpenGraph: () => void
}

function Row({ row }: { row: ConnectionRow }): ReactElement {
  return (
    <div style={rowStyle} data-testid={`connection-row-${row.id}`}>
      <i
        aria-hidden
        style={{
          width: 6, height: 6, borderRadius: '50%',
          background: STATUS_COLOR[row.status], flex: '0 0 auto', display: 'block',
        }}
      />
      <span style={{ color: 'var(--color-text-primary)' }}>{row.fromLabel}</span>
      <span aria-hidden style={{ color: 'var(--color-text-muted)' }}>→</span>
      <span style={{ color: 'var(--color-text-primary)' }}>{row.toLabel}</span>
      <span style={{ marginLeft: 'auto', color: 'var(--color-text-muted)', fontVariantNumeric: 'tabular-nums' }}>
        :{row.port}
      </span>
      <span style={{ color: STATUS_COLOR[row.status] }}>{STATUS_WORD[row.status]}</span>
    </div>
  )
}

export function ConnectionsPanel({ onOpenGraph }: ConnectionsPanelProps): ReactElement {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const rows = useMemo(() => connectionRows(doc, compiled), [doc, compiled])

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <button type="button" className="kit-press" style={actionBtn} onClick={onOpenGraph}>
          open graph ↗
        </button>
      </div>

      {rows.length === 0 ? (
        <div style={{ font: '10px var(--font-mono)', color: 'var(--color-text-muted)', padding: '8px 0', lineHeight: 1.6 }}>
          No connections yet. A connection is one service depending on another — open the graph to
          draw one, or add a dependency from a service.
        </div>
      ) : (
        rows.map(row => <Row key={row.id} row={row} />)
      )}
    </div>
  )
}
