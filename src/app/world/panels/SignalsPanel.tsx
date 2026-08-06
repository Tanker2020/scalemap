// src/app/world/panels/SignalsPanel.tsx
// FEAT-009 Task 4: the Signals tab body -- one small-multiple SignalChart row per SignalKey,
// stacked over the engine's replay ring. Reads the simulation store (the ONLY sanctioned engine
// seam) for frames + scrub state; never touches worldEngine directly. Data-fetching-and-layout
// only -- all chart-drawing lives in SignalChart.tsx, all series math in signalsSeries.ts.
import { useMemo } from 'react'
import { useSimulationStore } from '../../store/simulation.store'
import { extractSeries, downsample, type SignalKey } from './signalsSeries'
import { SignalChart } from './SignalChart'
import type { DockScope } from '../dock/scope'
import { CATEGORY_COLORS } from '../../../lib/theme'

const ROWS: { key: SignalKey; label: string }[] = [
  { key: 'rps', label: 'rps' },
  { key: 'errorRate', label: 'error rate' },
  { key: 'p50Ms', label: 'p50 ms' },
  { key: 'p90Ms', label: 'p90 ms' },
  { key: 'p99Ms', label: 'p99 ms' },
  { key: 'activeConnections', label: 'connections' },
  { key: 'cpu', label: 'cpu' },
  { key: 'ramMb', label: 'ram mb' },
]

const CHART_WIDTH = 300
const CHART_HEIGHT = 36

// CATEGORY_COLORS is keyed by category name, each entry `{ accent, foreground: { light }, bg,
// border }` (see src/lib/theme.ts) -- NOT the flat `{ base }` shape a draft of this file once
// guessed. `accent` is the dark-mode-tuned saturated value used for icon/chart-stroke purposes
// throughout the app (ServerFaceplate, PacketLayer, etc.) -- it's already contrast-checked for
// both surfaces via its `foreground.light` sibling, so it's the right single value to cycle here
// rather than branching this component on theme mode itself.
const ROW_COLORS = Object.values(CATEGORY_COLORS).map(c => c.accent)

export function SignalsPanel({ scope }: { scope: DockScope }) {
  const frames = useSimulationStore(s => s.getReplayFrames())
  const scrubIndex = useSimulationStore(s => s.scrubIndex)
  const setScrubIndex = useSimulationStore(s => s.setScrubIndex)
  const lastFrameSimMs = frames.length > 0 ? frames[frames.length - 1].simMs : null
  const scopeKey = JSON.stringify(scope)

  const seriesByKey = useMemo(() => {
    const out: Partial<Record<SignalKey, ReturnType<typeof downsample>>> = {}
    for (const row of ROWS) {
      out[row.key] = downsample(extractSeries(frames, scope, row.key), CHART_WIDTH)
    }
    return out
    // Memo key deliberately uses stable primitives instead of `frames`/`scope` object identity:
    // frames.length + lastFrameSimMs changes exactly once per new 1 Hz replay frame (the ring is
    // append-only while a run is live), and scopeKey is a JSON-stable proxy for this small
    // discriminated union -- both cheaper to compare than re-walking the whole frame array on
    // every unrelated re-render (e.g. a sibling dock tab's own state change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frames.length, lastFrameSimMs, scopeKey])

  const playheadSimMs = scrubIndex != null ? frames[scrubIndex]?.simMs ?? null : lastFrameSimMs

  const markers = useMemo(
    () => frames.flatMap(f => f.events.map(e => ({ simMs: f.simMs, label: e.kind }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [frames.length, lastFrameSimMs],
  )

  const handleScrub = (simMs: number) => {
    if (frames.length === 0) return
    let nearestIdx = 0
    let bestDelta = Infinity
    for (let i = 0; i < frames.length; i++) {
      const d = Math.abs(frames[i].simMs - simMs)
      if (d < bestDelta) { bestDelta = d; nearestIdx = i }
    }
    setScrubIndex(nearestIdx, frames)
  }

  if (frames.length === 0) {
    return (
      <div style={{ color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)', fontSize: 12, padding: 8 }}>
        no history yet -- run the simulation to populate signals
      </div>
    )
  }

  return (
    <div>
      {ROWS.map((row, i) => (
        <div key={row.key} style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 10, color: 'var(--color-text-secondary)', marginBottom: 2, fontFamily: 'var(--font-mono)' }}>
            {row.label}
          </div>
          <SignalChart
            points={seriesByKey[row.key] ?? []}
            color={ROW_COLORS[i % ROW_COLORS.length]}
            width={CHART_WIDTH}
            height={CHART_HEIGHT}
            playheadSimMs={playheadSimMs}
            markers={i === 0 ? markers : undefined}
            onScrub={handleScrub}
          />
        </div>
      ))}
    </div>
  )
}
