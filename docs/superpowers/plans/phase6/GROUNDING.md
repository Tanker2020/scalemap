# Phase 6 GROUNDING — real-source facts + resolved decisions

Controller-authored (Opus) before dispatching fragment writers. Every signature below is
quoted/verified against real source at `main`/`phase6-analysis` HEAD (`ee51f6a`). Fragment
writers and implementers: treat this as authoritative for names/shapes. Where this file
resolves an ambiguity in the skeleton, the resolution is marked **DECISION** with rationale —
carry it verbatim; do not re-litigate.

Global truth: Phase 6 is a READ-ONLY consumer of the engine. **No edits under
`src/lib/worldEngine/` except T9's one-liner** (`export const MAX_GLOBE_ARCS`). No new npm
deps. The only new Rust dep is `reqwest` (T5). D6 key-security invariants are non-negotiable
(see the plan Global Constraints).

---

## A. World types (`src/lib/world/types.ts`) — verbatim shapes the rules read

```ts
type RegionId=string; AzId=string; ServerId=string; BlueprintId=string; PlacementId=string
type ManagedServiceId=string; PopulationId=string; InstanceId=string

RoutingConfig { policy:'latency'|'geo'|'weighted'|'priority'; weights:Record<RegionId,number>;
  priorityOrder:RegionId[]; healthCheckIntervalMs:number; healthCheckFailureThreshold:number;
  dnsTtlSec:number }
TrafficConfig { autoBaseline:boolean; baselineTotalRps:number }
ClientPopulation { id; label; lat; lon; peakRps; diurnal:'flat'|'day-night' }
Region { id; catalogId:string /* e.g. 'us-east-1' */; role:'active'|'passive' }
AvailabilityZone { id; label /* e.g. 'us-east-1a' */; regionId }
ServerSpecs { vcpu; threadsPerCore; ramMb; diskGb; nicMbps }
FirewallRule { id; action:'allow'|'deny'; port:number|'any'; protocol:'tcp'|'udp'|'any';
  source:'any'|'internal'|string /* CIDR */ }
Server { id; label; azId; kind:'dedicated'|'vps'; catalogId; specs:ServerSpecs; hourlyUsd;
  oversubscriptionRatio:number|null; burstable:boolean; firewall:FirewallRule[]; stacks; rack }
ServicePort { port:number; protocol:'tcp'|'udp'; visibility:'public'|'internal' }
WorkloadProfile { cpuMsPerRequest; ramBaseMb; ramPerConnMb; diskIoPerRequest }
DependencyTarget = { kind:'blueprint'; blueprintId } | { kind:'managed'; managedServiceId }
BlueprintDependency { id; target:DependencyTarget; port:number;
  protocol:'http'|'db'|'event'|'stream'; packetTemplateId:number|null }
ServiceBlueprint { id; name; color; workload:WorkloadProfile; ports:ServicePort[];
  dependencies:BlueprintDependency[]; stateful:boolean; volumeName:string|null }
PlacementRole = 'primary'|'replica'|'canary'
PlacementRuntime = { type:'process' } | { type:'container'; stackName; networkNames:string[];
  portMappings:{host;container}[]; cpuLimit:number|null; memLimitMb:number|null }
Placement { id; blueprintId; serverId; count:number; role:PlacementRole; runtime:PlacementRuntime }
ManagedService { id; label; nodeType:string; scope:{kind:'region';regionId}|{kind:'az';azId};
  provider:'generic'|'aws'|'gcp'|'azure'; port:number }
WorldDoc { routing; traffic; populations:Record<PopulationId,ClientPopulation>;
  regions:Record<RegionId,Region>; azs:Record<AzId,AvailabilityZone>;
  servers:Record<ServerId,Server>; blueprints:Record<BlueprintId,ServiceBlueprint>;
  placements:Record<PlacementId,Placement>; managedServices:Record<ManagedServiceId,ManagedService> }
```

### Compiled output (produced by `compileWorld(doc)`):
```ts
ServiceInstance { id:`${placementId}#${index}`; blueprintId; placementId; serverId; azId;
  regionId; role:PlacementRole; indexInPlacement }
BlockReasonKind = 'no-port-binding'|'firewall-deny'|'network-isolation'
BlockReason { kind:BlockReasonKind; detail:string; firewallRuleId:string|null }
PathTarget = { kind:'instance'; instanceId } | { kind:'managed'; managedServiceId }
CompiledPath { id:string; dependencyId; fromInstanceId; to:PathTarget;
  hopClass:'localhost'|'same-az'|'cross-az'|'cross-region'; verdict:'permitted'|'blocked';
  blockReason:BlockReason|null }
CompiledRouting { populationRegionOrder:Record<PopulationId,RegionId[]>;
  regionAzSpread:Record<RegionId,AzId[]>; azBlueprintTargets:Record<AzId,Record<BlueprintId,InstanceId[]>> }
CompileFinding { id:string; severity:'error'|'warning';
  kind:'blocked-path'|'stateful-without-volume'|'missing-volume'; message:string; affected:string[] }
CompiledWorld { instances:Record<InstanceId,ServiceInstance>; paths:CompiledPath[];
  routing:CompiledRouting; findings:CompileFinding[] }
