import { describe, it, expect, vi } from 'vitest'
import { chatComplete } from './llmClient'
import type { LlmSettings } from './tauri'

const settings: LlmSettings = { baseUrl: 'http://x', apiKey: 'k', model: 'm' }

describe('chatComplete', () => {
  it('omits jsonMode/maxTokens/temperature from the body when not provided', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }))
    await chatComplete(settings, [{ role: 'user', content: 'q' }], undefined, chat)
    const body = JSON.parse(chat.mock.calls[0][2] as string)
    expect(body).toEqual({ model: 'm', messages: [{ role: 'user', content: 'q' }] })
  })

  it('includes response_format only when jsonMode is true', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ choices: [{ message: { content: '{}' } }] }))
    await chatComplete(settings, [{ role: 'user', content: 'q' }], { jsonMode: true }, chat)
    const body = JSON.parse(chat.mock.calls[0][2] as string)
    expect(body.response_format).toEqual({ type: 'json_object' })
  })

  it('includes max_tokens and temperature when provided', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }))
    await chatComplete(settings, [], { maxTokens: 500, temperature: 0.2 }, chat)
    const body = JSON.parse(chat.mock.calls[0][2] as string)
    expect(body.max_tokens).toBe(500)
    expect(body.temperature).toBe(0.2)
  })

  it('throws on non-JSON response', async () => {
    const chat = vi.fn().mockResolvedValue('not json')
    await expect(chatComplete(settings, [], undefined, chat)).rejects.toThrow(/non-JSON response/)
  })

  it('throws the provider error message from an error envelope', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ error: { message: 'rate limited' } }))
    await expect(chatComplete(settings, [], undefined, chat)).rejects.toThrow('rate limited')
  })

  it('throws when choices is missing or empty', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ choices: [] }))
    await expect(chatComplete(settings, [], undefined, chat)).rejects.toThrow(/without a completion/)
  })

  it('throws when message.content is not a string', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ choices: [{ message: { content: 42 } }] }))
    await expect(chatComplete(settings, [], undefined, chat)).rejects.toThrow(/non-text completion/)
  })

  it('returns the extracted content on success', async () => {
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ choices: [{ message: { content: 'answer' } }] }))
    const result = await chatComplete(settings, [], undefined, chat)
    expect(result).toBe('answer')
  })
})
