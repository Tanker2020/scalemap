// src/app/world/dock/drawers/ServicesDrawer.tsx
// Polish 4 T4 (spec D6): the SERVICES drawer body — one chip line per placement resident on this
// server (blueprint color swatch, name, `:port · role`, a count stepper), plus a ghosted
// "+ mount a blueprint…" line that expands to a blueprint `<select>` and dispatches
// `addPlacement(blueprintId, serverId)` — PlacementPanel's exact dispatch (relocated-dispatch
// contract). The count stepper reuses `updatePlacement(id, { count })`, clamped >= 1 (mirrors
// PlacementPanel's own `Math.max(1, ...)` clamp).
//
// Polish 4 T5 (spec D7): while watching (`liveInstances` supplied — running OR a scrub batch is
// active), the body swaps to one live row per COMPILED instance on this server (not per
// placement — a placement with count > 1 fans out to several instances, each with its own
// InstanceMetrics), health · rps, success/warning/danger colored by `HEALTH_COLOR`. The pv
// readout collapses to the server's first compiled instance (mirrors HardwareDrawer's own
// "first resident blueprint" convention for its consequence hints).
import { useState, type ReactElement } from 'react'
import { SpreadControl } from './SpreadControl'
import { AutoscaleControl } from './AutoscaleControl'
import { CanaryWeightControl } from './CanaryWeightControl'
import { AddServiceForm } from './AddServiceForm'
import { EditServiceForm } from './EditServiceForm'
import { useWorldStore } from '../../../store/world.store'
import { HEALTH_COLOR } from '../../server/healthColor'
import { isDbServerKind } from '../../../../lib/world/types'
import type { Placement, Server, WorldDoc, CompiledWorld, InstanceId } from '../../../../lib/world/types'
import type { InstanceMetrics } from '../../../../lib/worldEngine/types'

export function servicesPv(serverId: string, doc: WorldDoc, live?: { name: string; p50Ms: number } | null): string {
  if (live) return `${live.name} · p50 ${live.p50Ms.toFixed(1)} ms`
  const placements = Object.values(doc.placements).filter(p => p.serverId === serverId)
  if (placements.length === 0) return '—'
  if (placements.length === 1) {
    const pl = placements[0]
    const bp = doc.blueprints[pl.blueprintId]
    return `${bp?.name ?? '?'} ×${pl.count} · ${pl.role}`
  }
  return `${placements.length} services`
}

export interface ServicesDrawerProps {
  server: Server
  doc: WorldDoc
  compiled: CompiledWorld
  running: boolean
  liveInstances?: Record<InstanceId, InstanceMetrics> | null
  // FEAT-008 (Task 21): the batch's `MetricsBatch.runningByPlacement` (Task 16), threaded down
  // from ServerFaceplate's `display.runningByPlacement` — undefined whenever no batch has
  // published one yet (pre-first-batch, or no autoscaled placement exists at all).
  runningByPlacement?: Record<string, number>
}