```
- `compileWorld(doc)` and `instanceId(placementId,index)` are exported from
  `src/lib/world/compileWorld.ts`.
- **Blocked compile findings** have `id = `finding-${path.id}`` and `kind:'blocked-path'`
  (`compileWorld.ts:85`). This is the join key for T4 suppression (§ T4 below).

### MetricsBatch (from `src/lib/worldEngine/types.ts`) — the ONLY engine input Phase 6 reads:
```ts
ServerMetrics { serverId; coreUtilization:number[] /* per-vCPU 0..1 */; stealFraction;
  burstCredits:number|null; ramByInstance; ramUsedMb; ramTotalMb; nicInMbps; nicOutMbps;
  diskIoFraction; health }
RegionMetrics { regionId; rps; errorRate; p50Ms; healthScore; health; inboundByPopulation }
AzMetrics { azId; rps; errorRate; p50Ms; healthScore; health; serverCount; instanceCount }
WorldMetrics { totalRps; errorRate; populationRoutes; crossAzBytesPerSec; crossRegionBytesPerSec;
  internetEgressBytesPerSec }
MetricsBatch { simMs; instances:Record<InstanceId,InstanceMetrics>;
  servers:Record<ServerId,ServerMetrics>; azs:Record<AzId,AzMetrics>;
  regions:Record<RegionId,RegionMetrics>; world:WorldMetrics }
```

---

## B. Fixture-builder style (from `src/lib/worldEngine/index.test.ts`) — reuse verbatim

Factories in `src/lib/world/factories.ts` (import from there):
```ts
createWorld(): WorldDoc                      // routing.policy='latency', dnsTtlSec=30,
                                             // healthCheckIntervalMs=10_000, failureThreshold=3,
                                             // traffic.autoBaseline=true, baselineTotalRps=1000
createRegion(catalogId): Region              // role:'active'
createAz(regionId, label): AvailabilityZone
createServer(azId, preset): Server           // DEFAULT firewall = one rule:
   //   { action:'allow', port:'any', protocol:'any', source:'internal' }  ← source is 'internal', NOT 'any'
createBlueprint(name, colorIndex): ServiceBlueprint  // ports=[{port:8080,protocol:'tcp',visibility:'internal'}],
   //   workload={cpuMsPerRequest:5, ramBaseMb:128, ramPerConnMb:0.5, diskIoPerRequest:0}, stateful:false
createPlacement(blueprintId, serverId): Placement    // count:1, role:'primary', runtime:{type:'process'}
createPopulation(label, lat, lon): ClientPopulation  // peakRps:500, diurnal:'flat'
getPreset(id): InstancePreset | undefined    // from '../world/instanceCatalog'
```
Preset ids + `burstable`: `vps-small`(burstable **true**), `vps-medium`(**true**),
`aws-t3-medium`(**true**), `vps-large`(false), `aws-m7i-large`(false),
`gcp-e2-standard-4`(false), `dedicated-8`(false, ramMb 32768), `dedicated-16`, `dedicated-32`.
`vps-small` specs.ramMb=4096; `dedicated-8` specs.ramMb=32768.

Fixture assembly pattern:
```ts
const doc = createWorld(); doc.traffic.autoBaseline=false; doc.routing.policy='geo'
const r1=createRegion('us-east-1'); doc.regions[r1.id]=r1
const az=createAz(r1.id,'us-east-1a'); doc.azs[az.id]=az
const s1=createServer(az.id, getPreset('dedicated-8')!); doc.servers[s1.id]=s1
const web=createBlueprint('web',0); doc.blueprints[web.id]=web
const pl=createPlacement(web.id,s1.id); doc.placements[pl.id]=pl
const compiled = compileWorld(doc)
```
A publicBlueprint helper: `const bp=createBlueprint(n,i); bp.ports=[{port:8080,protocol:'tcp',visibility:'public'}]`.
Blueprint→blueprint dependency:
`web.dependencies=[{id:'d-api',target:{kind:'blueprint',blueprintId:api.id},port:8080,protocol:'http',packetTemplateId:null}]`.
`instanceId(pl.id, 0)` gives the first instance id of a placement.

Vitest test-file conventions in this repo:
- **Pure** rule tests (node env, no DOM): plain `import { describe, it, expect } from 'vitest'`, NO
  `@vitest-environment` pragma. Rule files import nothing from `app/` or the DOM.
- **Component** tests: first line `// @vitest-environment jsdom`, then
  `import { render, screen, fireEvent } from '@testing-library/react'`, `beforeEach(() =>
  useWorldStore.getState().newWorld())`. jest-dom matchers available.
- **Never** put a literal `@vitest-environment` string inside a comment mid-file — Vitest's pragma
  scanner mis-grabs it (Phase-5 T5 hit this). Keep the pragma only as the real first-line directive.

---

## C. Analysis module contract (T1) — exact

