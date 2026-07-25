// Groth16 proving, in the browser (§7).
//
// The membership secret never leaves this device — not to us, not to the relayer. What leaves is
// a proof that *some* member of the paid set authorised this exact claim, plus a nullifier that
// can only ever be burned once.
//
// The artifacts (~3.3 MB of wasm + zkey) are fetched from PSE's CDN on first use and cached by
// the browser thereafter, so the first proof of a session is the slow one.
import { ticketMessage, claimScope } from '../../../../shared/ticket.mjs'

/** A Semaphore proof, shaped for `LortnocMembership.spendTicket` and for JSON transport. */
export type Ticket = {
  merkleTreeDepth: number
  merkleTreeRoot: string
  nullifier: string
  message: string
  scope: string
  points: string[]
}

export type ProofStage = 'deriving' | 'loading-artifacts' | 'proving'

/** id_sem (§5.1) → Semaphore identity. Must match membership.ts::commitmentFrom exactly, or the
 *  proof would be generated against a commitment that was never paid for. */
async function identityFrom(ms: Uint8Array) {
  const { Identity } = await import('@semaphore-protocol/identity')
  const { hkdf } = await import('@noble/hashes/hkdf.js')
  const { sha256 } = await import('@noble/hashes/sha2.js')
  const sem = hkdf(sha256, ms, new TextEncoder().encode('lortnoc/semaphore/v1'), new TextEncoder().encode('sem'), 32)
  const hex = Array.from(sem, (b) => b.toString(16).padStart(2, '0')).join('')
  return new Identity(hex)
}

export async function commitmentOf(ms: Uint8Array): Promise<bigint> {
  return (await identityFrom(ms)).commitment
}

/**
 * Prove membership and bind the claim.
 *
 * `members` must be the real on-chain set — the caller is responsible for having verified the
 * root against `Semaphore.getMerkleTreeRoot` before calling. Proving against a set the relayer
 * invented would produce a proof that simply fails on-chain, but checking first gives a far
 * better error than "transaction reverted".
 */
export async function generateTicket(opts: {
  ms: Uint8Array
  members: string[]
  label: string
  evmAddr: string
  suiAddr: string
  pubkeyHex: string
  onStage?: (s: ProofStage) => void
}): Promise<Ticket> {
  const { ms, members, label, evmAddr, suiAddr, pubkeyHex, onStage } = opts

  onStage?.('deriving')
  const identity = await identityFrom(ms)

  onStage?.('loading-artifacts')
  const { Group } = await import('@semaphore-protocol/group')
  const { generateProof } = await import('@semaphore-protocol/proof')

  const group = new Group(members.map(BigInt))
  if (!members.some((m) => BigInt(m) === identity.commitment)) {
    throw new Error('this identity is not in the paid set — pay for a membership first')
  }

  // Everything the claim decides is bound into the public signal, so neither the relayer nor
  // anyone replaying this proof can point it elsewhere. See shared/ticket.mjs.
  const message = ticketMessage(label, evmAddr, suiAddr, pubkeyHex)
  // Fixed scope ⇒ one nullifier per identity ⇒ one handle per membership.
  const scope = claimScope()

  onStage?.('proving')
  const proof = await generateProof(identity, group, message, scope)

  return {
    merkleTreeDepth: Number(proof.merkleTreeDepth),
    merkleTreeRoot: proof.merkleTreeRoot.toString(),
    nullifier: proof.nullifier.toString(),
    message: proof.message.toString(),
    scope: proof.scope.toString(),
    points: proof.points.map((p) => p.toString()),
  }
}

export { ticketMessage, claimScope }
