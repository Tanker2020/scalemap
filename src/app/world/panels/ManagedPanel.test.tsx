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
    // Regression guard: EdgeRow's onClick (row-level, opens the editor) sits on the same outer
    // container that renders `trailing` — without stopPropagation() on the × button, this click
    // would bubble up and open the editor for the service the same click just deleted.
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
})
