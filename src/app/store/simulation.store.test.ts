// Regression: the engine's start() always begins at 1x, so the store must re-apply its
// timeScale selection after every start — without this, picking 2x, stopping, and simulating
// again left the select claiming 2x while the engine ran realtime (user report 2026-07-10).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useSimulationStore, pendingEventCount } from './simulation.store'
import { worldEngine } from '../../lib/worldEngine'
import { createWorld } from '../../lib/world/factories'
import { compileWorld } from '../../lib/world/compileWorld'
import { eventLogAppend, eventLogBeginRun } from '../../lib/tauri'
import type { EngineEvent, MetricsBatch } from '../../lib/worldEngine/types'

vi.mock('../../lib/tauri', () => ({
  eventLogBeginRun: vi.fn(async () => 7),
  eventLogAppend: vi.fn(async () => 0),
  eventLogTail: vi.fn(async () => []),
}))

describe('simulation.store timeScale', () => {
  beforeEach(() => {
    vi.spyOn(worldEngine, 'start').mockImplementation(() => {})
    vi.spyOn(worldEngine, 'stop').mockImplementation(() => {})
  })
  afterEach(() => {
    useSimulationStore.getState().resetSession()
    useSimulationStore.setState({ timeScale: 1 })
    vi.restoreAllMocks()
  })

  it('re-applies the stored timeScale to the engine on start', () => {
    const scaleSpy = vi.spyOn(worldEngine, 'setTimeScale').mockImplementation(() => {})
    useSimulationStore.setState({ timeScale: 2 })
    const doc = createWorld()
    useSimulationStore.getState().start(doc, compileWorld(doc))
    expect(scaleSpy).toHaveBeenCalledWith(2)
  })

  it('setTimeScale updates both the engine and the store while stopped', () => {
    const scaleSpy = vi.spyOn(worldEngine, 'setTimeScale').mockImplementation(() => {})
    useSimulationStore.getState().setTimeScale(4)
    expect(scaleSpy).toHaveBeenCalledWith(4)
    expect(useSimulationStore.getState().timeScale).toBe(4)
  })
})

// The durable event spill (2026-07-12): the in-memory `events` list is a presentation window;
// EVERY engine event must reach the event log in 1 Hz batches, with `eventLogTotal` tracking
// the true persisted count and stop() draining whatever the last second buffered.
describe('simulation.store event spill', () => {
  const mkEvent = (n: number): EngineEvent =>
    ({ id: `e${n}`, simMs: n * 100, kind: 'oom_kill', severity: 'critical', message: `m${n}`, affected: [] }) as EngineEvent

  let onEvent: ((e: EngineEvent) => void) | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    onEvent = null
    vi.spyOn(worldEngine, 'start').mockImplementation((_doc, _compiled, callbacks) => {
      onEvent = callbacks.onEvent
    })
    vi.spyOn(worldEngine, 'stop').mockImplementation(() => {})
    vi.spyOn(worldEngine, 'setTimeScale').mockImplementation(() => {})
    let total = 0
    vi.mocked(eventLogBeginRun).mockClear()
    vi.mocked(eventLogAppend).mockClear()
    vi.mocked(eventLogAppend).mockImplementation(async (_runId, events) => {
      total += events.length
      return total
    })
  })
  afterEach(() => {
    useSimulationStore.getState().resetSession()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('flushes buffered events once per second and drains the remainder on stop', async () => {
    const doc = createWorld()
    useSimulationStore.getState().start(doc, compileWorld(doc))
    await vi.advanceTimersByTimeAsync(0)   // begin-run ack lands
    expect(useSimulationStore.getState().eventLogRunId).toBe(7)

    onEvent!(mkEvent(1)); onEvent!(mkEvent(2)); onEvent!(mkEvent(3))
    await vi.advanceTimersByTimeAsync(1000)
    expect(vi.mocked(eventLogAppend)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(eventLogAppend).mock.calls[0][1]).toHaveLength(3)
    expect(useSimulationStore.getState().eventLogTotal).toBe(3)

    onEvent!(mkEvent(4)); onEvent!(mkEvent(5))
    useSimulationStore.getState().stop()   // final drain, no waiting for the next tick
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.mocked(eventLogAppend)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(eventLogAppend).mock.calls[1][1]).toHaveLength(2)
    expect(useSimulationStore.getState().eventLogTotal).toBe(5)
  })

  // Audit ISSUE-005: once a disk spill fails, spillBroken permanently disables flushing for the
  // run — so the buffer feeding that flush must stop growing too, or every subsequent event
  // accumulates forever (a leak the "in-memory window only" fallback claims to survive).
  it('stops buffering (and clears the backlog) once the disk spill breaks — no unbounded growth', async () => {
    const doc = createWorld()
    useSimulationStore.getState().start(doc, compileWorld(doc))
    await vi.advanceTimersByTimeAsync(0)   // begin-run ack lands

    vi.mocked(eventLogAppend).mockImplementation(async () => { throw new Error('disk full') })
    onEvent!(mkEvent(1)); onEvent!(mkEvent(2))
    await vi.advanceTimersByTimeAsync(1000)   // flush attempt fails → spillBroken

    for (let n = 3; n < 50; n++) onEvent!(mkEvent(n))
    await vi.advanceTimersByTimeAsync(5000)
    expect(pendingEventCount()).toBe(0)

    // The in-memory presentation window keeps working regardless.
    expect(useSimulationStore.getState().events.length).toBeGreaterThan(0)
  })

  it('stops buffering when the begin-run ack itself fails', async () => {
    vi.mocked(eventLogBeginRun).mockImplementationOnce(async () => { throw new Error('no db') })
    const doc = createWorld()
    useSimulationStore.getState().start(doc, compileWorld(doc))
    onEvent!(mkEvent(1))                   // buffered while the ack is in flight
    await vi.advanceTimersByTimeAsync(0)   // ack rejection lands → spillBroken

    for (let n = 2; n < 20; n++) onEvent!(mkEvent(n))
    expect(pendingEventCount()).toBe(0)
  })

  it('buffers events that arrive before the run ack and flushes them once it lands', async () => {
    const doc = createWorld()
    useSimulationStore.getState().start(doc, compileWorld(doc))
    onEvent!(mkEvent(1))                   // arrives before eventLogBeginRun resolves
    await vi.advanceTimersByTimeAsync(0)   // ack lands → immediate catch-up flush
    expect(vi.mocked(eventLogAppend)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(eventLogAppend).mock.calls[0][1]).toHaveLength(1)
    expect(useSimulationStore.getState().eventLogTotal).toBe(1)
  })
})

