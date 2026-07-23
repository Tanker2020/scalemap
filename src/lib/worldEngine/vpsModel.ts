// VPS noisy-neighbor steal random walk + burstable credit accrual/drain.
// Spec decision 4, docs/superpowers/specs/2026-07-08-phase2-substrate-engine-design.md.
import type { Server } from '../world/types'
import type { Rng } from './rng'

const STEAL_MIN = 0
const STEAL_MAX = 0.4
const STEAL_WALK_STEP = 0.02 // random-walk noise magnitude per step
const STEAL_REVERSION = 0.1 // pull-toward-mean strength per step (keeps the walk bounded)
const SPIKE_THRESHOLD = 0.15 // crossing this upward = a "noisy neighbor" spike

// Burstable-credit model (audit ISSUE-019 — AWS T-series semantics):
//   • credits ACCRUE at a fixed baseline rate CONTINUOUSLY (you earn whenever you exist), and
//   • DRAIN proportionally to utilization ABOVE the baseline — net-negative only while bursting.
// The old model gated accrual on `utilization < 0.4`, but the throttle itself keeps utilization
// high, so a throttled VM could never earn again — a permanent 0.4× lockout. And the single
// `credits ≤ 10` threshold both throttled and recovered, fluttering around 10; the split
// throttle(≤10)/recover(≥25) band is real hysteresis.
const CREDIT_BASELINE_UTIL = 0.4          // earn below this utilization, burn above it
const CREDIT_OVER_BASELINE_HEADROOM = 0.6 // 1 - CREDIT_BASELINE_UTIL
const CREDIT_ACCRUE_PER_SEC = 2           // continuous baseline accrual
const CREDIT_DRAIN_PER_SEC = 5            // max drain at full utilization (net −3/s while pegged)
const CREDIT_THROTTLE_THRESHOLD = 10      // enter throttle at ≤ this
const CREDIT_RECOVER_THRESHOLD = 25       // leave throttle only at ≥ this (hysteresis band)
const BASE_SHARE_FACTOR = 0.4 // effective vCPU factor while credit-throttled

export interface VpsState {
  steal: number
  credits: number
  throttled: boolean
}

export function createVpsState(server: Server): VpsState | null {
  // POSITIVE test on purpose: VPS modeling applies to VPS hosts only. Written as
  // `!== 'dedicated'` this would hand steal/credits to every future ServerKind (db appliances
  // included) by default.
  if (server.kind !== 'vps') return null
  return { steal: 0, credits: 100, throttled: false }
}

export interface VpsStepResult {
  steal: number
  effectiveVcpuFactor: number
  creditsFraction: number | null
  noisySpikeStarted: boolean
  creditsJustExhausted: boolean
}

export function stepVps(
  state: VpsState,
  server: Server,
  hostUtilization: number,
  stepMs: number,
  rng: Rng,
): VpsStepResult {
  const ratio = server.oversubscriptionRatio ?? 1
  const meanSteal = Math.max(0, (ratio - 1) * 0.02)
  const prevSteal = state.steal
  const walk = rng.range(-STEAL_WALK_STEP, STEAL_WALK_STEP)
  const reversion = (meanSteal - state.steal) * STEAL_REVERSION
  state.steal = Math.min(STEAL_MAX, Math.max(STEAL_MIN, state.steal + walk + reversion))
  const noisySpikeStarted = prevSteal < SPIKE_THRESHOLD && state.steal >= SPIKE_THRESHOLD

  let creditsFraction: number | null = null
  let creditsJustExhausted = false
  if (server.burstable) {
    const prevCredits = state.credits
    const stepSec = stepMs / 1000
    // Continuous accrual − over-baseline drain (ISSUE-019): net positive below baseline,
    // net −3/s at full utilization. Never gated by the throttle's own effect on utilization.
    const overBaseline =
      Math.max(0, hostUtilization - CREDIT_BASELINE_UTIL) / CREDIT_OVER_BASELINE_HEADROOM
    state.credits = Math.min(100, Math.max(0,
      state.credits + stepSec * (CREDIT_ACCRUE_PER_SEC - CREDIT_DRAIN_PER_SEC * overBaseline)))
    creditsJustExhausted = prevCredits > 0 && state.credits <= 0
    creditsFraction = state.credits / 100
    // Hysteresis: throttle engages at ≤10, releases only at ≥25 — no flutter at the boundary.
    if (state.throttled) {
      if (state.credits >= CREDIT_RECOVER_THRESHOLD) state.throttled = false
    } else if (state.credits <= CREDIT_THROTTLE_THRESHOLD) {
      state.throttled = true
    }
  }

  const throttled = server.burstable && state.throttled
  const effectiveVcpuFactor = throttled ? BASE_SHARE_FACTOR : 1 - state.steal

  return { steal: state.steal, effectiveVcpuFactor, creditsFraction, noisySpikeStarted, creditsJustExhausted }
}
