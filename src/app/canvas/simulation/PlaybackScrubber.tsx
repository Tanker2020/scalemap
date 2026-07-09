import { useShallow } from 'zustand/react/shallow'
import { useSimulationStore } from '../../store/simulationLegacy.store'
import { useReplayStore } from '../../store/replay.store'
import styles from './PlaybackScrubber.module.css'

function fmtTime(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return m > 0 ? `${m}:${String(sec).padStart(2, '0')}` : `${sec}s`
}

// Outage playback scrubber — appears at the bottom of the canvas only while paused with a
// recorded buffer. Dragging sets the replay cursor; the engine redraws particles and all
// metric/colour reads resolve to that moment via the replay store.
export function PlaybackScrubber() {
  const running = useSimulationStore(s => s.running)
  const paused  = useSimulationStore(s => s.paused)
  const setPaused = useSimulationStore(s => s.setPaused)
  const { frameTimes, replayIndex } = useReplayStore(
    useShallow(s => ({ frameTimes: s.frameTimes, replayIndex: s.replayIndex })),
  )
  const setReplayIndex = useReplayStore(s => s.setReplayIndex)

  if (!running || !paused || frameTimes.length === 0) return null

  const idx = replayIndex < 0 ? frameTimes.length - 1 : replayIndex
  const curT = frameTimes[idx] ?? 0
  const totalT = frameTimes[frameTimes.length - 1] ?? 0
  const atLatest = idx === frameTimes.length - 1

  return (
    <div className={styles.bar}>
      <span className={styles.badge}>◀◀ REPLAY</span>
      <span className={styles.time}>{fmtTime(curT)}</span>
      <input
        className={styles.slider}
        type="range"
        min={0}
        max={frameTimes.length - 1}
        step={1}
        value={idx}
        onChange={e => setReplayIndex(Number(e.target.value))}
        aria-label="Scrub outage timeline"
      />
      <span className={styles.total}>{fmtTime(totalT)}</span>
      <button
        className={styles.liveBtn}
        onClick={() => setPaused(false)}
        title="Resume the live simulation"
      >
        {atLatest ? '▶ Resume' : '⏭ Live'}
      </button>
    </div>
  )
}