// End (stop) must ERASE the finished run's visual state so a server/region that went down mid-run
// no longer renders as down after ending; Pause must PRESERVE it (scrub/inspect a frozen run).
// (User report 2026-07-23: after ending a sim, the region still showed down and the AZ edge stayed
// X'ed, because stop() left latestBatch/events/scrub/degraded intact.)
describe('simulation.store — End erases run visuals, Pause preserves them', () => {
  let onMetrics: ((b: MetricsBatch) => void) | null = null
  let onEvent: ((e: EngineEvent) => void) | null = null

  const emptyBatch = (simMs: number): MetricsBatch => ({
    simMs, instances: {}, servers: {}, azs: {}, regions: {},
    world: { totalRps: 0, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 },
    managedServices: {},
  })

  beforeEach(() => {
    vi.useFakeTimers()
    onMetrics = null; onEvent = null
    vi.spyOn(worldEngine, 'start').mockImplementation((_doc, _compiled, cb) => { onMetrics = cb.onMetrics; onEvent = cb.onEvent })
    vi.spyOn(worldEngine, 'stop').mockImplementation(() => {})
    vi.spyOn(worldEngine, 'resume').mockImplementation(() => {})
    vi.spyOn(worldEngine, 'setTimeScale').mockImplementation(() => {})
    vi.mocked(eventLogBeginRun).mockClear()
    vi.mocked(eventLogAppend).mockClear()
  })
  afterEach(() => {
    useSimulationStore.getState().resetSession()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const runWithDownState = async () => {
    const doc = createWorld()
    useSimulationStore.getState().start(doc, compileWorld(doc))
    await vi.advanceTimersByTimeAsync(0)                 // begin-run ack
    onMetrics!(emptyBatch(1000))                          // a published frame (as if something went down)
    onEvent!({ id: 'e1', simMs: 1000, kind: 'outage_triggered', severity: 'critical', message: 'down', affected: ['az-1'] } as EngineEvent)
    await vi.advanceTimersByTimeAsync(0)                 // flush the buffered-event microtask
    // Populate the remaining run-scoped fields the way a real down-mid-run session would.
    useSimulationStore.setState({ degraded: true, scrubIndex: 2, scrubBatch: emptyBatch(200), healthOverrides: { 'az-1': true } })
  }

  it('End (stop) clears batch, events, scrub, degraded, health overrides, and event-log fields', async () => {
    await runWithDownState()
    // Precondition: the run left visual state behind.
    expect(useSimulationStore.getState().latestBatch).not.toBeNull()
    expect(useSimulationStore.getState().events.length).toBeGreaterThan(0)

    useSimulationStore.getState().stop()

    const s = useSimulationStore.getState()
    expect(s.running).toBe(false)
    expect(s.paused).toBe(false)
    expect(s.latestBatch).toBeNull()      // ← the region/AZ "down" frame is gone
    expect(s.events).toEqual([])
    expect(s.scrubIndex).toBeNull()
    expect(s.scrubBatch).toBeNull()
    expect(s.degraded).toBe(false)
    expect(s.healthOverrides).toEqual({})
    expect(s.eventLogRunId).toBeNull()
    expect(s.eventLogTotal).toBe(0)
  })

  it('a buffered event microtask after End does not repopulate the cleared window', async () => {
    await runWithDownState()
    onEvent!({ id: 'e2', simMs: 1100, kind: 'outage_triggered', severity: 'critical', message: 'x', affected: [] } as EngineEvent)
    useSimulationStore.getState().stop()   // clears before the microtask fires
    await vi.advanceTimersByTimeAsync(0)   // the orphaned buffer flush must be a no-op
    expect(useSimulationStore.getState().events).toEqual([])
  })

  it('Pause preserves batch, events, scrub, degraded, and health overrides', async () => {
    await runWithDownState()
    useSimulationStore.getState().pause()
    const s = useSimulationStore.getState()
    expect(s.running).toBe(true)          // still an active (frozen) session
    expect(s.paused).toBe(true)
    expect(s.latestBatch).not.toBeNull()
    expect(s.events.length).toBeGreaterThan(0)
    expect(s.degraded).toBe(true)
    expect(s.healthOverrides).toEqual({ 'az-1': true })
  })
})

// Audit ISSUE-019: a fresh start() rebuilds every slow-converging piece of engine state from
// cold (burst credits, failover hysteresis, metric EMAs) — this is correct-to-reset, per
// CLAUDE.md's topology-mutability model, but nothing in the UI told a user that the first few
// seconds of a run look different for reasons unrelated to whatever edit triggered the restart.
describe('simulation.store — warm-up window (audit ISSUE-019)', () => {
  let onMetrics: ((b: MetricsBatch) => void) | null = null

  const emptyBatch = (simMs: number): MetricsBatch => ({
    simMs, instances: {}, servers: {}, azs: {}, regions: {},
    world: { totalRps: 0, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 },
    managedServices: {},
  })

  beforeEach(() => {
    vi.useFakeTimers()
    onMetrics = null
    vi.spyOn(worldEngine, 'start').mockImplementation((_doc, _compiled, cb) => { onMetrics = cb.onMetrics })
    vi.spyOn(worldEngine, 'stop').mockImplementation(() => {})
    vi.spyOn(worldEngine, 'setTimeScale').mockImplementation(() => {})
  })
  afterEach(() => {
    useSimulationStore.getState().resetSession()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('start() sets warmupBatchesRemaining to WARMUP_SECONDS, and it counts down one per published batch', async () => {
    const doc = createWorld()
    useSimulationStore.getState().start(doc, compileWorld(doc))
    await vi.advanceTimersByTimeAsync(0)
    const initial = useSimulationStore.getState().warmupBatchesRemaining
    expect(initial).toBeGreaterThan(0)
    onMetrics!(emptyBatch(1000))
    expect(useSimulationStore.getState().warmupBatchesRemaining).toBe(initial - 1)
  })

  it('never goes negative once every batch has been counted down', async () => {
    const doc = createWorld()
    useSimulationStore.getState().start(doc, compileWorld(doc))
    await vi.advanceTimersByTimeAsync(0)
    const initial = useSimulationStore.getState().warmupBatchesRemaining
    for (let i = 0; i < initial + 5; i++) onMetrics!(emptyBatch(1000 + i * 1000))
    expect(useSimulationStore.getState().warmupBatchesRemaining).toBe(0)
  })

  it('stop() and resetSession() clear the warm-up counter', async () => {
    const doc = createWorld()
    useSimulationStore.getState().start(doc, compileWorld(doc))
    await vi.advanceTimersByTimeAsync(0)
    expect(useSimulationStore.getState().warmupBatchesRemaining).toBeGreaterThan(0)
    useSimulationStore.getState().stop()
    expect(useSimulationStore.getState().warmupBatchesRemaining).toBe(0)
  })
})
