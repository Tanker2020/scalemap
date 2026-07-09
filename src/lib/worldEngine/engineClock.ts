// Fixed-step accumulator clock (default 100ms) turning rAF frame deltas into a whole number
// of simulation steps. Spec decision 1, docs/superpowers/specs/2026-07-08-phase2-substrate-engine-design.md.
// NOTE: this is a narrower helper than the frozen `EngineClock` contract type in ./types —
// see SKELETON CONCERNS #3 at the top of this fragment.

export interface ClockHandle {
  readonly simMs: number
  /** Feed a real elapsed-frame duration (ms) and a timeScale multiplier; returns how many
   *  fixed steps the caller should run this frame. Leftover time carries to the next call. */
  advance(frameMs: number, timeScale: number): number
}

export function createClock(stepMs: number = 100): ClockHandle {
  let simMs = 0
  let accumulatorMs = 0
  return {
    get simMs() {
      return simMs
    },
    advance(frameMs: number, timeScale: number): number {
      accumulatorMs += frameMs * timeScale
      let steps = 0
      while (accumulatorMs >= stepMs) {
        accumulatorMs -= stepMs
        simMs += stepMs
        steps++
      }
      return steps
    },
  }
}
