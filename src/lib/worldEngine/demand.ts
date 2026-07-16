// Population traffic demand: diurnal curves + per-route request-mix splitting. (Auto-baseline
// synthetic per-region demand was removed 2026-07-15 — traffic now comes only from authored
// populations.) Spec decision 5, docs/superpowers/specs/2026-07-08-phase2-substrate-engine-design.md.
import type { ClientPopulation, RequestMixEntry } from '../world/types'
import type { Rng } from './rng'

// A compressed 2-minute "day" so the day-night curve is visible within a short demo run.
const DAY_MS = 120_000
const JITTER_FRACTION = 0.03

export function populationDemandRps(pop: ClientPopulation, simMs: number, rng: Rng): number {
  const base =
    pop.diurnal === 'flat'
      ? pop.peakRps
      : pop.peakRps * (0.55 + 0.45 * Math.sin((2 * Math.PI * simMs) / DAY_MS - Math.PI / 2))
  const jitter = 1 + rng.range(-JITTER_FRACTION, JITTER_FRACTION)
  return Math.max(0, base * jitter)
}

// A slice of a population's demand belonging to one route (Phase 2 L7 route system).
// `routeId === null` is the implicit "default" route — the catch-all a population with no request
// mix emits, and the class the LB's default action serves.
export interface RouteDemand {
  routeId: string | null
  rps: number
}

// Splits a population's scalar demand (already jittered/diurnal from populationDemandRps) into
// per-route rps by its requestMix weights. No mix — or an empty/all-non-positive one — yields a
// SINGLE implicit default route carrying 100%, byte-equivalent to the pre-route scalar (so the
// engine's golden tests stay green). Weights are relative and normalized here. Deterministic by
// construction: the only randomness (jitter) is upstream in `totalRps`, so this is a pure
// proportional split with no `rng` — a world with N routes ticks identically every run.
export function splitDemandByMix(totalRps: number, requestMix?: RequestMixEntry[]): RouteDemand[] {
  const entries = (requestMix ?? []).filter(e => e.weight > 0)
  if (entries.length === 0) return [{ routeId: null, rps: totalRps }]
  const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0)
  return entries.map(e => ({ routeId: e.routeId, rps: totalRps * (e.weight / totalWeight) }))
}
