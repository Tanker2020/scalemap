# Phase 6 plan fragment — Tasks 5–8 (Rust+TS LLM transport · review client · settings
# modal/theme toggle · AI review section + stub)

> Fragment scope: Task 5 (Rust `save_llm_settings`/`load_llm_settings`/`llm_chat` commands + TS
> wrappers), Task 6 (`src/lib/llmReview.ts` — context builder / schema validator / retrying
> client), Task 7 (`SettingsModal.tsx` + WorldShell gear button + live theme toggle), Task 8
> (`AiReviewSection.tsx` + `scripts/llm-stub.mjs`, mounted into the Analysis tab). Global
> Constraints / File Structure live in the skeleton's assembled header
> (`docs/superpowers/plans/phase6/skeleton.md`) — not repeated here.
>
> **Grounding status:** T5, T6, and T7 are grounded against REAL, currently-committed source —
> `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`, `src/lib/tauri.ts`,
> `src/lib/tauriMock.ts`, and `src/app/world/WorldShell.tsx` all exist today exactly as quoted
> below (verified `2026-07-10`, current `main` tip `4f3ce5a` — Phase 5's traffic-authoring task
> already lifted `placeMode`/`selectedPopulationId` into `WorldShell`, so T7's diff is written
> against that real, current file). T8 is different: it depends on Task 4's
> `AnalysisTab.tsx`/`WorldPanel.tsx` output, and **Tasks 1–4 have not executed yet** at
> fragment-writing time — `WorldPanel.tsx` today still has the OLD `'findings'` tab (verified,
> quoted in T8's grounding). T8's diffs are therefore written against a **reconstruction** of
> Task 4's exact contract (pinned verbatim in `skeleton.md` §Task 4 and `GROUNDING.md` §G — not
> invented here), flagged explicitly at that step. The implementer executing T8 (after T4 has
> actually landed) must apply that step's diff **intent** against the real T4 files rather than
> pasting the reconstruction verbatim if T4's literal internal structure differs in ways that
> don't affect the pinned contract (`navigateToEntity`, `unsuppressedCompileFindings`, the
> family-grouped render, the props-less `AnalysisTab()` signature T4 leaves for T8 to extend).
>
> **D6 SECURITY (non-negotiable, carried into every one of T5–T8's sections below):** the API
> key is NEVER serialized into `.scalemap` (settings live outside `world.store`/`serializer`),
> NEVER logged or `console.*`'d, NEVER included in review-context payloads, REDACTED from every
> error string on both Rust and TS sides, rendered ONLY masked (`•••• <last4>`) after save, input
> `type=password`. Each task below names the specific test that asserts its slice of this.

---

## Task 5: Rust — LLM settings + chat commands `[sonnet]`

**D6 asserting tests this task owns:** `redact_masks_key_everywhere_and_short_keys_entirely`
(Rust) + `llm_chat_redacts_key_from_connection_refused_error` (Rust).

**Files:** modify `src-tauri/Cargo.toml`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`,
`src/lib/tauri.ts`, `src/lib/tauriMock.ts`; create `src/lib/tauri.test.ts`.

**Grounding — real current source, quoted verbatim.**

`src-tauri/src/commands.rs` (66 lines, full file) already establishes the exact pattern to mirror
for `llm_settings.json` — an app-data-dir JSON file, `fs::create_dir_all`, `serde_json`,
default-on-any-error reads:
```rust
//! Tauri commands backing the frontend file shim (`src/lib/tauri.ts`).
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

const RECENT_FILES_FILE: &str = "recent_files.json";
const MAX_RECENT: usize = 10;
const DIAGRAM_FILTER_NAME: &str = "Scalemap Diagram";
const DIAGRAM_EXTENSION: &str = "scalemap";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentFile { pub path: String, pub name: String, pub modified: String }

fn recent_files_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("could not resolve app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("could not create app data dir: {e}"))?;
    Ok(dir.join(RECENT_FILES_FILE))
}
// ... read_recent/write_recent/touch_recent/file_name_of ...

#[tauri::command]
pub fn save_diagram(app: AppHandle, path: String, data: String) -> Result<(), String> { /* ... */ }
#[tauri::command]
pub fn load_diagram(path: String) -> Result<String, String> { /* ... */ }
#[tauri::command]
pub fn get_recent_files(app: AppHandle) -> Vec<RecentFile> { read_recent(&app) }
#[tauri::command]
pub async fn open_file_dialog(app: AppHandle) -> Option<String> { /* ... */ }
#[tauri::command]
pub async fn save_file_dialog(app: AppHandle) -> Option<String> { /* ... */ }
```
`src-tauri/src/lib.rs` (full file):
```rust
mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::save_diagram,
            commands::load_diagram,
            commands::get_recent_files,
            commands::open_file_dialog,
            commands::save_file_dialog,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```
`src-tauri/Cargo.toml` `[dependencies]` (full section):
```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-opener = "2"
tauri-plugin-dialog = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
chrono = { version = "0.4", default-features = false, features = ["clock"] }
```
`src/lib/tauri.ts` (full file, 30 lines):
```ts
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

export const saveDiagram = (path: string, data: string) => invoke<void>('save_diagram', { path, data })
export const loadDiagram = (path: string) => invoke<string>('load_diagram', { path })
export const getRecentFiles = () => invoke<RecentFile[]>('get_recent_files')
export const openFileDialog = () => invoke<string | null>('open_file_dialog')
export const saveFileDialog = () => invoke<string | null>('save_file_dialog')

export type { RecentFile }
```
`src/lib/tauriMock.ts` (full file, 50 lines) — every `tauriMock` entry is a bare async function
keyed by the exact snake_case command name, called by `invoke`'s dynamic lookup:
```ts
const RECENT_FILES_KEY = 'scalemap:recent_files'
const DIAGRAMS_KEY = 'scalemap:diagram:'
export interface RecentFile { path: string; name: string; modified: string }
function getRecentFiles(): RecentFile[] { /* ... */ }
function addToRecent(path: string) { /* ... */ }
export const tauriMock = {
  async save_diagram(path: string, data: string): Promise<void> { /* ... */ },
  async load_diagram(path: string): Promise<string> { /* ... */ },
  async get_recent_files(): Promise<RecentFile[]> { return getRecentFiles() },
  async open_file_dialog(): Promise<string | null> { /* ... */ },
  async save_file_dialog(): Promise<string | null> { /* ... */ },
}
```

**Tauri v2 casing — VERIFIED finding (state this in the implementer's PR/commit notes too):**
command SCALAR argument names are camelCased on the JS side and mapped to snake_case Rust
parameter names by Tauri's macro (`base_url` ↔ `baseUrl`, `api_key` ↔ `apiKey`) — but **struct
FIELDS go through plain serde with their Rust names**, no Tauri casing layer touches them. So
`llmChat`'s wrapper calls `invoke('llm_chat', { baseUrl, apiKey, body })` (Tauri maps these
three scalar args to the snake_case Rust params), while `LlmSettings`'s fields stay snake_case
end-to-end and the **TS wrapper does the snake↔camel mapping explicitly** — `saveLlmSettings`
sends `{ settings: { base_url, api_key, model } }`, `loadLlmSettings` receives
`{ base_url, api_key, model }` back and maps it to camelCase before returning. This means
`llm_settings.json` on disk holds snake_case keys, consistent with `recent_files.json`'s
`RecentFile { path, name, modified }` (which happens to have no camelCase fields, so this
distinction was invisible until now — first struct-with-camelCase-conceptual-fields this repo
ships). **Confirm this by grep, don't take it on faith:** `grep -n "camelCase\|rename_all" -R
src-tauri/` turns up nothing repo-side — the casing behavior is Tauri's macro default, not a
repo convention, which is exactly why it's easy to get backwards; the implementer should sanity
check the wrapper against a real `cargo build` + a manual `npm run tauri dev` round trip if time
allows, not just the mock-transport tests below (the mock never exercises the real Tauri IPC
layer's casing at all).

Also confirmed: `Object.values(args)` in `invoke()`'s mock branch passes arguments **positionally
by object-key insertion order** — so `tauriMock.llm_chat(baseUrl, apiKey, body)`'s parameter
order must match the wrapper's `{ baseUrl, apiKey, body }` key order exactly (it does, below).

**Produces (exact, per `GROUNDING.md` §H):**
```rust
const LLM_SETTINGS_FILE: &str = "llm_settings.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LlmSettings { pub base_url: String, pub api_key: String, pub model: String }

fn redact(msg: &str, key: &str) -> String

#[tauri::command] pub fn save_llm_settings(app: AppHandle, settings: LlmSettings) -> Result<(), String>
#[tauri::command] pub fn load_llm_settings(app: AppHandle) -> LlmSettings
#[tauri::command] pub async fn llm_chat(base_url: String, api_key: String, body: String) -> Result<String, String>
```
```ts
export interface LlmSettings { baseUrl: string; apiKey: string; model: string }
export async function saveLlmSettings(s: LlmSettings): Promise<void>
export async function loadLlmSettings(): Promise<LlmSettings>
export async function llmChat(baseUrl: string, apiKey: string, body: string): Promise<string>
```

**Judgment call — `redact()`'s exact algorithm.** `GROUNDING.md`'s prose ("replace every
occurrence of `key` with `•••`; keys < 8 chars are masked entirely... short/empty key ⇒ do NOT
leak... Guard empty key (no-op replace of `""`)") reads two ways: (a) short keys get the WHOLE
message nuked to a placeholder, or (b) short keys still get precise substring-replacement — the
"masked entirely" phrase just reassures that even a short key's occurrences are fully replaced
(no partial leftover), and the ONLY real special case is guarding `msg.replace("", ...)`'s
insert-between-every-character footgun for an empty key. Reading (b) is more literal (the
`redact` doc comment's own words are "return msg with any occurrence replaced" — i.e. still doing
occurrence replacement) and is simpler/more testable, so this plan implements (b): a plain
substring `replace()` for any non-empty key, and a no-op passthrough for an empty key (nothing to
redact if no key was ever configured). **Flagging this as a genuine reading ambiguity in
`GROUNDING.md`'s phrasing, not silently picking one** — if the controller/reviewer intended (a),
swap `redact`'s body for a `key.len() < 8 → "[redacted]"` whole-message-scrub branch; the test
below would need updating to match (its two assertions on `out2`/short-key behavior are the ones
that would change).

- [ ] **Step 1: Write the failing Rust tests** (append to `src-tauri/src/commands.rs`)

```rust
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
```

- [ ] **Step 2: Run to verify the tests fail (they won't even compile yet — that's the failure)**

Run (from `src-tauri/`): `cargo test`
Expected: FAIL to compile — `error[E0433]: failed to resolve: use of undeclared type
'LlmSettings'` / `cannot find function 'redact' in this scope` / `cannot find function 'llm_chat'
in this scope` (the struct/fn/command don't exist yet).

- [ ] **Step 3: Write the Rust implementation** (insert above the `#[cfg(test)]` block, after the
existing `save_file_dialog` function)

