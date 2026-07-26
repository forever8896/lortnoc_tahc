#!/usr/bin/env node
// End-to-end check of the Sui/Walrus transport, using the exact SDK calls src/lib/live/sui.ts
// makes: encrypt → Walrus writeBlob → create ConversationHead → read head → readBlob → decrypt.
//
// Uses the funded Sui CLI keystore key (the app derives its keypair from MS instead; the
// storage path is identical either way).
//
//   node scripts/sui-roundtrip.mjs
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SuiClient } from '@mysten/sui/client'
import { Transaction } from '@mysten/sui/transactions'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { WalrusClient } from '@mysten/walrus'
import { aessiv } from '@noble/ciphers/aes.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

const PKG = process.env.VITE_SUI_PACKAGE || '0xb214da015f1f8f59fb9804f42185782f6f2ce34e398175b060fee266c8074faf'
const RPC = process.env.VITE_SUI_RPC || 'https://sui-testnet-rpc.publicnode.com'

const ok = (b, s) => { console.log(`  ${b ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${s}`); if (!b) process.exitCode = 1 }
const step = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`)

// --- signer from the CLI keystore -------------------------------------------------------------
function keypairFromKeystore() {
  const path = join(homedir(), '.sui', 'sui_config', 'sui.keystore')
  for (const b64 of JSON.parse(readFileSync(path, 'utf8'))) {
    const raw = Buffer.from(b64, 'base64')
    if (raw[0] !== 0x00) continue // 0x00 = ed25519 scheme flag
    const kp = Ed25519Keypair.fromSecretKey(new Uint8Array(raw.subarray(1)))
    return kp
  }
  throw new Error('no ed25519 key in the Sui keystore')
}

// --- the app's crypto (src/lib/crypto.ts), replicated -----------------------------------------
const enc = new TextEncoder()
const key = hkdf(sha256, enc.encode('roundtrip-seed'), enc.encode('lortnoc/conv/aes-siv/v1'), enc.encode('conv'), 64)
const encrypt = (k, s) => aessiv(k).encrypt(enc.encode(s))
const tryDecrypt = (k, ct) => { try { return new TextDecoder().decode(aessiv(k).decrypt(ct)) } catch { return null } }

const sui = new SuiClient({ url: RPC })
const signer = keypairFromKeystore()
const me = signer.toSuiAddress()

step('Setup')
console.log(`  package ${PKG}`)
console.log(`  signer  ${me}`)
const bal = await sui.getBalance({ owner: me })
const wal = await sui.getBalance({ owner: me, coinType: `${(await sui.getCoins({ owner: me })).data.length ? '' : ''}0x2::sui::SUI` }).catch(() => null)
console.log(`  SUI     ${(Number(bal.totalBalance) / 1e9).toFixed(3)}`)

const msg = { v: 1, from: 'alice.lortnoctahc.eth', to: 'bob.lortnoctahc.eth', ts: Date.now(), body: 'hidden in plain sight' }

// --- 1. Walrus write ---------------------------------------------------------------------------
step('1. Walrus — write the encrypted blob')
const walrus = new WalrusClient({
  network: 'testnet',
  suiClient: sui,
  uploadRelay: { host: 'https://upload-relay.testnet.walrus.space', sendTip: { max: 1000 } },
})
const ciphertext = encrypt(key, JSON.stringify(msg))
ok(!new TextDecoder().decode(ciphertext).includes('hidden'), 'plaintext is not present in the bytes we upload')
const { blobId } = await walrus.writeBlob({ blob: ciphertext, deletable: true, epochs: 3, signer })
console.log(`  blobId  ${blobId}`)
ok(!!blobId, 'blob written to Walrus')

// --- 2. Sui head -------------------------------------------------------------------------------
step('2. Sui — create the ConversationHead')
const tx = new Transaction()
tx.moveCall({
  target: `${PKG}::conversation::create`,
  arguments: [
    tx.pure.string(msg.from), tx.pure.string(msg.to),
    tx.pure.address(me), tx.pure.string(blobId), tx.pure.u64(msg.ts),
  ],
})
const res = await sui.signAndExecuteTransaction({
  transaction: tx, signer, options: { showObjectChanges: true, showEffects: true },
})
await sui.waitForTransaction({ digest: res.digest })
ok(res.effects?.status.status === 'success', `head created (tx ${res.digest.slice(0, 12)}…)`)
const created = res.objectChanges?.find((c) => c.type === 'created' && c.objectType?.includes('ConversationHead'))
const headId = created?.objectId
console.log(`  head    ${headId}`)

// --- 3. read back ------------------------------------------------------------------------------
step('3. Read back — head → blob ids → Walrus → decrypt')
const head = await sui.getObject({ id: headId, options: { showContent: true } })
const fields = head.data.content.fields
ok(fields.blobs.length === 1 && fields.blobs[0] === blobId, 'head lists the blob id')
ok(fields.members.includes(me), 'sender is a member (what seal_approve gates on)')

const fetched = await walrus.readBlob({ blobId })
const pt = tryDecrypt(key, new Uint8Array(fetched))
ok(pt !== null, 'blob decrypts with K_conv')
ok(JSON.parse(pt).body === msg.body, `round-tripped body: "${JSON.parse(pt || '{}').body}"`)

const wrong = hkdf(sha256, enc.encode('someone-else'), enc.encode('lortnoc/conv/aes-siv/v1'), enc.encode('conv'), 64)
ok(tryDecrypt(wrong, new Uint8Array(fetched)) === null, 'a wrong key fails closed (AES-SIV tag)')

// --- 4. append ---------------------------------------------------------------------------------
step('4. Append a second message')
const blob2 = await walrus.writeBlob({
  blob: encrypt(key, JSON.stringify({ ...msg, ts: Date.now(), body: 'second' })),
  deletable: true, epochs: 3, signer,
})
const tx2 = new Transaction()
tx2.moveCall({
  target: `${PKG}::conversation::append`,
  arguments: [tx2.object(headId), tx2.pure.string(blob2.blobId), tx2.pure.u64(Date.now())],
})
const res2 = await sui.signAndExecuteTransaction({ transaction: tx2, signer, options: { showEffects: true } })
await sui.waitForTransaction({ digest: res2.digest })
ok(res2.effects?.status.status === 'success', 'appended')
const head2 = await sui.getObject({ id: headId, options: { showContent: true } })
ok(head2.data.content.fields.seq === '2', `seq is now ${head2.data.content.fields.seq}`)

// --- 5. discovery ------------------------------------------------------------------------------
step('5. Discovery — find my heads from chain events')
const events = await sui.queryEvents({
  query: { MoveEventType: `${PKG}::conversation::ConversationCreated` }, limit: 50, order: 'descending',
})
ok(events.data.some((e) => e.parsedJson.head === headId), 'head discoverable via ConversationCreated event')

console.log(`\n${process.exitCode ? '\x1b[31mFAILED\x1b[0m' : '\x1b[32mSui + Walrus transport works end to end.\x1b[0m'}`)
console.log(`  head: https://testnet.suivision.xyz/object/${headId}\n`)