`src/lib/analysis/types.ts`:
```ts
import type { WorldDoc, CompiledWorld } from '../world/types'
import type { MetricsBatch } from '../worldEngine/types'
export type AnalysisFamily = 'structural' | 'network' | 'capacity'
export type AnalysisSeverity = 'critical' | 'warning' | 'info'
export interface AnalysisFinding {
  id: string           // `${ruleId}:${primaryAffectedId}` — stable across runs
  ruleId: string; family: AnalysisFamily; severity: AnalysisSeverity
  title: string; why: string; fix: string; affected: string[]  // most-specific first
}
export interface AnalysisInput { doc: WorldDoc; compiled: CompiledWorld; lastBatch: MetricsBatch | null }
export interface AnalysisRule { id: string; family: AnalysisFamily; run: (input: AnalysisInput) => AnalysisFinding[] }
```
`src/lib/analysis/runAnalysis.ts`:
```ts
export const ANALYSIS_RULES: AnalysisRule[]   // T1 seeds the 6 structural; T2 appends 3; T3 appends 4 — ONE array
export function runAnalysis(doc, compiled, lastBatch): AnalysisFinding[]
```
- `runAnalysis` builds `AnalysisInput` once, concatenates every rule's output, then sorts:
  severity rank `{critical:0,warning:1,info:2}`, then family rank `{structural:0,network:1,capacity:2}`,
  then `ruleId` lexicographic. Use a STABLE sort key (array `.sort` in V8 is stable; sort by a
  composed numeric+string comparator).
- **id convention when `affected` is empty** (e.g. `ttl-outlives-detection`): use a fixed suffix,
  `id = `${ruleId}:world``. **DECISION.** Otherwise `primaryAffectedId = affected[0]`.
- **DRY:** rules must not duplicate `compiled.findings` — the panel merges compile findings
  separately (D1/D4).

---

## D. T1 structural rules — resolved triggers

Read `compiled.instances` (Record) + `compiled.routing.populationRegionOrder` + `doc.blueprints`.

- **`single-az-region`** (warning): group `Object.values(compiled.instances)` by `regionId`.
  For a region with ≥1 instance and exactly ONE distinct `azId` across its instances → fire.
  `affected:[regionId, theAzId]`. why names the region catalogId + az label.
- **`no-failover-region`**: for each population, `order = compiled.routing.populationRegionOrder[popId]`;
  if `order.length === 1` → fire. `affected:[populationId, order[0]]`.
  **DECISION severity:** `Object.keys(doc.populations).length > 0 ? 'critical' : 'warning'` — matches
  skeleton "(warning; critical when the world has populations)". Because this rule is population-scoped
  it emits **critical** in practice; the ternary honors the literal text and is trivially tested (a
  population present ⇒ critical). why: "population <label> has only one region in its failover order".
- **`replicas-colocated`** (warning): for each stateful blueprint (`bp.stateful`), gather its instances
  from `compiled.instances`. Let primaries = instances with role 'primary', replicas = role 'replica'.
  Fire when ≥1 primary AND ≥1 replica AND **every** replica's `azId` equals the **first primary's**
  `azId`. `affected:[blueprintId, thatAzId, ...instanceIds]` (primary + replica instance ids).
  **DECISION:** use the first primary's azId as the reference; document the multi-primary simplification.
- **`dependency-cycle`** (critical): build bp→bp adjacency from `bp.dependencies` where
  `target.kind==='blueprint'`. DFS with white/gray/black coloring; on a back-edge (gray target) extract
  the cycle path. Canonicalize each cycle (rotate so lexicographically-smallest blueprintId is first),
  dedupe by joined string, emit ONE finding per distinct cycle. `affected:` cycle blueprintIds in order.
  id uses `affected[0]` (the smallest bp id after rotation) → stable.
- **`deep-sync-chain`** (warning): sub-graph of `http`/`db` dependency edges only (bp→bp). Find the
  LONGEST simple path (DFS with a visited set bounds it even under cycles). If its edge count ≥ 4
  (≥5 nodes) → fire ONE finding for the longest chain. `affected:` chain blueprintIds in path order.
  **DECISION:** ties broken by first-found; document. why states the chain length.
- **`unused-managed-service`** (info): a managed service id targeted by NO blueprint dependency
  (`no dep across all blueprints has target.kind==='managed' && managedServiceId===ms.id`) → fire.
  `affected:[managedServiceId]`.

Named tests: each rule `fires:` + `silent:` (12 min) + `runAnalysis orders by severity then family`
+ `finding ids stable across two runs`.

---

## E. T2 network/security rules — resolved triggers

Firewall helper in `src/lib/world/network.ts`: `evaluateFirewall(rules, port)` returns
`{allowed, matchedRuleId}` but it **ignores `source`** (Phase-1 treats all in-world traffic as
internal). The T2 rules that need internet exposure must consider `source`, so they **replicate a
source-aware first-match loop** (state this in the plan; do NOT change network.ts). First-match-wins
means: iterate rules in array order; a rule "matches" when `(rule.port==='any'||rule.port===port)`
AND `(rule.protocol==='any'||rule.protocol==='tcp')`; the FIRST matching rule decides.

- **`blocked-dependency-path`** (critical): ONE finding per `compiled.paths` entry with
  `verdict==='blocked'`. **DECISION id:** `blocked-dependency-path:${path.id}` — embeds the full
  compiled path id so T4 suppresses the raw compile duplicate (compile id `finding-${path.id}`).
  `affected:[path.fromInstanceId, targetInstanceId, targetServerId]` where
  `targetInstanceId = path.to.instanceId` (blocked paths always target an instance; managed paths are
  always permitted) and `targetServerId = compiled.instances[targetInstanceId].serverId`.
  **fix body from `path.blockReason.kind`:**
  - `firewall-deny` → name `blockReason.firewallRuleId` + the target server label; say "add an allow
    rule above it in the server's firewall (Server view → firewall)".
  - `no-port-binding` → say the target does not bind/publish the port (quote `blockReason.detail`);
    fix names the missing host-port mapping / port binding.
  - `network-isolation` → name the compose-network mismatch (quote `blockReason.detail`).
