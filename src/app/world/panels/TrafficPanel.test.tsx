// src/app/world/panels/TrafficPanel.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TrafficPanel } from './TrafficPanel'
import { useWorldStore } from '../../store/world.store'

beforeEach(() => useWorldStore.getState().newWorld())

const noop = () => {}

describe('TrafficPanel — populations', () => {
  it('add and edit population dispatches store actions with exact patches', () => {
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)

    fireEvent.click(screen.getByText('+ add'))
    const pops = Object.values(useWorldStore.getState().doc.populations)
    expect(pops).toHaveLength(1)
    expect(pops[0]).toMatchObject({ label: 'pop-1', lat: 40.7, lon: -74, peakRps: 100, diurnal: 'flat' })

    const id = pops[0].id
    fireEvent.click(screen.getByText(/pop-1/))   // expand the sentence row to reveal the tuning fields
    fireEvent.change(screen.getByLabelText(`label-${id}`), { target: { value: 'nyc' } })
    expect(useWorldStore.getState().doc.populations[id].label).toBe('nyc')

    const latInput = screen.getByLabelText(`lat-${id}`)
    fireEvent.change(latInput, { target: { value: '51.5' } })
    fireEvent.blur(latInput)
    expect(useWorldStore.getState().doc.populations[id].lat).toBe(51.5)

    const rpsInput = screen.getByLabelText(`rps-${id}`)
    fireEvent.change(rpsInput, { target: { value: '250' } })
    fireEvent.blur(rpsInput)
    expect(useWorldStore.getState().doc.populations[id].peakRps).toBe(250)

    fireEvent.change(screen.getByLabelText(`diurnal-${id}`), { target: { value: 'day-night' } })
    expect(useWorldStore.getState().doc.populations[id].diurnal).toBe('day-night')
  })

  it('remove population dispatches removePopulation', () => {
    const id = useWorldStore.getState().addPopulation('nyc', 40.7, -74)
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)
    fireEvent.click(screen.getByText(/nyc/))   // expand the sentence row
    fireEvent.click(screen.getByLabelText(`remove-${id}`))
    expect(useWorldStore.getState().doc.populations[id]).toBeUndefined()
  })

  it('shows a hint (no editor) when the route catalog is empty', () => {
    const id = useWorldStore.getState().addPopulation('nyc', 40.7, -74)
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)
    fireEvent.click(screen.getByText(/nyc/))
    expect(screen.getByText(/No routes defined/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(new RegExp(`^mix-${id}-`))).toBeNull()
  })

  it('setting a request-mix weight writes requestMix onto the population', () => {
    const routeId = useWorldStore.getState().addRoute({ name: 'api', method: 'GET', path: '/api/*' })
    const id = useWorldStore.getState().addPopulation('nyc', 40.7, -74)
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)
    fireEvent.click(screen.getByText(/nyc/))
    const weightInput = screen.getByLabelText(`mix-${id}-${routeId}`)
    fireEvent.change(weightInput, { target: { value: '3' } })
    fireEvent.blur(weightInput)
    expect(useWorldStore.getState().doc.populations[id].requestMix).toEqual([{ routeId, weight: 3 }])
  })

  it('zeroing a weight removes that route from the mix', () => {
    const routeId = useWorldStore.getState().addRoute({ name: 'api', method: 'GET', path: '/api/*' })
    const id = useWorldStore.getState().addPopulation('nyc', 40.7, -74)
    useWorldStore.getState().updatePopulation(id, { requestMix: [{ routeId, weight: 5 }] })
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)
    fireEvent.click(screen.getByText(/nyc/))
    const weightInput = screen.getByLabelText(`mix-${id}-${routeId}`)
    fireEvent.change(weightInput, { target: { value: '0' } })
    fireEvent.blur(weightInput)
    expect(useWorldStore.getState().doc.populations[id].requestMix).toBeUndefined()
  })

  it('lat clamps to [-90,90]', () => {
    const id = useWorldStore.getState().addPopulation('nyc', 40.7, -74)
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)
    fireEvent.click(screen.getByText(/nyc/))   // expand the sentence row
    const latInput = screen.getByLabelText(`lat-${id}`)

    fireEvent.change(latInput, { target: { value: '999' } })
    fireEvent.blur(latInput)
    expect(useWorldStore.getState().doc.populations[id].lat).toBe(90)

    fireEvent.change(latInput, { target: { value: '-999' } })
    fireEvent.blur(latInput)
    expect(useWorldStore.getState().doc.populations[id].lat).toBe(-90)
  })

  it('selectedPopulationId row auto-focuses its label input', () => {
    const id = useWorldStore.getState().addPopulation('nyc', 40.7, -74)
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={id} />)
    expect(screen.getByLabelText(`label-${id}`)).toHaveFocus()
  })
})

