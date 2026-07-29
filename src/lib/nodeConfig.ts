// Packet-template types (Flyweight) — the surviving slice of the deleted canvas app's node/edge
// config module (everything else — NODE_CONFIG icon registry, NodeSimConfig, edge configs,
// workload helpers — was removed 2026-07-12 with zero live consumers; see git history if the
// old shapes are ever needed).
//
// ONE registry, TWO views (packet-library phase). `WorldDoc.packets` is a single monotonic id
// space holding every template; what a template IS depends on whether it carries a path:
//   - `listRoutes(reg)`  — http templates WITH a non-empty path → the L7 route catalog (Phase 2:
//     client populations' requestMix, LB listener rules, the entry-tier byte/CPU model).
//   - `listPackets(reg)` — every template WITHOUT a path → the global packet library, all four
//     protocols, bound to service→service dependency edges (and, "advanced", to routes) via a
//     `PacketMixEntry[]` so internal hops carry real payload sizes instead of a flat 2 KB.
// Both are authored in the app (Packets tab / Routes tab); `src/lib/packetResolve.ts` is the one
// place the mix → wire-bytes fallback chain lives.

export type PacketProtocol = 'http' | 'event' | 'stream' | 'db'

// How a client/caller connection behaves. LIVE in the simulation as of the connection-semantics
// phase: `src/lib/connectionModel.ts` turns this (plus the protocol-wins rule for the non-http
// kinds) into a ConnectionProfile that drives connection COUNT (→ ramPerConnMb → the host
// scheduler's OOM path) and per-request handshake CPU, on both the entry tier and internal hops.
// `keep-alive` is the identity — it reproduces the pre-phase Little's-law behavior exactly.
export type ConnectionType = 'keep-alive' | 'short-lived' | 'streaming'

// Sizing lives on the BASE, not on HttpTemplate: every protocol puts bytes on the wire, and the
// packet library binds all four kinds to dependency edges. (`WorkloadDemand`/`WorkloadTier` — a
// canvas-era per-request compute shape with zero readers, and a confusing name-collision with the
// LIVE `WorkloadProfile` in world/types.ts that the engine actually reads — were deleted here.)
export interface BasePacketTemplate {
  id: number
  name: string
  protocol: PacketProtocol
  sizeKb: number            // request/packet payload size
  // Response payload size (KB). Drives the client-facing internet-egress byte rate (and thus the
  // internet-egress cost line) via routeIngressBytes → the engine's entry tier, and the response
  // leg of every internal hop via packetResolve. Optional: absent (older serialized routes) falls
  // back to the 2 KB/way convention, so byte totals are unchanged.
  responseSizeKb?: number
  // Log-normal per-step size jitter driving NIC-burst / p99 tails; 0 (or absent) ⇒ none. The
  // coefficient sigma in a mean-preserving multiplier exp(sigma·z - sigma²/2), applied only to
  // NIC byte bookings (never the cost/egress accumulator). Roughly 0..~1.5.
  sizeVariance?: number
  colorOverride?: string    // particle tint — user-configurable per packet, live in PacketLayer
}

export interface HttpTemplate extends BasePacketTemplate {
  protocol: 'http'
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  // OPTIONAL — the discriminator between the registry's two views. A non-empty path makes this
  // template a ROUTE (matchable by LB listener rules, emittable by a population's requestMix);
  // an absent/empty path makes it a library PACKET bound to edges. See listRoutes/listPackets.
  path?: string
  statusCode: number        // 2xx/3xx ok · 4xx error-but-completes · 5xx drop
  connectionType?: ConnectionType   // see ConnectionType — live via connectionModel.ts
  // How long a STREAMING connection is held open, in seconds. Meaningful only when
  // connectionType === 'streaming' (the other two classes derive their hold from request latency);
  // absent ⇒ connectionModel's DEFAULT_HOLD_SEC. Optional so an existing .scalemap is unchanged.
  holdSeconds?: number
  // "Advanced" route binding: when present and non-empty, this mix supersedes the route's own
  // inline sizeKb/responseSizeKb (see packetResolve's four-tier fallback).
  packetMix?: PacketMixEntry[]
}

export interface EventTemplate extends BasePacketTemplate {
  protocol: 'event'
  topic: string
  eventType: string
  deliveryMode: 'at-most-once' | 'at-least-once' | 'exactly-once'
}

