import { useState, useMemo, useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react'
import { TopologyPanel } from './TopologyPanel'
import { BlueprintPanel } from './BlueprintPanel'
import { PlacementPanel } from './PlacementPanel'
import { TrafficPanel } from './TrafficPanel'
import { AnalysisTab, unsuppressedCompileFindings } from './AnalysisTab'
import { useCompiledWorld } from '../useCompiledWorld'
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useUiStore, type PanelTab } from '../../store/ui.store'
import { runAnalysis } from '../../../lib/analysis/runAnalysis'
import { EventsTab } from '../EventsTab'
import { CostTab } from '../CostTab'
import { panel, sectionLabel } from './panelStyles'
import { ChipValue } from '../ui/kit'
import { useRollingNumber } from '../ui/motion'
import { computeWorldCost, HOURS_PER_MONTH } from '../../../lib/costModelV2'
import { ScopeRail } from '../dock/ScopeRail'
import { deriveScope, scopeTabs, type DockScope } from '../dock/scope'
import { scopedEvents, scopedFindings, scopedCost } from '../dock/scopeData'
import type { WorldDoc, CompileFinding } from '../../../lib/world/types'
import type { AnalysisFinding } from '../../../lib/analysis/types'
import type { EngineEvent } from '../../../lib/worldEngine/types'

// ─── SignatureHeader (Polish 3 T7 / spec D9) ──────────────────────────────────────
// Every dock tab gets a per-tab identity: a glyph, an accent, and a one-line live summary.
// Rendered BETWEEN the tab bar and the `<fieldset disabled={running}>` body (never inside
// it) — this is a read surface, not a control, and must stay legible while the sim runs.
// Identical DOM/layout across every tab; the ONLY thing that varies is glyph + accent, so
// the seven tabs read distinct-at-a-glance without becoming seven different box shapes.
interface SignatureHeaderProps { glyph: string; accent: string; summary: string; summaryColor?: string }

function SignatureHeader({ glyph, accent, summary, summaryColor }: SignatureHeaderProps) {
  return (
    <div
      data-testid="signature-header"
      style={{
        display: 'flex', alignItems: 'center', gap: 8, minWidth: 0,
        padding: '6px 9px', marginBottom: 8, borderRadius: 6,
        border: '1px solid var(--color-node-border)', borderLeft: `2px solid ${accent}`,
        background: 'var(--color-node-base)',
      }}
    >
      <span aria-hidden style={{ fontSize: 13, lineHeight: 1, color: accent, flexShrink: 0, width: 14, textAlign: 'center' }}>
        {glyph}
      </span>
      <span style={{
        fontSize: 10.5, color: summaryColor ?? 'var(--color-text-secondary)', minWidth: 0,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
      }}>
        {summary}
      </span>
    </div>
  )
}

const TAB_LABELS: Record<PanelTab, string> = {
  topology: 'Topology', blueprints: 'Blueprints', placements: 'Placements', traffic: 'Traffic',
  analysis: 'Analysis', events: 'Events', cost: 'Cost', config: 'Config',
}

export interface WorldPanelProps {
  running: boolean
  placeMode: boolean
  onTogglePlaceMode: () => void
  selectedPopulationId: string | null
  openSettings: () => void
}

