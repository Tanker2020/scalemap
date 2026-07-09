// Simulate/Stop + timeScale controls for WorldShell's header. Never touches the engine facade
// directly — contracts: "views... read this store; only control actions call the facade."
// (T18 later adds a `degraded` amber chip here once simulation.store gains that field — not
// this task's job; see Task 18.)
import type { CSSProperties } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { useSimulationStore } from '../store/simulation.store'
import { useWorldStore } from '../store/world.store'
import { useCompiledWorld } from './useCompiledWorld'

const btn: CSSProperties = {
  background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
  borderRadius: 4, padding: '3px 10px', cursor: 'pointer',
  font: '11px var(--font-mono)', color: 'var(--color-text-secondary)',
}
const btnRunning: CSSProperties = { ...btn, color: 'var(--color-danger)', border: '1px solid var(--color-danger)' }
const selectStyle: CSSProperties = {
  background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
  borderRadius: 4, padding: '3px 6px', font: '11px var(--font-mono)', color: 'var(--color-text-primary)',
}

export function SimControls() {
  const running = useSimulationStore(s => s.running)
  const timeScale = useSimulationStore(s => s.timeScale)
  const start = useSimulationStore(s => s.start)
  const stop = useSimulationStore(s => s.stop)
  const setTimeScale = useSimulationStore(s => s.setTimeScale)
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const reduced = useReducedMotion()

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {running && (
        <motion.span
          aria-hidden
          style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--color-success)' }}
          animate={reduced ? { opacity: 1 } : { opacity: [1, 0.35, 1] }}
          transition={reduced ? undefined : { duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
        />
      )}
      <button
        style={running ? btnRunning : btn}
        onClick={() => (running ? stop() : start(doc, compiled))}
      >
        {running ? 'Stop' : 'Simulate'}
      </button>
      <select
        aria-label="time-scale"
        style={selectStyle}
        value={timeScale}
        disabled={!running}
        onChange={e => setTimeScale(Number(e.target.value))}
      >
        <option value={1}>1x</option>
        <option value={2}>2x</option>
        <option value={4}>4x</option>
      </select>
    </div>
  )
}
