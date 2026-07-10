// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AnalysisTab, navigateToEntity, unsuppressedCompileFindings } from './AnalysisTab'
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import { useSimulationStore } from '../../store/simulation.store'
import { compileWorld } from '../../../lib/world/compileWorld'
import { getPreset } from '../../../lib/world/instanceCatalog'
import type { AnalysisFinding } from '../../../lib/analysis/types'
import type { CompileFinding } from '../../../lib/world/types'

// Author a world with a single-AZ region (structural warning) via the store's real actions.
// addServer(azId, preset) requires a preset (verified world.store signature).
function seedSingleAzRegion() {
  const w = useWorldStore.getState()
  const rId = w.addRegion('us-east-1')
  const azId = w.addAz(rId, 'us-east-1a')
  const srvId = w.addServer(azId, getPreset('dedicated-8')!)
  const bpId = w.addBlueprint('web')
  w.addPlacement(bpId, srvId)
  return { rId, azId, srvId, bpId }
}

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useNavStore.getState().goGlobe()
  useSimulationStore.setState({ latestBatch: null, scrubBatch: null })
})

describe('AnalysisTab', () => {
  it('groups findings by family and lists a structural warning', () => {
    seedSingleAzRegion()
    render(<AnalysisTab />)
    expect(screen.getByText('Structural')).toBeInTheDocument()
    expect(screen.getByText('Single-AZ region')).toBeInTheDocument()
  })

  it('affected chip navigates to a server (goServer)', () => {
    const { srvId } = seedSingleAzRegion()
    // Add a ram-oversubscribed finding path by oversubscribing the server so a server chip appears.
    const w = useWorldStore.getState()
    // Force server RAM tiny so ram-oversubscribed fires and yields a serverId chip.
    w.updateServer(srvId, { specs: { ...w.doc.servers[srvId].specs, ramMb: 1 } })
    render(<AnalysisTab />)
    const chip = screen.getAllByText(w.doc.servers[srvId].label)[0]
    fireEvent.click(chip)
    expect(useNavStore.getState().level).toBe('server')
    expect(useNavStore.getState().serverId).toBe(srvId)
  })

  it('navigateToEntity resolves entity kinds', () => {
    const { rId, azId, srvId } = seedSingleAzRegion()
    const doc = useWorldStore.getState().doc
    const compiled = compileWorld(doc)
    const calls: string[] = []
    const nav = {
      goRegion: (r: string) => calls.push(`region:${r}`),
      goAz: (_r: string, a: string) => calls.push(`az:${a}`),
      goServer: (_r: string, _a: string, s: string) => calls.push(`server:${s}`),
    }
    expect(navigateToEntity(rId, doc, compiled, nav)).toBe(true)
    expect(navigateToEntity(azId, doc, compiled, nav)).toBe(true)
    expect(navigateToEntity(srvId, doc, compiled, nav)).toBe(true)
    const instId = Object.keys(compiled.instances)[0]
    expect(navigateToEntity(instId, doc, compiled, nav)).toBe(true)          // instance → its server
    expect(navigateToEntity('bp-does-not-navigate', doc, compiled, nav)).toBe(false)
    expect(calls).toEqual([`region:${rId}`, `az:${azId}`, `server:${srvId}`, `server:${srvId}`])
  })

  it('suppresses the compile duplicate covered by a blocked-dependency-path finding', () => {
    const analysis: AnalysisFinding[] = [
      { id: 'blocked-dependency-path:i1->d->i2', ruleId: 'blocked-dependency-path', family: 'network', severity: 'critical', title: 't', why: 'w', fix: 'f', affected: [] },
    ]
    const compile: CompileFinding[] = [
      { id: 'finding-i1->d->i2', severity: 'error', kind: 'blocked-path', message: 'm', affected: [] },
      { id: 'finding-vol-x', severity: 'warning', kind: 'stateful-without-volume', message: 'm2', affected: [] },
    ]
    const kept = unsuppressedCompileFindings(analysis, compile)
    expect(kept.map(f => f.id)).toEqual(['finding-vol-x'])
  })
})
