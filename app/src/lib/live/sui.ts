// Sui + Walrus store. Messages are AES-SIV-encrypted client-side (we hold K_conv), stored
// as Walrus blobs, pointed at by a Sui ConversationHead object. Seal (threshold encryption
// + seal_approve policy) is the differentiator to layer on top — marked below.
//
// ⚠️ Needs the Move package published (contracts/move) + testnet SUI/WAL. Validate in-browser.
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client'
import { Transaction } from '@mysten/sui/transactions'
import { SUI, assertSuiSetup } from './config'
import { encrypt, tryDecrypt } from '../crypto'
import type { Message } from '../types'

export const sui = new SuiClient({ url: SUI.rpc || getFullnodeUrl('testnet') })

// A minimal blob store over Walrus. The @mysten/walrus WalrusClient signature can drift;
// this wraps the two calls we need so the rest of the app is stable.
async function walrusWrite(bytes: Uint8Array, signAndExecute: SignFn): Promise<string> {
  const { WalrusClient } = await import('@mysten/walrus')
  const client = new WalrusClient({ network: 'testnet', suiClient: sui as any })
  const res = await client.writeBlob({ blob: bytes, deletable: true, epochs: 3, signer: signAndExecute as any })
  return res.blobId
}
async function walrusRead(blobId: string): Promise<Uint8Array> {
  const { WalrusClient } = await import('@mysten/walrus')
  const client = new WalrusClient({ network: 'testnet', suiClient: sui as any })
  return client.readBlob({ blobId })
}

type SignFn = (tx: Transaction) => Promise<{ digest: string; objectChanges?: unknown[] }>

/** Append a message: encrypt → Walrus blob → bump the ConversationHead Sui object. */
export async function sendMessage(
  headId: string | null,
  convKey: Uint8Array,
  msg: Message,
  signAndExecute: SignFn,
): Promise<{ headId: string; blobId: string }> {
  assertSuiSetup()
  const blob = encrypt(convKey, JSON.stringify(msg))
  const blobId = await walrusWrite(blob, signAndExecute)

  const tx = new Transaction()
  if (headId) {
    tx.moveCall({
      target: `${SUI.packageId}::conversation::append`,
      arguments: [tx.object(headId), tx.pure.string(blobId), tx.pure.u64(msg.ts)],
    })
  } else {
    tx.moveCall({
      target: `${SUI.packageId}::conversation::create`,
      arguments: [tx.pure.string(msg.from), tx.pure.string(msg.to), tx.pure.string(blobId), tx.pure.u64(msg.ts)],
    })
  }
  const res = await signAndExecute(tx)
  const created = (res.objectChanges as { type: string; objectId: string; objectType?: string }[] | undefined)?.find(
    (c) => c.type === 'created' && c.objectType?.includes('conversation::ConversationHead'),
  )
  return { headId: headId ?? created?.objectId ?? '', blobId }
}

/** Read a conversation's messages: fetch the head's blob ids → Walrus → decrypt. */
export async function readMessages(headId: string, convKey: Uint8Array): Promise<Message[]> {
  assertSuiSetup()
  const head = await sui.getObject({ id: headId, options: { showContent: true } })
  const fields = (head.data?.content as { fields?: { blobs?: string[] } } | undefined)?.fields
  const blobIds = fields?.blobs ?? []
  const out: Message[] = []
  for (const id of blobIds) {
    try {
      const bytes = await walrusRead(id)
      const pt = tryDecrypt(convKey, bytes)
      if (pt) out.push(JSON.parse(pt) as Message)
    } catch {
      /* skip unreadable blob */
    }
  }
  return out.sort((a, b) => a.ts - b.ts)
}

// SEAL (differentiator, wire next): instead of our AES-SIV, Seal.encrypt to an identity
// gated by an on-chain seal_approve policy; decryption needs a t-of-n key-server session.
// See contracts/move/sources/conversation.move for the seal_approve stub + LIVE-SETUP.md.
