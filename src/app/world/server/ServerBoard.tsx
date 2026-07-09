// src/app/world/server/ServerBoard.tsx
// Fixed-composition stage (D1): scale-to-fit a 1000x560 logical space; PCB grid bg; layer stack
// TraceLayer (SVG z0) → DOM blocks (z1) → PacketLayer (canvas z2, T5: engine-driven particles).
// T4 wires live metrics (useServerDisplayMetrics, D5) into ServiceChip/NicBlock and mounts the
// unified HardwarePlatform (D4) at layout.hardware.box. T5 also feeds gateStats.blockedPerSecond
// into FirewallGate's "✕ N/s blocked" line from the store's events + latestBatch.simMs.
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { attributeCores, type BoardLayout, type CoreAttribution, type StaticTrace } from './boardLayout'
import type { BlueprintId, InstanceId, ServerId } from '../../../lib/world/types'
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
  const gateBlockedPerSecond = blockedPerSecond(events, serverId, latestBatch?.simMs ?? 0)

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
        <TraceLayer layout={layout} traces={traces} selection={props.selection} onSelect={props.onSelect} hoveredBlueprintId={props.hoveredBlueprintId} />
        {/* z1 DOM blocks */}
        {layout.stacks.map(st => <StackPlate key={st.stackName} stack={st} selection={props.selection} onSelect={props.onSelect} />)}
        <NicBlock
          box={layout.nic.box} nicMbps={server?.specs.nicMbps ?? 0}
          inMbps={display.server?.nicInMbps} outMbps={display.server?.nicOutMbps}
          utilFraction={display.server && server?.specs.nicMbps ? (display.server.nicInMbps + display.server.nicOutMbps) / server.specs.nicMbps : undefined}
          onSelect={() => props.onSelect({ kind: 'nic' })} onHover={() => {}}
        />
        <FirewallGate box={layout.gate.box} ruleCount={server?.firewall.length ?? 0} blockedPerSecond={gateBlockedPerSecond} onSelect={() => props.onSelect({ kind: 'firewall' })} />
        {layout.chips.map(chip => {
          const bp = doc.blueprints[chip.blueprintId]
          const m = display.instances[chip.instanceId]
          return (
            <ServiceChip
              key={chip.instanceId} chip={chip} name={bp?.name ?? '?'} color={bp?.color ?? '#888'}
              portsLabel={portsLabel(chip)}
              health={m?.health}
              connLabel={m ? `${m.activeConnections} conn · p50 ${m.p50Ms.toFixed(1)}ms` : '—'}
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
        {/* Unified hardware platform (D4): CPU die, RAM reservoir, disk platter — right rail */}
        {server && (
          <div style={{ position: 'absolute', left: layout.hardware.box.x, top: layout.hardware.box.y, width: layout.hardware.box.w, height: layout.hardware.box.h }}>
            <HardwarePlatform
              server={server} metrics={display.server} residentBlueprints={residentBlueprints}
              attribution={attribution} hoveredBlueprintId={props.hoveredBlueprintId}
              onHoverBlueprint={props.onHoverBlueprint} onSelect={props.onSelect}
              memLimits={memLimits} instanceRamMb={instanceRamMb}
            />
          </div>
        )}
        {/* z2: engine-driven packets */}
        <PacketLayer serverId={serverId} layout={layout} />
      </div>
    </div>
  )
}
