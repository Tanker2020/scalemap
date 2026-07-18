import { describe, it, expect } from 'vitest'
import { createWorld, createRegion, createAz, createServer } from './factories'
import { getPreset } from './instanceCatalog'
import { canAssign, autoArrangePlan, serverHeightU } from './rackModel'
import type { Rack, Server } from './types'

function seedAz() {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  doc.regions[region.id] = region
  const az = createAz(region.id, 'us-east-1a')
  doc.azs[az.id] = az
  return { doc, azId: az.id }
}

// dedicated-8 -> kind 'dedicated' -> serverHeightU 2.
function dedicatedServer(azId: string, label: string): Server {
  const s = createServer(azId, getPreset('dedicated-8')!)
  s.label = label
  return s
}

describe('rackModel', () => {
  describe('serverHeightU', () => {
    it('gives a vps 1U and a dedicated box 2U', () => {
      const { azId } = seedAz()
      expect(serverHeightU(createServer(azId, getPreset('vps-medium')!))).toBe(2 - 1)
      expect(serverHeightU(dedicatedServer(azId, 'd'))).toBe(2)
    })

    // A DB appliance is a real chassis, not a 1U VPS slice. Guards the ternary against
    // defaulting every non-'dedicated' kind to 1U.
    it('gives a db appliance 2U', () => {
      const { azId } = seedAz()
      const server = createServer(azId, getPreset('vps-medium')!)
      server.kind = 'db-sql'
      expect(serverHeightU(server)).toBe(2)
    })
  })

  describe('canAssign', () => {
    it('refuses when the rack is full and allows at exactly capacity', () => {
      const { doc, azId } = seedAz()
      const rack: Rack = { id: 'rack-1', azId, label: 'rack-1', capacityU: 4 }
      doc.racks[rack.id] = rack

      const s1 = dedicatedServer(azId, 'a')   // 2U
      const s2 = dedicatedServer(azId, 'b')   // 2U
      const s3 = dedicatedServer(azId, 'c')   // 2U
      s1.rack = { rackId: rack.id, unit: 1, heightU: 2 }
      doc.servers[s1.id] = s1
      doc.servers[s2.id] = s2
      doc.servers[s3.id] = s3

      // rack at 2U/4U used (s1 only) — s2 fits exactly to 4U.
      expect(canAssign(doc, s2.id, rack.id)).toBe(true)
      s2.rack = { rackId: rack.id, unit: 3, heightU: 2 }
      doc.servers[s2.id] = s2

      // rack now full (4U/4U) — a third 2U server is refused.
      expect(canAssign(doc, s3.id, rack.id)).toBe(false)
      // re-checking s2 (already resident) excludes its own usage — still allowed at exactly capacity.
      expect(canAssign(doc, s2.id, rack.id)).toBe(true)
    })

    it('refuses when the server or the rack does not exist', () => {
      const { doc, azId } = seedAz()
      const rack: Rack = { id: 'rack-1', azId, label: 'rack-1', capacityU: 8 }
      doc.racks[rack.id] = rack
      const s = dedicatedServer(azId, 'a')
      doc.servers[s.id] = s
      expect(canAssign(doc, 'no-such-server', rack.id)).toBe(false)
      expect(canAssign(doc, s.id, 'no-such-rack')).toBe(false)
    })
  })

  describe('autoArrangePlan', () => {
    it('is deterministic and creates rack-2 only when rack-1 is full', () => {
      const { doc, azId } = seedAz()
      const rack1: Rack = { id: 'rack-1', azId, label: 'rack-1', capacityU: 8 }
      doc.racks[rack1.id] = rack1

      // Fill rack-1 to 8U/8U with four 2U dedicated servers.
      for (let i = 0; i < 4; i++) {
        const s = dedicatedServer(azId, `srv-${i}`)
        s.rack = { rackId: rack1.id, unit: i * 2 + 1, heightU: 2 }
        doc.servers[s.id] = s
      }

      // One free-pool server needing placement — rack-1 has no room, so it must overflow
      // into a brand-new rack-2 (not reuse a fictional rack-1 slot).
      const overflow = dedicatedServer(azId, 'zzz-overflow')
      doc.servers[overflow.id] = overflow

      const plan1 = autoArrangePlan(doc, azId)
      expect(plan1.newRacks).toEqual([{ id: 'rack-2', azId, label: 'rack-2', capacityU: 8 }])
      expect(plan1.assignments).toEqual({
        [overflow.id]: { rackId: 'rack-2', unit: 1, heightU: 2 },
      })

      // Pure function, same input -> byte-identical plan (no Date.now()/nextWorldId
      // nondeterminism in how new racks are named).
      const plan2 = autoArrangePlan(doc, azId)
      expect(plan2).toEqual(plan1)
    })

    it('fills existing racks before creating new ones and orders the free pool by label', () => {
      const { doc, azId } = seedAz()
      const rackB: Rack = { id: 'rack-b-id', azId, label: 'rack-b', capacityU: 8 }
      const rackA: Rack = { id: 'rack-a-id', azId, label: 'rack-a', capacityU: 8 }
      doc.racks[rackB.id] = rackB
      doc.racks[rackA.id] = rackA

      const s2 = dedicatedServer(azId, 'server-2')
      const s1 = dedicatedServer(azId, 'server-1')
      doc.servers[s2.id] = s2
      doc.servers[s1.id] = s1

      const plan = autoArrangePlan(doc, azId)
      expect(plan.newRacks).toEqual([])
      // rack-a sorts before rack-b by label; server-1 sorts before server-2 by label.
      expect(plan.assignments[s1.id]).toEqual({ rackId: rackA.id, unit: 1, heightU: 2 })
      expect(plan.assignments[s2.id]).toEqual({ rackId: rackA.id, unit: 3, heightU: 2 })
    })
  })
})
