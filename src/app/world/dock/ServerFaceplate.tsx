// src/app/world/dock/ServerFaceplate.tsx
// Polish 4 T4 (spec D6): the faceplate instrument — server scope's Config surface. A
// screwed-on name plate (dark-scene chrome, D3) + a live vitals rail + a spine of four
// accordion drawers (HARDWARE/FIREWALL/SERVICES/PLACEMENT), one open at a time. AUTHORING
// posture only — T5 extends this same component with the "watching" re-voicing (a watchband,
// live pv strings, frozen knobs) on top of the seams left here: `running`/`display` are already
// threaded through, and each drawer's `pv` builder is a plain function T5 can branch on
// `running` without touching this file's layout.
//
// InspectorV2's selected-server pane retires this same task (D6: "InspectorV2 retires its
// selected-server pane... its dispatches all move into the faceplate") — `kill`/`↺ restore` and
// the rack `<select>` (now PlacementDrawer) are relocated byte-for-byte from InspectorV2.tsx.
import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { useReducedMotion } from 'framer-motion'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useNavStore } from '../../store/nav.store'
import { useUiStore } from '../../store/ui.store'
import { useCompiledWorld } from '../useCompiledWorld'
import { useServerDisplayMetrics } from '../server/useServerDisplayMetrics'
import { meanUtilization } from '../az/floorData'
import { HEALTH_COLOR } from '../server/healthColor'
import { Drawer } from './Drawer'
import { HardwareDrawer, hardwarePv } from './drawers/HardwareDrawer'
import { FirewallDrawer, firewallPv } from './drawers/FirewallDrawer'
import { ServicesDrawer, servicesPv } from './drawers/ServicesDrawer'
import { PlacementDrawer, placementPv } from './drawers/PlacementDrawer'
import './faceplateStyles'

export interface ServerFaceplateProps {
  serverId: string
  // AZ-scope selection reached this server WITHOUT navigating the board (dock/scope.ts's
  // `deriveScope`); the board itself (nav.level === 'server') is already "entered," so no
  // redundant enter action there. WorldPanel.tsx computes this.
  showEnter: boolean
}

type DrawerKey = 'hw' | 'fw' | 'svc' | 'pl'

// ─── Dark-scene chrome (spec D3, InspectorRail/AtlasHeader/FloorPlanHeader precedent): the plate
// keeps its fixed metal palette in BOTH themes — these are DARK_COLORS'/CATEGORY_COLORS' own
// hex values (theme.ts) / the locked mock's literals, not new invented colors. Status semantics
// below (health word, the running posture line) deliberately use var(--color-*) tokens instead —
// the same carve-out AtlasHeader.tsx documents for its HUD ring and InspectorRail.tsx uses for
// its rule-sentence coloring: success/warning/danger read fine against a permanently-dark
// backdrop in either theme, unlike a neutral text token calibrated for a flip-to-white card. ────
const PLATE_BG = 'linear-gradient(180deg, #242c38, #171d27)'
const PLATE_BORDER = '#333d4d'
const SCREW_BG = '#0b0e13'
const SCREW_RING = '#3a4556'
const PLATE_NAME_COLOR = '#F1F5F9'    // DARK_COLORS.textPrimary
const PLATE_MUTED_COLOR = '#64748B'   // DARK_COLORS.textMuted (identical in both themes)
const KIND_CHIP_COLOR = '#5B9CF6'     // CATEGORY_COLORS.compute.accent — "blue family" (D6)
const KIND_CHIP_BORDER = '#5B9CF655'

const screwStyle: CSSProperties = {
  position: 'absolute', width: 5, height: 5, borderRadius: '50%', background: SCREW_BG,
  boxShadow: `inset 0 0 2px #000, 0 0 0 1px ${SCREW_RING}`,
}

const actionBtn: CSSProperties = {
  font: '10px var(--font-mono)', background: 'var(--color-node-base)',
  border: '1px solid var(--color-node-border)', borderRadius: 5, padding: '4px 12px',
  color: 'var(--color-text-secondary)', cursor: 'pointer',
}
const dangerBtn: CSSProperties = {
  ...actionBtn, color: 'var(--color-danger)',
  borderColor: 'color-mix(in srgb, var(--color-danger) 25%, transparent)',
}
const dangerBtnLocked: CSSProperties = { ...dangerBtn, opacity: 0.35, cursor: 'default' }

