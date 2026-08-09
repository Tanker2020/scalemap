// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { buildCommands, type PaletteContext } from './commands'
import { createWorld, createRegion } from '../../lib/world/factories'
import { compileWorld } from '../../lib/world/compileWorld'
import type { WorldDoc, CompiledWorld } from '../../lib/world/types'

function fakePaletteContext(overrides: Partial<PaletteContext>): PaletteContext {
  const doc = overrides.doc ?? createWorld()
  const compiled = overrides.compiled ?? compileWorld(doc)
  return {
    doc,
    compiled,
    nav: { goRegion: vi.fn(), goAz: vi.fn(), goServer: vi.fn() },
    focusedServerId: null,
    addServer: vi.fn(),
    addRegion: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    setPendingTab: vi.fn(),
    ...overrides,
  }
}

describe('buildCommands', () => {
  it('includes dynamic entity-navigation commands built from entityNav', () => {
    const doc: WorldDoc = createWorld()
    const region = createRegion('us-east-1')
    doc.regions[region.id] = region
    const compiled: CompiledWorld = compileWorld(doc)
    const ctx = fakePaletteContext({ doc, compiled })
    const commands = buildCommands(ctx)
    expect(commands.some(c => c.label.includes('us-east'))).toBe(true)
  })

  it('chaos commands are when: running, author commands are when: stopped', () => {
    const commands = buildCommands(fakePaletteContext({}))
    const addServer = commands.find(c => c.id === 'add-server')!
    expect(addServer.when).toBe('stopped')
    const injectFault = commands.find(c => c.id.startsWith('inject-fault'))
    expect(injectFault?.when).toBe('running')
  })

  it('always includes the static author/view commands', () => {
    const commands = buildCommands(fakePaletteContext({}))
    expect(commands.find(c => c.id === 'add-region')).toBeTruthy()
    expect(commands.find(c => c.id === 'undo')).toBeTruthy()
    expect(commands.find(c => c.id === 'redo')).toBeTruthy()
    expect(commands.find(c => c.id === 'goto-cost')).toBeTruthy()
    expect(commands.find(c => c.id === 'goto-compare')).toBeTruthy()
  })

  it('runs the underlying ctx function when a static command runs', () => {
    const ctx = fakePaletteContext({})
    const commands = buildCommands(ctx)
    commands.find(c => c.id === 'add-server')!.run()
    expect(ctx.addServer).toHaveBeenCalled()
  })

  it('dynamic nav commands call navigateToEntity with the entity id', () => {
    const doc: WorldDoc = createWorld()
    const region = createRegion('us-east-1')
    doc.regions[region.id] = region
    const compiled: CompiledWorld = compileWorld(doc)
    const goRegion = vi.fn()
    const ctx = fakePaletteContext({ doc, compiled, nav: { goRegion, goAz: vi.fn(), goServer: vi.fn() } })
    const commands = buildCommands(ctx)
    const navCmd = commands.find(c => c.id === `nav-${region.id}`)!
    navCmd.run()
    expect(goRegion).toHaveBeenCalledWith(region.id)
  })
})
