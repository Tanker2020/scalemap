// src/app/world/server/InspectorRail.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { InspectorRail } from './InspectorRail'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
} from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'
import { instanceId } from '../../../lib/world/compileWorld'
import type { WorldDoc } from '../../../lib/world/types'

function seed(configure: (doc: WorldDoc, serverId: string) => void) {
  const doc = createWorld()
  const r = createRegion('us-east-1'); const az = createAz(r.id, 'us-east-1a')
  const s = createServer(az.id, getPreset('vps-medium')!)
  doc.regions[r.id] = r; doc.azs[az.id] = az; doc.servers[s.id] = s
  configure(doc, s.id)
  useWorldStore.setState({ doc, history: [], future: [] })
  useSimulationStore.setState({ running: false, latestBatch: null, scrubBatch: null })
  return { doc, serverId: s.id }
}

describe('InspectorRail (read panels)', () => {
  beforeEach(() => useWorldStore.getState().newWorld())

  it('instance selection shows runtime, limits, and host resources', () => {
    const { serverId } = seed((d, sid) => {
      d.servers[sid].stacks = [{ name: 'app', networks: [{ name: 'n', cidr: '172.18.0.0/16' }], volumes: [] }]
      const bp = createBlueprint('api', 1); d.blueprints[bp.id] = bp
      const pl = createPlacement(bp.id, sid)
      pl.runtime = { type: 'container', stackName: 'app', networkNames: ['n'], portMappings: [{ host: 3000, container: 8080 }], cpuLimit: 2, memLimitMb: 640 }
      // Keyed by the placement's own generated id (not an arbitrary literal): compileWorld builds
      // instance ids from `pl.id` (the object's field), not the doc.placements record key, so a
      // mismatched dict key here would leave `compiled.instances` without the id this test expects
      // to select (see ServerBoard.test.tsx:89-93 for the same pitfall documented previously).
      d.placements[pl.id] = pl
    })
    const doc = useWorldStore.getState().doc
    const pl = Object.values(doc.placements)[0]
    const iid = instanceId(pl.id, 0)
    render(<InspectorRail serverId={serverId} selection={{ kind: 'instance', instanceId: iid }} onSelect={() => {}} />)
    expect(screen.getByText('api')).toBeInTheDocument()
    expect(screen.getByText(/stack: app/)).toBeInTheDocument()
    expect(screen.getByText(/640/)).toBeInTheDocument()          // mem limit
  })

  it('firewall selection lists rules in order and drills into a rule', () => {
    const onSelect = vi.fn()
    const { serverId } = seed((d, sid) => {
      d.servers[sid].firewall = [
        { id: 'r1', action: 'allow', port: 443, protocol: 'tcp', source: 'any' },
        { id: 'r2', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' },
      ]
    })
    render(<InspectorRail serverId={serverId} selection={{ kind: 'firewall' }} onSelect={onSelect} />)
    expect(screen.getByText(/first match wins/i)).toBeInTheDocument()
    const rows = screen.getAllByTestId('fw-rule-row')
    expect(rows).toHaveLength(2)
    fireEvent.click(rows[1])
    expect(onSelect).toHaveBeenCalledWith({ kind: 'rule', ruleId: 'r2' })
  })

  it('volume panel lists consumers by volumeName', () => {
    const { serverId } = seed((d, sid) => {
      d.servers[sid].stacks = [{ name: 'app', networks: [], volumes: [{ name: 'pgdata', sizeGb: 12 }] }]
      const pg = createBlueprint('postgres', 2); pg.stateful = true; pg.volumeName = 'pgdata'
      d.blueprints[pg.id] = pg
      const pl = createPlacement(pg.id, sid)
      d.placements[pl.id] = pl
    })
    render(<InspectorRail serverId={serverId} selection={{ kind: 'volume', stackName: 'app', volumeName: 'pgdata' }} onSelect={() => {}} />)
    expect(screen.getByText(/postgres/)).toBeInTheDocument()
  })

  it('empty selection shows a hint', () => {
    const { serverId } = seed(() => {})
    render(<InspectorRail serverId={serverId} selection={null} onSelect={() => {}} />)
    expect(screen.getByText(/click any element/i)).toBeInTheDocument()
  })
})
