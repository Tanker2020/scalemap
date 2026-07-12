//! Tauri commands backing the frontend file shim (`src/lib/tauri.ts`).
//!
//! These mirror the localStorage mock in `src/lib/tauriMock.ts` but use real
//! filesystem operations so the desktop build reads/writes actual `.scalemap`
//! files. The recent-files list is persisted as JSON in the app data directory.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

const RECENT_FILES_FILE: &str = "recent_files.json";
const MAX_RECENT: usize = 10;
const DIAGRAM_FILTER_NAME: &str = "Scalemap Diagram";
const DIAGRAM_EXTENSION: &str = "scalemap";

/// One entry in the recent-files list. Shape matches `RecentFile` in
/// `src/lib/tauriMock.ts`: `{ path, name, modified }` where `modified` is an
/// ISO-8601 string parseable by JavaScript's `new Date(...)`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentFile {
    pub path: String,
    pub name: String,
    pub modified: String,
}

/// `<app_data_dir>/recent_files.json`, creating the data dir if missing.
fn recent_files_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("could not create app data dir: {e}"))?;
    Ok(dir.join(RECENT_FILES_FILE))
}

/// Read the recent-files list. Returns an empty list on any error (missing
/// file, corrupt JSON) so the home screen still loads.
fn read_recent(app: &AppHandle) -> Vec<RecentFile> {
    let Ok(path) = recent_files_path(app) else {
        return Vec::new();
    };
    let Ok(raw) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn write_recent(app: &AppHandle, files: &[RecentFile]) -> Result<(), String> {
    let path = recent_files_path(app)?;
    let raw = serde_json::to_string_pretty(files).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| format!("could not write recent files: {e}"))
}

/// Final path component, e.g. `/home/u/api.scalemap` -> `api.scalemap`.
/// Uses the platform's path rules (handles both `/` and `\` on Windows).
fn file_name_of(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// Insert/refresh `path` at the front of the recent list (most-recent-first,
/// capped at `MAX_RECENT`). Mirrors `addToRecent` in the mock. Best-effort:
/// a failure to persist must not fail the save itself.
fn touch_recent(app: &AppHandle, path: &str) {
    let entry = RecentFile {
        path: path.to_string(),
        name: file_name_of(path),
        modified: chrono::Utc::now().to_rfc3339(),
    };
    let mut files = read_recent(app);
    files.retain(|f| f.path != path);
    files.insert(0, entry);
    files.truncate(MAX_RECENT);
    let _ = write_recent(app, &files);
}

/// Write `data` to `path` and record it in the recent-files list.
#[tauri::command]
pub fn save_diagram(app: AppHandle, path: String, data: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("could not create directory for '{path}': {e}"))?;
        }
    }
    fs::write(&path, data).map_err(|e| format!("could not save diagram '{path}': {e}"))?;
    touch_recent(&app, &path);
    Ok(())
}

/// Read the contents of `path`. Errors if the file does not exist, matching
/// the mock's "File not found" behaviour.
#[tauri::command]
pub fn load_diagram(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("could not load diagram '{path}': {e}"))
}

#[tauri::command]
pub fn get_recent_files(app: AppHandle) -> Vec<RecentFile> {
    read_recent(&app)
}