- **`db-port-exposed`** (critical): TWO sub-conditions, each can fire:
  (a) any `db`-protocol dependency (`dep.protocol==='db'`) targeting a blueprint; for each instance of
      that target blueprint, evaluate the instance's server firewall first-match-wins for `dep.port`
      considering source: if the first matching rule has `action==='allow' && source==='any'` → exposed.
      `affected:[serverId, matchedRuleId]`. (One finding per exposed server; dedupe by serverId+ruleId.)
  (b) a blueprint that is the target of ANY `db`-protocol dependency and itself declares a port with
      `visibility==='public'` → `affected:[blueprintId]`.
  **DECISION:** de-dupe findings by their `affected[0]` so (a) and (b) don't double-count the same id.
- **`entry-unreachable`** (warning): a blueprint with a `public` port (`ports.some(p=>p.visibility==='public')`)
  that has ≥1 hosting server (a server running one of its instances) but NONE of those servers' firewalls
  allow that public port first-match-wins with `source==='any'` → fire. `affected:[blueprintId, ...serverIds]`
  (the hosting servers). Because the default server firewall uses `source:'internal'` (not `'any'`), a
  public blueprint on a default server IS unreachable from the internet — this is the intended, testable
  behavior. Making it reachable requires an explicit `source:'any'` allow (which then also makes a db
  target trip `db-port-exposed`).

Named tests: 3×(fires/silent) + `blocked-path fix body names the denying rule` +
`db exposure via public visibility fires without a firewall hole`.

---

## F. T3 capacity/geo rules — resolved triggers

- **`ram-oversubscribed`** (warning): per server, sum over resident instances
  (`compiled.instances` where `serverId===server.id`) of
  `(placement.runtime.type==='container' && runtime.memLimitMb!=null ? runtime.memLimitMb :
    doc.blueprints[inst.blueprintId].workload.ramBaseMb)`. If the sum `> server.specs.ramMb` → fire.
  `affected:[serverId, ...instanceIds]`. why includes BOTH numbers (sum vs ramMb).
- **`burstable-sustained-load`** (warning; REQUIRES `lastBatch`, silent when null): for each server with
  `server.burstable===true`, read `lastBatch.servers[server.id]`; if present and
  `mean(coreUtilization) > 0.4` → fire. `affected:[serverId]`. Skip entirely if `lastBatch===null`.
