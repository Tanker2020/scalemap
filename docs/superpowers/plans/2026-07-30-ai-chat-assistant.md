# AI Chat Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only, multi-turn AI advisor overlay that answers design and diagnosis
questions grounded in the live `WorldDoc`/`CompiledWorld`/simulation state, with every named
entity rendered as a clickable navigation chip.

**Architecture:** A stack of new pure `src/lib/` modules (LLM client, dependency index, event
causality, context digest, prompt, response formatting, citations) feeds a new `chat.store.ts`
(Zustand, synchronous actions only) driven by an async `sendChatTurn.ts` orchestrator, rendered by
a new full-screen portal overlay under `src/app/world/ai/` mounted from `WorldShell.tsx` beside
the existing `ConnectionsView` precedent. No Rust changes. No `WorldDoc` mutation anywhere in the
feature.

**Tech Stack:** TypeScript, React 19, Zustand (no middleware), Vitest (+jsdom for components),
existing `llm_chat` Tauri command via `tauriMock.ts` in browser dev.

## Global Constraints

- Read-only: nothing in this feature may call any `world.store.ts` mutation action. No apply
  buttons, no tool-calling.
- Persistence: `chat.store.ts` state lives in memory only — never serialized into `.scalemap`,
  never written to disk. Dies on app restart, survives navigation.
- `worldEngine/types.ts` (`EngineEvent`, `EngineEventKind`, `MetricsBatch`, `ReplayFrame`,
  `WorldEngineApi`) is a frozen contract — this feature only reads it, never changes it.
- No new markdown/highlighter dependency — `package.json` currently has none
  (`@fontsource/jetbrains-mono`, `@react-three/drei`, `@react-three/fiber`, `@tauri-apps/api`,
  `@tauri-apps/plugin-opener`, `framer-motion`, `lucide-react`, `react`, `react-dom`, `three`,
  `zustand`). Markdown rendering in this plan is hand-rolled (Task 8).
- No `dangerouslySetInnerHTML` anywhere in `src/app/world/ai/**` — model output must never be
  parsed as HTML.
- Theme: any new color must be `var(--color-*)` from `src/lib/theme.ts` — never a hardcoded hex.
- Corrected paths (verified against current code, differ from earlier drafts of this spec):
  - `src/app/world/panels/AnalysisTab.tsx` (not `src/app/world/AnalysisTab.tsx`)
  - `src/app/world/connections/ConnectionsView.tsx` (not `src/app/world/ConnectionsView.tsx`)
  - The ESM-cycle comment lives in `AiReviewSection.tsx:2-6`, not in `AnalysisTab.tsx`.
  - `failover.ts` does NOT emit `burst_credits_exhausted` or `health_check_failed` — both come
    only from `index.ts` (lines ~799, ~525).
  - `network.ts` has 5 rule objects (one, `dbPortExposed`, emits two different title strings).
  - Rule count is genuinely 15 (6 structural + 5 network + 4 capacity) — `CLAUDE.md:53` and
    `docs/module-boundaries.md:591` both still say "13 rules"; Task 12 fixes both.
  - `docs/module-boundaries.md`'s section letters run A→Y with no gaps; the next free letter is
    **Z**.

---

## Task 1: Extract a reusable LLM client + rewire `llmReview.ts`

**Files:**
- Create: `src/lib/llmClient.ts`
- Create: `src/lib/llmClient.test.ts`
- Modify: `src/lib/llmReview.ts` (delete `ChatMessage` interface at line 105, delete
  `callAndExtractContent` at lines 107-117, rewire `requestReview`/`pingLlm` to call
  `chatComplete`)

**Interfaces:**
- Consumes: `llmChat` from `src/lib/tauri.ts` (existing), `LlmSettings` from
  `src/lib/llmReview.ts` (existing type: `{ baseUrl: string; apiKey: string; model: string }`).
- Produces (used by Tasks 6/7 and by the rewired `llmReview.ts`):
  ```ts
  export type ChatRole = 'system' | 'user' | 'assistant'
  export interface ChatMessage { role: ChatRole; content: string }
  export interface ChatOptions { jsonMode?: boolean; maxTokens?: number; temperature?: number }
  export async function chatComplete(
    settings: LlmSettings,
    messages: ChatMessage[],
    options?: ChatOptions,
    chat: typeof llmChat = llmChat,
  ): Promise<string>
  ```

Current `llmReview.ts` internals being replaced (verified exact code):
```ts
// lines 105-117, to be deleted:
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
```
`pingLlm`'s existing 3-step ladder (lines 138-153, to be reused verbatim inside `chatComplete`):
non-JSON parse failure → `"endpoint returned a non-JSON response — check the base URL"`;
provider `error` envelope → the provider's message; empty/missing `choices` →
`"endpoint responded without a completion — check the base URL and model"`. Add a 4th rung for
this task: `choices[0].message.content` not a string → throw
`"endpoint returned a non-text completion — check the base URL and model"`.

`requestReview`'s existing call-shape MUST be preserved exactly: the *first* `chatComplete` call
sits **outside** the `try`, so a provider error envelope on that first call rejects with no retry
(this is what `llmReview.test.ts:111-115` — `expect(chat).toHaveBeenCalledTimes(1)` — asserts).
Only a validation failure of already-successfully-parsed content triggers the one retry.

- [ ] **Step 1: Write the failing tests for `chatComplete`**

```ts
// src/lib/llmClient.test.ts
import { describe, it, expect, vi } from 'vitest'
import { chatComplete } from './llmClient'
import type { LlmSettings } from './llmReview'

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/llmClient.test.ts`
Expected: FAIL — `src/lib/llmClient.ts` does not exist yet.

- [ ] **Step 3: Implement `llmClient.ts`**

```ts
// src/lib/llmClient.ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/llmClient.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Rewire `llmReview.ts` onto `chatComplete`, preserving exact call shape**

Replace the deleted `ChatMessage`/`callAndExtractContent` block with:
```ts
import { chatComplete, type ChatMessage } from './llmClient'
```
Rewrite `requestReview` (previously lines 119-136) to:
```ts
export async function requestReview(
  settings: LlmSettings,
  context: string,
  chat: typeof llmChat = llmChat,
): Promise<AiIssue[]> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: context },
  ]
  const content = await chatComplete(settings, messages, { jsonMode: true }, chat)
  try {
    return validateReviewResponse(content)
  } catch {
    const retryMessages: ChatMessage[] = [...messages, { role: 'system', content: CORRECTIVE_NOTE }]
    const retryContent = await chatComplete(settings, retryMessages, { jsonMode: true }, chat)
    return validateReviewResponse(retryContent)
  }
}
```
Rewrite `pingLlm` (previously lines 138-153) to:
```ts
export async function pingLlm(settings: LlmSettings, chat: typeof llmChat = llmChat): Promise<void> {
  await chatComplete(settings, [{ role: 'user', content: 'ping' }], { maxTokens: 1 }, chat)
}
```
This keeps `llmReview.test.ts:128-136`'s assertion (`max_tokens === 1`, `messages` exactly
`[{ role: 'user', content: 'ping' }]`) true, since `chatComplete` omits every other key when not
passed.

- [ ] **Step 6: Run the full existing suite for this file to confirm zero regressions**

Run: `npx vitest run src/lib/llmReview.test.ts`
Expected: PASS, unmodified — this is the regression check for the whole step (per the spec's own
requirement that this file's tests must pass without edits).

- [ ] **Step 7: Run the whole project test suite once**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/lib/llmClient.ts src/lib/llmClient.test.ts src/lib/llmReview.ts
git commit -m "refactor: extract reusable chatComplete client from llmReview"
```

---

## Task 2: Reverse-dependency index — `src/lib/world/dependents.ts`

**Files:**
- Create: `src/lib/world/dependents.ts`
- Create: `src/lib/world/dependents.test.ts`

**Interfaces:**
- Consumes: `WorldDoc` (`blueprints[id].dependencies: BlueprintDependency[]`,
  `placements`, `managedServices`) and `CompiledWorld` (`instances: Record<InstanceId,
  ServiceInstance>`, `paths: CompiledPath[]` where `CompiledPath.to` is
  `{ kind: 'instance'; instanceId } | { kind: 'managed'; managedServiceId }` — both from
  `src/lib/world/types.ts`).
