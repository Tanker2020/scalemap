import { describe, it, expect } from 'vitest'
import { nodePaletteEntries, nextApplianceName } from './paletteEntries'
import { createWorld, createRegion, createAz, createDbServer } from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'

describe('nodePaletteEntries', () => {
  it('offers both compute and data groups', () => {
    const groups = new Set(nodePaletteEntries().map(e => e.group))
    expect(groups.has('compute')).toBe(true)
    expect(groups.has('data')).toBe(true)
  })

  it('files vps and dedicated presets under compute', () => {
    for (const entry of nodePaletteEntries().filter(e => e.kind === 'vps' || e.kind === 'dedicated')) {
      expect(entry.group).toBe('compute')
    }
  })

  it('files db appliance presets under data', () => {
    const data = nodePaletteEntries().filter(e => e.group === 'data')
    expect(data.length).toBeGreaterThan(0)
    for (const entry of data) {
      expect(['db-sql', 'db-nosql']).toContain(entry.kind)
    }
  })

  // Every entry maps to a real preset — a palette row that dispatches getPreset(id)! on a
  // missing id would throw at click time, which no test of the component would catch.
  it('references only resolvable preset ids', () => {
    for (const entry of nodePaletteEntries()) {
      expect(getPreset(entry.presetId)).toBeDefined()
    }
  })

  // The catalog label embeds the specs ('VPS Medium (4 vCPU / 8 GB)'), but the palette renders a
  // separate detail column with the same numbers. Keeping both makes every row wrap to two lines
  // and say everything twice, so the palette label drops the parenthetical.
  it('strips the redundant spec parenthetical from the label', () => {
    for (const entry of nodePaletteEntries()) {
      expect(entry.label).not.toMatch(/[()]/)
    }
    expect(nodePaletteEntries().map(e => e.label)).toContain('VPS Medium')
    expect(nodePaletteEntries().map(e => e.label)).toContain('SQL DB Medium')
  })

  // The dedicated presets spell their specs WITHOUT parentheses ('Dedicated 16-core / 64 GB'),
  // so paren-stripping alone left them wrapping. The core count distinguishes them from each
  // other and must survive; only the trailing RAM figure (already in the detail column) goes.
  it('strips a trailing RAM figure while keeping what distinguishes an entry', () => {
    const labels = nodePaletteEntries().map(e => e.label)
    expect(labels).toContain('Dedicated 8-core')
    expect(labels).toContain('Dedicated 16-core')
    expect(labels).toContain('Dedicated 32-core')
  })

  it('keeps every label unique, so no two rows read identically', () => {
    const labels = nodePaletteEntries().map(e => e.label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('carries a price and a spec detail for every entry', () => {
    for (const entry of nodePaletteEntries()) {
      expect(entry.hourlyUsd).toBeGreaterThan(0)
      expect(entry.detail).toMatch(/vCPU/)
    }
  })

  // Groups render as sections in listed order, so compute must come before data.
  it('lists compute entries before data entries', () => {
    const entries = nodePaletteEntries()
    const lastCompute = entries.map(e => e.group).lastIndexOf('compute')
    const firstData = entries.map(e => e.group).indexOf('data')
    expect(lastCompute).toBeLessThan(firstData)
  })
})

describe('nextApplianceName', () => {
  it('starts at 1 in an empty world', () => {
    expect(nextApplianceName(createWorld(), 'db-sql')).toBe('sql-1')
    expect(nextApplianceName(createWorld(), 'db-nosql')).toBe('nosql-1')
  })

  it('numbers past existing appliances of the same engine', () => {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    const az = createAz(region.id, 'us-east-1a')
    doc.regions[region.id] = region
    doc.azs[az.id] = az

    const first = createDbServer(az.id, getPreset('db-sql-medium')!, 'sql-1')
    doc.servers[first.server.id] = first.server

    expect(nextApplianceName(doc, 'db-sql')).toBe('sql-2')
  })

  // SQL and NoSQL number independently — one sql box must not push the first nosql box to 2.
  it('counts each engine separately', () => {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    const az = createAz(region.id, 'us-east-1a')
    doc.regions[region.id] = region
    doc.azs[az.id] = az

    const sql = createDbServer(az.id, getPreset('db-sql-medium')!, 'sql-1')
    doc.servers[sql.server.id] = sql.server

    expect(nextApplianceName(doc, 'db-nosql')).toBe('nosql-1')
  })
})
