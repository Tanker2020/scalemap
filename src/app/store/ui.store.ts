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
export type PanelTab = 'topology' | 'blueprints' | 'placements' | 'connections' | 'traffic' | 'routes' | 'analysis' | 'events' | 'cost' | 'config'

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
  setSelectedServerId: (id) => set({ selectedServerId: id }),
}))