```rust
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
    fs::write(&path, raw).map_err(|e| format!("could not write llm settings: {e}"))
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
```

- [ ] **Step 4: Register the commands in `src-tauri/src/lib.rs`**

```diff
         .invoke_handler(tauri::generate_handler![
             commands::save_diagram,
             commands::load_diagram,
             commands::get_recent_files,
             commands::open_file_dialog,
             commands::save_file_dialog,
+            commands::save_llm_settings,
+            commands::load_llm_settings,
+            commands::llm_chat,
         ])
```

- [ ] **Step 5: Add the dependency to `src-tauri/Cargo.toml`**

```diff
 serde = { version = "1", features = ["derive"] }
 serde_json = "1"
 chrono = { version = "0.4", default-features = false, features = ["clock"] }
+reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }
```
This is the ONLY new dependency the whole phase adds (Global Constraints). `default-features =
false` + `rustls-tls` avoids pulling in a system OpenSSL dependency; `json` is included per the
pinned spec even though this command doesn't call `.json()` directly (it passes `body: String`
through verbatim and reads `.text()`) — don't drop it, it's the exact feature set the plan
mandates.

- [ ] **Step 6: Run `cargo test` and `cargo build` — BOTH gate this task, not the frontend build**

Run (from `src-tauri/`): `cargo test`
Expected: `running 4 tests ... test result: ok. 4 passed; 0 failed`. If
`llm_chat_returns_body_from_tcp_listener_stub`/`llm_chat_redacts_key_from_connection_refused_error`
panic with something like "there is no reactor running" or "must be called from the context of a
Tokio 1.x runtime", `tauri::async_runtime::block_on` needs an explicit runtime bootstrap in this
crate's test harness — see the judgment-call note inline above; do not silently add `tokio` as a
dependency without logging the deviation.

Run (from `src-tauri/`): `cargo build`
Expected: clean build, no warnings about unused imports.

**A green `npm run build` does NOT gate this task — say so explicitly**, per Global Constraints:
the frontend build only exercises the TS wrapper against the MOCK transport (Step 8 below); the
Rust transport itself is gated exclusively by `cargo test` + `cargo build` above.

- [ ] **Step 7: Modify `src/lib/tauri.ts`** (append after the existing exports)

```diff
 export const saveFileDialog = () =>
   invoke<string | null>('save_file_dialog')

 export type { RecentFile }
+
+export interface LlmSettings {
+  baseUrl: string
+  apiKey: string
+  model: string
+}
+
+// Field names cross the Rust boundary as snake_case: `LlmSettings`' struct FIELDS go through
+// serde with their Rust names (Tauri v2 only camelCases command SCALAR ARG names — e.g.
+// `base_url` <-> `baseUrl` — never struct field names; verified against tauri-macros' actual
+// casing behavior, see this task's grounding notes). These two wrappers are the ONLY place that
+// snake<->camel mapping happens; every other caller in the app uses the camelCase LlmSettings
+// shape below, never the raw Rust field names.
+export async function saveLlmSettings(settings: LlmSettings): Promise<void> {
+  return invoke<void>('save_llm_settings', {
+    settings: { base_url: settings.baseUrl, api_key: settings.apiKey, model: settings.model },
+  })
+}
+
+export async function loadLlmSettings(): Promise<LlmSettings> {
+  const r = await invoke<{ base_url: string; api_key: string; model: string }>('load_llm_settings')
+  return { baseUrl: r.base_url ?? '', apiKey: r.api_key ?? '', model: r.model ?? '' }
+}
+
+export async function llmChat(baseUrl: string, apiKey: string, body: string): Promise<string> {
+  return invoke<string>('llm_chat', { baseUrl, apiKey, body })
+}
```

- [ ] **Step 8: Modify `src/lib/tauriMock.ts`**

```diff
 const RECENT_FILES_KEY = 'scalemap:recent_files'
 const DIAGRAMS_KEY = 'scalemap:diagram:'
+const LLM_SETTINGS_KEY = 'scalemap:llm_settings'

 export interface RecentFile {
   path: string
   name: string
   modified: string
 }
+
+interface StoredLlmSettings { base_url: string; api_key: string; model: string }
```
```diff
   async save_file_dialog(): Promise<string | null> {
     return `diagram-${Date.now()}.scalemap`
   },
+
+  // Browser-dev only, mirrors llm_settings.json's snake_case shape. D6: this stores the settings
+  // object to localStorage for local dev convenience ONLY — it must never be reached from
+  // world.store/serializer (a completely separate persistence path — see saveWorld/serializer.ts,
+  // untouched by this phase), and must never console.* the key.
+  async save_llm_settings(settings: StoredLlmSettings): Promise<void> {
+    localStorage.setItem(LLM_SETTINGS_KEY, JSON.stringify(settings))
+  },
+
+  async load_llm_settings(): Promise<StoredLlmSettings> {
+    try {
+      return JSON.parse(localStorage.getItem(LLM_SETTINGS_KEY) ?? '')
+    } catch {
+      return { base_url: '', api_key: '', model: '' }
+    }
+  },
+
+  // Browser-dev only: a direct fetch() to whatever endpoint the user configured — fine for
+  // Ollama/LM Studio/local stubs where the user controls CORS (real desktop builds go through
+  // the Rust llm_chat command instead, which has no CORS restriction).
+  async llm_chat(baseUrl: string, apiKey: string, body: string): Promise<string> {
+    const r = await fetch(`${baseUrl}/chat/completions`, {
+      method: 'POST',
+      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
+      body,
+    })
+    return r.text()
+  },
 }
```

- [ ] **Step 9: Write the failing TS test `src/lib/tauri.test.ts`**

```ts
// src/lib/tauri.test.ts
// @vitest-environment jsdom
// The mock transport (isTauri === false in jsdom, no window.__TAURI_INTERNALS__) round-trips
// through localStorage — this proves the wrapper's snake<->camel mapping (Step 7) matches the
// mock's snake-case storage shape (Step 8) end to end, and that the stored JSON never grows a
// forbidden extra key (D6 sanity: the shape is exactly {base_url,api_key,model}, nothing else).
import { describe, it, expect, beforeEach } from 'vitest'
import { saveLlmSettings, loadLlmSettings } from './tauri'

describe('llm settings wrapper (mock transport)', () => {
  beforeEach(() => localStorage.clear())

  it('round-trips camelCase in/out through the snake_case-stored mock', async () => {
    await saveLlmSettings({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test-abc', model: 'gpt-4o-mini' })

    const raw = localStorage.getItem('scalemap:llm_settings')
    expect(raw).toBeTruthy()
    const stored = JSON.parse(raw!)
    expect(Object.keys(stored).sort()).toEqual(['api_key', 'base_url', 'model'])
    expect(stored.base_url).toBe('https://api.openai.com/v1')
    expect(stored.api_key).toBe('sk-test-abc')

    const loaded = await loadLlmSettings()
    expect(loaded).toEqual({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test-abc', model: 'gpt-4o-mini' })
  })

  it('load returns empty-string defaults when nothing is stored', async () => {
    const loaded = await loadLlmSettings()
    expect(loaded).toEqual({ baseUrl: '', apiKey: '', model: '' })
  })
})
```

- [ ] **Step 10: Run to verify it fails, then passes**

Run: `npx vitest run src/lib/tauri.test.ts`
Expected (before Steps 7–8 land): FAIL — `saveLlmSettings is not exported from './tauri'`. After:
PASS (2 tests).

- [ ] **Step 11: Full verify**

Run: `npx vitest run src/lib/tauri.test.ts` → PASS (2 tests).
Run: `npm run build` → strict tsc + vite build green.
Run (from `src-tauri/`): `cargo test` → PASS (4 tests).
Run (from `src-tauri/`): `cargo build` → clean.

- [ ] **Step 12: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/commands.rs src-tauri/src/lib.rs \
  src/lib/tauri.ts src/lib/tauriMock.ts src/lib/tauri.test.ts
git commit -m "feat(llm): rust-side llm settings persistence and chat transport"
```

---

## Task 6: Review client `[sonnet]`

**D6 asserting test this task owns:** `context contains no apiKey value (canary scan)`.

**Files:** create `src/lib/llmReview.ts`, `src/lib/llmReview.test.ts`.

**Grounding — types this file reads** (all previously pinned, re-quoted for this task's use):
`WorldDoc`/`CompiledWorld`/`CompileFinding` (`src/lib/world/types.ts`), `MetricsBatch` +
`InstanceMetrics`/`ServerMetrics`/`AzMetrics`/`RegionMetrics`/`WorldMetrics` (verbatim,
`src/lib/worldEngine/types.ts`):
```ts
export interface InstanceMetrics { instanceId; rps; errorRate; p50Ms; p99Ms; activeConnections; cpuCoresUsed; ramMb; health }
export interface ServerMetrics { serverId; coreUtilization: number[]; stealFraction; burstCredits: number | null;
  ramByInstance: { instanceId; blueprintId; ramMb }[]; ramUsedMb; ramTotalMb; nicInMbps; nicOutMbps; diskIoFraction; health }
export interface RegionMetrics { regionId; rps; errorRate; p50Ms; healthScore; health; inboundByPopulation: { populationId; rps }[] }
export interface AzMetrics { azId; rps; errorRate; p50Ms; healthScore; health; serverCount; instanceCount }
export interface WorldMetrics { totalRps; errorRate; populationRoutes: {...}[]; crossAzBytesPerSec; crossRegionBytesPerSec; internetEgressBytesPerSec }
export interface MetricsBatch { simMs; instances: Record<InstanceId, InstanceMetrics>; servers: Record<ServerId, ServerMetrics>;
  azs: Record<AzId, AzMetrics>; regions: Record<RegionId, RegionMetrics>; world: WorldMetrics }
