#!/usr/bin/env node
//   PRIVATE_KEY=0x... node scripts/ens/upgrade-registrar.mjs [--dry]
//
// Swaps LortnocRegistrar for a build whose `_claim` also writes the `addr` record.
//
// Why a redeploy and not a patch: the registrar is admin of a handle's resolver for exactly one
// transaction and revokes itself at the end of it, so a record it did not write at claim time can
// never be written by us afterwards — only by the handle's owner. `addr` has to be set in that
// window or not at all, which makes it a code change.
//
// The swap is two role operations on the registry, in this order:
//   grant ROLE_REGISTRAR to the new registrar, THEN revoke it from the old one.
// Grant-before-revoke matters: EAC refuses to remove the last assignee of a role, and doing it
// the other way round would leave nobody able to issue handles.
//
// Idempotent, and safe to re-run: each step reads chain state first.
import { createPublicClient, createWalletClient, http, namehash, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_ROLES, registryAbi } from './lib/ens.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEPLOY_PATH = join(ROOT, 'app/src/lib/live/ens-deployment.json')
const deployment = JSON.parse(readFileSync(DEPLOY_PATH, 'utf8'))
const ENS = deployment.ens
const ARTIFACT = join(ROOT, 'contracts/out/LortnocRegistrar.sol/LortnocRegistrar.json')
const PARENT_NAME = 'lortnoctahc.eth'
const DRY = process.argv.includes('--dry')

// RegistryRolesLib: ROLE_REGISTRAR = 1<<0, its admin = that << 128.
const ROLE_REGISTRAR = 1n << 0n
const ROLE_REGISTRAR_ADMIN = ROLE_REGISTRAR << 128n
const ROLES = ROLE_REGISTRAR | ROLE_REGISTRAR_ADMIN

const RPC = process.env.SEPOLIA_RPC || 'https://sepolia.drpc.org'
const key = process.env.PRIVATE_KEY || readFileSync(join(ROOT, '.env.local'), 'utf8')
  .split('\n').find((l) => l.startsWith('PRIVATE_KEY='))?.slice('PRIVATE_KEY='.length).trim()
if (!key) throw new Error('PRIVATE_KEY not set')

const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`)
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) })
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) })

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`)
const skip = (m) => console.log(`  \x1b[90m•\x1b[0m ${m}`)
const step = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`)

async function send(request, label) {
  if (DRY) return skip(`[dry] would send ${label}`)
  const hash = await wallet.writeContract(request)
  const r = await pub.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error(`${label} reverted (${hash})`)
  ok(`${label} — ${hash}`)
}

if (!existsSync(ARTIFACT)) throw new Error('build first: (cd contracts && forge build)')
const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'))
const registryAddr = deployment.lortnoc.registry
const oldRegistrar = deployment.lortnoc.registrar

console.log(`\nLortnocRegistrar upgrade · signer ${account.address}${DRY ? ' · DRY RUN' : ''}`)
console.log(`  registry      ${registryAddr}`)
console.log(`  old registrar ${oldRegistrar}`)

// ---- 1. deploy ---------------------------------------------------------------------------------
step('1. deploy the new registrar')
let newRegistrar
if (DRY) {
  skip('[dry] would deploy LortnocRegistrar')
} else {
  const hash = await wallet.deployContract({
    abi: parseAbi([
      'constructor(address registry, address factory, address resolverImpl, bytes32 parentNode, address owner)',
    ]),
    bytecode: artifact.bytecode.object,
    args: [registryAddr, ENS.verifiableFactory, ENS.permissionedResolverImpl, namehash(PARENT_NAME), account.address],
  })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error('registrar deploy reverted')
  newRegistrar = receipt.contractAddress
  ok(`deployed ${newRegistrar} — ${hash}`)
}

// ---- 2. grant, then revoke ---------------------------------------------------------------------
step('2. move ROLE_REGISTRAR (grant new before revoking old)')
if (DRY) {
  skip('[dry] would grant to new, then revoke from old')
} else {
  const hasNew = await pub.readContract({
    address: registryAddr, abi: registryAbi, functionName: 'hasRootRoles', args: [ROLES, newRegistrar],
  })
  if (hasNew) skip('new registrar already holds ROLE_REGISTRAR')
  else {
    const { request } = await pub.simulateContract({
      account, address: registryAddr, abi: registryAbi, functionName: 'grantRootRoles',
      args: [ROLES, newRegistrar],
    })
    await send(request, 'grantRootRoles(new)')
  }

  const hasOld = await pub.readContract({
    address: registryAddr, abi: registryAbi, functionName: 'hasRootRoles', args: [ROLES, oldRegistrar],
  })
  if (!hasOld) skip('old registrar already has no roles')
  else {
    const { request } = await pub.simulateContract({
      account, address: registryAddr, abi: registryAbi, functionName: 'revokeRootRoles',
      args: [ROLES, oldRegistrar],
    })
    await send(request, 'revokeRootRoles(old)')
  }
}

// ---- 3. record it ------------------------------------------------------------------------------
step('3. update ens-deployment.json')
if (DRY) {
  skip('[dry] would rewrite the deployment file')
} else {
  deployment.lortnoc.registrarPrevious = oldRegistrar
  deployment.lortnoc.registrar = newRegistrar
  deployment.lortnoc.registrarUpgradedAt = new Date().toISOString()
  writeFileSync(DEPLOY_PATH, `${JSON.stringify(deployment, null, 2)}\n`)
  ok(`registrar = ${newRegistrar}`)
  console.log('\n  NEXT: redeploy the relayer and the app — both read this file.')
}
