// src/app/world/ServerView.interaction.test.tsx
// @vitest-environment jsdom
// Integration coverage for T6's selection model that InspectorRail.test.tsx (component-level,
// props driven directly) can't exercise on its own: (1) the Esc capture-phase mechanism that
// clears ServerView's own selection state without letting WorldShell's bubble-phase Escape
// handler navigate up a level, and (2) hover-driven cross-highlight (D8) flowing from a
// ServiceChip mouseEnter, through ServerBoard, down into sibling chips and HardwarePlatform's
// RAM reservoir.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ServerView } from './ServerView'
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { useSimulationStore } from '../store/simulation.store'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
} from '../../lib/world/factories'
import { getPreset } from '../../lib/world/instanceCatalog'
import type { WorldDoc } from '../../lib/world/types'

beforeAll(() => {
  // jsdom lacks ResizeObserver, which ServerBoard uses for scale-to-fit (same polyfill as
  // ServerBoard.test.tsx).
  class RO { observe() {} unobserve() {} disconnect() {} }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO
})

function seed(configure: (doc: WorldDoc, serverId: string) => void) {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const az = createAz(region.id, 'us-east-1a')
  const server = createServer(az.id, getPreset('vps-medium')!)
  doc.regions[region.id] = region; doc.azs[az.id] = az; doc.servers[server.id] = server
  configure(doc, server.id)
  useWorldStore.setState({ doc, history: [], future: [] })
  useNavStore.setState({ level: 'server', regionId: region.id, azId: az.id, serverId: server.id })
  useSimulationStore.setState({ running: false, latestBatch: null, scrubBatch: null })
  return { doc, serverId: server.id }
}

describe('ServerView interaction (selection model + Esc + cross-highlight)', () => {
  beforeEach(() => {
    useWorldStore.getState().newWorld()
    useNavStore.setState({ level: 'globe', regionId: null, azId: null, serverId: null })
  })

  it('esc clears selection without changing nav level', () => {
    // Mirrors WorldShell's real bubble-phase Escape handler verbatim (WorldShell.tsx:42-66):
    // bail if defaultPrevented, bail on input-like targets, else nav.up(). Registered on window
    // BEFORE ServerView mounts (so a bubble-phase listener here would fire first if registration
    // order — not capture phase — were what determined the outcome). This proves capture phase,
    // not mount/registration order, is what stops the nav-up call.
    const worldShellLikeHandler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return
      if (e.key === 'Escape') useNavStore.getState().up()
    }
    window.addEventListener('keydown', worldShellLikeHandler)

    try {
      seed(() => {})
      render(<ServerView />)

      // Establish a selection via the real UI (click the firewall gate) — InspectorRail should
      // switch off its empty-selection hint.
      const gate = document.querySelector('[data-firewall]') as HTMLElement
      expect(gate).toBeTruthy()
      fireEvent.click(gate)
      expect(screen.getByText(/first match wins/i)).toBeInTheDocument()

      // Dispatch on a descendant of window (document.body), not on window itself, so the event
      // genuinely traverses window's capture phase (on the way down) before window's bubble
      // phase (on the way back up) — dispatching directly on window would collapse both phases
      // into "target phase" and make the assertion pass/fail on registration order instead of
      // capture-vs-bubble, defeating the point of this test.
      fireEvent.keyDown(document.body, { key: 'Escape' })

      // WorldShell's bubble handler must have seen defaultPrevented and skipped nav.up().
      expect(useNavStore.getState().level).toBe('server')
      // Selection itself was cleared by ServerView's own capture-phase handler.
      expect(screen.getByText(/click any element/i)).toBeInTheDocument()
    } finally {
      window.removeEventListener('keydown', worldShellLikeHandler)
    }
  })

  it('hovering a chip dims unrelated chips and highlights its ram stratum', () => {
    seed((d, sid) => {
      const web = createBlueprint('web', 0); d.blueprints[web.id] = web
      const cache = createBlueprint('cache', 1); d.blueprints[cache.id] = cache
      const webPl = createPlacement(web.id, sid); d.placements[webPl.id] = webPl
      const cachePl = createPlacement(cache.id, sid); d.placements[cachePl.id] = cachePl
    })
    render(<ServerView />)

    const webChip = screen.getByText('web').closest('[data-chip]') as HTMLElement
    const cacheChip = screen.getByText('cache').closest('[data-chip]') as HTMLElement
    expect(webChip).toBeTruthy()
    expect(cacheChip).toBeTruthy()

    fireEvent.mouseEnter(webChip)

    expect(webChip.style.opacity).toBe('1')
    expect(cacheChip.style.opacity).toBe('0.45')

    // HardwarePlatform's RAM reservoir: at-rest (no live metrics), strata render in resident
    // order (web, then cache) ahead of the always-present os/cache remainder stratum.
    const strata = screen.getAllByTestId('ram-stratum')
    expect(strata[0].style.opacity).toBe('1')      // web — hovered, highlighted
    expect(strata[1].style.opacity).toBe('0.45')   // cache — unrelated, dimmed
  })
})
