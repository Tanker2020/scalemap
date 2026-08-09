// Pure overlay resolver for Comparison Environments (Wave 5). `compileWorld.ts` calls this as
// the very first step, before any placement/instance expansion, so every downstream consumer
// (instances, paths, routing, findings) already operates on the scaled/overridden doc with zero
// changes anywhere else. See `WorldDoc.environments`/`activeEnvironmentId` and the `Environment`
// type in `./types.ts` for the schema this resolves.
import type { WorldDoc } from './types'

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

  let placements = doc.placements
  if (env.serverCountFactor != null || env.placementCountOverrides) {
    placements = Object.fromEntries(Object.entries(doc.placements).map(([id, p]) => {
      const override = env.placementCountOverrides?.[id]
      if (override != null) return [id, { ...p, count: override }]
      if (env.serverCountFactor != null) {
        return [id, { ...p, count: Math.max(1, Math.round(p.count * env.serverCountFactor)) }]
      }
      return [id, p]
    }))
  }

  let populations = doc.populations
  if (env.populationRpsFactor != null) {
    const factor = env.populationRpsFactor
    populations = Object.fromEntries(Object.entries(doc.populations).map(([id, pop]) =>
      [id, { ...pop, peakRps: pop.peakRps * factor }]))
  }

  let servers = doc.servers
  if (env.instanceClassOverrides) {
    const overrides = env.instanceClassOverrides
    servers = Object.fromEntries(Object.entries(doc.servers).map(([id, s]) => {
      const catalogId = overrides[id]
      return catalogId ? [id, { ...s, catalogId }] : [id, s]
    }))
  }

  return { ...doc, placements, populations, servers }
}
