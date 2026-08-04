// src/app/world/server/HardwarePlatform.test.tsx
// @vitest-environment jsdom
// Polish 3 T6 (D8): rewritten for the substrate redesign — corebank/corecell (coreCells), DIMM
// sticks (dimmStrata, worked example from the brief), spinning platter, queue-depth ticks. The
// prior D4/D5 CPU-ring/RAM-reservoir/disk-slice-per-volume suite is superseded (that DOM no
// longer exists); oom/volume detail now live in InspectorRail/StackPlate instead (see
// HardwarePlatform.tsx's header comment).
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { HardwarePlatform, coreCells, dimmStrata } from './HardwarePlatform'
import { createWorld, createRegion, createAz, createServer } from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'
import type { ServerMetrics } from '../../../lib/worldEngine/types'
import type { BlueprintId, ServiceBlueprint } from '../../../lib/world/types'

function server(kind: 'vps' | 'dedicated' = 'vps') {
  createWorld()
  const r = createRegion('us-east-1'); const az = createAz(r.id, 'us-east-1a')
  const s = createServer(az.id, getPreset(kind === 'vps' ? 'vps-medium' : 'dedicated-8')!)
  return s
}
const metrics = (over: Partial<ServerMetrics> = {}): ServerMetrics => ({
  serverId: 's', coreUtilization: [0.6, 0.4, 0.9, 0.1], stealFraction: 0, burstCredits: null,
  ramByInstance: [{ instanceId: 'i1', blueprintId: 'b1', ramMb: 1400 }, { instanceId: 'i2', blueprintId: 'b2', ramMb: 610 }],
  ramUsedMb: 5900, ramTotalMb: 8192, nicInMbps: 214, nicOutMbps: 118, diskIoFraction: 0.12, health: 'healthy', ...over,
})
const blueprint = (id: string, color: string, name = id): ServiceBlueprint => ({
  id, name, color, kind: 'api',
  workload: { cpuMsPerRequest: 5, ramBaseMb: 128, ramPerConnMb: 0.5, diskIoPerRequest: 0 },
  ports: [], dependencies: [], stateful: false, volumeName: null,
  dbConfig: null, ownerServerKind: null,
})
const blueprints: Record<BlueprintId, ServiceBlueprint> = {
  b1: blueprint('b1', '#A78BFA', 'postgres'), b2: blueprint('b2', '#4A9EFF', 'api'),
}
const residents = [{ instanceId: 'i1', blueprintId: 'b1' }, { instanceId: 'i2', blueprintId: 'b2' }]

describe('coreCells (pure)', () => {
  it('marks hot at 0.85 and applies steal only when stealing', () => {
    const noSteal = coreCells([0.5, 0.9], 0)
    expect(noSteal.every(c => !c.steal)).toBe(true)
    expect(noSteal[1].hot).toBe(true)   // 0.9 >= 0.85
    expect(noSteal[0].hot).toBe(false)

    const eightCores = new Array(8).fill(0.5)
    const withSteal = coreCells(eightCores, 0.3)   // ceil(0.3*8) = 3 -> cores 0,1,2 steal
    expect(withSteal.map(c => c.steal)).toEqual([true, true, true, false, false, false, false, false])

    const exactlyHot = coreCells([0.85], 0)
    expect(exactlyHot[0].hot).toBe(true)
  })
})

describe('dimmStrata (pure)', () => {
  it('partitions sticks by blueprint color with exact fractions (worked example)', () => {
    const bps: Record<BlueprintId, ServiceBlueprint> = { b1: blueprint('b1', '#4A9EFF') }
    const sticks = dimmStrata([{ blueprintId: 'b1', ramMb: 8000 }], bps, 16000)
    expect(sticks).toEqual([
      [{ color: '#4A9EFF', frac: 1 }],
      [{ color: '#4A9EFF', frac: 1 }],
      [{ color: '#4a5361', frac: 1 }],
      [{ color: '#4a5361', frac: 1 }],
    ])
  })

  it('returns 4 empty sticks when ramTotalMb is zero', () => {
    expect(dimmStrata([], {}, 0)).toEqual([[], [], [], []])
  })

  it('splits a stratum across a stick boundary', () => {
    // capPerStick = 1000/4 = 250; one 300mb blueprint spans stick0 (250) + spills 50 into stick1.
    const bps: Record<BlueprintId, ServiceBlueprint> = { b1: blueprint('b1', '#111') }
    const sticks = dimmStrata([{ blueprintId: 'b1', ramMb: 300 }], bps, 1000)
    expect(sticks[0]).toEqual([{ color: '#111', frac: 1 }])
    expect(sticks[1][0]).toEqual({ color: '#111', frac: 50 / 250 })
  })
})

