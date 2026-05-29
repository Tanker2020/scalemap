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
