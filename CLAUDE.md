# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Scalemap is a desktop application (Tauri 2 + React 19 + TypeScript) for visualizing and simulating infrastructure systems. Users drag infrastructure nodes onto a canvas, wire them together, and run a client-side traffic simulation that animates request/event/stream particles across the graph, computes per-node metrics (throughput, latency, error rate, queue depth), estimates cloud cost, and flags structural design issues (SPOFs, exposed databases, unbalanced load balancers, etc.).

The app is well past scaffold stage. Core systems that exist today:

- **Canvas** (`@xyflow/react`) with 18 custom compute/network/storage/messaging/caching node types and 8 group/container node types (VPC, subnet, AZ, region, k8s cluster, ECS cluster, Docker Compose, namespace), all with fully custom node/edge rendering.
- **Simulation engine** — a `requestAnimationFrame` particle engine driving live per-node metrics, replay/scrubbing, and a request inspector.
- **Packet system** — a Flyweight-style registry of packet templates (generic or user-defined protocols: http, event, stream, db) shared across edges.
- **Structural linter** — 9 rules that flag design smells in the graph (see below).
- **Cost model** — per-provider (AWS/GCP/Azure) pricing keyed off simulated traffic volume, with tiered egress billing.
- **ScaleScript** — a declarative JSON DSL for parameterizing a simulation run (node/edge overrides, timed scenarios, global SLOs).
- **Terraform export** (one-way: diagram → HCL). There is no Terraform *import*/parsing — see Roadmap.
- **Vault templates** — prebuilt starter diagrams (web, serverless, event-driven, k8s, data, network patterns).
- **.scalemap file persistence** via Tauri commands, with a `localStorage`-backed mock for browser-only dev.

There is no `prd.txt` in the repo (it has been removed); this file is the source of truth for scope and architecture.

---

## Commands

```bash
# Full Tauri dev (Rust + React hot-reload) — use this for all feature work
npm run tauri dev

# Vite-only dev server (no Tauri APIs available — falls back to tauriMock.ts)
npm run dev

# Type-check + build frontend
npm run build

# Build native app (release)
npm run tauri build

# Run frontend tests (vitest is configured; no test files exist yet — see Roadmap)
npx vitest

# Rust-only (from src-tauri/)
cargo build
cargo test
```

Vite dev server runs on port 1420 (strict — fails if occupied).

---

## Architecture

```
src/
  App.tsx
  main.tsx
  app/
    store/                       # Zustand, one store per domain
      canvas.store.ts            # Nodes, edges, viewport, undo/redo history, packet registry
      simulation.store.ts        # Reactive NodeMetrics, events, bottlenecks, SLO status, inspected requests
      diagnostics.store.ts       # Lint results + O(1) nodeId → issues index
      file.store.ts              # File path, dirty flag, recent files
      replay.store.ts            # 1Hz health snapshots (300-frame ring buffer), scrub cursor
      metricsHistory.store.ts    # Per-node metric timeseries (300 samples @ 1Hz)
      ui.store.ts                # Active tool, selection, panel/sidebar visibility
    canvas/
      Canvas.tsx                 # React Flow wrapper, registers all node/group types
      nodes/BaseNode.tsx         # Shared custom node component (icon, metrics, replay-aware)
      nodes/GroupNode.tsx        # Resizable/collapsible container node (VPC, subnet, cluster, ...)
      edges/BaseEdge.tsx         # Custom SVG edges, bowed paths for parallel edges, protocol styling
      simulation/
        particleEngine.ts        # rAF loop; particle state lives here, NOT in Zustand
        SimulationOverlay.tsx    # Canvas overlay, batches metrics up to simulation.store
        PlaybackScrubber.tsx     # Scrub UI over replay.store frameTimes
        RequestInspector.tsx     # Inspect a single picked particle
        useDisplayMetrics.ts     # Live vs replay metrics resolution for a node
    simulation/
      SimConfigPanel.tsx         # Per-node capacity/latency/retry/SLO configuration
      PacketEditor.tsx           # Packet template CRUD — actively buggy, see Roadmap
      CostTracker.tsx            # Renders costModel.ts output
      EventLogPanel.tsx          # Severity-colored event timeline
      defaults.ts                # NODE_SIM_DEFAULTS for all node types
    diagnostics/
      DiagnosticsPanel.tsx       # Renders lint issues
    analytics/
      MetricsDrawer.tsx, MetricGraphOverlay.tsx
    reports/
      ReportsPanel.tsx           # Export summaries (disk persistence not yet wired — see Roadmap)
    sidebar/
      NodePalette.tsx, PropertiesPanel.tsx, EdgeConfigForm.tsx, ContextMenu.tsx, Sparkline.tsx
    toolbar/Toolbar.tsx
    home/HomeScreen.tsx
    hooks/useSaveDiagram.ts
  lib/
    nodeConfig.ts                # NODE_CONFIG / NODE_ICON_MAP — central icon + category registry
    theme.ts                     # COLORS, CATEGORY_COLORS, FONT
    costModel.ts                 # Simulation → monthly cost projection
    cloudRegistry.ts             # Per-provider service/pricing catalog + egress tiers
    regionConfig.ts
    scalescript.ts               # ScaleScript DSL types + applyScaleScript() resolver
    serializer.ts                # .scalemap JSON read/write
    tauri.ts / tauriMock.ts      # Tauri command wrappers + browser-dev localStorage fallback
    lint/
      rules.ts                   # 9 structural lint rules
      lintGraph.ts                # Builds adjacency once, runs rules, returns LintIssue[]
      classify.ts, types.ts
    terraform/exportTerraform.ts # Diagram → HCL (export only, no import)
    vault/templates.ts           # Prebuilt starter diagrams

src-tauri/src/
  main.rs, lib.rs
  commands.rs                    # All Tauri commands live here (single file, not modularized)
                                  # save_diagram, load_diagram, get_recent_files,
                                  # open_file_dialog, save_file_dialog
```

