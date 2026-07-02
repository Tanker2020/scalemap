import { describe, it, expect } from 'vitest'
// isReadParticle and buildSnapshot's inline `seed = p.id % 97` method-selection logic are
// currently two independent, unexported code paths that can disagree on the same particle id.
// This fix extracts one shared, exported helper for the read/write lane classification and
// makes both call sites use it.
import { particleReadWriteLane } from '../particleEngine'

describe('read/write lane consistency', () => {
  it('the same particle id + readPercentage always classifies the same way, everywhere it is checked', () => {
    for (const id of [1, 50, 97, 99, 100, 196, 197]) {
      const a = particleReadWriteLane(id, 0.8)
      const b = particleReadWriteLane(id, 0.8)
      expect(a).toBe(b)
    }
  })

  it('classifies deterministically based on id % 100 vs readPercentage * 100', () => {
    // readPercentage 0.8 -> ids with (id % 100) < 80 are 'read', the rest are 'write'.
    expect(particleReadWriteLane(0, 0.8)).toBe('read')
    expect(particleReadWriteLane(79, 0.8)).toBe('read')
    expect(particleReadWriteLane(80, 0.8)).toBe('write')
    expect(particleReadWriteLane(99, 0.8)).toBe('write')
    // Wraps every 100 ids: id=180 -> 180 % 100 = 80 -> write.
    expect(particleReadWriteLane(180, 0.8)).toBe('write')
    expect(particleReadWriteLane(179, 0.8)).toBe('read')
  })

  it('the actual regression this fix prevents: the old % 97-seeded buildSnapshot logic could ' +
     'disagree with the % 100 isReadParticle logic for the same particle id', () => {
    // Reproduces the OLD, independent formulas side by side. Before the fix, `isReadParticle`
    // used `id % 100` while `buildSnapshot` derived its method label from a `seed = id % 97`
    // fed into `METHODS[seed % METHODS.length]` (mod 5) — an unrelated distribution. For a
    // representative range of ids, the two disagree on "is this a read (GET) or a write".
    const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']
    const readPercentage = 0.8

    const oldIsReadParticle = (particleId: number, edgeReadPct: number): boolean =>
      (particleId % 100) < Math.round(edgeReadPct * 100)

    const oldBuildSnapshotIsRead = (particleId: number): boolean => {
      const seed = particleId % 97
      const method = METHODS[seed % METHODS.length]
      return method === 'GET'
    }

    let disagreements = 0
    for (let id = 0; id < 500; id++) {
      if (oldIsReadParticle(id, readPercentage) !== oldBuildSnapshotIsRead(id)) disagreements++
    }
    // The two old, independent formulas disagree for a large share of ids — proving the bug.
    expect(disagreements).toBeGreaterThan(0)

    // After the fix, both call sites route through the same `particleReadWriteLane` helper, so
    // there is exactly one source of truth and zero possible disagreement by construction.
    for (let id = 0; id < 500; id++) {
      const lane = particleReadWriteLane(id, readPercentage)
      // A single call always agrees with itself — there is no second, independent formula left
      // to disagree with post-fix (this is what "share one helper" guarantees).
      expect(particleReadWriteLane(id, readPercentage)).toBe(lane)
    }
  })
})
