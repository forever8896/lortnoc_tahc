#!/usr/bin/env node
// Proves the REAL Seal round trip against the deployed policy — not a dry-run replica.
//
// seal-policy.mjs proves `seal_approve` gates correctly by dry-running it ourselves. This goes
// the whole way: encrypt through Seal's key servers, then ask them for key shares and watch them
// consult the chain before answering.
//
//   member      → shares released, plaintext recovered
//   non-member  → refused, because seal_approve aborts on the membership check
//
//   node scripts/seal-live.mjs
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SuiClient } from '@mysten/sui/client'
import { Transaction } from '@mysten/sui/transactions'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { SealClient, SessionKey, EncryptedObject } from '@mysten/seal'
import { fromHex } from '@mysten/bcs'

const PKG = process.env.VITE_SUI_PACKAGE || '0xb214da015f1f8f59fb9804f42185782f6f2ce34e398175b060fee266c8074faf'
const RPC = process.env.VITE_SUI_RPC || 'https://sui-testnet-rpc.publicnode.com'
// Testnet key servers advertise a protocol version on-chain (`first_version`/`last_version`).
// 0xb012… is v2 and needs @mysten/seal 1.x, which in turn needs @mysten/sui 2.x — a major bump
// this app cannot take mid-event (Walrus pins the 1.x line). 0x73d0… is v1 and works with the
// SDK we can actually run, so that is the committee for now.
const SERVERS = (process.env.SEAL_SERVERS ?? '0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75')
  .split(',').map((objectId) => ({ objectId, weight: 1 }))
const THRESHOLD = 1

const sui = new SuiClient({ url: RPC })
const seal = new SealClient({ suiClient: sui, serverConfigs: SERVERS, verifyKeyServers: false })
let failed = false
const ok = (b, s) => { console.log(`  ${b ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${s}`); if (!b) failed = true }

function keypair() {
  const path = join(homedir(), '.sui', 'sui_config', 'sui.keystore')
  for (const b64 of JSON.parse(readFileSync(path, 'utf8'))) {
    const raw = Buffer.from(b64, 'base64')
    if (raw[0] === 0x00) return Ed25519Keypair.fromSecretKey(new Uint8Array(raw.subarray(1)))
  }
  throw new Error('no ed25519 key in the sui keystore')
}

const approvalBytes = async (headId, id) => {
  const tx = new Transaction()
  tx.moveCall({
    target: `${PKG}::conversation::seal_approve`,
    arguments: [tx.pure.vector('u8', Array.from(id)), tx.object(headId)],
  })
  return tx.build({ client: sui, onlyTransactionKind: true })
}

const me = keypair()
console.log('signer (member):', me.toSuiAddress())

// 1. A head this signer is a participant of.
const tx = new Transaction()
tx.moveCall({
  target: `${PKG}::conversation::create`,
  arguments: [
    tx.pure.string('seal-live.test'), tx.pure.string('seal-live.test'),
    tx.pure.address(me.toSuiAddress()), tx.pure.string(''), tx.pure.u64(Date.now()),
  ],
})
const created = await sui.signAndExecuteTransaction({
  transaction: tx, signer: me, options: { showObjectChanges: true, showEffects: true },
})
await sui.waitForTransaction({ digest: created.digest })
const head = created.objectChanges.find((c) => c.type === 'created' && c.objectType.includes('ConversationHead')).objectId
console.log('head:', head, '\n')

// 2. Encrypt to an identity namespaced under that head.
const nonce = crypto.getRandomValues(new Uint8Array(8))
const idBytes = new Uint8Array([...fromHex(head.replace(/^0x/, '')), ...nonce])
const idHex = Buffer.from(idBytes).toString('hex')
const secret = new TextEncoder().encode(JSON.stringify({ v: 1, body: 'the policy is the product' }))

const { encryptedObject } = await seal.encrypt({ threshold: THRESHOLD, packageId: PKG, id: idHex, data: secret })
ok(encryptedObject?.length > 0, `Seal encrypted ${secret.length} B → ${encryptedObject.length} B object`)
ok(EncryptedObject.parse(encryptedObject).id === idHex, 'encrypted object carries the head-namespaced identity')

// 3. The member decrypts — key servers must dry-run seal_approve and release shares.
const txBytes = await approvalBytes(head, idBytes)
const sessionKey = await SessionKey.create({ address: me.toSuiAddress(), packageId: PKG, ttlMin: 10, signer: me, suiClient: sui })
try {
  const out = await seal.decrypt({ data: encryptedObject, sessionKey, txBytes })
  ok(new TextDecoder().decode(out) === new TextDecoder().decode(secret), 'MEMBER recovered the plaintext from real key servers')
} catch (e) {
  ok(false, `member decrypt failed: ${e.message}`)
}

// 4. A stranger must be refused — by the chain, not by us.
//
// NOTE the fresh SealClient. A client caches derived keys, so reusing the one that just decrypted
// as the member would answer from cache and never ask a key server — which looks exactly like a
// policy failure and is really a test bug. Strangers get their own client, as they would in life.
const stranger = new Ed25519Keypair()
const strangerSeal = new SealClient({ suiClient: sui, serverConfigs: SERVERS, verifyKeyServers: false })
try {
  const sk = await SessionKey.create({ address: stranger.toSuiAddress(), packageId: PKG, ttlMin: 10, signer: stranger, suiClient: sui })
  await strangerSeal.decrypt({ data: encryptedObject, sessionKey: sk, txBytes })
  ok(false, 'STRANGER decrypted — the policy is not gating!')
} catch (e) {
  ok(true, `STRANGER refused (${e.constructor.name})`)
}

process.exit(failed ? 1 : 0)