describe('HardwarePlatform', () => {
  it('renders one core cell per vcpu', () => {
    const s = server()
    render(<HardwarePlatform server={s} metrics={metrics()} residentInstances={residents} blueprints={blueprints} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}} />)
    expect(screen.getAllByTestId('core-cell')).toHaveLength(4)
  })

  it('marks hot cores and applies the steal overlay only to stolen cores', () => {
    const s = server('vps')
    render(<HardwarePlatform server={s} metrics={metrics({ stealFraction: 0.3 })} residentInstances={residents} blueprints={blueprints} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}} />)
    const cells = screen.getAllByTestId('core-cell')
    // 4 cores, stealFraction 0.3 -> ceil(0.3*4)=2 stolen (indices 0,1)
    expect(cells[0]).toHaveAttribute('data-steal', 'true')
    expect(cells[1]).toHaveAttribute('data-steal', 'true')
    expect(cells[2]).toHaveAttribute('data-steal', 'false')
    expect(screen.getAllByTestId('core-steal')).toHaveLength(2)
    // core index 2 has utilization 0.9 -> hot
    expect(cells[2]).toHaveAttribute('data-hot', 'true')
  })

  it('no steal overlay when stealFraction is 0', () => {
    const s = server()
    render(<HardwarePlatform server={s} metrics={metrics({ stealFraction: 0 })} residentInstances={residents} blueprints={blueprints} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}} />)
    expect(screen.queryAllByTestId('core-steal')).toHaveLength(0)
  })

  it('renders 4 dimm sticks with signature-colored segments and a free remainder', () => {
    const s = server()
    render(<HardwarePlatform server={s} metrics={metrics()} residentInstances={residents} blueprints={blueprints} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}} />)
    expect(screen.getAllByTestId('dimm-stick')).toHaveLength(4)
    const segs = screen.getAllByTestId('dimm-seg')
    expect(segs[0]).toHaveAttribute('data-blueprint', 'b1')
    expect(segs.some(s => s.getAttribute('data-blueprint') === 'free')).toBe(true)
    expect(screen.getByText('postgres')).toBeInTheDocument()
    expect(screen.getByText('api')).toBeInTheDocument()
    expect(screen.getByText('free')).toBeInTheDocument()
  })

  it('hovering a dimm segment cross-highlights by blueprint; free segments never dim', () => {
    const s = server()
    render(<HardwarePlatform server={s} metrics={metrics()} residentInstances={residents} blueprints={blueprints} hoveredBlueprintId="b1" onHoverBlueprint={() => {}} onSelect={() => {}} />)
    const segs = screen.getAllByTestId('dimm-seg')
    const b1Seg = segs.find(s => s.getAttribute('data-blueprint') === 'b1')!
    const b2Seg = segs.find(s => s.getAttribute('data-blueprint') === 'b2')!
    const freeSeg = segs.find(s => s.getAttribute('data-blueprint') === 'free')!
    expect(b1Seg.style.opacity).toBe('1')
    expect(b2Seg.style.opacity).toBe('0.45')
    expect(freeSeg.style.opacity).toBe('1')
  })

  it('at-rest estimate uses blueprint ramBaseMb when metrics is null', () => {
    const s = server()
    render(<HardwarePlatform server={s} metrics={null} residentInstances={residents} blueprints={blueprints} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}} />)
    expect(screen.getByText(/at rest/i)).toBeInTheDocument()
    // 2 residents x 128 (default ramBaseMb) = 256M used, out of the 8192M vps-medium preset.
    expect(screen.getByText(/\/ 8 G \(at rest\)/)).toBeInTheDocument()
    const segs = screen.getAllByTestId('dimm-seg')
    expect(segs[0]).toHaveAttribute('data-blueprint', 'b1')
    expect(segs[1]).toHaveAttribute('data-blueprint', 'b2')
  })

  it('platter is static at zero IO', () => {
    const s = server()
    render(<HardwarePlatform server={s} metrics={metrics({ diskIoFraction: 0 })} residentInstances={residents} blueprints={blueprints} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}} />)
    const spin = screen.getByTestId('platter-spin')
    expect(spin).toHaveAttribute('data-spinning', 'false')
    expect(spin.style.animation).toBe('')
  })

  it('platter spins when IO is active', () => {
    const s = server()
    render(<HardwarePlatform server={s} metrics={metrics({ diskIoFraction: 0.4 })} residentInstances={residents} blueprints={blueprints} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}} />)
    const spin = screen.getByTestId('platter-spin')
    expect(spin).toHaveAttribute('data-spinning', 'true')
    expect(spin.style.animation).toMatch(/^spin /)
  })

  // Task 22 (FEAT-006): disk saturation bar — same track+fill shape as the core cells, redlining
  // to var(--color-danger) at the SAME threshold (0.9) the iops-saturated analysis rule fires at.
  it('disk saturation bar fills proportionally to diskIoFraction and stays below the danger threshold', () => {
    const s = server()
    render(<HardwarePlatform server={s} metrics={metrics({ diskIoFraction: 0.4 })} residentInstances={residents} blueprints={blueprints} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}} />)
    const fill = screen.getByTestId('disk-io-fill')
    expect(fill.style.width).toBe('40%')
    expect(fill).toHaveAttribute('data-saturated', 'false')
    expect(fill.style.background).not.toBe('var(--color-danger)')
  })

  it('disk saturation bar redlines to var(--color-danger) once diskIoFraction crosses 0.9', () => {
    const s = server()
    render(<HardwarePlatform server={s} metrics={metrics({ diskIoFraction: 0.95 })} residentInstances={residents} blueprints={blueprints} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}} />)
    const fill = screen.getByTestId('disk-io-fill')
    expect(fill.style.width).toBe('95%')
    expect(fill).toHaveAttribute('data-saturated', 'true')
    expect(fill.style.background).toBe('var(--color-danger)')
  })

  // Audit final-review finding: diskIoFraction is dual-behavior (Task 20) — with NEITHER
  // diskIops nor diskType authored it's the legacy `min(1, diskIo/100)` heuristic, not a real
  // saturation signal, and trivially exceeds 0.9 on an ordinary server. The board must not
  // redline on that, mirroring capacity.ts's `iopsSaturated` rule's own gate.
  it('does NOT redline on a high legacy diskIoFraction when neither diskIops nor diskType is authored', () => {
    const s = server()
    delete s.specs.diskType
    delete s.specs.diskIops
    render(<HardwarePlatform server={s} metrics={metrics({ diskIoFraction: 0.95 })} residentInstances={residents} blueprints={blueprints} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}} />)
    const fill = screen.getByTestId('disk-io-fill')
    expect(fill).toHaveAttribute('data-saturated', 'false')
    expect(fill.style.background).not.toBe('var(--color-danger)')
  })

  it('DOES redline on a high diskIoFraction when an authored ceiling (diskType) is present', () => {
    const s = server()
    s.specs.diskType = 'ssd'
    delete s.specs.diskIops
    render(<HardwarePlatform server={s} metrics={metrics({ diskIoFraction: 0.95 })} residentInstances={residents} blueprints={blueprints} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}} />)
    const fill = screen.getByTestId('disk-io-fill')
    expect(fill).toHaveAttribute('data-saturated', 'true')
    expect(fill.style.background).toBe('var(--color-danger)')
  })

  it('shows the authored diskType label in place of the generic "nvme0" placeholder', () => {
    const s = server()
    s.specs.diskType = 'hdd'
    render(<HardwarePlatform server={s} metrics={metrics()} residentInstances={residents} blueprints={blueprints} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}} />)
    expect(screen.getByText(/hdd · io/)).toBeInTheDocument()
  })

  it('queue-depth ticks reflect summed active connections', () => {
    const s = server()
    render(<HardwarePlatform server={s} metrics={metrics()} residentInstances={residents} blueprints={blueprints} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}} queueDepth={9} />)
    const ticks = screen.getAllByTestId('qtick')
    expect(ticks).toHaveLength(12)
    // 9 conns / 3 per tick = 3 on-ticks
    expect(ticks.filter(t => t.getAttribute('data-on') === 'true')).toHaveLength(3)
    expect(screen.getByText(/depth 9/)).toBeInTheDocument()
  })

  it('core flicker/glitch is capped at MAX_ANIMATED_CORES (4) on a large dedicated box, ranked by utilization', () => {
    const s = server('dedicated')   // dedicated-8 preset (8 vCPU) — see instanceCatalog.ts
    const util = [0.1, 0.2, 0.9, 0.3, 0.4, 0.5, 0.6, 0.7]   // 8 cores, strictly varied utilization
    render(<HardwarePlatform server={s} metrics={metrics({ coreUtilization: util, stealFraction: 0 })} residentInstances={residents} blueprints={blueprints} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}} />)
    const cells = screen.getAllByTestId('core-cell')
    expect(cells).toHaveLength(8)
    const flickering = cells.filter(c => c.querySelector('div')?.getAttribute('class') === 'hw-flicker')
    expect(flickering).toHaveLength(4)
    // The 4 highest-utilization cores (indices 2, 6, 7, 5 -> 0.9, 0.6, 0.7, 0.5) must be among the
    // flickering set; the two lowest (indices 0, 1 -> 0.1, 0.2) must not.
    expect(cells[0].querySelector('div')?.getAttribute('class')).not.toBe('hw-flicker')
    expect(cells[1].querySelector('div')?.getAttribute('class')).not.toBe('hw-flicker')
    expect(cells[2].querySelector('div')?.getAttribute('class')).toBe('hw-flicker')
  })

  it('clicking the core bank, dimms, and disk zones dispatches the matching hardware selection', () => {
    const s = server()
    const onSelect = vi.fn()
    const { container } = render(<HardwarePlatform server={s} metrics={metrics()} residentInstances={residents} blueprints={blueprints} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={onSelect} />)
    fireEvent.click(container.querySelector('[data-corebank]')!)
    expect(onSelect).toHaveBeenLastCalledWith({ kind: 'hardware', part: 'cpu' })
    fireEvent.click(container.querySelector('[data-dimms]')!)
    expect(onSelect).toHaveBeenLastCalledWith({ kind: 'hardware', part: 'ram' })
    fireEvent.click(container.querySelector('[data-disk]')!)
    expect(onSelect).toHaveBeenLastCalledWith({ kind: 'hardware', part: 'disk' })
  })
})
