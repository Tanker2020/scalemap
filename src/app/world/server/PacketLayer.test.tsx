// src/app/world/server/PacketLayer.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { PacketLayer } from './PacketLayer'
import { useSimulationStore } from '../../store/simulation.store'
import { useUiStore } from '../../store/ui.store'
import { CATEGORY_COLORS } from '../../../lib/theme'
import { layoutServerBoard } from './boardLayout'
import { createWorld, createRegion, createAz, createServer } from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'
import { compileWorld } from '../../../lib/world/compileWorld'
import type { RenderScope, FramePayload, VisualParticle } from '../../../lib/worldEngine/types'

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

// ─── Path-length caching + theme-aware protocol color (audit ISSUE-016) ──────
describe('PacketLayer — path length cache + protocol color (audit ISSUE-016)', () => {
  let fillStyleHistory: string[]
  let getTotalLengthCalls: number
  let restoreCanvas: () => void
  let restoreSvg: () => void

  beforeEach(() => {
    useSimulationStore.setState({ running: false })
    useUiStore.setState({ themeMode: 'dark' })
    fillStyleHistory = []
    getTotalLengthCalls = 0

    const fakeCtx = {
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      set fillStyle(v: string) { fillStyleHistory.push(v) },
      get fillStyle() { return fillStyleHistory[fillStyleHistory.length - 1] ?? '' },
      strokeStyle: '', lineWidth: 0,
    }
    const origGetContext = HTMLCanvasElement.prototype.getContext
    // @ts-expect-error — test stub, not a full CanvasRenderingContext2D
    HTMLCanvasElement.prototype.getContext = () => fakeCtx
    restoreCanvas = () => { HTMLCanvasElement.prototype.getContext = origGetContext }

    // jsdom doesn't expose SVGPathElement as a global in this setup, so grab the prototype off a
    // real created element instead of referencing the class by name.
    const proto = Object.getPrototypeOf(document.createElementNS('http://www.w3.org/2000/svg', 'path')) as {
      getTotalLength?: () => number
      getPointAtLength?: (len: number) => DOMPoint
    }
    const origGetTotalLength = proto.getTotalLength
    const origGetPointAtLength = proto.getPointAtLength
    proto.getTotalLength = () => { getTotalLengthCalls++; return 100 }
    proto.getPointAtLength = () => ({ x: 1, y: 2 } as DOMPoint)
    restoreSvg = () => {
      proto.getTotalLength = origGetTotalLength
      proto.getPointAtLength = origGetPointAtLength
    }
  })

  afterEach(() => { restoreCanvas(); restoreSvg() })

  // Drives PacketLayer with a manually-captured onFrame callback (bypassing attachRenderer's real
  // implementation) so a test can push frames on demand without running the engine.
  function drive(themeMode: 'dark' | 'light' = 'dark') {
    useUiStore.setState({ themeMode })
    let onFrame: ((p: FramePayload) => void) | null = null
    const attach = vi.fn((_scope: RenderScope, cb: (p: FramePayload) => void) => { onFrame = cb; return vi.fn() })
    useSimulationStore.setState({ running: true, attachRenderer: attach as never })
    const { layout: l, serverId } = layout()
    render(<PacketLayer serverId={serverId} layout={l} />)
    // fromId===toId===nicId is a valid (if degenerate) traced pair in an empty-world layout (no
    // resident chips to target) — anchorFor(nicId) always resolves, so tracePath returns real
    // geometry instead of `''`, and pointAt actually reaches getTotalLength/getPointAtLength.
    const nicId = `nic:${serverId}`
    const particle = (protocol: VisualParticle['protocol']): VisualParticle => ({
      id: 0, fromId: nicId, toId: nicId, progress: 0.5, protocol, blocked: false, colorHint: null, packetId: null,
    })
    return {
      push: (particles: VisualParticle[]) => onFrame!({ simMs: 0, particles, arcs: [] }),
      particle,
    }
  }

  it('caches getTotalLength across frames for the same fromId/toId pair', () => {
    const { push, particle } = drive()
    push([particle('http')])
    push([particle('http')])
    expect(getTotalLengthCalls).toBe(1)   // computed once at cache-population, not per frame
  })

  it('draws the dark-mode CATEGORY_COLORS accent for each protocol', () => {
    const { push, particle } = drive('dark')
    push([particle('http'), particle('db'), particle('event'), particle('stream')])
    expect(fillStyleHistory).toEqual([
      CATEGORY_COLORS.compute.accent,
      CATEGORY_COLORS.storage.accent,
      CATEGORY_COLORS.messaging.accent,
      CATEGORY_COLORS.network.accent,
    ])
  })

  it('draws the light-mode CATEGORY_COLORS foreground for each protocol', () => {
    const { push, particle } = drive('light')
    push([particle('http'), particle('db'), particle('event'), particle('stream')])
    expect(fillStyleHistory).toEqual([
      CATEGORY_COLORS.compute.foreground.light,
      CATEGORY_COLORS.storage.foreground.light,
      CATEGORY_COLORS.messaging.foreground.light,
      CATEGORY_COLORS.network.foreground.light,
    ])
  })

  it('an authored colorHint still wins over the protocol color, in either theme', () => {
    const { push, particle } = drive('light')
    push([{ ...particle('http'), colorHint: '#ff00ff' }])
    expect(fillStyleHistory).toEqual(['#ff00ff'])
  })
})
