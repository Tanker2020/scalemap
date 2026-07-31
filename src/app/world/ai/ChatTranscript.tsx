// Scrollable turn history: question + (pending spinner | formatted answer | error+retry),
// auto-scrolling to the newest turn as it arrives or its status changes.
import { useEffect, useRef, useState } from 'react'
import { useChatStore, type ChatTurn } from '../../store/chat.store'
import { ResponseBlocks } from './ResponseBlocks'
import type { WorldDoc, CompiledWorld } from '../../../lib/world/types'

function PendingIndicator({ askedAt }: { askedAt: number }) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setElapsed(Math.round((Date.now() - askedAt) / 1000)), 1000)
    return () => clearInterval(id)
  }, [askedAt])
  return (
    <div style={{ color: 'var(--color-text-muted)', font: '11px var(--font-mono)' }}>
      thinking… {elapsed}s
      {elapsed >= 45 && <div style={{ color: 'var(--color-warning)' }}>this is taking a while — the transport gives up at 60s</div>}
    </div>
  )
}

function TurnView({ turn, doc, compiled, onNavigated, onRetry }: {
  turn: ChatTurn; doc: WorldDoc; compiled: CompiledWorld; onNavigated: () => void; onRetry: (t: ChatTurn) => void
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ color: 'var(--color-text-secondary)', marginBottom: 4 }}>{turn.question}</div>
      {turn.status === 'pending' && <PendingIndicator askedAt={turn.askedAt} />}
      {turn.status === 'done' && <ResponseBlocks raw={turn.answer} doc={doc} compiled={compiled} onNavigated={onNavigated} />}
      {turn.status === 'error' && (
        <div style={{ color: 'var(--color-danger)' }}>
          {turn.error}{' '}
          <button onClick={() => onRetry(turn)} style={{ color: 'var(--color-accent)', background: 'none', border: 'none', cursor: 'pointer' }}>retry</button>
        </div>
      )}
    </div>
  )
}

export function ChatTranscript({ doc, compiled, onNavigated, onRetry, reducedMotion }: {
  doc: WorldDoc; compiled: CompiledWorld; onNavigated: () => void; onRetry: (t: ChatTurn) => void; reducedMotion: boolean
}) {
  const turns = useChatStore(s => s.turns)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // jsdom (this file's test environment) doesn't implement scrollIntoView — guard rather than
    // assume every render target has it.
    endRef.current?.scrollIntoView?.({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'end' })
  }, [turns.length, turns[turns.length - 1]?.status, reducedMotion])

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
      {turns.map(t => <TurnView key={t.id} turn={t} doc={doc} compiled={compiled} onNavigated={onNavigated} onRetry={onRetry} />)}
      <div ref={endRef} />
    </div>
  )
}
