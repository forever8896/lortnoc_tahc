#!/usr/bin/env node
// Deploy LortnocSpaces (contracts/src/LortnocSpaces.sol) and verify it end to end on-chain.
//
//   node scripts/ens/deploy-spaces.mjs sepolia            deploy + live purchase test (testnet ETH)
//   node scripts/ens/deploy-spaces.mjs mainnet            deploy + read-back checks only (no purchase)
//
// Treasury AND owner = whatever lortnoctahc.eth resolves to on Ethereum MAINNET, looked up now, so
// no address is hard-coded here and the hot deploy key never controls the price or the money.
// Result → app/src/lib/live/spaces-deployment.json (one entry per network).
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  createPublicClient, createWalletClient, http, parseEther, formatEther, keccak256, toHex, decodeEventLog, getAddress,
} from 'viem'
import { mainnet, sepolia } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { ROOT, loadEnv } from './lib/ens.mjs'

const NET = process.argv[2]
if (!['sepolia', 'mainnet'].includes(NET)) throw new Error('usage: deploy-spaces.mjs sepolia|mainnet')
const PRICE = parseEther('0.005')
const TREASURY_NAME = 'lortnoctahc.eth'
const OUT = join(ROOT, 'app/src/lib/live/spaces-deployment.json')
const RPC = { sepolia: 'https://ethereum-sepolia-rpc.publicnode.com', mainnet: 'https://ethereum-rpc.publicnode.com' }

loadEnv()
const pk = process.env.PRIVATE_KEY
if (!pk) throw new Error('PRIVATE_KEY not set (.env.local)')
const account = privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`)
const chain = NET === 'mainnet' ? mainnet : sepolia
const pc = createPublicClient({ chain, transport: http(RPC[NET]) })
const wc = createWalletClient({ account, chain, transport: http(RPC[NET]) })
const ens = createPublicClient({ chain: mainnet, transport: http(RPC.mainnet) })

const art = JSON.parse(readFileSync(join(ROOT, 'contracts/out/LortnocSpaces.sol/LortnocSpaces.json'), 'utf8'))
const abi = art.abi
const ok = (m) => console.log(`  ✓ ${m}`)
const fail = (m) => {
  console.error(`  ✗ ${m}`)
  process.exit(1)
}

const treasury = await ens.getEnsAddress({ name: TREASURY_NAME })
if (!treasury) fail(`${TREASURY_NAME} does not resolve on mainnet`)
if (getAddress(treasury) === account.address) fail('treasury resolves to the deploy key — refusing')
console.log(`${NET}: deployer ${account.address}, balance ${formatEther(await pc.getBalance({ address: account.address }))} ETH`)
console.log(`treasury + owner = ${TREASURY_NAME} → ${treasury}`)

// Fees: public RPCs answer eth_maxPriorityFeePerGas with 0 on mainnet, and a zero-tip transaction
// sits in the mempool forever (measured 2026-09-25 — the first mainnet deploy hung exactly so).
// So the tip is floored, and DEPLOY_NONCE lets a stuck deploy be REPLACED rather than duplicated.
const gwei = (g) => BigInt(Math.round(Number(g) * 1e9))
const est = await pc.estimateFeesPerGas()
const maxPriorityFeePerGas = process.env.TIP_GWEI ? gwei(process.env.TIP_GWEI) : (est.maxPriorityFeePerGas > gwei(0.05) ? est.maxPriorityFeePerGas : gwei(0.05))
const maxFeePerGas = process.env.MAX_FEE_GWEI ? gwei(process.env.MAX_FEE_GWEI) : est.maxFeePerGas + maxPriorityFeePerGas
const nonce = process.env.DEPLOY_NONCE ? Number(process.env.DEPLOY_NONCE) : undefined
console.log(`fees: tip ${formatEther(maxPriorityFeePerGas * 10n ** 9n)} gwei, max ${formatEther(maxFeePerGas * 10n ** 9n)} gwei${nonce !== undefined ? `, nonce ${nonce} (replacement)` : ''}`)
const hash = await wc.deployContract({ abi, bytecode: art.bytecode.object, args: [PRICE, treasury, treasury], maxPriorityFeePerGas, maxFeePerGas, nonce })
console.log(`sent ${hash} — waiting`)
const rcpt = await pc.waitForTransactionReceipt({ hash, timeout: 900_000 })
if (rcpt.status !== 'success') fail(`deploy reverted (${hash})`)
const address = rcpt.contractAddress
console.log(`deployed ${address} (tx ${hash}, gas ${rcpt.gasUsed})`)

const read = (functionName, args = []) => pc.readContract({ address, abi, functionName, args })
if ((await pc.getCode({ address }))?.length > 2) ok('code present')
;(await read('price')) === PRICE ? ok('price 0.005 ETH') : fail('price mismatch')
getAddress(await read('treasury')) === getAddress(treasury) ? ok('treasury') : fail('treasury mismatch')
getAddress(await read('owner')) === getAddress(treasury) ? ok('owner = cold wallet') : fail('owner mismatch')

if (NET === 'sepolia') {
  // A real purchase with overpayment, then the refusals — all against the live contract.
  const label = `verify-${Date.now().toString(36)}`
  const rules = keccak256(toHex('verification rules'))
  const before = await pc.getBalance({ address: treasury })
  const { request } = await pc.simulateContract({
    account, address, abi, functionName: 'buySpace', args: [label, account.address, rules], value: parseEther('0.006'),
  })
  const bh = await wc.writeContract(request)
  const br = await pc.waitForTransactionReceipt({ hash: bh, timeout: 300_000 })
  if (br.status !== 'success') fail('purchase reverted')
  const ev = br.logs.map((l) => { try { return decodeEventLog({ abi, ...l }) } catch { return null } }).find((e) => e?.eventName === 'SpaceBought')
  ev?.args.label === label && ev.args.rulesHash === rules && ev.args.price === PRICE ? ok(`SpaceBought ${label}`) : fail('event mismatch')
  ;(await pc.getBalance({ address: treasury })) - before === PRICE ? ok('treasury +0.005 ETH exactly (excess refunded)') : fail('treasury delta wrong')
  ;(await pc.getBalance({ address })) === 0n ? ok('contract holds nothing') : fail('contract kept funds')
  for (const [why, args, value] of [
    ['same label twice', [label, account.address, rules], PRICE],
    ['underpaid', [`${label}-b`, account.address, rules], PRICE - 1n],
    ['invalid label', ['Bad Label', account.address, rules], PRICE],
  ]) {
    try {
      await pc.simulateContract({ account, address, abi, functionName: 'buySpace', args, value })
      fail(`${why} was accepted`)
    } catch {
      ok(`refuses: ${why}`)
    }
  }
}

const all = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {}
all[NET] = { address, chainId: chain.id, price: PRICE.toString(), treasuryName: TREASURY_NAME, treasury, owner: treasury, deployTx: hash, deployBlock: Number(rcpt.blockNumber), deployedAt: new Date().toISOString() }
writeFileSync(OUT, JSON.stringify(all, null, 2) + '\n')
console.log(`recorded → ${OUT}`)
