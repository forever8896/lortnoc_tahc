#!/usr/bin/env node
// The relayer — the one component that spans all three chains (§8 Layer 1).
//
//   PRIVATE_KEY=0x… node scripts/ens/relayer.mjs <label> <claimantEvmAddr> <claimantSuiAddr>
//
// A member burns a ticket on 0G. This watches for that, then on their behalf:
//   1. issues `<label>.lortnoctahc.eth` on Sepolia via `LortnocRegistrar.claimFor`, and
//   2. pays a SUI + WAL stipend to their Sui address, which is what makes messaging work.
//
// Why a relayer exists at all: no chain can read another's state, so something has to carry the
// fact "a valid ticket was burned on 0G" over to Sepolia. Being explicit about what that costs —
//
//   It CANNOT forge a claim. The nullifier is burned on 0G by a Groth16 proof; if no ticket was
//   spent, there is nothing to relay.
//   It CANNOT redirect a claim. The proof's `message` commits to (label, evm addr, sui addr).
//   Change any of them and the commitment stops matching the burned ticket.
//   It CAN censor or stall. That is the honest cost of the design (§8 Layer 4), and the mitigation
//   is that anyone can run one — the registrar's relayer set is a list, not a monopoly.
//   It does NOT learn which payment funded the ticket. Nobody does, including us.
//
// Because the claimant never sends a transaction on Sepolia, the wallet that paid on 0G and the
// handle that results are never co-signers anywhere: payer ≠ claimer, by construction.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createPublicClient, createWalletClient, http, defineChain, parseAbi,
  keccak256, encodeAbiParameters, getAddress,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { ROOT, loadEnv, log, readDeployment, registrarAbi, ticketMessage } from './lib/ens.mjs'

const [label, claimantEvm, claimantSui, claimantPubkey] = process.argv.slice(2)
if (!label || !claimantEvm || !claimantSui || !claimantPubkey) {
  console.error(
    'usage: PRIVATE_KEY=0x… node scripts/ens/relayer.mjs <label> <evmAddr> <suiAddr> <pubkeyHex>',
  )
  process.exit(1)
}

const ZG = JSON.parse(readFileSync(join(ROOT, 'app', 'src', 'lib', 'live', 'zerog-deployment.json'), 'utf8'))
const ENS_D = readDeployment()
const MEMBERSHIP = ZG.contracts.membership
const REGISTRAR = ENS_D.lortnoc.registrar

const galileo = defineChain({
  id: 16602, name: '0G Galileo',
  nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 },
  rpcUrls: { default: { http: ['https://evmrpc-testnet.0g.ai'] } },
})

loadEnv()
const account = privateKeyToAccount(process.env.PRIVATE_KEY)
const zg = createPublicClient({ chain: galileo, transport: http('https://evmrpc-testnet.0g.ai') })
const eth = createPublicClient({ chain: sepolia, transport: http('https://ethereum-sepolia-rpc.publicnode.com') })
const ethWallet = createWalletClient({ account, chain: sepolia, transport: http('https://ethereum-sepolia-rpc.publicnode.com') })

console.log(`\n\x1b[1mlortnoc_tahc relayer\x1b[0m`)
console.log(`  label      ${label}.lortnoctahc.eth`)
console.log(`  claimant   ${claimantEvm}`)
console.log(`  sui        ${claimantSui}`)
console.log(`  pubkey     ${claimantPubkey.slice(0, 20)}…`)
console.log(`  relayer    ${account.address}`)

// ---- 1. find the burned ticket on 0G ----------------------------------------------------------
log.step('0G — look for a spent ticket committing to this claim')
const expected = ticketMessage(label, claimantEvm, claimantSui, claimantPubkey)
log.info(`expected message ${expected}`)

const spentLogs = await zg.getLogs({
  address: MEMBERSHIP,
  event: {
    type: 'event', name: 'TicketSpent',
    inputs: [
      { name: 'nullifier', type: 'uint256', indexed: true },
      { name: 'message', type: 'uint256', indexed: false },
      { name: 'relayer', type: 'address', indexed: true },
    ],
  },
  fromBlock: 0n, toBlock: 'latest',
})

const match = spentLogs.find((l) => l.args.message === expected)
if (!match) {
  console.error(
    `\n\x1b[31mNo ticket found for this claim.\x1b[0m ${spentLogs.length} ticket(s) burned so far, none ` +
      `committing to (${label}, ${claimantEvm}, ${claimantSui}, ${claimantPubkey.slice(0, 12)}…).\n` +
      `The claimant must spend a ticket with exactly this message first.\n`,
  )
  process.exit(1)
}
log.ok(`ticket ${match.args.nullifier} burned in block ${match.blockNumber}`)
log.info('the proof bound this exact (label, evm, sui) triple — we cannot redirect it')

