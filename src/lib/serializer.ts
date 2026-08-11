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
  // Version gate compares on the STRING form (audit ISSUE-070): an externally-authored file
  // carrying `"version": 3` (number) is the same format, not an unknown one — and a numeric
  // 1/2 must land on its dedicated rejection message, not the generic fallthrough.
  const version = data.version == null ? undefined : String(data.version)
  if (version === '1') {
    throw new Error('This is a v1 diagram from an older Scalemap and predates the world model — v1 files are not supported.')
  }
  if (version === '2') {
    // node-model Phase 5: a v2 world predates the typed-node redesign (typed palette nodes, DB
    // appliances, cloud-DB instance classes). It cannot be migrated automatically — rebuild it in
    // the current app. Rejected here, at the version gate, BEFORE the world-shape check.
    throw new Error('This is a v2 world from before the typed-node redesign — it predates node-based services and databases, and cannot be migrated automatically. v2 files are not supported.')
  }
  if (version !== '3') {
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
  // Purity at the boundary (audit ISSUE-069): normalization used to write racks/rack/packets
  // defaults straight onto the just-parsed `data` — harmless for today's callers, but a caller
  // retaining its parsed JSON would see it silently rewritten. Build a NEW normalized file
  // object instead; `data` is never mutated below.
  const src = data as ScalemapFileV3

  // ── Boundary validation (audit ISSUE-012) ──────────────────────────────────
  // Shape-only checking let a corrupt/hostile file carry poison past the gate: a string
  // hourlyUsd turns computeWorldCost into NaN, an unknown routing policy left region scores
  // undefined. Reject values that are PRESENT but invalid; MISSING additive fields get the
  // defensive defaults applied below (a hand-authored bare server still loads).
  const invalid = (msg: string): never => { throw new Error(`Invalid .scalemap file: ${msg}`) }
  const finiteOrThrow = (v: unknown, what: string): void => {
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) {
      invalid(`${what} must be a finite number`)
    }
  }
  const ROUTING_POLICIES = ['latency', 'geo', 'weighted', 'priority']
  if (!ROUTING_POLICIES.includes((src.world.routing as unknown as Record<string, unknown>).policy as string)) {
    invalid(`unknown routing policy "${String((src.world.routing as unknown as Record<string, unknown>).policy)}"`)
  }
  // Missing timing fields default to the createWorld() values; present ones must be finite.
  // (`??` on required fields looks redundant to the TYPE, but the parsed file is untrusted —
  // a hand-authored routing block may omit them despite what ScalemapFileV3 claims.)
  const routing = {
    ...src.world.routing,
    dnsTtlSec: src.world.routing.dnsTtlSec ?? 30,
    healthCheckIntervalMs: src.world.routing.healthCheckIntervalMs ?? 10_000,
    healthCheckFailureThreshold: src.world.routing.healthCheckFailureThreshold ?? 3,
  }
  for (const field of ['dnsTtlSec', 'healthCheckIntervalMs', 'healthCheckFailureThreshold', 'healthCheckTimeoutMs'] as const) {
    finiteOrThrow((routing as unknown as Record<string, unknown>)[field], `routing.${field}`)
  }
  for (const server of Object.values(src.world.servers)) {
    const s = server as unknown as Record<string, unknown>
    finiteOrThrow(s.hourlyUsd, `server ${server.id} hourlyUsd`)
    const specs = s.specs as Record<string, unknown> | null | undefined
    if (specs != null && typeof specs === 'object') {
      for (const field of ['vcpu', 'threadsPerCore', 'ramMb', 'diskGb', 'nicMbps']) {
        finiteOrThrow(specs[field], `server ${server.id} specs.${field}`)
      }
    }
  }

  // Additive-format normalization, all applied to the copy:
  //  • `racks` + non-null `server.rack` (Polish 3 Task 2) — a pre-Polish-3 file won't carry
  //    them; default racks to {} and a server missing `rack` to the free pool (null).
  //  • `loadBalancers` (Phase 1 regional LB) — default {}; compileWorld synthesizes a default
  //    LB per region, so behavior is unchanged.
  //  • `packets` (Phase 2 route system) — the catalog lives at `world.packets`; older files
  //    omit it or carry the vestigial LEGACY top-level `packets` slot (fileOps always passed
  //    undefined). Prefer world.packets; else fold the legacy slot in; else empty (implicit
  //    default route ⇒ the pre-route scalar distribution).
  //  • `connectionLayout` (Connections editor) — default {} (auto tree-layout fallback).
  //  • `blueprints[].dependencies[].packetMix` (packet library) — an older file may carry the
  //    DEPRECATED single-slot `packetTemplateId`; a non-null value is folded into a 1-entry mix so
  //    the intent survives the slot's retirement. Null (every file the app has ever written) is
  //    left exactly as-is, which is what keeps byte totals unchanged.
  const legacyPackets = (data as { packets?: PacketRegistry }).packets
  const servers = Object.fromEntries(Object.entries(src.world.servers).map(([id, server]) =>
    [id, server.rack === undefined ? { ...server, rack: null } : server]))
  const blueprints = Object.fromEntries(Object.entries(src.world.blueprints).map(([id, bp]) => {
    const deps = bp.dependencies ?? []
    if (!deps.some(d => d.packetTemplateId != null && d.packetMix == null)) return [id, bp]
    return [id, {
      ...bp,
      dependencies: deps.map(d => (d.packetTemplateId != null && d.packetMix == null)
        ? { ...d, packetMix: [{ packetId: d.packetTemplateId, weight: 1 }] }
        : d),
    }]
  }))
  const normalizedWorld: WorldDoc = {
    ...src.world,
    routing,
    servers,
    blueprints,
    racks: src.world.racks ?? {},
    loadBalancers: src.world.loadBalancers ?? {},
    vpcs: src.world.vpcs ?? {},
    subnets: src.world.subnets ?? {},
    routeTables: src.world.routeTables ?? {},
    internetGateways: src.world.internetGateways ?? {},
    natGateways: src.world.natGateways ?? {},
    securityGroups: src.world.securityGroups ?? {},
    packets: src.world.packets ?? legacyPackets ?? emptyPacketRegistry(),
    connectionLayout: src.world.connectionLayout ?? {},
    scenario: src.world.scenario ?? undefined,
    slo: src.world.slo ?? undefined,
    environments: src.world.environments ?? {},
    activeEnvironmentId: src.world.activeEnvironmentId ?? undefined,
    cloudProfile: src.world.cloudProfile ?? undefined,
  }
  return {
    version: '3',
    meta: src.meta,
    world: normalizedWorld,
    ...(src.viewState ? { viewState: src.viewState } : {}),
  }
}