export interface StreamTemplate extends BasePacketTemplate {
  protocol: 'stream'
  streamId: string
  compressionType: 'none' | 'gzip' | 'snappy'
  // A stream is a persistent connection by definition (connectionModel's protocol-wins rule), so
  // this is how long it is held open, in seconds. Absent ⇒ DEFAULT_HOLD_SEC.
  holdSeconds?: number
}

export interface DbTemplate extends BasePacketTemplate {
  protocol: 'db'
  queryType: 'read' | 'write' | 'transaction'
  isWAL: boolean            // Write-Ahead Logging active
  resultSizeKb: number      // DB's response payload size
}

export type PacketTemplate = HttpTemplate | EventTemplate | StreamTemplate | DbTemplate

export type PacketMode = 'generic' | 'custom'

// A weighted binding of library packets to a carrier (a dependency edge or a route). Weights are
// relative, not normalized — weight 0 means "not in the mix" and is stripped by the editors. The
// resolver takes the weighted MEAN of the referenced packets' sizes.
export interface PacketMixEntry {
  packetId: number
  weight: number
}

// Serialized form of the template registry — persisted at `WorldDoc.packets`.
export interface PacketRegistry {
  mode: PacketMode
  templates: Record<number, PacketTemplate>
  nextId: number
  // World-level tier-3 fallback: what an UNBOUND, size-unauthored hop costs on the wire. Absent ⇒
  // the historical DEFAULT_PACKET_BYTES_EACH_WAY (2 KB each way), which is what keeps a pre-packet
  // world byte-identical.
  defaultPacket?: { reqKb: number; respKb: number }
}

// ─── Route catalog (Phase 2 L7 route system) ─────────────────────────────────────────────────
// The revival of the dormant packet system: the HTTP-protocol templates in a PacketRegistry ARE
// the "routes" a ClientPopulation emits (via requestMix) and a regional LB's listener rules match
// on. A route is just an HttpTemplate — it already carries method/path (for matching) and
// sizeKb/workload (for future byte/compute realism). routeId is the template id, stringified,
// so it round-trips through requestMix's string routeId. All functions are pure and immutable
// (mirroring the world.store mutate() convention) so store actions and compileWorld share them.
export type RouteId = string

// A route is an http template that HAS a path — narrowed so consumers (LB matching, the engine's
// route table) get a `string` path rather than the base type's optional one.
export type RouteTemplate = HttpTemplate & { path: string }

export function routeIdOf(t: HttpTemplate): RouteId { return String(t.id) }

export function emptyPacketRegistry(): PacketRegistry {
  return { mode: 'generic', templates: {}, nextId: 1 }
}

// Only the http templates carrying a PATH, id-ascending (stable order for the routes UI +
// deterministic compile). A pathless http template is a library packet, not a route — see
// listPackets and the module header.
export function listRoutes(reg: PacketRegistry): RouteTemplate[] {
  return Object.values(reg.templates)
    .filter((t): t is RouteTemplate => t.protocol === 'http' && !!t.path)
    .sort((a, b) => a.id - b.id)
}

export function getRoute(reg: PacketRegistry, routeId: RouteId): RouteTemplate | undefined {
  const t = reg.templates[Number(routeId)]
  return t && t.protocol === 'http' && !!t.path ? (t as RouteTemplate) : undefined
}

export interface RouteFields {
  name: string
  method: HttpTemplate['method']
  path: string          // the route's path, e.g. '/api/users' — matched against listener patterns
  sizeKb?: number              // request payload size (KB)
  responseSizeKb?: number      // response payload size (KB) — drives client-facing egress
  connectionType?: ConnectionType
  holdSeconds?: number         // streaming hold duration (s) — see HttpTemplate.holdSeconds
  sizeVariance?: number        // log-normal NIC-burst/p99 jitter coefficient (sigma), default 0
}

export function addRoute(reg: PacketRegistry, fields: RouteFields): { registry: PacketRegistry; route: RouteTemplate } {
  const id = reg.nextId
  const route: RouteTemplate = {
    id, name: fields.name, protocol: 'http', sizeKb: fields.sizeKb ?? 1,
    responseSizeKb: fields.responseSizeKb ?? 4, connectionType: fields.connectionType ?? 'keep-alive',
    sizeVariance: fields.sizeVariance ?? 0,
    method: fields.method, path: fields.path, statusCode: 200,
    // Only written when authored: an absent holdSeconds means "use DEFAULT_HOLD_SEC", and a
    // keep-alive/short-lived route has no use for the field at all.
    ...(fields.holdSeconds != null ? { holdSeconds: fields.holdSeconds } : {}),
  }
  return {
    registry: { ...reg, templates: { ...reg.templates, [id]: route }, nextId: id + 1 },
    route,
  }
}

