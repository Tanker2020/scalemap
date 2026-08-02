// @vitest-environment jsdom
// FEAT-002 Task 14: component test for the partition-authoring surface. Covers the edit-lock
// INVERSE (enabled only while running, per ChaosControl's CHAOS_LOCKED_TITLE convention),
// authoring a partition via setPartition, and healing one via healPartition(index).
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PartitionsSection } from './PartitionsSection'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { CHAOS_LOCKED_TITLE } from '../dock/ChaosControl'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useSimulationStore.getState().resetSession()
})

describe('PartitionsSection', () => {
  it('form is disabled when not running, with the standardized chaos tooltip', () => {
    render(<PartitionsSection />)
    const addBtn = screen.getByRole('button', { name: /add partition/i })
    expect(addBtn).toBeDisabled()
    expect(addBtn).toHaveAttribute('title', CHAOS_LOCKED_TITLE)
    expect(screen.getByLabelText('partition-from-id')).toBeDisabled()
  })

  it('Add partition calls setPartition with the authored fault', () => {
    const regionA = useWorldStore.getState().addRegion('us-east-1')
    const regionB = useWorldStore.getState().addRegion('eu-west-1')
    useSimulationStore.setState({ running: true })
    render(<PartitionsSection />)

    fireEvent.change(screen.getByLabelText('partition-from-id'), { target: { value: regionA } })
    fireEvent.change(screen.getByLabelText('partition-to-id'), { target: { value: regionB } })
    fireEvent.click(screen.getByRole('button', { name: /add partition/i }))

    expect(useSimulationStore.getState().partitions).toEqual([
      { from: { kind: 'region', id: regionA }, to: { kind: 'region', id: regionB }, mode: 'drop', symmetric: true },
    ])
  })

  it('Heal calls healPartition with the correct index', () => {
    const regionA = useWorldStore.getState().addRegion('us-east-1')
    const regionB = useWorldStore.getState().addRegion('eu-west-1')
    useSimulationStore.setState({ running: true })
    useSimulationStore.getState().setPartition({
      from: { kind: 'region', id: regionA }, to: { kind: 'region', id: regionB }, mode: 'drop', symmetric: true,
    })
    render(<PartitionsSection />)

    expect(screen.getAllByTestId('partition-row')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'heal-partition-0' }))
    expect(useSimulationStore.getState().partitions).toEqual([])
  })

  it('the add button stays disabled until both endpoints are chosen', () => {
    useWorldStore.getState().addRegion('us-east-1')
    useSimulationStore.setState({ running: true })
    render(<PartitionsSection />)
    expect(screen.getByRole('button', { name: /add partition/i })).toBeDisabled()
  })
})
