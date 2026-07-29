// src/app/world/panels/BlueprintsPanel.tsx
// The global service-blueprint library — world scope.
//
// `ServiceBlueprint` has always been a genuinely global, reusable entity: `blueprints` and
// `placements` are sibling normalized maps, one blueprint mounts on many hosts, `spreadBlueprint`
// fans one across N AZs. But node-model Phase 5 removed the world-scope Blueprints tab, leaving
// the definition discoverable ONLY through a host that already runs it. This panel is the missing
// library surface — it does not resurrect the retired generic-blueprint authoring model: creating
// a service still happens at the VPS door (dock/drawers/AddServiceForm), which is what also
// places it. What you get here is the catalog view: every definition, where it runs, edit,
// duplicate, delete.
//
// Dependencies are shown as a count only; the Connections graph authors relationships (see
// BlueprintModal's header for why).
import { useState, type CSSProperties } from 'react'
import { useWorldStore } from '../../store/world.store'
import type { ServiceBlueprint, WorldDoc } from '../../../lib/world/types'
import { SectionHeader, Explainer } from '../ui/kit'
import { smallBtn, dangerBtn, row } from './panelStyles'
import { BlueprintModal } from './BlueprintModal'

const chip: CSSProperties = {
  fontSize: 9, padding: '1px 5px', borderRadius: 3, flexShrink: 0,
  border: '1px solid var(--color-node-border)', color: 'var(--color-text-muted)',
}
const muted: CSSProperties = { fontSize: 9.5, color: 'var(--color-text-muted)' }
const actionBtn: CSSProperties = {
  font: '10px var(--font-mono)', background: 'var(--color-node-base)',
  border: '1px solid var(--color-node-border)', borderRadius: 5, padding: '4px 12px',
  color: 'var(--color-text-secondary)', cursor: 'pointer',
}

// Where this definition actually runs: N hosts across M AZs. An unplaced blueprint is the
// interesting case — it costs nothing and simulates nothing, and the row says so plainly.
function placementSummary(doc: WorldDoc, bpId: string): string {
  const servers = Object.values(doc.placements).filter(p => p.blueprintId === bpId).map(p => p.serverId)
  if (servers.length === 0) return 'not placed'
  const azs = new Set(servers.map(sid => doc.servers[sid]?.azId).filter(Boolean))
  return `${servers.length} host${servers.length === 1 ? '' : 's'} · ${azs.size} AZ${azs.size === 1 ? '' : 's'}`
}

function workloadSummary(bp: ServiceBlueprint): string {
  const parts = [`${bp.workload.cpuMsPerRequest} ms/req`]
  if (bp.workload.cpuMsPerKb) parts.push(`+${bp.workload.cpuMsPerKb} ms/KB`)
  parts.push(`${bp.workload.ramBaseMb} MB`)
  if (bp.ports[0]) parts.push(`:${bp.ports[0].port}${bp.ports[0].visibility === 'public' ? ' public' : ''}`)
  return parts.join(' · ')
}

export interface BlueprintsPanelProps {
  /** Opens the full-screen connections canvas — where dependencies are authored. */
  openConnections: () => void
}

export function BlueprintsPanel({ openConnections }: BlueprintsPanelProps) {
  const doc = useWorldStore(s => s.doc)
  const removeBlueprint = useWorldStore(s => s.removeBlueprint)
  const duplicateBlueprint = useWorldStore(s => s.duplicateBlueprint)
  const [editingId, setEditingId] = useState<string | null>(null)
  const blueprints = Object.values(doc.blueprints).sort((a, b) => a.name.localeCompare(b.name))

  return (
    <div>
      <SectionHeader label="▸ SERVICES" />
      <Explainer>
        Every service definition in this world, whether or not it runs anywhere. A definition is
        global — mount the same one on many hosts and each becomes an instance. Add a new service
        from a host (its VPS door); duplicate here when you want a variant to diverge from.
      </Explainer>
      {blueprints.length === 0 && (
        <div style={{ color: 'var(--color-text-muted)', margin: '6px 0' }}>
          no services yet — open a server and add one
        </div>
      )}
      {blueprints.map(bp => {
        const deps = bp.dependencies.length
        const owned = bp.ownerServerKind != null
        return (
          <div key={bp.id} style={{
            background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
            borderRadius: 8, padding: 10, marginTop: 8,
          }}>
            <div style={row}>
              <span aria-hidden style={{
                width: 10, height: 10, borderRadius: 2, flexShrink: 0,
                background: bp.color, border: '1px solid var(--color-node-border)',
              }} />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {bp.name}
              </span>
              <span style={chip}>{bp.kind}</span>
            </div>
            <div style={{ ...row, marginTop: 4 }}>
              <span style={{ ...muted, flex: 1, minWidth: 0 }}>{workloadSummary(bp)}</span>
            </div>
            <div style={{ ...row, marginTop: 2 }}>
              <span style={{ ...muted, flex: 1, minWidth: 0 }}>
                {placementSummary(doc, bp.id)} · {deps} dep{deps === 1 ? '' : 's'}
              </span>
            </div>
            <div style={{ ...row, marginTop: 4, marginBottom: 0 }}>
              <button className="kit-press" style={smallBtn} aria-label={`edit-blueprint-${bp.id}`}
                onClick={() => setEditingId(bp.id)}>edit</button>
              <button className="kit-press" style={smallBtn} aria-label={`duplicate-blueprint-${bp.id}`}
                title="a second definition to diverge from — copied unplaced"
                onClick={() => duplicateBlueprint(bp.id)}>dup</button>
              <span style={{ flex: 1 }} />
              {/* An appliance-owned blueprint (a DB box's own service) has no independent life —
                  deleting it would orphan the box, so removal goes through the box itself. */}
              <button className="kit-press" style={owned ? { ...dangerBtn, opacity: 0.35, cursor: 'default' } : dangerBtn}
                aria-label={`remove-blueprint-${bp.id}`} disabled={owned}
                title={owned ? 'owned by an appliance — remove the box instead' : 'deletes the definition and every placement of it'}
                onClick={() => removeBlueprint(bp.id)}>×</button>
            </div>
          </div>
        )
      })}

      <SectionHeader label="▸ CONNECTIONS" />
      <Explainer>Dependencies between these services — and the packets each carries — live in the graph.</Explainer>
      <button className="kit-press" style={actionBtn} aria-label="open connections graph"
        onClick={openConnections}>open connections graph ↗</button>

      <BlueprintModal
        open={editingId !== null}
        editingId={editingId}
        onClose={() => setEditingId(null)}
        onOpenConnections={openConnections}
      />
    </div>
  )
}
