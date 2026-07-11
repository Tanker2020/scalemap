// src/app/world/ServerView.tsx
// Level-4 server interior composition root (Phase 3): header strip + circuit-board stage +
// InspectorRail. Selection/hover are held here (T6) and threaded down into ServerBoard; Esc
// clears the selection via a CAPTURE-phase window keydown listener (see the comment on the
// effect below for why capture phase specifically is required).
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { useCompiledWorld } from './useCompiledWorld'
import { layoutServerBoard, serverTraces } from './server/boardLayout'
import { ServerBoard } from './server/ServerBoard'
import { InspectorRail } from './server/InspectorRail'
import type { BoardSelection } from './server/selection'
import type { BlueprintId } from '../../lib/world/types'

export function ServerView(): ReactElement | null {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const serverId = useNavStore(s => s.serverId)
  const server = serverId ? doc.servers[serverId] : null

  const layout = useMemo(() => (server ? layoutServerBoard(server, doc, compiled) : null), [server, doc, compiled])
  const traces = useMemo(() => (server && serverId ? serverTraces(serverId, doc, compiled) : []), [server, serverId, doc, compiled])

  const [selection, setSelection] = useState<BoardSelection | null>(null)
  const [hoveredBlueprintId, setHoveredBlueprintId] = useState<BlueprintId | null>(null)
  const selRef = useRef(selection)
  selRef.current = selection

  // WorldShell owns a `window` keydown listener in the BUBBLE phase that calls
  // `useNavStore.getState().up()` on Escape, but first bails if `e.defaultPrevented`
  // (WorldShell.tsx:44-49). ServerView mounts AFTER WorldShell, so a bubble-phase listener
  // registered here would fire second and couldn't call preventDefault() in time. Registering
  // in the CAPTURE phase instead guarantees this handler runs before WorldShell's bubble
  // handler regardless of mount order — capture always precedes bubble for a `window` listener
  // on an event that originates from a descendant node. A ref (not `selection` in the dep
  // array) keeps this effect mounted exactly once.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selRef.current) {
        e.preventDefault()          // capture phase → WorldShell's bubble Esc sees defaultPrevented and skips nav.up
        setSelection(null)
      }
    }
    window.addEventListener('keydown', onKey, true)     // CAPTURE
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Clear selection/hover when navigating to a different server.
  useEffect(() => { setSelection(null); setHoveredBlueprintId(null) }, [serverId])

  if (!server || !serverId || !layout) return null
  const az = doc.azs[server.azId]
  const gb = Math.round(server.specs.ramMb / 1024)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--color-node-border)', font: '11px var(--font-mono)', color: 'var(--color-text-secondary)' }}>
        <span style={{ color: 'var(--color-text-primary)' }}>{server.label}</span> · {server.kind} · {server.specs.vcpu} vCPU / {gb} GB
        {/* server.rack is nullable (free pool, Polish 3 T2) — this header still renders for
            an unracked server (e.g. reached before T4's free-pool tray/rack UI exists). */}
        {' — '}{az?.label ?? '?'} › {server.rack ? `${server.rack.rackId} › U${server.rack.unit}` : 'unracked'}
      </div>
      {/* D8/T6: InspectorRail re-housed from a permanent-width flex sidebar to a docked overlay
          (position:absolute inside this wrapper — see InspectorRail.tsx's own comment) so the
          board gets the full width regardless of selection state ("never eats the board"). This
          wrapper is InspectorRail's positioning ancestor; it spans exactly the area ServerBoard
          fills, so "docked to the board's bottom-right" resolves against the board itself. */}
      <div style={{ position: 'relative', display: 'flex', flex: 1, minHeight: 0 }}>
        <ServerBoard
          serverId={serverId} layout={layout} traces={traces}
          selection={selection} onSelect={setSelection}
          hoveredBlueprintId={hoveredBlueprintId} onHoverBlueprint={setHoveredBlueprintId}
        />
        <InspectorRail serverId={serverId} selection={selection} onSelect={setSelection} />
      </div>
    </div>
  )
}
