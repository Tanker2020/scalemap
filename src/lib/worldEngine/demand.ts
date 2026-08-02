// Population traffic demand: diurnal curves × Poisson arrivals × flash-crowd bursts, plus
// per-route request-mix splitting. (Auto-baseline synthetic per-region demand was removed
// 2026-07-15 — traffic now comes only from authored populations.) Spec decision 5,
// docs/superpowers/specs/2026-07-08-phase2-substrate-engine-design.md.
//
// Audit ISSUE-017: the old ±3% uniform jitter never stressed queues, breakers, or capacity
// thresholds — real arrivals are Poisson (variance ≈ mean) with occasional heavy bursts. The
// diurnal curve now sets the MEAN; per-step arrivals are a seeded Poisson draw around it, and an
// on-off burst process (MMPP-flavored) occasionally multiplies the mean for a few seconds.
// Deterministic by construction: every draw flows through the engine's seeded rng, and
// populations are iterated in a fixed order — same seed ⇒ identical demand.
import type { ClientPopulation, RequestMixEntry } from '../world/types'
import type { Rng } from './rng'
import { effectiveOverlayMultiplier, type DemandOverlayEntry } from './rampMath'

// A compressed 2-minute "day" so the day-night curve is visible within a short demo run.
const DAY_MS = 120_000

// FEAT-003 (Task 19): the diurnal-mean shape as a function of population + simMs, extracted
// unchanged from populationDemandRps's former inline expression for 'flat'/'day-night' (bit-for-
// bit identical output — no behavior change for existing worlds) plus a new 'custom' branch that
// piecewise-linearly interpolates the authored `curve` points over one compressed day. Exported so
// the scenario/demand-overlay tests can assert the curve shape in isolation from the Poisson draw.
export function diurnalMultiplierFor(pop: ClientPopulation, simMs: number): number {
  if (pop.diurnal === 'flat') return 1
  if (pop.diurnal === 'day-night') return 0.55 + 0.45 * Math.sin((2 * Math.PI * simMs) / DAY_MS - Math.PI / 2)

  // 'custom': piecewise-linear interpolation over the authored curve points, keyed by fraction of
  // one compressed day. An absent/empty curve falls back to a flat 1x (no authored shape ⇒ no-op).
  const curve = pop.curve
  if (!curve || curve.length === 0) return 1
  const atFraction = ((simMs % DAY_MS) + DAY_MS) % DAY_MS / DAY_MS
  if (curve.length === 1) return curve[0].multiplier
  const sorted = [...curve].sort((a, b) => a.atFraction - b.atFraction)
  if (atFraction <= sorted[0].atFraction) return sorted[0].multiplier
  if (atFraction >= sorted[sorted.length - 1].atFraction) return sorted[sorted.length - 1].multiplier
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]
    const b = sorted[i + 1]
    if (atFraction >= a.atFraction && atFraction <= b.atFraction) {
      const span = b.atFraction - a.atFraction
      const t = span <= 0 ? 0 : (atFraction - a.atFraction) / span
      return a.multiplier + (b.multiplier - a.multiplier) * t
    }
  }
  return sorted[sorted.length - 1].multiplier
}

// Burst process constants (exported for tests). Expected ~1 burst per 200s of sim time per
// population at burstiness 1; each burst multiplies mean demand 1.5–3× for 2–10s.
export const BURST_START_PROBABILITY_PER_SEC = 0.005
export const BURST_MULTIPLIER_MIN = 1.5
export const BURST_MULTIPLIER_MAX = 3
export const BURST_DURATION_MS_MIN = 2_000
export const BURST_DURATION_MS_MAX = 10_000

// Per-population burst state, owned by the engine (demand.ts stays stateless-per-call).
export interface PopulationDemandState {
  burstUntilMs: number
  burstMultiplier: number
}

export function createDemandState(): PopulationDemandState {
  return { burstUntilMs: -1, burstMultiplier: 1 }
}

// Knuth below this mean, normal approximation above (Knuth's loop runs O(λ) rng draws).
const POISSON_NORMAL_THRESHOLD = 64

