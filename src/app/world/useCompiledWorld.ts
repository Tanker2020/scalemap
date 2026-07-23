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

// ── Derived indexes over a compiled world (audit ISSUE-029) ──
// Cached per compiled IDENTITY like compiledFor above: views that need "instances on server X"
// or "instances in AZ Y" index into these instead of re-filtering the whole instance map per
// server per 1 Hz batch (which made AzRow/DatacenterFloor O(servers × instances) every second).

const byServerCache = new WeakMap<CompiledWorld, Map<string, CompiledWorld['instances'][string][]>>()
const byAzCache = new WeakMap<CompiledWorld, Map<string, CompiledWorld['instances'][string][]>>()

function groupInstances(
  compiled: CompiledWorld,
  cache: WeakMap<CompiledWorld, Map<string, CompiledWorld['instances'][string][]>>,
  keyOf: (inst: CompiledWorld['instances'][string]) => string,
): Map<string, CompiledWorld['instances'][string][]> {
  let m = cache.get(compiled)
  if (!m) {
    m = new Map()
    for (const inst of Object.values(compiled.instances)) {
      const key = keyOf(inst)
      const list = m.get(key)
      if (list) list.push(inst)
      else m.set(key, [inst])
    }
    cache.set(compiled, m)
  }
  return m
}

export function instancesByServerFor(compiled: CompiledWorld) {
  return groupInstances(compiled, byServerCache, i => i.serverId)
}

export function instancesByAzFor(compiled: CompiledWorld) {
  return groupInstances(compiled, byAzCache, i => i.azId)
}
