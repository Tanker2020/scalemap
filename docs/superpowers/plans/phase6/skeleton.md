# Phase 6 Plan Skeleton — Analysis Rule Engine + LLM Reviewer + Settings

Authored by the Phase-6 planning session (Fable). The executor expands each task into a
full plan section per the handoff runbook's Step 0. Signatures and semantics are exact —
expand, don't redesign. D1–D11 cite the phase spec
(`docs/superpowers/specs/2026-07-10-phase6-analysis-llm-design.md`). This is the FINAL
phase of the rebuild.

## Global Constraints (every task inherits these)

- Branch: `phase6-analysis`, cut from `main` (Phase 5 merged; main ≥ `ee51f6a`).
- NO changes under `src/lib/worldEngine/` except T9's sanctioned one-liner (export
  `MAX_GLOBE_ARCS` — a carry-forward). Contract types FROZEN. Forced drift →
  `.superpowers/sdd/contract-drift.md` `## PHASE 6`.
- strict tsc; `npm run build` green per commit; `cargo build` (from `src-tauri/`) green
  for every task touching Rust.
- SECURITY (spec D6, non-negotiable): the API key is never serialized into `.scalemap`
  (settings never touch `world.store`/`serializer`), never logged or `console.*`'d,
  never included in review-context payloads, REDACTED from every error string on both
  sides, rendered only masked after save, input type=password. Any test or smoke that
  can assert one of these, must.
- New dependency allowed: `reqwest = { version = "0.12", default-features = false,
  features = ["json", "rustls-tls"] }` in `src-tauri/Cargo.toml` (T5 only). NO new npm
  dependencies anywhere (JSON-schema validation is hand-rolled).
- Full `border` shorthand rule; jsdom pragma + jest-dom for component tests; pure tests
  node env; views read stores; world mutations via existing actions (this phase adds
  NONE — analysis findings are derived data, LLM settings live outside the world doc).
- Theme: all new UI uses `var(--color-*)` tokens exclusively — the theme toggle goes
  LIVE this phase, so hardcoded palette hexes are now user-visible bugs, not latent ones.
- Live smokes controller-run on strict port 1420 (browser + `tauriMock` transport), ZERO
  app console errors, screenshots, stop servers (dev + stub) after. The Rust transport's
  gate is `cargo test` + `cargo build`, NOT the browser smoke — say so in reports.
- Ledger: `.superpowers/sdd/progress.md` `## PHASE 6`. Boundaries doc gains §O (T9).

## File Structure

```
src/lib/analysis/                       # NEW — Layer 1
  types.ts                              # T1: AnalysisFinding, AnalysisRule, families
  runAnalysis.ts                        # T1: registry + runner
  rules/structural.ts (+ .test.ts)      # T1: 6 rules
  rules/network.ts (+ .test.ts)         # T2: 3 rules
  rules/capacity.ts (+ .test.ts)        # T3: 4 rules
  __fixtures__/worlds.ts                # T1 (shared rule fixtures; T2/T3 extend)
src/lib/llmReview.ts (+ .test.ts)       # T6: context builder + request/validate/retry
src/app/world/panels/AnalysisTab.tsx    # T4 (+ .test.tsx): replaces the findings tab body
src/app/world/panels/WorldPanel.tsx     # T4: tab rename findings→analysis; T8 mounts AI section
src/app/world/panels/AiReviewSection.tsx# T8 (+ .test.tsx)
src/app/world/SettingsModal.tsx         # T7 (+ .test.tsx): ⚙ gear, Appearance + AI Review
src/app/world/WorldShell.tsx            # T7: gear button in header
src/lib/tauri.ts + src/lib/tauriMock.ts # T5: llm settings + chat wrappers (+ mock)
src-tauri/src/commands.rs               # T5: save/load_llm_settings, llm_chat (+ pure helpers)
src-tauri/src/lib.rs                    # T5: register 3 commands
src-tauri/Cargo.toml                    # T5: reqwest
scripts/llm-stub.mjs                    # T8: OpenAI-compatible smoke stub (canned + malformed-first)
CLAUDE.md                               # T9: rewrite for the world-model app
docs/module-boundaries.md               # T9: §O
```

