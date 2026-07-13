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

export interface LlmSettings {
  baseUrl: string
  apiKey: string
  model: string
}

// Field names cross the Rust boundary as snake_case: `LlmSettings`' struct FIELDS go through
// serde with their Rust names (Tauri v2 only camelCases command SCALAR ARG names — e.g.
// `base_url` <-> `baseUrl` — never struct field names; verified against tauri-macros' actual
// casing behavior, see this task's grounding notes). These two wrappers are the ONLY place that
// snake<->camel mapping happens; every other caller in the app uses the camelCase LlmSettings
// shape below, never the raw Rust field names.
export async function saveLlmSettings(settings: LlmSettings): Promise<void> {
  return invoke<void>('save_llm_settings', {
    settings: { base_url: settings.baseUrl, api_key: settings.apiKey, model: settings.model },
  })
}

export async function loadLlmSettings(): Promise<LlmSettings> {
  const r = await invoke<{ base_url: string; api_key: string; model: string }>('load_llm_settings')
  return { baseUrl: r.base_url ?? '', apiKey: r.api_key ?? '', model: r.model ?? '' }
}

export async function llmChat(baseUrl: string, apiKey: string, body: string): Promise<string> {
  return invoke<string>('llm_chat', { baseUrl, apiKey, body })
}

// ─── Simulation event log ─────────────────────────────────────────────────────────
// Durable, unbounded engine-event history: SQLite (WAL) at <app_data_dir>/events.db on
// desktop, an in-memory map in browser dev (tauriMock). The store keeps only a small live
// window in memory; EVERY event is spilled here in 1 Hz batches (user decision 2026-07-12:
// no hard caps — overflow goes to disk). Struct fields cross the boundary camelCased
// (serde rename on the Rust side); command ARG names are camelCased by Tauri itself.

/** Wire shape of one event — structurally identical to `EngineEvent` (worldEngine/types.ts). */
export interface LoggedEngineEvent {
  id: string
  simMs: number
  kind: string
  severity: string
  message: string
  affected: string[]
}

/** A stored event plus its per-run sequence number (pagination cursor for eventLogTail). */
export interface LoggedEventRow extends LoggedEngineEvent {
  seq: number
}

export const eventLogBeginRun = (worldName: string) =>
  invoke<number>('event_log_begin_run', { worldName })

/** Appends a batch (one SQLite transaction); resolves to the run's durable total so far. */
export const eventLogAppend = (runId: number, events: LoggedEngineEvent[]) =>
  invoke<number>('event_log_append', { runId, events })

/** Newest-first page of a run's events; pass the last row's seq as beforeSeq to page back. */
export const eventLogTail = (runId: number, beforeSeq: number | null, limit: number) =>
  invoke<LoggedEventRow[]>('event_log_tail', { runId, beforeSeq, limit })

/** One row per Simulate press, newest-first, with its persisted event count. */
export interface EventLogRun {
  id: number
  startedAt: string   // RFC-3339
  worldName: string
  events: number
}

export const eventLogRuns = () =>
  invoke<EventLogRun[]>('event_log_runs')

/** Deletes ALL persisted history (every run, every event) and reclaims the disk space. */
export const eventLogClear = () =>
  invoke<void>('event_log_clear')
