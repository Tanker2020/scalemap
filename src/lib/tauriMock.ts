const RECENT_FILES_KEY = 'scalemap:recent_files'
const DIAGRAMS_KEY = 'scalemap:diagram:'
const LLM_SETTINGS_KEY = 'scalemap:llm_settings'

export interface RecentFile {
  path: string
  name: string
  modified: string
}

interface StoredLlmSettings { base_url: string; api_key: string; model: string }

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

  // Browser-dev only, mirrors llm_settings.json's snake_case shape. D6: this stores the settings
  // object to localStorage for local dev convenience ONLY — it must never be reached from
  // world.store/serializer (a completely separate persistence path — see saveWorld/serializer.ts,
  // untouched by this phase), and must never console.* the key.
  async save_llm_settings(settings: StoredLlmSettings): Promise<void> {
    localStorage.setItem(LLM_SETTINGS_KEY, JSON.stringify(settings))
  },

  async load_llm_settings(): Promise<StoredLlmSettings> {
    try {
      return JSON.parse(localStorage.getItem(LLM_SETTINGS_KEY) ?? '')
    } catch {
      return { base_url: '', api_key: '', model: '' }
    }
  },

  // Browser-dev only: a direct fetch() to whatever endpoint the user configured — fine for
  // Ollama/LM Studio/local stubs where the user controls CORS (real desktop builds go through
  // the Rust llm_chat command instead, which has no CORS restriction).
  async llm_chat(baseUrl: string, apiKey: string, body: string): Promise<string> {
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body,
    })
    return r.text()
  },

  // Browser-dev event log: same command surface as the Rust SQLite (WAL) log, held in memory
  // (NOT localStorage — a long run's volume would blow its quota). Semantics mirror
  // commands.rs: per-run monotonic seq, newest-first tail with an exclusive beforeSeq cursor,
  // newest-first run summaries, clear-all.
  async event_log_begin_run(worldName: string): Promise<number> {
    const id = mockEventLogNextRun++
    mockEventLogRuns.set(id, { startedAt: new Date().toISOString(), worldName, list: [] })
    return id
  },

  async event_log_append(runId: number, events: MockLoggedEvent[]): Promise<number> {
    const run = mockEventLogRuns.get(runId)
    if (!run) throw new Error(`unknown run: ${runId}`)
    for (const e of events) run.list.push({ ...e, seq: run.list.length + 1 })
    return run.list.length
  },

  async event_log_tail(
    runId: number, beforeSeq: number | null, limit: number,
  ): Promise<(MockLoggedEvent & { seq: number })[]> {
    const list = mockEventLogRuns.get(runId)?.list ?? []
    const cursor = beforeSeq ?? Number.MAX_SAFE_INTEGER
    return list.filter(r => r.seq < cursor).slice(-limit).reverse()
  },

  async event_log_runs(): Promise<{ id: number; startedAt: string; worldName: string; events: number }[]> {
    return [...mockEventLogRuns.entries()]
      .map(([id, r]) => ({ id, startedAt: r.startedAt, worldName: r.worldName, events: r.list.length }))
      .sort((a, b) => b.id - a.id)
  },

  async event_log_clear(): Promise<void> {
    mockEventLogRuns.clear()
  },
}

interface MockLoggedEvent {
  id: string
  simMs: number
  kind: string
  severity: string
  message: string
  affected: string[]
}

interface MockEventLogRun {
  startedAt: string
  worldName: string
  list: (MockLoggedEvent & { seq: number })[]
}

const mockEventLogRuns = new Map<number, MockEventLogRun>()
let mockEventLogNextRun = 1
