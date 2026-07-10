# Polish 1: Hybrid Panel System + Examples Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every authoring surface the user-approved HYBRID panel identity — Direction A's Instrument Rail skin (luminous section rules, edge-lit rows, chip values, live micro-bars) carrying Direction B's Console Card widgets (sliders with derived-consequence hints, host preset cards, segmented pickers, explainer microcopy) — ship the four-example vault on the home screen, and fix the carried stale-replay-after-doc-swap bug. Binding visual truth: `docs/superpowers/specs/mockups/panels-hybrid-v1.html`.

**Architecture:** One new shared kit (`src/app/world/ui/kit.tsx` + pure `derived.ts` hint math) applied surface-by-surface to the existing panels with ZERO store-semantics changes (same actions, same patch shapes — the restyle contract); one new pure data module (`src/lib/vault/exampleWorlds.ts`, four `WorldDoc` builders with test-enforced findings contracts) consumed by new home-screen vault cards; one additive `simulation.store.resetSession()` action called by the doc-swap paths plus a `latestBatch` render gate in `ScrubberV2`. Nothing under `src/lib/worldEngine/` changes.

**Tech Stack:** TypeScript + React 19 + Zustand + Tauri 2. No new dependencies anywhere.

## Global Constraints (every task inherits these)

- Branch: `polish-panels-vault`, cut from `main` (≥ `bf0b78e`).
- ZERO changes under `src/lib/worldEngine/` and zero contract/data-model changes (D7).
  Forced drift → `.superpowers/sdd/contract-drift.md` `## POLISH 1`, never silently.
- **Restyles must not change store semantics.** Every panel keeps dispatching the same
  actions with the same patch shapes — the panels' EXISTING test files are extended,
  never weakened; a restyle task that has to touch an assertion about a dispatched patch
  is doing something wrong.
- strict tsc; `npm run build` green per commit; full `border` shorthand rule; jsdom
  pragma + jest-dom for component tests; pure tests node env.
- Kit is token-only (`var(--color-*)`); the HUD glow hexes (`#7CFFE9`, `#2DD4BF44`
  shadows) live as named constants in `src/app/world/ui/kit.ts` ONLY — no other file
  hardcodes them. Panel base font 11px, `tabular-nums` for digit columns (D1).
- Metrics-driven UI reads `scrubBatch ?? latestBatch`; every restyled surface keeps a
  meaningful at-rest state with no batch.
- All animation/hover transitions respect `prefers-reduced-motion` (kit centralizes
  this: one shared transition constant that collapses to none under the media query).
- Live smokes controller-run on strict port 1420, ZERO app console errors, screenshots
  (dark AND light for every restyled panel — the theme toggle is live now), stop the
  server after.
- Ledger: `.superpowers/sdd/progress.md` under `## POLISH 1`. Boundaries doc gains §P (T8).

## File Structure

```
src/app/world/ui/                     # NEW — the hybrid kit (T1)
  kit.tsx (+ kit.test.tsx)            # SectionHeader, EdgeRow, ChipValue, SpecBar,
                                      #   MicroBars, DerivedField, Segmented,
                                      #   PresetCardGrid, Explainer  (one file: they are
                                      #   small and always used together)
  derived.ts (+ derived.test.ts)      # pure hint math (T1)
src/app/world/panels/TopologyPanel.tsx      # T2 restyle (+ extend existing test)
src/app/world/panels/BlueprintPanel.tsx     # T3 restyle (+ extend existing test)
src/app/world/panels/PlacementPanel.tsx     # T3 restyle
src/app/world/panels/TrafficPanel.tsx       # T4 restyle (+ extend existing test)
src/app/world/panels/WorldPanel.tsx         # T4: tab bar treatment
src/app/world/SettingsModal.tsx             # T4: kit alignment
src/app/world/panels/AnalysisTab.tsx        # T4: kit alignment (headers/chips only)
src/app/world/server/inspectorForms.tsx     # T4: firewall stack restyle (mockup A block)
src/app/world/server/InspectorRail.tsx      # T4: header/spacing alignment
src/lib/vault/exampleWorlds.ts (+ .test.ts) # T5: the four VaultEntry builders
src/app/home/HomeScreen.tsx (+ .module.css) # T6: vault section
src/app/home/VaultCard.tsx (+ test)         # T6
src/app/store/simulation.store.ts           # T7: resetSession action (additive)
src/app/store/world.store.ts (+ test)       # T7: newWorld/replaceWorld call resetSession
src/app/world/ScrubberV2.tsx                # T7: latestBatch gate
docs/module-boundaries.md                   # T8: §P
```

Dependency order: T1 → T2 → T3 → T4; T5 → T6; T7 independent; T8 last. Serial T1…T8.

# Polish 1 plan fragment — Tasks 1–4 (hybrid kit + derived hints · Topology restyle ·
# Blueprint/Placement restyle · Traffic/chrome/settings/firewall restyle)

> Fragment scope: Task 1 (`src/app/world/ui/` kit + derived math), Task 2 (TopologyPanel),
> Task 3 (BlueprintPanel + PlacementPanel), Task 4 (TrafficPanel, WorldPanel chrome,
> SettingsModal/AnalysisTab/InspectorRail alignment, firewall stack). Global Constraints /
> File Structure live in the assembled plan header (from
> `docs/superpowers/plans/polish1/skeleton.md`) — not repeated here.
>
> **Grounding status: everything below is grounded against REAL, currently-committed source**
> on branch `polish-panels-vault` (cut from `main` @ `c2ffdc5`), verified 2026-07-10 by the
> controller session: every panel file, its existing test file, `panelStyles.ts`,
> `instanceCatalog.ts`, `factories.ts`, `theme.ts`, `App.tsx`'s `useThemeBootstrap`,
> `simulation.store.ts`, and the mockup's CSS blocks were read in full; the derived-math
> numbers were verified with a scratch `vite-node` run (125 rps/core @ 8 ms; 500 host rps @
> 4 vCPU × 8 ms; 1220 MB @ 220 + 0.5×2000).
>
> **Grounded corrections to the skeleton (controller decisions, apply as written):**
> 1. The "add-server preset select" the skeleton's Task 3 assigns to PlacementPanel actually
>    lives in **TopologyPanel.tsx** (the per-AZ `INSTANCE_CATALOG` select + `+ Server`
>    button). The PresetCardGrid conversion and its named test (`preset card select feeds
>    addServer with the chosen preset`) therefore belong to **Task 2**, which owns that file.
>    PlacementPanel's Task-3 scope is unchanged otherwise (kit clothing + `Segmented` role).
> 2. Widget-swap test mechanics: where the spec itself converts a control's *type* (policy
>    `<select>` → `Segmented` buttons; `Analysis (N)` tab label → label + `ChipValue`), the
>    existing test's **interaction** lines are mechanically updated to drive the new widget,
>    but every **store assertion** (the dispatched action and its exact patch) is kept
>    byte-identical. That is the restyle contract; anything beyond it is out of bounds.
> 3. `App.tsx`'s `useThemeBootstrap` stamps `document.documentElement.dataset.theme` with
>    `'dark' | 'light'` (verified, App.tsx:41). The kit themes its two sanctioned glow hexes
>    via `:root[data-theme="light"]` CSS variable overrides — no JS theme branching.

---

## Task 1: The kit + derived-hint math `[sonnet]`

**Files:** create `src/app/world/ui/kit.tsx`, `src/app/world/ui/kit.test.tsx`,
`src/app/world/ui/derived.ts`, `src/app/world/ui/derived.test.ts`; modify
`src/lib/analysis/rules/capacity.ts` (extract one pure helper — see step 3).

### Grounding

- `panelStyles.ts` (read in full) is the current shared panel style module; the kit does NOT
  replace it this task — panels migrate in T2–T4. Base panel font is `11px var(--font-mono)`.
