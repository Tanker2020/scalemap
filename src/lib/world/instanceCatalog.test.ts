import { describe, it, expect } from 'vitest'
import { INSTANCE_CATALOG, getPreset, presetLadder } from './instanceCatalog'
import type { ServerKind } from './types'

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

  // Written as a POSITIVE test on 'vps': oversubscription and burst credits are a VPS-tenancy
  // property, so every OTHER kind — dedicated boxes and db appliances alike — must have neither.
  // Phrased the other way round ('if dedicated … else expect ratio > 1') it wrongly demanded
  // oversubscription from every kind added after vps/dedicated.
  it('only vps presets carry oversubscription; every other kind has none', () => {
    for (const p of INSTANCE_CATALOG) {
      if (p.kind === 'vps') {
        expect(p.oversubscriptionRatio).toBeGreaterThan(1)
      } else {
        expect(p.oversubscriptionRatio).toBeNull()
        expect(p.burstable).toBe(false)
      }
    }
  })

  it('contains every kind and resolves by id', () => {
    expect(INSTANCE_CATALOG.some(p => p.kind === 'vps')).toBe(true)
    expect(INSTANCE_CATALOG.some(p => p.kind === 'dedicated')).toBe(true)
    expect(INSTANCE_CATALOG.some(p => p.kind === 'db-sql')).toBe(true)
    expect(INSTANCE_CATALOG.some(p => p.kind === 'db-nosql')).toBe(true)
    expect(getPreset('vps-medium')?.specs.vcpu).toBe(4)
    expect(getPreset('nope')).toBeUndefined()
  })
})

// Polish 4 T4 (spec D6): the hardware drawer's knobs snap across this ladder — every preset of
// the server's own kind, sorted vcpu-then-ramMb so a knob step never regresses on one axis while
// advancing the other.
describe('presetLadder', () => {
  it('filters to only the requested kind', () => {
    const ladder = presetLadder('dedicated')
    expect(ladder.length).toBeGreaterThan(0)
    expect(ladder.every(p => p.kind === 'dedicated')).toBe(true)
    expect(ladder.some(p => p.kind === 'vps')).toBe(false)
  })

  it('sorts ascending by vcpu, then by ramMb within equal vcpu', () => {
    const ladder = presetLadder('vps')
    for (let i = 1; i < ladder.length; i++) {
      const prev = ladder[i - 1]
      const cur = ladder[i]
      const orderedByVcpu = prev.specs.vcpu < cur.specs.vcpu
      const tiedVcpuOrderedByRam = prev.specs.vcpu === cur.specs.vcpu && prev.specs.ramMb <= cur.specs.ramMb
      expect(orderedByVcpu || tiedVcpuOrderedByRam).toBe(true)
    }
  })

  it('matches INSTANCE_CATALOG membership exactly — same ids, no drop/duplicate', () => {
    const ladder = presetLadder('vps')
    const expectedIds = INSTANCE_CATALOG.filter(p => p.kind === 'vps').map(p => p.id).sort()
    expect(ladder.map(p => p.id).sort()).toEqual(expectedIds)
  })

  it('returns an empty array for a kind with no presets, never throws', () => {
    // Both real kinds ('vps'/'dedicated') are populated today; this just proves presetLadder
    // itself degrades to [] rather than undefined/throw for a hypothetical unmatched kind.
    const ladder = presetLadder('nonexistent' as ServerKind)
    expect(ladder).toEqual([])
  })
})
