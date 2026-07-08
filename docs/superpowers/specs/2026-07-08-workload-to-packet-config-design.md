# Move Workload Definition from Node Config to Packet Config — Design

Addresses GitHub issue **#18**: `WorkloadDemand` (CPU/memory/IO cost per
request) currently lives on the compute *node* (`NodeSimConfig.workload`),
but conceptually belongs on the *packet/request type* — the computational
cost of a request is a property of what the request IS (a heavy ML
inference call vs. a light CRUD read), not of the box that happens to
process it. The node's `ComputeProfile` (vCPU/RAM/clock) should decide how
*fast* it handles demand, not define the demand itself.

## Problem

Today, one EC2 node has exactly one `WorkloadDemand`
(`NodeSimConfig.workload`, set in `SimConfigPanel`), applied uniformly to
every request that arrives at it — regardless of what kind of request it
is. A node fronting both a cheap health-check endpoint and an expensive
image-processing endpoint has no way to express that difference; today
every request costs the same simulated CPU time and memory footprint at
that node. Custom packet templates (`BasePacketTemplate` and its 4
protocol variants — `HttpTemplate`/`EventTemplate`/`StreamTemplate`/
`DbTemplate`) already let a user distinguish request *shape* (size, method,
status code, query type) per packet type; workload cost should live there
too.

### Where the current node-level workload is read

Traced against the current code (`particleEngine.ts`,
`particleEngine/compute.ts`, `SimConfigPanel.tsx`), six call sites resolve
`resolveEc2Resources(config)` → `{ profile, workload }`:

1. `trackRequest` (`:715-728`) — sets an admitted request's thread-hold
   time via `wallTimeMs`. Has a specific `Particle` in scope at 4 of its 7
   call sites (the arrival-time success paths in `handleParticleArrival`,
   `:1477/:1561/:1643/:1678`); the other 2 (caller-side spawn-time
   acquisition, `:1035`/`:2531`) run *before* a particle exists — admission
   is decided, then the particle is minted.
2. Caller-side spawn-time capacity sizing (`:1015`/`:2526`, the
   `hardThreadCap`/`computeMaxThreads` cap for the unified caller/
   server-side thread pool from the prior compute-fix branch) — no
   particle yet, same as above.
3. Target-side admission decision (`:1422-1433`, inside
   `handleParticleArrival`) — **has** a specific `particle` in scope
   (arrival-time, before the success path).
4. The legacy-`maxRps`-skip gate (`:1653`) — only needs to know a
   `ComputeProfile` exists at all, never actually reads `.workload`.
5. `updateAllNodeMetrics`'s per-node utilization/bottleneck calc
   (`:1957-1963`) — runs once per node per metrics tick, no specific
   particle; this is a genuine node-level *aggregate*.

Sites 1 (partially) and 3 have a real particle and can resolve its exact
packet's workload. Sites 1 (partially), 2, and 5 are inherently
particle-less — they need a *representative* workload for "this node's
traffic mix right now."

## Decisions (confirmed with user)

1. **True weighted blend for particle-less contexts**, not a flat default
   constant. Where a specific packet isn't yet known (caller-side spawn-time
   capacity sizing) or isn't singular (target-side aggregate utilization),
   compute a real weighted average of the relevant `WorkloadDemand` fields
   from the node's configured `PacketDistributionEntry[]` — not just fall
   back to one flat default in every non-trivial case.
2. **`NodeSimConfig.workload` is removed entirely**, not deprecated-in-place.
   The issue frames this as a relocation; ripple is small and contained
   (a handful of test fixtures constructing `NodeSimConfig` literals, one UI
   section). Old `.scalemap` files simply carry a harmless, unread orphan
   key under `simConfig.workload` — no migration/parsing changes needed,
   since `serializer.ts` round-trips `simConfig` as an opaque
   `Partial<NodeSimConfig>` blob already.

## Design

### Schema (`src/lib/nodeConfig.ts`)

- Move `workload?: WorkloadDemand` from `NodeSimConfig` (delete the field)
  onto `BasePacketTemplate` (add it there) — shared by all 4 protocol
  variants, since any protocol's packet can arrive at (or originate a call
  from) an ec2/container node and has *some* compute cost, even a small one.
- `WorkloadDemand`, `WorkloadTier`, `WORKLOAD_TIER_RANGES`,
  `resolveWorkloadInstructions` stay exactly as-is (unchanged shape) — only
  their attachment point moves.

### New defaults (`src/app/simulation/defaults.ts`)

- Rename `DEFAULT_EC2_WORKLOAD` → `DEFAULT_PACKET_WORKLOAD` (same values,
  same shape) — it's no longer EC2-specific, it's the fallback for *any*
  packet that doesn't carry its own workload (generic mode, or a custom
  template predating this field). `DEFAULT_EC2_COMPUTE_PROFILE` is
  unaffected (hardware profile stays node-level, stays EC2-specific).
