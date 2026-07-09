# Phase 3 plan fragment — Tasks 3–5 (static stage · hardware platform · packet layer)

> Fragment scope: Task 3 (static circuit-board stage), Task 4 (live hardware platform + display
> metrics), Task 5 (engine-driven packet layer + gate stats). Imports T1's `BoardLayout`/
> `StaticTrace`/`ChipLayout`/`attributeCores` and T2's server-scope particles. Global
> Constraints / File Structure live in the assembled header. Scene-accent hexes are LOCAL
> constants per component (no new global tokens); semantic colors use `var(--color-*)`.

**Shared local scene constants (each component declares only what it uses):**
`PCB_GRID = '#101620'`, `STAGE_BG = 'radial-gradient(ellipse at 40% 35%, #0C1018 0%, #07090D 70%)'`,
`ACCENT_TEAL = '#2DD4BF'`, `TEAL_TEXT = '#7CFFE9'`, `NIC_BG = 'linear-gradient(90deg,#0A2A26,#0E1A18)'`,
`GATE_AMBER = '#F59E0B'`, `PROTOCOL_COLOR = { http:'#4A9EFF', db:'#F5A623', event:'#A78BFA', stream:'#2DD4BF' }`.

---

## Task 3: Static stage — ServerBoard, chips, plates, gate, NIC, traces `[sonnet]`

**Files:** create `ServerBoard.tsx`, `ServiceChip.tsx`, `StackPlate.tsx`, `FirewallGate.tsx`,
`NicBlock.tsx`, `TraceLayer.tsx`, `ServerBoard.test.tsx` under `src/app/world/server/`;
REWRITE `src/app/world/ServerView.tsx`.

**Grounding:** `nav.store` exposes `serverId` (view is only mounted at `level==='server'`);
`useCompiledWorld()` returns `{ instances, paths, findings, ... }`; `doc.azs[server.azId].label`
is the AZ label; `server.rack = { rackId, unit }`; `ServiceBlueprint.ports[].visibility`,
`Placement.runtime` (process|container with `portMappings:[{host,container}]`). Views may read
`useWorldStore`/`useSimulationStore`; world writes go only through store actions (none here).

- [ ] **Step 1: Write the failing jsdom test `ServerBoard.test.tsx`**

```tsx
// src/app/world/server/ServerBoard.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ServerBoard } from './ServerBoard'
import { ServerView } from '../ServerView'
import { layoutServerBoard, serverTraces, MAX_BOARD_CHIPS } from './boardLayout'
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
} from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'
import { compileWorld } from '../../../lib/world/compileWorld'
import type { WorldDoc, ComposeStack } from '../../../lib/world/types'

beforeAll(() => {
  // jsdom lacks ResizeObserver, which ServerBoard uses for scale-to-fit.
  class RO { observe() {} unobserve() {} disconnect() {} }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO
})

const stack = (name: string): ComposeStack => ({ name, networks: [{ name: 'net', cidr: '172.18.0.0/16' }], volumes: [] })

function seed(configure: (doc: WorldDoc, serverId: string) => void) {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const az = createAz(region.id, 'us-east-1a')
  const server = createServer(az.id, getPreset('vps-medium')!)
  server.label = 'web-01'
  doc.regions[region.id] = region; doc.azs[az.id] = az; doc.servers[server.id] = server
  configure(doc, server.id)
  useWorldStore.setState({ doc, history: [], future: [] })
  useNavStore.setState({ level: 'server', regionId: region.id, azId: az.id, serverId: server.id })
  return { doc, server }
}

function renderBoard(doc: WorldDoc, serverId: string) {
  const compiled = compileWorld(doc)
  const server = doc.servers[serverId]
  const layout = layoutServerBoard(server, doc, compiled)
  const traces = serverTraces(serverId, doc, compiled)
  render(
    <ServerBoard
      serverId={serverId} layout={layout} traces={traces}
      selection={null} onSelect={() => {}} hoveredBlueprintId={null} onHoverBlueprint={() => {}}
    />,
  )
  return { layout, traces }
}

describe('ServerBoard (static stage)', () => {
  beforeEach(() => useWorldStore.getState().newWorld())

  it('renders a chip per resident instance with signature color', () => {
    const { doc, server } = seed((d, sid) => {
      const bp = createBlueprint('nginx', 0)
      d.blueprints[bp.id] = bp
      d.placements['p'] = createPlacement(bp.id, sid)
    })
    renderBoard(doc, server.id)
    const chip = screen.getByText('nginx').closest('[data-chip]') as HTMLElement
    expect(chip).toBeInTheDocument()
    // signature-color tab present
    expect(chip.querySelector('[data-chip-tab]')).toBeTruthy()
  })

  it('container chips render inside their stack plate', () => {
    const { doc, server } = seed((d, sid) => {
      d.servers[sid].stacks = [stack('app')]
      const bp = createBlueprint('api', 1)
      d.blueprints[bp.id] = bp
      const pl = createPlacement(bp.id, sid)
      pl.runtime = { type: 'container', stackName: 'app', networkNames: [], portMappings: [{ host: 3000, container: 8080 }], cpuLimit: null, memLimitMb: null }
      d.placements[pl.id] = pl
    })
    renderBoard(doc, server.id)
    expect(screen.getByText(/stack: app/)).toBeInTheDocument()
    expect(screen.getByText('api')).toBeInTheDocument()
    expect(screen.getByText(/3000.*8080/)).toBeInTheDocument()   // :host→container
  })

  it('blocked trace renders dashed with rule label', () => {
    const { doc, server } = seed((d, sid) => {
      const web = createBlueprint('web', 0); web.ports = [{ port: 8080, protocol: 'tcp', visibility: 'public' }]
      const db = createBlueprint('db', 2)
      web.dependencies = [{ id: 'd', target: { kind: 'blueprint', blueprintId: db.id }, port: 5432, protocol: 'db', packetTemplateId: null }]
      d.blueprints[web.id] = web; d.blueprints[db.id] = db
      d.placements['p1'] = createPlacement(web.id, sid)
      d.placements['p2'] = createPlacement(db.id, sid)
      d.servers[sid].firewall = [
        { id: 'deny', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' },
        { id: 'allow', action: 'allow', port: 'any', protocol: 'any', source: 'internal' },
      ]
    })
    const { traces } = renderBoard(doc, server.id)
    expect(traces.some(t => t.verdict === 'blocked')).toBe(true)
    const dashed = document.querySelector('path[stroke-dasharray]')
    expect(dashed).toBeTruthy()
  })

  it('renders overflow chip when instances exceed MAX_BOARD_CHIPS', () => {
    const { doc, server } = seed((d, sid) => {
      for (let i = 0; i < MAX_BOARD_CHIPS + 2; i++) {
        const bp = createBlueprint(`svc${i}`, i); d.blueprints[bp.id] = bp
        d.placements[`p${i}`] = createPlacement(bp.id, sid)
      }
    })
    renderBoard(doc, server.id)
    expect(screen.getByText(/\+2 more/)).toBeInTheDocument()
  })

  it('header shows specs and rack position', () => {
    seed((d, sid) => { d.servers[sid].rack = { rackId: 'A1', unit: 7, heightU: 1 } })
    render(<ServerView />)
    expect(screen.getByText(/web-01/)).toBeInTheDocument()
    expect(screen.getByText(/vCPU/)).toBeInTheDocument()
    expect(screen.getByText(/A1/)).toBeInTheDocument()
    expect(screen.getByText(/U7/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/world/server/ServerBoard.test.tsx`
