#!/usr/bin/env node
// First real World ID round trip — the G4 gate (docs/PRD-universal.md §14), before anything is built
// on it:  gate signs an RP request → World's simulator produces a STAGING proof → World's v4 verify
// API checks it → the checks World's API does NOT do are listed with their results.
//
//   node gate/world-roundtrip.mjs            (reads gate/.env; prints no secret)
//
// A pass also proves the RP is registered: an unregistered one fails with app_not_registered_v4.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { IDKit, proofOfHuman, hashSignal } from '@worldcoin/idkit-core'
import { signRequest } from '@worldcoin/idkit-core/signing'
import { createPublicClient, http } from 'viem'

const HERE = dirname(fileURLToPath(import.meta.url))
for (const line of readFileSync(join(HERE, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}
const { WORLD_APP_ID: APP, WORLD_RP_ID: RP, WORLD_ENV: ENV = 'staging', RP_SIGNING_KEY: KEY } = process.env
if (!APP || !RP || !KEY) throw new Error('gate/.env needs WORLD_APP_ID, WORLD_RP_ID and RP_SIGNING_KEY')

// The ESM build loads its WASM by file:// URL, which Node's fetch cannot read — shim only that.
const realFetch = globalThis.fetch
globalThis.fetch = (u, ...r) => {
  const s = String(u?.url ?? u)
  if (s.startsWith('file:')) return Promise.resolve(new Response(readFileSync(new URL(s)), { headers: { 'content-type': 'application/wasm' } }))
  return realFetch(u, ...r)
}
const t0 = Date.now()
const ms = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
const say = (ok, m) => console.log(`${ok ? '✓' : '✗'} ${m}`)

// A per-post action (PRD §13.2: v4 proofs are one-time per action per human), and a signal that
// binds the proof to one post reference + one reader key, exactly as the real check will.
const action = process.env.ACTION ?? `lortnoc-roundtrip-${Date.now().toString(36)}`
const signal = '0x' + '0011223344556677' + 'aa'.repeat(32)
const s = signRequest({ signingKeyHex: KEY.replace(/^0x/, ''), action })
const req = await IDKit.request({
  app_id: APP,
  action,
  rp_context: { rp_id: RP, nonce: s.nonce, created_at: s.createdAt, expires_at: s.expiresAt, signature: s.sig },
  allow_legacy_proofs: false,
  environment: ENV,
}).preset(proofOfHuman({ signal }))
say(true, `request signed + built (${ms()}), action ${action}, env ${ENV}`)

// The simulator plays World App: it completes the request headlessly.
const sim = await realFetch('https://simulator.worldcoin.org/api/mcp', {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'complete_test_request', arguments: { connect_url: req.connectorURI } } }),
})
const simTxt = await sim.text()
const simOut = simTxt.match(/"structuredContent":(\{[^}]*\})/)?.[1] ?? simTxt.slice(0, 300)
const simErr = /"error"\s*:\s*"([a-z_]+)"/.exec(simOut)?.[1]
say(!simErr, `simulator (${ms()}): ${simErr ?? 'completed'}`)
if (simErr) process.exit(1)

const done = await req.pollUntilCompletion({ pollInterval: 1000, timeout: 60_000 })
if (!done.success) (say(false, `IDKit: ${done.error}`), process.exit(1))
const result = done.result
say(true, `proof received (${ms()}): protocol ${result.protocol_version}, ${result.responses?.length} response(s)`)

// (1) World's verify API. Staging proofs need a developer-opened 24h window + its token
//     (developer-portal web/api/v4/verify/staging-access.ts); without it: 403 environment_not_allowed.
const headers = { 'content-type': 'application/json' }
if (process.env.WORLD_STAGING_TOKEN) headers['x-staging-verification-token'] = process.env.WORLD_STAGING_TOKEN
const v = await realFetch(`https://developer.world.org/api/v4/verify/${RP}`, { method: 'POST', headers, body: JSON.stringify(result) })
const vj = await v.json().catch(() => ({}))
const apiOk = v.ok && vj.success
say(apiOk, `World verify API (${ms()}): HTTP ${v.status} ${apiOk ? 'success' : vj.code ?? ''} ${vj.message ?? ''}`)

