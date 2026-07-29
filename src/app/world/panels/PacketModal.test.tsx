// src/app/world/panels/PacketModal.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PacketModal } from './PacketModal'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useNavStore } from '../../store/nav.store'
import { listPackets } from '../../../lib/nodeConfig'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useSimulationStore.setState({ running: false })
  useNavStore.setState({ level: 'globe', regionId: null, azId: null, serverId: null })
})

const packets = () => listPackets(useWorldStore.getState().doc.packets)

describe('PacketModal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<PacketModal open={false} editingId={null} onClose={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  // Same proof technique as ManagedServiceModal.test.tsx: a WorldShell-like BUBBLE-phase handler
  // registered BEFORE the modal mounts. If the modal used bubble too, registration order would
  // let this one fire first and drop the nav level — capture is what prevents that.
  it('Escape closes without changing nav level', () => {
    useNavStore.setState({ level: 'region', regionId: 'r1', azId: null, serverId: null })
    const worldShellLikeHandler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (e.key === 'Escape') useNavStore.getState().up()
    }
    window.addEventListener('keydown', worldShellLikeHandler)
    let closed = false
    try {
      render(<PacketModal open={true} editingId={null} onClose={() => { closed = true }} />)
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(closed).toBe(true)
      expect(useNavStore.getState().level).toBe('region')
    } finally {
      window.removeEventListener('keydown', worldShellLikeHandler)
    }
  })

  it('creates a packet with NO path, so it lands in the packet view and not the route view', () => {
    render(<PacketModal open={true} editingId={null} onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'thumb-upload' } })
    fireEvent.change(screen.getByLabelText('request size'), { target: { value: '2048' } })
    fireEvent.change(screen.getByLabelText('response size'), { target: { value: '1' } })
    fireEvent.click(screen.getByText('Create'))

    const [p] = packets()
    expect(p).toMatchObject({ name: 'thumb-upload', protocol: 'http', sizeKb: 2048, responseSizeKb: 1 })
    expect(p).not.toHaveProperty('path')
  })

  it('the add flow is exactly one undo entry', () => {
    render(<PacketModal open={true} editingId={null} onClose={() => {}} />)
    const before = useWorldStore.getState().history.length
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'p' } })
    fireEvent.change(screen.getByLabelText('request size'), { target: { value: '9' } })
    fireEvent.click(screen.getByText('Create'))
    expect(useWorldStore.getState().history.length).toBe(before + 1)
  })

  it('switching protocol swaps the kind-specific section and strands no fields', () => {
    render(<PacketModal open={true} editingId={null} onClose={() => {}} />)
    expect(screen.getByLabelText('method')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'DB' }))
    expect(screen.queryByLabelText('method')).toBeNull()
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'q' } })
    fireEvent.change(screen.getByLabelText('query type'), { target: { value: 'write' } })
    fireEvent.change(screen.getByLabelText('result size'), { target: { value: '512' } })
    fireEvent.click(screen.getByLabelText('write-ahead logging'))
    fireEvent.click(screen.getByText('Create'))

    const [p] = packets()
    expect(p).toMatchObject({ protocol: 'db', queryType: 'write', isWAL: true, resultSizeKb: 512 })
    expect(p).not.toHaveProperty('method')
  })

  it('event and stream packets carry their own fields', () => {
    render(<PacketModal open={true} editingId={null} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Event' }))
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'order-placed' } })
    fireEvent.change(screen.getByLabelText('topic'), { target: { value: 'orders' } })
    fireEvent.change(screen.getByLabelText('delivery mode'), { target: { value: 'exactly-once' } })
    fireEvent.click(screen.getByText('Create'))
    expect(packets()[0]).toMatchObject({ protocol: 'event', topic: 'orders', deliveryMode: 'exactly-once' })
  })

  it('edit mode loads the existing packet and saves in place', () => {
    const id = useWorldStore.getState().addPacket({
      name: 'q', protocol: 'db', sizeKb: 1, queryType: 'read', isWAL: false, resultSizeKb: 64,
    })
    render(<PacketModal open={true} editingId={id} onClose={() => {}} />)
    expect((screen.getByLabelText('name') as HTMLInputElement).value).toBe('q')
    expect((screen.getByLabelText('result size') as HTMLInputElement).value).toBe('64')

    fireEvent.change(screen.getByLabelText('result size'), { target: { value: '1024' } })
    fireEvent.click(screen.getByText('Save'))
    expect(packets()).toHaveLength(1)
    expect(packets()[0]).toMatchObject({ id, resultSizeKb: 1024 })
  })

  it('a blank name cannot be submitted', () => {
    render(<PacketModal open={true} editingId={null} onClose={() => {}} />)
    fireEvent.click(screen.getByText('Create'))
    expect(packets()).toHaveLength(0)
  })

  it('is edit-locked while the simulation runs (its own fieldset — the portal escapes the dock\'s)', () => {
    useSimulationStore.setState({ running: true })
    render(<PacketModal open={true} editingId={null} onClose={() => {}} />)
    // toBeDisabled() walks the fieldset ancestry — the `disabled` PROPERTY on a control inside a
    // disabled fieldset is still false, which is exactly the trap this modal's own fieldset exists
    // to avoid mis-testing.
    expect(screen.getByLabelText('name')).toBeDisabled()
    expect(screen.getByText('Create')).toBeDisabled()
    // ...but there is always a way out
    expect(screen.getByText('Cancel')).not.toBeDisabled()
    // and even a programmatic click can't mutate the store — submit() self-guards on `running`
    fireEvent.click(screen.getByText('Create'))
    expect(packets()).toHaveLength(0)
  })

  it('the color override is optional — "auto" clears it rather than storing an empty string', () => {
    render(<PacketModal open={true} editingId={null} onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'p' } })
    fireEvent.change(screen.getByLabelText('color'), { target: { value: '#ff0000' } })
    fireEvent.click(screen.getByLabelText('clear color'))
    fireEvent.click(screen.getByText('Create'))
    expect(packets()[0]).not.toHaveProperty('colorOverride')
  })
})