- `NODE_SIM_DEFAULTS.ec2` drops its `workload:` entry (keeps
  `computeProfile: DEFAULT_EC2_COMPUTE_PROFILE`).
- `PacketEditor.tsx`'s `defaultTemplate(protocol)` seeds every newly-created
  template with a starting `workload` (via `DEFAULT_PACKET_WORKLOAD`, or a
  protocol-appropriate tier — e.g. `db` slightly heavier than `event` — at
  the implementer's discretion within `WORKLOAD_TIER_RANGES`'s existing
  bounds) so a fresh template is immediately valid without extra clicks,
  matching this file's existing "sensible starting values" convention.

### Resolution functions (`particleEngine.ts` — new, engine-state-dependent,
so NOT in the pure `compute.ts` module)

```
resolveParticleWorkload(particle: Particle): WorkloadDemand
```
Exact resolution for a specific particle: `_packetTemplates[particle.templateId]?.workload ?? DEFAULT_PACKET_WORKLOAD`
(also the fallback when `particle.templateId` is `undefined`, i.e. generic mode).

```
blendDistributionWorkload(dist: PacketDistributionEntry[] | undefined, edgeType: EdgeType): WorkloadDemand | undefined
```
Shared inner helper: weighted-average `cpuInstructionsBillions`/
`memoryFootprintMb`/`ioBoundFraction` across `dist`, restricted to entries
whose template's protocol is compatible with `edgeType` (same eligibility
filter `rollDistribution`/`distributionReadFraction` already use —
`edgeAcceptsProtocol`), weighted by each entry's `weight`. Returns
`undefined` (not a default) when there's nothing eligible to blend, so
callers can layer their own fallback.