Expected: FAIL — `Cannot find module './ServerBoard'`.

- [ ] **Step 3: Write `TraceLayer.tsx`**

```tsx
// src/app/world/server/TraceLayer.tsx
// SVG etched traces beneath the DOM blocks (z0). One <path> per StaticTrace via
// layout.tracePath; permitted = protocol-colored with a soft glow, blocked = danger dashed with
// the rule label at the path midpoint. Paths are clickable (T6 refines to trace inspect).
import type { ReactElement } from 'react'
import type { BoardLayout, StaticTrace } from './boardLayout'
import type { BlueprintId } from '../../../lib/world/types'
import type { BoardSelection } from './selection'

const PROTOCOL_COLOR: Record<StaticTrace['protocol'], string> = {
  http: '#4A9EFF', db: '#F5A623', event: '#A78BFA', stream: '#2DD4BF',
}

export interface TraceLayerProps {
  layout: BoardLayout
  traces: StaticTrace[]
  selection: BoardSelection | null
  onSelect: (s: BoardSelection | null) => void
  hoveredBlueprintId: BlueprintId | null
}

export function TraceLayer({ layout, traces, onSelect }: TraceLayerProps): ReactElement {
  return (
    <svg width={layout.stageW} height={layout.stageH}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {traces.map((t, i) => {
        const d = layout.tracePath(t.fromId, t.toId)
        if (!d) return null
        const blocked = t.verdict === 'blocked'
        const color = blocked ? 'var(--color-danger)' : PROTOCOL_COLOR[t.protocol]
        const a = layout.anchorFor(t.fromId)
        const b = layout.anchorFor(t.toId)
        const mx = a && b ? (a.x + b.x) / 2 : 0
        const my = a && b ? (a.y + b.y) / 2 : 0
        return (
          <g key={i}>
            <path
              d={d} fill="none" stroke={color}
              strokeWidth={blocked ? 1.6 : 2.2}
              strokeDasharray={blocked ? '4 4' : undefined}
              opacity={blocked ? 0.85 : 0.85}
              style={{ filter: blocked ? undefined : `drop-shadow(0 0 4px ${color})`, cursor: 'pointer', pointerEvents: 'stroke' }}
              onClick={() => onSelect(null)}
            />
            {blocked && t.label && (
              <text x={mx + 6} y={my - 4} fill="#FF8A8A" fontSize={8} style={{ pointerEvents: 'none' }}>
                refused — {t.label}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}
```

- [ ] **Step 4: Write `NicBlock.tsx`**

```tsx
// src/app/world/server/NicBlock.tsx
// Teal edge connector on the left rail. T4 adds the live in/out bar; T3 shows the link speed.
import type { CSSProperties, ReactElement } from 'react'
import type { Box } from './boardLayout'

const TEAL = '#2DD4BF', TEAL_TEXT = '#7CFFE9'

export interface NicBlockProps {
  box: Box
  nicMbps: number
  inMbps?: number
  outMbps?: number
  utilFraction?: number        // (in+out)/nicMbps, 0..1 — T4
  selected?: boolean
  dimmed?: boolean
  onSelect?: () => void
  onHover?: (v: boolean) => void
}

export function NicBlock({ box, nicMbps, inMbps, outMbps, utilFraction, selected, dimmed, onSelect, onHover }: NicBlockProps): ReactElement {
  const style: CSSProperties = {
    position: 'absolute', left: box.x, top: box.y, width: box.w,
    background: 'linear-gradient(90deg,#0A2A26,#0E1A18)',
    border: `1px solid ${selected ? TEAL : '#2DD4BF66'}`, borderLeft: `3px solid ${TEAL}`,
    borderRadius: '0 6px 6px 0', padding: 6, boxShadow: '0 0 14px #2DD4BF22', cursor: 'pointer',
    opacity: dimmed ? 0.45 : 1, font: '8px var(--font-mono)',
  }
  return (
    <div data-nic style={style} onClick={onSelect}
      onMouseEnter={() => onHover?.(true)} onMouseLeave={() => onHover?.(false)}>
      <div style={{ color: TEAL_TEXT, fontSize: 8.5 }}>eth0</div>
      <div style={{ color: '#5EEAD4', opacity: 0.8 }}>{nicMbps} Mbps</div>
      {inMbps !== undefined && outMbps !== undefined && (
        <div style={{ color: 'var(--color-text-secondary)', marginTop: 3 }}>↓{Math.round(inMbps)} ↑{Math.round(outMbps)} Mb/s</div>
      )}
      <div style={{ height: 3, background: '#0F2B27', borderRadius: 2, marginTop: 3 }}>
        <div style={{ width: `${Math.min(100, (utilFraction ?? 0) * 100)}%`, height: '100%', background: TEAL, borderRadius: 2, boxShadow: `0 0 4px ${TEAL}` }} />
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Write `FirewallGate.tsx`**

```tsx
// src/app/world/server/FirewallGate.tsx
// Amber gate arch the NIC traffic threads through. T5 adds the blocked/s line.
import type { CSSProperties, ReactElement } from 'react'
import type { Box } from './boardLayout'

const AMBER = '#F59E0B'

export interface FirewallGateProps {
  box: Box
  ruleCount: number
  blockedPerSecond?: number       // T5
  selected?: boolean
  dimmed?: boolean
  onSelect?: () => void
}