/// Show a native "open" dialog; returns the chosen path, or `null` if the user
/// cancels. `async` so it runs off the main thread (a requirement for the
/// blocking dialog API).
#[tauri::command]
pub async fn open_file_dialog(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .add_filter(DIAGRAM_FILTER_NAME, &[DIAGRAM_EXTENSION])
        .blocking_pick_file()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

/// Show a native "save as" dialog; returns the chosen path, or `null` if the
/// user cancels.
#[tauri::command]
pub async fn save_file_dialog(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .add_filter(DIAGRAM_FILTER_NAME, &[DIAGRAM_EXTENSION])
        .set_file_name(&format!("diagram.{DIAGRAM_EXTENSION}"))
        .blocking_save_file()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

// ─── LLM settings + chat transport (Phase 6, D5/D6) ─────────────────────────────────
// Settings persist to `llm_settings.json` in the app data dir — the exact pattern
// `recent_files.json` already uses above. This file is DELIBERATELY never touched by
// save_diagram/load_diagram — the API key must never end up inside a `.scalemap` file
// (D6). `llm_chat` exists because a webview `fetch()` to an arbitrary third-party origin
// (OpenAI, OpenRouter, etc.) dies on CORS; this command is the only place the key ever
// leaves the process, and every error path passes through `redact()` first.

const LLM_SETTINGS_FILE: &str = "llm_settings.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LlmSettings {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

/// Replace every occurrence of `key` in `msg` with "•••". A no-op for an empty key (nothing
/// configured yet, nothing to redact — and this sidesteps `str::replace("", ...)`'s footgun of
/// inserting the marker between every character). Pure, unit-tested above.
fn redact(msg: &str, key: &str) -> String {
    if key.is_empty() {
        return msg.to_string();
    }
    msg.replace(key, "\u{2022}\u{2022}\u{2022}")
}

fn llm_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("could not create app data dir: {e}"))?;
    Ok(dir.join(LLM_SETTINGS_FILE))
}

#[tauri::command]
pub fn save_llm_settings(app: AppHandle, settings: LlmSettings) -> Result<(), String> {
    let path = llm_settings_path(&app)?;
    let raw = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    write_private(&path, &raw)
}

/// Write `contents` readable by the owning OS user only (0600 on unix). The settings file
/// holds an API key at rest (spec D6), so it must not inherit group/other-readable defaults.
/// Windows has no mode bits; there the app-data dir's per-user ACL is the boundary.
fn write_private(path: &Path, contents: &str) -> Result<(), String> {
    fs::write(path, contents).map_err(|e| format!("could not write llm settings: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("could not restrict llm settings permissions: {e}"))?;
    }
    Ok(())
}

/// Returns `LlmSettings::default()` (all empty strings) on ANY error — missing file, corrupt
/// JSON, unresolvable app data dir — so the Settings modal always has something to render.
#[tauri::command]
pub fn load_llm_settings(app: AppHandle) -> LlmSettings {
    let Ok(path) = llm_settings_path(&app) else {
        return LlmSettings::default();
    };
    let Ok(raw) = fs::read_to_string(&path) else {
        return LlmSettings::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

/// POSTs `body` verbatim to `{base_url}/chat/completions` with a Bearer auth header, 60s
/// timeout, and returns the raw response text for ANY HTTP status (the caller reads an
/// OpenAI-style `{error:{...}}` envelope itself when the provider signals failure via 4xx/5xx
/// with a JSON body — this command doesn't interpret status codes at all). Err is reserved for
/// TRANSPORT failures (DNS, connection refused, timeout) and always passes through `redact()`.
#[tauri::command]
pub async fn llm_chat(base_url: String, api_key: String, body: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| redact(&e.to_string(), &api_key))?;

    let url = format!("{base_url}/chat/completions");
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| redact(&e.to_string(), &api_key))?;

    response
        .text()
        .await
        .map_err(|e| redact(&e.to_string(), &api_key))
}

// ─── Simulation event log (SQLite, WAL) ──────────────────────────────────────────
// The frontend keeps only a small in-memory WINDOW of engine events for the live Events tab;
// EVERY event is durably appended here so long runs never lose history (user decision
// 2026-07-12: no hard caps — overflow spills to disk). WAL journal mode lets future readers
// (history browsing, a second window) query concurrently with the 1 Hz batched appends coming
// from `simulation.store.ts`. One database at `<app_data_dir>/events.db`; one `runs` row per
// Simulate press; per-run monotonic `seq` for stable pagination.

const EVENT_DB_FILE: &str = "events.db";

/// Wire shape of one engine event, camelCased to match `EngineEvent` in
/// `src/lib/worldEngine/types.ts` (id/simMs/kind/severity/message/affected).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoggedEvent {
    pub id: String,
    pub sim_ms: i64,
    pub kind: String,
    pub severity: String,
    pub message: String,
    pub affected: Vec<String>,
}

/// A stored event plus its per-run sequence number (pagination cursor for `event_log_tail`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoggedEventRow {
    pub seq: i64,
    pub id: String,
    pub sim_ms: i64,
    pub kind: String,
    pub severity: String,
    pub message: String,
    pub affected: Vec<String>,
}

