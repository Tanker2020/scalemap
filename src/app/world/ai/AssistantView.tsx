// The read-only AI chat assistant overlay — a floating, non-modal window (hand-rolled drag via
// the header + resize via the corner handle, no new dependency). Builds a fresh ChatContextInput
// from the live doc/compiled/simulation state on every render and hands it to sendChatTurn.ts,
// which owns the actual request lifecycle via chat.store.ts. Position/size persist for the
// session in chat.store.ts's windowRect field (in-memory only, dies on app restart).
import { useEffect, useCallback, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { useReducedMotion } from 'framer-motion'
import { useChatStore, type WindowRect } from '../../store/chat.store'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useCompiledWorld } from '../useCompiledWorld'
import { runAnalysis } from '../../../lib/analysis/runAnalysis'
import { loadLlmSettings } from '../../../lib/tauri'
import { sendChatTurn } from './sendChatTurn'
import { ChatComposer } from './ChatComposer'
import { ChatTranscript } from './ChatTranscript'
import { AttachmentBar } from './AttachmentBar'
import type { ChatTurn } from '../../store/chat.store'
import type { ChatContextInput } from '../../../lib/aiChat/context'

const WINDOW_MIN_WIDTH = 380
const WINDOW_MIN_HEIGHT = 320
const WINDOW_DEFAULT_WIDTH = 720
const WINDOW_DEFAULT_HEIGHT = 600
// Minimum px of the window that must stay reachable on every edge after a drag — prevents
// dragging the header fully off-screen and losing the window with no way to grab it back.
const EDGE_MARGIN = 40

function clampRect(rect: WindowRect): WindowRect {
  const width = Math.max(WINDOW_MIN_WIDTH, Math.min(rect.width, window.innerWidth))
  const height = Math.max(WINDOW_MIN_HEIGHT, Math.min(rect.height, window.innerHeight))
  // minX/minY are re-derived from the FINAL width/height above (not whatever was passed in),
  // so a resize (which keeps x/y fixed while growing width/height) re-validates the same
  // left/top EDGE_MARGIN guarantee a move gets — this is what keeps a stranded-off-viewport
  // rect (e.g. after the app window itself shrinks) recoverable on the read path too.
  const minX = EDGE_MARGIN - width
  const maxX = window.innerWidth - EDGE_MARGIN
  const minY = 0
  const maxY = Math.max(0, window.innerHeight - EDGE_MARGIN)
  const x = Math.max(minX, Math.min(rect.x, maxX))
  const y = Math.max(minY, Math.min(rect.y, maxY))
  return { x, y, width, height }
}

const headerStyle: CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '8px 12px', borderBottom: '1px solid var(--color-node-border)',
  cursor: 'grab', userSelect: 'none', flexShrink: 0,
}

