// src/app/world/server/PacketLayer.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { PacketLayer } from './PacketLayer'
import { useSimulationStore } from '../../store/simulation.store'
import { layoutServerBoard } from './boardLayout'
import { createWorld, createRegion, createAz, createServer } from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'
import { compileWorld } from '../../../lib/world/compileWorld'
import type { RenderScope } from '../../../lib/worldEngine/types'

function layout() {
  const doc = createWorld()
  const r = createRegion('us-east-1'); const az = createAz(r.id, 'us-east-1a')
  const s = createServer(az.id, getPreset('vps-medium')!)
  doc.regions[r.id] = r; doc.azs[az.id] = az; doc.servers[s.id] = s
  return { layout: layoutServerBoard(s, doc, compileWorld(doc)), serverId: s.id }
}

describe('PacketLayer', () => {
  beforeEach(() => useSimulationStore.setState({ running: false }))

  it('attaches the renderer when running and detaches on unmount', () => {
    const detach = vi.fn()
    // Typed with the real attachRenderer param shape (scope, onFrame) so `.mock.calls[0][0]`
    // resolves under strict tsc — a bare `() => detach` infers a zero-arg mock and `calls[0]`
    // becomes an empty tuple, which strict mode rejects at `[0]`.
    const attach = vi.fn((_scope: RenderScope, _onFrame: (p: unknown) => void) => detach)
    useSimulationStore.setState({ running: true, attachRenderer: attach as never })
    const { layout: l, serverId } = layout()
    const { unmount } = render(<PacketLayer serverId={serverId} layout={l} />)
    expect(attach).toHaveBeenCalledTimes(1)
    expect(attach.mock.calls[0][0]).toEqual({ level: 'server', serverId })
    unmount()
    expect(detach).toHaveBeenCalledTimes(1)
  })

  it('does not attach when stopped', () => {
    const attach = vi.fn(() => vi.fn())
    useSimulationStore.setState({ running: false, attachRenderer: attach as never })
    const { layout: l, serverId } = layout()
    render(<PacketLayer serverId={serverId} layout={l} />)
    expect(attach).not.toHaveBeenCalled()
  })
})
