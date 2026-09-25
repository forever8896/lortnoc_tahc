#!/usr/bin/env node
// The ENS v2 flagship walkthrough, asserted end to end (CLAUDE.md §6.5 creative use #1), on the
// 09-15 PermissionedResolver API.
//
// Delegate ONE text key to a delegate with `grantSetterRoles`, prove the delegate can write that
// key and ONLY that key, then `revokeRoles` in a single transaction and prove the write dies with
// it. Run it against a TEST handle the signer owns — never a user's handle.
//
//   node scripts/ens/demo.mjs boothdemo                          (PRIVATE_KEY from .env.local)
//   node scripts/ens/demo.mjs boothdemo --delegate 0x…
//   node scripts/ens/demo.mjs boothdemo --key eth.lortnoc.audience.friends
//
// Permission checks are `eth_call` simulations from the delegate address: they exercise the real
// on-chain authorization logic without the delegate needing gas. Pass --execute to additionally
// send the allowed write for real (requires DELEGATE_PRIVATE_KEY, a funded second wallet).
//
// 09-15 semantics worth saying on stage: the grant is scoped per RESOLVER and per KEY
// (resource = keccak256(key)), not per name. With one resolver per handle that is the same thing.
import { encodeFunctionData, isAddressEqual } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  ENS, PARENT_NAME, REC, ROLE_SET_TEXT,
  registryAbi, resolverAbi, factoryAbi,
  clients, readDeployment, send, dnsEncode, log, textResource,
} from './lib/ens.mjs'

const args = process.argv.slice(2)
const opt = (k, d) => (args.indexOf(k) === -1 ? d : args[args.indexOf(k) + 1])
const label = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? 'boothdemo'
const KEY = opt('--key', 'eth.lortnoc.audience.friends')
const EXECUTE = args.includes('--execute')

const { publicClient, walletClient, account } = clients()
const D = readDeployment()
const REGISTRY = D.lortnoc.registry
if (!REGISTRY) throw new Error('setup not done — run scripts/ens/deploy.mjs first')

const delegateKey = process.env.DELEGATE_PRIVATE_KEY
const delegate =
  opt('--delegate', null) ??
  (delegateKey
    ? privateKeyToAccount(delegateKey).address
    // A throwaway stand-in so the demo runs with no extra setup. Nobody holds its key; the
    // permission checks are simulations, so it never needs gas.
    : '0x000000000000000000000000000000000000dEaD')

const handle = `${label}.${PARENT_NAME}`
const name = dnsEncode(handle)
const resource = textResource(KEY)

const results = []
const check = (pass, what) => {
  results.push([pass, what])
  console.log(`    ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${what}`)
  return pass
}

/** Can `who` call `fn(args)` on the resolver right now? Runs the real authorization path. */
async function can(resolver, who, functionName, fnArgs) {
  try {
    await publicClient.simulateContract({ account: who, address: resolver, abi: resolverAbi, functionName, args: fnArgs })
    return true
  } catch {
    return false
  }
}
const canText = (res, who, key) => can(res, who, 'setText', [name, key, 'probe'])

console.log(`\n\x1b[1mENS v2 (09-15) — per-key write delegation\x1b[0m`)
console.log(`  handle    ${handle}`)
console.log(`  owner     ${account.address}`)
console.log(`  delegate  ${delegate}`)
console.log(`  key       ${KEY}`)

// ---- 0. the handle exists and is ours ----------------------------------------------------------
log.step('Handle')
const resolver = await publicClient.readContract({ address: REGISTRY, abi: registryAbi, functionName: 'getResolver', args: [label] })
if (isAddressEqual(resolver, '0x0000000000000000000000000000000000000000')) {
  throw new Error(`${handle} has no resolver — claim it first: node scripts/ens/claim.mjs ${label}`)
}
const owner = await publicClient.readContract({ address: REGISTRY, abi: registryAbi, functionName: 'findOwner', args: [label] })
log.info(`resolver ${resolver}`)
if (!check(isAddressEqual(owner, account.address), 'the signer owns this handle')) {
  throw new Error('refusing to run the delegation demo on a handle the signer does not own')
}
const impl = await publicClient.readContract({ address: ENS.verifiableFactory, abi: factoryAbi, functionName: 'verifyContract', args: [resolver] })
check(isAddressEqual(impl, ENS.permissionedResolverImpl), 'verifyContract(resolver) → canonical PermissionedResolverImpl')
const pubkeyBefore = await publicClient.getEnsText({ name: handle, key: REC.pubkey })
const addrBefore = await publicClient.getEnsAddress({ name: handle })