```
`AnalysisFinding` (`src/lib/analysis/types.ts`, T1's contract, pinned in `GROUNDING.md` §C):
`{ id; ruleId; family; severity; title; why; fix; affected: string[] }`. `CompileFinding`
(`src/lib/world/types.ts`): `{ id; severity: 'error'|'warning'; kind; message; affected }`.
`LlmSettings` (T5, `src/lib/tauri.ts`): `{ baseUrl; apiKey; model }` — **imported, not redefined**
(seam per `GROUNDING.md` §M).

Test fixtures reuse `createWorld`/`createRegion` from `src/lib/world/factories.ts` and
`compileWorld` from `src/lib/world/compileWorld.ts` — same fixture-builder style as every other
Phase 6 rule-family test file.

**Produces (exact, per `GROUNDING.md` §I):**
```ts
import type { WorldDoc, CompiledWorld } from './world/types'
import type { MetricsBatch } from './worldEngine/types'
import type { AnalysisFinding } from './analysis/types'
import { llmChat, type LlmSettings } from './tauri'

export interface AiIssue {
  title: string
  severity: 'critical' | 'warning' | 'info'
  confidence: number
  affected: string[]
  reasoning: string
  recommendation: string
  estimated_effort: 'low' | 'medium' | 'high'
}

export function buildReviewContext(doc: WorldDoc, compiled: CompiledWorld, findings: AnalysisFinding[], lastBatch: MetricsBatch | null): string
export function validateReviewResponse(raw: string): AiIssue[]
export function requestReview(settings: LlmSettings, context: string, chat?: typeof llmChat): Promise<AiIssue[]>
export function pingLlm(settings: LlmSettings, chat?: typeof llmChat): Promise<void>
```

- [ ] **Step 1: Write the failing test `src/lib/llmReview.test.ts`** (pure — node env, no
`@vitest-environment` pragma; `chat` is always injected in these tests, so `tauri.ts`'s
`isTauri`/`window` guard is never exercised and never needs jsdom)

```ts
// src/lib/llmReview.test.ts
import { describe, it, expect, vi } from 'vitest'
import {
  buildReviewContext, validateReviewResponse, requestReview, pingLlm, type AiIssue,
} from './llmReview'
import { createWorld, createRegion } from './world/factories'
import { compileWorld } from './world/compileWorld'
import type { LlmSettings } from './tauri'
import type { MetricsBatch } from './worldEngine/types'

const SETTINGS: LlmSettings = { baseUrl: 'http://localhost:4141/v1', apiKey: 'sk-test', model: 'gpt-4o-mini' }

function envelope(content: string): string {
  return JSON.stringify({ choices: [{ message: { content } }] })
}

function issuesJson(issues: Partial<AiIssue>[]): string {
  return '```json\n' + JSON.stringify({ issues }) + '\n```'
}

describe('buildReviewContext', () => {
  it('contains no apiKey value (canary scan)', () => {
    const doc = createWorld()
    const compiled = compileWorld(doc)
    const context = buildReviewContext(doc, compiled, [], null)
    expect(context).not.toMatch(/apiKey/i)
    expect(context).not.toMatch(/api_key/i)
  })

  it('aggregates region metrics and omits raw instance/server maps', () => {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    doc.regions[region.id] = region
    const compiled = compileWorld(doc)

    const batch: MetricsBatch = {
      simMs: 5000,
      instances: {
        'inst-secret-1': {
          instanceId: 'inst-secret-1', rps: 10, errorRate: 0, p50Ms: 5, p99Ms: 9,
          activeConnections: 2, cpuCoresUsed: 0.3, ramMb: 128, health: 'healthy',
        },
      },
      servers: {
        'srv-secret-1': {
          serverId: 'srv-secret-1', coreUtilization: [0.4], stealFraction: 0, burstCredits: null,
          ramByInstance: [], ramUsedMb: 128, ramTotalMb: 4096, nicInMbps: 1, nicOutMbps: 1,
          diskIoFraction: 0, health: 'healthy',
        },
      },
      azs: {},
      regions: {
        [region.id]: {
          regionId: region.id, rps: 42, errorRate: 0.02, p50Ms: 18, healthScore: 91,
          health: 'healthy', inboundByPopulation: [],
        },
      },
      world: {
        totalRps: 42, errorRate: 0.02, populationRoutes: [],
        crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0,
      },
    }

    const context = buildReviewContext(doc, compiled, [], batch)
    const parsed = JSON.parse(context) as {
      metrics: { world: { totalRps: number; errorRate: number }; regions: unknown[]; azs: unknown[] }
    }
    expect(parsed.metrics.world).toEqual({ totalRps: 42, errorRate: 0.02 })
    expect(parsed.metrics.regions).toEqual([
      { id: region.id, rps: 42, errorRate: 0.02, p50Ms: 18, health: 'healthy' },
    ])
    expect(context).not.toContain('inst-secret-1')
    expect(context).not.toContain('srv-secret-1')
  })
})

describe('requestReview', () => {
  it('happy path parses fenced json', async () => {
    const chat = vi.fn().mockResolvedValue(envelope(issuesJson([
      { title: 'ok', severity: 'critical', confidence: 0.9, affected: ['x'], reasoning: 'r', recommendation: 'y', estimated_effort: 'high' },
    ])))
    const issues = await requestReview(SETTINGS, 'ctx', chat)
    expect(issues).toEqual([
      { title: 'ok', severity: 'critical', confidence: 0.9, affected: ['x'], reasoning: 'r', recommendation: 'y', estimated_effort: 'high' },
    ])
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('malformed then valid succeeds via one retry with corrective message appended', async () => {
    const chat = vi.fn()
      .mockResolvedValueOnce(envelope('not json at all'))
      .mockResolvedValueOnce(envelope(issuesJson([
        { title: 'ok', severity: 'info', confidence: 0.5, affected: [], reasoning: 'r', recommendation: 'x', estimated_effort: 'low' },
      ])))

    const issues = await requestReview(SETTINGS, 'ctx', chat)
    expect(issues).toHaveLength(1)
    expect(issues[0].title).toBe('ok')
    expect(chat).toHaveBeenCalledTimes(2)

    const secondBody = JSON.parse(chat.mock.calls[1][2] as string) as { messages: { role: string; content: string }[] }
    expect(secondBody.messages.some(m => m.role === 'system' && /previous reply/i.test(m.content))).toBe(true)
  })

  it('two malformed responses throw gracefully', async () => {
    const chat = vi.fn().mockResolvedValue(envelope('still not json'))
    await expect(requestReview(SETTINGS, 'ctx', chat)).rejects.toThrow('malformed review response')
    expect(chat).toHaveBeenCalledTimes(2)
  })

  it('error envelope surfaces provider message', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ error: { message: 'rate limited, retry later' } }))
    await expect(requestReview(SETTINGS, 'ctx', chat)).rejects.toThrow('rate limited, retry later')
    expect(chat).toHaveBeenCalledTimes(1) // a provider error envelope isn't a "malformed content" case — no retry
  })

  it('severity/confidence/effort clamping', () => {
    const raw = issuesJson([
      { title: 'a', severity: 'BOGUS' as AiIssue['severity'], confidence: 5, affected: ['ok', 42 as unknown as string, null as unknown as string], reasoning: 'r', recommendation: 'x', estimated_effort: 'urgent' as AiIssue['estimated_effort'] },
      { title: 'b', severity: 'critical', confidence: -3, affected: [], reasoning: 'r2', recommendation: 'x2', estimated_effort: 'low' },
    ])
    const issues = validateReviewResponse(raw)
    expect(issues[0]).toMatchObject({ severity: 'info', confidence: 1, affected: ['ok'], estimated_effort: 'medium' })
    expect(issues[1]).toMatchObject({ severity: 'critical', confidence: 0, estimated_effort: 'low' })
  })
})