export function FirewallGate({ box, ruleCount, blockedPerSecond, selected, dimmed, onSelect }: FirewallGateProps): ReactElement {
  const arch: CSSProperties = {
    position: 'absolute', inset: 0, border: `1.5px solid ${selected ? AMBER : '#F59E0BAA'}`,
    borderRadius: 8, background: 'linear-gradient(180deg,#F59E0B11,#F59E0B04)',
    boxShadow: '0 0 16px #F59E0B33, inset 0 0 12px #F59E0B22',
  }
  return (
    <div data-firewall
      style={{ position: 'absolute', left: box.x, top: box.y, width: box.w, height: box.h, cursor: 'pointer', opacity: dimmed ? 0.45 : 1 }}
      onClick={onSelect}>
      <div style={arch} />
      <div style={{ position: 'absolute', top: -14, width: '100%', textAlign: 'center', fontSize: 9, color: '#FBBF24', textShadow: `0 0 6px ${AMBER}` }}>🛡</div>
      <div style={{ position: 'absolute', bottom: -26, width: 130, left: (box.w - 130) / 2, textAlign: 'center', fontSize: 7, color: '#D9A24A', font: '7px var(--font-mono)' }}>
        FIREWALL · {ruleCount} rules
        {blockedPerSecond !== undefined && blockedPerSecond > 0 && (
          <><br /><span style={{ color: 'var(--color-danger)' }}>✕ {blockedPerSecond.toFixed(0)}/s blocked</span></>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 6: Write `ServiceChip.tsx`**

```tsx
// src/app/world/server/ServiceChip.tsx
// Process/container service chip. T4 fills the conn/p50 line + health dot; T6 adds dim/glow.
import type { CSSProperties, ReactElement } from 'react'
import type { ChipLayout } from './boardLayout'
import type { HealthState } from '../../../lib/worldEngine/types'

const HEALTH_COLOR: Record<HealthState, string> = {
  healthy: 'var(--color-success)', degraded: 'var(--color-warning)', down: 'var(--color-danger)',
}

export interface ServiceChipProps {
  chip: ChipLayout
  name: string
  color: string
  portsLabel: string           // ":443 :80" or ":3000→8080"
  health?: HealthState
  connLabel?: string           // "1.1k conn · p50 2.1ms" — T4; T3 passes "—"
  selected?: boolean
  hovered?: boolean
  dimmed?: boolean
  onSelect?: () => void
  onHover?: (v: boolean) => void
}

export function ServiceChip({ chip, name, color, portsLabel, health = 'healthy', connLabel = '—', selected, hovered, dimmed, onSelect, onHover }: ServiceChipProps): ReactElement {
  const style: CSSProperties = {
    position: 'absolute', left: chip.box.x, top: chip.box.y, width: chip.box.w, minHeight: chip.box.h,
    background: 'linear-gradient(160deg,#16202E,#0E141E)',
    border: `1px solid ${selected || hovered ? color : color + '88'}`, borderRadius: 6, padding: 6,
    boxShadow: hovered ? `0 0 16px ${color}` : `0 0 10px ${color}22`,
    opacity: dimmed ? 0.45 : 1, cursor: 'pointer', font: '9px var(--font-mono)',
    transition: 'opacity 0.15s, box-shadow 0.15s',
  }
  return (
    <div data-chip data-instance={chip.instanceId} style={style} onClick={onSelect}
      onMouseEnter={() => onHover?.(true)} onMouseLeave={() => onHover?.(false)}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ color: '#DBEAFE' }}><span data-chip-tab style={{ color }}>▮</span> {name}</span>
        <span style={{ width: 4, height: 4, borderRadius: '50%', background: HEALTH_COLOR[health], boxShadow: `0 0 5px ${HEALTH_COLOR[health]}` }} />
      </div>
      <div style={{ color: '#7CFFE9', marginTop: 2, fontSize: 7 }}>{portsLabel}</div>
      <div style={{ color: 'var(--color-text-secondary)', fontSize: 7 }}>{connLabel}</div>
    </div>
  )
}
```

- [ ] **Step 7: Write `StackPlate.tsx`**

```tsx
// src/app/world/server/StackPlate.tsx
// Raised docker-stack plate (dashed purple). Container chips are rendered by ServerBoard on top;
// the plate owns the header + volume cylinders.
import type { CSSProperties, ReactElement } from 'react'
import type { StackLayout } from './boardLayout'
import type { BoardSelection } from './selection'

const PURPLE = '#A78BFA'

export interface StackPlateProps {
  stack: StackLayout
  selection?: BoardSelection | null
  dimmed?: boolean
  onSelect?: (s: BoardSelection) => void
}

export function StackPlate({ stack, dimmed, onSelect }: StackPlateProps): ReactElement {
  const style: CSSProperties = {
    position: 'absolute', left: stack.box.x, top: stack.box.y, width: stack.box.w, height: stack.box.h,
    background: 'linear-gradient(160deg,#1A1430 0%,#120E22 100%)', border: `1px dashed ${PURPLE}88`,
    borderRadius: 10, boxShadow: '0 8px 24px #00000066, 0 0 18px #A78BFA22', padding: 6,
    opacity: dimmed ? 0.45 : 1, cursor: 'pointer', font: '7px var(--font-mono)',
  }
  return (
    <div data-stack={stack.stackName} style={style} onClick={() => onSelect?.({ kind: 'stack', stackName: stack.stackName })}>
      <div style={{ color: '#C4B5FD', textShadow: `0 0 6px ${PURPLE}` }}>▣ stack: {stack.stackName} · {stack.networkLabel}</div>
      <svg style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} width={stack.box.w} height={stack.box.h}>
        {stack.volumes.map(v => {
          const lx = v.box.x - stack.box.x, ty = v.box.y - stack.box.y
          return (
            <g key={v.volumeName} style={{ pointerEvents: 'auto', cursor: 'pointer' }}
              onClick={e => { e.stopPropagation(); onSelect?.({ kind: 'volume', stackName: stack.stackName, volumeName: v.volumeName }) }}>
              <ellipse cx={lx + v.box.w / 2} cy={ty + 4} rx={v.box.w / 2} ry={4} fill="#F5A62388" stroke="#F5A623" />
              <rect x={lx} y={ty + 4} width={v.box.w} height={v.box.h - 8} fill="#F5A62333" stroke="#F5A623" strokeWidth={0.5} />
              <ellipse cx={lx + v.box.w / 2} cy={ty + v.box.h - 4} rx={v.box.w / 2} ry={4} fill="#F5A623AA" stroke="#F5A623" />
              <text x={lx + v.box.w / 2} y={ty + v.box.h + 6} fill="var(--color-text-muted)" fontSize={5.5} textAnchor="middle">{v.volumeName}</text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
```

- [ ] **Step 8: Write `ServerBoard.tsx`**

```tsx
// src/app/world/server/ServerBoard.tsx
// Fixed-composition stage (D1): scale-to-fit a 1000x560 logical space; PCB grid bg; layer stack
// TraceLayer (SVG z0) → DOM blocks (z1) → PacketLayer slot (z2, added by T5).
import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { BoardLayout, StaticTrace } from './boardLayout'
import type { BlueprintId, ServerId } from '../../../lib/world/types'
import type { BoardSelection } from './selection'
import { useWorldStore } from '../../store/world.store'
import { TraceLayer } from './TraceLayer'
import { NicBlock } from './NicBlock'
import { FirewallGate } from './FirewallGate'
import { ServiceChip } from './ServiceChip'
import { StackPlate } from './StackPlate'

const PCB_GRID = '#101620'

export interface ServerBoardProps {
  serverId: ServerId
  layout: BoardLayout
  traces: StaticTrace[]
  selection: BoardSelection | null
  onSelect: (s: BoardSelection | null) => void
  hoveredBlueprintId: BlueprintId | null
  onHoverBlueprint: (id: BlueprintId | null) => void
}

export function ServerBoard(props: ServerBoardProps): ReactElement {
  const { serverId, layout, traces } = props
  const doc = useWorldStore(s => s.doc)
  const server = doc.servers[serverId]
  const containerRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const fit = () => setScale(Math.min(el.clientWidth / layout.stageW, el.clientHeight / layout.stageH) || 1)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [layout.stageW, layout.stageH])

  const portsLabel = (chip: (typeof layout.chips)[number]): string => {
    const pl = doc.placements[chip.placementId]
    if (pl?.runtime.type === 'container' && pl.runtime.portMappings.length) {
      return pl.runtime.portMappings.map(m => `:${m.host}→${m.container}`).join(' ')
    }
    const bp = doc.blueprints[chip.blueprintId]
    return bp?.ports.map(p => `:${p.port}`).join(' ') || 'internal'
  }

  return (
    <div ref={containerRef} style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden', background: 'radial-gradient(ellipse at 40% 35%, #0C1018 0%, #07090D 70%)' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: layout.stageW, height: layout.stageH, transformOrigin: '0 0', transform: `scale(${scale})` }}>
        {/* PCB grid */}
        <div style={{ position: 'absolute', inset: 0, backgroundImage: `linear-gradient(${PCB_GRID} 1px,transparent 1px),linear-gradient(90deg,${PCB_GRID} 1px,transparent 1px)`, backgroundSize: '26px 26px', opacity: 0.5 }} />
        {/* z0 traces */}
        <TraceLayer layout={layout} traces={traces} selection={props.selection} onSelect={props.onSelect} hoveredBlueprintId={props.hoveredBlueprintId} />
        {/* z1 DOM blocks */}
        {layout.stacks.map(st => <StackPlate key={st.stackName} stack={st} selection={props.selection} onSelect={props.onSelect} />)}
        <NicBlock box={layout.nic.box} nicMbps={server?.specs.nicMbps ?? 0} onSelect={() => props.onSelect({ kind: 'nic' })} onHover={() => {}} />
        <FirewallGate box={layout.gate.box} ruleCount={server?.firewall.length ?? 0} onSelect={() => props.onSelect({ kind: 'firewall' })} />
        {layout.chips.map(chip => {
          const bp = doc.blueprints[chip.blueprintId]
          return (
            <ServiceChip
              key={chip.instanceId} chip={chip} name={bp?.name ?? '?'} color={bp?.color ?? '#888'}
              portsLabel={portsLabel(chip)}
              onSelect={() => props.onSelect({ kind: 'instance', instanceId: chip.instanceId })}
              onHover={v => props.onHoverBlueprint(v ? chip.blueprintId : null)}
            />
          )
        })}
        {layout.overflowCount > 0 && (
          <div style={{ position: 'absolute', left: 250, bottom: 8, color: 'var(--color-text-muted)', font: '9px var(--font-mono)' }}>
            +{layout.overflowCount} more instance{layout.overflowCount > 1 ? 's' : ''}
          </div>
        )}
        {/* z2: PacketLayer mounts here in T5 */}
      </div>
    </div>
  )
}
```

- [ ] **Step 9: Rewrite `ServerView.tsx` as the composition root**

```tsx
// src/app/world/ServerView.tsx
// Level-4 server interior composition root (Phase 3): header strip + circuit-board stage +
// inspector rail placeholder (T6 replaces the <aside>). Selection/hover are held here in T6.
import { useMemo, type ReactElement } from 'react'
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { useCompiledWorld } from './useCompiledWorld'
import { layoutServerBoard, serverTraces } from './server/boardLayout'
import { ServerBoard } from './server/ServerBoard'

export function ServerView(): ReactElement | null {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const serverId = useNavStore(s => s.serverId)
  const server = serverId ? doc.servers[serverId] : null

  const layout = useMemo(() => (server ? layoutServerBoard(server, doc, compiled) : null), [server, doc, compiled])
  const traces = useMemo(() => (server && serverId ? serverTraces(serverId, doc, compiled) : []), [server, serverId, doc, compiled])

  if (!server || !serverId || !layout) return null
  const az = doc.azs[server.azId]
  const gb = Math.round(server.specs.ramMb / 1024)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--color-node-border)', font: '11px var(--font-mono)', color: 'var(--color-text-secondary)' }}>
        <span style={{ color: 'var(--color-text-primary)' }}>{server.label}</span> · {server.kind} · {server.specs.vcpu} vCPU / {gb} GB
        {' — '}{az?.label ?? '?'} › {server.rack.rackId} › U{server.rack.unit}
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ flex: 2.6, display: 'flex', minWidth: 0 }}>
          <ServerBoard
            serverId={serverId} layout={layout} traces={traces}
            selection={null} onSelect={() => {}} hoveredBlueprintId={null} onHoverBlueprint={() => {}}
          />
        </div>
        <aside style={{ width: 240, borderLeft: '1px solid var(--color-node-border)', background: 'var(--color-surface)' }} />
      </div>
    </div>
  )
}
```

> Note: T3 imports `./server/boardLayout`'s `serverTraces`/`layoutServerBoard` and ServerBoard
> imports `./selection` (BoardSelection) which T6 creates. To keep T3's build green BEFORE T6,
> T3 also creates the type-only `src/app/world/server/selection.ts` with the full `BoardSelection`
> union now (it is T6's deliverable but a pure type file; T6 will already find it present and
> only add its consumers). Copy the union verbatim from the T6 section. If the controller
> sequences strictly, create it here — a type-only file breaks nothing downstream.

- [ ] **Step 10: Run tests + build**

Run: `npx vitest run src/app/world/server/ServerBoard.test.tsx` → PASS (5 tests).
Run: `npm run build` → succeeds.
Run: `npx vitest run` → all suites green.

- [ ] **Step 11: Live Playwright smoke (controller-run, port 1420)**

1. `npm run dev` (background); wait for `Local:   http://localhost:1420/`.
2. `browser_navigate` → `http://localhost:1420`; `browser_click` "New World".
3. Topology tab: add region `us-east-1` → "+ AZ" → "+ Server".
4. Blueprints tab: create `web`; expand it, give it a public port (if UI exposes it) — otherwise
   author via the DEV `window.__scalemapDebug` hook to set a `public` port and a stack + a
   container placement + a dependency the firewall blocks (mirror Phase-2 T14/T18 smoke pattern;
   the debug hook exposes `useWorldStore` — use `updateBlueprint`/`updateServer`/`updatePlacement`).
5. Navigate into the server (breadcrumb region → AZ card → server chassis/card).
6. `browser_snapshot` → confirm NIC (`eth0`), firewall gate (`FIREWALL · N rules`), a service
   chip with signature color, the stack plate (`stack: …`), and a red dashed blocked trace with a
   `refused …` label.
7. `browser_console_messages` → assert ZERO error-level entries.
8. `browser_take_screenshot` → scratchpad `task3-static-board.png`.
9. Stop the dev server.

- [ ] **Step 12: Commit**

```bash
git add src/app/world/server/ServerBoard.tsx src/app/world/server/ServiceChip.tsx \
        src/app/world/server/StackPlate.tsx src/app/world/server/FirewallGate.tsx \
        src/app/world/server/NicBlock.tsx src/app/world/server/TraceLayer.tsx \
        src/app/world/server/ServerBoard.test.tsx src/app/world/server/selection.ts \
        src/app/world/ServerView.tsx
git commit -m "feat(server-view): static circuit-board stage replacing the Phase-1 readout"
```

---

## Task 4: Hardware platform + live display metrics `[sonnet]`

**Files:** create `HardwarePlatform.tsx`, `useServerDisplayMetrics.ts`; extend `NicBlock.tsx`
(live bar) and `ServiceChip.tsx` (conn/p50 line, health dot) call sites in `ServerBoard.tsx`;
create jsdom test `HardwarePlatform.test.tsx`.

**Grounding:** `ServerMetrics { coreUtilization:number[], stealFraction, burstCredits:number|null,
ramByInstance:[{instanceId,blueprintId,ramMb}], ramUsedMb, ramTotalMb, nicInMbps, nicOutMbps,
diskIoFraction, health }` and `InstanceMetrics { activeConnections, p50Ms, ramMb, health }`
(contracts, order-stable). Store: `useSimulationStore` v2 has `latestBatch: MetricsBatch|null`
and `scrubBatch: MetricsBatch|null` (T15). Scrub-aware read = `scrubBatch ?? latestBatch` (D5).
`server.specs.diskGb/nicMbps`, blueprint `workload.ramBaseMb` for at-rest estimate.

- [ ] **Step 1: Write `useServerDisplayMetrics.ts`**

```ts
// src/app/world/server/useServerDisplayMetrics.ts
// Scrub-aware slice of the metrics pyramid for one server + its resident instances (D5).
import { useSimulationStore } from '../../store/simulation.store'
import type { ServerMetrics, InstanceMetrics } from '../../../lib/worldEngine/types'
import type { InstanceId } from '../../../lib/world/types'   // id types live in world/types, NOT re-exported by worldEngine/types

export interface ServerDisplay {
  server: ServerMetrics | null
  instances: Record<InstanceId, InstanceMetrics>
  scrubbing: boolean
}

export function useServerDisplayMetrics(serverId: string): ServerDisplay {
  return useSimulationStore(s => {
    const batch = s.scrubBatch ?? s.latestBatch
    if (!batch) return { server: null, instances: {}, scrubbing: s.scrubBatch !== null }
    const server = batch.servers[serverId] ?? null
    const instances: Record<InstanceId, InstanceMetrics> = {}
    for (const [id, m] of Object.entries(batch.instances)) {
      if (server && batch.servers[serverId] && m) instances[id] = m   // filtered below by caller via resident set
    }
    return { server, instances: batch.instances, scrubbing: s.scrubBatch !== null }
  })
}
```

> Note: returning the full `batch.instances` map is intentional — `HardwarePlatform`/`ServiceChip`
> index it by the resident instance ids they already hold from the layout; filtering here would
> duplicate the layout's resident set. `useSimulationStore(selector)` must return a stable-enough
> object; if reference churn causes re-render storms, wrap the slice in a `useMemo` keyed on
> `[batch, serverId]` inside the hook (zustand selector returning a fresh object each call is a
> known footgun — prefer selecting `scrubBatch`/`latestBatch` separately then `useMemo`). Prefer
> the `useMemo` form:

```ts
import { useMemo } from 'react'
import { useSimulationStore } from '../../store/simulation.store'
import type { ServerMetrics, InstanceMetrics } from '../../../lib/worldEngine/types'
import type { InstanceId } from '../../../lib/world/types'   // id types live in world/types, NOT re-exported by worldEngine/types

export interface ServerDisplay {
  server: ServerMetrics | null
  instances: Record<InstanceId, InstanceMetrics>
  scrubbing: boolean
}

export function useServerDisplayMetrics(serverId: string): ServerDisplay {
  const scrubBatch = useSimulationStore(s => s.scrubBatch)
  const latestBatch = useSimulationStore(s => s.latestBatch)
  return useMemo(() => {
    const batch = scrubBatch ?? latestBatch
    return {
      server: batch?.servers[serverId] ?? null,
      instances: batch?.instances ?? {},
      scrubbing: scrubBatch !== null,
    }
  }, [scrubBatch, latestBatch, serverId])
}
```

Use the `useMemo` version (delete the first sketch).

- [ ] **Step 2: Write the failing jsdom test `HardwarePlatform.test.tsx`**

```tsx
// src/app/world/server/HardwarePlatform.test.tsx
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HardwarePlatform } from './HardwarePlatform'
import { createWorld, createRegion, createAz, createServer } from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'
import type { ServerMetrics } from '../../../lib/worldEngine/types'

function server(kind: 'vps' | 'dedicated' = 'vps') {
  const doc = createWorld()
  const r = createRegion('us-east-1'); const az = createAz(r.id, 'us-east-1a')
  const s = createServer(az.id, getPreset(kind === 'vps' ? 'vps-medium' : 'dedicated-8')!)
  return s
}
const metrics = (over: Partial<ServerMetrics> = {}): ServerMetrics => ({
  serverId: 's', coreUtilization: [0.6, 0.4, 0.9, 0.1], stealFraction: 0, burstCredits: null,
  ramByInstance: [{ instanceId: 'i1', blueprintId: 'b1', ramMb: 1400 }, { instanceId: 'i2', blueprintId: 'b2', ramMb: 610 }],
  ramUsedMb: 5900, ramTotalMb: 8192, nicInMbps: 214, nicOutMbps: 118, diskIoFraction: 0.12, health: 'healthy', ...over,
})
const residents = [
  { instanceId: 'i1', blueprintId: 'b1', color: '#A78BFA', name: 'postgres', ramBaseMb: 256 },
  { instanceId: 'i2', blueprintId: 'b2', color: '#4A9EFF', name: 'api', ramBaseMb: 128 },
]

describe('HardwarePlatform', () => {
  it('renders one core cell per vcpu', () => {
    const s = server()
    render(<HardwarePlatform server={s} metrics={metrics()} residentBlueprints={residents} attribution={[]} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}} />)
    expect(screen.getAllByTestId('core-cell')).toHaveLength(4)
  })

  it('steal arc appears only for vps with steal', () => {
    const s = server('vps')
    const { rerender } = render(<HardwarePlatform server={s} metrics={metrics({ stealFraction: 0.18 })} residentBlueprints={residents} attribution={[]} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}} />)
    expect(screen.getByText(/steal/)).toBeInTheDocument()
    rerender(<HardwarePlatform server={s} metrics={metrics({ stealFraction: 0 })} residentBlueprints={residents} attribution={[]} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}} />)
    expect(screen.queryByText(/steal/)).not.toBeInTheDocument()
  })

  it('ram strata follow ramByInstance order and include os+cache remainder', () => {
    const s = server()
    render(<HardwarePlatform server={s} metrics={metrics()} residentBlueprints={residents} attribution={[]} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}} />)
    const strata = screen.getAllByTestId('ram-stratum')
    // 2 instance strata + os+cache remainder
    expect(strata.length).toBe(3)
    expect(screen.getByText(/os \+ cache/i)).toBeInTheDocument()
  })

  it('at-rest estimate uses ramBaseMb when no batch', () => {
    const s = server()
    render(<HardwarePlatform server={s} metrics={null} residentBlueprints={residents} attribution={[]} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}} />)
    expect(screen.getByText(/at rest/i)).toBeInTheDocument()
  })

  it('disk slices proportional to volume sizes', () => {
    const s = server()
    s.stacks = [{ name: 'app', networks: [], volumes: [{ name: 'pgdata', sizeGb: 12 }] }]
    render(<HardwarePlatform server={s} metrics={metrics()} residentBlueprints={residents} attribution={[]} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}} />)
    expect(screen.getByText(/pgdata/)).toBeInTheDocument()
  })

  it('oom warning appears at 90% of memLimit', () => {
    const s = server()
    render(<HardwarePlatform server={s} metrics={metrics()} residentBlueprints={residents}
      attribution={[]} hoveredBlueprintId={null} onHoverBlueprint={() => {}} onSelect={() => {}}
      memLimits={{ i2: 640 }} instanceRamMb={{ i2: 610 }} />)
    expect(screen.getByText(/oom/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Write `HardwarePlatform.tsx`**

```tsx
// src/app/world/server/HardwarePlatform.tsx
// Unified host platform (D4): CPU die + utilization ring (hatched amber steal arc for VPS),
// stratified RAM reservoir (one colored stratum per resident + os/cache remainder), sliced disk
// platter with an io scanner. All numbers from ServerMetrics (order-stable); at-rest estimate
// from blueprint ramBaseMb when metrics is null (D5). prefers-reduced-motion parks the scanner
// and drops idle shimmer.
import type { ReactElement } from 'react'
import { useReducedMotion } from 'framer-motion'
import type { Server, InstanceId } from '../../../lib/world/types'   // id types from world/types (not re-exported by worldEngine/types)
import type { ServerMetrics } from '../../../lib/worldEngine/types'
import type { CoreAttribution } from './boardLayout'
import type { BoardSelection } from './selection'

const AMBER = '#F5A623', CPU_BLUE = '#4A9EFF'

export interface HardwarePlatformProps {
  server: Server
  metrics: ServerMetrics | null
  residentBlueprints: { instanceId: InstanceId; blueprintId: string; color: string; name: string; ramBaseMb: number }[]
  attribution: CoreAttribution[]
  hoveredBlueprintId: string | null
  onHoverBlueprint: (id: string | null) => void
  onSelect: (s: BoardSelection | null) => void
  box?: { x: number; y: number; w: number; h: number }   // hardware.box from layout (optional)
  memLimits?: Record<InstanceId, number>                  // container memLimitMb by instance
  instanceRamMb?: Record<InstanceId, number>              // live per-instance ramMb (oom check)
}

export function HardwarePlatform(props: HardwarePlatformProps): ReactElement {
  const { server, metrics, residentBlueprints, attribution, hoveredBlueprintId, onHoverBlueprint, onSelect } = props
  const reduced = useReducedMotion()
  const vcpu = server.specs.vcpu
  const cols = Math.ceil(Math.sqrt(vcpu))
  const dimFor = (bpId: string | null) => (hoveredBlueprintId && bpId !== hoveredBlueprintId ? 0.45 : 1)

  const cores = metrics?.coreUtilization ?? new Array(vcpu).fill(0)
  const meanUtil = cores.length ? cores.reduce((a, b) => a + b, 0) / cores.length : 0
  const steal = metrics?.stealFraction ?? 0

  // RAM strata: instance slices in order + os/cache remainder (D4).
  const atRest = metrics === null
  const strata = atRest
    // at-rest estimate (D5): each resident blueprint's workload.ramBaseMb
    ? residentBlueprints.map(r => ({ instanceId: r.instanceId, blueprintId: r.blueprintId, color: r.color, name: r.name, ramMb: r.ramBaseMb }))
    : (metrics!.ramByInstance).map(s => {
        const rb = residentBlueprints.find(r => r.instanceId === s.instanceId)
        return { instanceId: s.instanceId, blueprintId: s.blueprintId, color: rb?.color ?? CPU_BLUE, name: rb?.name ?? '?', ramMb: s.ramMb }
      })
  const ramUsed = metrics?.ramUsedMb ?? strata.reduce((a, s) => a + s.ramMb, 0)
  const ramTotal = metrics?.ramTotalMb ?? server.specs.ramMb
  const osCache = Math.max(0, ramUsed - strata.reduce((a, s) => a + s.ramMb, 0))

  // Disk slices: system 15% + one per volume, remainder free (D4).
  const diskGb = server.specs.diskGb
  const volumes = server.stacks.flatMap(st => st.volumes)
  const systemGb = diskGb * 0.15
  const usedGb = systemGb + volumes.reduce((a, v) => a + v.sizeGb, 0)
  const io = metrics?.diskIoFraction ?? 0
  const HEALTH_COLOR = { healthy: 'var(--color-success)', degraded: 'var(--color-warning)', down: 'var(--color-danger)' } as const
  const hostHealth = metrics?.health ?? 'healthy'

  return (
    <div data-hardware style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 8, font: '7px var(--font-mono)', color: 'var(--color-text-secondary)' }}>
      <div style={{ color: '#8FA8C7', letterSpacing: '0.12em', display: 'flex', alignItems: 'center', gap: 4 }}>
        <span data-host-health style={{ width: 5, height: 5, borderRadius: '50%', background: HEALTH_COLOR[hostHealth], boxShadow: `0 0 5px ${HEALTH_COLOR[hostHealth]}` }} />
        ⬢ HOST · {server.kind}{server.kind === 'vps' ? ' (shared tenancy)' : ''}
      </div>

      {/* CPU die */}
      <div data-cpu onClick={() => onSelect({ kind: 'hardware', part: 'cpu' })} style={{ cursor: 'pointer' }}>
        <svg width={100} height={100} viewBox="0 0 100 100">
          <circle cx={50} cy={50} r={45} fill="none" stroke="#16202E" strokeWidth={5} />
          <circle cx={50} cy={50} r={45} fill="none" stroke={CPU_BLUE} strokeWidth={5} strokeLinecap="round"
            strokeDasharray={`${meanUtil * 283} 283`} transform="rotate(-90 50 50)" style={{ filter: `drop-shadow(0 0 5px ${CPU_BLUE})` }} />
          {steal > 0 && (
            <circle cx={50} cy={50} r={45} fill="none" stroke={AMBER} strokeWidth={5}
              strokeDasharray="2 3.1" strokeDashoffset={-meanUtil * 283} pathLength={283} transform="rotate(-90 50 50)" opacity={0.9} />
          )}
        </svg>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 3, width: 56, margin: '-78px auto 0' }}>
          {cores.map((u, i) => {
            const dom = attribution[i]?.dominantBlueprintId ?? null
            const color = residentBlueprints.find(r => r.blueprintId === dom)?.color ?? CPU_BLUE
            return <div key={i} data-testid="core-cell" style={{ height: 18, borderRadius: 2, background: `linear-gradient(0deg, ${color} ${Math.round(u * 100)}%, #141B26 ${Math.round(u * 100)}%)`, opacity: dimFor(dom) }} />
          })}
        </div>
        <div style={{ textAlign: 'center', color: '#9CC8FF', marginTop: 6 }}>
          cpu {Math.round(meanUtil * 100)}%{steal > 0 && <span style={{ color: AMBER }}> +{Math.round(steal * 100)}% steal</span>}
        </div>
        {metrics?.burstCredits != null && (
          <div style={{ height: 2, background: '#0F2B27', marginTop: 2 }}><div style={{ width: `${metrics.burstCredits * 100}%`, height: '100%', background: AMBER }} /></div>
        )}
      </div>

      {/* RAM reservoir */}
      <div data-ram onClick={() => onSelect({ kind: 'hardware', part: 'ram' })} style={{ display: 'flex', gap: 6, alignItems: 'flex-end', cursor: 'pointer' }}>
        <div style={{ width: 34, height: 64, background: '#0C1119', border: '1px solid #2A3648', borderRadius: '5px 5px 3px 3px', position: 'relative', overflow: 'hidden' }}>
          {(() => { let acc = 0; return strata.map(s => {
            const pct = ramTotal ? (s.ramMb / ramTotal) * 100 : 0
            const el = <div key={s.instanceId} data-testid="ram-stratum" onMouseEnter={() => onHoverBlueprint(s.blueprintId)} onMouseLeave={() => onHoverBlueprint(null)}
              style={{ position: 'absolute', bottom: `${acc}%`, width: '100%', height: `${pct}%`, background: s.color, opacity: dimFor(s.blueprintId) }} />
            acc += pct; return el
          }) })()}
          <div data-testid="ram-stratum" style={{ position: 'absolute', bottom: `${ramTotal ? (ramUsed - osCache) / ramTotal * 100 : 0}%`, width: '100%', height: `${ramTotal ? osCache / ramTotal * 100 : 0}%`, background: 'linear-gradient(0deg,#F5A62388,#F5A62333)' }} />
        </div>
        <div style={{ flex: 1, lineHeight: 1.7 }}>
          <div style={{ color: '#E2E8F0' }}>ram {(ramUsed / 1024).toFixed(1)}/{(ramTotal / 1024).toFixed(0)}G {atRest && <span style={{ color: 'var(--color-text-muted)' }}>(at rest)</span>}</div>
          {strata.map(s => {
            const oom = props.memLimits?.[s.instanceId] && props.instanceRamMb?.[s.instanceId] && props.instanceRamMb[s.instanceId] >= props.memLimits[s.instanceId] * 0.9
            return <div key={s.instanceId} style={{ opacity: dimFor(s.blueprintId) }}><span style={{ color: s.color }}>▮</span> {s.name} {Math.round(s.ramMb)}M {oom && <span style={{ color: 'var(--color-danger)' }}>⚠oom</span>}</div>
          })}
          <div><span style={{ color: AMBER }}>▮</span> os + cache {Math.round(osCache)}M</div>
        </div>
      </div>

      {/* Disk platter */}
      <div data-disk onClick={() => onSelect({ kind: 'hardware', part: 'disk' })} style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
        <svg width={52} height={52} viewBox="0 0 52 52">
          <circle cx={26} cy={26} r={23} fill="#0C1119" stroke="#2A3648" strokeWidth={1} />
          {(() => {
            const circ = 2 * Math.PI * 11.5
            let off = 0
            const slices: ReactElement[] = []
            const push = (gb: number, color: string, key: string) => {
              const len = diskGb ? (gb / diskGb) * circ : 0
              slices.push(<circle key={key} cx={26} cy={26} r={11.5} fill="none" stroke={color} strokeWidth={21} strokeDasharray={`${len} ${circ - len}`} strokeDashoffset={-off} transform="rotate(-90 26 26)" opacity={0.85} />)
              off += len
            }
            push(systemGb, '#33415888', 'system')
            volumes.forEach(v => push(v.sizeGb, AMBER, v.name))
            return slices
          })()}
          <line x1={26} y1={26} x2={26} y2={4} stroke="#7CFFE9" strokeWidth={1} opacity={0.7}
            style={reduced || !metrics ? undefined : { transformOrigin: '26px 26px', animation: `spin ${(3.5 / Math.max(io, 0.05)).toFixed(2)}s linear infinite` }} />
          <circle cx={26} cy={26} r={3} fill="#141B26" stroke="#2A3648" />
        </svg>
        <div style={{ flex: 1, lineHeight: 1.7 }}>
          <div style={{ color: '#E2E8F0' }}>nvme0 {Math.round(usedGb)}/{diskGb}G · io {Math.round(io * 100)}%</div>
          {volumes.map(v => <div key={v.name}><span style={{ color: AMBER }}>▮</span> vol {v.name} {v.sizeGb}G</div>)}
          <div><span style={{ color: '#64748B' }}>▮</span> system {Math.round(systemGb)}G · free {Math.round(diskGb - usedGb)}G</div>
        </div>
      </div>
    </div>
  )
}
```

> `@keyframes spin { to { transform: rotate(360deg) } }` must exist — add it once to
> `src/index.css` if absent (a generic util, not a scene token). The at-rest RAM estimate (D5)
> uses each resident blueprint's `workload.ramBaseMb`: when `metrics === null`, replace the empty
> `ramMb: 0` sketch with `doc.blueprints[r.blueprintId]?.workload.ramBaseMb ?? 0` — pass a
> `restRamByBlueprint` prop from `ServerView` (which has `doc`) OR read the base directly by
> threading the resident blueprint's base into `residentBlueprints`. Simplest: extend
> `residentBlueprints` items with `ramBaseMb: number` and use it for the at-rest slice. Wire this
> in ServerView's memo.

- [ ] **Step 4: Mount `HardwarePlatform` in `ServerBoard.tsx` and wire live chip/NIC metrics**

In `ServerBoard.tsx`, call `useServerDisplayMetrics(serverId)` and `attributeCores` over the live
`cpuCoresUsed` (from `batch.instances[iid].cpuCoresUsed`), then:
- render `<HardwarePlatform>` absolutely-positioned at `layout.hardware.box` (a right-rail
  wrapper `div` at `left/top/width/height` = the box), passing `metrics = display.server`,
  `residentBlueprints` (built from `doc` + resident chips, incl. `ramBaseMb`), `attribution`,
  and `memLimits`/`instanceRamMb` from placements + `display.instances`.
- pass live `connLabel`/`health` into each `ServiceChip`:
  `connLabel = m ? \`${m.activeConnections} conn · p50 ${m.p50Ms.toFixed(1)}ms\` : '—'`,
  `health = m?.health`.