fn open_event_db(path: &Path) -> Result<rusqlite::Connection, String> {
    let conn = rusqlite::Connection::open(path)
        .map_err(|e| format!("could not open event log: {e}"))?;
    // WAL + NORMAL: the standard desktop-app profile — readers never block on the writer,
    // and a power loss can only lose the last unsynced batch, never corrupt the file.
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("could not enable WAL: {e}"))?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| format!("could not set synchronous: {e}"))?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at TEXT NOT NULL,
            world_name TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS events (
            run_id INTEGER NOT NULL REFERENCES runs(id),
            seq INTEGER NOT NULL,
            event_id TEXT NOT NULL,
            sim_ms INTEGER NOT NULL,
            kind TEXT NOT NULL,
            severity TEXT NOT NULL,
            message TEXT NOT NULL,
            affected TEXT NOT NULL,
            PRIMARY KEY (run_id, seq)
        );
        CREATE INDEX IF NOT EXISTS idx_events_run_sim ON events(run_id, sim_ms);",
    )
    .map_err(|e| format!("could not create event log schema: {e}"))?;
    Ok(conn)
}

static EVENT_DB: std::sync::OnceLock<std::sync::Mutex<rusqlite::Connection>> =
    std::sync::OnceLock::new();

fn event_db(app: &AppHandle) -> Result<&'static std::sync::Mutex<rusqlite::Connection>, String> {
    if let Some(db) = EVENT_DB.get() {
        return Ok(db);
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("could not create app data dir: {e}"))?;
    let conn = open_event_db(&dir.join(EVENT_DB_FILE))?;
    let _ = EVENT_DB.set(std::sync::Mutex::new(conn));
    Ok(EVENT_DB.get().expect("event db just initialized"))
}

fn begin_run_in(conn: &rusqlite::Connection, world_name: &str) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO runs (started_at, world_name) VALUES (?1, ?2)",
        rusqlite::params![chrono::Utc::now().to_rfc3339(), world_name],
    )
    .map_err(|e| format!("could not begin run: {e}"))?;
    Ok(conn.last_insert_rowid())
}

/// Appends a batch in one transaction; returns the run's total event count afterwards.
fn append_events_in(
    conn: &rusqlite::Connection,
    run_id: i64,
    events: &[LoggedEvent],
) -> Result<i64, String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("could not start event tx: {e}"))?;
    let mut next_seq: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(seq), 0) FROM events WHERE run_id = ?1",
            rusqlite::params![run_id],
            |r| r.get(0),
        )
        .map_err(|e| format!("could not read event seq: {e}"))?;
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO events (run_id, seq, event_id, sim_ms, kind, severity, message, affected)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )
            .map_err(|e| format!("could not prepare event insert: {e}"))?;
        for e in events {
            next_seq += 1;
            let affected = serde_json::to_string(&e.affected).map_err(|e| e.to_string())?;
            stmt.execute(rusqlite::params![
                run_id, next_seq, e.id, e.sim_ms, e.kind, e.severity, e.message, affected
            ])
            .map_err(|e| format!("could not insert event: {e}"))?;
        }
    }
    tx.commit().map_err(|e| format!("could not commit events: {e}"))?;
    Ok(next_seq)
}