Dependency order: T1 → T2 → T3 → T4; T5 → T6; T7 after T5; T8 after {T4, T6, T7};
T9 last. Serial T1…T9.

---

## Task 1: Analysis core + structural family `[sonnet]`

**Files:** create `src/lib/analysis/types.ts`, `runAnalysis.ts`,
`rules/structural.ts`, `rules/structural.test.ts`, `__fixtures__/worlds.ts`.

**Produces (exact):**

```ts
// types.ts
import type { WorldDoc, CompiledWorld } from '../world/types'
import type { MetricsBatch } from '../worldEngine/types'

export type AnalysisFamily = 'structural' | 'network' | 'capacity'
export type AnalysisSeverity = 'critical' | 'warning' | 'info'

export interface AnalysisFinding {
  id: string                       // `${ruleId}:${primaryAffectedId}` — stable across runs
  ruleId: string
  family: AnalysisFamily
  severity: AnalysisSeverity
  title: string                    // short, e.g. 'Single-AZ region'
  why: string                      // one/two sentences, concrete entity names inlined
  fix: string                      // actionable body, names the panel/edit that resolves it
  affected: string[]               // entity ids, most-specific first
}

export interface AnalysisInput { doc: WorldDoc; compiled: CompiledWorld; lastBatch: MetricsBatch | null }
export interface AnalysisRule { id: string; family: AnalysisFamily; run: (input: AnalysisInput) => AnalysisFinding[] }
```

```ts
// runAnalysis.ts
export const ANALYSIS_RULES: AnalysisRule[]   // T1 seeds structural; T2/T3 append — ONE array
export function runAnalysis(doc: WorldDoc, compiled: CompiledWorld, lastBatch: MetricsBatch | null): AnalysisFinding[]
// concat of every rule's output, ordered: severity (critical→info) then family then ruleId.
```

**Structural rules (exact triggers, spec D2):**
- `single-az-region` (warning): a region whose compiled instances all live in ONE AZ
  while the region has ≥1 instance. Affected: [regionId, azId].
- `no-failover-region` (warning; critical when the world has populations): a population
  whose `populationRegionOrder` has exactly one entry. Affected: [populationId, regionId].
- `replicas-colocated` (warning): stateful blueprint with a primary instance and ≥1
  replica instance where every replica shares the primary's AZ. Affected: [blueprintId,
  azId, ...instanceIds].
- `dependency-cycle` (critical): cycle in the blueprint dependency graph
  (blueprint→blueprint edges only; DFS with stack coloring). One finding per distinct
  cycle, affected = the cycle's blueprintIds in order.
- `deep-sync-chain` (warning): a simple path of `http`/`db` dependencies with length ≥ 4
  edges. One finding for the LONGEST such chain only. Affected: chain blueprintIds.
- `unused-managed-service` (info): a managed service no blueprint dependency targets.
  Affected: [managedServiceId].

Fixtures: `__fixtures__/worlds.ts` exports small doc-builder helpers (reuse the style of
existing engine test fixtures — read `src/lib/worldEngine/index.test.ts` first) so every
rule test builds a minimal world + `compileWorld(doc)`.

**Named test cases:** each rule gets `fires: <scenario>` + `silent: <counter-scenario>`
(12 minimum), plus `runAnalysis orders by severity then family` and `finding ids stable
across two runs`.

**Commit:** `feat(analysis): analysis core, registry, and structural rule family`

---

## Task 2: Network/security family `[sonnet]`

**Files:** create `rules/network.ts`, `rules/network.test.ts`; register in
`ANALYSIS_RULES`.

**Rules (exact triggers, spec D2):**
- `blocked-dependency-path` (critical): one finding per compiled BLOCKED path, carrying
  a fix body derived from `blockReason` (firewall-deny → name the rule id + server and
  say "add an allow rule above it in the server's firewall (Server view → firewall)";
  no-port-binding → name the missing host mapping; network-isolation → name the compose
  networks). `affected: [fromInstanceId, targetId, serverId]` and `id` reuses the
  compiled path id so the panel can suppress the raw compile duplicate (spec D4).
