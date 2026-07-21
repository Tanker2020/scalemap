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
  it('adds a managed service scoped to a region with the aws provider default', () => {
    seedRegionAz()
    render(<ManagedPanel />)
    const scopeSelect = screen.getByLabelText('managed scope')
    fireEvent.change(scopeSelect, { target: { value: scopeSelect.querySelectorAll('option')[1].getAttribute('value') } })
    fireEvent.click(screen.getByText('+ Add'))
    const ms = Object.values(useWorldStore.getState().doc.managedServices)
    expect(ms).toHaveLength(1)
    expect(ms[0].provider).toBe('aws')
    // The default type is the first MANAGED_TYPES entry — a cloud SQL DB.
    expect(ms[0].nodeType).toBe('dbSql')
  })

  it('remove dispatches removeManagedService', () => {
    const { regionId } = seedRegionAz()
    useWorldStore.getState().addManagedService('redis', 'Redis', { kind: 'region', regionId }, 6379, 'aws')
    render(<ManagedPanel />)
    fireEvent.click(screen.getByText('×'))
    expect(Object.values(useWorldStore.getState().doc.managedServices)).toHaveLength(0)
  })

  it('a cloud DB exposes the instance-class + replica pickers that drive the write ceiling', () => {
    const { regionId } = seedRegionAz()
    const msId = useWorldStore.getState().addManagedService('dbSql', 'SQL DB', { kind: 'region', regionId }, 5432, 'aws')
    render(<ManagedPanel />)
    const classSelect = screen.getByLabelText(`db-class-${msId}`)
    const firstClass = classSelect.querySelectorAll('option')[0].getAttribute('value')!
    fireEvent.change(classSelect, { target: { value: firstClass } })
    expect(useWorldStore.getState().doc.managedServices[msId].instanceClassId).toBe(firstClass)
    fireEvent.change(screen.getByLabelText(`db-replicas-${msId}`), { target: { value: '3' } })
    expect(useWorldStore.getState().doc.managedServices[msId].replicaCount).toBe(3)
  })

  it('a cloud DB exposes the multi-AZ standby toggle (Phase 5.3)', () => {
    const { regionId } = seedRegionAz()
    const msId = useWorldStore.getState().addManagedService('dbSql', 'SQL DB', { kind: 'region', regionId }, 5432, 'aws')
    render(<ManagedPanel />)
    fireEvent.click(screen.getByLabelText(`db-multiaz-${msId}`))
    expect(useWorldStore.getState().doc.managedServices[msId].multiAz).toBe(true)
  })

  it('a non-DB managed service shows no instance-class picker', () => {
    const { regionId } = seedRegionAz()
    const msId = useWorldStore.getState().addManagedService('objectStorage', 'Object store', { kind: 'region', regionId }, 443, 'aws')
    render(<ManagedPanel />)
    expect(screen.queryByLabelText(`db-class-${msId}`)).toBeNull()
  })
})