// ---- 1. before delegation ----------------------------------------------------------------------
log.step('Before delegation')
check(await canText(resolver, account.address, REC.pubkey), 'owner can write pubkey')
check(!(await canText(resolver, delegate, KEY)), `delegate CANNOT write ${KEY}`)
check(!(await canText(resolver, delegate, REC.pubkey)), 'delegate CANNOT write pubkey')

// ---- 2. delegate exactly one key ---------------------------------------------------------------
log.step(`grantSetterRoles(setText(name, "${KEY}", ""), delegate) — one tx`)
const setter = encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [name, KEY, ''] })
{
  const { request } = await publicClient.simulateContract({
    account, address: resolver, abi: resolverAbi, functionName: 'grantSetterRoles', args: [setter, delegate],
  })
  await send(publicClient, walletClient, request, 'grantSetterRoles')
}
check(
  await publicClient.readContract({ address: resolver, abi: resolverAbi, functionName: 'hasRoles', args: [resource, ROLE_SET_TEXT, delegate] }),
  'ROLE_SET_TEXT granted on resource keccak256(key)',
)
check(await canText(resolver, delegate, KEY), `delegate CAN now write ${KEY}`)
check(!(await canText(resolver, delegate, REC.pubkey)), 'delegate still CANNOT write pubkey (reverts)')
check(!(await canText(resolver, delegate, 'eth.lortnoc.audience.work')), 'delegate still CANNOT write a different audience key')
check(!(await can(resolver, delegate, 'setAddress', [name, 60n, delegate])), 'delegate still CANNOT write addr')
check(!(await can(resolver, delegate, 'grantSetterRoles', [setter, '0x000000000000000000000000000000000000bEEF'])), 'delegate CANNOT sub-delegate')

if (EXECUTE) {
  if (!delegateKey) throw new Error('--execute needs DELEGATE_PRIVATE_KEY (a funded second wallet)')
  log.step('Delegate writes the key for real')
  const { createWalletClient, http } = await import('viem')
  const { sepolia } = await import('viem/chains')
  const dAccount = privateKeyToAccount(delegateKey)
  const dWallet = createWalletClient({ account: dAccount, chain: sepolia, transport: http(process.env.RPC_URL || undefined) })
  const value = JSON.stringify([`member.${PARENT_NAME}`])
  const { request } = await publicClient.simulateContract({ account: dAccount, address: resolver, abi: resolverAbi, functionName: 'setText', args: [name, KEY, value] })
  await send(publicClient, dWallet, request, 'delegate setText')
  check((await publicClient.getEnsText({ name: handle, key: KEY })) === value, 'getEnsText returns the delegate-written value')
}

// ---- 3. revoke ---------------------------------------------------------------------------------
log.step('revokeRoles(keccak256(key), ROLE_SET_TEXT, delegate) — one tx')
{
  const { request } = await publicClient.simulateContract({
    account, address: resolver, abi: resolverAbi, functionName: 'revokeRoles', args: [resource, ROLE_SET_TEXT, delegate],
  })
  await send(publicClient, walletClient, request, 'revokeRoles')
}
check(!(await canText(resolver, delegate, KEY)), `delegate can no longer write ${KEY}`)
check(await canText(resolver, account.address, KEY), 'owner unaffected')
check(
  (await publicClient.getEnsText({ name: handle, key: REC.pubkey })) === pubkeyBefore &&
    isAddressEqual((await publicClient.getEnsAddress({ name: handle })) ?? '0x0000000000000000000000000000000000000000', addrBefore ?? '0x0000000000000000000000000000000000000000'),
  'pubkey + addr unchanged after the whole cycle (canonical UR)',
)

// ---- summary -----------------------------------------------------------------------------------
const failed = results.filter(([p]) => !p).length
console.log(
  `\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${results.length - failed}/${results.length} checks passed\x1b[0m` +
    `\n\nThe delegate could write ${KEY} and nothing else, and lost it in one transaction.` +
    `\nRoles gate writes only — every record stays world-readable.\n`,
)
process.exit(failed === 0 ? 0 : 1)