- pass `inMbps`/`outMbps`/`utilFraction` into `NicBlock`:
  `utilFraction = server ? (server.nicInMbps + server.nicOutMbps) / server.specs... ` →
  `(metrics.nicInMbps + metrics.nicOutMbps) / server.specs.nicMbps`.
- add a small "scrubbing" pill in the board corner when `display.scrubbing`.

- [ ] **Step 5: Run tests + build**

Run: `npx vitest run src/app/world/server/HardwarePlatform.test.tsx` → PASS (6 tests).
Run: `npm run build`, `npx vitest run` → green.

- [ ] **Step 6: Live smoke** — simulate the T3 world; verify the ring fills, RAM strata stack in
blueprint colors, NIC bar moves, disk scanner rotates; `browser_console_messages` zero errors;
screenshot `task4-hardware.png`; Stop then scrub → strata reflect the scrubbed frame (a
"scrubbing" pill shows). Stop the dev server.

- [ ] **Step 7: Commit**

```bash
git add src/app/world/server/HardwarePlatform.tsx src/app/world/server/useServerDisplayMetrics.ts \
        src/app/world/server/HardwarePlatform.test.tsx src/app/world/server/ServerBoard.tsx \
        src/app/world/server/ServiceChip.tsx src/app/world/server/NicBlock.tsx src/index.css
git commit -m "feat(server-view): live unified hardware platform (cpu die, ram reservoir, disk platter)"
```

