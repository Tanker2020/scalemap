// src/app/world/dock/drawers/HardwareDrawer.tsx
// Polish 4 T4 (spec D6): the HARDWARE drawer body — two spec knobs (vCPU, RAM) that snap across
// `presetLadder(server.kind)` (instanceCatalog.ts). A knob commit sets the target preset's FULL
// set (`catalogId`/`specs`/`hourlyUsd`/`oversubscriptionRatio`/`burstable`) so the plate price and
// the specs can never drift apart — moving either knob just walks the SAME shared ladder index
// (both axes move together, matching how real cloud instance tiers actually price). Authoring
// posture only (T4) — T5 adds the "locked while running" re-voice on top of this pv builder.
import { type CSSProperties, type ReactElement } from 'react'
import { useWorldStore } from '../../../store/world.store'
import { presetLadder, type InstancePreset } from '../../../../lib/world/instanceCatalog'
import { hostRpsCapacity, residentRamDemandMb } from '../../ui/derived'
import type { Server, WorldDoc, CompiledWorld } from '../../../../lib/world/types'

export function hardwarePv(server: Server): string {
  const ramGb = Math.round(server.specs.ramMb / 1024)
  return `${server.specs.vcpu}c · ${ramGb}G`
}

// A server's `catalogId` matches a ladder entry exactly whenever it was born from (or last
// snapped to) a catalog preset. A custom/off-ladder spec (catalogId null, or a preset from a
// DIFFERENT kind — shouldn't happen but defensive) falls back to nearest-by-distance so the
// knobs still land somewhere sane instead of at index 0.
export function currentLadderIndex(server: Server, ladder: InstancePreset[]): number {
  if (ladder.length === 0) return -1
  const byId = ladder.findIndex(p => p.id === server.catalogId)
  if (byId >= 0) return byId
  let best = 0
  let bestDist = Infinity
  ladder.forEach((p, i) => {
    const d = Math.abs(p.specs.vcpu - server.specs.vcpu) * 100_000 + Math.abs(p.specs.ramMb - server.specs.ramMb)
    if (d < bestDist) { bestDist = d; best = i }
  })
  return best
}

export interface HardwareDrawerProps {
  server: Server
  doc: WorldDoc
  compiled: CompiledWorld
  running: boolean
}

const knobWrap: CSSProperties = { margin: '6px 0' }
const knobLabelRow: CSSProperties = { display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--color-text-secondary)' }
const knobValue: CSSProperties = { color: 'var(--color-text-primary)', fontVariantNumeric: 'tabular-nums' }
const knobInput: CSSProperties = { width: '100%', marginTop: 5, accentColor: 'var(--kit-accent)' }
const knobHint: CSSProperties = { fontSize: 9.5, color: 'var(--color-text-muted)', marginTop: 4 }
const knobHintStrong: CSSProperties = { color: 'var(--kit-accent)' }

export function HardwareDrawer({ server, doc, compiled, running }: HardwareDrawerProps): ReactElement {
  const ladder = presetLadder(server.kind)
  const index = currentLadderIndex(server, ladder)

  const commit = (nextIndex: number) => {
    const p = ladder[nextIndex]
    if (!p) return
    useWorldStore.getState().updateServer(server.id, {
      catalogId: p.id, specs: { ...p.specs }, hourlyUsd: p.hourlyUsd,
      oversubscriptionRatio: p.oversubscriptionRatio, burstable: p.burstable,
    })
  }

  // Consequence hints (guided-console grammar, D6): both read the server's FIRST resident
  // blueprint (by compiled instance) — the same "pick one representative workload" convention
  // the brief specifies for the vCPU hint, carried to RAM's per-connection size too.
  const firstInstance = Object.values(compiled.instances).find(i => i.serverId === server.id)
  const firstBlueprint = firstInstance ? doc.blueprints[firstInstance.blueprintId] : null

  const vcpuHintText = firstBlueprint
    ? `sustains ~${Math.round(hostRpsCapacity(server.specs.vcpu, firstBlueprint.workload.cpuMsPerRequest)).toLocaleString('en-US')} rps of ${firstBlueprint.name} at ${firstBlueprint.workload.cpuMsPerRequest} ms/query`
    : null

  const residentMb = residentRamDemandMb(server.id, doc, compiled)
  const ramPerConnMb = firstBlueprint?.workload.ramPerConnMb ?? 0
  const headroomConns = Math.max(0, Math.round((server.specs.ramMb - residentMb) / ramPerConnMb))
  const ramHintText = ramPerConnMb > 0
    ? `headroom for ~${headroomConns.toLocaleString('en-US')} connection${headroomConns === 1 ? '' : 's'} at ${ramPerConnMb} MB each`
    : null

  const disabled = running || ladder.length === 0

  return (
    <div data-testid="hardware-drawer-body">
      <div style={knobWrap}>
        <div style={knobLabelRow}>
          <span>vCPU</span>
          <span style={knobValue}>{server.specs.vcpu} core{server.specs.vcpu === 1 ? '' : 's'}</span>
        </div>
        <input
          type="range" aria-label="vCPU" style={knobInput}
          min={0} max={Math.max(0, ladder.length - 1)} step={1}
          value={Math.max(0, index)} disabled={disabled}
          title={running ? 'stop the simulation to edit' : undefined}
          onChange={e => commit(Number(e.target.value))}
        />
        <div style={knobHint} data-testid="vcpu-hint">
          {vcpuHintText ? <>→ <b style={knobHintStrong}>{vcpuHintText}</b></> : '→ no services mounted yet'}
        </div>
      </div>
      <div style={knobWrap}>
        <div style={knobLabelRow}>
          <span>RAM</span>
          <span style={knobValue}>{Math.round(server.specs.ramMb / 1024)} GB</span>
        </div>
        <input
          type="range" aria-label="RAM" style={knobInput}
          min={0} max={Math.max(0, ladder.length - 1)} step={1}
          value={Math.max(0, index)} disabled={disabled}
          title={running ? 'stop the simulation to edit' : undefined}
          onChange={e => commit(Number(e.target.value))}
        />
        <div style={knobHint} data-testid="ram-hint">
          {ramHintText ? <>→ <b style={knobHintStrong}>{ramHintText}</b></> : '—'}
        </div>
      </div>
    </div>
  )
}
