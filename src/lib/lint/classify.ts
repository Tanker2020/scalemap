import { NODE_CONFIG, GROUPING_TYPES, type NodeType } from '../nodeConfig'

// Node-type predicates used by lint rules. Where a whole NODE_CONFIG category maps cleanly to a
// concept we read the category; where the concept is a hand-picked subset we use an explicit set.

const DATABASE_TYPES = new Set<NodeType>(['dbSql', 'dbNoSql'])
const ENTRY_TYPES    = new Set<NodeType>(['cdn', 'apiGateway', 'loadBalancer'])

export function isCompute(type: NodeType): boolean {
  return NODE_CONFIG[type]?.category === 'compute'
}

export function isDatabase(type: NodeType): boolean {
  return DATABASE_TYPES.has(type)
}

// "Entry" / edge-facing nodes that should never talk straight to a database.
export function isEntry(type: NodeType): boolean {
  return ENTRY_TYPES.has(type)
}

// A buffer is anything that can absorb/queue load between an entry node and a database:
// caches (redis/memcached/cdnCache) and messaging (queue/stream/pubsub/eventBus).
export function isBuffer(type: NodeType): boolean {
  const cat = NODE_CONFIG[type]?.category
  return cat === 'caching' || cat === 'messaging'
}

export function isGrouping(type: NodeType): boolean {
  return GROUPING_TYPES.has(type)
}

export function isMessaging(type: NodeType): boolean {
  return NODE_CONFIG[type]?.category === 'messaging'
  // Covers: queue, eventBus, pubsub, stream
}
