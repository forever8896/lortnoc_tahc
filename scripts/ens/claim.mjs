#!/usr/bin/env node
// Claim <label>.lortnoctahc.eth through LortnocRegistrar — the same one-transaction path the app
// uses, from the CLI. Useful for seeding demo handles and for checking the chain independently
// of the browser. Read-back goes through ENS's OWN path (viem's default UniversalResolver +
// UniversalHelper.findExactOwner), never our wrapper.
//
//   node scripts/ens/claim.mjs alice                 (PRIVATE_KEY from .env.local)
//   node scripts/ens/claim.mjs alice --pubkey 0xabc…   (default: a stand-in derived below)
import { keccak256, stringToHex, isAddressEqual } from 'viem'
import {
  ENS, PARENT_NAME, REC, registrarAbi, registryAbi, factoryAbi, helperAbi,
  clients, readDeployment, send, log, dnsEncode,
} from './lib/ens.mjs'

const args = process.argv.slice(2)
const label = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--pubkey')
const pubkeyIdx = args.indexOf('--pubkey')
const pubkeyArg = pubkeyIdx === -1 ? undefined : args[pubkeyIdx + 1]

if (!label) {
  console.error('usage: node scripts/ens/claim.mjs <label> [--pubkey 0x…]')
  process.exit(1)
}

const { publicClient, walletClient, account } = clients()
const D = readDeployment()
const REGISTRAR = D.lortnoc.registrar
const REGISTRY = D.lortnoc.registry
if (!REGISTRAR) {
  console.error('setup not done — run scripts/ens/deploy.mjs first')
  process.exit(1)
}

// A stand-in messaging pubkey when none is supplied. The app passes the real X25519 key derived
// from the wallet signature (§5.1); this is only so a CLI-seeded handle has a well-formed record.
const pubkey = pubkeyArg ?? keccak256(stringToHex(`lortnoc/demo-pubkey/${label}`))
const handle = `${label}.${PARENT_NAME}`

console.log(`\n\x1b[1mClaim ${handle}\x1b[0m`)
console.log(`  claimant  ${account.address}`)
console.log(`  pubkey    ${pubkey}`)

const available = await publicClient.readContract({ address: REGISTRAR, abi: registrarAbi, functionName: 'available', args: [label] })
if (!available) {
  const owner = await publicClient.readContract({ address: REGISTRY, abi: registryAbi, functionName: 'findOwner', args: [label] })
  console.error(`\n\x1b[31m${handle} is not available\x1b[0m (owner ${owner})`)
  process.exit(1)
}

log.step('claim() — one tx: deploy resolver (initializer writes pubkey + addr), register subname')
const { request } = await publicClient.simulateContract({
  account, address: REGISTRAR, abi: registrarAbi, functionName: 'claim', args: [label, pubkey],
})
const receipt = await send(publicClient, walletClient, request, 'claim')
log.ok(`mined in block ${receipt.blockNumber} — gas ${receipt.gasUsed}`)

// ---- verify through ENS's canonical path ---------------------------------------------------------
const [addr, stored, resolver, exactOwner] = await Promise.all([
  publicClient.getEnsAddress({ name: handle }),
  publicClient.getEnsText({ name: handle, key: REC.pubkey }),
  publicClient.getEnsResolver({ name: handle }),
  publicClient.readContract({ address: ENS.universalHelper, abi: helperAbi, functionName: 'findExactOwner', args: [dnsEncode(handle)] }),
])
const impl = await publicClient.readContract({ address: ENS.verifiableFactory, abi: factoryAbi, functionName: 'verifyContract', args: [resolver] })

log.step('On-chain state (viem default UniversalResolver)')
log.info(`owner (findExactOwner) ${exactOwner}`)
log.info(`addr                   ${addr}`)
log.info(`resolver               ${resolver}`)
log.info(`${REC.pubkey}     ${stored}`)
log.info(`verifyContract         ${impl}`)

const checks = [
  [isAddressEqual(exactOwner, account.address), 'findExactOwner == claimant'],
  [!!addr && isAddressEqual(addr, account.address), 'addr(60) == claimant'],
  [stored === pubkey, 'pubkey text record matches'],
  [isAddressEqual(impl, ENS.permissionedResolverImpl), 'resolver is a factory-deployed PermissionedResolver'],
]
console.log()
let ok = true
for (const [pass, what] of checks) {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${what}`)
  ok &&= pass
}
console.log(`\n${ok ? '\x1b[32mHandle live.\x1b[0m' : '\x1b[31mSomething is off.\x1b[0m'} ${handle}\n`)
process.exit(ok ? 0 : 1)