export function ServicesDrawer({ server, doc, compiled, running, liveInstances, runningByPlacement }: ServicesDrawerProps): ReactElement {
  const [mounting, setMounting] = useState(false)
  const [adding, setAdding] = useState(false)
  const [editingBp, setEditingBp] = useState<string | null>(null)
  // An appliance box (a DB) owns exactly one service and accepts no others, so it offers no way
  // to author or mount another — the same rule spread's canHost() enforces on the model side.
  const isAppliance = isDbServerKind(server.kind)
  const placements = Object.values(doc.placements).filter(p => p.serverId === server.id)
  const blueprints = Object.values(doc.blueprints)

  const step = (pl: Placement, delta: number) => {
    useWorldStore.getState().updatePlacement(pl.id, { count: Math.max(1, pl.count + delta) })
  }

  const mount = (blueprintId: string) => {
    if (!blueprintId) return
    useWorldStore.getState().addPlacement(blueprintId, server.id)
    setMounting(false)
  }

  if (liveInstances) {
    const serverInstances = Object.values(compiled.instances).filter(i => i.serverId === server.id)
    // FEAT-008 (Task 19 consumer audit): `compiled.instances` is an autoscaled placement's full
    // maxCount ENVELOPE (Task 11), and a parked (scaled-in) slot is omitted from the published
    // batch entirely (Task 16). This body means "what is running right now", so a slot with no
    // published metrics must read as PARKED — not as the `?? 'healthy'` fallback (phantom running
    // capacity) and not as 'down' either, which would conflate elastic scale-in with a kill/chaos
    // fault. Gated on a non-empty published map so the pre-first-batch case (watching, nothing
    // published yet) keeps its historical healthy-fallback rendering.
    const hasPublished = Object.keys(liveInstances).length > 0
    // FEAT-008 (Task 21): group this server's envelope by placement so an autoscaled placement
    // can carry one `desired / running / max` readout line ahead of its per-instance rows,
    // without disturbing the flat per-instance iteration non-autoscaled placements still get.
    // Map preserves first-seen order, matching `serverInstances`' own (compiled.instances) order.
    const byPlacement = new Map<string, typeof serverInstances>()
    for (const inst of serverInstances) {
      const arr = byPlacement.get(inst.placementId)
      if (arr) arr.push(inst); else byPlacement.set(inst.placementId, [inst])
    }
    return (
      <div data-testid="services-drawer-body">
        {serverInstances.length === 0 && (
          <div style={{ color: 'var(--color-text-muted)', padding: '4px 2px' }}>No services mounted here yet.</div>
        )}
        {Array.from(byPlacement.entries()).map(([placementId, instances]) => {
          const pl = doc.placements[placementId]
          // Brief's exact gate: only when the batch has actually published a running count for
          // THIS placement AND it is authored as autoscaled — a placement mid-transition (just
          // toggled off autoscale, batch not yet caught up) simply gets no readout line, same as
          // the pre-Task-21 body rendered nothing extra there.
          const desired = runningByPlacement?.[placementId]
          const showReadout = hasPublished && pl?.autoscale != null && desired != null
          const runningNow = instances.filter(i => liveInstances[i.id] != null).length
          // "running still includes the draining instance briefly" (brief, Step 2): runningNow
          // can exceed desired for one tick while a scaled-in instance is still draining its
          // in-flight connections — render that gap as a distinct "draining" suffix rather than
          // silently disagreeing with `desired`.
          const draining = runningNow > (desired ?? 0)
          return (
            <div key={placementId}>
              {showReadout && (
                <div
                  data-testid="autoscale-readout"
                  style={{
                    display: 'flex', justifyContent: 'space-between', gap: 8, padding: '2px 6px 3px',
                    fontSize: 9, color: 'var(--color-text-muted)', fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  <span>autoscale</span>
                  <span style={{ color: 'var(--color-text-secondary)' }}>
                    {desired} / {runningNow} / {pl!.autoscale!.maxCount}
                    {draining && <span style={{ color: 'var(--color-warning)' }}> · draining</span>}
                  </span>
                </div>
              )}
              {instances.map(inst => {
                const bp = doc.blueprints[inst.blueprintId]
                const m = liveInstances[inst.id]
                const parked = hasPublished && !m
                const health = m?.health ?? 'healthy'
                return (
                  <div
                    key={inst.id} data-testid="service-live-row" data-parked={parked ? 'true' : 'false'}
                    style={{
                      display: 'flex', justifyContent: 'space-between', gap: 8, padding: '4px 6px', fontSize: 10,
                      opacity: parked ? 0.55 : 1,
                    }}
                  >
                    <span style={{ color: 'var(--color-text-secondary)' }}>
                      {bp?.name ?? '?'} :{bp?.ports[0]?.port ?? '—'}
                    </span>
                    {parked ? (
                      <span style={{ color: 'var(--color-text-muted)', fontVariantNumeric: 'tabular-nums' }}>parked</span>
                    ) : (
                      <span style={{ color: HEALTH_COLOR[health], fontVariantNumeric: 'tabular-nums' }}>
                        {health} · {Math.round(m?.rps ?? 0).toLocaleString('en-US')} rps
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div data-testid="services-drawer-body">
      {placements.length === 0 && (
        <div style={{ color: 'var(--color-text-muted)', padding: '4px 2px' }}>No services mounted here yet.</div>
      )}
      {placements.map(pl => {
        const bp = doc.blueprints[pl.blueprintId]
        return (
          <div key={pl.id}>
          <div
            data-testid="service-chip-line" className="kit-row"
            style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '4px 6px', borderRadius: 5 }}
          >
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: bp?.color ?? 'var(--color-text-muted)', flexShrink: 0 }} />
            <span style={{ color: 'var(--color-text-primary)' }}>{bp?.name ?? '?'}</span>
            <span style={{ color: 'var(--color-text-muted)', fontSize: 9.5 }}>
              :{bp?.ports[0]?.port ?? '—'} · {pl.role}
            </span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 3 }}>
              <button
                type="button" className="kit-press" aria-label={`edit ${bp?.name ?? 'service'}`}
                disabled={running} title={running ? 'stop the simulation to edit' : 'edit this service'}
                style={stepBtnStyle} onClick={() => setEditingBp(id => id === pl.blueprintId ? null : pl.blueprintId)}
              >
                ✎
              </button>
              <button
                type="button" className="kit-press" aria-label={`decrease ${bp?.name ?? 'placement'} count`}
                disabled={running} title={running ? 'stop the simulation to edit' : undefined}
                style={stepBtnStyle} onClick={() => step(pl, -1)}
              >
                −
              </button>
              <button
                type="button" className="kit-press" aria-label={`increase ${bp?.name ?? 'placement'} count`}
                disabled={running} title={running ? 'stop the simulation to edit' : undefined}
                style={stepBtnStyle} onClick={() => step(pl, 1)}
              >
                +
              </button>
            </span>
            <span data-testid="service-chip-count" style={{ color: 'var(--color-text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
              ×{pl.count}
            </span>
          </div>
          {/* Post-creation editor (node-model Phase 5): the ✎ on the chip opens the service's
              name/port/workload/stateful fields inline — the editing path the retired BlueprintPanel
              used to own. Dependencies stay in the Connections tab, not here. */}
          {editingBp === pl.blueprintId && (
            <div style={{ padding: '0 6px 4px' }}>
              <EditServiceForm blueprintId={pl.blueprintId} running={running} onDone={() => setEditingBp(null)} />
            </div>
          )}
          {/* Replication lives beside the service it replicates, not in a separate surface: the
              count stepper above scales this service ON THIS BOX, spread scales it ACROSS AZs. */}
          <div style={{ padding: '0 6px 4px' }}>
            <SpreadControl blueprintId={pl.blueprintId} serverId={server.id} running={running} />
          </div>
          {/* FEAT-008 (Task 21): author this placement's AutoscalePolicy — a static-count
              placement (the stepper above) and an autoscaled one are mutually exclusive on the
              SAME placement, so this toggle lives right beside the stepper it supersedes. */}
          <div style={{ padding: '0 6px 4px' }}>
            <AutoscaleControl placement={pl} running={running} />
          </div>
          {/* Wave 5 (Task 14): canaryWeight is only meaningful for a role: 'canary' placement —
              CanaryWeightControl itself renders null otherwise. */}
          <div style={{ padding: '0 6px 4px' }}>
            <CanaryWeightControl placement={pl} running={running} />
          </div>
          </div>
        )
      })}

      {mounting ? (
        <select
          aria-label="mount a blueprint" autoFocus disabled={running}
          style={{
            width: '100%', marginTop: 6, background: 'var(--color-node-base)',
            border: '1px solid var(--color-node-border)', borderRadius: 4, padding: '4px 6px',
            font: '10.5px var(--font-mono)', color: 'var(--color-text-primary)',
          }}
          defaultValue=""
          onChange={e => mount(e.target.value)}
          onBlur={() => setMounting(false)}
        >
          <option value="" disabled>choose a blueprint…</option>
          {blueprints.map(bp => <option key={bp.id} value={bp.id}>{bp.name}</option>)}
        </select>
      ) : (
        <div
          role="button" tabIndex={running ? -1 : 0} data-testid="mount-blueprint-ghost"
          aria-disabled={running || blueprints.length === 0}
          style={{
            fontSize: 10, color: 'var(--color-text-muted)', padding: '6px 6px', marginTop: 4,
            cursor: running || blueprints.length === 0 ? 'default' : 'pointer',
            opacity: running || blueprints.length === 0 ? 0.5 : 1,
          }}
          title={running ? 'stop the simulation to edit' : undefined}
          onClick={() => { if (!running && blueprints.length > 0) setMounting(true) }}
          onKeyDown={e => {
            if ((e.key === 'Enter' || e.key === ' ') && !running && blueprints.length > 0) {
              e.preventDefault(); setMounting(true)
            }
          }}
        >
          + mount a blueprint…
        </div>
      )}

      {/* Two distinct actions, deliberately both kept:
            "add a service"      — author a NEW global service and place it here (the door)
            "mount a blueprint…" — attach a service that ALREADY exists to this second host
          The second is how you hand-place a replica without spread, so the new form augments it
          rather than replacing it. An appliance box is excluded: it owns exactly one service. */}
      {!isAppliance && (adding ? (
        <AddServiceForm serverId={server.id} running={running} onDone={() => setAdding(false)} />
      ) : (
        <div
          role="button" tabIndex={running ? -1 : 0} data-testid="add-service-ghost"
          aria-disabled={running}
          style={{
            fontSize: 10, color: 'var(--color-text-muted)', padding: '6px 6px',
            cursor: running ? 'default' : 'pointer', opacity: running ? 0.5 : 1,
          }}
          title={running ? 'stop the simulation to edit' : undefined}
          onClick={() => { if (!running) setAdding(true) }}
          onKeyDown={e => {
            if ((e.key === 'Enter' || e.key === ' ') && !running) { e.preventDefault(); setAdding(true) }
          }}
        >
          + add a service…
        </div>
      ))}
    </div>
  )
}

const stepBtnStyle = {
  width: 18, height: 18, background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
  borderRadius: 4, color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 10, lineHeight: 1,
} as const
