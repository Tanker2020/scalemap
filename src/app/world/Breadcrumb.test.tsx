// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Breadcrumb } from './Breadcrumb'
import { useNavStore } from '../store/nav.store'
import { useWorldStore } from '../store/world.store'
import { getPreset } from '../../lib/world/instanceCatalog'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useNavStore.getState().goGlobe()
})

describe('Breadcrumb', () => {
  it('renders the full lineage at server level and climbs on segment click', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    useNavStore.getState().goServer(regionId, azId, serverId)

    render(<Breadcrumb />)
    expect(screen.getByText('World')).toBeInTheDocument()
    expect(screen.getByText(/us-east-1a/)).toBeInTheDocument()

    fireEvent.click(screen.getByText('us-east-1'))
    expect(useNavStore.getState().level).toBe('region')
  })

  it('renders only World at globe level', () => {
    render(<Breadcrumb />)
    expect(screen.getByText('World')).toBeInTheDocument()
    expect(screen.queryByText('us-east-1')).not.toBeInTheDocument()
  })

  it('shows the active environment label in the breadcrumb when set', () => {
    useWorldStore.setState({ doc: { ...useWorldStore.getState().doc, environments: { s: { id: 's', label: 'Staging' } }, activeEnvironmentId: 's' } })
    render(<Breadcrumb />)
    expect(screen.getByText(/staging/i)).toBeInTheDocument()
  })

  it('does not show an environment chip when no environment is active', () => {
    render(<Breadcrumb />)
    expect(screen.queryByTestId('env-chip')).not.toBeInTheDocument()
  })
})
