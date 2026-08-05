// src/app/world/region/timelineModel.ts
// Pure model for the region page's failover timeline v2 (Polish 4 T6, spec D8 — "a git chart
// for your infra"): per-AZ swimlanes (health bands from replay frames), event markers (real
// engine events only — D8 guarantee 1), a narrated kill -> detection -> shift -> promotion
// chain (guarantee 4), and the cross-lane causality-arrow pairs that chain implies. No React,
// no store reads, no randomness — mirrors regionData.ts's "pure hub" shape (§M); TimelineV2.tsx
// is the only consumer. Event scoping goes through regionData.ts's existing `regionEvents`,
// unchanged, per the task brief.
import type { WorldDoc, CompiledWorld, RegionId, AzId } from '../../../lib/world/types'
import type { EngineEvent, EngineEventKind, ReplayFrame, HealthState } from '../../../lib/worldEngine/types'
import { regionEvents } from './regionData'

export interface TimelineBand { startMs: number; endMs: number; state: HealthState }
// FEAT-008 (Task 21): 'scale-out'/'scale-in' cover the autoscaler's own scale_out/scale_in
// events — a distinct class from 'other' so TimelineV2 can give them their own glyph/color,
// same as every other narrated class. They never enter `narration()`'s kill/hc/shift/promote
// chain (that function only ever looks for those four classes), so adding them here is additive.
export interface TimelineMarker { event: EngineEvent; cls: 'kill' | 'hc' | 'shift' | 'promote' | 'scale-out' | 'scale-in' | 'other' }
export interface TimelineLane { azId: AzId; label: string; serverCount: number; bands: TimelineBand[]; markers: TimelineMarker[] }

// Last 120s of sim time (D8 layout). Shorter runs simply produce bands that start later than
// the window's left edge — TimelineV2 renders the remainder as empty (unpainted) track, i.e.
// the "left-pad from t=0" behavior lives in the view, not here.
export const TIMELINE_WINDOW_MS = 120_000

export function markerClass(kind: EngineEventKind): TimelineMarker['cls'] {
  switch (kind) {
    case 'outage_triggered': return 'kill'
    case 'health_check_failed': return 'hc'
    case 'failover_started':
    case 'failover_completed':
    case 'ttl_lag_expired':
      return 'shift'
    case 'replica_promoted': return 'promote'
    case 'scale_out': return 'scale-out'
    case 'scale_in': return 'scale-in'
    default: return 'other'
  }
}

// Merges consecutive frames (already filtered to this AZ + the window) that report the SAME
// `health` into one band, closing each band at the simMs where the next differing band starts
// so bands render edge-to-edge with no gaps. The final band is always stretched to `endMs`
// ("now") — an AZ's current state visually persists to the present instant even though the
// last frame that reported it may be up to 1s stale (the metrics pyramid's own publish cadence).
function buildBandsForAz(azId: AzId, framesInWindow: ReplayFrame[], endMs: number): TimelineBand[] {
  const bands: TimelineBand[] = []
  for (const f of framesInWindow) {
    const state: HealthState = f.batch.azs[azId]?.health ?? 'healthy'
    const last = bands[bands.length - 1]
    if (last && last.state === state) continue
    if (last) last.endMs = f.simMs
    bands.push({ startMs: f.simMs, endMs: f.simMs, state })
  }
  if (bands.length > 0) bands[bands.length - 1].endMs = endMs
  return bands
}

// The per-AZ analog of regionData.ts's region-level `isRelevant`: true when `affected` names
// this AZ itself, a server that lives in it, or a compiled instance resident on it. FEAT-008
// (Task 21): scale_out/scale_in fire with `affected = [placementId]` (index.ts's emit call
// sites), not a server/AZ/instance id, so a placement whose host server lives in this AZ must
// also count — otherwise a scale event never resolves to any lane.
function azClosureContains(azId: AzId, doc: WorldDoc, compiled: CompiledWorld, affected: string[]): boolean {
  if (affected.includes(azId)) return true
  return affected.some(id =>
    doc.servers[id]?.azId === azId ||
    compiled.instances[id]?.azId === azId ||
    doc.servers[doc.placements[id]?.serverId ?? '']?.azId === azId)
}

// One lane per AZ in the region (doc iteration order, matching RegionView/AzRow's own
// unsorted convention). Bands come from `frames` restricted to the 120s window ending at
// `endMs`; markers come from `regionEvents`-scoped events restricted to the same window,
// assigned to the lane whose closure contains an affected id (fallback: the first lane).
export function buildLanes(
  regionId: RegionId, doc: WorldDoc, compiled: CompiledWorld,
  events: EngineEvent[], frames: ReplayFrame[], endMs: number,
): TimelineLane[] {
  const azs = Object.values(doc.azs).filter(a => a.regionId === regionId)
  const windowStart = Math.max(0, endMs - TIMELINE_WINDOW_MS)
  const framesInWindow = frames
    .filter(f => f.simMs >= windowStart && f.simMs <= endMs)
    .sort((a, b) => a.simMs - b.simMs)
  // regionEvents' population-routing membership needs a batch; the latest in-window frame's
  // batch is the closest analog to `scrubBatch ?? latestBatch` available from pure inputs alone.
  const latestBatch = framesInWindow.length > 0 ? framesInWindow[framesInWindow.length - 1].batch : null
  const scoped = regionEvents(regionId, doc, compiled, events, latestBatch)
    .filter(e => e.simMs >= windowStart && e.simMs <= endMs)
    .sort((a, b) => a.simMs - b.simMs)

  const lanes: TimelineLane[] = azs.map(az => ({
    azId: az.id,
    label: az.label,
    serverCount: Object.values(doc.servers).filter(s => s.azId === az.id).length,
    bands: buildBandsForAz(az.id, framesInWindow, endMs),
    markers: [],
  }))

  for (const event of scoped) {
    const idx = lanes.findIndex(lane => azClosureContains(lane.azId, doc, compiled, event.affected))
    const target = idx >= 0 ? lanes[idx] : lanes[0]
    target?.markers.push({ event, cls: markerClass(event.kind) })
  }

  return lanes
}

