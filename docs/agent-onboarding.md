# Agent Onboarding — Scalemap

Read this before writing any code. It is the distilled working knowledge of the agents that
built this app: the laws that are enforced in review, the mental models behind the design, the
traps that have already burned previous sessions, and the exact commands to verify your work.
It is written to be followed literally.

**Reading order for a new session:**

1. `CLAUDE.md` (repo root) — architecture overview, commands, key decisions. Loaded automatically.
2. This file — laws, philosophy, workflow, gotchas.
3. `docs/module-boundaries.md` — file-by-file detail. Do NOT read it top to bottom (it is long
   and partly historical); search it for the specific files you are touching.
4. Only if doing engine work: `docs/superpowers/specs/2026-07-08-world-engine-contracts.md` and
   `docs/superpowers/specs/2026-07-08-phase2-substrate-engine-design.md`.
5. Only if doing a new major feature: the umbrella spec
   `docs/superpowers/specs/2026-07-08-world-model-multiscale-simulation-design.md` (decisions
   D1–D16 and the §9 parked list).

The repo is indexed by CodeGraph (`.codegraph/` exists). Use `codegraph explore "<symbols or
question>"` (shell) or the `codegraph_explore` MCP tool BEFORE grep/manual reading — one call
returns verbatim source plus callers/callees, which is exactly what you need to judge blast
radius.

---

## 1. What this app is

Scalemap is a **desktop app (Tauri 2 + React 19 + TypeScript)** for designing multi-region
server infrastructure and watching it run. A user authors a "world" — regions, availability
zones, servers, service blueprints, placements, managed services, client populations — then a
**from-scratch client-side simulation engine** ticks it and every view lights up with live
metrics: traffic arcs on a globe, dot streams between AZs, LED slats on datacenter racks,
packets on a server circuit board. A deterministic rule engine plus an optional LLM reviewer
point out design flaws (SPOFs, exposed databases, capacity problems). A cost model prices the
whole thing per hour.

There are exactly **four zoom levels** (`nav.store.ts` `WorldLevel`):

| Level | View | File |
|---|---|---|
| 1 `globe` | react-three-fiber night-earth globe, region pins, traffic arcs | `src/app/world/GlobeView.tsx` + `globe/` |
| 2 `region` | cross-AZ traffic columns, failover timeline, rack chassis | `src/app/world/RegionView.tsx` + `region/` |
| 3 `az` | DOM/SVG isometric datacenter floor (racks, pods, ISP ingress cabinet) | `src/app/world/az/DatacenterFloor.tsx` |
| 4 `server` | "circuit board": RJ45 NIC, firewall shield, service chips, hardware platform | `src/app/world/ServerView.tsx` + `server/` |

The right-hand dock (`WorldPanel.tsx` + `src/app/world/dock/`) is **contextual**: world scope
shows 7 tabs (Topology, Blueprints, Placements, Traffic, Analysis, Events, Cost); region/AZ/
server scopes show 4 (Config, Analysis, Events, Cost) where Config is a signature instrument —
atlas constellation (world/region), floor-plan minimap (AZ), server faceplate with four
drawers (server).

This is the app's **second architecture**. The original React-Flow canvas prototype (particle
engine, ScaleScript DSL, Terraform export, 9-rule linter) was deleted wholesale in 2026-07. If
you find yourself assuming any of those exist, stop — see §6.

---

## 2. The data flow (memorize this)

```
WorldDoc  (src/lib/world/types.ts — the ONE document model, plain data, keyed by id)
   │  every mutation goes through world.store.ts's internal mutate()
   ▼
compileWorld(doc)  (src/lib/world/compileWorld.ts — PURE function)
   │  resolves placements → ServiceInstances; evaluates firewalls/ports/network isolation
   │  → permitted/blocked CompiledPaths; builds routing tables; emits CompileFindings
   ▼
CompiledWorld ──────────────┬───────────────────────┬─────────────────────┐
   │                        │                       │                     │
   ▼                        ▼                       ▼                     ▼
views (all 4 levels    worldEngine.start()     analysis rules        cost model
 via useCompiledWorld)  (simulation.store       (runAnalysis.ts)     (costModelV2.ts)
                         is the ONLY caller)
```

**Law: nothing downstream reads the raw `WorldDoc` for anything *derived*.** Reading
`doc.servers[id].label` for display is fine; deriving "which instances live on this server" or
"is this path allowed" must come from `CompiledWorld`. If you need new derived data, extend
`CompiledWorld` **additively** — never reshape existing fields (they fan out everywhere).

