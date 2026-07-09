// src/app/world/server/HardwarePlatform.test.tsx
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HardwarePlatform } from './HardwarePlatform'
import { createWorld, createRegion, createAz, createServer } from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'
import type { ServerMetrics } from '../../../lib/worldEngine/types'

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
const residents = [
  { instanceId: 'i1', blueprintId: 'b1', color: '#A78BFA', name: 'postgres', ramBaseMb: 256 },
  { instanceId: 'i2', blueprintId: 'b2', color: '#4A9EFF', name: 'api', ramBaseMb: 128 },
]

describe('HardwarePlatform', () => {
  it('renders one core cell per vcpu', () => {
    const s = server()
    render(<HardwarePlatform server={s} metrics={metrics()} residentBlueprints={residents} attribution={[]} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}} />)
    expect(screen.getAllByTestId('core-cell')).toHaveLength(4)
  })

  it('steal arc appears only for vps with steal', () => {
    const s = server('vps')
    const { rerender } = render(<HardwarePlatform server={s} metrics={metrics({ stealFraction: 0.18 })} residentBlueprints={residents} attribution={[]} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}} />)
    expect(screen.getByText(/steal/)).toBeInTheDocument()
    rerender(<HardwarePlatform server={s} metrics={metrics({ stealFraction: 0 })} residentBlueprints={residents} attribution={[]} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}} />)
    expect(screen.queryByText(/steal/)).not.toBeInTheDocument()
  })

  it('ram strata follow ramByInstance order and include os+cache remainder', () => {
    const s = server()
    render(<HardwarePlatform server={s} metrics={metrics()} residentBlueprints={residents} attribution={[]} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}} />)
    const strata = screen.getAllByTestId('ram-stratum')
    // 2 instance strata + os+cache remainder
    expect(strata.length).toBe(3)
    expect(screen.getByText(/os \+ cache/i)).toBeInTheDocument()
  })

  it('at-rest estimate uses ramBaseMb when no batch', () => {
    const s = server()
    render(<HardwarePlatform server={s} metrics={null} residentBlueprints={residents} attribution={[]} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}} />)
    expect(screen.getByText(/at rest/i)).toBeInTheDocument()
    // strata should reflect each resident's ramBaseMb (256, 128), not 0
    expect(screen.getByText(/256/)).toBeInTheDocument()
    expect(screen.getByText(/128/)).toBeInTheDocument()
  })

  it('oom falsy-zero guard: memLimits/instanceRamMb of 0 renders no stray "0" or oom marker', () => {
    const s = server()
    render(<HardwarePlatform server={s} metrics={metrics()} residentBlueprints={residents}
      attribution={[]} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}}
      memLimits={{ i2: 0 }} instanceRamMb={{ i2: 0 }} />)
    expect(screen.queryByText('⚠oom')).not.toBeInTheDocument()
    const apiRow = screen.getByText(/api/)
    expect(apiRow.textContent).not.toMatch(/\b0\b/)
  })

  it('disk slices proportional to volume sizes', () => {
    const s = server()
    s.stacks = [{ name: 'app', networks: [], volumes: [{ name: 'pgdata', sizeGb: 12 }] }]
    render(<HardwarePlatform server={s} metrics={metrics()} residentBlueprints={residents} attribution={[]} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}} />)
    expect(screen.getByText(/pgdata/)).toBeInTheDocument()
  })

  it('oom warning appears at 90% of memLimit', () => {
    const s = server()
    render(<HardwarePlatform server={s} metrics={metrics()} residentBlueprints={residents}
      attribution={[]} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}}
      memLimits={{ i2: 640 }} instanceRamMb={{ i2: 610 }} />)
    expect(screen.getByText(/oom/i)).toBeInTheDocument()
  })
})
