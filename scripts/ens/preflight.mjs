#!/usr/bin/env node
// scripts/ens/preflight.mjs — G1 (docs/PRD-universal.md §14). READ-ONLY. Exits non-zero on ANY failure.
// The ✓ source (status.mjs runs it). Targets ENS v2 `sepolia-deployment-2026-09-15` and later.
//
// Rule: verify the way ENS's OWN tooling sees us, never through our wrapper.
//   * Resolution = viem getEnsAddress / getEnsText / getEnsResolver with viem's BUILT-IN sepolia
//     UniversalResolver (0xeeee…eeee) — the exact path manager.ens.dev / explorer.ens.dev take.
//   * Ownership  = UniversalHelper.findExactOwner(name) from the CURRENT root (PRD §16.4 `holder`).
//   * Canonical addresses = ensdomains/contracts-v2's NEWEST `sepolia-deployment-*` tag on GitHub.
//   * Nothing imported from app/src/lib/live/ens.ts or scripts/ens/lib. No keys, no .env, no writes.
//
//   node scripts/ens/preflight.mjs                 # live Sepolia
//   CHECK_RPC=http://127.0.0.1:8548 node …         # an anvil fork
//   ENS_DEPLOYMENT_JSON=<path>  --offline-tags  PARENT_MIN_DAYS=60
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createPublicClient, http, parseAbi, parseAbiItem, getAddress, isAddressEqual } from 'viem'
import { sepolia } from 'viem/chains'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const DEPLOYMENT = process.env.ENS_DEPLOYMENT_JSON || `${HERE}../../app/src/lib/live/ens-deployment.json`
const RPC = process.env.CHECK_RPC || 'https://ethereum-sepolia-rpc.publicnode.com'
const PARENT_MIN_DAYS = Number(process.env.PARENT_MIN_DAYS ?? 60)
const CANONICAL_UR = sepolia.contracts.ensUniversalResolver.address // 0xeeee…eeee
const ZERO = '0x0000000000000000000000000000000000000000'
const PUBKEY = 'eth.lortnoc.pubkey'
const D = JSON.parse(readFileSync(DEPLOYMENT, 'utf8'))
const c = createPublicClient({ chain: sepolia, transport: http(RPC, { timeout: 30000, retryCount: 3 }) })

const failures = []
const fail = (m) => { failures.push(m); console.log(`  \x1b[31mFAIL\x1b[0m ${m}`) }
const pass = (m) => console.log(`  \x1b[32mok\x1b[0m   ${m}`)
const warn = (m) => console.log(`  \x1b[33mwarn\x1b[0m ${m}`)
const rd = (address, abi, functionName, args = []) => c.readContract({ address, abi, functionName, args })
const dns = (name) => { let o = '0x'; for (const p of name.split('.').filter(Boolean)) { const b = new TextEncoder().encode(p); o += b.length.toString(16).padStart(2, '0') + [...b].map((x) => x.toString(16).padStart(2, '0')).join('') } return o + '00' }
const short = (e) => (e?.shortMessage || e?.message || String(e)).split('\n')[0].slice(0, 110)

const urAbi = parseAbi(['function ROOT_REGISTRY() view returns (address)'])
const regAbi = parseAbi([
  'function getSubregistry(string) view returns (address)', 'function getResolver(string) view returns (address)',
  'function findOwner(string) view returns (address)', 'function findExpiry(string) view returns (uint64)',
  'function getParent() view returns (address, string)',
])
const helperAbi = parseAbi(['function findExactOwner(bytes) view returns (address)', 'function ROOT_REGISTRY() view returns (address)'])
const facAbi = parseAbi(['function verifyContract(address) view returns (address)'])
const labelRegistered = parseAbiItem('event LabelRegistered(uint256 indexed tokenId, bytes32 indexed labelHash, string label, address owner, uint64 expiry, address indexed sender)')

// ens-deployment.json key → contracts/deployments/sepolia/<file>.json at a tag.
const FILES = {
  rootRegistry: 'RootRegistry', ethRegistry: 'ETHRegistry', ethRegistrar: 'ETHRegistrar',
  permissionedResolverImpl: 'PermissionedResolverImpl', userRegistryImpl: 'UserRegistryImpl',
  verifiableFactory: 'VerifiableFactory', universalResolver: 'UpgradableUniversalResolverProxy',
  universalHelper: 'UniversalHelper', mockUSDC: 'MockUSDC',
}

console.log(`ENS v2 preflight (G1) — rpc ${RPC} — block ${await c.getBlockNumber()}`)
console.log(`pinned tag ${D.tag}; canonical UR (viem default) ${CANONICAL_UR}\n`)