**Stores** (Zustand, one per domain, in `src/app/store/`):

| Store | Owns | Critical rule |
|---|---|---|
| `world.store.ts` | `WorldDoc` + undo/redo history | ALL doc mutations go through its actions, which route through `mutate()` — that is what gives you undo + dirty-marking for free. Never `set({ doc })` directly. |
| `nav.store.ts` | level + regionId/azId/serverId focus | Deliberately has NO import of world.store. Navigation must never create undo history. |
| `simulation.store.ts` | running, timeScale, latestBatch, events, scrub state, health overrides, event-log run id/total | The ONLY file in the app allowed to call the engine facade (`createWorldEngine()` / `worldEngine` singleton). Views read this store, never the engine. Its in-memory `events` list is a 500-entry presentation WINDOW, not a history cap: every event is also spilled in 1 Hz batches to the durable SQLite (WAL) event log (`event_log_*` Tauri commands → `<app_data_dir>/events.db`; in-memory map in browser dev), with `eventLogTotal` as the true count. |
| `file.store.ts` | file path, dirty flag, recent files | — |
| `ui.store.ts` | themeMode, panel tab, selectedServerId | Dock scope is DERIVED (`dock/scope.ts` `deriveScope`), never stored. |

**The engine** (`src/lib/worldEngine/`) is a fixed-step discrete simulation: demand generation →
DNS-TTL-cached routing with health checks/failover → per-host CPU/RAM scheduling → VPS
burst-credit + noisy-neighbor model → NIC byte caps → circuit breakers → BFS flow solver →
replica promotion → 1 Hz metrics pyramid (instance→server→AZ→region→world) → event ring +
replay buffer. Perf envelope: ~2 ms/step at ~2,000 instances against a 4 ms budget.
`worldEngine/types.ts` is a **frozen contract**: additive-only changes, and every change gets a
line in `.superpowers/sdd/contract-drift.md`. Recent polish phases shipped with **zero engine
diff** — treat engine changes as a separate, spec-first project, not something you slip into a
UI task.

---

## 3. Hard laws (violations get reverted)

These were each established by explicit user decisions. Do not re-litigate them.

1. **Compiled-world gate** — §2 above.
2. **Engine seam** — only `simulation.store.ts` touches the engine facade; engine contract
   additive-only + drift log.
3. **Theme tokens only.** Every color in new UI is `var(--color-*)` from `src/lib/theme.ts`
   (`DARK_COLORS`/`LIGHT_COLORS`). No hardcoded hexes. Both themes are user-reachable (⚙
   Settings → Appearance), so eyeball your work in dark AND light. Narrow carve-out: SVG
   gradient/stroke micro-shades inside the isometric floor and board use local hexes where a
   token genuinely doesn't exist — copy the neighboring file's pattern, don't invent new ones.
4. **Price law.** Every money value app-wide renders in `var(--color-price)` (dark `#6EE7B7`,
   light `#047857`). No exceptions — a `$` in `--color-text-secondary` is a review finding.
5. **No emojis. Ever.** The user purged them app-wide. Plain-text glyphs are fine and already
   in use: `▸ ✕ ⇄ ⌬ ⏎ ↺ ⊘ ⌖ − ● ◷ ¤ →`. If you're unsure whether a character is a glyph or an
   emoji, use a word instead ("settings", not a gear).
6. **Edit-lock law.** While the simulation is running, authoring controls are disabled (the
   dock wraps content in a `<fieldset disabled>`; floor/board toolbars check `running`).
   Destructive "chaos" actions (kill server / AZ outage) are the inverse: enabled ONLY while
   running. Tooltip copy is standardized: disabled-while-running controls say
   `stop the simulation to edit`; run-only chaos controls say
   `start the simulation to break things`.
7. **Motion budget.** Animation encodes DATA, never decoration, and is strictly capped:
   - Flow-line dashes march only when their rate > 0 — everything static at 0 rps.
   - Region + floor animate only the top `TOP_ANIMATED = 5` flows by rate (shared budget on
     the floor between dep flows and internet-ingress lines).
   - Floor LEDs: at most `MAX_ANIMATED_LEDS = 3` blink (ranked by CPU); the rest render color
     statically.
   - ~≤8 concurrent ambient strokes per view (inventory: `docs/module-boundaries.md` §R).
   - The server board's fixed hardware chrome (RJ45 pin ripple, shield scan, inspector
     scanline) is a user-ratified bounded exception — it doesn't scale with world size.
   - `prefers-reduced-motion` ⇒ everything fully static (every animated component checks
     `useReducedMotion()` or the CSS media query). Zero infinite animations under it —
     this is smoke-tested.
