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

// Shared mu/sigma derivation (audit ISSUE-006) — extracted so sampleLatencyMs's sampling and
// timeoutErrorFraction's analytic CDF can never derive two different distributions from the same
// (p50, p99) pair.
function muSigma(p50: number, p99: number): { mu: number; sigma: number } {
  const mu = Math.log(Math.max(p50, 0.001))
  const sigma = (Math.log(Math.max(p99, p50 + 0.001)) - mu) / 2.326
  return { mu, sigma }
}

export function sampleLatencyMs(p50: number, p99: number, rng: Rng): number {
  const { mu, sigma } = muSigma(p50, p99)
  return Math.exp(mu + sigma * boxMullerZ(rng))
}

// Standard normal CDF via the Abramowitz-Stegun erf approximation (accurate to ~1e-7) — a small,
// pure helper, not a new distribution module; it shares muSigma's derivation above with
// sampleLatencyMs, so nothing here can drift from what's actually sampled.
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x)
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429
  const p = 0.3275911
  const t = 1 / (1 + p * ax)
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax)
  return sign * y
}
function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2))
}

// Audit ISSUE-006: the analytic P(latency > timeoutMs) under the SAME log-normal (p50, p99) a hop
// already samples from — cheaper than Monte Carlo (no rng draw, so no extra rng consumption to
// throw off the seeded stream) and deterministic given the same inputs. This is what makes a
// client-side timeout possible: without it, a breaker could only ever open on capacity overflow,
// never on a dependency simply being too slow.
export function timeoutErrorFraction(p50: number, p99: number, timeoutMs: number): number {
  if (!(timeoutMs > 0)) return 0
  const { mu, sigma } = muSigma(p50, p99)
  if (sigma <= 0) return timeoutMs < p50 ? 1 : 0   // degenerate zero-spread case
  const z = (Math.log(Math.max(timeoutMs, 0.001)) - mu) / sigma
  return Math.max(0, Math.min(1, 1 - normalCdf(z)))
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
