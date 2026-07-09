# Phase 3: Server Interior ("Living Circuit Board") — Design

**Date:** 2026-07-09 · **Status:** Approved direction (umbrella spec §5 Level 4 / §9 row 3;
user approved the mockup "Looks phenominal" — it is binding).
**Binding companions:** umbrella `2026-07-08-world-model-multiscale-simulation-design.md`,
FROZEN `2026-07-08-world-engine-contracts.md` (amended 2026-07-09: server-scope particle id
vocabulary), approved mockup `docs/superpowers/specs/mockups/serverview-hybrid-v3.html`,
Phase-2 drift log `.superpowers/sdd/contract-drift.md` (§5 deferrals dispositioned below).

## Goal

Replace the Phase-1 placeholder `ServerView` with the Level-4 living circuit board: a dark
PCB stage where the NIC edge connector feeds a firewall gate arch, engine particles run the
traces to service chips and docker stack plates, and a unified hardware platform renders the
host's CPU die, stratified RAM reservoir, and sliced disk platter live from `ServerMetrics`.
Service signature colors bind chip ↔ RAM stratum ↔ core share ↔ disk slice; a HUD inspector
rail makes every element clickable and editable. One engine addition: server-scope particle
payloads (currently empty-but-valid per `buildPayload`).

## Engineering decisions (within the umbrella's envelope)

1. **Stage architecture: DOM + SVG + canvas, no React Flow.** The board is a fixed
   composition (no pan/zoom): absolutely-positioned DOM blocks for NIC/gate/chips/stacks/
   hardware platform (hoverable, clickable), one SVG layer beneath them for etched traces
   (clickable paths), one canvas layer above for packets (pointer-events: none, refs-only
   drawing — the `AzSimOverlay` pattern). The stage uses a fixed logical coordinate space
   (1000×560) scaled to fit its container via `transform: scale()`, so layout math never
   sees the viewport.
2. **Pure layout module.** `layoutServerBoard(server, doc, compiled)` in
   `src/app/world/server/boardLayout.ts` computes every box and anchor deterministically
   (unit-tested): NIC on the left edge, firewall gate right of it, process-placement chips
   in a middle column, one raised plate per compose stack containing its container chips
   and volume cylinders, the hardware platform as a fixed right rail, power rail at the
   bottom. `anchorFor(id)` resolves any particle endpoint (`instanceId` or `'nic:<sid>'`)
   to trace coordinates; traces are cubic béziers between anchors, routed through the gate
   when an endpoint is the NIC.
3. **Engine: server-scope particles (the only engine change).**
   `buildServerParticles(serverId, wallMs)` fills the empty server branch of
   `buildPayload`, cap `MAX_SERVER_PARTICLES = 50` engine-enforced. Sources, from the
   server's resident instances' flows: entry rps → `'nic:<sid>'` → instance; downstream
   rows → instance → resident target instance, or instance → `'nic:<sid>'` when the target
   is off-server/managed; blocked rows emit `blocked: true` particles. `colorHint` = the
   *target* instance's blueprint color (inbound trace glows the receiving service's hue);
   instance→nic outbound uses the *from* blueprint's color. Same sampling/phase mechanics
   as `buildAzParticles` (rps-proportional, `RENDER_PROGRESS_PER_MS` sweep). Vocabulary is
   the contracts amendment of 2026-07-09.
4. **Hardware platform bindings (all from `ServerMetrics`, order-stable per contracts):**
   CPU die = per-core cell grid from `coreUtilization` with an aggregate ring (mean) and a
   hatched amber ring segment + hatched cells for `stealFraction` (VPS only; burst-credit
   fraction as a thin sub-bar when `burstCredits !== null`). RAM reservoir = one stratum
   per `ramByInstance` entry (in array order, bottom-up, blueprint color), plus an
   "os + cache" remainder stratum = `max(0, ramUsedMb − Σ ramByInstance)` in amber.
   Disk platter = one slice per compose volume (`sizeGb / specs.diskGb`, amber family) plus
   a muted "system" slice (fixed 15% of `diskGb`) and free space; the sweeping scanner's
   rotation period scales inversely with `diskIoFraction` and parks when idle. NIC block =
   `nicInMbps`/`nicOutMbps` against `specs.nicMbps` as the utilization bar.
5. **Idle / running / scrub.** Structure (chips, stacks, static traces, firewall) renders
   from `doc` + `compiled` always — the board works before any simulation. Metric-driven
   elements read `scrubBatch ?? latestBatch` (the sanctioned T15 pattern, making the board
   scrub-aware for free). With no batch at all: cores/ring at 0, RAM strata estimated from
   each resident blueprint's `workload.ramBaseMb` (labeled "at rest"), scanner parked.
