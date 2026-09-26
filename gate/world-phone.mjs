#!/usr/bin/env node
// World ID with a REAL phone — not the simulator. Runs the gate's own code (gate/world.mjs), the
// exact path a reader's proof takes in the extension:
//
//   gate signs an RP request → a QR in this terminal → you scan it with World App (or World's
//   Sandbox app for staging) → IDKit returns the proof → the gate checks nonce/action/signal/
//   credential, World's v4 verify API, and WorldIDVerifier on World Chain (≥2 RPCs agree)
//   → controls: the same proof replayed, and for a different reader, are both refused.
//
//   node gate/world-phone.mjs                   # Selfie Check, env from gate/.env
//   node gate/world-phone.mjs poh               # Proof of Human (needs an Orb-verified World ID)
//   node gate/world-phone.mjs identity:JPN      # Identity Check on nationality (passport; preview)
//   WORLD_ENV=production node gate/world-phone.mjs
//
// Prints no secret. The nullifier is shown truncated (it is a per-action pseudonym, not an identity).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { IDKit, proofOfHuman, selfieCheck, identityCheck } from '@worldcoin/idkit-core'
import QR from '../extension-everywhere/node_modules/qrcode/lib/index.js'
import { createWorld } from './world.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
for (const line of readFileSync(join(HERE, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}
// IDKit's ESM build loads its WASM by file:// URL, which Node's fetch cannot read — shim only that.
const realFetch = globalThis.fetch
globalThis.fetch = (u, ...r) => {
  const s = String(u?.url ?? u)
  if (s.startsWith('file:')) return Promise.resolve(new Response(readFileSync(new URL(s)), { headers: { 'content-type': 'application/wasm' } }))
  return realFetch(u, ...r)
}

const [preset, country] = (process.argv[2] ?? 'selfie').split(':')
if (!['poh', 'selfie', 'identity'].includes(preset) || (preset === 'identity' && !/^[A-Z]{3}$/.test(country ?? '')))
  throw new Error('usage: world-phone.mjs [selfie | poh | identity:<ISO alpha-3>]')
const env = process.env.WORLD_ENV ?? 'staging'
const world = createWorld({
  appId: process.env.WORLD_APP_ID, rpId: process.env.WORLD_RP_ID, env,
  signingKey: process.env.RP_SIGNING_KEY, stagingToken: process.env.WORLD_STAGING_TOKEN,
})
if (!world) throw new Error('gate/.env needs WORLD_APP_ID, WORLD_RP_ID and RP_SIGNING_KEY')
const say = (ok, m) => console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${m}`)

// One made-up post + reader, exactly as the extension would send them.
const ref = randomBytes(8).toString('hex')
const readerPub = randomBytes(32).toString('hex')
const state = new Map()
const q = world.challenge(ref, readerPub, state, preset, undefined, country)
const req = await IDKit.request({
  app_id: q.app_id, action: q.action, rp_context: q.rp_context, allow_legacy_proofs: false, environment: q.environment,
}).preset(preset === 'identity' ? identityCheck({ attributes: q.attributes }) : preset === 'selfie' ? selfieCheck({ signal: q.signal }) : proofOfHuman({ signal: q.signal }))

console.log(`World ID ${preset}${country ? ` (nationality ${country})` : ''} · env ${env} · app ${q.app_id} · action ${q.action}\n`)
console.log(await QR.toString(req.connectorURI, { type: 'terminal', small: true }))
console.log(`Scan with ${env === 'production' ? 'World App' : "World's Sandbox app"} (or open on the phone): ${req.connectorURI}\n`)

const t0 = Date.now()
let result
for (;;) {
  let s
  try {
    s = await req.pollOnce()
  } catch (e) {
    await new Promise((r) => setTimeout(r, 1500)) // network blips are common; keep polling
    continue
  }
  if (s.type === 'confirmed') { result = s.result; break }
  if (s.type === 'failed') { say(false, `World App: ${s.error}`); process.exit(1) }
  if (Date.now() - t0 > 5 * 60_000) { say(false, 'no answer from the phone in 5 minutes'); process.exit(1) }
  await new Promise((r) => setTimeout(r, 1500))
}
const r0 = result.responses?.[0] ?? {}
say(true, `proof received from the phone after ${((Date.now() - t0) / 1000).toFixed(0)}s — protocol ${result.protocol_version}, credential ${r0.identifier}, env ${result.environment ?? env}`)
if (preset === 'identity') say(result.identity_attested === true, `identity_attested = ${result.identity_attested}`)

const v = await world.verify(result, { ref, readerPub, preset, action: q.action }, state)
if (v.deny) { say(false, `gate refused: ${v.deny}`); process.exit(1) }
say(v.api === 'ok', `World v4 verify API: ${v.api === 'ok' ? 'success' : v.api}`)
say(true, `WorldIDVerifier on World Chain: ${v.verdicts.join(' / ')} (${env === 'production' ? '0x00000000009E00F9FE82CfeeBB4556686da094d7' : '0x703a6316c975DEabF30b637c155edD53e24657DB'})`)
say(true, `nullifier ${String(v.nullifier).slice(0, 12)}… — the gate's per-post (or per-space) pseudonym for this human`)

// controls — the gate must refuse these, or the ✓ above means nothing
const replay = await world.verify(result, { ref, readerPub, preset, action: q.action }, state)
say(/already used/.test(replay.deny ?? ''), `replaying the same proof is refused (${replay.deny})`)
const other = await world.verify(result, { ref, readerPub: randomBytes(32).toString('hex'), preset, action: q.action }, state)
say(!!other.deny, `the same proof for a different reader is refused (${other.deny})`)
process.exit(0)
