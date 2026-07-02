# Module Boundaries & Ownership Map

Goal: let multiple people work in this codebase at once with minimal merge conflicts,
by making explicit which files belong to which feature area, which files are shared
"hubs" that everyone touches (and therefore need a light-touch convention), and what
the blast radius of a change in each area actually is.

This is a *code organization* map, not a service-decomposition proposal — see the
note at the bottom on why microservices aren't the fix for merge conflicts here.
Findings below were pulled from CodeGraph's call-graph/blast-radius index
(`.codegraph/`), not just file layout, so "who imports this" is call-verified,
not guessed from folder structure.

---

## 1. Feature modules (safe to own independently)

Each block below is a vertical slice — one person/PR can usually work entirely
inside it without touching another slice's files.

### A. Canvas graph editing
Nodes/edges CRUD, undo-redo, packet registry, drag/drop.

| File | Role |
|---|---|
| `src/app/store/canvas.store.ts` (249 lines) | Nodes/edges state, history/future undo stack, packet registry |
| `src/app/canvas/Canvas.tsx` | React Flow wrapper, registers node/edge types — `MiniMap`/`Background` are configured via inline props (not `Canvas.module.css`), so their colors are `var(--color-*)` CSS-variable strings passed directly as prop values rather than class-based; touch alongside `Canvas.module.css` if the canvas-chrome palette changes again (design-system task 9) |
| `src/app/canvas/nodes/BaseNode.tsx` | Compute/network/storage node rendering — `statusColor`/`saturationBorderColor`/`lintColor` (lines ~69-92) already resolve through `var(--color-*)` tokens, so they're theme-reactive. `utilColor`'s low-utilization fallback was fixed (final-review-fix-round, see `.superpowers/sdd/final-review-fix-report.md`) to use the component's existing `accentColor` (theme-aware, resolves `CATEGORY_COLORS[category].accent` in dark / `.foreground.light` in light) instead of the raw dark-mode-only `colors.accent` — one-line swap, `colors.accent` itself is still read elsewhere in this file for the `--node-bg`/`--node-border` CSS custom properties (unaffected, those are deliberately category-tinted not theme-tinted) |
| `src/app/canvas/nodes/GroupNode.tsx` | Container node rendering (VPC/subnet/cluster/etc) — deliberately static: same 12px corner-radius family as `BaseNode` (visual resemblance), but no breathing glow/hover-lift/per-category saturation, so containers stay recessive relative to the nodes placed inside them (design-system task 7) |
| `src/app/canvas/edges/BaseEdge.tsx` | Edge rendering |
| `src/app/sidebar/PropertiesPanel.tsx`, `ContextMenu.tsx`, `EdgeConfigForm.tsx` | Node/edge property editing UI |

**Blast radius:** `BaseNode` has 1 caller (`Canvas.tsx`), `GroupNode` has 1 caller — low fan-out, safe to edit in isolation. `canvas.store.ts`'s packet-registry actions (`addPacketTemplate`/`updatePacketTemplate`/`removePacketTemplate`) are read by `PacketEditor.tsx` and `serializer.ts` — touch those three together.

### B. Simulation engine & live metrics
The particle physics loop and everything that reads its output.

