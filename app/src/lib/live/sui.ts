// Sui + Walrus store. Messages are encrypted client-side under K_conv (ECDH-derived, §5.3),
// written to Walrus as blobs, and pointed at by a shared `ConversationHead` Sui object.
//
// Walrus is the durable log, not a per-message bus (§6.4) — reads poll the head.
//
// The signer is an Ed25519 keypair derived from the user's MS (§5.1), so storage needs no
// separate Sui wallet; that address just has to hold testnet SUI (gas) and WAL (storage).
import { SuiClient } from '@mysten/sui/client'
import { Transaction } from '@mysten/sui/transactions'
import type { Signer } from '@mysten/sui/cryptography'
import { SUI, assertSuiSetup } from './config'
import { encrypt, tryDecrypt } from '../crypto'
import type { Message, SendStage } from '../types'

export const sui = new SuiClient({ url: SUI.rpc })

/** Walrus client, lazily constructed (the SDK pulls in a lot; keep it off the boot path). */
async function walrus() {
  const { WalrusClient } = await import('@mysten/walrus')
  return new WalrusClient({
    network: SUI.network,
    suiClient: sui as never,
    uploadRelay: { host: SUI.uploadRelay, sendTip: { max: SUI.uploadRelayMaxTip } },
  })
}

/** Write an encrypted blob to Walrus. `signer` pays WAL for storage and SUI for gas. */
async function walrusWrite(bytes: Uint8Array, signer: Signer): Promise<string> {
  const client = await walrus()
  const { blobId } = await client.writeBlob({
    blob: bytes,
    deletable: true,
    epochs: SUI.epochs,
    signer,
  })
  return blobId
}

/**
 * Read a blob, aggregator first.
 *
 * The SDK's `readBlob` pulls slivers straight from storage nodes, which is the same direct-node
 * path that already forces writes through an upload relay — from a browser it is unreliable, and
 * a failed read here is indistinguishable from "not our message", so a sent message would simply
 * never appear. Aggregators serve the reconstructed blob over plain HTTP with `access-control-
 * allow-origin: *`, so they work from the page. The SDK stays as the last resort, since it is the
 * trust-minimised path: an aggregator is someone else reconstructing the blob for us.
 */
async function walrusRead(blobId: string): Promise<Uint8Array> {
  for (const host of SUI.aggregators) {
    try {
      const res = await fetch(`${host}/v1/blobs/${blobId}`)
      if (!res.ok) continue
      return new Uint8Array(await res.arrayBuffer())
    } catch {
      /* try the next aggregator */
    }
  }
  const client = await walrus()
  return client.readBlob({ blobId })
}

/**
 * Sending fires several transactions back to back — Walrus register/certify for the blob, then
 * the head create/append — and they all spend the SAME gas coin, because the derived storage
 * account normally holds exactly one. Each spend bumps that coin's version, so a transaction
 * built before the fullnode has caught up references a version that no longer exists and is
 * rejected with "Error checking transaction input objects".
 *
 * It is purely a race, so a short backoff resolves it. Only retried for that class of error;
 * anything else (out of gas, a Move abort, a rejected policy) is a real failure and is rethrown
 * immediately rather than retried into a worse state.
 */
const TRANSIENT =
  /input objects|ObjectNotFound|not available for consumption|Could not find the referenced object|version|equivocat|reserved for another transaction/i

async function executeWithRetry(
  build: () => Transaction,
  signer: Signer,
  attempts = 4,
): Promise<Awaited<ReturnType<typeof sui.signAndExecuteTransaction>>> {
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await sui.signAndExecuteTransaction({
        transaction: build(),
        signer,
        options: { showObjectChanges: true, showEffects: true },
      })
      // Wait for the node to index it, so the NEXT transaction sees the new coin version.
      await sui.waitForTransaction({ digest: res.digest })
      return res
    } catch (e) {
      last = e
      if (!TRANSIENT.test(String(e instanceof Error ? e.message : e))) throw e
      const wait = 700 * (i + 1)
      console.warn(`[lortnoc] Sui input-object race, retrying in ${wait}ms (${i + 1}/${attempts})`, e)
      await new Promise((r) => setTimeout(r, wait))
    }
  }
  throw last
}

