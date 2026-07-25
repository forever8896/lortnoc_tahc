#!/usr/bin/env node
// The ENS v2 flagship walkthrough, asserted end to end (CLAUDE.md §6.5 creative use #1).
//
// Delegate ONE text record to a gateway, prove the gateway can write that record and ONLY that
// record, then revoke in a single transaction and prove the write dies with it. Run it against
// the live chain before demoing — it fails loudly if any leg is wrong.
//
//   PRIVATE_KEY=0x... node scripts/ens/demo.mjs alice
//   PRIVATE_KEY=0x... node scripts/ens/demo.mjs alice --gateway 0x…
//
// Permission checks are `eth_call` simulations from the gateway address: they exercise the real
// on-chain authorization logic without the gateway needing gas. Pass --execute to additionally
// send the allowed write for real (requires GATEWAY_PRIVATE_KEY).
import { keccak256, stringToHex, encodeAbiParameters } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  ENS, PARENT_NAME, REC, ROLE_SET_TEXT,
  registryAbi, resolverAbi, factoryAbi,
  clients, readDeployment, send, dnsEncode, subnode, log,
} from './lib/ens.mjs'

const args = process.argv.slice(2)
const label = args.find((a) => !a.startsWith('--')) ?? 'alice'
const gwIdx = args.indexOf('--gateway')
const EXECUTE = args.includes('--execute')

const { publicClient, walletClient, account } = clients()
const D = readDeployment()
const REGISTRY = D.lortnoc.registry
if (!REGISTRY) throw new Error('day-0 setup not done — run scripts/ens/deploy.mjs first')

const gatewayKey = process.env.GATEWAY_PRIVATE_KEY
const gateway =
  gwIdx !== -1
    ? args[gwIdx + 1]
    : gatewayKey
      ? privateKeyToAccount(gatewayKey).address
      // A deterministic stand-in so the demo runs with no extra setup. It holds no funds; the
      // permission checks are simulations, so it never needs any.
      : '0x000000000000000000000000000000000000dEaD'

const handle = `${label}.${PARENT_NAME}`
const node = subnode(PARENT_NAME, label)
const dnsName = dnsEncode(handle)

const results = []
const check = (pass, what) => {
  results.push([pass, what])
  console.log(`    ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${what}`)
  return pass
}

/** Can `who` write `key` on the resolver right now? Runs the real authorization path. */
async function canWrite(resolver, who, key, value = 'probe') {
  try {
    await publicClient.simulateContract({
      account: who, address: resolver, abi: resolverAbi, functionName: 'setText',
      args: [node, key, value],
    })
    return true
  } catch {
    return false
  }
}

console.log(`\n\x1b[1mENS v2 — per-record write delegation\x1b[0m`)
console.log(`  handle   ${handle}`)
console.log(`  owner    ${account.address}`)
console.log(`  gateway  ${gateway}`)

// ---- 0. the handle exists and is ours ----------------------------------------------------------
log.step('Handle')
const resolver = await publicClient.readContract({
  address: REGISTRY, abi: registryAbi, functionName: 'getResolver', args: [label],
})
if (resolver === '0x0000000000000000000000000000000000000000') {
  throw new Error(`${handle} has no resolver — claim it first: node scripts/ens/claim.mjs ${label}`)
}
const owner = await publicClient.readContract({
  address: REGISTRY, abi: registryAbi, functionName: 'findOwner', args: [label],
})
log.info(`resolver ${resolver}`)
check(owner.toLowerCase() === account.address.toLowerCase(), 'you own the handle')

const impl = await publicClient.readContract({
  address: ENS.verifiableFactory, abi: factoryAbi, functionName: 'verifyContract', args: [resolver],
})
check(
  impl.toLowerCase() === ENS.permissionedResolverImpl.toLowerCase(),
  'verifyContract(resolver) → canonical PermissionedResolverImpl (trustless handle proof)',
)

