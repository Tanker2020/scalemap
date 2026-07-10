// src/lib/tauri.test.ts
// @vitest-environment jsdom
// The mock transport (isTauri === false in jsdom, no window.__TAURI_INTERNALS__) round-trips
// through localStorage — this proves the wrapper's snake<->camel mapping (Step 7) matches the
// mock's snake-case storage shape (Step 8) end to end, and that the stored JSON never grows a
// forbidden extra key (D6 sanity: the shape is exactly {base_url,api_key,model}, nothing else).
import { describe, it, expect, beforeEach } from 'vitest'
import { saveLlmSettings, loadLlmSettings } from './tauri'

describe('llm settings wrapper (mock transport)', () => {
  beforeEach(() => localStorage.clear())

  it('round-trips camelCase in/out through the snake_case-stored mock', async () => {
    await saveLlmSettings({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test-abc', model: 'gpt-4o-mini' })

    const raw = localStorage.getItem('scalemap:llm_settings')
    expect(raw).toBeTruthy()
    const stored = JSON.parse(raw!)
    expect(Object.keys(stored).sort()).toEqual(['api_key', 'base_url', 'model'])
    expect(stored.base_url).toBe('https://api.openai.com/v1')
    expect(stored.api_key).toBe('sk-test-abc')

    const loaded = await loadLlmSettings()
    expect(loaded).toEqual({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test-abc', model: 'gpt-4o-mini' })
  })

  it('load returns empty-string defaults when nothing is stored', async () => {
    const loaded = await loadLlmSettings()
    expect(loaded).toEqual({ baseUrl: '', apiKey: '', model: '' })
  })
})
