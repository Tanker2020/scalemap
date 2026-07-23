// Circuit breaker state machine — originally a pure port of the legacy
// src/app/canvas/simulation/particleEngine/circuitBreakers.ts semantics, rebuilt for audit
// ISSUE-015 with Hystrix/resilience4j-shaped windows:
//   • time-bucketed, REQUEST-WEIGHTED rolling window (bucketMs × bucketCount) — a 1-rps and a
//     10 000-rps dependency no longer contribute one sample each; the error rate is
//     Σfailures/Σtotal over the live window, not an unweighted mean of per-tick fractions.
//   • hysteresis band — OPEN at errorThreshold (0.5); a half-open probe batch only counts as a
//     SUCCESS below closeThreshold (0.2). A dependency hovering at ~50% errors opens and stays
//     open instead of flapping open→half-open→closed→open.
//   • k consecutive half-open probe successes (halfOpenProbes) are required to close — a single
//     lucky probe no longer resets everything.
// Unchanged: keyed per pathKey `${fromInstanceId}->${dependencyId}`, simMs injected (never
// Date.now), no event emission — the facade observes state changes and emits breaker_* itself.

export type BreakerState = 'closed' | 'open' | 'half-open'

export interface BreakerConfig {
  errorThreshold: number   // windowed weighted error rate that opens the breaker
  closeThreshold: number   // a half-open probe batch below this error fraction counts as success
  bucketMs: number         // time-bucket width for the rolling window
  bucketCount: number      // window = bucketMs × bucketCount
  minTotalToOpen: number   // weighted call volume the window must hold before the open check trips
  halfOpenProbes: number   // consecutive successful probe batches required to close
  resetMs: number          // open -> half-open cooldown
}

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  errorThreshold: 0.5,
  closeThreshold: 0.2,
  bucketMs: 1_000,
  bucketCount: 10,
  minTotalToOpen: 10,
  halfOpenProbes: 3,
  resetMs: 10_000,
}

interface Bucket {
  bucketIndex: number   // floor(simMs / bucketMs) — identifies the wall-clock bucket
  failures: number      // weighted failed calls in this bucket
  total: number         // weighted total calls in this bucket
}

export interface Breaker {
  state: BreakerState
  openedAt: number         // simMs when last opened
  buckets: Bucket[]        // rolling window, oldest first; pruned on every record
  // While half-open: whether the single allowed trial has been claimed (admitRequest) and
  // is in flight. Reset on every entry to/exit from half-open.
  trialPending: boolean
  halfOpenSuccesses: number // consecutive successful probe batches in the current half-open spell
  config: BreakerConfig
}

export function pathKey(fromInstanceId: string, dependencyId: string): string {
  return `${fromInstanceId}->${dependencyId}`
}

export function getBreaker(
  map: Map<string, Breaker>,
  key: string,
  config: BreakerConfig = DEFAULT_BREAKER_CONFIG,
): Breaker {
  let b = map.get(key)
  if (!b) {
    b = { state: 'closed', openedAt: 0, buckets: [], trialPending: false, halfOpenSuccesses: 0, config }
    map.set(key, b)
  }
  return b
}

function pruneAndBucket(breaker: Breaker, simMs: number): Bucket {
  const { bucketMs, bucketCount } = breaker.config
  const index = Math.floor(simMs / bucketMs)
  const oldest = index - bucketCount + 1
  breaker.buckets = breaker.buckets.filter(b => b.bucketIndex >= oldest)
  let bucket = breaker.buckets[breaker.buckets.length - 1]
  if (!bucket || bucket.bucketIndex !== index) {
    bucket = { bucketIndex: index, failures: 0, total: 0 }
    breaker.buckets.push(bucket)
  }
  return bucket
}

function windowRate(breaker: Breaker): { rate: number; total: number } {
  let failures = 0
  let total = 0
  for (const b of breaker.buckets) {
    failures += b.failures
    total += b.total
  }
  return { rate: total > 0 ? failures / total : 0, total }
}

// Weighted recording (audit ISSUE-001 + ISSUE-015): `errored` of `total` calls in this batch
// failed — pass REQUEST COUNTS (rps × stepSec), so the window's volume floor has real units. A
// half-open trial resolves against closeThreshold: a clean-enough batch is one probe success
// (halfOpenProbes of them close the breaker), anything else reopens immediately.
export function recordWeighted(breaker: Breaker, errored: number, total: number, simMs: number): void {
  if (total <= 0) return   // no calls observed — nothing to learn from this batch
  const failures = Math.min(total, Math.max(0, errored))
  const fraction = failures / total

  if (breaker.state === 'closed') {
    const bucket = pruneAndBucket(breaker, simMs)
    bucket.failures += failures
    bucket.total += total
    const w = windowRate(breaker)
    if (w.total >= breaker.config.minTotalToOpen && w.rate >= breaker.config.errorThreshold) {
      breaker.state = 'open'
      breaker.openedAt = simMs
      breaker.trialPending = false
      breaker.halfOpenSuccesses = 0
    }
  } else if (breaker.state === 'half-open') {
    breaker.trialPending = false // the trial resolved one way or the other
    if (fraction < breaker.config.closeThreshold) {
      breaker.halfOpenSuccesses += 1
      if (breaker.halfOpenSuccesses >= breaker.config.halfOpenProbes) {
        breaker.state = 'closed'
        breaker.buckets = []
        breaker.halfOpenSuccesses = 0
      }
    } else {
      breaker.state = 'open'
      breaker.openedAt = simMs
      breaker.halfOpenSuccesses = 0
    }
  }
  // open: no calls flow (admitRequest refuses), so nothing to record.
}

export function recordResult(breaker: Breaker, failed: boolean, simMs: number): void {
  recordWeighted(breaker, failed ? 1 : 0, 1, simMs)
}

export function transition(breaker: Breaker, simMs: number): BreakerState {
  if (breaker.state === 'open' && simMs - breaker.openedAt > breaker.config.resetMs) {
    breaker.state = 'half-open'
    breaker.trialPending = false // fresh half-open window — no trial claimed yet
    breaker.halfOpenSuccesses = 0
  }
  return breaker.state
}

// May a request proceed through this breaker right now? closed: always. open: never.
// half-open: exactly once per unresolved trial — the first caller claims it (side effect: sets
// trialPending), everyone else is refused until recordWeighted resolves it.
// This is the gate flows.ts's breakerOpen callback inverts. SKELETON CONCERNS #6.
export function admitRequest(breaker: Breaker): boolean {
  if (breaker.state === 'closed') return true
  if (breaker.state === 'half-open' && !breaker.trialPending) {
    breaker.trialPending = true
    return true
  }
  return false
}

export function clearBreakers(map: Map<string, Breaker>): void {
  map.clear()
}