// ---- [1] our tag is the NEWEST canonical deployment, and every address matches it ---------------
console.log('[1] ens-deployment.json vs ensdomains/contracts-v2')
if (!D.tag) fail('ens-deployment.json has no `tag`')
if (process.argv.includes('--offline-tags')) warn('GitHub tag check skipped (--offline-tags) — NOT a pass')
else {
  try {
    // `git ls-remote` first: it is not subject to the unauthenticated REST API's 60 req/h limit
    // (which a CI runner or a busy laptop exhausts). REST API (optionally with GITHUB_TOKEN) as fallback.
    let names
    try {
      names = execFileSync('git', ['ls-remote', '--tags', '--refs', 'https://github.com/ensdomains/contracts-v2'], { encoding: 'utf8', timeout: 30000 })
        .split('\n').map((l) => l.split('refs/tags/')[1]).filter(Boolean)
    } catch {
      const res = await fetch('https://api.github.com/repos/ensdomains/contracts-v2/tags?per_page=100', { headers: { 'user-agent': 'lortnoc-preflight', ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } })
      if (!res.ok) throw new Error(`git ls-remote failed and GitHub tags API returned HTTP ${res.status}`)
      names = (await res.json()).map((t) => t.name)
    }
    const tags = names.filter((n) => /^sepolia-deployment-\d{4}-\d{2}-\d{2}$/.test(n)).sort()
    const newest = tags.at(-1)
    if (newest !== D.tag) fail(`NEWER canonical deployment exists: ${newest} (ours ${D.tag}) — ENS has likely reset Sepolia; our names are probably gone from the canonical root`)
    else pass(`our tag is the newest canonical deployment (${newest})`)
    for (const [k, f] of Object.entries(FILES)) {
      if (!D.ens?.[k]) { fail(`ens.${k} missing from ens-deployment.json`); continue }
      const r = await fetch(`https://raw.githubusercontent.com/ensdomains/contracts-v2/${D.tag}/contracts/deployments/sepolia/${f}.json`)
      if (!r.ok) { fail(`${f}.json missing at ${D.tag} (HTTP ${r.status})`); continue }
      const a = (await r.json()).address
      if (!isAddressEqual(a, D.ens[k])) fail(`ens.${k}: ours ${D.ens[k]} != ${D.tag} ${a}`)
    }
    pass(`${Object.keys(FILES).length} ENS addresses checked against ${D.tag}`)
  } catch (e) { fail(`could not read GitHub tags/deployments: ${short(e)}`) }
}
const ours = { LortnocRegistry: D.lortnoc?.registry, LortnocRegistrar: D.lortnoc?.registrar, parentResolver: D.lortnoc?.parentResolver }
for (const [k, a] of [...Object.entries(D.ens ?? {}), ...Object.entries(ours)]) {
  if (!a) { fail(`${k} address missing`); continue }
  const code = await c.getCode({ address: a }).catch(() => null)
  if (!code || code === '0x') fail(`${k} ${a} has no bytecode`)
}
pass('bytecode present for every address')

// ---- [2] the resolver ENS's tooling uses walks OUR root, and our registry hangs off it ---------
console.log('\n[2] canonical root → eth → lortnoctahc → LortnocRegistry')
if (!isAddressEqual(D.ens.universalResolver, CANONICAL_UR)) fail(`ens.universalResolver ${D.ens.universalResolver} is not viem's default ${CANONICAL_UR} — we would be checking a private path`)
const root = await rd(CANONICAL_UR, urAbi, 'ROOT_REGISTRY')
if (!isAddressEqual(root, D.ens.rootRegistry)) fail(`canonical UR walks root ${root}, ours is ${D.ens.rootRegistry} — our names are INVISIBLE to viem / ENS app / explorer`)
else pass(`canonical UR root == ${root}`)
const helperRoot = await rd(D.ens.universalHelper, helperAbi, 'ROOT_REGISTRY').catch(() => ZERO)
if (!isAddressEqual(helperRoot, root)) fail(`UniversalHelper root ${helperRoot} != canonical root ${root}`)
const [parentLabel] = D.lortnoc.parentName.split('.')
const ethReg = await rd(root, regAbi, 'getSubregistry', ['eth'])
if (!isAddressEqual(ethReg, D.ens.ethRegistry)) fail(`root.getSubregistry("eth") = ${ethReg}, ours ${D.ens.ethRegistry}`)
const sub = await rd(ethReg, regAbi, 'getSubregistry', [parentLabel])
if (!isAddressEqual(sub, D.lortnoc.registry)) fail(`${D.lortnoc.parentName} subregistry on the canonical root = ${sub}, expected LortnocRegistry ${D.lortnoc.registry}`)
else pass(`${D.lortnoc.parentName} → LortnocRegistry ${sub}`)
const [pParent, pLabel] = await rd(D.lortnoc.registry, regAbi, 'getParent').catch(() => [ZERO, ''])
if (!isAddressEqual(pParent, ethReg) || pLabel !== parentLabel) fail(`LortnocRegistry.getParent() = (${pParent}, "${pLabel}") — setParent(ETHRegistry, "${parentLabel}") missing; canonical-name lookups will fail`)