- Produces (used by Task 5's `buildChatDigest`):
  ```ts
  export interface DependencyIndex {
    dependentsOfBlueprint: Map<string, string[]>
    dependenciesOfBlueprint: Map<string, string[]>
    dependentInstances: Map<string, string[]>
    dependencyTargets: Map<string, string[]>
  }
  export function dependencyIndexFor(doc: WorldDoc, compiled: CompiledWorld): DependencyIndex
  export function blastRadius(
    rootId: string, doc: WorldDoc, compiled: CompiledWorld, opts?: { maxDepth?: number },
  ): { direct: string[]; transitive: string[]; depthOf: Record<string, number> }
  ```

Memoize with the exact `pathIndexFor` idiom from `src/lib/worldEngine/flows.ts:321-344`
(`WeakMap<CompiledWorld, DependencyIndex>` — weak-keyed on the compiled object identity so a
recompile invalidates the memo automatically).

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/world/dependents.test.ts
import { describe, it, expect } from 'vitest'
import { dependencyIndexFor, blastRadius } from './dependents'
import type { WorldDoc, CompiledWorld } from './types'

function makeFixture(): { doc: WorldDoc; compiled: CompiledWorld } {
  // web (bp-web) -> api (bp-api) -> db (managed-db)
  const doc = {
    blueprints: {
      'bp-web': { id: 'bp-web', name: 'web', dependencies: [
        { id: 'dep-1', target: { kind: 'blueprint', blueprintId: 'bp-api' }, port: 80, protocol: 'http', packetTemplateId: null },
      ] },
      'bp-api': { id: 'bp-api', name: 'api', dependencies: [
        { id: 'dep-2', target: { kind: 'managed', managedServiceId: 'managed-db' }, port: 5432, protocol: 'db', packetTemplateId: null },
      ] },
    },
    placements: {}, managedServices: { 'managed-db': { id: 'managed-db', label: 'db' } },
  } as unknown as WorldDoc
  const compiled = {
    instances: {
      'web-1': { id: 'web-1', blueprintId: 'bp-web', serverId: 's1', azId: 'az1', regionId: 'r1' },
      'api-1': { id: 'api-1', blueprintId: 'bp-api', serverId: 's2', azId: 'az1', regionId: 'r1' },
    },
    paths: [
      { id: 'p1', dependencyId: 'dep-1', fromInstanceId: 'web-1', to: { kind: 'instance', instanceId: 'api-1' }, verdict: 'permitted' },
      { id: 'p2', dependencyId: 'dep-2', fromInstanceId: 'api-1', to: { kind: 'managed', managedServiceId: 'managed-db' }, verdict: 'permitted' },
    ],
    findings: [], routing: {},
  } as unknown as CompiledWorld
  return { doc, compiled }
}

describe('dependencyIndexFor', () => {
  it('builds forward and reverse blueprint-level maps', () => {
    const { doc, compiled } = makeFixture()
    const idx = dependencyIndexFor(doc, compiled)
    expect(idx.dependentsOfBlueprint.get('bp-api')).toEqual(['bp-web'])
    expect(idx.dependenciesOfBlueprint.get('bp-web')).toEqual(['bp-api'])
  })

  it('builds instance-level maps from compiled.paths', () => {
    const { doc, compiled } = makeFixture()
    const idx = dependencyIndexFor(doc, compiled)
    expect(idx.dependentInstances.get('api-1')).toEqual(['web-1'])
    expect(idx.dependencyTargets.get('web-1')).toEqual(['api-1'])
  })

  it('memoizes by CompiledWorld identity', () => {
    const { doc, compiled } = makeFixture()
    expect(dependencyIndexFor(doc, compiled)).toBe(dependencyIndexFor(doc, compiled))
  })

  it('rebuilds when the compiled object identity changes', () => {
    const { doc, compiled } = makeFixture()
    const first = dependencyIndexFor(doc, compiled)
    const second = dependencyIndexFor(doc, { ...compiled })
    expect(first).not.toBe(second)
  })
})

describe('blastRadius', () => {
  it('expands a serverId to its hosted instance and returns transitive dependents', () => {
    const { doc, compiled } = makeFixture()
    const result = blastRadius('s2', doc, compiled) // server hosting api-1
    expect(result.direct).toContain('web-1')
  })

  it('is cycle-safe', () => {
    const { doc, compiled } = makeFixture()
    // introduce a cycle api-1 -> web-1
    compiled.paths.push({
      id: 'p3', dependencyId: 'dep-3', fromInstanceId: 'api-1',
      to: { kind: 'instance', instanceId: 'web-1' }, verdict: 'permitted',
    } as never)
    expect(() => blastRadius('web-1', doc, compiled)).not.toThrow()
    const result = blastRadius('web-1', doc, compiled)
    expect(result.transitive.filter(id => id === 'web-1').length).toBeLessThanOrEqual(1)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/world/dependents.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `dependents.ts`**

```ts
// src/lib/world/dependents.ts
import type { WorldDoc, CompiledWorld } from './types'

export interface DependencyIndex {
  dependentsOfBlueprint: Map<string, string[]>
  dependenciesOfBlueprint: Map<string, string[]>
  dependentInstances: Map<string, string[]>
  dependencyTargets: Map<string, string[]>
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key)
  if (list) { if (!list.includes(value)) list.push(value) }
  else map.set(key, [value])
}

function buildIndex(doc: WorldDoc, compiled: CompiledWorld): DependencyIndex {
  const dependentsOfBlueprint = new Map<string, string[]>()
  const dependenciesOfBlueprint = new Map<string, string[]>()
  for (const bp of Object.values(doc.blueprints)) {
    for (const dep of bp.dependencies) {
      const targetId = dep.target.kind === 'blueprint' ? dep.target.blueprintId : dep.target.managedServiceId
      push(dependenciesOfBlueprint, bp.id, targetId)
      push(dependentsOfBlueprint, targetId, bp.id)
    }
  }

  const dependentInstances = new Map<string, string[]>()
  const dependencyTargets = new Map<string, string[]>()
  for (const path of compiled.paths) {
    const targetId = path.to.kind === 'instance' ? path.to.instanceId : path.to.managedServiceId
    push(dependencyTargets, path.fromInstanceId, targetId)
    push(dependentInstances, targetId, path.fromInstanceId)
  }

  return { dependentsOfBlueprint, dependenciesOfBlueprint, dependentInstances, dependencyTargets }
}

const cache = new WeakMap<CompiledWorld, DependencyIndex>()

export function dependencyIndexFor(doc: WorldDoc, compiled: CompiledWorld): DependencyIndex {
  const cached = cache.get(compiled)
  if (cached) return cached
  const index = buildIndex(doc, compiled)
  cache.set(compiled, index)
  return index
}

function instancesHostedBy(rootId: string, doc: WorldDoc, compiled: CompiledWorld): string[] {
  if (compiled.instances[rootId]) return [rootId]
  const server = doc.servers[rootId]
  if (server) {
    return Object.values(compiled.instances).filter(i => i.serverId === rootId).map(i => i.id)
  }
  const az = doc.azs[rootId]
  if (az) return Object.values(compiled.instances).filter(i => i.azId === rootId).map(i => i.id)
  const region = doc.regions[rootId]
  if (region) return Object.values(compiled.instances).filter(i => i.regionId === rootId).map(i => i.id)
  return []
}

export function blastRadius(
  rootId: string, doc: WorldDoc, compiled: CompiledWorld, opts?: { maxDepth?: number },
): { direct: string[]; transitive: string[]; depthOf: Record<string, number> } {
  const idx = dependencyIndexFor(doc, compiled)
  const maxDepth = opts?.maxDepth ?? 8
  const roots = instancesHostedBy(rootId, doc, compiled)
  const depthOf: Record<string, number> = {}
  const direct = new Set<string>()
  const transitive: string[] = []
  const visited = new Set<string>(roots)
  let frontier = roots
  let depth = 0
  while (frontier.length > 0 && depth < maxDepth) {
    const next: string[] = []
    for (const id of frontier) {
      for (const dep of idx.dependentInstances.get(id) ?? []) {
        if (visited.has(dep)) continue
        visited.add(dep)
        if (depth === 0) direct.add(dep)
        depthOf[dep] = depth + 1
        transitive.push(dep)
        next.push(dep)
      }
    }
    frontier = next
    depth += 1
  }
  return { direct: [...direct], transitive, depthOf }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/world/dependents.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/world/dependents.ts src/lib/world/dependents.test.ts
git commit -m "feat: add reverse-dependency index and blast-radius query"
```

---

## Task 3: Move pure scope filters — `src/lib/world/scopeFilters.ts`

**Files:**
- Create: `src/lib/world/scopeFilters.ts`
- Modify: `src/app/world/dock/scopeData.ts` (replace the moved function bodies with re-exports)
- Test: `src/app/world/dock/scopeData.test.ts` must pass unmodified.

**Interfaces:**
- Produces (re-exported by `scopeData.ts`, consumed later by Task 5's attachment builder):
  ```ts
  export function scopeEntityIds(scope: DockScope, doc: WorldDoc, compiled: CompiledWorld): Set<string> | null
  export function scopedEvents(scope, doc, compiled, events: EngineEvent[], batch: MetricsBatch | null): EngineEvent[]
  export function scopedFindings(scope, findings: AnalysisFinding[], compileFindings: CompileFinding[], doc, compiled): { analysis: AnalysisFinding[]; compile: CompileFinding[] }
  ```
  (`scopedCost` stays in `scopeData.ts` — it is not needed by `lib/` and isn't in the spec's list.)

`lib/` must not import from `app/` (module-boundary rule) — these three functions currently import
no store, so this is a pure mechanical move, per `docs/module-boundaries.md`'s documented
"mechanical-move" pattern.

- [ ] **Step 1: Read the current file to get exact bodies**

Run: read `src/app/world/dock/scopeData.ts` in full (lines 1-140ish) before editing, since the
exact bodies must move byte-for-byte.

- [ ] **Step 2: Create `scopeFilters.ts` with the moved bodies**

Cut `scopeEntityIds` (lines 32-60), `scopedEvents` (lines 85-94), `scopedFindings` (lines 99-110)
and their shared imports (`DockScope`, `WorldDoc`, `CompiledWorld`, `EngineEvent`, `MetricsBatch`,
`AnalysisFinding`, `CompileFinding` types) verbatim into the new file. Keep `scopedCost` and any
`regionEvents` helper it depends on in `scopeData.ts`.

- [ ] **Step 3: Replace the moved code in `scopeData.ts` with re-exports**

```ts
// src/app/world/dock/scopeData.ts — add near the top, after existing imports:
export { scopeEntityIds, scopedEvents, scopedFindings } from '../../../lib/world/scopeFilters'
```
Delete the now-duplicate function bodies and their now-unused imports from `scopeData.ts`.

- [ ] **Step 4: Run the existing test file unmodified**

Run: `npx vitest run src/app/world/dock/scopeData.test.ts`
Expected: PASS, byte-for-byte unmodified — this is the regression check for the whole step.

- [ ] **Step 5: Run the whole suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/world/scopeFilters.ts src/app/world/dock/scopeData.ts
git commit -m "refactor: move pure scope filters into lib/world for chat context reuse"
```

---

## Task 4: Event causality — `src/lib/aiChat/eventCausality.ts`

**Files:**
- Create: `src/lib/aiChat/eventCausality.ts`
- Create: `src/lib/aiChat/eventCausality.test.ts`

**Interfaces:**
- Consumes: `ReplayFrame[]` (`{ simMs, batch: MetricsBatch, events: EngineEvent[] }` from
  `src/lib/worldEngine/types.ts`), `WorldDoc`, `CompiledWorld`, and Task 2's
  `dependencyIndexFor`/`blastRadius`.
- Produces (consumed by Task 5's `events` attachment):
  ```ts
  export interface CausalEpisode {
    seedEventId: string
    kind: EngineEventKind
    startMs: number
    repeatedForMs: number
    roles: { primaryId: string; secondaryId: string | null }
    before: { errorRate?: number; coreUtilization?: number[] } | null
    after: { errorRate?: number; coreUtilization?: number[] } | null
    consequences: { id: string; depth: number; metric: string }[]
    followOnEvents: { id: string; kind: EngineEventKind; simMs: number }[]
    unexplainedSpikes: string[]
    message: string
  }
  export function decodeAffected(kind: EngineEventKind, affected: string[]): { primaryId: string; secondaryId: string | null }
  export function buildCausalEpisodes(frames: ReplayFrame[], doc: WorldDoc, compiled: CompiledWorld): CausalEpisode[]
  ```

**4a. `decodeAffected` — one exhaustive record**, verified against the actual emission sites in
`src/lib/worldEngine/index.ts` and `failover.ts`:

| kind | shape | verified site |
|---|---|---|
| `oom_kill` | `[victim, host]` | `index.ts:786` |
| `connection_refused` | `[caller, callee]` (`callee` may be `''`) | `index.ts:1023` |
| `breaker_open`/`breaker_half_open`/`breaker_closed` | `[caller, callee]` (`callee` may be `''`) | `index.ts:930` (transition emitted at `:478-483`) |
| `ttl_lag_expired`/`failover_started` | `[populationId, fromRegionId, toRegionId]` | `index.ts:565-566` |
| `replica_promoted` | two arities: instance form `[promoted, failed]`, managed form `[managedServiceId]` only | `failover.ts:370-377` / `:164-171` |
| `primary_failback` | `[...authoredPrimaryIds, promoted]` — promoted is last | `failover.ts:409-416` |
| `health_check_failed` | `[scopeId]` | `index.ts:525` |
| `noisy_neighbor`/`burst_credits_exhausted` | `[serverId]` | `index.ts:798-799` |
| `outage_triggered`/`outage_cleared` | `[scopeId]` | `failover.ts:76-91` |
| `instance_restarted` | `[instanceId]` (mirrors `oom_kill`'s victim slot) | — |
| `failover_completed` | `[populationId, regionId]` | — |
| `engine_degraded` | `[]` | `index.ts:1122` |

- [ ] **Step 1: Write the failing decoder tests**

```ts
// src/lib/aiChat/eventCausality.test.ts (decoder section)
import { describe, it, expect } from 'vitest'
import { decodeAffected } from './eventCausality'

describe('decodeAffected', () => {
  it('decodes oom_kill as victim/host', () => {
    expect(decodeAffected('oom_kill', ['inst-1', 'srv-1'])).toEqual({ primaryId: 'inst-1', secondaryId: 'srv-1' })
  })
  it('decodes connection_refused with a possibly-empty callee', () => {
    expect(decodeAffected('connection_refused', ['inst-1', ''])).toEqual({ primaryId: 'inst-1', secondaryId: null })
  })
  it('decodes replica_promoted instance form', () => {
    expect(decodeAffected('replica_promoted', ['inst-2', 'inst-1'])).toEqual({ primaryId: 'inst-2', secondaryId: 'inst-1' })
  })
  it('decodes replica_promoted managed form (single id)', () => {
    expect(decodeAffected('replica_promoted', ['managed-db'])).toEqual({ primaryId: 'managed-db', secondaryId: null })
  })
  it('decodes primary_failback taking the LAST id as promoted', () => {
    expect(decodeAffected('primary_failback', ['inst-1', 'inst-2', 'inst-3'])).toEqual({ primaryId: 'inst-3', secondaryId: 'inst-1' })
  })
  it('decodes single-scope kinds', () => {
    expect(decodeAffected('health_check_failed', ['srv-1'])).toEqual({ primaryId: 'srv-1', secondaryId: null })
    expect(decodeAffected('noisy_neighbor', ['srv-1'])).toEqual({ primaryId: 'srv-1', secondaryId: null })
  })
  it('decodes engine_degraded with no ids', () => {
    expect(decodeAffected('engine_degraded', [])).toEqual({ primaryId: '', secondaryId: null })
  })
  it('decodes ttl_lag_expired as population/from/to', () => {
    expect(decodeAffected('ttl_lag_expired', ['pop-1', 'r1', 'r2'])).toEqual({ primaryId: 'pop-1', secondaryId: 'r2' })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/aiChat/eventCausality.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the decoder**

```ts
// src/lib/aiChat/eventCausality.ts (part 1)
import type { EngineEvent, EngineEventKind, ReplayFrame } from '../worldEngine/types'
import type { WorldDoc, CompiledWorld } from '../world/types'
import { blastRadius } from '../world/dependents'

export function decodeAffected(
  kind: EngineEventKind, affected: string[],
): { primaryId: string; secondaryId: string | null } {
  switch (kind) {
    case 'oom_kill':
    case 'instance_restarted':
      return { primaryId: affected[0] ?? '', secondaryId: affected[1] || null }
    case 'connection_refused':
    case 'breaker_open':
    case 'breaker_half_open':
    case 'breaker_closed':
      return { primaryId: affected[0] ?? '', secondaryId: affected[1] || null }
    case 'ttl_lag_expired':
    case 'failover_started':
    case 'failover_completed':
      return { primaryId: affected[0] ?? '', secondaryId: affected[2] || affected[1] || null }
    case 'replica_promoted':
      return affected.length >= 2
        ? { primaryId: affected[0], secondaryId: affected[1] }
        : { primaryId: affected[0] ?? '', secondaryId: null }
    case 'primary_failback': {
      const promoted = affected[affected.length - 1] ?? ''
      const firstFailed = affected.length > 1 ? affected[0] : null
      return { primaryId: promoted, secondaryId: firstFailed }
    }
    case 'health_check_failed':
    case 'noisy_neighbor':
    case 'burst_credits_exhausted':
    case 'outage_triggered':
    case 'outage_cleared':
      return { primaryId: affected[0] ?? '', secondaryId: null }
    case 'engine_degraded':
      return { primaryId: '', secondaryId: null }
  }
}
```

- [ ] **Step 4: Run to verify decoder tests pass**

Run: `npx vitest run src/lib/aiChat/eventCausality.test.ts`
Expected: PASS (8 tests)

**4b. Episodes.** Add to the same test file, then implement `buildCausalEpisodes`.

- [ ] **Step 5: Write the failing episode test (the canonical fixture from the spec)**

```ts
// append to src/lib/aiChat/eventCausality.test.ts
import { buildCausalEpisodes } from './eventCausality'

function frame(simMs: number, events: EngineEvent[], instanceErrorRates: Record<string, number>) {
  return {
    simMs,
    batch: {
      simMs,
      instances: Object.fromEntries(Object.entries(instanceErrorRates).map(([id, errorRate]) => [
        id, { instanceId: id, rps: 10, errorRate, p50Ms: 1, p99Ms: 1, activeConnections: 1, cpuCoresUsed: 1, ramMb: 1, health: 'healthy' },
      ])),
      servers: {}, azs: {}, regions: {}, world: { totalRps: 0, errorRate: 0 },
    },
    events,
  } as unknown as ReplayFrame
}

describe('buildCausalEpisodes', () => {
  it('seeds on oom_kill, joins dependents, and separates unrelated spikes', () => {
    const doc = {
      blueprints: {}, placements: {}, managedServices: {},
    } as unknown as WorldDoc
    const compiled = {
      instances: {
        'instA': { id: 'instA', serverId: 'srvX', azId: 'az1', regionId: 'r1' },
        'instB': { id: 'instB', serverId: 'srv2', azId: 'az1', regionId: 'r1' },
        'instC': { id: 'instC', serverId: 'srv3', azId: 'az1', regionId: 'r1' },
        'instD': { id: 'instD', serverId: 'srv4', azId: 'az1', regionId: 'r1' },
      },
      paths: [
        { id: 'p1', dependencyId: 'd1', fromInstanceId: 'instB', to: { kind: 'instance', instanceId: 'instA' }, verdict: 'permitted' },
        { id: 'p2', dependencyId: 'd2', fromInstanceId: 'instC', to: { kind: 'instance', instanceId: 'instA' }, verdict: 'permitted' },
      ],
      findings: [], routing: {},
    } as unknown as CompiledWorld

    const oomEvent: EngineEvent = { id: 'e1', simMs: 47000, kind: 'oom_kill', severity: 'critical', message: 'instA OOM-killed on srvX', affected: ['instA', 'srvX'] }
    const frames = [
      frame(45000, [], { instA: 0.01, instB: 0.01, instC: 0.01, instD: 0.01 }),
      frame(47000, [oomEvent], { instA: 0.9, instB: 0.6, instC: 0.6, instD: 0.7 }),
    ]

    const episodes = buildCausalEpisodes(frames, doc, compiled)
    expect(episodes).toHaveLength(1)
    const [ep] = episodes
    expect(ep.kind).toBe('oom_kill')
    const consequenceIds = ep.consequences.map(c => c.id)
    expect(consequenceIds).toContain('instB')
    expect(consequenceIds).toContain('instC')
    expect(consequenceIds).not.toContain('instD')
    expect(ep.unexplainedSpikes).toContain('instD')
  })

  it('collapses consecutive identical events into one episode with repeatedForMs', () => {
    const doc = { blueprints: {}, placements: {}, managedServices: {} } as unknown as WorldDoc
    const compiled = { instances: {}, paths: [], findings: [], routing: {} } as unknown as CompiledWorld
    const mkRefused = (simMs: number): EngineEvent => ({
      id: `e-${simMs}`, simMs, kind: 'connection_refused', severity: 'warning',
      message: 'x refused on y', affected: ['instX', 'instY'],
    })
    const frames = [1000, 2000, 3000].map(ms => frame(ms, [mkRefused(ms)], {}))
    const episodes = buildCausalEpisodes(frames, doc, compiled)
    expect(episodes).toHaveLength(1)
    expect(episodes[0].repeatedForMs).toBeGreaterThanOrEqual(2000)
  })
})
```

- [ ] **Step 6: Run to verify failure**

Run: `npx vitest run src/lib/aiChat/eventCausality.test.ts`
Expected: FAIL — `buildCausalEpisodes` not defined.

- [ ] **Step 7: Implement `buildCausalEpisodes`**

```ts
// append to src/lib/aiChat/eventCausality.ts
const SEED_KINDS = new Set<EngineEventKind>([
  'breaker_open', 'failover_started', 'health_check_failed', 'replica_promoted',
])
const WINDOW_MS = 15_000

function isSeed(e: EngineEvent): boolean {
  return e.severity === 'critical' || SEED_KINDS.has(e.kind)
}

function metricFor(instanceId: string, batch: ReplayFrame['batch']): number | undefined {
  return batch.instances[instanceId]?.errorRate
}

export function buildCausalEpisodes(
  frames: ReplayFrame[], doc: WorldDoc, compiled: CompiledWorld,
): CausalEpisode[] {
  const episodes: CausalEpisode[] = []
  const collapsedKeys = new Map<string, CausalEpisode>()

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]
    for (const e of f.events) {
      if (!isSeed(e)) continue
      const { primaryId, secondaryId } = decodeAffected(e.kind, e.affected)
      const key = `${e.kind}|${primaryId}|${secondaryId ?? ''}`
      const existing = collapsedKeys.get(key)
      if (existing && f.simMs - existing.startMs <= WINDOW_MS * 2) {
        existing.repeatedForMs = f.simMs - existing.startMs
        continue
      }

      const before = frames[i - 1] ? { errorRate: metricFor(primaryId, frames[i - 1].batch) } : null
      const windowFrames = frames.filter(wf => wf.simMs >= f.simMs && wf.simMs <= f.simMs + WINDOW_MS)
      const afterRate = Math.max(0, ...windowFrames.map(wf => metricFor(primaryId, wf.batch) ?? 0))
      const after = { errorRate: afterRate }

      const radius = primaryId ? blastRadius(primaryId, doc, compiled) : { direct: [], transitive: [], depthOf: {} }
      const dependents = new Set([...radius.direct, ...radius.transitive, primaryId, secondaryId].filter(Boolean) as string[])

      const consequences: CausalEpisode['consequences'] = []
      const unexplainedSpikes: string[] = []
      for (const wf of windowFrames) {
        for (const [instId, m] of Object.entries(wf.batch.instances)) {
          if (m.errorRate < 0.3) continue
          if (dependents.has(instId)) {
            if (!consequences.some(c => c.id === instId)) {
              consequences.push({ id: instId, depth: radius.depthOf[instId] ?? 0, metric: `errorRate=${m.errorRate}` })
            }
          } else if (!unexplainedSpikes.includes(instId)) {
            unexplainedSpikes.push(instId)
          }
        }
      }

      const followOnEvents: CausalEpisode['followOnEvents'] = []
      for (const wf of windowFrames) {
        for (const fe of wf.events) {
          if (fe.id === e.id) continue
          const decoded = decodeAffected(fe.kind, fe.affected)
          if (dependents.has(decoded.primaryId) || (decoded.secondaryId && dependents.has(decoded.secondaryId))) {
            followOnEvents.push({ id: fe.id, kind: fe.kind, simMs: fe.simMs })
          }
        }
      }

      const episode: CausalEpisode = {
        seedEventId: e.id, kind: e.kind, startMs: f.simMs, repeatedForMs: 0,
        roles: { primaryId, secondaryId }, before, after,
        consequences, followOnEvents, unexplainedSpikes, message: e.message,
      }
      collapsedKeys.set(key, episode)
      episodes.push(episode)
    }
  }

  return episodes.sort((a, b) => b.startMs - a.startMs).slice(0, 8)
}
```

- [ ] **Step 8: Run to verify pass**

Run: `npx vitest run src/lib/aiChat/eventCausality.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 9: Run the whole suite, then commit**

```bash
git add src/lib/aiChat/eventCausality.ts src/lib/aiChat/eventCausality.test.ts
git commit -m "feat: decode event causality and build causal episodes from replay frames"
```

---

## Task 5: Context builder — `src/lib/aiChat/context.ts`

**Files:**
- Create: `src/lib/aiChat/context.ts`
- Create: `src/lib/aiChat/context.test.ts`

**Interfaces:**
- Consumes: `WorldDoc`, `CompiledWorld`, `AnalysisFinding[]`, `CompileFinding[]`,
  `MetricsBatch | null`, `ReplayFrame[]`, `EngineEvent[]`, Task 2's `dependencyIndexFor`/
  `blastRadius`, Task 3's `scopeEntityIds`/`scopedEvents`/`scopedFindings`, Task 4's
  `buildCausalEpisodes`.
- Produces (consumed by Task 6's prompt builder and Task 11's `AttachmentBar`):
  ```ts
  export type Attachment =
    | { kind: 'events' } | { kind: 'replay' } | { kind: 'findings' } | { kind: 'topology' }
    | { kind: 'traces'; scope: RenderScope } | { kind: 'entity'; id: string }
  export interface ChatContextInput {
    doc: WorldDoc; compiled: CompiledWorld
    findings: AnalysisFinding[]; compileFindings: CompileFinding[]
    latestBatch: MetricsBatch | null; events: EngineEvent[]; replayFrames: ReplayFrame[]
  }
  export function buildChatDigest(input: ChatContextInput): string
  export function buildContextBlock(attachments: Attachment[], input: ChatContextInput): string
  export function attachmentPreview(a: Attachment, input: ChatContextInput): { label: string; tokens: number }
  export function attachmentKey(a: Attachment): string
  export function estimateTokens(text: string): number
  ```

**Excluded, by construction — never referenced anywhere in this file:** any `LlmSettings` field,
the whole `WorldDoc` unless `topology` is attached, full `batch.instances`/`batch.servers` maps
outside the top-8 truncation, `doc.packets` bodies, the durable event log, cost-model output.

- [ ] **Step 1: Write the failing tests, including the security canary**

```ts
// src/lib/aiChat/context.test.ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/aiChat/context.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `context.ts`**

```ts
// src/lib/aiChat/context.ts
import type { WorldDoc, CompiledWorld } from '../world/types'
import type { AnalysisFinding, CompileFinding } from '../analysis/types'
import type { MetricsBatch, EngineEvent, ReplayFrame } from '../worldEngine/types'
import type { RenderScope } from '../worldEngine/types'
import { dependencyIndexFor } from '../world/dependents'
import { buildCausalEpisodes } from './eventCausality'

export type Attachment =
  | { kind: 'events' } | { kind: 'replay' } | { kind: 'findings' } | { kind: 'topology' }
  | { kind: 'traces'; scope: RenderScope } | { kind: 'entity'; id: string }

export interface ChatContextInput {
  doc: WorldDoc
  compiled: CompiledWorld
  findings: AnalysisFinding[]
  compileFindings: CompileFinding[]
  latestBatch: MetricsBatch | null
  events: EngineEvent[]
  replayFrames: ReplayFrame[]
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function attachmentKey(a: Attachment): string {
  switch (a.kind) {
    case 'entity': return `entity:${a.id}`
    case 'traces': {
      const s = a.scope as { level: string; azId?: string; serverId?: string; regionId?: string }
      const id = s.serverId ?? s.azId ?? s.regionId ?? 'world'
      return `traces:${s.level}:${id}`
    }
    default: return a.kind
  }
}

function topN<T>(items: T[], n: number, byKey: (t: T) => number): T[] {
  return [...items].sort((a, b) => byKey(b) - byKey(a)).slice(0, n)
}

function worldSummary(doc: WorldDoc): unknown {
  return {
    routingPolicy: doc.routing.policy,
    dnsTtlSec: doc.routing.dnsTtlSec,
    healthCheckIntervalMs: doc.routing.healthCheckIntervalMs,
    healthCheckFailureThreshold: doc.routing.healthCheckFailureThreshold,
    regionCount: Object.keys(doc.regions).length,
    azCount: Object.keys(doc.azs).length,
    serverCount: Object.keys(doc.servers).length,
  }
}

function servicesSummary(doc: WorldDoc): unknown[] {
  return Object.values(doc.blueprints).map(bp => ({
    id: bp.id, name: bp.name,
    dependencies: bp.dependencies.map(d => d.target.kind === 'blueprint' ? d.target.blueprintId : d.target.managedServiceId),
    placementCount: Object.values(doc.placements).filter(p => p.blueprintId === bp.id).length,
  }))
}

function liveStateSummary(batch: MetricsBatch | null): unknown {
  if (!batch) return null
  const servers = topN(Object.values(batch.servers), 8, s => Math.max(0, ...s.coreUtilization))
    .map(s => ({ serverId: s.serverId, maxCoreUtilization: Math.max(0, ...s.coreUtilization) }))
  const instances = topN(Object.values(batch.instances), 8, i => i.errorRate)
    .map(i => ({ instanceId: i.instanceId, errorRate: i.errorRate, p99Ms: i.p99Ms }))
  return {
    world: batch.world,
    regions: batch.regions,
    azs: batch.azs,
    servers, instances,
  }
}

function findingsIndex(findings: AnalysisFinding[]): unknown[] {
  const byRule = new Map<string, { ruleId: string; severity: string; affectedCount: number }>()
  for (const f of findings as unknown as { ruleId: string; severity: string; affected: string[] }[]) {
    const existing = byRule.get(f.ruleId)
    if (existing) existing.affectedCount += f.affected.length
    else byRule.set(f.ruleId, { ruleId: f.ruleId, severity: f.severity, affectedCount: f.affected.length })
  }
  return [...byRule.values()]
}

function eventSummary(events: EngineEvent[]): unknown {
  const counts: Record<string, number> = {}
  for (const e of events) counts[`${e.kind}:${e.severity}`] = (counts[`${e.kind}:${e.severity}`] ?? 0) + 1
  const mostSevere = [...events].filter(e => e.severity !== 'info').slice(-5)
  return {
    counts,
    firstSimMs: events[0]?.simMs ?? null,
    lastSimMs: events[events.length - 1]?.simMs ?? null,
    mostSevere: mostSevere.map(e => ({ id: e.id, kind: e.kind, severity: e.severity, message: e.message })),
  }
}

const LIMITATIONS = [
  'No queue-depth or offered-vs-admitted-rps signal exists — infer saturation from coreUtilization/p99Ms/errorRate/droppedRps/refusedRps only.',
  'There is no connection pool or connection ceiling model — RAM is the only hard capacity constraint.',
  'k8s/ECS scheduling, ScaleScript, Terraform export, and spot instances are not implemented in this app — never recommend them.',
]

export function buildChatDigest(input: ChatContextInput): string {
  const idx = dependencyIndexFor(input.doc, input.compiled)
  const payload = {
    worldSummary: worldSummary(input.doc),
    services: servicesSummary(input.doc),
    managed: Object.keys(input.doc.managedServices),
    blastRadiusIndexSize: idx.dependentInstances.size,
    liveState: liveStateSummary(input.latestBatch),
    findingsIndex: findingsIndex(input.findings),
    eventSummary: eventSummary(input.events),
    limitations: LIMITATIONS,
  }
  return JSON.stringify(payload)
}

function findingsBlock(input: ChatContextInput): string {
  return JSON.stringify(input.findings)
}

function eventsBlock(input: ChatContextInput): string {
  return JSON.stringify(buildCausalEpisodes(input.replayFrames, input.doc, input.compiled))
}

function replayBlock(input: ChatContextInput): string {
  const rows = input.replayFrames.slice(-60).map(f => ({
    simMs: f.simMs, worldRps: f.batch.world.totalRps, worldErrorRate: f.batch.world.errorRate,
    eventCount: f.events.length,
  }))
  return JSON.stringify(rows)
}

function topologyBlock(input: ChatContextInput): string {
  return JSON.stringify(input.doc)
}

function entityBlock(id: string, input: ChatContextInput): string {
  const record =
    input.doc.regions[id] ?? input.doc.azs[id] ?? input.doc.servers[id] ??
    input.doc.blueprints[id] ?? input.doc.managedServices[id] ?? input.doc.populations[id] ??
    input.compiled.instances[id] ?? null
  return JSON.stringify({ id, record })
}

export function buildContextBlock(attachments: Attachment[], input: ChatContextInput): string {
  const parts: string[] = []
  for (const a of attachments) {
    switch (a.kind) {
      case 'events': parts.push(`EVENTS:\n${eventsBlock(input)}`); break
      case 'replay': parts.push(`REPLAY:\n${replayBlock(input)}`); break
      case 'findings': parts.push(`FINDINGS:\n${findingsBlock(input)}`); break
      case 'topology': parts.push(`TOPOLOGY:\n${topologyBlock(input)}`); break
      case 'entity': parts.push(`ENTITY ${a.id}:\n${entityBlock(a.id, input)}`); break
      case 'traces': parts.push(`TRACES ${JSON.stringify(a.scope)}: unavailable in this build`); break
    }
  }
  return parts.join('\n\n')
}

export function attachmentPreview(a: Attachment, input: ChatContextInput): { label: string; tokens: number } {
  const block = buildContextBlock([a], input)
  const labels: Record<Attachment['kind'], string> = {
    events: 'Events', replay: 'Replay', findings: 'Findings', topology: 'Topology (full world)',
    traces: 'Traces', entity: 'Entity',
  }
  return { label: labels[a.kind], tokens: estimateTokens(block) }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/aiChat/context.test.ts`
Expected: PASS

- [ ] **Step 5: Run the whole suite, then commit**

```bash
git add src/lib/aiChat/context.ts src/lib/aiChat/context.test.ts
git commit -m "feat: build always-on digest and opt-in attachment blocks for AI chat context"
```

---

## Task 6: Prompt + turn caller — `src/lib/aiChat/prompt.ts`, `src/lib/aiChat/index.ts`

**Files:**
- Create: `src/lib/aiChat/prompt.ts`
- Create: `src/lib/aiChat/index.ts`
- Create: `src/lib/aiChat/index.test.ts`

**Interfaces:**
- Consumes: Task 1's `chatComplete`, Task 5's `buildChatDigest`/`buildContextBlock`/
  `ChatContextInput`/`Attachment`.
- Produces (consumed by Task 10's `sendChatTurn.ts`):
  ```ts
  export const HISTORY_TURN_CAP = 12
  export interface AssistantTurnRequest {
    question: string
    attachments: Attachment[]
    history: { role: 'user' | 'assistant'; content: string }[]
    contextInput: ChatContextInput
  }
  export async function requestAssistantTurn(
    settings: LlmSettings, req: AssistantTurnRequest, chat: typeof llmChat = llmChat,
  ): Promise<string>
  ```

- [ ] **Step 1: Write `prompt.ts` (no test needed — it's a string constant, exercised by index.test.ts)**

```ts
// src/lib/aiChat/prompt.ts
export const ASSISTANT_SYSTEM_PROMPT = `You are Scalemap's read-only AI advisor. You cannot change
the world — never suggest you are making an edit; describe changes in terms of the app's own
controls (Placement count, drag/resize, the Connections graph, Settings).

Ontology, exact terms: Regions (catalogId, role) contain AZs, which contain Servers. A Placement
(blueprintId, serverId, count, role) instantiates a global ServiceBlueprint onto a server, producing
one or more ServiceInstances. ManagedServices are black-box cloud services (no simulated internals).
Exactly one LoadBalancer per region. ClientPopulations are geolocated traffic sources. Reachability
is an ordered list of firewall rules evaluated first-match-wins with a default-deny fallback, further
gated by each ServicePort's visibility.

Levers that actually exist, so advice is executable: Placement.count; moving a placement to another
server/AZ/region; resizing to a named INSTANCE_CATALOG preset (name the preset id verbatim, never a
vague "bigger instance"); adding a role: passive region plus routing priority; a region LoadBalancer's
crossZone flag; routing.dnsTtlSec and healthCheckIntervalMs/healthCheckFailureThreshold (detection
time is roughly interval × failureThreshold + one probe timeout); a managed database's
instanceClassId, replicaCount, multiAz, maxConnections, queryTimeoutMs.

Simulator semantics that change the correct answer: managed SQL databases are single-writer — read
replicas do not help a write-bound primary, so never suggest "add a replica" for write-bound SQL
load. RAM is the only hard constraint on instance count (there is no connection pool or ceiling
model); an OOM-killed instance restarts after about 5 seconds. Burstable VPS instances degrade under
sustained load once burst credits exhaust. Setting crossZone: false on a region's load balancer
forfeits traffic to an empty AZ — that traffic shows up as droppedRps.

Prohibitions: do not repeat findings already shown in the Analysis tab — reference them, don't
restate their text. Never invent a metric you were not given in context. Never recommend Kubernetes/
ECS scheduling, ScaleScript, Terraform export, or spot instances — none of these exist in this app.

Output contract: short markdown. Allowed formatting only — fenced code blocks, blank-line
paragraphs, "-"/"*"/"1." bullets, "##"/"###" headings, **bold**, \`inline code\`. Put every entity id
you reference in backticks, exactly as given in the context (e.g. \`srv-a1\`, \`inst-1#0\`).`
```

- [ ] **Step 2: Write the failing tests for `index.ts`**

```ts
// src/lib/aiChat/index.test.ts
import { describe, it, expect, vi } from 'vitest'
import { requestAssistantTurn, HISTORY_TURN_CAP } from './index'
import type { AssistantTurnRequest } from './index'
import type { LlmSettings } from '../llmReview'

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
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/lib/aiChat/index.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `index.ts`**

```ts
// src/lib/aiChat/index.ts
import { chatComplete, type ChatMessage } from '../llmClient'
import type { LlmSettings } from '../llmReview'
import type { llmChat } from '../tauri'
import { ASSISTANT_SYSTEM_PROMPT } from './prompt'
import { buildChatDigest, buildContextBlock, type Attachment, type ChatContextInput } from './context'

export const HISTORY_TURN_CAP = 12

export interface AssistantTurnRequest {
  question: string
  attachments: Attachment[]
  history: { role: 'user' | 'assistant'; content: string }[]
  contextInput: ChatContextInput
}

export async function requestAssistantTurn(
  settings: LlmSettings, req: AssistantTurnRequest, chat: typeof llmChat,
): Promise<string> {
  const digest = buildChatDigest(req.contextInput)
  const attachmentBlock = buildContextBlock(req.attachments, req.contextInput)
  const contextContent = attachmentBlock ? `${digest}\n\n${attachmentBlock}` : digest

  const cappedHistory = req.history.slice(-HISTORY_TURN_CAP * 2)

  const messages: ChatMessage[] = [
    { role: 'system', content: ASSISTANT_SYSTEM_PROMPT },
    { role: 'system', content: contextContent },
    ...cappedHistory,
    { role: 'user', content: req.question },
  ]

  return chatComplete(settings, messages, { temperature: 0.2 }, chat)
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/lib/aiChat/index.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/lib/aiChat/prompt.ts src/lib/aiChat/index.ts src/lib/aiChat/index.test.ts
git commit -m "feat: add assistant system prompt and turn-request orchestration"
```

---

## Task 7: Response formatter — `src/lib/aiChat/formatResponse.ts`

**Files:**
- Create: `src/lib/aiChat/formatResponse.ts`
- Create: `src/lib/aiChat/formatResponse.test.ts`

**Interfaces:**
- Produces (consumed by Task 11's `ResponseBlocks.tsx`):
  ```ts
  export type Span = { kind: 'text'; text: string } | { kind: 'strong'; text: string } | { kind: 'code'; text: string } | { kind: 'entity'; id: string; text: string }
  export type Block =
    | { kind: 'paragraph'; spans: Span[] } | { kind: 'bullets'; items: Span[][] }
    | { kind: 'heading'; level: 2 | 3; spans: Span[] } | { kind: 'code'; lang: string | null; text: string }
  export function formatResponse(raw: string, resolveEntity: (token: string) => boolean): Block[]
  ```
  (Citation upgrading — turning a matched `code` span into an `entity` span — is Task 9's job;
  this function's `resolveEntity` callback is the seam Task 9 plugs into. In this task, a stub
  `() => false` is used in tests so `code` spans stay `code`.)

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/aiChat/formatResponse.test.ts
import { describe, it, expect } from 'vitest'
import { formatResponse } from './formatResponse'

const noEntities = () => false

describe('formatResponse', () => {
  it('splits fenced code blocks first, at highest precedence', () => {
    const blocks = formatResponse('before\n```ts\nconst x = 1\n```\nafter', noEntities)
    expect(blocks.map(b => b.kind)).toEqual(['paragraph', 'code', 'paragraph'])
    const code = blocks[1] as { kind: 'code'; lang: string | null; text: string }
    expect(code.lang).toBe('ts')
    expect(code.text).toBe('const x = 1')
  })

  it('handles an unterminated fence by taking the remainder', () => {
    const blocks = formatResponse('```\nno closing fence here', noEntities)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe('code')
  })

  it('does not parse markdown inside a fenced block', () => {
    const blocks = formatResponse('```\n**not bold** `not code`\n```', noEntities)
    const code = blocks[0] as { kind: 'code'; text: string }
    expect(code.text).toContain('**not bold**')
  })

  it('splits blank-line-separated paragraphs', () => {
    const blocks = formatResponse('first para\n\nsecond para', noEntities)
    expect(blocks).toHaveLength(2)
    expect(blocks.every(b => b.kind === 'paragraph')).toBe(true)
  })

  it('parses flat bullets with -, *, and N.', () => {
    const blocks = formatResponse('- one\n- two\n* three', noEntities)
    expect(blocks).toHaveLength(1)
    expect((blocks[0] as { kind: 'bullets'; items: unknown[] }).items).toHaveLength(3)
  })

  it('parses ## and ### headings', () => {
    const blocks = formatResponse('## Heading', noEntities)
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 2 })
  })

  it('does not match bold across a paragraph break', () => {
    const blocks = formatResponse('**opens but\n\nnever closes', noEntities)
    const paragraph = blocks[0] as { kind: 'paragraph'; spans: { kind: string }[] }
    expect(paragraph.spans.every(s => s.kind !== 'strong')).toBe(true)
  })

  it('bolds **text** within one paragraph', () => {
    const blocks = formatResponse('a **bold** word', noEntities)
    const paragraph = blocks[0] as { kind: 'paragraph'; spans: { kind: string; text: string }[] }
    expect(paragraph.spans.some(s => s.kind === 'strong' && s.text === 'bold')).toBe(true)
  })

  it('renders inline code spans', () => {
    const blocks = formatResponse('call `foo()` now', noEntities)
    const paragraph = blocks[0] as { kind: 'paragraph'; spans: { kind: string; text: string }[] }
    expect(paragraph.spans.some(s => s.kind === 'code' && s.text === 'foo()')).toBe(true)
  })

  it('upgrades a resolvable inline-code span to an entity span', () => {
    const resolve = (token: string) => token === 'srv-1'
    const blocks = formatResponse('see `srv-1` for details', resolve)
    const paragraph = blocks[0] as { kind: 'paragraph'; spans: { kind: string; id?: string }[] }
    expect(paragraph.spans.some(s => s.kind === 'entity' && s.id === 'srv-1')).toBe(true)
  })

  it('keeps unsupported syntax (tables, links, raw HTML) as literal text', () => {
    const blocks = formatResponse('<script>alert(1)</script> and [a link](http://x)', noEntities)
    const paragraph = blocks[0] as { kind: 'paragraph'; spans: { kind: string; text: string }[] }
    const joined = paragraph.spans.map(s => s.text).join('')
    expect(joined).toContain('<script>alert(1)</script>')
    expect(joined).toContain('[a link](http://x)')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/aiChat/formatResponse.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `formatResponse.ts`**

```ts
// src/lib/aiChat/formatResponse.ts
export type Span =
  | { kind: 'text'; text: string } | { kind: 'strong'; text: string }
  | { kind: 'code'; text: string } | { kind: 'entity'; id: string; text: string }
export type Block =
  | { kind: 'paragraph'; spans: Span[] } | { kind: 'bullets'; items: Span[][] }
  | { kind: 'heading'; level: 2 | 3; spans: Span[] } | { kind: 'code'; lang: string | null; text: string }

function parseInline(text: string, resolveEntity: (token: string) => boolean): Span[] {
  const spans: Span[] = []
  let i = 0
  while (i < text.length) {
    const boldStart = text.indexOf('**', i)
    const codeStart = text.indexOf('`', i)
    const nextSpecial = [boldStart, codeStart].filter(n => n >= 0).sort((a, b) => a - b)[0]
    if (nextSpecial === undefined) { spans.push({ kind: 'text', text: text.slice(i) }); break }
    if (nextSpecial === boldStart) {
      const close = text.indexOf('**', boldStart + 2)
      const newline = text.indexOf('\n\n', boldStart)
      if (close === -1 || (newline !== -1 && newline < close)) {
        spans.push({ kind: 'text', text: text.slice(i, boldStart + 2) })
        i = boldStart + 2
        continue
      }
      if (boldStart > i) spans.push({ kind: 'text', text: text.slice(i, boldStart) })
      spans.push({ kind: 'strong', text: text.slice(boldStart + 2, close) })
      i = close + 2
    } else {
      const close = text.indexOf('`', codeStart + 1)
      if (close === -1) { spans.push({ kind: 'text', text: text.slice(i) }); break }
      if (codeStart > i) spans.push({ kind: 'text', text: text.slice(i, codeStart) })
      const token = text.slice(codeStart + 1, close)
      spans.push(resolveEntity(token) ? { kind: 'entity', id: token, text: token } : { kind: 'code', text: token })
      i = close + 1
    }
  }
  return spans
}

export function formatResponse(raw: string, resolveEntity: (token: string) => boolean): Block[] {
  const blocks: Block[] = []
  const fenceRe = /```(\w*)\n?/g
  let cursor = 0
  let match: RegExpExecArray | null

  const pushProse = (segment: string): void => {
    for (const para of segment.split(/\n\n+/)) {
      const trimmed = para.trim()
      if (!trimmed) continue
      const headingMatch = /^(#{2,3})\s+(.*)$/.exec(trimmed)
      if (headingMatch) {
        blocks.push({ kind: 'heading', level: headingMatch[1].length as 2 | 3, spans: parseInline(headingMatch[2], resolveEntity) })
        continue
      }
      const lines = trimmed.split('\n')
      if (lines.every(l => /^\s*([-*]|\d+\.)\s+/.test(l))) {
        blocks.push({ kind: 'bullets', items: lines.map(l => parseInline(l.replace(/^\s*([-*]|\d+\.)\s+/, ''), resolveEntity)) })
        continue
      }
      blocks.push({ kind: 'paragraph', spans: parseInline(trimmed, resolveEntity) })
    }
  }

  while ((match = fenceRe.exec(raw)) !== null) {
    pushProse(raw.slice(cursor, match.index))
    const closeIdx = raw.indexOf('```', fenceRe.lastIndex)
    const lang = match[1] || null
    if (closeIdx === -1) {
      blocks.push({ kind: 'code', lang, text: raw.slice(fenceRe.lastIndex) })
      cursor = raw.length
      break
    }
    blocks.push({ kind: 'code', lang, text: raw.slice(fenceRe.lastIndex, closeIdx) })
    cursor = closeIdx + 3
    fenceRe.lastIndex = cursor
  }
  pushProse(raw.slice(cursor))
  return blocks
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/aiChat/formatResponse.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/aiChat/formatResponse.ts src/lib/aiChat/formatResponse.test.ts
git commit -m "feat: hand-rolled markdown-subset formatter for AI chat responses"
```

---

## Task 8: Neutral nav module — `src/app/world/entityNav.ts`

**Files:**
- Create: `src/app/world/entityNav.ts`
- Modify: `src/app/world/panels/AnalysisTab.tsx` (remove `navigateToEntity`/`entityLabel`
  definitions, re-export `navigateToEntity` from the new module; update its own call sites to
  import from the new module too)
- Modify: `src/app/world/panels/AiReviewSection.tsx` (import `navigateToEntity`/`entityLabel`
  from `../entityNav` instead of `./AnalysisTab`; render `entityLabel(id, doc, compiled)` instead
  of the raw `id` at the button, line ~109)
- Modify: `src/app/world/panels/AiReviewSection.test.tsx` (update the one assertion at ~94-95 that
  currently expects the raw id, to expect the label)

**Interfaces:**
- Produces (consumed by Task 11's `EntityChip.tsx` and re-exported by `AnalysisTab.tsx`):
  ```ts
  export interface NavApi { goRegion(id: string): void; goAz(regionId: string, azId: string): void; goServer(regionId: string, azId: string, serverId: string): void }
  export function navigateToEntity(id: string, doc: WorldDoc, compiled: CompiledWorld, nav: NavApi): boolean
  export function entityLabel(id: string, doc: WorldDoc, compiled: CompiledWorld): string
  ```

- [ ] **Step 1: Read the current exact bodies before moving them**

Read `src/app/world/panels/AnalysisTab.tsx` lines 1-65 in full to copy `navigateToEntity` (lines
20-33) and `entityLabel` (line 59 onward) verbatim, and read `AiReviewSection.tsx` in full to see
every call site of both.

- [ ] **Step 2: Create `entityNav.ts` with the moved bodies, `entityLabel` now exported**

```ts
// src/app/world/entityNav.ts
import type { WorldDoc, CompiledWorld } from '../../lib/world/types'

export interface NavApi {
  goRegion(id: string): void
  goAz(regionId: string, azId: string): void
  goServer(regionId: string, azId: string, serverId: string): void
}

export function navigateToEntity(id: string, doc: WorldDoc, compiled: CompiledWorld, nav: NavApi): boolean {
  if (doc.regions[id]) { nav.goRegion(id); return true }
  const az = doc.azs[id]
  if (az) { nav.goAz(az.regionId, id); return true }
  const server = doc.servers[id]
  if (server) {
    const a = doc.azs[server.azId]
    if (a) { nav.goServer(a.regionId, a.id, id); return true }
  }
  const inst = compiled.instances[id]
  if (inst) { nav.goServer(inst.regionId, inst.azId, inst.serverId); return true }
  return false
}

export function entityLabel(id: string, doc: WorldDoc, compiled: CompiledWorld): string {
  if (doc.regions[id]) return doc.regions[id].catalogId
  if (doc.azs[id]) return doc.azs[id].label
  if (doc.servers[id]) return doc.servers[id].label
  if (doc.blueprints[id]) return doc.blueprints[id].name
  if (doc.managedServices[id]) return doc.managedServices[id].label
  if (doc.populations[id]) return doc.populations[id].label
  const inst = compiled.instances[id]
  if (inst) return `${doc.servers[inst.serverId]?.label ?? inst.serverId}·${doc.blueprints[inst.blueprintId]?.name ?? ''}`
  return id
}
```

- [ ] **Step 3: Update `AnalysisTab.tsx` to re-export instead of define**

Delete the `navigateToEntity`/`entityLabel` function bodies; add:
```ts
export { navigateToEntity, entityLabel } from '../entityNav'
```
Keep every existing internal call site in `AnalysisTab.tsx` working unchanged (they still resolve
via the local re-exported name).

- [ ] **Step 4: Update `AiReviewSection.tsx` to import from the new module and use `entityLabel`**

Replace `import { navigateToEntity } from './AnalysisTab'` with:
```ts
import { navigateToEntity, entityLabel } from '../entityNav'
```
Remove the header comment documenting the deliberate ESM cycle (lines 2-6) — the cycle no longer
exists once both files import from the neutral `entityNav.ts` instead of each other. Change the
chip render (previously line 109) from:
```tsx
{issue.affected.map(id => (
  <button key={id} style={smallBtnStyle} onClick={() => navigateToEntity(id, doc, compiled, useNavStore.getState())}>{id}</button>
))}
```
to:
```tsx
{issue.affected.map(id => (
  <button key={id} style={smallBtnStyle} onClick={() => navigateToEntity(id, doc, compiled, useNavStore.getState())}>{entityLabel(id, doc, compiled)}</button>
))}
```

- [ ] **Step 5: Update the one test assertion that expects the raw id**

In `AiReviewSection.test.tsx` around lines 94-95, change the expectation from the raw id string to
the resolved label (e.g. if the fixture server's `label` is `'srv-1'` and its `catalogId`/`name`
differ, update the assertion to match whatever `entityLabel` actually returns for that fixture —
read the fixture in the test file first to get the exact expected string).

- [ ] **Step 6: Run the affected test files**

Run: `npx vitest run src/app/world/panels/AnalysisTab.test.tsx src/app/world/panels/AiReviewSection.test.tsx`
Expected: PASS

- [ ] **Step 7: Run the whole suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/app/world/entityNav.ts src/app/world/panels/AnalysisTab.tsx src/app/world/panels/AiReviewSection.tsx src/app/world/panels/AiReviewSection.test.tsx
git commit -m "refactor: extract entityNav module, removing the AnalysisTab/AiReviewSection ESM cycle"
```

---

## Task 9: Citations — `src/lib/aiChat/citations.ts`

**Files:**
- Create: `src/lib/aiChat/citations.ts`
- Create: `src/lib/aiChat/citations.test.ts`

**Interfaces:**
- Consumes: `WorldDoc` (`regions`/`azs`/`servers`/`blueprints`/`managedServices`/`populations`/
  `placements`), `CompiledWorld.instances`.
- Produces (consumed by Task 11's `ResponseBlocks.tsx`, plugged into Task 7's `formatResponse`
  `resolveEntity` callback):
  ```ts
  export function buildCitationIndex(doc: WorldDoc, compiled: CompiledWorld): { has: (token: string) => boolean }
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/aiChat/citations.test.ts
import { describe, it, expect } from 'vitest'
import { buildCitationIndex } from './citations'
import type { WorldDoc, CompiledWorld } from '../world/types'

function fixture(): { doc: WorldDoc; compiled: CompiledWorld } {
  const doc = {
    regions: { 'r1': {} }, azs: { 'az1': {} }, servers: { 'srv-1': {} },
    blueprints: { 'bp-1': {} }, managedServices: {}, populations: {}, placements: {},
  } as unknown as WorldDoc
  const compiled = { instances: { 'inst-1': {}, 'inst-1#0': {} }, paths: [], findings: [], routing: {} } as unknown as CompiledWorld
  return { doc, compiled }
}

describe('buildCitationIndex', () => {
  it('matches a known id with word-boundary-like lookarounds', () => {
    const { doc, compiled } = fixture()
    const idx = buildCitationIndex(doc, compiled)
    expect(idx.has('srv-1')).toBe(true)
    expect(idx.has('unknown-id')).toBe(false)
  })

  it('matches the longer id first when one id is a prefix of another', () => {
    const { doc, compiled } = fixture()
    const idx = buildCitationIndex(doc, compiled)
    expect(idx.has('inst-1#0')).toBe(true)
    expect(idx.has('inst-1')).toBe(true)
  })

  it('does not match a substring that only partially overlaps an id', () => {
    const { doc, compiled } = fixture()
    const idx = buildCitationIndex(doc, compiled)
    expect(idx.has('srv-12')).toBe(false)
    expect(idx.has('xsrv-1')).toBe(false)
  })

  it('memoizes per compiled identity', () => {
    const { doc, compiled } = fixture()
    expect(buildCitationIndex(doc, compiled)).toBe(buildCitationIndex(doc, compiled))
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/aiChat/citations.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `citations.ts`**

```ts
// src/lib/aiChat/citations.ts
import type { WorldDoc, CompiledWorld } from '../world/types'

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface CitationIndex { has: (token: string) => boolean }

const cache = new WeakMap<CompiledWorld, CitationIndex>()

export function buildCitationIndex(doc: WorldDoc, compiled: CompiledWorld): CitationIndex {
  const cached = cache.get(compiled)
  if (cached) return cached

  const ids = new Set<string>([
    ...Object.keys(doc.regions), ...Object.keys(doc.azs), ...Object.keys(doc.servers),
    ...Object.keys(doc.blueprints), ...Object.keys(doc.managedServices),
    ...Object.keys(doc.populations), ...Object.keys(doc.placements),
    ...Object.keys(compiled.instances),
  ])
  const idSet = ids

  const index: CitationIndex = { has: (token: string) => idSet.has(token) }
  cache.set(compiled, index)
  return index
}
```

Note: `buildCitationIndex`'s `has()` is an exact-membership check (the actual scanning-a-larger-
string use case belongs to `ResponseBlocks.tsx`/`formatResponse`'s `resolveEntity` callback, which
calls `has(token)` on each already-tokenized inline-code span — so the longest-first regex
alternation described in the original spec is unnecessary complexity here: `formatResponse`
already isolates candidate tokens at backtick boundaries, so a plain Set lookup suffices and no
regex/lookaround is needed in this file at all).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/aiChat/citations.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/aiChat/citations.ts src/lib/aiChat/citations.test.ts
git commit -m "feat: add known-entity-id lookup for AI chat citation upgrading"
```

---

## Task 10: `src/app/store/chat.store.ts` + `src/app/world/ai/sendChatTurn.ts`

**Files:**
- Create: `src/app/store/chat.store.ts`
- Create: `src/app/store/chat.store.test.ts`
- Create: `src/app/world/ai/sendChatTurn.ts`
- Create: `src/app/world/ai/sendChatTurn.test.ts`

**Interfaces:**
- Consumes: Task 6's `requestAssistantTurn`, Task 5's `Attachment`.
- Produces (consumed by Task 11's UI components):
  ```ts
  export interface ChatTurn {
    id: string; askedAt: number; question: string
    attachments: Attachment[]
    contextTokens: number; worldChangedSincePrev: boolean
    status: 'pending' | 'done' | 'error'; answer: string; error: string
  }
  interface ChatStore {
    turns: ChatTurn[]; draft: string; selected: Attachment[]
    requestGen: number; inFlightTurnId: string | null
    setDraft(d: string): void
    toggleAttachment(a: Attachment): void
    clearAttachments(): void
    clearTranscript(): void
    beginTurn(question: string, attachments: Attachment[], contextTokens: number, worldChangedSincePrev: boolean): { turnId: string; gen: number }
    resolveTurn(turnId: string, gen: number, answer: string): void
    failTurn(turnId: string, gen: number, message: string): void
    abandonInFlight(): void
  }
  export const useChatStore: UseBoundStore<StoreApi<ChatStore>>
  ```

- [ ] **Step 1: Write the failing store tests**

```ts
// src/app/store/chat.store.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from './chat.store'

beforeEach(() => {
  useChatStore.setState({ turns: [], draft: '', selected: [], requestGen: 0, inFlightTurnId: null })
})

describe('chat.store', () => {
  it('toggleAttachment adds and removes without duplicates', () => {
    useChatStore.getState().toggleAttachment({ kind: 'events' })
    expect(useChatStore.getState().selected).toEqual([{ kind: 'events' }])
    useChatStore.getState().toggleAttachment({ kind: 'events' })
    expect(useChatStore.getState().selected).toEqual([])
  })

  it('beginTurn appends a pending turn and bumps nothing else', () => {
    const { turnId, gen } = useChatStore.getState().beginTurn('q', [], 100, false)
    const turn = useChatStore.getState().turns.find(t => t.id === turnId)
    expect(turn?.status).toBe('pending')
    expect(useChatStore.getState().inFlightTurnId).toBe(turnId)
    expect(gen).toBe(useChatStore.getState().requestGen)
  })

  it('resolveTurn marks the turn done when gen matches current', () => {
    const { turnId, gen } = useChatStore.getState().beginTurn('q', [], 0, false)
    useChatStore.getState().resolveTurn(turnId, gen, 'the answer')
    const turn = useChatStore.getState().turns.find(t => t.id === turnId)
    expect(turn?.status).toBe('done')
    expect(turn?.answer).toBe('the answer')
    expect(useChatStore.getState().inFlightTurnId).toBeNull()
  })

  it('resolveTurn is a no-op after abandonInFlight bumped the generation', () => {
    const { turnId, gen } = useChatStore.getState().beginTurn('q', [], 0, false)
    useChatStore.getState().abandonInFlight()
    useChatStore.getState().resolveTurn(turnId, gen, 'late answer')
    const turn = useChatStore.getState().turns.find(t => t.id === turnId)
    expect(turn?.status).toBe('pending') // untouched — the stale resolve was dropped
  })

  it('overlapping turns do not cross-write each other', () => {
    const first = useChatStore.getState().beginTurn('q1', [], 0, false)
    useChatStore.getState().abandonInFlight()
    const second = useChatStore.getState().beginTurn('q2', [], 0, false)
    useChatStore.getState().resolveTurn(second.turnId, second.gen, 'answer2')
    useChatStore.getState().resolveTurn(first.turnId, first.gen, 'stale answer1')
    const turns = useChatStore.getState().turns
    expect(turns.find(t => t.id === second.turnId)?.answer).toBe('answer2')
    expect(turns.find(t => t.id === first.turnId)?.status).toBe('pending')
  })

  it('failTurn marks the turn error when gen matches', () => {
    const { turnId, gen } = useChatStore.getState().beginTurn('q', [], 0, false)
    useChatStore.getState().failTurn(turnId, gen, 'boom')
    expect(useChatStore.getState().turns.find(t => t.id === turnId)?.status).toBe('error')
  })

  it('clearTranscript empties turns but keeps draft', () => {
    useChatStore.getState().setDraft('hello')
    useChatStore.getState().beginTurn('q', [], 0, false)
    useChatStore.getState().clearTranscript()
    expect(useChatStore.getState().turns).toEqual([])
    expect(useChatStore.getState().draft).toBe('hello')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/app/store/chat.store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `chat.store.ts`**

```ts
// src/app/store/chat.store.ts
import { create } from 'zustand'
import type { Attachment } from '../../lib/aiChat/context'

export interface ChatTurn {
  id: string
  askedAt: number
  question: string
  attachments: Attachment[]
  contextTokens: number
  worldChangedSincePrev: boolean
  status: 'pending' | 'done' | 'error'
  answer: string
  error: string
}

interface ChatStore {
  turns: ChatTurn[]
  draft: string
  selected: Attachment[]
  requestGen: number
  inFlightTurnId: string | null
  setDraft: (d: string) => void
  toggleAttachment: (a: Attachment) => void
  clearAttachments: () => void
  clearTranscript: () => void
  beginTurn: (question: string, attachments: Attachment[], contextTokens: number, worldChangedSincePrev: boolean) => { turnId: string; gen: number }
  resolveTurn: (turnId: string, gen: number, answer: string) => void
  failTurn: (turnId: string, gen: number, message: string) => void
  abandonInFlight: () => void
}

function attachmentKeyLocal(a: Attachment): string {
  if (a.kind === 'entity') return `entity:${a.id}`
  if (a.kind === 'traces') return `traces:${JSON.stringify(a.scope)}`
  return a.kind
}

let nextTurnId = 0

export const useChatStore = create<ChatStore>((set, get) => ({
  turns: [],
  draft: '',
  selected: [],
  requestGen: 0,
  inFlightTurnId: null,

  setDraft: (d) => set({ draft: d }),

  toggleAttachment: (a) => set(state => {
    const key = attachmentKeyLocal(a)
    const exists = state.selected.some(s => attachmentKeyLocal(s) === key)
    return { selected: exists ? state.selected.filter(s => attachmentKeyLocal(s) !== key) : [...state.selected, a] }
  }),

  clearAttachments: () => set({ selected: [] }),

  clearTranscript: () => set({ turns: [] }),

  beginTurn: (question, attachments, contextTokens, worldChangedSincePrev) => {
    const turnId = `turn-${nextTurnId++}`
    const gen = get().requestGen
    const turn: ChatTurn = {
      id: turnId, askedAt: Date.now(), question, attachments, contextTokens,
      worldChangedSincePrev, status: 'pending', answer: '', error: '',
    }
    set(state => ({ turns: [...state.turns, turn], inFlightTurnId: turnId }))
    return { turnId, gen }
  },

  resolveTurn: (turnId, gen, answer) => {
    if (gen !== get().requestGen) return
    set(state => ({
      turns: state.turns.map(t => t.id === turnId ? { ...t, status: 'done', answer } : t),
      inFlightTurnId: state.inFlightTurnId === turnId ? null : state.inFlightTurnId,
    }))
  },

  failTurn: (turnId, gen, message) => {
    if (gen !== get().requestGen) return
    set(state => ({
      turns: state.turns.map(t => t.id === turnId ? { ...t, status: 'error', error: message } : t),
      inFlightTurnId: state.inFlightTurnId === turnId ? null : state.inFlightTurnId,
    }))
  },

  abandonInFlight: () => set(state => ({ requestGen: state.requestGen + 1, inFlightTurnId: null })),
}))
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/app/store/chat.store.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Write the failing test for `sendChatTurn.ts`**

```ts
// src/app/world/ai/sendChatTurn.test.ts
import { describe, it, expect, vi } from 'vitest'
import { sendChatTurn } from './sendChatTurn'
import { useChatStore } from '../../store/chat.store'
import type { LlmSettings } from '../../../lib/llmReview'
import type { ChatContextInput } from '../../../lib/aiChat/context'

const settings: LlmSettings = { baseUrl: 'http://x', apiKey: 'k', model: 'm' }
const contextInput: ChatContextInput = {
  doc: { routing: {}, regions: {}, azs: {}, servers: {}, blueprints: {}, placements: {}, managedServices: {}, populations: {} } as never,
  compiled: { instances: {}, paths: [], findings: [], routing: {} } as never,
  findings: [], compileFindings: [], latestBatch: null, events: [], replayFrames: [],
}

beforeEachSetup()
function beforeEachSetup() {
  // vitest hoists imports; reset happens inline per-test below instead of a top-level beforeEach
}

describe('sendChatTurn', () => {
  it('resolves the turn with the assistant answer on success', async () => {
    useChatStore.setState({ turns: [], draft: '', selected: [], requestGen: 0, inFlightTurnId: null })
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ choices: [{ message: { content: 'the answer' } }] }))
    await sendChatTurn(settings, 'why?', [], contextInput, chat)
    const turn = useChatStore.getState().turns[0]
    expect(turn.status).toBe('done')
    expect(turn.answer).toBe('the answer')
  })

  it('fails the turn with the error message on rejection', async () => {
    useChatStore.setState({ turns: [], draft: '', selected: [], requestGen: 0, inFlightTurnId: null })
    const chat = vi.fn().mockRejectedValue(new Error('network down'))
    await sendChatTurn(settings, 'why?', [], contextInput, chat)
    const turn = useChatStore.getState().turns[0]
    expect(turn.status).toBe('error')
    expect(turn.error).toBe('network down')
  })
})
```

- [ ] **Step 6: Run to verify failure**

Run: `npx vitest run src/app/world/ai/sendChatTurn.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement `sendChatTurn.ts`**

```ts
// src/app/world/ai/sendChatTurn.ts
import { useChatStore } from '../../store/chat.store'
import { requestAssistantTurn } from '../../../lib/aiChat'
import { estimateTokens, buildChatDigest, buildContextBlock, type Attachment, type ChatContextInput } from '../../../lib/aiChat/context'
import type { LlmSettings } from '../../../lib/llmReview'
import { llmChat } from '../../../lib/tauri'

export async function sendChatTurn(
  settings: LlmSettings,
  question: string,
  attachments: Attachment[],
  contextInput: ChatContextInput,
  chat: typeof llmChat = llmChat,
): Promise<void> {
  const store = useChatStore.getState()
  const contextTokens = estimateTokens(buildChatDigest(contextInput) + buildContextBlock(attachments, contextInput))
  const history = store.turns
    .filter(t => t.status === 'done')
    .flatMap(t => [{ role: 'user' as const, content: t.question }, { role: 'assistant' as const, content: t.answer }])

  const { turnId, gen } = store.beginTurn(question, attachments, contextTokens, false)
  try {
    const answer = await requestAssistantTurn(settings, { question, attachments, history, contextInput }, chat)
    useChatStore.getState().resolveTurn(turnId, gen, answer)
  } catch (err) {
    useChatStore.getState().failTurn(turnId, gen, err instanceof Error ? err.message : String(err))
  }
}
```

- [ ] **Step 8: Run to verify pass**

Run: `npx vitest run src/app/world/ai/sendChatTurn.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 9: Run the whole suite, then commit**

```bash
git add src/app/store/chat.store.ts src/app/store/chat.store.test.ts src/app/world/ai/sendChatTurn.ts src/app/world/ai/sendChatTurn.test.ts
git commit -m "feat: add chat store with generation-guarded turns and the async send orchestrator"
```

---

## Task 11: The overlay UI — `src/app/world/ai/`

**Files:**
- Create: `src/app/world/ai/AssistantView.tsx`
- Create: `src/app/world/ai/ChatComposer.tsx`
- Create: `src/app/world/ai/ChatTranscript.tsx`
- Create: `src/app/world/ai/AttachmentBar.tsx`
- Create: `src/app/world/ai/ResponseBlocks.tsx`
- Create: `src/app/world/ai/EntityChip.tsx`
- Create: `src/app/world/ai/AssistantView.test.tsx`

**Interfaces:**
- Consumes: Task 10's `useChatStore`/`sendChatTurn`, Task 7's `formatResponse`, Task 9's
  `buildCitationIndex`, Task 8's `navigateToEntity`/`entityLabel`, Task 5's `Attachment`/
  `attachmentPreview`, `useNavStore`, `useUiStore` (existing `selectedServerId`),
  `useWorldStore`/`useSimulationStore` (existing), `loadLlmSettings` (existing, from
  `llmReview.ts`'s settings module).

Follow `src/app/world/connections/ConnectionsView.tsx`'s verified overlay recipe exactly:
`createPortal(..., document.body)`, backdrop `{ position: 'fixed', inset: 0, background:
'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
}`, surface `{ width: '94vw', height: '90vh', background: 'var(--color-surface)', border: '1px
solid var(--color-node-border)', borderRadius: 8, display: 'flex', flexDirection: 'column' }`,
capture-phase `Escape` listener with `stopPropagation()`+`preventDefault()`.

- [ ] **Step 1: Write `EntityChip.tsx`**

```tsx
// src/app/world/ai/EntityChip.tsx
import type { CSSProperties } from 'react'
import { navigateToEntity, entityLabel } from '../entityNav'
import { useNavStore } from '../../store/nav.store'
import type { WorldDoc, CompiledWorld } from '../../../lib/world/types'

const chipStyle: CSSProperties = {
  font: '11px var(--font-mono)', color: 'var(--color-accent)', background: 'transparent',
  border: '1px solid var(--color-node-border)', borderRadius: 4, padding: '1px 6px',
  cursor: 'pointer', display: 'inline-block', margin: '0 2px',
}
const labelStyle: CSSProperties = { ...chipStyle, cursor: 'default', color: 'var(--color-text-secondary)' }

export function EntityChip({ id, doc, compiled, onNavigated }: {
  id: string; doc: WorldDoc; compiled: CompiledWorld; onNavigated: () => void
}) {
  const label = entityLabel(id, doc, compiled)
  const canNav = doc.regions[id] || doc.azs[id] || doc.servers[id] || compiled.instances[id]
  if (!canNav) return <span style={labelStyle}>{label}</span>
  return (
    <button
      style={chipStyle}
      title={id}
      onClick={() => { if (navigateToEntity(id, doc, compiled, useNavStore.getState())) onNavigated() }}
    >
      {label}
    </button>
  )
}
```

- [ ] **Step 2: Write `ResponseBlocks.tsx`**

```tsx
// src/app/world/ai/ResponseBlocks.tsx
import type { CSSProperties } from 'react'
import { formatResponse, type Span } from '../../../lib/aiChat/formatResponse'
import { buildCitationIndex } from '../../../lib/aiChat/citations'
import { EntityChip } from './EntityChip'
import type { WorldDoc, CompiledWorld } from '../../../lib/world/types'

function renderSpan(span: Span, key: number, doc: WorldDoc, compiled: CompiledWorld, onNavigated: () => void) {
  if (span.kind === 'text') return <span key={key}>{span.text}</span>
  if (span.kind === 'strong') return <strong key={key}>{span.text}</strong>
  if (span.kind === 'entity') return <EntityChip key={key} id={span.id} doc={doc} compiled={compiled} onNavigated={onNavigated} />
  return <code key={key} style={{ background: 'var(--color-surface-hover)', padding: '0 3px', borderRadius: 3 }}>{span.text}</code>
}

const codeBlockStyle: CSSProperties = {
  background: 'var(--color-surface-hover)', border: '1px solid var(--color-node-border)',
  borderRadius: 4, padding: 8, overflowX: 'auto', whiteSpace: 'pre',
}

export function ResponseBlocks({ raw, doc, compiled, onNavigated }: {
  raw: string; doc: WorldDoc; compiled: CompiledWorld; onNavigated: () => void
}) {
  const citations = buildCitationIndex(doc, compiled)
  const blocks = formatResponse(raw, citations.has)
  return (
    <div style={{ font: '11px var(--font-mono)', lineHeight: 1.5 }}>
      {blocks.map((b, i) => {
        if (b.kind === 'code') return <pre key={i} style={codeBlockStyle}>{b.text}</pre>
        if (b.kind === 'heading') return <div key={i} style={{ fontWeight: 700, marginTop: 8 }}>{b.spans.map((s, j) => renderSpan(s, j, doc, compiled, onNavigated))}</div>
        if (b.kind === 'bullets') return (
          <ul key={i} style={{ margin: '4px 0', paddingLeft: 18 }}>
            {b.items.map((spans, j) => <li key={j}>{spans.map((s, k) => renderSpan(s, k, doc, compiled, onNavigated))}</li>)}
          </ul>
        )
        return <p key={i} style={{ margin: '4px 0' }}>{b.spans.map((s, j) => renderSpan(s, j, doc, compiled, onNavigated))}</p>
      })}
    </div>
  )
}
```

- [ ] **Step 3: Write `AttachmentBar.tsx`**

```tsx
// src/app/world/ai/AttachmentBar.tsx
import type { CSSProperties } from 'react'
import { useChatStore } from '../../store/chat.store'
import { attachmentPreview, type Attachment, type ChatContextInput } from '../../../lib/aiChat/context'
import { useNavStore } from '../../store/nav.store'
import { useUiStore } from '../../store/ui.store'

const chip = (active: boolean): CSSProperties => ({
  font: '10px var(--font-mono)', padding: '2px 6px', borderRadius: 4, marginRight: 4,
  border: `1px solid ${active ? 'var(--color-accent)' : 'var(--color-node-border)'}`,
  background: active ? 'var(--color-surface-hover)' : 'transparent',
  color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
  cursor: 'pointer',
})

export function AttachmentBar({ contextInput, running }: { contextInput: ChatContextInput; running: boolean }) {
  const selected = useChatStore(s => s.selected)
  const toggle = useChatStore(s => s.toggleAttachment)
  const navLevel = useNavStore(s => s.level)
  const selectedServerId = useUiStore(s => s.selectedServerId)

  const base: Attachment[] = [{ kind: 'events' }, { kind: 'replay' }, { kind: 'findings' }, { kind: 'topology' }]
  const entityAttachment: Attachment | null = selectedServerId ? { kind: 'entity', id: selectedServerId } : null
  const options = entityAttachment ? [...base, entityAttachment] : base

  const isSelected = (a: Attachment) => selected.some(s => JSON.stringify(s) === JSON.stringify(a))
  const totalTokens = selected.reduce((sum, a) => sum + attachmentPreview(a, contextInput).tokens, 0)

  return (
    <div style={{ padding: '4px 8px', borderTop: '1px solid var(--color-node-border)' }}>
      {options.map(a => {
        const preview = attachmentPreview(a, contextInput)
        return (
          <button key={JSON.stringify(a)} style={chip(isSelected(a))} onClick={() => toggle(a)} title={`~${preview.tokens} tokens`}>
            {preview.label} · ~{preview.tokens}tok
          </button>
        )
      })}
      <span style={{ font: '10px var(--font-mono)', color: totalTokens > 12000 ? 'var(--color-warning)' : 'var(--color-text-muted)', marginLeft: 8 }}>
        {totalTokens} tokens total
      </span>
      {running && (
        <div style={{ font: '10px var(--font-mono)', color: 'var(--color-warning)', marginTop: 4 }}>
          Ending the run clears its metrics window — attach events/replay before stopping if you want them referenced.
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Write `ChatComposer.tsx`**

```tsx
// src/app/world/ai/ChatComposer.tsx
import { useRef, type KeyboardEvent } from 'react'
import { useChatStore } from '../../store/chat.store'

const fieldStyle = {
  font: '11px var(--font-mono)', color: 'var(--color-text-primary)', background: 'var(--color-surface)',
  border: '1px solid var(--color-node-border)', borderRadius: 4, padding: '6px 8px',
  resize: 'none' as const, minHeight: 52, maxHeight: 160, overflowY: 'auto' as const, width: '100%',
}

export function ChatComposer({ onSend, disabled }: { onSend: (question: string) => void; disabled: boolean }) {
  const draft = useChatStore(s => s.draft)
  const setDraft = useChatStore(s => s.setDraft)
  const ref = useRef<HTMLTextAreaElement>(null)

  const send = () => {
    const q = draft.trim()
    if (!q || disabled) return
    onSend(q)
    setDraft('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div style={{ padding: 8, borderTop: '1px solid var(--color-node-border)', flexShrink: 0 }}>
      <textarea
        ref={ref}
        style={fieldStyle}
        value={draft}
        placeholder="Ask about this world's design or what went wrong in the run..."
        onChange={e => {
          setDraft(e.target.value)
          const el = e.target
          el.style.height = 'auto'
          el.style.height = `${Math.min(160, el.scrollHeight)}px`
        }}
        onKeyDown={onKeyDown}
      />
    </div>
  )
}
```

- [ ] **Step 5: Write `ChatTranscript.tsx`**

```tsx
// src/app/world/ai/ChatTranscript.tsx
import { useEffect, useRef, useState } from 'react'
import { useChatStore, type ChatTurn } from '../../store/chat.store'
import { ResponseBlocks } from './ResponseBlocks'
import type { WorldDoc, CompiledWorld } from '../../../lib/world/types'

function PendingIndicator({ askedAt }: { askedAt: number }) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setElapsed(Math.round((Date.now() - askedAt) / 1000)), 1000)
    return () => clearInterval(id)
  }, [askedAt])
  return (
    <div style={{ color: 'var(--color-text-muted)', font: '11px var(--font-mono)' }}>
      thinking… {elapsed}s
      {elapsed >= 45 && <div style={{ color: 'var(--color-warning)' }}>this is taking a while — the transport gives up at 60s</div>}
    </div>
  )
}

function TurnView({ turn, doc, compiled, onNavigated, onRetry }: {
  turn: ChatTurn; doc: WorldDoc; compiled: CompiledWorld; onNavigated: () => void; onRetry: (t: ChatTurn) => void
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ color: 'var(--color-text-secondary)', marginBottom: 4 }}>{turn.question}</div>
      {turn.status === 'pending' && <PendingIndicator askedAt={turn.askedAt} />}
      {turn.status === 'done' && <ResponseBlocks raw={turn.answer} doc={doc} compiled={compiled} onNavigated={onNavigated} />}
      {turn.status === 'error' && (
        <div style={{ color: 'var(--color-danger)' }}>
          {turn.error}{' '}
          <button onClick={() => onRetry(turn)} style={{ color: 'var(--color-accent)', background: 'none', border: 'none', cursor: 'pointer' }}>retry</button>
        </div>
      )}
    </div>
  )
}

export function ChatTranscript({ doc, compiled, onNavigated, onRetry, reducedMotion }: {
  doc: WorldDoc; compiled: CompiledWorld; onNavigated: () => void; onRetry: (t: ChatTurn) => void; reducedMotion: boolean
}) {
  const turns = useChatStore(s => s.turns)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'end' })
  }, [turns.length, turns[turns.length - 1]?.status, reducedMotion])

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
      {turns.map(t => <TurnView key={t.id} turn={t} doc={doc} compiled={compiled} onNavigated={onNavigated} onRetry={onRetry} />)}
      <div ref={endRef} />
    </div>
  )
}
```

- [ ] **Step 6: Write `AssistantView.tsx`**

```tsx
// src/app/world/ai/AssistantView.tsx
import { useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties } from 'react'
import { useReducedMotion } from 'framer-motion'
import { useChatStore } from '../../store/chat.store'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useCompiledWorld } from '../useCompiledWorld'
import { runAnalysis } from '../../../lib/analysis/runAnalysis'
import { loadLlmSettings } from '../../../lib/llmReview'
import { sendChatTurn } from './sendChatTurn'
import { ChatComposer } from './ChatComposer'
import { ChatTranscript } from './ChatTranscript'
import { AttachmentBar } from './AttachmentBar'
import type { ChatTurn } from '../../store/chat.store'
import type { ChatContextInput } from '../../../lib/aiChat/context'

const backdrop: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
}
const surface: CSSProperties = {
  width: '94vw', height: '90vh', background: 'var(--color-surface)',
  border: '1px solid var(--color-node-border)', borderRadius: 8,
  display: 'flex', flexDirection: 'column',
  font: '11px var(--font-mono)', color: 'var(--color-text-primary)',
}
const headerStyle: CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '8px 12px', borderBottom: '1px solid var(--color-node-border)',
}

export function AssistantView({ open, onClose, openSettings }: {
  open: boolean; onClose: () => void; openSettings: () => void
}) {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld(doc)
  const events = useSimulationStore(s => s.events)
  const latestBatch = useSimulationStore(s => s.latestBatch)
  const running = useSimulationStore(s => s.running)
  const batchSimMs = latestBatch?.simMs ?? null
  // getReplayFrames is non-reactive (same convention as TimelineV2.tsx:109) — batchSimMs is its change signal
  const replayFrames = useMemo(() => useSimulationStore.getState().getReplayFrames(), [batchSimMs])
  const abandonInFlight = useChatStore(s => s.abandonInFlight)
  const reducedMotion = useReducedMotion() ?? false

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation(); e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  const contextInput: ChatContextInput = {
    doc, compiled,
    findings: runAnalysis(doc, compiled, latestBatch ?? null),
    compileFindings: compiled.findings,
    latestBatch: latestBatch ?? null,
    events,
    replayFrames,
  }

  const send = useCallback(async (question: string) => {
    const settings = await loadLlmSettings()
    const selected = useChatStore.getState().selected
    await sendChatTurn(settings, question, selected, contextInput)
  }, [contextInput])

  const retry = useCallback((turn: ChatTurn) => { void send(turn.question) }, [send])

  if (!open) return null

  return createPortal(
    <div style={backdrop} onClick={onClose}>
      <div style={surface} onClick={e => e.stopPropagation()}>
        <div style={headerStyle}>
          <span>AI Assistant</span>
          <div>
            <button onClick={openSettings} style={{ marginRight: 8 }}>settings</button>
            <button onClick={onClose}>close</button>
          </div>
        </div>
        <AttachmentBar contextInput={contextInput} running={running} />
        <ChatTranscript doc={doc} compiled={compiled} onNavigated={onClose} onRetry={retry} reducedMotion={reducedMotion} />
        <ChatComposer onSend={send} disabled={false} />
      </div>
    </div>,
    document.body,
  )
}
```

Note: this overlay deliberately has **no `<fieldset disabled={running}>`** wrapping its body —
unlike every other portal surface in the app. It cannot mutate the world (read-only advisor), and
"what just went wrong" is inherently a mid-run question, mirroring `WorldPanel.tsx`'s Events-tab
exemption (`disabled={running && tab !== 'events'}`). Leave the comment above so a future author
copying this file's recipe doesn't paste a fieldset back in.

- [ ] **Step 7: Write `AssistantView.test.tsx`**

```tsx
// src/app/world/ai/AssistantView.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AssistantView } from './AssistantView'
import { useChatStore } from '../../store/chat.store'
import { useNavStore } from '../../store/nav.store'
import { useWorldStore } from '../../store/world.store'

vi.mock('../../../lib/llmReview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/llmReview')>()
  return { ...actual, loadLlmSettings: vi.fn().mockResolvedValue({ baseUrl: '', apiKey: '', model: '' }) }
})

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useChatStore.setState({ turns: [], draft: '', selected: [], requestGen: 0, inFlightTurnId: null })
})