/// Newest-first page of a run's events; `before_seq` (exclusive) pages further back.
fn tail_in(
    conn: &rusqlite::Connection,
    run_id: i64,
    before_seq: Option<i64>,
    limit: i64,
) -> Result<Vec<LoggedEventRow>, String> {
    let cursor = before_seq.unwrap_or(i64::MAX);
    let mut stmt = conn
        .prepare(
            "SELECT seq, event_id, sim_ms, kind, severity, message, affected FROM events
             WHERE run_id = ?1 AND seq < ?2 ORDER BY seq DESC LIMIT ?3",
        )
        .map_err(|e| format!("could not prepare tail query: {e}"))?;
    let rows = stmt
        .query_map(rusqlite::params![run_id, cursor, limit], |r| {
            let affected_raw: String = r.get(6)?;
            Ok(LoggedEventRow {
                seq: r.get(0)?,
                id: r.get(1)?,
                sim_ms: r.get(2)?,
                kind: r.get(3)?,
                severity: r.get(4)?,
                message: r.get(5)?,
                affected: serde_json::from_str(&affected_raw).unwrap_or_default(),
            })
        })
        .map_err(|e| format!("could not query events: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("could not read event rows: {e}"))?;
    Ok(rows)
}

fn lock_event_db(
    db: &'static std::sync::Mutex<rusqlite::Connection>,
) -> Result<std::sync::MutexGuard<'static, rusqlite::Connection>, String> {
    db.lock().map_err(|_| "event log lock poisoned".to_string())
}

#[tauri::command]
pub fn event_log_begin_run(app: AppHandle, world_name: String) -> Result<i64, String> {
    let conn = lock_event_db(event_db(&app)?)?;
    begin_run_in(&conn, &world_name)
}

#[tauri::command]
pub fn event_log_append(
    app: AppHandle,
    run_id: i64,
    events: Vec<LoggedEvent>,
) -> Result<i64, String> {
    let conn = lock_event_db(event_db(&app)?)?;
    append_events_in(&conn, run_id, &events)
}

#[tauri::command]
pub fn event_log_tail(
    app: AppHandle,
    run_id: i64,
    before_seq: Option<i64>,
    limit: i64,
) -> Result<Vec<LoggedEventRow>, String> {
    let conn = lock_event_db(event_db(&app)?)?;
    tail_in(&conn, run_id, before_seq, limit)
}

#[cfg(test)]
mod event_log_tests {
    use super::*;

    fn temp_db() -> (rusqlite::Connection, PathBuf) {
        // Unique per call — tests run in parallel, and a shared path makes WAL setup race.
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "scalemap-eventlog-test-{}-{n}.db",
            std::process::id(),
        ));
        let _ = fs::remove_file(&path);
        (open_event_db(&path).expect("open temp event db"), path)
    }

    fn evt(n: i64) -> LoggedEvent {
        LoggedEvent {
            id: format!("evt-{n}"),
            sim_ms: n * 100,
            kind: "server_down".into(),
            severity: "critical".into(),
            message: format!("event {n}"),
            affected: vec![format!("srv-{n}"), "az-1".into()],
        }
    }

    #[test]
    fn wal_mode_is_active_on_a_file_backed_db() {
        let (conn, path) = temp_db();
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        drop(conn);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn append_batches_accumulate_with_monotonic_seq_and_running_total() {
        let (conn, path) = temp_db();
        let run = begin_run_in(&conn, "three-tier").unwrap();
        let total1 = append_events_in(&conn, run, &[evt(1), evt(2), evt(3)]).unwrap();
        assert_eq!(total1, 3);
        let total2 = append_events_in(&conn, run, &[evt(4), evt(5)]).unwrap();
        assert_eq!(total2, 5);
        let all = tail_in(&conn, run, None, 100).unwrap();
        assert_eq!(all.len(), 5);
        assert_eq!(all.first().unwrap().seq, 5, "tail is newest-first");
        assert_eq!(all.last().unwrap().seq, 1);
        drop(conn);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn tail_paginates_backwards_and_roundtrips_affected_json() {
        let (conn, path) = temp_db();
        let run = begin_run_in(&conn, "w").unwrap();
        append_events_in(&conn, run, &(1..=10).map(evt).collect::<Vec<_>>()).unwrap();
        let page1 = tail_in(&conn, run, None, 4).unwrap();
        assert_eq!(page1.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![10, 9, 8, 7]);
        let page2 = tail_in(&conn, run, Some(7), 4).unwrap();
        assert_eq!(page2.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![6, 5, 4, 3]);
        assert_eq!(page2[0].affected, vec!["srv-6".to_string(), "az-1".to_string()]);
        drop(conn);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn runs_are_isolated_from_each_other() {
        let (conn, path) = temp_db();
        let run_a = begin_run_in(&conn, "a").unwrap();
        let run_b = begin_run_in(&conn, "b").unwrap();
        append_events_in(&conn, run_a, &[evt(1), evt(2)]).unwrap();
        let total_b = append_events_in(&conn, run_b, &[evt(9)]).unwrap();
        assert_eq!(total_b, 1, "run B's seq starts fresh");
        assert_eq!(tail_in(&conn, run_a, None, 10).unwrap().len(), 2);
        assert_eq!(tail_in(&conn, run_b, None, 10).unwrap().len(), 1);
        drop(conn);
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_masks_key_everywhere_and_short_keys_entirely() {
        let key = "sk-super-secret-key-123"; // 23 chars — normal-length key
        let msg = format!("connect failed using key {key} and again {key} here");
        let out = redact(&msg, key);
        assert!(!out.contains(key), "raw key leaked: {out}");
        assert_eq!(out.matches('\u{2022}').count(), 6, "expected two '•••' markers (3 bullets each)");

        // Short key (< 8 chars) — still fully replaced wherever it appears, not left partially
        // visible or missed due to a length-based bug.
        let short = "abc123"; // 6 chars
        let msg2 = format!("error near {short} boundary, retrying {short}");
        let out2 = redact(&msg2, short);
        assert!(!out2.contains(short), "short key leaked: {out2}");

        // Empty key — no-op passthrough (nothing configured yet, nothing to redact) and,
        // critically, must NOT call `str::replace("", ...)` which would insert the marker
        // between every character of the message.
        let unchanged = redact("some upstream error text", "");
        assert_eq!(unchanged, "some upstream error text");
    }

    #[test]
    #[cfg(unix)]
    fn write_private_sets_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let path = std::env::temp_dir().join(format!(
            "scalemap-llm-settings-test-{}.json",
            std::process::id()
        ));
        write_private(&path, "{\"api_key\":\"sk-test\"}").unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        let _ = fs::remove_file(&path);
        assert_eq!(mode, 0o600, "llm settings file must be owner-only, got {mode:o}");
    }

    #[test]
    fn settings_serde_round_trip() {
        let s = LlmSettings {
            base_url: "https://api.openai.com/v1".to_string(),
            api_key: "sk-abc-123".to_string(),
            model: "gpt-4o-mini".to_string(),
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"base_url\""));
        assert!(json.contains("\"api_key\""));
        assert!(json.contains("\"model\""));
        let back: LlmSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.base_url, s.base_url);
        assert_eq!(back.api_key, s.api_key);
        assert_eq!(back.model, s.model);
    }

    #[test]
    fn llm_chat_returns_body_from_tcp_listener_stub() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let body = r#"{"choices":[{"message":{"content":"hi"}}]}"#;

        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf); // drain the request; this stub doesn't parse it
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body,
            );
            stream.write_all(response.as_bytes()).unwrap();
        });

        let base_url = format!("http://127.0.0.1:{port}");
        // NOTE (per Global Constraints — VERIFY, don't hard-assume): tauri::async_runtime::block_on
        // needs no new Cargo.toml dependency (tauri already depends on tokio transitively and
        // every existing async #[tauri::command] in this file — open_file_dialog/save_file_dialog
        // — already proves tauri's async infra works without one). If this genuinely fails to
        // compile/run in a plain #[test] (e.g. "no reactor running" panic), the dependency-free
        // constraint is violated either way by adding `tokio` as a dev-dependency for
        // `#[tokio::test]` — do that ONLY as a fallback, and log the deviation in
        // `.superpowers/sdd/contract-drift.md` `## PHASE 6` since Global Constraints says Cargo.toml
        // adds ONLY reqwest.
        let result = tauri::async_runtime::block_on(llm_chat(
            base_url,
            "sk-test-key-0123456789".to_string(),
            "{}".to_string(),
        ));
        handle.join().unwrap();

        assert_eq!(result.unwrap(), body);
    }

    #[test]
    fn llm_chat_redacts_key_from_connection_refused_error() {
        // Bind then immediately drop — frees the ephemeral port while guaranteeing nothing else
        // grabbed it in the interim, so connecting to it is a real OS-level refusal.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let key = "sk-should-never-leak-0000";
        let base_url = format!("http://127.0.0.1:{port}");
        let result = tauri::async_runtime::block_on(llm_chat(base_url, key.to_string(), "{}".to_string()));

        let err = result.expect_err("expected a transport error against a closed port");
        assert!(!err.contains(key), "raw api key leaked into error string: {err}");
    }
}
