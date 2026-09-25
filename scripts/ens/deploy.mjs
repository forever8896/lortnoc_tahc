#!/usr/bin/env node
// ENS v2 setup for lortnoc_tahc on Sepolia, targeting the deployment pinned in
// app/src/lib/live/ens-deployment.json (`tag`, currently sepolia-deployment-2026-09-15).
// Idempotent: safe to re-run after a failure, it skips whatever is already on-chain for THIS tag.
// Writes the resulting addresses back into ens-deployment.json, which arms the app's live mode.
//
//   node scripts/ens/deploy.mjs              (dry: checks + prints the plan; PRIVATE_KEY from .env.local)
//   node scripts/ens/deploy.mjs --yes        (spend Sepolia gas)
//   RPC_URL=http://127.0.0.1:8545 node scripts/ens/deploy.mjs --yes --fork   (anvil fork dry-run)
//
// Sequence (fork-proven, research-tokyo/migration/PLAN.md §3):
//   1. preflight — pinned ENS v2 addresses have code, wallet is funded
//   2. lortnoctahc.eth — already ours? else commit → wait → register (MockUSDC-priced)
//   3. LortnocRegistry — UserRegistry proxy via VerifiableFactory, initialize(Grant[])
//   4. registry.setParent(ETHRegistry, "lortnoctahc") — canonical-name lookups need it
//   5. LortnocRegistrar — constructor takes the DNS-encoded parent; gets ROLE_REGISTRAR only
//   6. setRelayer(relayer) — a fresh registrar does NOT inherit relayers (§6.5 gotcha)
//   7. parent resolver — PermissionedResolver proxy, addr written by its initializer
//   8. ETHRegistry.setSubregistry + setResolver for lortnoctahc.eth
// Then: node scripts/ens/migrate-handles.mjs --yes --close, and node scripts/ens/preflight.mjs.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { encodeFunctionData, encodeDeployData, keccak256, stringToHex, toHex, isAddressEqual } from 'viem'
import {
  ROOT, ENS, PARENT_NAME, PARENT_LABEL,
  ALL_ROLES, ROLE_REGISTRAR,
  registryAbi, factoryAbi, erc20Abi, ethRegistrarAbi, registrarAbi, resolverAbi,
  clients, contracts, readDeployment, writeDeployment, send, sendTx, sleep, log, fmt, dnsEncode,
} from './lib/ens.mjs'

const args = process.argv.slice(2)
const YES = args.includes('--yes') || args.includes('-y')
/** Dry-run against an `anvil --fork-url <sepolia>` node: lets us warp past the commitment wait. */
const FORK = args.includes('--fork')
const relayerIdx = args.indexOf('--relayer')

const ZERO = '0x0000000000000000000000000000000000000000'
const DURATION = 31536000n // 1 year
// Salts are namespaced per ENS deployment tag: outerSalt = keccak(msg.sender, salt), so re-using a
// salt after a Sepolia reset would be harmless, but distinct salts keep explorers unambiguous.
const TAG_SUFFIX = readDeployment().tag.replace('sepolia-deployment-', '')
const REGISTRY_SALT = BigInt(keccak256(stringToHex(`lortnoc/registry/${TAG_SUFFIX}`)))
const PARENT_RESOLVER_SALT = BigInt(keccak256(stringToHex(`lortnoc/parent-resolver/${TAG_SUFFIX}`)))
// Resume file: the commit-reveal secret must survive a crash between the two txs.
const STATE_PATH = join(ROOT, 'scripts', 'ens', '.deploy-state.json')
const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {}
const saveState = () => writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n')

const ARTIFACT = join(ROOT, 'contracts', 'out', 'LortnocRegistrar.sol', 'LortnocRegistrar.json')

