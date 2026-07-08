import { describe, it, expect } from 'vitest'
import { INSTANCE_CATALOG, getPreset } from './instanceCatalog'

describe('instance catalog', () => {
  it('has unique ids and positive specs/pricing', () => {
    const ids = new Set(INSTANCE_CATALOG.map(p => p.id))
    expect(ids.size).toBe(INSTANCE_CATALOG.length)
    for (const p of INSTANCE_CATALOG) {
      expect(p.specs.vcpu).toBeGreaterThan(0)
      expect(p.specs.ramMb).toBeGreaterThan(0)
      expect(p.specs.diskGb).toBeGreaterThan(0)
      expect(p.specs.nicMbps).toBeGreaterThan(0)
      expect(p.hourlyUsd).toBeGreaterThan(0)
    }
  })

  it('vps presets carry oversubscription, dedicated never do', () => {
    for (const p of INSTANCE_CATALOG) {
      if (p.kind === 'dedicated') {
        expect(p.oversubscriptionRatio).toBeNull()
        expect(p.burstable).toBe(false)
      } else {
        expect(p.oversubscriptionRatio).toBeGreaterThan(1)
      }
    }
  })

  it('contains both kinds and resolves by id', () => {
    expect(INSTANCE_CATALOG.some(p => p.kind === 'vps')).toBe(true)
    expect(INSTANCE_CATALOG.some(p => p.kind === 'dedicated')).toBe(true)
    expect(getPreset('vps-medium')?.specs.vcpu).toBe(4)
    expect(getPreset('nope')).toBeUndefined()
  })
})
