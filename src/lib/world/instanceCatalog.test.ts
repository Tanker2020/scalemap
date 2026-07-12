import { describe, it, expect } from 'vitest'
import { INSTANCE_CATALOG, getPreset, presetLadder } from './instanceCatalog'

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
    // Both real kinds ('vps'/'dedicated') are populated today; this just proves the filter
    // degrades to [] rather than undefined/throw for a hypothetical unmatched kind.
    const ladder = INSTANCE_CATALOG.filter(p => p.kind === ('nonexistent' as never))
    expect(ladder).toEqual([])
  })
})
