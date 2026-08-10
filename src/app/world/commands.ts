// Command palette (⌘K) content — the list of commands the palette filters/renders. Built OVER
// keymap.ts's Binding shape (reuses its `group`/`when` type aliases rather than redefining them,
// task 16 brief) and over entityNav.ts's neutral navigateToEntity/entityLabel helpers (the SAME
// resolution logic AnalysisTab/AiReviewSection already use to jump the nav store from an entity
// id — the palette's dynamic "Go to <entity>" commands are a third consumer, not a fork).
//
// PaletteContext is a plain bag of function references/values, mirroring keymap.ts's
// CommandContext data-flow style: WorldShell builds one fresh ctx object per render (or per
// palette-open) from store getters, the same way App.tsx's installKeymap getCtx() does — no new
// data-flow style invented for this surface.
import { navigateToEntity, entityLabel, type NavApi } from './entityNav'
import { useSimulationStore } from '../store/simulation.store'
import type { WorldDoc, CompiledWorld } from '../../lib/world/types'
import type { Binding } from '../keymap'
import type { PanelTab } from '../store/ui.store'

export interface PaletteContext {
  doc: WorldDoc
  compiled: CompiledWorld
  nav: NavApi
  // The currently-focused server (nav.store's serverId, when at server level) — the implicit
  // target of a server-scoped chaos command like "Kill focused server". null when nothing is
  // focused (globe/region/az level, or no server visited yet); such commands are then a no-op.
  focusedServerId: string | null
  // Both addServer/addRegion take real args in world.store (`addServer(azId, preset)` /
  // `addRegion(catalogId)` — there is no bare "quick add" action). WorldShell supplies the
  // no-arg closures the palette needs (defaulting to the first free catalog region / first AZ +
  // a standard preset), matching how TopologyPanel's own "+ Region"/AddServiceForm affordances
  // pick a target today rather than inventing a new default-selection policy here.
  addServer: () => void
  addRegion: () => void
  undo: () => void
  redo: () => void
  setPendingTab: (tab: PanelTab) => void
}

export interface PaletteCommand {
  id: string
  label: string
  group: Binding['group']
  when?: Binding['when']
  run: () => void
}

export function buildCommands(ctx: PaletteContext): PaletteCommand[] {
  const staticCommands: PaletteCommand[] = [
    { id: 'add-server', label: 'Add server', group: 'author', when: 'stopped', run: ctx.addServer },
    { id: 'add-region', label: 'Add region', group: 'author', when: 'stopped', run: ctx.addRegion },
    { id: 'undo', label: 'Undo', group: 'author', when: 'stopped', run: ctx.undo },
    { id: 'redo', label: 'Redo', group: 'author', when: 'stopped', run: ctx.redo },
    { id: 'goto-cost', label: 'Go to Cost tab', group: 'view', when: 'always', run: () => ctx.setPendingTab('cost') },
    { id: 'goto-compare', label: 'Go to Compare tab', group: 'view', when: 'always', run: () => ctx.setPendingTab('compare') },
    {
      id: 'inject-fault-focused-down',
      label: 'Kill focused server',
      group: 'chaos',
      when: 'running',
      run: () => {
        if (!ctx.focusedServerId) return
        useSimulationStore.getState().setFault('server', ctx.focusedServerId, { kind: 'down' })
      },
    },
  ]

  const entityCommands: PaletteCommand[] = [
    ...Object.keys(ctx.doc.regions).map(id => ({
      id: `nav-${id}`,
      label: `Go to ${entityLabel(id, ctx.doc, ctx.compiled)}`,
      group: 'navigate' as const,
      when: 'always' as const,
      run: () => navigateToEntity(id, ctx.doc, ctx.compiled, ctx.nav),
    })),
    ...Object.keys(ctx.doc.servers).map(id => ({
      id: `nav-${id}`,
      label: `Go to ${entityLabel(id, ctx.doc, ctx.compiled)}`,
      group: 'navigate' as const,
      when: 'always' as const,
      run: () => navigateToEntity(id, ctx.doc, ctx.compiled, ctx.nav),
    })),
  ]

  return [...staticCommands, ...entityCommands]
}