describe('pingLlm', () => {
  it('sends max_tokens 1', async () => {
    const chat = vi.fn().mockResolvedValue(envelope('pong'))
    await pingLlm(SETTINGS, chat)
    expect(chat).toHaveBeenCalledTimes(1)
    const body = JSON.parse(chat.mock.calls[0][2] as string) as { max_tokens: number; messages: { role: string; content: string }[] }
    expect(body.max_tokens).toBe(1)
    expect(body.messages).toEqual([{ role: 'user', content: 'ping' }])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/llmReview.test.ts`
Expected: FAIL — `Cannot find module './llmReview'`.

- [ ] **Step 3: Write `src/lib/llmReview.ts`**

```ts
// src/lib/llmReview.ts
// On-demand LLM architecture review (Phase 6, D7). Pure/mock-invoke-testable — `chat` is
// injectable and defaults to T5's llmChat wrapper. D6: this file must NEVER embed settings.apiKey
// (or any settings value) into buildReviewContext's payload — the canary-scan test above enforces
// this by stringify-scanning the emitted context for the literal property names apiKey/api_key.
import type { WorldDoc, CompiledWorld } from './world/types'
import type { MetricsBatch } from './worldEngine/types'
import type { AnalysisFinding } from './analysis/types'
import { llmChat, type LlmSettings } from './tauri'

export interface AiIssue {
  title: string
  severity: 'critical' | 'warning' | 'info'
  confidence: number
  affected: string[]
  reasoning: string
  recommendation: string
  estimated_effort: 'low' | 'medium' | 'high'
}

export function buildReviewContext(
  doc: WorldDoc,
  compiled: CompiledWorld,
  findings: AnalysisFinding[],
  lastBatch: MetricsBatch | null,
): string {
  const metrics = lastBatch
    ? {
        world: { totalRps: lastBatch.world.totalRps, errorRate: lastBatch.world.errorRate },
        regions: Object.values(lastBatch.regions).map(r => ({
          id: r.regionId, rps: r.rps, errorRate: r.errorRate, p50Ms: r.p50Ms, health: r.health,
        })),
        azs: Object.values(lastBatch.azs).map(a => ({
          id: a.azId, rps: a.rps, errorRate: a.errorRate, p50Ms: a.p50Ms, health: a.health,
        })),
      }
    : null

  const payload = {
    world: doc,
    deterministicFindings: findings.map(f => ({ ruleId: f.ruleId, severity: f.severity, title: f.title, affected: f.affected })),
    compileFindings: compiled.findings.map(f => ({ kind: f.kind, severity: f.severity, message: f.message })),
    metrics,
  }
  return JSON.stringify(payload)
}

const SEVERITIES = ['critical', 'warning', 'info'] as const
const EFFORTS = ['low', 'medium', 'high'] as const

function stripJsonFence(raw: string): string {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  return fenced ? fenced[1] : trimmed
}

function clampIssue(raw: unknown): AiIssue {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const severity = (SEVERITIES as readonly string[]).includes(r.severity as string)
    ? (r.severity as AiIssue['severity'])
    : 'info'
  const confNum = Number(r.confidence)
  const confidence = Number.isFinite(confNum) ? Math.max(0, Math.min(1, confNum)) : 0
  const affected = Array.isArray(r.affected) ? r.affected.filter((x): x is string => typeof x === 'string') : []
  const estimated_effort = (EFFORTS as readonly string[]).includes(r.estimated_effort as string)
    ? (r.estimated_effort as AiIssue['estimated_effort'])
    : 'medium'
  return {
    title: typeof r.title === 'string' ? r.title : '',
    severity,
    confidence,
    affected,
    reasoning: typeof r.reasoning === 'string' ? r.reasoning : '',
    recommendation: typeof r.recommendation === 'string' ? r.recommendation : '',
    estimated_effort,
  }
}

export function validateReviewResponse(raw: string): AiIssue[] {
  const stripped = stripJsonFence(raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    throw new Error('malformed review response')
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { issues?: unknown }).issues)) {
    throw new Error('malformed review response')
  }
  return (parsed as { issues: unknown[] }).issues.map(clampIssue)
}

const SCHEMA_HINT = `Respond ONLY with a single JSON object — no prose, no markdown fence — matching
this schema: { "issues": [ { "title": string, "severity": "critical"|"warning"|"info",
"confidence": number (0-1), "affected": string[] (entity ids), "reasoning": string,
"recommendation": string, "estimated_effort": "low"|"medium"|"high" } ] }`

const SYSTEM_PROMPT = `You are a senior infrastructure architect reviewing a compiled system
topology. You are given a list of deterministic findings already detected by static analysis —
do not repeat them verbatim; focus on issues those rules cannot see (cross-cutting risk, blast
radius, sequencing, cost/perf tradeoffs). ${SCHEMA_HINT}`

const CORRECTIVE_NOTE = `Your previous reply was not valid JSON matching the schema. ${SCHEMA_HINT}`

interface ChatMessage { role: string; content: string }

async function callAndExtractContent(
  settings: LlmSettings,
  messages: ChatMessage[],
  chat: typeof llmChat,
): Promise<string> {
  const body = { model: settings.model, response_format: { type: 'json_object' }, messages }
  const raw = await chat(settings.baseUrl, settings.apiKey, JSON.stringify(body))
  const parsed = JSON.parse(raw) as { error?: { message?: string }; choices?: { message: { content: string } }[] }
  if (parsed.error) throw new Error(parsed.error.message ?? 'LLM error')
  return parsed.choices![0].message.content
}

export async function requestReview(
  settings: LlmSettings,
  context: string,
  chat: typeof llmChat = llmChat,
): Promise<AiIssue[]> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: context },
  ]
  const content = await callAndExtractContent(settings, messages, chat)
  try {
    return validateReviewResponse(content)
  } catch {
    const retryMessages: ChatMessage[] = [...messages, { role: 'system', content: CORRECTIVE_NOTE }]
    const retryContent = await callAndExtractContent(settings, retryMessages, chat)
    return validateReviewResponse(retryContent) // rethrows on a second failure — no further retry
  }
}

