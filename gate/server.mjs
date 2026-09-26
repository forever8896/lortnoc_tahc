#!/usr/bin/env node
// HTTP around gate/core.mjs. Plain node:http + node:sqlite — no dependencies of its own.
//
//   GET  /health    → { ok, pub, checks, deposits }
//   POST /deposit   { check, params, box, policyHash }        → { ref }
//   POST /challenge { ref, readerPub, policyHash }            → { request } | { deny }   (World ID)
//   POST /release   { ref, readerPub, policyHash, proof?, memberPub? } → { box, member? } | { deny, retryAt? }
//   POST /space     { space, ownerPub, sig }                  → register a space to an owner key
//   POST /member/sign { space, memberId, contentHash, sig }   → { sig } gate attestation of a member's post
//   POST /ban       { space, memberId, sig, unban? }          → owner bans/unbans a member (by nullifier)
//
// Env: PORT (8790), GATE_DB (gate/.data/gate.sqlite), GATE_KEY (hex X25519 private key; if unset it
// is generated once and kept in the database), GATE_ORIGINS (comma list for CORS; default *).
//
// PRIVACY (PRD §8 Layer 4): request IPs are used for rate limiting in memory only and are never
// logged or stored.
import { createServer } from 'node:http'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, existsSync } from 'node:fs'
import { createGate } from './core.mjs'
import { createWorld } from './world.mjs'
import { createEnsSpaces } from './ens-spaces.mjs'
import { createHolders } from './holders.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 8790)
const DB = process.env.GATE_DB ?? join(HERE, '.data', 'gate.sqlite')
mkdirSync(dirname(DB), { recursive: true })
// gate/.env (gitignored) → process.env, without overriding what the environment already set.
if (existsSync(join(HERE, '.env'))) {
  for (const l of readFileSync(join(HERE, '.env'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && m[2] && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
}
const world = createWorld({
  appId: process.env.WORLD_APP_ID, rpId: process.env.WORLD_RP_ID, env: process.env.WORLD_ENV ?? 'staging',
  signingKey: process.env.RP_SIGNING_KEY, stagingToken: process.env.WORLD_STAGING_TOKEN,
  rpcs: process.env.WORLDCHAIN_RPCS?.split(','),
})
const ensSpaces = createEnsSpaces()
const gate = createGate({ dbPath: DB, keyHex: process.env.GATE_KEY, world, ensSpaces, holders: createHolders({ ensSpaces }) })
const ORIGINS = (process.env.GATE_ORIGINS ?? '*').split(',')

const WINDOW = 60_000, LIMIT = 60
const hits = new Map()
function limited(ip) {
  const now = Date.now()
  const h = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW)
  h.push(now)
  hits.set(ip, h)
  return h.length > LIMIT
}

const send = (res, status, body, origin) => {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': ORIGINS.includes('*') ? '*' : ORIGINS.includes(origin) ? origin : ORIGINS[0],
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  })
  res.end(JSON.stringify(body))
}

createServer(async (req, res) => {
  const origin = req.headers.origin
  if (req.method === 'OPTIONS') return send(res, 204, {}, origin)
  if (limited(req.socket.remoteAddress ?? '?')) return send(res, 429, { error: 'slow down' }, origin)
  try {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      return send(res, 200, { ok: true, pub: gate.pub, signPub: gate.signPub, checks: gate.checks, world: gate.world, deposits: gate.stats() }, origin)
    }
    if (req.method !== 'POST') return send(res, 404, { error: 'not found' }, origin)
    let raw = ''
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > 64_000) return send(res, 413, { error: 'too large' }, origin)
    }
    const body = JSON.parse(raw || '{}')
    if (req.url === '/deposit') return send(res, 200, gate.deposit(body), origin)
    if (req.url === '/challenge') return send(res, 200, await gate.challenge(body), origin)
    if (req.url === '/space') return send(res, 200, gate.spaces.register(body), origin)
    if (req.url === '/member/sign') return send(res, 200, await gate.spaces.attest(body), origin)
    if (req.url === '/ban') return send(res, 200, gate.spaces.ban(body), origin)
    // staging demo helper: the gate plays courier to World's simulator (see world.mjs simulate)
    if (req.url === '/dev/simulate') return send(res, 200, world ? await world.simulate(body.connectUrl) : { deny: 'no World ID' }, origin)
    if (req.url === '/release') return send(res, 200, await gate.release(body), origin)
    return send(res, 404, { error: 'not found' }, origin)
  } catch (e) {
    return send(res, e.status ?? 500, { error: e.status ? e.message : 'internal error' }, origin)
  }
}).listen(PORT, () => console.log(`lortnoc gate on :${PORT} — pub ${gate.pub.slice(0, 16)}…, checks ${gate.checks.join(', ')}`))