---

## Task 5: Packet layer + gate stats `[sonnet]`

**Files:** create `PacketLayer.tsx`, `gateStats.ts`, `gateStats.test.ts`; extend
`FirewallGate.tsx` call site (blocked/s) and `ServerBoard.tsx` (mount PacketLayer at z2).

**Grounding:** `useSimulationStore.attachRenderer({level:'server',serverId}, onFrame)` returns a
`DetachFn`; `onFrame` gets a `FramePayload { particles: VisualParticle[] }`. `EngineEvent
{ kind, simMs, affected[] }`; `connection_refused` is the blocked-path kind. Store has `events`
and `latestBatch.simMs`. Canvas draws via refs only (D10); attach once per `(serverId, running)`
(T14 lesson) — never on hover/selection. Reduced motion → ≥500ms between redraws (AzSimOverlay
precedent).

- [ ] **Step 1: Write the failing test `gateStats.test.ts`**

```ts
// src/app/world/server/gateStats.test.ts
import { describe, it, expect } from 'vitest'
import { blockedPerSecond } from './gateStats'
import type { EngineEvent } from '../../../lib/worldEngine/types'

const ev = (simMs: number, affected: string[], kind: EngineEvent['kind'] = 'connection_refused'): EngineEvent =>
  ({ id: `${simMs}-${affected.join()}`, simMs, kind, severity: 'warning', message: '', affected })

describe('blockedPerSecond', () => {
  it('counts only this server refused events in the window', () => {
    const events = [
      ev(9000, ['srv-1']), ev(9500, ['srv-1']), ev(9800, ['srv-2']),
      ev(9900, ['srv-1'], 'oom_kill'),
    ]
    // window (5000, 10000], 5s → 2 srv-1 refused / 5 = 0.4
    expect(blockedPerSecond(events, 'srv-1', 10000)).toBeCloseTo(0.4)
  })

  it('returns 0 outside the window', () => {
    const events = [ev(1000, ['srv-1']), ev(2000, ['srv-1'])]
    expect(blockedPerSecond(events, 'srv-1', 10000)).toBe(0)
  })

  it('scales to per-second by the window width', () => {
    const events = [ev(9000, ['srv-1']), ev(9200, ['srv-1']), ev(9400, ['srv-1'])]
    expect(blockedPerSecond(events, 'srv-1', 10000, 2000)).toBeCloseTo(1.5)   // 3 / (2000/1000)
  })
})
```