6. **Blocked-path storytelling.** Static traces take their verdict from `compiled.paths`:
   permitted = protocol/blueprint-colored, blocked = dashed red with the `blockReason`
   detail as a label. Live blocked particles burst red at the gate (when from the NIC) or
   at the target chip (intra-server), mockup-style `refused :<port> — <detail>`. The gate
   header shows `<n> rules` from `server.firewall` and a blocked-per-second figure counted
   from `connection_refused` events whose `affected` includes this serverId within the
   last 5 sim-seconds of the store's event ring.
7. **Selection + inspector rail.** A `BoardSelection` union — instance | nic | firewall |
   rule | stack | volume | hardware(cpu/ram/disk) | core — held in local `ServerView`
   state (not nav.store). The HUD-styled rail (right, ~240px) renders a read panel per
   kind plus edit forms that write **only through existing `world.store` actions**
   (`updateServer` / `updateBlueprint` / `updatePlacement`): blueprint workload profile
   (4 numeric fields) and signature color; container `cpuLimit`/`memLimitMb`,
   `portMappings`, `networkNames` membership; firewall rule add/remove/edit/reorder
   (array order = first-match-wins, reorder buttons with aria-labels); stack volumes
   add/remove/resize. Placement `count`/`role`/runtime-type switching stays in
   `PlacementPanel` — the rail edits the selected entity's knobs, it does not duplicate
   authoring. Edits recompile the world via the existing `useCompiledWorld` memo, so a
   firewall fix visibly flips a red trace to teal.
   The mockup's "restart on-failure" chip is cosmetic — restart policy is not in the data
   model and is NOT added (parked).
8. **Signature-color cross-highlight.** Hovering any element sets a hovered blueprint id;
   its chip, RAM stratum, core share, and disk slice glow while unrelated elements dim to
   ~0.45 opacity. Core attribution is approximate and pure (`attributeCores`): sort
   resident instances by `cpuCoresUsed` descending, claim cores greedily (an instance
   demanding 1.2 cores owns core N fully and 20% of core N+1); a core's dominant owner
   colors it. Volumes attribute by `blueprint.volumeName` match.
9. **Simulation edit-lock.** All rail edit controls sit inside
   `<fieldset disabled={running}>` (T13 precedent); inspection stays available while
   running.
10. **Perf + motion.** Packet canvas draws via refs (no per-frame setState); the renderer
    attaches once per `(serverId, running)` — never resubscribes on hover/selection (the
    T14 lesson). ≤50 particles engine-enforced. `prefers-reduced-motion`: no idle
    animations (scanner, shimmer, pulses), packet redraws throttled to ~2/s (AzSimOverlay
    precedent).
11. **Phase-2 deferral dispositions (drift log §5) — none taken in Phase 3:** instance
    p50/p99 stay service-time-only (chips show them as-is; network transit remains visible
    in `InspectorV2` traces); `applyNicCap` shed/queue stays unwired (the NIC block renders
    utilization only); breaker semantics unchanged. All remain Phase-4+ candidates.
12. **Queued cleanup rides along:** align `PlacementPanel`'s `MANAGED_TYPES` with
    `CLOUD_REGISTRY` keys (Phase-2 rulings item; managed services authored with registry
    keys so Cost v2 prices them without the alias table).

## Testing & verification

Unit: `boardLayout` (zones, anchors, gate routing, determinism), `attributeCores`,
`buildServerParticles` (vocabulary, cap, blocked flags, colorHint, seeded determinism).
Component (jsdom pragma + jest-dom): inspector rail per edit form — correct store action +
patch, fieldset gate, firewall reorder order. Live Playwright smoke (mandatory, controller-
run, port 1420, zero console errors): author a server with a compose stack, a process
placement, and a deliberately blocked dependency → navigate to the board → static red trace
with rule label → Simulate → packets flow, strata/cores/ring live, gate counts blocks →
fix the firewall rule via the rail (after Stop) → trace turns permitted → hover
cross-highlight → scrub shows historical strata.

## Out of scope (unchanged from umbrella)

Rack chassis + region flow page (Phase 4), r3f globe (Phase 5), analysis engine + LLM
reviewer (Phase 6), k8s/ECS, restart-policy modeling, NIC shed/queue realism, folding
network transit into the metrics pyramid.