- Theme tokens are written as `--color-<kebab>` custom properties by `useThemeBootstrap`
  (`App.tsx:22-41`), which also sets `data-theme` on `<html>`. Available tokens (from
  `theme.ts`'s `ColorTokens`): `--color-canvas`, `--color-canvas-dots`, `--color-node-base`,
  `--color-node-border`, `--color-surface`, `--color-surface-hover`, `--color-toolbar`,
  `--color-toolbar-border`, `--color-text-primary`, `--color-text-secondary`,
  `--color-text-muted`, `--color-danger`, `--color-success`, `--color-success-text`,
  `--color-warning`, `--color-accent`, `--color-on-accent`.
- The ram-oversubscribed rule (`src/lib/analysis/rules/capacity.ts:7-34`) sums, per server,
  `memLimitMb ?? workload.ramBaseMb` over that server's compiled instances. There is no
  exported helper today — step 3 extracts one so `derived.ts` shares the exact quantity
  instead of duplicating it (skeleton instruction).
- The commit-discipline convention to copy is `TrafficPanel.tsx`'s `NumberField`
  (TrafficPanel.tsx:28-44): local text buffer, commit on blur/Enter, `Number.isFinite`
  check, clamp to [min,max], revert buffer to last valid on NaN, snap buffer to the clamped
  value on commit.
- Mockup CSS values (transcribed from `panels-hybrid-v1.html`, not eyeballed):
  - `.a-sect .lbl`: 9.5px, letter-spacing 0.15em, color `#7CFFE9`, text-shadow
    `0 0 8px #2DD4BF44`; `.a-sect .rule`: 1px, `linear-gradient(90deg, #2DD4BF44, transparent)`;
    section margin `14px 0 8px`.
  - `.a-row`: flex, gap 8, padding `6px 8px`, radius 5, border `1px solid transparent`,
    margin-bottom 3; hover bg `#13161E` (≈ `--color-surface-hover`) border `#2A2E38`
    (≈ `--color-node-border`). `.a-server`: border-left `2px solid` accent, bg `#10141C`
    (≈ `--color-node-base`).
  - `.a-mini`: flex, gap 2, align-items flex-end, height 14; bars width 3, radius 1.
  - `.chipval`: border 1px `--border`, radius 3, padding `0 7px`, 11px, bg `#0C0E13`
    (≈ `--color-canvas`).
  - `.b-specbar`: grid `42px 1fr 58px`, gap 8, 10px, muted, `tabular-nums`, margin-bottom 4;
    track height 5, bg `#0C0E13`, radius 3.
  - `.b-field label`: 10.5px secondary, margin-bottom 5. `.b-derive`: teal, 10.5px,
    margin-top 4, `tabular-nums`. `.b-slider`: gap 10; range `accent-color` blue; value
    readout width 64, right-aligned, 11.5px, `tabular-nums`.
  - `.b-seg`: inline-flex, border 1px, radius 6, overflow hidden; buttons padding `5px 12px`,
    11px; `.on` bg `#4A9EFF22` color blue; dividers via border-right.
  - `.b-pcard`: border 1px, radius 8, padding 10, bg `#11141B` (≈ `--color-node-base`);
    `.sel` border blue bg `#4A9EFF0D`; `.pn` 11.5px 600; `.pd` 9.5px muted margin
    `2px 0 6px`; `.pp` amber 10.5px. Grid: 2 columns, gap 8.
  - `.b-explain`: 10.5px muted, line-height 1.5, margin-top 4.
  - Reduced motion: `@media (prefers-reduced-motion: reduce)` kills the shared
    `transition: all 0.15s ease` and any hover transform.

### Step 1.1 — failing tests first: `derived.test.ts`

`// @vitest-environment node` is unnecessary (node is the default env; only component tests
carry the jsdom pragma). Write `src/app/world/ui/derived.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  rpsPerCore, hostRpsCapacity, ramAtConnections, residentRamDemandMb, ttlLagHint, diskIoWord,
} from './derived'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
} from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'
import { compileWorld } from '../../../lib/world/compileWorld'

describe('rpsPerCore', () => {
  it('computes 1000/ms', () => {
    expect(rpsPerCore(8)).toBe(125)
    expect(rpsPerCore(1)).toBe(1000)
  })
  it('is 0-safe and NaN-safe', () => {
    expect(rpsPerCore(0)).toBe(0)
    expect(rpsPerCore(-3)).toBe(0)
    expect(rpsPerCore(Number.NaN)).toBe(0)
  })
})

describe('hostRpsCapacity', () => {
  it('scales rpsPerCore by vcpu', () => {
    expect(hostRpsCapacity(4, 8)).toBe(500)
    expect(hostRpsCapacity(16, 5)).toBe(3200)
  })
  it('guards zero/NaN inputs', () => {
    expect(hostRpsCapacity(0, 8)).toBe(0)
    expect(hostRpsCapacity(4, 0)).toBe(0)
    expect(hostRpsCapacity(Number.NaN, 8)).toBe(0)
  })
})

describe('ramAtConnections', () => {
  it('defaults to 2000 connections', () => {
    expect(ramAtConnections(220, 0.5)).toBe(1220)
  })
  it('honors an explicit connection count', () => {
    expect(ramAtConnections(128, 0.5, 100)).toBe(178)
  })
})

describe('residentRamDemandMb', () => {
  it('sums memLimitMb ?? ramBaseMb per resident instance — same quantity as the ram-oversubscribed rule', () => {
    const doc = createWorld()
    const r = createRegion('us-east-1'); doc.regions[r.id] = r
    const az = createAz(r.id, 'us-east-1a'); doc.azs[az.id] = az
    const s = createServer(az.id, getPreset('vps-small')!); doc.servers[s.id] = s
    const bp = createBlueprint('api', 0); bp.workload.ramBaseMb = 300; doc.blueprints[bp.id] = bp
    const plA = createPlacement(bp.id, s.id); plA.count = 2; doc.placements[plA.id] = plA   // 2 × 300
    const plB = createPlacement(bp.id, s.id); doc.placements[plB.id] = plB
    plB.runtime = { type: 'container', stackName: 'app', networkNames: [], portMappings: [], cpuLimit: null, memLimitMb: 512 }
    const compiled = compileWorld(doc)
    expect(residentRamDemandMb(s.id, doc, compiled)).toBe(300 + 300 + 512)
  })
  it('returns 0 for a server with no instances', () => {
    const doc = createWorld()
    expect(residentRamDemandMb('missing', doc, compileWorld(doc))).toBe(0)
  })
})

describe('ttlLagHint', () => {
  const routing = (dnsTtlSec: number, healthCheckIntervalMs: number, healthCheckFailureThreshold: number) => ({
    policy: 'latency' as const, weights: {}, priorityOrder: [],
    dnsTtlSec, healthCheckIntervalMs, healthCheckFailureThreshold,
  })
  it('is null when TTL covers the detection window (factory defaults: 30s vs 10s×3)', () => {
    expect(ttlLagHint(routing(30, 10_000, 3))).toBeNull()
  })
  it('phrases the lag with both numbers when TTL is shorter than detection', () => {
    expect(ttlLagHint(routing(5, 12_000, 3))).toBe(
      '⚠ ttl 5s < detection 36s — clients re-resolve before the failure is even detected',
    )
  })
})

describe('diskIoWord', () => {
  it('buckets <0.5 / <2 / ≥2', () => {
    expect(diskIoWord(0.2)).toBe('light')
    expect(diskIoWord(0.5)).toBe('moderate')
    expect(diskIoWord(1.9)).toBe('moderate')
    expect(diskIoWord(2)).toBe('heavy')
  })
})
```

Run: `npx vitest run src/app/world/ui/derived.test.ts` → FAILS (module missing). That is the
expected red.

### Step 1.2 — `derived.ts`

```ts
// src/app/world/ui/derived.ts
// Pure derived-consequence math for the hybrid panel kit (Polish 1 D2). Panels never inline
// this arithmetic — they call these. No store imports, no React.
import type { WorldDoc, CompiledWorld, RoutingConfig } from '../../../lib/world/types'
import { reservedRamMb } from '../../../lib/analysis/rules/capacity'

export function rpsPerCore(cpuMsPerRequest: number): number {
  if (!Number.isFinite(cpuMsPerRequest) || cpuMsPerRequest <= 0) return 0
  return 1000 / cpuMsPerRequest
}

export function hostRpsCapacity(vcpu: number, cpuMsPerRequest: number): number {
  if (!Number.isFinite(vcpu) || vcpu <= 0) return 0
  return vcpu * rpsPerCore(cpuMsPerRequest)
}

export function ramAtConnections(baseMb: number, perConnMb: number, conns = 2000): number {
  return baseMb + perConnMb * conns
}

// Σ resident (memLimitMb ?? workload.ramBaseMb) — the SAME quantity the ram-oversubscribed
// analysis rule sums; shared via reservedRamMb rather than duplicated (skeleton T1).
export function residentRamDemandMb(serverId: string, doc: WorldDoc, compiled: CompiledWorld): number {
  return reservedRamMb(serverId, doc, compiled)
}

// Mirrors ttl-outlives-detection's inequality (capacity.ts:93-108), phrased as a hint before
// it becomes a finding: null when TTL ≥ detection window.
export function ttlLagHint(routing: RoutingConfig): string | null {
  const ttlMs = routing.dnsTtlSec * 1000
  const detectMs = routing.healthCheckIntervalMs * routing.healthCheckFailureThreshold
  if (ttlMs >= detectMs) return null
  return `⚠ ttl ${routing.dnsTtlSec}s < detection ${detectMs / 1000}s — clients re-resolve before the failure is even detected`
}

export function diskIoWord(diskIoPerRequest: number): 'light' | 'moderate' | 'heavy' {
  if (diskIoPerRequest < 0.5) return 'light'
  if (diskIoPerRequest < 2) return 'moderate'
  return 'heavy'
}
```

### Step 1.3 — extract `reservedRamMb` in `capacity.ts` (pure refactor, tests stay green)

In `src/lib/analysis/rules/capacity.ts`, add the export and rewire the rule to call it. The
rule's per-server grouping loop is replaced by a per-server scan; findings output is
byte-identical (same ids, same `sum`, same affected list):

```ts
// Reserved RAM on a server: Σ (container memLimitMb ?? blueprint ramBaseMb) over resident
// instances. Shared with the panel kit's derived hints (src/app/world/ui/derived.ts).
export function reservedRamMb(serverId: string, doc: WorldDoc, compiled: CompiledWorld): number {
  let sum = 0
  for (const inst of Object.values(compiled.instances)) {
    if (inst.serverId !== serverId) continue
    const pl = doc.placements[inst.placementId]
    const memLimit = pl?.runtime.type === 'container' ? pl.runtime.memLimitMb : null
    sum += memLimit ?? doc.blueprints[inst.blueprintId]?.workload.ramBaseMb ?? 0
  }
  return sum
}
```

The `ramOversubscribed` rule keeps its instance grouping (it needs `insts` for `affected`)
but computes `sum` via `reservedRamMb(serverId, doc, compiled)` — delete its inline loop.
`WorldDoc`/`CompiledWorld` types are already reachable from `../../world/types`. Run
`npx vitest run src/lib/analysis/rules/capacity.test.ts` → all existing cases green.

### Step 1.4 — failing tests: `kit.test.tsx`

```tsx
// src/app/world/ui/kit.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import {
  SectionHeader, EdgeRow, ChipValue, SpecBar, MicroBars, DerivedField, Segmented,
  PresetCardGrid, Explainer,
} from './kit'

describe('SectionHeader', () => {
  it('renders the label and trailing content', () => {
    render(<SectionHeader label="▸ US-EAST-1 · N. VIRGINIA" trailing={<span>● healthy</span>} />)
    expect(screen.getByText('▸ US-EAST-1 · N. VIRGINIA')).toBeInTheDocument()
    expect(screen.getByText('● healthy')).toBeInTheDocument()
  })
})

describe('EdgeRow', () => {
  it('status maps to dot color', () => {
    const { rerender } = render(<EdgeRow status="healthy">x</EdgeRow>)
    expect(screen.getByTestId('kit-dot').style.background).toContain('--color-success')
    rerender(<EdgeRow status="degraded">x</EdgeRow>)
    expect(screen.getByTestId('kit-dot').style.background).toContain('--color-warning')
    rerender(<EdgeRow status="down">x</EdgeRow>)
    expect(screen.getByTestId('kit-dot').style.background).toContain('--color-danger')
    rerender(<EdgeRow status={null}>x</EdgeRow>)
    expect(screen.getByTestId('kit-dot').style.background).toContain('--color-text-muted')
  })
  it('omits the dot when status is undefined and fires onClick', () => {
    const onClick = vi.fn()
    render(<EdgeRow onClick={onClick}>row content</EdgeRow>)
    expect(screen.queryByTestId('kit-dot')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('row content'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe('ChipValue', () => {
  it('renders children in a chip', () => {
    render(<ChipValue title="count">×4</ChipValue>)
    expect(screen.getByTitle('count')).toHaveTextContent('×4')
  })
})

describe('SpecBar', () => {
  it('clamps fraction to [0,1]', () => {
    const { rerender } = render(<SpecBar label="cpu" fraction={1.8} color="var(--color-accent)" value="9/4 c" />)
    expect(screen.getByTestId('kit-specbar-fill').style.width).toBe('100%')
    rerender(<SpecBar label="cpu" fraction={-0.5} color="var(--color-accent)" value="0/4 c" />)
    expect(screen.getByTestId('kit-specbar-fill').style.width).toBe('0%')
  })
})

describe('MicroBars', () => {
  it('renders three bars with clamped heights', () => {
    render(<MicroBars cpu={0.62} ram={2} io={-1} />)
    const bars = screen.getAllByTestId('kit-microbar')
    expect(bars).toHaveLength(3)
    expect(bars[0].style.height).toBe('62%')
    expect(bars[1].style.height).toBe('100%')
    expect(bars[2].style.height).toBe('0%')
  })
})

describe('DerivedField', () => {
  it('commits clamped value on blur and Enter', () => {
    const onCommit = vi.fn()
    render(<DerivedField label="dnsTtlSec" value={30} min={1} onCommit={onCommit} />)
    const input = screen.getByLabelText('dnsTtlSec')
    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledWith(1)
    fireEvent.change(input, { target: { value: '45' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).toHaveBeenLastCalledWith(45)
  })
  it('rejects NaN keeping last valid', () => {
    const onCommit = vi.fn()
    render(<DerivedField label="ramBaseMb" value={220} onCommit={onCommit} />)
    const input = screen.getByLabelText('ramBaseMb')
    fireEvent.change(input, { target: { value: 'abc' } })
    fireEvent.blur(input)
    expect(onCommit).not.toHaveBeenCalled()
    expect(input).toHaveValue('220')
  })
  it('slider updates the derive line live and commits on release', () => {
    const onCommit = vi.fn()
    render(
      <DerivedField label="cpu ms" value={8} min={1} max={60} mode="slider" unit="ms"
        derive={v => `→ one core sustains ~${Math.round(1000 / v)} rps`} onCommit={onCommit} />,
    )
    const slider = screen.getByLabelText('cpu ms')
    expect(screen.getByText('→ one core sustains ~125 rps')).toBeInTheDocument()
    fireEvent.change(slider, { target: { value: '20' } })
    expect(screen.getByText('→ one core sustains ~50 rps')).toBeInTheDocument()
    expect(onCommit).not.toHaveBeenCalled()          // live derive, no commit mid-drag
    fireEvent.mouseUp(slider)
    expect(onCommit).toHaveBeenCalledWith(20)
  })
  it('disabled renders inert', () => {
    const onCommit = vi.fn()
    render(<DerivedField label="x" value={5} disabled onCommit={onCommit} />)
    expect(screen.getByLabelText('x')).toBeDisabled()
  })
})

describe('Segmented', () => {
  it('fires onChange and marks selection', () => {
    const onChange = vi.fn()
    render(
      <Segmented ariaLabel="routing policy" value="latency" onChange={onChange}
        options={[{ value: 'latency', label: '⚡ latency' }, { value: 'geo', label: '🌍 geo' }]} />,
    )
    expect(screen.getByText('⚡ latency')).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByText('🌍 geo'))
    expect(onChange).toHaveBeenCalledWith('geo')
  })
})

describe('PresetCardGrid', () => {
  it('select dispatches value', () => {
    const onChange = vi.fn()
    render(
      <PresetCardGrid value="vps-medium" onChange={onChange}
        options={[
          { value: 'vps-medium', name: 'vps-medium', detail: '4 vCPU · 8 GB · shared tenancy', price: '$0.036/hr' },
          { value: 'dedicated-8', name: 'dedicated-8', detail: '8 cores · 32 GB · yours alone', price: '$0.34/hr' },
        ]} />,
    )
    expect(screen.getByText('vps-medium').closest('button')).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByText('dedicated-8'))
    expect(onChange).toHaveBeenCalledWith('dedicated-8')
  })
})

describe('Explainer', () => {
  it('renders muted microcopy', () => {
    render(<Explainer>each population is served by its fastest healthy region</Explainer>)
    expect(screen.getByText(/fastest healthy region/)).toBeInTheDocument()
  })
})
```

Run: `npx vitest run src/app/world/ui/kit.test.tsx` → FAILS (module missing).

### Step 1.5 — `kit.tsx`

One file; the components are small and always used together. Implementation notes that are
binding:

- **Sanctioned hexes** (ONLY here, no other file): `KIT_GLOW_TEXT = '#7CFFE9'`,
  `KIT_GLOW_DIM = '#2DD4BF44'`, `KIT_TEAL = '#2DD4BF'`, plus their light-theme counterparts
  `#0F766E` / `#0F766E33` / `#288177` (network-teal AA foregrounds from `theme.ts`'s
  `CATEGORY_COLORS.network.foreground.light` family). They are exposed to CSS as
  `--kit-accent`, `--kit-accent-dim`, `--kit-teal` via an injected stylesheet (next bullet)
  so every consumer stays theme-correct for free.
- **One injected stylesheet**, id `scalemap-kit-styles`, appended to `document.head` on first
  import (guard on `document.getElementById`). It carries: the CSS variables above with
  `:root[data-theme="light"]` overrides; `.kit-row:hover { background:
  var(--color-surface-hover); border-color: var(--color-node-border) }`;
  `.kit-pcard:hover { border-color: var(--color-accent) }`; the shared
  `.kit-t { transition: all 0.15s ease }` class; and
  `@media (prefers-reduced-motion: reduce) { .kit-t { transition: none } }` — this is the
  centralized reduced-motion collapse the Global Constraints require. Everything else is
  inline styles with `var(--color-*)` tokens.
- **Exact props** are the skeleton's contract (already quoted in the assembled header) plus
  ONE additive optional prop: `DerivedField.deriveTone?: 'accent' | 'warning'` (default
  `'accent'`) — T4's TTL hint renders amber per the spec's D3; adding a tone prop here is
  additive extension, not redesign. Derive line color: `var(--kit-teal)` for accent,
  `var(--color-warning)` for warning.
- `SectionHeader`: flex row (gap 8, margin `14px 0 8px`); label span 9.5px, letter-spacing
  0.15em, `white-space: nowrap`, color `accent ?? var(--kit-accent)`, text-shadow
  `0 0 8px ${accent ? accent + '44' : 'var(--kit-accent-dim)'}` — when `accent` is given it
  is an 6-digit hex per the prop contract, so `+ '44'` yields the dim variant; rule div
  height 1 / flex 1 / `linear-gradient(90deg, <dim>, transparent)`; then `trailing`.
- `EdgeRow`: div, className `kit-row kit-t`, flex/gap 8/padding `6px 8px`/radius 5/
  margin-bottom 3/border `1px solid transparent`; when `edgeColor` present: border-left
  `2px solid ${edgeColor}` + background `var(--color-node-base)`; `cursor: pointer` +
  `onClick` when given. Status dot: `data-testid="kit-dot"`, 7×7 round span, background
  `var(--color-success|warning|danger)` for healthy/degraded/down with box-shadow
  `0 0 5px` same color; `null` → `var(--color-text-muted)`, no glow; `undefined` → no dot.
  `children` in a `flex: 1; min-width: 0` wrapper, then `trailing`.
- `ChipValue`: span, border `1px solid var(--color-node-border)`, radius 3, padding `0 7px`,
  11px, background `var(--color-canvas)`, color `var(--color-text-primary)`,
  `fontVariantNumeric: 'tabular-nums'`, `title` passthrough.
- `SpecBar`: grid `42px 1fr 58px`, gap 8, 10px muted, tabular-nums, margin-bottom 4; track
  div (height 5, bg `var(--color-canvas)`, radius 3, overflow hidden) wrapping fill div
  `data-testid="kit-specbar-fill"` width `${clamp01(fraction) * 100}%`, background `color`.
- `MicroBars`: flex gap 2 align-end height 14; three spans `data-testid="kit-microbar"`,
  width 3, radius 1, heights `${Math.round(clamp01(v) * 100)}%` (ROUNDED — `0.62 * 100` is
  `62.00000000000001` in JS float math and the tests assert `'62%'`), backgrounds
  `var(--color-accent)` / `var(--color-warning)` / `var(--kit-teal)` (cpu/ram/io — mockup
  `.a-mini` order).
- `DerivedField`: label block (10.5px secondary, margin-bottom 5, rendered as `<label>` text
  only — the control carries `aria-label={label}`).
  - *input mode* (default): text input styled like `panelStyles.field` with tokens; local
    text buffer seeded from `value`, resynced by `useEffect` on `value` change; commit on
    blur/Enter: `Number.isFinite` else revert; clamp to `[min ?? -Infinity, max ?? Infinity]`;
    snap buffer to clamped value (the TrafficPanel `NumberField` convention, generalized).
    Two deliberate refinements over that convention: (1) the Enter handler runs the commit
    routine DIRECTLY instead of delegating to `.blur()` — jsdom's `element.blur()` is a
    no-op when the element never had real focus, so blur-delegation makes Enter untestable;
    (2) the commit routine skips `onCommit` (but still snaps the buffer) when the clamped
    number equals the current `value` prop — otherwise Enter-then-blur would dispatch twice
    and push two undo-history entries for one edit.
  - *slider mode*: `<input type="range">` (flex 1, `accentColor: 'var(--color-accent)'`)
    + readout span (width 64, right, 11.5px, tabular-nums) showing `${local}${unit ? ' ' + unit : ''}`;
    local numeric state synced from `value` via effect; `onChange` updates local only (live
    derive); commit clamped value on `mouseUp`/`touchEnd`/`keyUp`/`blur` of the range —
    dragging must not spam the undo history with per-pixel `updateBlueprint` calls.
  - derive line: when `derive` given and returns a non-empty string, div 10.5px margin-top 4
    tabular-nums, color per `deriveTone`, computed from the LIVE local value.
  - `disabled` disables the control.
- `Segmented`: `role="group"` + `aria-label={ariaLabel}`; inline-flex, border 1px
  node-border, radius 6, overflow hidden; `type="button"` buttons, padding `5px 12px`, 11px,
  secondary text, `aria-pressed`, `background: transparent`, `border: none` except
  border-right `1px solid var(--color-node-border)` on all but the last; selected:
  background `color-mix(in srgb, var(--color-accent) 13%, transparent)` + color
  `var(--color-accent)`.
- `PresetCardGrid`: grid 2 columns gap 8; `type="button"` cards className `kit-pcard kit-t`,
  text-left, border 1px node-border, radius 8, padding 10, background
  `var(--color-node-base)`, `aria-pressed={selected}`; selected: border
  `1px solid var(--color-accent)` + background
  `color-mix(in srgb, var(--color-accent) 5%, transparent)`; name 11.5px 600 primary,
  detail 9.5px muted margin `2px 0 6px`, price 10.5px `var(--color-warning)`.
- `Explainer`: div 10.5px muted, line-height 1.5, margin-top 4.
- Full `border` shorthand everywhere (Global Constraint — never bare `borderColor` on an
  element that didn't set a border).

### Step 1.6 — verify

```
npx vitest run src/app/world/ui/ src/lib/analysis/rules/capacity.test.ts
```
Expected: all new cases + all existing capacity cases pass.
```
npm run build
```
Expected: tsc + vite green (kit exports unused yet — that is fine, `noUnusedLocals` applies
to locals, not exports).

**Commit:** `feat(ui): hybrid panel kit — instrument skin, console widgets, derived hints`

---

## Task 2: TopologyPanel restyle `[sonnet]`

**Files:** modify `src/app/world/panels/TopologyPanel.tsx`; EXTEND
`src/app/world/panels/TopologyPanel.test.tsx` (existing assertions untouched).

### Grounding — dispatch inventory that MUST survive byte-for-byte in behavior

From the current file (read in full before editing):

| Trigger | Dispatch |
|---|---|
| `+ Region` button | `store.addRegion(newRegion)` |
| region role select | direct `useWorldStore.setState` role patch + `useFileStore.getState().setDirty(true)` (deliberate history bypass — keep the comment and the mechanism) |
| region `×` | `store.removeRegion(region.id)` |
| `+ AZ` | `store.addAz(region.id, nextAzLabel(...))` |
| AZ `×` | `store.removeAz(az.id)` |
| `+ Server` | `store.addServer(az.id, getPreset(presetByAz[az.id] ?? 'vps-medium')!)` |
| server label input (`aria-label="server-label"`) | `store.updateServer(id, { label })` |
| firewall row edits (`fw-port-${i}` etc.), ↑ ↓ ×, `+ Rule` | `store.updateServer(id, { firewall })` |
| stack edits (`stack-name-${i}`, `stack-nets-${i}`, `stack-vols-${i}`), `+ Stack`, × | `store.updateServer(id, { stacks })` |
| server `→` | `nav.goServer(az.regionId, az.id, server.id)` |
| server `×` | `store.removeServer(server.id)` |

Existing test hooks that must keep working: `getByLabelText('add-region-select')`,
`getByText('+ Region')`, `getByText('+ AZ')`, `getByText('+ Server')`,
`getByText(/server-1/)` (expand toggle), `getByText('+ Rule')`, `getAllByText('↑')`.

`WORLD_REGIONS` labels look like `'US East (N. Virginia)'` — the mockup section label
`▸ US-EAST-1 · N. VIRGINIA` is `catalogId.toUpperCase()` + `·` + the parenthesized metro
uppercased (fallback to the raw label when no parens).

Metrics: `const displayBatch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)`.
Region health: `displayBatch?.regions[region.id]?.health`. Server metrics
(`displayBatch?.servers[server.id]`): cpu = mean of `coreUtilization`, ram =
`ramUsedMb / ramTotalMb` (guard 0), io = `diskIoFraction`, health drives the dot and the
edge color. `$X/hr` from `server.hourlyUsd` (doc), format `$${hourlyUsd}/hr`.

### Step 2.1 — failing tests first (append to `TopologyPanel.test.tsx`)

Add a minimal batch builder at the top of the new describe block (fabricate ONLY the fields
the panel reads — `MetricsBatch` is structurally typed):

```tsx
import { useSimulationStore } from '../../store/simulation.store'
import type { MetricsBatch } from '../../../lib/worldEngine/types'

function serverBatch(serverId: string, regionId: string): MetricsBatch {
  return {
    simMs: 1000,
    instances: {},
    servers: {
      [serverId]: {
        serverId, coreUtilization: [0.62, 0.62], stealFraction: 0, burstCredits: null,
        ramByInstance: [], ramUsedMb: 4096, ramTotalMb: 8192, nicInMbps: 0, nicOutMbps: 0,
        diskIoFraction: 0.3, health: 'healthy',
      },
    },
    azs: {},
    regions: { [regionId]: { regionId, rps: 100, errorRate: 0, p50Ms: 5, healthScore: 100, health: 'healthy', inboundByPopulation: [] } },
    world: { totalRps: 100, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 },
  }
}

describe('TopologyPanel — instrument restyle', () => {
  it('server row shows micro-bars and a utilization bar from a batch', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    useSimulationStore.setState({ latestBatch: serverBatch(serverId, regionId) })
    render(<TopologyPanel />)
    expect(screen.getAllByTestId('kit-microbar').length).toBe(3)
    expect(screen.getByTestId('topo-util-fill').style.width).toBe('62%')
    useSimulationStore.setState({ latestBatch: null })
  })

  it('at rest renders without utilization or fake numbers', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(<TopologyPanel />)
    expect(screen.queryByTestId('kit-microbar')).not.toBeInTheDocument()
    expect(screen.queryByTestId('topo-util-fill')).not.toBeInTheDocument()
  })

  it('preset card select feeds addServer with the chosen preset', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    useWorldStore.getState().addAz(regionId, 'us-east-1a')
    render(<TopologyPanel />)
    fireEvent.click(screen.getByLabelText('choose server preset'))     // opens the grid
    fireEvent.click(screen.getByText('dedicated-8'))                   // select card
    fireEvent.click(screen.getByText('+ Server'))
    const server = Object.values(useWorldStore.getState().doc.servers)[0]
    expect(server.catalogId).toBe('dedicated-8')
    expect(server.kind).toBe('dedicated')
  })
})
```

(`getPreset` is already imported by the panel; add it to the test imports from
`'../../../lib/world/instanceCatalog'`.) Run the file — the three new cases fail, the four
existing cases still pass against the unmodified panel except `preset card…` (fails —
control doesn't exist yet). That is the red state.

### Step 2.2 — restyle the panel

Keep the component tree and every handler; swap presentation:

1. Header block per region → `SectionHeader` with `label={regionSectLabel(region)}`
   (`▸ US-EAST-1 · N. VIRGINIA` builder as grounded above) and `trailing` carrying, in
   order: the health dot text (`● healthy|degraded|down` at 9px in the matching status
   color, muted `● —` when no batch), the EXISTING role `<select>` (kit field styling, same
   direct-setState handler + comment), and the EXISTING `×` region button.
2. `+ Region` row: unchanged handlers; inputs restyled with the kit field look (tokens,
   11px). Keep `aria-label="add-region-select"`.
3. AZ block: label row stays (label + `×`), `+ AZ` unchanged. The per-AZ add-server row
   becomes: a `ChipValue`-styled toggle button `aria-label="choose server preset"` showing
   the currently selected preset id (default `vps-medium`), which expands/collapses a
   `PresetCardGrid` fed from `INSTANCE_CATALOG`:
   `options={INSTANCE_CATALOG.map(p => ({ value: p.id, name: p.id, detail: presetDetail(p), price: '$' + p.hourlyUsd + '/hr' }))}`
   where `presetDetail(p)` = `` `${p.specs.vcpu} vCPU · ${p.specs.ramMb / 1024} GB · ${p.kind === 'vps' ? 'shared tenancy' : 'yours alone'}` ``.
   Grid `onChange` writes `presetByAz` (existing state) — selection only, no store dispatch.
   The `+ Server` button keeps its exact handler and stays always visible (existing test
   clicks it cold and must still add a vps-medium).
4. Server rows → `EdgeRow`: `edgeColor` = `var(--color-accent)` normally, warning/danger hex
   token when the batch health is degraded/down; `status` = batch health (or `null` at
   rest); content = first line `label` + muted meta `` `${kind} · ${specs.vcpu}c/${specs.ramMb / 1024}G · ${azSuffix}` ``
   (azSuffix = last char of the AZ label), second line the 4px utilization bar ONLY when a
   batch has this server: track div + fill div `data-testid="topo-util-fill"`, width =
   `${Math.round(mean(coreUtilization) * 100)}%`, background accent (warning when > 0.75);
   trailing = `<MicroBars cpu ram io />` (batch only) + `$X/hr` muted span + the EXISTING
   `→` and `×` buttons. The row body (label area) keeps the expand toggle button with its
   `▸/▾ server-N (kind)` text so `getByText(/server-1/)` still matches.
5. Expanded editor: unchanged structure and aria-labels; restyle section captions with
   `SectionHeader` (`▸ FIREWALL — TOP-DOWN, DEFAULT DENY` with `accent="#F5A623"`? NO —
   panels must not hardcode hexes; pass `accent` only where a token-derived hex is already
   in scope. Use the default teal header here; the full amber firewall treatment is T4's,
   in the server view). Inputs/selects/buttons pick up the kit field/button styling
   (tokens, 11px, full border shorthand).
6. Local styles: reuse `panelStyles.field`/`smallBtn`/`dangerBtn`/`row` where they already
   fit — do not fork a second style module. New style needs are inline with tokens.

### Step 2.3 — verify

```
npx vitest run src/app/world/panels/TopologyPanel.test.tsx
```
Expected: 7/7 (4 existing + 3 new).
```
npx vitest run && npm run build
```
Expected: full suite green, build green.

### Step 2.4 — live smoke (controller runs it, per Global Constraints)

Dev server on port 1420 (the user's running instance is fine per runbook §2b). Playwright:
1. New world → Topology tab: add region us-east-1, 2 AZs, add a server per AZ via the
   preset grid (one vps-medium, one dedicated-8) — cards render specs + price.
2. Add blueprint/placement via panels (or open an example after T6) — Simulate → server rows
   show live utilization bars + micro-bars; Stop.
3. ⚙ Settings → light theme → screenshot; back to dark → screenshot. Zero console errors.
Screenshots → `.superpowers/sdd/screenshots/polish1-t2-topology-{dark,light}.png`.

**Commit:** `feat(panels): topology tab in the hybrid instrument style`

---

## Task 3: BlueprintPanel + PlacementPanel restyle `[sonnet]`

**Files:** modify `src/app/world/panels/BlueprintPanel.tsx`,
`src/app/world/panels/PlacementPanel.tsx`; EXTEND `BlueprintPanel.test.tsx`; ADD
`PlacementPanel.test.tsx` (none exists — verified).

### Grounding — dispatch inventory

BlueprintPanel (all through `store.addBlueprint` / `store.updateBlueprint(bp.id, patch)` /
`store.removeBlueprint`):
- name input `aria-label="bp-name"` → `upd({ name })`
- ports rows `port-${i}` + visibility select + `×` + `+ Port` → `upd({ ports })`
- workload number inputs (currently four bare `type="number"` rows, no aria-labels) →
  `upd({ workload: { ...bp.workload, [key]: Number(...) } })`
- stateful checkbox → `upd({ stateful, volumeName })`; volume name input → `upd({ volumeName })`
- deps: `▸ deps` toggle, target select, `dep-port-${i}`, protocol select, `×`,
  `+ Dependency` → `upd({ dependencies })`

Existing test hooks: `getByPlaceholderText('new blueprint name')`, `getByText('+ Blueprint')`,
`getAllByText('▸ deps')[0]`, `getByText('+ Dependency')`.

PlacementPanel (all through `store.addPlacement` / `store.updatePlacement(pl.id, patch)` /
`store.removePlacement` / `store.addManagedService` / `store.removeManagedService`):
- `+ Place` → `store.addPlacement(bp.id, servers[0].id)`
- server select → `upd({ serverId })`
- count `aria-label="pl-count"` → `upd({ count: Math.max(1, Number(...)) })`
- role select → `upd({ role })`  ← becomes `Segmented`
- runtime select → `setRuntimeType` (exact container-default object preserved:
  `{ type: 'container', stackName, networkNames, portMappings: [], cpuLimit: null, memLimitMb: null }`)
- stack select → `upd({ runtime: { ...pl.runtime, stackName, networkNames } })`
- `pl-mappings` input → `upd({ runtime: { ...pl.runtime, portMappings } })`
- managed add (`aria-label="provider"` select, scope select, `+ Add`) →
  `store.addManagedService(msType, label, scope, 5432, msProvider)`; list `×` → remove

Workload derive inputs for the cpu slider's host line: the blueprint's FIRST placement
(`Object.values(doc.placements).find(p => p.blueprintId === bp.id)`) → its server's
`specs.vcpu`. Instance count chip: `useCompiledWorld()` →
`Object.values(compiled.instances).filter(i => i.blueprintId === bp.id).length`.

### Step 3.1 — failing tests first

Append to `BlueprintPanel.test.tsx`:

```tsx
it('workload slider commits updateBlueprint with the exact patch', () => {
  const bpId = useWorldStore.getState().addBlueprint('api')
  render(<BlueprintPanel />)
  const slider = screen.getByLabelText('cpu / request')
  fireEvent.change(slider, { target: { value: '12' } })
  fireEvent.mouseUp(slider)
  const bp = useWorldStore.getState().doc.blueprints[bpId]
  expect(bp.workload).toEqual({ cpuMsPerRequest: 12, ramBaseMb: 128, ramPerConnMb: 0.5, diskIoPerRequest: 0 })
})

it('derive line reflects the committed cpu ms', () => {
  const bpId = useWorldStore.getState().addBlueprint('api')
  useWorldStore.getState().updateBlueprint(bpId, { workload: { cpuMsPerRequest: 8, ramBaseMb: 128, ramPerConnMb: 0.5, diskIoPerRequest: 0 } })
  render(<BlueprintPanel />)
  expect(screen.getByText(/one core sustains ~125 rps/)).toBeInTheDocument()
})

it('host capacity line appears only when the blueprint has a placement', () => {
  const bpId = useWorldStore.getState().addBlueprint('api')
  render(<BlueprintPanel />)
  expect(screen.queryByText(/this \d+-core host/)).not.toBeInTheDocument()
  const regionId = useWorldStore.getState().addRegion('us-east-1')
  const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
  const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
  useWorldStore.getState().addPlacement(bpId, serverId)
  expect(screen.getByText(/this 4-core host ~500 rps/)).toBeInTheDocument()
})
```

(add `getPreset` import). New `PlacementPanel.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PlacementPanel } from './PlacementPanel'
import { useWorldStore } from '../../store/world.store'
import { getPreset } from '../../../lib/world/instanceCatalog'

beforeEach(() => useWorldStore.getState().newWorld())

function seedPlacement() {
  const s = useWorldStore.getState()
  const regionId = s.addRegion('us-east-1')
  const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
  const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
  const bpId = useWorldStore.getState().addBlueprint('api')
  const plId = useWorldStore.getState().addPlacement(bpId, serverId)
  return { serverId, bpId, plId }
}

describe('PlacementPanel', () => {
  it('+ Place dispatches addPlacement to the first server', () => {
    seedPlacement()
    render(<PlacementPanel />)
    fireEvent.click(screen.getByText('+ Place'))
    expect(Object.keys(useWorldStore.getState().doc.placements)).toHaveLength(2)
  })

  it('role segmented dispatches updatePlacement with the exact patch', () => {
    const { plId } = seedPlacement()
    render(<PlacementPanel />)
    fireEvent.click(screen.getByText('replica'))
    expect(useWorldStore.getState().doc.placements[plId].role).toBe('replica')
  })

  it('count clamps to a floor of 1', () => {
    const { plId } = seedPlacement()
    render(<PlacementPanel />)
    fireEvent.change(screen.getByLabelText('pl-count'), { target: { value: '0' } })
    expect(useWorldStore.getState().doc.placements[plId].count).toBe(1)
  })

  it('managed service add + remove dispatch with provider', () => {
    seedPlacement()
    render(<PlacementPanel />)
    const scopeSelect = screen.getAllByRole('combobox').find(el => el.querySelector('option[value=""]'))!
    fireEvent.change(scopeSelect, { target: { value: scopeSelect.querySelectorAll('option')[1].getAttribute('value') } })
    fireEvent.click(screen.getByText('+ Add'))
    const ms = Object.values(useWorldStore.getState().doc.managedServices)
    expect(ms).toHaveLength(1)
    expect(ms[0].provider).toBe('aws')
  })
})
```

Run both files → the new BlueprintPanel cases fail (no `cpu / request` slider yet); the
PlacementPanel role case fails (no segmented). `+ Place`/`pl-count`/managed cases pass
against the current file — they are the existing-behavior lock, written now because the file
never had a test.

### Step 3.2 — BlueprintPanel restyle

1. Card shell → mockup `.b-card` in tokens: background `var(--color-node-base)`, border
   `1px solid var(--color-node-border)`, radius 8, padding 12, margin-top 8. Head row: the
   signature swatch (existing 10×10, keep `bp.color`), the name input (same aria-label),
   the instance-count `<ChipValue title="placed instances">×N</ChipValue>` (from
   `useCompiledWorld()`), the `×` remove.
2. Meta line under the head: muted 10px — ports + deps summary, e.g. `:443 :80 · 2 deps`.
3. Ports editor: same rows/handlers, kit field styling, `SectionHeader label="▸ PORTS"`.
4. Workload → `SectionHeader label="▸ WORKLOAD"` + four `DerivedField`s (labels are the
   aria-labels):
   - `cpu / request`: `mode="slider"`, min 1, max 60, step 1, unit `'ms'`, value
     `bp.workload.cpuMsPerRequest`, derive:
     `v => '→ one core sustains ~' + Math.round(rpsPerCore(v)) + ' rps' + (vcpu ? '; this ' + vcpu + '-core host ~' + Math.round(hostRpsCapacity(vcpu, v)) + ' rps' : '')`
     (vcpu from first placement's server, undefined when unplaced), onCommit
     `v => upd({ workload: { ...bp.workload, cpuMsPerRequest: v } })`.
   - `ram base MB`: input mode, min 0, value `ramBaseMb`, no derive, onCommit patches
     `ramBaseMb`.
   - `ram / conn MB`: input mode, min 0, step 0.1, value `ramPerConnMb`, derive:
     `v => '→ ~' + (ramAtConnections(bp.workload.ramBaseMb, v) / 1024).toFixed(1) + ' GB at 2,000 active connections'`,
     onCommit patches `ramPerConnMb`.
   - `disk io / req`: input mode, min 0, step 0.1, value `diskIoPerRequest`, derive
     `v => '→ ' + diskIoWord(v)`, onCommit patches `diskIoPerRequest`.
   Every onCommit spreads `...bp.workload` exactly as today.
5. stateful/volume + deps editor: same controls/handlers, kit clothing; the `▸ deps`
   toggle text stays verbatim.
6. Color: keep an `<input type="color">` (same dispatch) presented as the signature swatch
   (32×20, borderless) with an `aria-label="signature color"`.

### Step 3.3 — PlacementPanel restyle

1. Blueprint groups → card shell as above; `+ Place` unchanged. Placement rows →
   `EdgeRow`-family clothing (edge color = `bp.color`); server select / count / remove keep
   their handlers + aria-labels; role select → `<Segmented ariaLabel={'role-' + pl.id}`
   options primary/replica/canary, `value={pl.role}`,
   `onChange={v => upd({ role: v })}`.
2. Runtime row: keep the process/container select (same `setRuntimeType`), stack select,
   `pl-mappings` input — kit field styling only.
3. Managed services: `SectionHeader label="▸ MANAGED SERVICES"`; add-row unchanged
   (selects + `+ Add`, provider default `'aws'` preserved — the D10a comment moves with
   it); list rows → `EdgeRow` with label + `:port` meta + `×`.

### Step 3.4 — verify

```
npx vitest run src/app/world/panels/BlueprintPanel.test.tsx src/app/world/panels/PlacementPanel.test.tsx
npx vitest run && npm run build
```
Expected: 5/5 + 4/4, full suite green, build green.

### Step 3.5 — live smoke

1. Blueprint with a placement: drag the cpu slider → derive line updates live during drag,
   store patch lands on release (undo once undoes the whole drag).
2. Add server via T2's preset grid, place a blueprint, flip role via segmented.
3. Dark + light screenshots of both panels →
   `.superpowers/sdd/screenshots/polish1-t3-{blueprints,placements}-{dark,light}.png`.
   Zero console errors.

**Commit:** `feat(panels): blueprint and placement editing with derived-hint widgets`

---

## Task 4: TrafficPanel, WorldPanel chrome, Settings/Analysis/rail alignment, firewall stack `[sonnet]`

**Files:** modify `src/app/world/panels/TrafficPanel.tsx` (+ extend its test),
`src/app/world/panels/WorldPanel.tsx` (+ extend its test), `src/app/world/SettingsModal.tsx`
(+ extend its test — `SettingsModal.test.tsx` exists, read it first),
`src/app/world/panels/AnalysisTab.tsx` (extend `AnalysisTab.test.tsx` only if a header
assertion needs a mechanical update — read it first), `src/app/world/server/InspectorRail.tsx`,
`src/app/world/server/inspectorForms.tsx` (+ extend `InspectorRail.test.tsx`).

### Grounding — the fragile points, verified

- `TrafficPanel.test.tsx` drives the policy control with
  `fireEvent.change(screen.getByLabelText('routing-policy'), …)` (a `<select>`). The spec
  converts this control to `Segmented` — per grounded correction #2, update those TWO
  interaction lines (weights-editor test at :103 and :110) to
  `fireEvent.click(screen.getByText('⚖ weighted'))` / `fireEvent.click(screen.getByText('🌍 geo'))`;
  every assertion on `doc.routing` stays identical. All other traffic tests
  (`dnsTtlSec`/`healthCheckIntervalMs`/`healthCheckFailureThreshold` via change+blur,
  population labels, `+ place on globe` aria-pressed) must pass UNCHANGED — `DerivedField`
  input mode deliberately reproduces the NumberField blur/Enter/clamp contract, and the
  keep-alive of every `aria-label` is mandatory.
- `WorldPanel.test.tsx` clicks `getByText(/Analysis \(\d+\)/)`. The tab becomes
  `Analysis` + `<ChipValue>{n}</ChipValue>` — update the two clicks to
  `fireEvent.click(screen.getByText('Analysis'))`, keep the finding-text assertions
  verbatim.
- `InspectorRail.test.tsx` (read in full) requires: `getByText(/first match wins/i)` in the
  firewall selection body, `getAllByTestId('fw-rule-row')` in ARRAY ORDER with click →
  `onSelect({ kind: 'rule', ruleId })`, `getAllByLabelText('move rule down')[0]` reorder
  dispatching `updateServer(serverId, { firewall: [r2, r1] })`, `getByLabelText('add rule')`
  disabled while running, and the NumberField staleness remount via `key`. Every one of
  these hooks survives the restyle.
- `inspectorForms.tsx`'s `FirewallEditor` currently renders action/port/protocol selects +
  ↑↓✕ + `+ add rule`; the rail's firewall branch renders the read-only drill rows ABOVE it.
  The mockup's single amber stack is achieved by restyling the RAIL's firewall branch into
  the frame (flow captions + drill rows + editor + DENIED footer inside one bordered box)
  — `FirewallEditor` keeps its own rows unframed. No dispatch changes anywhere.
- Amber frame colors: `color-mix(in srgb, var(--color-warning) 27%, transparent)` border,
  `color-mix(in srgb, var(--color-warning) 4%, transparent)` background — the mockup's
  `#F5962344` / `#F596230A` mapped to the warning token (no new hexes).
- `SettingsModal.tsx` already has a hand-rolled dark/light two-button group with
  `aria-pressed` — convert to kit `Segmented` (same `setThemeMode` dispatch); read
  `SettingsModal.test.tsx` first and mechanically update only if it drives the buttons by
  role/text that changes (aria-pressed + text 'dark'/'light' are preserved by `Segmented`,
  so most likely NO test change is needed).
- `AnalysisTab.tsx`: swap `sectionLabel` headers for `SectionHeader` (`▸ STRUCTURAL`,
  `▸ NETWORK`, `▸ CAPACITY`, `▸ COMPILE`); severity chips and `AiReviewSection` untouched.
  `AnalysisTab.test.tsx` asserts on finding text/behavior — check for header-text
  assertions before assuming zero updates.

### Step 4.1 — failing tests first

Append to `TrafficPanel.test.tsx`:

```tsx
it('policy segmented dispatches updateRouting and shows the policy explainer', () => {
  render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)
  fireEvent.click(screen.getByText('🌍 geo'))
  expect(useWorldStore.getState().doc.routing.policy).toBe('geo')
  expect(screen.getByText(/nearest region by great-circle distance/)).toBeInTheDocument()
})

it('ttl hint appears when TTL outlives detection and clears otherwise', () => {
  useWorldStore.getState().updateRouting({ dnsTtlSec: 5, healthCheckIntervalMs: 12000, healthCheckFailureThreshold: 3 })
  render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)
  expect(screen.getByText(/ttl 5s < detection 36s/)).toBeInTheDocument()
  const ttl = screen.getByLabelText('dnsTtlSec')
  fireEvent.change(ttl, { target: { value: '60' } })
  fireEvent.blur(ttl)
  expect(useWorldStore.getState().doc.routing.dnsTtlSec).toBe(60)
  expect(screen.queryByText(/< detection/)).not.toBeInTheDocument()
})
```

Append to `InspectorRail.test.tsx` (in the read-panels describe):

```tsx
it('firewall stack renders order numbers and flow captions', () => {
  const { serverId } = seed((d, sid) => {
    d.servers[sid].firewall = [
      { id: 'r1', action: 'allow', port: 443, protocol: 'tcp', source: 'any' },
      { id: 'r2', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' },
    ]
  })
  render(<InspectorRail serverId={serverId} selection={{ kind: 'firewall' }} onSelect={() => {}} />)
  expect(screen.getByText(/evaluated top-down · first match wins/)).toBeInTheDocument()
  expect(screen.getByText(/everything else: DENIED/)).toBeInTheDocument()
  const rows = screen.getAllByTestId('fw-rule-row')
  expect(rows[0]).toHaveTextContent('1')
  expect(rows[0]).toHaveTextContent('ALLOW')
  expect(rows[1]).toHaveTextContent('2')
  expect(rows[1]).toHaveTextContent('DENY')
  expect(rows[1]).toHaveTextContent('from any')
})
```

Append to `WorldPanel.test.tsx`:

```tsx
it('active tab renders the count as a chip and stays clickable', () => {
  render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)
  fireEvent.click(screen.getByText('Analysis'))
  expect(screen.getByText('No findings — the compiled world is clean.')).toBeInTheDocument()
})
```

Update the two existing WorldPanel clicks and the two TrafficPanel policy-select interaction
lines as grounded above (assertions untouched). Run the three files → new cases red,
mechanically-updated cases red (widgets not built), everything else green.

### Step 4.2 — TrafficPanel

1. Populations: `SectionHeader label="▸ POPULATIONS"`; rows → `EdgeRow` with a teal
   signature dot (`<span>` 8×8 radius 2 background `var(--kit-teal)` — import nothing;
   the CSS var is provided by the kit stylesheet, which is loaded because the panel imports
   kit components), all six per-row controls unchanged (labels, NumberFields may become
   `DerivedField` input-mode ONLY if aria-labels and clamp behavior are identical — keeping
   the local `NumberField` is also acceptable; do not churn). Draft row + `+ add` +
   `+ place on globe` untouched.
2. Traffic section: `SectionHeader label="▸ TRAFFIC"`, controls unchanged.
3. Routing: `SectionHeader label="▸ ROUTING"`. Policy →
   `<Segmented ariaLabel="routing-policy"` options
   `[{ value: 'latency', label: '⚡ latency' }, { value: 'geo', label: '🌍 geo' }, { value: 'weighted', label: '⚖ weighted' }, { value: 'priority', label: 'priority' }]`,
   `onChange={v => updateRouting({ policy: v })}`. Below it one `Explainer` per active
   policy:
   - latency: `each population is served by its fastest healthy region; failover honors the DNS TTL`
   - geo: `each population is pinned to its nearest region by great-circle distance`
   - weighted: `traffic splits by the region weights below — heavier weight, more traffic`
   - priority: `all traffic goes to the highest-priority healthy region in the order below`
   Weighted/priority sub-editors stay exactly as-is below their explainer (kit field look).
4. `dnsTtlSec` → `DerivedField` input mode, min 1, `deriveTone="warning"`, derive
   `v => ttlLagHint({ ...doc.routing, dnsTtlSec: v }) ?? ''`. `healthCheckIntervalMs` /
   `healthCheckFailureThreshold` keep NumberField semantics under their existing labels
   (converting to DerivedField-without-derive is fine — identical contract).

### Step 4.3 — WorldPanel chrome

Tab buttons: `type="button"`, padding `5px 10px`, background transparent, border
`1px solid transparent`, border-bottom `2px solid transparent`, secondary text; active:
text-primary + border-bottom `2px solid var(--color-accent)`. Analysis label becomes
`Analysis` + `<ChipValue>{analysisCount}</ChipValue>` (chip renders even for 0). No logic
changes; the `fieldset disabled={running}` wrapper and every prop stays.

### Step 4.4 — SettingsModal + AnalysisTab + InspectorRail alignment

- SettingsModal: section labels → `SectionHeader` (`▸ APPEARANCE`, `▸ AI REVIEW`); theme
  buttons → `Segmented` (`ariaLabel="theme"`, options dark/light, same dispatch); field
  inputs pick the kit field look. D6 invariants untouched (password input, masked
  placeholder, no key echo).
- AnalysisTab: family headers + Compile header → `SectionHeader`; nothing else.
- InspectorRail: the `header(title)` helper renders through `SectionHeader` with the glow
  default (`label={'▸ INSPECTOR — ' + title}`) — the rail's hardcoded `#7CFFE9` moves to
  the kit's `--kit-accent` for free; body spacing aligned to 8px rhythm. All testids,
  text content (`first match wins`, `click any element`), and form mounts unchanged EXCEPT
  the firewall branch, next step.

### Step 4.5 — the firewall stack (rail branch + inspectorForms rows)

In `InspectorRail.tsx`'s `firewall`/`rule` branch, wrap everything in the amber frame.
`SectionHeader` keeps its DEFAULT teal glow (panels never pass hardcoded hexes); the amber
identity lives entirely on the frame box:

```tsx
<div style={{ border: '1px solid color-mix(in srgb, var(--color-warning) 27%, transparent)',
  borderRadius: 6, padding: 8, background: 'color-mix(in srgb, var(--color-warning) 4%, transparent)', marginTop: 6 }}>
  <div style={flowCaption}>▼ evaluated top-down · first match wins ▼</div>
  {rules.map((r, i) => (
    <div key={r.id} data-testid="fw-rule-row" onClick={() => onSelect({ kind: 'rule', ruleId: r.id })}
      style={/* row: flex, gap 8, 10.5px, padding 4px 6px, radius 4, pointer, selected bg #ffffff08→ use
        color-mix(in srgb, var(--color-text-primary) 3%, transparent) */}>
      <span style={{ color: 'var(--color-text-muted)', width: 12 }}>{i + 1}</span>
      <span style={{ color: r.action === 'allow' ? 'var(--color-success)' : 'var(--color-danger)' }}>{r.action.toUpperCase()}</span>
      <span>:{r.port} {r.protocol}</span>
      <span style={{ color: 'var(--color-text-muted)' }}>from {r.source}</span>
    </div>
  ))}
  <FirewallEditor key={serverId} serverId={serverId} />
  <div style={{ ...flowCaption, color: 'var(--color-danger)' }}>▼ everything else: DENIED ▼</div>
</div>
```
`flowCaption` = `{ textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 9, letterSpacing: '0.1em', margin: '4px 0' }`.
The `first match wins · default deny` caption line above the frame is KEPT (test hook).
`FirewallEditor` itself: same controls/labels/dispatches; row styling aligned (10.5px, gap
3 → 4, selects/inputs in kit field look). `WorkloadForm`/`RuntimeForm`/`VolumesEditor`: font
bumps from the illegible `6.5px/7px` to the kit's 10/10.5px scale, labels/dispatches
unchanged (their tests drive by aria-label, not size).

### Step 4.6 — verify

```
npx vitest run src/app/world/panels/TrafficPanel.test.tsx src/app/world/panels/WorldPanel.test.tsx src/app/world/server/InspectorRail.test.tsx src/app/world/SettingsModal.test.tsx src/app/world/panels/AnalysisTab.test.tsx
npx vitest run && npm run build
```
Expected: all green (TrafficPanel 12, InspectorRail 12, WorldPanel 3, plus untouched suites).

### Step 4.7 — live smoke

1. Traffic tab: flip all four policies — explainer swaps; weighted/priority editors appear.
2. Set TTL 5 with 12000×3 health checks → amber hint appears under the field; raise TTL →
   clears; the Analysis tab shows the matching finding while the hint is active.
3. Server view → firewall: amber stack with flow captions; reorder via ↑↓ still works.
4. Screenshots dark + light: traffic panel, firewall stack, settings modal, analysis tab →
   `.superpowers/sdd/screenshots/polish1-t4-*.png`. Zero console errors.

**Commit:** `feat(panels): traffic, chrome, settings, and firewall stack in the hybrid style`
# Polish 1 plan fragment — Tasks 5–8 (examples vault data · vault home screen · stale-replay
# fix · phase gate)

> Fragment scope: Task 5 (`src/lib/vault/exampleWorlds.ts` + tests), Task 6 (HomeScreen vault
> section + `VaultCard`), Task 7 (`resetSession` + scrubber gate), Task 8 (phase smoke,
> light-mode pass, `docs/module-boundaries.md` §P, ledger). Global Constraints / File
> Structure live in the assembled plan header.
>
> **Grounding status:** the four world builders below are NOT designs — they are the exact
> compositions the controller session verified with a scratch `vite-node` run against real
> `compileWorld`/`runAnalysis`/`createWorldEngine` on 2026-07-10. Verified results:
>
> | world | compile findings | analysis findings | engine rps @ 50 steps (seed 1) |
> |---|---|---|---|
> | three-tier | 0 | 0 | 2000.0 |
> | multi-region-failover | 0 | 0 | 1495.3 |
> | event-driven | 0 | 0 | 1000.0 |
> | broken-teaching | 2 (`blocked-path`, `stateful-without-volume`) | **11** — structural 5 / network 4 / capacity 2 | 1999.4 |
>
> **Grounded corrections to the skeleton (controller decisions, verified necessary):**
> 1. **`three-tier` and `event-driven` ship with NO population.** The `no-failover-region`
>    rule (structural.ts:46-67) fires **critical** for ANY population whose compiled region
>    order has exactly one entry — in a single-region world that is every population. The
>    skeleton's "ONE population (NYC)" cannot coexist with its own binding zero-findings
>    contract. Demand comes from `traffic.autoBaseline` (verified: 2000/1000 rps — the
>    engine synthesizes one baseline population per region, demand.ts:24-40).
> 2. **`multi-region-failover`'s third population is São Paulo, not Singapore.** Passive
>    regions are stably partitioned to the END of every population's region order
>    (routing.ts:41-43), while `ocean-crossing-population` (capacity.ts:59-91) compares the
>    FIRST routed region against the nearest region regardless of role — a Singapore
>    population with passive `ap-southeast-1` always fires it. NYC/London/São Paulo keeps
>    the "populations on 3 continents" design intent (design D4) with zero findings
>    (verified: São Paulo's nearest doc region IS its first-routed region, us-east-1).
> 3. **The teaching card's findings pill reads `12 findings`**, not the mockup's decorative
>    `14`: verified 11 analysis findings + 1 unsuppressed compile finding
>    (`stateful-without-volume`; the `blocked-path` compile finding is suppressed by its
>    `blocked-dependency-path` analysis twin per AnalysisTab D4) = 12 in the Analysis tab
>    count.
> 4. The teaching world's front door (web :443) is deliberately REACHABLE — the
>    `entry-unreachable` finding comes from a separate firewalled-shut `admin` blueprint —
>    so the engine smoke and the phase-gate live story still show traffic flowing.

---

## Task 5: Examples vault — data `[sonnet]`

**Files:** create `src/lib/vault/exampleWorlds.ts`, `src/lib/vault/exampleWorlds.test.ts`.

### Step 5.1 — failing tests first: `exampleWorlds.test.ts`

Node env (pure — no jsdom pragma). Same engine harness as `src/lib/worldEngine/index.test.ts`
(seeded `createWorldEngine(1)` + `__test_step`):

```ts
import { describe, it, expect } from 'vitest'
import { VAULT } from './exampleWorlds'
import { compileWorld } from '../world/compileWorld'
import { runAnalysis } from '../analysis/runAnalysis'
import { createWorldEngine } from '../worldEngine'
import type { MetricsBatch } from '../worldEngine/types'

const entry = (id: string) => VAULT.find(e => e.id === id)!

describe('VAULT registry', () => {
  it('has the four entries with unique ids and names', () => {
    expect(VAULT).toHaveLength(4)
    expect(new Set(VAULT.map(e => e.id)).size).toBe(4)
    expect(new Set(VAULT.map(e => e.name)).size).toBe(4)
    expect(VAULT.map(e => e.id)).toEqual(['three-tier', 'multi-region-failover', 'event-driven', 'broken-teaching'])
  })

  it('every build() returns a fresh document', () => {
    for (const e of VAULT) {
      const a = e.build()
      const b = e.build()
      expect(a).not.toBe(b)
      expect(Object.keys(a.servers)).not.toEqual(Object.keys(b.servers)) // fresh ids, no shared refs
    }
  })
})

describe.each([['three-tier'], ['multi-region-failover'], ['event-driven']])('%s (clean world)', (id) => {
  it('compiles with zero compile findings and zero analysis findings', () => {
    const doc = entry(id).build()
    const compiled = compileWorld(doc)
    expect(compiled.findings).toEqual([])
    expect(runAnalysis(doc, compiled, null)).toEqual([])
    expect(compiled.paths.some(p => p.verdict === 'blocked')).toBe(false)
  })
})

describe('broken-teaching (teaching world)', () => {
  it('trips ≥10 analysis findings spanning all three families', () => {
    const doc = entry('broken-teaching').build()
    const compiled = compileWorld(doc)
    const findings = runAnalysis(doc, compiled, null)
    expect(findings.length).toBeGreaterThanOrEqual(10)
    for (const family of ['structural', 'network', 'capacity'] as const) {
      expect(findings.some(f => f.family === family)).toBe(true)
    }
    const ruleIds = new Set(findings.map(f => f.ruleId))
    for (const expected of [
      'single-az-region', 'no-failover-region', 'replicas-colocated', 'deep-sync-chain',
      'unused-managed-service', 'blocked-dependency-path', 'db-port-exposed',
      'entry-unreachable', 'ram-oversubscribed', 'ttl-outlives-detection',
    ]) expect(ruleIds.has(expected), `expected rule ${expected}`).toBe(true)
    expect(compiled.findings.map(f => f.kind).sort()).toEqual(['blocked-path', 'stateful-without-volume'])
  })
})

describe.each(VAULT.map(e => [e.id] as const))('%s engine smoke', (id) => {
  it('seeded engine reaches non-zero world rps in 50 steps', () => {
    const doc = entry(id).build()
    const compiled = compileWorld(doc)
    const engine = createWorldEngine(1)
    const batches: MetricsBatch[] = []
    engine.start(doc, compiled, { onMetrics: b => batches.push(b), onEvent: () => {}, onHealthChange: () => {} })
    engine.__test_step(50)
    engine.stop()
    expect(batches.length).toBeGreaterThan(0)
    expect(batches[batches.length - 1].world.totalRps).toBeGreaterThan(0)
  })
})
```

Run: `npx vitest run src/lib/vault/exampleWorlds.test.ts` → FAILS (module missing).

### Step 5.2 — `exampleWorlds.ts`

The module below is the verified scratch composition reshaped into the `VaultEntry`
contract. Transcribe it faithfully — every port, firewall rule, placement role, and routing
number is load-bearing for the findings contracts above. Names/blurbs/tags are the mockup's
vault cards verbatim (except the findings pill per grounded correction #3).

```ts
// src/lib/vault/exampleWorlds.ts
// The examples vault (Polish 1 D4): four complete WorldDoc builders. Pure data — imports the
// world factories only (module-boundaries §P). Every entry's findings contract is enforced by
// exampleWorlds.test.ts: the three clean worlds compile to ZERO compile+analysis findings; the
// teaching world trips ≥10 analysis findings across all three families. Composition notes:
// - Single-region worlds carry NO population: no-failover-region fires critical for any
//   population whose region order has one entry; autoBaseline supplies their demand.
// - multi-region's third population is São Paulo (not Singapore): passive regions sort to the
//   end of every routing order, so a population nearest the passive region would always trip
//   ocean-crossing-population.
import type { WorldDoc, Server, ServiceBlueprint, FirewallRule } from '../world/types'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
  createPopulation,
} from '../world/factories'
import { getPreset } from '../world/instanceCatalog'

export interface VaultEntry {
  id: 'three-tier' | 'multi-region-failover' | 'event-driven' | 'broken-teaching'
  name: string
  blurb: string
  tags: string[]
  difficulty: 'beginner' | 'intermediate' | 'teaching'
  build: () => WorldDoc
}

// ── doc-building helpers (same idiom as src/lib/analysis/__fixtures__/worlds.ts) ──
function region(doc: WorldDoc, catalogId: string, role: 'active' | 'passive' = 'active') {
  const r = createRegion(catalogId); r.role = role; doc.regions[r.id] = r; return r
}
function az(doc: WorldDoc, regionId: string, label: string) {
  const a = createAz(regionId, label); doc.azs[a.id] = a; return a
}
function server(doc: WorldDoc, azId: string, presetId: string, label: string): Server {
  const s = createServer(azId, getPreset(presetId)!); s.label = label; doc.servers[s.id] = s; return s
}
function blueprint(doc: WorldDoc, name: string, colorIndex: number): ServiceBlueprint {
  const b = createBlueprint(name, colorIndex); doc.blueprints[b.id] = b; return b
}
function place(doc: WorldDoc, blueprintId: string, serverId: string, role: 'primary' | 'replica' = 'primary') {
  const p = createPlacement(blueprintId, serverId); p.role = role; doc.placements[p.id] = p; return p
}
function dep(id: string, target: { kind: 'blueprint'; blueprintId: string } | { kind: 'managed'; managedServiceId: string },
  port: number, protocol: 'http' | 'db' | 'event' | 'stream') {
  return { id, target, port, protocol, packetTemplateId: null }
}
const allowAny = (port: number): FirewallRule =>
  ({ id: `fw-${port}-any`, action: 'allow', port, protocol: 'tcp', source: 'any' })
const denyAny = (port: number): FirewallRule =>
  ({ id: `fw-${port}-deny`, action: 'deny', port, protocol: 'tcp', source: 'any' })

function threeTier(): WorldDoc {
  const doc = createWorld()
  const r = region(doc, 'us-east-1')
  const aza = az(doc, r.id, 'us-east-1a')
  const azb = az(doc, r.id, 'us-east-1b')

  const lb1 = server(doc, aza.id, 'vps-large', 'lb-01')
  const web1 = server(doc, aza.id, 'vps-large', 'web-01')
  const web2 = server(doc, azb.id, 'vps-large', 'web-02')
  const api1 = server(doc, azb.id, 'vps-large', 'api-01')
  const dbP = server(doc, aza.id, 'dedicated-8', 'db-primary')
  const dbR = server(doc, azb.id, 'dedicated-8', 'db-replica')

  lb1.firewall = [allowAny(443), ...lb1.firewall]

  const lb = blueprint(doc, 'lb', 1)
  lb.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
  const web = blueprint(doc, 'web', 0)
  web.ports = [{ port: 8080, protocol: 'tcp', visibility: 'internal' }]
  const api = blueprint(doc, 'api', 2)
  api.ports = [{ port: 8081, protocol: 'tcp', visibility: 'internal' }]
  const db = blueprint(doc, 'db', 3)
  db.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
  db.stateful = true; db.volumeName = 'pgdata'
  lb.dependencies = [dep('d-lb-web', { kind: 'blueprint', blueprintId: web.id }, 8080, 'http')]
  web.dependencies = [dep('d-web-api', { kind: 'blueprint', blueprintId: api.id }, 8081, 'http')]
  api.dependencies = [dep('d-api-db', { kind: 'blueprint', blueprintId: db.id }, 5432, 'db')]

  place(doc, lb.id, lb1.id)
  place(doc, web.id, web1.id)
  place(doc, web.id, web2.id)
  place(doc, api.id, api1.id)
  place(doc, db.id, dbP.id, 'primary')
  place(doc, db.id, dbR.id, 'replica')
  // No populations (grounded correction #1) — autoBaseline (factory default) supplies demand.
  return doc
}

function multiRegion(): WorldDoc {
  const doc = createWorld()
  doc.routing.dnsTtlSec = 20
  doc.routing.healthCheckIntervalMs = 3000
  doc.routing.healthCheckFailureThreshold = 2
  doc.traffic.autoBaseline = false

  const web = blueprint(doc, 'web', 0)
  web.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
  const api = blueprint(doc, 'api', 1)
  api.ports = [{ port: 8080, protocol: 'tcp', visibility: 'internal' }]
  const db = blueprint(doc, 'db', 2)
  db.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
  db.stateful = true; db.volumeName = 'pgdata'
  web.dependencies = [dep('d-web-api', { kind: 'blueprint', blueprintId: api.id }, 8080, 'http')]
  api.dependencies = [dep('d-api-db', { kind: 'blueprint', blueprintId: db.id }, 5432, 'db')]

  for (const catalogId of ['us-east-1', 'eu-west-1']) {
    const r = region(doc, catalogId)
    const aza = az(doc, r.id, `${catalogId}a`)
    const azb = az(doc, r.id, `${catalogId}b`)
    const webS = server(doc, aza.id, 'vps-large', `web-${catalogId}`)
    webS.firewall = [allowAny(443), ...webS.firewall]
    const apiS = server(doc, azb.id, 'vps-large', `api-${catalogId}`)
    const dbP = server(doc, aza.id, 'dedicated-8', `db-primary-${catalogId}`)
    const dbR = server(doc, azb.id, 'dedicated-8', `db-replica-${catalogId}`)
    place(doc, web.id, webS.id)
    place(doc, api.id, apiS.id)
    place(doc, db.id, dbP.id, 'primary')
    place(doc, db.id, dbR.id, 'replica')
  }
  const passive = region(doc, 'ap-southeast-1', 'passive')
  az(doc, passive.id, 'ap-southeast-1a')
  az(doc, passive.id, 'ap-southeast-1b')
  // Warm-standby placeholder: no servers — regions without instances are exempt from
  // single-az-region, and a population near a passive region would trip
  // ocean-crossing-population (grounded correction #2), hence São Paulo below.

  const nyc = createPopulation('NYC', 40.7, -74.0); nyc.peakRps = 400; doc.populations[nyc.id] = nyc
  const lon = createPopulation('London', 51.5, -0.1); lon.peakRps = 400; doc.populations[lon.id] = lon
  const sp = createPopulation('São Paulo', -23.5, -46.6); sp.peakRps = 200; doc.populations[sp.id] = sp
  return doc
}

function eventDriven(): WorldDoc {
  const doc = createWorld()
  const r = region(doc, 'us-east-1')
  const aza = az(doc, r.id, 'us-east-1a')
  const azb = az(doc, r.id, 'us-east-1b')

  const msId = 'ms-queue'
  doc.managedServices[msId] = { id: msId, label: 'Queue', nodeType: 'queue', scope: { kind: 'region', regionId: r.id }, provider: 'aws', port: 443 }

  const api = blueprint(doc, 'api', 0)
  api.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
  const worker = blueprint(doc, 'worker', 1)
  worker.ports = [{ port: 9000, protocol: 'tcp', visibility: 'internal' }]
  const store = blueprint(doc, 'store', 2)
  store.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
  store.stateful = true; store.volumeName = 'eventdata'
  api.dependencies = [dep('d-api-q', { kind: 'managed', managedServiceId: msId }, 443, 'event')]
  worker.dependencies = [
    dep('d-w-q', { kind: 'managed', managedServiceId: msId }, 443, 'event'),
    dep('d-w-store', { kind: 'blueprint', blueprintId: store.id }, 5432, 'db'),
  ]

  const api1 = server(doc, aza.id, 'vps-large', 'api-01')
  api1.firewall = [allowAny(443), ...api1.firewall]
  const api2 = server(doc, azb.id, 'vps-large', 'api-02')
  api2.firewall = [allowAny(443), ...api2.firewall]
  const w1 = server(doc, aza.id, 'vps-large', 'worker-01')
  w1.stacks = [{ name: 'workers', networks: [{ name: 'wnet', cidr: '172.19.0.0/16' }], volumes: [] }]
  const w2 = server(doc, azb.id, 'vps-large', 'worker-02')
  w2.stacks = [{ name: 'workers', networks: [{ name: 'wnet', cidr: '172.19.0.0/16' }], volumes: [] }]
  const st1 = server(doc, aza.id, 'dedicated-8', 'store-01')
  st1.stacks = [{ name: 'data', networks: [{ name: 'datanet', cidr: '172.20.0.0/16' }], volumes: [{ name: 'eventdata', sizeGb: 20 }] }]

  place(doc, api.id, api1.id)
  place(doc, api.id, api2.id)
  const wp1 = place(doc, worker.id, w1.id); wp1.count = 2
  wp1.runtime = { type: 'container', stackName: 'workers', networkNames: ['wnet'], portMappings: [], cpuLimit: null, memLimitMb: null }
  const wp2 = place(doc, worker.id, w2.id); wp2.count = 2
  wp2.runtime = { type: 'container', stackName: 'workers', networkNames: ['wnet'], portMappings: [], cpuLimit: null, memLimitMb: null }
  const sp1 = place(doc, store.id, st1.id)
  // The host port mapping is what keeps worker→store permitted cross-server.
  sp1.runtime = { type: 'container', stackName: 'data', networkNames: ['datanet'], portMappings: [{ host: 5432, container: 5432 }], cpuLimit: null, memLimitMb: null }
  // No populations (grounded correction #1) — autoBaseline supplies demand.
  return doc
}

function brokenTeaching(): WorldDoc {
  const doc = createWorld()
  doc.routing.dnsTtlSec = 5                    // ttl-outlives-detection: 5s TTL vs
  doc.routing.healthCheckIntervalMs = 12000    // 12s × 3 = 36s detection window
  doc.routing.healthCheckFailureThreshold = 3

  const r = region(doc, 'us-east-1')
  const aza = az(doc, r.id, 'us-east-1a')      // ONE AZ — single-az-region

  const webS = server(doc, aza.id, 'vps-medium', 'web-01')
  webS.firewall = [allowAny(443), ...webS.firewall]      // front door stays REACHABLE (correction #4)
  const apiS = server(doc, aza.id, 'vps-medium', 'api-01')
  const dbS = server(doc, aza.id, 'vps-small', 'db-01')
  dbS.firewall = [allowAny(5432), ...dbS.firewall]       // db-port-exposed (a)
  const cacheS = server(doc, aza.id, 'vps-small', 'cache-01')
  cacheS.firewall = [denyAny(6379), ...cacheS.firewall]  // blocked-dependency-path
  const adminS = server(doc, aza.id, 'vps-small', 'admin-01')  // default internal-only → entry-unreachable

  const web = blueprint(doc, 'web', 0)
  web.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
  const api = blueprint(doc, 'api', 1)
  api.ports = [{ port: 8080, protocol: 'tcp', visibility: 'internal' }]
  const auth = blueprint(doc, 'auth', 4)
  auth.ports = [{ port: 8100, protocol: 'tcp', visibility: 'internal' }]
  const profile = blueprint(doc, 'profile', 5)
  profile.ports = [{ port: 8200, protocol: 'tcp', visibility: 'internal' }]
  const db = blueprint(doc, 'db', 2)
  db.ports = [{ port: 5432, protocol: 'tcp', visibility: 'public' }]   // db-port-exposed (b)
  db.stateful = true; db.volumeName = null                             // stateful-without-volume (compile)
  db.workload = { ...db.workload, ramBaseMb: 2400 }                    // 2 × 2400 > 4096 → ram-oversubscribed
  const cache = blueprint(doc, 'cache', 3)
  cache.ports = [{ port: 6379, protocol: 'tcp', visibility: 'internal' }]
  const admin = blueprint(doc, 'admin', 1)
  admin.ports = [{ port: 8443, protocol: 'tcp', visibility: 'public' }]

  web.dependencies = [dep('d-web-api', { kind: 'blueprint', blueprintId: api.id }, 8080, 'http')]
  api.dependencies = [
    dep('d-api-auth', { kind: 'blueprint', blueprintId: auth.id }, 8100, 'http'),
    dep('d-api-db', { kind: 'blueprint', blueprintId: db.id }, 5432, 'db'),
    dep('d-api-cache', { kind: 'blueprint', blueprintId: cache.id }, 6379, 'stream'),
  ]
  auth.dependencies = [dep('d-auth-profile', { kind: 'blueprint', blueprintId: profile.id }, 8200, 'http')]
  profile.dependencies = [dep('d-profile-db', { kind: 'blueprint', blueprintId: db.id }, 5432, 'db')]
  // web→api→auth→profile→db = 4 http/db hops → deep-sync-chain

  place(doc, web.id, webS.id)
  place(doc, api.id, apiS.id)
  place(doc, auth.id, apiS.id)
  place(doc, profile.id, apiS.id)
  place(doc, db.id, dbS.id, 'primary')
  place(doc, db.id, dbS.id, 'replica')   // primary + replica in the same AZ → replicas-colocated
  place(doc, cache.id, cacheS.id)
  place(doc, admin.id, adminS.id)

  doc.managedServices['ms-metrics'] = { id: 'ms-metrics', label: 'Metrics store', nodeType: 'redis', scope: { kind: 'az', azId: aza.id }, provider: 'aws', port: 6380 }
  // nothing depends on it → unused-managed-service

  const pop = createPopulation('customers', 40.7, -74.0)   // 1-region order → no-failover-region
  pop.peakRps = 500
  doc.populations[pop.id] = pop
  return doc
}

export const VAULT: VaultEntry[] = [
  {
    id: 'three-tier',
    name: 'Classic three-tier',
    blurb: 'LB-fronted web + api + replicated db across two AZs. The on-ramp.',
    tags: ['1 region', '6 servers'],
    difficulty: 'beginner',
    build: threeTier,
  },
  {
    id: 'multi-region-failover',
    name: 'Multi-region failover',
    blurb: 'Active/passive across three continents, TTL tuned so killing a region tells the whole DNS-lag story.',
    tags: ['3 regions', 'populations'],
    difficulty: 'intermediate',
    build: multiRegion,
  },
  {
    id: 'event-driven',
    name: 'Event-driven microservices',
    blurb: 'Services publishing through a managed queue to worker pools in compose stacks — networks, volumes, the works.',
    tags: ['1 region', 'queue + workers'],
    difficulty: 'intermediate',
    build: eventDriven,
  },
  {
    id: 'broken-teaching',
    name: 'Everything wrong at once',
    blurb: 'Exposed database, single-AZ SPOF, oversubscribed RAM, TTL slower than detection. Run the analysis, then fix it.',
    tags: ['teaching world', '12 findings'],
    difficulty: 'teaching',
    build: brokenTeaching,
  },
]
```

**Builder reference (verified composition — implement these exactly):**

- `threeTier()`: us-east-1 (active); AZs `us-east-1a`/`us-east-1b`. Servers: `lb-01`
  (vps-large, 1a, firewall `[allowAny(443), ...factory internal rule]`), `web-01`
  (vps-large, 1a), `web-02` (vps-large, 1b), `api-01` (vps-large, 1b), `db-primary`
  (dedicated-8, 1a), `db-replica` (dedicated-8, 1b) — 6 servers, both AZs populated
  (single-az-region needs ≥2 AZs WITH instances). Blueprints: `lb` (public :443 →
  dep http :8080 → web), `web` (:8080 internal → dep http :8081 → api), `api` (:8081
  internal → dep db :5432 → db), `db` (:5432 internal, `stateful: true`,
  `volumeName: 'pgdata'`). Every blueprint's `ports` array must BIND the port its
  dependents call (no-port-binding is checked before the firewall). Placements: lb→lb-01,
  web→web-01, web→web-02, api→api-01, db→db-primary (primary), db→db-replica (**replica**,
  different AZ — replicas-colocated). Routing/traffic: factory defaults (TTL 30s ≥ 10s×3
  detection; autoBaseline true). NO populations.
- `multiRegion()`: routing `{ dnsTtlSec: 20, healthCheckIntervalMs: 3000, healthCheckFailureThreshold: 2 }`
  (TTL 20s comfortably ≥ 6s detection — no hint, real lag drama on a kill);
  `traffic.autoBaseline = false` (populations carry all demand). Shared blueprints web
  (public :443 → api http :8080), api (:8080 → db db :5432), db (:5432, stateful,
  'pgdata'). Per active region (us-east-1, eu-west-1): AZs `<id>a`/`<id>b`; servers
  `web-<id>` (vps-large, a, `allowAny(443)` prepended), `api-<id>` (vps-large, b),
  `db-primary-<id>` (dedicated-8, a, role primary), `db-replica-<id>` (dedicated-8, b,
  role replica). Passive `ap-southeast-1` with AZs `ap-southeast-1a`/`b` and NO servers
  (a warm-standby placeholder; regions without instances are exempt from
  single-az-region). Populations: `NYC` (40.7, −74.0, 400 rps), `London` (51.5, −0.1,
  400 rps), `São Paulo` (−23.5, −46.6, 200 rps), all `diurnal: 'flat'`.
- `eventDriven()`: us-east-1, AZs a/b. Managed service `{ id: 'ms-queue', label: 'Queue',
  nodeType: 'queue', scope: { kind: 'region', regionId }, provider: 'aws', port: 443 }`
  (authored inline — `nodeType: 'queue'` is the CLOUD_REGISTRY key PlacementPanel's
  MANAGED_TYPES uses). Blueprints: `api` (public :443; dep event :443 → queue), `worker`
  (:9000 internal; deps event :443 → queue AND db :5432 → store), `store` (:5432 internal,
  stateful, `volumeName: 'eventdata'`). Servers: `api-01` (vps-large, a, allowAny(443)),
  `api-02` (vps-large, b, allowAny(443)), `worker-01` (vps-large, a, stack
  `workers`/network `wnet@172.19.0.0/16`), `worker-02` (vps-large, b, same stack shape),
  `store-01` (dedicated-8, a, stack `data`/network `datanet@172.20.0.0/16`/volume
  `eventdata@20`). Placements: api on both api servers (process); worker on both worker
  servers, `count: 2`, container runtime `{ stackName: 'workers', networkNames: ['wnet'],
  portMappings: [], cpuLimit: null, memLimitMb: null }`; store on store-01, container
  `{ stackName: 'data', networkNames: ['datanet'], portMappings: [{ host: 5432,
  container: 5432 }], … }` — the host mapping is what keeps worker→store permitted
  cross-server. autoBaseline stays true (demand source). NO populations.
- `brokenTeaching()`: routing `{ dnsTtlSec: 5, healthCheckIntervalMs: 12000,
  healthCheckFailureThreshold: 3 }` (ttl-outlives-detection). us-east-1 with ONE AZ
  (single-az-region). Servers (all 1a): `web-01` (vps-medium, allowAny(443) prepended),
  `api-01` (vps-medium), `db-01` (vps-small, **allowAny(5432)** prepended →
  db-port-exposed (a)), `cache-01` (vps-small, **denyAny(6379)** prepended →
  blocked-dependency-path + blocked-path compile finding), `admin-01` (vps-small,
  factory default internal-only → entry-unreachable). Blueprints: `web` (public :443 →
  api http :8080), `api` (:8080; deps http :8100 → auth, db :5432 → db, stream :6379 →
  cache), `auth` (:8100 → profile http :8200), `profile` (:8200 → db db :5432) — the
  web→api→auth→profile→db chain is 4 http/db hops (deep-sync-chain); `db` (**public**
  :5432 → db-port-exposed (b); `stateful: true`, `volumeName: null` →
  stateful-without-volume compile finding; `workload.ramBaseMb = 2400` so primary+replica
  on the 4096 MB vps-small oversubscribe RAM), `cache` (:6379 internal), `admin`
  (**public :8443**, placed on admin-01, no allow rule → entry-unreachable while web
  stays reachable). Placements: web→web-01; api, auth, profile→api-01; db→db-01 primary
  AND db→db-01 **replica** (replicas-colocated); cache→cache-01; admin→admin-01. Managed
  service `{ id: 'ms-metrics', label: 'Metrics store', nodeType: 'redis', scope:
  { kind: 'az', azId }, provider: 'aws', port: 6380 }` with no dependent
  (unused-managed-service). ONE population `customers` (40.7, −74.0, 500 rps) —
  no-failover-region (critical). Expected: exactly the verified 11 analysis + 2 compile
  findings.

Every builder constructs a brand-new doc per call (factories mint fresh ids) — that is the
"fresh deep copy" contract; no module-level doc singletons.

### Step 5.3 — verify

```
npx vitest run src/lib/vault/exampleWorlds.test.ts
```
Expected: 4 + 3 + 1 + 4 = 12 cases green. Then `npx vitest run && npm run build` green.
Delete nothing else; the controller removes `scratch-verify-polish1.ts` at plan-assembly
commit time.

**Commit:** `feat(vault): four example worlds with enforced findings contracts`

---

## Task 6: Examples vault — home screen `[sonnet]`

**Files:** create `src/app/home/VaultCard.tsx`, `src/app/home/VaultCard.test.tsx`; modify
`src/app/home/HomeScreen.tsx`, `src/app/home/HomeScreen.module.css`,
`src/app/store/ui.store.ts`, `src/app/world/panels/WorldPanel.tsx` (+ its test), create
`src/app/home/HomeScreen.test.tsx`.

### Grounding

- `HomeScreen.tsx` (79 lines, read in full): `openNew()` is the New stance to mirror —
  `newWorld()` + `goGlobe()` + `setFilePath(null)` + `setShowHome(false)`. `newWorld()`
  itself resets dirty=false and createdIso=null (world.store.ts:106-117); `replaceWorld`
  does NOT touch the file store — the vault opener must do those resets explicitly.
- `HomeScreen.module.css` still carries LEGACY vault classes (`.vault`, `.vaultHeader`,
  `.vaultCount`, `.vaultGrid`, `.templateCard`, `.template*` — the deleted canvas app's
  template grid, zero consumers, verified). DELETE that whole block and write the mockup's
  card styles fresh under the same section banner.
- `WorldPanel.tsx` holds a local `type Tab` union and `useState<Tab>('topology')`. The
  one-shot open-on-Analysis mechanism: move the union to `ui.store.ts` as `PanelTab`,
  WorldPanel imports it (view→store type import, correct direction).
- Mockup vault CSS (transcribed): `.vault` grid `repeat(auto-fit, minmax(220px, 1fr))` gap
  12; `.vcard` gradient `165deg #12151D → #0D1015` (→ tokens: `var(--color-node-base)` to
  `var(--color-canvas)`), border `1px solid #232833` (≈ node-border), radius 10, padding
  14; hover border `#3A4150`, `translateY(-2px)`, shadow `0 10px 26px #00000060`;
  reduced-motion kills transform+transition; `.vg` height 64 margin-bottom 10; `.vn`
  12.5px 600; `.vd` muted 10px lh 1.5 margin `3px 0 8px`; `.vm` flex gap 6 9px; `.vpill`
  padding `1px 7px` radius 8 border 1px node-border secondary text. Teaching card border
  tint `#EF444433` → `color-mix(in srgb, var(--color-danger) 20%, transparent)`.
- The four SVG glyphs: transcribe the mockup's `<svg class="vg" viewBox="0 0 200 64">`
  blocks 1:1 into JSX (self-closing tags, `strokeWidth`/`strokeDasharray` camelCase).
  Stroke mapping: `#4A9EFF` → `var(--color-accent)`, `#EF4444` → `var(--color-danger)`,
  `#2A2E38` → `var(--color-node-border)`, `#F59E0B` → `var(--color-warning)`; the teal
  `#2DD4BF` and violet `#A78BFA` strokes stay as two named constants in `VaultCard.tsx`
  (`GLYPH_TEAL`, `GLYPH_VIOLET`) — decorative glyph art, the same stance as the
  globe/board scene hexes (documented inline).

### Step 6.1 — failing tests first

`src/app/home/VaultCard.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { VaultCard } from './VaultCard'
import { VAULT } from '../../lib/vault/exampleWorlds'

describe('VaultCard', () => {
  it('renders glyph, name, blurb, tags, and difficulty pill', () => {
    const entry = VAULT[0]
    const { container } = render(<VaultCard entry={entry} onOpen={() => {}} />)
    expect(container.querySelector('svg')).toBeInTheDocument()
    expect(screen.getByText('Classic three-tier')).toBeInTheDocument()
    expect(screen.getByText(/The on-ramp/)).toBeInTheDocument()
    expect(screen.getByText('1 region')).toBeInTheDocument()
    expect(screen.getByText('beginner')).toBeInTheDocument()
  })
  it('click fires onOpen with the entry', () => {
    const onOpen = vi.fn()
    render(<VaultCard entry={VAULT[3]} onOpen={onOpen} />)
    fireEvent.click(screen.getByText('Everything wrong at once'))
    expect(onOpen).toHaveBeenCalledWith(VAULT[3])
  })
})
```

`src/app/home/HomeScreen.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { HomeScreen } from './HomeScreen'
import { useWorldStore } from '../store/world.store'
import { useFileStore } from '../store/file.store'
import { useNavStore } from '../store/nav.store'
import { useUiStore } from '../store/ui.store'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useFileStore.setState({ showHome: true, filePath: 'old.scalemap', dirty: true, createdIso: 'x' })
  useUiStore.setState({ pendingPanelTab: null })
})

describe('HomeScreen vault', () => {
  it('renders all four cards with difficulty pills', () => {
    render(<HomeScreen />)
    expect(screen.getByText('Start from an example')).toBeInTheDocument()
    expect(screen.getByText('Classic three-tier')).toBeInTheDocument()
    expect(screen.getByText('Multi-region failover')).toBeInTheDocument()
    expect(screen.getByText('Event-driven microservices')).toBeInTheDocument()
    expect(screen.getByText('Everything wrong at once')).toBeInTheDocument()
    expect(screen.getByText('teaching')).toBeInTheDocument()
  })

  it('opening an example loads the world, resets file state, and dismisses home', () => {
    render(<HomeScreen />)
    fireEvent.click(screen.getByText('Classic three-tier'))
    const s = useWorldStore.getState()
    expect(Object.keys(s.doc.servers)).toHaveLength(6)
    expect(s.history).toHaveLength(0)
    const f = useFileStore.getState()
    expect(f.showHome).toBe(false)
    expect(f.filePath).toBeNull()
    expect(f.dirty).toBe(false)
    expect(f.createdIso).toBeNull()
    expect(useNavStore.getState().level).toBe('globe')
    expect(useUiStore.getState().pendingPanelTab).toBeNull()   // only the teaching card queues a tab
  })

  it('the teaching card queues the analysis tab', () => {
    render(<HomeScreen />)
    fireEvent.click(screen.getByText('Everything wrong at once'))
    expect(useUiStore.getState().pendingPanelTab).toBe('analysis')
  })
})
```

Append to `WorldPanel.test.tsx`:

```tsx
it('consumes a pending panel tab once on mount', () => {
  useUiStore.setState({ pendingPanelTab: 'analysis' })
  render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)
  expect(screen.getByText('No findings — the compiled world is clean.')).toBeInTheDocument()
  expect(useUiStore.getState().pendingPanelTab).toBeNull()
})
```

(import `useUiStore` there.) Run → all red where expected.

### Step 6.2 — `ui.store.ts` additive field

```ts
export type PanelTab = 'topology' | 'blueprints' | 'placements' | 'traffic' | 'analysis' | 'events' | 'cost'
```
Add `pendingPanelTab: PanelTab | null` (initial `null`) and
`setPendingPanelTab: (tab: PanelTab | null) => void`. Additive — the themeMode contract is
untouched.

### Step 6.3 — WorldPanel consume-on-mount

Replace the local `type Tab` with `import { useUiStore, type PanelTab } from '../../store/ui.store'`;
`const [tab, setTab] = useState<PanelTab>(() => useUiStore.getState().pendingPanelTab ?? 'topology')`
plus a mount effect that clears it:
`useEffect(() => { if (useUiStore.getState().pendingPanelTab) useUiStore.getState().setPendingPanelTab(null) }, [])`.
(Read in the initializer, clear in an effect — no setState-during-render.)

### Step 6.4 — `VaultCard.tsx` + HomeScreen wiring + CSS

`VaultCard`: a `<button type="button" className={styles.vcard} data-teaching={entry.difficulty === 'teaching' || undefined}>`
rendering glyph / name / blurb / tag pills / difficulty pill. Difficulty pill colors via
tokens: beginner → `var(--color-success-text)` + border
`color-mix(in srgb, var(--color-success) 27%, transparent)`; intermediate →
`var(--color-warning)`; teaching → `var(--color-danger)`. Glyphs: a `GLYPHS: Record<VaultEntry['id'], ReactElement>`
map, transcribed per the grounding note. Card takes `{ entry, onOpen }` and calls
`onOpen(entry)` on click.

HomeScreen: below `.actions`, a vault section:

```tsx
<div className={styles.vaultSection}>
  <div className={styles.vaultHeader}>Start from an example</div>
  <div className={styles.vaultGrid}>
    {VAULT.map(e => <VaultCard key={e.id} entry={e} onOpen={openExample} />)}
  </div>
</div>
```

```tsx
const openExample = (entry: VaultEntry) => {
  useWorldStore.getState().replaceWorld(entry.build())
  useFileStore.getState().setFilePath(null)
  useFileStore.getState().setDirty(false)         // pristine — the New stance; Save will ask for a location
  useFileStore.getState().setCreatedIso(null)
  if (entry.id === 'broken-teaching') useUiStore.getState().setPendingPanelTab('analysis')
  useNavStore.getState().goGlobe()
  setShowHome(false)
}
```

CSS: delete the legacy `.vault…/.template…` block; add `.vaultSection` (width 100%),
`.vaultHeader` (the existing eyebrow-caps recipe: 11px 600, letter-spacing 0.07em,
uppercase, muted, margin-bottom 14), `.vaultGrid`
(`grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px`), `.vcard` per
the transcription (tokens; `text-align: left; font-family: var(--font-mono); cursor:
pointer; transition: border-color 0.15s, transform 0.15s, box-shadow 0.15s`), `.vcard:hover`
(border `var(--color-text-muted)`-mixed, `transform: translateY(-2px)`, shadow),
`.vcard[data-teaching]` danger-tinted border, glyph/name/desc/meta/pill classes, and
`@media (prefers-reduced-motion: reduce) { .vcard { transition: none } .vcard:hover { transform: none } }`.

### Step 6.5 — verify

```
npx vitest run src/app/home src/app/world/panels/WorldPanel.test.tsx
npx vitest run && npm run build
```

### Step 6.6 — live smoke

1. Reload → home shows the four cards under the actions.
2. Open "Everything wrong at once" → lands on globe with the WorldPanel's **Analysis tab
   pre-selected**, count chip ≥ 12, findings grouped by family; title bar shows no file
   path; Save prompts for a location.
3. Fix one finding via the T4 firewall stack (cache-01: remove/reorder the deny :6379) →
   blocked-dependency-path clears from the tab live.
4. New (⌘N) → stays in-shell (existing behavior, home NOT shown); reload → home again →
   open "Classic three-tier" → Simulate → topology rows light up.
5. Dark + light screenshots of the home screen →
   `.superpowers/sdd/screenshots/polish1-t6-home-{dark,light}.png`. Zero console errors.

**Commit:** `feat(vault): start-from-example cards on the home screen`

---

## Task 7: Stale replay after doc swap `[sonnet]`

**Files:** modify `src/app/store/simulation.store.ts`, `src/app/store/world.store.ts`,
`src/app/world/ScrubberV2.tsx`; EXTEND `src/app/store/world.store.test.ts`; CREATE
`src/app/world/ScrubberV2.test.tsx` (verified: no scrubber test file exists).

### Grounding

- The bug: `worldEngine`'s replay ring survives `stop()` (it only resets on the next
  `start()`); `ScrubberV2` fetches frames whenever `running` flips false
  (ScrubberV2.tsx:27-30) and renders whenever `frames.length > 0` — so after New/Open the
  discarded world's frames are offered against a fresh doc.
- `newWorld`/`replaceWorld` currently call `useSimulationStore.getState().stop()`
  (world.store.ts:111/120) and both existing tests assert `running` flips false — those
  assertions must keep passing (resetSession also sets `running: false`).
- `stop()` deliberately KEEPS `latestBatch` (the stop-then-scrub flow) — the new gate uses
  `latestBatch === null` as the "fresh session" signal, which only `resetSession`/`start`
  produce.

### Step 7.1 — failing tests first

Extend `world.store.test.ts`:

```ts
it('newWorld clears batch, events, scrub state, and health overrides', () => {
  useSimulationStore.setState({
    running: true, latestBatch: { simMs: 1 } as never, events: [{ id: 'e' } as never],
    scrubIndex: 3, scrubBatch: { simMs: 1 } as never, degraded: true, healthOverrides: { srv: true },
  })
  useWorldStore.getState().newWorld()
  const s = useSimulationStore.getState()
  expect(s.running).toBe(false)
  expect(s.latestBatch).toBeNull()
  expect(s.events).toEqual([])
  expect(s.scrubIndex).toBeNull()
  expect(s.scrubBatch).toBeNull()
  expect(s.degraded).toBe(false)
  expect(s.healthOverrides).toEqual({})
})

it('replaceWorld likewise clears the sim session', () => {
  useSimulationStore.setState({ latestBatch: { simMs: 1 } as never, scrubIndex: 2, healthOverrides: { x: true } })
  useWorldStore.getState().replaceWorld(useWorldStore.getState().doc)
  const s = useSimulationStore.getState()
  expect(s.latestBatch).toBeNull()
  expect(s.scrubIndex).toBeNull()
  expect(s.healthOverrides).toEqual({})
})
```

New `src/app/world/ScrubberV2.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ScrubberV2 } from './ScrubberV2'
import { useSimulationStore } from '../store/simulation.store'
import type { ReplayFrame, MetricsBatch } from '../../lib/worldEngine/types'

const batch = (simMs: number): MetricsBatch => ({
  simMs, instances: {}, servers: {}, azs: {}, regions: {},
  world: { totalRps: 0, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 },
})
const frames: ReplayFrame[] = [{ simMs: 1000, batch: batch(1000), events: [] }]

beforeEach(() => useSimulationStore.setState({ running: false, latestBatch: null, scrubIndex: null, scrubBatch: null }))

describe('ScrubberV2 session gate', () => {
  it('shown after a normal stop (frames + latestBatch)', () => {
    useSimulationStore.setState({ latestBatch: batch(1000), getReplayFrames: () => frames })
    render(<ScrubberV2 />)
    expect(screen.getByLabelText('replay-scrubber')).toBeInTheDocument()
  })
  it('hidden after a doc swap even when the engine still holds frames', () => {
    useSimulationStore.setState({ latestBatch: null, getReplayFrames: () => frames })
    render(<ScrubberV2 />)
    expect(screen.queryByLabelText('replay-scrubber')).not.toBeInTheDocument()
  })
})
```

Run → the two store cases fail (fields survive), the scrubber hidden case fails (renders).

### Step 7.2 — implement

`simulation.store.ts` — additive action (contracts: additive store fields/actions are
sanctioned; no engine change, it calls the existing facade `stop()`):

```ts
resetSession: () => {
  worldEngine.stop()
  set({
    running: false, latestBatch: null, events: [], scrubIndex: null, scrubBatch: null,
    degraded: false, healthOverrides: {},
  })
},
```
(+ the interface line `resetSession: () => void` with the comment: doc swaps call this
instead of `stop()` — healthOverrides referenced the discarded world's ids.)

`world.store.ts`: in `newWorld` and `replaceWorld`, replace
`useSimulationStore.getState().stop()` with `useSimulationStore.getState().resetSession()`
(keep each site's explanatory comment, extended one line: the session state references the
discarded doc's ids, so the swap clears it wholesale).

`ScrubberV2.tsx`: subscribe `const latestBatch = useSimulationStore(s => s.latestBatch)` and
gate `if (running || frames.length === 0 || latestBatch === null) return null` (comment: a
fresh doc has neither frames nor a batch; engine buffers reset on the next start as they
always did).

### Step 7.3 — verify

```
npx vitest run src/app/store/world.store.test.ts src/app/world/ScrubberV2.test.tsx
npx vitest run && npm run build
```
Expected: 15 + 2 store cases, 2 scrubber cases, full suite green.

**Commit:** `fix(replay): doc swap clears the sim session — no scrubbing a discarded world`

---

## Task 8: Final — phase smoke, light-mode pass, boundaries §P `[sonnet]`

**Files:** `docs/module-boundaries.md` (add §P); fix any Minors queued in the ledger during
T1–T7; no product code beyond those fixes.

### Step 8.1 — full battery

```
npx vitest run          # expected: every suite green
npm run build           # expected: tsc + vite green
```

### Step 8.2 — phase-gate live story (controller-run, port 1420, zero console errors)

The spec's Testing story end-to-end, in one session:
1. Reload → home → open **Everything wrong at once** → Analysis tab pre-selected, ≥12 in
   the count chip, findings grouped structural/network/capacity + Compile.
2. Navigate to cache-01's server view → firewall stack (amber frame, flow captions) →
   remove/reorder the deny :6379 → the blocked-dependency-path finding clears live.
3. Home (reload) → **Classic three-tier** → Simulate → Topology rows show live utilization
   bars + micro-bars; Blueprints tab → drag the cpu slider → derive hint updates live.
4. Stop → New (⌘N) → **no scrubber appears** for the discarded session; controls unlocked.
5. Reload → **Multi-region failover** → Simulate → globe arcs; kill us-east-1 (region
   outage switch) → traffic drains to eu-west-1 after the visible TTL lag (ttl_lag events
   in the Events tab).
6. ⚙ → light theme → walk every restyled surface (Topology, Blueprints, Placements,
   Traffic, Analysis, Events, Cost tabs; Settings modal; server-view rail + firewall
   stack; home screen) — screenshot each dark AND light →
   `.superpowers/sdd/screenshots/polish1-t8-<surface>-{dark,light}.png`.
7. Console: zero errors across the whole story (webgl-context warnings from the globe are
   pre-existing and out of scope ONLY if they already occur on main — verify before
   waving anything through).

### Step 8.3 — `docs/module-boundaries.md` §P

Append a §P documenting: `src/app/world/ui/` (kit + derived — panels import the kit; the
kit imports NOTHING from panels; the two sanctioned glow hexes live in kit.tsx alone;
`derived.ts` shares `reservedRamMb` with `lib/analysis/rules/capacity.ts`),
`src/lib/vault/` (imports world factories/types + instanceCatalog only; consumed by
HomeScreen; findings contracts test-enforced), the `ui.store.pendingPanelTab` one-shot
channel (HomeScreen writes, WorldPanel consumes-and-clears), and
`simulation.store.resetSession` (the ONLY doc-swap reset path; `stop()` remains the
scrub-preserving user stop). Update §-references/file lists the phase touched (panels,
ScrubberV2, HomeScreen). Follow the existing section voice.

### Step 8.4 — ledger

Append to `.superpowers/sdd/progress.md` under `## POLISH 1`: per-task lines (already
written during execution), then the phase summary: what shipped, the four grounded
corrections (fragment headers), open items (expected: cosmetic Minors only), drift state
(expected: NONE — nothing under `src/lib/worldEngine/` changed; verify with
`git diff main..HEAD --stat -- src/lib/worldEngine/` printing empty).

**Commit:** `docs: module boundaries §P — hybrid ui kit and examples vault`
