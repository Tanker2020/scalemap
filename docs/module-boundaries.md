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
| `src/app/canvas/Canvas.tsx` | React Flow wrapper, registers node/edge types |
| `src/app/canvas/nodes/BaseNode.tsx` | Compute/network/storage node rendering |
| `src/app/canvas/nodes/GroupNode.tsx` | Container node rendering (VPC/subnet/cluster/etc) |
| `src/app/canvas/edges/BaseEdge.tsx` | Edge rendering |
| `src/app/sidebar/PropertiesPanel.tsx`, `ContextMenu.tsx`, `EdgeConfigForm.tsx` | Node/edge property editing UI |

**Blast radius:** `BaseNode` has 1 caller (`Canvas.tsx`), `GroupNode` has 1 caller — low fan-out, safe to edit in isolation. `canvas.store.ts`'s packet-registry actions (`addPacketTemplate`/`updatePacketTemplate`/`removePacketTemplate`) are read by `PacketEditor.tsx` and `serializer.ts` — touch those three together.

### B. Simulation engine & live metrics
The particle physics loop and everything that reads its output.

| File | Role |
|---|---|
| `src/app/canvas/simulation/particleEngine.ts` (**2,617 lines**) | rAF particle loop — circuit breakers, retries, queueing, chaos mode |
| `src/app/canvas/simulation/SimulationOverlay.tsx` | Canvas overlay, batches engine output up to `simulation.store` |
| `src/app/canvas/simulation/useDisplayMetrics.ts` | Live-vs-replay metric resolution hook |
| `src/app/canvas/simulation/PlaybackScrubber.tsx`, `RequestInspector.tsx` | Replay UI, single-particle inspector |
| `src/app/store/simulation.store.ts` (257 lines) | `NodeMetrics`, events, SLO status, inspected request |
| `src/app/store/replay.store.ts`, `metricsHistory.store.ts` | 300-frame health snapshot ring buffer, per-node timeseries |

**Blast radius — this is the highest-conflict area in the repo.** `particleEngine.ts` is 2.6k lines in one file with no internal module split (circuit breakers, thread/queue backpressure, chaos anomalies, token buckets all live in the same file per the ideas in `SRE_Critique.txt`). Anyone touching simulation realism ends up in this same file. **Recommendation:** if more than one person is actively extending simulation behavior, split `particleEngine.ts` internally along the lines already implied by its own state maps — e.g. `particleEngine/circuitBreakers.ts`, `particleEngine/backpressure.ts`, `particleEngine/chaos.ts`, `particleEngine/tokenBuckets.ts` — each exporting pure functions the main rAF loop calls, rather than one shared file. `useDisplayMetrics` has 7 callers (`BaseNode.tsx`, `PropertiesPanel.tsx`, `SimConfigPanel.tsx`) — safe to extend (new fields), risky to change its signature.

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
| `src/lib/nodeConfig.ts` (368 lines) | `NODE_CONFIG` registry — every node type's icon/category/label | **31 files import it** — the single largest fan-in in the repo |
| `src/lib/theme.ts` (28 lines) | `COLORS`/`CATEGORY_COLORS` — small file, but touched by any node/edge visual change | Node rendering, group nodes, panels |
| `src/app/store/simulation.store.ts` | `NodeMetrics`/`SimEvent`/`SloStatus` shape — anyone adding a new metric touches this | particleEngine, BaseNode, SimConfigPanel, ReportsPanel |
| `src/app/canvas/simulation/particleEngine.ts` | See §1B — also a hub in the sense that *any* new sim behavior lands here today | N/A (internal, but everyone's diff passes through it) |

**Convention to adopt:** when adding a new node type, only add to `NODE_CONFIG` (one new key) — don't reorder existing keys or reformat the file. Same for `LINT_RULES` and `NODE_SIM_DEFAULTS`. Append-only registries plus small, frequent PRs are what actually reduce conflicts here — restructuring these files is the thing to schedule as its own solo PR.

---

## 3. Suggested ownership split for parallel work

If splitting a sprint's work across people to avoid stepping on each other:

1. **Simulation realism** (per `SRE_Critique.txt`'s blueprints — circuit breakers on edges, thread-pool exhaustion, token-bucket gateways, chaos gray-failures) → §1B, and should be the *first* candidate for splitting `particleEngine.ts` into sub-modules before more than one person works there concurrently.
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
