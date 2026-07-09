// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CostTab } from './CostTab'
import { useWorldStore } from '../store/world.store'
import { useSimulationStore } from '../store/simulation.store'
import { getPreset } from '../../lib/world/instanceCatalog'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useSimulationStore.setState({ latestBatch: null, scrubBatch: null })
})

describe('CostTab', () => {
  it('renders exact monthly math for a server-only world', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)   // 0.036 usd/hr
    render(<CostTab />)
    expect(screen.getByText('$26.28 /mo')).toBeInTheDocument()   // 0.036 * 730
  })

  it('shows a zero-state before any regions exist', () => {
    render(<CostTab />)
    expect(screen.getByText('$0.00 /mo')).toBeInTheDocument()
    expect(screen.getByText('no regions yet')).toBeInTheDocument()
  })
})
