// src/app/world/dock/AzConfigTab.tsx
// Polish 4 T3 (spec D3/D5): AZ scope's Config tab body, under the FloorPlanHeader minimap —
// rack capacity wells, a slat row per server (racked first, then free pool, tap = select — the
// SAME shared `ui.store.selectedServerId` the floor/minimap read+write), this AZ's cost, and the
// floor toolbar's authoring actions relocated byte-for-byte (`+ server`/`auto-arrange`/
// `kill AZ`) — see each action's own comment below for its exact origin.
import { useMemo, useState, type CSSProperties, type ReactElement } from 'react'
import { useReducedMotion } from 'framer-motion'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useUiStore } from '../../store/ui.store'
import { useCompiledWorld } from '../useCompiledWorld'
import { rackUsedU } from '../../../lib/world/rackModel'
import { NodePalette } from '../az/NodePalette'
import { serverAccents, meanUtilization } from '../az/floorData'
import { AzConnectionsView } from '../az/AzConnectionsView'
import { healthWord } from '../ui/derived'
import { scopedCost } from './scopeData'
import { ChaosControl, isNonFatalFault, NON_FATAL_FAULT_ACCENT } from './ChaosControl'
import { azConnectionGraph } from '../../../lib/world/connections'
import { INSTANCE_CATALOG, getPreset } from '../../../lib/world/instanceCatalog'
import { field } from '../panels/panelStyles'
import type { RackId, Server, ServerId } from '../../../lib/world/types'
import type { HealthState } from '../../../lib/worldEngine/types'
import './floorPlanStyles'

export interface AzConfigTabProps { azId: string }

const HEALTH_LED_COLOR: Record<HealthState, string> = {
  healthy: 'var(--color-success)', degraded: 'var(--color-warning)', down: 'var(--color-danger)',
}

function byLabelThenId(a: { label: string; id: string }, b: { label: string; id: string }): number {
  return a.label.localeCompare(b.label) || a.id.localeCompare(b.id)
}

// Hatched industrial section rail (spec D5, mock `.azsec::after`'s `repeating-linear-gradient`
// stripe) — tokenized (below-header law: `var(--color-*)` only past the minimap).
function SectionRail({ label }: { label: string }): ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0 7px', minWidth: 0 }}>
      <span style={{ fontSize: 9, letterSpacing: '0.14em', color: 'var(--color-text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>
        {label}
      </span>
      <div aria-hidden style={{
        flex: 1, height: 3, minWidth: 8, borderRadius: 2,
        background: 'repeating-linear-gradient(-45deg, var(--color-node-border) 0 4px, transparent 4px 8px)',
      }} />
    </div>
  )
}

// C1 fix (final wave-5 review): the batch-edit affordance (originally Task 18, hosted only in
// TopologyPanel.tsx, a world-scope-only tab) is unreachable in the running app — multi-select
// only originates on this AZ's floor (`ui.store.ts`'s `selectedEntityIds`), and the ONLY way to
// reach TopologyPanel is to navigate to world scope, which is the SAME navigation
// (`WorldShell.tsx`'s nav-clear effect fires on any `nav.level` change) that empties the
// selection before the world-scope tab ever mounts. This copy renders at AZ scope instead —
// exactly where a multi-selection can actually exist (`dock/scope.ts`'s `deriveScope`: a 2+
// selection keeps AZ scope, never narrows to server scope) — so it's reachable without leaving
// the floor. TopologyPanel's own copy is left in place (harmless, still covered by its own
// tests) rather than deleted, since removing it isn't required to fix reachability.
function AzBatchEditBar({ azId }: { azId: string }) {
  const selectedEntityIds = useUiStore(s => s.selectedEntityIds)
  const doc = useWorldStore(s => s.doc)
  const store = useWorldStore.getState()
  // Scoped to THIS az's servers — a selection can't legitimately span AZs (the floor's
  // marquee/click selection only ever targets servers physically on this floor), but this guard
  // keeps a stale foreign id (if one ever slipped through) from being batch-edited here.
  const selectedServerIds = [...selectedEntityIds].filter(id => doc.servers[id]?.azId === azId)

  if (selectedServerIds.length < 2) return null

  const applyClass = (presetId: string) => {
    const p = getPreset(presetId)
    if (!p) return
    store.batchUpdateServers(selectedServerIds, {
      catalogId: p.id, specs: { ...p.specs }, hourlyUsd: p.hourlyUsd,
      oversubscriptionRatio: p.oversubscriptionRatio, burstable: p.burstable,
    })
  }

  return (
    <div data-testid="batch-edit-bar" style={{
      display: 'flex', alignItems: 'center', gap: 6, margin: '2px 0 8px', padding: '4px 6px',
      borderRadius: 4, border: '1px dashed var(--kit-accent)',
    }}>
      <span style={{ fontSize: 9.5, color: 'var(--color-text-secondary)' }}>
        {selectedServerIds.length} selected
      </span>
      <select aria-label="batch instance class" style={{ ...field, flex: 1, marginBottom: 0 }}
        defaultValue="" onChange={e => { if (e.target.value) applyClass(e.target.value) }}>
        <option value="" disabled>apply instance class to all…</option>
        {INSTANCE_CATALOG.map(p => <option key={p.id} value={p.id}>{p.id}</option>)}
      </select>
    </div>
  )
}

