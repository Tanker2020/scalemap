// src/lib/world/managedDraft.ts
// The vocabulary the "add a managed service" form speaks, and its translation into the engine's.
//
// Authoring a managed service means filling in configuration fields — node type, provider,
// scope, and optional cloud-DB or storage settings. This module gives forms (the inline
// ManagedPanel and a future modal) a draft that captures in-progress editing before commit
// to the world document, and translates it into a concrete `ManagedService` record.
//
// Mirrors the existing `serviceDraft.ts` precedent — pure, no React, no store, node-testable.
//
// PURE: no React, no store — node-env testable, same contract as serviceDraft.ts beside it.
import type { CacheConfig, ManagedService } from './types'
import { managedDbEngine, MANAGED_DB_NODE_TYPES } from './types'
import { defaultDbClassId } from '../dbInstanceClasses'

// Types with provisioned storage that drives $/GB-month pricing + the egress free allowance.
export const STORAGE_CAPABLE = new Set(['objectStorage', 'fileStorage', 'dbSql', 'dbNoSql'])

// Key-value cache types (cloudRegistry.ts's authoritative CLOUD_REGISTRY keys) — the ones a
// `cacheConfig` (hit ratio / warmup / ttl) is meaningful for. `cdnCache` is deliberately excluded:
// it's an edge/CDN cache, a different concept from the cache-aside key-value store this feature
// models (worldEngine/cache.ts's effectiveHitRatio, CacheAsideVia's target).
export const CACHE_MANAGED_TYPES = new Set(['redis', 'memcached'])

// Sensible defaults for a freshly-typed cache managed service — same values BlueprintModal.tsx
// uses for a fresh cache blueprint.
const DEFAULT_CACHE_CONFIG: CacheConfig = { hitRatio: 0.9, warmupSec: 30, ttlSec: 300 }

// Author managed services with CLOUD_REGISTRY keys directly (D12) so Cost v2 prices them without
// the alias table. Labels stay human-readable.
export const MANAGED_TYPES: { key: string; label: string; port: number }[] = [
  { key: 'dbSql', label: 'SQL DB', port: 5432 },
  { key: 'dbNoSql', label: 'NoSQL DB', port: 27017 },
  { key: 'objectStorage', label: 'Object store', port: 443 },
  { key: 'queue', label: 'Queue', port: 5672 },
  { key: 'redis', label: 'Redis', port: 6379 },
  { key: 'cdn', label: 'CDN', port: 443 },
  { key: 'apiGateway', label: 'API Gateway', port: 443 },
  { key: 'lambda', label: 'Lambda', port: 443 },
]

// The authoring UI defaults to 'aws' (not the store's 'generic' default) so a freshly added managed
// service prices non-zero immediately — see world.store.ts's addManagedService, whose own default
// stays 'generic' for callers that omit the param.
export const PROVIDERS: { key: ManagedService['provider']; label: string }[] = [
  { key: 'aws', label: 'AWS' },
  { key: 'gcp', label: 'GCP' },
  { key: 'azure', label: 'Azure' },
  { key: 'generic', label: 'Generic' },
]

// Scope key format: 'region:<id>' or 'az:<id>'
export interface ManagedDraft {
  nodeType: string
  label: string
  port: number
  provider: 'generic' | 'aws' | 'gcp' | 'azure'
  scopeKey: string // format: 'region:<id>' or 'az:<id>'

  // Cloud-managed DB fields (meaningful only when nodeType is a DB)
  instanceClassId?: string | null
  replicaCount?: number
  multiAz?: boolean
  capacityMode?: 'provisioned' | 'serverless'
  pricing?: 'onDemand' | 'reserved1yr' | 'reserved3yr'
  // Inherit-capable fields stored as STRINGS to preserve '' as "use default"
  maxConnections?: string
  queryTimeoutMs?: string
  replicaLocality?: 'sameAz' | 'multiAz' | 'crossRegion'
  promotionTier?: string

  // Storage fields (meaningful for storage-capable types)
  // Inherit-capable fields stored as STRINGS to preserve '' as "use default"
  storageGb?: string
  storageTierId?: string | null

  // Non-DB throughput ceiling (meaningful for non-DB types)
  // Inherit-capable field stored as STRING to preserve '' as "use default"
  capacityRps?: string

  // Cache fields (meaningful only when nodeType is in CACHE_MANAGED_TYPES) — same shape as
  // BlueprintModal.tsx's cache draft fields, strings while editing for the same half-typed-box
  // reason as everything else in this file.
  cacheHitRatio?: string
  cacheWarmupSec?: string
  cacheTtlSec?: string
}

