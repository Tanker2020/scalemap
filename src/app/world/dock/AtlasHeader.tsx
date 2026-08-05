// src/app/world/dock/AtlasHeader.tsx
// Polish 4 T2 (spec D4): the atlas instrument's signature header for world + region scope — a
// live constellation SVG (graticule, region dots, population dots, traffic arcs) plus a
// two-posture headline. ABSORBS the pre-Polish-4 `WorldSummary` strip (WorldPanel.tsx) — its
// exact number derivations (region/server/city counts, baseline rps, rolling rps, $/hr) are
// reused, not reinvented (see the headline section below).
//
// Pure presentational: reads props (`regionId`) + the world/simulation stores directly (the
// dock's established pattern — ScopeRail does the same). `projectLatLon` is exported as a
// standalone pure function so its projection/clamping math is node-clean-testable even though
// this file itself is jsdom (plain SVG/DOM, no WebGL).
import { type ReactElement, type ReactNode } from 'react'
import { useReducedMotion } from 'framer-motion'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useCompiledWorld } from '../useCompiledWorld'
import { useRollingNumber } from '../ui/motion'
import { REGION_GEO } from '../../../lib/world/regionGeo'
import { populationLanding } from '../ui/derived'
import { pinColor } from '../globe/RegionPins'
import { scopedCost } from './scopeData'
import type { WorldDoc } from '../../../lib/world/types'
import type { HealthState, MetricsBatch } from '../../../lib/worldEngine/types'

export interface AtlasHeaderProps { regionId: string | null }   // null = world scope

// ─── Dark-scene chrome (spec D3, InspectorRail precedent) ────────────────────────────────────
// The constellation header is one of the app's three "instrument header" scenes and keeps the
// mock's navy palette in BOTH themes — fixed local hex, never `var(--color-*)`. Reasoning
// mirrors InspectorRail.tsx's identical carve-out: those tokens are calibrated for legibility on
// a surface that flips light in light theme, not one that's permanently dark (e.g.
// `--color-text-secondary` becomes a mid-gray meant for a WHITE card — illegible on this fixed
// navy backdrop). Values below are DARK_COLORS' own hex (theme.ts) / the locked mock's literals,
// not new invented colors.
const ATLAS_BG = 'linear-gradient(180deg, #0d1420 0%, #101318 65%)'
const ATLAS_BORDER = '#21344a'
const GRATICULE_STROKE = '#16283d'
const LABEL_COLOR = '#8fb3e0'
const HEADLINE_MUTED = '#94A3B8'    // DARK_COLORS.textSecondary — the mock's --t2
const HEADLINE_STRONG = '#F1F5F9'   // DARK_COLORS.textPrimary — the mock's --t1

// Exception to the fixed-chrome rule above (ambiguity resolution, T2 brief): the region-scope
// ring and the traffic arcs both denote "hud/live," the SAME semantic ScopeRail's "here" pill
// and the tab-bar ink already use — they deliberately reuse that already-theme-aware,
// WCAG-checked token pair instead of a fifth hardcoded hex, exactly as ScopeRail.tsx's own
// comment documents for its "here" pill.
const HUD = 'var(--kit-accent)'

const W = 372
const H = 92
// The headline overlay owns the bottom ~20px of the card, so GEOGRAPHY projects into the band
// above it (user report 2026-07-12: São Paulo's population dot projected to y≈67 — directly
// under the caption text + its black text-shadow — so its traffic arc read as "a dashed line
// to nowhere"). Graticule stays full-bleed; it's decorative chrome, not geography.
const MAP_H = H - 20
// Graticule (D4 evolved 2026-07-12): 3 latitude curves + 5 longitude curves. The lat curves
// keep the locked mock's 10px center bulge; the outer meridians bow harder than the inner
// ones — spherical foreshortening, the strongest single "this is a globe" cue at this size.
const GRATICULE_PATHS = [
  'M0,30 Q186,10 372,30', 'M0,55 Q186,38 372,55', 'M0,80 Q186,66 372,80',
  'M28,6 Q46,46 28,86', 'M80,2 Q92,46 80,90', 'M186,0 Q186,46 186,92',
  'M292,2 Q280,46 292,90', 'M344,6 Q326,46 344,86',
]

