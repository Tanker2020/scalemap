// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ProxyConfigSection } from './ProxyConfigSection'
import { EditServiceForm } from './EditServiceForm'
import { useWorldStore } from '../../../store/world.store'
import { defaultProxyConfig } from '../../../../lib/world/factories'
import type { BlueprintDependency } from '../../../../lib/world/types'

beforeEach(() => useWorldStore.getState().newWorld())

const http = (id: string, to: string): BlueprintDependency =>
  ({ id, target: { kind: 'blueprint', blueprintId: to }, port: 8080, protocol: 'http', packetTemplateId: null })

function seedProxy(withUpstreams = true): string {
  const s = useWorldStore.getState()
  const px = s.addBlueprint('edge')
  const web = s.addBlueprint('web')
  const api = s.addBlueprint('api')
  useWorldStore.getState().updateBlueprint(px, {
    kind: 'proxy', proxyConfig: defaultProxyConfig(),
    dependencies: withUpstreams ? [http('d-web', web), http('d-api', api)] : [],
  })
  return px
}
const cfg = (id: string) => useWorldStore.getState().doc.blueprints[id].proxyConfig!

describe('ProxyConfigSection', () => {
  it('renders nothing for a non-proxy blueprint, and is mounted by EditServiceForm for a proxy', () => {
    const api = useWorldStore.getState().addBlueprint('api')
    const { container } = render(<ProxyConfigSection blueprintId={api} running={false} />)
    expect(container.innerHTML).toBe('')
    const px = seedProxy()
    render(<EditServiceForm blueprintId={px} running={false} onDone={() => {}} />)
    expect(screen.getByTestId('proxy-config')).toBeInTheDocument()
  })

  it('points at the Connections graph when the proxy has no upstreams', () => {
    render(<ProxyConfigSection blueprintId={seedProxy(false)} running={false} />)
    expect(screen.getByText(/connect this proxy to the services it fronts/i)).toBeInTheDocument()
  })

  it('L4: edits a weight and shows the resulting share', () => {
    const px = seedProxy()
    render(<ProxyConfigSection blueprintId={px} running={false} />)
    expect(screen.getAllByText('50%')).toHaveLength(2)
    fireEvent.change(screen.getByLabelText('weight web :8080'), { target: { value: '3' } })
    expect(cfg(px).upstreamWeights).toEqual({ 'd-web': 3 })
    expect(screen.getByText('75%')).toBeInTheDocument()
    expect(screen.getByText('25%')).toBeInTheDocument()
  })

  it('L7: adds, edits, reorders and removes rules, and can choose a 503 default', () => {
    const px = seedProxy()
    render(<ProxyConfigSection blueprintId={px} running={false} />)
    fireEvent.change(screen.getByLabelText('proxy mode'), { target: { value: 'l7' } })
    expect(cfg(px).mode).toBe('l7')

    fireEvent.click(screen.getByLabelText('add rule'))
    fireEvent.click(screen.getByLabelText('add rule'))
    fireEvent.change(screen.getByLabelText('rule 1 path'), { target: { value: '/api/*' } })
    fireEvent.change(screen.getByLabelText('rule 1 upstream'), { target: { value: 'd-api' } })
    expect(cfg(px).listenerRules[0]).toMatchObject({ pathPattern: '/api/*', dependencyId: 'd-api' })

    fireEvent.click(screen.getByLabelText('move rule 2 up'))
    expect(cfg(px).listenerRules[1]).toMatchObject({ pathPattern: '/api/*' })
    fireEvent.click(screen.getByLabelText('remove rule 1'))
    expect(cfg(px).listenerRules).toHaveLength(1)

    fireEvent.change(screen.getByLabelText('default upstream'), { target: { value: 'd-web' } })
    expect(cfg(px).defaultDependencyId).toBe('d-web')
    fireEvent.change(screen.getByLabelText('default upstream'), { target: { value: '' } })
    expect(cfg(px).defaultDependencyId).toBeNull()
  })

  it('toggles zone-aware routing', () => {
    const px = seedProxy()
    render(<ProxyConfigSection blueprintId={px} running={false} />)
    fireEvent.click(screen.getByLabelText('prefer same-AZ upstreams'))
    expect(cfg(px).preferLocalAz).toBe(false)
  })

  it('is edit-locked while the simulation runs', () => {
    render(<ProxyConfigSection blueprintId={seedProxy()} running />)
    expect(screen.getByLabelText('proxy mode')).toBeDisabled()
    expect(screen.getByLabelText('prefer same-AZ upstreams')).toBeDisabled()
    expect(screen.getByLabelText('weight web :8080')).toBeDisabled()
  })
})
