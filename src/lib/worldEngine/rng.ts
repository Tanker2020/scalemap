// Seeded PRNG (mulberry32) — every stochastic draw anywhere in src/lib/worldEngine/ must
// flow through this; Math.random is never called there. Determinism section,
// docs/superpowers/specs/2026-07-08-world-engine-contracts.md.

export interface Rng {
  next(): number                          // [0, 1)
  range(min: number, max: number): number  // [min, max)
  pick<T>(arr: T[]): T
}

// Fixed default so an un-seeded engine run is still reproducible run-to-run.
const DEFAULT_SEED = 0x9e3779b9

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function createRng(seed: number = DEFAULT_SEED): Rng {
  const next = mulberry32(seed)
  return {
    next,
    range(min: number, max: number): number {
      return min + next() * (max - min)
    },
    pick<T>(arr: T[]): T {
      const idx = Math.floor(next() * arr.length)
      return arr[Math.min(idx, arr.length - 1)]
    },
  }
}
