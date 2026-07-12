// src/app/world/region/TimelineV2.tsx
// Failover timeline v2 (Polish 4 T6, spec D8 — "a git chart for your infra"): replaces
// TimelineStrip.tsx's glyph strip at the same RegionView mount point (AlertRibbon's "timeline"
// scroll/flash wiring targets this component's wrapper div unchanged). One swimlane per AZ,
// colored health bands, real-event markers with hover tooltips, static dotted causality arrows
// between the narrated chain's cross-lane steps, a time axis, a legend, and (only when a chain
// exists) a one-sentence narration bar. All data comes from `timelineModel.ts`'s pure
// buildLanes/narration/causalLinks — this component is render-only, the same "scoped mini-view
// reads its own regionData.ts selector" shape TimelineStrip established (module-boundaries.md
// §M), just against the new pure model instead of computing inline.
//
// D8 guarantee 5 (zero animation cost): the ONLY transition anywhere in this component is the
// marker hover-scale defined in timelineStyles.ts's injected `.tl-marker:hover` rule, which
// rides the app's existing blanket prefers-reduced-motion override (src/index.css) — the same
// precedent that file's own `.region-timeline-flash` comment documents, so no separate
// useReducedMotion() call is needed here for this one CSS-only transition.
import type { CSSProperties, ReactElement } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useCompiledWorld } from '../useCompiledWorld'
import { buildLanes, narration, causalLinks, TIMELINE_WINDOW_MS, type TimelineLane, type TimelineMarker } from './timelineModel'
import type { RegionId } from '../../../lib/world/types'
import type { EngineEvent, HealthState } from '../../../lib/worldEngine/types'
import './timelineStyles'

const LANE_GUTTER = 92   // brief: "right-aligned, 92px gutter"
const LANE_GAP = 10
const AXIS_OFFSET = LANE_GUTTER + LANE_GAP
const LANE_H = 44
const VB_W = 1000        // causality-arrow SVG's x-axis reference width (see arrow-geometry note below)

const GLYPH: Record<TimelineMarker['cls'], string> = { kill: '✕', hc: '♺', shift: '⇄', promote: '⬆', other: '●' }
const MARKER_COLOR: Record<TimelineMarker['cls'], string> = {
  kill: 'var(--color-danger)', hc: 'var(--color-warning)',
  shift: 'var(--tl-teal)', promote: 'var(--tl-violet)', other: 'var(--color-text-muted)',
}
// Opaque chip fill (accent mixed into the node surface, not into transparent) — a theme-aware
// stand-in for the mock's near-black per-class literals (#2a0f0f/#241b07/#0a1f1c/#16121f),
// which are dark-mode-only and would look wrong on a light card (D8: this strip is normal
// region-view chrome, not an instrument-header dark scene — must look right in both themes).
const MARKER_BG: Record<TimelineMarker['cls'], string> = {
  kill: 'color-mix(in srgb, var(--color-danger) 16%, var(--color-node-base))',
  hc: 'color-mix(in srgb, var(--color-warning) 16%, var(--color-node-base))',
  shift: 'color-mix(in srgb, var(--tl-teal) 16%, var(--color-node-base))',
  promote: 'color-mix(in srgb, var(--tl-violet) 16%, var(--color-node-base))',
  other: 'var(--color-node-base)',
}
const LEGEND: { cls: TimelineMarker['cls']; label: string }[] = [
  { cls: 'kill', label: 'manual kill' },
  { cls: 'hc', label: 'health detection' },
  { cls: 'shift', label: 'traffic shift' },
  { cls: 'promote', label: 'promotion' },
]
// Band tint families (brief: "#22c55e22/#f59e0b22/#ef444426 ... via tokens where they exist,
// with alpha") — color-mix is this codebase's established way to alpha-blend a var(--color-*)
// token (see ui/kit.tsx, dock/*Styles.ts, server/InspectorRail.tsx): both themes' success/
// warning/danger tokens carry through automatically, unlike a hardcoded hex+alpha literal would.
const BAND_BG: Record<HealthState, string> = {
  healthy: 'color-mix(in srgb, var(--color-success) 13%, transparent)',
  degraded: 'color-mix(in srgb, var(--color-warning) 13%, transparent)',
  down: 'color-mix(in srgb, var(--color-danger) 15%, transparent)',
}
const BAND_BORDER: Record<HealthState, string> = {
  healthy: '1px solid color-mix(in srgb, var(--color-success) 24%, transparent)',
  degraded: '1px solid color-mix(in srgb, var(--color-warning) 27%, transparent)',
  down: '1px solid color-mix(in srgb, var(--color-danger) 30%, transparent)',
}

const secs = (ms: number) => `${Math.round(ms / 1000)}s`

function laneIndexForEventId(lanes: TimelineLane[], eventId: string): number {
  return lanes.findIndex(l => l.markers.some(m => m.event.id === eventId))
}

