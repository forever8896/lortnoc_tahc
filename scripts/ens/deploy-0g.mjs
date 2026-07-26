#!/usr/bin/env node
// Deploys the anonymous membership stack on 0G Galileo (chain 16602) — §7.
//
//   PRIVATE_KEY=0x… node scripts/ens/deploy-0g.mjs --yes
//
// Three contracts, in order:
//   1. SemaphoreVerifier — the canonical Groth16 verifier, deployed verbatim. Needs the bn254
//      precompiles (0x06/0x07/0x08), which Galileo has (checked before building this).
//   2. Semaphore         — canonical group/nullifier manager (LeanIMT member tree).
//   3. LortnocMembership — ours: `join()` is payable and inserts your identity commitment;
//      `spendTicket()` burns a nullifier against a zk proof carrying your handle pubkey.
//
// Nothing here is deployed on 0G yet, so we deploy the Semaphore contracts ourselves and pin
// the addresses into app/src/lib/live/zerog-deployment.json.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createPublicClient, createWalletClient, http, defineChain, parseEther, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ROOT, loadEnv, log, send } from './lib/ens.mjs'

const args = process.argv.slice(2)
const YES = args.includes('--yes') || args.includes('-y')
/** --mainnet targets 0G mainnet (16661) and REAL money. Everything else is Galileo testnet. */
const MAINNET = args.includes('--mainnet')
const argOf = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1] }
/** Where membership fees land. On mainnet this MUST be a cold address: `join()` forwards the
 *  full payment to it immediately, so fees never sit in the contract or touch the deploy key. */
const TREASURY = argOf('treasury', null)
/** Membership price in USD, converted to 0G at the live rate at deploy time. */
const PRICE_USD = Number(argOf('price-usd', '1'))

export const galileo = defineChain({
  id: 16602,
  name: '0G Galileo',
  nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 },
  rpcUrls: { default: { http: ['https://evmrpc-testnet.0g.ai'] } },
  blockExplorers: { default: { name: 'chainscan', url: 'https://chainscan-galileo.0g.ai' } },
})

export const zeroGMainnet = defineChain({
  id: 16661,
  name: '0G',
  nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 },
  rpcUrls: { default: { http: ['https://evmrpc.0g.ai'] } },
  blockExplorers: { default: { name: '0G Scan', url: 'https://chainscan.0g.ai' } },
})

const CHAIN = MAINNET ? zeroGMainnet : galileo

/** Live 0G price, so a "$1 membership" is actually a dollar rather than a guess. */
async function usdPerZeroG() {
  const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=zero-gravity&vs_currencies=usd')
  const usd = (await res.json())?.['zero-gravity']?.usd
  if (!usd) throw new Error('could not read the 0G price')
  return usd
}

const OUT = join(ROOT, 'app', 'src', 'lib', 'live', 'zerog-deployment.json')
const artifact = (name, file) =>
  JSON.parse(readFileSync(join(ROOT, 'contracts', 'out', file ?? `${name}.sol`, `${name}.json`), 'utf8'))

/** Testnet price is symbolic (the faucet gives 0.1 0G/day). Mainnet is priced in dollars. */
const PRICE = MAINNET
  ? parseEther((PRICE_USD / (await usdPerZeroG())).toFixed(6))
  : parseEther('0.001')