/** Append a message: encrypt → Walrus blob → create or bump the ConversationHead. */
export async function sendMessage(
  headId: string | null,
  convKey: Uint8Array,
  msg: Message,
  signer: Signer,
  peerAddress: string,
  onStage?: (s: SendStage) => void,
): Promise<{ headId: string; blobId: string }> {
  assertSuiSetup()
  onStage?.('storing')
  const blobId = await walrusWrite(encrypt(convKey, JSON.stringify(msg)), signer)
  onStage?.('anchoring')

  // Rebuilt per attempt: a Transaction caches its built bytes (including the gas coin it picked),
  // so retrying the same instance would retry the same stale reference.
  const build = () => {
    const tx = new Transaction()
    if (headId) {
      tx.moveCall({
        target: `${SUI.packageId}::conversation::append`,
        arguments: [tx.object(headId), tx.pure.string(blobId), tx.pure.u64(msg.ts)],
      })
    } else {
      tx.moveCall({
        target: `${SUI.packageId}::conversation::create`,
        arguments: [
          tx.pure.string(msg.from),
          tx.pure.string(msg.to),
          tx.pure.address(peerAddress),
          tx.pure.string(blobId),
          tx.pure.u64(msg.ts),
        ],
      })
    }
    return tx
  }

  const res = await executeWithRetry(build, signer)
  if (res.effects?.status.status !== 'success') {
    throw new Error(`Sui tx failed: ${res.effects?.status.error ?? 'unknown'}`)
  }

  const created = res.objectChanges?.find(
    (c) => c.type === 'created' && 'objectType' in c && c.objectType.includes('conversation::ConversationHead'),
  )
  const newHead = created && 'objectId' in created ? created.objectId : null
  return { headId: headId ?? newHead ?? '', blobId }
}

/**
 * blobId+key → decoded message, or null when that key definitively cannot open it.
 *
 * Walrus blobs are IMMUTABLE, so a successful decode is true forever and re-fetching one is pure
 * waste. Without this, every poll re-downloaded and re-decrypted the whole conversation, which is
 * what made the app crawl once a thread had any history. Keyed by the conversation key too, so a
 * re-keyed conversation cannot inherit a stale "not ours" verdict. Fetch FAILURES are never
 * cached — those are transient and must be retried.
 */
const blobCache = new Map<string, Message | null>()
const cacheKey = (blobId: string, convKey: Uint8Array): string =>
  `${blobId}|${convKey.slice(0, 4).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '')}`

/** Read a conversation: head → blob ids → Walrus → decrypt. Undecryptable blobs are skipped
 *  (a wrong key is indistinguishable from a foreign blob, which is the point — §6.1). */
export async function readMessages(headId: string, convKey: Uint8Array): Promise<Message[]> {
  assertSuiSetup()
  const head = await sui.getObject({ id: headId, options: { showContent: true } })
  const content = head.data?.content
  const fields = content && content.dataType === 'moveObject'
    ? (content.fields as { blobs?: string[] })
    : undefined
  const out: Message[] = []
  for (const id of fields?.blobs ?? []) {
    // Two very different failures used to share one silent catch, which is how a stored message
    // could vanish without a trace: a blob we cannot FETCH is transient and self-heals on the
    // next poll, while a blob that will not DECRYPT is simply not ours and never will be.
    const ck = cacheKey(id, convKey)
    const hit = blobCache.get(ck)
    if (hit !== undefined) {
      if (hit) out.push(hit)
      continue
    }
    let bytes: Uint8Array
    try {
      bytes = await walrusRead(id)
    } catch (e) {
      console.warn('[lortnoc] blob unavailable, will retry next poll:', id, e)
      continue // NOT cached — transient
    }
    const pt = tryDecrypt(convKey, bytes)
    if (!pt) {
      console.debug('[lortnoc] blob did not decrypt (not ours / wrong key):', id)
      blobCache.set(ck, null) // this key will never open this blob
      continue
    }
    try {
      const msg = JSON.parse(pt) as Message
      blobCache.set(ck, msg)
      out.push(msg)
    } catch {
      console.warn('[lortnoc] decrypted but unparseable:', id)
      blobCache.set(ck, null)
    }
  }
  return out.sort((a, b) => a.ts - b.ts)
}

/** Find conversation heads this address participates in, so a second device (or the peer)
 *  discovers threads without a local index. */
export async function findHeads(address: string): Promise<string[]> {
  assertSuiSetup()
  const events = await sui.queryEvents({
    query: { MoveEventType: `${SUI.packageId}::conversation::ConversationCreated` },
    limit: 50,
    order: 'descending',
  })
  const ids = events.data.map((e) => (e.parsedJson as { head?: string })?.head).filter(Boolean) as string[]
  const mine: string[] = []
  for (const id of ids) {
    const o = await sui.getObject({ id, options: { showContent: true } })
    const c = o.data?.content
    if (c?.dataType !== 'moveObject') continue
    const members = (c.fields as { members?: string[] }).members ?? []
    if (members.some((m) => m.toLowerCase() === address.toLowerCase())) mine.push(id)
  }
  return mine
}

// SEAL (the differentiator, §6.4): the Move module already ships `seal_approve`, which gates a
// key share on "caller is a participant in THIS head". Wiring @mysten/seal means encrypting to
// an identity namespaced by the head's object id and fetching a t-of-n session key instead of
// using our own AES-SIV here. The policy is deployed and callable; the client swap is next.
