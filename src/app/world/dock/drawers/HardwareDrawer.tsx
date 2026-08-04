// src/app/world/dock/drawers/HardwareDrawer.tsx
// Polish 4 T4 (spec D6): the HARDWARE drawer body — two spec knobs (vCPU, RAM) that snap across
// `presetLadder(server.kind)` (instanceCatalog.ts). A knob commit sets the target preset's FULL
// set (`catalogId`/`specs`/`hourlyUsd`/`oversubscriptionRatio`/`burstable`) so the plate price and
// the specs can never drift apart — moving either knob just walks the SAME shared ladder index
// (both axes move together, matching how real cloud instance tiers actually price).
//
// Polish 4 T5 (spec D7): "the shape never changes — only its temperature." When `live` is
// supplied (watching posture — running OR a scrub batch is active, ServerFaceplate's call),
// this body swaps from the two draggable knobs to two FROZEN gauges (opacity 0.55, no
// `<input>` at all — "thumb hidden" taken literally, not just visually: nothing here is
// draggable during a scrub replay either) with the LIVE cpu/ram fraction as the track fill
// behind the still-shown spec value, above two live rows (rps, ram). `hardwarePv` grows an
// optional second arg for the same reason — the pv readout is text, T5 only changes what text.
import { type CSSProperties, type ReactElement } from 'react'
import { useWorldStore } from '../../../store/world.store'
import { presetLadder, type InstancePreset } from '../../../../lib/world/instanceCatalog'
import { hostRpsCapacity, residentRamDemandMb } from '../../ui/derived'
import type { Server, WorldDoc, CompiledWorld } from '../../../../lib/world/types'

