// World ID for the gate — the `human` check's server side (docs/PRD-universal.md §5, §13.2, §22.5).
//
// Two calls:
//   challenge(ref, readerPub, state) — sign an IDKit 4 RP request for THIS post and THIS reader:
//       action = per-post (v4 proofs are one-time per action per human: a static action would let a
//                person read ONE gated post ever)
//       signal = ref ‖ readerPub (the proof is useless for another post or another reader)
//       nonce  = recorded as issued, single use
//   verify(proof, expected, state) — everything World's API does NOT check, then World's verdict:
//       nonce issued-and-unused · protocol 4.0 · action · environment · signal hash · credential type
//       → World's /api/v4/verify (when available) AND the WorldIDVerifier contract on World Chain,
//         read through independent RPCs: at least two must say valid and none may say invalid. verify() returns nothing on success, so
//         one RPC answering "ok" is indistinguishable from a valid proof — measured: a single public
//         RPC once "accepted" a tampered proof (gate/world-roundtrip.mjs history).
//
// Everything network-facing is injectable, so test/unit/world.test.mjs exercises every refusal
// without World's servers.
import { signRequest } from '@worldcoin/idkit-core/signing'
import { hashSignal } from '@worldcoin/idkit-core/hashing'
import { createPublicClient, http } from 'viem'

export const VERIFIER = {
  production: '0x00000000009E00F9FE82CfeeBB4556686da094d7',
  staging: '0x703a6316c975DEabF30b637c155edD53e24657DB',
  sandbox: '0x703a6316c975DEabF30b637c155edD53e24657DB', // World's Sandbox app verifies against staging
}
export const DEFAULT_RPCS = [
  'https://worldchain-mainnet.g.alchemy.com/public',
  'https://worldchain.drpc.org',
  'https://worldchain-mainnet.gateway.tenderly.co',
]
const CREDENTIAL = { poh: 'proof_of_human', selfie: 'selfie' }
/** Identity Check (nationality) answers with a DOCUMENT credential: passport / eID (9303) or MNC (9310). */
const DOCUMENT_CREDENTIALS = new Set(['passport', 'eid', 'mnc'])
const DOCUMENT_SCHEMAS = new Set([9303, 9310])
/** ISO 3166-1 alpha-3 — the format World's docs require for `nationality`. */
export const COUNTRY_RE = /^[A-Z]{3}$/
const VERIFIER_ABI = [{
  type: 'function', name: 'verify', stateMutability: 'view', outputs: [],
  inputs: ['uint256', 'uint256', 'uint64', 'uint256', 'uint256', 'uint64', 'uint64', 'uint256', 'uint256[5]'].map((type) => ({ type })),
}]

/** RPC verdicts → confirmed? At least two must say valid and none may say invalid: verify() returns
 *  nothing on success, so one lying or glitching RPC must never be enough (measured, see header). */
export const confirmed = (verdicts) =>
  verdicts.filter((v) => v === 'valid').length >= 2 && !verdicts.includes('invalid')

export const actionFor = (ref) => `lortnoc-read-${ref}`
/** One action per SPACE: the same human always gets the same nullifier there, so a ban sticks. */
export const spaceAction = (space) => `lortnoc-space-${space}`
export const signalFor = (ref, readerPub) => `0x${ref}${readerPub}`

