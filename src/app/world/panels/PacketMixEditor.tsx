// src/app/world/panels/PacketMixEditor.tsx
// The one weighted-mix control, shared by every carrier that can bind packets: a dependency edge
// (ConnectionsView's EdgeInspector) and a route's "advanced" binding (RoutesPanel).
//
// Lifted from TrafficPanel's RequestMixEditor rather than written a third time — the interaction
// is identical (one row per library entry, a relative weight, blank/0 ⇒ not in the mix, a live %
// readout). TrafficPanel keeps its own copy for now because it binds ROUTES by string routeId,
// not packets by numeric id; if a third route-mix carrier ever appears, that is the moment to
// generalize this over the key type instead of duplicating again.
//
// Presentation only: it renders the CURRENT mix and calls onChange with the next one. Stripping
// weight-0 rows and deciding "empty mix ⇒ unbound" is the store's job (setDependencyPacketMix /
// setRoutePacketMix), so this component never has to know what absence means.
import type { PacketMixEntry, PacketRegistry } from '../../../lib/nodeConfig'
import { listPackets } from '../../../lib/nodeConfig'
import { NumberField } from './NumberField'
import { Explainer } from '../ui/kit'

export interface PacketMixEditorProps {
  registry: PacketRegistry
  mix: PacketMixEntry[] | undefined
  onChange: (mix: PacketMixEntry[]) => void
  /** Prefix for each row's aria-label, so two editors on one screen stay addressable. */
  idPrefix: string
  /** Shown when the library is empty — says where to go author one. */
  emptyHint?: string
}

export function PacketMixEditor({ registry, mix, onChange, idPrefix, emptyHint }: PacketMixEditorProps) {
  const packets = listPackets(registry)
  if (packets.length === 0) {
    return <Explainer>{emptyHint ?? 'No packets defined. Add them in the Packets tab to give this hop real payload sizes.'}</Explainer>
  }

  const entries = mix ?? []
  const weightOf = (packetId: number) => entries.find(e => e.packetId === packetId)?.weight ?? 0
  const total = entries.reduce((sum, e) => sum + (e.weight > 0 ? e.weight : 0), 0)
  const setWeight = (packetId: number, w: number) => {
    const others = entries.filter(e => e.packetId !== packetId)
    onChange(w > 0 ? [...others, { packetId, weight: w }] : others)
  }

  return (
    <div style={{ marginTop: 6 }}>
      {packets.map(p => {
        const w = weightOf(p.id)
        const pct = total > 0 && w > 0 ? Math.round((w / total) * 100) : 0
        return (
          <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
            <span aria-hidden style={{
              width: 8, height: 8, borderRadius: 2, flexShrink: 0,
              background: p.colorOverride ?? 'transparent',
              border: `1px solid ${p.colorOverride ?? 'var(--color-node-border)'}`,
            }} />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {p.name}
            </span>
            <span style={{ width: 32, textAlign: 'right', fontSize: 9.5, color: w > 0 ? 'var(--kit-teal)' : 'var(--color-text-muted)' }}>
              {w > 0 ? `${pct}%` : '—'}
            </span>
            <NumberField label={`${idPrefix}-${p.id}`} value={w} min={0} max={Infinity} onCommit={n => setWeight(p.id, n)} />
          </div>
        )
      })}
    </div>
  )
}