// ---- 1. before delegation ----------------------------------------------------------------------
log.step('Before delegation')
check(await canWrite(resolver, account.address, REC.pubkey), 'owner can write pubkey')
check(!(await canWrite(resolver, gateway, REC.inbox)), 'gateway CANNOT write inbox')
check(!(await canWrite(resolver, gateway, REC.pubkey)), 'gateway CANNOT write pubkey')

// ---- 2. delegate exactly one record ------------------------------------------------------------
log.step(`Delegate ${REC.inbox} → gateway (authorizeTextRoles, one tx)`)
{
  const { request } = await publicClient.simulateContract({
    account, address: resolver, abi: resolverAbi, functionName: 'authorizeTextRoles',
    args: [dnsName, REC.inbox, gateway, true],
  })
  await send(publicClient, walletClient, request, 'authorizeTextRoles(grant)')
}
// The grant landed on `resource(node, keccak256(key))` — a per-record EAC resource, not the name.
const inboxResource = BigInt(
  keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [node, keccak256(stringToHex(REC.inbox))])),
)
check(
  await publicClient.readContract({
    address: resolver, abi: resolverAbi, functionName: 'hasRoles',
    args: [inboxResource, ROLE_SET_TEXT, gateway],
  }),
  'ROLE_SET_TEXT granted on the per-record resource keccak(node, keccak(key))',
)
check(await canWrite(resolver, gateway, REC.inbox), 'gateway CAN now write inbox')
check(!(await canWrite(resolver, gateway, REC.pubkey)), 'gateway still CANNOT write pubkey')
check(!(await canWrite(resolver, gateway, REC.walrus)), 'gateway still CANNOT write walrus')
check(await canWrite(resolver, account.address, REC.pubkey), 'owner still controls everything')

if (EXECUTE) {
  if (!gatewayKey) throw new Error('--execute needs GATEWAY_PRIVATE_KEY (a funded second wallet)')
  log.step('Gateway rotates the inbox pointer for real')
  const gwAccount = privateKeyToAccount(gatewayKey)
  const { createWalletClient, http } = await import('viem')
  const { sepolia } = await import('viem/chains')
  const gwWallet = createWalletClient({
    account: gwAccount, chain: sepolia, transport: http(process.env.RPC_URL || undefined),
  })
  const value = `relay://lortnoc/${label}/${Date.now()}`
  const { request } = await publicClient.simulateContract({
    account: gwAccount, address: resolver, abi: resolverAbi, functionName: 'setText',
    args: [node, REC.inbox, value],
  })
  await send(publicClient, gwWallet, request, 'gateway setText(inbox)')
  const read = await publicClient.readContract({
    address: resolver, abi: resolverAbi, functionName: 'text', args: [node, REC.inbox],
  })
  check(read === value, `inbox now reads "${read}" — written by the gateway, not the owner`)
}

// ---- 3. revoke ---------------------------------------------------------------------------------
log.step('Revoke in one tx (grant = false)')
{
  const { request } = await publicClient.simulateContract({
    account, address: resolver, abi: resolverAbi, functionName: 'authorizeTextRoles',
    args: [dnsName, REC.inbox, gateway, false],
  })
  await send(publicClient, walletClient, request, 'authorizeTextRoles(revoke)')
}
check(!(await canWrite(resolver, gateway, REC.inbox)), 'gateway can no longer write inbox')
check(await canWrite(resolver, account.address, REC.inbox), 'owner unaffected')

// ---- summary -----------------------------------------------------------------------------------
const failed = results.filter(([p]) => !p).length
console.log(
  `\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${results.length - failed}/${results.length} checks passed\x1b[0m` +
    `\n\nThe gateway could rotate ${REC.inbox} and nothing else, and lost it in one transaction.` +
    `\nRoles gate writes only — every record stays world-readable (read-gating is the offchain gateway's job).\n`,
)
process.exit(failed === 0 ? 0 : 1)