- `db-port-exposed` (critical): (a) any `db`-protocol dependency whose target instance's
  server firewall ALLOWS the dep port from `'any'` (first-match-wins evaluation — reuse
  `src/lib/world/network.ts` helpers if exported, else replicate the match loop and say
  so), or (b) a blueprint that is the target of any `db`-protocol dependency and itself
  declares a `public`-visibility port. Affected: [serverId|blueprintId, ruleId?].
- `entry-unreachable` (warning): a blueprint with a `public` port none of whose hosting
  servers' firewalls allow that port (evaluated first-match-wins with source `'any'`).
  Affected: [blueprintId, ...serverIds].

**Named test cases:** 3×(fires/silent) + `blocked-path fix body names the denying rule`
+ `db exposure via public visibility fires without a firewall hole`.

**Commit:** `feat(analysis): network/security rule family`

---

## Task 3: Capacity/geo family `[sonnet]`

**Files:** create `rules/capacity.ts`, `rules/capacity.test.ts`; register in
`ANALYSIS_RULES`.

**Rules (exact triggers, spec D2):**
- `ram-oversubscribed` (warning): Σ over a server's resident instances of
  `(container memLimitMb ?? blueprint workload.ramBaseMb)` > server `specs.ramMb`.
  Affected: [serverId, ...instanceIds]. Why-string includes both numbers.
- `burstable-sustained-load` (warning; REQUIRES lastBatch, silent without): a
  `burstable` VPS whose mean `coreUtilization` in `lastBatch.servers[id]` > 0.4.
  Affected: [serverId].
- `ocean-crossing-population` (warning): with ≥2 regions in the world: the first entry
  of the population's `populationRegionOrder` is more than 1.5× the great-circle
  distance of the nearest world region. Distance source: `REGION_GEO` lat/lon +
  haversine — implement a local `haversineKm` in this file (the globe's `geo.ts` is
  app-layer; lib must not import from app — check `docs/module-boundaries.md` §N).
  Affected: [populationId, firstRegionId, nearestRegionId].
- `ttl-outlives-detection` (warning): `routing.dnsTtlSec * 1000 <
  routing.healthCheckIntervalMs * routing.healthCheckFailureThreshold`. Why-string shows
  both sides of the inequality with units. Affected: [] (world-scoped).

**Named test cases:** 4×(fires/silent) + `burstable rule silent with null batch` +
`haversine sanity (NYC→London ≈ 5570km ±2%)`.

**Commit:** `feat(analysis): capacity/geo rule family`

---

## Task 4: Analysis tab `[sonnet]`

**Files:** create `src/app/world/panels/AnalysisTab.tsx`, `AnalysisTab.test.tsx`;
modify `WorldPanel.tsx` (tab id `findings`→`analysis`, label `Analysis (<n>)` where n =
analysis findings + unsuppressed compile findings; the inline findings JSX moves into
AnalysisTab); update `WorldPanel.test.tsx` accordingly.

**Produces (exact):**

```tsx
export function AnalysisTab(): ReactElement
// useMemo(runAnalysis(doc, compiled, displayBatch), [compiled, displayBatch?.simMs])
// where displayBatch = scrubBatch ?? latestBatch. Sections in order: structural /
// network / capacity (each only when non-empty, family heading + findings sorted
// severity-first), then 'compile' = compiled.findings whose path-derived id is NOT
// already claimed by a blocked-dependency-path finding (suppression by id, spec D4).
// Finding row: severity chip (danger/warning/muted token colors), title, why, fix
// (muted, prefixed '→ '), affected chips.

export function navigateToEntity(id: string, doc: WorldDoc, compiled: CompiledWorld, nav: NavApi): boolean
// Exported pure-ish helper (nav injected for tests): resolve id against doc.regions →
// goRegion; doc.azs → goAz(regionId, id); doc.servers → goServer(region, az, id);
// compiled.instances → goServer of its server; else return false (chip renders with
// title 'edit via panels', no-op). Returns whether navigation happened.
```