- [ ] **Step 2: Run to verify it fails**, then write `gateStats.ts`

```ts
// src/app/world/server/gateStats.ts
import type { EngineEvent } from '../../../lib/worldEngine/types'

// Refused connections attributed to this server within the trailing window, per second.
export function blockedPerSecond(
  events: EngineEvent[], serverId: string, nowSimMs: number, windowMs = 5000,
): number {
  const lo = nowSimMs - windowMs
  let count = 0
  for (const e of events) {
    if (e.kind !== 'connection_refused') continue
    if (e.simMs <= lo || e.simMs > nowSimMs) continue
    if (e.affected.includes(serverId)) count++
  }
  return count / (windowMs / 1000)
}
```

Run: `npx vitest run src/app/world/server/gateStats.test.ts` → PASS (3 tests).

- [ ] **Step 3: Write the failing jsdom test `PacketLayer.test.tsx`**

```tsx
// src/app/world/server/PacketLayer.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { PacketLayer } from './PacketLayer'
import { useSimulationStore } from '../../store/simulation.store'
import { layoutServerBoard } from './boardLayout'
import { createWorld, createRegion, createAz, createServer } from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'
import { compileWorld } from '../../../lib/world/compileWorld'

function layout() {
  const doc = createWorld()
  const r = createRegion('us-east-1'); const az = createAz(r.id, 'us-east-1a')
  const s = createServer(az.id, getPreset('vps-medium')!)
  doc.regions[r.id] = r; doc.azs[az.id] = az; doc.servers[s.id] = s
  return { layout: layoutServerBoard(s, doc, compileWorld(doc)), serverId: s.id }
}

describe('PacketLayer', () => {
  beforeEach(() => useSimulationStore.setState({ running: false }))

  it('attaches the renderer when running and detaches on unmount', () => {
    const detach = vi.fn()
    const attach = vi.fn(() => detach)
    useSimulationStore.setState({ running: true, attachRenderer: attach as never })
    const { layout: l, serverId } = layout()
    const { unmount } = render(<PacketLayer serverId={serverId} layout={l} />)
    expect(attach).toHaveBeenCalledTimes(1)
    expect(attach.mock.calls[0][0]).toEqual({ level: 'server', serverId })
    unmount()
    expect(detach).toHaveBeenCalledTimes(1)
  })

  it('does not attach when stopped', () => {
    const attach = vi.fn(() => vi.fn())
    useSimulationStore.setState({ running: false, attachRenderer: attach as never })
    const { layout: l, serverId } = layout()
    render(<PacketLayer serverId={serverId} layout={l} />)
    expect(attach).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 4: Write `PacketLayer.tsx`**

```tsx
// src/app/world/server/PacketLayer.tsx
// Canvas over the (unscaled) 1000x560 stage — lives INSIDE the scaled stage div so logical coords
// need no conversion. Attaches the server renderer once per (serverId, running); draws via refs.
// Particle position = point at `progress` along layout.tracePath, resolved with a cached hidden
// SVG path per unique pair. Blocked bursts render at the gate (nic origin) or target anchor (D6).
import { useEffect, useRef, type ReactElement } from 'react'
import { useReducedMotion } from 'framer-motion'
import { useSimulationStore } from '../../store/simulation.store'
import type { BoardLayout } from './boardLayout'
import type { VisualParticle } from '../../../lib/worldEngine/types'

