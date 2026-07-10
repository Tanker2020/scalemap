// src/app/world/ScrubberV2.tsx
// Bottom-bar playback scrubber. Shown only once replay frames exist and the sim is stopped
// (contracts: replay is a 1Hz, 300-frame ring — "scrubbing any level reads one frame").
import { useEffect, useState } from 'react'
import { useReducedMotion } from 'framer-motion'
import { useSimulationStore } from '../store/simulation.store'
import type { ReplayFrame } from '../../lib/worldEngine/types'

const HEALTH_TICK_COLOR = (score: number): string => {
  if (score >= 80) return 'var(--color-success)'
  if (score >= 40) return 'var(--color-warning)'
  return 'var(--color-danger)'
}

function worstAzHealthScore(frame: ReplayFrame): number {
  const scores = Object.values(frame.batch.azs).map(az => az.healthScore)
  return scores.length === 0 ? 100 : Math.min(...scores)
}

export function ScrubberV2() {
  const running = useSimulationStore(s => s.running)
  const latestBatch = useSimulationStore(s => s.latestBatch)
  const scrubIndex = useSimulationStore(s => s.scrubIndex)
  const setScrubIndex = useSimulationStore(s => s.setScrubIndex)
  const [frames, setFrames] = useState<ReplayFrame[]>([])
  const reduced = useReducedMotion()

  useEffect(() => {
    if (running) return
    setFrames(useSimulationStore.getState().getReplayFrames())
  }, [running])

  // A fresh doc (post New/Open resetSession) has neither frames nor a batch — the engine's
  // replay ring survives stop() and only clears on the next start(), so latestBatch is the
  // signal that distinguishes "just stopped, scrub away" from "discarded world, stale ring".
  if (running || frames.length === 0 || latestBatch === null) return null

  const pick = (clientX: number, target: HTMLDivElement) => {
    const rect = target.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    setScrubIndex(Math.min(frames.length - 1, Math.floor(ratio * frames.length)))
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '6px 16px',
      borderTop: '1px solid var(--color-toolbar-border)', background: 'var(--color-toolbar)',
      font: '11px var(--font-mono)', color: 'var(--color-text-secondary)',
    }}>
      <span>Replay</span>
      <div
        role="slider"
        aria-label="replay-scrubber"
        aria-valuemin={0}
        aria-valuemax={frames.length - 1}
        aria-valuenow={scrubIndex ?? frames.length - 1}
        style={{
          flex: 1, height: 18, display: 'flex', cursor: 'pointer', borderRadius: 3, overflow: 'hidden',
          border: '1px solid var(--color-node-border)',
        }}
        onClick={e => pick(e.clientX, e.currentTarget)}
      >
        {frames.map((f, i) => (
          <div
            key={f.simMs}
            style={{
              flex: 1, background: HEALTH_TICK_COLOR(worstAzHealthScore(f)),
              opacity: scrubIndex === i ? 1 : 0.55,
              transition: reduced ? undefined : 'opacity 120ms ease',
            }}
          />
        ))}
      </div>
      <span>{scrubIndex == null ? 'live' : `${(frames[scrubIndex].simMs / 1000).toFixed(1)}s`}</span>
      {scrubIndex != null && (
        <button
          style={{
            background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
            borderRadius: 4, padding: '2px 8px', cursor: 'pointer',
            font: '11px var(--font-mono)', color: 'var(--color-text-secondary)',
          }}
          onClick={() => setScrubIndex(null)}
        >
          Exit scrub
        </button>
      )}
    </div>
  )
}
