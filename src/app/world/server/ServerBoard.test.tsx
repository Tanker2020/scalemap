// src/app/world/server/ServerBoard.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { ServerBoard } from './ServerBoard'
import { ServerView } from '../ServerView'
import { layoutServerBoard, serverTraces, MAX_BOARD_CHIPS } from './boardLayout'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useNavStore } from '../../store/nav.store'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
} from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'
import { compileWorld } from '../../../lib/world/compileWorld'
import type { WorldDoc, ComposeStack } from '../../../lib/world/types'
import type { MetricsBatch } from '../../../lib/worldEngine/types'

beforeAll(() => {
  // jsdom lacks ResizeObserver, which ServerBoard uses for scale-to-fit.
  class RO { observe() {} unobserve() {} disconnect() {} }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO
})

const stack = (name: string): ComposeStack => ({ name, networks: [{ name: 'net', cidr: '172.18.0.0/16' }], volumes: [] })

function seed(configure: (doc: WorldDoc, serverId: string) => void) {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const az = createAz(region.id, 'us-east-1a')
  const server = createServer(az.id, getPreset('vps-medium')!)
  server.label = 'web-01'
  doc.regions[region.id] = region; doc.azs[az.id] = az; doc.servers[server.id] = server
  configure(doc, server.id)
  useWorldStore.setState({ doc, history: [], future: [] })
  useNavStore.setState({ level: 'server', regionId: region.id, azId: az.id, serverId: server.id })
  return { doc, server }
}

function renderBoard(doc: WorldDoc, serverId: string) {
  const compiled = compileWorld(doc)
  const server = doc.servers[serverId]
  const layout = layoutServerBoard(server, doc, compiled)
  const traces = serverTraces(serverId, doc, compiled)
  render(
    <ServerBoard
      serverId={serverId} layout={layout} traces={traces}
      selection={null} onSelect={() => {}} hoveredBlueprintId={null} onHoverBlueprint={() => {}}
    />,
  )
  return { layout, traces }
}