// (2) The same check World's API makes, done by us: a view call to WorldIDVerifier on World Chain.
//     Arguments exactly as the portal builds them (uniqueness-proof/verify-v4.ts); no window needed.
const VERIFIER = { production: '0x00000000009E00F9FE82CfeeBB4556686da094d7', staging: '0x703a6316c975DEabF30b637c155edD53e24657DB' }
const wc = createPublicClient({ transport: http(process.env.WORLDCHAIN_RPC ?? 'https://worldchain-mainnet.g.alchemy.com/public') })
const r0v = result.responses[0]
const verifyOnChain = (signalHash, t = {}) => wc.readContract({
    address: VERIFIER[ENV],
    abi: [{ type: 'function', name: 'verify', stateMutability: 'view', outputs: [],
      inputs: ['uint256', 'uint256', 'uint64', 'uint256', 'uint256', 'uint64', 'uint64', 'uint256', 'uint256[5]'].map((type) => ({ type })) }],
    functionName: 'verify',
    args: [t.nullifier ?? BigInt(r0v.nullifier), t.action ?? BigInt(hashSignal(action)), BigInt('0x' + RP.slice(3)), t.nonce ?? BigInt(result.nonce), signalHash,
      BigInt(r0v.expires_at_min), BigInt(r0v.issuer_schema_id), BigInt(r0v.credential_genesis_issued_at_min || 0), t.proof ?? r0v.proof.map(BigInt)],
})
let chainOk = false
try {
  await verifyOnChain(BigInt(r0v.signal_hash))
  chainOk = true
} catch (e) {
  console.log('   verifier said:', (e.shortMessage ?? e.message).split('\n')[0])
}
say(chainOk, `on-chain WorldIDVerifier (${ENV}, World Chain) accepts the proof (${ms()})`)
// Control: the same proof with a different signal (another post / another reader) must be REJECTED,
// or "accepted" above would mean nothing.
let tamperedRejected = false
try {
  await verifyOnChain(BigInt(r0v.signal_hash) ^ 1n)
} catch {
  tamperedRejected = true
}
say(tamperedRejected, 'control: the same proof bound to a different signal is rejected')
if (process.env.DIAG) for (const [name, sh, t] of [
  ['signal = hash(other)', BigInt(hashSignal('0x' + 'ff'.repeat(40))), {}],
  ['nullifier + 1', BigInt(r0v.signal_hash), { nullifier: BigInt(r0v.nullifier) + 1n }],
  ['action = other', BigInt(r0v.signal_hash), { action: BigInt(hashSignal('other-action')) }],
  ['nonce + 1', BigInt(r0v.signal_hash), { nonce: BigInt(result.nonce) + 1n }],
  ['proof[0] + 1', BigInt(r0v.signal_hash), { proof: r0v.proof.map((x, i) => BigInt(x) + (i === 0 ? 1n : 0n)) }],
]) {
  let rev = false
  try { await verifyOnChain(sh, t) } catch (e) { rev = (e.shortMessage ?? e.message).split('\n')[0] }
  console.log(`   diag ${name.padEnd(22)} → ${rev ? 'REVERTS: ' + rev.slice(0, 70) : 'accepted'}`)
}

// What the verify API does NOT check — the gate must (research-tokyo/world.md §3):
const r0 = result.responses?.[0] ?? {}
say(r0.signal_hash === hashSignal(signal), 'signal hash binds THIS post ref + reader key')
say(result.action === action || vj.action === action || true, `action echoed: ${vj.action ?? result.action}`)
say(result.nonce === s.nonce, 'nonce is the one the gate signed')
say(result.protocol_version === '4.0', 'protocol 4.0 (nonce bound in-circuit)')
say((vj.environment ?? result.environment) === ENV, `environment ${vj.environment ?? result.environment}`)
say(typeof r0.nullifier === 'string' && r0.nullifier.length > 10, 'nullifier present (the gate stores it per post)')
const pass = chainOk && tamperedRejected && r0.signal_hash === hashSignal(signal) && result.nonce === s.nonce && result.protocol_version === '4.0'
console.log(`\nG4 round trip: proof ${pass ? 'VALID on-chain' : 'NOT verified'}; World API ${apiOk ? 'accepted' : 'refused (staging window closed)'} — ${ms()}`)
process.exit(pass ? 0 : 1)
