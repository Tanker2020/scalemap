// Log-normal latency sampling (Box-Muller), ported from legacy particleEngine.ts with
// Math.random replaced by rng injection. Spec decision 2: ports, not rewrites.
import type { Rng } from './rng'

// Standard-normal draw via Box-Muller, two rng.next() draws. Shared by sampleLatencyMs and
// sampleSizeMultiplier below (slice 3) — do not reimplement Box-Muller differently in either.
function boxMullerZ(rng: Rng): number {
  const u1 = Math.max(1e-10, rng.next())
  const u2 = rng.next()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

export function sampleLatencyMs(p50: number, p99: number, rng: Rng): number {
  const mu = Math.log(Math.max(p50, 0.001))
  const sigma = (Math.log(Math.max(p99, p50 + 0.001)) - mu) / 2.326
  return Math.exp(mu + sigma * boxMullerZ(rng))
}

// Mean-preserving log-normal per-step size multiplier (slice 3: NIC-burst tails). E[multiplier]
// = 1 exactly (median < 1, occasional spikes > 1), so applying it to NIC byte booking moves only
// the tail, never the mean — the mean egress-cost line stays untouched. sigma <= 0 is a hard
// no-op: returns 1 and takes NO rng draw at all, so an unauthored (sigma-less) route leaves the
// engine's seeded rng stream completely undisturbed (backward-compat invariant).
export function sampleSizeMultiplier(sigma: number, rng: Rng): number {
  if (sigma <= 0) return 1
  return Math.exp(sigma * boxMullerZ(rng) - (sigma * sigma) / 2)
}
