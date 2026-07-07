import { beforeEach, afterEach } from 'vitest'

// ─── Deterministic RNG for tests ────────────────────────────────────────────────
// Math.random() is a process-global built-in and is NOT reset by Vitest's per-file module
// isolation. The particle engine samples it heavily (spawn chance, log-normal latency, edge
// selection), so with unseeded randomness one test file's random-consumption shifts the global
// RNG position that the NEXT file in the same worker thread starts from. Because Vitest assigns
// files to workers nondeterministically, low-rps / sparse-arrival assertions occasionally land on
// an unlucky spawn pattern — order-dependent flakiness that passes in isolation but fails ~1/10
// full-suite runs (surfaced by the EC2 compute-model work, which changed how many random calls the
// ec2-heavy test files consume). Reseeding to a fixed value before EVERY test makes each test fully
// reproducible regardless of file/worker ordering, eliminating that class of flakiness. Production
// code is untouched — this only affects the test process.
const SEED = 0x9e3779b9

// mulberry32 — tiny, fast, well-distributed 32-bit PRNG. Deterministic for a given seed.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const _originalRandom = Math.random

beforeEach(() => {
  Math.random = mulberry32(SEED)
})

afterEach(() => {
  Math.random = _originalRandom
})
