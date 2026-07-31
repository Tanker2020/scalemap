import type { WorldDoc, CompiledWorld } from '../world/types'

interface CitationIndex { has: (token: string) => boolean }

const cache = new WeakMap<CompiledWorld, CitationIndex>()

export function buildCitationIndex(doc: WorldDoc, compiled: CompiledWorld): CitationIndex {
  const cached = cache.get(compiled)
  if (cached) return cached

  const ids = new Set<string>([
    ...Object.keys(doc.regions), ...Object.keys(doc.azs), ...Object.keys(doc.servers),
    ...Object.keys(doc.blueprints), ...Object.keys(doc.managedServices),
    ...Object.keys(doc.populations), ...Object.keys(doc.placements),
    ...Object.keys(compiled.instances),
  ])
  const idSet = ids

  const index: CitationIndex = { has: (token: string) => idSet.has(token) }
  cache.set(compiled, index)
  return index
}
