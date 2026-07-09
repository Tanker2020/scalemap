// Log-normal latency sampling (Box-Muller), ported from legacy particleEngine.ts with
// Math.random replaced by rng injection. Spec decision 2: ports, not rewrites.
import type { Rng } from './rng'

export function sampleLatencyMs(p50: number, p99: number, rng: Rng): number {
  const mu = Math.log(Math.max(p50, 0.001))
  const sigma = (Math.log(Math.max(p99, p50 + 0.001)) - mu) / 2.326
  const u1 = Math.max(1e-10, rng.next())
  const u2 = rng.next()
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  return Math.exp(mu + sigma * z)
}
