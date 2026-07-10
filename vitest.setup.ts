import '@testing-library/jest-dom/vitest'
import { beforeEach, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

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

// ─── React Testing Library cleanup ──────────────────────────────────────────────
// RTL's own auto-cleanup only registers itself when it detects a global `afterEach`
// (see its `typeof afterEach === 'function'` check). This project doesn't enable Vitest's
// `test.globals`, so that check never fires and rendered components leak across tests in
// the same file. Register cleanup explicitly instead.
afterEach(() => {
  cleanup()
})

// ─── jsdom `localStorage` polyfill (Node 22+ compatibility) ─────────────────────
// Node 22+ ships a built-in global `localStorage` (the Web Storage API) that requires the
// `--localstorage-file=<path>` CLI flag to actually persist entries; without that flag the
// global still exists (so environment feature-detection sees it as "already implemented") but
// every method silently no-ops — `setItem`/`getItem`/`clear` are all `undefined` on it. Vitest's
// jsdom environment reuses whatever `globalThis.localStorage` it finds instead of installing its
// own working `Storage` class in that case, so `window.localStorage` under `@vitest-environment
// jsdom` inherits the same broken stub (verified: `Object.getPrototypeOf(localStorage).constructor
// .name === 'Object'`, not `'Storage'`). First surfaced by src/lib/tauri.test.ts (Phase 6 Task
// 5 — the first jsdom test in this repo to touch localStorage). Detect the broken stub and
// replace it with a tiny in-memory Storage-compatible polyfill, scoped to jsdom test files only
// (`typeof window !== 'undefined'`) and only when the existing global is actually non-functional,
// so this is a complete no-op on any runtime where Node's flag/behavior differs (e.g. an older
// Node, or one invoked with `--localstorage-file`).
if (typeof window !== 'undefined' && typeof window.localStorage?.setItem !== 'function') {
  class MemoryStorage {
    private store = new Map<string, string>()
    getItem(key: string): string | null {
      return this.store.has(key) ? this.store.get(key)! : null
    }
    setItem(key: string, value: string): void {
      this.store.set(key, String(value))
    }
    removeItem(key: string): void {
      this.store.delete(key)
    }
    clear(): void {
      this.store.clear()
    }
    key(index: number): string | null {
      return Array.from(this.store.keys())[index] ?? null
    }
    get length(): number {
      return this.store.size
    }
  }
  const polyfill = new MemoryStorage()
  Object.defineProperty(globalThis, 'localStorage', {
    value: polyfill,
    configurable: true,
    writable: true,
    enumerable: true,
  })
  Object.defineProperty(window, 'localStorage', {
    value: polyfill,
    configurable: true,
    writable: true,
    enumerable: true,
  })
}