// Seeded Poisson sample — Knuth's product method for small λ, N(λ, √λ) approximation for large.
export function samplePoisson(lambda: number, rng: Rng): number {
  if (lambda <= 0) return 0
  if (lambda >= POISSON_NORMAL_THRESHOLD) {
    // Box–Muller from two uniform draws; clamp u1 away from 0 for a finite log.
    const u1 = Math.max(rng.next(), 1e-12)
    const u2 = rng.next()
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * z))
  }
  const limit = Math.exp(-lambda)
  let k = 0
  let p = 1
  do {
    k += 1
    p *= rng.next()
  } while (p > limit)
  return k - 1
}

export function populationDemandRps(
  pop: ClientPopulation,
  simMs: number,
  rng: Rng,
  // Sampling window for the Poisson draw. Defaults to 1s (per-second arrivals) so pure-function
  // callers get classic Poisson counts; the engine passes its real stepMs.
  stepMs = 1_000,
  // Optional burst state (engine-owned, per population). Absent ⇒ no bursts (pure diurnal+Poisson).
  burst?: PopulationDemandState,
  // FEAT-003 (Task 19): the engine-owned demand-shaping overlay (Task 18's 'demand-multiplier'/
  // 'set-population-rps' scenario actions write into it; index.ts threads state.demandOverlay
  // through here). Absent ⇒ no override (multiplier 1, pure diurnal+Poisson) — a pre-scenario
  // world simulates byte-identically.
  demandOverlay?: Map<string, DemandOverlayEntry>,
): number {
  const mean = pop.peakRps * diurnalMultiplierFor(pop, simMs)

  const overlay = demandOverlay?.get(pop.id)
  // Same ramp math as index.ts's write-time helper (both import effectiveOverlayMultiplier from
  // rampMath.ts) — this is the "what's the multiplier right now" read that must match the write
  // side exactly, or a scenario step firing mid-ramp would visibly discontinuity-jump.
  const overlayMultiplier = overlay ? effectiveOverlayMultiplier(overlay, simMs) : 1

  const stepSec = stepMs / 1000
  let effectiveMean = mean * overlayMultiplier
  if (burst) {
    if (simMs < burst.burstUntilMs) {
      effectiveMean *= burst.burstMultiplier
    } else {
      const startP = BURST_START_PROBABILITY_PER_SEC * stepSec * Math.max(0, pop.burstiness ?? 1)
      if (startP > 0 && rng.next() < startP) {
        burst.burstMultiplier = rng.range(BURST_MULTIPLIER_MIN, BURST_MULTIPLIER_MAX)
        burst.burstUntilMs = simMs + rng.range(BURST_DURATION_MS_MIN, BURST_DURATION_MS_MAX)
        effectiveMean *= burst.burstMultiplier
      }
    }
  }

  const arrivals = samplePoisson(effectiveMean * stepSec, rng)
  return arrivals / stepSec
}

// A slice of a population's demand belonging to one route (Phase 2 L7 route system).
// `routeId === null` is the implicit "default" route — the catch-all a population with no request
// mix emits, and the class the LB's default action serves.
export interface RouteDemand {
  routeId: string | null
  rps: number
}

// Splits a population's scalar demand (already Poisson/diurnal from populationDemandRps) into
// per-route rps by its requestMix weights. No mix — or an empty/all-non-positive one — yields a
// SINGLE implicit default route carrying 100%, byte-equivalent to the pre-route scalar (so the
// engine's golden tests stay green). Weights are relative and normalized here. Deterministic by
// construction: the only randomness (arrivals) is upstream in `totalRps`, so this is a pure
// proportional split with no `rng` — a world with N routes ticks identically every run.
export function splitDemandByMix(totalRps: number, requestMix?: RequestMixEntry[]): RouteDemand[] {
  const entries = (requestMix ?? []).filter(e => e.weight > 0)
  if (entries.length === 0) return [{ routeId: null, rps: totalRps }]
  const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0)
  return entries.map(e => ({ routeId: e.routeId, rps: totalRps * (e.weight / totalWeight) }))
}