// NOTE: `DEFAULT_PACKET_BYTES_EACH_WAY` and `routeIngressBytes` moved to src/lib/packetResolve.ts
// — the single point where the mix → inline → world-default → 2 KB fallback chain lives. They
// cannot live here: the resolver needs registry TYPES from this module, so a value import in the
// other direction would be a cycle.

export function updateRoute(reg: PacketRegistry, routeId: RouteId, patch: Partial<RouteFields>): PacketRegistry {
  const existing = reg.templates[Number(routeId)]
  if (!existing || existing.protocol !== 'http') return reg
  const updated: HttpTemplate = { ...existing, ...patch } as HttpTemplate
  return { ...reg, templates: { ...reg.templates, [existing.id]: updated } }
}

export function removeRoute(reg: PacketRegistry, routeId: RouteId): PacketRegistry {
  const templates = { ...reg.templates }
  delete templates[Number(routeId)]
  return { ...reg, templates }
}

// ─── Packet library (the registry's second view) ─────────────────────────────────────────────
// Everything WITHOUT a path, any protocol, id-ascending. These are the reusable payload
// definitions bound to dependency edges (BlueprintDependency.packetMix) and, optionally, to
// routes. Same id space as listRoutes — the two views are disjoint by construction.
export function listPackets(reg: PacketRegistry): PacketTemplate[] {
  return Object.values(reg.templates)
    .filter(t => t.protocol !== 'http' || !(t as HttpTemplate).path)
    .sort((a, b) => a.id - b.id)
}

export function getPacket(reg: PacketRegistry, packetId: number): PacketTemplate | undefined {
  const t = reg.templates[packetId]
  return t && (t.protocol !== 'http' || !(t as HttpTemplate).path) ? t : undefined
}

// Fields for a new library packet — everything but the id, which the registry assigns
// monotonically. The omit must DISTRIBUTE over the union: a plain `Omit<PacketTemplate, 'id'>`
// collapses the four kinds to their common keys, silently rejecting `topic`, `queryType`, etc.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type PacketFields = DistributiveOmit<PacketTemplate, 'id'>

export function addPacket(reg: PacketRegistry, fields: PacketFields): { registry: PacketRegistry; packet: PacketTemplate } {
  const id = reg.nextId
  const packet = { ...fields, id } as PacketTemplate
  return {
    registry: { ...reg, templates: { ...reg.templates, [id]: packet }, nextId: id + 1 },
    packet,
  }
}

// Patch an existing library packet. A protocol switch replaces the kind-specific fields wholesale,
// so callers pass the full new shape (see packetDraft.ts's applyProtocolChange) rather than a
// partial that would leave the previous protocol's fields stranded on the object.
export function updatePacket(reg: PacketRegistry, packetId: number, fields: PacketFields): PacketRegistry {
  if (getPacket(reg, packetId) == null) return reg
  const updated = { ...fields, id: packetId } as PacketTemplate
  return { ...reg, templates: { ...reg.templates, [packetId]: updated } }
}

export function removePacket(reg: PacketRegistry, packetId: number): PacketRegistry {
  const templates = { ...reg.templates }
  delete templates[packetId]
  return { ...reg, templates }
}

// Deep-copy a packet under a fresh id. Scrubbing the old id out of bound mixes is NOT this
// function's job (nothing references the copy yet) — see world.store's removePacket cascade.
export function duplicatePacket(reg: PacketRegistry, packetId: number, name: string): { registry: PacketRegistry; packet: PacketTemplate } | null {
  const src = getPacket(reg, packetId)
  if (src == null) return null
  const { id: _id, ...fields } = src
  return addPacket(reg, { ...fields, name } as PacketFields)
}

// Glob prefix matching for listener rules. `*` / `/*` match anything; `/prefix/*` matches the
// prefix and its path children (but NOT a sibling sharing the stem, e.g. `/apix` ∉ `/api/*`); a
// bare trailing `*` is a plain string prefix; everything else is exact equality. First-match-wins
// is the CALLER's responsibility (iterate rules in authored order) — mirrors the firewall loop.
export function routeMatchesPattern(path: string, pattern: string): boolean {
  if (pattern === '*' || pattern === '/*') return true
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2)
    return path === prefix || path.startsWith(prefix + '/')
  }
  if (pattern.endsWith('*')) return path.startsWith(pattern.slice(0, -1))
  return path === pattern
}
