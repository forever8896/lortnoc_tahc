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
import type { Message } from '../types'

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

async function walrusRead(blobId: string): Promise<Uint8Array> {
  const client = await walrus()
  return client.readBlob({ blobId })
}

/** Append a message: encrypt → Walrus blob → create or bump the ConversationHead. */
export async function sendMessage(
  headId: string | null,
  convKey: Uint8Array,
  msg: Message,
  signer: Signer,
  peerAddress: string,
): Promise<{ headId: string; blobId: string }> {
  assertSuiSetup()
  const blobId = await walrusWrite(encrypt(convKey, JSON.stringify(msg)), signer)

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

  const res = await sui.signAndExecuteTransaction({
    transaction: tx,
    signer,
    options: { showObjectChanges: true, showEffects: true },
  })
  await sui.waitForTransaction({ digest: res.digest })
  if (res.effects?.status.status !== 'success') {
    throw new Error(`Sui tx failed: ${res.effects?.status.error ?? 'unknown'}`)
  }

  const created = res.objectChanges?.find(
    (c) => c.type === 'created' && 'objectType' in c && c.objectType.includes('conversation::ConversationHead'),
  )
  const newHead = created && 'objectId' in created ? created.objectId : null
  return { headId: headId ?? newHead ?? '', blobId }
}

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
    try {
      const pt = tryDecrypt(convKey, await walrusRead(id))
      if (pt) out.push(JSON.parse(pt) as Message)
    } catch {
      /* blob unavailable or not ours — skip */
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
