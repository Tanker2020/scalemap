// src/lib/llmReview.ts
// On-demand LLM architecture review (Phase 6, D7). Pure/mock-invoke-testable — `chat` is
// injectable and defaults to T5's llmChat wrapper. D6: this file must NEVER embed settings.apiKey
// (or any settings value) into buildReviewContext's payload — the canary-scan test above enforces
// this by stringify-scanning the emitted context for the literal property names apiKey/api_key.
import type { WorldDoc, CompiledWorld } from './world/types'
import type { MetricsBatch } from './worldEngine/types'
import type { AnalysisFinding } from './analysis/types'
import { llmChat, type LlmSettings } from './tauri'

export interface AiIssue {
  title: string
  severity: 'critical' | 'warning' | 'info'
  confidence: number
  affected: string[]
  reasoning: string
  recommendation: string
  estimated_effort: 'low' | 'medium' | 'high'
}

export function buildReviewContext(
  doc: WorldDoc,
  compiled: CompiledWorld,
  findings: AnalysisFinding[],
  lastBatch: MetricsBatch | null,
): string {
  const metrics = lastBatch
    ? {
        world: { totalRps: lastBatch.world.totalRps, errorRate: lastBatch.world.errorRate },
        regions: Object.values(lastBatch.regions).map(r => ({
          id: r.regionId, rps: r.rps, errorRate: r.errorRate, p50Ms: r.p50Ms, health: r.health,
        })),
        azs: Object.values(lastBatch.azs).map(a => ({
          id: a.azId, rps: a.rps, errorRate: a.errorRate, p50Ms: a.p50Ms, health: a.health,
        })),
      }
    : null

  const payload = {
    world: doc,
    deterministicFindings: findings.map(f => ({ ruleId: f.ruleId, severity: f.severity, title: f.title, affected: f.affected })),
    compileFindings: compiled.findings.map(f => ({ kind: f.kind, severity: f.severity, message: f.message })),
    metrics,
  }
  return JSON.stringify(payload)
}

const SEVERITIES = ['critical', 'warning', 'info'] as const
const EFFORTS = ['low', 'medium', 'high'] as const

function stripJsonFence(raw: string): string {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  return fenced ? fenced[1] : trimmed
}

function clampIssue(raw: unknown): AiIssue {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const severity = (SEVERITIES as readonly string[]).includes(r.severity as string)
    ? (r.severity as AiIssue['severity'])
    : 'info'
  const confNum = Number(r.confidence)
  const confidence = Number.isFinite(confNum) ? Math.max(0, Math.min(1, confNum)) : 0
  const affected = Array.isArray(r.affected) ? r.affected.filter((x): x is string => typeof x === 'string') : []
  const estimated_effort = (EFFORTS as readonly string[]).includes(r.estimated_effort as string)
    ? (r.estimated_effort as AiIssue['estimated_effort'])
    : 'medium'
  return {
    title: typeof r.title === 'string' ? r.title : '',
    severity,
    confidence,
    affected,
    reasoning: typeof r.reasoning === 'string' ? r.reasoning : '',
    recommendation: typeof r.recommendation === 'string' ? r.recommendation : '',
    estimated_effort,
  }
}

export function validateReviewResponse(raw: string): AiIssue[] {
  const stripped = stripJsonFence(raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    throw new Error('malformed review response')
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { issues?: unknown }).issues)) {
    throw new Error('malformed review response')
  }
  return (parsed as { issues: unknown[] }).issues.map(clampIssue)
}

const SCHEMA_HINT = `Respond ONLY with a single JSON object — no prose, no markdown fence — matching
this schema: { "issues": [ { "title": string, "severity": "critical"|"warning"|"info",
"confidence": number (0-1), "affected": string[] (entity ids), "reasoning": string,
"recommendation": string, "estimated_effort": "low"|"medium"|"high" } ] }`

const SYSTEM_PROMPT = `You are a senior infrastructure architect reviewing a compiled system
topology. You are given a list of deterministic findings already detected by static analysis —
do not repeat them verbatim; focus on issues those rules cannot see (cross-cutting risk, blast
radius, sequencing, cost/perf tradeoffs). ${SCHEMA_HINT}`

const CORRECTIVE_NOTE = `Your previous reply was not valid JSON matching the schema. ${SCHEMA_HINT}`

interface ChatMessage { role: string; content: string }

async function callAndExtractContent(
  settings: LlmSettings,
  messages: ChatMessage[],
  chat: typeof llmChat,
): Promise<string> {
  const body = { model: settings.model, response_format: { type: 'json_object' }, messages }
  const raw = await chat(settings.baseUrl, settings.apiKey, JSON.stringify(body))
  const parsed = JSON.parse(raw) as { error?: { message?: string }; choices?: { message: { content: string } }[] }
  if (parsed.error) throw new Error(parsed.error.message ?? 'LLM error')
  return parsed.choices![0].message.content
}

export async function requestReview(
  settings: LlmSettings,
  context: string,
  chat: typeof llmChat = llmChat,
): Promise<AiIssue[]> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: context },
  ]
  const content = await callAndExtractContent(settings, messages, chat)
  try {
    return validateReviewResponse(content)
  } catch {
    const retryMessages: ChatMessage[] = [...messages, { role: 'system', content: CORRECTIVE_NOTE }]
    const retryContent = await callAndExtractContent(settings, retryMessages, chat)
    return validateReviewResponse(retryContent) // rethrows on a second failure — no further retry
  }
}

export async function pingLlm(settings: LlmSettings, chat: typeof llmChat = llmChat): Promise<void> {
  const body = { model: settings.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }
  await chat(settings.baseUrl, settings.apiKey, JSON.stringify(body))
}