const PROTOCOL_COLOR: Record<VisualParticle['protocol'], string> = {
  http: '#4A9EFF', db: '#F5A623', event: '#A78BFA', stream: '#2DD4BF',
}

export interface PacketLayerProps { serverId: string; layout: BoardLayout }

export function PacketLayer({ serverId, layout }: PacketLayerProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const running = useSimulationStore(s => s.running)
  const reduced = useReducedMotion()
  const lastDrawRef = useRef(0)
  const pathCache = useRef(new Map<string, SVGPathElement>())

  useEffect(() => {
    if (!running) {
      const ctx = canvasRef.current?.getContext('2d')
      if (ctx && canvasRef.current) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height)
      return
    }
    const svgNS = 'http://www.w3.org/2000/svg'
    const pointAt = (fromId: string, toId: string, progress: number) => {
      const key = `${fromId}→${toId}`
      let path = pathCache.current.get(key)
      if (!path) {
        const d = layout.tracePath(fromId, toId)
        if (!d) return null
        path = document.createElementNS(svgNS, 'path')
        path.setAttribute('d', d)
        pathCache.current.set(key, path)
      }
      const len = path.getTotalLength?.() ?? 0
      if (!len) return null
      return path.getPointAtLength(len * progress)
    }
    const detach = useSimulationStore.getState().attachRenderer({ level: 'server', serverId }, payload => {
      const now = performance.now()
      if (reduced && now - lastDrawRef.current < 500) return
      lastDrawRef.current = now
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) return
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      for (const p of payload.particles) {
        if (p.blocked && p.progress > 0.85) {
          const burstAt = p.fromId.startsWith('nic:') ? layout.gate.inAnchor : layout.anchorFor(p.toId)
          if (!burstAt) continue
          const t = (p.progress - 0.85) / 0.15
          ctx.beginPath(); ctx.arc(burstAt.x, burstAt.y, 4 + t * 10, 0, Math.PI * 2)
          ctx.strokeStyle = `rgba(239,68,68,${1 - t})`; ctx.lineWidth = 2; ctx.stroke()
          continue
        }
        const pt = pointAt(p.fromId, p.toId, p.progress)
        if (!pt) continue
        ctx.beginPath(); ctx.arc(pt.x, pt.y, 2.6, 0, Math.PI * 2)
        ctx.fillStyle = p.colorHint ?? PROTOCOL_COLOR[p.protocol]; ctx.fill()
      }
    })
    return detach
  }, [running, serverId, layout, reduced])

  return <canvas ref={canvasRef} width={layout.stageW} height={layout.stageH}
    style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
}
```

- [ ] **Step 5: Mount PacketLayer at z2 in `ServerBoard.tsx` and wire the gate counter**

Replace the `{/* z2: PacketLayer mounts here in T5 */}` comment with
`<PacketLayer serverId={serverId} layout={layout} />`. Compute
`blockedPerSecond(events, serverId, latestBatch?.simMs ?? 0)` from
`useSimulationStore(s => s.events)` + `latestBatch` and pass it into `<FirewallGate blockedPerSecond={…}>`.

- [ ] **Step 6: Run tests + build**

Run: `npx vitest run src/app/world/server/gateStats.test.ts src/app/world/server/PacketLayer.test.tsx` → PASS.
Run: `npm run build`, `npx vitest run` → green.

- [ ] **Step 7: Live smoke** — simulate → packets visibly traverse nic→gate→chip and
chip→plate traces; a blocked burst pulses at the gate and `✕ N/s blocked` increments; emulate
reduced motion (`browser` `emulateMedia prefers-reduced-motion: reduce`) → still shows
current-state redraws (throttled). Zero console errors; screenshot `task5-packets.png`. Stop dev.

- [ ] **Step 8: Commit**

```bash
git add src/app/world/server/PacketLayer.tsx src/app/world/server/gateStats.ts \
        src/app/world/server/gateStats.test.ts src/app/world/server/PacketLayer.test.tsx \
        src/app/world/server/FirewallGate.tsx src/app/world/server/ServerBoard.tsx
git commit -m "feat(server-view): engine-driven packet layer and firewall block counter"
```

<!-- COMPLETE -->
