import { describe, it, expect } from 'vitest'
import { buildChatDigest, buildContextBlock, estimateTokens, attachmentKey } from './context'
import type { ChatContextInput } from './context'

function baseInput(): ChatContextInput {
  return {
    doc: {
      routing: { policy: 'latency', dnsTtlSec: 30, healthCheckIntervalMs: 10000, healthCheckFailureThreshold: 3 },
      regions: {}, azs: {}, servers: {}, blueprints: {}, placements: {}, managedServices: {}, populations: {},
    } as never,
    compiled: { instances: {}, paths: [], findings: [], routing: {} } as never,
    findings: [], compileFindings: [], latestBatch: null, events: [], replayFrames: [],
  }
}

describe('estimateTokens', () => {
  it('estimates roughly len/4', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100)
  })
})

describe('buildChatDigest', () => {
  it('never contains an apiKey/api_key value (security canary)', () => {
    const digest = buildChatDigest(baseInput())
    expect(digest).not.toMatch(/apiKey/i)
    expect(digest).not.toMatch(/api_key/i)
  })

  it('never leaks a raw instance/server map (only top-8 rollups)', () => {
    const input = baseInput()
    ;(input.compiled as { instances: Record<string, unknown> }).instances = {
      'inst-secret-1': { id: 'inst-secret-1', blueprintId: 'bp', serverId: 'srv-secret-1', azId: 'az1', regionId: 'r1' },
    }
    const digest = buildChatDigest(input)
    expect(digest).not.toContain('"inst-secret-1":{')  // no raw map entry, only rollup rows if present
  })

  it('is valid JSON containing the documented top-level keys', () => {
    const digest = buildChatDigest(baseInput())
    const parsed = JSON.parse(digest)
    expect(parsed).toHaveProperty('worldSummary')
    expect(parsed).toHaveProperty('services')
    expect(parsed).toHaveProperty('liveState')
    expect(parsed).toHaveProperty('findingsIndex')
    expect(parsed).toHaveProperty('eventSummary')
    expect(parsed).toHaveProperty('limitations')
  })

  it('includes the no-queue-depth limitation always', () => {
    const parsed = JSON.parse(buildChatDigest(baseInput()))
    expect(parsed.limitations.join(' ')).toMatch(/queue/i)
  })
})

describe('buildContextBlock', () => {
  it('returns empty string for no attachments', () => {
    expect(buildContextBlock([], baseInput())).toBe('')
  })

  it('includes a findings block when findings attached', () => {
    const input = baseInput()
    input.findings = [{ ruleId: 'r1', severity: 'high', message: 'bad', why: 'why', fix: 'fix', affected: ['x'] } as never]
    const block = buildContextBlock([{ kind: 'findings' }], input)
    expect(block).toContain('bad')
  })
})

describe('attachmentKey', () => {
  it('produces stable, distinct keys', () => {
    expect(attachmentKey({ kind: 'entity', id: 'srv-1' })).toBe('entity:srv-1')
    expect(attachmentKey({ kind: 'events' })).toBe('events')
    expect(attachmentKey({ kind: 'traces', scope: { level: 'az', azId: 'az-1' } as never })).toBe('traces:az:az-1')
  })
})
