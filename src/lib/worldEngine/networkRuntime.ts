// Runtime network model: per-hop latency sampling, NIC throughput caps, blocked-path
// refusals. Spec decision 6, docs/superpowers/specs/2026-07-08-phase2-substrate-engine-design.md.
import type { HopClass, CompiledPath, BlueprintDependency } from '../world/types'
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

// The un-jittered expected value for a hop (audit ISSUE-003): factored out of hopLatencyMs so a
// caller that needs a deterministic latency ESTIMATE — the flow solver's per-step composed-latency
// pass, which touches every downstream row every tick — never has to draw from the seeded rng to
// get one. Drawing there would shift the rng stream for the rest of the step (particle picks, VPS
// steal, breaker jitter, ...), invalidating every other exact-value test in the suite for a number
// that only needs to be a reasonable estimate, not a sampled realization. hopLatencyMs itself is
// unchanged — same jitter, same rng draws, same callers (the tracer).
export function baseHopLatencyMs(
  hopClass: HopClass | 'internet',
  fromRegionCatalogId: string | null,
  toRegionCatalogId: string | null,
  popLatLon: [number, number] | null,
  regionGeo: Record<string, { lat: number; lon: number }>,
): number {
  switch (hopClass) {
    case 'localhost':
      return LOCALHOST_MS
    case 'same-az':
      return SAME_AZ_MS
    case 'cross-az':
      return CROSS_AZ_MS
    case 'cross-region': {
      if (!fromRegionCatalogId || !toRegionCatalogId) return CROSS_REGION_FALLBACK_MS
      const base = interRegionLatencyMs(fromRegionCatalogId, toRegionCatalogId)
      return base > 0 ? base : CROSS_REGION_FALLBACK_MS
    }
    case 'internet': {
      const geo = toRegionCatalogId ? regionGeo[toRegionCatalogId] : undefined
      if (!popLatLon || !geo) return INTERNET_FALLBACK_MS
      const km = greatCircleKm(popLatLon[0], popLatLon[1], geo.lat, geo.lon)
      return km / INTERNET_KM_PER_MS
    }
  }
}

// Jittered wrapper for simulation use. The engine's own seeded Rng drives the jitter here —
// NOT regionConfig.ts's interRegionLatencyMs, which stays pure/deterministic for callers
// relying on stable cost/region-metadata display (Math.random() is forbidden inside worldEngine).
export function hopLatencyMs(
  hopClass: HopClass | 'internet',
  fromRegionCatalogId: string | null,
  toRegionCatalogId: string | null,
  popLatLon: [number, number] | null,
  regionGeo: Record<string, { lat: number; lon: number }>,
  rng: Rng,
): number {
  return jitter(baseHopLatencyMs(hopClass, fromRegionCatalogId, toRegionCatalogId, popLatLon, regionGeo), rng)
}

// ─── NIC caps ─────────────────────────────────────────────────────────────────

// Request/response byte asymmetry for NIC accounting (audit ISSUE-002): a request payload is
// much smaller than its response. flows.ts's BYTES_PER_REQUEST_EACH_WAY (2048, symmetric)
// remains the cost-model convention; the NIC books the split so ingress and egress saturate
// independently and realistically.
export const NIC_REQUEST_BYTES = 512
export const NIC_RESPONSE_BYTES = 2048

export interface NicState {
  inBytesThisStep: number
  outBytesThisStep: number
  // Send-buffer carryover from a saturated step (audit ISSUE-002): what the NIC accepted but
  // could not transmit within the step. Joins the next step's load, so a saturated NIC drains
  // over several ticks instead of resetting. Bounded at one step's cap — beyond 2x cap the
  // excess is SHED, not queued.
  backlogBytes: number
}

export function createNicState(): NicState {
  return { inBytesThisStep: 0, outBytesThisStep: 0, backlogBytes: 0 }
}

/** Accumulate a call's bytes into the step's running totals (no evaluation). */
export function addNicBytes(state: NicState, inBytes: number, outBytes: number): void {
  state.inBytesThisStep += inBytes
  state.outBytesThisStep += outBytes
}

// Evaluate the cumulative step load (+ backlog carryover) against the per-step budget (worst
// direction governs):
//   <= cap        -> deliveredFraction 1, no added latency
//   cap .. 2xcap  -> still delivers fully; excess waits, queuedLatencyMs grows linearly
//                    from 0 at cap to stepMs at 2xcap
//   >  2xcap      -> sheds to 2xcap (deliveredFraction = 2xcap / load), queue saturated
function evaluateNic(
  state: NicState,
  nicMbps: number,
  stepMs: number,
): { capBytes: number; load: number; result: { deliveredFraction: number; queuedLatencyMs: number } } {
  const capBytes = ((nicMbps * 1e6) / 8) * (stepMs / 1000)
  const load = Math.max(state.inBytesThisStep, state.outBytesThisStep) + state.backlogBytes
  if (capBytes <= 0) return { capBytes, load, result: { deliveredFraction: 0, queuedLatencyMs: stepMs } }
  const ratio = load / capBytes
  const result =
    ratio <= 1 ? { deliveredFraction: 1, queuedLatencyMs: 0 }
    : ratio <= 2 ? { deliveredFraction: 1, queuedLatencyMs: (ratio - 1) * stepMs }
    : { deliveredFraction: 2 / ratio, queuedLatencyMs: stepMs }
  return { capBytes, load, result }
}

/** Accumulate + evaluate in one call (the original single-shot API; result reflects backlog). */
export function applyNicCap(
  state: NicState,
  nicMbps: number,
  addInBytes: number,
  addOutBytes: number,
  stepMs: number,
): { deliveredFraction: number; queuedLatencyMs: number } {
  addNicBytes(state, addInBytes, addOutBytes)
  return evaluateNic(state, nicMbps, stepMs).result
}

// End-of-step settlement (audit ISSUE-002): evaluate the step, carry the un-transmitted
// remainder as backlog (bounded at one step-cap — the beyond-2x slice was shed), reset the
// per-step counters. The engine feeds the result into the NEXT step's admits and latency,
// mirroring admittedScale's one-step lag.
export function settleNic(
  state: NicState,
  nicMbps: number,
  stepMs: number,
): { deliveredFraction: number; queuedLatencyMs: number } {
  const { capBytes, load, result } = evaluateNic(state, nicMbps, stepMs)
  state.backlogBytes = capBytes <= 0 ? 0 : Math.min(Math.max(0, load - capBytes), capBytes)
  state.inBytesThisStep = 0
  state.outBytesThisStep = 0
  return result
}

// NAT gateway reuses the identical NicState shape/formulas — a NAT gateway IS a shared NIC from
// the flow solver's point of view, just keyed by gateway id instead of server id.
export type NatGatewayState = NicState
export const createNatGatewayState = createNicState
export const applyNatGatewayCap = applyNicCap
export const settleNatGateway = settleNic

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