**Named jsdom tests:** `groups findings by family with severity ordering`; `affected
chip navigates to a server`; `instance chip navigates to its server's interior`;
`blueprint chip does not navigate`; `compile duplicate suppressed when
blocked-dependency-path covers the same path id`; `tab label counts merged findings`.

**Live smoke:** author a world tripping ≥4 rules across families (single-AZ region +
db-port-exposed + ram-oversubscribed + ttl-outlives-detection); the tab groups them;
chips navigate (screenshot per hop).

**Commit:** `feat(analysis): analysis tab with family grouping and entity navigation`

---

## Task 5: Rust — LLM settings + chat commands `[sonnet]`

**Files:** modify `src-tauri/Cargo.toml` (reqwest per Global Constraints),
`src-tauri/src/commands.rs` (append — read the file's existing patterns first; mirror
the `recent_files.json` app-data-dir approach), `src-tauri/src/lib.rs` (register),
`src/lib/tauri.ts` + `src/lib/tauriMock.ts` (wrappers + mock — read both first and
mirror their existing invoke/fallback pattern).

**Produces (exact):**

```rust
const LLM_SETTINGS_FILE: &str = "llm_settings.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LlmSettings { pub base_url: String, pub api_key: String, pub model: String }

/// Replace every occurrence of `key` in `msg` with "•••" (no-op for keys < 8 chars,
/// which are masked entirely). Pure — unit-tested.
fn redact(msg: &str, key: &str) -> String

#[tauri::command] pub fn save_llm_settings(app: AppHandle, settings: LlmSettings) -> Result<(), String>
#[tauri::command] pub fn load_llm_settings(app: AppHandle) -> LlmSettings   // Default on any error
/// POST {base_url}/chat/completions, Bearer auth, `body` passed through verbatim,
/// 60s timeout, returns raw response text (ANY status — the frontend reads OpenAI-style
/// error JSON itself); Err only on transport failure, message passed through redact().
#[tauri::command] pub async fn llm_chat(base_url: String, api_key: String, body: String) -> Result<String, String>
```

```ts
// tauri.ts additions (mock mirrors with localStorage + direct fetch)
export interface LlmSettings { baseUrl: string; apiKey: string; model: string }
export async function saveLlmSettings(s: LlmSettings): Promise<void>
export async function loadLlmSettings(): Promise<LlmSettings>
export async function llmChat(baseUrl: string, apiKey: string, body: string): Promise<string>
```

