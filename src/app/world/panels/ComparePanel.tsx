// WorldPanel's Compare tab (Wave 5 FEAT-011 Task 6): a two-column diff between two captured
// RunSummary baselines (`useBaselineStore`, Task 3). A validity banner fires whenever the
// selected pair isn't a sound comparison (different scenarioId or seed — different traffic
// shape/rng means a latency or cost delta says nothing about the change under test), plus a
// softer note when the pair's structural fingerprint is identical (nothing to compare). Every
// per-metric row renders as ONE text node (label + values + delta together) so its color can
// flip direction-aware — lower latency/error-rate is "good" (green), lower peak rps is "bad"
// (throughput regression) — without a second element splitting the sentence a screen reader (or
// a test) would have to stitch back together. Cost rows are the one exception: money always
// renders in var(--color-price), never recolored to success/danger (the price-law constraint —
// a dollar figure must never double as a status/health signal), with direction conveyed only via
// the +/− sign and percentage in the text.
import { useState } from 'react'
import { useBaselineStore } from '../../store/baseline.store'
import { sectionLabel, field, smallBtn, dangerBtn, row } from './panelStyles'
import { saveFileDialog, saveDiagram, openFileDialog, loadDiagram } from '../../../lib/tauri'

// Deltas below this magnitude render as "no change" rather than a misleadingly precise +1%/-1%
// on what's really measurement noise between two runs of the same scenario.
const NOISE_FLOOR = 0.01

function pctDelta(a: number, b: number): number | null {
  if (a === 0) return b === 0 ? 0 : null
  return (b - a) / a
}

interface MetricRowProps {
  label: string
  a: number
  b: number
  lowerIsBetter: boolean
  format: (n: number) => string
  // Money rows always render in var(--color-price) regardless of direction — the price-law
  // constraint says a dollar figure must never read as a status/health signal via success/danger
  // recoloring. Direction is still conveyed via the +/− sign and percentage in the text.
  isMoney?: boolean
}

function MetricRow({ label, a, b, lowerIsBetter, format, isMoney }: MetricRowProps) {
  const delta = pctDelta(a, b)
  const noChange = delta === null || Math.abs(delta) < NOISE_FLOOR
  const good = !noChange && (lowerIsBetter ? delta! < 0 : delta! > 0)
  const color = isMoney
    ? 'var(--color-price)'
    : noChange ? 'var(--color-text-secondary)' : good ? 'var(--color-success)' : 'var(--color-danger)'
  const pctText = noChange ? 'no change' : `${delta! < 0 ? '−' : '+'}${Math.abs(Math.round(delta! * 100))}%`
  return (
    <div style={row}>
      <span style={{ color }}>{`${label} ${format(a)} → ${format(b)} (${pctText})`}</span>
    </div>
  )
}

