// src/app/world/dock/ScopeRail.tsx
// Polish 4 T1 (spec D1/D3): the ONE piece of chrome shared identically by every dock instrument
// — "the way out." A restyled Breadcrumb (`app/world/Breadcrumb.tsx`), not a second navigation
// system: every pill click reuses an EXISTING nav dispatch byte-for-byte (relocated-dispatch
// contract) — the header Breadcrumb stays untouched and reads the same stores.
//
// Styling note (D3's "InspectorRail precedent"): the lit "here" pill rides `--kit-accent`/
// `--kit-accent-dim` (`app/world/ui/kit.tsx`) — the SAME already-theme-aware cyan/teal token
// pair the dock's active-tab ink (`.kit-ink`) and default SignatureHeader accent already use,
// and a 1:1 dark-mode match for the mockup's locked `--hud`/`--hud-dim` (`#7CFFE9`/
// `#2DD4BF44`) with a WCAG-safe light-mode swap already defined — not a new hardcoded hex.
import type { CSSProperties } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import { useUiStore } from '../../store/ui.store'
import type { DockScope } from './scope'

export interface ScopeRailProps { scope: DockScope }

interface Pill { key: string; label: string; here: boolean; onClick: (() => void) | null }

const railStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0,
  padding: '6px 8px', marginBottom: 8, borderRadius: 6,
  background: 'var(--color-toolbar)', border: '1px solid var(--color-toolbar-border)',
  font: '10px var(--font-mono)',
}
const pillStyle: CSSProperties = {
  border: '1px solid transparent', background: 'none', borderRadius: 4, padding: '2px 7px',
  cursor: 'pointer', font: '10px var(--font-mono)', color: 'var(--color-text-muted)',
}
const pillHereStyle: CSSProperties = {
  border: '1px solid var(--kit-accent-dim)', borderRadius: 4, padding: '2px 7px',
  font: '10px var(--font-mono)', color: 'var(--kit-accent)',
  background: 'color-mix(in srgb, var(--kit-accent) 8%, transparent)',
  textShadow: '0 0 7px var(--kit-accent-dim)',
}
const sepStyle: CSSProperties = { color: 'var(--color-text-muted)', margin: '0 1px', fontSize: 10 }

export function ScopeRail({ scope }: ScopeRailProps) {
  const doc = useWorldStore(s => s.doc)
  const level = useNavStore(s => s.level)
  const goGlobe = useNavStore(s => s.goGlobe)
  const goRegion = useNavStore(s => s.goRegion)
  const goAz = useNavStore(s => s.goAz)
  const setSelectedServerId = useUiStore(s => s.setSelectedServerId)

  const pills: Pill[] = [
    { key: 'world', label: 'world', here: scope.kind === 'world', onClick: scope.kind === 'world' ? null : goGlobe },
  ]

  if (scope.kind === 'region' || scope.kind === 'az' || scope.kind === 'server') {
    const region = doc.regions[scope.regionId]
    pills.push({
      key: 'region',
      label: region?.catalogId ?? scope.regionId,
      here: scope.kind === 'region',
      onClick: scope.kind === 'region' ? null : () => goRegion(scope.regionId),
    })
  }

  if (scope.kind === 'az' || scope.kind === 'server') {
    const az = doc.azs[scope.azId]
    pills.push({
      key: 'az',
      label: az?.label ?? scope.azId,
      here: scope.kind === 'az',
      // D1: if nav is ALREADY at this AZ (the floor selection narrowed scope to 'server' without
      // navigating away from the az level) just widen by clearing selection; otherwise (nav is
      // literally on the server board, `level === 'server'`) this is a real "climb up" navigation.
      onClick: scope.kind === 'az' ? null : () => {
        if (level === 'az') setSelectedServerId(null)
        else goAz(scope.regionId, scope.azId)
      },
    })
  }

  if (scope.kind === 'server') {
    const server = doc.servers[scope.serverId]
    pills.push({ key: 'server', label: server?.label ?? scope.serverId, here: true, onClick: null })
  }

  return (
    <nav data-testid="scope-rail" aria-label="dock scope" style={railStyle}>
      {pills.map((p, i) => (
        <span key={p.key} style={{ display: 'inline-flex', alignItems: 'center' }}>
          {i > 0 && <span aria-hidden style={sepStyle}>▸</span>}
          {p.here ? (
            <span data-testid={`scope-pill-${p.key}`} aria-current="location" style={pillHereStyle}>{p.label}</span>
          ) : (
            <button
              type="button" className="kit-press" data-testid={`scope-pill-${p.key}`}
              style={pillStyle} onClick={p.onClick ?? undefined}
            >
              {p.label}
            </button>
          )}
        </span>
      ))}
    </nav>
  )
}
