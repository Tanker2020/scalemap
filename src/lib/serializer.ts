import type { PacketRegistry } from './nodeConfig'
import { emptyPacketRegistry } from './nodeConfig'
import type { WorldDoc } from './world/types'

// ─── .scalemap v2 (world model) ──────────────────────────────────────────────
// The v1 file-format interface and its (de)serialize functions were removed in Phase 2 Task 17
// along with the legacy canvas/simulation UI that was their only caller.

export interface WorldViewState {
  level: 'globe' | 'region' | 'az' | 'server'
  regionId?: string
  azId?: string
  serverId?: string
}

export interface ScalemapFileV2 {
  version: '2'
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
  const file: ScalemapFileV2 = {
    version: '2',
    meta: { name, created, modified: new Date().toISOString() },
    world,
    ...(packets ? { packets } : {}),
    ...(viewState ? { viewState } : {}),
  }
  return JSON.stringify(file, null, 2)
}

export function deserializeWorld(raw: string): ScalemapFileV2 {
  const data = JSON.parse(raw) as { version?: unknown; world?: unknown }
  if (data.version === '1') {
    throw new Error('This is a v1 diagram from an older Scalemap and predates the world model — v1 files are not supported.')
  }
  if (data.version !== '2') {
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
  const result = data as ScalemapFileV2
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
  return result
}