---

## Key Architecture Decisions

**Canvas engine:** `@xyflow/react` (React Flow) with fully custom node/edge components — never the library's default visual style.

**State management:** Zustand, one store per domain (listed above). No monolithic store.

**Simulation particles:** Particle state lives inside `particleEngine.ts`'s internal `EngineState`, mutated directly inside the `requestAnimationFrame` loop — never in Zustand. Only derived, lower-frequency data (`NodeMetrics`, events, bottleneck/SLO status) is published to `simulation.store.ts`, batched via the `onNodeMetrics` callback in `SimulationOverlay.tsx`. Do not add raw particle arrays to any reactive store.

**Packet registry (Flyweight):** Edges reference a shared `PacketTemplate` by id (`canvas.store.ts`) rather than embedding protocol config per-edge. `packetMode` toggles between `generic` (built-in defaults per protocol) and `custom` (user-authored templates).

**Node icons:** Route all icons through `NODE_CONFIG` in `src/lib/nodeConfig.ts`. Never hard-code icon elements in node JSX.

**Lint rules:** Structural checks run on-demand over the graph (`lintGraph.ts` builds in/out-edge adjacency once, then runs each rule from `rules.ts`). Current rules: `isolatedNode`, `exposedDatabase`, `noQueueConsumer`, `noQueueProducer`, `lambdaDirectDb`, `circularDependency`, `singleEntryPointSpof`, `unbalancedLoadBalancer`, `deepSyncChain`. Add new rules to `rules.ts` and register them in the same array — don't special-case rule execution elsewhere.

**Terraform:** Export-only (`exportTerraform.ts`, diagram → HCL string). There is currently no HCL parsing, no `hcl-rs` dependency, and no import path. Do not assume an import feature exists — treat any reference to Terraform *import* as future work, not current behavior.

**Undo/redo:** Immutable history stack in `canvas.store.ts` (`history`/`future` snapshot arrays of `{ nodes, edges }`).

**Cross-platform:** All Tauri API calls (file dialogs, path resolution) must use Tauri's cross-platform abstractions — no OS-specific system calls. Rust code is currently a single `commands.rs`; keep new commands there unless the file grows large enough to warrant splitting (not yet planned/required).

---

## Design System

```
Canvas bg:         #0D0F12   /  canvas dots: #1A1D22
Node base:         #161920   /  border: #2A2E38
Surface:           #0F1117   /  surface hover: #13161E
Toolbar:           #111318   /  toolbar border: #1E2128

Compute/Orchestration: #4A9EFF (blue)
Storage/Caching:       #F5A623 (amber)
Network:               #2DD4BF (teal)
Messaging:              #A78BFA (purple)
Grouping:               #475569 (slate, transparent bg)

Text primary: #F1F5F9 / secondary: #94A3B8 / muted: #64748B
Status: danger #EF4444 / success #22C55E / warning #F59E0B
```

Source of truth: `src/lib/theme.ts` (`COLORS`, `CATEGORY_COLORS`). Font: `JetBrains Mono` throughout. All animations must respect `prefers-reduced-motion`.

---

## Diagram File Format

`.scalemap` files are JSON (`src/lib/serializer.ts`):

```json
{
  "version": "1",
  "meta": { "name": "", "created": "", "modified": "" },
  "viewport": { "x": 0, "y": 0, "zoom": 1 },
  "nodes": [{ "id": "", "type": "", "position": {}, "data": {} }],
  "edges": [{ "id": "", "source": "", "target": "", "type": "", "data": {} }],
  "packets": { "mode": "generic", "templates": {}, "nextId": 1 }
}
```

`packets` is optional (only present when the diagram uses custom packet templates).

---

## Key Dependencies

| Package | Purpose |
|---|---|
| `@xyflow/react` | Canvas — node/edge rendering, pan/zoom |
| `zustand` | State management |
| `dagre` | Graph layout (installed; verify usage before relying on it) |
| `framer-motion` | Panel/node animations |
| `lucide-react` | Node icons |
| `vitest` / `@testing-library/react` | Test harness (configured, unused — see Roadmap) |

Rust (`src-tauri/Cargo.toml`): `tauri`, `tauri-plugin-opener`, `tauri-plugin-dialog`, `serde`/`serde_json`, `chrono`. No `hcl-rs`.

---

## Known Issues / Roadmap

- **`PacketEditor.tsx` is actively buggy** (per commit `93c193a`, "still has bugs"). Verify current behavior before extending it rather than assuming the CRUD flows work end-to-end.
- **No test coverage.** `vitest` and Testing Library are installed but there isn't a single `*.test.ts(x)` file yet. New non-trivial logic (lint rules, cost model, ScaleScript resolver) is a good place to start.
- **Terraform import doesn't exist.** If this is picked back up, decide whether to keep parsing client-side or reintroduce a Rust-side `hcl-rs` sidecar before writing code.
- **`ReportsPanel.tsx` exports aren't persisted to disk** — wire up a Tauri command instead of leaving it browser-only.
- **Rust commands are a single flat file.** Fine at the current size; revisit modularization only if `commands.rs` becomes hard to navigate.


When making changes to the codebase refer to the [module boundaries](docs/module-boundaries.md) document to understand which files are low-risk to modify in parallel and which are high-conflict "hub" files that require careful coordination, and try to utilize codegraph mcp server if possible to understand the fan-in and fan-out of the files you are modifying. And after every new feature/change update the docs/module-boundaries.md file to reflect the new architecture and module boundaries.