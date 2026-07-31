// Simulate / Pause·Resume / End + timeScale controls for WorldShell's header. Idle shows Simulate;
// an active run shows Pause (or Resume when frozen) + End. Never touches the engine facade
// directly — contracts: "views... read this store; only control actions call the facade."
// (Task 18 adds a `degraded` amber chip, shown when the facade halved its step rate.)
import type { CSSProperties } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { useSimulationStore, selectWarmingUp } from '../store/simulation.store'
import { useWorldStore } from '../store/world.store'
import { useCompiledWorld } from './useCompiledWorld'

const btn: CSSProperties = {
  background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
  borderRadius: 4, padding: '3px 10px', cursor: 'pointer',
  font: '11px var(--font-mono)', color: 'var(--color-text-secondary)',
}
const btnResume: CSSProperties = { ...btn, color: 'var(--color-success)', border: '1px solid var(--color-success)' }
const btnEnd: CSSProperties = { ...btn, color: 'var(--color-danger)', border: '1px solid var(--color-danger)' }
const selectStyle: CSSProperties = {
  background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
  borderRadius: 4, padding: '3px 6px', font: '11px var(--font-mono)', color: 'var(--color-text-primary)',
}
const degradedChip: CSSProperties = {
  padding: '2px 6px', borderRadius: 3, font: '10px var(--font-mono)',
  color: 'var(--color-warning)', border: '1px solid var(--color-warning)',
}
const warmupChip: CSSProperties = {
  padding: '2px 6px', borderRadius: 3, font: '10px var(--font-mono)',
  color: 'var(--color-text-secondary)', border: '1px solid var(--color-node-border)',
}

export function SimControls() {
  const running = useSimulationStore(s => s.running)
  const paused = useSimulationStore(s => s.paused)
  const timeScale = useSimulationStore(s => s.timeScale)
  const degraded = useSimulationStore(s => s.degraded)
  const warmingUp = useSimulationStore(selectWarmingUp)
  const warmupBatchesRemaining = useSimulationStore(s => s.warmupBatchesRemaining)
  const start = useSimulationStore(s => s.start)
  const stop = useSimulationStore(s => s.stop)
  const pause = useSimulationStore(s => s.pause)
  const resume = useSimulationStore(s => s.resume)
  const setTimeScale = useSimulationStore(s => s.setTimeScale)
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const reduced = useReducedMotion()

  // live = actively ticking; a running-but-paused sim keeps its state but freezes.
  const live = running && !paused

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {running && (
        // Pulses green while live; sits static amber while paused (the run is frozen, not ended).
        <motion.span
          aria-hidden
          style={{ width: 7, height: 7, borderRadius: '50%', background: live ? 'var(--color-success)' : 'var(--color-warning)' }}
          animate={reduced || !live ? { opacity: 1 } : { opacity: [1, 0.35, 1] }}
          transition={reduced || !live ? undefined : { duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
        />
      )}

      {!running ? (
        <button className="kit-press" style={btn} onClick={() => start(doc, compiled)}>Simulate</button>
      ) : (
        <>
          {/* Pause/Resume toggles the freeze (run state kept — scrub/inspect); End tears the run
              down and ERASES its visuals + stored run info (persist-on-pause, erase-on-end). */}
          <button className="kit-press" style={live ? btn : btnResume} onClick={() => (live ? pause() : resume())}>
            {live ? 'Pause' : 'Resume'}
          </button>
          <button className="kit-press" style={btnEnd} onClick={() => stop()}>End</button>
        </>
      )}

      {/* Enabled while stopped too: the selection lives in the store and start() re-applies it
          to the engine, so picking 2x before hitting Simulate now works (it used to be a
          disabled control that "didn't seem to do anything"). */}
      <select
        aria-label="time-scale"
        title="Simulation speed"
        style={selectStyle}
        value={timeScale}
        onChange={e => setTimeScale(Number(e.target.value))}
      >
        <option value={1}>1x</option>
        <option value={2}>2x</option>
        <option value={4}>4x</option>
      </select>
      {degraded && (
        <span style={degradedChip} title="Sustained step-cost overrun — the engine halved its tick rate to keep up (see Events)">
          degraded tick
        </span>
      )}
      {warmingUp && (
        // Audit ISSUE-019: purely advisory — a fresh start() rebuilds burst credits, failover
        // hysteresis, and metric EMAs from cold, so the first few seconds of a run look different
        // from a settled one for reasons that have nothing to do with any edit that triggered the
        // restart. Gates nothing; just tells the user not to read too much into it yet.
        <motion.span
          style={warmupChip}
          title="Engine state (burst credits, health hysteresis, metric smoothing) is still settling after this run's start — metrics may not reflect steady state yet"
          animate={reduced ? { opacity: 1 } : { opacity: [1, 0.55, 1] }}
          transition={reduced ? undefined : { duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
        >
          warming up ({warmupBatchesRemaining}s)
        </motion.span>
      )}
    </div>
  )
}
