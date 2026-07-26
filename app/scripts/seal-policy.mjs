#!/usr/bin/env node
// Proves the on-chain Seal access policy actually gates.
//
// Seal key servers decide whether to release a key share by dry-running `seal_approve`. This
// replicates that with devInspectTransactionBlock, from three different senders/identities:
// a member with a correctly-namespaced identity (must pass), a stranger (must abort), and a
// member reaching for another conversation's identity (must abort).
//
//   node scripts/seal-policy.mjs [headObjectId]
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SuiClient } from '@mysten/sui/client'
import { Transaction } from '@mysten/sui/transactions'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { fromHex } from '@mysten/bcs'

const PKG = process.env.VITE_SUI_PACKAGE || '0xb214da015f1f8f59fb9804f42185782f6f2ce34e398175b060fee266c8074faf'
const RPC = process.env.VITE_SUI_RPC || 'https://sui-testnet-rpc.publicnode.com'
const HEAD = process.argv[2] || '0x2104584e327cf679b56e19bc6f7e97f39d9fae21d375eb550f439ef86f9ad8ca'

const sui = new SuiClient({ url: RPC })
const ok = (b, s) => { console.log(`  ${b ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${s}`); if (!b) process.exitCode = 1 }

function member() {
  const path = join(homedir(), '.sui', 'sui_config', 'sui.keystore')
  for (const b64 of JSON.parse(readFileSync(path, 'utf8'))) {
    const raw = Buffer.from(b64, 'base64')
    if (raw[0] === 0x00) return Ed25519Keypair.fromSecretKey(new Uint8Array(raw.subarray(1))).toSuiAddress()
  }
  throw new Error('no ed25519 key in keystore')
}

/** Run seal_approve exactly as a key server would, and report whether it aborted. */
async function approve(sender, identity) {
  const tx = new Transaction()
  tx.moveCall({
    target: `${PKG}::conversation::seal_approve`,
    arguments: [tx.pure.vector('u8', identity), tx.object(HEAD)],
  })
  const res = await sui.devInspectTransactionBlock({ sender, transactionBlock: tx })
  return { approved: res.effects.status.status === 'success', error: res.effects.status.error }
}

const me = member()
// Seal identities are namespaced by the object they belong to: <head id bytes> || <suffix>.
const idFor = (objectId) => [...fromHex(objectId), 0x01, 0x02]

console.log(`\n\x1b[1mSeal policy — ${PKG.slice(0, 10)}…::conversation::seal_approve\x1b[0m`)
console.log(`  head   ${HEAD}`)
console.log(`  member ${me}\n`)

const a = await approve(me, idFor(HEAD))
ok(a.approved, 'member + correctly-namespaced identity → key share released')

const stranger = Ed25519Keypair.generate().toSuiAddress()
const b = await approve(stranger, idFor(HEAD))
ok(!b.approved, `stranger → refused (${b.error?.slice(0, 40) ?? 'aborted'})`)

const c = await approve(me, idFor('0x' + '11'.repeat(32)))
ok(!c.approved, `member reaching for another conversation's identity → refused`)

console.log(
  `\n${process.exitCode ? '\x1b[31mPOLICY BROKEN\x1b[0m' : '\x1b[32mPolicy holds: participation is enforced on-chain, not by the client.\x1b[0m'}\n`,
)