export async function pingLlm(settings: LlmSettings, chat: typeof llmChat = llmChat): Promise<void> {
  const body = { model: settings.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }
  await chat(settings.baseUrl, settings.apiKey, JSON.stringify(body))
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/llmReview.test.ts` → PASS (8 tests: 2 buildReviewContext + 5
requestReview + 1 pingLlm).

- [ ] **Step 5: Full verify**

Run: `npx vitest run` → full suite green.
Run: `npm run build` → strict tsc + vite build green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/llmReview.ts src/lib/llmReview.test.ts
git commit -m "feat(llm): review context builder, schema validation, and retrying client"
```

---

## Task 7: Settings modal + theme toggle `[sonnet]`

**D6 asserting test this task owns:** `saved key renders masked and is not echoed into the input
value`.

**Files:** create `src/app/world/SettingsModal.tsx`, `src/app/world/SettingsModal.test.tsx`;
modify `src/app/world/WorldShell.tsx`.

**Grounding — real current source, quoted verbatim.**

`src/app/store/ui.store.ts` (full file — theme system is fully wired, NO new plumbing needed):
```ts
interface UiStore {
  themeMode: 'dark' | 'light'
  setThemeMode: (mode: 'dark' | 'light') => void
}
export const useUiStore = create<UiStore>((set) => ({
  themeMode: (localStorage.getItem('scalemap-theme-mode') as 'dark' | 'light') ?? 'dark',
  setThemeMode: (mode) => { localStorage.setItem('scalemap-theme-mode', mode); set({ themeMode: mode }) },
}))
```
`src/App.tsx`'s `useThemeBootstrap()` applies `--color-*` custom properties and
`document.documentElement.dataset.theme` on every `themeMode` change — the toggle below only
needs to call `setThemeMode`; the visual flip is already automatic.

`src/lib/theme.ts` `CATEGORY_COLORS.messaging.accent = '#9C8CE0'` (verified, line 77) — the
violet AI-chip color T8 needs; not this task's concern but confirmed here since both tasks read
the same file.

`src/index.css` confirms every token this modal uses already exists: `--color-node-border`,
`--color-surface`, `--color-node-base`, `--color-danger`, `--color-warning`, `--color-success`,
`--color-accent`, `--color-text-primary/secondary/muted`.

**The capture-phase Esc precedent** (`src/app/world/ServerView.tsx`, real source, verbatim —
Phase 3 already solved exactly this problem for its own escape-without-nav-change need):
```tsx
// WorldShell owns a `window` keydown listener in the BUBBLE phase that calls
// `useNavStore.getState().up()` on Escape, but first bails if `e.defaultPrevented`
// (WorldShell.tsx:44-49). ServerView mounts AFTER WorldShell, so a bubble-phase listener
// registered here would fire second and couldn't call preventDefault() in time. Registering
// in the CAPTURE phase instead guarantees this handler runs before WorldShell's bubble
// handler regardless of mount order — capture always precedes bubble for a `window` listener
// on an event that originates from a descendant node.
useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && selRef.current) {
      e.preventDefault()          // capture phase → WorldShell's bubble Esc sees defaultPrevented and skips nav.up
      setSelection(null)
    }
  }
  window.addEventListener('keydown', onKey, true)     // CAPTURE
  return () => window.removeEventListener('keydown', onKey, true)
}, [])
```
`SettingsModal` reuses this exact mechanism, with `stopPropagation()` added as the primary
mechanism (the modal isn't a `window`-scoped state clear like ServerView's selection — it must
guarantee WorldShell's bubble handler, ALSO on `window`, never runs at all for this keydown, not
just that it sees `defaultPrevented`; `stopPropagation` during the capture pass halts the event's
entire remaining traversal, including its own return trip through `window`'s bubble phase, so
`preventDefault` here is redundant belt-and-suspenders matching ServerView's own comment style,
not the sole guard).

`src/app/world/WorldShell.tsx` (full file, current real source, 144 lines — quoted in full since
this task's diff touches the header, the state list, and the render tree):
```tsx
// The app's entire post-home body: breadcrumb header + animated level router.
// AZ level renders <AzCanvas/> (Task 13); Task 14 adds file actions here.
import { useEffect, useState, type CSSProperties } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useNavStore } from '../store/nav.store'
import { useFileStore } from '../store/file.store'
import { useWorldStore } from '../store/world.store'
import { useSimulationStore } from '../store/simulation.store'
import { Breadcrumb } from './Breadcrumb'
import { SimControls } from './SimControls'
import { ScrubberV2 } from './ScrubberV2'
import { GlobeView } from './GlobeView'
import { RegionView } from './RegionView'
import { ServerView } from './ServerView'
import { WorldPanel } from './panels/WorldPanel'
import { AzCanvas } from './AzCanvas'
import { openWorldViaDialog, saveWorld } from './fileOps'

const hdrBtn: CSSProperties = {
  background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
  borderRadius: 4, padding: '3px 10px', cursor: 'pointer',
  font: '11px var(--font-mono)', color: 'var(--color-text-secondary)',
}

export function WorldShell() {
  const nav = useNavStore()
  const reduced = useReducedMotion()
  const dirty = useFileStore(s => s.dirty)
  const [fileError, setFileError] = useState<string | null>(null)
  const running = useSimulationStore(s => s.running)
  const [placeMode, setPlaceMode] = useState(false)
  const [selectedPopulationId, setSelectedPopulationId] = useState<string | null>(null)

  useEffect(() => {
    if (nav.level !== 'globe' && placeMode) setPlaceMode(false)
  }, [nav.level, placeMode])

  useEffect(() => { /* dev-only __scalemapDebug hook, unchanged */ }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return
      if (e.key === 'Escape') { useNavStore.getState().up(); return }
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); useWorldStore.getState().redo(); return }
      if (meta && e.key.toLowerCase() === 'z') { e.preventDefault(); useWorldStore.getState().undo(); return }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const view =
    nav.level === 'globe' ? (
      <GlobeView placeMode={placeMode} onExitPlaceMode={() => setPlaceMode(false)} onPopulationPlaced={setSelectedPopulationId} />
    ) :
    nav.level === 'region' ? <RegionView /> :
    nav.level === 'az' ? <AzCanvas /> :
    <ServerView />

  const viewKey = `${nav.level}:${nav.regionId ?? ''}:${nav.azId ?? ''}:${nav.serverId ?? ''}`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: 'var(--color-canvas)' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 16px', borderBottom: '1px solid var(--color-toolbar-border)', background: 'var(--color-toolbar)' }}>
        <Breadcrumb />
        <SimControls />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ font: '10px var(--font-mono)', color: 'var(--color-text-muted)' }}>esc = up one level</span>
          {dirty && <span style={{ color: 'var(--color-warning)', font: '10px var(--font-mono)' }}>● unsaved</span>}
          <button style={hdrBtn} onClick={() => { /* New */ }}>New</button>
          <button style={hdrBtn} onClick={() => { /* Open */ }}>Open</button>
          <button style={hdrBtn} onClick={() => { /* Save */ }}>Save</button>
          <button style={hdrBtn} onClick={() => { /* Save As */ }}>Save As</button>
        </div>
      </header>
      {fileError && ( /* unchanged */ )}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <main style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
          <AnimatePresence mode="wait">
            <motion.div key={viewKey} /* unchanged */>{view}</motion.div>
          </AnimatePresence>
        </main>
        <WorldPanel running={running} placeMode={placeMode} onTogglePlaceMode={() => setPlaceMode(p => !p)} selectedPopulationId={selectedPopulationId} />
      </div>
      <ScrubberV2 />
    </div>
  )
}
```

**Produces (exact, per `GROUNDING.md` §J):**
```tsx
export interface SettingsModalProps { open: boolean; onClose: () => void }
export function SettingsModal(props: SettingsModalProps): ReactElement | null
```

- [ ] **Step 1: Write the failing test `src/app/world/SettingsModal.test.tsx`**

```tsx
// src/app/world/SettingsModal.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SettingsModal } from './SettingsModal'
import { useUiStore } from '../store/ui.store'
import { useNavStore } from '../store/nav.store'
import * as tauri from '../../lib/tauri'

vi.mock('../../lib/tauri', () => ({
  loadLlmSettings: vi.fn(),
  saveLlmSettings: vi.fn(),
  pingLlm: vi.fn(),
}))

const mockLoad = tauri.loadLlmSettings as unknown as ReturnType<typeof vi.fn>
const mockSave = tauri.saveLlmSettings as unknown as ReturnType<typeof vi.fn>
const mockPing = tauri.pingLlm as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  mockLoad.mockReset().mockResolvedValue({ baseUrl: '', apiKey: '', model: '' })
  mockSave.mockReset().mockResolvedValue(undefined)
  mockPing.mockReset().mockResolvedValue(undefined)
  useUiStore.setState({ themeMode: 'dark' })
  useNavStore.setState({ level: 'globe', regionId: null, azId: null, serverId: null })
})

describe('SettingsModal', () => {
  it('returns null when closed', () => {
    const { container } = render(<SettingsModal open={false} onClose={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('theme toggle reflects and sets themeMode', async () => {
    render(<SettingsModal open={true} onClose={() => {}} />)
    await waitFor(() => expect(mockLoad).toHaveBeenCalled())

    expect(screen.getByText('dark')).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByText('light'))
    expect(useUiStore.getState().themeMode).toBe('light')
    expect(screen.getByText('light')).toHaveAttribute('aria-pressed', 'true')
  })

  it('esc closes without changing nav level', async () => {
    // Mirrors WorldShell's real bubble-phase Escape handler verbatim (see this task's grounding
    // quote) — bail if defaultPrevented, else nav.up(). Registered on window BEFORE the modal
    // mounts, so a bubble-phase listener here would fire FIRST if registration order (not
    // capture-vs-bubble) were what determined the outcome — same proof technique as
    // ServerView.interaction.test.tsx.
    const worldShellLikeHandler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (e.key === 'Escape') useNavStore.getState().up()
    }
    window.addEventListener('keydown', worldShellLikeHandler)
    const onClose = vi.fn()
    try {
      render(<SettingsModal open={true} onClose={onClose} />)
      await waitFor(() => expect(mockLoad).toHaveBeenCalled())
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(useNavStore.getState().level).toBe('globe')
    } finally {
      window.removeEventListener('keydown', worldShellLikeHandler)
    }
  })

  it('saved key renders masked and is not echoed into the input value', async () => {
    mockLoad.mockResolvedValue({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-abcdefgh1234', model: 'gpt-4o-mini' })
    render(<SettingsModal open={true} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByLabelText('apiKey')).toHaveAttribute('placeholder', '•••• 1234'))
    expect(screen.getByLabelText('apiKey')).toHaveValue('')
  })

  it('save dispatches saveLlmSettings with typed values', async () => {
    render(<SettingsModal open={true} onClose={() => {}} />)
    await waitFor(() => expect(mockLoad).toHaveBeenCalled())

    fireEvent.change(screen.getByLabelText('baseUrl'), { target: { value: 'http://localhost:4141/v1' } })
    fireEvent.change(screen.getByLabelText('apiKey'), { target: { value: 'sk-new-key-999' } })
    fireEvent.change(screen.getByLabelText('model'), { target: { value: 'gpt-4o-mini' } })
    fireEvent.click(screen.getByText('Save'))

    expect(mockSave).toHaveBeenCalledWith({ baseUrl: 'http://localhost:4141/v1', apiKey: 'sk-new-key-999', model: 'gpt-4o-mini' })
  })

  it('test connection surfaces ping success and failure', async () => {
    render(<SettingsModal open={true} onClose={() => {}} />)
    await waitFor(() => expect(mockLoad).toHaveBeenCalled())

    mockPing.mockResolvedValueOnce(undefined)
    fireEvent.click(screen.getByText('Test connection'))
    await waitFor(() => expect(screen.getByText('ok')).toBeInTheDocument())

    mockPing.mockRejectedValueOnce(new Error('connection refused'))
    fireEvent.click(screen.getByText('Test connection'))
    await waitFor(() => expect(screen.getByText('connection refused')).toBeInTheDocument())
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/world/SettingsModal.test.tsx`
Expected: FAIL — `Cannot find module './SettingsModal'`.

- [ ] **Step 3: Write `src/app/world/SettingsModal.tsx`**

```tsx
// src/app/world/SettingsModal.tsx
// Global Settings surface (spec D8): the app's theme toggle and BYO LLM endpoint config live
// here — the ONLY sanctioned home for either concern. Appearance flips a fully-wired-but-so-far
// UI-less theme system (see this task's grounding — the toggle only calls setThemeMode, nothing
// else to plumb). AI Review persists { baseUrl, apiKey, model } through T5's Rust-backed
// commands, OUTSIDE world.store/serializer per D6 — this modal must never import either.
import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { useUiStore } from '../store/ui.store'
import { loadLlmSettings, saveLlmSettings, pingLlm, type LlmSettings } from '../../lib/tauri'

export interface SettingsModalProps {
  open: boolean
  onClose: () => void
}

const backdropStyle: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
}
const surfaceStyle: CSSProperties = {
  width: 420, maxWidth: '92vw', background: 'var(--color-surface)',
  border: '1px solid var(--color-node-border)', borderRadius: 8, padding: 16,
  font: '11px var(--font-mono)', color: 'var(--color-text-primary)',
}
const sectionLabelStyle: CSSProperties = {
  font: '600 10px var(--font-mono)', color: 'var(--color-text-muted)',
  textTransform: 'uppercase', letterSpacing: '0.06em', margin: '14px 0 6px',
}
const fieldLabelStyle: CSSProperties = { display: 'block', marginBottom: 2, color: 'var(--color-text-secondary)' }
const fieldInputStyle: CSSProperties = {
  width: '100%', boxSizing: 'border-box', background: 'var(--color-node-base)',
  border: '1px solid var(--color-node-border)', borderRadius: 4, padding: '5px 7px',
  font: '11px var(--font-mono)', color: 'var(--color-text-primary)', marginBottom: 6,
}
const smallBtnStyle: CSSProperties = {
  background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
  borderRadius: 4, padding: '4px 10px', cursor: 'pointer',
  font: '11px var(--font-mono)', color: 'var(--color-text-secondary)',
}
function segBtnStyle(active: boolean): CSSProperties {
  return {
    flex: 1, padding: '5px 0', textAlign: 'center', cursor: 'pointer',
    background: active ? 'var(--color-accent)' : 'var(--color-node-base)',
    border: '1px solid var(--color-node-border)',
    color: active ? '#fff' : 'var(--color-text-secondary)',
  }
}

function maskedPlaceholder(apiKey: string): string {
  if (!apiKey) return ''
  return `•••• ${apiKey.slice(-4)}`
}

export function SettingsModal({ open, onClose }: SettingsModalProps): ReactElement | null {
  const themeMode = useUiStore(s => s.themeMode)
  const setThemeMode = useUiStore(s => s.setThemeMode)

  // savedKey is kept ONLY to derive the masked placeholder below — it is NEVER rendered into an
  // input's `value` (D6: the stored key must never be echoed back into an editable field).
  const [savedKey, setSavedKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKeyInput, setApiKeyInput] = useState('') // stays '' until the user types a NEW key
  const [model, setModel] = useState('')
  const [testStatus, setTestStatus] = useState<'idle' | 'pending' | 'ok' | 'error'>('idle')
  const [testError, setTestError] = useState('')

  useEffect(() => {
    if (!open) return
    let cancelled = false
    loadLlmSettings().then(s => {
      if (cancelled) return
      setSavedKey(s.apiKey)
      setBaseUrl(s.baseUrl)
      setModel(s.model)
      setApiKeyInput('')
      setTestStatus('idle')
      setTestError('')
    })
    return () => { cancelled = true }
  }, [open])

  // Capture-phase Esc: fires BEFORE WorldShell's bubble-phase Escape-goes-up handler (same
  // mechanism ServerView.tsx already uses — capture always precedes bubble for a `window`
  // listener regardless of mount order). stopPropagation halts the event's entire remaining
  // traversal, including its own return trip through window's bubble phase, so WorldShell's
  // handler never runs for this keydown at all; preventDefault is belt-and-suspenders in case
  // that return trip somehow still occurs (WorldShell's handler also bails on defaultPrevented).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true) // CAPTURE
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open) return null

  const save = () => {
    const settings: LlmSettings = { baseUrl, apiKey: apiKeyInput || savedKey, model }
    saveLlmSettings(settings).then(() => {
      setSavedKey(settings.apiKey)
      setApiKeyInput('')
    })
  }

  const testConnection = () => {
    setTestStatus('pending')
    setTestError('')
    pingLlm({ baseUrl, apiKey: apiKeyInput || savedKey, model })
      .then(() => setTestStatus('ok'))
      .catch(e => {
        setTestStatus('error')
        setTestError(e instanceof Error ? e.message : 'connection failed')
      })
  }

  return createPortal(
    <div style={backdropStyle} onClick={onClose}>
      <div style={surfaceStyle} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ font: '600 12px var(--font-mono)' }}>Settings</span>
          <button style={smallBtnStyle} onClick={onClose}>close</button>
        </div>

        <div style={sectionLabelStyle}>Appearance</div>
        <div style={{ display: 'flex', border: '1px solid var(--color-node-border)', borderRadius: 4, overflow: 'hidden' }}>
          <button type="button" aria-pressed={themeMode === 'dark'} style={segBtnStyle(themeMode === 'dark')} onClick={() => setThemeMode('dark')}>dark</button>
          <button type="button" aria-pressed={themeMode === 'light'} style={segBtnStyle(themeMode === 'light')} onClick={() => setThemeMode('light')}>light</button>
        </div>

        <div style={sectionLabelStyle}>AI Review</div>
        <label style={fieldLabelStyle}>base URL</label>
        <input style={fieldInputStyle} aria-label="baseUrl" placeholder="https://api.openai.com/v1"
          value={baseUrl} onChange={e => setBaseUrl(e.target.value)} />

        <label style={fieldLabelStyle}>API key</label>
        <input style={fieldInputStyle} aria-label="apiKey" type="password"
          placeholder={maskedPlaceholder(savedKey) || 'sk-...'}
          value={apiKeyInput} onChange={e => setApiKeyInput(e.target.value)} />

        <label style={fieldLabelStyle}>model</label>
        <input style={fieldInputStyle} aria-label="model" placeholder="gpt-4o-mini"
          value={model} onChange={e => setModel(e.target.value)} />

        <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }}>
          <button style={smallBtnStyle} onClick={save}>Save</button>
          <button style={smallBtnStyle} onClick={testConnection} disabled={testStatus === 'pending'}>
            {testStatus === 'pending' ? 'testing…' : 'Test connection'}
          </button>
          {testStatus === 'ok' && <span style={{ color: 'var(--color-success)' }}>ok</span>}
          {testStatus === 'error' && <span style={{ color: 'var(--color-danger)' }}>{testError}</span>}
        </div>
      </div>
    </div>,
    document.body,
  )
}
```

- [ ] **Step 4: Modify `src/app/world/WorldShell.tsx`**

```diff
 import { WorldPanel } from './panels/WorldPanel'
 import { AzCanvas } from './AzCanvas'
 import { openWorldViaDialog, saveWorld } from './fileOps'
+import { SettingsModal } from './SettingsModal'
```
```diff
   const [fileError, setFileError] = useState<string | null>(null)
   const running = useSimulationStore(s => s.running)
+  const [settingsOpen, setSettingsOpen] = useState(false)
   const [placeMode, setPlaceMode] = useState(false)
```
```diff
         <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
+          <button style={hdrBtn} aria-label="settings" onClick={() => setSettingsOpen(true)}>⚙</button>
           <span style={{ font: '10px var(--font-mono)', color: 'var(--color-text-muted)' }}>esc = up one level</span>
```
```diff
       <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
         ...(unchanged)...
       </div>
+      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
       <ScrubberV2 />
     </div>
   )
 }
```
The gear is the FIRST child of the right-side header `<div>` (i.e. right of `<SimControls/>`,
left of the `esc = up one level` hint) — per `GROUNDING.md` §J.

- [ ] **Step 5: Run tests + build**

Run: `npx vitest run src/app/world/SettingsModal.test.tsx` → PASS (6 tests).
Run: `npx vitest run` → full suite green (WorldShell has no dedicated test file to update — its
only consumers are integration-level, unaffected by an additively-added button/portal).
Run: `npm run build` → succeeds.

- [ ] **Step 6: Live smoke**

Strict port 1420, zero app console errors, screenshots, stop server after. Story: click the ⚙ →
modal opens over the current view → click `light` → **entire app flips to light mode live**
(globe/panel backgrounds, text, borders — screenshot before/after) → click `dark` → flips back →
reload the page → theme persisted (localStorage `scalemap-theme-mode`) → reopen Settings, type a
`baseUrl`/`apiKey`/`model`, Save → reopen Settings again → apiKey input shows empty with
placeholder `•••• <last4>` (never the raw key) → Esc closes the modal without changing the
current nav level (verify breadcrumb unchanged) → click the backdrop → also closes.

- [ ] **Step 7: Commit**

```bash
git add src/app/world/SettingsModal.tsx src/app/world/SettingsModal.test.tsx src/app/world/WorldShell.tsx
git commit -m "feat(settings): global settings modal — live theme toggle and AI endpoint config"
```

---

## Task 8: AI review section + smoke stub `[sonnet]`

**D6 asserting step this task owns:** the live smoke's grep of the saved `.scalemap` (localStorage
mock) for the API key → absent.

**Files:** create `src/app/world/panels/AiReviewSection.tsx`,
`src/app/world/panels/AiReviewSection.test.tsx`, `scripts/llm-stub.mjs`; modify
`src/app/world/panels/AnalysisTab.tsx`, `src/app/world/panels/WorldPanel.tsx`,
`src/app/world/WorldShell.tsx` (post-T7 version, real by the time this task executes).

> **Reconstruction disclaimer (read before applying this task's AnalysisTab/WorldPanel diffs):**
> Tasks 1–4 have not executed yet at fragment-writing time. `WorldPanel.tsx` TODAY (verified,
> quoted below) still has the OLD `'findings'` tab with inline findings JSX — Task 4 replaces
> that with `'analysis'` + `AnalysisTab.tsx` per the EXACT contract pinned in `skeleton.md`'s
> Task 4 spec and `GROUNDING.md` §G (`navigateToEntity`, `unsuppressedCompileFindings`, family
> sections, `AnalysisTab()` with **no props yet**). The two blocks below reconstruct that
> contract-accurate T4 output so this task's diff has something concrete to apply against; when
> T8 actually executes (after T1–T4 have really landed, per the serial task order), apply the
> diff's **intent** — add an `openSettings` prop to `AnalysisTab`/`WorldPanelProps`, mount
> `AiReviewSection` at the top of the family sections, thread `openSettings` through
> `WorldPanel` — against the REAL T4 files rather than pasting the reconstruction verbatim if
> their literal internal structure (styling, helper names) differs in ways that don't affect the
> pinned contract.

**Grounding — real current `WorldPanel.tsx` (quoted in full, 79 lines, confirms the CURRENT
pre-T4 state so the reconstruction below is legible as a diff, not asserted as-is):**
```tsx
import { useState } from 'react'
import { TopologyPanel } from './TopologyPanel'
import { BlueprintPanel } from './BlueprintPanel'
import { PlacementPanel } from './PlacementPanel'
import { TrafficPanel } from './TrafficPanel'
import { useCompiledWorld } from '../useCompiledWorld'
import { EventsTab } from '../EventsTab'
import { CostTab } from '../CostTab'
import { panel, smallBtn, sectionLabel } from './panelStyles'

type Tab = 'topology' | 'blueprints' | 'placements' | 'traffic' | 'findings' | 'events' | 'cost'

export interface WorldPanelProps {
  running: boolean
  placeMode: boolean
  onTogglePlaceMode: () => void
  selectedPopulationId: string | null
}

export function WorldPanel({ running, placeMode, onTogglePlaceMode, selectedPopulationId }: WorldPanelProps) {
  const [tab, setTab] = useState<Tab>('topology')
  const { findings } = useCompiledWorld()
  const tabs: { id: Tab; label: string }[] = [
    { id: 'topology', label: 'Topology' },
    { id: 'blueprints', label: 'Blueprints' },
    { id: 'placements', label: 'Placements' },
    { id: 'traffic', label: 'Traffic' },
    { id: 'findings', label: `Findings (${findings.length})` },
    { id: 'events', label: 'Events' },
    { id: 'cost', label: 'Cost' },
  ]
  return (
    <aside style={panel}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
        {tabs.map(t => ( /* ... */ ))}
      </div>
      <fieldset disabled={running} style={{ border: 'none', margin: 0, padding: 0 }}>
        {tab === 'topology' && <TopologyPanel />}
        {tab === 'blueprints' && <BlueprintPanel />}
        {tab === 'placements' && <PlacementPanel />}
        {tab === 'traffic' && ( <TrafficPanel placeMode={placeMode} onTogglePlaceMode={onTogglePlaceMode} selectedPopulationId={selectedPopulationId} /> )}
        {tab === 'findings' && ( /* inline findings JSX — T4 deletes this */ )}
        {tab === 'events' && <EventsTab />}
        {tab === 'cost' && <CostTab />}
      </fieldset>
    </aside>
  )
}
```

**Reconstructed T4 output — `AnalysisTab.tsx` (contract per `skeleton.md` Task 4 /
`GROUNDING.md` §G; props-less, as G explicitly states "In T4, AnalysisTab takes no props yet"):**
```tsx
// src/app/world/panels/AnalysisTab.tsx (T4 output, reconstructed)
import { useMemo, type ReactElement } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useNavStore } from '../../store/nav.store'
import { useCompiledWorld } from '../useCompiledWorld'
import { runAnalysis } from '../../../lib/analysis/runAnalysis'
import type { AnalysisFinding, AnalysisFamily } from '../../../lib/analysis/types'
import type { CompileFinding, CompiledWorld, WorldDoc } from '../../../lib/world/types'
import { sectionLabel } from './panelStyles'

interface NavApi {
  goRegion: (regionId: string) => void
  goAz: (regionId: string, azId: string) => void
  goServer: (regionId: string, azId: string, serverId: string) => void
}

export function navigateToEntity(id: string, doc: WorldDoc, compiled: CompiledWorld, nav: NavApi): boolean {
  if (doc.regions[id]) { nav.goRegion(id); return true }
  if (doc.azs[id]) { nav.goAz(doc.azs[id].regionId, id); return true }
  if (doc.servers[id]) {
    const az = doc.azs[doc.servers[id].azId]
    if (az) { nav.goServer(az.regionId, az.id, id); return true }
  }
  const inst = compiled.instances[id]
  if (inst) { nav.goServer(inst.regionId, inst.azId, inst.serverId); return true }
  return false
}

export function unsuppressedCompileFindings(analysis: AnalysisFinding[], compile: CompileFinding[]): CompileFinding[] {
  const suppressedPathIds = new Set(
    analysis.filter(f => f.ruleId === 'blocked-dependency-path')
      .map(f => f.id.slice('blocked-dependency-path:'.length)),
  )
  return compile.filter(c => {
    if (c.kind !== 'blocked-path') return true
    return !suppressedPathIds.has(c.id.slice('finding-'.length))
  })
}

const FAMILY_LABEL: Record<AnalysisFamily, string> = { structural: 'Structural', network: 'Network', capacity: 'Capacity' }

export function AnalysisTab(): ReactElement {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const displayBatch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const findings = useMemo(() => runAnalysis(doc, compiled, displayBatch), [compiled, displayBatch?.simMs])
  const compileFindings = useMemo(() => unsuppressedCompileFindings(findings, compiled.findings), [findings, compiled.findings])

  return (
    <div>
      {(['structural', 'network', 'capacity'] as const).map(family => {
        const group = findings.filter(f => f.family === family)
        if (group.length === 0) return null
        return (
          <div key={family}>
            <div style={sectionLabel}>{FAMILY_LABEL[family]}</div>
            {/* ... finding rows: severity chip, title, why, fix, affected chips calling
                navigateToEntity(id, doc, compiled, useNavStore.getState()) ... */}
          </div>
        )
      })}
      {compileFindings.length > 0 && ( <div><div style={sectionLabel}>Compile</div>{/* ... */}</div> )}
      {findings.length === 0 && compileFindings.length === 0 && (
        <div style={{ color: 'var(--color-text-muted)' }}>No findings — the compiled world is clean.</div>
      )}
    </div>
  )
}
```
**Reconstructed T4 output — `WorldPanel.tsx`'s relevant diff** (rename tab, merged count, no
`openSettings` yet):
```tsx
type Tab = 'topology' | 'blueprints' | 'placements' | 'traffic' | 'analysis' | 'events' | 'cost'
// ... tabs array: { id: 'analysis', label: `Analysis (${analysisCount})` } ...
// ... {tab === 'analysis' && <AnalysisTab />} ...
```

**Now this task's actual diffs, on top of the reconstruction above:**

- [ ] **Step 1: Write the failing test `src/app/world/panels/AiReviewSection.test.tsx`**

```tsx
// src/app/world/panels/AiReviewSection.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AiReviewSection } from './AiReviewSection'
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import * as tauri from '../../../lib/tauri'
import * as llmReview from '../../../lib/llmReview'
import { createRegion } from '../../../lib/world/factories'

vi.mock('../../../lib/tauri', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../lib/tauri')>()
  return { ...actual, loadLlmSettings: vi.fn() }
})
vi.mock('../../../lib/llmReview', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../lib/llmReview')>()
  return { ...actual, buildReviewContext: vi.fn(() => '{}'), requestReview: vi.fn() }
})

const mockLoad = tauri.loadLlmSettings as unknown as ReturnType<typeof vi.fn>
const mockRequestReview = llmReview.requestReview as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useNavStore.setState({ level: 'globe', regionId: null, azId: null, serverId: null })
  mockLoad.mockReset()
  mockRequestReview.mockReset()
})

describe('AiReviewSection', () => {
  it('unconfigured state links to settings', async () => {
    mockLoad.mockResolvedValue({ baseUrl: '', apiKey: '', model: '' })
    const openSettings = vi.fn()
    render(<AiReviewSection openSettings={openSettings} />)
    await waitFor(() => expect(screen.getByText(/Open Settings/i)).toBeInTheDocument())
    fireEvent.click(screen.getByText(/Open Settings/i))
    expect(openSettings).toHaveBeenCalledTimes(1)
  })

  it('review renders cards on success', async () => {
    mockLoad.mockResolvedValue({ baseUrl: 'http://localhost:4141/v1', apiKey: '', model: 'x' })
    mockRequestReview.mockResolvedValue([{
      title: 'Consider a read replica', severity: 'warning', confidence: 0.8, affected: [],
      reasoning: 'single writer under sustained load', recommendation: 'add a replica',
      estimated_effort: 'medium',
    }])
    render(<AiReviewSection openSettings={() => {}} />)
    await waitFor(() => expect(screen.getByText('Review architecture')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Review architecture'))
    await waitFor(() => expect(screen.getByText('Consider a read replica')).toBeInTheDocument())
    expect(screen.getByText('80%')).toBeInTheDocument()
  })

  it('in-flight disables the button', async () => {
    mockLoad.mockResolvedValue({ baseUrl: 'http://localhost:4141/v1', apiKey: '', model: 'x' })
    let resolveReview: (v: unknown) => void = () => {}
    mockRequestReview.mockReturnValue(new Promise(res => { resolveReview = res }))
    render(<AiReviewSection openSettings={() => {}} />)
    await waitFor(() => expect(screen.getByText('Review architecture')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Review architecture'))
    await waitFor(() => expect(screen.getByText('reviewing…')).toBeInTheDocument())
    expect(screen.getByText('reviewing…').closest('button')).toBeDisabled()
    resolveReview([])
  })

  it('error keeps prior cards and shows message', async () => {
    mockLoad.mockResolvedValue({ baseUrl: 'http://localhost:4141/v1', apiKey: '', model: 'x' })
    mockRequestReview.mockResolvedValueOnce([{
      title: 'first issue', severity: 'info', confidence: 0.5, affected: [],
      reasoning: 'r', recommendation: 'x', estimated_effort: 'low',
    }])
    render(<AiReviewSection openSettings={() => {}} />)
    await waitFor(() => expect(screen.getByText('Review architecture')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Review architecture'))
    await waitFor(() => expect(screen.getByText('first issue')).toBeInTheDocument())

    mockRequestReview.mockRejectedValueOnce(new Error('malformed review response'))
    fireEvent.click(screen.getByText('Review architecture'))
    await waitFor(() => expect(screen.getByText('malformed review response')).toBeInTheDocument())
    expect(screen.getByText('first issue')).toBeInTheDocument() // prior card retained
  })

  it('card affected chip navigates to a server', async () => {
    const region = createRegion('us-east-1')
    useWorldStore.setState(s => ({ doc: { ...s.doc, regions: { ...s.doc.regions, [region.id]: region } } }))
    mockLoad.mockResolvedValue({ baseUrl: 'http://localhost:4141/v1', apiKey: '', model: 'x' })
    mockRequestReview.mockResolvedValue([{
      title: 'region risk', severity: 'warning', confidence: 0.6, affected: [region.id],
      reasoning: 'r', recommendation: 'x', estimated_effort: 'low',
    }])
    render(<AiReviewSection openSettings={() => {}} />)
    await waitFor(() => expect(screen.getByText('Review architecture')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Review architecture'))
    await waitFor(() => expect(screen.getByText(region.id)).toBeInTheDocument())
    fireEvent.click(screen.getByText(region.id))
    expect(useNavStore.getState().level).toBe('region')
    expect(useNavStore.getState().regionId).toBe(region.id)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/world/panels/AiReviewSection.test.tsx`
Expected: FAIL — `Cannot find module './AiReviewSection'`.

- [ ] **Step 3: Write `src/app/world/panels/AiReviewSection.tsx`**

**Judgment call — the `openSettings`-only prop vs. passing `currentAnalysisFindings` down.**
`skeleton.md`'s "Produces (exact)" line for this component is literally
`{ openSettings: () => void }` — one prop — but the surrounding prose says
`currentAnalysisFindings` "= the runAnalysis(...) result AnalysisTab already computes; pass it
down **or recompute in the section** — prefer passing... to avoid a second run." Those two
sentences pull in different directions (an exact one-prop signature vs. a stated preference for
a second prop). Since `skeleton.md`'s header mandates expanding signatures exactly, not
redesigning them, and the prose explicitly names "recompute in the section" as a sanctioned
alternative, this plan keeps the literal one-prop signature and has `AiReviewSection` recompute
`runAnalysis` itself (a cheap, pure call per spec D3 — "analysis runs continuously, cheaply").
**Flagging this choice explicitly**, since it resolves a real tension rather than a
non-existent one — if a reviewer prefers the "avoid a second run" reading instead, add a
`findings: AnalysisFinding[]` prop here and pass `AnalysisTab`'s own `findings` down (the diff
in Step 4 below would drop one line and gain another).

