// src/app/store/ui.store.ts
// Trimmed 2026-07-08 (Phase 2 Task 17): every field except themeMode was read only by legacy
// canvas/simulation/sidebar/toolbar/dock/reports UI, all deleted this task (verified by grep —
// see SKELETON CONCERN #6). If a future phase wants a "focus this node" pulse or similar, re-add
// the relevant field then rather than resurrecting the whole old surface.
import { create } from 'zustand'

interface UiStore {
  themeMode: 'dark' | 'light'
  setThemeMode: (mode: 'dark' | 'light') => void
}

export const useUiStore = create<UiStore>((set) => ({
  themeMode: (localStorage.getItem('scalemap-theme-mode') as 'dark' | 'light') ?? 'dark',
  setThemeMode: (mode) => {
    localStorage.setItem('scalemap-theme-mode', mode)
    set({ themeMode: mode })
  },
}))