describe('AssistantView', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<AssistantView open={false} onClose={() => {}} openSettings={() => {}} />)
    expect(container.firstChild).toBeNull()
  })

  it('Escape closes without triggering nav.up()', () => {
    const onClose = vi.fn()
    useNavStore.setState({ level: 'server' } as never)
    render(<AssistantView open={true} onClose={onClose} openSettings={() => {}} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
    expect(useNavStore.getState().level).toBe('server')
  })

  it('Enter sends, Shift+Enter does not', () => {
    render(<AssistantView open={true} onClose={() => {}} openSettings={() => {}} />)
    const textarea = screen.getByPlaceholderText(/Ask about/i)
    fireEvent.change(textarea, { target: { value: 'hello' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(useChatStore.getState().turns).toHaveLength(0)
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })
    expect(useChatStore.getState().turns.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 8: Run the new component test**

Run: `npx vitest run src/app/world/ai/AssistantView.test.tsx`
Expected: PASS (3 tests) — fix any import path mismatches against the actual `world.store.ts`/
`nav.store.ts`/`useCompiledWorld.ts` exports discovered while wiring this up (their exact
export names should be confirmed by reading those files, since this task assumes the
conventional `useWorldStore`/`useNavStore`/`useCompiledWorld` names used elsewhere in
`src/app/world/`).

- [ ] **Step 9: Run the whole suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src/app/world/ai/
git commit -m "feat: add the AI chat assistant overlay UI"
```

---

## Task 12: Wire into `WorldShell.tsx`

**Files:**
- Modify: `src/app/world/WorldShell.tsx`

**Interfaces:**
- Consumes: Task 11's `AssistantView`.

- [ ] **Step 1: Add local open-state and the header button**

Following the verified `connectionsOpen` precedent at line 41 and the `settings` header button at
line 139:
```tsx
const [chatOpen, setChatOpen] = useState(false)
```
```tsx
<button className="kit-press" style={hdrBtn} aria-label="ai assistant" onClick={() => setChatOpen(true)}>ai</button>
```
placed in the same header button cluster as the `settings` button (lines ~138-148).

- [ ] **Step 2: Mount the overlay beside `<ConnectionsView/>`**

Following the verified mount at line 181:
```tsx
<AssistantView open={chatOpen} onClose={() => setChatOpen(false)} openSettings={() => setSettingsOpen(true)} />
```
Add the import: `import { AssistantView } from './ai/AssistantView'`.

- [ ] **Step 3: Manually verify in the running app**

Run: `npm run tauri dev`
Build a small world (two regions, one undersized server placement), start the sim, click the new
"ai" header button, confirm the overlay opens, the composer accepts Enter-to-send, attachment
chips show token counts, and Escape closes the overlay without also navigating up a level.

- [ ] **Step 4: Run the whole suite and the build**

Run: `npx vitest run` then `npm run build`
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add src/app/world/WorldShell.tsx
git commit -m "feat: mount the AI chat assistant overlay from WorldShell"
```

---

## Task 13: Docs — `docs/module-boundaries.md` and `CLAUDE.md`

**Files:**
- Modify: `docs/module-boundaries.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add a new lettered section `Z` to `docs/module-boundaries.md`**

Append after the current last section (`Y`, ending around line 1864+its content). Cover: the new
`src/lib/aiChat/` module family and their single responsibilities (context digest, event
causality, prompt, citations, formatting); the `llmClient.ts` seam now shared by `llmReview.ts`
and the chat feature; the `scopeFilters.ts` move (`scopeData.ts` now re-exports from
`lib/world/scopeFilters.ts`); the `entityNav.ts` extraction and the ESM cycle it removed between
`AnalysisTab.tsx` and `AiReviewSection.tsx`; the deliberate no-`fieldset disabled={running}`
carve-out on `AssistantView.tsx` and why (read-only surface, mid-run diagnosis is the point).

- [ ] **Step 2: Fix the stale "13 rules" text**

In `docs/module-boundaries.md` at line 591, change `13 rules total across Tasks 1–3` to
`15 rules total across Tasks 1–3` (verified: 6 structural + 5 network + 4 capacity).

- [ ] **Step 3: Update `CLAUDE.md`**

- Line 53: change `capacity, 13 rules)` to `capacity, 15 rules)`.
- Add a sentence beside the LLM-reviewer bullet (current lines ~56-58) introducing the multi-turn
  AI chat assistant, its read-only guarantee, and its overlay surface.
- Extend the LLM key-security paragraph to state the API-key/no-raw-instance-map canary now also
  covers `src/lib/aiChat/context.ts`'s digest and attachment builders.
- In the Known Issues / Roadmap list: keep "AI watch-mode" parked as-is; rewrite "LLM review
  persistence/history" to state both surfaces (one-shot review AND multi-turn chat) are
  ephemeral, in-memory only, never serialized; extend the "Streaming LLM responses / request
  cancellation" bullet to note the chat assistant has a generation-counter **abandon** (in-flight
  result discarded on close/retry) but no true request cancellation, since `llm_chat` itself is
  un-abortable (60s fixed Rust-side timeout).

- [ ] **Step 4: Commit**

```bash
git add docs/module-boundaries.md CLAUDE.md
git commit -m "docs: document the AI chat assistant module boundaries and fix stale rule count"
```

---

## Verification Summary

After Task 13, run in order:
1. `npx vitest run` — full suite green, including every new test file above.
2. `npm run build` — clean type-check + build.
3. Manual end-to-end pass (Task 12 Step 3), plus: toggle the theme to `light` in Settings while
   the assistant overlay is open and confirm every color still reads correctly (no hardcoded hex
   anywhere in `src/app/world/ai/`).
4. `grep -rn "dangerouslySetInnerHTML" src/app/world/ai/` — expect zero matches.