| File | Role |
|---|---|
| `src/app/canvas/simulation/particleEngine.ts` (**~2,450 lines**) | rAF loop, `spawnParticles`, `handleParticleArrival`, `updateAllNodeMetrics` orchestration, `buildSnapshot` — imports the three sub-modules below rather than owning their state directly |
| `src/app/canvas/simulation/particleEngine/circuitBreakers.ts` (169 lines) | `CircuitBreakerEntry`, `getBreaker`/`getAllBreakers`, `recordBreakerResult`, `checkBreakerTransition`, `forceOpenBreakersForNode`, `resetBreakersIfRecovered`, `clearBreakers` |
| `src/app/canvas/simulation/particleEngine/backpressure.ts` (96 lines) | `_activeWorkers`/`_activeConnections`/lambda warm-instance maps, `acquireWorkers`/`releaseWorkerNow`/`scheduleWorkerRelease`, `acquireConnection`/`scheduleConnectionRelease`, `clearBackpressureState` |
| `src/app/canvas/simulation/particleEngine/chaos.ts` (114 lines) | `effectiveMultiplier`, spike/chaos state (`ChaosEntry`, `getChaosFailures`), `clearChaosState` |
| `src/app/canvas/simulation/SimulationOverlay.tsx` | Canvas overlay, batches engine output up to `simulation.store` |
| `src/app/canvas/simulation/useDisplayMetrics.ts` | Live-vs-replay metric resolution hook |
| `src/app/canvas/simulation/PlaybackScrubber.tsx`, `RequestInspector.tsx` | Replay UI, single-particle inspector |
| `src/app/store/simulation.store.ts` (257 lines) | `NodeMetrics`, events, SLO status, inspected request |
| `src/app/store/replay.store.ts`, `metricsHistory.store.ts` | 300-frame health snapshot ring buffer, per-node timeseries |

**Blast radius — still the highest-conflict area in the repo, now split into four files.** `particleEngine.ts` was 2,617 lines in one file with no internal module split; it has since been split (pure code motion, no behavior change) along the lines its own state maps already implied: `particleEngine/circuitBreakers.ts`, `particleEngine/backpressure.ts`, and `particleEngine/chaos.ts` each export pure(r) functions that the main rAF loop in `particleEngine.ts` calls, passing in the node/edge snapshots and callbacks those functions need rather than the sub-modules importing engine-internal state directly. (`tokenBuckets.ts` was considered but not created — no current logic owns token-bucket state yet; add it only when a fix actually needs it.) The four files are still a fan-in of one (only `particleEngine.ts` imports from the three sub-modules; nothing outside the `particleEngine/` directory imports them directly yet), so this split reduces *internal* merge conflict between concurrent changes to breaker/backpressure/chaos logic, not the file's external blast radius. `useDisplayMetrics` has 7 callers (`BaseNode.tsx`, `PropertiesPanel.tsx`, `SimConfigPanel.tsx`) — safe to extend (new fields), risky to change its signature.

### C. Structural linter
Self-contained, already well-factored for parallel work.

| File | Role |
|---|---|
| `src/lib/lint/types.ts` | `LintIssue`/`LintRule`/`LintContext` types |
| `src/lib/lint/rules.ts` (301 lines) | 9 rules + `LINT_RULES` registry array |
| `src/lib/lint/lintGraph.ts` | Builds adjacency once, runs registry |
| `src/lib/lint/classify.ts` | Node-type classification helpers (`isCompute`, `isDatabase`, ...) |
| `src/app/diagnostics/DiagnosticsPanel.tsx` | Renders issues |
| `src/app/store/diagnostics.store.ts` | Issue list + nodeId index |

**Blast radius:** low and well-isolated. `lintGraph` has 2 callers (`Toolbar.tsx`). Each rule in `rules.ts` is an independent pure function appended to one array — **two people adding two different rules will only conflict on the `LINT_RULES = [...]` array line**, not on rule logic. Good candidate for genuinely parallel work with near-zero conflict risk already.

### D. Cost modeling & cloud pricing
| File | Role |
|---|---|
| `src/lib/costModel.ts` (144 lines) | Simulation traffic → monthly cost |
| `src/lib/cloudRegistry.ts` (263 lines) | Per-provider service/pricing catalog, egress tiers |
| `src/lib/regionConfig.ts` (58 lines) | Region metadata |
| `src/app/simulation/CostTracker.tsx` | Renders cost output |

**Blast radius:** `costModel.ts` is imported by `BaseNode.tsx`, `particleEngine.ts`, `nodeConfig.ts`, `PropertiesPanel.tsx` — changing its exported function *signatures* ripples into simulation and node rendering; adding new provider pricing data does not.