export function createWorld({
  appId, rpId, env = 'staging', signingKey, stagingToken, rpcs = DEFAULT_RPCS,
  // injectable for tests
  now = () => Date.now(),
  verifyApi,
  verifyChain,
} = {}) {
  if (!appId || !rpId || !signingKey) return null // World not configured: the check is simply unavailable
  // `env` may be a list — "sandbox,staging": the first serves real phones (World ID Sandbox app), and
  // staging stays available for World's simulator. Each request names one; its proof must match it.
  const envs = String(env).split(',').map((e) => e.trim()).filter((e) => e in VERIFIER)
  if (!envs.length) throw new Error(`WORLD_ENV must be production, staging and/or sandbox (got "${env}")`)
  env = envs[0]
  const numericRp = BigInt('0x' + rpId.slice(3))

  const api = verifyApi ?? (async (proof, env) => {
    // sandbox proofs go to the same endpoint and, like staging, need the staging window (portal
    // web/api/v4/verify/index.ts: sandbox → the staging verifier, behind authorizeStagingVerification)
    if (env !== 'production' && !stagingToken) return { skipped: 'no staging window' }
    const headers = { 'content-type': 'application/json' }
    if (env !== 'production') headers['x-staging-verification-token'] = stagingToken
    const r = await fetch(`https://developer.world.org/api/v4/verify/${rpId}`, { method: 'POST', headers, body: JSON.stringify(proof) })
    const j = await r.json().catch(() => ({}))
    return r.ok && j.success ? { ok: true, environment: j.environment } : { ok: false, reason: j.code ?? `http ${r.status}` }
  })

  const chain = verifyChain ?? (async (proof, action, env) => {
    const r0 = proof.responses[0]
    // Identity Check takes no signal; the empty signal's hash is what the circuit then commits to.
    const args = [BigInt(r0.nullifier), BigInt(hashSignal(action)), numericRp, BigInt(proof.nonce), BigInt(r0.signal_hash ?? hashSignal('')),
      BigInt(r0.expires_at_min), BigInt(r0.issuer_schema_id), BigInt(r0.credential_genesis_issued_at_min || 0), r0.proof.map(BigInt)]
    const verdicts = await Promise.all(rpcs.map(async (url) => {
      try {
        await createPublicClient({ transport: http(url, { timeout: 10_000 }) })
          .readContract({ address: VERIFIER[env], abi: VERIFIER_ABI, functionName: 'verify', args })
        return 'valid'
      } catch (e) {
        // A revert is a real "invalid"; anything else (timeout, 5xx) is "unknown".
        return /revert/i.test(e.shortMessage ?? e.message ?? '') ? 'invalid' : 'unknown'
      }
    }))
    return { ok: confirmed(verdicts), verdicts }
  })

  return {
    env,
    envs,
    /**
     * STAGING ONLY — ask World's simulator to play World App for a request. Called by the gate, not
     * the browser: the simulator rejects calls carrying an extension Origin ("Invalid Origin",
     * measured 2026-09-26). The connect URL carries a bridge encryption key for a FAKE staging
     * identity; it is forwarded, never stored or logged.
     */
    async simulate(connectUrl) {
      if (!envs.includes('staging')) return { deny: 'the simulator exists only on staging' }
      if (!/^https:\/\/[a-z.]*world\.org\/verify\?/.test(connectUrl ?? '')) return { deny: 'not a World ID connect URL' }
      const r = await fetch('https://simulator.worldcoin.org/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'complete_test_request', arguments: { connect_url: connectUrl } } }),
        signal: AbortSignal.timeout(60_000),
      })
      const t = await r.text()
      const err = /\\?"error\\?"\s*:\s*\\?"([a-z_]+)/.exec(t)?.[1] ?? (/"error":\{/.test(t) ? 'simulator refused' : null)
      return err ? { deny: `simulator: ${err}` } : { ok: true }
    },
    /** Per-post action, or per-space when the post belongs to a space (bans need a stable nullifier). */
    actionFor: (ref, space) => (space ? spaceAction(space) : actionFor(ref)),
    /** Sign a request for one post + one reader. The nonce is remembered as issued. */
    challenge(ref, readerPub, state, preset = 'poh', action = actionFor(ref), country, wantEnv) {
      const e = envs.includes(wantEnv) ? wantEnv : env
      const s = signRequest({ signingKeyHex: signingKey.replace(/^0x/, ''), action })
      // The nonce is bound in-circuit (v4) — it is also what ties an Identity Check proof, which has
      // no signal, to THIS post and THIS reader.
      state.set(`nonce:${s.nonce}`, JSON.stringify({ readerPub, ref, env: e, expiresAt: s.expiresAt * 1000 }))
      return {
        app_id: appId,
        action,
        signal: signalFor(ref, readerPub),
        environment: e,
        preset,
        ...(preset === 'identity' ? { attributes: [{ type: 'nationality', value: country }] } : {}),
        rp_context: { rp_id: rpId, nonce: s.nonce, created_at: s.createdAt, expires_at: s.expiresAt, signature: s.sig },
      }
    },

    /** @returns {Promise<{ok: true, nullifier: string} | {deny: string}>} */
    async verify(proof, { ref, readerPub, preset = 'poh', action = actionFor(ref) }, state) {
      // (preset 'identity' = Identity Check on nationality — see the branch below)
      const r0 = proof?.responses?.[0]
      if (!r0 || !Array.isArray(r0.proof) || r0.proof.length !== 5) return { deny: 'malformed proof' }
      // single-use nonce, issued by us, for THIS reader, not expired
      const issued = state.get(`nonce:${proof.nonce}`)
      if (!issued) return { deny: 'nonce was not issued by this gate' }
      const n = JSON.parse(issued)
      if (n.used) return { deny: 'nonce already used' }
      if (n.readerPub !== readerPub) return { deny: 'proof was requested by a different reader' }
      if (n.ref !== undefined && n.ref !== ref) return { deny: 'proof is for another post' }
      if (now() > n.expiresAt + 10 * 60_000) return { deny: 'challenge expired' }
      if (proof.protocol_version !== '4.0') return { deny: 'not a World ID 4.0 proof' }
      if (proof.action !== undefined && proof.action !== action) return { deny: 'proof is for another post' }
      const e = n.env ?? env // the environment THIS request was issued for
      if (proof.environment !== undefined && proof.environment !== e) return { deny: `proof is from ${proof.environment}, the request was for ${e}` }
      if (preset === 'identity') {
        // Nationality: World App only answers with a proof when the passport matches; the backend
        // must still check it said so (docs: "identity_attested so your backend can tell").
        if (proof.identity_attested !== true) return { deny: 'World ID did not attest the required nationality' }
        if (!DOCUMENT_CREDENTIALS.has(r0.identifier) && !DOCUMENT_SCHEMAS.has(Number(r0.issuer_schema_id)))
          return { deny: `needs a passport / eID credential, got ${r0.identifier}` }
      } else {
        if (r0.identifier !== CREDENTIAL[preset]) return { deny: `needs ${CREDENTIAL[preset]}, got ${r0.identifier}` }
        if (r0.signal_hash !== hashSignal(signalFor(ref, readerPub))) return { deny: 'proof is bound to another post or reader' }
      }
      // burn the nonce BEFORE the slow network checks, so a racing duplicate cannot pass twice
      state.set(`nonce:${proof.nonce}`, JSON.stringify({ ...n, used: true }))

      const [a, c] = await Promise.all([api(proof, e), chain(proof, action, e)])
      if (!c.ok) return { deny: `World Chain verifier did not confirm (${(c.verdicts ?? []).join('/') || 'invalid'})` }
      if (a.ok === false) return { deny: `World verify API refused (${a.reason})` }
      return { ok: true, nullifier: r0.nullifier, api: a.skipped ? 'skipped' : 'ok', verdicts: c.verdicts }
    },
  }
}
