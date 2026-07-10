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