(Field-name mapping snake↔camel happens in the TS wrapper via explicit
serialization — Tauri v2 camelCases command ARG names but NOT struct fields; verify
against the existing commands' conventions and state the finding in the plan.)

**Named tests:** Rust `cargo test`: `redact masks the key everywhere and short keys
entirely`; `settings serde round-trip`; `llm_chat returns body from a TcpListener stub
and redacts the key from connection-refused errors` (async test against a one-shot stub
on an ephemeral port; use `tauri::async_runtime` or `#[tokio::test]` per what the
project compiles with — verify). TS (jsdom): mock wrappers round-trip localStorage.

**Commit:** `feat(llm): rust-side llm settings persistence and chat transport`

---

## Task 6: Review client `[sonnet]`

**Files:** create `src/lib/llmReview.ts`, `llmReview.test.ts`.

**Produces (exact):**

```ts
import type { WorldDoc, CompiledWorld } from './world/types'
import type { MetricsBatch } from './worldEngine/types'
import type { AnalysisFinding } from './analysis/types'
import type { LlmSettings } from './tauri'

export interface AiIssue {
  title: string
  severity: 'critical' | 'warning' | 'info'      // unknown values clamp to 'info'
  confidence: number                              // clamped [0,1]
  affected: string[]                              // strings only; others dropped
  reasoning: string
  recommendation: string
  estimated_effort: 'low' | 'medium' | 'high'     // unknown → 'medium'
}

export function buildReviewContext(doc: WorldDoc, compiled: CompiledWorld, findings: AnalysisFinding[], lastBatch: MetricsBatch | null): string
// JSON string: { world: doc, deterministicFindings: [{ruleId,severity,title,affected}],
// compileFindings: [{kind,severity,message}], metrics: null | { world: {totalRps,
// errorRate}, regions: [{id,rps,errorRate,p50Ms,health}], azs: [likewise] } }.
// NEVER includes instance-level maps or any settings value.

export function validateReviewResponse(raw: string): AiIssue[]
// Parses the assistant message content (the raw arg is the CONTENT string, not the HTTP
// envelope), tolerates a ```json fence, requires { issues: [...] }, clamps per AiIssue
// comments, throws Error('malformed review response') otherwise.

export function requestReview(settings: LlmSettings, context: string, chat?: typeof llmChat): Promise<AiIssue[]>
// Builds { model, response_format: { type: 'json_object' }, messages: [system, user] }
// — system prompt: senior infra architect, respond ONLY with JSON matching the schema
// (schema inlined in the prompt), consider the deterministic findings as known context
// and do not repeat them verbatim. Parses the OpenAI envelope (choices[0].message.
// content; an { error: {...} } envelope throws with its message). On validate failure:
// ONE retry appending a corrective system line; then rethrow. `chat` injectable for
// tests (defaults to the T5 wrapper).

export async function pingLlm(settings: LlmSettings, chat?: typeof llmChat): Promise<void>
// max_tokens:1 'ping' completion; resolves ok / throws with a redact-safe message.
```

**Named tests (mock `chat`):** `context contains no apiKey value` (stringify scan with a
canary key); `context aggregates region metrics and omits instance maps`; `happy path
parses fenced json`; `malformed then valid succeeds via one retry with corrective
message appended`; `two malformed responses throw gracefully`; `error envelope surfaces
provider message`; `severity/confidence/effort clamping`; `ping sends max_tokens 1`.

**Commit:** `feat(llm): review context builder, schema validation, and retrying client`

---

## Task 7: Settings modal + theme toggle `[sonnet]`

**Files:** create `src/app/world/SettingsModal.tsx`, `SettingsModal.test.tsx`; modify
`src/app/world/WorldShell.tsx` (⚙ ghost button right of SimControls; local
`settingsOpen` state; read the header's existing button styling first).

**Produces (exact):**

```tsx
export interface SettingsModalProps { open: boolean; onClose: () => void }
export function SettingsModal(props: SettingsModalProps): ReactElement | null
```

Portal overlay (`position:fixed`, backdrop `rgba(0,0,0,0.55)`, centered surface ~420px,
token-styled). Backdrop click + Esc close (Esc handler `stopPropagation`s so the nav
shell's Esc-goes-up never fires while open — verify against WorldShell's key handling
the way Phase 3's inspector did). Sections:
1. **APPEARANCE** — segmented `dark | light` control reflecting `useUiStore.themeMode`,
   clicking calls `setThemeMode` (effect is live via App.tsx's existing bootstrap —
   nothing else to wire).
2. **AI REVIEW** — on open, `loadLlmSettings()`; baseUrl text input (placeholder
   `https://api.openai.com/v1`), apiKey `type=password` (after a saved key exists,
   render placeholder `•••• <last4>` and only overwrite on new input), model text input
   (placeholder `gpt-4o-mini`); `Save` → `saveLlmSettings`; `Test connection` →
   `pingLlm` with inline ok/error (error text passed through as-is — it is already
   redacted upstream).

**Named jsdom tests:** `theme toggle reflects and sets themeMode`; `esc closes without
changing nav level`; `saved key renders masked and is not echoed into the input value`;
`save dispatches saveLlmSettings with typed values`; `test connection surfaces ping
success and failure`.

**Live smoke:** gear opens modal; theme flips the ENTIRE app light and back live
(screenshots of globe header + panel in both modes); settings persist across reload
(mock localStorage path).

**Commit:** `feat(settings): global settings modal — live theme toggle and AI endpoint config`

---

## Task 8: AI review section + smoke stub `[sonnet]`

