// Packet-template types (Flyweight) — the surviving slice of the deleted canvas app's node/edge
// config module (everything else — NODE_CONFIG icon registry, NodeSimConfig, edge configs,
// workload helpers — was removed 2026-07-12 with zero live consumers; see git history if the
// old shapes are ever needed). What remains is read by exactly two places today:
//   - `ScalemapFileV2.packets?: PacketRegistry` (src/lib/serializer.ts) — persisted registry
//   - `BlueprintDependency.packetTemplateId: number | null` (src/lib/world/types.ts)
// There is NO authoring UI for packet templates in the world model — the types survive so
// .scalemap files carrying custom templates stay round-trippable, not because an editor exists.

export type PacketProtocol = 'http' | 'event' | 'stream' | 'db'

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
