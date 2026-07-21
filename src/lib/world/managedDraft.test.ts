import { describe, it, expect } from 'vitest'
import type { ManagedService } from './types'
import { DB_INSTANCE_CLASSES } from '../dbInstanceClasses'
import {
  ManagedDraft,
  MANAGED_TYPES,
  PROVIDERS,
  STORAGE_CAPABLE,
  scopeToKey,
  scopeFromKey,
  defaultManagedDraft,
  draftFromService,
  draftToConfig,
  applyNodeTypeChange,
  applyProviderChange,
} from './managedDraft'

describe('managedDraft', () => {
  describe('constants', () => {
    it('exports MANAGED_TYPES with key, label, and port', () => {
      expect(MANAGED_TYPES).toHaveLength(8)
      const dbSql = MANAGED_TYPES.find(t => t.key === 'dbSql')
      expect(dbSql).toEqual({ key: 'dbSql', label: 'SQL DB', port: 5432 })
    })

    it('exports PROVIDERS', () => {
      expect(PROVIDERS).toHaveLength(4)
      const aws = PROVIDERS.find(p => p.key === 'aws')
      expect(aws).toEqual({ key: 'aws', label: 'AWS' })
    })

    it('exports STORAGE_CAPABLE set with objectStorage, fileStorage, dbSql, dbNoSql', () => {
      expect(STORAGE_CAPABLE.has('objectStorage')).toBe(true)
      expect(STORAGE_CAPABLE.has('fileStorage')).toBe(true)
      expect(STORAGE_CAPABLE.has('dbSql')).toBe(true)
      expect(STORAGE_CAPABLE.has('dbNoSql')).toBe(true)
      expect(STORAGE_CAPABLE.has('queue')).toBe(false)
      expect(STORAGE_CAPABLE.has('redis')).toBe(false)
    })
  })

  describe('scopeToKey / scopeFromKey', () => {
    it('converts scope object to key string', () => {
      expect(scopeToKey({ kind: 'region', id: 'r1' })).toBe('region:r1')
      expect(scopeToKey({ kind: 'az', id: 'az-1a' })).toBe('az:az-1a')
    })

    it('parses key string to scope object', () => {
      expect(scopeFromKey('region:r1')).toEqual({ kind: 'region', id: 'r1' })
      expect(scopeFromKey('az:az-1a')).toEqual({ kind: 'az', id: 'az-1a' })
    })

    it('returns null for empty key', () => {
      expect(scopeFromKey('')).toBeNull()
    })

    it('returns null for invalid key format', () => {
      expect(scopeFromKey('invalid')).toBeNull()
      expect(scopeFromKey('region:')).toBeNull()
      expect(scopeFromKey(':id')).toBeNull()
      expect(scopeFromKey('zone:id')).toBeNull()
    })

    it('round-trips scope: scope → key → scope', () => {
      const scopes = [
        { kind: 'region' as const, id: 'us-east-1' },
        { kind: 'az' as const, id: 'us-east-1a' },
      ]
      for (const scope of scopes) {
        const key = scopeToKey(scope)
        const parsed = scopeFromKey(key)
        expect(parsed).toEqual(scope)
      }
    })
  })

  describe('defaultManagedDraft', () => {
    it('creates default SQL DB draft', () => {
      const draft = defaultManagedDraft('dbSql')
      expect(draft.nodeType).toBe('dbSql')
      expect(draft.label).toBe('')
      expect(draft.port).toBe(5432)
      expect(draft.provider).toBe('aws')
      expect(draft.scopeKey).toBe('')
      expect(draft.instanceClassId).toBeDefined()
      expect(draft.capacityMode).toBe('provisioned')
      expect(draft.pricing).toBe('onDemand')
      expect(draft.replicaLocality).toBe('sameAz')
      expect(draft.replicaCount).toBe(0)
      expect(draft.multiAz).toBe(false)
    })

    it('creates default NoSQL DB draft with nosql engine defaults', () => {
      const draft = defaultManagedDraft('dbNoSql')
      expect(draft.nodeType).toBe('dbNoSql')
      expect(draft.port).toBe(27017)
      expect(draft.instanceClassId).toBeDefined()
      // Both should have instanceClassId but for different engines
      const sqlDraft = defaultManagedDraft('dbSql')
      expect(draft.instanceClassId).not.toBe(sqlDraft.instanceClassId)
    })

    it('creates default for non-DB type (objectStorage)', () => {
      const draft = defaultManagedDraft('objectStorage')
      expect(draft.nodeType).toBe('objectStorage')
      expect(draft.port).toBe(443)
      expect(draft.provider).toBe('aws')
      // Should NOT have DB fields set
      expect(draft.instanceClassId).toBeUndefined()
      expect(draft.capacityMode).toBeUndefined()
    })

    it('uses first MANAGED_TYPES as default if nodeType not provided', () => {
      const draft = defaultManagedDraft()
      expect(draft.nodeType).toBe(MANAGED_TYPES[0].key)
    })
  })

  describe('draftFromService', () => {
    it('builds draft from existing SQL DB service', () => {
      const service: ManagedService = {
        id: 'ms-1',
        label: 'orders-db',
        nodeType: 'dbSql',
        scope: { kind: 'region', regionId: 'us-east-1' },
        provider: 'aws',
        port: 5432,
        instanceClassId: 'sql.small',
        replicaCount: 2,
        multiAz: true,
        storageGb: 100,
        capacityMode: 'provisioned',
        pricing: 'reserved1yr',
        maxConnections: 500,
        queryTimeoutMs: 5000,
        replicaLocality: 'multiAz',
        promotionTier: 1,
        storageTierId: 'aws-standard',
      }

      const draft = draftFromService(service)

      expect(draft.nodeType).toBe('dbSql')
      expect(draft.label).toBe('orders-db')
      expect(draft.scopeKey).toBe('region:us-east-1')
      expect(draft.provider).toBe('aws')
      expect(draft.port).toBe(5432)
      expect(draft.instanceClassId).toBe('sql.small')
      expect(draft.replicaCount).toBe(2)
      expect(draft.multiAz).toBe(true)
      expect(draft.storageGb).toBe('100')
      expect(draft.maxConnections).toBe('500')
      expect(draft.queryTimeoutMs).toBe('5000')
      expect(draft.replicaLocality).toBe('multiAz')
      expect(draft.promotionTier).toBe('1')
      expect(draft.storageTierId).toBe('aws-standard')
    })

    it('builds draft from AZ-scoped service', () => {
      const service: ManagedService = {
        id: 'ms-2',
        label: 'cache',
        nodeType: 'redis',
        scope: { kind: 'az', azId: 'us-east-1a' },
        provider: 'gcp',
        port: 6379,
      }

      const draft = draftFromService(service)

      expect(draft.scopeKey).toBe('az:us-east-1a')
      expect(draft.provider).toBe('gcp')
    })

    it('converts undefined inherit-capable fields to empty strings', () => {
      const service: ManagedService = {
        id: 'ms-3',
        label: 'queue',
        nodeType: 'queue',
        scope: { kind: 'region', regionId: 'us-east-1' },
        provider: 'aws',
        port: 5672,
      }

      const draft = draftFromService(service)

      expect(draft.maxConnections).toBe('')
      expect(draft.queryTimeoutMs).toBe('')
      expect(draft.promotionTier).toBe('')
      expect(draft.storageGb).toBe('')
      expect(draft.capacityRps).toBe('')
    })
  })

  describe('draftToConfig', () => {
    it('converts draft to ManagedService config', () => {
      const draft: ManagedDraft = {
        nodeType: 'dbSql',
        label: 'orders-db',
        port: 5432,
        provider: 'aws',
        scopeKey: 'region:us-east-1',
        instanceClassId: 'sql.small',
        replicaCount: 2,
        multiAz: true,
        capacityMode: 'provisioned',
        pricing: 'reserved1yr',
        maxConnections: '500',
        queryTimeoutMs: '5000',
        replicaLocality: 'multiAz',
        promotionTier: '1',
        storageGb: '100',
        storageTierId: 'aws-standard',
      }

      const config = draftToConfig(draft)

      expect(config.nodeType).toBe('dbSql')
      expect(config.label).toBe('orders-db')
      expect(config.port).toBe(5432)
      expect(config.provider).toBe('aws')
      expect(config.scope).toEqual({ kind: 'region', regionId: 'us-east-1' })
      expect(config.instanceClassId).toBe('sql.small')
      expect(config.replicaCount).toBe(2)
      expect(config.multiAz).toBe(true)
      expect(config.maxConnections).toBe(500)
      expect(config.queryTimeoutMs).toBe(5000)
      expect(config.promotionTier).toBe(1)
      expect(config.storageGb).toBe(100)
    })

    it('clamps numeric fields to minimum values', () => {
      const draft: ManagedDraft = {
        nodeType: 'dbSql',
        label: 'test',
        port: 0,
        provider: 'aws',
        scopeKey: 'region:us-east-1',
        maxConnections: '0',
        queryTimeoutMs: '0',
        promotionTier: '-5',
        storageGb: '-10',
      }

      const config = draftToConfig(draft)

      expect(config.port).toBe(1)
      expect(config.maxConnections).toBe(1) // Math.max(1, 0)
      expect(config.queryTimeoutMs).toBe(1) // Math.max(1, 0)
      expect(config.promotionTier).toBe(0) // Math.max(0, -5)
      expect(config.storageGb).toBe(0) // Math.max(0, -10)
    })

    it('converts empty strings to undefined for inherit-capable fields', () => {
      const draft: ManagedDraft = {
        nodeType: 'dbSql',
        label: 'test',
        port: 5432,
        provider: 'aws',
        scopeKey: 'region:us-east-1',
        maxConnections: '',
        queryTimeoutMs: '',
        promotionTier: '',
        storageGb: '',
        capacityRps: '',
      }

      const config = draftToConfig(draft)

      expect(config.maxConnections).toBeUndefined()
      expect(config.queryTimeoutMs).toBeUndefined()
      expect(config.promotionTier).toBeUndefined()
      expect(config.storageGb).toBeUndefined()
      expect(config.capacityRps).toBeUndefined()
    })

    it('emits DB fields only for DB node types', () => {
      const dbDraft: ManagedDraft = {
        nodeType: 'dbSql',
        label: 'db',
        port: 5432,
        provider: 'aws',
        scopeKey: 'region:us-east-1',
        instanceClassId: 'sql.small',
        maxConnections: '100',
      }

      const dbConfig = draftToConfig(dbDraft)
      expect(dbConfig.instanceClassId).toBe('sql.small')
      expect(dbConfig.maxConnections).toBe(100)

      // Non-DB type should NOT have DB fields
      const queueDraft: ManagedDraft = {
        nodeType: 'queue',
        label: 'queue',
        port: 5672,
        provider: 'aws',
        scopeKey: 'region:us-east-1',
        instanceClassId: 'sql.small', // Should be ignored
        maxConnections: '100', // Should be ignored
      }

      const queueConfig = draftToConfig(queueDraft)
      expect(queueConfig.instanceClassId).toBeUndefined()
      expect(queueConfig.maxConnections).toBeUndefined()
    })

    it('emits storage fields only for storage-capable types', () => {
      // Storage-capable: objectStorage
      const storageDraft: ManagedDraft = {
        nodeType: 'objectStorage',
        label: 'bucket',
        port: 443,
        provider: 'aws',
        scopeKey: 'region:us-east-1',
        storageGb: '1000',
        storageTierId: 'aws-standard',
      }

      const storageConfig = draftToConfig(storageDraft)
      expect(storageConfig.storageGb).toBe(1000)
      expect(storageConfig.storageTierId).toBe('aws-standard')

      // Non-storage: queue
      const queueDraft: ManagedDraft = {
        nodeType: 'queue',
        label: 'queue',
        port: 5672,
        provider: 'aws',
        scopeKey: 'region:us-east-1',
        storageGb: '1000', // Should be ignored
        storageTierId: 'aws-standard', // Should be ignored
      }

      const queueConfig = draftToConfig(queueDraft)
      expect(queueConfig.storageGb).toBeUndefined()
      expect(queueConfig.storageTierId).toBeUndefined()
    })

    it('emits capacityRps only for non-DB types', () => {
      // Non-DB type
      const queueDraft: ManagedDraft = {
        nodeType: 'queue',
        label: 'queue',
        port: 5672,
        provider: 'aws',
        scopeKey: 'region:us-east-1',
        capacityRps: '1000',
      }

      const queueConfig = draftToConfig(queueDraft)
      expect(queueConfig.capacityRps).toBe(1000)

      // DB type should NOT have capacityRps
      const dbDraft: ManagedDraft = {
        nodeType: 'dbSql',
        label: 'db',
        port: 5432,
        provider: 'aws',
        scopeKey: 'region:us-east-1',
        capacityRps: '1000', // Should be ignored
      }

      const dbConfig = draftToConfig(dbDraft)
      expect(dbConfig.capacityRps).toBeUndefined()
    })

    it('returns undefined scope if scopeKey is empty', () => {
      const draft: ManagedDraft = {
        nodeType: 'dbSql',
        label: 'test',
        port: 5432,
        provider: 'aws',
        scopeKey: '',
      }

      const config = draftToConfig(draft)
      expect(config.scope).toBeUndefined()
    })
  })

  describe('draftFromService → draftToConfig round-trip', () => {
    it('recovers original service values for SQL DB with all fields', () => {
      const originalService: ManagedService = {
        id: 'ms-1',
        label: 'orders-db',
        nodeType: 'dbSql',
        scope: { kind: 'region', regionId: 'us-east-1' },
        provider: 'aws',
        port: 5432,
        instanceClassId: 'sql.small',
        replicaCount: 2,
        multiAz: true,
        storageGb: 100,
        capacityMode: 'provisioned',
        pricing: 'reserved1yr',
        maxConnections: 500,
        queryTimeoutMs: 5000,
        replicaLocality: 'multiAz',
        promotionTier: 1,
        storageTierId: 'aws-standard',
      }

      const draft = draftFromService(originalService)
      const config = draftToConfig(draft)

      // Verify all fields match (except id, which is set by the store)
      expect(config.label).toBe(originalService.label)
      expect(config.nodeType).toBe(originalService.nodeType)
      expect(config.scope).toEqual(originalService.scope)
      expect(config.provider).toBe(originalService.provider)
      expect(config.port).toBe(originalService.port)
      expect(config.instanceClassId).toBe(originalService.instanceClassId)
      expect(config.replicaCount).toBe(originalService.replicaCount)
      expect(config.multiAz).toBe(originalService.multiAz)
      expect(config.storageGb).toBe(originalService.storageGb)
      expect(config.capacityMode).toBe(originalService.capacityMode)
      expect(config.pricing).toBe(originalService.pricing)
      expect(config.maxConnections).toBe(originalService.maxConnections)
      expect(config.queryTimeoutMs).toBe(originalService.queryTimeoutMs)
      expect(config.replicaLocality).toBe(originalService.replicaLocality)
      expect(config.promotionTier).toBe(originalService.promotionTier)
      expect(config.storageTierId).toBe(originalService.storageTierId)
    })

    it('recovers minimal service (only required fields)', () => {
      const minimalService: ManagedService = {
        id: 'ms-2',
        label: 'cache',
        nodeType: 'redis',
        scope: { kind: 'az', azId: 'us-east-1a' },
        provider: 'generic',
        port: 6379,
      }

      const draft = draftFromService(minimalService)
      const config = draftToConfig(draft)

      expect(config.label).toBe(minimalService.label)
      expect(config.nodeType).toBe(minimalService.nodeType)
      expect(config.scope).toEqual(minimalService.scope)
      expect(config.provider).toBe(minimalService.provider)
      expect(config.port).toBe(minimalService.port)
    })
  })

  describe('invalidation rule: changing nodeType re-bases fields', () => {
    it('picks new instance class when switching SQL → NoSQL', () => {
      const sqlDraft: ManagedDraft = {
        nodeType: 'dbSql',
        label: 'orders-db',
        port: 5432,
        provider: 'aws',
        scopeKey: 'region:us-east-1',
        instanceClassId: 'sql.small', // SQL class
      }

      const nosqlDraft = applyNodeTypeChange(sqlDraft, 'dbNoSql')

      expect(nosqlDraft.nodeType).toBe('dbNoSql')
      expect(nosqlDraft.port).toBe(27017) // NoSQL default port
      // Instance class should be re-based to an actual NoSQL class (not just "not sql.small")
      expect(nosqlDraft.instanceClassId).toBeDefined()
      expect(nosqlDraft.instanceClassId).not.toBe('sql.small')
      const rebasedClass = DB_INSTANCE_CLASSES.find(c => c.id === nosqlDraft.instanceClassId)
      expect(rebasedClass).toBeDefined()
      expect(rebasedClass?.engine).toBe('nosql')
      expect(nosqlDraft.label).toBe('orders-db') // Label should be preserved
    })

    it('clears DB fields when switching DB → non-DB', () => {
      const dbDraft: ManagedDraft = {
        nodeType: 'dbSql',
        label: 'orders-db',
        port: 5432,
        provider: 'aws',
        scopeKey: 'region:us-east-1',
        instanceClassId: 'sql.small',
        maxConnections: '500',
        replicaCount: 2,
      }

      const queueDraft = applyNodeTypeChange(dbDraft, 'queue')

      expect(queueDraft.nodeType).toBe('queue')
      expect(queueDraft.port).toBe(5672) // Queue default port
      expect(queueDraft.instanceClassId).toBeUndefined()
      expect(queueDraft.maxConnections).toBeUndefined()
      expect(queueDraft.replicaCount).toBeUndefined()
      expect(queueDraft.label).toBe('orders-db') // Label preserved
    })

    it('preserves non-type-derived fields when changing nodeType', () => {
      const originalDraft: ManagedDraft = {
        nodeType: 'dbSql',
        label: 'my-db',
        port: 5432,
        provider: 'gcp',
        scopeKey: 'az:us-east-1a',
      }

      const newDraft = applyNodeTypeChange(originalDraft, 'dbNoSql')

      expect(newDraft.label).toBe('my-db')
      expect(newDraft.provider).toBe('gcp')
      expect(newDraft.scopeKey).toBe('az:us-east-1a')
    })
  })

  describe('invalidation rule: changing provider clears storageTierId', () => {
    it('clears storageTierId when provider changes from aws to gcp', () => {
      const awsDraft: ManagedDraft = {
        nodeType: 'objectStorage',
        label: 'bucket',
        port: 443,
        provider: 'aws',
        scopeKey: 'region:us-east-1',
        storageTierId: 'aws-standard',
      }

      const gcpDraft = applyProviderChange(awsDraft, 'gcp')

      expect(gcpDraft.provider).toBe('gcp')
      expect(gcpDraft.storageTierId).toBeUndefined()
      expect(gcpDraft.label).toBe('bucket') // Label preserved
      expect(gcpDraft.scopeKey).toBe('region:us-east-1') // Scope preserved
    })

    it('clears storageTierId when provider changes to generic', () => {
      const awsDraft: ManagedDraft = {
        nodeType: 'dbSql',
        label: 'db',
        port: 5432,
        provider: 'aws',
        scopeKey: 'region:us-east-1',
        storageTierId: 'aws-standard',
      }

      const genericDraft = applyProviderChange(awsDraft, 'generic')

      expect(genericDraft.provider).toBe('generic')
      expect(genericDraft.storageTierId).toBeUndefined()
    })

    it('preserves other fields when changing provider', () => {
      const originalDraft: ManagedDraft = {
        nodeType: 'objectStorage',
        label: 'bucket',
        port: 443,
        provider: 'aws',
        scopeKey: 'region:us-east-1',
        storageTierId: 'aws-standard',
        storageGb: '500',
        capacityRps: '1000',
      }

      const newDraft = applyProviderChange(originalDraft, 'azure')

      expect(newDraft.nodeType).toBe('objectStorage')
      expect(newDraft.label).toBe('bucket')
      expect(newDraft.port).toBe(443)
      expect(newDraft.scopeKey).toBe('region:us-east-1')
      expect(newDraft.storageGb).toBe('500')
      expect(newDraft.capacityRps).toBe('1000')
      expect(newDraft.provider).toBe('azure')
      expect(newDraft.storageTierId).toBeUndefined()
    })
  })

  describe('inherit-capable fields are strings', () => {
    it('preserves empty string as distinct from zero', () => {
      // Empty string means "use default"
      const emptyDraft: ManagedDraft = {
        nodeType: 'dbSql',
        label: 'db',
        port: 5432,
        provider: 'aws',
        scopeKey: 'region:us-east-1',
        maxConnections: '', // Empty = inherit
      }

      const config = draftToConfig(emptyDraft)
      expect(config.maxConnections).toBeUndefined()

      // Zero means "use 0" (which gets clamped to 1)
      const zeroDraft: ManagedDraft = {
        ...emptyDraft,
        maxConnections: '0',
      }

      const zeroConfig = draftToConfig(zeroDraft)
      expect(zeroConfig.maxConnections).toBe(1)
    })
  })
})