**Files:** create `src/app/world/panels/AiReviewSection.tsx`, `AiReviewSection.test.tsx`,
`scripts/llm-stub.mjs`; mount the section at the top of `AnalysisTab`.

**Produces (exact):**

```tsx
export function AiReviewSection(props: { openSettings: () => void }): ReactElement
// (WorldPanel threads openSettings up to WorldShell's settingsOpen state — add the prop
// plumb-through, keep it a plain prop chain.)
// States: unconfigured (loadLlmSettings baseUrl empty) → hint + 'open Settings' link;
// idle → 'Review architecture' button; in-flight → disabled + spinner text
// 'reviewing…'; done → AiIssue cards (violet AI chip #A78BFA local const is FORBIDDEN —
// use a new --color-ai token? NO: use CATEGORY_COLORS.messaging import from theme.ts,
// which is the violet); error → inline danger text, previous cards retained.
// Review click: buildReviewContext(doc, compiled, currentAnalysisFindings, displayBatch)
// → requestReview. Cards: AI chip, title, severity chip, `${Math.round(confidence*100)}%`,
// reasoning, recommendation (→ prefixed), effort tag, affected chips via T4's
// navigateToEntity.
```

```js
// scripts/llm-stub.mjs — node scripts/llm-stub.mjs [port=4141]
// POST /v1/chat/completions + CORS (OPTIONS + Access-Control-Allow-*): FIRST request
// returns choices[0].message.content = 'not json at all' (exercises the retry), every
// later request returns a canned valid { issues: [ ...2 plausible issues whose affected
// reference plausible entity ids... ] } inside a ```json fence. Logs each hit.
```

**Named jsdom tests (mock llmReview module):** `unconfigured state links to settings`;
`review renders cards on success`; `error keeps prior cards and shows message`;
`in-flight disables the button`; `card affected chip navigates`.

**Live smoke (browser mock transport):** start the stub; configure
`http://localhost:4141/v1` via the Settings modal; Review → stub log shows TWO hits
(retry proven live) → cards render beside deterministic findings; save the world and
grep the `.scalemap` (localStorage mock) for the key — absent. Stop the stub.

**Commit:** `feat(llm): on-demand AI architecture review with retrying stub-proven flow`

---

## Task 9: Final — phase smoke, light-mode pass, CLAUDE.md, §O, carry-forwards `[sonnet]`

**Files:** `CLAUDE.md` (rewrite Project Overview / Architecture / Key Decisions /
Diagram File Format sections for the world-model app: 4-level nav, world/ +
worldEngine/ + analysis/ modules, compileWorld gate, engine facade + stores, packet
system's CURRENT role, `.scalemap` v2, LLM reviewer + key-security note; keep
Commands/Design System/Key Dependencies accurate — update the dependency table: add
three/r3f/drei, remove dagre/lint mentions; Roadmap section: parked list from umbrella
§9); `docs/module-boundaries.md` §O (analysis + llm + settings modules, boundary rules:
`lib/analysis` imports world+worldEngine types only; `llmReview` imports tauri wrappers;
key-security invariants restated); Phase-5 carry-forwards:
`src/lib/worldEngine/index.ts` exports `MAX_GLOBE_ARCS` + `ArcsLayer.tsx` imports it
(delete the local copy), population default-label max-suffix helper shared by
`TrafficPanel`/`GlobeView`, `GlobeScene` texture mutation `useMemo`→`useLayoutEffect`,
`buildDrainArcs` missing-geo fallback test added to `globeArcs.test.ts`.

**Done bar (this task's checklist):** full suite + `npm run build` + `cargo build` +
`cargo test` green; the spec's phase-gate live story end-to-end (rules → navigation →
stub review with retry → masked key → no key in saved file → LIVE THEME FLIP with
screenshot pass over globe/region/AZ/server in light mode, fixing any unreadable
straggler hexes found); ledger `## PHASE 6` summary + a REBUILD-COMPLETE note (all six
phases shipped; remaining parked list). Update the ledger and leave the branch for the
user's merge decision.

**Commit:** `docs: CLAUDE.md for the world-model app; module boundaries §O; globe carry-forwards`