async function main() {
  const { publicClient, walletClient, account, rpc } = clients()
  const c = contracts(publicClient, walletClient)
  const deployment = readDeployment()
  const L = deployment.lortnoc
  const parentDns = dnsEncode(PARENT_NAME)
  const labelId = BigInt(keccak256(stringToHex(PARENT_LABEL)))
  // The production relayer signs with the deployer key, so it is the default relayer address.
  const RELAYER = relayerIdx !== -1 ? args[relayerIdx + 1] : process.env.RELAYER_ADDRESS || account.address
  const persist = () => writeDeployment(deployment)

  console.log(`\n\x1b[1mlortnoc_tahc — ENS v2 setup @ ${deployment.tag}\x1b[0m`)
  console.log(`  rpc      ${rpc}`)
  console.log(`  deployer ${account.address}`)
  console.log(`  parent   ${PARENT_NAME}`)
  console.log(`  relayer  ${RELAYER}`)

  // ---- 1. preflight ---------------------------------------------------------------------------
  log.step('Preflight — pinned ENS v2 addresses and wallet')
  const chainId = await publicClient.getChainId()
  if (chainId !== deployment.chainId) throw new Error(`chain id ${chainId} != expected ${deployment.chainId} (wrong RPC?)`)
  for (const [name, address] of Object.entries(ENS)) {
    const code = await publicClient.getCode({ address })
    if (!code || code === '0x') {
      throw new Error(`${name} (${address}) has no code. ${deployment.tag} may have rotated — run scripts/ens/preflight.mjs.`)
    }
  }
  log.ok(`${Object.keys(ENS).length} contracts have code at tag ${deployment.tag}`)
  const balance = await publicClient.getBalance({ address: account.address })
  log.info(`ETH balance ${(Number(balance) / 1e18).toFixed(4)}`)
  if (balance < 2n * 10n ** 16n) throw new Error('wallet has < 0.02 ETH — top up before deploying')
  if (!existsSync(ARTIFACT)) throw new Error('build the contract first: forge build --root contracts')

  if (!YES) {
    console.log(`\n  This spends real Sepolia gas from ${account.address} (~2.6M gas for setup).`)
    console.log(`  Re-run with --yes to proceed.\n`)
    process.exit(0)
  }

  // ---- 2. the parent name ---------------------------------------------------------------------
  log.step(`${PARENT_NAME} on the ${deployment.tag} ETHRegistry`)
  const parentOwner = await c.ethRegistry.read.findOwner([PARENT_LABEL])
  if (isAddressEqual(parentOwner, account.address)) {
    log.skip(`owned by ${fmt.addr(parentOwner)}, expires ${new Date(Number(await c.ethRegistry.read.findExpiry([PARENT_LABEL])) * 1000).toISOString().slice(0, 10)}`)
  } else if (!isAddressEqual(parentOwner, ZERO)) {
    throw new Error(`${PARENT_NAME} is owned by ${parentOwner}, not us — stop`)
  } else {
    await registerParent(publicClient, walletClient, account, c)
  }

  // ---- 3. LortnocRegistry ---------------------------------------------------------------------
  log.step('LortnocRegistry — UserRegistry proxy via VerifiableFactory')
  const isOurs = async (addr, impl) =>
    !!addr &&
    isAddressEqual(
      await publicClient.readContract({ address: ENS.verifiableFactory, abi: factoryAbi, functionName: 'verifyContract', args: [addr] }).catch(() => ZERO),
      impl,
    )
  if (await isOurs(L.registry, ENS.userRegistryImpl)) {
    log.skip(`at ${L.registry}`)
  } else {
    const initData = encodeFunctionData({ abi: registryAbi, functionName: 'initialize', args: [[{ account: account.address, roleBitmap: ALL_ROLES }]] })
    const { result, request } = await publicClient.simulateContract({
      account, address: ENS.verifiableFactory, abi: factoryAbi, functionName: 'deployProxy',
      args: [ENS.userRegistryImpl, REGISTRY_SALT, initData],
    })
    await send(publicClient, walletClient, request, 'deployProxy(UserRegistry)')
    if (!(await isOurs(result, ENS.userRegistryImpl))) throw new Error(`verifyContract(${result}) != UserRegistryImpl`)
    L.registry = result
    persist()
    log.ok(`deployed ${result} (verifyContract → UserRegistryImpl ✓)`)
  }

  // ---- 4. setParent ---------------------------------------------------------------------------
  log.step('registry.setParent(ETHRegistry, parent label)')
  const [pAddr, pLabel] = await publicClient.readContract({ address: L.registry, abi: registryAbi, functionName: 'getParent' })
  if (isAddressEqual(pAddr, ENS.ethRegistry) && pLabel === PARENT_LABEL) {
    log.skip('parent already set')
  } else {
    const { request } = await publicClient.simulateContract({
      account, address: L.registry, abi: registryAbi, functionName: 'setParent', args: [ENS.ethRegistry, PARENT_LABEL],
    })
    await send(publicClient, walletClient, request, 'setParent')
    log.ok(`getParent() → (ETHRegistry, "${PARENT_LABEL}")`)
  }

  // ---- 5. LortnocRegistrar --------------------------------------------------------------------
  log.step('LortnocRegistrar — permissionless handle issuance + one-shot migrate()')
  const registrarOk = async (addr) => {
    if (!addr) return false
    try {
      const reg = await publicClient.readContract({ address: addr, abi: registrarAbi, functionName: 'REGISTRY' })
      await publicClient.readContract({ address: addr, abi: registrarAbi, functionName: 'migrationOpen' })
      return isAddressEqual(reg, L.registry)
    } catch { return false }
  }
  if (await registrarOk(L.registrar)) {
    log.skip(`at ${L.registrar}`)
  } else {
    const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'))
    const data = encodeDeployData({
      abi: artifact.abi, bytecode: artifact.bytecode.object,
      args: [L.registry, ENS.verifiableFactory, ENS.permissionedResolverImpl, parentDns, account.address],
    })
    const receipt = await sendTx(publicClient, walletClient, { to: undefined, data }, 'deploy LortnocRegistrar')
    L.registrar = receipt.contractAddress
    L.registrarDeployBlock = Number(receipt.blockNumber)
    persist()
    log.ok(`deployed ${L.registrar} in block ${receipt.blockNumber}`)
  }

  log.step('Grant ROLE_REGISTRAR (only) to LortnocRegistrar')
  const hasRole = await publicClient.readContract({ address: L.registry, abi: registryAbi, functionName: 'hasRootRoles', args: [ROLE_REGISTRAR, L.registrar] })
  if (hasRole) log.skip('registrar already holds ROLE_REGISTRAR')
  else {
    const { request } = await publicClient.simulateContract({
      account, address: L.registry, abi: registryAbi, functionName: 'grantRootRoles', args: [ROLE_REGISTRAR, L.registrar],
    })
    await send(publicClient, walletClient, request, 'grantRootRoles')
    log.ok('LortnocRegistrar may now issue subnames — and nothing else')
  }

  // ---- 6. relayer -----------------------------------------------------------------------------
  log.step(`setRelayer(${fmt.addr(RELAYER)}, true)`)
  if (await publicClient.readContract({ address: L.registrar, abi: registrarAbi, functionName: 'isRelayer', args: [RELAYER] })) log.skip('already a relayer')
  else {
    const { request } = await publicClient.simulateContract({
      account, address: L.registrar, abi: registrarAbi, functionName: 'setRelayer', args: [RELAYER, true],
    })
    await send(publicClient, walletClient, request, 'setRelayer')
    log.ok('relayed claims (claimFor) enabled')
  }

  // ---- 7. parent resolver ---------------------------------------------------------------------
  // Explorers resolve lortnoctahc.eth itself; since fix #440 a resolver at a non-leaf is only used
  // if it is an IExtendedResolver, which PermissionedResolver is. NEVER write the default record
  // (name 0x00) on it: every unclaimed or expired label would inherit it.
  log.step('Parent resolver — PermissionedResolver proxy, addr set by its initializer')
  if (await isOurs(L.parentResolver, ENS.permissionedResolverImpl)) log.skip(`at ${L.parentResolver}`)
  else {
    const init = encodeFunctionData({
      abi: resolverAbi, functionName: 'initialize',
      args: [
        [{ account: account.address, roleBitmap: ALL_ROLES }],
        [encodeFunctionData({ abi: resolverAbi, functionName: 'setAddress', args: [parentDns, 60n, account.address] })],
      ],
    })
    const { result, request } = await publicClient.simulateContract({
      account, address: ENS.verifiableFactory, abi: factoryAbi, functionName: 'deployProxy',
      args: [ENS.permissionedResolverImpl, PARENT_RESOLVER_SALT, init],
    })
    await send(publicClient, walletClient, request, 'deployProxy(parent resolver)')
    L.parentResolver = result
    persist()
    log.ok(`deployed ${result}`)
  }

  // ---- 8. link into the canonical root --------------------------------------------------------
  log.step(`Link ${PARENT_NAME} → LortnocRegistry + parent resolver`)
  const sub = await c.ethRegistry.read.getSubregistry([PARENT_LABEL])
  if (isAddressEqual(sub, L.registry)) log.skip(`subregistry ${fmt.addr(sub)}`)
  else {
    const { request } = await publicClient.simulateContract({
      account, address: ENS.ethRegistry, abi: registryAbi, functionName: 'setSubregistry', args: [labelId, L.registry],
    })
    await send(publicClient, walletClient, request, 'setSubregistry')
    log.ok(`subregistry → ${L.registry}`)
  }
  const res = await c.ethRegistry.read.getResolver([PARENT_LABEL])
  if (isAddressEqual(res, L.parentResolver)) log.skip(`resolver ${fmt.addr(res)}`)
  else {
    const { request } = await publicClient.simulateContract({
      account, address: ENS.ethRegistry, abi: registryAbi, functionName: 'setResolver', args: [labelId, L.parentResolver],
    })
    await send(publicClient, walletClient, request, 'setResolver')
    log.ok(`resolver → ${L.parentResolver}`)
  }

  L.deployedAt = L.deployedAt ?? new Date().toISOString()
  L.deployer = account.address
  persist()

  const parentAddr = await publicClient.getEnsAddress({ name: PARENT_NAME })
  console.log(`\n\x1b[1m\x1b[32mSetup complete.\x1b[0m`)
  console.log(`  registry        ${L.registry}`)
  console.log(`  registrar       ${L.registrar}`)
  console.log(`  parentResolver  ${L.parentResolver}`)
  console.log(`  getEnsAddress(${PARENT_NAME}) via viem's default UR → ${parentAddr}`)
  console.log(`\n  Next: node scripts/ens/migrate-handles.mjs --yes --close && node scripts/ens/preflight.mjs\n`)
}

