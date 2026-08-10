// src/app/store/ui.store.ts
// Trimmed 2026-07-08 (Phase 2 Task 17): every field except themeMode was read only by legacy
// canvas/simulation/sidebar/toolbar/dock/reports UI, all deleted this task (verified by grep —
// see SKELETON CONCERN #6). If a future phase wants a "focus this node" pulse or similar, re-add
// the relevant field then rather than resurrecting the whole old surface.
// 2026-07-10 (Polish 1 Task 6): gained `pendingPanelTab` — a one-shot "open WorldPanel on this
// tab" signal set by the home screen's examples vault (the teaching card wants to land straight
// on Analysis) and consumed once by WorldPanel's mount effect. Additive; themeMode untouched.
// 2026-07-10 (Polish 2 Task 3): gained `sceneOverlay` — the single open in-scene overlay card
// (region pin or population marker tap), read by the globe layers and cleared on Escape/
// click-away/unmount. Additive; nothing above touched.
// 2026-07-11 (Polish 4 Task 1, spec D1): gained `selectedServerId` + `setSelectedServerId` —
// LIFTS the AZ floor's (`DatacenterFloor.tsx`) formerly-local `selectedServerId` useState into
// shared state, so "floor selection and dock scope are the SAME state: select there, configure
// here." `PanelTab` gained `'config'` (the non-world scopes' shared entity-config tab; see
// `app/world/dock/scope.ts`'s `scopeTabs`). Nothing else changed.
import { create } from 'zustand'
import type { ServerId } from '../../lib/world/types'

// 2026-07-18 (node-model Phase 2): gained 'connections' — the service-dependency graph was a
// header-toggled overlay, reachable only from a button that looked like a mode switch. It is now
// a first-class world tab whose dock body lists every edge (source → target, port, status) and
// opens the full-screen canvas on demand.
// 2026-07-19 (node-model Phase 5): dropped 'blueprints' and 'placements' — the generic-blueprint
// authoring model was retired. Services are now authored via the VPS door (AddServiceForm) + the
// Connections tab; managed cloud appliances get their own 'managed' tab (ManagedPanel).
// 2026-07-28 (packet library): gained 'packets' and 'blueprints'. Packets are the reusable
// payload definitions bound to service→service edges (the internal-hop sibling of 'routes').
// 'blueprints' RETURNS — the Phase-5 removal left ServiceBlueprint, a genuinely global reusable
// entity, discoverable only through a host already running it; this is the missing library
// surface, not a revival of the retired generic-blueprint authoring model (the VPS door remains
// the way a service gets onto a host).
// 2026-08-02 (FEAT-003 Task 20): gained 'scenario' — the scenario-timeline authoring tab
// (ScenarioPanel.tsx). World scope only, alongside routes/traffic; configuration, not a live
// chaos surface, so it rides the ambient WorldPanel fieldset normally (disabled while running).
// 2026-08-05 (FEAT-009 Task 5): gained 'signals' — the per-instance/AZ/region metric small-
// multiples tab (SignalsPanel.tsx), reachable at EVERY scope (unlike 'scenario', which is
// world-only) since it reads the replay ring scoped to wherever the dock currently is.
// 2026-08-09 (wave 5 task 5): gained 'compare' — the A/B baseline-comparison tab, world scope
// only (a comparison is a whole-world statement).
export type PanelTab = 'topology' | 'blueprints' | 'packets' | 'managed' | 'connections' | 'traffic' | 'routes' | 'scenario' | 'signals' | 'analysis' | 'events' | 'cost' | 'compare' | 'config'

export interface SceneOverlayTarget { kind: 'region' | 'population'; id: string }

