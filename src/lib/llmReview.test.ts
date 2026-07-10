// src/lib/llmReview.test.ts
import { describe, it, expect, vi } from 'vitest'
import {
  buildReviewContext, validateReviewResponse, requestReview, pingLlm, type AiIssue,
} from './llmReview'
import { createWorld, createRegion } from './world/factories'
import { compileWorld } from './world/compileWorld'
import type { LlmSettings } from './tauri'
import type { MetricsBatch } from './worldEngine/types'

const SETTINGS: LlmSettings = { baseUrl: 'http://localhost:4141/v1', apiKey: 'sk-test', model: 'gpt-4o-mini' }

function envelope(content: string): string {
  return JSON.stringify({ choices: [{ message: { content } }] })
}

function issuesJson(issues: Partial<AiIssue>[]): string {
  return '```json\n' + JSON.stringify({ issues }) + '\n```'
}

describe('buildReviewContext', () => {
  it('contains no apiKey value (canary scan)', () => {
    const doc = createWorld()
    const compiled = compileWorld(doc)
    const context = buildReviewContext(doc, compiled, [], null)
    expect(context).not.toMatch(/apiKey/i)
    expect(context).not.toMatch(/api_key/i)
  })

  it('aggregates region metrics and omits raw instance/server maps', () => {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    doc.regions[region.id] = region
    const compiled = compileWorld(doc)

    const batch: MetricsBatch = {
      simMs: 5000,
      instances: {
        'inst-secret-1': {
          instanceId: 'inst-secret-1', rps: 10, errorRate: 0, p50Ms: 5, p99Ms: 9,
          activeConnections: 2, cpuCoresUsed: 0.3, ramMb: 128, health: 'healthy',
        },
      },
      servers: {
        'srv-secret-1': {
          serverId: 'srv-secret-1', coreUtilization: [0.4], stealFraction: 0, burstCredits: null,
          ramByInstance: [], ramUsedMb: 128, ramTotalMb: 4096, nicInMbps: 1, nicOutMbps: 1,
          diskIoFraction: 0, health: 'healthy',
        },
      },
      azs: {},
      regions: {
        [region.id]: {
          regionId: region.id, rps: 42, errorRate: 0.02, p50Ms: 18, healthScore: 91,
          health: 'healthy', inboundByPopulation: [],
        },
      },
      world: {
        totalRps: 42, errorRate: 0.02, populationRoutes: [],
        crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0,
      },
    }

    const context = buildReviewContext(doc, compiled, [], batch)
    const parsed = JSON.parse(context) as {
      metrics: { world: { totalRps: number; errorRate: number }; regions: unknown[]; azs: unknown[] }
    }
    expect(parsed.metrics.world).toEqual({ totalRps: 42, errorRate: 0.02 })
    expect(parsed.metrics.regions).toEqual([
      { id: region.id, rps: 42, errorRate: 0.02, p50Ms: 18, health: 'healthy' },
    ])
    expect(context).not.toContain('inst-secret-1')
    expect(context).not.toContain('srv-secret-1')
  })
})

describe('requestReview', () => {
  it('happy path parses fenced json', async () => {
    const chat = vi.fn().mockResolvedValue(envelope(issuesJson([
      { title: 'ok', severity: 'critical', confidence: 0.9, affected: ['x'], reasoning: 'r', recommendation: 'y', estimated_effort: 'high' },
    ])))
    const issues = await requestReview(SETTINGS, 'ctx', chat)
    expect(issues).toEqual([
      { title: 'ok', severity: 'critical', confidence: 0.9, affected: ['x'], reasoning: 'r', recommendation: 'y', estimated_effort: 'high' },
    ])
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('malformed then valid succeeds via one retry with corrective message appended', async () => {
    const chat = vi.fn()
      .mockResolvedValueOnce(envelope('not json at all'))
      .mockResolvedValueOnce(envelope(issuesJson([
        { title: 'ok', severity: 'info', confidence: 0.5, affected: [], reasoning: 'r', recommendation: 'x', estimated_effort: 'low' },
      ])))

    const issues = await requestReview(SETTINGS, 'ctx', chat)
    expect(issues).toHaveLength(1)
    expect(issues[0].title).toBe('ok')
    expect(chat).toHaveBeenCalledTimes(2)

    const secondBody = JSON.parse(chat.mock.calls[1][2] as string) as { messages: { role: string; content: string }[] }
    expect(secondBody.messages.some(m => m.role === 'system' && /previous reply/i.test(m.content))).toBe(true)
  })

  it('two malformed responses throw gracefully', async () => {
    const chat = vi.fn().mockResolvedValue(envelope('still not json'))
    await expect(requestReview(SETTINGS, 'ctx', chat)).rejects.toThrow('malformed review response')
    expect(chat).toHaveBeenCalledTimes(2)
  })

  it('error envelope surfaces provider message', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ error: { message: 'rate limited, retry later' } }))
    await expect(requestReview(SETTINGS, 'ctx', chat)).rejects.toThrow('rate limited, retry later')
    expect(chat).toHaveBeenCalledTimes(1) // a provider error envelope isn't a "malformed content" case — no retry
  })

  it('severity/confidence/effort clamping', () => {
    const raw = issuesJson([
      { title: 'a', severity: 'BOGUS' as AiIssue['severity'], confidence: 5, affected: ['ok', 42 as unknown as string, null as unknown as string], reasoning: 'r', recommendation: 'x', estimated_effort: 'urgent' as AiIssue['estimated_effort'] },
      { title: 'b', severity: 'critical', confidence: -3, affected: [], reasoning: 'r2', recommendation: 'x2', estimated_effort: 'low' },
    ])
    const issues = validateReviewResponse(raw)
    expect(issues[0]).toMatchObject({ severity: 'info', confidence: 1, affected: ['ok'], estimated_effort: 'medium' })
    expect(issues[1]).toMatchObject({ severity: 'critical', confidence: 0, estimated_effort: 'low' })
  })
})

describe('pingLlm', () => {
  it('sends max_tokens 1', async () => {
    const chat = vi.fn().mockResolvedValue(envelope('pong'))
    await pingLlm(SETTINGS, chat)
    expect(chat).toHaveBeenCalledTimes(1)
    const body = JSON.parse(chat.mock.calls[0][2] as string) as { max_tokens: number; messages: { role: string; content: string }[] }
    expect(body.max_tokens).toBe(1)
    expect(body.messages).toEqual([{ role: 'user', content: 'ping' }])
  })

  it('rejects an error envelope (e.g. bad api key) instead of reporting ok', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ error: { message: 'Incorrect API key provided' } }))
    await expect(pingLlm(SETTINGS, chat)).rejects.toThrow('Incorrect API key provided')
  })

  it('rejects a non-JSON response', async () => {
    const chat = vi.fn().mockResolvedValue('<html>502 Bad Gateway</html>')
    await expect(pingLlm(SETTINGS, chat)).rejects.toThrow('non-JSON response')
  })

  it('rejects a JSON response that is not a completion envelope', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ status: 'ok' }))
    await expect(pingLlm(SETTINGS, chat)).rejects.toThrow('without a completion')
  })
})
