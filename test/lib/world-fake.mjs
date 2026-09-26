// A fake World for tests: the REAL gate/world.mjs checks, with World's two network verdicts (the
// verify API and the on-chain verifier) injected — so every refusal the gate itself must make is
// exercised without World's servers. `proofFor` plays World App: it asks the gate for a challenge
// and returns a proof shaped exactly like IDKit 4's result, with the signal hash the challenge asked.
import { hashSignal } from '../../gate/node_modules/@worldcoin/idkit-core/dist/hashing.js'
import { createWorld } from '../../gate/world.mjs'

export const THROWAWAY_KEY = '11'.repeat(32) // signs requests in tests only; not a real RP key

export function fakeWorld({ api = { ok: true }, chain = { ok: true, verdicts: ['valid', 'valid', 'valid'] }, env = 'staging', now } = {}) {
  return createWorld({
    appId: 'app_' + '0'.repeat(32), rpId: 'rp_0123456789abcdef', env, signingKey: THROWAWAY_KEY,
    verifyApi: async () => (typeof api === 'function' ? api() : api),
    verifyChain: async () => (typeof chain === 'function' ? chain() : chain),
    now,
  })
}

let n = 1
/** Build the proof World App would return for a challenge `request`. Overrides let tests forge one. */
export function proofFrom(request, over = {}) {
  return {
    protocol_version: '4.0',
    nonce: request.rp_context.nonce,
    action: request.action,
    environment: request.environment,
    responses: [{
      identifier: request.preset === 'selfie' ? 'selfie' : 'proof_of_human',
      issuer_schema_id: 1,
      signal_hash: hashSignal(request.signal),
      proof: ['1', '2', '3', '4', '5'],
      nullifier: '0x' + (n++).toString(16).padStart(64, '0'),
      expires_at_min: String(Math.floor(Date.now() / 60000) + 60),
      ...over.response,
    }],
    ...over.top,
  }
}

/** gateReleaser's proofFor: challenge → "World App" → proof. */
export const proofFor = (over) => async ({ check, ref, readerPub, policyHash, post }) => {
  if (check !== 'human') return undefined
  const c = await post('/challenge', { ref, readerPub, policyHash })
  if (!c.request) throw new Error(c.deny ?? 'no challenge')
  return proofFrom(c.request, over)
}