8. **Seamless-dash law.** Any looping `stroke-dashoffset`/`background-position` animation must
   travel an INTEGER MULTIPLE of its dash/stripe period per loop, or it visibly snaps each
   cycle. (Incident: dashes `'8 9'` = period 17 marched −30/loop → jerk; fix was dash `'7 8'`
   = period 15, which divides 30.) Check the arithmetic every time you touch a marching dash.
9. **Plain words + singular-aware copy.** UI copy is lowercase, sentence-style, jargon-free
   ("3 servers · 1 down", healthWord not enum names). Counts are singular-aware: "1 server",
   never "1 server(s)". Rule/firewall lines render as sentences via
   `src/app/world/server/ruleSentence.ts` — reuse it, don't re-voice.
10. **Relocated-dispatch contract.** When moving a control to a new surface (dock, drawer,
    overlay), reuse the EXISTING store dispatch byte-for-byte. Never fork a slightly-different
    mutation path for the new location.
11. **LLM key security (non-negotiable).** The API key is NEVER: serialized into `.scalemap`,
    logged/`console.*`'d, included in the review-context payload, or echoed back into the
    Settings input (render masked `•••• <last4>`). It is REDACTED from error strings on both
    the Rust and TS sides. Settings live in `llm_settings.json` in the app data dir (0600).
    Each invariant has an asserting test — keep them passing.
12. **Serializer is additive.** `.scalemap` is at v3 (`serializer.ts:38`); both v1 and v2 are
    rejected at the version gate (`serializer.ts:53-64`). New doc fields must be optional-on-load
    (old v3 files keep opening). Never write derived/ephemeral state (analysis findings, LLM
    reviews) into the file.
13. **Font.** JetBrains Mono everywhere. Don't add fonts.
14. **Cross-platform.** All native calls go through Tauri's abstractions; Rust commands live in
    `src-tauri/src/commands.rs` (single file, keep it that way until it hurts). Any HTTP to
    arbitrary hosts must be Rust-side (`llm_chat`) — webview `fetch` dies on CORS.

---

## 4. Design philosophy (why it looks the way it does)

- **Instrument, not dashboard.** Each scope gets one *signature instrument* that could only
  belong to that scope — atlas constellation, floor-plan minimap, server faceplate — rather
  than generic reused panels. When designing new UI, ask "what would the physical instrument
  for this be?" before reaching for a table.
- **Realism-first substrate.** The user's explicit choice: "every reasonable thing configurable
  and realistically simulated," bottom-up (servers/services are the substrate) over generated
  fake detail. New simulation features should model a real mechanism (credits, TTLs, queues),
  not a random-number vibe.
- **Motion is meaning.** Dash speed = rate, LED = CPU, blink = activity. If an animation
  doesn't encode a live number, it shouldn't exist (board chrome excepted, §3.7).
- **Physicality.** The NIC is a real RJ45 jack with 8 gold pins; racks are isometric boxes
  with roof stripes; the internet arrives via a street-fed ISP cabinet. Skeuomorphic detail is
  welcome when it teaches what the thing IS.
- **Words a beginner understands.** The app teaches infrastructure; copy explains consequences
  ("stop the simulation to edit", "no public entry") instead of naming internals.
- **Mockup-first for visual work.** Big visual changes were always locked as HTML mockups
  before implementation, and the mockup is then BINDING (transcribed values, cited line
  numbers). Two surviving binding mockups: `docs/superpowers/specs/mockups/
  level-redesign-v5.html` (board/floor/region) and `panels-hybrid-v1.html` (panel kit).

Interaction grammar shared app-wide: **tap = select, hold = enter** (`useHoldTap`:
`HOLD_TAP_MS = 250`, `HOLD_DURATION_MS = 700`, `HOLD_SLOP_PX = 12`, ring must zero its
`progressRef` on every cancel path); wheel = zoom-at-cursor and background-drag = pan via
`useFloorCamera` (floor + board; interactive elements excluded via selector so clicks still
land); Escape = navigate up one level (which is why modals must close via their close button
in tests, not Esc).

---

## 5. Where things happen (user-visible feature map)

