# Phase 4 plan fragment — Tasks 7–8 (carry-forwards · final integration)

> Fragment scope: Task 7 (managed-service provider selector + Phase-3 hygiene carry-forwards),
> Task 8 (final integration, phase-gate live smoke, `docs/module-boundaries.md` §M, PHASE 4
> ledger). These are independent of T1–T6's region/rack work at the type level (T7 touches only
> `world.store.ts`/`PlacementPanel.tsx`/`costModelV2.test.ts`/four `server/` files) but T8 must
> run last — it verifies the WHOLE phase, T1–T7 inclusive. No scene-accent constants are
> introduced by either task (T7 is behavior-only; T8 is docs-only), so there is no "shared local
> scene constants" header to declare here (contrast the Task-3-style header in
> `phase3/fragments/tasks-03-05.md`).

**Grounding index for this fragment:** `/private/tmp/claude-501/-Users-nish-Projects-scalemap/750edf85-5e62-4d17-830c-d1af07a3ca1e/scratchpad/phase4-grounding.md`
§0 (rulings R6/R7 are load-bearing for Task 7), §3 (store surface), §8 (verbatim file-by-file
carry-forward notes). Design spec D10(a–e):
`docs/superpowers/specs/2026-07-09-phase4-region-rack-design.md`. Phase-3 backlog these tasks
absorb: `.superpowers/sdd/progress.md`, "OPEN ITEMS for Phase 4 / backlog" (bottom of the PHASE 3
section).

---

## Task 7: Carry-forwards — provider selector + Phase-3 hygiene `[sonnet]`

**Files:** modify `src/app/store/world.store.ts`, `src/app/world/panels/PlacementPanel.tsx`,
`src/lib/costModelV2.test.ts`, `src/app/store/world.store.test.ts`,
`src/app/world/server/ServerBoard.tsx`, `src/app/world/server/inspectorForms.tsx`,
`src/app/world/server/FirewallGate.tsx` (verify only — see Step 8), `src/app/world/server/PacketLayer.tsx`.

**Grounding (verified against current source, all five carry-forward items = design D10 a–e):**
- `world.store.ts:80` (interface) and `:176-180` (impl) — `addManagedService` currently hardcodes
  `provider: 'generic'` in the impl and has no `provider` parameter at all. The store's default
  export doc.managedServices entry today is always priced at $0 via `getServiceSpec` (confirmed
  in `costModelV2.ts`: `if (!spec) return 0 // 'generic' provider or unmapped nodeType`). This is
  the exact Phase-3 backlog item: *"world.store.addManagedService hardcodes provider:'generic' →
  getServiceSpec returns $0, so managed services added via the REAL UI price $0 regardless of
  nodeType"* (progress.md, PHASE 3 open items).
- `PlacementPanel.tsx:58-62` — the `+ Add` button's `onClick` calls
  `store.addManagedService(msType, label, scope, 5432)` — 4 args, no provider. `MANAGED_TYPES`
  already authors canonical `CLOUD_REGISTRY` keys (`dbSql`/`objectStorage`/`queue`/…, Phase-3
  Task 8) so pricing only needs a non-generic `provider` to stop being $0.
  `ManagedService.provider: 'generic' | 'aws' | 'gcp' | 'azure'` already exists on the type
  (`src/lib/world/types.ts:170`) — nothing to add there.
  `cloudRegistry.ts`'s `dbSql.aws` entry has `instanceHourly` pricing
  (`defaultRateUsdHr: 0.068, defaultCount: 1`), so an `aws`-provider `dbSql` service prices
  `0.068 × 730 ≈ $49.64/mo` — confirmed non-zero.
- `costModelV2.test.ts` already has (do NOT duplicate) a case named
  *"prices new managed services authored with CLOUD_REGISTRY keys directly (dbSql)"* that
  hand-builds a `doc.managedServices['ms-new']` literal with `provider: 'aws'` directly — R6
  (grounding §0): the NEW case must instead drive the **store-authored path**
  (`useWorldStore.getState().addManagedService(...)`), proving the new `provider` param actually
  flows from the store action into a priced document, not just that the pricing function handles
  a hand-built fixture.
- `inspectorForms.tsx` — three falsy-zero bugs, all `x || y` patterns that silently discard a
  legitimate `0`:
  - `RuntimeForm` (`cpuLimit`/`memLimitMb`, lines ~65-66): `onCommit={v => setRt({ cpuLimit: v || null })}`.
    `NumberField`'s `onBlur` (same file, `NumberField`) already guarantees `v` is
    `Number.isFinite(v) && v >= 0` before calling `onCommit` — so `v` is never `NaN`/negative here,
    only ever a real number that happens to sometimes be `0`. `v || null` maps that `0` to `null`
    (meaning "unlimited"), so a user can never actually set/keep an explicit zero limit.
  - `FirewallEditor` (`port`, line ~97):
    `onChange={e => patch(i, { port: e.target.value === 'any' ? 'any' : (Number(e.target.value) || 'any') })}`.
    Typing literal `0` into the port field: `Number('0') === 0` (falsy) → coerced to `'any'`
    instead of being stored as the number `0`.
