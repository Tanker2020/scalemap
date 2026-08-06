import { useState, useMemo, useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react'
import { TopologyPanel } from './TopologyPanel'
import { BlueprintsPanel } from './BlueprintsPanel'
import { PacketsPanel } from './PacketsPanel'
import { ManagedPanel } from './ManagedPanel'
import { ConnectionsPanel } from './ConnectionsPanel'
import { isEntryBlueprint } from '../../../lib/world/connections'
import { TrafficPanel } from './TrafficPanel'
import { RoutesPanel } from './RoutesPanel'
import { ScenarioPanel } from './ScenarioPanel'
import { SignalsPanel } from './SignalsPanel'
import { AnalysisTab, unsuppressedCompileFindings } from './AnalysisTab'
import { useCompiledWorld } from '../useCompiledWorld'
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useUiStore, type PanelTab } from '../../store/ui.store'
import { runAnalysis } from '../../../lib/analysis/runAnalysis'
import { listRoutes, listPackets } from '../../../lib/nodeConfig'
import { EventsTab } from '../EventsTab'
import { CostTab } from '../CostTab'
import { panel, sectionLabel } from './panelStyles'
import { ChipValue } from '../ui/kit'
import { ScopeRail } from '../dock/ScopeRail'
import { AtlasHeader } from '../dock/AtlasHeader'
import { RegionConfigTab } from '../dock/RegionConfigTab'
import { FloorPlanHeader } from '../dock/FloorPlanHeader'
import { AzConfigTab } from '../dock/AzConfigTab'
import { ServerFaceplate } from '../dock/ServerFaceplate'
import { deriveScope, scopeTabs, type DockScope } from '../dock/scope'
import { scopedEvents, scopedFindings, scopedCost } from '../dock/scopeData'
import { regionEvents } from '../region/regionData'
import type { CompileFinding } from '../../../lib/world/types'
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
  topology: 'Topology', blueprints: 'Blueprints', packets: 'Packets', managed: 'Managed',
  connections: 'Connections', traffic: 'Traffic',
  routes: 'Routes', scenario: 'Scenario', signals: 'Signals', analysis: 'Analysis', events: 'Events', cost: 'Cost', config: 'Config',
}

export interface WorldPanelProps {
  running: boolean
  placeMode: boolean
  onTogglePlaceMode: () => void
  selectedPopulationId: string | null
  openSettings: () => void
  /** Opens the full-screen connections canvas from the Connections tab (node-model Phase 2). */
  openConnections: () => void
  /** Opens the FirewallRulesModal (WorldShell-mounted) for the given server, from the server
   *  scope's ServerFaceplate FIREWALL drawer. */
  openFirewallRules: (serverId: string) => void
}

