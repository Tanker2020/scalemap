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
