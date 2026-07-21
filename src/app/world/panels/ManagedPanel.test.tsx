// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ManagedPanel } from './ManagedPanel'
import { useWorldStore } from '../../store/world.store'

beforeEach(() => useWorldStore.getState().newWorld())

function seedRegionAz() {
  const s = useWorldStore.getState()
  const regionId = s.addRegion('us-east-1')
  const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
  return { regionId, azId }
}

describe('ManagedPanel', () => {
  // managed-service-modal Task 4: the old inline "+ Add" 3-select row is gone — "+ add service"
  // opens ManagedServiceModal in add mode (editingId: null) instead.
  it('"+ add service" opens the modal in add mode', () => {
    seedRegionAz()
    render(<ManagedPanel />)
    expect(screen.queryByText('Add managed service')).toBeNull()
    fireEvent.click(screen.getByText('+ add service'))
    expect(screen.getByText('Add managed service')).toBeInTheDocument()
  })

  it('remove dispatches removeManagedService, and does not also open the editor', () => {
    const { regionId } = seedRegionAz()
    useWorldStore.getState().addManagedService('redis', 'Redis', { kind: 'region', regionId }, 6379, 'aws')
    render(<ManagedPanel />)
    fireEvent.click(screen.getByText('×'))
    expect(Object.values(useWorldStore.getState().doc.managedServices)).toHaveLength(0)
    // Regression guard: the row itself has no onClick (final-review fix — only the explicit
    // `edit` button opens the editor), and the `×` button's stopPropagation() is retained
    // defensively — either way, removing a service must never also open its editor.
    expect(screen.queryByText('Edit managed service')).toBeNull()
    expect(screen.queryByText('Add managed service')).toBeNull()
  })

  it('a cloud DB row summarizes instance class, replica count, multi-AZ, and capacity mode', () => {
    const { regionId } = seedRegionAz()
    const msId = useWorldStore.getState().addManagedService('dbSql', 'SQL DB', { kind: 'region', regionId }, 5432, 'aws')
    useWorldStore.getState().updateManagedService(msId, {
      instanceClassId: 'sql.small', replicaCount: 3, multiAz: true, capacityMode: 'serverless',
    })
    render(<ManagedPanel />)
    const summary = screen.getByTestId(`ms-summary-${msId}`)
    expect(summary.textContent).toContain('3 replicas')
    expect(summary.textContent).toContain('multi-AZ')
    expect(summary.textContent).toContain('serverless')
  })

  it('a non-DB managed service row summarizes the effective rps ceiling instead of a class picker', () => {
    const { regionId } = seedRegionAz()
    const msId = useWorldStore.getState().addManagedService('objectStorage', 'Object store', { kind: 'region', regionId }, 443, 'aws')
    useWorldStore.getState().updateManagedService(msId, { capacityRps: 777 })
    render(<ManagedPanel />)
    const summary = screen.getByTestId(`ms-summary-${msId}`)
    expect(summary.textContent).toContain('777 rps')
    expect(screen.queryByLabelText(`db-class-${msId}`)).toBeNull()
  })

  it('a row\'s edit button opens the editor prefilled for that service', () => {
    const { regionId } = seedRegionAz()
    const msId = useWorldStore.getState().addManagedService('dbSql', 'SQL DB', { kind: 'region', regionId }, 5432, 'aws')
    render(<ManagedPanel />)
    fireEvent.click(screen.getByLabelText(`edit-${msId}`))
    expect(screen.getByText('Edit managed service')).toBeInTheDocument()
    expect(screen.getByLabelText('name')).toHaveValue('SQL DB')
  })

  // End-to-end regression test (final whole-branch review, "Important" finding): no prior test
  // exercised the FULL add → edit → nodeType-switch chain through the real mounted panel+modal
  // pair as they run in production (ManagedPanel mounts ManagedServiceModal itself — see
  // ManagedPanel.tsx). This is also the direct regression guard for the Critical fix in
  // managedDraft.ts's draftToConfig: editing an existing DB service to a non-DB type must not
  // leave a stale instanceClassId/capacityMode behind (world.store.ts's updateManagedService
  // merges via `{ ...existing, ...patch, id }`, which only clears keys draftToConfig actually
  // assigns — even to `undefined`).
  it('full add → edit chain: creating a dbSql service then switching it to queue clears DB-specific summary + store fields', () => {
    const { regionId } = seedRegionAz()
    render(<ManagedPanel />)

    // 1. Open the add modal.
    fireEvent.click(screen.getByText('+ add service'))
    expect(screen.getByText('Add managed service')).toBeInTheDocument()

    // 2. Fill the modal for a dbSql service with a real instance class selected, then Create.
    //    defaultManagedDraft() already opens on dbSql (MANAGED_TYPES[0]) with a real
    //    engine-derived instanceClassId, so no explicit "service type" change is needed here —
    //    just confirm it really is a SQL class before proceeding.
    const classSelect = screen.getByLabelText('instance class') as HTMLSelectElement
    expect(classSelect.value.startsWith('sql.')).toBe(true)
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'orders-db' } })
    fireEvent.change(screen.getByLabelText('scope'), { target: { value: `region:${regionId}` } })
    fireEvent.click(screen.getByText('Create'))

    const created = Object.values(useWorldStore.getState().doc.managedServices)
    expect(created).toHaveLength(1)
    const msId = created[0].id
    expect(created[0]).toMatchObject({ nodeType: 'dbSql', instanceClassId: classSelect.value })

    // 3. Assert the panel row's summary now reflects the created DB service.
    let summary = screen.getByTestId(`ms-summary-${msId}`)
    expect(summary.textContent).toContain('provisioned')
    expect(summary.textContent).not.toContain('rps')

    // 4. Click that row's edit button, switch service type to a non-DB type (queue), Save.
    fireEvent.click(screen.getByLabelText(`edit-${msId}`))
    expect(screen.getByText('Edit managed service')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('service type'), { target: { value: 'queue' } })
    fireEvent.click(screen.getByText('Save'))

    // 5. The row's summary no longer shows DB-specific info (no instance class label, no
    //    "provisioned"/"replica" text — instead an rps-ceiling summary), and the underlying store
    //    record genuinely has no stale instanceClassId/capacityMode left over from the DB phase.
    expect(Object.values(useWorldStore.getState().doc.managedServices)).toHaveLength(1)
    summary = screen.getByTestId(`ms-summary-${msId}`)
    expect(summary.textContent).not.toContain('provisioned')
    expect(summary.textContent).not.toContain('replica')
    expect(summary.textContent).toContain('rps')

    const updated = useWorldStore.getState().doc.managedServices[msId]
    expect(updated.nodeType).toBe('queue')
    expect(updated.instanceClassId).toBeUndefined()
    expect(updated.capacityMode).toBeUndefined()
    expect(updated.replicaCount).toBeUndefined()
    expect(updated.multiAz).toBeUndefined()
  })
})
