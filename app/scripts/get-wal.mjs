#!/usr/bin/env node
// Top the treasury up with testnet WAL.
//
// There is no WAL faucet — the only source is swapping testnet SUI through the `wal_exchange`
// contract (rate 1:1). The treasury pays every new user a SUI + WAL storage stipend on claim, so
// running dry on WAL stops onboarding just as hard as running dry on SUI.
//
//   node scripts/get-wal.mjs [suiAmount]     # default 2
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SuiClient } from '@mysten/sui/client'
import { Transaction } from '@mysten/sui/transactions'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'

const RPC = process.env.VITE_SUI_RPC || 'https://sui-testnet-rpc.publicnode.com'
const PKG = '0x82593828ed3fcb8c6a235eac9abd0adbe9c5f9bbffa9b1e7a45cdd884481ef9f'
const EXCHANGE = '0xf4d164ea2def5fe07dc573992a029e010dba09b1a8dcbc44c5c2e79567f39073'
const WAL = '0x8270feb7375eee355e64fdb69c50abb6b5f9393a722883c1cf45f8e26048810a::wal::WAL'
const AMOUNT = BigInt(Math.round(Number(process.argv[2] ?? 2) * 1e9))

const sui = new SuiClient({ url: RPC })

function keypair() {
  for (const b64 of JSON.parse(readFileSync(join(homedir(), '.sui', 'sui_config', 'sui.keystore'), 'utf8'))) {
    const raw = Buffer.from(b64, 'base64')
    if (raw[0] === 0x00) return Ed25519Keypair.fromSecretKey(new Uint8Array(raw.subarray(1)))
  }
  throw new Error('no ed25519 key in the sui keystore')
}

const me = keypair()
const addr = me.toSuiAddress()
const fmt = (v) => (Number(v) / 1e9).toFixed(4)

const before = await Promise.all([
  sui.getBalance({ owner: addr }),
  sui.getBalance({ owner: addr, coinType: WAL }).catch(() => ({ totalBalance: '0' })),
])
console.log(`${addr}\n  before  SUI ${fmt(before[0].totalBalance)}  WAL ${fmt(before[1].totalBalance)}`)

const tx = new Transaction()
// Split exactly what we intend to spend and hand it over BY VALUE: exchange_all_for_wal consumes
// the whole coin, so there is no remainder to hand back and nothing left dangling in the PTB.
const [payment] = tx.splitCoins(tx.gas, [AMOUNT])
const wal = tx.moveCall({
  target: `${PKG}::wal_exchange::exchange_all_for_wal`,
  arguments: [tx.object(EXCHANGE), payment],
})
tx.transferObjects([wal], addr)

const res = await sui.signAndExecuteTransaction({
  transaction: tx, signer: me, options: { showEffects: true, showBalanceChanges: true },
})
await sui.waitForTransaction({ digest: res.digest })
if (res.effects?.status.status !== 'success') {
  console.error('FAILED:', res.effects?.status.error)
  process.exit(1)
}

const after = await Promise.all([
  sui.getBalance({ owner: addr }),
  sui.getBalance({ owner: addr, coinType: WAL }).catch(() => ({ totalBalance: '0' })),
])
console.log(`  after   SUI ${fmt(after[0].totalBalance)}  WAL ${fmt(after[1].totalBalance)}`)
console.log(`  digest  ${res.digest}`)
const joins = Math.min(Number(after[0].totalBalance), Number(after[1].totalBalance)) / 0.05e9
console.log(`  → stipends available for ~${Math.floor(joins)} new users (0.05 SUI + 0.05 WAL each)`)
