// Lives in app/ (not lib/world/) deliberately: lib/ must never import app stores.
//
// Audit ISSUE-028: compilation is cached per doc IDENTITY in a module-level WeakMap, not per
// hook instance. `doc` is immutable and replaced wholesale by every store mutation, so identity
// is a perfect cache key — a region page with N AzRows (each calling useCompiledWorld()) now
// compiles once per doc change instead of N+2 times, with zero call-site changes. WeakMap keys
// let GC reclaim superseded compiles; and since undo/redo restores prior doc REFERENCES
// (ISSUE-031), stepping through history is a cache hit, not a recompile.
import { useWorldStore } from '../store/world.store'
import { compileWorld } from '../../lib/world/compileWorld'
import type { WorldDoc, CompiledWorld } from '../../lib/world/types'

const cache = new WeakMap<WorldDoc, CompiledWorld>()

// Pure accessor for non-hook contexts (same cache).
export function compiledFor(doc: WorldDoc): CompiledWorld {
  let compiled = cache.get(doc)
  if (!compiled) {
    compiled = compileWorld(doc)
    cache.set(doc, compiled)
  }
  return compiled
}

export function useCompiledWorld() {
  const doc = useWorldStore(s => s.doc)
  return compiledFor(doc)
}
