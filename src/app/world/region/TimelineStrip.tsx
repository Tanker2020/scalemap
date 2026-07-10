// src/app/world/region/TimelineStrip.tsx
// Region-scoped failover timeline under the flow (D6, skeleton T3): horizontal simMs axis
// covering the last 120s, one glyph per event, click-to-scrub while stopped. Mounted by
// RegionView; AlertRibbon's "timeline" link scrolls/flashes it (wired in RegionView.tsx, not
// here — this component only renders the strip itself).
import type { ReactElement } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useCompiledWorld } from '../useCompiledWorld'
import { regionEvents } from './regionData'
import type { RegionId } from '../../../lib/world/types'
import type { EngineEvent, EngineEventKind } from '../../../lib/worldEngine/types'

const WINDOW_MS = 120_000
const TRACK_BG = '#1E2430'
const TRACK_BORDER = '#232833'

const GLYPH: Record<EngineEventKind, string> = {
  outage_triggered: '⚡', outage_cleared: '⚡',
  health_check_failed: '♺',
  failover_started: '⇄', failover_completed: '⇄',
  ttl_lag_expired: '◷',
  replica_promoted: '⬆',
  oom_kill: '☠',
  noisy_neighbor: '▲',
  connection_refused: '●', instance_restarted: '●', burst_credits_exhausted: '●',
  breaker_open: '●', breaker_half_open: '●', breaker_closed: '●', engine_degraded: '●',
}
const SEVERITY_COLOR: Record<EngineEvent['severity'], string> = {
  critical: 'var(--color-danger)', warning: 'var(--color-warning)', info: 'var(--color-text-muted)',
}

export interface TimelineStripProps { regionId: RegionId }

export function TimelineStrip({ regionId }: TimelineStripProps): ReactElement | null {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const batch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const running = useSimulationStore(s => s.running)
  const events = useSimulationStore(s => s.events)
  const setScrubIndex = useSimulationStore(s => s.setScrubIndex)

  const scoped = regionEvents(regionId, doc, compiled, events, batch)
  if (scoped.length === 0) return null

  const endMs = batch?.simMs ?? Math.max(...scoped.map(e => e.simMs))
  const startMs = endMs - WINDOW_MS

  const onEventClick = (e: EngineEvent) => {
    if (running) return
    const frames = useSimulationStore.getState().getReplayFrames()
    if (frames.length === 0) return
    let nearest = 0
    let best = Infinity
    frames.forEach((f, i) => {
      const d = Math.abs(f.simMs - e.simMs)
      if (d < best) { best = d; nearest = i }
    })
    setScrubIndex(nearest)
  }

  return (
    <div style={{ marginTop: 12, font: '9px var(--font-mono)' }}>
      <div style={{ color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
        failover timeline
      </div>
      <div style={{ position: 'relative', height: 28, background: TRACK_BG, border: `1px solid ${TRACK_BORDER}`, borderRadius: 4 }}>
        {scoped.map(e => {
          if (e.simMs < startMs) return null
          const pct = ((e.simMs - startMs) / WINDOW_MS) * 100
          return (
            <button
              key={e.id}
              title={running ? 'stop the simulation to scrub to this event' : `${e.message} · t+${(e.simMs / 1000).toFixed(1)}s`}
              onClick={() => onEventClick(e)}
              disabled={running}
              style={{
                position: 'absolute', left: `${pct}%`, top: '50%', transform: 'translate(-50%, -50%)',
                background: 'none', border: 'none', padding: 2, cursor: running ? 'default' : 'pointer',
                color: SEVERITY_COLOR[e.severity], fontSize: 11, lineHeight: 1,
              }}
            >
              {GLYPH[e.kind]}
            </button>
          )
        })}
      </div>
    </div>
  )
}
