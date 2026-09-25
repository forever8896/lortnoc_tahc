#!/usr/bin/env node
// Fund the DM tier's writer wallet from the Sui CLI keystore. EXPLICIT, never run by the tests.
//
//   node test/dm/fund.mjs [--sui 0.3] [--wal 0.2] [--to 0x<address>]
//
// `--to` funds any address instead of ALICE — a real person testing the app from a browser needs
// exactly the same SUI-for-gas and WAL-for-blobs that the test writer does, and running out mid
// demo reports as "Error checking transaction input objects: Balance of gas object … is lower
// than the needed amount", which names neither the account nor the fix.
//
// Only ALICE needs funding, and that asymmetry is the design rather than a shortcut: writing a
// message costs Sui gas plus WAL for the Walrus blob, while READING costs nothing — a reader
// signs a Seal session key off-chain and fetches blobs over HTTP. So a two-party conversation is
// testable end to end with exactly one funded account, and Bob/Mallory prove the read and
// access-control paths for free.
//
// Deterministic addresses (see identities.mjs) mean this is a one-off: fund once and every future
// run reuses the same accounts.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SuiClient } from '../../app/node_modules/@mysten/sui/dist/esm/client/index.js'
import { Transaction } from '../../app/node_modules/@mysten/sui/dist/esm/transactions/index.js'
import { Ed25519Keypair } from '../../app/node_modules/@mysten/sui/dist/esm/keypairs/ed25519/index.js'
import { ALICE } from './identities.mjs'

const RPC = process.env.VITE_SUI_RPC || 'https://sui-testnet-rpc.publicnode.com'
const WAL_TYPE = process.env.WAL_TYPE ||
  '0x8270feb7375eee355e64fdb69c50abb6b5f9393a722883c1cf45f8e26048810a::wal::WAL'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? Number(process.argv[i + 1]) : dflt
}
const SUI_AMT = BigInt(Math.round(arg('sui', 0.3) * 1e9))
const WAL_AMT = BigInt(Math.round(arg('wal', 0.2) * 1e9))

/** Who gets funded. Defaults to ALICE so the documented one-off still works with no arguments. */
const toIdx = process.argv.indexOf('--to')
const TO = toIdx > -1 ? process.argv[toIdx + 1] : ALICE.address
if (!/^0x[0-9a-fA-F]{64}$/.test(TO)) throw new Error(`--to must be a full 32-byte Sui address, got ${TO}`)

function treasury() {
  const path = join(homedir(), '.sui', 'sui_config', 'sui.keystore')
  for (const b64 of JSON.parse(readFileSync(path, 'utf8'))) {
    const raw = Buffer.from(b64, 'base64')
    if (raw[0] === 0x00) return Ed25519Keypair.fromSecretKey(new Uint8Array(raw.subarray(1)))
  }
  throw new Error('no ed25519 key in the sui keystore')
}

const sui = new SuiClient({ url: RPC })
const from = treasury()
const fromAddr = from.getPublicKey().toSuiAddress()

const balances = Object.fromEntries(
  (await sui.getAllBalances({ owner: fromAddr })).map((b) => [b.coinType, BigInt(b.totalBalance)]),
)
console.log(`treasury ${fromAddr}`)
console.log(`  SUI ${balances['0x2::sui::SUI'] ?? 0n}   WAL ${balances[WAL_TYPE] ?? 0n}`)
console.log(`funding ${TO === ALICE.address ? 'ALICE' : 'address'} ${TO}`)

const tx = new Transaction()
tx.setSender(fromAddr)
// SUI comes from the gas coin; WAL has to be selected explicitly.
const [suiCoin] = tx.splitCoins(tx.gas, [SUI_AMT])
tx.transferObjects([suiCoin], TO)

const wal = await sui.getCoins({ owner: fromAddr, coinType: WAL_TYPE })
if (!wal.data.length) throw new Error(`treasury holds no ${WAL_TYPE}`)
const primary = tx.object(wal.data[0].coinObjectId)
if (wal.data.length > 1) tx.mergeCoins(primary, wal.data.slice(1).map((c) => tx.object(c.coinObjectId)))
const [walCoin] = tx.splitCoins(primary, [WAL_AMT])
tx.transferObjects([walCoin], TO)

const res = await sui.signAndExecuteTransaction({
  transaction: tx, signer: from, options: { showEffects: true },
})
await sui.waitForTransaction({ digest: res.digest })
console.log(`  status ${res.effects?.status?.status}   digest ${res.digest}`)

const after = await sui.getAllBalances({ owner: TO })
console.log('now holds:', after.map((b) => `${b.coinType.split('::').pop()}=${b.totalBalance}`).join(' ') || '(empty)')
