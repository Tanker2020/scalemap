// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { EditServiceForm } from './EditServiceForm'
import { useWorldStore } from '../../../store/world.store'

beforeEach(() => useWorldStore.getState().newWorld())

function seedService() {
  const s = useWorldStore.getState()
  const bpId = s.addBlueprint('orders-api')
  // Give it a public port so the port editor renders.
  useWorldStore.getState().updateBlueprint(bpId, {
    ports: [{ port: 8080, protocol: 'tcp', visibility: 'internal' }],
  })
  return bpId
}

describe('EditServiceForm', () => {
  it('renames the service via updateBlueprint', () => {
    const bpId = seedService()
    render(<EditServiceForm blueprintId={bpId} running={false} onDone={() => {}} />)
    fireEvent.change(screen.getByLabelText('service name'), { target: { value: 'payments-api' } })
    expect(useWorldStore.getState().doc.blueprints[bpId].name).toBe('payments-api')
  })

  it('edits the primary port and visibility', () => {
    const bpId = seedService()
    render(<EditServiceForm blueprintId={bpId} running={false} onDone={() => {}} />)
    fireEvent.change(screen.getByLabelText('port'), { target: { value: '9090' } })
    expect(useWorldStore.getState().doc.blueprints[bpId].ports[0].port).toBe(9090)
    fireEvent.change(screen.getByLabelText('visibility'), { target: { value: 'public' } })
    expect(useWorldStore.getState().doc.blueprints[bpId].ports[0].visibility).toBe('public')
  })

  it('edits a workload field', () => {
    const bpId = seedService()
    render(<EditServiceForm blueprintId={bpId} running={false} onDone={() => {}} />)
    fireEvent.change(screen.getByLabelText('cpu / request'), { target: { value: '12' } })
    expect(useWorldStore.getState().doc.blueprints[bpId].workload.cpuMsPerRequest).toBe(12)
  })

  it('toggles stateful and defaults a volume name', () => {
    const bpId = seedService()
    render(<EditServiceForm blueprintId={bpId} running={false} onDone={() => {}} />)
    fireEvent.click(screen.getByLabelText('stateful'))
    const bp = useWorldStore.getState().doc.blueprints[bpId]
    expect(bp.stateful).toBe(true)
    expect(bp.volumeName).toBe('orders-api-data')
  })

  it('disables every field while the simulation runs', () => {
    const bpId = seedService()
    render(<EditServiceForm blueprintId={bpId} running={true} onDone={() => {}} />)
    expect(screen.getByLabelText('service name')).toBeDisabled()
    expect(screen.getByLabelText('cpu / request')).toBeDisabled()
  })
})
