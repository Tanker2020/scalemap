# Phase 3 plan fragment — Tasks 6–9 (selection + rail · editing · managed-types · final)

> Fragment scope: Task 6 (selection model, inspector rail read panels, cross-highlight), Task 7
> (editing forms + sim edit-lock), Task 8 (PlacementPanel ↔ CLOUD_REGISTRY), Task 9 (final
> integration + §L). Imports T1's `BoardLayout`/`attributeCores`/`CoreAttribution`, T3's board
> components, T4's `useServerDisplayMetrics`. World writes go ONLY through `useWorldStore`
> actions `updateServer`/`updateBlueprint`/`updatePlacement` (D7 — verified: those are the write
> surface; no `updateManagedService` exists, and the rail must not invent one).

---

## Task 6: Selection model, inspector rail (read), cross-highlight `[sonnet]`

**Files:** `src/app/world/server/selection.ts` already exists (T3 created the type-only union to
keep its build green) — verify it matches the union below verbatim, else reconcile. Create
`InspectorRail.tsx`, `InspectorRail.test.tsx`; wire selection + hover through `ServerView.tsx`
and `ServerBoard.tsx` (replace T3's `null`/noop props); confirm dim/glow treatment in
`ServiceChip`/`StackPlate`/`HardwarePlatform`/`TraceLayer` (props already accept `dimmed`/
`hovered` from T3/T4 — wire the values).

**Grounding — Esc handling (verified against `WorldShell.tsx:42-66`):** WorldShell registers a
`window` `keydown` (bubble phase) that calls `useNavStore.getState().up()` on `Escape`, but FIRST
does `if (e.defaultPrevented) return`. It also ignores events whose target is INPUT/TEXTAREA/
SELECT/contentEditable. Therefore ServerView's own Esc handler must register in the **capture
phase** (`addEventListener('keydown', h, true)`) so it runs before WorldShell's bubble handler
regardless of mount order, and call `e.preventDefault()` when a selection is active — WorldShell
then sees `defaultPrevented` and does NOT navigate up. (Registration-order tricks are unreliable
here: ServerView mounts after WorldShell, so its bubble listener would fire second. Capture phase
is the robust mechanism — document this in the report.)

- [ ] **Step 1: Confirm `selection.ts` (type-only)**

```ts
// src/app/world/server/selection.ts
import type { InstanceId } from '../../../lib/world/types'

export type BoardSelection =
  | { kind: 'instance'; instanceId: InstanceId }
  | { kind: 'nic' }
  | { kind: 'firewall' }
  | { kind: 'rule'; ruleId: string }
  | { kind: 'stack'; stackName: string }
  | { kind: 'volume'; stackName: string; volumeName: string }
  | { kind: 'hardware'; part: 'cpu' | 'ram' | 'disk' }
  | { kind: 'core'; coreIndex: number }
```

- [ ] **Step 2: Write the failing jsdom test `InspectorRail.test.tsx`**

```tsx
// src/app/world/server/InspectorRail.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { InspectorRail } from './InspectorRail'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
} from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'
import { compileWorld, instanceId } from '../../../lib/world/compileWorld'
import type { WorldDoc } from '../../../lib/world/types'

function seed(configure: (doc: WorldDoc, serverId: string) => void) {
  const doc = createWorld()
  const r = createRegion('us-east-1'); const az = createAz(r.id, 'us-east-1a')
  const s = createServer(az.id, getPreset('vps-medium')!)
  doc.regions[r.id] = r; doc.azs[az.id] = az; doc.servers[s.id] = s
  configure(doc, s.id)
  useWorldStore.setState({ doc, history: [], future: [] })
  useSimulationStore.setState({ running: false, latestBatch: null, scrubBatch: null })
  return { doc, serverId: s.id }
}

describe('InspectorRail (read panels)', () => {
  beforeEach(() => useWorldStore.getState().newWorld())

  it('instance selection shows runtime, limits, and host resources', () => {
    const { doc, serverId } = seed((d, sid) => {
      d.servers[sid].stacks = [{ name: 'app', networks: [{ name: 'n', cidr: '172.18.0.0/16' }], volumes: [] }]
      const bp = createBlueprint('api', 1); d.blueprints[bp.id] = bp
      const pl = createPlacement(bp.id, sid)
      pl.runtime = { type: 'container', stackName: 'app', networkNames: ['n'], portMappings: [{ host: 3000, container: 8080 }], cpuLimit: 2, memLimitMb: 640 }
      d.placements['p'] = pl
    })
    const iid = instanceId('p', 0)
    render(<InspectorRail serverId={serverId} selection={{ kind: 'instance', instanceId: iid }} onSelect={() => {}} />)
    expect(screen.getByText('api')).toBeInTheDocument()
    expect(screen.getByText(/stack: app/)).toBeInTheDocument()
    expect(screen.getByText(/640/)).toBeInTheDocument()          // mem limit
  })

  it('firewall selection lists rules in order and drills into a rule', () => {
    const onSelect = vi.fn()
    const { serverId } = seed((d, sid) => {
      d.servers[sid].firewall = [
        { id: 'r1', action: 'allow', port: 443, protocol: 'tcp', source: 'any' },
        { id: 'r2', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' },
      ]
    })
    render(<InspectorRail serverId={serverId} selection={{ kind: 'firewall' }} onSelect={onSelect} />)
    expect(screen.getByText(/first match wins/i)).toBeInTheDocument()
    const rows = screen.getAllByTestId('fw-rule-row')
    expect(rows).toHaveLength(2)
    fireEvent.click(rows[1])
    expect(onSelect).toHaveBeenCalledWith({ kind: 'rule', ruleId: 'r2' })
  })

  it('volume panel lists consumers by volumeName', () => {
    const { serverId } = seed((d, sid) => {
      d.servers[sid].stacks = [{ name: 'app', networks: [], volumes: [{ name: 'pgdata', sizeGb: 12 }] }]
      const pg = createBlueprint('postgres', 2); pg.stateful = true; pg.volumeName = 'pgdata'
      d.blueprints[pg.id] = pg
      d.placements['p'] = createPlacement(pg.id, sid)
    })
    render(<InspectorRail serverId={serverId} selection={{ kind: 'volume', stackName: 'app', volumeName: 'pgdata' }} onSelect={() => {}} />)
    expect(screen.getByText(/postgres/)).toBeInTheDocument()
  })

  it('empty selection shows a hint', () => {
    const { serverId } = seed(() => {})
    render(<InspectorRail serverId={serverId} selection={null} onSelect={() => {}} />)
    expect(screen.getByText(/click any element/i)).toBeInTheDocument()
  })
})

import { vi } from 'vitest'
```

> Move the `import { vi } from 'vitest'` to the top with the other imports (shown at the bottom
> only for readability of this skeleton).

- [ ] **Step 3: Write `InspectorRail.tsx` (read panels)**

```tsx
// src/app/world/server/InspectorRail.tsx
// HUD inspector rail: a read panel per BoardSelection kind. Reads doc (useWorldStore) + live
// metrics (useServerDisplayMetrics); world writes arrive in T7's forms mounted here. Rule rows
// drill into `{kind:'rule'}`.
import type { ReactElement } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useCompiledWorld } from '../useCompiledWorld'
import { useServerDisplayMetrics } from './useServerDisplayMetrics'
import type { BoardSelection } from './selection'

const railText = { font: '7.5px var(--font-mono)', color: 'var(--color-text-secondary)', lineHeight: 1.9 } as const

export interface InspectorRailProps {
  serverId: string
  selection: BoardSelection | null
  onSelect: (s: BoardSelection | null) => void
}

export function InspectorRail({ serverId, selection, onSelect }: InspectorRailProps): ReactElement {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const display = useServerDisplayMetrics(serverId)
  const server = doc.servers[serverId]

  const header = (title: string) => (
    <div style={{ font: '8px var(--font-mono)', color: '#7CFFE9', letterSpacing: '0.1em', borderBottom: '1px solid #14332E', paddingBottom: 5 }}>▸ INSPECTOR — {title}</div>
  )

  let body: ReactElement
  if (!selection) {
    body = <div style={{ ...railText, color: 'var(--color-text-muted)', marginTop: 8 }}>click any element (chip · trace · gate · rule · core · volume) to inspect</div>
  } else if (selection.kind === 'instance') {
    const inst = compiled.instances[selection.instanceId]
    const bp = inst ? doc.blueprints[inst.blueprintId] : undefined
    const pl = inst ? doc.placements[inst.placementId] : undefined
    const m = display.instances[selection.instanceId]
    const rt = pl?.runtime
    const memLimit = rt?.type === 'container' ? rt.memLimitMb : null
    const oom = memLimit && m ? m.ramMb >= memLimit * 0.9 : false
    body = (
      <div style={{ ...railText, marginTop: 6 }}>
        <div style={{ color: '#DBEAFE' }}>{bp?.name}</div>
        <div>runtime <span style={{ color: '#C4B5FD' }}>{rt?.type}{rt?.type === 'container' ? ` · stack: ${rt.stackName}` : ''}</span></div>
        {rt?.type === 'container' && <div>binds <span style={{ color: '#9CC8FF' }}>{rt.portMappings.map(p => `:${p.host}→${p.container}`).join(' ') || '—'}</span></div>}
        {rt?.type === 'container' && <div>cpu {m?.cpuCoresUsed?.toFixed(1) ?? '—'}c of {rt.cpuLimit ?? '∞'}</div>}
        {rt?.type === 'container' && <div style={{ color: oom ? 'var(--color-danger)' : undefined }}>mem {m ? Math.round(m.ramMb) : '—'}M / {memLimit ?? '∞'}M {oom && '⚠'}</div>}
        <div style={{ marginTop: 7, color: '#475569', letterSpacing: '0.08em' }}>RESOURCES ON HOST</div>
        <div>p50 {m?.p50Ms?.toFixed(1) ?? '—'}ms · {m?.activeConnections ?? '—'} conn</div>
        {/* T7 mounts WorkloadForm + RuntimeForm below this line */}
      </div>
    )
  } else if (selection.kind === 'nic') {
    const sm = display.server
    body = <div style={{ ...railText, marginTop: 6 }}>
      <div>speed {server?.specs.nicMbps} Mbps</div>
      <div>in {sm ? Math.round(sm.nicInMbps) : '—'} · out {sm ? Math.round(sm.nicOutMbps) : '—'} Mb/s</div>
    </div>
  } else if (selection.kind === 'firewall' || selection.kind === 'rule') {
    body = <div style={{ ...railText, marginTop: 6 }}>
      <div style={{ color: '#475569' }}>first match wins · default deny</div>
      {(server?.firewall ?? []).map(r => (
        <div key={r.id} data-testid="fw-rule-row" onClick={() => onSelect({ kind: 'rule', ruleId: r.id })}
          style={{ cursor: 'pointer', color: r.action === 'allow' ? 'var(--color-success)' : 'var(--color-danger)', background: selection.kind === 'rule' && selection.ruleId === r.id ? '#ffffff08' : undefined }}>
          {r.action.toUpperCase()} :{r.port} {r.protocol} from {r.source}
        </div>
      ))}
      {/* T7 mounts FirewallEditor below */}
    </div>
  } else if (selection.kind === 'stack') {
    const st = server?.stacks.find(s => s.name === selection.stackName)
    const members = Object.values(compiled.instances).filter(i => {
      const pl = doc.placements[i.placementId]
      return i.serverId === serverId && pl?.runtime.type === 'container' && pl.runtime.stackName === selection.stackName
    })
    body = <div style={{ ...railText, marginTop: 6 }}>
      <div>networks {st?.networks.map(n => n.cidr).join(', ') || '—'}</div>
      <div>volumes {st?.volumes.map(v => `${v.name} ${v.sizeGb}G`).join(', ') || '—'}</div>
      <div>members {members.map(i => doc.blueprints[i.blueprintId]?.name).join(', ') || '—'}</div>
      {/* T7 mounts VolumesEditor below */}
    </div>
  } else if (selection.kind === 'volume') {
    const consumers = Object.values(doc.blueprints).filter(b => b.volumeName === selection.volumeName)
    const vol = server?.stacks.find(s => s.name === selection.stackName)?.volumes.find(v => v.name === selection.volumeName)
    body = <div style={{ ...railText, marginTop: 6 }}>
      <div>size {vol?.sizeGb ?? '—'}G</div>
      <div>consumers {consumers.map(b => b.name).join(', ') || '—'}</div>
    </div>
  } else if (selection.kind === 'hardware') {
    const sm = display.server
    body = <div style={{ ...railText, marginTop: 6 }}>
      {selection.part === 'cpu' && <div>cores {sm?.coreUtilization.length ?? server?.specs.vcpu} · steal {sm ? Math.round(sm.stealFraction * 100) : 0}%</div>}
      {selection.part === 'ram' && <div>ram {sm ? (sm.ramUsedMb / 1024).toFixed(1) : '—'}/{sm ? (sm.ramTotalMb / 1024).toFixed(0) : Math.round((server?.specs.ramMb ?? 0) / 1024)}G</div>}
      {selection.part === 'disk' && <div>io {sm ? Math.round(sm.diskIoFraction * 100) : 0}% · {server?.specs.diskGb}G</div>}
    </div>
  } else { // core
    const sm = display.server
    body = <div style={{ ...railText, marginTop: 6 }}>core {selection.coreIndex} · {sm ? Math.round((sm.coreUtilization[selection.coreIndex] ?? 0) * 100) : 0}%</div>
  }

  const title = selection?.kind === 'instance'
    ? (doc.blueprints[compiled.instances[selection.instanceId]?.blueprintId]?.name ?? 'instance')
    : (selection?.kind ?? 'server')
  return (
    <aside style={{ width: 240, borderLeft: '1px solid #1E2734', background: 'linear-gradient(180deg,#0D1117EE,#0A0D12EE)', padding: 10, overflowY: 'auto' }}>
      {header(title)}
      {body}
    </aside>
  )
}
```

- [ ] **Step 4: Hold selection + hover in `ServerView.tsx`; wire the rail + Esc**

Replace the T3 `<aside>` placeholder and noop props:

```tsx
const [selection, setSelection] = useState<BoardSelection | null>(null)
const [hoveredBlueprintId, setHoveredBlueprintId] = useState<BlueprintId | null>(null)
const selRef = useRef(selection)
selRef.current = selection

useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && selRef.current) {
      e.preventDefault()          // capture phase → WorldShell's bubble Esc sees defaultPrevented and skips nav.up
      setSelection(null)
    }
  }
  window.addEventListener('keydown', onKey, true)     // CAPTURE
  return () => window.removeEventListener('keydown', onKey, true)
}, [])

// clear selection when navigating to a different server
useEffect(() => { setSelection(null); setHoveredBlueprintId(null) }, [serverId])
```

Pass real props to `<ServerBoard selection={selection} onSelect={setSelection} hoveredBlueprintId={hoveredBlueprintId} onHoverBlueprint={setHoveredBlueprintId} />` and render
`<InspectorRail serverId={serverId} selection={selection} onSelect={setSelection} />` instead of the `<aside>`.

- [ ] **Step 5: Wire dim/glow in `ServerBoard.tsx`**

Compute per-chip `dimmed = hoveredBlueprintId !== null && chip.blueprintId !== hoveredBlueprintId`
and `hovered = chip.blueprintId === hoveredBlueprintId`; pass into `ServiceChip`. Compute
`selected` from `selection` (`selection?.kind==='instance' && selection.instanceId===chip.instanceId`).
Pass `dimmed` to `StackPlate` (dim when its members aren't the hovered blueprint), and pass
`hoveredBlueprintId` to `HardwarePlatform` (already dims per-stratum/core in T4) and `TraceLayer`.
Under `prefers-reduced-motion` the components already omit transitions (T3/T4 used inline
transitions — gate them behind `useReducedMotion()` where present).

- [ ] **Step 6: Tests + build + commit**

Run: `npx vitest run src/app/world/server/InspectorRail.test.tsx` → PASS (4 tests).
Run: `npm run build`, `npx vitest run` → green.

Add a jsdom test `esc clears selection without changing nav level` and `hovering a chip dims
unrelated chips and highlights its ram stratum` (render `ServerView` with seeded stores; fire a
capture-phase `keydown` Escape and assert `useNavStore.getState().level` stays `'server'`; fire
`mouseEnter` on one chip and assert unrelated chips get opacity 0.45). These live in
`InspectorRail.test.tsx` or a sibling `ServerView.interaction.test.tsx`.

```bash
git add src/app/world/server/selection.ts src/app/world/server/InspectorRail.tsx \
        src/app/world/server/InspectorRail.test.tsx src/app/world/ServerView.tsx \
        src/app/world/server/ServerBoard.tsx src/app/world/server/ServiceChip.tsx \
        src/app/world/server/StackPlate.tsx src/app/world/server/TraceLayer.tsx \
        src/app/world/server/HardwarePlatform.tsx
git commit -m "feat(server-view): selection model, HUD inspector rail, signature cross-highlight"
```

---

## Task 7: Inspector editing forms + edit-lock `[sonnet]`

**Files:** create `inspectorForms.tsx`; extend `InspectorRail.tsx` to mount the matching form
under each read panel; extend `InspectorRail.test.tsx`.

**Grounding:** write surface (verified `world.store.ts:72-78`): `updateBlueprint(id, patch:
Partial<ServiceBlueprint>)`, `updatePlacement(id, patch: Partial<Placement>)`, `updateServer(id,
patch: Partial<Server>)` — all patch-merge via `mutate` (pushes history). `WorkloadProfile =
{ cpuMsPerRequest, ramBaseMb, ramPerConnMb, diskIoPerRequest }`. Container runtime =
`{ type:'container', stackName, networkNames, portMappings:[{host,container}], cpuLimit:number|null,
memLimitMb:number|null }`. `FirewallRule = { id, action:'allow'|'deny', port:number|'any',
protocol:'tcp'|'udp'|'any', source }`. `ComposeStack.volumes = [{name,sizeGb}]`. `running` from
`useSimulationStore`. All edits recompile automatically via `useCompiledWorld` (doc-keyed memo).

- [ ] **Step 1: Write the failing tests (append to `InspectorRail.test.tsx`)**

```tsx
describe('inspector editing forms', () => {
  it('workload form patches blueprint via updateBlueprint', () => {
    const spy = vi.spyOn(useWorldStore.getState(), 'updateBlueprint')
    const { doc } = seed((d, sid) => {
      const bp = createBlueprint('api', 1); d.blueprints[bp.id] = bp
      d.placements['p'] = createPlacement(bp.id, sid)
    })
    const bpId = Object.keys(doc.blueprints)[0]
    render(<WorkloadForm blueprintId={bpId} />)
    const input = screen.getByLabelText('cpuMsPerRequest')
    fireEvent.change(input, { target: { value: '12' } })
    fireEvent.blur(input)
    expect(spy).toHaveBeenCalledWith(bpId, expect.objectContaining({ workload: expect.objectContaining({ cpuMsPerRequest: 12 }) }))
  })

  it('firewall reorder swaps array order', () => {
    const spy = vi.spyOn(useWorldStore.getState(), 'updateServer')
    const { serverId } = seed((d, sid) => {
      d.servers[sid].firewall = [
        { id: 'r1', action: 'allow', port: 443, protocol: 'tcp', source: 'any' },
        { id: 'r2', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' },
      ]
    })
    render(<FirewallEditor serverId={serverId} />)
    fireEvent.click(screen.getAllByLabelText('move rule down')[0])
    expect(spy).toHaveBeenCalledWith(serverId, { firewall: [
      expect.objectContaining({ id: 'r2' }), expect.objectContaining({ id: 'r1' }),
    ] })
  })

  it('adding an allow rule above the deny unblocks the compiled path', () => {
    // recompiled-fixture assertion (not DOM): allow :5432 above deny → path permitted
    const { doc, serverId } = seed((d, sid) => {
      const web = createBlueprint('web', 0); web.ports = [{ port: 8080, protocol: 'tcp', visibility: 'public' }]
      const db = createBlueprint('db', 2)
      web.dependencies = [{ id: 'd', target: { kind: 'blueprint', blueprintId: db.id }, port: 5432, protocol: 'db', packetTemplateId: null }]
      d.blueprints[web.id] = web; d.blueprints[db.id] = db
      d.placements['p1'] = createPlacement(web.id, sid); d.placements['p2'] = createPlacement(db.id, sid)
      d.servers[sid].firewall = [{ id: 'deny', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' }]
    })
    expect(compileWorld(doc).paths.some(p => p.verdict === 'blocked')).toBe(true)
    useWorldStore.getState().updateServer(serverId, { firewall: [
      { id: 'allow', action: 'allow', port: 5432, protocol: 'tcp', source: 'any' },
      { id: 'deny', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' },
    ] })
    expect(compileWorld(useWorldStore.getState().doc).paths.some(p => p.verdict === 'blocked')).toBe(false)
  })

  it('invalid numeric input does not fire an update', () => {
    const spy = vi.spyOn(useWorldStore.getState(), 'updateBlueprint')
    const { doc } = seed((d, sid) => { const bp = createBlueprint('api', 1); d.blueprints[bp.id] = bp; d.placements['p'] = createPlacement(bp.id, sid) })
    render(<WorkloadForm blueprintId={Object.keys(doc.blueprints)[0]} />)
    const input = screen.getByLabelText('ramBaseMb')
    fireEvent.change(input, { target: { value: 'abc' } })
    fireEvent.blur(input)
    expect(spy).not.toHaveBeenCalled()
  })

  it('all forms disabled while running', () => {
    useSimulationStore.setState({ running: true })
    const { serverId } = seed(() => {})
    render(<FirewallEditor serverId={serverId} />)
    expect(screen.getByLabelText('add rule')).toBeDisabled()
  })
})
```

(imports: add `WorkloadForm`, `FirewallEditor` from `./inspectorForms`.)

- [ ] **Step 2: Write `inspectorForms.tsx`**

```tsx
// src/app/world/server/inspectorForms.tsx
// Edit forms mounted inside the InspectorRail panels. Every form sits in <fieldset
// disabled={running}> (D9); numeric inputs clamp ≥0 and reject NaN (keep last valid). All writes
// go through existing world.store actions; recompile is automatic via useCompiledWorld.
import { useState, type ReactElement } from 'react'
import { useSimulationStore } from '../../store/simulation.store'
import { useWorldStore } from '../../store/world.store'
import type { WorkloadProfile, FirewallRule, ComposeVolume } from '../../../lib/world/types'

const lockNote = { font: '6.5px var(--font-mono)', color: 'var(--color-text-muted)', marginTop: 4 } as const
const fs = (running: boolean): React.CSSProperties => ({ border: 'none', margin: 0, padding: 0, opacity: running ? 0.55 : 1 })
const inp: React.CSSProperties = { width: 52, background: 'var(--color-node-base)', border: '1px solid #2A3648', borderRadius: 3, color: '#E2E8F0', font: '7px var(--font-mono)', padding: '1px 4px' }

function NumberField({ label, value, onCommit }: { label: string; value: number; onCommit: (n: number) => void }) {
  const [text, setText] = useState(String(value))
  return (
    <label style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
      <span>{label}</span>
      <input aria-label={label} style={inp} value={text}
        onChange={e => setText(e.target.value)}
        onBlur={() => { const n = Number(text); if (Number.isFinite(n) && n >= 0) onCommit(n); else setText(String(value)) }}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
    </label>
  )
}

export function WorkloadForm({ blueprintId }: { blueprintId: string }): ReactElement {
  const running = useSimulationStore(s => s.running)
  const bp = useWorldStore(s => s.doc.blueprints[blueprintId])
  const update = useWorldStore(s => s.updateBlueprint)
  if (!bp) return <></>
  const set = (patch: Partial<WorkloadProfile>) => update(blueprintId, { workload: { ...bp.workload, ...patch } })
  return (
    <fieldset disabled={running} style={fs(running)}>
      <div style={{ font: '6.5px var(--font-mono)', color: '#475569', marginTop: 7, letterSpacing: '0.08em' }}>WORKLOAD</div>
      <NumberField label="cpuMsPerRequest" value={bp.workload.cpuMsPerRequest} onCommit={v => set({ cpuMsPerRequest: v })} />
      <NumberField label="ramBaseMb" value={bp.workload.ramBaseMb} onCommit={v => set({ ramBaseMb: v })} />
      <NumberField label="ramPerConnMb" value={bp.workload.ramPerConnMb} onCommit={v => set({ ramPerConnMb: v })} />
      <NumberField label="diskIoPerRequest" value={bp.workload.diskIoPerRequest} onCommit={v => set({ diskIoPerRequest: v })} />
      <label style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
        <span>color</span>
        <input aria-label="signature color" type="color" value={bp.color} onChange={e => update(blueprintId, { color: e.target.value })} />
      </label>
      {running && <div style={lockNote}>stop simulation to edit</div>}
    </fieldset>
  )
}

export function RuntimeForm({ placementId }: { placementId: string }): ReactElement {
  const running = useSimulationStore(s => s.running)
  const pl = useWorldStore(s => s.doc.placements[placementId])
  const server = useWorldStore(s => (pl ? s.doc.servers[pl.serverId] : undefined))
  const update = useWorldStore(s => s.updatePlacement)
  if (!pl) return <></>
  if (pl.runtime.type !== 'container') {
    return <div style={{ ...lockNote, marginTop: 6 }}>process runtime — limits/ports are container-only. Switch runtime in the Placements panel.</div>
  }
  const rt = pl.runtime
  const setRt = (patch: Partial<typeof rt>) => update(placementId, { runtime: { ...rt, ...patch } })
  const networks = server?.stacks.find(s => s.name === rt.stackName)?.networks ?? []
  return (
    <fieldset disabled={running} style={fs(running)}>
      <div style={{ font: '6.5px var(--font-mono)', color: '#475569', marginTop: 7, letterSpacing: '0.08em' }}>LIMITS</div>
      <NumberField label="cpuLimit" value={rt.cpuLimit ?? 0} onCommit={v => setRt({ cpuLimit: v || null })} />
      <NumberField label="memLimitMb" value={rt.memLimitMb ?? 0} onCommit={v => setRt({ memLimitMb: v || null })} />
      <div style={{ marginTop: 4 }}>networks: {networks.map(n => (
        <label key={n.name} style={{ marginRight: 6 }}>
          <input type="checkbox" checked={rt.networkNames.includes(n.name)}
            onChange={e => setRt({ networkNames: e.target.checked ? [...rt.networkNames, n.name] : rt.networkNames.filter(x => x !== n.name) })} />
          {n.name}
        </label>
      ))}</div>
      {running && <div style={lockNote}>stop simulation to edit</div>}
    </fieldset>
  )
}

export function FirewallEditor({ serverId }: { serverId: string }): ReactElement {
  const running = useSimulationStore(s => s.running)
  const server = useWorldStore(s => s.doc.servers[serverId])
  const update = useWorldStore(s => s.updateServer)
  if (!server) return <></>
  const rules = server.firewall
  const commit = (next: FirewallRule[]) => update(serverId, { firewall: next })
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= rules.length) return
    const next = [...rules]; [next[i], next[j]] = [next[j], next[i]]; commit(next)
  }
  const patch = (i: number, p: Partial<FirewallRule>) => commit(rules.map((r, k) => (k === i ? { ...r, ...p } : r)))
  return (
    <fieldset disabled={running} style={fs(running)}>
      {rules.map((r, i) => (
        <div key={r.id} style={{ display: 'flex', gap: 3, alignItems: 'center', marginTop: 3 }}>
          <select aria-label="action" value={r.action} onChange={e => patch(i, { action: e.target.value as FirewallRule['action'] })}><option value="allow">allow</option><option value="deny">deny</option></select>
          <input aria-label="port" style={{ ...inp, width: 40 }} value={String(r.port)} onChange={e => patch(i, { port: e.target.value === 'any' ? 'any' : (Number(e.target.value) || 'any') })} />
          <select aria-label="protocol" value={r.protocol} onChange={e => patch(i, { protocol: e.target.value as FirewallRule['protocol'] })}><option value="tcp">tcp</option><option value="udp">udp</option><option value="any">any</option></select>
          <button aria-label="move rule up" onClick={() => move(i, -1)}>↑</button>
          <button aria-label="move rule down" onClick={() => move(i, 1)}>↓</button>
          <button aria-label="remove rule" onClick={() => commit(rules.filter((_, k) => k !== i))}>✕</button>
        </div>
      ))}
      <button aria-label="add rule" style={{ marginTop: 4 }} onClick={() => commit([...rules, { id: `fw-${Date.now().toString(36)}`, action: 'allow', port: 'any', protocol: 'tcp', source: 'any' }])}>+ add rule</button>
      {running && <div style={lockNote}>stop simulation to edit</div>}
    </fieldset>
  )
}

export function VolumesEditor({ serverId, stackName }: { serverId: string; stackName: string }): ReactElement {
  const running = useSimulationStore(s => s.running)
  const server = useWorldStore(s => s.doc.servers[serverId])
  const update = useWorldStore(s => s.updateServer)
  if (!server) return <></>
  const stack = server.stacks.find(s => s.name === stackName)
  if (!stack) return <></>
  const commitVols = (volumes: ComposeVolume[]) => update(serverId, { stacks: server.stacks.map(s => (s.name === stackName ? { ...s, volumes } : s)) })
  return (
    <fieldset disabled={running} style={fs(running)}>
      {stack.volumes.map((v, i) => (
        <div key={v.name} style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 3 }}>
          <span>{v.name}</span>
          <NumberField label={`size-${v.name}`} value={v.sizeGb} onCommit={n => commitVols(stack.volumes.map((x, k) => (k === i ? { ...x, sizeGb: n } : x)))} />
          <button aria-label={`remove volume ${v.name}`} onClick={() => commitVols(stack.volumes.filter((_, k) => k !== i))}>✕</button>
        </div>
      ))}
      <button aria-label="add volume" onClick={() => commitVols([...stack.volumes, { name: `vol-${stack.volumes.length + 1}`, sizeGb: 10 }])}>+ add volume</button>
      {running && <div style={lockNote}>stop simulation to edit</div>}
    </fieldset>
  )
}
```

- [ ] **Step 3: Mount forms in `InspectorRail.tsx`**

Under the instance read panel render `<WorkloadForm blueprintId={inst.blueprintId} />` and, when
the placement is a container, `<RuntimeForm placementId={inst.placementId} />`. Under the
firewall/rule panel render `<FirewallEditor serverId={serverId} />`. Under the stack panel render
`<VolumesEditor serverId={serverId} stackName={selection.stackName} />`.

- [ ] **Step 4: Tests + build**

Run: `npx vitest run src/app/world/server/InspectorRail.test.tsx` → PASS.
Run: `npm run build`, `npx vitest run` → green.

- [ ] **Step 5: Live smoke** — with the T3 blocked world: Stop → select the firewall → add an
allow rule above the deny → the red trace flips teal (recompiled). Select the api chip → raise
`memLimitMb`; nav away and back → the value persists. Start the sim → all rail edit controls
disabled. Zero console errors; screenshot `task7-edit-unblock.png`. Stop dev.

- [ ] **Step 6: Commit**

```bash
git add src/app/world/server/inspectorForms.tsx src/app/world/server/InspectorRail.tsx \
        src/app/world/server/InspectorRail.test.tsx
git commit -m "feat(server-view): inspector editing (workload, runtime, firewall, volumes) with sim edit-lock"
```

---

## Task 8: PlacementPanel MANAGED_TYPES ↔ CLOUD_REGISTRY alignment `[haiku]`

**Files:** modify `src/app/world/panels/PlacementPanel.tsx`, `src/lib/costModelV2.ts` (+ its test).

**Grounding (verified):** `PlacementPanel.tsx:6` `const MANAGED_TYPES = ['rds','s3','sqs','redis',
'cdn','apiGateway','lambda']`; the select writes `msType` verbatim into `nodeType` and
`msType.toUpperCase()` into the label (`PlacementPanel.tsx:48-51`). `costModelV2.ts:19-20`
`MANAGED_TYPE_ALIASES = { rds:'dbSql', s3:'objectStorage', sqs:'queue' }`, used by
`managedServiceMonthlyUsd` (`getServiceSpec(MANAGED_TYPE_ALIASES[nodeType] ?? nodeType, provider)`).
So the registry keys for the three human aliases are `dbSql`/`objectStorage`/`queue`; `redis`,
`cdn`, `apiGateway`, `lambda` already ARE registry keys.

- [ ] **Step 1: Change `MANAGED_TYPES` to registry keys with readable labels**

In `PlacementPanel.tsx`, replace line 6 and the select + add handler:

```tsx
// Author managed services with CLOUD_REGISTRY keys directly (D12) so Cost v2 prices them without
// the alias table. Labels stay human-readable.
const MANAGED_TYPES: { key: string; label: string }[] = [
  { key: 'dbSql', label: 'SQL DB' },
  { key: 'objectStorage', label: 'Object store' },
  { key: 'queue', label: 'Queue' },
  { key: 'redis', label: 'Redis' },
  { key: 'cdn', label: 'CDN' },
  { key: 'apiGateway', label: 'API Gateway' },
  { key: 'lambda', label: 'Lambda' },
]
```

Update `useState(MANAGED_TYPES[0])` → `useState(MANAGED_TYPES[0].key)`; the `<select>` options to
`<option key={t.key} value={t.key}>{t.label}</option>`; and the add handler to use the key for
`nodeType` and the label for the display label:
`store.addManagedService(msType, MANAGED_TYPES.find(t => t.key === msType)?.label ?? msType, scope, 5432)`.

- [ ] **Step 2: costModelV2 — keep aliases (legacy load-bearing), update the comment**

Do NOT delete `MANAGED_TYPE_ALIASES` — old `.scalemap` files saved with `rds`/`s3`/`sqs` still
load and must price. Update the comment above it to note new authoring emits registry keys
directly; the aliases now only bridge legacy documents. No behavior change.

- [ ] **Step 3: Tests (`costModelV2.test.ts`)**

Add two cases: (a) a doc authored with the NEW key prices without the alias —
`managedServiceMonthlyUsd('dbSql','aws') > 0` (assert via the public cost function on a fixture
world whose managed service has `nodeType: 'dbSql'`); (b) a LEGACY doc with `nodeType:'rds'`
still prices `> 0`. Run: `npx vitest run src/lib/costModelV2.test.ts` → PASS.

- [ ] **Step 4: Build + commit**

Run: `npm run build`, `npx vitest run` → green.

```bash
git add src/app/world/panels/PlacementPanel.tsx src/lib/costModelV2.ts src/lib/costModelV2.test.ts
git commit -m "refactor(world): author managed services with CLOUD_REGISTRY keys"
```

---

## Task 9: Final integration, full live smoke, boundaries §L `[sonnet]`

**Files:** modify `docs/module-boundaries.md` (add §L); fix any accumulated Minors the controller
queued; run the whole verification battery; append the `## PHASE 3` ledger summary.

- [ ] **Step 1: Add `docs/module-boundaries.md` §L — Server interior (Level 4)**

Document: the `src/app/world/server/` file list (boardLayout + 10 components + hooks/forms);
boundary rules — `server/` imports `lib/` (world types, worldEngine types, boardLayout) and app
stores (`world.store`, `simulation.store`, `nav.store` read; `world.store` actions for writes) but
NOTHING under `panels/`; the engine facade is untouched except T2's server-particle branch +
`__test_render` test hook; `boardLayout.ts` is a pure hub imported by every server component
(low-risk, high fan-in — change its exported shapes deliberately). Note the scale-to-fit /
fixed-1000×560 stage invariant and the "renderer attaches once per (serverId, running)" rule.

- [ ] **Step 2: Full verification battery**

Run: `npx vitest run` → ALL suites green (record the count).
Run: `npm run build` → succeeds (strict tsc + vite).

- [ ] **Step 3: Full end-to-end live smoke (the phase gate — controller-run, port 1420)**

Execute the spec's Testing script end-to-end and capture screenshots at each milestone:
author region→AZ→server with a compose stack + a process placement + a firewall-blocked
dependency (via UI + the DEV `window.__scalemapDebug` hook where the UI can't author public
ports/deps) → the server board renders all zones (NIC, gate, chips, stack plate, hardware
platform) → a static red-dashed blocked trace shows its rule label → Simulate → packets traverse
the traces, the hardware platform is live (cores/ring/steal, RAM strata, disk scanner, NIC bar),
the gate counts blocks → Stop → fix the firewall via the inspector rail → the trace flips
permitted (teal) → hover a chip → cross-highlight dims unrelated elements and glows its
stratum/core/slice → scrub → historical strata render. Assert ZERO app console errors throughout
(benign Vite HMR WS blips excepted). Save screenshots to `.superpowers/sdd/screenshots/`.

- [ ] **Step 4: Ledger + drift**

Append to `.superpowers/sdd/progress.md` under `## PHASE 3`: per-task completion lines, open
items, and contract-drift state (the `__test_render` additive test hook is the only engine-surface
addition; no frozen-type change). If any forced contract change occurred, it is already logged in
`.superpowers/sdd/contract-drift.md` under `## PHASE 3`.

- [ ] **Step 5: Commit**

```bash
git add docs/module-boundaries.md .superpowers/sdd/progress.md
git commit -m "docs: update module boundaries for the server interior (§L)"
```

<!-- COMPLETE -->
