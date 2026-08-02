// FEAT-003 (Task 19): the ONE ramp-interpolation formula shared by the demand overlay's write
// side (index.ts's applyScenarioAction, seeding a new scenario step's starting multiplier from
// wherever an in-flight ramp actually is) and its read side (demand.ts's populationDemandRps,
// scaling the diurnal mean before the Poisson draw). Both MUST compute "the overlay's current
// effective multiplier at simMs" identically, or a demand-shaping scenario step landing mid-ramp
// would visibly discontinuity-jump the instant it fires. Kept in its own tiny pure file (rather
// than duplicated, or hoisted into either call site) because index.ts imports from demand.ts and
// never the reverse — a shared leaf module avoids introducing a new import direction.
export interface DemandOverlayEntry {
  multiplier: number
  targetMultiplier: number
  rampStartMs: number
  rampSec: number
}

export function effectiveOverlayMultiplier(entry: DemandOverlayEntry, simMs: number): number {
  if (entry.rampSec <= 0) return entry.targetMultiplier
  const elapsedSec = Math.max(0, simMs - entry.rampStartMs) / 1000
  if (elapsedSec >= entry.rampSec) return entry.targetMultiplier
  return entry.multiplier + (entry.targetMultiplier - entry.multiplier) * (elapsedSec / entry.rampSec)
}
