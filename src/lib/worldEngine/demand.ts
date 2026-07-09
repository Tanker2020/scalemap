// Population traffic demand: diurnal curves + auto-baseline synthetic per-region populations.
// Spec decision 5, docs/superpowers/specs/2026-07-08-phase2-substrate-engine-design.md.
import type { ClientPopulation, TrafficConfig, PopulationId, RegionId, Region } from '../world/types'
import type { Rng } from './rng'

// A compressed 2-minute "day" so the day-night curve is visible within a short demo run.
const DAY_MS = 120_000
const JITTER_FRACTION = 0.03

export function populationDemandRps(pop: ClientPopulation, simMs: number, rng: Rng): number {
  const base =
    pop.diurnal === 'flat'
      ? pop.peakRps
      : pop.peakRps * (0.55 + 0.45 * Math.sin((2 * Math.PI * simMs) / DAY_MS - Math.PI / 2))
  const jitter = 1 + rng.range(-JITTER_FRACTION, JITTER_FRACTION)
  return Math.max(0, base * jitter)
}

// Synthetic ambient traffic: one population per region, `baselineTotalRps / regionCount`
// each, keyed `baseline:<regionId>` (views may filter by this prefix — see SKELETON
// CONCERNS #1 at the top of this fragment for what this map does and doesn't carry: it's
// numeric demand only, no lat/lon anchoring).
export function baselineDemands(
  traffic: TrafficConfig,
  populations: Record<PopulationId, ClientPopulation>,
  regions: Record<RegionId, Region>,
): Record<PopulationId, number> {
  const result: Record<PopulationId, number> = {}
  if (!traffic.autoBaseline) return result
  const regionIds = Object.keys(regions)
  if (regionIds.length === 0) return result
  const share = traffic.baselineTotalRps / regionIds.length
  for (const regionId of regionIds) {
    const id = `baseline:${regionId}`
    if (populations[id]) continue // an authored population already claims this id — don't clobber it
    result[id] = share
  }
  return result
}
