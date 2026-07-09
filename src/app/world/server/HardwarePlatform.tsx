// src/app/world/server/HardwarePlatform.tsx
// Unified host platform (D4): CPU die + utilization ring (hatched amber steal arc for VPS),
// stratified RAM reservoir (one colored stratum per resident + os/cache remainder), sliced disk
// platter with an io scanner. All numbers from ServerMetrics (order-stable); at-rest estimate
// from blueprint ramBaseMb when metrics is null (D5). prefers-reduced-motion parks the scanner
// and drops idle shimmer.
import type { ReactElement } from 'react'
import { useReducedMotion } from 'framer-motion'
import type { Server, InstanceId } from '../../../lib/world/types'   // id types from world/types (not re-exported by worldEngine/types)
import type { ServerMetrics } from '../../../lib/worldEngine/types'
import type { CoreAttribution } from './boardLayout'
import type { BoardSelection } from './selection'

const AMBER = '#F5A623', CPU_BLUE = '#4A9EFF'

export interface HardwarePlatformProps {
  server: Server
  metrics: ServerMetrics | null
  residentBlueprints: { instanceId: InstanceId; blueprintId: string; color: string; name: string; ramBaseMb: number }[]
  attribution: CoreAttribution[]
  hoveredBlueprintId: string | null
  onHoverBlueprint: (id: string | null) => void
  onSelect: (s: BoardSelection | null) => void
  box?: { x: number; y: number; w: number; h: number }   // hardware.box from layout (optional)
  memLimits?: Record<InstanceId, number>                  // container memLimitMb by instance
  instanceRamMb?: Record<InstanceId, number>              // live per-instance ramMb (oom check)
}

