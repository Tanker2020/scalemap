// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { BlueprintPanel } from './BlueprintPanel'
import { useWorldStore } from '../../store/world.store'
import { getPreset } from '../../../lib/world/instanceCatalog'

beforeEach(() => useWorldStore.getState().newWorld())

describe('BlueprintPanel', () => {
  it('adds a blueprint by name', () => {
    render(<BlueprintPanel />)
    fireEvent.change(screen.getByPlaceholderText('new blueprint name'), { target: { value: 'api' } })
    fireEvent.click(screen.getByText('+ Blueprint'))
    expect(Object.values(useWorldStore.getState().doc.blueprints)[0].name).toBe('api')
  })

  it('adds a dependency between two blueprints', () => {
    const apiId = useWorldStore.getState().addBlueprint('api')
    useWorldStore.getState().addBlueprint('pg')
    render(<BlueprintPanel />)
    fireEvent.click(screen.getAllByText('▸ deps')[0])         // expand api's dependency editor
    fireEvent.click(screen.getByText('+ Dependency'))
    const api = useWorldStore.getState().doc.blueprints[apiId]
    expect(api.dependencies).toHaveLength(1)
    expect(api.dependencies[0].target.kind).toBe('blueprint')
  })

  it('workload slider commits updateBlueprint with the exact patch', () => {
    const bpId = useWorldStore.getState().addBlueprint('api')
    render(<BlueprintPanel />)
    const slider = screen.getByLabelText('cpu / request')
    fireEvent.change(slider, { target: { value: '12' } })
    fireEvent.mouseUp(slider)
    const bp = useWorldStore.getState().doc.blueprints[bpId]
    expect(bp.workload).toEqual({ cpuMsPerRequest: 12, ramBaseMb: 128, ramPerConnMb: 0.5, diskIoPerRequest: 0 })
  })

  it('derive line reflects the committed cpu ms', () => {
    const bpId = useWorldStore.getState().addBlueprint('api')
    useWorldStore.getState().updateBlueprint(bpId, { workload: { cpuMsPerRequest: 8, ramBaseMb: 128, ramPerConnMb: 0.5, diskIoPerRequest: 0 } })
    render(<BlueprintPanel />)
    expect(screen.getByText(/one core sustains ~125 rps/)).toBeInTheDocument()
  })

  it('host capacity line appears only when the blueprint has a placement', () => {
    const bpId = useWorldStore.getState().addBlueprint('api')
    render(<BlueprintPanel />)
    expect(screen.queryByText(/this \d+-core host/)).not.toBeInTheDocument()
    // Zustand v5's external-store notification lands outside any React-tracked event, so under
    // React 19 automatic batching it stays pending until the next act() boundary — wrap the
    // post-render store writes so the DOM query below observes the flushed render (verified via
    // an isolated repro; TopologyPanel's existing tests all mutate either pre-render or via
    // fireEvent, which self-wraps in act(), so this gap wasn't hit before).
    act(() => {
      const regionId = useWorldStore.getState().addRegion('us-east-1')
      const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
      const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
      useWorldStore.getState().addPlacement(bpId, serverId)
    })
    // vps-medium is 4 vCPU; the blueprint's workload keeps factories.ts's createBlueprint
    // default (cpuMsPerRequest: 5, untouched by this test) — rpsPerCore(5) = 200,
    // hostRpsCapacity(4, 5) = 800, per derived.ts's frozen (T1-tested) math.
    expect(screen.getByText(/this 4-core host ~800 rps/)).toBeInTheDocument()
  })
})