export function AssistantView({ open, onClose, openSettings }: {
  open: boolean; onClose: () => void; openSettings: () => void
}) {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const events = useSimulationStore(s => s.events)
  const latestBatch = useSimulationStore(s => s.latestBatch)
  const running = useSimulationStore(s => s.running)
  const batchSimMs = latestBatch?.simMs ?? null
  const replayFrames = useMemo(() => useSimulationStore.getState().getReplayFrames(), [batchSimMs])
  const reducedMotion = useReducedMotion() ?? false

  const storedRect = useChatStore(s => s.windowRect)
  const setWindowRect = useChatStore(s => s.setWindowRect)
  // AssistantView is always-mounted (only `open` gates the `return null` below), so a useMemo([])
  // here would capture the viewport at APP STARTUP, not at first open. Computed fresh on every
  // render instead (cheap — four arithmetic reads of window.inner{Width,Height}) so it reflects
  // the CURRENT viewport whenever it's actually used (i.e. before the user's first drag/resize,
  // after which storedRect always wins).
  const defaultRect: WindowRect = {
    width: WINDOW_DEFAULT_WIDTH, height: WINDOW_DEFAULT_HEIGHT,
    x: Math.max(0, (window.innerWidth - WINDOW_DEFAULT_WIDTH) / 2),
    y: Math.max(0, (window.innerHeight - WINDOW_DEFAULT_HEIGHT) / 2),
  }
  // Ephemeral, only set while a drag/resize is actively in progress — lets the window visually
  // track the pointer without writing to the store on every pointermove. Committed to the store
  // once, on pointerup.
  const [liveRect, setLiveRect] = useState<WindowRect | null>(null)
  const liveRectRef = useRef<WindowRect | null>(null)
  const dragState = useRef<{ mode: 'move' | 'resize'; startX: number; startY: number; startRect: WindowRect } | null>(null)
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  // Re-clamped on every render (not just mid-drag) — otherwise a stored rect that was valid when
  // saved but is now off-viewport (the app window itself got resized/moved smaller) would strand
  // the window permanently, with no "reset position" affordance anywhere in the UI.
  const rect = clampRect(liveRect ?? storedRect ?? defaultRect)

  // Forces a re-render when the viewport changes so a stored-but-now-out-of-bounds rect gets
  // visually corrected immediately (via the clampRect call above) rather than waiting on some
  // unrelated state change to trigger the next render.
  const [, setResizeTick] = useState(0)
  useEffect(() => {
    const onViewportResize = () => setResizeTick(t => t + 1)
    window.addEventListener('resize', onViewportResize)
    return () => window.removeEventListener('resize', onViewportResize)
  }, [])

  const onDragMove = useCallback((e: PointerEvent) => {
    const ds = dragState.current
    if (!ds) return
    const dx = e.clientX - ds.startX
    const dy = e.clientY - ds.startY
    const next = clampRect(ds.mode === 'move'
      ? { ...ds.startRect, x: ds.startRect.x + dx, y: ds.startRect.y + dy }
      : { ...ds.startRect, width: ds.startRect.width + dx, height: ds.startRect.height + dy })
    liveRectRef.current = next
    setLiveRect(next)
  }, [])

  const onDragEnd = useCallback(() => {
    window.removeEventListener('pointermove', onDragMove)
    window.removeEventListener('pointerup', onDragEnd)
    window.removeEventListener('pointercancel', onDragEnd)
    const committed = liveRectRef.current
    const start = dragState.current?.startRect
    // A zero-movement header click (pointerdown+pointerup with no pointermove between them)
    // still runs this path — only commit to the store if the rect actually changed, and always
    // clamp what gets committed so a first-ever interaction against an unclamped defaultRect
    // can't persist an out-of-bounds rect.
    const changed = !!committed && (!start
      || start.x !== committed.x || start.y !== committed.y
      || start.width !== committed.width || start.height !== committed.height)
    if (changed) setWindowRect(clampRect(committed!))
    dragState.current = null
    liveRectRef.current = null
    setLiveRect(null)
  }, [onDragMove, setWindowRect])

  const beginDrag = useCallback((e: ReactPointerEvent<HTMLElement>, mode: 'move' | 'resize') => {
    if (mode === 'move' && (e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    dragState.current = { mode, startX: e.clientX, startY: e.clientY, startRect: rect }
    liveRectRef.current = rect
    setLiveRect(rect)
    window.addEventListener('pointermove', onDragMove)
    window.addEventListener('pointerup', onDragEnd)
    // pointercancel can fire mid-drag on some platforms/input methods (e.g. a touch/pen input
    // interrupted by the OS) — without handling it, dragState/listeners would be left dangling
    // with no pointerup ever arriving to clean them up.
    window.addEventListener('pointercancel', onDragEnd)
  }, [rect, onDragMove, onDragEnd])

  // Closing the overlay abandons any turn still in flight — otherwise a late resolve/fail from
  // a question the user has already walked away from would silently land in the transcript (or
  // mutate inFlightTurnId) the next time the overlay reopens. abandonInFlight() bumps
  // chat.store.ts's requestGen, which makes resolveTurn/failTurn's gen check a no-op for that
  // turn (see sendChatTurn.ts).
  const handleClose = useCallback(() => {
    if (useChatStore.getState().inFlightTurnId) useChatStore.getState().abandonInFlight()
    onClose()
  }, [onClose])

  // The window is non-modal (no backdrop) — the user can click into the globe/region/server
  // views behind it and keep working while the assistant stays open. Escape must therefore only
  // close the assistant (and swallow the event so WorldShell.tsx's own Escape handler — nav.up(),
  // disarming placeMode — doesn't ALSO fire) when the assistant surface actually has focus. If
  // focus is elsewhere (the user's actual interaction target is the world behind it), let the
  // event through untouched so WorldShell's bubble-phase handler receives it normally.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const active = document.activeElement
      if (!surfaceRef.current || !active || !surfaceRef.current.contains(active)) return
      e.stopPropagation(); e.preventDefault()
      handleClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, handleClose])

  // Defensive cleanup for a drag/resize left in progress when this component unmounts (e.g.
  // WorldShell itself unmounts mid-drag, or — in the real Tauri webview — the pointer leaves the
  // surface entirely and no pointerup ever reaches beginDrag's listeners). Without this, onDragEnd
  // still fires on an eventual pointerup and writes a stale windowRect via the zustand store even
  // after the owning component is gone, and/or the listener leaks for the rest of the session.
  // Removing a listener that was never added or was already removed is a harmless no-op.
  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', onDragMove)
      window.removeEventListener('pointerup', onDragEnd)
      window.removeEventListener('pointercancel', onDragEnd)
    }
  }, [onDragMove, onDragEnd])

  // Memoized so a metrics tick (latestBatch/events churn roughly once a second while a sim runs)
  // doesn't force a full runAnalysis() pass + rebuild the whole ChatContextInput on every render —
  // real jank risk on larger worlds, and the whole point of NOT gating this overlay behind
  // `disabled={running}` is that it has to stay responsive mid-run.
  const contextInput: ChatContextInput = useMemo(() => ({
    doc, compiled,
    findings: runAnalysis(doc, compiled, latestBatch ?? null),
    compileFindings: compiled.findings,
    latestBatch: latestBatch ?? null,
    events,
    replayFrames,
  }), [doc, compiled, latestBatch, events, replayFrames])

  const send = useCallback(async (question: string) => {
    // Loaded fresh on every send, NOT cached — matching AiReviewSection.tsx's own
    // `await loadLlmSettings()`-per-request convention.
    const settings = await loadLlmSettings()
    const selected = useChatStore.getState().selected
    if (useChatStore.getState().inFlightTurnId) useChatStore.getState().abandonInFlight()
    await sendChatTurn(settings, question, selected, contextInput)
  }, [contextInput])

  const retry = useCallback((turn: ChatTurn) => { void send(turn.question) }, [send])

  if (!open) return null

  const surfaceStyle: CSSProperties = {
    position: 'fixed', left: rect.x, top: rect.y, width: rect.width, height: rect.height,
    background: 'var(--color-surface)', border: '1px solid var(--color-node-border)', borderRadius: 8,
    display: 'flex', flexDirection: 'column',
    font: '11px var(--font-mono)', color: 'var(--color-text-primary)',
    zIndex: 1000, boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
  }
  const resizeHandleStyle: CSSProperties = {
    position: 'absolute', bottom: 0, right: 0, width: 14, height: 14, cursor: 'nwse-resize',
    background: `linear-gradient(135deg, transparent 0%, transparent 40%, var(--color-node-border) 40%,
      var(--color-node-border) 45%, transparent 45%, transparent 65%, var(--color-node-border) 65%,
      var(--color-node-border) 70%, transparent 70%, transparent 90%, var(--color-node-border) 90%,
      var(--color-node-border) 95%, transparent 95%)`,
  }

  // Deliberately NO backdrop <div> — this window is floating/non-modal (design spec §3): clicks
  // on the globe/region/AZ/server views and other panels behind it work normally while it's open.
  // There is no click-outside-to-close; Escape (handled above) is the only dismiss affordance
  // besides the "close" button.
  return createPortal(
    <div ref={surfaceRef} style={surfaceStyle}>
      <div style={headerStyle} onPointerDown={e => beginDrag(e, 'move')}>
        <span>AI Assistant</span>
        <div>
          <button onClick={openSettings} style={{ marginRight: 8 }}>settings</button>
          <button onClick={handleClose}>close</button>
        </div>
      </div>
      <AttachmentBar contextInput={contextInput} running={running} />
      <ChatTranscript doc={doc} compiled={compiled} onNavigated={handleClose} onRetry={retry} reducedMotion={reducedMotion} />
      {/*
        Deliberately NO <fieldset disabled={running}> wrapping the body below — unlike every
        other portal surface in the app (see WorldPanel.tsx's `disabled={running && tab !==
        'events'}`). This overlay is a read-only advisor that never mutates the world, and
        "what just went wrong" is inherently a mid-run question — mirroring WorldPanel's own
        Events-tab exemption. Do not paste a fieldset back in when copying this file's recipe.
      */}
      <ChatComposer onSend={send} disabled={false} />
      <div
        role="button"
        aria-label="resize"
        tabIndex={-1}
        style={resizeHandleStyle}
        onPointerDown={e => beginDrag(e, 'resize')}
      />
    </div>,
    document.body,
  )
}