| To add/do | Where |
|---|---|
| Add region | world scope → Topology tab → `+ region` |
| Add traffic/population | globe `+ traffic` HUD button, or Traffic tab; clicking Earth places a population snapped to the nearest real city (`cityCatalog.ts`) |
| Add AZ | region scope → `+ az` |
| Add server / rack | AZ floor toolbar `+ server` / `+ rack`; auto-arrange racks free-pool servers |
| Add service to a server | server board "+ service" ghost chip, or faceplate SERVICES drawer → "+ mount a blueprint…" |
| Author a blueprint | world scope → Blueprints tab (services are blueprints; placements bind them to servers) |
| Firewall rules | faceplate FIREWALL drawer `+ rule`, or the board's shield |
| Kill a server / AZ outage | run-only controls on faceplate/floor (chaos requires a running sim) |
| Theme + LLM endpoint | ⚙ settings (header gear) |
| Example worlds | home screen vault cards (`src/lib/vault/exampleWorlds.ts`, 4 examples, contract-tested) |
| Simulate / scrub | header SimControls; ScrubberV2 bottom bar replays the run |
| Keyboard shortcuts | ⌘N new world, ⌘Z/⇧⌘Z undo/redo (stopped only), Escape (disarms placement mode, else navigates up), ⌘K command palette, ⌘/ or `?` keyboard-map overlay — all one registry, `src/app/keymap.ts`'s `REGISTRY`, installed once in `App.tsx` |
| Capture a baseline / compare two runs | header SimControls "Capture baseline" button (enabled once the replay buffer has frames); world scope → Compare tab to pick two captured runs and see a direction-aware latency/error/cost diff, plus JSON export/import via the usual file dialogs |
| Switch / author a comparison environment | breadcrumb `▸ <Label>` chip shows the active environment; world scope → Topology tab → ENVIRONMENTS section to add/edit/delete environments (server-count and RPS scale factors, instance-class overrides) and switch the active one or the `cloudProfile` used for cost comparison |

---

## 6. Things that DO NOT exist (do not assume, do not "restore")

- **No React Flow / `@xyflow/react`** anywhere (the AZ canvas it powered was replaced by the
  isometric floor). No `dagre`.
- **No packet-template editor.** Only the *types* survive (`src/lib/nodeConfig.ts`) so old
  `.scalemap` files round-trip. Building an editor = new feature, needs a spec.
- **No ScaleScript**, no Terraform export/import, no k8s/ECS scheduling semantics, no
  spot-instance modeling, no managed-service internals (they're black-box cost/routing
  targets).
- **No LLM watch-mode, streaming, cancellation, or review persistence** — one blocking
  request with one retry, ephemeral cards.
- **No backend/server.** Everything is client-side + local Tauri commands. No network calls
  except the user-configured LLM endpoint (Rust-side).
- **No analysis/LLM persistence in `.scalemap`** — derived data stays derived.

These are parked deliberately (umbrella spec §9). If the user asks for one, it starts a fresh
spec cycle — don't bolt it on.

---

## 7. Build, test, verify (the done bar)

```bash
npm run tauri dev     # full dev (Rust + React HMR) — feature work happens here
npm run dev           # Vite-only on port 1420 (STRICT; fails if occupied). Tauri APIs
                      # fall back to src/lib/tauriMock.ts (localStorage file I/O + fetch LLM)
npx tsc --noEmit      # type gate
npx vitest run        # full suite (~880+ tests; jsdom for components, node for pure logic)
npm run build         # type-check + production build — must stay green
```

**The done bar for any change:** `tsc` clean → full `vitest` green → `npm run build` green →
**live smoke in the actual app** (the suite is strong but jsdom cannot see visual regressions;
live smokes have caught bugs jsdom is blind to — a React-19 `animation` shorthand +
`animationDelay` longhand console flood, raw-float labels, invisible overlays). Never claim
done from unit tests alone for UI work. Check the browser console: **zero errors** is the bar
(one pre-existing three.js Clock deprecation warning is known/accepted).

**Playwright/live-smoke gotchas (each of these has burned a session):**

- The globe's visually-hidden a11y region list is UNCLICKABLE (canvas swallows pointer
  events). Enter levels via the Topology tab's `→` buttons, then move scopes via the scope
  rail (testids `scope-pill-*`). Probe globe pins by dispatching hover at body-level cursor
  coordinates.