const actionBtn: CSSProperties = {
  font: '10px var(--font-mono)', background: 'var(--color-node-base)',
  border: '1px solid var(--color-node-border)', borderRadius: 5, padding: '4px 12px',
  color: 'var(--color-text-secondary)', cursor: 'pointer',
}
const actionBtnLocked: CSSProperties = { ...actionBtn, opacity: 0.35, cursor: 'default' }

export function AzConfigTab({ azId }: AzConfigTabProps): ReactElement {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const running = useSimulationStore(s => s.running)
  const batch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const activeFault = useSimulationStore(s => s.activeFaults[azId] ?? null)
  const selectedServerId = useUiStore(s => s.selectedServerId)
  const setSelectedServerId = useUiStore(s => s.setSelectedServerId)
  const reducedMotion = useReducedMotion() ?? false

  const az = doc.azs[azId]

  const azServers = useMemo(() => Object.values(doc.servers).filter(s => s.azId === azId), [doc.servers, azId])
  const racks = useMemo(() => Object.values(doc.racks).filter(r => r.azId === azId).sort(byLabelThenId), [doc.racks, azId])
  const rackedByRack = useMemo(() => {
    const m: Record<RackId, Server[]> = {}
    for (const rack of racks) m[rack.id] = []
    for (const s of azServers) {
      if (s.rack && m[s.rack.rackId]) m[s.rack.rackId].push(s)
    }
    for (const rackId of Object.keys(m)) {
      m[rackId].sort((a, b) => (a.rack!.unit - b.rack!.unit) || a.label.localeCompare(b.label))
    }
    return m
  }, [racks, azServers])
  const freePool = useMemo(() => azServers.filter(s => s.rack === null).sort(byLabelThenId), [azServers])
  const accentsByServer = useMemo(() => serverAccents(doc, compiled), [doc.blueprints, compiled.instances])

  // Slat order (D5): racked servers first (rack order, then unit within rack), then free pool.
  const orderedServers = useMemo(
    () => [...racks.flatMap(r => rackedByRack[r.id] ?? []), ...freePool],
    [racks, rackedByRack, freePool],
  )

  // Managed cloud services present in this AZ (node-model Phase 5.3): az-scoped here, plus
  // region-scoped ones (which render on every AZ's floor). Shown in the slat list so a cloud
  // appliance reads as part of the AZ, matching the floor box — even though it has no hardware.
  const managedHere = useMemo(
    () => Object.values(doc.managedServices).filter(m =>
      (m.scope.kind === 'az' && m.scope.azId === azId) ||
      (m.scope.kind === 'region' && m.scope.regionId === az?.regionId)),
    [doc.managedServices, azId, az?.regionId],
  )

  // Read-only, AZ-filtered subgraph of compiled.paths (2026-07-25) — the world-scope Connections
  // tab/graph is still the only authoring surface (see connections.ts's azConnectionGraph comment
  // for why a dependency has no single AZ it could be authored against); "open graph" below just
  // views what actually runs through here, in the SAME node/edge visual language as the world
  // graph (AzConnectionsView.tsx), not a separate list representation.
  const azGraph = useMemo(() => azConnectionGraph(doc, compiled, azId), [doc, compiled, azId])
  const [connectionsOpen, setConnectionsOpen] = useState(false)

  // Motion budget (D3): the dock's ONE ambient stroke at AZ scope — a single blinking LED for
  // the single busiest server by live mean CPU, running only, never reduced-motion. Reuses the
  // floor's own `MAX_ANIMATED_LEDS`-style ranking shape (DatacenterFloor.tsx), just capped at a
  // budget of 1 instead of 3 (that budget is the floor's OWN separate motion allowance — the
  // dock's is independent and smaller, per D3's per-instrument "ONE ambient stroke" law).
  const busiestServerId = useMemo(() => {
    if (!running || reducedMotion) return null
    let best: { id: ServerId; cpuMean: number } | null = null
    for (const s of azServers) {
      const cpuMean = meanUtilization(batch?.servers[s.id]?.coreUtilization)
      if (cpuMean > 0 && (!best || cpuMean > best.cpuMean)) best = { id: s.id, cpuMean }
    }
    return best?.id ?? null
  }, [azServers, batch, running, reducedMotion])

  // T8 fix (T3 carry-forward Minor): reads the SAME `scopedCost` helper FloorPlanHeader already
  // uses for this AZ's headline, instead of re-deriving `computeWorldCost().byAz` inline —
  // dedupes the two call sites and makes module-boundaries.md's "reads the SAME helper" claim
  // true. `regionId` is only read by scopedCost's server branch, so `az?.regionId ?? ''` is safe
  // here too (FloorPlanHeader's own precedent, scopeData.ts's az branch never touches it).
  // FEAT-008 (Task 21, controller-added gap): fold runningByPlacement in — see scopedCost's own comment.
  const azWorldForCost = batch?.world ? { ...batch.world, runningByPlacement: batch.runningByPlacement } : null
  const azCost = scopedCost({ kind: 'az', regionId: az?.regionId ?? '', azId }, doc, azWorldForCost, batch?.managedServices ?? null)

  // "+ rack" ghost (D5): hidden while running, same precedent as the floor's own ghost rack
  // (DatacenterFloor.tsx's `{ghostCell && !running && (...)}`).
  const ghostVisible = !running

  return (
    <div
      data-testid="az-config-tab"
      style={isNonFatalFault(activeFault) ? { ...NON_FATAL_FAULT_ACCENT, borderRadius: 6 } : undefined}
    >
      <SectionRail label="RACKS — capacity wells" />
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 10, flexShrink: 0, paddingTop: 2, flexWrap: 'wrap' }}>
          {racks.map(rack => {
            const used = rackUsedU(doc, rack.id)
            const fraction = rack.capacityU > 0 ? Math.min(1, used / rack.capacityU) : 0
            return (
              <div key={rack.id} style={{ width: 34 }}>
                <div data-testid="rack-well" style={{
                  height: 72, border: '1px solid var(--color-node-border)', borderRadius: 4,
                  position: 'relative', background: 'var(--color-canvas)', overflow: 'hidden',
                }}>
                  <div style={{
                    position: 'absolute', left: 2, right: 2, bottom: 2, height: `${fraction * 100}%`,
                    borderRadius: 2,
                    background: 'linear-gradient(180deg, var(--kit-teal), color-mix(in srgb, var(--kit-teal) 40%, transparent))',
                  }} />
                  {/* U-notch rung overlay (mock's `.well::after`) */}
                  <div aria-hidden style={{
                    position: 'absolute', inset: 0, opacity: 0.6,
                    background: 'repeating-linear-gradient(180deg, transparent 0 8px, var(--color-canvas) 8px 9.5px)',
                  }} />
                  {/* Delete rack — edit-locked while running (same `!running` gate as the "+ rack"
                      ghost). Dispatches the store's `removeRack`, which frees any resident servers
                      to the pool then deletes, one undo step. */}
                  {!running && (
                    <button
                      type="button" data-testid="rack-delete" title={`delete ${rack.label}`}
                      aria-label={`delete ${rack.label}`}
                      onClick={() => useWorldStore.getState().removeRack(rack.id)}
                      style={{
                        position: 'absolute', top: 1, right: 1, width: 13, height: 13, lineHeight: '11px',
                        padding: 0, borderRadius: 3, cursor: 'pointer',
                        font: '10px var(--font-mono)', color: 'var(--color-danger)',
                        background: 'color-mix(in srgb, var(--color-canvas) 80%, transparent)',
                        border: '1px solid color-mix(in srgb, var(--color-danger) 30%, transparent)',
                      }}
                    >×</button>
                  )}
                </div>
                <small style={{ display: 'block', textAlign: 'center', fontSize: 8.5, color: 'var(--color-text-muted)', marginTop: 4 }}>
                  {rack.label}<br />{used}/{rack.capacityU}U
                </small>
              </div>
            )
          })}
          {ghostVisible && (
            <div style={{ width: 34 }}>
              <button
                type="button" data-testid="rack-well-ghost" className="dockfp-rackwell-ghost"
                style={{
                  height: 72, width: 34, border: '1px dashed var(--color-node-border)', borderRadius: 4,
                  background: 'none', opacity: 0.5, cursor: 'pointer', padding: 0,
                }}
                onClick={() => useWorldStore.getState().addRack(azId)}
              />
              <small style={{ display: 'block', textAlign: 'center', fontSize: 8.5, color: 'var(--color-text-muted)', marginTop: 4 }}>
                + rack
              </small>
            </div>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <SectionRail label="SERVERS — tap = select on floor" />
          <AzBatchEditBar azId={azId} />
          {orderedServers.length === 0 && (
            <div style={{ color: 'var(--color-text-muted)', padding: '4px 2px 10px' }}>No servers yet in this AZ.</div>
          )}
          {orderedServers.map(server => {
            const sm = batch?.servers[server.id]
            const health = sm?.health ?? 'healthy'
            const cpuMean = meanUtilization(sm?.coreUtilization)
            const ramFraction = sm && sm.ramTotalMb > 0 ? sm.ramUsedMb / sm.ramTotalMb : 0
            const meta = batch ? `${server.kind} · ${healthWord(cpuMean, ramFraction)}` : server.kind
            const blinking = server.id === busiestServerId
            const accents = accentsByServer.get(server.id) ?? []
            // A foreign selection (a server outside this AZ) can legitimately keep AzConfigTab
            // mounted while `selectedServerId` is set (see `dock/scope.ts`'s `deriveScope` guard)
            // — this only ever lights up a row that's actually IN this list.
            const selected = server.id === selectedServerId
            return (
              // A plain <div>, not a <button> (EdgeRow/RegionConfigTab's exact precedent,
              // RegionConfigTab.tsx's own comment: "nav-only, never edit-locked... EdgeRow
              // renders a plain <div>, which a <fieldset disabled> doesn't touch anyway, unlike
              // a <button>"). Selecting a server is NOT authoring — WorldPanel.tsx wraps this
              // whole tab body in <fieldset disabled={running}>, which would otherwise silently
              // kill "tap = select on floor" for the entire duration of every simulation run —
              // confirmed live (Playwright against `npm run dev`) before this fix landed.
              <div
                key={server.id} role="button" tabIndex={0} data-testid="dock-slat" className="dockfp-slat"
                data-blinking={blinking ? 'true' : 'false'} data-selected={selected ? 'true' : undefined}
                style={selected ? { borderColor: 'var(--kit-accent)' } : undefined}
                onClick={() => setSelectedServerId(server.id)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedServerId(server.id) } }}
              >
                <span
                  aria-hidden
                  className={blinking ? 'dockfp-led-blink' : undefined}
                  style={{
                    width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
                    background: HEALTH_LED_COLOR[health], boxShadow: `0 0 4px ${HEALTH_LED_COLOR[health]}`,
                  }}
                />
                <span style={{ color: 'var(--color-text-primary)' }}>{server.label}</span>
                {accents.length > 0 && (
                  <span style={{ display: 'flex', gap: 3 }}>
                    {accents.slice(0, 3).map((c, i) => (
                      <i key={i} aria-hidden style={{ width: 6, height: 3, borderRadius: 1, background: c, display: 'block' }} />
                    ))}
                  </span>
                )}
                <span style={{ marginLeft: 'auto', color: 'var(--color-text-muted)', fontSize: 9 }}>{meta}</span>
              </div>
            )
          })}
          {/* Managed cloud services (node-model Phase 5.3) — not selectable (no floor server to
              tap), shown so the appliance is visibly part of the AZ, with its live rps + health. */}
          {managedHere.map(m => {
            const mm = batch?.managedServices?.[m.id]
            const health = mm?.health ?? 'healthy'
            const regionWide = m.scope.kind === 'region'
            return (
              <div key={m.id} data-testid={`az-managed-${m.id}`} className="dockfp-slat" style={{ cursor: 'default' }}>
                <span
                  aria-hidden
                  style={{
                    width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
                    background: HEALTH_LED_COLOR[health], boxShadow: `0 0 4px ${HEALTH_LED_COLOR[health]}`,
                  }}
                />
                <span style={{ color: 'var(--color-text-primary)' }}>{m.label}</span>
                {/* Phase 5.4 saturation bar: the list showed rps text only, so a DB could be pinned
                    at its ceiling and read the same as an idle one. Fills on the DB's binding-axis
                    saturation when the runtime publishes it, else the coarse utilization gauge. */}
                {mm && (
                  <span
                    aria-hidden
                    style={{
                      width: 34, height: 4, borderRadius: 2, marginLeft: 6, flexShrink: 0,
                      background: 'var(--color-surface)', overflow: 'hidden', display: 'block', position: 'relative',
                    }}
                  >
                    <span style={{
                      position: 'absolute', inset: '0 auto 0 0', height: '100%', display: 'block',
                      width: `${Math.max(2, Math.round(Math.min(1, (mm.saturation ?? 0) > 0 ? mm.saturation! : mm.utilization) * 100))}%`,
                      background: HEALTH_LED_COLOR[health],
                    }} />
                  </span>
                )}
                <span style={{ marginLeft: 'auto', color: 'var(--color-text-muted)', fontSize: 9 }}>
                  {mm ? `${Math.round(mm.rps)} rps · ` : ''}
                  {mm && (mm.p50Ms ?? 0) > 0
                    ? `${Math.round(Math.min(1, mm.saturation ?? 0) * 100)}% · ${mm.p50Ms! < 10 ? mm.p50Ms!.toFixed(1) : Math.round(mm.p50Ms!)}ms · ${Math.round(mm.connections ?? 0)}c · `
                    : ''}
                  {m.nodeType} · managed{regionWide ? ' · region' : ''}
                  {mm && (mm.errorRps ?? 0) > 0.5 ? ' ⚠' : ''}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      <SectionRail label="THIS AZ'S COST" />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 8px' }}>
        <span style={{ color: 'var(--color-text-secondary)' }}>servers + egress share</span>
        <span style={{ color: 'var(--color-price)', fontVariantNumeric: 'tabular-nums' }}>
          ${azCost.hourlyUsd.toFixed(2)}/hr · ${azCost.monthlyUsd.toFixed(0)}/mo
        </span>
      </div>

      <SectionRail label="CONNECTIONS — through this AZ" />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 8px' }}>
        <span style={{ color: 'var(--color-text-secondary)', fontSize: 10.5 }}>
          {azGraph.edges.length === 0
            ? 'No connections touch this AZ yet.'
            : `${azGraph.edges.length} connection${azGraph.edges.length === 1 ? '' : 's'} touch this AZ`}
        </span>
        <button
          type="button" className="kit-press" style={azGraph.edges.length === 0 ? actionBtnLocked : actionBtn}
          disabled={azGraph.edges.length === 0} onClick={() => setConnectionsOpen(true)}
        >
          open graph ↗
        </button>
      </div>
      <AzConnectionsView azId={azId} open={connectionsOpen} onClose={() => setConnectionsOpen(false)} />

      {/* The typed node palette replaces the old hardcoded "+ server" (which always dropped a
          vps-medium). Compute entries add an empty host; data entries add a preconfigured DB
          appliance. Shared with the floor toolbar so the two can't drift. */}
      <SectionRail label="ADD A NODE" />
      <NodePalette azId={azId} />

      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        {/* "auto-arrange": the floor toolbar's EXACT dispatch (`autoArrangeAz(azId)`). */}
        <button
          type="button" className="kit-press" style={running ? actionBtnLocked : actionBtn} disabled={running}
          title={running ? 'stop the simulation to edit' : undefined}
          onClick={() => useWorldStore.getState().autoArrangeAz(azId)}
        >
          auto-arrange
        </button>
        {/* "kill AZ": the shared ChaosControl split button (FEAT-001 Task 8), fieldset-escaped —
            run-only (disabled while stopped, standard title), clickable exactly while
            `running` despite sitting inside WorldPanel.tsx's ambient
            `<fieldset disabled={running}>` edit-lock — confirmed live (Playwright against
            `npm run dev`) before this escape first landed. */}
        <ChaosControl scope="az" id={azId} running={running} label={az?.label ?? azId} killLabel="kill AZ" escapeFieldset />
      </div>
    </div>
  )
}
