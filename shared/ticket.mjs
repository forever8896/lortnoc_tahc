// The membership-ticket public signal. ONE implementation, imported by both the browser app
// (app/src/lib/live/proof.ts) and the CLI/relayer (scripts/ens, relayer/) — this value is
// security-critical and two copies would eventually disagree.
//
// A Semaphore proof proves "I know the secret behind SOME commitment in the paid set" and emits
// a nullifier. `message` is the public signal riding along with it, and it is the ONLY thing
// stopping whoever submits the proof from pointing the claim somewhere else.
//
// Everything a claim decides is bound here:
//   label   — which handle is minted
//   evmAddr — who ends up owning it
//   suiAddr — where the storage stipend lands
//   pubkey  — WHICH MESSAGING KEY GETS PUBLISHED. Without this a relayer could publish a key it
//             controls and read everything sent to the handle. Never remove it.
import { keccak256, encodeAbiParameters, getAddress, toHex } from 'viem'

/**
 * @param {string} label      handle label, e.g. "alice"
 * @param {string} evmAddr    claimant's EVM address (owns the subname)
 * @param {string} suiAddr    claimant's Sui address (receives the stipend)
 * @param {string} pubkeyHex  X25519 messaging pubkey published to eth.lortnoc.pubkey
 * @returns {bigint} the public signal, inside the BN254 scalar field
 */
export function ticketMessage(label, evmAddr, suiAddr, pubkeyHex) {
  if (!label || !evmAddr || !suiAddr || !pubkeyHex) {
    throw new Error('ticketMessage: all four fields are required — a missing one silently unbinds the claim')
  }
  const packed = keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'address' }, { type: 'string' }, { type: 'string' }],
      [label, getAddress(evmAddr), suiAddr, pubkeyHex.toLowerCase()],
    ),
  )
  // >> 8 keeps the value below the BN254 scalar modulus, which Semaphore requires of public inputs.
  return BigInt(packed) >> 8n
}

/** Fixed claim scope ⇒ one nullifier per identity ⇒ one handle per membership. The product rule
 *  ("a membership buys a handle") is enforced by the maths rather than by our bookkeeping. */
export const CLAIM_SCOPE_SEED = 'lortnoc/claim/v1'

export function claimScope() {
  return BigInt(keccak256(toHex(CLAIM_SCOPE_SEED))) >> 8n
}