export function ComparePanel() {
  const summaries = useBaselineStore(s => s.summaries)
  const compareA = useBaselineStore(s => s.compareA)
  const compareB = useBaselineStore(s => s.compareB)
  const setCompareA = useBaselineStore(s => s.setCompareA)
  const setCompareB = useBaselineStore(s => s.setCompareB)
  const remove = useBaselineStore(s => s.remove)
  const exportJson = useBaselineStore(s => s.exportJson)
  const importJson = useBaselineStore(s => s.importJson)
  const [fileError, setFileError] = useState<string | null>(null)

  const a = summaries.find(s => s.id === compareA) ?? null
  const b = summaries.find(s => s.id === compareB) ?? null

  const scenarioDiffers = a && b && a.scenarioId !== b.scenarioId
  const seedDiffers = a && b && a.seed !== b.seed
  const isInvalid = Boolean(scenarioDiffers || seedDiffers)
  // I2 fix (final wave-5 review): `docFingerprint` is deliberately structural-only (instance/path
  // shape — see runSummary.ts) — it stays IDENTICAL across a `populationRpsFactor`-only or
  // `cloudProfile`-only change, so two runs captured under different environments (e.g. "staging"
  // vs "prod") used to read as "nothing changed" even though the whole demand curve or pricing
  // basis moved. Gate the "identical" note on environment/cloudProfile agreement too, and surface
  // a distinct informational note (not the red "not sound" banner above — same structure, same
  // scenario/seed, so the comparison IS still valid) when they differ but the fingerprint matches.
  const envDiffers = Boolean(a && b && (a.environmentId !== b.environmentId || a.cloudProfile !== b.cloudProfile))
  const fingerprintMatches = Boolean(a && b && a.docFingerprint === b.docFingerprint)
  const isIdentical = Boolean(!isInvalid && fingerprintMatches && !envDiffers)
  const isEnvNote = Boolean(!isInvalid && fingerprintMatches && envDiffers)

  return (
    <div>
      <div style={sectionLabel}>Compare runs</div>
      <select style={field} value={compareA ?? ''} onChange={e => setCompareA(e.target.value || null)}>
        <option value="">Select run A</option>
        {summaries.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select>
      <select style={field} value={compareB ?? ''} onChange={e => setCompareB(e.target.value || null)}>
        <option value="">Select run B</option>
        {summaries.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select>

      {isInvalid && (
        <div role="alert" style={{ color: 'var(--color-danger)', marginTop: 8, marginBottom: 8 }}>
          {`Runs differ in ${[scenarioDiffers && 'scenario', seedDiffers && 'seed'].filter(Boolean).join(' and ')} — this comparison is not sound.`}
        </div>
      )}
      {isIdentical && (
        <div role="status" style={{ color: 'var(--color-text-muted)', marginTop: 8, marginBottom: 8 }}>
          Runs share an identical architecture fingerprint — nothing changed structurally between A and B.
        </div>
      )}
      {isEnvNote && (
        <div role="status" style={{ color: 'var(--color-warning)', marginTop: 8, marginBottom: 8 }}>
          {`Same architecture fingerprint, but captured under different ${
            [a!.environmentId !== b!.environmentId && 'environments', a!.cloudProfile !== b!.cloudProfile && 'cloud profiles']
              .filter(Boolean).join(' and ')
          } (A: ${a!.environmentId ?? 'base world'} / ${a!.cloudProfile ?? 'generic'} vs B: ${b!.environmentId ?? 'base world'} / ${b!.cloudProfile ?? 'generic'}) — demand volume or pricing may differ even though nothing changed structurally.`}
        </div>
      )}

      {a && b && (
        <>
          <div style={sectionLabel}>Latency</div>
          <MetricRow label="p50" a={a.latency.p50Ms} b={b.latency.p50Ms} lowerIsBetter format={n => `${n.toFixed(0)}ms`} />
          <MetricRow label="p90" a={a.latency.p90Ms} b={b.latency.p90Ms} lowerIsBetter format={n => `${n.toFixed(0)}ms`} />
          <MetricRow label="p99" a={a.latency.p99Ms} b={b.latency.p99Ms} lowerIsBetter format={n => `${n.toFixed(0)}ms`} />

          <div style={sectionLabel}>Traffic</div>
          <MetricRow label="error rate" a={a.errorRate} b={b.errorRate} lowerIsBetter format={n => `${(n * 100).toFixed(2)}%`} />
          <MetricRow label="peak rps" a={a.peakRps} b={b.peakRps} lowerIsBetter={false} format={n => n.toFixed(0)} />

          <div style={sectionLabel}>Cost</div>
          <MetricRow label="cost mean $/hr" a={a.cost.meanHourlyUsd} b={b.cost.meanHourlyUsd} lowerIsBetter format={n => `$${n.toFixed(2)}`} isMoney />
          <MetricRow label="cost peak $/hr" a={a.cost.peakHourlyUsd} b={b.cost.peakHourlyUsd} lowerIsBetter format={n => `$${n.toFixed(2)}`} isMoney />
          <MetricRow label="cost total" a={a.cost.totalUsd} b={b.cost.totalUsd} lowerIsBetter format={n => `$${n.toFixed(2)}`} isMoney />

          <div style={sectionLabel}>SLO breaches</div>
          <div style={row}>
            <span style={{ color: 'var(--color-text-secondary)' }}>{a.slo.breaches.length} vs {b.slo.breaches.length}</span>
          </div>
        </>
      )}

      <div style={sectionLabel}>Captured runs ({summaries.length})</div>
      {summaries.length === 0 && <div style={{ color: 'var(--color-text-muted)' }}>no baselines captured yet</div>}
      {summaries.map(s => (
        <div key={s.id} style={row}>
          <span style={{ flex: 1 }}>{s.label}</span>
          <button type="button" style={dangerBtn} onClick={() => remove(s.id)}>remove</button>
        </div>
      ))}
      {fileError && (
        <div role="alert" style={{ color: 'var(--color-danger)', marginTop: 8, marginBottom: 8 }}>
          {fileError} <button type="button" style={{ ...smallBtn, padding: '0 6px' }} onClick={() => setFileError(null)}>dismiss</button>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button
          type="button"
          style={smallBtn}
          onClick={() => {
            (async () => {
              const path = await saveFileDialog()
              if (!path) return
              await saveDiagram(path, exportJson())
            })().catch(() => setFileError('Export failed — could not write the baseline file.'))
          }}
        >
          Export
        </button>
        <button
          type="button"
          style={smallBtn}
          onClick={() => {
            (async () => {
              const path = await openFileDialog()
              if (!path) return
              const json = await loadDiagram(path)
              importJson(json)
            })().catch(() => setFileError('Import failed — file is not a valid baseline export.'))
          }}
        >
          Import
        </button>
      </div>
    </div>
  )
}
