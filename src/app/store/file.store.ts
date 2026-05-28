import { create } from 'zustand'
import type { RecentFile } from '../../lib/tauri'

interface FileStore {
  filePath: string | null
  fileName: string | null
  dirty: boolean
  lastAutosave: Date | null
  recentFiles: RecentFile[]
  showHome: boolean

  setFilePath: (path: string | null) => void
  setDirty: (dirty: boolean) => void
  setRecentFiles: (files: RecentFile[]) => void
  setShowHome: (show: boolean) => void
  markSaved: (path?: string) => void
  setLastAutosave: (date: Date) => void
}

export const useFileStore = create<FileStore>((set) => ({
  filePath: null,
  fileName: null,
  dirty: false,
  lastAutosave: null,
  recentFiles: [],
  showHome: true,

  setFilePath: (path) =>
    set({ filePath: path, fileName: path ? (path.split('/').pop() ?? path) : null }),

  setDirty: (dirty) => set({ dirty }),

  setRecentFiles: (files) => set({ recentFiles: files }),

  setShowHome: (show) => set({ showHome: show }),

  markSaved: (path?) =>
    set(s => ({
      filePath: path ?? s.filePath,
      fileName: path ? (path.split('/').pop() ?? path) : s.fileName,
      dirty: false,
    })),

  setLastAutosave: (date) => set({ lastAutosave: date }),
}))
