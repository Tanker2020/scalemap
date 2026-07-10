# Phase 6: Analysis Rule Engine + LLM Reviewer — Design

**Date:** 2026-07-10 · **Status:** Approved direction (umbrella spec §7 / §9 row 6 — the
FINAL phase; D14 governs the LLM reviewer). **Binding companions:** umbrella
`2026-07-08-world-model-multiscale-simulation-design.md` §7, FROZEN
`2026-07-08-world-engine-contracts.md` (read-only consumers: latest `MetricsBatch` +
`ReplayFrame`s as LLM context — no engine or contract changes this phase).

## Goal

Layer 1: a deterministic analysis engine — three rule families run over the *compiled*
world (exactly what the engine sees), producing findings with severity, clickable
affected ids, a "why", and a fix body — rendered in an upgraded Analysis tab that merges
today's compile findings. Layer 2: an on-demand LLM architecture review against any
OpenAI-compatible endpoint (OpenAI, Anthropic-compatible proxies, OpenRouter, Ollama,
LM Studio), schema-forced JSON, rendered as AI-tagged cards beside the deterministic
findings. API keys live in the app data dir via Tauri commands and are NEVER serialized
into `.scalemap`, logged, or echoed. This phase completes the rebuild; it also retires
the long-stale repo `CLAUDE.md` description of the deleted legacy app.

## Engineering decisions (within the umbrella's envelope)

1. **Analysis module shape.** `src/lib/analysis/`: `types.ts`, `rules/` (one file per
   family), `runAnalysis.ts`. Finding:
   `{ id, ruleId, family: 'structural' | 'network' | 'capacity', severity: 'critical' |
   'warning' | 'info', title, why, fix, affected: string[] }`. Runner:
   `runAnalysis(doc, compiled, lastBatch: MetricsBatch | null) → AnalysisFinding[]` —
   pure; rules registered in ONE array (the old linter's contribution pattern, per
   umbrella §7); the optional metrics batch is input, never fetched. Compile findings
   (`compiled.findings`) are NOT duplicated by rules — the panel merges both lists.