export function WorldPanel({ running, placeMode, onTogglePlaceMode, selectedPopulationId, openSettings }: WorldPanelProps) {
  const [tab, setTab] = useState<PanelTab>(() => useUiStore.getState().pendingPanelTab ?? 'topology')
  const pendingPanelTab = useUiStore(s => s.pendingPanelTab)
  useEffect(() => {
    // One-shot consume, now reactive (Polish 2 D4): the vault path still lands via the
    // mount-time initializer above (this effect's first run just re-selects the same tab and
    // clears the field — the previous mount-only effect's behavior, subsumed); a
    // pendingPanelTab set while the panel is ALREADY mounted (scene overlay "traffic panel →")
    // now switches the tab too. Clear via getState() so the write doesn't re-fire the effect.
    if (pendingPanelTab) {
      setTab(pendingPanelTab)
      useUiStore.getState().setPendingPanelTab(null)
    }
  }, [pendingPanelTab])
  const compiled = useCompiledWorld()
  const doc = useWorldStore(s => s.doc)
  const displayBatch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const events = useSimulationStore(s => s.events)

  // Scope (Polish 4 T1, spec D1) — derived, never stored: "where you are" (nav) + "what you
  // selected" (the floor's lifted ui.store selection). Selective primitive subscriptions (not a
  // whole-store `useNavStore()`) so this only re-renders WorldPanel when a field that can
  // actually change the scope changes.
  const navLevel = useNavStore(s => s.level)
  const navRegionId = useNavStore(s => s.regionId)
  const navAzId = useNavStore(s => s.azId)
  const navServerId = useNavStore(s => s.serverId)
  const selectedServerId = useUiStore(s => s.selectedServerId)
  const scope: DockScope = useMemo(
    () => deriveScope({ level: navLevel, regionId: navRegionId, azId: navAzId, serverId: navServerId }, selectedServerId, doc),
    [navLevel, navRegionId, navAzId, navServerId, selectedServerId, doc],
  )
  const tabIds = useMemo(() => scopeTabs(scope), [scope])

  // Tab persistence across a scope change (D2): keep the active tab if it still exists at the
  // new scope, else land on the new scope's first tab (Topology at world, Config elsewhere).
  // useLayoutEffect (this file's existing `placeInk` precedent below) so a scope change never
  // paints a frame with a tab id that's invalid for the scope that just landed.
  useLayoutEffect(() => {
    if (!tabIds.includes(tab)) setTab(tabIds[0])
    // Deliberately scoped to `scope` alone (mirrors DatacenterFloor.tsx's currentIdsKey
    // precedent) — this corrects the tab on a SCOPE transition, not on every tab click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope])

  const analysis = useMemo(() => runAnalysis(doc, compiled, displayBatch), [compiled, displayBatch?.simMs])
  const compileExtra = useMemo(() => unsuppressedCompileFindings(analysis, compiled.findings), [analysis, compiled.findings])
  // Scoped Analysis/Events/Cost (D2's four helpers, src/app/world/dock/scopeData.ts) — a
  // pass-through at world scope (mathematically identical to the pre-T1 unscoped values below),
  // a real filter/rollup at region/az/server scope. The Analysis tab-bar badge follows this
  // scoped count everywhere, per the brief ("Analysis badge = scoped count").
  const scopedFindingsResult = useMemo(
    () => scopedFindings(scope, analysis, compileExtra, doc, compiled),
    [scope, analysis, compileExtra, doc, compiled],
  )
  const analysisCount = scopedFindingsResult.analysis.length + scopedFindingsResult.compile.length
  const scopedEventsList = useMemo(
    () => scopedEvents(scope, doc, compiled, events, displayBatch),
    [scope, doc, compiled, events, displayBatch],
  )
  const scopedCostResult = useMemo(
    () => scopedCost(scope, doc, displayBatch?.world ?? null),
    [scope, doc, displayBatch],
  )

  const tabs: { id: PanelTab; label: string }[] = tabIds.map(id => ({ id, label: TAB_LABELS[id] }))

  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const barRef = useRef<HTMLDivElement>(null)
  const [ink, setInk] = useState<{ left: number; width: number; top: number }>({ left: 0, width: 0, top: 0 })

  const placeInk = (id: PanelTab) => {
    const el = tabRefs.current[id]
    // top is tracked per-tab because the bar WRAPS (flexWrap, 7 tabs in a 360px dock) — a
    // bottom-anchored ink would underline the container's last row for every tab. With an
    // explicit height + top, the .kit-ink CSS `bottom: 0` is overconstrained-ignored.
    if (el) setInk({ left: el.offsetLeft, width: el.offsetWidth, top: el.offsetTop + el.offsetHeight - 2 })
  }
  // Also keyed on tabIds (stable reference — only changes when `scope` does, see its useMemo
  // above): the SAME tab id (e.g. 'analysis', valid at every scope) can shift on-screen position
  // when the tab SET around it shrinks from seven buttons to four, which `[tab]` alone wouldn't
  // catch since the id string itself didn't change.
  useLayoutEffect(() => { placeInk(tab) }, [tab, tabIds])

  // Per-tab signature header config — computed only for the ACTIVE tab (glyph/accent are
  // static per tab; the summary is the one live-derived piece). Each tab rides a distinct
  // hue that stays distinct in BOTH themes (review fix wave, Polish 3 T7): topology and
  // blueprints previously both resolved to #3F6DAC in light mode (--color-accent's light
  // value equals compute's foreground.light) — blueprints moved onto --kit-cat-storage to
  // break the collision. The four CATEGORY_COLORS-sourced tabs ride the --kit-cat-* vars
  // (ui/kit.tsx), which already swap dark/light for exactly this token family.
  // Nullable now that 'config' (non-world scopes) is a valid tab id with no generic
  // SignatureHeader — its instrument-specific header (atlas/floor-plan/faceplate) is later-task
  // territory (D3); T1 renders no header for it rather than inventing one that'd be thrown away.
  let header: SignatureHeaderProps | null = null
  switch (tab) {
    case 'topology': {
      const nRegions = Object.keys(doc.regions).length
      const nAzs = Object.keys(doc.azs).length
      const nServers = Object.keys(doc.servers).length
      header = {
        glyph: '▦', accent: 'var(--color-accent)',
        summary: `${nRegions} region${nRegions === 1 ? '' : 's'} · ${nAzs} AZ${nAzs === 1 ? '' : 's'} · ${nServers} server${nServers === 1 ? '' : 's'}`,
      }
      break
    }
    case 'blueprints': {
      const nBlueprints = Object.keys(doc.blueprints).length
      header = { glyph: '⌬', accent: 'var(--kit-cat-storage)', summary: `${nBlueprints} blueprint${nBlueprints === 1 ? '' : 's'}` }
      break
    }
    case 'placements': {
      const nPlacements = Object.keys(doc.placements).length
      header = { glyph: '◎', accent: 'var(--kit-cat-messaging)', summary: `${nPlacements} placement${nPlacements === 1 ? '' : 's'}` }
      break
    }
    case 'traffic': {
      const nPopulations = Object.keys(doc.populations).length
      header = {
        glyph: '⇢', accent: 'var(--kit-cat-network)',
        summary: `${doc.traffic.baselineTotalRps.toLocaleString('en-US')} rps baseline · ${nPopulations} population${nPopulations === 1 ? '' : 's'}`,
      }
      break
    }
    case 'analysis': {
      const errorCount = scopedFindingsResult.analysis.filter(f => f.severity === 'critical').length
        + scopedFindingsResult.compile.filter(cf => cf.severity === 'error').length
      header = {
        glyph: '▲', accent: 'var(--color-danger)',
        summary: `${analysisCount} finding${analysisCount === 1 ? '' : 's'} (${errorCount} error${errorCount === 1 ? '' : 's'})`,
      }
      break
    }
    case 'events': {
      const nEvents = scopedEventsList.length
      let summary = '—'
      if (nEvents > 0) {
        const last = scopedEventsList[nEvents - 1]
        const nowMs = displayBatch?.simMs ?? last.simMs
        const agoS = Math.max(0, Math.round((nowMs - last.simMs) / 1000))
        summary = `${nEvents} event${nEvents === 1 ? '' : 's'} · last ${agoS}s ago`
      }
      header = { glyph: '◷', accent: 'var(--color-text-muted)', summary }
      break
    }
    case 'cost': {
      header = {
        glyph: '¤', accent: 'var(--color-price)',
        summary: `$${scopedCostResult.hourlyUsd.toFixed(2)}/hr`, summaryColor: 'var(--color-price)',
      }
      break
    }
    case 'config': {
      header = null
      break
    }
  }

  return (
    <aside style={panel}>
      <ScopeRail scope={scope} />
      <WorldSummary />
      <div ref={barRef} onMouseLeave={() => placeInk(tab)}
        style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap', position: 'relative' }}>
        {tabs.map(t => (
          <button key={t.id}
            ref={el => { tabRefs.current[t.id] = el }}
            type="button"
            onMouseEnter={() => placeInk(t.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '5px 10px', background: 'transparent',
              border: '1px solid transparent',
              color: tab === t.id ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
              cursor: 'pointer', font: '11px var(--font-mono)',
            }}
            onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === 'analysis' && <ChipValue>{analysisCount}</ChipValue>}
          </button>
        ))}
        <span className="kit-ink" aria-hidden style={{ left: ink.left, width: ink.width, top: ink.top }} />
      </div>
      {header && <SignatureHeader {...header} />}
      {/* Native fieldset-disabled cascades into every descendant button/input/select with zero
          changes to TopologyPanel/BlueprintPanel/PlacementPanel. Findings/Events have no form
          controls, so wrapping them here too is a harmless no-op — kept uniform on purpose. */}
      {/* minInlineSize 0: a fieldset defaults to min-inline-size:min-content and refuses to
          shrink to the dock's width, pushing rows past the viewport edge. */}
      <fieldset disabled={running} style={{ border: 'none', margin: 0, padding: 0, minInlineSize: 0 }}>
        {scope.kind === 'world' ? (
          <>
            {tab === 'topology' && <TopologyPanel />}
            {tab === 'blueprints' && <BlueprintPanel />}
            {tab === 'placements' && <PlacementPanel />}
            {tab === 'traffic' && (
              <TrafficPanel placeMode={placeMode} onTogglePlaceMode={onTogglePlaceMode} selectedPopulationId={selectedPopulationId} />
            )}
            {tab === 'analysis' && <AnalysisTab openSettings={openSettings} />}
            {tab === 'events' && <EventsTab />}
            {tab === 'cost' && <CostTab />}
          </>
        ) : (
          // Region/AZ/server scope (D2): Config is a placeholder T2 (region)/T3 (az)/T4
          // (server) each replace with their own instrument body — out of scope here by design.
          // Analysis/Events/Cost are real, wired to this scope's data via T1's scopeData
          // helpers (computed above) — they are NOT placeholders and nothing later replaces them.
          <>
            {tab === 'config' && <ScopedConfigBody scope={scope} doc={doc} />}
            {tab === 'analysis' && (
              <ScopedAnalysisBody analysis={scopedFindingsResult.analysis} compile={scopedFindingsResult.compile} />
            )}
            {tab === 'events' && <ScopedEventsBody events={scopedEventsList} />}
            {tab === 'cost' && <ScopedCostBody cost={scopedCostResult} />}
          </>
        )}
      </fieldset>
    </aside>
  )
}

// World summary strip (Polish 2 D5): a read surface above the tab bar, OUTSIDE the
// fieldset — it must not gray out while the sim is running. At rest (no metrics batch yet)
// it shows the authored doc's counts; once metrics are flowing it becomes the live sentence
// (rolling rps, health dot, $/hr, p50).
function WorldSummary() {
  const doc = useWorldStore(s => s.doc)
  const displayBatch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const rolledRps = useRollingNumber(displayBatch?.world.totalRps ?? 0)

  const regionCount = Object.keys(doc.regions).length
  const serverCount = Object.keys(doc.servers).length
  const cityCount = Object.keys(doc.populations).length

  const box: CSSProperties = {
    border: '1px solid var(--color-node-border)', borderRadius: 7, padding: '11px 13px',
    background: 'linear-gradient(180deg, var(--color-surface-hover), var(--color-node-base))',
    marginBottom: 8,
  }

  if (!displayBatch) {
    return (
      <div style={box} data-testid="world-summary">
        <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
          {regionCount} region{regionCount === 1 ? '' : 's'} · {serverCount} server{serverCount === 1 ? '' : 's'} · baseline {doc.traffic.baselineTotalRps.toLocaleString('en-US')} rps
        </div>
      </div>
    )
  }

  const regions = Object.values(displayBatch.regions)
  const downCount = regions.filter(r => r.health === 'down').length
  const degradedCount = regions.filter(r => r.health === 'degraded').length
  // The dot glyph moved out of this string into its own .kit-ripple span (Polish 2 T7) — a
  // ripple radiating from an inline text run spanning "N regions down" would paint an oval
  // over the words, not a dot; the dot needs its own small, roughly-square box.
  const healthLabel = downCount > 0
    ? `${downCount} region${downCount === 1 ? '' : 's'} down`
    : degradedCount > 0
      ? `${degradedCount} region${degradedCount === 1 ? '' : 's'} degraded`
      : 'all healthy'
  const healthColor = downCount > 0 ? 'var(--color-danger)' : degradedCount > 0 ? 'var(--color-warning)' : 'var(--color-success)'
  // Decision 9: WorldMetrics exposes no latency — rps-weighted mean of region p50Ms.
  const totalRps = regions.reduce((s, r) => s + r.rps, 0)
  const p50 = totalRps > 0 ? regions.reduce((s, r) => s + r.p50Ms * r.rps, 0) / totalRps : 0
  const hourlyUsd = computeWorldCost(doc, displayBatch.world).monthlyUsd / HOURS_PER_MONTH

  return (
    <div style={box} data-testid="world-summary">
      <div style={{ fontSize: 12.5 }}>
        Handling <b style={{ color: 'var(--kit-accent)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{Math.round(rolledRps).toLocaleString('en-US')} rps</b>
        {' '}from {cityCount} {cityCount === 1 ? 'city' : 'cities'} across {regionCount} region{regionCount === 1 ? '' : 's'}
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--color-text-muted)', marginTop: 3, display: 'flex', gap: 10, flexWrap: 'wrap', fontVariantNumeric: 'tabular-nums', alignItems: 'center' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: healthColor }}>
          <span className={displayBatch ? 'kit-ripple' : undefined} style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', flexShrink: 0 }} />
          {healthLabel}
        </span>
        <span style={{ color: 'var(--color-price)' }}>${hourlyUsd.toFixed(2)}/hr</span>
        <span>p50 {Math.round(p50)} ms</span>
      </div>
    </div>
  )
}

// ─── Non-world Config/Analysis/Events/Cost bodies (Polish 4 T1, spec D2) ─────────────────────
// Config is an intentional placeholder — T2/T3/T4 replace it per scope with the real atlas/
// floor-plan/faceplate instrument body (see the brief: "do NOT build the atlas/floor/faceplate
// now"). Analysis/Events/Cost are the real, final-for-this-phase bodies: small, scope-fed
// siblings of AnalysisTab/EventsTab/CostTab (world-only, self-computing) rather than a prop-ified
// rework of those three components, which the brief's file list doesn't touch.

function ScopedConfigBody({ scope, doc }: { scope: DockScope; doc: WorldDoc }) {
  let kindLabel = ''
  let label = ''
  if (scope.kind === 'region') { kindLabel = 'region'; label = doc.regions[scope.regionId]?.catalogId ?? scope.regionId }
  else if (scope.kind === 'az') { kindLabel = 'AZ'; label = doc.azs[scope.azId]?.label ?? scope.azId }
  else if (scope.kind === 'server') { kindLabel = 'server'; label = doc.servers[scope.serverId]?.label ?? scope.serverId }
  return (
    <div data-testid="config-placeholder" style={{ color: 'var(--color-text-muted)', padding: '10px 2px' }}>
      Config for {kindLabel} <b style={{ color: 'var(--color-text-secondary)' }}>{label}</b> — coming soon.
    </div>
  )
}

function scopedSevChipStyle(sev: 'critical' | 'warning' | 'info' | 'error'): CSSProperties {
  return {
    padding: '1px 6px', borderRadius: 3, font: '10px var(--font-mono)', color: 'var(--color-on-accent)',
    background: sev === 'critical' || sev === 'error' ? 'var(--color-danger)'
      : sev === 'warning' ? 'var(--color-warning)' : 'var(--color-text-muted)',
  }
}

function ScopedAnalysisBody({ analysis, compile }: { analysis: AnalysisFinding[]; compile: CompileFinding[] }) {
  if (analysis.length === 0 && compile.length === 0) {
    return <div style={{ color: 'var(--color-text-muted)' }}>No findings in this scope.</div>
  }
  return (
    <div>
      {analysis.map(f => (
        <div key={f.id} data-testid="scoped-finding" style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={scopedSevChipStyle(f.severity)}>{f.severity}</span>
            <span style={{ color: 'var(--color-text-primary)' }}>{f.title}</span>
          </div>
          <div style={{ marginTop: 2, color: 'var(--color-text-secondary)' }}>{f.why}</div>
          <div style={{ marginTop: 2, color: 'var(--color-text-muted)' }}>→ {f.fix}</div>
        </div>
      ))}
      {compile.map(cf => (
        <div key={cf.id} data-testid="scoped-compile-finding" style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={scopedSevChipStyle(cf.severity)}>{cf.severity}</span>
            <span style={{ color: 'var(--color-text-secondary)' }}>{cf.kind}</span>
          </div>
          <div style={{ marginTop: 2 }}>{cf.message}</div>
        </div>
      ))}
    </div>
  )
}

const SCOPED_EVENT_SEVERITY_COLOR: Record<'info' | 'warning' | 'critical', string> = {
  info: 'var(--color-text-muted)',
  warning: 'var(--color-warning)',
  critical: 'var(--color-danger)',
}

function ScopedEventsBody({ events }: { events: EngineEvent[] }) {
  const ordered = [...events].reverse()
  return (
    <div data-testid="scoped-events">
      <div style={sectionLabel}>Events ({events.length})</div>
      {ordered.length === 0 && (
        <div style={{ color: 'var(--color-text-muted)' }}>No events in this scope yet.</div>
      )}
      {ordered.map(e => (
        <div key={e.id} style={{
          marginBottom: 6, borderLeft: `2px solid ${SCOPED_EVENT_SEVERITY_COLOR[e.severity]}`, paddingLeft: 6,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: SCOPED_EVENT_SEVERITY_COLOR[e.severity] }}>
            <span>{e.kind}</span>
            <span style={{ color: 'var(--color-text-muted)' }}>{(e.simMs / 1000).toFixed(1)}s</span>
          </div>
          <div style={{ color: 'var(--color-text-secondary)' }}>{e.message}</div>
        </div>
      ))}
    </div>
  )
}

function ScopedCostBody({ cost }: { cost: { hourlyUsd: number; monthlyUsd: number; egressNote: string | null } }) {
  return (
    <div data-testid="scoped-cost">
      <div style={sectionLabel}>Cost in this scope</div>
      <div style={{ font: '600 16px var(--font-mono)', color: 'var(--color-price)', marginBottom: 8 }}>
        ${cost.monthlyUsd.toFixed(2)} /mo
        <span style={{ font: '11px var(--font-mono)', color: 'var(--color-price)' }}> · ${cost.hourlyUsd.toFixed(2)}/hr</span>
      </div>
      {cost.egressNote && (
        <div style={{ color: 'var(--color-text-muted)', fontSize: 10.5 }}>{cost.egressNote}</div>
      )}
    </div>
  )
}
