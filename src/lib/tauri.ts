import { tauriMock, type RecentFile } from './tauriMock'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri) {
    const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
    return tauriInvoke<T>(cmd, args)
  }
  const fn = (tauriMock as Record<string, (...a: unknown[]) => Promise<unknown>>)[cmd]
  if (!fn) throw new Error(`Unknown command: ${cmd}`)
  const argValues = args ? Object.values(args) : []
  return fn(...argValues) as Promise<T>
}

export const saveDiagram = (path: string, data: string) =>
  invoke<void>('save_diagram', { path, data })

export const loadDiagram = (path: string) =>
  invoke<string>('load_diagram', { path })

export const getRecentFiles = () =>
  invoke<RecentFile[]>('get_recent_files')

export const openFileDialog = () =>
  invoke<string | null>('open_file_dialog')

export const saveFileDialog = () =>
  invoke<string | null>('save_file_dialog')

export type { RecentFile }
