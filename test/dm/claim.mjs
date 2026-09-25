#!/usr/bin/env node
// Give a DM test wallet a REAL ENS handle: fund its owner account, then claim
// <label>.lortnoctahc.eth with its actual X25519 messaging pubkey.
//
//   node test/dm/claim.mjs alice ALICE
//
// Why this matters: without it the tier proves two keypairs can talk, which is not the product.
// The product is "message a NAME" — someone types `alice` and the app resolves it to a messaging
// key it has never seen before. That path only exists once a handle is claimed and its
// eth.lortnoc.pubkey record holds the key the wallet actually derives.
//
// The claim is ONE transaction (LortnocRegistrar.claim): it deploys the claimant's own
// PermissionedResolver proxy, writes eth.lortnoc.pubkey AND addr, grants the claimant every role
// on it, revokes its own, and registers the subname. The registrar is admin for exactly one tx.
//
// Funding comes from PRIVATE_KEY in .env.local (the deployer). It is read into the child's env
// and never printed.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, http, parseEther, formatEther } from '../../app/node_modules/viem/_esm/index.js'
import { privateKeyToAccount } from '../../app/node_modules/viem/_esm/accounts/index.js'
import { sepolia } from '../../app/node_modules/viem/_esm/chains/index.js'
import { deriveOwnerKey } from '../../shared/keys.mjs'
import * as ids from './identities.mjs'

const RPC = process.env.VITE_SEPOLIA_RPC || 'https://ethereum-sepolia-rpc.publicnode.com'
const [label, who = 'ALICE'] = process.argv.slice(2)
if (!label) {
  console.error('usage: node test/dm/claim.mjs <label> [ALICE|BOB|MALLORY]')
  process.exit(1)
}
const wallet = ids[who]
if (!wallet) { console.error(`unknown wallet ${who}`); process.exit(1) }

/** The claimant signs as its OWN MS-derived key (§4: the handle is owned by K_own, not by the
 *  wallet that paid the gas). We only top that account up. */
const own = deriveOwnerKey(wallet.ms)
const claimant = privateKeyToAccount(own.privHex)

const pub = createPublicClient({ chain: sepolia, transport: http(RPC) })
console.log(`\nClaiming ${label}.lortnoctahc.eth for ${who}`)
console.log(`  owner (K_own) ${claimant.address}`)
console.log(`  pubkey        ${wallet.pubHex}`)

const bal = await pub.getBalance({ address: claimant.address })
console.log(`  balance       ${formatEther(bal)} ETH`)

const NEED = parseEther('0.01')
if (bal < NEED) {
  const funderKey = (readFileSync(new URL('../../.env.local', import.meta.url), 'utf8')
    .match(/^PRIVATE_KEY=(.+)$/m) ?? [])[1]?.trim()
  if (!funderKey) { console.error('no PRIVATE_KEY in .env.local to fund from'); process.exit(1) }
  const funder = privateKeyToAccount(funderKey.startsWith('0x') ? funderKey : `0x${funderKey}`)
  const w = createWalletClient({ account: funder, chain: sepolia, transport: http(RPC) })
  console.log(`  funding from  ${funder.address}`)
  const hash = await w.sendTransaction({ to: claimant.address, value: parseEther('0.02') })
  await pub.waitForTransactionReceipt({ hash })
  console.log(`  funded        ${formatEther(await pub.getBalance({ address: claimant.address }))} ETH`)
}

// Reuse the CLI the project already ships rather than a second claim implementation — one path
// to the registrar means the test cannot pass against a claim the app would perform differently.
execFileSync(
  process.execPath,
  ['scripts/ens/claim.mjs', label, '--pubkey', wallet.pubHex],
  { stdio: 'inherit', env: { ...process.env, PRIVATE_KEY: own.privHex } },
)
