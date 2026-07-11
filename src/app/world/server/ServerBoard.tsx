// src/app/world/server/ServerBoard.tsx
// Fixed-composition stage (D1): scale-to-fit a 1000x560 logical space; PCB grid bg; layer stack
// TraceLayer (SVG z0) → PacketLayer (canvas z1, T5: engine-driven particles — under the blocks
// so dots vanish into a chip's edge rather than crossing its text) → DOM blocks (z2).
// T4 wires live metrics (useServerDisplayMetrics, D5) into ServiceChip/NicBlock and mounts the
// substrate instruments at layout.hardware.box (T6, D8: HardwarePlatform's corebank/DIMM/platter
// redesign — see that file's header). T5 also feeds gateStats.blockedPerSecond into FirewallGate's
// reject sparks from the store's events + latestBatch.simMs, and derives `inboundRps` (Σ resident
// instance rps — no server-level rps metric exists) once, shared by NicBlock's ACT LED and
// FirewallGate's allow-slat edge-dot gate (D6/D7 physical-jack + shield redesign). T6 adds two
// more resident-walk derivations of the same shape (`queueDepth`, `instanceRps`) for the
// substrate's queue ticks and TraceLayer's flowing-dash overlay.
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { BoardLayout, StaticTrace } from './boardLayout'
import type { BlueprintId, ServerId } from '../../../lib/world/types'
import type { BoardSelection } from './selection'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useServerDisplayMetrics } from './useServerDisplayMetrics'
import { TraceLayer } from './TraceLayer'
import { NicBlock } from './NicBlock'
import { FirewallGate } from './FirewallGate'
import { ServiceChip } from './ServiceChip'
import { StackPlate } from './StackPlate'
import { HardwarePlatform } from './HardwarePlatform'
import { PacketLayer } from './PacketLayer'
import { blockedPerSecond } from './gateStats'

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
  // D6/D7 (T5): inbound rps has no server-level metric — derive it as Σ resident instance rps.
  // Feeds both the NIC's ACT LED blink period and the firewall shield's allow-slat edge-dot gate
  // (same "is traffic passing" signal, computed once here).
  const inboundRps = useMemo(
    () => layout.residentInstanceIds.reduce((sum, id) => sum + (display.instances[id]?.rps ?? 0), 0),
    [layout.residentInstanceIds, display.instances],
  )
  // D8 (T6): Σ resident instance activeConnections feeds HardwarePlatform's io-queue ticks. Same
  // "walk residents, pull one live metric" shape as inboundRps above (TraceLayer reads rps
  // straight off `display.instances` itself — no separate derived map needed there).
  const queueDepth = useMemo(
    () => layout.residentInstanceIds.reduce((sum, id) => sum + (display.instances[id]?.activeConnections ?? 0), 0),
    [layout.residentInstanceIds, display.instances],
  )

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

  // Resident instance identity pairs for the hardware platform's substrate (D8) — just enough
  // for the at-rest RAM synthesis (D5) when no live batch exists; blueprint color/name/ramBaseMb
  // now come from `doc.blueprints` directly (HardwarePlatform's `blueprints` prop below), so this
  // no longer needs its own denormalized copy of those fields. Memoized (T7 hygiene, Phase-3
  // carry-forward) — recomputed only when the chip list changes, not on every 1Hz metrics tick.
  const residentInstances = useMemo(
    () => layout.chips.map(chip => ({ instanceId: chip.instanceId, blueprintId: chip.blueprintId })),
    [layout.chips],
  )

  return (
    <div ref={containerRef} style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden', background: 'radial-gradient(ellipse at 40% 35%, #0C1018 0%, #07090D 70%)' }}>
      {display.scrubbing && (
        <div style={{ position: 'absolute', right: 10, top: 10, zIndex: 3, padding: '3px 8px', borderRadius: 10, border: '1px solid var(--color-warning)', background: '#2A1F0Bcc', color: 'var(--color-warning)', font: '9px var(--font-mono)', letterSpacing: '0.06em' }}>
          ● scrubbing
        </div>
      )}
      <div style={{ position: 'absolute', left: 0, top: 0, width: layout.stageW, height: layout.stageH, transformOrigin: '0 0', transform: `scale(${scale})` }}>
        {/* PCB grid */}
        <div style={{ position: 'absolute', inset: 0, backgroundImage: `linear-gradient(${PCB_GRID} 1px,transparent 1px),linear-gradient(90deg,${PCB_GRID} 1px,transparent 1px)`, backgroundSize: '26px 26px', opacity: 0.5 }} />
        {/* z0 traces */}
        <TraceLayer
          layout={layout} traces={traces} selection={props.selection} onSelect={props.onSelect}
          hoveredBlueprintId={props.hoveredBlueprintId} serverId={serverId} instances={display.instances}
        />
        {/* z1: engine-driven packets — BETWEEN traces and blocks, so dots ride the copper and
            disappear INTO a chip's edge instead of crawling over its text (user report
            2026-07-11: packets rendered on top of the chips read as jank). */}
        <PacketLayer serverId={serverId} layout={layout} />
        {/* z2 DOM blocks */}
        {layout.stacks.map(st => {
          const stackChips = layout.chips.filter(c => c.stackName === st.stackName)
          const stackDimmed = props.hoveredBlueprintId !== null && !stackChips.some(c => c.blueprintId === props.hoveredBlueprintId)
          return <StackPlate key={st.stackName} stack={st} dimmed={stackDimmed} selection={props.selection} onSelect={props.onSelect} />
        })}
        <NicBlock
          box={layout.nic.box} nicMbps={server?.specs.nicMbps ?? 0}
          inMbps={display.server?.nicInMbps} outMbps={display.server?.nicOutMbps}
          inboundRps={inboundRps} health={display.server?.health}
          selected={props.selection?.kind === 'nic'}
          onSelect={() => props.onSelect({ kind: 'nic' })} onHover={() => {}}
        />
        <FirewallGate
          box={layout.gate.box} rules={server?.firewall ?? []} blockedPerSecond={gateBlockedPerSecond}
          trafficActive={inboundRps > 0}
          selected={props.selection?.kind === 'firewall' || props.selection?.kind === 'rule'}
          onSelect={() => props.onSelect({ kind: 'firewall' })}
        />
        {layout.chips.map(chip => {
          const bp = doc.blueprints[chip.blueprintId]
          const m = display.instances[chip.instanceId]
          const hovered = props.hoveredBlueprintId !== null && chip.blueprintId === props.hoveredBlueprintId
          const dimmed = props.hoveredBlueprintId !== null && chip.blueprintId !== props.hoveredBlueprintId
          const selected = props.selection?.kind === 'instance' && props.selection.instanceId === chip.instanceId
          return (
            <ServiceChip
              key={chip.instanceId} chip={chip} name={bp?.name ?? '?'} color={bp?.color ?? '#888'}
              portsLabel={portsLabel(chip)}
              health={m?.health}
              connLabel={m ? `${Math.round(m.activeConnections).toLocaleString('en-US')} conn · p50 ${m.p50Ms.toFixed(1)}ms` : '—'}
              rps={m?.rps ?? 0}
              selected={selected} hovered={hovered} dimmed={dimmed}
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
        {/* Substrate instruments (D8): core bank, DIMM sticks, platter, queue-depth — right rail */}
        {server && (
          <div style={{ position: 'absolute', left: layout.hardware.box.x, top: layout.hardware.box.y, width: layout.hardware.box.w, height: layout.hardware.box.h }}>
            <HardwarePlatform
              server={server} metrics={display.server} residentInstances={residentInstances}
              blueprints={doc.blueprints} hoveredBlueprintId={props.hoveredBlueprintId}
              onHoverBlueprint={props.onHoverBlueprint} onSelect={props.onSelect}
              queueDepth={queueDepth}
            />
          </div>
        )}
      </div>
    </div>
  )
}