### E. Packet system (Flyweight templates)
| File | Role |
|---|---|
| `src/app/simulation/PacketEditor.tsx` | Template CRUD UI (**actively buggy per CLAUDE.md — verify before extending**) |
| `src/app/store/canvas.store.ts` (packet slice only, lines ~27–103) | Template storage, `packetMode` toggle |
| `nodeConfig.ts` packet types (`PacketTemplate`, `PacketMode`, `PacketRegistry`, etc.) | Shared types |

**Blast radius:** `PacketRegistry` type has 5 callers spanning `canvas.store.ts` and `serializer.ts` — packet-format changes must update both together or `.scalemap` file round-tripping breaks silently.

### F. Terraform export / Vault templates / ScaleScript / Serialization
Each is a narrow, single-direction module with few callers — good isolated-PR candidates.

| File | Role | Callers |
|---|---|---|
| `src/lib/terraform/exportTerraform.ts` (177 lines) | Diagram → HCL string, export-only | Toolbar export action |
| `src/lib/vault/templates.ts` (145 lines) | Prebuilt starter diagrams | `HomeScreen.tsx` |
| `src/lib/scalescript.ts` (205 lines) | DSL types + `applyScaleScript()` resolver | `simulation.store.ts` (`activeScript`) |
| `src/lib/serializer.ts` (36 lines) | `.scalemap` JSON read/write | `file.store.ts`, `tauri.ts` |

### G. Rust / Tauri backend
| File | Role |
|---|---|
| `src-tauri/src/commands.rs` (132 lines) | All Tauri commands: save/load diagram, file dialogs, recent files |
| `src-tauri/src/lib.rs`, `main.rs` | Entrypoint wiring |

Entirely separate language/toolchain from the TS frontend — zero merge-conflict overlap with anything above by construction. Good area for someone to own if they're doing file-persistence work (e.g. wiring up `ReportsPanel.tsx` disk export, a roadmap item).

---

## 2. Shared "hub" files (everyone touches these — high conflict risk)

These aren't feature modules; they're registries other code plugs into. The fix
isn't to avoid them, it's to **only ever append/extend, never restructure, in a
routine PR** — restructure them in their own dedicated PR when nobody else has
in-flight changes.

