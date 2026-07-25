#!/usr/bin/env node
// Read-only health check for the live ENS layer. No key needed. Run it before a demo.
//
//   node scripts/ens/status.mjs
//   node scripts/ens/status.mjs alice          (also inspect one handle)
import { encodeFunctionData } from 'viem'
import {
  ENS, PARENT_NAME, PARENT_LABEL, RESERVED_LABEL, REC,
  registryAbi, resolverAbi, factoryAbi, registrarAbi, ethRegistrarAbi,
  clients, readDeployment, subnode, dnsEncode,
} from './lib/ens.mjs'

const label = process.argv[2]
const { publicClient, rpc } = clients({ requireKey: false })
const D = readDeployment()
const ZERO = '0x0000000000000000000000000000000000000000'

const ok = (b) => (b ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m')
const dim = (s) => `\x1b[90m${s}\x1b[0m`

console.log(`\n\x1b[1mlortnoc_tahc — ENS v2 status\x1b[0m  ${dim(rpc)}`)
console.log(`  deployment tag ${D.tag}   chain ${D.chainId}`)

console.log(`\n\x1b[1mPinned ENS v2 contracts\x1b[0m`)
for (const [name, address] of Object.entries(ENS)) {
  const code = await publicClient.getBytecode({ address }).catch(() => null)
  console.log(`  ${ok(!!code && code !== '0x')} ${name.padEnd(26)} ${address}`)
}

console.log(`\n\x1b[1mOurs\x1b[0m`)
const { registry, registrar } = D.lortnoc
if (!registry || !registrar) {
  console.log(`  ${ok(false)} day-0 setup not done — run: node scripts/ens/deploy.mjs --yes`)
  process.exit(1)
}
for (const [name, address] of [['LortnocRegistry', registry], ['LortnocRegistrar', registrar]]) {
  const code = await publicClient.getBytecode({ address }).catch(() => null)
  console.log(`  ${ok(!!code && code !== '0x')} ${name.padEnd(26)} ${address}`)
}

const parentOwner = await publicClient.readContract({
  address: ENS.ethRegistry, abi: registryAbi, functionName: 'findOwner', args: [PARENT_LABEL],
})
const reservedOwner = await publicClient.readContract({
  address: ENS.ethRegistry, abi: registryAbi, functionName: 'findOwner', args: [RESERVED_LABEL],
}).catch(() => ZERO)
const sub = await publicClient.readContract({
  address: ENS.ethRegistry, abi: registryAbi, functionName: 'getSubregistry', args: [PARENT_LABEL],
})
const expiry = await publicClient.readContract({
  address: ENS.ethRegistry, abi: registryAbi, functionName: 'findExpiry', args: [PARENT_LABEL],
})
const claimOpen = await publicClient.readContract({
  address: registrar, abi: registrarAbi, functionName: 'available', args: ['zzprobezz'],
})
const gate = await publicClient.readContract({
  address: registrar, abi: registrarAbi, functionName: 'gate',
})

console.log(`\n\x1b[1mNames\x1b[0m`)
console.log(`  ${ok(parentOwner !== ZERO)} ${PARENT_NAME.padEnd(26)} owner ${parentOwner}`)
console.log(`  ${ok(reservedOwner !== ZERO)} ${(RESERVED_LABEL + '.eth (reserved)').padEnd(26)} owner ${reservedOwner}`)
console.log(`  ${ok(sub.toLowerCase() === registry.toLowerCase())} subregistry wired      ${sub}`)
console.log(`  ${dim('expires')} ${new Date(Number(expiry) * 1000).toISOString().slice(0, 10)}`)
console.log(`  ${ok(claimOpen)} handles claimable      ${gate === ZERO ? 'free tier (open to all)' : `gated by ${gate}`}`)

if (label) {
  console.log(`\n\x1b[1mHandle ${label}.${PARENT_NAME}\x1b[0m`)
  const owner = await publicClient.readContract({
    address: registry, abi: registryAbi, functionName: 'findOwner', args: [label],
  })
  if (owner === ZERO) {
    console.log(`  ${dim('unclaimed')}`)
  } else {
    const resolver = await publicClient.readContract({
      address: registry, abi: registryAbi, functionName: 'getResolver', args: [label],
    })
    const node = subnode(PARENT_NAME, label)
    const impl = await publicClient.readContract({
      address: ENS.verifiableFactory, abi: factoryAbi, functionName: 'verifyContract', args: [resolver],
    }).catch(() => ZERO)
    console.log(`  owner     ${owner}`)
    console.log(`  resolver  ${resolver}  ${ok(impl.toLowerCase() === ENS.permissionedResolverImpl.toLowerCase())} factory-verified`)
    console.log(`  node      ${node}`)
    for (const [k, key] of Object.entries(REC)) {
      const v = await publicClient.readContract({
        address: resolver, abi: resolverAbi, functionName: 'text', args: [node, key],
      }).catch(() => '')
      console.log(`  ${key.padEnd(26)} ${v || dim('(unset)')}`)
    }
    // Canonical resolution — proves the whole registry chain is traversable, not just our reads.
    const viaUR = await publicClient.readContract({
      address: ENS.universalResolver, abi: [
        { type: 'function', name: 'resolve', stateMutability: 'view', inputs: [{ name: 'name', type: 'bytes' }, { name: 'data', type: 'bytes' }], outputs: [{ type: 'bytes' }, { type: 'address' }] },
      ], functionName: 'resolve',
      args: [
        dnsEncode(`${label}.${PARENT_NAME}`),
        encodeFunctionData({ abi: resolverAbi, functionName: 'text', args: [node, REC.pubkey] }),
      ],
    }).catch(() => null)
    console.log(`  ${ok(!!viaUR)} resolves through UniversalResolverV2`)
  }
}
console.log()