describe('ServerBoard (static stage)', () => {
  beforeEach(() => useWorldStore.getState().newWorld())

  it('renders a chip per resident instance with signature color', () => {
    const { doc, server } = seed((d, sid) => {
      const bp = createBlueprint('nginx', 0)
      d.blueprints[bp.id] = bp
      d.placements['p'] = createPlacement(bp.id, sid)
    })
    renderBoard(doc, server.id)
    // "nginx" now also appears in HardwarePlatform's DIMM legend (D8) — disambiguate to the chip.
    const chip = screen.getAllByText('nginx').map(el => el.closest('[data-chip]')).find(Boolean) as HTMLElement
    expect(chip).toBeInTheDocument()
    // signature-color tab present
    expect(chip.querySelector('[data-chip-tab]')).toBeTruthy()
  })

  it('container chips render inside their stack plate', () => {
    const { doc, server } = seed((d, sid) => {
      d.servers[sid].stacks = [stack('app')]
      const bp = createBlueprint('api', 1)
      d.blueprints[bp.id] = bp
      const pl = createPlacement(bp.id, sid)
      pl.runtime = { type: 'container', stackName: 'app', networkNames: [], portMappings: [{ host: 3000, container: 8080 }], cpuLimit: null, memLimitMb: null }
      d.placements[pl.id] = pl
    })
    renderBoard(doc, server.id)
    expect(screen.getByText(/stack: app/)).toBeInTheDocument()
    // "api" now also appears in HardwarePlatform's DIMM legend (D8) — assert at least one match.
    expect(screen.getAllByText('api').length).toBeGreaterThan(0)
    expect(screen.getByText(/3000.*8080/)).toBeInTheDocument()   // :host→container
  })

  it('blocked trace renders dashed with rule label', () => {
    const { doc, server } = seed((d, sid) => {
      const web = createBlueprint('web', 0); web.ports = [{ port: 8080, protocol: 'tcp', visibility: 'public' }]
      const db = createBlueprint('db', 2)
      web.dependencies = [{ id: 'd', target: { kind: 'blueprint', blueprintId: db.id }, port: 5432, protocol: 'db', packetTemplateId: null }]
      d.blueprints[web.id] = web; d.blueprints[db.id] = db
      // Keyed by the placement's own generated id (not an arbitrary literal) — compileWorld
      // looks up `doc.placements[instance.placementId]` internally, so a mismatched dict key
      // silently drops the instance from dependency-path resolution (paths: [] instead of the
      // intended blocked path). Mirrors the correct convention the previous test in this file
      // already uses (`d.placements[pl.id] = pl`).
      const webPl = createPlacement(web.id, sid)
      const dbPl = createPlacement(db.id, sid)
      d.placements[webPl.id] = webPl
      d.placements[dbPl.id] = dbPl
      d.servers[sid].firewall = [
        { id: 'deny', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' },
        { id: 'allow', action: 'allow', port: 'any', protocol: 'any', source: 'internal' },
      ]
    })
    const { traces } = renderBoard(doc, server.id)
    expect(traces.some(t => t.verdict === 'blocked')).toBe(true)
    const dashed = document.querySelector('path[stroke-dasharray]')
    expect(dashed).toBeTruthy()
  })

  it('renders overflow chip when instances exceed MAX_BOARD_CHIPS', () => {
    const { doc, server } = seed((d, sid) => {
      for (let i = 0; i < MAX_BOARD_CHIPS + 2; i++) {
        const bp = createBlueprint(`svc${i}`, i); d.blueprints[bp.id] = bp
        d.placements[`p${i}`] = createPlacement(bp.id, sid)
      }
    })
    renderBoard(doc, server.id)
    expect(screen.getByText(/\+2 more/)).toBeInTheDocument()
  })

  it('header shows specs and rack position', () => {
    seed((d, sid) => { d.servers[sid].rack = { rackId: 'A1', unit: 7, heightU: 1 } })
    render(<ServerView onOpenFirewallRules={() => {}} />)
    expect(screen.getByText(/web-01/)).toBeInTheDocument()
    // "vCPU" now also appears in HardwarePlatform's SUBSTRATE header line (D8) — assert both exist.
    expect(screen.getAllByText(/vCPU/).length).toBeGreaterThan(0)
    expect(screen.getByText(/A1/)).toBeInTheDocument()
    expect(screen.getByText(/U7/)).toBeInTheDocument()
  })
})

describe('ServerBoard — "+ service" ghost chip (2026-07-12)', () => {
  beforeEach(() => {
    useWorldStore.getState().newWorld()
    useSimulationStore.getState().resetSession()
  })

  it('mounts a placement through the inline blueprint picker while stopped', () => {
    const { doc, server } = seed((d) => {
      const bp = createBlueprint('api', 0)
      d.blueprints[bp.id] = bp
    })
    renderBoard(doc, server.id)
    fireEvent.click(screen.getByTestId('board-add-service'))
    const select = screen.getByLabelText('mount a blueprint') as HTMLSelectElement
    const bpId = Object.keys(doc.blueprints)[0]
    fireEvent.change(select, { target: { value: bpId } })
    const placements = Object.values(useWorldStore.getState().doc.placements)
    expect(placements).toHaveLength(1)
    expect(placements[0]).toMatchObject({ blueprintId: bpId, serverId: server.id })
  })

  it('is disabled with no blueprints and hidden while the simulation runs', () => {
    const { doc, server } = seed(() => {})
    const { unmount } = (() => { renderBoard(doc, server.id); return { unmount: () => {} } })()
    const ghost = screen.getByTestId('board-add-service') as HTMLButtonElement
    expect(ghost.disabled).toBe(true)
    expect(ghost.title).toContain('create a blueprint first')
    unmount()
    act(() => { useSimulationStore.setState({ running: true }) })
    expect(screen.queryByTestId('board-add-service')).toBeNull()
  })
})

// FEAT-008 (Task 19 consumer audit): boardLayout draws one chip per `compiled.instances` entry,
// which since Task 11 is an autoscaled placement's full maxCount ENVELOPE. A parked slot publishes
// no metrics (Task 16), so ServiceChip's `health = 'healthy'` default painted it with a green
// health dot and a 0-rps sparkbar — a chip that looks like a running service but isn't one.
describe('ServerBoard — parked autoscale-envelope chips (FEAT-008)', () => {
  beforeEach(() => useWorldStore.getState().newWorld())

  it('marks envelope slots absent from the published batch as parked, and leaves running ones alone', () => {
    const { doc, server } = seed((d, sid) => {
      const bp = createBlueprint('web', 0)
      d.blueprints[bp.id] = bp
      const pl = createPlacement(bp.id, sid)
      pl.count = 1
      pl.autoscale = { minCount: 1, maxCount: 3, targetCpuPercent: 70, scaleUpCooldownSec: 60, scaleDownCooldownSec: 300 }
      d.placements[pl.id] = pl
    })
    const compiled = compileWorld(doc)
    const instances = Object.values(compiled.instances)
    expect(instances).toHaveLength(3)
    const running = instances.find(i => i.indexInPlacement === 0)!

    act(() => {
      useSimulationStore.setState({
        running: true, scrubBatch: null,
        latestBatch: {
          simMs: 1000,
          instances: {
            [running.id]: {
              instanceId: running.id, rps: 50, errorRate: 0, p50Ms: 2, p99Ms: 4, p90Ms: 3,
              activeConnections: 1, cpuCoresUsed: 0.1, ramMb: 64, health: 'healthy',
            },
          },
          servers: {}, azs: {}, regions: {},
        } as unknown as MetricsBatch,
      })
    })

    renderBoard(doc, server.id)
    const chips = Array.from(document.querySelectorAll('[data-chip]')) as HTMLElement[]
    expect(chips).toHaveLength(3)
    const parked = chips.filter(c => c.dataset.parked === 'true')
    expect(parked).toHaveLength(2)
    expect(chips.find(c => c.dataset.instance === running.id)!.dataset.parked).toBe('false')
    for (const c of parked) expect(c.textContent).toContain('parked')
  })
})