- **`ocean-crossing-population`** (warning): only when `Object.values(doc.regions).length >= 2`. For each
  population with a non-empty `populationRegionOrder`, let `first = order[0]`. Compute distances with
  **`greatCircleKm` imported from `../../world/regionGeo`** (lib→lib; see DECISION below) using
  `REGION_GEO[region.catalogId]`. `firstKm = gc(pop.lat,pop.lon, geo[first])`; `nearestKm = min over all
  world regions`. If `firstKm > 1.5 * nearestKm` (and nearest !== first) → fire.
  `affected:[populationId, firstRegionId, nearestRegionId]`. Skip regions whose catalogId is missing from
  REGION_GEO (defensive).
  **DECISION (deviates from skeleton wording):** the skeleton says "implement a local `haversineKm`…the
  globe's `geo.ts` is app-layer; lib must not import from app." But the actual haversine already lives in
  **`src/lib/world/regionGeo.ts` as the exported `greatCircleKm`** (lib-layer, already imported by
  `src/lib/world/routing.ts:6`). Reusing it satisfies design D2's "reuse the haversine already implicit in
  `regionGeo`" and "pick ONE distance source and cite it" while avoiding a DRY-violating duplicate. So
  T3 imports `REGION_GEO, greatCircleKm` from `../../world/regionGeo` — NOT a local copy, NOT app-layer
  `geo.ts`. Cite `regionGeo.greatCircleKm` as the single distance source.
  Verified: `greatCircleKm(40.7,-74, 51.5,-0.1) = 5572.8 km` (skeleton's "NYC→London ≈ 5570 ±2%" ✓).
  Testable fire: a London population (51.5,-0.1) with routing that puts `us-east-1`(5930km) first vs
  nearest `eu-west-1`(465km) → ratio 12.7 > 1.5.
- **`ttl-outlives-detection`** (warning): fire when
  `routing.dnsTtlSec*1000 < routing.healthCheckIntervalMs * routing.healthCheckFailureThreshold`.
  `affected:[]` → id `ttl-outlives-detection:world`. why shows both sides with units
  ("DNS TTL 5000ms < detection 30000ms"). Default world (30_000 vs 30_000) is NOT `<` → silent; set
  `dnsTtlSec=5` to fire.

Named tests: 4×(fires/silent) + `burstable rule silent with null batch` +
`haversine sanity (NYC→London ≈ 5570km ±2%)` (call `greatCircleKm` directly).

---

## G. T4 Analysis tab — resolved wiring

- `AnalysisTab()`:
  ```ts
  const doc = useWorldStore(s=>s.doc)
  const compiled = useCompiledWorld()   // app/world/useCompiledWorld.ts → memoized compileWorld(doc)
  const displayBatch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const findings = useMemo(() => runAnalysis(doc, compiled, displayBatch), [compiled, displayBatch?.simMs])
  ```
- Sections in order: `structural`, `network`, `capacity` (each only when it has findings; family heading
  + findings already severity-sorted by runAnalysis), then a `compile` section =
  `unsuppressedCompileFindings(findings, compiled.findings)`.
- **Suppression (D4):** a compile finding with `kind==='blocked-path'` and `id===`finding-${pathId}``
  is suppressed iff some analysis finding has `id===`blocked-dependency-path:${pathId}``. Implement as an
  exported pure helper in AnalysisTab.tsx:
  ```ts
  export function unsuppressedCompileFindings(analysis: AnalysisFinding[], compile: CompileFinding[]): CompileFinding[]
  ```
  (strip the `finding-` prefix from the compile id to get pathId; check the analysis id set). **Both**
  AnalysisTab (render) and WorldPanel (tab count) call this — one helper, no duplication.
- **Finding row:** severity chip color — critical→`var(--color-danger)`, warning→`var(--color-warning)`,
  info→`var(--color-text-muted)`. title (primary text), why (secondary), fix (muted, prefixed `→ `),
  then affected ids as clickable chips.
- **`navigateToEntity(id, doc, compiled, nav)`** exported, `nav` injected `{goRegion, goAz, goServer}`:
  ```ts
  if (doc.regions[id]) { nav.goRegion(id); return true }
  if (doc.azs[id]) { nav.goAz(doc.azs[id].regionId, id); return true }
  if (doc.servers[id]) { const az=doc.azs[doc.servers[id].azId]; if(az){ nav.goServer(az.regionId, az.id, id); return true } }
  const inst = compiled.instances[id]; if (inst) { nav.goServer(inst.regionId, inst.azId, inst.serverId); return true }
  return false   // blueprint/placement/population/managed → chip renders, title 'edit via panels', no-op
  ```
  Real nav signatures: `goRegion(regionId)`, `goAz(regionId, azId)`, `goServer(regionId, azId, serverId)`
  (`src/app/store/nav.store.ts`). In the tab, chips call `navigateToEntity(id, doc, compiled, useNavStore.getState())`.
- **WorldPanel.tsx changes:** rename tab id `findings`→`analysis`; label
  `Analysis (${analysisCount + unsuppressedCompileCount})`; remove the inline findings JSX (moves into
  AnalysisTab); render `{tab==='analysis' && <AnalysisTab openSettings={openSettings} />}` (openSettings
  prop is added in T8 — in T4, AnalysisTab takes no props yet; T8 adds `openSettings`). For the label
  count in T4, WorldPanel imports `runAnalysis` + `unsuppressedCompileFindings` and computes the merged
  count via useMemo. The `Tab` union: replace `'findings'` with `'analysis'`.
- **WorldPanel.test.tsx** (2 tests) needs updating: click target `Analysis (\d+)` instead of
  `Findings (\d+)`; the stateful-without-volume message still renders (it's an unsuppressed compile
  finding shown in the compile section). Empty-state test: `Analysis (0)` + an empty-state string
  (keep AnalysisTab's own empty text, e.g. "No findings — the compiled world is clean.").

Named jsdom tests (AnalysisTab.test.tsx): `groups findings by family with severity ordering`;
`affected chip navigates to a server`; `instance chip navigates to its server's interior`;
`blueprint chip does not navigate`; `compile duplicate suppressed when blocked-dependency-path covers
the same path id`; `tab label counts merged findings`.

Live smoke (controller): a world tripping ≥4 rules across families → grouped tab → chips navigate.

---

## H. T5 Rust + TS transport — resolved

`src-tauri/src/commands.rs` (append; mirror the `recent_files.json` app-data-dir pattern already there —
`app.path().app_data_dir()`, `fs::create_dir_all`, `serde_json`):
```rust
const LLM_SETTINGS_FILE: &str = "llm_settings.json";
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LlmSettings { pub base_url: String, pub api_key: String, pub model: String }
fn redact(msg: &str, key: &str) -> String   // replace every occurrence of `key` with "•••";
                                             // keys < 8 chars are masked entirely (return msg with
                                             // any occurrence replaced; short/empty key ⇒ do NOT leak).
                                             // Pure, unit-tested. Guard empty key (no-op replace of "").
#[tauri::command] pub fn save_llm_settings(app: AppHandle, settings: LlmSettings) -> Result<(), String>
#[tauri::command] pub fn load_llm_settings(app: AppHandle) -> LlmSettings   // Default::default() on ANY error
#[tauri::command] pub async fn llm_chat(base_url: String, api_key: String, body: String) -> Result<String, String>
   // reqwest client (rustls), POST {base_url}/chat/completions,
   // header Authorization: Bearer <api_key>, .body(body).header(content-type application/json),
   // timeout 60s; returns resp.text() for ANY status (frontend reads OpenAI error JSON itself);
   // Err only on transport failure — the error string passes through redact(msg, &api_key).
```
`src-tauri/src/lib.rs`: add the 3 commands to `generate_handler![…]`.
`src-tauri/Cargo.toml` `[dependencies]`: add
`reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }`.

**Tauri v2 casing (VERIFIED via tauri-macros source, context7):** command SCALAR arg names default to
camelCase on the JS side (`base_url`↔`baseUrl`, `api_key`↔`apiKey`); struct FIELDS go through serde with
their Rust names (no Tauri casing). So:
- `llmChat` wrapper calls `invoke('llm_chat', { baseUrl, apiKey, body })` — Tauri maps to snake params.
- `LlmSettings` struct stays snake_case (default serde) ⇒ the TS wrapper does explicit snake↔camel mapping:
  save sends `{ settings: { base_url, api_key, model } }`; load returns `{ base_url, api_key, model }` and
  the wrapper maps back to camel `{ baseUrl, apiKey, model }`. The saved file `llm_settings.json` therefore
  holds snake_case keys (consistent with `recent_files.json`).

`src/lib/tauri.ts` additions (mock mirrors with localStorage + direct fetch):
```ts
export interface LlmSettings { baseUrl: string; apiKey: string; model: string }
export async function saveLlmSettings(s: LlmSettings): Promise<void>
   //  invoke('save_llm_settings', { settings: { base_url: s.baseUrl, api_key: s.apiKey, model: s.model } })
export async function loadLlmSettings(): Promise<LlmSettings>
   //  const r = await invoke<{base_url;api_key;model}>('load_llm_settings');
   //  return { baseUrl: r.base_url ?? '', apiKey: r.api_key ?? '', model: r.model ?? '' }
export async function llmChat(baseUrl: string, apiKey: string, body: string): Promise<string>
   //  invoke('llm_chat', { baseUrl, apiKey, body })
```
Note the existing `invoke` (`src/lib/tauri.ts`): real path passes the `args` object to Tauri; MOCK path
does `Object.values(args)` **positionally** — so mock functions receive values in object-key order.
Keep the wrapper's arg-object key order matching the mock signature.

`src/lib/tauriMock.ts` additions (browser-dev only; localStorage key e.g. `scalemap:llm_settings`, and a
direct `fetch()` for `llm_chat` since the user controls CORS for local stubs):
```ts
async save_llm_settings(settings) { localStorage.setItem('scalemap:llm_settings', JSON.stringify(settings)) }
async load_llm_settings() { try { return JSON.parse(localStorage.getItem('scalemap:llm_settings')??'') } catch { return {base_url:'',api_key:'',model:''} } }
async llm_chat(baseUrl, apiKey, body) { const r = await fetch(`${baseUrl}/chat/completions`,
   { method:'POST', headers:{'content-type':'application/json','authorization':`Bearer ${apiKey}`}, body }); return r.text() }
```
**D6 in the mock too:** the mock stores the settings object to localStorage (browser dev only) but must
NEVER write it into `world.store`/serializer and must NEVER `console.*` the key.

Rust tests (`cargo test`, colocated `#[cfg(test)] mod tests` in commands.rs): `redact masks the key
everywhere and short keys entirely`; `settings serde round-trip`; `llm_chat returns body from a
TcpListener stub and redacts the key from connection-refused errors`. For the async test use
`#[tokio::test]` if the project already pulls tokio via tauri's default runtime — VERIFY what compiles
(`tauri::async_runtime::block_on` is the dependency-free fallback). TS test (jsdom): mock wrappers
round-trip localStorage (camel in, camel out; assert the stored JSON has NO forbidden shape leak).

---

## I. T6 review client (`src/lib/llmReview.ts`) — resolved

```ts
import type { WorldDoc, CompiledWorld } from './world/types'
import type { MetricsBatch } from './worldEngine/types'
import type { AnalysisFinding } from './analysis/types'
import { llmChat, type LlmSettings } from './tauri'
export interface AiIssue { title; severity:'critical'|'warning'|'info'; confidence:number;
  affected:string[]; reasoning; recommendation; estimated_effort:'low'|'medium'|'high' }
export function buildReviewContext(doc, compiled, findings:AnalysisFinding[], lastBatch:MetricsBatch|null): string
export function validateReviewResponse(raw: string): AiIssue[]
export function requestReview(settings:LlmSettings, context:string, chat?: typeof llmChat): Promise<AiIssue[]>
export function pingLlm(settings:LlmSettings, chat?: typeof llmChat): Promise<void>
```
- `buildReviewContext` → JSON string of `{ world: doc, deterministicFindings:
  [{ruleId,severity,title,affected}], compileFindings:[{kind,severity,message}], metrics: null | { world:
  {totalRps, errorRate}, regions:[{id,rps,errorRate,p50Ms,health}], azs:[{id,rps,errorRate,p50Ms,health}] } }`.
  **NEVER** include `lastBatch.instances`/`servers` maps or any settings value. (D6: `apiKey` is not in
  `doc`, so it can't leak — but the test asserts a stringify scan with a canary key finds nothing.)
- `validateReviewResponse(raw)`: `raw` is the assistant MESSAGE CONTENT string (not the HTTP envelope).
  Tolerate a ```json … ``` fence (strip it). Parse JSON; require `{ issues: [...] }`; map each to AiIssue
  with clamps: severity ∉ {critical,warning,info} → 'info'; confidence → `Math.max(0,Math.min(1,Number))`
  (NaN → 0); affected → keep only strings; estimated_effort ∉ {low,medium,high} → 'medium'. Throw
  `new Error('malformed review response')` when not parseable / not `{issues:[]}`-shaped.
- `requestReview`: build body `{ model: settings.model, response_format:{type:'json_object'}, messages:[
  {role:'system', content:<system prompt with the schema inlined>}, {role:'user', content} ] }`; call
  `chat(settings.baseUrl, settings.apiKey, JSON.stringify(body))`; parse the OpenAI envelope: if
  `parsed.error` → `throw new Error(parsed.error.message ?? 'LLM error')`; else content =
  `parsed.choices[0].message.content`; `validateReviewResponse(content)`. On validate failure: ONE retry
  appending a corrective system message (e.g. "Your previous reply was not valid JSON. Respond ONLY with
  the JSON object."), re-call, re-validate; if it fails again, rethrow the error. `chat` defaults to the
  T5 `llmChat` wrapper (injectable for tests). System prompt: senior infra architect; respond ONLY with
  JSON matching the schema; treat the deterministic findings as known context, don't repeat them verbatim.
- `pingLlm`: body `{ model, max_tokens:1, messages:[{role:'user', content:'ping'}] }`; call chat; resolve
  on any HTTP text (a reachable endpoint), throw a redact-safe error on transport failure.

Named tests (mock `chat`, node env): `context contains no apiKey value` (canary); `context aggregates
region metrics and omits instance maps`; `happy path parses fenced json`; `malformed then valid succeeds
via one retry with corrective message appended`; `two malformed responses throw gracefully`; `error
envelope surfaces provider message`; `severity/confidence/effort clamping`; `ping sends max_tokens 1`.

---

## J. T7 Settings modal + theme — resolved

Theme system is fully wired (NO new plumbing): `useUiStore(s=>s.themeMode)` / `setThemeMode(mode)`
(`src/app/store/ui.store.ts`, persists to localStorage `scalemap-theme-mode`); `App.tsx`'s
`useThemeBootstrap` applies `--color-*` tokens + `document.documentElement.dataset.theme` on themeMode
change. So the toggle only calls `setThemeMode` — effect is immediate.
```tsx
export interface SettingsModalProps { open: boolean; onClose: () => void }
export function SettingsModal(props): ReactElement | null   // returns null when !open
```
- Portal (`createPortal` to `document.body`), `position:fixed` backdrop `rgba(0,0,0,0.55)`, centered
  ~420px surface, token-styled (`var(--color-surface)`, `var(--color-node-border)`, etc.). All new UI uses
  `var(--color-*)` tokens ONLY (theme is live now).
- **Esc/backdrop close WITHOUT nav change.** WorldShell's key handler is a `window` bubble-phase listener
  that bails on `e.defaultPrevented` and calls `useNavStore.getState().up()` on Escape. So the modal
  registers its own `window` keydown listener in **capture phase** while open; on Escape it calls
  `e.stopPropagation()` + `e.preventDefault()` + `onClose()` (preventDefault makes the shell handler bail
  as a belt-and-suspenders — the Phase-3 inspector used this exact mechanism). Backdrop click closes;
  clicks inside the surface `stopPropagation`.
- **APPEARANCE:** segmented `dark | light` control reflecting `useUiStore(s=>s.themeMode)`; clicking a
  segment calls `setThemeMode('dark'|'light')`.
- **AI REVIEW:** on open, `loadLlmSettings()` into local state; `baseUrl` text input (placeholder
  `https://api.openai.com/v1`); `apiKey` `type=password` — after a saved key exists, render placeholder
  `•••• <last4>` and only overwrite the stored value when the user types a NEW value (empty input on save
  ⇒ keep existing key); `model` text input (placeholder `gpt-4o-mini`); `Save` → `saveLlmSettings`;
  `Test connection` → `pingLlm(settings)` with inline ok/error (error text shown as-is — already redacted
  upstream). The masked key must NEVER be echoed into the input `value` (value stays '' until typed).
- WorldShell: add a ⚙ ghost button as the FIRST child of the right-side header
  `<div style={{display:'flex',alignItems:'center',gap:8}}>` (i.e. right of `<SimControls/>`, left of the
  esc hint), styled like `hdrBtn`; local `const [settingsOpen,setSettingsOpen]=useState(false)`; render
  `<SettingsModal open={settingsOpen} onClose={()=>setSettingsOpen(false)} />`.

Named jsdom tests: `theme toggle reflects and sets themeMode`; `esc closes without changing nav level`;
`saved key renders masked and is not echoed into the input value`; `save dispatches saveLlmSettings with
typed values`; `test connection surfaces ping success and failure`. (Mock the tauri wrappers.)

Live smoke: gear opens modal; theme flips the ENTIRE app light and back live (screenshots); settings
persist across reload (mock localStorage path).

---

## K. T8 AI review section + stub — resolved

```tsx
export function AiReviewSection(props: { openSettings: () => void }): ReactElement
```
- States: `unconfigured` (loadLlmSettings baseUrl empty) → hint + an "open Settings" link (calls
  `props.openSettings`); `idle` → `Review architecture` button; `in-flight` → disabled + `reviewing…`;
  `done` → AiIssue cards; `error` → inline `var(--color-danger)` text, **previous cards retained**.
- Violet AI chip: **import `CATEGORY_COLORS` from `../../lib/theme` and use `CATEGORY_COLORS.messaging.accent`**
  (`#9C8CE0`) — a local `#A78BFA` const is FORBIDDEN (Global Constraints).
- Review click: `buildReviewContext(doc, compiled, currentAnalysisFindings, displayBatch)` →
  `requestReview(settings, context)`. Cards render: AI chip, title, severity chip, `${Math.round(conf*100)}%`,
  reasoning, recommendation (`→ ` prefixed), effort tag, affected chips via T4's `navigateToEntity`.
- Mount at the TOP of `AnalysisTab`. `AnalysisTab` gains an `openSettings` prop; WorldPanel threads it;
  WorldShell passes `openSettings={()=>setSettingsOpen(true)}` (the SAME state the gear opens). Plain prop
  chain: WorldShell → WorldPanel → AnalysisTab → AiReviewSection. So in T8, WorldPanel & AnalysisTab gain
  an `openSettings` prop (T4 created AnalysisTab without it; T8 adds it).
- `currentAnalysisFindings` = the `runAnalysis(...)` result AnalysisTab already computes; pass it down or
  recompute in the section — prefer passing from AnalysisTab to avoid a second run.

`scripts/llm-stub.mjs` — `node scripts/llm-stub.mjs [port=4141]`, ~40 lines, stdlib `http` only:
`POST /v1/chat/completions` + CORS (`OPTIONS` preflight + `Access-Control-Allow-Origin/Methods/Headers`).
FIRST request → `choices[0].message.content = 'not json at all'` (exercises the retry); every LATER request
→ a canned valid `{ issues:[ …2 plausible issues whose affected reference plausible entity ids… ] }` inside
a ```json fence. Log each hit (proves the two-hit retry live).

Named jsdom tests (mock the llmReview module): `unconfigured state links to settings`; `review renders
cards on success`; `error keeps prior cards and shows message`; `in-flight disables the button`;
`card affected chip navigates`.

Live smoke (browser mock transport): start stub; configure `http://localhost:4141/v1` via Settings;
Review → stub log shows TWO hits (retry) → cards render beside deterministic findings; save the world +
grep the `.scalemap` (localStorage mock) for the key → ABSENT. Stop the stub.

---

## L. T9 final — carry-forwards + docs

- **MAX_GLOBE_ARCS:** `src/lib/worldEngine/index.ts:43` `const MAX_GLOBE_ARCS = 200` → change to
  `export const MAX_GLOBE_ARCS = 200` (the ONLY sanctioned worldEngine edit this phase). Then
  `src/app/world/globe/ArcsLayer.tsx:22` deletes its local `const MAX_GLOBE_ARCS = 200` and imports it
  from the engine index (`import { MAX_GLOBE_ARCS } from '../../../lib/worldEngine'` — verify the barrel
  re-exports it; the engine facade is imported elsewhere as `../../../lib/worldEngine`).
- **Population default-label collision:** `TrafficPanel.tsx:80` (`pop-${populations.length+1}`) and
  `GlobeView.tsx:53` (`pop-${populationCount+1}`) both use independent length counters → duplicate labels
  after remove+re-add. Add a shared max-suffix helper (scan existing `pop-N` labels, next = max+1) used by
  both. Put it where both can import (a small `src/lib/world/populationLabel.ts` or reuse an existing util —
  writer picks a lib-layer home so both app files can import; document the choice).
- **GlobeScene texture mutation:** `src/app/world/globe/GlobeScene.tsx:63` runs the texture wrap/offset
  mutation in a `useMemo` (side-effect) → move to `useLayoutEffect` (idempotent; conventional home). Keep
  `texture.needsUpdate=true`.
- **buildDrainArcs missing-geo fallback test:** add a test to `src/lib/worldEngine/globeArcs.test.ts` for
  the `?? [pop.lat,pop.lon]` fallback path (a prev region whose catalogId lacks REGION_GEO). This is a
  TEST-ONLY addition to an existing test file (not a worldEngine source edit).
- **CLAUDE.md rewrite** (Project Overview / Architecture / Key Decisions / Diagram File Format): describe
  the world-model app — 4-level nav (globe/region/az/server), `world/` + `worldEngine/` + `analysis/`
  modules, `compileWorld` gate, engine facade + stores, packet system's CURRENT role, `.scalemap` v2, LLM
  reviewer + key-security note. Keep Commands / Design System / Key Dependencies but UPDATE the dep table:
  add `three`/`@react-three/fiber`/`@react-three/drei`, remove `dagre`/lint/ScaleScript/Terraform mentions.
  Roadmap → the umbrella §9 parked list.
- **`docs/module-boundaries.md` §O:** analysis + llm + settings modules; boundary rules
  (`lib/analysis` imports world+worldEngine TYPES only, no app; `llmReview` imports the tauri wrappers;
  settings NEVER touch world.store/serializer; key-security invariants restated).

Done bar for T9: full suite + `npm run build` + `cargo build` + `cargo test` green; the phase-gate live
story (rules → navigation → stub review with retry → masked key → no key in saved file → LIVE THEME FLIP
with a screenshot pass over globe/region/AZ/server in light mode, fixing straggler hexes); ledger
`## PHASE 6` summary + REBUILD-COMPLETE note.

---

## M. Cross-task seams (must line up)

- T2/T3 rules are appended to T1's single `ANALYSIS_RULES` array (import their rule objects into
  `runAnalysis.ts` and spread them in — keep ONE array).
- T4 imports `runAnalysis` + `AnalysisFinding` from `../../lib/analysis` (barrel or direct).
- T6's `LlmSettings` type = T5's `src/lib/tauri.ts` export (import it, don't redefine).
- T8 imports T4's `navigateToEntity` and T6's `buildReviewContext`/`requestReview`.
- T7 & T8 share the `settingsOpen` state in WorldShell via the `openSettings` prop chain.
- Security: key never in `.scalemap` (settings live outside world.store/serializer), never logged,
  never in review-context, redacted in every error, rendered masked, input type=password. Every task that
  can assert one of these, must (canary scan in T6, redact test in T5, masked-render test in T7, saved-file
  grep in T8).
