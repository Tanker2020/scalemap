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
import { create } from 'zustand'

export type PanelTab = 'topology' | 'blueprints' | 'placements' | 'traffic' | 'analysis' | 'events' | 'cost'

export interface SceneOverlayTarget { kind: 'region' | 'population'; id: string }

interface UiStore {
  themeMode: 'dark' | 'light'
  setThemeMode: (mode: 'dark' | 'light') => void
  pendingPanelTab: PanelTab | null
  setPendingPanelTab: (tab: PanelTab | null) => void
  sceneOverlay: SceneOverlayTarget | null
  setSceneOverlay: (o: SceneOverlayTarget | null) => void
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
}))