describe('TrafficPanel — place mode', () => {
  it('place toggle fires onTogglePlaceMode', () => {
    const onToggle = vi.fn()
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={onToggle} selectedPopulationId={null} />)
    fireEvent.click(screen.getByText('+ place on globe'))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('reflects armed state via aria-pressed while placeMode is true', () => {
    render(<TrafficPanel placeMode={true} onTogglePlaceMode={noop} selectedPopulationId={null} />)
    expect(screen.getByText('+ place on globe')).toHaveAttribute('aria-pressed', 'true')
  })
})


describe('TrafficPanel — routing', () => {
  it('weights editor only for weighted policy', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)
    expect(screen.queryByLabelText(`weight-${regionId}`)).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('weighted'))
    const w = screen.getByLabelText(`weight-${regionId}`)
    expect(w).toBeInTheDocument()
    fireEvent.change(w, { target: { value: '3' } })
    fireEvent.blur(w)
    expect(useWorldStore.getState().doc.routing.weights[regionId]).toBe(3)

    fireEvent.click(screen.getByText('geo'))
    expect(screen.queryByLabelText(`weight-${regionId}`)).not.toBeInTheDocument()
  })

  it('priority order buttons reorder priorityOrder', () => {
    const r1 = useWorldStore.getState().addRegion('us-east-1')
    const r2 = useWorldStore.getState().addRegion('eu-west-1')
    useWorldStore.getState().updateRouting({ policy: 'priority', priorityOrder: [r1, r2] })
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)

    fireEvent.click(screen.getByLabelText('move eu-west-1 up'))
    expect(useWorldStore.getState().doc.routing.priorityOrder).toEqual([r2, r1])

    fireEvent.click(screen.getByLabelText('move eu-west-1 down'))
    expect(useWorldStore.getState().doc.routing.priorityOrder).toEqual([r1, r2])
  })

  it('health/ttl numerics dispatch updateRouting with a floor of 1', () => {
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)
    const ttl = screen.getByLabelText('dnsTtlSec')
    fireEvent.change(ttl, { target: { value: '0' } })
    fireEvent.blur(ttl)
    expect(useWorldStore.getState().doc.routing.dnsTtlSec).toBe(1)
  })

  it('policy segmented dispatches updateRouting and shows the policy explainer', () => {
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)
    fireEvent.click(screen.getByText('geo'))
    expect(useWorldStore.getState().doc.routing.policy).toBe('geo')
    expect(screen.getByText(/nearest region by great-circle distance/)).toBeInTheDocument()
  })

  it('latency and priority policy explainers render when selected', () => {
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)
    fireEvent.click(screen.getByText('latency'))
    expect(useWorldStore.getState().doc.routing.policy).toBe('latency')
    expect(screen.getByText(/fastest healthy region; failover honors the DNS TTL/)).toBeInTheDocument()

    fireEvent.click(screen.getByText('priority'))
    expect(useWorldStore.getState().doc.routing.policy).toBe('priority')
    expect(screen.getByText(/highest-priority healthy region in the order below/)).toBeInTheDocument()
  })

  it('ttl hint appears when TTL outlives detection and clears otherwise', () => {
    useWorldStore.getState().updateRouting({ dnsTtlSec: 5, healthCheckIntervalMs: 12000, healthCheckFailureThreshold: 3 })
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)
    expect(screen.getByText(/ttl 5s < detection 36s/)).toBeInTheDocument()
    const ttl = screen.getByLabelText('dnsTtlSec')
    fireEvent.change(ttl, { target: { value: '60' } })
    fireEvent.blur(ttl)
    expect(useWorldStore.getState().doc.routing.dnsTtlSec).toBe(60)
    expect(screen.queryByText(/< detection/)).not.toBeInTheDocument()
  })
})

describe('TrafficPanel — population row', () => {
  it('population sentence row expands to the existing fields and their dispatch is unchanged', () => {
    const id = useWorldStore.getState().addPopulation('São Paulo', -23.55, -46.63)
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)
    expect(screen.queryByLabelText(`rps-${id}`)).not.toBeInTheDocument()          // collapsed
    fireEvent.click(screen.getByText(/São Paulo/))
    const rpsInput = screen.getByLabelText(`rps-${id}`)                            // same aria-label
    fireEvent.change(rpsInput, { target: { value: '250' } })
    fireEvent.blur(rpsInput)
    expect(useWorldStore.getState().doc.populations[id].peakRps).toBe(250)         // same dispatch
  })
})