| File | Why it's a hub | Fan-in (CodeGraph-verified) |
|---|---|---|
| `src/lib/nodeConfig.ts` (~380 lines) | `NODE_CONFIG` registry — every node type's icon/category/label | **31 files import it** — the single largest fan-in in the repo. `NodeSimConfig` gained two append-only optional fields (`consistencyLevel`, `replicationLagMs`, GitHub #12) — fan-in count unchanged (no new importers), verified via `grep -rln "from '.*nodeConfig'" src` before/after |
| `src/lib/theme.ts` (120 lines) | `ColorTokens`/`DARK_COLORS`/`LIGHT_COLORS`/`CATEGORY_COLORS`/`FONT_*`/`SPACING`/`MOTION` — small file, but touched by any node/edge visual change. **Known coverage gap:** only the 16 `ColorTokens` keys (`canvas`, `canvasDots`, `nodeBase`, `nodeBorder`, `surface`, `surfaceHover`, `toolbar`, `toolbarBorder`, `textPrimary`, `textSecondary`, `textMuted`, `danger`, `success`, `successText`, `warning`, `accent`) are exposed as `--color-*` CSS custom properties by `App.tsx`'s `useThemeBootstrap` and mirrored in `src/index.css`'s static `:root` fallback (final-review-fix-round). `CATEGORY_COLORS` (messaging/network/storage/etc per-category accents) is **not** exposed to CSS at all — only consumed directly in `.tsx` via inline styles (`BaseNode.tsx`, `GroupNode.tsx`). `Toolbar.module.css`'s Reports (purple/messaging), Diagnostics (teal/network), Inspect/chaos-mode (purple/messaging) accents are hardcoded dark-mode-only hex for this reason — see `.superpowers/sdd/final-review-fix-report.md` for the full audit and the pending decision on whether to promote category foregrounds into `ColorTokens` | Node rendering, group nodes, panels, toolbar |
| `src/index.css` | `:root` holds a **static copy of `DARK_COLORS`/`FONT_*`/`SPACING`/`MOTION`** (restored final-review-fix-round to close a first-paint FOUC gap — before this, the block was empty and every `var(--color-*)` reference was undefined until `App.tsx`'s `useThemeBootstrap` `useEffect` ran post-first-paint). This is a values-only fallback, not a second source of truth — if `theme.ts`'s `DARK_COLORS`/`FONT_*`/`SPACING`/`MOTION` change, update this block to match (nothing enforces the two staying in sync; no test covers this — worth adding a `theme.test.ts` case that parses `index.css` and diffs against `DARK_COLORS` if this drifts) | Every CSS module transitively (first paint only — overridden by the bootstrap effect on mount) |
| `src/app/store/ui.store.ts` | `themeMode: 'dark' \| 'light'` + `setThemeMode` — drives a runtime CSS custom-property bootstrap in `App.tsx` that every panel's CSS module reads via `var(--color-*)`. Persisted to `localStorage` (`scalemap-theme-mode`). Toggled from `Toolbar.tsx` (Sun/Moon button in the Select/Hand/Connect tool cluster) — the only current writer besides the initial bootstrap read | `App.tsx` (bootstrap), `Toolbar.tsx` (toggle UI); read transitively by every CSS module via custom properties, not by direct import. **Also directly imported** by `BaseNode.tsx` and `GroupNode.tsx` (design-system tasks 6/7) — both read `themeMode` to resolve `CATEGORY_COLORS[category].accent` (dark) vs `.foreground.light` (light) into a per-instance `--accent`/`--node-accent` inline style, since `CATEGORY_COLORS` itself isn't theme-mode-aware the way `DARK_COLORS`/`LIGHT_COLORS` are |
| `src/app/store/simulation.store.ts` | `NodeMetrics`/`SimEvent`/`SloStatus` shape — anyone adding a new metric touches this | particleEngine, BaseNode, SimConfigPanel, ReportsPanel |
| `src/app/canvas/simulation/particleEngine.ts` | See §1B — also a hub in the sense that *any* new sim behavior lands here today | N/A (internal, but everyone's diff passes through it) |

**Convention to adopt:** when adding a new node type, only add to `NODE_CONFIG` (one new key) — don't reorder existing keys or reformat the file. Same for `LINT_RULES` and `NODE_SIM_DEFAULTS`. Append-only registries plus small, frequent PRs are what actually reduce conflicts here — restructuring these files is the thing to schedule as its own solo PR.

---

## 3. Suggested ownership split for parallel work

If splitting a sprint's work across people to avoid stepping on each other:

1. **Simulation realism** (per `SRE_Critique.txt`'s blueprints — circuit breakers on edges, thread-pool exhaustion, token-bucket gateways, chaos gray-failures) → §1B. `particleEngine.ts` has been split into `particleEngine/circuitBreakers.ts`, `particleEngine/backpressure.ts`, and `particleEngine/chaos.ts`, so separate fixes to breaker/backpressure/chaos logic can now land in disjoint files instead of one shared 2.6k-line file.
2. **Lint rules** → §1C, already safe for concurrent work, no changes needed.
3. **Packet editor bug fixes** → §1E, isolated to `PacketEditor.tsx` + the packet slice of `canvas.store.ts`.
4. **Cost/pricing model work** → §1D, isolated unless changing `costModel.ts` function signatures.
5. **Terraform/Vault/ScaleScript/Rust persistence** → §1F/G, narrowest blast radius in the repo, good for onboarding or solo side-quests.

---

## 4. Why this is a codebase-organization fix, not a microservices one

Scalemap is a single-process Tauri desktop app: canvas state, the particle engine,
and the Zustand stores all run in one JS runtime because the simulation loop reads
and mutates them synchronously every frame. There's no network boundary to split
services along, so introducing microservices would mean standing up inter-process
communication purely to solve a code-ownership problem — real added complexity
(serialization, latency, deployment) without the deployment-independence benefit
that normally justifies it. The module boundaries above get most of the
conflict-reduction benefit without that cost.
