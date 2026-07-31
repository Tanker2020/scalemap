import { describe, it, expect, vi } from 'vitest'
import { requestAssistantTurn, HISTORY_TURN_CAP } from './index'
import type { AssistantTurnRequest } from './index'
import type { LlmSettings } from '../tauri'

const settings: LlmSettings = { baseUrl: 'http://x', apiKey: 'k', model: 'm' }

function baseReq(overrides?: Partial<AssistantTurnRequest>): AssistantTurnRequest {
  return {
    question: 'why did errors spike?',
    attachments: [],
    history: [],
    contextInput: {
      doc: { routing: {}, regions: {}, azs: {}, servers: {}, blueprints: {}, placements: {}, managedServices: {}, populations: {} } as never,
      compiled: { instances: {}, paths: [], findings: [], routing: {} } as never,
      findings: [], compileFindings: [], latestBatch: null, events: [], replayFrames: [],
    },
    ...overrides,
  }
}

describe('requestAssistantTurn', () => {
  it('sends system prompt, context, history, then the question in that order', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ choices: [{ message: { content: 'answer' } }] }))
    const req = baseReq({ history: [{ role: 'user', content: 'earlier q' }, { role: 'assistant', content: 'earlier a' }] })
    await requestAssistantTurn(settings, req, chat)
    const body = JSON.parse(chat.mock.calls[0][2] as string)
    expect(body.messages[0].role).toBe('system')
    expect(body.messages[1].role).toBe('system')
    expect(body.messages[1].content.length).toBeGreaterThan(0)
    expect(body.messages[2]).toEqual({ role: 'user', content: 'earlier q' })
    expect(body.messages[3]).toEqual({ role: 'assistant', content: 'earlier a' })
    expect(body.messages[body.messages.length - 1]).toEqual({ role: 'user', content: 'why did errors spike?' })
  })

  it('does not set response_format (jsonMode unset)', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ choices: [{ message: { content: 'answer' } }] }))
    await requestAssistantTurn(settings, baseReq(), chat)
    const body = JSON.parse(chat.mock.calls[0][2] as string)
    expect(body.response_format).toBeUndefined()
  })

  it('caps history to the last HISTORY_TURN_CAP*2 messages', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ choices: [{ message: { content: 'answer' } }] }))
    const longHistory = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` }) as const)
    await requestAssistantTurn(settings, baseReq({ history: longHistory }), chat)
    const body = JSON.parse(chat.mock.calls[0][2] as string)
    const historyMessages = body.messages.slice(2, -1)
    expect(historyMessages.length).toBeLessThanOrEqual(HISTORY_TURN_CAP * 2)
  })

  it('returns the raw answer string', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ choices: [{ message: { content: 'the answer' } }] }))
    const result = await requestAssistantTurn(settings, baseReq(), chat)
    expect(result).toBe('the answer')
  })
})