- Synthetic Escape triggers nav-up in `WorldShell` — close modals with their close button.
- While the sim runs, authoring controls sit in a disabled `<fieldset>` — stop the sim before
  clicking topology `→` etc.
- Run smokes only AFTER all your edits land — Vite HMR resets app state and floods the console
  mid-edit.
- `getByRole` strict-mode collisions are common (floor viewport and dock both have an
  "auto-arrange" button) — scope queries with `getByTestId('floor-viewport')` etc.
- If port 1420 is busy, the user's own dev server is probably running — smoke against it (HMR
  serves the working tree); don't kill it.

**Other hard-won implementation gotchas:**

- drei `Html occlude` does not work for hiding far-side globe labels — use the exported
  `isFrontFacing` horizon test.
- `<fieldset>` defaults to `min-inline-size: min-content` and refuses to shrink — set
  `minInlineSize: 0` or panels overflow.
- Inline `all: unset` on a button kills the kit stylesheet's hover/press feedback — use an
  explicit reset.
- r3f pointer capture makes `onPointerOut` dead during a hold — cancel holds via slop/up/leave
  in DOM land, and always zero the hold-ring `progressRef` on cancel (a stale ref paints a
  frozen ring forever).
- The floor's `anchorFor` resolves line endpoints: racked servers must resolve to their rack
  cabinet (`plan.cabinets` is rack-keyed; `plan.pods` is free-pool-only).
- Internet-ingress "reachable" = the analysis rules' `openToAny` convention (first port+tcp
  firewall match is `allow` with `source === 'any'`). `world/network.ts`'s `evaluateFirewall`
  is source-blind — do NOT reuse it for ingress semantics.
- Label layers deconflict via `az/labelLayout.ts` (greedy push-up placement) — add new floor
  labels through it, not as free-floating SVG text.

---

## 8. High-conflict hub files (coordinate, edit sequentially)

`WorldPanel.tsx` (dock shell — every tab/scope meets here), `world.store.ts`,
`src/lib/world/types.ts`, `src/lib/worldEngine/types.ts` (frozen), `WorldShell.tsx`,
`theme.ts`, `serializer.ts`. Parallel work must not overlap on these; everything under a
single view directory (`az/`, `server/`, `region/`, `globe/`, `dock/`) is safe to own
independently. Full map: `docs/module-boundaries.md` §2–§3.

After any feature/change, **update `docs/module-boundaries.md`** (repo instruction in
CLAUDE.md) — add/adjust the row for files you changed rather than appending long narrative.

---

## 9. Process for non-trivial work

The pattern that built this app (keep using it):

1. **Spec first** for anything design-shaped: numbered decisions (D1, D2, …), written to
   `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`. Visual features get an HTML mockup
   locked by the user BEFORE implementation; the mockup is binding.
2. **Skeleton + runbook** for multi-task phases: exact file paths and function signatures per
   task; a context-free executor session runs them via subagent-driven development on a
   feature branch, with the ledger at `.superpowers/sdd/progress.md`.
3. **Verify → merge**: re-run the full done bar independently; check
   `git diff main...branch -- src/lib/worldEngine/` is EMPTY unless the spec sanctioned engine
   work; then `git checkout main` FIRST (executor sessions leave HEAD on their branch — merging
   from there silently no-ops), `git merge --ff-only <branch>`, push.
4. Small fixes/feedback waves go directly on `main`: fix → test → live-verify → commit → push.

Commit style: `type(scope): summary` (`fix(az): …`, `feat(dock): …`, `chore(review): …`, `docs: …`).

---

## 10. Current state + backlog (2026-07-12)

Everything through Polish 4 plus its feedback waves is merged; the suite is ~888 tests green;
the engine has been frozen since Phase 6. Known open items — parked, not in progress:

- **Deferred minors:** atlas top-arc opacity 0.7 vs mock's 0.65; firewall `+ rule` stays
  enabled during scrub-only watching (should lock).
- **Floor:** drag-to-rack assignment (today: rack selector + auto-arrange only). Option B "3D
  datacenter" is GitHub issue #23.
- **Engine (needs a spec cycle):** dependency traffic fans out to DOWN instances without
  health filtering — flagged during the killed-region fix, deliberately not patched ad hoc.
- **Umbrella spec §9 parked list** — the §6 "does not exist" items above.

If the user reports a bug: root-cause it first (`systematic-debugging` if available), fix the
CAUSE not the symptom, add a regression test, live-verify with the user's exact repro, then
commit on main. That loop — not speed — is why they trust this repo's history.
