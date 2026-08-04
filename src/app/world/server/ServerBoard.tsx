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
import { useMemo, useState, type ReactElement } from 'react'
import type { BoardLayout, StaticTrace } from './boardLayout'
import type { BlueprintId, ServerId } from '../../../lib/world/types'
import type { BoardSelection } from './selection'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useCompiledWorld } from '../useCompiledWorld'
import { replicaClusterLagSec } from '../../../lib/world/replicaLag'
import { useServerDisplayMetrics } from './useServerDisplayMetrics'
import { TraceLayer } from './TraceLayer'
import { NicBlock } from './NicBlock'
import { FirewallGate } from './FirewallGate'
import { ServiceChip } from './ServiceChip'
import { StackPlate } from './StackPlate'
import { HardwarePlatform } from './HardwarePlatform'
import { PacketLayer } from './PacketLayer'
import { blockedPerSecond } from './gateStats'
import { useFloorCamera } from '../az/useFloorCamera'

const PCB_GRID = '#101620'

// Pointerdown on any of these never starts a camera pan (see useFloorCamera's own comment):
// the board blocks ([data-chip]/[data-nic]/[data-firewall]/[data-stack]), TraceLayer's
// clickable stroke paths, and native controls keep their clicks.
const BOARD_INTERACTIVE_SEL = '[data-chip], [data-nic], [data-firewall], [data-stack], path, button, select, a, input, [data-no-pan]'

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
  // FEAT-005 (Task 15): compiled instances give us each chip's `role` (needed to know it's a
  // replica at all) — display.instances only carries the published metrics, not the role.
  const compiled = useCompiledWorld()
  // Camera (user request 2026-07-12: "the view within the server needs to be movable — zoom,
  // move around"): the floor's fit/zoom-at-cursor/drag-pan camera, verbatim, with a
  // board-specific interactive exclusion list. Replaces the old fit-only ResizeObserver scale.
  const camera = useFloorCamera(layout.stageW, layout.stageH, `${layout.stageW}x${layout.stageH}`, BOARD_INTERACTIVE_SEL)
  const running = useSimulationStore(s => s.running)
  const [mountingService, setMountingService] = useState(false)
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

  const blueprints = Object.values(doc.blueprints)

  return (
    <div
      ref={camera.containerRef}
      data-testid="board-viewport"
      onPointerDown={camera.onPointerDown}
      onPointerMove={camera.onPointerMove}
      onPointerUp={camera.onPointerUp}
      onPointerCancel={camera.onPointerUp}
      style={{
        position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden',
        background: 'radial-gradient(ellipse at 40% 35%, #0C1018 0%, #07090D 70%)',
        cursor: camera.panning ? 'grabbing' : 'grab', touchAction: 'none',
      }}
    >
      {display.scrubbing && (
        <div style={{ position: 'absolute', right: 10, top: 10, zIndex: 3, padding: '3px 8px', borderRadius: 10, border: '1px solid var(--color-warning)', background: '#2A1F0Bcc', color: 'var(--color-warning)', font: '9px var(--font-mono)', letterSpacing: '0.06em' }}>
          ● scrubbing
        </div>
      )}
      {/* Screen-space chrome: camera hint + fit, outside the transform (floor precedent). */}
      <div style={{ position: 'absolute', left: 12, bottom: 12, zIndex: 3, font: '8.5px var(--font-mono)', color: 'var(--color-text-muted)', pointerEvents: 'none' }}>
        scroll = zoom · drag = pan
      </div>
      <button
        data-no-pan aria-label="fit board to view" onClick={camera.fit}
        style={{
          position: 'absolute', right: 12, bottom: 12, zIndex: 3,
          font: '10px var(--font-mono)', background: '#10141bee', border: '1px solid var(--color-node-border)',
          color: 'var(--color-text-secondary)', borderRadius: 5, padding: '4px 12px', cursor: 'pointer',
        }}
      >
        fit
      </button>
      <div style={camera.cameraStyle}>
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
          // FEAT-005 (Task 15): the SAME "scrub-correct display batch" the gate's blocked/s
          // counter above already reads (scrubBatch ?? latestBatch) — a replica's lag readout
          // must freeze at its scrubbed value too, not keep ticking off the live clock.
          const inst = compiled.instances[chip.instanceId]
          const lagSec = inst ? replicaClusterLagSec(inst, compiled, scrubBatch ?? latestBatch ?? null) : null
          return (
            <ServiceChip
              key={chip.instanceId} chip={chip} name={bp?.name ?? '?'} color={bp?.color ?? '#888'}
              portsLabel={portsLabel(chip)}
              health={m?.health}
              connLabel={m ? `${Math.round(m.activeConnections).toLocaleString('en-US')} conn · p50 ${m.p50Ms.toFixed(1)}ms` : '—'}
              rps={m?.rps ?? 0}
              cacheHitRatio={m?.cacheHitRatio}
              cacheWarming={m?.cacheHitRatio != null && bp?.cacheConfig != null && m.cacheHitRatio < bp.cacheConfig.hitRatio - 0.001}
              replicaLagSec={lagSec ?? undefined}
              replicaLagOverRpo={lagSec != null && bp?.dbConfig?.rpoTargetSec != null && lagSec > bp.dbConfig.rpoTargetSec}
              selected={selected} hovered={hovered} dimmed={dimmed}
              onSelect={() => props.onSelect({ kind: 'instance', instanceId: chip.instanceId })}
              onHover={v => props.onHoverBlueprint(v ? chip.blueprintId : null)}
            />
          )
        })}
        {/* "+ service" ghost chip (user request 2026-07-12: "where is the ability to add new
            services within the server") — authoring only; the dock's SERVICES drawer keeps its
            own "+ mount a blueprint…" line, this is the same addPlacement dispatch surfaced on
            the board itself, in the next process-column slot. */}
        {!running && (mountingService ? (
          <select
            data-no-pan aria-label="mount a blueprint" autoFocus defaultValue=""
            style={{
              position: 'absolute', left: layout.ghostChip.x, top: layout.ghostChip.y + layout.ghostChip.h / 2 - 13,
              width: layout.ghostChip.w + 46, background: 'var(--color-node-base)',
              border: '1px solid var(--color-node-border)', borderRadius: 4, padding: '4px 6px',
              font: '10.5px var(--font-mono)', color: 'var(--color-text-primary)', zIndex: 3,
            }}
            onChange={e => {
              if (!e.target.value) return
              useWorldStore.getState().addPlacement(e.target.value, serverId)
              setMountingService(false)
            }}
            onBlur={() => setMountingService(false)}
          >
            <option value="" disabled>choose a blueprint…</option>
            {blueprints.map(bp => <option key={bp.id} value={bp.id}>{bp.name}</option>)}
          </select>
        ) : (
          <button
            data-no-pan data-testid="board-add-service"
            disabled={blueprints.length === 0}
            title={blueprints.length === 0 ? 'create a blueprint first (world scope › Blueprints)' : 'mount a blueprint on this server'}
            onClick={() => setMountingService(true)}
            style={{
              position: 'absolute', left: layout.ghostChip.x, top: layout.ghostChip.y,
              width: layout.ghostChip.w, height: layout.ghostChip.h,
              background: 'none', border: '1px dashed #2a3140', borderRadius: 6,
              color: 'var(--color-text-muted)', font: '10px var(--font-mono)',
              cursor: blueprints.length === 0 ? 'default' : 'pointer',
              opacity: blueprints.length === 0 ? 0.5 : 1,
            }}
          >
            + service
          </button>
        ))}
        {layout.overflowCount > 0 && (
          <div style={{ position: 'absolute', left: 250, bottom: 8, color: 'var(--color-text-muted)', font: '9px var(--font-mono)' }}>
            +{layout.overflowCount} more instance{layout.overflowCount > 1 ? 's' : ''}
          </div>
        )}
        {/* Substrate instruments (D8): core bank, DIMM sticks, platter, queue-depth — right rail */}
        {server && (
          <div data-no-pan style={{ position: 'absolute', left: layout.hardware.box.x, top: layout.hardware.box.y, width: layout.hardware.box.w, height: layout.hardware.box.h }}>
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
