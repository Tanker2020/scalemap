// VPS noisy-neighbor steal random walk + burstable credit accrual/drain.
// Spec decision 4, docs/superpowers/specs/2026-07-08-phase2-substrate-engine-design.md.
import type { Server } from '../world/types'
import type { Rng } from './rng'

const STEAL_MIN = 0
const STEAL_MAX = 0.4
const STEAL_WALK_STEP = 0.02 // random-walk noise magnitude per step
const STEAL_REVERSION = 0.1 // pull-toward-mean strength per step (keeps the walk bounded)
const SPIKE_THRESHOLD = 0.15 // crossing this upward = a "noisy neighbor" spike

const CREDIT_LOW_UTIL = 0.4
const CREDIT_HIGH_HEADROOM = 0.6 // 1 - CREDIT_LOW_UTIL
const CREDIT_ACCRUE_PER_SEC = 2
const CREDIT_DRAIN_PER_SEC = 5
const CREDIT_RECOVER_THRESHOLD = 10
const BASE_SHARE_FACTOR = 0.4 // effective vCPU factor while credit-throttled

export interface VpsState {
  steal: number
  credits: number
}

export function createVpsState(server: Server): VpsState | null {
  // POSITIVE test on purpose: VPS modeling applies to VPS hosts only. Written as
  // `!== 'dedicated'` this would hand steal/credits to every future ServerKind (db appliances
  // included) by default.
  if (server.kind !== 'vps') return null
  return { steal: 0, credits: 100 }
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
    if (hostUtilization < CREDIT_LOW_UTIL) {
      state.credits = Math.min(100, state.credits + (stepMs / 1000) * CREDIT_ACCRUE_PER_SEC)
    } else {
      const drain =
        (stepMs / 1000) * CREDIT_DRAIN_PER_SEC * ((hostUtilization - CREDIT_LOW_UTIL) / CREDIT_HIGH_HEADROOM)
      state.credits = Math.max(0, state.credits - drain)
    }
    creditsJustExhausted = prevCredits > 0 && state.credits <= 0
    creditsFraction = state.credits / 100
  }

  const throttled = server.burstable && state.credits <= CREDIT_RECOVER_THRESHOLD
  const effectiveVcpuFactor = throttled ? BASE_SHARE_FACTOR : 1 - state.steal

  return { steal: state.steal, effectiveVcpuFactor, creditsFraction, noisySpikeStarted, creditsJustExhausted }
}