export function HardwarePlatform(props: HardwarePlatformProps): ReactElement {
  const { server, metrics, residentBlueprints, attribution, hoveredBlueprintId, onHoverBlueprint, onSelect } = props
  const reduced = useReducedMotion()
  const vcpu = server.specs.vcpu
  const cols = Math.ceil(Math.sqrt(vcpu))
  const dimFor = (bpId: string | null) => (hoveredBlueprintId && bpId !== hoveredBlueprintId ? 0.45 : 1)

  const cores = metrics?.coreUtilization ?? new Array(vcpu).fill(0)
  const meanUtil = cores.length ? cores.reduce((a, b) => a + b, 0) / cores.length : 0
  const steal = metrics?.stealFraction ?? 0

  // RAM strata: instance slices in order + os/cache remainder (D4).
  const atRest = metrics === null
  const strata = atRest
    // at-rest estimate (D5): each resident blueprint's workload.ramBaseMb
    ? residentBlueprints.map(r => ({ instanceId: r.instanceId, blueprintId: r.blueprintId, color: r.color, name: r.name, ramMb: r.ramBaseMb }))
    : (metrics!.ramByInstance).map(s => {
        const rb = residentBlueprints.find(r => r.instanceId === s.instanceId)
        return { instanceId: s.instanceId, blueprintId: s.blueprintId, color: rb?.color ?? CPU_BLUE, name: rb?.name ?? '?', ramMb: s.ramMb }
      })
  const ramUsed = metrics?.ramUsedMb ?? strata.reduce((a, s) => a + s.ramMb, 0)
  const ramTotal = metrics?.ramTotalMb ?? server.specs.ramMb
  const osCache = Math.max(0, ramUsed - strata.reduce((a, s) => a + s.ramMb, 0))

  // Disk slices: system 15% + one per volume, remainder free (D4).
  const diskGb = server.specs.diskGb
  const volumes = server.stacks.flatMap(st => st.volumes)
  const systemGb = diskGb * 0.15
  const usedGb = systemGb + volumes.reduce((a, v) => a + v.sizeGb, 0)
  const io = metrics?.diskIoFraction ?? 0
  const HEALTH_COLOR = { healthy: 'var(--color-success)', degraded: 'var(--color-warning)', down: 'var(--color-danger)' } as const
  const hostHealth = metrics?.health ?? 'healthy'

  return (
    <div data-hardware style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 8, font: '7px var(--font-mono)', color: 'var(--color-text-secondary)' }}>
      <div style={{ color: '#8FA8C7', letterSpacing: '0.12em', display: 'flex', alignItems: 'center', gap: 4 }}>
        <span data-host-health style={{ width: 5, height: 5, borderRadius: '50%', background: HEALTH_COLOR[hostHealth], boxShadow: `0 0 5px ${HEALTH_COLOR[hostHealth]}` }} />
        ⬢ HOST · {server.kind}{server.kind === 'vps' ? ' (shared tenancy)' : ''}
      </div>

      {/* CPU die */}
      <div data-cpu onClick={() => onSelect({ kind: 'hardware', part: 'cpu' })} style={{ cursor: 'pointer' }}>
        <svg width={100} height={100} viewBox="0 0 100 100">
          <circle cx={50} cy={50} r={45} fill="none" stroke="#16202E" strokeWidth={5} />
          <circle cx={50} cy={50} r={45} fill="none" stroke={CPU_BLUE} strokeWidth={5} strokeLinecap="round"
            strokeDasharray={`${meanUtil * 283} 283`} transform="rotate(-90 50 50)" style={{ filter: `drop-shadow(0 0 5px ${CPU_BLUE})` }} />
          {steal > 0 && (
            <circle cx={50} cy={50} r={45} fill="none" stroke={AMBER} strokeWidth={5}
              strokeDasharray="2 3.1" strokeDashoffset={-meanUtil * 283} pathLength={283} transform="rotate(-90 50 50)" opacity={0.9} />
          )}
        </svg>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 3, width: 56, margin: '-78px auto 0' }}>
          {cores.map((u, i) => {
            const dom = attribution[i]?.dominantBlueprintId ?? null
            const color = residentBlueprints.find(r => r.blueprintId === dom)?.color ?? CPU_BLUE
            return <div key={i} data-testid="core-cell" style={{ height: 18, borderRadius: 2, background: `linear-gradient(0deg, ${color} ${Math.round(u * 100)}%, #141B26 ${Math.round(u * 100)}%)`, opacity: dimFor(dom) }} />
          })}
        </div>
        <div style={{ textAlign: 'center', color: '#9CC8FF', marginTop: 6 }}>
          cpu {Math.round(meanUtil * 100)}%{steal > 0 && <span style={{ color: AMBER }}> +{Math.round(steal * 100)}% steal</span>}
        </div>
        {metrics?.burstCredits != null && (
          <div style={{ height: 2, background: '#0F2B27', marginTop: 2 }}><div style={{ width: `${metrics.burstCredits * 100}%`, height: '100%', background: AMBER }} /></div>
        )}
      </div>

      {/* RAM reservoir */}
      <div data-ram onClick={() => onSelect({ kind: 'hardware', part: 'ram' })} style={{ display: 'flex', gap: 6, alignItems: 'flex-end', cursor: 'pointer' }}>
        <div style={{ width: 34, height: 64, background: '#0C1119', border: '1px solid #2A3648', borderRadius: '5px 5px 3px 3px', position: 'relative', overflow: 'hidden' }}>
          {(() => { let acc = 0; return strata.map(s => {
            const pct = ramTotal ? (s.ramMb / ramTotal) * 100 : 0
            const el = <div key={s.instanceId} data-testid="ram-stratum" onMouseEnter={() => onHoverBlueprint(s.blueprintId)} onMouseLeave={() => onHoverBlueprint(null)}
              style={{ position: 'absolute', bottom: `${acc}%`, width: '100%', height: `${pct}%`, background: s.color, opacity: dimFor(s.blueprintId) }} />
            acc += pct; return el
          }) })()}
          <div data-testid="ram-stratum" style={{ position: 'absolute', bottom: `${ramTotal ? (ramUsed - osCache) / ramTotal * 100 : 0}%`, width: '100%', height: `${ramTotal ? osCache / ramTotal * 100 : 0}%`, background: 'linear-gradient(0deg,#F5A62388,#F5A62333)' }} />
          {!reduced && metrics && (
            <div style={{ position: 'absolute', bottom: `${ramTotal ? (ramUsed / ramTotal) * 100 : 0}%`, width: '100%', height: 1.5, background: 'linear-gradient(90deg,transparent,#FFE9C2,transparent)', opacity: 0.8, animation: 'shimmer 1.8s ease-in-out infinite' }} />
          )}
        </div>
        <div style={{ flex: 1, lineHeight: 1.7 }}>
          <div style={{ color: '#E2E8F0' }}>ram {(ramUsed / 1024).toFixed(1)}/{(ramTotal / 1024).toFixed(0)}G {atRest && <span style={{ color: 'var(--color-text-muted)' }}>(at rest)</span>}</div>
          {strata.map(s => {
            const oom = !!(props.memLimits?.[s.instanceId] && props.instanceRamMb?.[s.instanceId] && props.instanceRamMb[s.instanceId] >= props.memLimits[s.instanceId] * 0.9)
            return <div key={s.instanceId} style={{ opacity: dimFor(s.blueprintId) }}><span style={{ color: s.color }}>▮</span> {s.name} {Math.round(s.ramMb)}M {oom && <span style={{ color: 'var(--color-danger)' }}>⚠oom</span>}</div>
          })}
          <div><span style={{ color: AMBER }}>▮</span> os + cache {Math.round(osCache)}M</div>
        </div>
      </div>

      {/* Disk platter */}
      <div data-disk onClick={() => onSelect({ kind: 'hardware', part: 'disk' })} style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
        <svg width={52} height={52} viewBox="0 0 52 52">
          <circle cx={26} cy={26} r={23} fill="#0C1119" stroke="#2A3648" strokeWidth={1} />
          {(() => {
            const circ = 2 * Math.PI * 11.5
            let off = 0
            const slices: ReactElement[] = []
            const push = (gb: number, color: string, key: string) => {
              const len = diskGb ? (gb / diskGb) * circ : 0
              slices.push(<circle key={key} cx={26} cy={26} r={11.5} fill="none" stroke={color} strokeWidth={21} strokeDasharray={`${len} ${circ - len}`} strokeDashoffset={-off} transform="rotate(-90 26 26)" opacity={0.85} />)
              off += len
            }
            push(systemGb, '#33415888', 'system')
            volumes.forEach(v => push(v.sizeGb, AMBER, v.name))
            return slices
          })()}
          <line x1={26} y1={26} x2={26} y2={4} stroke="#7CFFE9" strokeWidth={1} opacity={0.7}
            style={reduced || !metrics ? undefined : { transformOrigin: '26px 26px', animation: `spin ${(3.5 / Math.max(io, 0.05)).toFixed(2)}s linear infinite` }} />
          <circle cx={26} cy={26} r={3} fill="#141B26" stroke="#2A3648" />
        </svg>
        <div style={{ flex: 1, lineHeight: 1.7 }}>
          <div style={{ color: '#E2E8F0' }}>nvme0 {Math.round(usedGb)}/{diskGb}G · io {Math.round(io * 100)}%</div>
          {volumes.map(v => <div key={v.name}><span style={{ color: AMBER }}>▮</span> vol {v.name} {v.sizeGb}G</div>)}
          <div><span style={{ color: '#64748B' }}>▮</span> system {Math.round(systemGb)}G · free {Math.round(diskGb - usedGb)}G</div>
        </div>
      </div>
    </div>
  )
}