/**
 * Convert a scope object to a scope key string.
 * Format: 'region:<id>' or 'az:<id>'
 */
export function scopeToKey(scope: { kind: 'region' | 'az'; id: string }): string {
  return `${scope.kind}:${scope.id}`
}

/**
 * Convert a scope key string to a scope object.
 * Returns null if key is empty or invalid.
 */
export function scopeFromKey(key: string): { kind: 'region' | 'az'; id: string } | null {
  if (!key) return null
  const [kind, id] = key.split(':')
  if ((kind === 'region' || kind === 'az') && id) {
    return { kind, id }
  }
  return null
}

/**
 * Create a sensible empty/default draft for a fresh "Add" flow.
 */
export function defaultManagedDraft(nodeType: string = 'dbSql'): ManagedDraft {
  const typeInfo = MANAGED_TYPES.find(t => t.key === nodeType)
  const port = typeInfo?.port ?? 443

  const draft: ManagedDraft = {
    nodeType,
    label: '',
    port,
    provider: 'aws', // UI default (different from store's 'generic' default) for immediate non-zero pricing
    scopeKey: '',
  }

  // Set up DB-specific defaults if this is a DB type
  if (MANAGED_DB_NODE_TYPES.includes(nodeType as any)) {
    const engine = managedDbEngine(nodeType)
    if (engine) {
      draft.instanceClassId = defaultDbClassId(engine)
      draft.capacityMode = 'provisioned'
      draft.pricing = 'onDemand'
      draft.replicaLocality = 'sameAz'
      draft.replicaCount = 0
      draft.multiAz = false
    }
  }

  if (CACHE_MANAGED_TYPES.has(nodeType)) {
    draft.cacheHitRatio = String(DEFAULT_CACHE_CONFIG.hitRatio)
    draft.cacheWarmupSec = String(DEFAULT_CACHE_CONFIG.warmupSec)
    draft.cacheTtlSec = String(DEFAULT_CACHE_CONFIG.ttlSec)
  }

  return draft
}

/**
 * Build a draft from an existing ManagedService record (the "Edit" entry point).
 */
export function draftFromService(ms: ManagedService): ManagedDraft {
  const scopeKey = scopeToKey({ kind: ms.scope.kind, id: ms.scope.kind === 'region' ? ms.scope.regionId : ms.scope.azId })

  return {
    nodeType: ms.nodeType,
    label: ms.label,
    port: ms.port,
    provider: ms.provider,
    scopeKey,

    // DB fields
    instanceClassId: ms.instanceClassId,
    replicaCount: ms.replicaCount,
    multiAz: ms.multiAz,
    capacityMode: ms.capacityMode,
    pricing: ms.pricing,
    maxConnections: ms.maxConnections?.toString() ?? '',
    queryTimeoutMs: ms.queryTimeoutMs?.toString() ?? '',
    replicaLocality: ms.replicaLocality,
    promotionTier: ms.promotionTier?.toString() ?? '',

    // Storage fields
    storageGb: ms.storageGb?.toString() ?? '',
    storageTierId: ms.storageTierId,

    // Non-DB fields
    capacityRps: ms.capacityRps?.toString() ?? '',

    // Cache fields
    cacheHitRatio: String(ms.cacheConfig?.hitRatio ?? DEFAULT_CACHE_CONFIG.hitRatio),
    cacheWarmupSec: String(ms.cacheConfig?.warmupSec ?? DEFAULT_CACHE_CONFIG.warmupSec),
    cacheTtlSec: String(ms.cacheConfig?.ttlSec ?? DEFAULT_CACHE_CONFIG.ttlSec),
  }
}

/**
 * Convert a draft to a Partial<ManagedService> config.
 * Applies numeric clamps, '' → undefined conversion, and gates output by nodeType.
 */
