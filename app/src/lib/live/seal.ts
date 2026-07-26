// Seal — threshold encryption with an ON-CHAIN access policy (§6.4).
//
// This is the layer that makes Walrus+Seal worth its Sui/Move/WAL overhead rather than being a
// plain encrypt-library: a key server will only hand out a decryption share after dry-running
// `conversation::seal_approve` against the live chain state, which asserts BOTH
//
//   1. the identity being decrypted is prefixed with THIS head's object address, so a member of
//      one conversation cannot request shares for another; and
//   2. the caller is a participant of that head.
//
// So access follows conversation membership on-chain. Revoking someone's membership revokes
// their ability to decrypt future blobs, without re-keying anything client-side.
//
// The identity we encrypt to is therefore `headAddress || nonce` — the prefix satisfies (1) and
// the nonce keeps each message a distinct identity.
import { EncryptedObject, SealClient, SessionKey } from '@mysten/seal'
import { Transaction } from '@mysten/sui/transactions'
import type { Signer } from '@mysten/sui/cryptography'
import { fromHex } from '@mysten/bcs'
import { SEAL, SUI } from './config'
import { sui } from './sui'

let client: SealClient | null = null

function sealClient(): SealClient {
  if (!client) {
    client = new SealClient({
      suiClient: sui as never,
      serverConfigs: SEAL.servers.map((s) => ({ objectId: s.objectId, weight: 1, ...(s.aggregatorUrl ? { aggregatorUrl: s.aggregatorUrl } : {}) })),
      // The key servers are pinned by object id from the Seal docs and eth_getObject-verified;
      // on-chain verification adds a round trip per server on every construction.
      verifyKeyServers: false,
    })
  }
  return client
}

/** One session key per signer, reused until it expires. Creating one signs a personal message —
 *  free for us because the storage keypair is derived from MS and lives in memory, but it is
 *  still a signature per session, not per message. */
const sessions = new Map<string, { key: SessionKey; expires: number }>()

async function sessionFor(signer: Signer): Promise<SessionKey> {
  const address = signer.toSuiAddress()
  const hit = sessions.get(address)
  if (hit && hit.expires > Date.now() + 30_000) return hit.key

  const key = await SessionKey.create({
    address,
    packageId: SUI.packageId,
    ttlMin: SEAL.sessionTtlMin,
    signer,
    suiClient: sui as never,
  })
  sessions.set(address, { key, expires: Date.now() + SEAL.sessionTtlMin * 60_000 })
  return key
}

/** headAddress || nonce — the prefix is what `seal_approve` checks. */
function identityFor(headId: string): Uint8Array {
  const head = fromHex(headId.replace(/^0x/, ''))
  const nonce = crypto.getRandomValues(new Uint8Array(8))
  const id = new Uint8Array(head.length + nonce.length)
  id.set(head, 0)
  id.set(nonce, head.length)
  return id
}

/** The PTB a key server dry-runs. It never executes — it only has to not abort. */
async function approvalBytes(headId: string, id: Uint8Array): Promise<Uint8Array> {
  const tx = new Transaction()
  tx.moveCall({
    target: `${SUI.packageId}::conversation::seal_approve`,
    arguments: [tx.pure.vector('u8', Array.from(id)), tx.object(headId)],
  })
  return tx.build({ client: sui as never, onlyTransactionKind: true })
}

/** Encrypt to an identity namespaced under `headId`. Returns the Seal encrypted object bytes,
 *  which are what we store in the Walrus blob. */
export async function sealEncrypt(headId: string, data: Uint8Array): Promise<Uint8Array> {
  const id = identityFor(headId)
  const { encryptedObject } = await sealClient().encrypt({
    threshold: SEAL.threshold,
    packageId: SUI.packageId,
    id: Array.from(id)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(''),
    data,
  })
  return encryptedObject
}

/**
 * Decrypt a Seal object. Throws if this signer is not a participant of `headId` — which is the
 * whole point: the refusal comes from the key servers evaluating on-chain state, not from us.
 */
export async function sealDecrypt(
  headId: string,
  encrypted: Uint8Array,
  signer: Signer,
): Promise<Uint8Array> {
  const parsed = EncryptedObject.parse(encrypted)
  const id = fromHex(parsed.id)
  const [sessionKey, txBytes] = await Promise.all([sessionFor(signer), approvalBytes(headId, id)])
  return sealClient().decrypt({ data: encrypted, sessionKey, txBytes })
}

/** Cheap sniff: is this blob a Seal encrypted object at all? Blobs written before Seal was wired
 *  are raw AES-SIV and must still open, so the reader needs to tell them apart without a
 *  round trip to a key server. */
export function isSealObject(bytes: Uint8Array): boolean {
  try {
    EncryptedObject.parse(bytes)
    return true
  } catch {
    return false
  }
}