2. **Initial rule registry (12 rules, binding — trigger conditions in the skeleton):**
   *Structural:* `single-az-region` (instances all in one AZ of a region — AZ-level
   SPOF), `no-failover-region` (a population whose region order has exactly one entry /
   world has one active region), `replicas-colocated` (stateful blueprint whose primary
   and ALL replicas share an AZ), `dependency-cycle` (blueprint dependency graph cycle),
   `deep-sync-chain` (http/db dependency chain depth ≥ 4), `unused-managed-service`
   (managed service no dependency targets — info).
   *Network/security:* `blocked-dependency-path` (re-surfaces compile blocked paths with
   a fix body naming the firewall rule/network to change — same affected ids, distinct
   ruleId; the panel shows the analysis version and suppresses the raw compile duplicate
   by path id), `db-port-exposed` (a `db`-protocol dependency target whose server
   firewall allows that port from `'any'`, or a db-serving blueprint with a
   `public`-visibility port), `entry-unreachable` (blueprint has a public port but no
   server hosting it allows that port — first-match-wins evaluated, i.e. the world has a
   front door that's firewalled shut).
   *Capacity/geo:* `ram-oversubscribed` (Σ resident `memLimitMb ?? workload.ramBaseMb`
   > host `ramMb`), `burstable-sustained-load` (burstable VPS whose mean
   `coreUtilization` in `lastBatch` exceeds 0.4 — the credit-drain threshold; skipped
   when no batch), `ocean-crossing-population` (the first region in a population's
   compiled order is >1.5× the great-circle distance of the nearest region present in
   the world — reuse `REGION_GEO` + the haversine already implicit in
   `regionGeo`/`geo.ts`; pick ONE distance source and cite it), `ttl-outlives-detection`
   (`dnsTtlSec × 1000 < healthCheckIntervalMs × healthCheckFailureThreshold` — clients
   re-resolve faster than failure detection concludes; warning with both numbers in the
   why).
3. **Analysis runs continuously, cheaply.** The panel computes
   `useMemo(runAnalysis, [compiled, lastBatch?.simMs])` — static rules re-run on world
   edits, capacity rules refresh at 1 Hz while simulating. No store, no persistence:
   findings are derived data (same stance as compile findings).
4. **Analysis tab (replaces the Findings tab).** WorldPanel's `findings` tab becomes
   `analysis`, label `Analysis (<n>)` where n counts merged deterministic findings.
   Sections per family (+ a `compile` section for unsuppressed compile findings),
   severity chip (critical=danger, warning=warning, info=muted), title, why, fix body,
   and the affected ids as clickable chips that NAVIGATE: regionId→`goRegion`,
   azId→`goAz`, serverId→`goServer`, instanceId→its server's interior, blueprintId/
   placementId/populationId/managedServiceId→no navigation (tooltip explains "shown in
   panels") — resolve id kind by lookup across doc/compiled maps, in that order.
5. **LLM transport is Rust-side.** Browser `fetch` from a webview to arbitrary
   endpoints dies on CORS (OpenAI et al. don't allow webview origins). New Tauri command
   `llm_chat(base_url, api_key, body) → String`: POSTs `{base_url}/chat/completions`
   with `Authorization: Bearer <key>`, JSON body passed through verbatim, 60s timeout,
   returns raw response text; errors map to `Err(String)` with the key REDACTED from any
   message. Dependency: `reqwest` 0.12, `default-features = false`, features
   `["json", "rustls-tls"]` (no OpenSSL). The browser-dev mock (`tauriMock.ts`) performs
   a direct `fetch()` instead — fine for Ollama/LM Studio/local stubs where the user
   controls CORS, and for the smoke stub.
6. **Settings persistence.** `llm_settings.json` in the app data dir (exact pattern of
   `recent_files.json`): `{ baseUrl, apiKey, model }`. Commands `save_llm_settings` /
   `load_llm_settings`; mock mirrors to `localStorage` (browser dev only). Enforced
   invariants: settings never touch `world.store`/`serializer` (grep-verifiable), the UI
   renders the stored key masked (`••••` + last 4), the key never appears in logs,
   errors, or the LLM context payload.
7. **Review client.** `src/lib/llmReview.ts` (pure, mock-invoke-testable):
   `buildReviewContext(doc, compiled, findings, lastBatch)` → compact JSON — the doc
   (minus nothing sensitive; keys aren't in it by D6), compiled findings + analysis
   findings (dedup context per umbrella), and aggregated metrics (world totals +
   per-region/AZ rps/err/p50/health — NOT raw instance maps; keep the payload readable
   and small). `requestReview(settings, context)` → builds a chat request (system
   prompt demanding STRICT JSON matching the D14 schema `{ issues: [{ title, severity,
   confidence, affected, reasoning, recommendation, estimated_effort }] }`, plus
   `response_format: { type: 'json_object' }` — the widely-supported subset), calls the
   command, validates the shape manually (no new deps), retries ONCE on malformed, then
   throws a graceful error. Severity clamps to critical/warning/info; confidence to
   [0,1]; unknown affected ids render unclickable.
8. **Global Settings surface (user-requested 2026-07-10) + AI review UI.** The app has a
   fully-wired theme system (`LIGHT_COLORS`/`DARK_COLORS` in `theme.ts`, `App.tsx`'s
   `useThemeBootstrap` applying tokens + `data-theme`, persisted
   `ui.store.themeMode`) — but NO UI has ever exposed it. Phase 6 adds a ⚙ gear button
   in WorldShell's header (right of SimControls) opening a `SettingsModal` (portal
   overlay, Esc/backdrop closes WITHOUT touching nav — same stopPropagation care as the
   Phase-3 inspector) with two sections:
   - **Appearance:** theme `dark | light` segmented toggle wired to the existing
     `setThemeMode` (no new plumbing; live effect is immediate via the bootstrap).
   - **AI Review:** baseUrl, apiKey (password input, rendered masked `••••` + last 4
     after save), model; save/load via the D6 commands; a `test connection` button
     sending a 1-token ping and reporting ok/error inline.
   The Analysis tab's "AI REVIEW" section then holds only: the `Review architecture`
   button (disabled while a review is in flight; no cancel — requests time out; parked),
   an `unconfigured → open Settings` hint, and the result cards: violet `AI` chip,
   title, severity chip, confidence %, reasoning, recommendation, effort tag, affected
   chips (same navigation as D4). Errors render inline and never clear existing
   deterministic findings. Reviews are ephemeral (not persisted, not serialized).
   With a live theme toggle finally in the app, the phase smoke includes a light-mode
   pass over the main views — known latent hex bypasses were already swept in Phases
   4–5's carry-forwards; any stragglers the smoke exposes get fixed in the final task.
9. **Verification without a real provider.** The live smoke runs a ~40-line local Node
   stub (`scripts/llm-stub.mjs`, committed): an HTTP server implementing
   `POST /v1/chat/completions` with CORS headers, returning a canned valid review on the
   2nd call and a malformed body on the 1st (proves the retry path live). Rust side:
   `cargo test` covers the pure helpers (settings round-trip serde, key redaction) and
   an `llm_chat` integration test against a std `TcpListener` one-shot stub. The
   browser smoke exercises the mock transport; the Rust transport's gate is cargo test +
   `cargo build` — state this split explicitly in the plan.
10. **CLAUDE.md refresh (repo hygiene, final-phase duty).** The repo `CLAUDE.md` still
    describes the deleted legacy app (canvas.store, particleEngine, lint rules,
    ScaleScript, Terraform). The final task rewrites its Project Overview / Architecture
    / Key Decisions / File-format sections to describe the world-model app (4-level nav,
    worldEngine, compileWorld, analysis engine, LLM reviewer, .scalemap v2), preserving
    the Commands/Design-System sections that still hold. `docs/module-boundaries.md`
    gains §O.
11. **Phase-5 carry-forwards absorbed:** population default-label collision (max-suffix
    scan shared by TrafficPanel and GlobeView place-mode), `MAX_GLOBE_ARCS` exported
    from the engine index and imported by `ArcsLayer` (kill the hand-synced copy),
    GlobeScene texture mutation moves `useMemo` → `useLayoutEffect`, a test for
    `buildDrainArcs`' missing-geo fallback.

## Testing & verification

Unit: every rule gets a positive + negative fixture case (rule files are pure);
`runAnalysis` ordering/merge; `buildReviewContext` (shape, size sanity, no `apiKey` key
anywhere in the payload — assert by stringify scan); `requestReview` (happy path,
malformed→retry→ok, retry→fail graceful, severity/confidence clamping) with a mocked
invoke. Component (jsdom): Analysis tab (family grouping, severity chips, affected-chip
navigation dispatches nav actions, compile-duplicate suppression), SettingsModal (theme
toggle calls `setThemeMode` and reflects current mode; AI settings save/load via mocked
commands; masked key display; Esc closes without nav change), AI section (review button
states, cards render canned issues, error state preserves deterministic findings). Rust: `cargo test`
(settings serde round-trip, redaction, `llm_chat` against a TcpListener stub) +
`cargo build`. Live phase-gate story (browser + stub): author a world tripping ≥4 rules
across all three families (single-AZ region + exposed db port + oversubscribed RAM +
TTL/health mismatch) → Analysis tab lists them grouped with working navigation chips →
configure the stub endpoint → `Review architecture` → first stub reply malformed (retry
fires) → AI cards render beside deterministic findings → key shown masked after reload →
grep-style assertion that `.scalemap` save contains no `apiKey` → Settings theme toggle
flips the whole app to light mode live (and back), with a screenshot pass over
globe/region/AZ/server views for unreadable-contrast stragglers. Zero console errors.

## Out of scope (parked list is normative, umbrella §9)

k8s/ECS schedulers, ScaleScript v2, Terraform v2, AI watch-mode (continuous review),
spot instances, managed-service pseudo-internals, review persistence/history, streaming
LLM responses, request cancellation.
