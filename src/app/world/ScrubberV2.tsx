// src/app/world/ScrubberV2.tsx
// Bottom-bar playback scrubber. Shown once replay frames exist and the sim is halted-but-alive —
// i.e. PAUSED. (End/stop now erases the run's latestBatch — persist-on-pause, erase-on-end — and
// the `latestBatch === null` gate below hides the scrubber then, so scrubbing is effectively
// pause-only; the halted check still admits `!running` defensively but that state carries a null
// batch after End.) (contracts: replay is a 1Hz, 300-frame ring — "scrubbing any level reads one frame".)
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
  const paused = useSimulationStore(s => s.paused)
  const latestBatch = useSimulationStore(s => s.latestBatch)
  const scrubIndex = useSimulationStore(s => s.scrubIndex)
  const scrubBatch = useSimulationStore(s => s.scrubBatch)
  const setScrubIndex = useSimulationStore(s => s.setScrubIndex)
  const [frames, setFrames] = useState<ReplayFrame[]>([])
  const reduced = useReducedMotion()

  // "Halted" = not actively ticking (stopped OR paused). Scrubbing is only meaningful then; while
  // live the bottom bar hides and the views follow the head. A paused run keeps `running` true, so
  // this deliberately checks `paused` too rather than just `!running`.
  const halted = !running || paused

  useEffect(() => {
    if (!halted) return
    setFrames(useSimulationStore.getState().getReplayFrames())
  }, [halted])

  // A fresh doc (post New/Open resetSession) has neither frames nor a batch — the engine's replay
  // ring survives stop()/pause and only clears on the next start(), so latestBatch is the signal
  // that distinguishes "just stopped/paused, scrub away" from "discarded world, stale ring".
  if (!halted || frames.length === 0 || latestBatch === null) return null

  // Resolve against the SAME captured array the ticks render (audit ISSUE-052): index, batch
  // and label all derive from `frames`, so a late final ring frame can't desync them.
  const pick = (clientX: number, target: HTMLDivElement) => {
    const rect = target.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    setScrubIndex(Math.min(frames.length - 1, Math.floor(ratio * frames.length)), frames)
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
      {/* Label from the RESOLVED batch (audit ISSUE-052), never frames[scrubIndex] — the store
          clamps a stale index to null, so this can't deref undefined. */}
      <span>{scrubIndex == null || scrubBatch == null ? 'live' : `${(scrubBatch.simMs / 1000).toFixed(1)}s`}</span>
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