- `ServerBoard.tsx` — `residentBlueprints`/`attribution`/`memLimits`+`instanceRamMb`/
  `volumeConsumers` are five plain `const`/loop computations, recomputed on every render
  (documented Phase-3 Minor: *"ServerBoard derived values [...] unmemoized — cheap at ≤12 chips +
  1Hz events but tidier with useMemo"*). Separately, `gateBlockedPerSecond` (line 44) reads
  `latestBatch?.simMs ?? 0` — **not** `scrubBatch ?? latestBatch` — so the blocked/s counter keeps
  advancing off the live clock even while the board is showing a scrubbed historical frame
  (documented Minor: *"gate block counter not scrub-aware"*). R7 (grounding §0) is explicit: the
  fix reads the **display** batch's simMs.
- `FirewallGate.tsx` — pure presentational component; it only renders whatever
  `blockedPerSecond` prop it's given (verified: no `simMs`/store read anywhere in the file). The
  R7 fix therefore has **no code change in this file** — it is entirely in its caller
  (`ServerBoard.tsx`). This file is listed in the skeleton/grounding's Files sections because it's
  the visible surface of the fix, not because its source changes; Step 8 below is a verification
  step, not an edit.
- `PacketLayer.tsx` `pointAt` (lines ~36-49) calls `path.getTotalLength?.()` then
  `path.getPointAtLength(...)` with no exception handling — documented Phase-3 Minor:
  *"getPointAtLength packet positioning unverified in WebKit/Tauri native build"*. D10e: wrap in
  try/catch, fall back to a linear interpolation between the trace's two anchors
  (`layout.anchorFor(fromId)`/`layout.anchorFor(toId)`, both already used identically in
  `TraceLayer.tsx` — `Anchor = { x: number; y: number }`, `anchorFor(id): Anchor | null`).

**Scope note:** all five items are additive/behavior-preserving except the two genuinely new
behaviors (provider pricing, falsy-zero, scrub-correct blocked/s) — none of them touch
`worldEngine/`, none change any frozen contract, none add a new store action.

- [ ] **Step 1: Write the two new failing tests**

Append to `src/app/store/world.store.test.ts` (inside the existing `describe('world.store', ...)`
block, after the `removeManagedService strips dependencies targeting it` case):

```ts
  it('addManagedService stores the given provider', () => {
    const { azId } = buildChain()
    const msId = useWorldStore.getState().addManagedService('dbSql', 'SQL DB', { kind: 'az', azId }, 5432, 'aws')
    const doc = useWorldStore.getState().doc
    expect(doc.managedServices[msId].provider).toBe('aws')
  })
```

Append to `src/lib/costModelV2.test.ts` (inside `describe('computeWorldCost', ...)`, after the
existing `prices new managed services authored with CLOUD_REGISTRY keys directly (dbSql)` case).
This file currently has no store import — add one:

```ts
import { describe, it, expect } from 'vitest'
import { computeWorldCost } from './costModelV2'
import { createWorld, createRegion, createAz, createServer } from './world/factories'
import { getPreset } from './world/instanceCatalog'
import { useWorldStore } from '../app/store/world.store'
import type { WorldDoc } from './world/types'
```

```ts
  it('authored aws managed service prices non-zero', () => {
    // R6 (grounding §0): unlike the hand-built-fixture case above, this drives the STORE-authored
    // path — proving addManagedService's new provider param actually reaches a priced document,
    // not just that computeWorldCost can price a manually-constructed ManagedService literal.
    useWorldStore.getState().newWorld()
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addManagedService('dbSql', 'SQL DB', { kind: 'az', azId }, 5432, 'aws')
    const doc = useWorldStore.getState().doc
    expect(computeWorldCost(doc, null).monthlyUsd).toBeGreaterThan(0)
  })
```

- [ ] **Step 2: Run to verify both fail**

Run: `npx vitest run src/app/store/world.store.test.ts`
Expected: FAIL — `addManagedService` only accepts 4 args; the 5th (`'aws'`) is a **type error**
under strict tsc (`vitest` still executes untyped, so the case runs but
`doc.managedServices[msId].provider` is `'generic'`, not `'aws'` → assertion fails).

Run: `npx vitest run src/lib/costModelV2.test.ts`
Expected: FAIL — same reason; `addManagedService('dbSql', …, 'aws')`'s 5th arg is silently
dropped by the pre-T7 signature, so the service is stored with `provider: 'generic'` and
`getServiceSpec` returns `undefined` → `monthlyUsd` stays `0` → `toBeGreaterThan(0)` fails.

- [ ] **Step 3: `world.store.ts` — thread the `provider` parameter**

Add `ManagedService` to the existing type-only import (needed for `ManagedService['provider']`):

```ts
import type {
  WorldDoc, Server, ServiceBlueprint, Placement, ManagedScope, ManagedService, ClientPopulation,
  RoutingConfig, TrafficConfig,
} from '../../lib/world/types'
```

Interface (`WorldStore`), change the `addManagedService` signature:

```ts
  addManagedService: (nodeType: string, label: string, scope: ManagedScope, port: number) => string
```
→
```ts
  addManagedService: (nodeType: string, label: string, scope: ManagedScope, port: number, provider?: ManagedService['provider']) => string
```

Implementation, replace the hardcoded `provider: 'generic'`:

```ts
    addManagedService: (nodeType, label, scope, port) => {
      const id = nextWorldId('ms')
      mutate(d => ({ ...d, managedServices: { ...d.managedServices, [id]: { id, label, nodeType, scope, provider: 'generic', port } } }))
      return id
    },
```
→
```ts
    addManagedService: (nodeType, label, scope, port, provider = 'generic') => {
      const id = nextWorldId('ms')
      mutate(d => ({ ...d, managedServices: { ...d.managedServices, [id]: { id, label, nodeType, scope, provider, port } } }))
      return id
    },
```

The trailing param is additive with a default — every existing 4-arg call site
(`PlacementPanel.tsx` pre-Step-4, both `world.store.test.ts` pre-existing cases, both
`costModelV2.test.ts` pre-existing cases) keeps compiling and keeps defaulting to `'generic'`,
unchanged.

- [ ] **Step 4: `PlacementPanel.tsx` — provider `<select>`, default `'aws'`**

Add `ManagedService` to the existing type import:

```tsx
import type { Placement, PlacementRuntime } from '../../../lib/world/types'
```
→
```tsx
import type { ManagedService, Placement, PlacementRuntime } from '../../../lib/world/types'
```

Add a `PROVIDERS` table next to `MANAGED_TYPES` (top of file, after the `MANAGED_TYPES` array):

```tsx
// Phase 4 D10a: the authoring UI defaults to 'aws' (not the store's 'generic' default) so a
// freshly added managed service prices non-zero immediately — see world.store.ts's
// addManagedService, whose own default stays 'generic' for callers that omit the param.
const PROVIDERS: { key: ManagedService['provider']; label: string }[] = [
  { key: 'aws', label: 'AWS' },
  { key: 'gcp', label: 'GCP' },
  { key: 'azure', label: 'Azure' },
  { key: 'generic', label: 'Generic' },
]
```

Add state (next to the existing `msType`/`msScope` state):

```tsx
  const [msType, setMsType] = useState(MANAGED_TYPES[0].key)
  const [msScope, setMsScope] = useState('')
```
→
```tsx
  const [msType, setMsType] = useState(MANAGED_TYPES[0].key)
  const [msScope, setMsScope] = useState('')
  const [msProvider, setMsProvider] = useState<ManagedService['provider']>('aws')
```

Add the `<select>` and thread `msProvider` through as the 5th arg:

```tsx
      <div style={row}>
        <select style={{ ...field, flex: 1, marginBottom: 0 }} value={msType} onChange={e => setMsType(e.target.value)}>
          {MANAGED_TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <select style={{ ...field, flex: 1, marginBottom: 0 }} value={msScope} onChange={e => setMsScope(e.target.value)}>
          <option value="">scope…</option>
          {scopeOptions.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        <button style={smallBtn} disabled={!msScope} onClick={() => {
          const [kind, id] = msScope.split(':')
          store.addManagedService(msType, MANAGED_TYPES.find(t => t.key === msType)?.label ?? msType,
            kind === 'region' ? { kind: 'region', regionId: id } : { kind: 'az', azId: id }, 5432)
        }}>+ Add</button>
      </div>
```
→
```tsx
      <div style={row}>
        <select style={{ ...field, flex: 1, marginBottom: 0 }} value={msType} onChange={e => setMsType(e.target.value)}>
          {MANAGED_TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <select style={{ ...field, flex: 1, marginBottom: 0 }} value={msScope} onChange={e => setMsScope(e.target.value)}>
          <option value="">scope…</option>
          {scopeOptions.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        <select style={{ ...field, width: 74, marginBottom: 0 }} aria-label="provider" value={msProvider}
          onChange={e => setMsProvider(e.target.value as ManagedService['provider'])}>
          {PROVIDERS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        <button style={smallBtn} disabled={!msScope} onClick={() => {
          const [kind, id] = msScope.split(':')
          store.addManagedService(msType, MANAGED_TYPES.find(t => t.key === msType)?.label ?? msType,
            kind === 'region' ? { kind: 'region', regionId: id } : { kind: 'az', azId: id }, 5432, msProvider)
        }}>+ Add</button>
      </div>
```

No `PlacementPanel.test.tsx` exists today (verified — only `BlueprintPanel.test.tsx`/
`TopologyPanel.test.tsx`/`WorldPanel.test.tsx` do) and Phase-3 Task 8 set the precedent of not
adding one when re-keying this same managed-services picker — coverage stays at the store/cost
layer (Step 1's two cases) plus the live smoke in Task 8, which exercises this exact control.

- [ ] **Step 5: Run the two new tests — confirm they pass**

Run: `npx vitest run src/app/store/world.store.test.ts` → PASS (12 tests; 11 existing + 1 new).
Run: `npx vitest run src/lib/costModelV2.test.ts` → PASS (6 tests; 5 existing + 1 new).

- [ ] **Step 6: `ServerBoard.tsx` hygiene — memoize the derived values, scrub-correct the gate counter**

Add `useMemo` to the React import:

```tsx
import { useEffect, useRef, useState, type ReactElement } from 'react'
```
→
```tsx
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
```

Replace the `display`/`events`/`latestBatch`/`gateBlockedPerSecond` block:

```tsx
  const display = useServerDisplayMetrics(serverId)
  const events = useSimulationStore(s => s.events)
  const latestBatch = useSimulationStore(s => s.latestBatch)
  const gateBlockedPerSecond = blockedPerSecond(events, serverId, layout.residentInstanceIds, latestBatch?.simMs ?? 0)
```
→
```tsx
  const display = useServerDisplayMetrics(serverId)
  const events = useSimulationStore(s => s.events)
  const latestBatch = useSimulationStore(s => s.latestBatch)
  const scrubBatch = useSimulationStore(s => s.scrubBatch)
  // D10d/R7: the blocked/s counter must be scrub-correct — read the DISPLAY batch's simMs
  // (scrubBatch ?? latestBatch), not latestBatch unconditionally. Previously the counter kept
  // advancing off the live clock even while the board displayed a scrubbed historical frame.
  const displaySimMs = (scrubBatch ?? latestBatch)?.simMs ?? 0
  const gateBlockedPerSecond = useMemo(
    () => blockedPerSecond(events, serverId, layout.residentInstanceIds, displaySimMs),
    [events, serverId, layout.residentInstanceIds, displaySimMs],
  )
```

Replace the `residentBlueprints`/`attribution`/`memLimits`+`instanceRamMb`/`volumeConsumers` block:

```tsx
  // Resident blueprints for the hardware platform (D4): signature color/name + at-rest ramBaseMb
  // (D5, used when metrics is null).
  const residentBlueprints = layout.chips.map(chip => {
    const bp = doc.blueprints[chip.blueprintId]
    return {
      instanceId: chip.instanceId, blueprintId: chip.blueprintId,
      color: bp?.color ?? '#888', name: bp?.name ?? '?', ramBaseMb: bp?.workload.ramBaseMb ?? 0,
    }
  })

  // Live per-core attribution (D8): dominant blueprint per vCPU from live cpuCoresUsed.
  const attribution: CoreAttribution[] = attributeCores(
    server?.specs.vcpu ?? 0,
    layout.chips.map(chip => ({
      instanceId: chip.instanceId, blueprintId: chip.blueprintId,
      cpuCoresUsed: display.instances[chip.instanceId]?.cpuCoresUsed ?? 0,
    })),
  )

  // Container memLimitMb by instance (oom check) + live per-instance ramMb.
  const memLimits: Record<InstanceId, number> = {}
  for (const chip of layout.chips) {
    const rt = doc.placements[chip.placementId]?.runtime
    if (rt?.type === 'container' && rt.memLimitMb != null) memLimits[chip.instanceId] = rt.memLimitMb
  }
  const instanceRamMb: Record<InstanceId, number> = {}
  for (const chip of layout.chips) {
    const m = display.instances[chip.instanceId]
    if (m) instanceRamMb[chip.instanceId] = m.ramMb
  }

  // Volume -> consumer blueprint id (D8 disk-slice cross-highlight): attribute each volume to
  // the resident blueprint whose volumeName matches it.
  const volumeConsumers: Record<string, string> = {}
  for (const st of server?.stacks ?? []) {
    for (const v of st.volumes) {
      const bp = Object.values(doc.blueprints).find(b => b.volumeName === v.name)
      if (bp) volumeConsumers[v.name] = bp.id
    }
  }
```
→
```tsx
  // Resident blueprints for the hardware platform (D4): signature color/name + at-rest ramBaseMb
  // (D5, used when metrics is null). Memoized (T7 hygiene, Phase-3 carry-forward) — recomputed
  // only when the chip list or blueprint table changes, not on every render/1Hz metrics tick.
  const residentBlueprints = useMemo(() => layout.chips.map(chip => {
    const bp = doc.blueprints[chip.blueprintId]
    return {
      instanceId: chip.instanceId, blueprintId: chip.blueprintId,
      color: bp?.color ?? '#888', name: bp?.name ?? '?', ramBaseMb: bp?.workload.ramBaseMb ?? 0,
    }
  }), [layout.chips, doc.blueprints])

  // Live per-core attribution (D8): dominant blueprint per vCPU from live cpuCoresUsed.
  const attribution: CoreAttribution[] = useMemo(() => attributeCores(
    server?.specs.vcpu ?? 0,
    layout.chips.map(chip => ({
      instanceId: chip.instanceId, blueprintId: chip.blueprintId,
      cpuCoresUsed: display.instances[chip.instanceId]?.cpuCoresUsed ?? 0,
    })),
  ), [server?.specs.vcpu, layout.chips, display.instances])

  // Container memLimitMb by instance (oom check) + live per-instance ramMb. Grouped into one
  // memo — both loops walk the same layout.chips list and feed the same HardwarePlatform props,
  // so memoizing them separately would be an arbitrary split of one logical derivation.
  const { memLimits, instanceRamMb } = useMemo(() => {
    const memLimits: Record<InstanceId, number> = {}
    for (const chip of layout.chips) {
      const rt = doc.placements[chip.placementId]?.runtime
      if (rt?.type === 'container' && rt.memLimitMb != null) memLimits[chip.instanceId] = rt.memLimitMb
    }
    const instanceRamMb: Record<InstanceId, number> = {}
    for (const chip of layout.chips) {
      const m = display.instances[chip.instanceId]
      if (m) instanceRamMb[chip.instanceId] = m.ramMb
    }
    return { memLimits, instanceRamMb }
  }, [layout.chips, doc.placements, display.instances])

  // Volume -> consumer blueprint id (D8 disk-slice cross-highlight): attribute each volume to
  // the resident blueprint whose volumeName matches it.
  const volumeConsumers: Record<string, string> = useMemo(() => {
    const consumers: Record<string, string> = {}
    for (const st of server?.stacks ?? []) {
      for (const v of st.volumes) {
        const bp = Object.values(doc.blueprints).find(b => b.volumeName === v.name)
        if (bp) consumers[v.name] = bp.id
      }
    }
    return consumers
  }, [server, doc.blueprints])
```

Nothing below this point in the file changes — the JSX return block references
`residentBlueprints`/`attribution`/`memLimits`/`instanceRamMb`/`volumeConsumers`/
`gateBlockedPerSecond` by the same names with the same shapes, so every prop passed to
`HardwarePlatform`/`FirewallGate` is byte-identical to before; this is a pure memoization + input
change, not a rendering change.

- [ ] **Step 7: `inspectorForms.tsx` hygiene — stop coalescing meaningful zeros**

`RuntimeForm`:

```tsx
      <NumberField label="cpuLimit" value={rt.cpuLimit ?? 0} onCommit={v => setRt({ cpuLimit: v || null })} />
      <NumberField label="memLimitMb" value={rt.memLimitMb ?? 0} onCommit={v => setRt({ memLimitMb: v || null })} />
```
→
```tsx
      <NumberField label="cpuLimit" value={rt.cpuLimit ?? 0} onCommit={v => setRt({ cpuLimit: Number.isFinite(v) ? v : null })} />
      <NumberField label="memLimitMb" value={rt.memLimitMb ?? 0} onCommit={v => setRt({ memLimitMb: Number.isFinite(v) ? v : null })} />
```

`FirewallEditor`'s port input:

```tsx
          <input aria-label="port" style={{ ...inp, width: 40 }} value={String(r.port)} onChange={e => patch(i, { port: e.target.value === 'any' ? 'any' : (Number(e.target.value) || 'any') })} />
```
→
```tsx
          <input aria-label="port" style={{ ...inp, width: 40 }} value={String(r.port)} onChange={e => {
            const raw = e.target.value
            if (raw === 'any' || raw === '') { patch(i, { port: 'any' }); return }
            const n = Number(raw)
            patch(i, { port: Number.isFinite(n) && n >= 0 ? n : 'any' })
          }} />
```

The blank-input branch is kept explicit (clearing the field still resolves to `'any'`, matching
today's UX) — only a genuinely-typed `0` (or any other finite ≥0 number) now survives as that
number instead of being falsy-coalesced away. `NumberField` itself is untouched (its own
`onBlur` already does the correct `Number.isFinite(n) && n >= 0` check — the bug was only in the
two call sites above, both of which used `v || null` / `Number(...) || 'any'` after that guard
already ran).

- [ ] **Step 8: `FirewallGate.tsx` — verify, no edit**

Open the file and confirm it contains no `simMs`/store read of its own — it only destructures
`blockedPerSecond` from props and renders it (`✕ {blockedPerSecond…}/s blocked` when `> 0`). The
R7 scrub-correctness fix is entirely upstream in `ServerBoard.tsx` (Step 6); this file needs no
change. Do not stage a no-op diff.

- [ ] **Step 9: `PacketLayer.tsx` hygiene — geometry-throw fallback**

```tsx
    const pathCache = new Map<string, SVGPathElement>()
    const svgNS = 'http://www.w3.org/2000/svg'
    const pointAt = (fromId: string, toId: string, progress: number) => {
      const key = `${fromId}→${toId}`
      let path = pathCache.get(key)
      if (!path) {
        const d = layout.tracePath(fromId, toId)
        if (!d) return null
        path = document.createElementNS(svgNS, 'path')
        path.setAttribute('d', d)
        pathCache.set(key, path)
      }
      const len = path.getTotalLength?.() ?? 0
      if (!len) return null
      return path.getPointAtLength(len * progress)
    }
```
→
```tsx
    const pathCache = new Map<string, SVGPathElement>()
    const svgNS = 'http://www.w3.org/2000/svg'
    // D10e (Phase-3 carry-forward): getPointAtLength (and, defensively, getTotalLength) can throw
    // in some native WebView SVG implementations — never verified against an actual native Tauri
    // build (documented Phase-3 open item). A thrown geometry call must never crash the frame
    // loop; fall back to a straight-line lerp between the trace's two cached anchors — visually
    // close enough for a single degraded frame, and cheap (anchorFor is a plain lookup).
    const pointAt = (fromId: string, toId: string, progress: number): { x: number; y: number } | null => {
      const key = `${fromId}→${toId}`
      let path = pathCache.get(key)
      if (!path) {
        const d = layout.tracePath(fromId, toId)
        if (!d) return null
        path = document.createElementNS(svgNS, 'path')
        path.setAttribute('d', d)
        pathCache.set(key, path)
      }
      try {
        const len = path.getTotalLength?.() ?? 0
        if (!len) return null
        return path.getPointAtLength(len * progress)
      } catch {
        const a = layout.anchorFor(fromId)
        const b = layout.anchorFor(toId)
        if (!a || !b) return null
        return { x: a.x + (b.x - a.x) * progress, y: a.y + (b.y - a.y) * progress }
      }
    }
```

The explicit `{ x: number; y: number } | null` return annotation is required so both branches
(the native `DOMPoint` from `getPointAtLength` and the plain-object lerp fallback) unify to one
type — `DOMPoint` is structurally assignable to `{x,y}` (it has `x`/`y`/`z`/`w`, all numbers), so
this compiles under strict tsc with no cast. `pathCache`'s per-attach rebuild (a Phase-3 Task-5
fix) and every call site (`ctx.arc(pt.x, pt.y, …)`) are unaffected — callers only ever read
`.x`/`.y`.

- [ ] **Step 10: Full verification**

Run: `npx vitest run src/app/store/world.store.test.ts` → PASS (12 tests).
Run: `npx vitest run src/lib/costModelV2.test.ts` → PASS (6 tests).

Re-run the existing suites the hygiene edits must NOT change (behavior-neutral — memoization,
explicit finite-checks, and a try/catch fallback are not new behavior on any path these suites
already exercise; per the skeleton, no throwaway tests are added for them):

Run: `npx vitest run src/app/world/server/ServerBoard.test.tsx` → PASS (5 tests, unchanged) — the
regression guard for the memoization + scrub-correct-simMs edit (Step 6). None of these 5 cases
assert on `gateBlockedPerSecond`'s scrub behavior specifically (there is no scrubbing in this
file's fixtures) — they prove the board still renders every zone correctly with the same derived
values, which is exactly what a behavior-preserving refactor should leave unchanged.
Run: `npx vitest run src/app/world/server/InspectorRail.test.tsx` → PASS (11 tests, unchanged) —
covers `inspectorForms.tsx` (there is no separate `inspectorForms.test.tsx`; its forms are
exercised here, per `docs/module-boundaries.md` §L). Confirms `RuntimeForm`/`FirewallEditor`
still commit correctly for the non-zero values these tests already use.
Run: `npx vitest run src/app/world/server/gateStats.test.ts` → PASS (5 tests, unchanged) — pure
unit tests of `blockedPerSecond` itself (untouched by Step 6; only its caller's `nowSimMs`
argument changed).
Run: `npx vitest run src/app/world/server/PacketLayer.test.tsx` → PASS (2 tests, unchanged) —
both tests mock `attachRenderer` entirely and never invoke `pointAt`, so they only prove
attach/detach still works after the Step 9 edit, not the fallback path itself (there is no
practical way to make jsdom's `SVGPathElement.getPointAtLength` throw without reaching into
happy-dom/jsdom internals — the fallback is defensive insurance for a native-WebView failure
mode this project cannot reproduce in jsdom; it remains unverified in a real Tauri build, same as
before this task).

Run: `npm run build` → succeeds (strict tsc + vite).
Run: `npx vitest run` → **276 tests green** (274 baseline + 2 new from Step 1; confirm the exact
number against the repo's current state before committing — it was 274/46 files at the time this
fragment was written, immediately after Phase 3 merged to main at `c7771d0`).

**Live verification:** no separate live-smoke gate is defined for this task (the skeleton names
one for T2/T3/T5/T6 but not T7 or T8's sibling pure-module tasks). The provider `<select>` this
task adds IS a real, on-screen UI control, so it should not go completely unverified outside unit
tests — Task 8's phase-gate live smoke (Step 3 there) adds one extra beat exercising it end to
end (author a managed service via the new selector, confirm the Cost tab prices it). Flagged
there as an addition beyond the spec's literal phase-gate story.

- [ ] **Step 11: Commit**

```bash
git add src/app/store/world.store.ts src/app/store/world.store.test.ts \
        src/app/world/panels/PlacementPanel.tsx src/lib/costModelV2.test.ts \
        src/app/world/server/ServerBoard.tsx src/app/world/server/inspectorForms.tsx \
        src/app/world/server/PacketLayer.tsx
git commit -m "fix(world): managed-service provider selection + server-view hygiene carry-forwards"
```

(`FirewallGate.tsx` is intentionally absent from this list — Step 8 verified it needs no change.)

---

## Task 8: Final integration, phase smoke, `docs/module-boundaries.md` §M `[sonnet]`

**Files:** modify `docs/module-boundaries.md` (append §M); modify `.superpowers/sdd/progress.md`
(append `## PHASE 4`); no source changes except whatever Step 2 turns up.

**Precondition:** Tasks 1–7 are committed on `phase4-region-rack`. This task is the phase's final
gate — it verifies the whole branch, not just T7's diff. Mirrors Phase 3's Task 9
(`phase3/fragments/tasks-06-09.md`), which is the structural precedent for this task's shape.

- [ ] **Step 1: Fix queued Minors**

Check each of T1–T7's own completion notes (whatever the controller/implementer logged per-task
during actual execution — analogous to how Phase 3's T4 queued a `HEALTH_COLOR` dedup that T9
picked up) for anything flagged as deferred-to-final-integration, and apply the trivial/safe ones
here. At minimum, confirm the following Phase-3-backlog items (`progress.md`'s "OPEN ITEMS for
Phase 4 / backlog") are now resolved by this phase's actual work, and record their disposition in
Step 5's ledger entry — don't leave the ledger vague:

| Backlog item | Expected disposition after T1–T7 |
|---|---|
| `addManagedService` hardcodes `provider:'generic'` → managed services price $0 | **RESOLVED** (T7) |
| Falsy-zero coalescing (`port 0→'any'`, `cpuLimit`/`memLimitMb 0→null`) | **RESOLVED** (T7) |
| `ServerBoard` derived values unmemoized | **RESOLVED** (T7) |
| Gate block counter not scrub-aware | **RESOLVED** (T7) |
| `AzSimOverlay` re-subscribes the renderer on every pan/zoom (Phase-2 standing deferral) | **RESOLVED** (T6, per D9) — confirm `AzSimOverlay.tsx`'s effect deps are exactly `[running, azId, reduced]` before crediting this |
| Overflow residents (>12 chips) not color-attributed | **STILL OPEN** — out of scope this phase, not touched by any T1–T7 task |
| `getPointAtLength` unverified in a native Tauri build | **MITIGATED, NOT VERIFIED** (T7 added a try/catch + lerp fallback; no native `tauri build` smoke exists to actually exercise the throw path) |
| Fold hop latency into instance p50/p99; `applyNicCap` shed/queue; per-step grouping-map caching (Phase-2 standing deferrals) | **STILL OPEN** — engine-side, out of scope (Global Constraints forbid `worldEngine/` changes this phase anyway) |

- [ ] **Step 2: Full verification battery**

Run: `npx vitest run` → **ALL suites green — record the exact count** (baseline 274 before this
phase's T1–T6 add their own new test files/cases, +2 from T7 Step 1; the true final number
depends on T1–T6's actual test counts as executed — do not hardcode a number here, report what
the run actually prints).
Run: `npm run build` → succeeds (strict tsc + vite).

If either fails, stop and fix before proceeding — Step 3's live smoke assumes a green, buildable
tree.

- [ ] **Step 3: Full end-to-end live smoke — the phase gate (controller-run, port 1420)**

This is the spec's (`2026-07-09-phase4-region-rack-design.md`, "Testing & verification") gating
story end-to-end, plus one addition (marked below) exercising T7's provider selector, which the
spec's story doesn't otherwise touch. Zero console errors throughout is a hard requirement, not a
nice-to-have — treat any red console line as a blocking bug, not a note.

1. `npm run dev` (background); wait for `Local:   http://localhost:1420/`.
2. `browser_navigate` → `http://localhost:1420`; `browser_click` "New World".
3. Author a 2-AZ region under load, via the real UI (Topology/Blueprints/Placements tabs,
   established across Phases 2–3) plus the `window.__scalemapDebug` DEV hook only where the UI
   still can't author something (population traffic, per Phase 2/3 precedent):
   - Topology: add region `us-east-1` → two AZs (`us-east-1a`, `us-east-1b`) → 2–3 servers per AZ
     (`vps-medium`/`dedicated-8` presets).
   - Blueprints: a `web` blueprint with a public port; an entry-tier dependency chain deep enough
     to generate real cross-AZ traffic once populations are added.
   - Placements: place `web` (and its dependencies) across both AZs' servers.
   - **[Addition, exercising T7]** Managed services: using the new provider `<select>` added in
     Task 7, add one `dbSql` managed service scoped to `us-east-1a` with provider **`aws`** (the
     UI's default) — leave it at the default, don't change it, to prove the default itself prices.
   - Populations: author via `window.__scalemapDebug.useWorldStore.getState().addPopulation(...)`
     with enough `peakRps` to drive visible load (Phase 2/3 precedent — no population-authoring
     UI exists yet).
4. Open the Cost tab — confirm the `dbSql`/`aws` managed service from step 3 contributes a
   non-zero line (proves T7's provider selector end-to-end, not just unit-level).
5. Navigate to the region view (Level 2). `browser_snapshot` — confirm: header shows
   `<catalogId> · 2 AZs · <n> servers · <k> service instances` + routing/health-interval chips;
   `AlertRibbon` slot present but empty (no alert yet); inbound column shows a nonzero rps +
   moving sparkline; `SplitLines` shares sum to ~100% across the two AZ rows; each `AzRow` shows a
   health ring, per-server strips with visible height (mean coreUtilization), and a `$<n>/mo`
   figure; `CrossAzColumn` shows the `1a ⇄ 1b` pair with the `1.5`ms cross-AZ latency figure.
6. Click `us-east-1b`'s row outage switch (⚡). `browser_snapshot` — confirm: `AlertRibbon`
   appears with a redistribution message naming `us-east-1a`; the split re-shares toward ~100%
   `1a`/~0% `1b`; `1b`'s row dims, shows the red left border, and swaps its strips for the drain
   line (`draining → us-east-1a` [`· replicas promoting`] if any stateful blueprint has a replica
   there); `TimelineStrip` logs `outage_triggered`/`health_check_failed`/failover-adjacent events.
7. Click "Stop" (`SimControls`). Click an event glyph on `TimelineStrip`. `browser_snapshot` —
   confirm `ScrubberV2` shows a scrubbed state (not "live") and the region page's numbers now
   reflect that historical frame (ring scores / strips / $ figures change from the live-stopped
   snapshot to the scrubbed one).
8. Navigate into `us-east-1a`'s AZ canvas (Level 3, still scrubbed or re-run live — either
   demonstrates the rack chassis). `browser_snapshot` — confirm: server nodes are now rack
   **frames** (not flat cards) with stacked **chassis** at varying U-heights, rail dot pattern,
   `RACK <id> · <az label>` caption, blank-U filler strips where units are gapped, a `PDU · <n>kW`
   strip; each chassis shows the LED trio, drive-bay grid, vent grill, and cpu/ram/io micro-bars;
   if simulating live, confirm the micro-bars/LEDs are actually animating (re-`Simulate` if still
   scrubbed, to see this on real live data at least once). Managed node still dashed-border.
9. Click a chassis. `browser_snapshot` — confirm navigation lands on that server's Level-4 board
   (unchanged from Phase 3 — proves `worldChassis` click routing survived the T5 rewire).
10. Pan and zoom the AZ canvas continuously for several seconds while simulating — confirm (via
    `browser_console_messages` and visual inspection) particles keep tracking chassis positions
    with no drift and the renderer does not visibly stutter/reset (T6's no-re-subscribe fix).
11. `browser_console_messages` at each of the above milestones → assert ZERO error-level entries
    across the whole run (benign Vite HMR WS blips excepted, per established precedent).
12. `browser_take_screenshot` at steps 5, 6, 7, 8, 9 → save to
    `.superpowers/sdd/screenshots/phase4/` (create the directory if absent):
    `region-under-load.png`, `region-az-down.png`, `region-scrubbed.png`, `az-rack-chassis.png`,
    `server-interior-from-chassis.png`.
13. Stop the dev server.

- [ ] **Step 4: `docs/module-boundaries.md` — append §M**

Append after §L (Server interior board) and before "## 2. Shared "hub" files". Read the actual
T1–T6 source first and correct any prose below that drifted from what was really built (this is
a draft grounded in the skeleton + design spec, written before T1–T6 exist as code — reconcile,
don't transcribe blindly):

```markdown
---

### M. Region flow page & rack chassis — Phase 4 Levels 2–3 (`src/app/world/region/`, `src/lib/world/layoutRacks.ts`, `src/app/world/RackNodes.tsx`, 2026-07-09)

Replaces the Phase-1 placeholder `RegionView` with the Level-2 flow story (global-edge inbound →
animated split lines → AZ rows → cross-AZ column, one alert ribbon, a failover timeline, per-AZ
outage switches) and replaces the Level-3 AZ canvas's flat server cards with realistic rack-frame
groups of chassis (Task 5/6). Built across Tasks 1–6; Task 7 (§1J's `world.store.ts`/
`PlacementPanel.tsx` rows) and this task (integration) close out the phase. Spec:
`docs/superpowers/specs/2026-07-09-phase4-region-rack-design.md`.

| File | Role |
|---|---|
| `src/app/world/region/regionData.ts` (Task 1) | Pure selectors the whole region page derives from: `azShares` (per-AZ fraction of region rps, down AZs pinned to 0), `ribbonAlert` (most-severe recent region-scoped event, formatted with redistribution targets), `regionEvents` (events scoped to the region/its AZs/servers/resident instances/routed populations), `replicationPairs` (primary/replica pairs across this region's AZs), `crossAzEntries` (AZ-pair latency + replication, using a **local mirrored constant** `CROSS_AZ_HOP_MS = 1.5` — see the Frozen-contract note below, this is NOT an import from `worldEngine/`), `sparklineSeries`, `dominantBlueprintColor`. No React, no store reads — same "pure hub" shape as `server/boardLayout.ts` (§L) |
| `src/app/world/region/AlertRibbon.tsx`, `SplitLines.tsx`, `AzRow.tsx`, `CrossAzColumn.tsx` (Task 2) | The flow page's four visual sections, each a presentation component reading no store directly — `RegionView.tsx` computes everything from `regionData.ts` + `useSimulationStore`/`useWorldStore`/`useCompiledWorld` and passes it down as props |
| `src/app/world/region/TimelineStrip.tsx` (Task 3) | Failover timeline — region-scoped events on a simMs axis; click-to-scrub when stopped (`setScrubIndex`), inert while running |
| `src/app/world/RegionView.tsx` (Task 2, REWRITTEN) | Composition root: header + `AlertRibbon` + inbound/`SplitLines`/`AzRow`-stack/`CrossAzColumn` flow row + `TimelineStrip`. Preserves the existing Phase-2 region-outage button verbatim (`healthOverrides`/`setOutage('region', …)`) |
| `src/lib/world/layoutRacks.ts` (Task 4) | Pure rack-frame layout — the Level-3 analog of `server/boardLayout.ts` (§L): groups `Server`s by `rack.rackId` into frames, stacks chassis by `rack.unit` (height = `heightU × U_PX`), blank-unit fillers, PDU strip, a separate managed-service column. Deterministic; imported by both `AzCanvas.tsx` and `RackNodes.tsx`. Replaces `layoutAzGrid` for the AZ canvas |
| `src/lib/world/layoutAz.ts` — **DELETED (Task 5)** | `layoutAzGrid`'s only caller (`AzCanvas.tsx`) was rewired to `layoutRacks` in Task 5; grep-verified zero remaining importers before deletion. Superseded, not ported — its grid-position algorithm has no successor because rack framing replaces the whole positioning model, not just the numbers |
| `src/app/world/RackNodes.tsx` (Task 5) | `RackFrameNode` (non-interactive backdrop: rails, caption, filler strips, PDU) + `RackChassisNode` (LED trio, drive-bay grid, vent grill, cpu/ram/io micro-bars, noisy-neighbor tag, blocked-path badge) + `WorldManagedNode` (moved here verbatim from the deleted `WorldServerNode.tsx`, dashed-border managed-service node, unchanged visuals). **`RackNodes.tsx` owns all chassis chrome** — `AzCanvas.tsx` only positions nodes (via `layoutRacks`) and aggregates edges; it renders no chassis-internal markup itself |
| `src/app/world/WorldServerNode.tsx` — **DELETED (Task 5)** | `WorldServerNode` (flat server card) had no more callers once Task 5 rewired `AzCanvas.tsx` to `RackFrameNode`/`RackChassisNode`; `WorldManagedNode` was moved (not duplicated) into `RackNodes.tsx` before deletion — grep-verified no other importer existed (Phase-3 files reference the node TYPE STRINGS `'worldManaged'`/etc. in `AzSimOverlay.tsx`, not this file, and were updated to the new type strings in Task 6) |
| `src/app/world/AzCanvas.tsx` (Task 5, rewired) | Same edge-aggregation logic as Phase 1–3 (copied verbatim — `compiled.paths` → one aggregate edge per server pair, `internalBlockedByServer`, same-server-skip), but node-building now goes through `layoutRacks`: frames as React Flow parent nodes (`type: 'worldRackFrame'`, non-selectable, `zIndex: -1`), chassis as `parentId`-linked children (`extent: 'parent'`), managed nodes absolute. `worldChassis` click still routes to `goServer` |
| `src/app/world/AzSimOverlay.tsx` (Task 6, v2) | Switched from `getNode(id).position` + `useViewport()`-in-effect-deps to `getInternalNode(id).internals.positionAbsolute` (works through parent/child nesting) + `node.measured?.width/height` (falls back to the old fixed constants pre-paint, since chassis heights now vary by `heightU`) + an imperative `getViewport()` read **inside** the frame callback. Effect deps are now `[running, azId, reduced]` only — **this closes the Phase-2/3 standing "re-subscribes on every pan/zoom" deferral** (previously `useViewport()` sat in the deps array, causing a re-subscribe on every pan/zoom tick) |
| `src/app/store/world.store.ts` (Task 7) | `addManagedService` gained a 5th, optional `provider` parameter (`ManagedService['provider']`, default `'generic'` — additive, every pre-existing 4-arg call site is unaffected) |
| `src/app/world/panels/PlacementPanel.tsx` (Task 7) | Managed-service authoring gained a provider `<select>` (`aws`/`gcp`/`azure`/`generic`, UI default `'aws'` — deliberately different from the store's own `'generic'` default, so a freshly authored managed service prices non-zero without the user having to know to change it) |
| `src/app/world/server/{ServerBoard,inspectorForms,PacketLayer}.tsx` (Task 7, hygiene) | Behavior-preserving carry-forwards from the Phase-3 backlog: `ServerBoard.tsx` memoizes its five per-render derived values and reads the blocked/s counter's simMs from `scrubBatch ?? latestBatch` (scrub-correct); `inspectorForms.tsx` stops falsy-zero-coalescing a legitimately-typed `0` in the port/cpuLimit/memLimitMb fields; `PacketLayer.tsx` wraps its SVG geometry calls in try/catch with a linear-interpolation fallback. `FirewallGate.tsx` needed no change (pure presentational, verified) |

**Boundary rules:** `src/app/world/region/*` imports only `lib/` (world types,
`worldEngine/types` for **type-only** imports — `MetricsBatch`/`EngineEvent`/`ReplayFrame`/
`HealthState`, never a value/executable import) and app stores (`useSimulationStore` — read
`scrubBatch`/`latestBatch`/`events`/`running`, call `setOutage`/`setScrubIndex`;
`useWorldStore` — read `doc`; `useNavStore` — navigation callbacks passed down as props), plus
the ONE local constant `CROSS_AZ_HOP_MS` in `regionData.ts` — a documented, manually-synced
mirror of `worldEngine/networkRuntime.ts`'s private `CROSS_AZ_MS`, **not** an import (see the
Frozen-contract note below and `.superpowers/sdd/contract-drift.md` §PHASE 4 item 8). Like
`server/` (§L), nothing in `region/` imports `worldEngine/index.ts` (the executable facade)
directly — only `useSimulationStore` does that; the seam established in §K holds for a second
feature module in a row. `RackNodes.tsx` owns all chassis/frame/managed-node chrome; `AzCanvas.tsx`
and `layoutRacks.ts` only compute positions and aggregate edges, never render chassis internals.
`layoutAz.ts` is gone — nothing outside git history depends on `layoutAzGrid` anymore.

**Frozen-contract note:** `regionData.ts`'s `CROSS_AZ_HOP_MS = 1.5` is a **local mirror**, not an
import, of `worldEngine/networkRuntime.ts:10`'s private (non-exported) `CROSS_AZ_MS` — the design
spec's D5 named `worldEngine/latency.ts` as the source, but that file exports no such constant
(it's a function-only module); exporting the real constant would be a code change under
`worldEngine/`, which this phase's Global Constraints forbid. If the engine ever varies cross-AZ
latency, this mirror must be updated by hand (or the engine can additively export the constant,
at which point the mirror becomes a real import — additive, no reshape). Logged in
`.superpowers/sdd/contract-drift.md` §PHASE 4 item 8 — this doc entry doesn't restate the
reasoning, just cross-references it.

**Blast radius:** `layoutRacks.ts`'s `RackLayout`/`RackFrame` types fan out to `AzCanvas.tsx` and
`RackNodes.tsx` only (two consumers) — extend additively. `regionData.ts`'s exported types
(`AzShare`/`RibbonAlert`/`ReplicationPair`/`CrossAzEntry`) fan out to `RegionView.tsx` and the
four `region/` components — same extend-don't-reshape rule as `boardLayout.ts` (§L).
`world.store.ts`'s `addManagedService` now has two call sites (`PlacementPanel.tsx`, plus
whatever test fixtures call it directly) — the new param is optional/defaulted, so no existing
caller needed to change.
```

- [ ] **Step 5: Append the `## PHASE 4` ledger to `.superpowers/sdd/progress.md`**

Follow the exact structure of the `## PHASE 2`/`## PHASE 3` sections already in this file: a
`## PHASE 4 — Region flow page + rack chassis` heading, `Plan:`/`Branch:` lines, then one line per
task (`Task 1: complete (commits …, review …; <notable findings>)` — using the REAL commit hashes
and REAL findings from T1–T7's actual execution, not placeholders), then a `PHASE 4 COMPLETE`
block modeled on Phase 3's (final-review verdict, DONE BAR checklist, task commit chain, open
items for Phase 5). Two things must appear, precisely, regardless of what else T1–T6 turned up:

1. **Drift state** — cite `contract-drift.md`'s already-logged `## PHASE 4` / item 8 (the
   `CROSS_AZ_HOP_MS` local-mirror resolution, R1/Task 1) as the phase's only drift entry, and
   state explicitly that it is a **RESOLVED, view-side deviation from the plan text — not an
   engine or frozen-contract change** (no code under `src/lib/worldEngine/` was touched). This
   matches the skeleton's own expectation ("no drift entries" beyond this one).
2. **Phase-3 backlog disposition** — transcribe Step 1's table (which backlog items got resolved
   by which task, which remain open for Phase 5) so a future reader doesn't have to re-derive it
   from T7's commit alone.

Also carry forward, unresolved, into the "OPEN ITEMS for Phase 5" line: the mockup's
`recovery in 41s` timer and numeric replication lag (D4/D5, parked — no engine surface exists),
r3f globe (Phase 5 proper), analysis/LLM reviewer (Phase 6), overflow-resident color attribution,
and the Phase-2 engine-side deferrals that remain untouched (hop-latency-in-p50/p99, NIC
shed/queue, per-step grouping-map caching) — none of these are Phase-4 regressions, all were
already-known deferrals this phase didn't claim to fix.

- [ ] **Step 6: Commit**

```bash
# NOTE: .superpowers/ is gitignored (scratch) — do NOT `git add` progress.md (it would error on an
# ignored path, and Phases 1–3 never committed the ledger either). The §M doc is the only tracked
# change here; the progress.md ledger append (Step 5) lives on disk as scratch, uncommitted.
git add docs/module-boundaries.md
git commit -m "docs: update module boundaries for region flow page and rack chassis (§M)"
```

<!-- COMPLETE -->
