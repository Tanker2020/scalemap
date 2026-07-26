// Packet-template types (Flyweight) — the surviving slice of the deleted canvas app's node/edge
// config module (everything else — NODE_CONFIG icon registry, NodeSimConfig, edge configs,
// workload helpers — was removed 2026-07-12 with zero live consumers; see git history if the
// old shapes are ever needed). What remains is read by exactly two places today:
//   - `ScalemapFileV2.packets?: PacketRegistry` (src/lib/serializer.ts) — persisted registry
//   - `BlueprintDependency.packetTemplateId: number | null` (src/lib/world/types.ts)
// There is NO authoring UI for packet templates in the world model — the types survive so
// .scalemap files carrying custom templates stay round-trippable, not because an editor exists.

export type PacketProtocol = 'http' | 'event' | 'stream' | 'db'

// How a route's client connection behaves. AUTHORED + STORED today, but carries NO simulation
// behavior yet — its future effect (keep-alive → fewer connections / handshake CPU / RAM-per-conn)
// is a later phase (see the packet-cost roadmap). Not dead schema: the editor writes it now so the
// intent round-trips, and the engine will read it when connection semantics land.
export type ConnectionType = 'keep-alive' | 'short-lived' | 'streaming'

export type WorkloadTier = 'simple_crud' | 'moderate_logic' | 'heavy_compute' | 'custom'

export interface WorkloadDemand {
  tier: WorkloadTier
  cpuInstructionsBillions: number    // resolved value (tier-clamped or custom)
  memoryFootprintMb: number          // RAM held per active request for its duration
  ioBoundFraction: number            // 0..0.99 — fraction of wall time blocked on IO (not CPU)
}

export interface BasePacketTemplate {
  id: number
  name: string
  protocol: PacketProtocol
  sizeKb: number            // request/packet payload size
  colorOverride?: string    // optional particle tint
  workload?: WorkloadDemand // per-request compute cost carried by serialized templates
}

export interface HttpTemplate extends BasePacketTemplate {
  protocol: 'http'
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  statusCode: number        // 2xx/3xx ok · 4xx error-but-completes · 5xx drop
  // Response payload size (KB). Drives the client-facing internet-egress byte rate (and thus the
  // internet-egress cost line) via routeIngressBytes → the engine's entry tier. Optional: absent
  // (older serialized routes) falls back to the 2 KB/way convention, so byte totals are unchanged.
  responseSizeKb?: number
  connectionType?: ConnectionType   // see ConnectionType — authored/stored, no sim behavior yet
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
}

export interface DbTemplate extends BasePacketTemplate {
  protocol: 'db'
  queryType: 'read' | 'write' | 'transaction'
  isWAL: boolean            // Write-Ahead Logging active
  resultSizeKb: number      // DB's response payload size
}

export type PacketTemplate = HttpTemplate | EventTemplate | StreamTemplate | DbTemplate

export type PacketMode = 'generic' | 'custom'

// Serialized form of the template registry — persisted in .scalemap v2's optional `packets` key.
export interface PacketRegistry {
  mode: PacketMode
  templates: Record<number, PacketTemplate>
  nextId: number
}

// ─── Route catalog (Phase 2 L7 route system) ─────────────────────────────────────────────────
// The revival of the dormant packet system: the HTTP-protocol templates in a PacketRegistry ARE
// the "routes" a ClientPopulation emits (via requestMix) and a regional LB's listener rules match
// on. A route is just an HttpTemplate — it already carries method/path (for matching) and
// sizeKb/workload (for future byte/compute realism). routeId is the template id, stringified,
// so it round-trips through requestMix's string routeId. All functions are pure and immutable
// (mirroring the world.store mutate() convention) so store actions and compileWorld share them.
export type RouteId = string

export function routeIdOf(t: HttpTemplate): RouteId { return String(t.id) }

export function emptyPacketRegistry(): PacketRegistry {
  return { mode: 'generic', templates: {}, nextId: 1 }
}

// Only the http templates, id-ascending (stable order for the routes UI + deterministic compile).
export function listRoutes(reg: PacketRegistry): HttpTemplate[] {
  return Object.values(reg.templates)
    .filter((t): t is HttpTemplate => t.protocol === 'http')
    .sort((a, b) => a.id - b.id)
}

export function getRoute(reg: PacketRegistry, routeId: RouteId): HttpTemplate | undefined {
  const t = reg.templates[Number(routeId)]
  return t && t.protocol === 'http' ? t : undefined
}

export interface RouteFields {
  name: string
  method: HttpTemplate['method']
  path: string          // the route's path, e.g. '/api/users' — matched against listener patterns
  sizeKb?: number              // request payload size (KB)
  responseSizeKb?: number      // response payload size (KB) — drives client-facing egress
  connectionType?: ConnectionType
}

export function addRoute(reg: PacketRegistry, fields: RouteFields): { registry: PacketRegistry; route: HttpTemplate } {
  const id = reg.nextId
  const route: HttpTemplate = {
    id, name: fields.name, protocol: 'http', sizeKb: fields.sizeKb ?? 1,
    responseSizeKb: fields.responseSizeKb ?? 4, connectionType: fields.connectionType ?? 'keep-alive',
    method: fields.method, path: fields.path, statusCode: 200,
  }
  return {
    registry: { ...reg, templates: { ...reg.templates, [id]: route }, nextId: id + 1 },
    route,
  }
}

// Per-request wire bytes an HTTP route implies, split request/response (KB×1024). The single
// fallback point that preserves pre-packet-sizing behavior: an absent route (the implicit null
// "default" route) or an unauthored field defaults to 2 KB — matching the engine's long-standing
// BYTES_PER_REQUEST_EACH_WAY convention, so a world with no authored sizes stays byte-identical.
export const DEFAULT_PACKET_BYTES_EACH_WAY = 2048

export function routeIngressBytes(route: HttpTemplate | undefined): { reqBytes: number; respBytes: number } {
  return {
    reqBytes: route?.sizeKb != null ? route.sizeKb * 1024 : DEFAULT_PACKET_BYTES_EACH_WAY,
    respBytes: route?.responseSizeKb != null ? route.responseSizeKb * 1024 : DEFAULT_PACKET_BYTES_EACH_WAY,
  }
}

export function updateRoute(reg: PacketRegistry, routeId: RouteId, patch: Partial<RouteFields>): PacketRegistry {
  const existing = reg.templates[Number(routeId)]
  if (!existing || existing.protocol !== 'http') return reg
  const updated: HttpTemplate = { ...existing, ...patch }
  return { ...reg, templates: { ...reg.templates, [existing.id]: updated } }
}

export function removeRoute(reg: PacketRegistry, routeId: RouteId): PacketRegistry {
  const templates = { ...reg.templates }
  delete templates[Number(routeId)]
  return { ...reg, templates }
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