// Real engines routinely fire two markers at the identical simMs in the same lane (verified
// live: a replica promotion can land on the SAME tick as the manual kill that caused it, well
// before the AZ's aggregate health check even confirms down). Dead-on-top markers would render
// as one indistinguishable glyph with the later one eating every click, so cluster markers
// whose x-position falls within CLUSTER_EPSILON_PCT of an earlier one in the same lane and
// stagger them vertically (alternating above/below center) instead.
const CLUSTER_EPSILON_PCT = 1.5
const STACK_STEP_PX = 9

function stackOffsetsPx(pcts: number[]): number[] {
  return pcts.map((pct, i) => {
    let rank = 0
    for (let j = 0; j < i; j++) {
      if (Math.abs(pcts[j] - pct) < CLUSTER_EPSILON_PCT) rank += 1
    }
    if (rank === 0) return 0
    const step = Math.ceil(rank / 2) * STACK_STEP_PX
    return rank % 2 === 1 ? -step : step
  })
}

export interface TimelineV2Props { regionId: RegionId }

export function TimelineV2({ regionId }: TimelineV2Props): ReactElement | null {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const batch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const running = useSimulationStore(s => s.running)
  const events = useSimulationStore(s => s.events)
  const setScrubIndex = useSimulationStore(s => s.setScrubIndex)
  // Non-reactive getter, re-read fresh every render — the same imperative access TimelineStrip
  // used, but read at render time (not just inside the click handler) since bands/markers need
  // the frame history to draw, not only to scrub to it. `batch`/`events` above already give
  // this component a subscribed 1Hz re-render cadence while running, so the frame data this
  // pulls stays effectively live without a second subscription.
  const frames = useSimulationStore.getState().getReplayFrames()

  const endMs = batch?.simMs ?? 0
  const windowStart = Math.max(0, endMs - TIMELINE_WINDOW_MS)
  const lanes = buildLanes(regionId, doc, compiled, events, frames, endMs)
  if (lanes.length === 0) return null

  const chainInfo = narration(regionId, doc, compiled, events)
  const chain = chainInfo?.chain ?? []
  const links = chainInfo ? causalLinks(lanes, chain) : []

  const pctFor = (simMs: number): number => {
    const raw = ((simMs - windowStart) / TIMELINE_WINDOW_MS) * 100
    return Math.min(100, Math.max(0, raw))
  }

  // Carried verbatim from TimelineStrip.tsx's onEventClick (D8 guarantee 3): nearest-frame-by-
  // simMs-distance scrub, inert while running.
  const onMarkerClick = (event: EngineEvent) => {
    if (running) return
    const replayFrames = useSimulationStore.getState().getReplayFrames()
    if (replayFrames.length === 0) return
    let nearest = 0
    let best = Infinity
    replayFrames.forEach((f, i) => {
      const d = Math.abs(f.simMs - event.simMs)
      if (d < best) { best = d; nearest = i }
    })
    setScrubIndex(nearest)
  }

  // Cross-lane consecutive chain-step arrows (D8: dotted, static, arrowhead). Geometry is
  // derived directly from event ids (unambiguous — buildLanes assigns each scoped event to
  // exactly one lane) rather than from `links`' azId pairs, since a lane can hold more than one
  // marker and only the exact event tells us its x position; `links` (from the exported,
  // independently-unit-tested `causalLinks`) is still consumed here — zipped in by index, since
  // both this loop and `causalLinks` apply the identical cross-lane filter to the same ordered
  // `chain`, so their qualifying entries line up 1:1 — to label each arrow's AZ pair.
  const arrows: { key: string; d: string; arrow: string; label: string }[] = []
  if (chainInfo) {
    let li = 0
    for (let i = 0; i < chain.length - 1; i++) {
      const a = chain[i]; const b = chain[i + 1]
      const laneA = laneIndexForEventId(lanes, a.id)
      const laneB = laneIndexForEventId(lanes, b.id)
      if (laneA < 0 || laneB < 0 || laneA === laneB) continue
      const link = links[li]; li += 1
      const x1 = (pctFor(a.simMs) / 100) * VB_W
      const x2 = (pctFor(b.simMs) / 100) * VB_W
      const y1 = laneA * LANE_H + LANE_H / 2
      const y2 = laneB * LANE_H + LANE_H / 2
      const dx = (x2 - x1) / 2
      const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
      const arrow = `${x2},${y2} ${x2 - 10},${y2 - 5} ${x2 - 10},${y2 + 5}`
      arrows.push({ key: `${a.id}->${b.id}`, d, arrow, label: link ? `${link.fromId} -> ${link.toId}` : `${a.id}->${b.id}` })
    }
  }

  const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: LANE_GAP, height: LANE_H }

  return (
    <div style={{ marginTop: 12, font: '9px var(--font-mono)' }}>
      <div style={{ color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
        failover timeline
      </div>

      {chainInfo && (
        <div style={{
          background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
          borderLeft: '3px solid var(--color-warning)', borderRadius: 6, padding: '7px 10px',
          fontSize: 10, color: 'var(--color-text-secondary)', marginBottom: 12, lineHeight: 1.6,
        }}>
          {chainInfo.text}
        </div>
      )}

      <div style={{ position: 'relative' }}>
        {arrows.length > 0 && (
          <svg
            aria-hidden="true"
            data-testid="causality-arrows"
            style={{
              position: 'absolute', left: AXIS_OFFSET, top: 0,
              width: `calc(100% - ${AXIS_OFFSET}px)`, height: lanes.length * LANE_H,
              pointerEvents: 'none', overflow: 'visible',
            }}
            viewBox={`0 0 ${VB_W} ${lanes.length * LANE_H}`}
            preserveAspectRatio="none"
          >
            {arrows.map(a => (
              <g key={a.key}>
                <title>{a.label}</title>
                <path d={a.d} fill="none" stroke="var(--color-text-muted)" strokeWidth={1} strokeDasharray="3 4" />
                <polygon points={a.arrow} fill="var(--color-text-muted)" opacity={0.6} />
              </g>
            ))}
          </svg>
        )}

        {lanes.map(lane => (
          <div key={lane.azId} style={rowStyle}>
            <div style={{ width: LANE_GUTTER, flexShrink: 0, textAlign: 'right', color: 'var(--color-text-secondary)' }}>
              {lane.label}
              <div style={{ color: 'var(--color-text-muted)', fontSize: 8.5 }}>{lane.serverCount} srv</div>
            </div>
            <div style={{ position: 'relative', flex: 1, height: '100%', borderLeft: '1px solid var(--color-node-border)' }}>
              <div style={{ position: 'absolute', left: 0, right: 0, top: '50%', height: 1, background: 'var(--color-node-border)' }} />
              {lane.bands.map((band, bi) => {
                const left = pctFor(band.startMs)
                const width = Math.max(0, pctFor(band.endMs) - left)
                return (
                  <div
                    key={bi}
                    data-testid="tl-band"
                    data-state={band.state}
                    style={{
                      position: 'absolute', top: 'calc(50% - 5px)', height: 10, borderRadius: 5,
                      left: `${left}%`, width: `${width}%`,
                      background: BAND_BG[band.state], border: BAND_BORDER[band.state],
                    }}
                  />
                )
              })}
              {(() => {
                const pcts = lane.markers.map(m => pctFor(m.event.simMs))
                const offsets = stackOffsetsPx(pcts)
                return lane.markers.map((marker, mi) => {
                  const top = offsets[mi] === 0 ? '50%' : `calc(50% + ${offsets[mi]}px)`
                  return (
                    <button
                      key={marker.event.id}
                      className="tl-marker"
                      data-testid="tl-marker"
                      data-cls={marker.cls}
                      onClick={() => onMarkerClick(marker.event)}
                      disabled={running}
                      title={running ? 'stop the simulation to scrub to this event' : undefined}
                      aria-label={`${marker.cls} event at t=${secs(marker.event.simMs)}`}
                      style={{
                        position: 'absolute', top, left: `${pcts[mi]}%`,
                        width: 16, height: 16, borderRadius: '50%', padding: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 9, lineHeight: 1, cursor: running ? 'default' : 'pointer', zIndex: 2,
                        background: MARKER_BG[marker.cls], border: `1.5px solid ${MARKER_COLOR[marker.cls]}`,
                        color: MARKER_COLOR[marker.cls],
                      }}
                    >
                      {GLYPH[marker.cls]}
                      <span
                        className="tl-tip"
                        style={{
                          position: 'absolute', bottom: 22, left: '50%', transform: 'translateX(-50%)',
                          background: 'var(--color-toolbar)', border: '1px solid var(--color-node-border)',
                          borderRadius: 5, padding: '4px 9px', fontSize: 9.5, color: 'var(--color-text-secondary)',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        t={secs(marker.event.simMs)} · {marker.event.message}
                      </span>
                    </button>
                  )
                })
              })()}
            </div>
          </div>
        ))}
      </div>

      <div style={{
        display: 'flex', marginLeft: AXIS_OFFSET, justifyContent: 'space-between',
        fontSize: 9, color: 'var(--color-text-muted)', borderTop: '1px solid var(--color-node-border)',
        paddingTop: 4, marginTop: 2,
      }}>
        <span>t=0</span><span>30s</span><span>60s</span><span>90s</span><span>now</span>
      </div>

      <div style={{ display: 'flex', gap: 16, fontSize: 9.5, color: 'var(--color-text-muted)', marginTop: 10, flexWrap: 'wrap' }}>
        {LEGEND.map(l => (
          <span key={l.cls} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{
              display: 'inline-flex', width: 12, height: 12, borderRadius: '50%', alignItems: 'center',
              justifyContent: 'center', fontSize: 8, background: MARKER_BG[l.cls],
              border: `1px solid ${MARKER_COLOR[l.cls]}`, color: MARKER_COLOR[l.cls],
            }}>
              {GLYPH[l.cls]}
            </span>
            {l.label}
          </span>
        ))}
        <span style={{ marginLeft: 'auto' }}>band color = the AZ&apos;s state · click a marker = scrub there</span>
      </div>
    </div>
  )
}
