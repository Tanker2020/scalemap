// src/app/world/SettingsModal.tsx
// Global Settings surface (spec D8): the app's theme toggle and BYO LLM endpoint config live
// here — the ONLY sanctioned home for either concern. Appearance flips a fully-wired-but-so-far
// UI-less theme system (see this task's grounding — the toggle only calls setThemeMode, nothing
// else to plumb). AI Review persists { baseUrl, apiKey, model } through T5's Rust-backed
// commands, OUTSIDE world.store/serializer per D6 — this modal must never import either.
import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { useUiStore } from '../store/ui.store'
import { loadLlmSettings, saveLlmSettings, type LlmSettings } from '../../lib/tauri'
import { pingLlm } from '../../lib/llmReview'
import { SectionHeader, Segmented } from './ui/kit'

export interface SettingsModalProps {
  open: boolean
  onClose: () => void
}

const backdropStyle: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
}
const surfaceStyle: CSSProperties = {
  width: 420, maxWidth: '92vw', background: 'var(--color-surface)',
  border: '1px solid var(--color-node-border)', borderRadius: 8, padding: 16,
  font: '11px var(--font-mono)', color: 'var(--color-text-primary)',
}
const fieldLabelStyle: CSSProperties = { display: 'block', marginBottom: 2, color: 'var(--color-text-secondary)' }
const fieldInputStyle: CSSProperties = {
  width: '100%', boxSizing: 'border-box', background: 'var(--color-node-base)',
  border: '1px solid var(--color-node-border)', borderRadius: 4, padding: '4px 6px',
  fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--color-text-primary)', marginBottom: 6,
}
const smallBtnStyle: CSSProperties = {
  background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
  borderRadius: 4, padding: '4px 10px', cursor: 'pointer',
  font: '11px var(--font-mono)', color: 'var(--color-text-secondary)',
}

function maskedPlaceholder(apiKey: string): string {
  if (!apiKey) return ''
  return `•••• ${apiKey.slice(-4)}`
}

export function SettingsModal({ open, onClose }: SettingsModalProps): ReactElement | null {
  const themeMode = useUiStore(s => s.themeMode)
  const setThemeMode = useUiStore(s => s.setThemeMode)

  // savedKey is kept ONLY to derive the masked placeholder below — it is NEVER rendered into an
  // input's `value` (D6: the stored key must never be echoed back into an editable field).
  const [savedKey, setSavedKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKeyInput, setApiKeyInput] = useState('') // stays '' until the user types a NEW key
  const [model, setModel] = useState('')
  const [testStatus, setTestStatus] = useState<'idle' | 'pending' | 'ok' | 'error'>('idle')
  const [testError, setTestError] = useState('')

  useEffect(() => {
    if (!open) return
    let cancelled = false
    loadLlmSettings().then(s => {
      if (cancelled) return
      setSavedKey(s.apiKey)
      setBaseUrl(s.baseUrl)
      setModel(s.model)
      setApiKeyInput('')
      setTestStatus('idle')
      setTestError('')
    })
    return () => { cancelled = true }
  }, [open])

  // Capture-phase Esc: fires BEFORE WorldShell's bubble-phase Escape-goes-up handler (same
  // mechanism ServerView.tsx already uses — capture always precedes bubble for a `window`
  // listener regardless of mount order). stopPropagation halts the event's entire remaining
  // traversal, including its own return trip through window's bubble phase, so WorldShell's
  // handler never runs for this keydown at all; preventDefault is belt-and-suspenders in case
  // that return trip somehow still occurs (WorldShell's handler also bails on defaultPrevented).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true) // CAPTURE
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open) return null

  const save = () => {
    const settings: LlmSettings = { baseUrl, apiKey: apiKeyInput || savedKey, model }
    saveLlmSettings(settings).then(() => {
      setSavedKey(settings.apiKey)
      setApiKeyInput('')
    })
  }

  const testConnection = () => {
    setTestStatus('pending')
    setTestError('')
    pingLlm({ baseUrl, apiKey: apiKeyInput || savedKey, model })
      .then(() => setTestStatus('ok'))
      .catch(e => {
        setTestStatus('error')
        setTestError(e instanceof Error ? e.message : 'connection failed')
      })
  }

  return createPortal(
    <div style={backdropStyle} onClick={onClose}>
      <div style={surfaceStyle} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ font: '600 12px var(--font-mono)' }}>Settings</span>
          <button style={smallBtnStyle} onClick={onClose}>close</button>
        </div>

        <SectionHeader label="▸ APPEARANCE" />
        <Segmented
          ariaLabel="theme"
          value={themeMode}
          onChange={setThemeMode}
          options={[{ value: 'dark', label: 'dark' }, { value: 'light', label: 'light' }]}
        />

        <SectionHeader label="▸ AI REVIEW" />
        <label style={fieldLabelStyle}>base URL</label>
        <input style={fieldInputStyle} aria-label="baseUrl" placeholder="https://api.openai.com/v1"
          value={baseUrl} onChange={e => setBaseUrl(e.target.value)} />

        <label style={fieldLabelStyle}>API key</label>
        <input style={fieldInputStyle} aria-label="apiKey" type="password"
          placeholder={maskedPlaceholder(savedKey) || 'sk-...'}
          value={apiKeyInput} onChange={e => setApiKeyInput(e.target.value)} />

        <label style={fieldLabelStyle}>model</label>
        <input style={fieldInputStyle} aria-label="model" placeholder="gpt-4o-mini"
          value={model} onChange={e => setModel(e.target.value)} />

        <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }}>
          <button style={smallBtnStyle} onClick={save}>Save</button>
          <button style={smallBtnStyle} onClick={testConnection} disabled={testStatus === 'pending'}>
            {testStatus === 'pending' ? 'testing…' : 'Test connection'}
          </button>
          {testStatus === 'ok' && <span style={{ color: 'var(--color-success)' }}>ok</span>}
          {testStatus === 'error' && <span style={{ color: 'var(--color-danger)' }}>{testError}</span>}
        </div>
      </div>
    </div>,
    document.body,
  )
}
