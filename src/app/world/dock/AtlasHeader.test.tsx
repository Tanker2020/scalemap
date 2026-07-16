// @vitest-environment jsdom
// Polish 4 T2 (spec D4): the atlas instrument's constellation SVG + headline. jsdom because the
// component is plain SVG/DOM (no WebGL) — `projectLatLon` itself is pure node-clean logic, tested
// first (TDD) before any rendering.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'

// Same precedent as az/DatacenterFloor.test.tsx / server/NicBlock.test.tsx — mock the hook
// directly rather than stubbing matchMedia (jsdom has no matchMedia, and framer-motion's
// reduced-motion listener only initializes once per test-module lifetime, so a per-test stub is
// unreliable once any earlier test has rendered a consumer).
const { mockUseReducedMotion } = vi.hoisted(() => ({ mockUseReducedMotion: vi.fn(() => false) }))
vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>()
  return { ...actual, useReducedMotion: mockUseReducedMotion }
})

import { AtlasHeader, projectLatLon, warpToSphere } from './AtlasHeader'
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import { useUiStore } from '../../store/ui.store'
import { useSimulationStore } from '../../store/simulation.store'
import { getPreset } from '../../../lib/world/instanceCatalog'
import type { MetricsBatch } from '../../../lib/worldEngine/types'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useNavStore.setState({ level: 'globe', regionId: null, azId: null, serverId: null })
  useUiStore.setState({ selectedServerId: null })
  useSimulationStore.setState({ latestBatch: null, scrubBatch: null, running: false })
  mockUseReducedMotion.mockReturnValue(false)
})

describe('projectLatLon (equirectangular, lon -180..180 -> 0..w, lat 75..-60 -> 0..h)', () => {
  it('projects the origin-ish reference point (lat 75, lon -180) to the top-left corner', () => {
    expect(projectLatLon(75, -180, 372, 92)).toEqual({ x: 0, y: 0 })
  })

  it('projects (lat -60, lon 180) to the bottom-right corner', () => {
    expect(projectLatLon(-60, 180, 372, 92)).toEqual({ x: 372, y: 92 })
  })

  it('projects lon 0 to the horizontal midpoint', () => {
    const { x } = projectLatLon(7.5, 0, 372, 92)   // lat picked mid-range, irrelevant to x
    expect(x).toBeCloseTo(186, 5)
  })

  it('projects a known region (us-east-1, lat 38.9 lon -77.5) inside bounds with the documented formula', () => {
    const { x, y } = projectLatLon(38.9, -77.5, 372, 92)
    expect(x).toBeCloseTo(((-77.5 + 180) / 360) * 372, 5)
    expect(y).toBeCloseTo(((75 - 38.9) / 135) * 92, 5)
    expect(x).toBeGreaterThan(0)
    expect(x).toBeLessThan(372)
    expect(y).toBeGreaterThan(0)
    expect(y).toBeLessThan(92)
  })

  it('clamps latitude above 75 to y=0', () => {
    expect(projectLatLon(89, 0, 372, 92).y).toBe(0)
  })

  it('clamps latitude below -60 to y=h', () => {
    expect(projectLatLon(-85, 0, 372, 92).y).toBe(92)
  })

  it('clamps longitude below -180 to x=0', () => {
    expect(projectLatLon(0, -200, 372, 92).x).toBe(0)
  })

  it('clamps longitude above 180 to x=w', () => {
    expect(projectLatLon(0, 200, 372, 92).x).toBe(372)
  })

  it('scales linearly with w/h (a different viewport size still hits the corners)', () => {
    expect(projectLatLon(75, -180, 100, 50)).toEqual({ x: 0, y: 0 })
    expect(projectLatLon(-60, 180, 100, 50)).toEqual({ x: 100, y: 50 })
  })
})

function seedRegion(catalogId: string, azLabel: string) {
  const regionId = useWorldStore.getState().addRegion(catalogId)
  const azId = useWorldStore.getState().addAz(regionId, azLabel)
  useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
  return regionId
}

function runningBatch(overrides: Partial<MetricsBatch> = {}): MetricsBatch {
  return {
    simMs: 5000, instances: {}, servers: {}, azs: {}, regions: {},
    world: { totalRps: 0, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 },
    ...overrides,
  }
}

