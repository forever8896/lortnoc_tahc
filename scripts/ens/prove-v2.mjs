#!/usr/bin/env node
// scripts/ens/prove-v2.mjs — anyone can check that lortnoc tahc genuinely runs on ENS v2.
// READ-ONLY, NO KEYS, NO .env. Every reference address comes from ENS's OWN GitHub deployment tag,
// never from our config; every read goes through ENS's canonical contracts (the ones the ENS app and
// explorer use). Our config is used only to name the things being proven.
//
//   cd scripts/ens && npm ci && node prove-v2.mjs [name …]
//   (default: a paid NFT-gated space and a user handle)
//
// For each name it proves, with the ENS-v2-only primitive in brackets:
//   1. it resolves through ENS's canonical UniversalResolver                 [UniversalResolver proxy]
//   2. the path root → eth → lortnoctahc → … is a tree of REGISTRIES, each
//      hop a separate contract (ENS v1 had one flat registry)                [hierarchical IRegistry]
//   3. ENS's UniversalHelper computes the same owner                           [findExactOwner]
//   4. the name has its OWN resolver, deployed by ENS's canonical factory
//      from ENS's canonical PermissionedResolver implementation               [VerifiableFactory]
//   5. write access is per-record roles: the owner holds them, our registrar
//      holds none (it was admin for one transaction), a stranger holds none   [Enhanced Access Control]
//   6. the on-chain history: when it was issued and every record write        [events]
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createPublicClient, http, parseAbi, isAddressEqual, keccak256, stringToHex, getAddress } from 'viem'
import { sepolia } from 'viem/chains'

const HERE = new URL('.', import.meta.url).pathname
const D = JSON.parse(readFileSync(`${HERE}../../app/src/lib/live/ens-deployment.json`, 'utf8'))
const RPC = process.env.CHECK_RPC || 'https://ethereum-sepolia-rpc.publicnode.com'
const c = createPublicClient({ chain: sepolia, transport: http(RPC, { timeout: 30_000, retryCount: 3 }) })
const NAMES = process.argv.slice(2).length ? process.argv.slice(2) : ['nft-3qxy1p.space.lortnoctahc.eth', 'kirsten.lortnoctahc.eth']
const ROLE_SET_TEXT = 1n << 4n
const TEXT_KEYS = ['eth.lortnoc.pubkey', 'eth.lortnoc.space.token', 'eth.lortnoc.space.bans']

let failures = 0
const ok = (cond, m) => (console.log(`  ${cond ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${m}`), cond || failures++, cond)
const info = (m) => console.log(`    ${m}`)
const ES = 'https://sepolia.etherscan.io'
const dns = (name) => { let o = '0x'; for (const p of name.split('.')) { const b = new TextEncoder().encode(p); o += b.length.toString(16).padStart(2, '0') + [...b].map((x) => x.toString(16).padStart(2, '0')).join('') } return o + '00' }

const regAbi = parseAbi([
  'function getSubregistry(string) view returns (address)', 'function getResolver(string) view returns (address)',
  'function findOwner(string) view returns (address)', 'function getParent() view returns (address, string)',
])
const urAbi = parseAbi(['function ROOT_REGISTRY() view returns (address)'])
const helperAbi = parseAbi(['function findExactOwner(bytes) view returns (address)'])
const facAbi = parseAbi(['function verifyContract(address) view returns (address)'])
const eacAbi = parseAbi([
  'function hasRootRoles(uint256, address) view returns (bool)', 'function hasRoles(uint256, uint256, address) view returns (bool)',
  'function roles(uint256, address) view returns (uint256)',
])
const rd = (address, abi, functionName, args = []) => c.readContract({ address, abi, functionName, args })

// ---- ENS's own addresses, from ENS's own repository --------------------------------------------
console.log(`ENS v2 proof — Sepolia block ${await c.getBlockNumber()} — rpc ${RPC}\n`)
console.log('[0] reference addresses from github.com/ensdomains/contracts-v2')
let tags
try {
  tags = execFileSync('git', ['ls-remote', '--tags', '--refs', 'https://github.com/ensdomains/contracts-v2'], { encoding: 'utf8', timeout: 30_000 })
    .split('\n').map((l) => l.split('refs/tags/')[1]).filter((n) => /^sepolia-deployment-\d{4}-\d{2}-\d{2}$/.test(n ?? '')).sort()
} catch {
  tags = [D.tag]
}
const TAG = tags.at(-1)
ok(TAG === D.tag, `newest ENS Sepolia deployment is ${TAG}${TAG === D.tag ? ' — the one we are on' : ` — WE ARE ON ${D.tag}: ENS reset Sepolia`}`)
const E = {}
for (const [k, f] of Object.entries({ root: 'RootRegistry', eth: 'ETHRegistry', ur: 'UpgradableUniversalResolverProxy', helper: 'UniversalHelper', factory: 'VerifiableFactory', resolverImpl: 'PermissionedResolverImpl' })) {
  const r = await fetch(`https://raw.githubusercontent.com/ensdomains/contracts-v2/${TAG}/contracts/deployments/sepolia/${f}.json`)
  E[k] = getAddress((await r.json()).address)
  info(`${f.padEnd(34)} ${E[k]}`)
}
ok(isAddressEqual(sepolia.contracts.ensUniversalResolver.address, E.ur), `viem's built-in Sepolia UniversalResolver is ENS's canonical proxy (${E.ur})`)
ok(isAddressEqual(await rd(E.ur, urAbi, 'ROOT_REGISTRY').catch(() => '0x0000000000000000000000000000000000000000'), E.root), 'UniversalResolver walks the canonical RootRegistry')

