// src/app/world/panels/BlueprintModal.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BlueprintModal } from './BlueprintModal'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useNavStore } from '../../store/nav.store'
import { getPreset } from '../../../lib/world/instanceCatalog'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useSimulationStore.setState({ running: false })
  useNavStore.setState({ level: 'globe', regionId: null, azId: null, serverId: null })
})

const seedBlueprint = (name = 'api') => useWorldStore.getState().addBlueprint(name)
// A database box's own service — the only way a SQL/NoSQL blueprint is born (placementRules.ts).
const seedDbBox = (presetId: 'db-sql-small' | 'db-nosql-small' = 'db-sql-small') => {
  const s = useWorldStore.getState()
  const regionId = s.addRegion('us-east-1')
  const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
  return useWorldStore.getState().addDbServer(azId, getPreset(presetId)!, 'orders-db').blueprintId
}
const bp = (id: string) => useWorldStore.getState().doc.blueprints[id]

describe('BlueprintModal', () => {
  it('renders nothing when closed', () => {
    const id = seedBlueprint()
    const { container } = render(
      <BlueprintModal open={false} editingId={id} onClose={() => {}} onOpenConnections={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('Escape closes without changing nav level', () => {
    const id = seedBlueprint()
    useNavStore.setState({ level: 'region', regionId: 'r1', azId: null, serverId: null })
    const worldShellLikeHandler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (e.key === 'Escape') useNavStore.getState().up()
    }
    window.addEventListener('keydown', worldShellLikeHandler)
    let closed = false
    try {
      render(<BlueprintModal open={true} editingId={id} onClose={() => { closed = true }} onOpenConnections={() => {}} />)
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(closed).toBe(true)
      expect(useNavStore.getState().level).toBe('region')
    } finally {
      window.removeEventListener('keydown', worldShellLikeHandler)
    }
  })

  it('loads the blueprint and saves identity + workload edits in one undo entry', () => {
    const id = seedBlueprint('api')
    render(<BlueprintModal open={true} editingId={id} onClose={() => {}} onOpenConnections={() => {}} />)
    expect((screen.getByLabelText('name') as HTMLInputElement).value).toBe('api')

    const before = useWorldStore.getState().history.length
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'orders-api' } })
    fireEvent.change(screen.getByLabelText('cpu per request'), { target: { value: '25' } })
    fireEvent.change(screen.getByLabelText('cpu per kb'), { target: { value: '0.4' } })
    fireEvent.click(screen.getByText('Save'))

    expect(bp(id).name).toBe('orders-api')
    expect(bp(id).workload.cpuMsPerRequest).toBe(25)
    expect(bp(id).workload.cpuMsPerKb).toBe(0.4)
    expect(useWorldStore.getState().history.length).toBe(before + 1)
  })

  it('leaves the additive workload fields UNDEFINED when blank rather than writing 0', () => {
    const id = seedBlueprint()
    render(<BlueprintModal open={true} editingId={id} onClose={() => {}} onOpenConnections={() => {}} />)
    fireEvent.change(screen.getByLabelText('cpu shares'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('cpu per kb'), { target: { value: '' } })
    fireEvent.click(screen.getByText('Save'))
    expect(bp(id).workload.cpuShares).toBeUndefined()
    expect(bp(id).workload.cpuMsPerKb).toBeUndefined()
  })

  it('a database box\'s own service shows the storage section, locked to its engine', () => {
    const id = seedDbBox()
    render(<BlueprintModal open={true} editingId={id} onClose={() => {}} onOpenConnections={() => {}} />)
    const kind = screen.getByLabelText('kind') as HTMLSelectElement
    expect(kind).toBeDisabled()
    expect(Array.from(kind.options).map(o => o.value)).toEqual(['db-sql'])
    fireEvent.change(screen.getByLabelText('storage gb'), { target: { value: '250' } })
    fireEvent.click(screen.getByText('Save'))
    expect(bp(id).kind).toBe('db-sql')
    expect(bp(id).dbConfig).toEqual({ engine: 'sql', storageGb: 250, replicationMode: 'async' })
  })

  it('a free service cannot be turned into a database', () => {
    const id = seedBlueprint()
    render(<BlueprintModal open={true} editingId={id} onClose={() => {}} onOpenConnections={() => {}} />)
    const kind = screen.getByLabelText('kind') as HTMLSelectElement
    expect(kind).not.toBeDisabled()
    expect(Array.from(kind.options).map(o => o.value)).toEqual(['api', 'worker', 'cache', 'proxy'])
    expect(screen.queryByLabelText('storage gb')).toBeNull()
  })

  it('marking it stateful defaults the volume name off the service name', () => {
    const id = seedBlueprint('cart')
    render(<BlueprintModal open={true} editingId={id} onClose={() => {}} onOpenConnections={() => {}} />)
    fireEvent.click(screen.getByLabelText('stateful'))
    fireEvent.click(screen.getByText('Save'))
    expect(bp(id).stateful).toBe(true)
    expect(bp(id).volumeName).toBe('cart-data')
  })

  it('dependencies are read-only — the count is shown and the graph is the way to edit them', () => {
    const id = seedBlueprint('web')
    const target = seedBlueprint('db')
    useWorldStore.getState().connectServices(id, { kind: 'blueprint', blueprintId: target },
      { port: 5432, protocol: 'db', autoProvision: false })

    let opened = false
    render(<BlueprintModal open={true} editingId={id} onClose={() => {}} onOpenConnections={() => { opened = true }} />)
    expect(screen.getByText('▸ CONNECTIONS (1)')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('open connections graph'))
    expect(opened).toBe(true)
  })

  it('cache kind reveals the cache section and writes a cacheConfig; other kinds clear it', () => {
    const id = seedBlueprint()
    const { unmount } = render(<BlueprintModal open={true} editingId={id} onClose={() => {}} onOpenConnections={() => {}} />)
    expect(screen.queryByLabelText('cache hit ratio')).toBeNull()

    fireEvent.change(screen.getByLabelText('kind'), { target: { value: 'cache' } })
    fireEvent.change(screen.getByLabelText('cache hit ratio'), { target: { value: '0.95' } })
    fireEvent.change(screen.getByLabelText('cache warmup seconds'), { target: { value: '45' } })
    fireEvent.change(screen.getByLabelText('cache ttl seconds'), { target: { value: '600' } })
    fireEvent.click(screen.getByText('Save'))
    expect(bp(id).cacheConfig).toEqual({ hitRatio: 0.95, warmupSec: 45, ttlSec: 600 })
    unmount()

    // Switching away from 'cache' clears the config rather than leaving a stale value behind.
    render(<BlueprintModal open={true} editingId={id} onClose={() => {}} onOpenConnections={() => {}} />)
    fireEvent.change(screen.getByLabelText('kind'), { target: { value: 'api' } })
    fireEvent.click(screen.getByText('Save'))
    expect(bp(id).cacheConfig).toBeUndefined()
  })

  it('cache hit ratio clamps to [0,1]', () => {
    const id = seedBlueprint()
    render(<BlueprintModal open={true} editingId={id} onClose={() => {}} onOpenConnections={() => {}} />)
    fireEvent.change(screen.getByLabelText('kind'), { target: { value: 'cache' } })
    fireEvent.change(screen.getByLabelText('cache hit ratio'), { target: { value: '1.5' } })
    fireEvent.click(screen.getByText('Save'))
    expect(bp(id).cacheConfig?.hitRatio).toBe(1)
  })

  it('FEAT-005: authors replicationMode/applyRatePerReplica/rpoTargetSec/hotKeyCount on a db kind', () => {
    const id = seedDbBox()
    render(<BlueprintModal open={true} editingId={id} onClose={() => {}} onOpenConnections={() => {}} />)
    fireEvent.click(screen.getByText('semi-sync'))
    fireEvent.change(screen.getByLabelText('apply rate per replica'), { target: { value: '500' } })
    fireEvent.change(screen.getByLabelText('rpo target seconds'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('hot key count'), { target: { value: '2000' } })
    fireEvent.click(screen.getByText('Save'))

    expect(bp(id).dbConfig).toEqual({
      engine: 'sql', storageGb: 400, replicationMode: 'semi-sync',
      applyRatePerReplica: 500, rpoTargetSec: 2, hotKeyCount: 2000,
    })
  })

  it('FEAT-005: leaves applyRatePerReplica/rpoTargetSec/hotKeyCount UNDEFINED when blank rather than writing 0', () => {
    const id = seedDbBox()
    render(<BlueprintModal open={true} editingId={id} onClose={() => {}} onOpenConnections={() => {}} />)
    fireEvent.click(screen.getByText('Save'))
    expect(bp(id).dbConfig).toEqual({ engine: 'sql', storageGb: 400, replicationMode: 'async' })
  })

  it('is edit-locked while the simulation runs, but Cancel still works', () => {
    const id = seedBlueprint()
    useSimulationStore.setState({ running: true })
    render(<BlueprintModal open={true} editingId={id} onClose={() => {}} onOpenConnections={() => {}} />)
    expect(screen.getByLabelText('name')).toBeDisabled()
    expect(screen.getByText('Save')).toBeDisabled()
    expect(screen.getByText('Cancel')).not.toBeDisabled()
  })

  it('authors caller-side same-AZ preference, writing nothing when off', () => {
    const id = seedBlueprint()
    const { unmount } = render(<BlueprintModal open={true} editingId={id} onClose={() => {}} onOpenConnections={() => {}} />)
    fireEvent.click(screen.getByLabelText('prefer same-AZ for outgoing calls'))
    fireEvent.click(screen.getByText('Save'))
    expect(bp(id).preferLocalAz).toBe(true)
    unmount()
    render(<BlueprintModal open={true} editingId={id} onClose={() => {}} onOpenConnections={() => {}} />)
    fireEvent.click(screen.getByLabelText('prefer same-AZ for outgoing calls'))
    fireEvent.click(screen.getByText('Save'))
    expect(bp(id).preferLocalAz).toBeUndefined()
  })
})