// ---- 2. issue the handle on Sepolia ------------------------------------------------------------
log.step('Sepolia — issue the handle on the claimant\'s behalf')
const already = await eth.readContract({
  address: REGISTRAR, abi: registrarAbi, functionName: 'available', args: [label],
})
if (!already) {
  log.skip(`${label}.lortnoctahc.eth is already taken`)
} else {
  const isRelayer = await eth.readContract({
    address: REGISTRAR,
    abi: parseAbi(['function isRelayer(address) view returns (bool)']),
    functionName: 'isRelayer', args: [account.address],
  })
  if (!isRelayer) {
    log.info('authorising this relayer on the registrar (one-time, owner only)')
    const { request } = await eth.simulateContract({
      account, address: REGISTRAR, abi: registrarAbi, functionName: 'setRelayer',
      args: [account.address, true],
    })
    const h = await ethWallet.writeContract(request)
    await eth.waitForTransactionReceipt({ hash: h })
    log.ok('relayer authorised')
  }

  // Bound into the proof, so this is the only pubkey that could have produced the ticket we
  // just matched — we cannot publish a different one without invalidating it.
  const pubkey = claimantPubkey
  const { request } = await eth.simulateContract({
    account, address: REGISTRAR, abi: registrarAbi, functionName: 'claimFor',
    args: [label, pubkey, getAddress(claimantEvm)],
  })
  const hash = await ethWallet.writeContract(request)
  log.tx(hash)
  const r = await eth.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error('claimFor reverted')
  log.ok(`handle issued to ${claimantEvm} — gas paid by the relayer, not the claimant`)
}

// ---- 3. stipend on Sui -------------------------------------------------------------------------
log.step('Sui — pay the storage stipend (what the membership actually buys)')

// This is the concrete thing membership buys: enough SUI for gas and WAL for Walrus storage that
// the claimant can start messaging without ever touching a faucet. The treasury key is the Sui
// CLI keystore key — the same account that published the Move package.
const SUI_STIPEND = BigInt(process.env.SUI_STIPEND ?? 50_000_000) // 0.05 SUI
const WAL_STIPEND = BigInt(process.env.WAL_STIPEND ?? 50_000_000) // 0.05 WAL
const WAL_TYPE = '0x8270feb7375eee355e64fdb69c50abb6b5f9393a722883c1cf45f8e26048810a::wal::WAL'

try {
  const { SuiClient } = await import('@mysten/sui/client')
  const { Transaction } = await import('@mysten/sui/transactions')
  const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519')
  const { homedir } = await import('node:os')

  const keystore = JSON.parse(
    readFileSync(join(homedir(), '.sui', 'sui_config', 'sui.keystore'), 'utf8'),
  )
  const raw = keystore.map((b) => Buffer.from(b, 'base64')).find((b) => b[0] === 0x00)
  if (!raw) throw new Error('no ed25519 key in the Sui keystore')
  const treasury = Ed25519Keypair.fromSecretKey(new Uint8Array(raw.subarray(1)))

  const sui = new SuiClient({ url: process.env.VITE_SUI_RPC || 'https://sui-testnet-rpc.publicnode.com' })
  const tx = new Transaction()

  // SUI comes out of the gas coin; WAL needs an explicit coin of that type to merge and split.
  const [suiCoin] = tx.splitCoins(tx.gas, [SUI_STIPEND])
  const walCoins = await sui.getCoins({ owner: treasury.toSuiAddress(), coinType: WAL_TYPE })
  if (!walCoins.data.length) throw new Error('treasury holds no WAL — swap SUI→WAL first')
  const primary = walCoins.data[0].coinObjectId
  if (walCoins.data.length > 1) {
    tx.mergeCoins(tx.object(primary), walCoins.data.slice(1).map((c) => tx.object(c.coinObjectId)))
  }
  const [walCoin] = tx.splitCoins(tx.object(primary), [WAL_STIPEND])
  tx.transferObjects([suiCoin, walCoin], claimantSui)

  const res = await sui.signAndExecuteTransaction({
    transaction: tx, signer: treasury, options: { showEffects: true },
  })
  await sui.waitForTransaction({ digest: res.digest })
  if (res.effects?.status.status !== 'success') {
    throw new Error(res.effects?.status.error ?? 'stipend tx failed')
  }
  log.tx(res.digest)
  log.ok(`stipend sent: ${Number(SUI_STIPEND) / 1e9} SUI + ${Number(WAL_STIPEND) / 1e9} WAL`)

  const after = await sui.getBalance({ owner: claimantSui })
  log.info(`claimant now holds ${(Number(after.totalBalance) / 1e9).toFixed(3)} SUI`)
} catch (e) {
  log.warn(`stipend failed: ${String(e.message).split('\n')[0]}`)
  log.info('the handle is still issued — fund the Sui address manually (app/docs/LIVE-SETUP.md)')
}

console.log(`\n\x1b[32mRelay complete.\x1b[0m`)
console.log(`  A payment happened on 0G. A handle exists on Sepolia. Storage is funded on Sui.`)
console.log(`  No on-chain link connects the payment to the handle.\n`)
