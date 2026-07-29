// src/app/world/panels/BlueprintModal.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BlueprintModal } from './BlueprintModal'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useNavStore } from '../../store/nav.store'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useSimulationStore.setState({ running: false })
  useNavStore.setState({ level: 'globe', regionId: null, azId: null, serverId: null })
})

const seedBlueprint = (name = 'api') => useWorldStore.getState().addBlueprint(name)
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

  it('db kinds reveal the storage section and write a dbConfig; non-db kinds clear it', () => {
    const id = seedBlueprint()
    render(<BlueprintModal open={true} editingId={id} onClose={() => {}} onOpenConnections={() => {}} />)
    expect(screen.queryByLabelText('storage gb')).toBeNull()

    fireEvent.change(screen.getByLabelText('kind'), { target: { value: 'db-sql' } })
    fireEvent.change(screen.getByLabelText('storage gb'), { target: { value: '250' } })
    fireEvent.click(screen.getByText('Save'))
    expect(bp(id).dbConfig).toEqual({ engine: 'sql', storageGb: 250 })
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

  it('is edit-locked while the simulation runs, but Cancel still works', () => {
    const id = seedBlueprint()
    useSimulationStore.setState({ running: true })
    render(<BlueprintModal open={true} editingId={id} onClose={() => {}} onOpenConnections={() => {}} />)
    expect(screen.getByLabelText('name')).toBeDisabled()
    expect(screen.getByText('Save')).toBeDisabled()
    expect(screen.getByText('Cancel')).not.toBeDisabled()
  })
})
