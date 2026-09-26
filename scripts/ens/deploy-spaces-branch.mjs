#!/usr/bin/env node
// The `space.lortnoctahc.eth` branch for paid community spaces (docs/PRD-universal.md §23.1), on
// the ENS v2 deployment pinned in app/src/lib/live/ens-deployment.json. Idempotent: re-run after
// any failure and it skips whatever is already on-chain. Results → ens-deployment.json
// `lortnoc.spaces`. Sepolia only — there is no mainnet path in this script.
//
//   node scripts/ens/deploy-spaces-branch.mjs          (dry: checks + plan)
//   node scripts/ens/deploy-spaces-branch.mjs --yes    (spend Sepolia gas; PRIVATE_KEY from .env.local)
//
// Sequence (fork-proven in contracts/test/SpaceRegistrar.fork.t.sol):
//   1. SpaceRegistry — UserRegistry proxy via VerifiableFactory, deployer root admin
//   2. SpaceRegistry.setParent(LortnocRegistry, "space")
//   3. branch resolver — PermissionedResolver proxy for space.lortnoctahc.eth (IExtendedResolver, so
//      unclaimed spaces read EMPTY instead of reverting — fix #440), addr = deployer
//   4. LortnocRegistry.register("space", deployer, SpaceRegistry, branch resolver) — the deployer
//      holds ALL_ROLES on LortnocRegistry's root, which includes ROLE_REGISTRAR
//   5. SpaceRegistrar — constructor takes DNS-encoded space.lortnoctahc.eth; ROLE_REGISTRAR only
//   6. setRelayer(relayer)   (the production relayer signs with the deployer key)
//   7. LortnocDemoPass — open-mint ERC-721 for demo token gates
// Every tx goes through lib/ens.mjs sendTx: tip floored (zero-tip txs hang forever on public
// Sepolia RPCs) and a stuck tx is REPLACED at the same nonce, never re-sent at a new one.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { encodeFunctionData, encodeDeployData, keccak256, stringToHex, isAddressEqual } from 'viem'
import {
  ROOT, ENS, PARENT_NAME, PARENT_LABEL, ALL_ROLES, ROLE_REGISTRAR,
  registryAbi, factoryAbi, resolverAbi,
  clients, readDeployment, writeDeployment, send, sendTx, log, fmt, dnsEncode,
} from './lib/ens.mjs'

const YES = process.argv.includes('--yes') || process.argv.includes('-y')
const relayerIdx = process.argv.indexOf('--relayer')
const ZERO = '0x0000000000000000000000000000000000000000'
const BRANCH_LABEL = 'space'
const BRANCH_NAME = `${BRANCH_LABEL}.${PARENT_NAME}`
/** RegistryRolesLib: SET_SUBREGISTRY + SET_RESOLVER (+ admins). Same token roles as a handle. */
const OWNER_TOKEN_ROLES = (1n << 20n) | ((1n << 20n) << 128n) | (1n << 24n) | ((1n << 24n) << 128n)
const TAG_SUFFIX = readDeployment().tag.replace('sepolia-deployment-', '')
const SPACE_REGISTRY_SALT = BigInt(keccak256(stringToHex(`lortnoc/space-registry/${TAG_SUFFIX}`)))
const SPACE_RESOLVER_SALT = BigInt(keccak256(stringToHex(`lortnoc/space-resolver/${TAG_SUFFIX}`)))

const artifact = (name) => join(ROOT, 'contracts', 'out', `${name}.sol`, `${name}.json`)
const spaceRegistrarAbi = [
  { type: 'function', name: 'REGISTRY', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'PARENT_NODE', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'isRelayer', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'setRelayer', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'bool' }], outputs: [] },
]
const passAbi = [{ type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }]
const registryExtraAbi = [
  { type: 'function', name: 'findExpiry', stateMutability: 'view', inputs: [{ name: 'label', type: 'string' }], outputs: [{ type: 'uint64' }] },
]

