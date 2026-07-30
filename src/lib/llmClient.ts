import { llmChat } from './tauri'
import type { LlmSettings } from './llmReview'

export type ChatRole = 'system' | 'user' | 'assistant'
export interface ChatMessage { role: ChatRole; content: string }
export interface ChatOptions { jsonMode?: boolean; maxTokens?: number; temperature?: number }

interface ChatResponseEnvelope {
  error?: { message?: string }
  choices?: { message: { content: unknown } }[]
}

export async function chatComplete(
  settings: LlmSettings,
  messages: ChatMessage[],
  options?: ChatOptions,
  chat: typeof llmChat = llmChat,
): Promise<string> {
  const body: Record<string, unknown> = { model: settings.model, messages }
  if (options?.jsonMode) body.response_format = { type: 'json_object' }
  if (options?.maxTokens !== undefined) body.max_tokens = options.maxTokens
  if (options?.temperature !== undefined) body.temperature = options.temperature

  const raw = await chat(settings.baseUrl, settings.apiKey, JSON.stringify(body))

  let parsed: ChatResponseEnvelope
  try {
    parsed = JSON.parse(raw) as ChatResponseEnvelope
  } catch {
    throw new Error('endpoint returned a non-JSON response — check the base URL')
  }
  if (parsed.error) throw new Error(parsed.error.message ?? 'LLM error')
  if (!Array.isArray(parsed.choices) || parsed.choices.length === 0) {
    throw new Error('endpoint responded without a completion — check the base URL and model')
  }
  const content = parsed.choices[0].message.content
  if (typeof content !== 'string') {
    throw new Error('endpoint returned a non-text completion — check the base URL and model')
  }
  return content
}