interface UiStore {
  themeMode: 'dark' | 'light'
  setThemeMode: (mode: 'dark' | 'light') => void
  pendingPanelTab: PanelTab | null
  setPendingPanelTab: (tab: PanelTab | null) => void
  sceneOverlay: SceneOverlayTarget | null
  setSceneOverlay: (o: SceneOverlayTarget | null) => void
  selectedServerId: ServerId | null
  setSelectedServerId: (id: ServerId | null) => void
  // 2026-08-09 (wave 5 ergonomics, task 17): the general multi-select surface for the AZ floor
  // (click/⌘-click/⇧-click/marquee). `selectedServerId` is NOT a parallel concept — it is the
  // single-select DEGENERATE CASE of this set, kept in sync by every setter below so
  // `dock/scope.ts`'s `deriveScope` (which reads only `selectedServerId`) keeps resolving
  // exactly as it did before this task: a 1-member selection narrows the dock to that server,
  // a 0- or 2+-member selection widens it back to AZ scope, same as an explicit
  // `setSelectedServerId(null)` always has.
  selectedEntityIds: Set<string>
  setSelectedEntityIds: (ids: Set<string>) => void
  toggleSelectedEntity: (id: string) => void
  selectEntityRange: (ids: string[]) => void
  clearSelection: () => void
  // 2026-08-09 (wave 5 ergonomics, task 15): lifted out of WorldShell's local useState so the
  // app-level keymap.ts registry (installed once, above WorldShell) can read/toggle the SAME
  // "armed" globe traffic-placement mode Escape needs to disarm. GlobeView's own HUD button and
  // WorldPanel's TrafficPanel toggle both flip this one boolean, same as before the lift.
  placeMode: boolean
  setPlaceMode: (v: boolean | ((prev: boolean) => boolean)) => void
  // 2026-08-09 (wave 5 ergonomics, task 16): the command palette's open/closed state, lifted the
  // SAME way placeMode was one task earlier — keymap.ts's app-level ⌘K binding is installed in
  // App.tsx, above WorldShell, so its `run` needs a store-backed toggle it can reach; a
  // WorldShell-local useState would be invisible to that closure.
  paletteOpen: boolean
  setPaletteOpen: (v: boolean | ((prev: boolean) => boolean)) => void
  // 2026-08-09 (wave 5 ergonomics, task 19): the keyboard-map overlay's open/closed state, lifted
  // the SAME way paletteOpen was one task earlier — keymap.ts's app-level `?`/⌘/ bindings are
  // installed in App.tsx, above WorldShell, so their `run` needs a store-backed toggle to reach.
  helpOpen: boolean
  setHelpOpen: (v: boolean | ((prev: boolean) => boolean)) => void
}

export const useUiStore = create<UiStore>((set) => ({
  themeMode: (localStorage.getItem('scalemap-theme-mode') as 'dark' | 'light') ?? 'dark',
  setThemeMode: (mode) => {
    localStorage.setItem('scalemap-theme-mode', mode)
    set({ themeMode: mode })
  },
  pendingPanelTab: null,
  setPendingPanelTab: (tab) => set({ pendingPanelTab: tab }),
  sceneOverlay: null,
  setSceneOverlay: (o) => set({ sceneOverlay: o }),
  selectedServerId: null,
  // Kept in sync with selectedEntityIds (task 17) — a single-click-to-inspect flow elsewhere in
  // the app (that doesn't go through the multi-select handlers below) must not leave the two
  // disagreeing: selecting one id collapses selectedEntityIds to that single member; clearing
  // collapses it to empty, same as clearSelection().
  setSelectedServerId: (id) => set({ selectedServerId: id, selectedEntityIds: id ? new Set([id]) : new Set() }),
  selectedEntityIds: new Set<string>(),
  setSelectedEntityIds: (ids) => set({
    selectedEntityIds: ids,
    selectedServerId: ids.size === 1 ? [...ids][0] : null,
  }),
  toggleSelectedEntity: (id) => set(s => {
    const next = new Set(s.selectedEntityIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return { selectedEntityIds: next, selectedServerId: next.size === 1 ? [...next][0] : null }
  }),
  selectEntityRange: (ids) => set({
    selectedEntityIds: new Set(ids),
    selectedServerId: ids.length === 1 ? ids[0] : null,
  }),
  clearSelection: () => set({ selectedEntityIds: new Set(), selectedServerId: null }),
  placeMode: false,
  setPlaceMode: (v) => set(s => ({ placeMode: typeof v === 'function' ? v(s.placeMode) : v })),
  paletteOpen: false,
  setPaletteOpen: (v) => set(s => ({ paletteOpen: typeof v === 'function' ? v(s.paletteOpen) : v })),
  helpOpen: false,
  setHelpOpen: (v) => set(s => ({ helpOpen: typeof v === 'function' ? v(s.helpOpen) : v })),
}))
