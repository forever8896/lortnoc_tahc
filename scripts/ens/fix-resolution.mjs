#!/usr/bin/env node
//   PRIVATE_KEY=0x... node scripts/ens/fix-resolution.mjs [--dry]
//
// Repairs the two resolution defects the ENS team hit on the Sepolia explorer. Both were real,
// and neither was the one first suspected ("we deployed a resolver but never linked it") —
// the handles' resolvers were linked correctly all along.
//
//   1. `lortnoctahc.eth` — the PARENT — had no resolver at all. getSubregistry pointed at
//      LortnocRegistry correctly, but getResolver returned 0x0, so UniversalResolverV2.resolve()
//      reverted ResolverNotFound(bytes) for the domain itself. Anyone typing the bare domain into
//      an explorer saw nothing. Fixed by deploying a PermissionedResolver proxy for the parent
//      (same canonical VerifiableFactory the handles use) and linking it with setResolver.
//
//   2. Every handle resolved, but `addr` was unset. `_claim` wrote only eth.lortnoc.pubkey, and
//      `addr` is the record explorers and wallets ask for FIRST — so tooling read 0x0 and
//      reported the name as not resolving even though a text lookup returned fine. The registrar
//      now writes addr at claim time; this script backfills the handles we can still write to.
//
// Only handles owned by THIS key can be backfilled. `claim()` grants the claimant every root
// role and revokes its own, so a user's handle is writable by that user alone — by design, and
// the whole point of the per-record permission story. Those are repaired in-app instead.
//
// Idempotent: every step checks chain state first, so re-running is safe.
import { createPublicClient, createWalletClient, http, namehash, parseAbi, encodeFunctionData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEPLOYMENT = JSON.parse(readFileSync(join(ROOT, 'app/src/lib/live/ens-deployment.json'), 'utf8'))
const ENS = DEPLOYMENT.ens
const LORTNOC = DEPLOYMENT.lortnoc
const PARENT = 'lortnoctahc.eth'
const DRY = process.argv.includes('--dry')

// EACBaseRolesLib.ALL_ROLES — bit 0 of every nybble, NOT a solid mask. EAC packs 64 roles into
// nybbles (a count of holders per role), so (1<<128)-1 is rejected as EACInvalidRoleBitmap.
import { ALL_ROLES } from './lib/ens.mjs'
const RPC = process.env.SEPOLIA_RPC || 'https://sepolia.drpc.org'

const key = process.env.PRIVATE_KEY || readFileSync(join(ROOT, '.env.local'), 'utf8')
  .split('\n').find((l) => l.startsWith('PRIVATE_KEY='))?.slice('PRIVATE_KEY='.length).trim()
if (!key) throw new Error('PRIVATE_KEY not set (env or .env.local)')

const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`)
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) })
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) })

const registryAbi = parseAbi([
  'function findTokenId(string label) view returns (uint256)',
  'function getResolver(string label) view returns (address)',
  'function setResolver(uint256 anyId, address resolver)',
])
const resolverAbi = parseAbi([
  'function initialize(address admin, uint256 roleBitmap, bytes[] setters)',
  'function setAddr(bytes32 node, address addr)',
  'function addr(bytes32 node) view returns (address)',
  'function setText(bytes32 node, string key, string value)',
  'function text(bytes32 node, string key) view returns (string)',
])
const factoryAbi = parseAbi([
  'function deployProxy(address implementation, uint256 salt, bytes data) returns (address)',
  'function verifyContract(address proxy) view returns (address)',
])

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`)
const skip = (m) => console.log(`  \x1b[90m•\x1b[0m ${m}`)
const step = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`)

async function send(request, label) {
  if (DRY) return skip(`[dry] would send ${label}`)
  const hash = await wallet.writeContract(request)
  const receipt = await pub.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`${label} reverted (${hash})`)
  ok(`${label} — ${hash}`)
}

console.log(`\nENS resolution repair · signer ${account.address}${DRY ? ' · DRY RUN' : ''}`)

// ---- 1. the parent name's resolver -------------------------------------------------------------
step('1. lortnoctahc.eth — give the parent a resolver')
const parentNode = namehash(PARENT)
const parentTokenId = await pub.readContract({
  address: ENS.ethRegistry, abi: registryAbi, functionName: 'findTokenId', args: ['lortnoctahc'],
})
let freshlyDeployed = false
let parentResolver = await pub.readContract({
  address: ENS.ethRegistry, abi: registryAbi, functionName: 'getResolver', args: ['lortnoctahc'],
})

if (parentResolver && parentResolver !== '0x0000000000000000000000000000000000000000') {
  skip(`parent already has resolver ${parentResolver}`)
} else {
  // Same pattern as a handle: a VerifiableFactory proxy of the canonical PermissionedResolverImpl,
  // salted by the node so the address is deterministic and verifyContract() proves its origin.
  const initData = encodeFunctionData({
    abi: resolverAbi, functionName: 'initialize', args: [account.address, ALL_ROLES, []],
  })
  const { request, result } = await pub.simulateContract({
    account, address: ENS.verifiableFactory, abi: factoryAbi, functionName: 'deployProxy',
    args: [ENS.permissionedResolverImpl, BigInt(parentNode), initData],
  })
  console.log(`  parent resolver will be ${result}`)
  await send(request, 'deployProxy(parent resolver)')
  parentResolver = result
  freshlyDeployed = true

  const { request: linkReq } = await pub.simulateContract({
    account, address: ENS.ethRegistry, abi: registryAbi, functionName: 'setResolver',
    args: [parentTokenId, parentResolver],
  })
  await send(linkReq, 'setResolver(lortnoctahc)')
}

// ---- 2. records on the parent ------------------------------------------------------------------
step('2. lortnoctahc.eth — publish records')
// In a dry run the proxy was only simulated, so it has no code to read records from.
if (DRY && freshlyDeployed) {
  skip('[dry] parent resolver not actually deployed; record writes would follow')
} else {
  const cur = await pub.readContract({ address: parentResolver, abi: resolverAbi, functionName: 'addr', args: [parentNode] })
  if (cur !== '0x0000000000000000000000000000000000000000') {
    skip(`addr already ${cur}`)
  } else {
    const { request } = await pub.simulateContract({
      account, address: parentResolver, abi: resolverAbi, functionName: 'setAddr',
      args: [parentNode, account.address],
    })
    await send(request, 'setAddr(lortnoctahc.eth)')
  }
  const url = await pub.readContract({ address: parentResolver, abi: resolverAbi, functionName: 'text', args: [parentNode, 'url'] })
  if (url) {
    skip(`url already "${url}"`)
  } else {
    const { request } = await pub.simulateContract({
      account, address: parentResolver, abi: resolverAbi, functionName: 'setText',
      args: [parentNode, 'url', 'https://lortnoctahc.com'],
    })
    await send(request, 'setText(url)')
  }
}

// ---- 3. backfill addr on handles this key owns --------------------------------------------------
step('3. handles — backfill the missing addr record')
const handles = JSON.parse(readFileSync(join(ROOT, 'scripts/ens/handles.json'), 'utf8'))
for (const h of handles) {
  const mine = h.owner.toLowerCase() === account.address.toLowerCase()
  const cur = await pub.readContract({ address: h.resolver, abi: resolverAbi, functionName: 'addr', args: [h.node] })
  if (cur !== '0x0000000000000000000000000000000000000000') {
    skip(`${h.label}: addr already ${cur}`)
    continue
  }
  if (!mine) {
    skip(`${h.label}: owned by ${h.owner} — only that key may write (repaired in-app)`)
    continue
  }
  const { request } = await pub.simulateContract({
    account, address: h.resolver, abi: resolverAbi, functionName: 'setAddr', args: [h.node, h.owner],
  })
  await send(request, `setAddr(${h.label}.lortnoctahc.eth)`)
}

console.log(`\nparent resolver: ${parentResolver}`)
console.log('done.\n')
