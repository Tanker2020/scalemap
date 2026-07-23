// Circuit breaker state machine — a pure port of the legacy
// src/app/canvas/simulation/particleEngine/circuitBreakers.ts semantics (spec decision 2:
// ports, not rewrites), with three deliberate changes and NO behavioral ones:
//   1. keyed per pathKey `${fromInstanceId}->${dependencyId}` instead of per edge id,
//   2. simMs injected instead of Date.now(),
//   3. no event emission / node lookups — the facade (Task 12) observes state changes and
//      emits breaker_open / breaker_half_open / breaker_closed itself.
// Legacy force-open-on-down and health-gated reset are intentionally not here: flows.ts
// zeroes a down target's subtree and failover.ts owns health.

export type BreakerState = 'closed' | 'open' | 'half-open'

export interface BreakerConfig {
  errorThreshold: number   // windowed error rate that opens the breaker
  windowSize: number       // rolling sample window length
  resetMs: number          // open -> half-open cooldown
}

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  errorThreshold: 0.5,
  windowSize: 20,
  resetMs: 10_000,
}

// Legacy guard (circuitBreakers.ts:74): never open on a thin window — at least this many
// samples must exist before the threshold check can trip.
const MIN_SAMPLES_TO_OPEN = 10

export interface Breaker {
  state: BreakerState
  openedAt: number         // simMs when last opened
  // Per-sample error FRACTION 0..1 (audit ISSUE-001): each recorded call batch contributes its
  // observed failure fraction (a boolean recordResult contributes exactly 1 or 0, so the
  // pre-fix window contents are the degenerate case). Capped at config.windowSize.
  errorWindow: number[]
  // While half-open: whether the single allowed trial has been claimed (admitRequest) and
  // is in flight. Reset on every entry to/exit from half-open.
  trialPending: boolean
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
    b = { state: 'closed', openedAt: 0, errorWindow: [], trialPending: false, config }
    map.set(key, b)
  }
  return b
}

// Weighted recording (audit ISSUE-001): `errored` of `total` calls in this batch failed. The
// window stores the batch's error fraction, so a downstream that is down / erroring /
// CPU-shedding registers as failures even when its caller row isn't `blocked`. A half-open
// trial resolves against errorThreshold: a mostly-failing trial batch reopens, a mostly-clean
// one closes (the boolean cases 1 and 0 behave exactly as before).
export function recordWeighted(breaker: Breaker, errored: number, total: number, simMs: number): void {
  if (total <= 0) return   // no calls observed — nothing to learn from this batch
  const fraction = Math.min(1, Math.max(0, errored / total))
  breaker.errorWindow.push(fraction)
  if (breaker.errorWindow.length > breaker.config.windowSize) {
    breaker.errorWindow.splice(0, breaker.errorWindow.length - breaker.config.windowSize)
  }

  if (breaker.state === 'closed') {
    const errRate =
      breaker.errorWindow.reduce((s, v) => s + v, 0) / breaker.errorWindow.length
    if (errRate >= breaker.config.errorThreshold && breaker.errorWindow.length >= MIN_SAMPLES_TO_OPEN) {
      breaker.state = 'open'
      breaker.openedAt = simMs
      breaker.trialPending = false
    }
  } else if (breaker.state === 'half-open') {
    breaker.trialPending = false // the trial resolved one way or the other
    if (fraction < breaker.config.errorThreshold) {
      breaker.state = 'closed'
      breaker.errorWindow = []
    } else {
      breaker.state = 'open'
      breaker.openedAt = simMs
    }
  }
}

export function recordResult(breaker: Breaker, failed: boolean, simMs: number): void {
  recordWeighted(breaker, failed ? 1 : 0, 1, simMs)
}

export function transition(breaker: Breaker, simMs: number): BreakerState {
  if (breaker.state === 'open' && simMs - breaker.openedAt > breaker.config.resetMs) {
    breaker.state = 'half-open'
    breaker.trialPending = false // fresh half-open window — no trial claimed yet
  }
  return breaker.state
}

// May a request proceed through this breaker right now? closed: always. open: never.
// half-open: exactly once — the first caller claims the trial (side effect: sets
// trialPending), everyone else is refused until recordResult resolves it.
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
