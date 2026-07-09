// Runtime network model: per-hop latency sampling, NIC throughput caps, blocked-path
// refusals. Spec decision 6, docs/superpowers/specs/2026-07-08-phase2-substrate-engine-design.md.
import type { HopClass, CompiledPath, BlueprintDependency, Server } from '../world/types'
import type { Rng } from './rng'
import { interRegionLatencyMs } from '../regionConfig'
import { greatCircleKm } from '../world/regionGeo'

const LOCALHOST_MS = 0.1
const SAME_AZ_MS = 0.5
const CROSS_AZ_MS = 1.5
const HOP_JITTER_FRACTION = 0.1     // every hop class jitters +-10%
const INTERNET_KM_PER_MS = 100      // client->region: ~1ms per 100km great-circle
const INTERNET_FALLBACK_MS = 40     // population/geo unknown — plausible mid-continent RTT half
const CROSS_REGION_FALLBACK_MS = 80 // catalog id unknown — AMER<->EMEA-magnitude default

const jitter = (base: number, rng: Rng): number =>
  Math.max(0, base * (1 + rng.range(-HOP_JITTER_FRACTION, HOP_JITTER_FRACTION)))

// Cross-region intentionally uses the PURE interRegionLatencyMs + rng jitter rather than
// regionConfig's sampleInterRegionLatencyMs (which calls Math.random — forbidden inside
// worldEngine). Identical distribution, deterministic under seed. SKELETON CONCERNS #1.
export function hopLatencyMs(
  hopClass: HopClass | 'internet',
  fromRegionCatalogId: string | null,
  toRegionCatalogId: string | null,
  popLatLon: [number, number] | null,
  regionGeo: Record<string, { lat: number; lon: number }>,
  rng: Rng,
): number {
  switch (hopClass) {
    case 'localhost':
      return jitter(LOCALHOST_MS, rng)
    case 'same-az':
      return jitter(SAME_AZ_MS, rng)
    case 'cross-az':
      return jitter(CROSS_AZ_MS, rng)
    case 'cross-region': {
      if (!fromRegionCatalogId || !toRegionCatalogId) return jitter(CROSS_REGION_FALLBACK_MS, rng)
      const base = interRegionLatencyMs(fromRegionCatalogId, toRegionCatalogId)
      return jitter(base > 0 ? base : CROSS_REGION_FALLBACK_MS, rng)
    }
    case 'internet': {
      const geo = toRegionCatalogId ? regionGeo[toRegionCatalogId] : undefined
      if (!popLatLon || !geo) return jitter(INTERNET_FALLBACK_MS, rng)
      const km = greatCircleKm(popLatLon[0], popLatLon[1], geo.lat, geo.lon)
      return jitter(km / INTERNET_KM_PER_MS, rng)
    }
  }
}

// ─── NIC caps ─────────────────────────────────────────────────────────────────

export interface NicState {
  inBytesThisStep: number
  outBytesThisStep: number
}

export function createNicState(): NicState {
  return { inBytesThisStep: 0, outBytesThisStep: 0 }
}

// Accumulates this call's bytes into the step's running totals, then evaluates the
// cumulative load against the per-step budget (worst direction governs):
//   <= cap        -> deliveredFraction 1, no added latency
//   cap .. 2xcap  -> still delivers fully; excess waits, queuedLatencyMs grows linearly
//                    from 0 at cap to stepMs at 2xcap
//   >  2xcap      -> sheds to 2xcap (deliveredFraction = 2xcap / load), queue saturated
export function applyNicCap(
  state: NicState,
  server: Server,
  addInBytes: number,
  addOutBytes: number,
  stepMs: number,
): { deliveredFraction: number; queuedLatencyMs: number } {
  state.inBytesThisStep += addInBytes
  state.outBytesThisStep += addOutBytes
  const capBytes = ((server.specs.nicMbps * 1e6) / 8) * (stepMs / 1000)
  if (capBytes <= 0) return { deliveredFraction: 0, queuedLatencyMs: stepMs }
  const load = Math.max(state.inBytesThisStep, state.outBytesThisStep)
  const ratio = load / capBytes
  if (ratio <= 1) return { deliveredFraction: 1, queuedLatencyMs: 0 }
  if (ratio <= 2) return { deliveredFraction: 1, queuedLatencyMs: (ratio - 1) * stepMs }
  return { deliveredFraction: 2 / ratio, queuedLatencyMs: stepMs }
}

// ─── Blocked-path refusals ────────────────────────────────────────────────────

// Demand attempted down blocked paths still fires (spec decision 6) — misconfig is a live
// failure mode, not just a compile finding. Convention (SKELETON CONCERNS #2): pass EVERY
// compiled path for this (caller, dependency) pair; demand splits evenly across them and
// the share landing on blocked targets is refused in full.
export function refusedAttemptRate(
  dep: BlueprintDependency,
  blockedPaths: CompiledPath[],
  demandRps: number,
): number {
  const depPaths = blockedPaths.filter(p => p.dependencyId === dep.id)
  if (depPaths.length === 0) return 0
  const blocked = depPaths.filter(p => p.verdict === 'blocked').length
  return demandRps * (blocked / depPaths.length)
}