// Sphere warp (user report 2026-07-12: the atlas "looks like a flat plane"): the graticule
// always CURVED like a globe, but dots/arcs sat on flat equirectangular positions — two
// geometries on one card. This bends the projected content onto the same bulge: the center
// column lifts by SPHERE_LIFT, the edges don't, so a row of constant latitude follows the
// same arc the graticule draws. Output stays inside 0..mapH (the band squeezes by LIFT first).
const SPHERE_LIFT = 10
export function warpToSphere(
  pt: { x: number; y: number }, w = W, mapH = MAP_H,
): { x: number; y: number } {
  const u = (pt.x - w / 2) / (w / 2)                       // -1 (left limb) .. 1 (right limb)
  const lift = SPHERE_LIFT * (1 - u * u)                   // full lift at center, 0 at limbs
  return { x: pt.x, y: SPHERE_LIFT + pt.y * ((mapH - SPHERE_LIFT) / mapH) - lift }
}

function project(lat: number, lon: number): { x: number; y: number } {
  return warpToSphere(projectLatLon(lat, lon, W, MAP_H))
}

/** Equirectangular projection, clamped: lon -180..180 -> 0..w; lat 75..-60 -> 0..h (north-up —
 *  the datacenter-metro latitude band REGION_GEO actually uses, not the full -90..90 globe). */
export function projectLatLon(lat: number, lon: number, w: number, h: number): { x: number; y: number } {
  const lonFrac = Math.min(1, Math.max(0, (lon + 180) / 360))
  const latFrac = Math.min(1, Math.max(0, (75 - lat) / 135))
  return { x: lonFrac * w, y: latFrac * h }
}

function arcPath(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const mx = (from.x + to.x) / 2
  const my = Math.max(2, (from.y + to.y) / 2 - 14)   // gentle upward bow, matches the mock
  return `M${from.x},${from.y} Q${mx},${my} ${to.x},${to.y}`
}

// Mirrors RegionPins.tsx's `RegionPin` view-side health aggregation — the globe's "red-out law"
// (user report 2026-07-11): a region whose every AZ is manually killed reads as down here too,
// even when the engine's own region health hasn't (or structurally can't) reflect an
// all-AZs-down region. Duplicated rather than imported: RegionPins.tsx only exports `pinColor`/
// `isPulsing` as standalone helpers (this aggregation is inlined in a component-local selector
// there), and it's small/pure/cheap — the same "cite, don't cross-import engine-adjacent view
// math" precedent `ui/derived.ts` already sets for `populationLanding`'s latency convention.
function regionHealth(regionId: string, batch: MetricsBatch | null, doc: WorldDoc): HealthState {
  const h = batch?.regions[regionId]?.health ?? 'healthy'
  if (!batch || h === 'down') return h
  const azs = Object.values(doc.azs).filter(a => a.regionId === regionId)
  const allDown = azs.length > 0 && azs.every(a => batch.azs[a.id]?.health === 'down')
  return allDown ? 'down' : h
}

interface RouteCandidate { populationId: string; from: { lat: number; lon: number }; to: { lat: number; lon: number }; rps: number }

