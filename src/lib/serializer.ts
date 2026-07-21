import type { PacketRegistry } from './nodeConfig'
import { emptyPacketRegistry } from './nodeConfig'
import type { WorldDoc } from './world/types'

// ─── .scalemap v3 (typed-node world model) ───────────────────────────────────
// The v1 file-format interface and its (de)serialize functions were removed in Phase 2 Task 17
// along with the legacy canvas/simulation UI that was their only caller.
//
// node-model Phase 5 — clean breaking change. The typed-node redesign (palette nodes, DB
// appliances, cloud-DB instance classes, real replica promotion) has no faithful automatic
// translation from a pre-redesign document, so the format version is bumped '2' -> '3' and every
// v2 file is rejected on load with a clear message, exactly the way v1 was rejected when the world
// model itself shipped. There is no migration path — this mirrors `serializer.ts`'s v1 rejection.

export interface WorldViewState {
  level: 'globe' | 'region' | 'az' | 'server'
  regionId?: string
  azId?: string
  serverId?: string
}

export interface ScalemapFileV3 {
  version: '3'
  meta: { name: string; created: string; modified: string }
  world: WorldDoc
  packets?: PacketRegistry
  viewState?: WorldViewState
}

export function serializeWorld(
  world: WorldDoc,
  name: string,
  created: string,
  packets?: PacketRegistry,
  viewState?: WorldViewState,
): string {
  const file: ScalemapFileV3 = {
    version: '3',
    meta: { name, created, modified: new Date().toISOString() },
    world,
    ...(packets ? { packets } : {}),
    ...(viewState ? { viewState } : {}),
  }
  return JSON.stringify(file, null, 2)
}

export function deserializeWorld(raw: string): ScalemapFileV3 {
  const data = JSON.parse(raw) as { version?: unknown; world?: unknown }
  if (data.version === '1') {
    throw new Error('This is a v1 diagram from an older Scalemap and predates the world model — v1 files are not supported.')
  }
  if (data.version === '2') {
    // node-model Phase 5: a v2 world predates the typed-node redesign (typed palette nodes, DB
    // appliances, cloud-DB instance classes). It cannot be migrated automatically — rebuild it in
    // the current app. Rejected here, at the version gate, BEFORE the world-shape check.
    throw new Error('This is a v2 world from before the typed-node redesign — it predates node-based services and databases, and cannot be migrated automatically. v2 files are not supported.')
  }
  if (data.version !== '3') {
    throw new Error(`Unsupported scalemap version: ${String(data.version)}`)
  }
  const meta = (data as { meta?: unknown }).meta
  const world = data.world as Record<string, unknown> | undefined
  const requiredCollections = [
    'routing', 'populations', 'regions', 'azs', 'servers',
    'blueprints', 'placements', 'managedServices',
  ] as const
  const worldIsValid =
    world != null && typeof world === 'object' &&
    requiredCollections.every(key => world[key] != null && typeof world[key] === 'object')
  if (meta == null || typeof meta !== 'object' || !worldIsValid) {
    throw new Error('Invalid .scalemap file: missing or malformed world document')
  }
  // Additive-format normalization (Polish 3 Task 2): `racks` and non-null `server.rack`
  // were both introduced after v2 shipped, so a pre-Polish-3 file simply won't carry
  // them — default racks to {} and any server missing a `rack` key to the free pool
  // (null) rather than rejecting/leaving the field undefined.
  const result = data as ScalemapFileV3
  result.world.racks ??= {}
  // Additive-format normalization (Phase 1 regional LB): `loadBalancers` was introduced after
  // v2 shipped, so a pre-LB file won't carry it — default to {}. compileWorld synthesizes a
  // default LB per region from it, so behavior is unchanged.
  result.world.loadBalancers ??= {}
  // Additive-format normalization (Phase 2 route system): the route catalog now lives at
  // `world.packets` (mutate()-managed for undo/dirty, serialized inside `world` like every other
  // collection). Older files either omit it entirely or carry a LEGACY top-level `packets` slot —
  // the vestigial sibling the running app never actually populated (fileOps always passed
  // undefined). Prefer world.packets; else fold the legacy slot in; else default to empty. This
  // keeps every pre-Phase-2 file byte-behaviorally unchanged (empty catalog ⇒ implicit default
  // route ⇒ the pre-route scalar distribution).
  if (result.world.packets == null) {
    const legacy = (data as { packets?: PacketRegistry }).packets
    result.world.packets = legacy ?? emptyPacketRegistry()
  }
  for (const server of Object.values(result.world.servers)) {
    if (server.rack === undefined) server.rack = null
  }
  // Additive-format normalization (Connections editor): manual node positions were introduced
  // after v2 shipped — a pre-Connections file simply won't carry the map. Default to {} (every
  // node then falls back to the auto tree-layout).
  result.world.connectionLayout ??= {}
  return result
}