```
resolveSourceOutboundWorkload(sourceNodeId: string, edgeType: EdgeType): WorkloadDemand
```
For caller-side, particle-less contexts: blends the *source's own*
`packetDistribution` (already exists on `NodeData`, already describes that
node's outbound traffic mix) via `blendDistributionWorkload`, falling back
to `DEFAULT_PACKET_WORKLOAD` in generic mode or when nothing eligible
exists.

```
resolveInboundWeightedWorkload(targetNodeId: string): WorkloadDemand
```
For the target's aggregate utilization calc: iterates every inbound edge
into `targetNodeId`, blends *that edge's source's* distribution (filtered
to the edge's own type), then combines across edges weighted by each
edge's `effectiveRps ?? rps` share (mirroring how `inRps` itself is already
summed from inbound edges at `:1614` in the existing code). Falls back to
`DEFAULT_PACKET_WORKLOAD` when there are no inbound edges or nothing
eligible blends.

### `resolveEc2Resources` → `resolveEc2Profile`

`compute.ts`'s `resolveEc2Resources(config): { profile, workload } | null`
(`:121-124`) collapses to just the profile half, since workload no longer
lives on `config`:

```ts
export function resolveEc2Profile(config: NodeSimConfig): ComputeProfile | null {
  return config.computeProfile ?? null
}
```

Every call site now resolves `profile` via this function, then separately
resolves the workload via whichever of the three functions above fits that
call site's context (see table below).

### Call-site changes (`particleEngine.ts`)

| Site | Was | Now |
|---|---|---|
| `trackRequest` (`:715-728`) | `resolveEc2Resources(config)` gives both | Takes a new optional `particle?: Particle` parameter. `resolveEc2Profile(config)` for the profile; workload = `particle ? resolveParticleWorkload(particle) : resolveSourceOutboundWorkload(nodeId, 'request')` (the particle-less callers are always on a `'request'` edge — `isThreadPoolEdge`'s own gate already requires this). |
| Caller-side cap sizing (`:1015`/`:2526`) | `resolveEc2Resources(srcConfig)` | `resolveEc2Profile(srcConfig)` for `profile`; `resolveSourceOutboundWorkload(sourceNodeId, 'request')` for `workload` when `profile` is non-null. |
| Target admission decision (`:1422-1433`) | `resolveEc2Resources(config)` | `resolveEc2Profile(config)`; `workload = resolveParticleWorkload(particle)` — `particle` is already in scope here. |
| Legacy-`maxRps`-skip gate (`:1653`) | `resolveEc2Resources(config) !== null` | `resolveEc2Profile(config) !== null` — never needed `.workload` anyway. |
| `updateAllNodeMetrics` utilization (`:1957-1963`) | `resolveEc2Resources(config)` | `resolveEc2Profile(config)`; `workload = resolveInboundWeightedWorkload(nodeId)`. |
| `trackRequest`'s 4 arrival-time call sites (`:1477`/`:1561`/`:1643`/`:1678`) | `trackRequest(targetNodeId, targetNodeType, config)` | `trackRequest(targetNodeId, targetNodeType, config, particle)` — thread the already-in-scope `particle` through. |
| `trackRequest`'s 2 caller-side call sites (`:1035`/`:2531`) | same | unchanged call (no 4th arg) — `trackRequest` internally falls back to `resolveSourceOutboundWorkload` when `particle` is omitted. |

### UI (`SimConfigPanel.tsx`)

- Delete the "Workload" `configBlock` (tier/instructions/memory/IO-bound
  fields, currently `:446-540`ish) entirely — `ComputeProfile`'s hardware
  fields (vCPU, RAM, clock, architecture, IO model) stay.
- The "Derived Threads" live-stat (`:938`) can no longer show one precise
  number once workload varies per packet — change it to use
  `DEFAULT_PACKET_WORKLOAD` (an indicative estimate assuming default/generic
  traffic) with an updated tooltip/label noting actual capacity varies per
  packet type in Custom mode. Not a live blend computed inside the React
  component — that would require reaching into `canvas.store`'s edges and
  distribution from a properties-panel component, disproportionate to what
  this readout is for (a rough sizing hint, not a simulation-accuracy
  guarantee).

### UI (`PacketEditor.tsx`)

- Add a "Workload" section to `PacketCard`, rendered once (not
  per-protocol, since `workload` lives on `BasePacketTemplate` — shared by
  every protocol) — reuse the tier/instructions/memory/IO-bound field
  layout being removed from `SimConfigPanel` (same `WORKLOAD_TIER_RANGES`/
  `resolveWorkloadInstructions` logic), adapted to this file's card-based
  visual style (`PayloadBody`-adjacent, or its own labeled block below the
  protocol pins).
- `defaultTemplate(protocol)` seeds a starting `workload` (see Defaults
  above).

## Non-goals

- No change to `ComputeProfile` (hardware) — stays node-level, unaffected.
- No change to `container`/`pod`/`lambda`/DB/queue/network node types'
  capacity semantics — this only touches how EC2's *already-existing*
  compute model resolves its workload input, not which node types
  participate in it.
- No migration script for old `.scalemap` files — `simConfig.workload` on
  old files becomes a harmless, silently-ignored orphan key; no schema
  version bump needed since `serializer.ts` doesn't validate `simConfig`'s
  shape strictly (round-trips as `Partial<NodeSimConfig>`).
- No caching/memoization of the new resolution functions. `resolveParticleWorkload`
  and `resolveInboundWeightedWorkload` run at their existing cadences (per
  arrival, per metrics tick) — no hotter than what they replace.
  `resolveSourceOutboundWorkload` runs per particle-mint attempt in the
  spawn hot loop (replacing a previously-simpler node-config read), which
  is a real but small per-call cost increase (iterating a typically-short
  `packetDistribution` array); add memoization only if profiling shows it
  matters, not preemptively.

## Testing / verification

- Update existing fixtures across `compute.test.ts`, `computeDefaults.test.ts`,
  `nodeConfig.workload.test.ts`, `oomCrashLock.test.ts`,
  `circuitBreakerMetrics.test.ts`, `threadPoolUnification.test.ts`,
  `outboundBacklogDrain.test.ts` (every file the codebase-wide `workload`
  grep found) — remove `workload:` from `NodeSimConfig` object literals,
  add it to whatever `PacketTemplate` fixtures those tests construct (or
  rely on `DEFAULT_PACKET_WORKLOAD` where a test doesn't care about a
  specific value).
- New unit tests for `blendDistributionWorkload`/`resolveSourceOutboundWorkload`/
  `resolveInboundWeightedWorkload`: a node with a 2-template weighted
  distribution (e.g. 80% light CRUD / 20% heavy compute) should blend to a
  workload strictly between the two, proportioned to the weights — not
  simply the average of the two (verify the weighting math with an uneven
  split, not just 50/50, so an unweighted-average bug can't hide).
- Integration test (established `@vitest-environment jsdom` + mocked-rAF
  pattern): two custom templates on the same edge's distribution — a heavy
  one and a light one — confirm particles resolved to the heavy template
  hold their target's thread-pool slot measurably longer than particles
  resolved to the light one (proves per-particle exact resolution actually
  differentiates, the core point of this issue).
- Manual verification via `npm run dev`: create two packet templates with
  very different workload tiers, assign both to one node's distribution,
  confirm `PacketEditor` renders/edits workload fields for all 4 protocol
  types, confirm `SimConfigPanel`'s EC2 Workload section is gone and
  "Derived Threads" still shows a sensible number, run the simulation and
  confirm the node's behavior differs visibly depending on which template
  is (probabilistically) driving a given burst of traffic.