export function hardwarePv(server: Server, live?: { cpuPct: number; ramPct: number } | null): string {
  if (live) return `${live.cpuPct}% cpu · ${live.ramPct}% ram`
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

// The live re-voice (D7): rps is Σ InstanceMetrics.rps for this server's instances (frozen
// contract — ServerFaceplate computes it once and shares it with FirewallDrawer's pv too), the
// rest is ServerMetrics straight from `useServerDisplayMetrics` (scrub-or-latest). No metric
// here is invented — `cpuFraction`/`ramFraction` are the SAME derivations the vitals gauges use.
export interface HardwareLive {
  cpuFraction: number
  ramFraction: number
  rps: number
  ramUsedMb: number
  ramTotalMb: number
}

export interface HardwareDrawerProps {
  server: Server
  doc: WorldDoc
  compiled: CompiledWorld
  running: boolean
  live?: HardwareLive | null
}

const knobWrap: CSSProperties = { margin: '6px 0' }
const knobLabelRow: CSSProperties = { display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--color-text-secondary)' }
const knobValue: CSSProperties = { color: 'var(--color-text-primary)', fontVariantNumeric: 'tabular-nums' }
const knobInput: CSSProperties = { width: '100%', marginTop: 5, accentColor: 'var(--kit-accent)' }
const knobHint: CSSProperties = { fontSize: 9.5, color: 'var(--color-text-muted)', marginTop: 4 }
const knobHintStrong: CSSProperties = { color: 'var(--kit-accent)' }

// Disk fields (Task 22, FEAT-006): unlike vCPU/RAM, diskIops/diskType are NOT ladder-driven —
// there's no preset walk to snap to, so these are plain field inputs (AddServiceForm.tsx's
// `field` style precedent) rather than range knobs.
const diskField: CSSProperties = {
  font: '10px var(--font-mono)', marginTop: 5, background: 'var(--color-node-base)',
  border: '1px solid var(--color-node-border)', borderRadius: 4,
  padding: '3px 6px', color: 'var(--color-text-primary)', width: '100%',
}

const liveRow: CSSProperties = { display: 'flex', justifyContent: 'space-between', fontSize: 10, padding: '3px 0', color: 'var(--color-text-secondary)' }
const liveRowValue: CSSProperties = { color: 'var(--color-text-primary)', fontVariantNumeric: 'tabular-nums' }
const frozenKnobWrap: CSSProperties = { ...knobWrap, opacity: 0.55 }
const frozenTrack: CSSProperties = {
  position: 'relative', width: '100%', height: 5, borderRadius: 3, marginTop: 6,
  background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)', overflow: 'hidden',
}
function frozenFill(pct: number): CSSProperties {
  return { position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct}%`, background: 'var(--color-success)' }
}

export function HardwareDrawer({ server, doc, compiled, running, live }: HardwareDrawerProps): ReactElement {
  // T8 fix (T5 carry-forward Minor): the live (watching) branch never reads the ladder/knob/
  // consequence-hint computations below — they're authoring-only. Checking `live` FIRST means a
  // watching render (the common case while running, or scrubbing) does none of that work; it
  // used to be computed unconditionally above this branch and simply discarded.
  if (live) {
    const cpuPct = Math.round(Math.min(1, Math.max(0, live.cpuFraction)) * 100)
    const ramPct = Math.round(Math.min(1, Math.max(0, live.ramFraction)) * 100)
    const ramUsedGb = (live.ramUsedMb / 1024).toFixed(1)
    const ramTotalGb = (live.ramTotalMb / 1024).toFixed(1)
    return (
      <div data-testid="hardware-drawer-body">
        <div style={liveRow} data-testid="hw-live-rps">
          <span>rps</span>
          <span style={liveRowValue}>{Math.round(live.rps).toLocaleString('en-US')}</span>
        </div>
        <div style={liveRow} data-testid="hw-live-ram">
          <span>ram</span>
          <span style={liveRowValue}>{ramUsedGb} / {ramTotalGb} GB</span>
        </div>
        <div style={frozenKnobWrap} title="locked while running" data-testid="hw-frozen-vcpu">
          <div style={knobLabelRow}>
            <span>vCPU — locked while running</span>
            <span style={knobValue}>{server.specs.vcpu} core{server.specs.vcpu === 1 ? '' : 's'}</span>
          </div>
          <div style={frozenTrack}><div style={frozenFill(cpuPct)} /></div>
        </div>
        <div style={frozenKnobWrap} title="locked while running" data-testid="hw-frozen-ram">
          <div style={knobLabelRow}>
            <span>RAM — locked while running</span>
            <span style={knobValue}>{Math.round(server.specs.ramMb / 1024)} GB</span>
          </div>
          <div style={frozenTrack}><div style={frozenFill(ramPct)} /></div>
        </div>
      </div>
    )
  }

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

  // Direct specs patch — no ladder involved, so this bypasses `commit` entirely (unlike vCPU/RAM,
  // there's no catalog preset carrying diskIops/diskType to snap to).
  const commitDiskType = (value: string) => {
    useWorldStore.getState().updateServer(server.id, {
      specs: { ...server.specs, diskType: value === '' ? undefined : (value as 'hdd' | 'ssd' | 'nvme') },
    })
  }
  const commitDiskIops = (value: string) => {
    const n = value === '' ? undefined : Math.max(0, Math.round(Number(value)))
    useWorldStore.getState().updateServer(server.id, { specs: { ...server.specs, diskIops: n } })
  }

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
      <div style={knobWrap}>
        <div style={knobLabelRow}>
          <span>Disk Type</span>
          <span style={knobValue}>{server.specs.diskType ?? 'auto'}</span>
        </div>
        <select
          aria-label="Disk Type" data-testid="disk-type-select" style={diskField}
          value={server.specs.diskType ?? ''} disabled={running}
          title={running ? 'stop the simulation to edit' : undefined}
          onChange={e => commitDiskType(e.target.value)}
        >
          <option value="">auto — unbounded</option>
          <option value="hdd">hdd</option>
          <option value="ssd">ssd</option>
          <option value="nvme">nvme</option>
        </select>
        <div style={knobHint}>→ sets the IOPS ceiling family disk-saturation modeling uses</div>
      </div>
      <div style={knobWrap}>
        <div style={knobLabelRow}>
          <span>Disk IOPS</span>
          <span style={knobValue}>{server.specs.diskIops != null ? server.specs.diskIops.toLocaleString('en-US') : 'auto'}</span>
        </div>
        <input
          type="number" aria-label="Disk IOPS" data-testid="disk-iops-input" style={diskField}
          min={0} step={100} placeholder="auto"
          value={server.specs.diskIops ?? ''} disabled={running}
          title={running ? 'stop the simulation to edit' : undefined}
          onChange={e => commitDiskIops(e.target.value)}
        />
        <div style={knobHint}>→ overrides the {server.specs.diskType ?? 'auto'} default IOPS ceiling</div>
      </div>
    </div>
  )
}
