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
import { short } from './debug.mjs'
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
/** World ID 3.0 document credentials — what an older phone credential answers an Identity Check with.
 *  IDKit's IdentityCheck preset itself turns the v3 fallback on (idkit rust/core/src/preset.rs:
 *  legacy_verification_level Document, allow_legacy_proofs_override Some(true)). */
const V3_DOCUMENT_CREDENTIALS = new Set(['secure_document', 'document'])
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

/**
 * WorldIDVerifier.verify arguments for one response item — exactly as World's portal builds them
 * (developer-portal web/api/v4/verify/uniqueness-proof/verify-v4.ts).
 * Identity Check takes no signal, and IDKit then omits signal_hash. In v4 an absent signal is ZERO
 * (portal request-schema.ts: "V4 default signal_hash is zero, unlike v3 which uses keccak256 of empty
 * string"). Using hash('') here made every passport proof fail on-chain (measured 2026-09-26).
 */
export function verifierArgs(proof, action, rpId, r0 = proof.responses[0]) {
  return [BigInt(r0.nullifier), BigInt(hashSignal(action)), BigInt('0x' + rpId.slice(3)), BigInt(proof.nonce), BigInt(r0.signal_hash ?? '0x0'),
    BigInt(r0.expires_at_min), BigInt(r0.issuer_schema_id), BigInt(r0.credential_genesis_issued_at_min || 0), r0.proof.map(BigInt)]
}

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

  const api = verifyApi ?? (async (proof, env) => {
    // sandbox proofs go to the same endpoint and, like staging, need the staging window (portal
    // web/api/v4/verify/index.ts: sandbox → the staging verifier, behind authorizeStagingVerification)
    if (env !== 'production' && !stagingToken) return { skipped: 'no staging window' }
    const headers = { 'content-type': 'application/json' }
    if (env !== 'production') headers['x-staging-verification-token'] = stagingToken
    const r = await fetch(`https://developer.world.org/api/v4/verify/${rpId}`, { method: 'POST', headers, body: JSON.stringify(proof) })
    const j = await r.json().catch(() => ({}))
    return r.ok && j.success ? { ok: true, environment: j.environment }
      : { ok: false, reason: j.code ?? `http ${r.status}`, detail: j.detail ?? j.results?.map((x) => x.detail ?? x.code).join('; '), status: r.status }
  })

  const chain = verifyChain ?? (async (proof, action, env, r0 = proof.responses[0]) => {
    const args = verifierArgs(proof, action, rpId, r0)
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
    async verify(proof, { ref, readerPub, preset = 'poh', action = actionFor(ref), trace = () => {} }, state) {
      // (preset 'identity' = Identity Check on nationality — see the branch below)
      // Every check reports itself to `trace` (gate/debug.mjs), pass or fail, so a refusal at the booth
      // says exactly which step said no and what it saw.
      const deny = (step, why, detail = {}) => (trace(step, false, { why, ...detail }), { deny: why })
      const pass = (step, detail = {}) => trace(step, true, detail)
      // A proof may carry several responses (World's own API accepts if ANY verifies). Use the one
      // with the credential this check asks for — not blindly the first.
      const all = Array.isArray(proof?.responses) ? proof.responses : []
      trace('proof received', null, {
        environment: proof?.environment, protocol: proof?.protocol_version, action: proof?.action,
        identity_attested: proof?.identity_attested, nonce: short(proof?.nonce),
        responses: all.map((r) => ({ identifier: r?.identifier, issuer_schema_id: r?.issuer_schema_id, signal_hash: r?.signal_hash ? short(r.signal_hash) : 'absent', nullifier: short(r?.nullifier) })),
      })
      // World ID 3.0 — accepted ONLY for Identity Check (nationality), the one request where IDKit itself
      // allows the v3 fallback, and verified by World's API (v3 has no on-chain verifier; the portal checks
      // it through its sequencer: developer-portal web/api/v4/verify/uniqueness-proof/verify-v3.ts).
      const v3 = proof?.protocol_version === '3.0'
      if (v3 && preset !== 'identity') return deny('protocol', 'World ID 3.0 is accepted only for nationality checks — this one needs 4.0', { got: '3.0' })
      const r0 = all.find((r) => (v3 ? V3_DOCUMENT_CREDENTIALS.has(r?.identifier)
        : preset === 'identity' ? DOCUMENT_CREDENTIALS.has(r?.identifier) || DOCUMENT_SCHEMAS.has(Number(r?.issuer_schema_id))
        : r?.identifier === CREDENTIAL[preset])) ?? all[0]
      if (!r0 || (v3 ? typeof r0.proof !== 'string' || !r0.merkle_root || !r0.nullifier : !Array.isArray(r0.proof) || r0.proof.length !== 5))
        return deny('proof shape', 'malformed proof', { protocol: proof?.protocol_version })
      // single-use nonce, issued by us, for THIS reader, not expired
      const issued = state.get(`nonce:${proof.nonce}`)
      if (!issued) return deny('nonce', 'nonce was not issued by this gate')
      const n = JSON.parse(issued)
      if (n.used) return deny('nonce', 'nonce already used')
      if (n.readerPub !== readerPub) return deny('reader', 'proof was requested by a different reader')
      if (n.ref !== undefined && n.ref !== ref) return deny('post', 'proof is for another post')
      if (now() > n.expiresAt + 10 * 60_000) return deny('expiry', 'challenge expired', { expiredAt: new Date(n.expiresAt).toISOString() })
      pass('nonce · reader · expiry')
      if (proof.protocol_version !== '4.0' && !v3) return deny('protocol', 'not a World ID 4.0 (or, for nationality, 3.0) proof', { got: proof.protocol_version })
      if (proof.action !== undefined && proof.action !== action) return deny('action', 'proof is for another post', { got: proof.action, want: action })
      const e = n.env ?? env // the environment THIS request was issued for
      if (proof.environment !== undefined && proof.environment !== e) return deny('environment', `proof is from ${proof.environment}, the request was for ${e}`)
      pass('protocol · action · environment', { environment: e })
      if (preset === 'identity') {
        // Nationality: World App only answers with a proof when the passport matches; the backend
        // must still check it said so (docs: "identity_attested so your backend can tell").
        if (proof.identity_attested !== true) return deny('nationality attested', 'World ID did not attest the required nationality', { identity_attested: proof.identity_attested })
        if (v3) {
          if (!V3_DOCUMENT_CREDENTIALS.has(r0.identifier)) return deny('credential', `needs a document credential, got ${r0.identifier}`)
          // v3 carries no nonce in-circuit: the SIGNAL (request id ‖ keyring key, sent as legacy_signal)
          // is what ties it to this one request — without it, anyone's v3 proof could be replayed here.
          if (r0.signal_hash !== hashSignal(signalFor(ref, readerPub))) return deny('signal', 'v3 proof is not bound to this request (legacy_signal)', { got: short(r0.signal_hash) })
          pass('nationality attested · v3 document credential · signal', { identifier: r0.identifier, protocol: '3.0' })
        } else {
          if (!DOCUMENT_CREDENTIALS.has(r0.identifier) && !DOCUMENT_SCHEMAS.has(Number(r0.issuer_schema_id)))
            return deny('credential', `needs a passport / eID credential, got ${r0.identifier}`, { issuer_schema_id: r0.issuer_schema_id })
          pass('nationality attested · passport credential', { identifier: r0.identifier, issuer_schema_id: r0.issuer_schema_id })
        }
      } else {
        if (r0.identifier !== CREDENTIAL[preset]) return deny('credential', `needs ${CREDENTIAL[preset]}, got ${r0.identifier}`)
        if (r0.signal_hash !== hashSignal(signalFor(ref, readerPub))) return deny('signal', 'proof is bound to another post or reader')
        pass('credential · signal', { identifier: r0.identifier })
      }
      // burn the nonce BEFORE the slow network checks, so a racing duplicate cannot pass twice
      state.set(`nonce:${proof.nonce}`, JSON.stringify({ ...n, used: true }))

      if (v3) {
        const a = await api(proof, e)
        trace('World Chain verifier', null, { note: 'none for World ID 3.0 — World verify API is the authority' })
        trace('World verify API (v3 via sequencer)', a.ok === true, a.ok === true ? {} : a.skipped ? { why: a.skipped } : { code: a.reason, detail: a.detail, status: a.status })
        if (a.ok !== true) return { deny: a.skipped ? 'World ID 3.0 needs World’s verify API, which is unavailable (staging window closed?)' : `World verify API refused (${a.reason})` }
        return { ok: true, nullifier: r0.nullifier, api: 'ok', verdicts: [], protocol: '3.0' }
      }
      const [a, c] = await Promise.all([api(proof, e), chain(proof, action, e, r0)])
      trace('World Chain verifier', c.ok, { verdicts: c.verdicts, contract: VERIFIER[e] })
      trace('World verify API', a.ok === false ? false : a.skipped ? null : true, a.ok === false ? { code: a.reason, detail: a.detail, status: a.status } : a.skipped ? { skipped: a.skipped } : {})
      if (!c.ok) return { deny: `World Chain verifier did not confirm (${(c.verdicts ?? []).join('/') || 'invalid'})` }
      if (a.ok === false) return { deny: `World verify API refused (${a.reason})` }
      return { ok: true, nullifier: r0.nullifier, api: a.skipped ? 'skipped' : 'ok', verdicts: c.verdicts }
    },
  }
}
