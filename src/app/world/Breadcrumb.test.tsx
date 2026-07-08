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
})
