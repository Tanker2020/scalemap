// The read-only AI chat assistant overlay — full-stage portal (same recipe as
// connections/ConnectionsView.tsx: fixed backdrop, centered surface, capture-phase Escape).
// Builds a fresh ChatContextInput from the live doc/compiled/simulation state on every render
// and hands it to sendChatTurn.ts, which owns the actual request lifecycle via chat.store.ts.
import { useEffect, useCallback, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties } from 'react'
import { useReducedMotion } from 'framer-motion'
import { useChatStore } from '../../store/chat.store'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useCompiledWorld } from '../useCompiledWorld'
import { runAnalysis } from '../../../lib/analysis/runAnalysis'
import { loadLlmSettings, type LlmSettings } from '../../../lib/tauri'
import { sendChatTurn } from './sendChatTurn'
import { ChatComposer } from './ChatComposer'
import { ChatTranscript } from './ChatTranscript'
import { AttachmentBar } from './AttachmentBar'
import type { ChatTurn } from '../../store/chat.store'
import type { ChatContextInput } from '../../../lib/aiChat/context'

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
const headerStyle: CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '8px 12px', borderBottom: '1px solid var(--color-node-border)',
}

export function AssistantView({ open, onClose, openSettings }: {
  open: boolean; onClose: () => void; openSettings: () => void
}) {
  const doc = useWorldStore(s => s.doc)
  // useCompiledWorld() reads `doc` from the store itself (module-level WeakMap cache keyed by
  // doc identity — see useCompiledWorld.ts) — it does NOT take doc as an argument.
  const compiled = useCompiledWorld()
  const events = useSimulationStore(s => s.events)
  const latestBatch = useSimulationStore(s => s.latestBatch)
  const running = useSimulationStore(s => s.running)
  const batchSimMs = latestBatch?.simMs ?? null
  // getReplayFrames is non-reactive (same convention as TimelineV2.tsx) — batchSimMs is its change signal
  const replayFrames = useMemo(() => useSimulationStore.getState().getReplayFrames(), [batchSimMs])
  const reducedMotion = useReducedMotion() ?? false

  // Settings are loaded once up front (not awaited per-send) so that sending a question is a
  // SYNCHRONOUS call into sendChatTurn: sendChatTurn's own beginTurn() runs before its first
  // `await` regardless, but gating the call itself behind `await loadLlmSettings()` here would
  // push that synchronous turn-creation behind a microtask, which the composer's Enter-to-send
  // contract (and this file's own tests) expect to be visible immediately.
  const [settings, setSettings] = useState<LlmSettings>({ baseUrl: '', apiKey: '', model: '' })
  useEffect(() => {
    let alive = true
    loadLlmSettings().then(s => { if (alive) setSettings(s) })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation(); e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  const contextInput: ChatContextInput = {
    doc, compiled,
    findings: runAnalysis(doc, compiled, latestBatch ?? null),
    compileFindings: compiled.findings,
    latestBatch: latestBatch ?? null,
    events,
    replayFrames,
  }

  const send = useCallback((question: string) => {
    const selected = useChatStore.getState().selected
    // Fire-and-forget: sendChatTurn is async (it awaits the LLM round trip), but its beginTurn()
    // call happens synchronously before that await, so the pending turn appears immediately.
    void sendChatTurn(settings, question, selected, contextInput)
  }, [settings, contextInput])

  const retry = useCallback((turn: ChatTurn) => { send(turn.question) }, [send])

  if (!open) return null

  return createPortal(
    <div style={backdrop} onClick={onClose}>
      <div style={surface} onClick={e => e.stopPropagation()}>
        <div style={headerStyle}>
          <span>AI Assistant</span>
          <div>
            <button onClick={openSettings} style={{ marginRight: 8 }}>settings</button>
            <button onClick={onClose}>close</button>
          </div>
        </div>
        <AttachmentBar contextInput={contextInput} running={running} />
        <ChatTranscript doc={doc} compiled={compiled} onNavigated={onClose} onRetry={retry} reducedMotion={reducedMotion} />
        {/*
          Deliberately NO <fieldset disabled={running}> wrapping the body below — unlike every
          other portal surface in the app (see WorldPanel.tsx's `disabled={running && tab !==
          'events'}`). This overlay is a read-only advisor that never mutates the world, and
          "what just went wrong" is inherently a mid-run question — mirroring WorldPanel's own
          Events-tab exemption. Do not paste a fieldset back in when copying this file's recipe.
        */}
        <ChatComposer onSend={send} disabled={false} />
      </div>
    </div>,
    document.body,
  )
}
