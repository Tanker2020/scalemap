// src/app/world/RackNodes.test.tsx
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ReactFlowProvider, type NodeProps } from '@xyflow/react'
import { RackFrameNode, RackChassisNode, type RackFrameNodeData, type RackChassisNodeData } from './RackNodes'
import { createRegion, createAz, createServer } from '../../lib/world/factories'
import { getPreset } from '../../lib/world/instanceCatalog'

// RackFrameNode/RackChassisNode only destructure `data` from their props — building a
// fully-compliant NodeProps object (13 required fields) for every test would be pure
// ceremony, so this casts through `data` the same way production code already casts
// `data as WorldServerNodeData` (see the deleted WorldServerNode.tsx).
function nodeProps<T>(data: T): NodeProps {
  return { data } as unknown as NodeProps
}

// RackChassisNode renders <Handle> (unlike RackFrameNode), and @xyflow/react's Handle
// reaches into React Flow's internal store context — verified live: it throws "Seems
// like you have not used ReactFlowProvider as an ancestor" if rendered bare. Wrap every
// chassis render (RackFrameNode has no Handle and needs no wrapper).
function renderChassis(data: RackChassisNodeData) {
  return render(<ReactFlowProvider><RackChassisNode {...nodeProps(data)} /></ReactFlowProvider>)
}

// createServer only needs a valid azId string plus a preset — it never reads the doc
// itself, so this helper skips assembling a full WorldDoc (would be unused otherwise).
function seedServer(presetId: string, label: string) {
  const region = createRegion('us-east-1')
  const az = createAz(region.id, 'us-east-1a')
  const server = createServer(az.id, getPreset(presetId)!)
  server.label = label
  return server
}

describe('RackChassisNode', () => {
  it('chassis renders U-height, LEDs, and micro-bars from metrics', () => {
    const server = seedServer('dedicated-8', 'db-primary')   // heightU 2, vcpu 8, 32G
    const data: RackChassisNodeData = {
      server, chips: [{ color: '#4A9EFF', name: 'api' }], internalBlocked: 0, health: 'healthy',
      metrics: { cpuMean: 0.38, ramFrac: 0.52, diskIo: 0.12, nicFrac: 0.2, rps: 40 }, noisy: false,
    }
    renderChassis(data)
    expect(screen.getByText(/db-primary/)).toBeInTheDocument()
    expect(screen.getByText(/2U/)).toBeInTheDocument()
    // min(8, 2×heightU+2) at heightU=2 -> 6 (skeleton's literal formula — see the plan's
    // flagged discrepancy note against the mockup's own 8-bay 2U illustration).
    expect(screen.getAllByTestId('drive-bay')).toHaveLength(6)
    expect(screen.getAllByTestId('chassis-led')).toHaveLength(3)
    expect(screen.getByTestId('micro-bar-cpu').style.height).toBe('38%')
    expect(screen.getByTestId('micro-bar-ram').style.height).toBe('52%')
    expect(screen.getByTestId('micro-bar-io').style.height).toBe('12%')
  })

  it('noisy tag appears for recent noisy_neighbor', () => {
    const server = seedServer('vps-small', 'cache-01')
    const base: RackChassisNodeData = { server, chips: [], internalBlocked: 0, metrics: null, noisy: false }
    const { rerender } = renderChassis(base)
    expect(screen.queryByText(/noisy neighbor/)).not.toBeInTheDocument()
    rerender(<ReactFlowProvider><RackChassisNode {...nodeProps({ ...base, noisy: true })} /></ReactFlowProvider>)
    expect(screen.getByText(/noisy neighbor/)).toBeInTheDocument()
  })

  it('blocked badge carries over', () => {
    const server = seedServer('vps-small', 'web-01')
    const data: RackChassisNodeData = { server, chips: [], internalBlocked: 2, metrics: null, noisy: false }
    renderChassis(data)
    expect(screen.getByText(/✕ 2 blocked internal path/)).toBeInTheDocument()
  })
})

describe('RackFrameNode', () => {
  it('frame renders caption, fillers, and pdu', () => {
    const data: RackFrameNodeData = {
      rackId: 'rack-1', azLabel: 'us-east-1a',
      blankUnits: [{ y: 58, h: 44 }], pduY: 106, pduKw: 0.4,
    }
    render(<RackFrameNode {...nodeProps(data)} />)
    expect(screen.getByText(/RACK rack-1/)).toBeInTheDocument()
    expect(screen.getByText(/us-east-1a/)).toBeInTheDocument()
    expect(screen.getAllByTestId('blank-filler')).toHaveLength(1)
    expect(screen.getByText(/PDU/)).toBeInTheDocument()
    expect(screen.getByText(/0\.4kW/)).toBeInTheDocument()
  })
})
