#!/usr/bin/env node
// Open (or close) World's 24-hour staging-verification window for our app, and store the token it
// issues in gate/.env as WORLD_STAGING_TOKEN — without ever printing a secret.
//
//   node gate/world-staging-window.mjs          open  (needs WORLD_TEAM_API_KEY in gate/.env)
//   node gate/world-staging-window.mjs close    close it early
//
// Why this exists: World's /api/v4/verify refuses staging (simulator) proofs with 403
// environment_not_allowed unless the app's team has opened this window; the only way to open it is
// the Developer Portal MCP tool `set_world_id_staging_verification`, authenticated with a TEAM API
// key (developer-portal web/api/mcp/index.ts, web/api/v4/verify/staging-access.ts).
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ENV = join(dirname(fileURLToPath(import.meta.url)), '.env')
const text = readFileSync(ENV, 'utf8')
const env = Object.fromEntries(text.split('\n').map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]))
const key = env.WORLD_TEAM_API_KEY
if (!key?.startsWith('api_')) throw new Error('Put the team API key (starts with api_) in gate/.env as WORLD_TEAM_API_KEY=')
const enabled = process.argv[2] !== 'close'

const r = await fetch('https://developer.world.org/api/mcp', {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'set_world_id_staging_verification', arguments: { app_id: env.WORLD_APP_ID, enabled } } }),
})
const raw = await r.text()
// The answer may arrive as plain JSON or as one SSE `data:` line.
const json = JSON.parse(raw.startsWith('{') ? raw : raw.split('\n').find((l) => l.startsWith('data:')).slice(5))
if (json.error || json.result?.isError) {
  console.error('✗ portal refused:', JSON.stringify(json.error ?? json.result?.content?.[0]?.text ?? json).slice(0, 300))
  process.exit(1)
}
const out = json.result?.structuredContent ?? JSON.parse(json.result?.content?.[0]?.text ?? '{}')
const token = out.staging_verification_token
const lines = text.split('\n').filter((l) => !l.startsWith('WORLD_STAGING_TOKEN='))
if (enabled && token) lines.push(`WORLD_STAGING_TOKEN=${token}`)
writeFileSync(ENV, lines.join('\n').replace(/\n*$/, '\n'))
console.log(enabled
  ? `✓ staging window OPEN until ${out.staging_verification_expires_at} — token saved to gate/.env (not shown)`
  : '✓ staging window closed; token removed from gate/.env')