export function WorldPanel({ running, placeMode, onTogglePlaceMode, selectedPopulationId, openSettings, openConnections, openFirewallRules }: WorldPanelProps) {
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
    () => scopedEvents(scope, doc, compiled, events, displayBatch, regionEvents),
    [scope, doc, compiled, events, displayBatch],
  )
  const scopedCostResult = useMemo(
    // FEAT-008 (Task 21, controller-added gap): fold runningByPlacement in — see scopedCost's
    // own comment. `displayBatch` is already this memo's dep, so building the intersection
    // object inline here doesn't change the memoization cadence.
    () => scopedCost(
      scope, doc,
      displayBatch?.world ? { ...displayBatch.world, runningByPlacement: displayBatch.runningByPlacement } : null,
      displayBatch?.managedServices ?? null,
    ),
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
  // hue that stays distinct in BOTH themes (review fix wave, Polish 3 T7): topology rides
  // --color-accent, while the managed tab uses --kit-cat-storage to stay clear of it in light
  // mode (--color-accent's light value equals compute's foreground.light). The CATEGORY_COLORS-
  // sourced tabs ride the --kit-cat-* vars (ui/kit.tsx), which already swap dark/light for
  // exactly this token family.
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
      // Blueprints are DEFINITIONS; the useful second number is how many are actually mounted
      // somewhere, since an unplaced blueprint costs nothing and simulates nothing.
      const nBlueprints = Object.keys(doc.blueprints).length
      const placed = new Set(Object.values(doc.placements).map(p => p.blueprintId)).size
      header = {
        glyph: '❒', accent: 'var(--kit-cat-compute)',
        summary: `${nBlueprints} service${nBlueprints === 1 ? '' : 's'} · ${placed} placed`,
      }
      break
    }
    case 'packets': {
      const nPackets = listPackets(doc.packets).length
      header = { glyph: '❑', accent: 'var(--kit-cat-messaging)', summary: `${nPackets} packet${nPackets === 1 ? '' : 's'}` }
      break
    }
    case 'managed': {
      const nManaged = Object.keys(doc.managedServices).length
      header = { glyph: '🗄', accent: 'var(--kit-cat-storage)', summary: `${nManaged} managed service${nManaged === 1 ? '' : 's'}` }
      break
    }
    case 'connections': {
      // Must match the ROW COUNT the panel below renders, or the header reads "3 connections"
      // over a list of four. That means authored dependencies PLUS one synthetic Internet ingress
      // edge per publicly-exposed blueprint — the same two sources edgesForView folds together.
      // Counted per dependency (not per compiled path): one dependency is one connection the user
      // drew, however many instance-to-instance paths it fans out into.
      const nDeps = Object.values(doc.blueprints).reduce((sum, bp) => sum + bp.dependencies.length, 0)
      const nIngress = Object.values(doc.blueprints).filter(isEntryBlueprint).length
      const nConns = nDeps + nIngress
      header = { glyph: '🔗', accent: 'var(--kit-cat-network)', summary: `${nConns} connection${nConns === 1 ? '' : 's'}` }
      break
    }
    case 'traffic': {
      const nPopulations = Object.keys(doc.populations).length
      header = {
        glyph: '⇢', accent: 'var(--kit-cat-network)',
        summary: `${nPopulations} population${nPopulations === 1 ? '' : 's'} · routed by ${doc.routing.policy}`,
      }
      break
    }
    case 'routes': {
      const nRoutes = listRoutes(doc.packets).length
      header = {
        glyph: '⋔', accent: 'var(--kit-cat-network)',
        summary: `${nRoutes} route${nRoutes === 1 ? '' : 's'}`,
      }
      break
    }
    case 'scenario': {
      const nSteps = doc.scenario?.steps.length ?? 0
      header = doc.scenario
        ? { glyph: '⏱', accent: 'var(--color-warning)', summary: `${nSteps} step${nSteps === 1 ? '' : 's'} · ${Math.round(doc.scenario.durationMs / 1000)}s` }
        : { glyph: '⏱', accent: 'var(--color-warning)', summary: 'no scenario yet' }
      break
    }
    case 'signals': {
      // Non-hook getState() read, deliberately — see the file-level note above `useSimulationStore`
      // subscriptions: getReplayFrames() (simulation.store.ts -> replay.ts's getFrames()) always
      // returns a FRESH array (`[...frames]`), so subscribing to it via a reactive selector hook
      // gives every render a "changed" snapshot and makes React's useSyncExternalStore consistency
      // check loop forever once this component is already re-rendering on its own cadence (it
      // did, via displayBatch/events below — confirmed by a full-suite regression during Task 5).
      // A plain getState() read still shows a live count on every one of those OTHER re-renders,
      // without adding a subscription of its own.
      const frames = useSimulationStore.getState().getReplayFrames()
      header = { glyph: '◷', accent: 'var(--color-accent)', summary: frames.length > 0 ? `${frames.length} frames of history` : 'no history yet' }
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
      {/* Atlas instrument (Polish 4 T2, spec D3/D4): world scope's signature header — ABSORBS the
          pre-T2 WorldSummary strip (deleted below); region scope rides the same constellation,
          scoped (this region's dot ringed, headline narrowed to the region). az scope gets the
          floor-plan instrument's clickable minimap (T3); server scope's faceplate is T4
          territory — no header renders there yet. */}
      {(scope.kind === 'world' || scope.kind === 'region') && (
        <AtlasHeader regionId={scope.kind === 'region' ? scope.regionId : null} />
      )}
      {scope.kind === 'az' && <FloorPlanHeader azId={scope.azId} />}
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
          changes to TopologyPanel/ManagedPanel/etc. The events tab is exempt
          (2026-07-12): it's a READ surface — the history browser's expand/page buttons must
          work mid-run (WAL readers never block the writer), and its one destructive control
          (clear history) carries its own `disabled={running}` + edit-lock title. */}
      {/* minInlineSize 0: a fieldset defaults to min-inline-size:min-content and refuses to
          shrink to the dock's width, pushing rows past the viewport edge. */}
      <fieldset disabled={running && tab !== 'events'} style={{ border: 'none', margin: 0, padding: 0, minInlineSize: 0 }}>
        {scope.kind === 'world' ? (
          <>
            {tab === 'topology' && <TopologyPanel />}
            {tab === 'blueprints' && <BlueprintsPanel openConnections={openConnections} />}
            {tab === 'packets' && <PacketsPanel />}
            {tab === 'managed' && <ManagedPanel />}
            {tab === 'connections' && <ConnectionsPanel onOpenGraph={openConnections} />}
            {tab === 'traffic' && (
              <TrafficPanel placeMode={placeMode} onTogglePlaceMode={onTogglePlaceMode} selectedPopulationId={selectedPopulationId} />
            )}
            {tab === 'routes' && <RoutesPanel />}
            {tab === 'scenario' && <ScenarioPanel />}
            {tab === 'signals' && <SignalsPanel scope={scope} />}
            {tab === 'analysis' && <AnalysisTab openSettings={openSettings} />}
            {tab === 'events' && <EventsTab />}
            {tab === 'cost' && <CostTab />}
          </>
        ) : (
          // Region/AZ/server scope (D2): every scope's Config now has a real instrument — no
          // placeholder remains. Region's landed in T2 (RegionConfigTab); AZ's in T3
          // (AzConfigTab, under the FloorPlanHeader minimap above); server's this task (T4,
          // ServerFaceplate — the faceplate + drawer spine, under no header since T4 renders
          // none for server scope). Analysis/Events/Cost are real, wired to this scope's data
          // via T1's scopeData helpers (computed above) — they are NOT placeholders and nothing
          // later replaces them.
          <>
            {tab === 'config' && (
              scope.kind === 'region' ? <RegionConfigTab regionId={scope.regionId} />
              : scope.kind === 'az' ? <AzConfigTab azId={scope.azId} />
              // showEnter = true only when this server scope came from an AZ-level floor
              // selection (deriveScope's OTHER path into 'server' scope, dock/scope.ts) rather
              // than a real board navigation — "enter board" is meaningless once you're already
              // on the board (nav.level === 'server').
              : scope.kind === 'server' ? <ServerFaceplate serverId={scope.serverId} showEnter={navLevel === 'az'} openFirewallRules={openFirewallRules} />
              : null
            )}
            {tab === 'analysis' && (
              <ScopedAnalysisBody analysis={scopedFindingsResult.analysis} compile={scopedFindingsResult.compile} />
            )}
            {tab === 'events' && <ScopedEventsBody events={scopedEventsList} />}
            {tab === 'signals' && <SignalsPanel scope={scope} />}
            {tab === 'cost' && <ScopedCostBody cost={scopedCostResult} />}
          </>
        )}
      </fieldset>
    </aside>
  )
}

// ─── Non-world Analysis/Events/Cost bodies (Polish 4 T1/T2/T3, spec D2) ──────────────────────
// Small, scope-fed siblings of AnalysisTab/EventsTab/CostTab (world-only, self-computing).
// Every non-world scope's Config tab renders a real instrument (RegionConfigTab / AzConfigTab /
// ServerFaceplate, wired in above) — the old ScopedConfigBody placeholder was unreachable and
// was removed 2026-07-12.

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