/** commit → wait MIN_COMMITMENT_AGE → register. Only runs after a Sepolia reset. */
async function registerParent(publicClient, walletClient, account, c) {
  const [basePrice, premium] = await c.registrar.read.getRegisterPrice([PARENT_LABEL, DURATION, ENS.mockUSDC])
  const needed = (basePrice + premium) * 2n
  if ((await c.usdc.read.balanceOf([account.address])) < needed) {
    const { request } = await publicClient.simulateContract({ account, address: ENS.mockUSDC, abi: erc20Abi, functionName: 'mint', args: [account.address, needed] })
    await send(publicClient, walletClient, request, 'mint MockUSDC')
  }
  if ((await c.usdc.read.allowance([account.address, ENS.ethRegistrar])) < needed) {
    const { request } = await publicClient.simulateContract({ account, address: ENS.mockUSDC, abi: erc20Abi, functionName: 'approve', args: [ENS.ethRegistrar, needed] })
    await send(publicClient, walletClient, request, 'approve')
  }
  const key = `commit:${PARENT_LABEL}`
  const secret = state[key]?.secret ?? toHex(crypto.getRandomValues(new Uint8Array(32)))
  state[key] = { secret }
  saveState()
  const REF = '0x' + '00'.repeat(32)
  const commitment = await c.registrar.read.makeCommitment([PARENT_LABEL, account.address, secret, ZERO, ZERO, DURATION, REF])
  let at = await c.registrar.read.commitmentAt([commitment])
  if (at === 0n) {
    const { request } = await publicClient.simulateContract({ account, address: ENS.ethRegistrar, abi: ethRegistrarAbi, functionName: 'commit', args: [commitment] })
    await send(publicClient, walletClient, request, 'commit')
    at = await c.registrar.read.commitmentAt([commitment])
  }
  const readyAt = Number(at + (await c.registrar.read.MIN_COMMITMENT_AGE()))
  for (;;) {
    const now = Number((await publicClient.getBlock()).timestamp)
    if (now >= readyAt) break
    const wait = readyAt - now + 2
    if (FORK) {
      await publicClient.request({ method: 'evm_increaseTime', params: [`0x${wait.toString(16)}`] })
      await publicClient.request({ method: 'evm_mine', params: [] })
    } else {
      log.info(`waiting ${wait}s for the commitment to mature…`)
      await sleep(wait * 1000)
    }
  }
  const { request } = await publicClient.simulateContract({
    account, address: ENS.ethRegistrar, abi: ethRegistrarAbi, functionName: 'register',
    args: [PARENT_LABEL, account.address, secret, ZERO, ZERO, DURATION, ENS.mockUSDC, REF],
  })
  await send(publicClient, walletClient, request, 'register')
  delete state[key]
  saveState()
  log.ok(`${PARENT_NAME} registered to ${fmt.addr(account.address)}`)
}

main().catch((e) => {
  console.error(`\n\x1b[31merror:\x1b[0m ${e.shortMessage || e.message}`)
  if (e.metaMessages) console.error(e.metaMessages.join('\n'))
  process.exit(1)
})