// ---- [3] the parent itself ---------------------------------------------------------------------
console.log('\n[3] parent name')
const now = Number((await c.getBlock()).timestamp)
const parentOwner = await rd(ethReg, regAbi, 'findOwner', [parentLabel])
const parentExpiry = Number(await rd(ethReg, regAbi, 'findExpiry', [parentLabel]))
const daysLeft = (parentExpiry - now) / 86400
if (isAddressEqual(parentOwner, ZERO)) fail(`${D.lortnoc.parentName} has no owner on the canonical root (expired or never registered)`)
else if (daysLeft < PARENT_MIN_DAYS) fail(`${D.lortnoc.parentName} expires in ${daysLeft.toFixed(1)} days (< ${PARENT_MIN_DAYS}) — EVERY handle vanishes with it; renew via ETHRegistrar.renew`)
else pass(`${D.lortnoc.parentName} owner ${parentOwner}, expires ${new Date(parentExpiry * 1000).toISOString().slice(0, 10)} (${daysLeft.toFixed(0)} d)`)
try {
  const a = await c.getEnsAddress({ name: D.lortnoc.parentName })
  if (!a) fail(`${D.lortnoc.parentName}: getEnsAddress = null (parent resolver unlinked or addr unset)`)
  else pass(`getEnsAddress(${D.lortnoc.parentName}) = ${a}`)
} catch (e) { fail(`${D.lortnoc.parentName}: canonical resolve threw ${short(e)}`) }
// A default record (written to name 0x00) on the parent resolver would make EVERY unclaimed label
// resolve, because since fix #440 the parent resolver answers for non-leaf lookups.
const ghost = `preflight-ghost-${now.toString(36)}.${D.lortnoc.parentName}`
try {
  const g = await c.getEnsAddress({ name: ghost })
  if (g) fail(`unclaimed ${ghost} resolves to ${g} — a default record leaked onto the parent resolver`)
  else pass('unclaimed labels resolve to nothing (no default record leak)')
} catch (e) { warn(`ghost lookup threw ${short(e)}`) }

// ---- [4] every handle, enumerated from chain ---------------------------------------------------
console.log('\n[4] every handle via canonical UR + UniversalHelper')
const head = await c.getBlockNumber()
const from = BigInt(D.lortnoc.registrarDeployBlock ?? 0)
const logs = []
for (let b = from; b <= head; b += 50000n) logs.push(...await c.getLogs({ address: D.lortnoc.registry, event: labelRegistered, fromBlock: b, toBlock: b + 49999n > head ? head : b + 49999n }))
const labels = [...new Set(logs.map((l) => l.args.label))]
console.log(`  ${labels.length} handles on-chain: ${labels.join(', ') || '(none)'}`)
if (!labels.length) warn('no handles — nothing for a judge to resolve')
for (const label of labels) {
  const name = `${label}.${D.lortnoc.parentName}`
  const before = failures.length
  const f = (m) => fail(`${name}: ${m}`)
  try {
    const [addr, pubkey, resolver, exact, regOwner, regRes, expiry] = await Promise.all([
      c.getEnsAddress({ name }), c.getEnsText({ name, key: PUBKEY }), c.getEnsResolver({ name }),
      rd(D.ens.universalHelper, helperAbi, 'findExactOwner', [dns(name)]),
      rd(D.lortnoc.registry, regAbi, 'findOwner', [label]), rd(D.lortnoc.registry, regAbi, 'getResolver', [label]),
      rd(D.lortnoc.registry, regAbi, 'findExpiry', [label]),
    ])
    if (isAddressEqual(exact, ZERO)) f('findExactOwner = 0 (expired, or not reachable from the canonical root)')
    else if (!isAddressEqual(exact, regOwner)) f(`findExactOwner ${exact} != registry.findOwner ${regOwner}`)
    if (!addr) f('addr(60) unset — explorers show "does not resolve"')
    else if (!isAddressEqual(exact, ZERO) && !isAddressEqual(addr, exact)) warn(`${name}: addr ${addr} != registry owner ${exact} (holder checks use the OWNER, PRD §16.4)`)
    if (!pubkey) f(`${PUBKEY} missing`)
    if (!isAddressEqual(resolver, regRes)) f(`UR used resolver ${resolver}, registry says ${regRes} (leaf resolver missing → parent fallback?)`)
    const impl = await rd(D.ens.verifiableFactory, facAbi, 'verifyContract', [resolver]).catch(() => ZERO)
    if (!isAddressEqual(impl, D.ens.permissionedResolverImpl)) f(`verifyContract(${resolver}) = ${impl}, expected ${D.ens.permissionedResolverImpl}`)
    if (Number(expiry) > parentExpiry) warn(`${name}: expires after the parent (${new Date(Number(expiry) * 1000).toISOString().slice(0, 10)}) — only as long as the parent is renewed`)
    if (failures.length === before) pass(`${name} owner=${exact} addr=${addr} pubkey=${pubkey.slice(0, 10)}…`)
  } catch (e) { f(`canonical resolution threw ${short(e)}`) }
}

console.log(`\n${failures.length ? `\x1b[31mPREFLIGHT FAILED — ${failures.length} problem(s)\x1b[0m` : '\x1b[32mPREFLIGHT PASSED\x1b[0m'}`)
process.exit(failures.length ? 1 : 0)
