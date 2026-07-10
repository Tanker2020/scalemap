#!/usr/bin/env node
// scripts/llm-stub.mjs — OpenAI-compatible smoke stub for Phase 6's live review-with-retry story
// (spec D9). Usage: node scripts/llm-stub.mjs [port=4141]
//
// POST /v1/chat/completions: the FIRST request ever received returns a malformed content string
// (exercises llmReview.ts's one-shot retry live); every request after that returns a canned,
// valid, fenced `{ issues: [...] }` payload. CORS is wide-open (OPTIONS preflight +
// Access-Control-Allow-*) since the browser mock transport (tauriMock.ts's llm_chat) calls this
// via a direct fetch() from the webview/browser origin.
import http from 'node:http'

const port = Number(process.argv[2]) || 4141
let hitCount = 0

const CANNED_ISSUES = {
  issues: [
    {
      title: 'us-east-1a is a single point of failure for the web tier',
      severity: 'warning',
      confidence: 0.82,
      affected: ['az-us-east-1a'],
      reasoning: 'Every web instance resolved to one AZ; an AZ-level outage takes the whole tier down with no failover path.',
      recommendation: 'Spread web placements across at least two AZs in the region.',
      estimated_effort: 'medium',
    },
    {
      title: 'Database reachable from the public internet',
      severity: 'critical',
      confidence: 0.91,
      affected: ['srv-db-1'],
      reasoning: 'The firewall rule ahead of the db port allows source any, so the datastore is internet-facing.',
      recommendation: 'Restrict the db port to internal source CIDRs only; front it with the app tier.',
      estimated_effort: 'low',
    },
  ],
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      hitCount += 1
      console.log(`[llm-stub] hit #${hitCount}`)
      const content = hitCount === 1
        ? 'not json at all'
        : '```json\n' + JSON.stringify(CANNED_ISSUES) + '\n```'
      const body = JSON.stringify({ choices: [{ message: { content } }] })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(body)
    })
    return
  }

  res.writeHead(404)
  res.end()
})

server.listen(port, () => {
  console.log(`[llm-stub] listening on http://localhost:${port}/v1`)
})