function GaugeColumn({ label, fraction, color, testId }: { label: string; fraction: number; color: string; testId: string }): ReactElement {
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100)
  return (
    <div
      data-testid={testId} title={`${label} ${pct}%`}
      style={{
        width: 8, height: 44, borderRadius: 4, background: 'var(--color-node-base)',
        border: '1px solid var(--color-node-border)', position: 'relative', overflow: 'hidden',
      }}
    >
      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: 0, borderRadius: 3,
        height: `${pct}%`, background: color,
      }} />
    </div>
  )
}

export function ServerFaceplate({ serverId, showEnter }: ServerFaceplateProps): ReactElement | null {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const running = useSimulationStore(s => s.running)
  const isManuallyDown = useSimulationStore(s => s.healthOverrides[serverId] ?? false)
  const setOutage = useSimulationStore(s => s.setOutage)
  const navRegionId = useNavStore(s => s.regionId)
  const navAzId = useNavStore(s => s.azId)
  const goServer = useNavStore(s => s.goServer)
  const setSelectedServerId = useUiStore(s => s.setSelectedServerId)
  const reducedMotion = useReducedMotion() ?? false
  const display = useServerDisplayMetrics(serverId)

  const [openDrawer, setOpenDrawer] = useState<DrawerKey | null>('hw')
  const [confirmingRemove, setConfirmingRemove] = useState(false)

  // A fresh selection always lands with HARDWARE open and no dangling remove-confirmation from
  // whatever server was previously shown in this same mounted faceplate.
  useEffect(() => { setOpenDrawer('hw'); setConfirmingRemove(false) }, [serverId])

  const server = doc.servers[serverId]
  if (!server) return null

  const toggle = (key: DrawerKey) => setOpenDrawer(cur => cur === key ? null : key)

  const cpuFraction = meanUtilization(display.server?.coreUtilization)
  const ramFraction = display.server && display.server.ramTotalMb > 0
    ? display.server.ramUsedMb / display.server.ramTotalMb : 0
  const ioFraction = display.server?.diskIoFraction ?? 0
  // idle/live per T4's own brief (vitals rail "captions idle/live") — reflects whether a
  // batch actually exists for this server, not `running` alone (a stopped-but-scrubbed replay
  // still has real numbers to show).
  const vitalsCaption = display.server ? 'live' : 'idle'

  const ramGb = Math.round(server.specs.ramMb / 1024)
  const rackText = server.rack
    ? `${doc.racks[server.rack.rackId]?.label ?? server.rack.rackId} slot ${server.rack.unit}`
    : 'free pool'
  // Named `healthState` (not `healthWord`) deliberately — that name is already taken by
  // `ui/derived.ts`'s cpu/ram-fraction vocabulary ('comfortable'/'tight'/'straining'); the
  // plate's sub-line renders the engine's own HealthState word ('healthy'/'degraded'/'down'),
  // matching the locked mock's literal `healthy` text.
  const healthState = running ? (display.server?.health ?? null) : null

  const removeStep = () => {
    if (!confirmingRemove) { setConfirmingRemove(true); return }
    useWorldStore.getState().removeServer(serverId)
    setSelectedServerId(null)
  }

  return (
    <div data-testid="server-faceplate">
      <div
        data-testid="faceplate-plate"
        style={{
          position: 'relative', background: PLATE_BG, borderBottom: `1px solid ${PLATE_BORDER}`,
          borderRadius: '8px 8px 0 0', padding: '11px 16px 10px',
        }}
      >
        <span aria-hidden style={{ ...screwStyle, top: 5, left: 5 }} />
        <span aria-hidden style={{ ...screwStyle, top: 5, right: 5 }} />
        <span aria-hidden style={{ ...screwStyle, bottom: 5, left: 5 }} />
        <span aria-hidden style={{ ...screwStyle, bottom: 5, right: 5 }} />

        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 13, color: PLATE_NAME_COLOR, letterSpacing: '0.04em' }}>{server.label}</span>
          <span style={{
            fontSize: 8, letterSpacing: '0.12em', border: `1px solid ${KIND_CHIP_BORDER}`,
            color: KIND_CHIP_COLOR, borderRadius: 3, padding: '1px 6px',
          }}>
            {server.kind.toUpperCase()}
          </span>
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--color-price)' }}>
            ${server.hourlyUsd.toFixed(3)}/hr
          </span>
        </div>
        <div style={{ fontSize: 9.5, color: PLATE_MUTED_COLOR, marginTop: 2 }}>
          {server.specs.vcpu}c / {ramGb}G · {rackText}
          {healthState && <> · <span style={{ color: HEALTH_COLOR[healthState] }}>{healthState}</span></>}
        </div>
        <div
          data-testid="faceplate-posture"
          style={{ fontSize: 9.5, marginTop: 3, color: running ? 'var(--color-warning)' : PLATE_MUTED_COLOR }}
        >
          {running ? 'running — watching · stop to edit' : 'stopped — authoring · everything editable'}
        </div>
      </div>

      <div style={{
        display: 'flex', gap: 10, padding: 12, background: 'var(--color-surface)',
        backgroundImage: 'radial-gradient(#ffffff06 1px, transparent 1px)', backgroundSize: '22px 22px',
      }}>
        <div style={{ width: 20, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 7, alignItems: 'center', paddingTop: 4 }}>
          <span
            aria-hidden data-testid="vitals-pulse"
            className={reducedMotion ? undefined : 'dockfp-vitals-pulse'}
            style={{
              width: 6, height: 6, borderRadius: '50%', background: 'var(--color-success)',
              boxShadow: '0 0 6px var(--color-success)',
            }}
          />
          <GaugeColumn label="cpu" fraction={cpuFraction} color="var(--kit-cat-compute)" testId="vitals-gauge-cpu" />
          <GaugeColumn label="ram" fraction={ramFraction} color="var(--kit-cat-storage)" testId="vitals-gauge-ram" />
          <GaugeColumn label="io" fraction={ioFraction} color="var(--kit-cat-network)" testId="vitals-gauge-io" />
          <small data-testid="vitals-caption" style={{ fontSize: 7, color: 'var(--color-text-muted)', marginTop: -4 }}>
            {vitalsCaption}
          </small>
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <Drawer accent="var(--kit-cat-compute)" title="HARDWARE" readout={hardwarePv(server)} open={openDrawer === 'hw'} onToggle={() => toggle('hw')}>
            <HardwareDrawer server={server} doc={doc} compiled={compiled} running={running} />
          </Drawer>
          <Drawer accent="var(--kit-cat-storage)" title="FIREWALL" readout={firewallPv(server)} open={openDrawer === 'fw'} onToggle={() => toggle('fw')}>
            <FirewallDrawer server={server} running={running} />
          </Drawer>
          <Drawer accent="var(--kit-cat-messaging)" title="SERVICES" readout={servicesPv(serverId, doc)} open={openDrawer === 'svc'} onToggle={() => toggle('svc')}>
            <ServicesDrawer server={server} doc={doc} running={running} />
          </Drawer>
          <Drawer accent="var(--kit-cat-network)" title="PLACEMENT" readout={placementPv(server, doc)} open={openDrawer === 'pl'} onToggle={() => toggle('pl')}>
            <PlacementDrawer server={server} doc={doc} running={running} />
          </Drawer>

          <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
            {showEnter && (
              <div
                role="button" tabIndex={0} data-testid="faceplate-enter" className="kit-press"
                style={actionBtn}
                onClick={() => { if (navRegionId && navAzId) goServer(navRegionId, navAzId, serverId) }}
                onKeyDown={e => {
                  if ((e.key === 'Enter' || e.key === ' ') && navRegionId && navAzId) {
                    e.preventDefault(); goServer(navRegionId, navAzId, serverId)
                  }
                }}
              >
                enter board ⏎
              </div>
            )}
            {/* kill/restore — a `<div role="button">`, not a native `<button>`: this control is
                RUN-ONLY (must stay clickable exactly while WorldPanel.tsx's ambient
                `<fieldset disabled={running}>` is active), the same escape AzConfigTab's "kill AZ"
                and InspectorV2's original card used — a real <button> would be fieldset-disabled
                at the one moment it needs to work. */}
            <div
              role="button" tabIndex={running ? 0 : -1} data-testid="faceplate-kill" className="kit-press"
              style={running ? dangerBtn : dangerBtnLocked} aria-disabled={!running}
              title={running ? undefined : 'start the simulation to break things'}
              onClick={() => { if (running) setOutage('server', serverId, !isManuallyDown) }}
              onKeyDown={e => {
                if (running && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setOutage('server', serverId, !isManuallyDown) }
              }}
            >
              {isManuallyDown ? '↺ restore' : 'kill'}
            </div>
            <button
              type="button" className="kit-press" data-testid="faceplate-remove"
              style={running ? dangerBtnLocked : dangerBtn} disabled={running}
              title={running ? 'stop the simulation to edit' : undefined}
              onClick={removeStep}
            >
              {confirmingRemove ? 'confirm remove?' : 'remove…'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
