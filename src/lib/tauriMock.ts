const RECENT_FILES_KEY = 'scalemap:recent_files'
const DIAGRAMS_KEY = 'scalemap:diagram:'

export interface RecentFile {
  path: string
  name: string
  modified: string
}

function getRecentFiles(): RecentFile[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_FILES_KEY) ?? '[]')
  } catch {
    return []
  }
}

function addToRecent(path: string) {
  const name = path.split('/').pop() ?? path
  const entry: RecentFile = { path, name, modified: new Date().toISOString() }
  const existing = getRecentFiles().filter(f => f.path !== path)
  localStorage.setItem(RECENT_FILES_KEY, JSON.stringify([entry, ...existing].slice(0, 10)))
}

export const tauriMock = {
  async save_diagram(path: string, data: string): Promise<void> {
    localStorage.setItem(DIAGRAMS_KEY + path, data)
    addToRecent(path)
  },

  async load_diagram(path: string): Promise<string> {
    const data = localStorage.getItem(DIAGRAMS_KEY + path)
    if (!data) throw new Error(`File not found: ${path}`)
    return data
  },

  async get_recent_files(): Promise<RecentFile[]> {
    return getRecentFiles()
  },

  async open_file_dialog(): Promise<string | null> {
    const files = getRecentFiles()
    if (files.length === 0) return null
    return files[0].path
  },

  async save_file_dialog(): Promise<string | null> {
    return `diagram-${Date.now()}.scalemap`
  },
}