describe('warpToSphere (content rides the graticule bulge — fake-3D, 2026-07-12)', () => {
  it('lifts the center column by the full sphere lift and leaves the limbs unlifted', () => {
    // top of the band: center reaches y=0, the limbs sit SPHERE_LIFT lower
    expect(warpToSphere({ x: 186, y: 0 }).y).toBeCloseTo(0)
    expect(warpToSphere({ x: 0, y: 0 }).y).toBeCloseTo(10)
    expect(warpToSphere({ x: 372, y: 0 }).y).toBeCloseTo(10)
  })
  it('never leaves the 0..MAP_H band', () => {
    for (const x of [0, 93, 186, 279, 372]) {
      for (const y of [0, 36, 72]) {
        const out = warpToSphere({ x, y })
        expect(out.y).toBeGreaterThanOrEqual(0)
        expect(out.y).toBeLessThanOrEqual(72)
      }
    }
  })
  it('keeps x untouched', () => {
    expect(warpToSphere({ x: 123, y: 40 }).x).toBe(123)
  })
})

describe('AtlasHeader — world scope (regionId=null)', () => {
  it('renders one atlas-region-dot per region with a REGION_GEO entry', () => {
    seedRegion('us-east-1', 'us-east-1a')
    seedRegion('eu-west-1', 'eu-west-1a')
    render(<AtlasHeader regionId={null} />)
    expect(screen.getAllByTestId('atlas-region-dot')).toHaveLength(2)
  })

  // Regression (user report 2026-07-12): São Paulo projected under the headline caption, so
  // its arc read as "a dashed line to nowhere." Geography must stay inside the MAP band —
  // above the caption's ~20px strip at the bottom of the 92px card.
  it('a southern-hemisphere population dot projects clear of the caption band', () => {
    seedRegion('us-east-1', 'us-east-1a')
    useWorldStore.getState().addPopulation('São Paulo', -23.5, -46.6)
    render(<AtlasHeader regionId={null} />)
    const dot = screen.getByTestId('atlas-population-dot')
    expect(Number(dot.getAttribute('cy'))).toBeLessThanOrEqual(72)
    expect(Number(dot.getAttribute('r'))).toBeGreaterThanOrEqual(2.5)
  })

  it('at rest (no batch) region dots render the healthy/success color', () => {
    seedRegion('us-east-1', 'us-east-1a')
    render(<AtlasHeader regionId={null} />)
    const dot = screen.getByTestId('atlas-region-dot')
    expect(dot).toHaveAttribute('fill', '#22C55E')
  })

  it('a down region renders the danger color on its dot', () => {
    const regionId = seedRegion('us-east-1', 'us-east-1a')
    const batch = runningBatch({
      regions: { [regionId]: { regionId, rps: 0, errorRate: 0, p50Ms: 0, healthScore: 0, health: 'down', inboundByPopulation: [] } },
    })
    useSimulationStore.setState({ latestBatch: batch })
    render(<AtlasHeader regionId={null} />)
    expect(screen.getByTestId('atlas-region-dot')).toHaveAttribute('fill', '#EF4444')
  })

  it('headline at rest shows the authored-doc posture (regions/servers/populations)', () => {
    seedRegion('us-east-1', 'us-east-1a')
    render(<AtlasHeader regionId={null} />)
    expect(screen.getByTestId('atlas-headline')).toHaveTextContent(/1 region · 1 server · 0 populations/)
  })

  it('headline while running shows the handling posture with a price-colored $/hr', () => {
    seedRegion('us-east-1', 'us-east-1a')
    const batch = runningBatch({ world: { totalRps: 250, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 } })
    useSimulationStore.setState({ latestBatch: batch })
    render(<AtlasHeader regionId={null} />)
    const headline = screen.getByTestId('atlas-headline')
    expect(headline).toHaveTextContent(/Handling/)
    expect(headline).toHaveTextContent('250 rps')
    const price = within(headline).getByText('$0.04/hr')
    expect(price).toHaveStyle({ color: 'var(--color-price)' })
  })

  it('caps arcs at 3 and marks only the top route by rps as .live', () => {
    const r1 = useWorldStore.getState().addRegion('us-east-1')
    useWorldStore.getState().addAz(r1, 'us-east-1a')
    const p1 = useWorldStore.getState().addPopulation('nyc', 40.7, -74)
    const p2 = useWorldStore.getState().addPopulation('sfo', 37.8, -122.4)
    const p3 = useWorldStore.getState().addPopulation('bos', 42.4, -71.1)
    const p4 = useWorldStore.getState().addPopulation('chi', 41.9, -87.6)
    const batch = runningBatch({
      regions: { [r1]: { regionId: r1, rps: 400, errorRate: 0, p50Ms: 5, healthScore: 100, health: 'healthy', inboundByPopulation: [] } },
      world: {
        totalRps: 400, errorRate: 0, crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0,
        populationRoutes: [
          { populationId: p1, regionId: r1, rps: 100 },
          { populationId: p2, regionId: r1, rps: 200 },
          { populationId: p3, regionId: r1, rps: 50 },
          { populationId: p4, regionId: r1, rps: 50 },
        ],
      },
    })
    useSimulationStore.setState({ latestBatch: batch, running: true })
    render(<AtlasHeader regionId={null} />)
    const arcs = document.querySelectorAll('[data-arc]')
    expect(arcs.length).toBe(3)
    const live = document.querySelectorAll('[data-arc-live="true"]')
    expect(live.length).toBe(1)
    expect(live[0].getAttribute('data-arc-population')).toBe(p2)   // sfo carries the top rps (200)
  })

  it('the live arc carries data-animated=true only when running, top rps>0, and motion is not reduced', () => {
    const r1 = useWorldStore.getState().addRegion('us-east-1')
    useWorldStore.getState().addAz(r1, 'us-east-1a')
    const p1 = useWorldStore.getState().addPopulation('nyc', 40.7, -74)
    const batch = runningBatch({
      world: { totalRps: 100, errorRate: 0, crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0, populationRoutes: [{ populationId: p1, regionId: r1, rps: 100 }] },
    })
    useSimulationStore.setState({ latestBatch: batch, running: true })
    render(<AtlasHeader regionId={null} />)
    const live = document.querySelector('[data-arc-live="true"]')
    expect(live).not.toBeNull()
    expect(live).toHaveAttribute('data-animated', 'true')
  })

  it('the live arc is NOT animated under prefers-reduced-motion even while running', () => {
    mockUseReducedMotion.mockReturnValue(true)
    const r1 = useWorldStore.getState().addRegion('us-east-1')
    useWorldStore.getState().addAz(r1, 'us-east-1a')
    const p1 = useWorldStore.getState().addPopulation('nyc', 40.7, -74)
    const batch = runningBatch({
      world: { totalRps: 100, errorRate: 0, crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0, populationRoutes: [{ populationId: p1, regionId: r1, rps: 100 }] },
    })
    useSimulationStore.setState({ latestBatch: batch, running: true })
    render(<AtlasHeader regionId={null} />)
    expect(document.querySelector('[data-arc-live="true"]')).toHaveAttribute('data-animated', 'false')
  })

  it('arcs are NOT animated when the sim is stopped even with a scrubbed batch present', () => {
    const r1 = useWorldStore.getState().addRegion('us-east-1')
    useWorldStore.getState().addAz(r1, 'us-east-1a')
    const p1 = useWorldStore.getState().addPopulation('nyc', 40.7, -74)
    const batch = runningBatch({
      world: { totalRps: 100, errorRate: 0, crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0, populationRoutes: [{ populationId: p1, regionId: r1, rps: 100 }] },
    })
    useSimulationStore.setState({ scrubBatch: batch, running: false })
    render(<AtlasHeader regionId={null} />)
    const live = document.querySelector('[data-arc-live="true"]')
    expect(live).toHaveAttribute('data-animated', 'false')
  })
})

describe('AtlasHeader — region scope', () => {
  it('renders a scoped headline "<catalogId> · N rps · $X/hr"', () => {
    const regionId = seedRegion('us-east-1', 'us-east-1a')
    render(<AtlasHeader regionId={regionId} />)
    const headline = screen.getByTestId('atlas-headline')
    expect(headline).toHaveTextContent('us-east-1')
    expect(headline).toHaveTextContent('0 rps')
    expect(within(headline).getByText('$0.04/hr')).toHaveStyle({ color: 'var(--color-price)' })
  })

  it('rings this region\'s dot (and no other) with the hud accent stroke', () => {
    const r1 = seedRegion('us-east-1', 'us-east-1a')
    seedRegion('eu-west-1', 'eu-west-1a')
    render(<AtlasHeader regionId={r1} />)
    const dots = screen.getAllByTestId('atlas-region-dot')
    const ringed = dots.filter(d => d.getAttribute('stroke') === 'var(--kit-accent)')
    expect(ringed).toHaveLength(1)
  })
})