loadEnv()
const pk = process.env.PRIVATE_KEY
if (!pk) throw new Error('PRIVATE_KEY not set (put it in .env.local)')
const account = privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`)
const transport = http(process.env.ZG_RPC_URL || CHAIN.rpcUrls.default.http[0])
const publicClient = createPublicClient({ chain: CHAIN, transport })
const walletClient = createWalletClient({ account, chain: CHAIN, transport })

const all = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { chainId: 16602, network: 'galileo', contracts: {} }
// Mainnet lives in its own block so a testnet re-run can never overwrite production addresses.
if (MAINNET) all.mainnet ??= { chainId: 16661, network: '0g-mainnet', contracts: {} }
const state = MAINNET ? all.mainnet : all
state.contracts ??= {}
const persist = () => writeFileSync(OUT, JSON.stringify(all, null, 2) + '\n')

console.log(`\n\x1b[1mlortnoc_tahc — 0G membership (Semaphore) deploy\x1b[0m`)
console.log(`  chain    ${CHAIN.name} ${CHAIN.id}${MAINNET ? '  \x1b[33m*** REAL VALUE ***\x1b[0m' : ''}`)
console.log(`  deployer ${account.address}`)
if (MAINNET && !TREASURY) {
  console.error(
    `\n\x1b[31mRefusing to deploy to mainnet without --treasury.\x1b[0m\n` +
      `  Membership fees are forwarded there on every join. Point it at a cold address you\n` +
      `  control — not the deploy key, which lives in a server environment.\n`,
  )
  process.exit(1)
}
if (MAINNET) console.log(`  treasury ${TREASURY}`)

log.step('Preflight')
const chainId = await publicClient.getChainId()
if (chainId !== CHAIN.id) throw new Error(`wrong chain: ${chainId}, expected ${CHAIN.id}`)
const bal = await publicClient.getBalance({ address: account.address })
console.log(`    balance ${(Number(bal) / 1e18).toFixed(4)} 0G`)
if (bal < parseEther(MAINNET ? '0.2' : '0.05')) {
  throw new Error(MAINNET ? 'need ~0.2 0G for gas — bridge some via li.fi' : 'need 0.05 0G — faucet.0g.ai')
}

// bn254 precompiles: Groth16 verification is impossible without them.
const pairing = await publicClient.call({ to: '0x0000000000000000000000000000000000000008', data: '0x' })
if (!pairing.data || BigInt(pairing.data) !== 1n) throw new Error('bn254 pairing precompile (0x08) missing')
log.ok('bn254 precompiles present (0x08 pairing → 1)')

if (!YES) {
  console.log(`\n  Re-run with --yes to spend gas.\n`)
  process.exit(0)
}

// 0G's eth_estimateGas rejects viem's default (1559 fields + nonce) with "invalid parameters",
// so we price legacy and pass an explicit gas limit — which also skips estimation entirely.
const gasPrice = await publicClient.getGasPrice()

async function deploy(label, name, abi, args_ = [], file, gas = 6_000_000n, linkTo) {
  const existing = state.contracts[label]
  if (existing && (await publicClient.getBytecode({ address: existing }))) {
    log.skip(`${label} at ${existing}`)
    return existing
  }
  const a = artifact(name, file)
  const bytecode = linkTo ? link(a.bytecode.object, a.bytecode.linkReferences, linkTo) : a.bytecode.object
  const hash = await walletClient.deployContract({ abi, bytecode, args: args_, gas, gasPrice })
  log.tx(hash)
  const receipt = await publicClient.waitForTransactionReceipt({
    hash, timeout: 180_000, pollingInterval: 3_000, retryCount: 12,
  })
  if (receipt.status !== 'success') throw new Error(`${label} deploy reverted`)
  state.contracts[label] = receipt.contractAddress
  persist()
  log.ok(`${label} → ${receipt.contractAddress}`)
  return receipt.contractAddress
}

/** Semaphore's LeanIMT hashes with Poseidon, which solc compiles to an EXTERNAL library call.
 *  The artifact therefore ships with `__$<hash>$__` placeholders that must be replaced with a
 *  deployed PoseidonT3 address before the bytecode is valid. */
function link(bytecode, linkReferences, address) {
  let out = bytecode
  for (const file of Object.values(linkReferences ?? {})) {
    for (const [libName] of Object.entries(file)) {
      // solc's placeholder is `__$` + keccak256(fully-qualified-name)[0..34] + `$__`.
      const re = new RegExp(`__\\$[0-9a-fA-F]{34}\\$__`, 'g')
      const before = out
      out = out.replace(re, address.slice(2).toLowerCase())
      if (before !== out) log.info(`linked ${libName} → ${address}`)
    }
  }
  if (out.includes('__$')) throw new Error('bytecode still has unlinked libraries')
  return out
}

log.step('1. PoseidonT3 (library Semaphore links against)')
// 16.5 KB of bytecode — the code-deposit cost alone is ~3.3M gas.
const poseidon = await deploy('poseidonT3', 'PoseidonT3', parseAbi(['constructor()']), [], undefined, 12_000_000n)

log.step('2. SemaphoreVerifier (canonical, deployed verbatim)')
const verifier = await deploy('semaphoreVerifier', 'SemaphoreVerifier', parseAbi(['constructor()']))

log.step('3. Semaphore (canonical group + nullifier manager, Poseidon linked)')
const semaphore = await deploy(
  'semaphore', 'Semaphore', parseAbi(['constructor(address verifier)']), [verifier], undefined, 12_000_000n, poseidon,
)

log.step('4. LortnocMembership (ours — pay to join, prove to spend)')
const membership = await deploy(
  'membership',
  'LortnocMembership',
  parseAbi(['constructor(address semaphore, uint256 price, address treasury, address owner)']),
  [semaphore, PRICE, TREASURY ?? account.address, account.address],
)

log.step('Verify wiring')
const membershipAbi = parseAbi([
  'function GROUP_ID() view returns (uint256)',
  'function price() view returns (uint256)',
  'function memberCount() view returns (uint256)',
  'function SEMAPHORE() view returns (address)',
])
const [groupId, price, members, sem] = await Promise.all([
  publicClient.readContract({ address: membership, abi: membershipAbi, functionName: 'GROUP_ID' }),
  publicClient.readContract({ address: membership, abi: membershipAbi, functionName: 'price' }),
  publicClient.readContract({ address: membership, abi: membershipAbi, functionName: 'memberCount' }),
  publicClient.readContract({ address: membership, abi: membershipAbi, functionName: 'SEMAPHORE' }),
])
log.ok(`group ${groupId} · price ${Number(price) / 1e18} 0G · ${members} members`)
if (sem.toLowerCase() !== semaphore.toLowerCase()) throw new Error('membership points at the wrong Semaphore')

state.groupId = groupId.toString()
state.price = price.toString()
state.deployer = account.address
state.priceUsd = MAINNET ? PRICE_USD : null
state.treasury = TREASURY ?? account.address
state.deployedAt = new Date().toISOString()
state.explorer = `${CHAIN.blockExplorers.default.url}/address/${membership}`
if (MAINNET) state.membership = membership
persist()

console.log(`\n\x1b[1m\x1b[32m0G membership live.\x1b[0m`)
console.log(`  verifier   ${verifier}`)
console.log(`  semaphore  ${semaphore}`)
console.log(`  membership ${membership}   (group ${groupId})`)
console.log(`  explorer   ${state.explorer}\n`)