export function draftToConfig(draft: ManagedDraft): Partial<ManagedService> {
  const scope = scopeFromKey(draft.scopeKey)

  const config: Partial<ManagedService> = {
    nodeType: draft.nodeType,
    label: draft.label,
    port: Math.max(1, draft.port),
    provider: draft.provider,
    scope: scope ? (
      scope.kind === 'region'
        ? { kind: 'region', regionId: scope.id }
        : { kind: 'az', azId: scope.id }
    ) : undefined,
  }

  // Helper: parse inherit-capable field ('' → undefined, otherwise parse number with min)
  const parseNumericInheritable = (value: string | undefined, min: number): number | undefined => {
    if (value === '' || value === undefined) return undefined
    const num = Number(value)
    return isNaN(num) ? undefined : Math.max(min, num)
  }

  const engine = managedDbEngine(draft.nodeType)
  const isDb = engine !== null
  const isStorageCapable = STORAGE_CAPABLE.has(draft.nodeType)
  const isCache = CACHE_MANAGED_TYPES.has(draft.nodeType)

  // DB-specific fields: always assigned so an UPDATE-path merge (world.store.ts's
  // updateManagedService, which spreads `{ ...existing, ...patch }`) actually clears stale
  // values when nodeType changes away from a DB — an omitted key would let the old value
  // survive untouched, but an explicit `undefined` overwrites it. Same idiom as the
  // '' → undefined clearing above for inherit-capable string fields.
  config.instanceClassId = isDb ? draft.instanceClassId : undefined
  config.replicaCount = isDb ? draft.replicaCount : undefined
  config.multiAz = isDb ? draft.multiAz : undefined
  config.capacityMode = isDb ? draft.capacityMode : undefined
  config.pricing = isDb ? draft.pricing : undefined
  config.maxConnections = isDb ? parseNumericInheritable(draft.maxConnections, 1) : undefined
  config.queryTimeoutMs = isDb ? parseNumericInheritable(draft.queryTimeoutMs, 1) : undefined
  config.replicaLocality = isDb ? draft.replicaLocality : undefined
  config.promotionTier = isDb ? parseNumericInheritable(draft.promotionTier, 0) : undefined

  // Storage fields: always assigned, same reasoning as above.
  config.storageGb = isStorageCapable ? parseNumericInheritable(draft.storageGb, 0) : undefined
  config.storageTierId = isStorageCapable ? draft.storageTierId : undefined

  // Non-DB throughput ceiling: always assigned, same reasoning as above.
  config.capacityRps = !isDb ? parseNumericInheritable(draft.capacityRps, 0) : undefined

  // Cache config: always assigned, same reasoning as above — an explicit undefined clears a
  // stale cacheConfig when nodeType changes away from redis/memcached. A blank/non-finite box
  // falls back to the default rather than to 0, but an explicit 0 (e.g. hitRatio) is honored —
  // same "blank vs zero" distinction BlueprintModal.tsx's `num()` helper makes.
  const parseOrDefault = (value: string | undefined, fallback: number): number => {
    if (value === undefined || value.trim() === '') return fallback
    const n = Number(value)
    return Number.isFinite(n) ? n : fallback
  }
  config.cacheConfig = isCache ? {
    hitRatio: Math.max(0, Math.min(1, parseOrDefault(draft.cacheHitRatio, DEFAULT_CACHE_CONFIG.hitRatio))),
    warmupSec: Math.max(0, parseOrDefault(draft.cacheWarmupSec, DEFAULT_CACHE_CONFIG.warmupSec)),
    ttlSec: Math.max(0, parseOrDefault(draft.cacheTtlSec, DEFAULT_CACHE_CONFIG.ttlSec)),
  } : undefined

  return config
}

/**
 * Apply invalidation rule: changing nodeType re-bases type-derived fields.
 * Same idiom as AddServiceForm.tsx's pickKind — reset to new defaults while preserving non-type-derived fields.
 */
export function applyNodeTypeChange(draft: ManagedDraft, newNodeType: string): ManagedDraft {
  const defaults = defaultManagedDraft(newNodeType)
  return {
    ...draft,
    nodeType: newNodeType,
    port: defaults.port,
    // Re-base DB fields
    instanceClassId: defaults.instanceClassId,
    replicaCount: defaults.replicaCount,
    multiAz: defaults.multiAz,
    capacityMode: defaults.capacityMode,
    pricing: defaults.pricing,
    maxConnections: defaults.maxConnections,
    queryTimeoutMs: defaults.queryTimeoutMs,
    replicaLocality: defaults.replicaLocality,
    promotionTier: defaults.promotionTier,
    // Re-base storage fields
    storageGb: defaults.storageGb,
    storageTierId: defaults.storageTierId,
    // Re-base non-DB fields
    capacityRps: defaults.capacityRps,
    // Re-base cache fields
    cacheHitRatio: defaults.cacheHitRatio,
    cacheWarmupSec: defaults.cacheWarmupSec,
    cacheTtlSec: defaults.cacheTtlSec,
  }
}

/**
 * Apply invalidation rule: changing provider clears storageTierId.
 * Tier ids differ per provider (S3/GCS/BLOB) and getServiceSpec returns undefined for 'generic'.
 */
export function applyProviderChange(draft: ManagedDraft, newProvider: ManagedService['provider']): ManagedDraft {
  return {
    ...draft,
    provider: newProvider,
    storageTierId: undefined, // Clear invalid tier id
  }
}