async function main() {
  const { publicClient: pc, walletClient: wc, account, rpc } = clients()
  const deployment = readDeployment()
  const L = deployment.lortnoc
  const S = (L.spaces ??= {})
  const persist = () => writeDeployment(deployment)
  const branchDns = dnsEncode(BRANCH_NAME)
  const RELAYER = relayerIdx !== -1 ? process.argv[relayerIdx + 1] : process.env.RELAYER_ADDRESS || account.address
  const read = (address, abi, functionName, args = []) => pc.readContract({ address, abi, functionName, args })
  const isProxyOf = async (addr, impl) =>
    !!addr && isAddressEqual(await read(ENS.verifiableFactory, factoryAbi, 'verifyContract', [addr]).catch(() => ZERO), impl)

  console.log(`\n\x1b[1mlortnoc_tahc — ${BRANCH_NAME} branch @ ${deployment.tag}\x1b[0m`)
  console.log(`  rpc      ${rpc}\n  deployer ${account.address}\n  relayer  ${RELAYER}`)

  log.step('Preflight')
  const chainId = await pc.getChainId()
  if (chainId !== 11155111) throw new Error(`chain id ${chainId} is not Sepolia — refusing`)
  for (const [n, a] of Object.entries({ ...ENS, lortnocRegistry: L.registry })) {
    const code = await pc.getCode({ address: a })
    if (!code || code === '0x') throw new Error(`${n} (${a}) has no code — run scripts/ens/preflight.mjs`)
  }
  if (!(await read(L.registry, registryAbi, 'hasRootRoles', [ROLE_REGISTRAR, account.address]))) {
    throw new Error(`deployer lacks ROLE_REGISTRAR on LortnocRegistry ${L.registry}`)
  }
  const bal = await pc.getBalance({ address: account.address })
  log.ok(`contracts have code; deployer may register under ${PARENT_NAME}; ${(Number(bal) / 1e18).toFixed(4)} ETH`)
  if (bal < 10n ** 16n) throw new Error('wallet has < 0.01 ETH')
  for (const n of ['SpaceRegistrar', 'LortnocDemoPass']) {
    if (!existsSync(artifact(n))) throw new Error(`build first: forge build --root contracts (${n} missing)`)
  }
  const holder = await read(L.registry, registryAbi, 'findOwner', [BRANCH_LABEL])
  if (!isAddressEqual(holder, ZERO) && !isAddressEqual(holder, account.address)) {
    throw new Error(`"${BRANCH_LABEL}" is held by ${holder} in LortnocRegistry — stop`)
  }
  if (!YES) {
    console.log(`\n  Plan: SpaceRegistry, branch resolver, register "${BRANCH_LABEL}", SpaceRegistrar, relayer, LortnocDemoPass.`)
    console.log('  Re-run with --yes to spend Sepolia gas.\n')
    return
  }

  // 1. SpaceRegistry
  log.step('SpaceRegistry — UserRegistry proxy')
  if (await isProxyOf(S.registry, ENS.userRegistryImpl)) log.skip(`at ${S.registry}`)
  else {
    const init = encodeFunctionData({ abi: registryAbi, functionName: 'initialize', args: [[{ account: account.address, roleBitmap: ALL_ROLES }]] })
    const { result, request } = await pc.simulateContract({
      account, address: ENS.verifiableFactory, abi: factoryAbi, functionName: 'deployProxy', args: [ENS.userRegistryImpl, SPACE_REGISTRY_SALT, init],
    })
    await send(pc, wc, request, 'deployProxy(SpaceRegistry)')
    if (!(await isProxyOf(result, ENS.userRegistryImpl))) throw new Error(`verifyContract(${result}) != UserRegistryImpl`)
    S.registry = result
    persist()
    log.ok(`deployed ${result}`)
  }

  // 2. setParent
  log.step(`SpaceRegistry.setParent(LortnocRegistry, "${BRANCH_LABEL}")`)
  const [pAddr, pLabel] = await read(S.registry, registryAbi, 'getParent')
  if (isAddressEqual(pAddr, L.registry) && pLabel === BRANCH_LABEL) log.skip('parent set')
  else {
    const { request } = await pc.simulateContract({ account, address: S.registry, abi: registryAbi, functionName: 'setParent', args: [L.registry, BRANCH_LABEL] })
    await send(pc, wc, request, 'setParent')
    log.ok('parent set')
  }

  // 3. branch resolver
  log.step(`Resolver for ${BRANCH_NAME}`)
  if (await isProxyOf(S.resolver, ENS.permissionedResolverImpl)) log.skip(`at ${S.resolver}`)
  else {
    const init = encodeFunctionData({
      abi: resolverAbi, functionName: 'initialize',
      args: [
        [{ account: account.address, roleBitmap: ALL_ROLES }],
        [encodeFunctionData({ abi: resolverAbi, functionName: 'setAddress', args: [branchDns, 60n, account.address] })],
      ],
    })
    const { result, request } = await pc.simulateContract({
      account, address: ENS.verifiableFactory, abi: factoryAbi, functionName: 'deployProxy', args: [ENS.permissionedResolverImpl, SPACE_RESOLVER_SALT, init],
    })
    await send(pc, wc, request, 'deployProxy(space resolver)')
    S.resolver = result
    persist()
    log.ok(`deployed ${result}`)
  }

  // 4. register the branch label
  log.step(`LortnocRegistry.register("${BRANCH_LABEL}")`)
  if (isAddressEqual(await read(L.registry, registryAbi, 'findOwner', [BRANCH_LABEL]), account.address)) {
    const tokenId = await read(L.registry, registryAbi, 'findTokenId', [BRANCH_LABEL])
    const sub = await read(L.registry, registryAbi, 'getSubregistry', [BRANCH_LABEL])
    const res = await read(L.registry, registryAbi, 'getResolver', [BRANCH_LABEL])
    if (isAddressEqual(sub, S.registry)) log.skip(`subregistry ${fmt.addr(sub)}`)
    else {
      const { request } = await pc.simulateContract({ account, address: L.registry, abi: registryAbi, functionName: 'setSubregistry', args: [tokenId, S.registry] })
      await send(pc, wc, request, 'setSubregistry(space)')
    }
    if (isAddressEqual(res, S.resolver)) log.skip(`resolver ${fmt.addr(res)}`)
    else {
      const { request } = await pc.simulateContract({ account, address: L.registry, abi: registryAbi, functionName: 'setResolver', args: [tokenId, S.resolver] })
      await send(pc, wc, request, 'setResolver(space)')
    }
  } else {
    // Expires with the parent: a branch outliving lortnoctahc.eth would resolve nothing anyway.
    const expiry = await read(ENS.ethRegistry, registryExtraAbi, 'findExpiry', [PARENT_LABEL])
    const { request } = await pc.simulateContract({
      account, address: L.registry, abi: registryAbi, functionName: 'register',
      args: [BRANCH_LABEL, account.address, S.registry, S.resolver, OWNER_TOKEN_ROLES, expiry],
    })
    await send(pc, wc, request, 'register(space)')
    log.ok(`registered, expires ${new Date(Number(expiry) * 1000).toISOString().slice(0, 10)}`)
  }

  // 5. SpaceRegistrar
  log.step('SpaceRegistrar')
  const registrarOk = async (a) => !!a && isAddressEqual(await read(a, spaceRegistrarAbi, 'REGISTRY').catch(() => ZERO), S.registry)
  if (await registrarOk(S.registrar)) log.skip(`at ${S.registrar}`)
  else {
    const art = JSON.parse(readFileSync(artifact('SpaceRegistrar'), 'utf8'))
    const data = encodeDeployData({
      abi: art.abi, bytecode: art.bytecode.object,
      args: [S.registry, ENS.verifiableFactory, ENS.permissionedResolverImpl, branchDns, account.address],
    })
    const r = await sendTx(pc, wc, { to: undefined, data }, 'deploy SpaceRegistrar')
    S.registrar = r.contractAddress
    S.registrarDeployBlock = Number(r.blockNumber)
    persist()
    log.ok(`deployed ${S.registrar} in block ${r.blockNumber}`)
  }

  log.step('Grant ROLE_REGISTRAR (only) to SpaceRegistrar on SpaceRegistry')
  if (await read(S.registry, registryAbi, 'hasRootRoles', [ROLE_REGISTRAR, S.registrar])) log.skip('held')
  else {
    const { request } = await pc.simulateContract({ account, address: S.registry, abi: registryAbi, functionName: 'grantRootRoles', args: [ROLE_REGISTRAR, S.registrar] })
    await send(pc, wc, request, 'grantRootRoles')
    log.ok('granted')
  }

  // 6. relayer
  log.step(`setRelayer(${fmt.addr(RELAYER)})`)
  if (await read(S.registrar, spaceRegistrarAbi, 'isRelayer', [RELAYER])) log.skip('already a relayer')
  else {
    const { request } = await pc.simulateContract({ account, address: S.registrar, abi: spaceRegistrarAbi, functionName: 'setRelayer', args: [RELAYER, true] })
    await send(pc, wc, request, 'setRelayer')
    log.ok('claimSpaceFor enabled')
  }

  // 7. demo pass
  log.step('LortnocDemoPass (open-mint ERC-721, testnet)')
  if (S.demoPass && (await read(S.demoPass, passAbi, 'symbol').catch(() => '')) === 'LDP') log.skip(`at ${S.demoPass}`)
  else {
    const art = JSON.parse(readFileSync(artifact('LortnocDemoPass'), 'utf8'))
    const r = await sendTx(pc, wc, { to: undefined, data: art.bytecode.object }, 'deploy LortnocDemoPass')
    S.demoPass = r.contractAddress
    persist()
    log.ok(`deployed ${S.demoPass}`)
  }

  S.branchName = BRANCH_NAME
  S.deployedAt ??= new Date().toISOString()
  persist()

  const a = await pc.getEnsAddress({ name: BRANCH_NAME })
  console.log(`\n\x1b[1m\x1b[32mBranch ready.\x1b[0m`)
  for (const k of ['registry', 'resolver', 'registrar', 'demoPass']) console.log(`  ${k.padEnd(10)} ${S[k]}`)
  console.log(`  getEnsAddress(${BRANCH_NAME}) via viem's default UR → ${a}\n`)
  if (!a || !isAddressEqual(a, account.address)) throw new Error(`${BRANCH_NAME} does not resolve to the deployer`)
}

main().catch((e) => {
  console.error(`\n\x1b[31merror:\x1b[0m ${e.shortMessage || e.message}`)
  process.exit(1)
})
