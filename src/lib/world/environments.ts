// Pure overlay resolver for Comparison Environments (Wave 5). `compileWorld.ts` calls this as
// the very first step, before any placement/instance expansion, so every downstream consumer
// (instances, paths, routing, findings) already operates on the scaled/overridden doc with zero
// changes anywhere else. See `WorldDoc.environments`/`activeEnvironmentId` and the `Environment`
// type in `./types.ts` for the schema this resolves.
import type { AutoscalePolicy, WorldDoc } from './types'
import { getPreset } from './instanceCatalog'

// Scales an autoscale policy's min/max envelope by `factor`, preserving the min<=max invariant
// (rounding can otherwise push minCount above a shrunk maxCount). Used by both
// `serverCountFactor` (factor = the environment's factor directly) and
// `placementCountOverrides` (factor = override / original count, so the autoscale envelope moves
// by the same proportion as the flat placement count).
function scaleAutoscale(autoscale: AutoscalePolicy, factor: number): AutoscalePolicy {
  const maxCount = Math.max(1, Math.round(autoscale.maxCount * factor))
  const minCount = Math.min(maxCount, Math.max(1, Math.round(autoscale.minCount * factor)))
  return { ...autoscale, minCount, maxCount }
}

// Resolves `doc.activeEnvironmentId` against `doc.environments` and returns a NEW WorldDoc with
// the overlay's scaling/overrides applied to placements/populations/servers. Returns the SAME
// `doc` reference (no-op) when there is no active environment, or when the active environment id
// doesn't resolve to an entry -- in the latter case `compileWorld.ts` is responsible for emitting
// a `missing-environment` compile finding; this function stays silent/pure.
export function applyEnvironment(doc: WorldDoc): WorldDoc {
  const envId = doc.activeEnvironmentId
  if (!envId) return doc
  const env = doc.environments?.[envId]
  if (!env) return doc

  // The envelope compileWorld.ts actually instantiates for an autoscaled placement is
  // `autoscale.maxCount`, not `count` (see compileWorld.ts's `envelopeCount`) -- so any
  // count-scaling below must also move `autoscale.minCount`/`maxCount` by the same factor, or
  // the environment's scaling would be silently invisible for every autoscaled placement.
  let placements = doc.placements
  if (env.serverCountFactor != null || env.placementCountOverrides) {
    placements = Object.fromEntries(Object.entries(doc.placements).map(([id, p]) => {
      const override = env.placementCountOverrides?.[id]
      let factor: number | null = null
      let newCount = p.count
      if (override != null) {
        newCount = override
        factor = p.count > 0 ? override / p.count : 1
      } else if (env.serverCountFactor != null) {
        factor = env.serverCountFactor
        newCount = Math.max(1, Math.round(p.count * factor))
      }
      if (factor == null) return [id, p]
      const autoscale = p.autoscale ? scaleAutoscale(p.autoscale, factor) : p.autoscale
      return [id, { ...p, count: newCount, autoscale }]
    }))
  }

  let populations = doc.populations
  if (env.populationRpsFactor != null) {
    const factor = env.populationRpsFactor
    populations = Object.fromEntries(Object.entries(doc.populations).map(([id, pop]) =>
      [id, { ...pop, peakRps: pop.peakRps * factor }]))
  }

  // Swapping just `catalogId` was cosmetic -- the fields that actually drive host scheduling
  // (specs) and cost (hourlyUsd) must be re-resolved from the new preset too, or an override
  // changes the label without changing anything the engine or cost model reads. An unknown
  // catalog id leaves the server unchanged (mirrors the missing-environment fallback: silent,
  // not a throw).
  let servers = doc.servers
  if (env.instanceClassOverrides) {
    const overrides = env.instanceClassOverrides
    servers = Object.fromEntries(Object.entries(doc.servers).map(([id, s]) => {
      const catalogId = overrides[id]
      if (!catalogId) return [id, s]
      const preset = getPreset(catalogId)
      if (!preset) return [id, s]
      return [id, { ...s, catalogId, specs: preset.specs, hourlyUsd: preset.hourlyUsd }]
    }))
  }

  return { ...doc, placements, populations, servers }
}
