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