```tsx
// src/app/world/panels/AiReviewSection.tsx
// On-demand AI architecture review UI (Phase 6, D8). Mounted at the top of AnalysisTab (Step 4).
// A circular import with AnalysisTab.tsx is deliberate and safe here: AnalysisTab imports the
// AiReviewSection COMPONENT, and this file imports AnalysisTab's navigateToEntity HELPER — both
// bindings are used only inside render/event-handler bodies (never at module top-level), so ESM's
// live-binding resolution handles the cycle the same way React container/child components
// routinely reference each other's siblings-exported helpers.
import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useCompiledWorld } from '../useCompiledWorld'
import { runAnalysis } from '../../../lib/analysis/runAnalysis'
import { loadLlmSettings } from '../../../lib/tauri'
import { buildReviewContext, requestReview, type AiIssue } from '../../../lib/llmReview'
import { navigateToEntity } from './AnalysisTab'
import { CATEGORY_COLORS } from '../../../lib/theme'

export interface AiReviewSectionProps {
  openSettings: () => void
}

type ReviewState = 'idle' | 'in-flight' | 'done' | 'error'

const chipStyle: CSSProperties = {
  display: 'inline-block', padding: '1px 6px', borderRadius: 3,
  font: '10px var(--font-mono)', color: '#fff', background: CATEGORY_COLORS.messaging.accent,
}
const smallBtnStyle: CSSProperties = {
  background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
  borderRadius: 4, padding: '3px 8px', cursor: 'pointer',
  font: '11px var(--font-mono)', color: 'var(--color-text-secondary)',
}
const linkBtnStyle: CSSProperties = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
  font: '11px var(--font-mono)', color: 'var(--color-accent)', textDecoration: 'underline',
}
const SEVERITY_COLOR = { critical: 'var(--color-danger)', warning: 'var(--color-warning)', info: 'var(--color-text-muted)' } as const

export function AiReviewSection({ openSettings }: AiReviewSectionProps): ReactElement {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const displayBatch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const nav = useNavStore()

  // Recomputed here rather than threaded down as a prop — see this step's judgment-call note.
  const currentAnalysisFindings = useMemo(
    () => runAnalysis(doc, compiled, displayBatch),
    [doc, compiled, displayBatch],
  )

  const [configured, setConfigured] = useState<boolean | null>(null)
  const [state, setState] = useState<ReviewState>('idle')
  const [issues, setIssues] = useState<AiIssue[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    loadLlmSettings().then(s => setConfigured(s.baseUrl.trim().length > 0))
  }, [])

  const review = async () => {
    setState('in-flight')
    setError('')
    try {
      const settings = await loadLlmSettings()
      const context = buildReviewContext(doc, compiled, currentAnalysisFindings, displayBatch)
      const result = await requestReview(settings, context)
      setIssues(result)
      setState('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'review failed')
      setState('error') // previous cards (issues state) are intentionally left untouched
    }
  }

  if (configured === false) {
    return (
      <div style={{ marginBottom: 12 }}>
        <span style={chipStyle}>AI</span>
        <div style={{ marginTop: 4, color: 'var(--color-text-muted)' }}>
          No AI endpoint configured. <button style={linkBtnStyle} onClick={openSettings}>Open Settings</button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={chipStyle}>AI</span>
        <button disabled={state === 'in-flight'} onClick={review} style={smallBtnStyle}>
          {state === 'in-flight' ? 'reviewing…' : 'Review architecture'}
        </button>
      </div>
      {state === 'error' && <div style={{ color: 'var(--color-danger)', marginTop: 4 }}>{error}</div>}
      {issues.map((issue, i) => (
        <div key={i} style={{ marginTop: 8, borderTop: '1px solid var(--color-node-border)', paddingTop: 6 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={chipStyle}>AI</span>
            <span>{issue.title}</span>
            <span style={{ color: SEVERITY_COLOR[issue.severity] }}>{issue.severity}</span>
            <span style={{ color: 'var(--color-text-muted)' }}>{`${Math.round(issue.confidence * 100)}%`}</span>
          </div>
          <div>{issue.reasoning}</div>
          <div style={{ color: 'var(--color-text-muted)' }}>{`→ ${issue.recommendation}`}</div>
          <div style={{ color: 'var(--color-text-muted)' }}>{`${issue.estimated_effort} effort`}</div>
          <div style={{ display: 'flex', gap: 4, marginTop: 2, flexWrap: 'wrap' }}>
            {issue.affected.map(id => (
              <button key={id} style={smallBtnStyle} onClick={() => navigateToEntity(id, doc, compiled, nav)}>{id}</button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: Modify `src/app/world/panels/AnalysisTab.tsx`** (on top of the T4 reconstruction
above)

```diff
 import { useMemo, type ReactElement } from 'react'
 import { useWorldStore } from '../../store/world.store'
 import { useSimulationStore } from '../../store/simulation.store'
 import { useNavStore } from '../../store/nav.store'
 import { useCompiledWorld } from '../useCompiledWorld'
 import { runAnalysis } from '../../../lib/analysis/runAnalysis'
 import type { AnalysisFinding, AnalysisFamily } from '../../../lib/analysis/types'
 import type { CompileFinding, CompiledWorld, WorldDoc } from '../../../lib/world/types'
 import { sectionLabel } from './panelStyles'