export function AtlasHeader({ regionId }: AtlasHeaderProps): ReactElement {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const displayBatch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const running = useSimulationStore(s => s.running)
  const reduced = useReducedMotion()

  const regions = Object.values(doc.regions)
    .map(region => ({ region, geo: REGION_GEO[region.catalogId] }))
    .filter((entry): entry is { region: typeof entry.region; geo: { lat: number; lon: number } } => entry.geo != null)

  const populations = Object.values(doc.populations)

  // Arcs (D4): population -> landing-region. `populationLanding` (rest) or
  // `batch.world.populationRoutes` (a batch is present, running or scrubbed-stopped alike — the
  // SAME "displayBatch truthy" discriminator every other dock/panel surface already uses, e.g.
  // the pre-Polish-4 WorldSummary's own `!displayBatch` branch below). Baseline synthetic
  // populations (`populationRoutes` entries with no `doc.populations` entry — the engine's
  // region-keyed auto-baseline traffic) are skipped: they have no population marker anywhere in
  // the app (including the globe) to draw an arc FROM.
  const candidates: RouteCandidate[] = []
  if (displayBatch) {
    for (const route of displayBatch.world.populationRoutes) {
      const pop = doc.populations[route.populationId]
      const region = doc.regions[route.regionId]
      const geo = region ? REGION_GEO[region.catalogId] : undefined
      if (!pop || !geo) continue
      candidates.push({ populationId: route.populationId, from: { lat: pop.lat, lon: pop.lon }, to: geo, rps: route.rps })
    }
  } else {
    for (const pop of populations) {
      const landing = populationLanding(pop, doc, compiled)
      if (!landing) continue
      const target = regions.find(r => r.region.catalogId === landing.regionCatalogId)
      if (!target) continue
      // No live rps at rest — rank by the population's own authored scale (peakRps) so the cap
      // and ordering are still deterministic; the running-vs-reduced animation gate below never
      // engages while `running` is false anyway, so this ranking only affects which 3 render.
      candidates.push({ populationId: pop.id, from: { lat: pop.lat, lon: pop.lon }, to: target.geo, rps: pop.peakRps })
    }
  }
  candidates.sort((a, b) => b.rps - a.rps)
  const topArcs = candidates.slice(0, 3)
  const topRps = topArcs[0]?.rps ?? 0
  // Motion law (D3): the atlas arc is the dock's ONE ambient stroke — marches only while the sim
  // is actually running (not merely "a batch exists," which also covers a stopped/scrubbed
  // replay — idle-static law) AND the top route carries traffic AND motion isn't reduced.
  const animateGate = running && topRps > 0 && !reduced

  // Headline (D4): world scope mirrors WorldSummary's two postures; region scope is one
  // formula that degrades gracefully at rest (rps=0, price=authored compute cost — computeWorldCost
  // sums server hourlyUsd regardless of `world` being null, only egress needs live bytes).
  // `useRollingNumber` is called exactly once, unconditionally, with whichever raw figure is
  // scope-relevant — a hook must never be called from inside an `if regionId === null` branch.
  const rawRps = regionId === null ? (displayBatch?.world.totalRps ?? 0) : (displayBatch?.regions[regionId]?.rps ?? 0)
  const rolledRps = useRollingNumber(rawRps)

  let headline: ReactNode
  if (regionId === null) {
    const regionCount = Object.keys(doc.regions).length
    const serverCount = Object.keys(doc.servers).length
    const cityCount = Object.keys(doc.populations).length
    if (!displayBatch) {
      headline = `${regionCount} region${regionCount === 1 ? '' : 's'} · ${serverCount} server${serverCount === 1 ? '' : 's'} · ${cityCount} population${cityCount === 1 ? '' : 's'}`
    } else {
      // FEAT-008 (Task 21, controller-added gap): fold runningByPlacement in — see scopedCost's own comment.
      const cost = scopedCost({ kind: 'world' }, doc, { ...displayBatch.world, runningByPlacement: displayBatch.runningByPlacement }, displayBatch.managedServices ?? null)
      headline = (
        <>
          Handling <b style={{ color: HEADLINE_STRONG, fontVariantNumeric: 'tabular-nums' }}>{Math.round(rolledRps).toLocaleString('en-US')} rps</b>
          {' '}from {cityCount} {cityCount === 1 ? 'city' : 'cities'} · <span style={{ color: 'var(--color-price)' }}>${cost.hourlyUsd.toFixed(2)}/hr</span>
        </>
      )
    }
  } else {
    const region = doc.regions[regionId]
    // FEAT-008 (Task 21, controller-added gap): fold runningByPlacement in — see scopedCost's own comment.
    const worldForCost = displayBatch?.world ? { ...displayBatch.world, runningByPlacement: displayBatch.runningByPlacement } : null
    const cost = scopedCost({ kind: 'region', regionId }, doc, worldForCost, displayBatch?.managedServices ?? null)
    headline = (
      <>
        {region?.catalogId ?? regionId} · {Math.round(rolledRps).toLocaleString('en-US')} rps{' '}
        · <span style={{ color: 'var(--color-price)' }}>${cost.hourlyUsd.toFixed(2)}/hr</span>
      </>
    )
  }

  return (
    <div data-testid="atlas-header" style={{
      position: 'relative', height: H, borderRadius: 7, marginBottom: 8, overflow: 'hidden',
      background: ATLAS_BG, border: `1px solid ${ATLAS_BORDER}`,
    }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
        {/* Sphere lighting (2026-07-12): a lit zenith upper-center and limb darkening toward
            the card's edges — under the content so health colors never dim. */}
        <defs>
          <radialGradient id="atlas-zenith" cx="50%" cy="22%" r="62%">
            <stop offset="0%" stopColor="#3a5a86" stopOpacity="0.22" />
            <stop offset="60%" stopColor="#3a5a86" stopOpacity="0.05" />
            <stop offset="100%" stopColor="#3a5a86" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="atlas-limb" cx="50%" cy="30%" r="80%">
            <stop offset="52%" stopColor="#000" stopOpacity="0" />
            <stop offset="86%" stopColor="#000" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#000" stopOpacity="0.55" />
          </radialGradient>
        </defs>
        <rect x="0" y="0" width={W} height={H} fill="url(#atlas-zenith)" />
        <g>
          {GRATICULE_PATHS.map((d, i) => <path key={i} d={d} fill="none" stroke={GRATICULE_STROKE} strokeWidth={0.6} />)}
        </g>
        {/* Atmosphere rim — the same thin glow the real globe wears at its limb. */}
        <path d="M0,9 Q186,-7 372,9" fill="none" stroke={HUD} strokeWidth={3.5} opacity={0.06} />
        <path d="M0,9 Q186,-7 372,9" fill="none" stroke={HUD} strokeWidth={1} opacity={0.28} />
        <rect x="0" y="0" width={W} height={H} fill="url(#atlas-limb)" />
        <g>
          {topArcs.map((c, i) => {
            const from = project(c.from.lat, c.from.lon)
            const to = project(c.to.lat, c.to.lon)
            const isTop = i === 0
            const animated = isTop && animateGate
            return (
              <path key={c.populationId} d={arcPath(from, to)} fill="none" stroke={HUD} strokeWidth={1}
                strokeDasharray="4 6" opacity={isTop ? 0.7 : 0.35}
                data-arc="true" data-arc-live={isTop ? 'true' : 'false'} data-arc-population={c.populationId}
                data-animated={animated ? 'true' : 'false'}
                style={animated ? { animation: 'dashflow 1.2s linear infinite' } : undefined}
              />
            )
          })}
        </g>
        <g>
          {populations.map(p => {
            const pt = project(p.lat, p.lon)
            // r/opacity sized to read as an arc ENDPOINT, not dust — an arc must visibly
            // terminate at a city or the whole constellation looks broken.
            return <circle key={p.id} data-testid="atlas-population-dot" cx={pt.x} cy={pt.y} r={2.5} fill={HUD} opacity={0.9} />
          })}
        </g>
        <g>
          {regions.map(({ region, geo }) => {
            const pt = project(geo.lat, geo.lon)
            const health = regionHealth(region.id, displayBatch, doc)
            const color = pinColor(health)
            const ringed = regionId === region.id
            return (
              <g key={region.id}>
                <circle
                  data-testid="atlas-region-dot" cx={pt.x} cy={pt.y} r={4} fill={color}
                  stroke={ringed ? HUD : 'none'} strokeWidth={ringed ? 1.5 : 0}
                  style={{ filter: `drop-shadow(0 0 ${health === 'down' ? 6 : 4}px ${color})` }}
                />
                <text x={pt.x + 6} y={pt.y - 5} style={{ font: `8px var(--font-mono)` }} fill={LABEL_COLOR}>
                  {region.catalogId}
                </text>
              </g>
            )
          })}
        </g>
      </svg>
      <div data-testid="atlas-headline" style={{
        position: 'absolute', left: 12, bottom: 8, fontSize: 11, color: HEADLINE_MUTED,
        textShadow: '0 1px 6px #000', fontVariantNumeric: 'tabular-nums',
      }}>
        {headline}
      </div>
    </div>
  )
}