function entityLabel(id: string, doc: WorldDoc): string {
  return doc.azs[id]?.label ?? doc.servers[id]?.label ?? doc.regions[id]?.catalogId ?? id
}

// Assembles the "last kill/detection cluster -> subsequent shift -> promotion" chain (D8
// guarantee 4): anchored on the MOST RECENT manual kill (outage_triggered); the detection
// segment is the earliest health_check_failed AT OR AFTER that kill (or, when there was no
// kill, the most recent detection standing alone); the shift is the earliest shift-class event
// at or after the detection/kill; the promotion is the earliest promotion at or after the
// shift. Segments are omitted, never fabricated, when their event doesn't exist. No kill AND
// no detection at all means there's no incident to narrate -> null (no narration bar).
export function narration(
  regionId: RegionId, doc: WorldDoc, compiled: CompiledWorld, events: EngineEvent[],
): { text: string; chain: EngineEvent[] } | null {
  // No batch is available at this call site (the brief's signature omits it) — population-
  // routing membership is simply not part of this narrower scoping, same tradeoff as any other
  // pure caller of regionEvents without a batch on hand.
  const scoped = regionEvents(regionId, doc, compiled, events, null).slice().sort((a, b) => a.simMs - b.simMs)

  const kills = scoped.filter(e => markerClass(e.kind) === 'kill')
  const detections = scoped.filter(e => markerClass(e.kind) === 'hc')
  const shifts = scoped.filter(e => markerClass(e.kind) === 'shift')
  const promotions = scoped.filter(e => markerClass(e.kind) === 'promote')

  const kill = kills.length > 0 ? kills[kills.length - 1] : null
  const detection = kill
    ? (detections.find(e => e.simMs >= kill.simMs) ?? null)
    : (detections.length > 0 ? detections[detections.length - 1] : null)

  if (!kill && !detection) return null

  const onsetMs = detection?.simMs ?? kill!.simMs
  const shift = shifts.find(e => e.simMs >= onsetMs) ?? null
  const promotion = promotions.find(e => e.simMs >= (shift?.simMs ?? onsetMs)) ?? null

  const chain = [kill, detection, shift, promotion].filter((e): e is EngineEvent => e !== null)

  const secs = (ms: number) => `${Math.round(ms / 1000)}s`
  // Kill/detection get the mandated fixed voicing (D8 guarantee 4: "you killed" / "health
  // checks failed"); shift/promotion have no mandated phrase, so they speak in the engine's
  // own message — real text, never invented — satisfying "regenerates from the actual event
  // chain" without guessing at a destination label the event's `affected` ids don't reliably
  // carry (failover-class events carry population/region ids, not AZ ids).
  const segments = chain.map((e, i) => {
    const cls = markerClass(e.kind)
    const body =
      cls === 'kill' ? `you killed ${entityLabel(e.affected[0] ?? '', doc)}`
      : cls === 'hc' ? 'health checks failed'
      : e.message
    return i === 0 ? `t=${secs(e.simMs)} ${body}` : `${body} (t=${secs(e.simMs)})`
  })

  return { text: `What just happened: ${segments.join(' → ')}.`, chain }
}

// Index (within `lanes`) of the lane whose markers contain `eventId`, or -1 if the event isn't
// assigned to any lane. The one "find an event's lane" lookup shared by this module's own
// causalLinks AND TimelineV2.tsx's cross-lane arrow-endpoint math, so the two can't drift.
export function laneIndexOfEvent(lanes: TimelineLane[], eventId: string): number {
  return lanes.findIndex(l => l.markers.some(m => m.event.id === eventId))
}

// Consecutive steps of the narrated chain that land in DIFFERENT lanes — the pairs TimelineV2
// draws a dotted causality arrow between. Lane membership is resolved by exact event id (each
// scoped event is assigned to exactly one lane in `buildLanes`, so this lookup is unambiguous).
export function causalLinks(lanes: TimelineLane[], chain: EngineEvent[]): { fromId: string; toId: string }[] {
  const links: { fromId: string; toId: string }[] = []
  for (let i = 0; i < chain.length - 1; i++) {
    const fromIdx = laneIndexOfEvent(lanes, chain[i].id)
    const toIdx = laneIndexOfEvent(lanes, chain[i + 1].id)
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) continue
    links.push({ fromId: lanes[fromIdx].azId, toId: lanes[toIdx].azId })
  }
  return links
}
