// src/app/world/panels/ManagedServiceModal.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ManagedServiceModal } from './ManagedServiceModal'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useNavStore } from '../../store/nav.store'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useSimulationStore.setState({ running: false })
  useNavStore.setState({ level: 'globe', regionId: null, azId: null, serverId: null })
})

function seedRegionAz() {
  const s = useWorldStore.getState()
  const regionId = s.addRegion('us-east-1')
  const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
  return { regionId, azId }
}

// Fills the two required fields (name + scope) so canSubmit passes for a fresh add-mode draft.
function fillRequiredFields(scopeKey: string) {
  fireEvent.change(screen.getByLabelText('name'), { target: { value: 'orders-db' } })
  fireEvent.change(screen.getByLabelText('scope'), { target: { value: scopeKey } })
}

describe('ManagedServiceModal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<ManagedServiceModal open={false} editingId={null} onClose={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  // Mirrors WorldShell's real bubble-phase Escape handler verbatim (SettingsModal.test.tsx's own
  // proof technique) — bail if defaultPrevented, else nav.up(). Registered on window BEFORE the
  // modal mounts, so a bubble-phase listener here would fire FIRST if registration order (not
  // capture-vs-bubble) were what determined the outcome. Starts at 'region' (not 'globe' — up()
  // is a no-op at the top level, which would make the "level unchanged" assertion pass trivially
  // regardless of which phase wins) so a real regression (bubble instead of capture) is caught:
  // up() from 'region' actually mutates to 'globe' if the handler fires.
  it('Escape closes without changing nav level', () => {
    useNavStore.setState({ level: 'region', regionId: 'r1', azId: null, serverId: null })
    const worldShellLikeHandler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (e.key === 'Escape') useNavStore.getState().up()
    }
    window.addEventListener('keydown', worldShellLikeHandler)
    let closed = false
    try {
      render(<ManagedServiceModal open={true} editingId={null} onClose={() => { closed = true }} />)
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(closed).toBe(true)
      expect(useNavStore.getState().level).toBe('region')
    } finally {
      window.removeEventListener('keydown', worldShellLikeHandler)
    }
  })

  it('backdrop click closes; a click on the surface itself does not', () => {
    let closed = false
    render(<ManagedServiceModal open={true} editingId={null} onClose={() => { closed = true }} />)
    fireEvent.click(screen.getByText('Add managed service'))
    expect(closed).toBe(false)
    // The backdrop is the outer fixed-position div rendered by createPortal; the surface's parent.
    const surface = screen.getByText('Add managed service').closest('div')!.parentElement!
    const backdrop = surface.parentElement!
    fireEvent.click(backdrop)
    expect(closed).toBe(true)
  })

  it('add flow is exactly one undo entry', () => {
    const { regionId } = seedRegionAz()
    render(<ManagedServiceModal open={true} editingId={null} onClose={() => {}} />)
    const historyBefore = useWorldStore.getState().history.length
    fillRequiredFields(`region:${regionId}`)
    fireEvent.click(screen.getByText('Create'))
    expect(Object.values(useWorldStore.getState().doc.managedServices)).toHaveLength(1)
    expect(useWorldStore.getState().history.length).toBe(historyBefore + 1)
    useWorldStore.getState().undo()
    expect(Object.values(useWorldStore.getState().doc.managedServices)).toHaveLength(0)
  })

  it('cancel discards — filled fields never reach the store', () => {
    const { regionId } = seedRegionAz()
    render(<ManagedServiceModal open={true} editingId={null} onClose={() => {}} />)
    fillRequiredFields(`region:${regionId}`)
    fireEvent.click(screen.getByText('Cancel'))
    expect(Object.values(useWorldStore.getState().doc.managedServices)).toHaveLength(0)
  })

  it('edit flow prefills from the existing service and saves exactly one service', () => {
    const { regionId } = seedRegionAz()
    const msId = useWorldStore.getState().addManagedService('dbSql', 'SQL DB', { kind: 'region', regionId }, 5432, 'aws')
    render(<ManagedServiceModal open={true} editingId={msId} onClose={() => {}} />)

    expect(screen.getByLabelText('name')).toHaveValue('SQL DB')
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'Renamed DB' } })
    fireEvent.click(screen.getByText('Save'))

    const services = Object.values(useWorldStore.getState().doc.managedServices)
    expect(services).toHaveLength(1)
    expect(services[0].label).toBe('Renamed DB')
  })

  it('conditional section visibility: dbSql shows DB + storage sections, queue shows neither, objectStorage shows storage only', () => {
    const { regionId } = seedRegionAz()

    const { unmount: unmountDb } = render(<ManagedServiceModal open={true} editingId={null} onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('service type'), { target: { value: 'dbSql' } })
    expect(screen.getByText('▸ REPLICAS & FAILOVER')).toBeInTheDocument()
    expect(screen.getByText('▸ STORAGE')).toBeInTheDocument()
    expect(screen.getByText('▸ PRICING')).toBeInTheDocument()
    expect(screen.getByLabelText('instance class')).toBeInTheDocument()
    unmountDb()

    const { unmount: unmountQueue } = render(<ManagedServiceModal open={true} editingId={null} onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('service type'), { target: { value: 'queue' } })
    expect(screen.queryByText('▸ REPLICAS & FAILOVER')).toBeNull()
    expect(screen.queryByText('▸ STORAGE')).toBeNull()
    expect(screen.queryByText('▸ PRICING')).toBeNull()
    expect(screen.getByLabelText('throughput ceiling')).toBeInTheDocument()
    unmountQueue()

    render(<ManagedServiceModal open={true} editingId={null} onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('service type'), { target: { value: 'objectStorage' } })
    expect(screen.queryByText('▸ REPLICAS & FAILOVER')).toBeNull()
    expect(screen.getByText('▸ STORAGE')).toBeInTheDocument()
    expect(screen.queryByText('▸ PRICING')).toBeNull()

    void regionId // scope not needed for this visibility-only assertion
  })

  it('type switch re-bases the instance class from SQL to a valid NoSQL class', () => {
    render(<ManagedServiceModal open={true} editingId={null} onClose={() => {}} />)
    // Default draft opens on dbSql already; confirm the instance class select is a SQL class first.
    const classSelect = screen.getByLabelText('instance class') as HTMLSelectElement
    expect(classSelect.value.startsWith('sql.')).toBe(true)

    fireEvent.change(screen.getByLabelText('service type'), { target: { value: 'dbNoSql' } })
    const rebasedSelect = screen.getByLabelText('instance class') as HTMLSelectElement
    expect(rebasedSelect.value.startsWith('nosql.')).toBe(true)
  })

  it('serverless disables the commitment term select with the edit-lock-style tooltip', () => {
    render(<ManagedServiceModal open={true} editingId={null} onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('service type'), { target: { value: 'dbSql' } })
    const commitmentSelect = screen.getByLabelText('commitment term')
    expect(commitmentSelect).not.toBeDisabled()

    fireEvent.click(screen.getByText('serverless'))
    expect(commitmentSelect).toBeDisabled()
    expect(commitmentSelect).toHaveAttribute('title', 'serverless has no commitment term')
  })

  it('edit lock reaches into the portal: disables inputs, leaves Cancel enabled, blocks Create', () => {
    const { regionId } = seedRegionAz()
    useSimulationStore.setState({ running: true })
    render(<ManagedServiceModal open={true} editingId={null} onClose={() => {}} />)

    expect(screen.getByLabelText('name')).toBeDisabled()
    expect(screen.getByText('Cancel')).not.toBeDisabled()

    // Even a programmatic click on the (visually locked) Create button must not mutate the store —
    // submit() self-guards on `running` in addition to the disabled attribute.
    fireEvent.click(screen.getByText('Create'))
    expect(Object.values(useWorldStore.getState().doc.managedServices)).toHaveLength(0)

    void regionId
  })

  // Brief's test #11 asks for ONE Create covering all 12 previously-undertested config fields
  // (instanceClassId, replicaCount, multiAz, capacityMode, pricing, maxConnections,
  // queryTimeoutMs, replicaLocality, promotionTier, capacityRps, storageGb, storageTierId) in one
  // toMatchObject. That is not reachable through a single nodeType: draftToConfig (Task 1) gates
  // capacityMode/pricing/maxConnections/queryTimeoutMs/replicaLocality/promotionTier/
  // instanceClassId/replicaCount/multiAz behind `isDb`, gates capacityRps behind `!isDb`, and the
  // commitment-term select is disabled (so unreachable via UI) whenever capacityMode is
  // 'serverless' — a DB draft can never carry both 'serverless' AND a non-default `pricing` at
  // once, and no type is simultaneously DB (for the 9 DB fields) and non-DB (for capacityRps).
  // Split into three focused round-trips instead, covering the same 12 fields with equivalent
  // rigor: (A) a DB flow exercising 8 of the 9 DB fields via 'serverless', (B) a DB flow
  // exercising `pricing` under 'provisioned' (the one field flow A structurally cannot reach),
  // (C) a non-DB storage-capable flow exercising `capacityRps` and `storageTierId`. `storageGb`
  // round-trips in both A and C since dbSql/objectStorage are both storage-capable.
  it('DB round-trip (serverless): 8 of 9 DB fields + storageGb land in the resulting record', () => {
    const { regionId } = seedRegionAz()
    render(<ManagedServiceModal open={true} editingId={null} onClose={() => {}} />)

    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'orders-db' } })
    fireEvent.change(screen.getByLabelText('port'), { target: { value: '5433' } })
    fireEvent.change(screen.getByLabelText('scope'), { target: { value: `region:${regionId}` } })
    fireEvent.click(screen.getByText('GCP'))

    const classSelect = screen.getByLabelText('instance class') as HTMLSelectElement
    const nonDefaultClass = Array.from(classSelect.querySelectorAll('option'))
      .map(o => o.getAttribute('value')!)
      .find(v => v !== classSelect.value)!
    fireEvent.change(classSelect, { target: { value: nonDefaultClass } })

    fireEvent.click(screen.getByText('serverless'))
    fireEvent.change(screen.getByLabelText('max connections'), { target: { value: '250' } })
    fireEvent.change(screen.getByLabelText('query timeout'), { target: { value: '750' } })

    const replicaInput = screen.getByLabelText('read replicas')
    fireEvent.change(replicaInput, { target: { value: '3' } })
    fireEvent.blur(replicaInput)
    fireEvent.change(screen.getByLabelText('replica locality'), { target: { value: 'multiAz' } })
    fireEvent.click(screen.getByLabelText('multi-AZ standby'))
    fireEvent.change(screen.getByLabelText('promotion tier'), { target: { value: '2' } })

    const storageInput = screen.getByLabelText('provisioned GB')
    fireEvent.change(storageInput, { target: { value: '500' } })
    fireEvent.blur(storageInput)

    fireEvent.click(screen.getByText('Create'))

    const services = Object.values(useWorldStore.getState().doc.managedServices)
    expect(services).toHaveLength(1)
    expect(services[0]).toMatchObject({
      nodeType: 'dbSql',
      label: 'orders-db',
      port: 5433,
      provider: 'gcp',
      scope: { kind: 'region', regionId },
      instanceClassId: nonDefaultClass,
      capacityMode: 'serverless',
      maxConnections: 250,
      queryTimeoutMs: 750,
      replicaCount: 3,
      replicaLocality: 'multiAz',
      multiAz: true,
      promotionTier: 2,
      storageGb: 500,
    })
  })

  it('DB round-trip (provisioned): a non-default commitment term lands in the resulting record', () => {
    const { regionId } = seedRegionAz()
    render(<ManagedServiceModal open={true} editingId={null} onClose={() => {}} />)

    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'reserved-db' } })
    fireEvent.change(screen.getByLabelText('scope'), { target: { value: `region:${regionId}` } })
    // capacityMode stays the default 'provisioned', so the commitment select stays enabled.
    fireEvent.change(screen.getByLabelText('commitment term'), { target: { value: 'reserved1yr' } })
    fireEvent.click(screen.getByText('Create'))

    const services = Object.values(useWorldStore.getState().doc.managedServices)
    expect(services).toHaveLength(1)
    expect(services[0]).toMatchObject({ nodeType: 'dbSql', pricing: 'reserved1yr', capacityMode: 'provisioned' })
  })

  it('non-DB storage-capable round-trip: capacityRps and storageTierId land in the resulting record', () => {
    const { regionId } = seedRegionAz()
    render(<ManagedServiceModal open={true} editingId={null} onClose={() => {}} />)

    fireEvent.change(screen.getByLabelText('service type'), { target: { value: 'objectStorage' } })
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'assets-bucket' } })
    fireEvent.change(screen.getByLabelText('scope'), { target: { value: `region:${regionId}` } })
    fireEvent.change(screen.getByLabelText('throughput ceiling'), { target: { value: '1234' } })

    const tierSelect = screen.getByLabelText('storage tier') as HTMLSelectElement
    const nonDefaultTier = Array.from(tierSelect.querySelectorAll('option'))
      .map(o => o.getAttribute('value')!)
      .find(v => v !== tierSelect.value)!
    fireEvent.change(tierSelect, { target: { value: nonDefaultTier } })

    fireEvent.click(screen.getByText('Create'))

    const services = Object.values(useWorldStore.getState().doc.managedServices)
    expect(services).toHaveLength(1)
    expect(services[0]).toMatchObject({
      nodeType: 'objectStorage',
      capacityRps: 1234,
      storageTierId: nonDefaultTier,
    })
  })
})
