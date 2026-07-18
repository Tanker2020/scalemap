// src/app/world/az/paletteEntries.ts
// The AZ floor's typed node palette — what you can drop into an availability zone.
//
// PURE: no React, no store imports (type-only imports erase at build time), so this stays
// node-env testable, matching floorLayout.ts / floorData.ts / labelLayout.ts in this directory.
// The rendering component (NodePalette.tsx) owns dispatch; this file owns only WHAT is offered
// and how it's grouped/labelled.
//
// Derived from INSTANCE_CATALOG rather than hand-listed, so a preset added there shows up in the
// palette automatically and can never drift out of sync with what getPreset() can resolve.
import { INSTANCE_CATALOG } from '../../../lib/world/instanceCatalog'
import { isDbServerKind, type ServerKind, type WorldDoc } from '../../../lib/world/types'

// Compute nodes are empty hosts you fill with services; data nodes arrive preconfigured as a
// database appliance. (Caches, queues and the rest of the palette stay ManagedService-backed —
// they are typed cost/routing terminals, not hosts, so they are not offered here.)
export type PaletteGroup = 'compute' | 'data'

export interface PaletteEntry {
  presetId: string
  label: string
  group: PaletteGroup
  kind: ServerKind
  hourlyUsd: number
  detail: string
}

const GROUP_ORDER: PaletteGroup[] = ['compute', 'data']

function groupOf(kind: ServerKind): PaletteGroup {
  return isDbServerKind(kind) ? 'data' : 'compute'
}

function detailOf(vcpu: number, ramMb: number): string {
  return `${vcpu} vCPU · ${Math.round(ramMb / 1024)} GB`
}

// Catalog labels embed their specs — 'VPS Medium (4 vCPU / 8 GB)'. The palette already renders
// those specs in its own detail column, so keeping the parenthetical made every row say the same
// numbers twice and wrap onto a second line. Strip it for the palette only; the catalog label is
// left untouched for the places that show a preset on its own (the hardware drawer, topology).
function shortLabel(label: string): string {
  return label
    // 'VPS Medium (4 vCPU / 8 GB)' -> 'VPS Medium'
    .replace(/\s*\([^)]*\)\s*$/, '')
    // 'Dedicated 16-core / 64 GB' -> 'Dedicated 16-core'. Only the trailing RAM figure goes:
    // the core count is what distinguishes the three dedicated presets from each other.
    .replace(/\s*\/\s*[\d.]+\s*[GT]B\s*$/i, '')
    .trim()
}

// Catalog order within a group is meaningful (small → large), so this is a STABLE partition by
// group rather than a sort: entries keep their catalog order inside each section.
export function nodePaletteEntries(): PaletteEntry[] {
  const entries = INSTANCE_CATALOG.map<PaletteEntry>(preset => ({
    presetId: preset.id,
    label: shortLabel(preset.label),
    group: groupOf(preset.kind),
    kind: preset.kind,
    hourlyUsd: preset.hourlyUsd,
    detail: detailOf(preset.specs.vcpu, preset.specs.ramMb),
  }))
  return GROUP_ORDER.flatMap(group => entries.filter(e => e.group === group))
}

// A default name for a new DB appliance — 'sql-1', 'nosql-2'. Engines are numbered independently
// so adding a SQL box never renumbers the NoSQL series. Counts SERVERS of the kind rather than
// blueprints, because a replica added later shares its primary's blueprint (the blueprint IS the
// cluster) and must not be counted as a second database.
export function nextApplianceName(doc: WorldDoc, kind: ServerKind): string {
  const stem = kind === 'db-nosql' ? 'nosql' : 'sql'
  const existing = Object.values(doc.servers).filter(s => s.kind === kind).length
  return `${stem}-${existing + 1}`
}