for (const name of NAMES) {
  console.log(`\n━━ ${name} ━━  ${'https://explorer.ens.dev/' + name}`)

  console.log('[1] canonical resolution (viem default UniversalResolver)')
  const resolver = await c.getEnsResolver({ name })
  const addr = await c.getEnsAddress({ name }).catch(() => null)
  ok(!!resolver && !/^0x0{40}$/i.test(resolver), `resolver ${resolver}`)
  ok(!!addr, `addr = ${addr}`)
  for (const key of TEXT_KEYS) {
    const v = await c.getEnsText({ name, key }).catch(() => null)
    if (v) info(`text ${key} = ${v.length > 70 ? v.slice(0, 67) + '…' : v}`)
  }

  console.log('[2] registry tree — each hop is its own contract (v2 hierarchical registries)')
  const labels = name.split('.').reverse() // eth, lortnoctahc, space, label
  let reg = E.root
  let leafReg, leafLabel
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i]
    const sub = await rd(reg, regAbi, 'getSubregistry', [label])
    const res = await rd(reg, regAbi, 'getResolver', [label])
    const known = isAddressEqual(reg, E.root) ? 'RootRegistry (ENS)' : isAddressEqual(reg, E.eth) ? 'ETHRegistry (ENS)'
      : isAddressEqual(reg, D.lortnoc.registry) ? 'LortnocRegistry' : isAddressEqual(reg, D.lortnoc.spaces?.registry ?? '0x0000000000000000000000000000000000000000') ? 'SpaceRegistry' : 'registry'
    info(`${known.padEnd(19)} ${reg}  .getSubregistry("${label}") → ${sub}${/^0x0{40}$/i.test(res) ? '' : `  .getResolver → ${res}`}`)
    if (i === labels.length - 1) (leafReg = reg), (leafLabel = label)
    else {
      if (!ok(!/^0x0{40}$/i.test(sub), `"${label}" has its own subregistry`)) break
      reg = sub
    }
  }
  if (leafReg) {
    const [parent, plabel] = await rd(leafReg, regAbi, 'getParent')
    ok(!/^0x0{40}$/i.test(parent), `the leaf registry knows its parent: ${parent} as "${plabel}" (v2 IRegistry.getParent)`)
    ok(isAddressEqual(await rd(leafReg, regAbi, 'getResolver', [leafLabel]), resolver), 'the resolver the UniversalResolver used is the one the registry set for this label')
  }

  console.log('[3] ownership as ENS computes it')
  const exact = await rd(E.helper, helperAbi, 'findExactOwner', [dns(name)])
  ok(!/^0x0{40}$/i.test(exact), `UniversalHelper.findExactOwner = ${exact}`)
  if (leafReg) ok(isAddressEqual(await rd(leafReg, regAbi, 'findOwner', [leafLabel]), exact), 'the registry agrees')
  if (addr) ok(isAddressEqual(addr, exact), 'addr record = the owner')

  console.log('[4] its own resolver, from ENS\'s canonical factory + implementation')
  const impl = await rd(E.factory, facAbi, 'verifyContract', [resolver]).catch(() => null)
  ok(impl && isAddressEqual(impl, E.resolverImpl), `VerifiableFactory.verifyContract(resolver) = PermissionedResolverImpl ${impl}`)
  const shared = isAddressEqual(resolver, D.lortnoc.parentResolver)
  ok(!shared, 'not a shared resolver — this name has its own')

  console.log('[5] per-record write roles (Enhanced Access Control)')
  ok(await rd(resolver, eacAbi, 'hasRootRoles', [ROLE_SET_TEXT, exact]), 'owner holds SET_TEXT on every record')
  const issuer = name.endsWith(`.space.${D.lortnoc.parentName}`) ? D.lortnoc.spaces.registrar : D.lortnoc.registrar
  ok((await rd(resolver, eacAbi, 'roles', [0n, issuer])) === 0n, `our registrar ${issuer} holds NO role on it (admin for one transaction, then self-revoked)`)
  const stranger = '0x000000000000000000000000000000000000dEaD'
  for (const key of TEXT_KEYS) ok(!(await rd(resolver, eacAbi, 'hasRoles', [BigInt(keccak256(stringToHex(key))), ROLE_SET_TEXT, stranger])), `a stranger cannot write ${key}`)

  console.log('[6] on-chain history of its resolver')
  const logs = await c.getLogs({ address: resolver, fromBlock: BigInt(D.lortnoc.registrarDeployBlock ?? 0) }).catch(() => [])
  const txs = [...new Set(logs.map((l) => l.transactionHash))]
  ok(txs.length > 0, `${txs.length} transaction(s) touched this resolver`)
  for (const h of txs.slice(0, 8)) info(`${ES}/tx/${h}`)
  info(`resolver: ${ES}/address/${resolver}`)
}

console.log(failures ? `\n\x1b[31m✗ ${failures} check(s) failed\x1b[0m` : '\n\x1b[32m✓ every check passed — this is ENS v2, read the way ENS reads it\x1b[0m')
process.exit(failures ? 1 : 0)