+import { AiReviewSection } from './AiReviewSection'
```
```diff
-export function AnalysisTab(): ReactElement {
+export interface AnalysisTabProps {
+  openSettings: () => void
+}
+
+export function AnalysisTab({ openSettings }: AnalysisTabProps): ReactElement {
   const doc = useWorldStore(s => s.doc)
   const compiled = useCompiledWorld()
   const displayBatch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
   const findings = useMemo(() => runAnalysis(doc, compiled, displayBatch), [compiled, displayBatch?.simMs])
   const compileFindings = useMemo(() => unsuppressedCompileFindings(findings, compiled.findings), [findings, compiled.findings])

   return (
     <div>
+      <AiReviewSection openSettings={openSettings} />
       {(['structural', 'network', 'capacity'] as const).map(family => {
```
`navigateToEntity`/`unsuppressedCompileFindings` are unchanged — `AiReviewSection` imports
`navigateToEntity` directly from this file (Step 3), not through a prop.

- [ ] **Step 5: Modify `src/app/world/panels/WorldPanel.tsx`** (on top of the T4 reconstruction)

```diff
 export interface WorldPanelProps {
   running: boolean
   placeMode: boolean
   onTogglePlaceMode: () => void
   selectedPopulationId: string | null
+  openSettings: () => void
 }

-export function WorldPanel({ running, placeMode, onTogglePlaceMode, selectedPopulationId }: WorldPanelProps) {
+export function WorldPanel({ running, placeMode, onTogglePlaceMode, selectedPopulationId, openSettings }: WorldPanelProps) {
```
```diff
-        {tab === 'analysis' && <AnalysisTab />}
+        {tab === 'analysis' && <AnalysisTab openSettings={openSettings} />}
```
If T4's real `WorldPanel.test.tsx` renders `<WorldPanel>` without stubbing `../../../lib/tauri`,
`AiReviewSection`'s mount effect will call the REAL `loadLlmSettings()` (resolving to empty
defaults via the mock transport) — harmless, but add `openSettings={() => {}}` to that file's
existing render call sites when this step lands, and wrap any assertion that follows a tab switch
in `waitFor` if an act()-async warning shows up.

- [ ] **Step 6: Modify `src/app/world/WorldShell.tsx`** (post-T7 version — `settingsOpen` already
exists from Task 7)

```diff
-        <WorldPanel
-          running={running}
-          placeMode={placeMode}
-          onTogglePlaceMode={() => setPlaceMode(p => !p)}
-          selectedPopulationId={selectedPopulationId}
-        />
+        <WorldPanel
+          running={running}
+          placeMode={placeMode}
+          onTogglePlaceMode={() => setPlaceMode(p => !p)}
+          selectedPopulationId={selectedPopulationId}
+          openSettings={() => setSettingsOpen(true)}
+        />
```
This reuses the EXACT `settingsOpen` state Task 7 introduced for the gear button — one state,
two triggers (the gear, and this "open Settings" link chain), per `GROUNDING.md` §M.

- [ ] **Step 7: Write `scripts/llm-stub.mjs`**

```js
#!/usr/bin/env node
// scripts/llm-stub.mjs — OpenAI-compatible smoke stub for Phase 6's live review-with-retry story
// (spec D9). Usage: node scripts/llm-stub.mjs [port=4141]
//
// POST /v1/chat/completions: the FIRST request ever received returns a malformed content string
// (exercises llmReview.ts's one-shot retry live); every request after that returns a canned,
// valid, fenced `{ issues: [...] }` payload. CORS is wide-open (OPTIONS preflight +
// Access-Control-Allow-*) since the browser mock transport (tauriMock.ts's llm_chat) calls this
// via a direct fetch() from the webview/browser origin.
import http from 'node:http'

const port = Number(process.argv[2]) || 4141
let hitCount = 0

const CANNED_ISSUES = {
  issues: [
    {
      title: 'us-east-1a is a single point of failure for the web tier',
      severity: 'warning',
      confidence: 0.82,
      affected: ['az-us-east-1a'],
      reasoning: 'Every web instance resolved to one AZ; an AZ-level outage takes the whole tier down with no failover path.',
      recommendation: 'Spread web placements across at least two AZs in the region.',
      estimated_effort: 'medium',
    },
    {
      title: 'Database reachable from the public internet',
      severity: 'critical',
      confidence: 0.91,
      affected: ['srv-db-1'],
      reasoning: 'The firewall rule ahead of the db port allows source any, so the datastore is internet-facing.',
      recommendation: 'Restrict the db port to internal source CIDRs only; front it with the app tier.',
      estimated_effort: 'low',
    },
  ],
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      hitCount += 1
      console.log(`[llm-stub] hit #${hitCount}`)
      const content = hitCount === 1
        ? 'not json at all'
        : '```json\n' + JSON.stringify(CANNED_ISSUES) + '\n```'
      const body = JSON.stringify({ choices: [{ message: { content } }] })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(body)
    })
    return
  }

  res.writeHead(404)
  res.end()
})

server.listen(port, () => {
  console.log(`[llm-stub] listening on http://localhost:${port}/v1`)
})
```

- [ ] **Step 8: Run to verify the new test passes**

Run: `npx vitest run src/app/world/panels/AiReviewSection.test.tsx` → PASS (5 tests).

- [ ] **Step 9: Full verify**

Run: `npx vitest run` → full suite green (including T4's `AnalysisTab.test.tsx` and
`WorldPanel.test.tsx`, updated per Step 5's note).
Run: `npm run build` → strict tsc + vite build green.

- [ ] **Step 10: Live smoke**

Strict port 1420, zero app console errors, screenshots, stop the dev server AND the stub after.
Story: `node scripts/llm-stub.mjs 4141` in a separate terminal → open the app, Settings → set
baseUrl `http://localhost:4141/v1`, model `stub`, Save → Analysis tab → the AI section shows
`Review architecture` (no longer the unconfigured hint) → click it → button shows `reviewing…`
and is disabled → stub terminal log shows **TWO hits** (`hit #1`, `hit #2` — proves the
malformed→retry→success path fired live, not just in the unit test) → two AI-chipped cards
render beside the deterministic findings, with clickable affected chips that navigate → Save the
world (mock localStorage path) → **grep the saved `.scalemap` payload in localStorage for the
configured API key string → confirm it is ABSENT** (this is the D6 assertion this task owns —
the settings never touch `world.store`/`serializer`, so there is nothing to find). Stop the stub
(`Ctrl-C`) and the dev server.

- [ ] **Step 11: Commit**

```bash
git add src/app/world/panels/AiReviewSection.tsx src/app/world/panels/AiReviewSection.test.tsx \
  src/app/world/panels/AnalysisTab.tsx src/app/world/panels/WorldPanel.tsx \
  src/app/world/WorldShell.tsx scripts/llm-stub.mjs
git commit -m "feat(llm): on-demand AI architecture review with retrying stub-proven flow"
```
