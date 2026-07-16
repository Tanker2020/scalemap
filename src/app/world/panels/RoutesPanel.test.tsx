// @vitest-environment jsdom
// Route catalog authoring (Phase 2). RoutesPanel writes through world.store's addRoute/updateRoute/
// removeRoute (undo/dirty), storing HttpTemplates in doc.packets.
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RoutesPanel } from './RoutesPanel'
import { useWorldStore } from '../../store/world.store'
import { listRoutes } from '../../../lib/nodeConfig'

beforeEach(() => useWorldStore.getState().newWorld())

describe('RoutesPanel', () => {
  it('adds a route from the new-route form into doc.packets', () => {
    render(<RoutesPanel />)
    fireEvent.change(screen.getByLabelText('new-route-name'), { target: { value: 'api' } })
    fireEvent.change(screen.getByLabelText('new-route-path'), { target: { value: '/api/*' } })
    fireEvent.change(screen.getByLabelText('new-route-method'), { target: { value: 'POST' } })
    fireEvent.click(screen.getByText('+ Route'))
    const routes = listRoutes(useWorldStore.getState().doc.packets)
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ name: 'api', path: '/api/*', method: 'POST', protocol: 'http' })
  })

  it('the add button is disabled until name and path are both non-empty', () => {
    render(<RoutesPanel />)
    expect(screen.getByText('+ Route')).toBeDisabled()
    fireEvent.change(screen.getByLabelText('new-route-name'), { target: { value: 'api' } })
    // path starts as '/', so it's already non-empty — clear it to re-disable
    fireEvent.change(screen.getByLabelText('new-route-path'), { target: { value: '' } })
    expect(screen.getByText('+ Route')).toBeDisabled()
    fireEvent.change(screen.getByLabelText('new-route-path'), { target: { value: '/x' } })
    expect(screen.getByText('+ Route')).not.toBeDisabled()
  })

  it('edits and removes an existing route', () => {
    const id = useWorldStore.getState().addRoute({ name: 'api', method: 'GET', path: '/api' })
    render(<RoutesPanel />)
    fireEvent.change(screen.getByLabelText(`route-path-${id}`), { target: { value: '/v2/*' } })
    expect(listRoutes(useWorldStore.getState().doc.packets)[0].path).toBe('/v2/*')
    fireEvent.click(screen.getByLabelText(`remove-route-${id}`))
    expect(listRoutes(useWorldStore.getState().doc.packets)).toHaveLength(0)
  })

  it('shows a usage count for routes referenced by a population request mix', () => {
    const id = useWorldStore.getState().addRoute({ name: 'api', method: 'GET', path: '/api' })
    const popId = useWorldStore.getState().addPopulation('nyc', 40, -74)
    useWorldStore.getState().updatePopulation(popId, { requestMix: [{ routeId: id, weight: 1 }] })
    render(<RoutesPanel />)
    expect(screen.getByText('1 pop')).toBeInTheDocument()
  })
})
